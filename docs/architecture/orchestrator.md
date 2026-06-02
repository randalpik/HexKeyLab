# HKL Orchestrator (HKLO)

Browser app that samples a physical MIDI instrument's audio output into a velocity-layered `.hki`
instrument bundle, so users can play their own keyboard's sound inside HKL — legally, without
bundling someone else's samples. Served at `/orchestrator/` (port 5176 standalone). Back to
[architecture overview](../architecture.md). Format details in [the `.hki` v2 section
below](#hki-v2--velocity-layers); shared DSP in [analyzer.md](./analyzer.md) / `@hkl/analysis`.

## What it does

A five-step wizard. The user routes the instrument's audio into an audio-interface input and
picks the MIDI output that triggers it (or selects the synthetic loopback for a hardware-free
dry run):

1. **Connect** — pick MIDI output (Web MIDI) + audio input (getUserMedia, all browser DSP off),
   build a `CaptureDevice`, test with a probe note + live level meter.
2. **Discover** — sweep a probe note across the velocity band, fingerprint each, and detect the
   device's internal velocity-layer boundaries (or fall back to N even bins). User edits the bins.
3. **Configure** — instrument key/name, note range, semitone stride, hold time.
4. **Capture** — record each (note × layer): hold the key, record the natural decay (12 s max or
   until −60 dBFS), run quality gates, flag failures for re-capture.
5. **Export** — normalize each layer, assemble a v2 `.hki`, download or Send-to-HKL.

Decay instruments only (sustained is out of scope). Output provenance is tagged
`source: 'orchestrator'`.

## Package layout (`apps/orchestrator/src/`)

```
main.ts          wizard bootstrap + step router; window.__hklo test hook
state.ts         session: active CaptureDevice, discovered bins, CaptureConfig (pub/sub)
persist.ts       localStorage: config + bins + last device IDs (survives reload/HMR)
bridge.ts        HKLO↔HKL bridge (hkl-orchestrator-bridge): sendHkiToHkl + conn badge

device/
  midiOut.ts         Web MIDI output: requestMIDIAccess, port select, noteOn/Off, allNotesOff
  audioIn.ts         getUserMedia input → CaptureGraph (AGC/NS/EC forced off)
  capture-worklet.ts AudioWorkletProcessor: copies Float32 quanta + per-quantum RMS to main thread
  captureGraph.ts    shared worklet wiring + capture concat + trailing-RMS (real + loopback)
  device.ts          RealDevice (MidiOut + AudioInput) implements CaptureDevice; midiToFreq
  loopback.ts        synthetic CaptureDevice (additive synth, discrete velocity layers) — no hardware
  recorder.ts        one capture: arm → noteOn → hold → stop on decay/12s → noteOff → take
  types.ts           CaptureRecord, CaptureDevice

discovery/
  fft.ts             radix-2 FFT + Hann magnitude spectrum
  fingerprint.ts     per-velocity fingerprint: triangular-filterbank+log band shape, centroid, level
  bins.ts            adjacent-distance peak-pick → boundaries (+ absFloor), even-bin fallback (pure)
  sweep.ts           velocity sweep (warm-up + ring-clearing gaps) → Fingerprint[]

capture/
  plan.ts            enumerate (note × layer) jobs
  loop.ts            sequential capture loop + single-job captureOne (re-capture)
  gates.ts           quality gates (quiet/clip/short/pitch) — reuses @hkl/analysis DSP
  store.ts           in-memory lossless PCM store + gate outcomes (not persisted — too big)

analysis/
  shim.ts            single import point for @hkl/analysis DSP (computeGain, measureDecay, …)
  denoise.ts         spectral-subtraction NR (pre-roll noise profile, WOLA)
  buildHki.ts        denoise → normalize gain → float-WAV encode → v2 HkiBundle (claimed pitch)

ui/
  dom.ts, download.ts
  stepConnect.ts, stepDiscover.ts, stepConfigure.ts, stepCapture.ts, stepExport.ts
```

Declared deps: `@hkl/{shared, analysis, bridge}` — **not** `@hkl/engine` (no in-app audition; the
user hears their own hardware live).

## Capture path

**Lossless intermediate.** Audio is captured with an `AudioWorklet` that copies raw Float32 quanta
to the main thread (transferred, no re-encode) — never `MediaRecorder` (opus/lossy) or
`ScriptProcessorNode` (deprecated/main-thread). getUserMedia runs with `echoCancellation`,
`noiseSuppression`, `autoGainControl` all **off** (they'd corrupt loudness + spectra).

**Recorder.** Sampling a decay instrument means holding the key and recording the *natural* decay
(releasing early would damp/truncate it), so the recorder holds note-on for the whole capture and
sends note-off only at the stop. The ~120 ms pre-roll (armed silence before note-on) is both
captured (the analyzer/denoise trim it later) and measured for the **noise floor**. Stop = elapsed
≥ 12 s, OR (after a minimum hold past the attack) trailing RMS within **1 dB of the measured noise
floor** for 250 ms — *noise-floor relative*, not an absolute −60 dBFS, so the tail rings all the way
down into the floor regardless of how padded the capture level is (a fixed level would either chop
a loud tail early or never trigger on a quiet one). Note-on alignment need not be sample-accurate.

**Loopback.** `LoopbackDevice` implements the same `CaptureDevice` over an internal additive synth
through the same `CaptureGraph`, with **discrete velocity layers** (flat within a layer, jumps
between — like a real sampler). It's the hardware-free path for development and the
`test/orchestrator-smoke` harness; `velocityVaries=false` makes it velocity-invariant to exercise
the even-bin fallback.

## Discovery

At one probe note, sweep velocity (stride 4) and fingerprint each probe over its post-onset
window: 24 log-spaced **triangular-filterbank** band energies (log-compressed → stable for sparse
tonal spectra), spectral centroid, and windowed level. The adjacent-distance curve
`d[i]=‖F(vᵢ₊₁)−F(vᵢ)‖` spikes at layer boundaries; peak-pick above `max(mean+1.5·std, absFloor)`.
The `absFloor` prevents a velocity-invariant device from flagging noise; a warm-up discarded
capture + a gap longer than the ring-out keep the first probe from being a false boundary. No
boundaries → N even bins. `detectBins` is pure (unit-tested in `bins-test.mjs`).

## Quality gates

The level/duration gates are **noise-floor relative**, not absolute dBFS — the chain may be padded
(e.g. a cable's lo switch) and every sample is later normalized, so SNR and decay-relative-to-peak
are what survive normalization. The noise floor is self-measured from each capture's pre-attack
pre-roll. Failing flags:
- **quiet** — SNR (peak − noise floor) < 12 dB. (12, not 24: the noise-reduction step recovers
  ~15–20 dB, so a modestly-above-floor sample is still usable.)
- **clip** — any sample ≥ −0.1 dBFS (the one absolute test).
- **short** — audible-above-noise length < 0.12 s (a missed/dead note; a fast-decaying high note
  with a real attack still clears it).

**Pitch is informational only — never a failure.** We TRUST the claimed MIDI→12-TET pitch (see
Pitch/tuning below); the cents deviation is still measured (via `refineFundamentalPeriod`) and shown
in the capture table for the user to eyeball, but it never rejects a sample or sets its stored pitch.
UI tiers: green pass, yellow recoverable (quiet/short), red hard-fail (clip).

## Noise reduction

Each captured layer is denoised before encoding (`analysis/denoise.ts`) by **spectral subtraction**:
the pre-roll silence is a clean per-capture noise profile, so we STFT the signal (Hann, 75 % overlap,
zero-padded edges for clean WOLA reconstruction), subtract `α·noiseMag` per bin with a spectral
floor `β·|X|`, and invert. Defaults α = 1.5, β = 0.04 (≈ conservative; the floor prevents musical
noise). It's dramatic on tonal noise (mains hum, device whine — ~20–28 dB) and modest on broadband
hiss (~5 dB), and leaves the note body essentially untouched (signal ≫ noise there), so it mainly
cleans the decay tail + inter-note silence — the chord-hiss source.

## Pitch / tuning — trust the claimed pitch

We do **not** detect pitch to set the sample frequency: `buildHki` stores the **claimed MIDI→12-TET
frequency (A440)** as each sample's `freq`. Rationale: a digital instrument holds equal temperament
to a fraction of a cent, whereas period-detection on piano reads systematically **sharp** (string
inharmonicity pulls the autocorrelation toward the stretched upper partials) and is noisy at low SNR
— so "correcting" by detection would *add* error. This mirrors the analyzer's `trustLabeledPitch`
(default-on for local sources). The JI cents-correction is computed from the tuning system at
playback (engine freq-matching), landing the fundamental exactly on target; inharmonic partials stay
in the audio for timbre. (An earlier autocorrelation octave-guard was removed — it can't distinguish
a weak-fundamental high note from an octave-up, and only ever produced false failures.)

## `.hki` v2 + velocity layers

The bundle is the same `.hki` format bumped to version 2 (`packages/shared/src/hki.ts`):
`HkiSampleEntry` gains an optional `vel?` (reference velocity). A layered note is multiple flat
`samples[]` rows sharing `name`+`freq` at different `vel`. **Each layer is normalized to the same
−18 dBFS target** with the analyzer's gain finder, so at play time the engine picks the nearest
layer by velocity (`pickLayer` in `@hkl/engine`) and the existing house velocity curve owns
loudness — the layer choice changes timbre, not level. Single-layer notes omit `vel` and behave
identically to v1. `readHki` losslessly upcasts v1 bundles. Audio is the denoised capture encoded to
32-bit float WAV.

## Bridge to HKL

Own `BroadcastChannel('hkl-orchestrator-bridge')` mirroring the Analyzer: `orchestrator-hello`/
`-bye`, `import-hki { instrumentKey, bytes }` → HKL writes via `InstrumentRegistry.importBundle` →
`import-ack`. HKL's handler shares a factored `handleHkiImport()` with the Analyzer bridge
(`apps/hkl/src/bridge/hkl-side.ts`).

## Verification

HKLO's audio path can't be fully verified model-only. The split (see lessons.md "Orchestrator
capture/discovery gotchas"):
- **Pure logic, deterministic** — `test/orchestrator-smoke/bins-test.mjs` (node) asserts
  `detectBins` boundary positions on synthetic fingerprints. `pickLayer` is in
  `test/engine-smoke`.
- **Plumbing + browser-only logic** — `test/orchestrator-smoke/smoke.mjs` drives a headless
  Chromium and calls `window.__hklo.*` hooks: loopback capture returns audio, a sweep runs
  end-to-end, the gates fire on synthesized PCM (with a pre-roll noise floor so the SNR-relative
  logic is exercised), noise reduction drops the floor while preserving the note body, a capture
  loop runs, and an end-to-end export builds a v2 `.hki` that round-trips, decodes, normalizes
  layers to within ~1 dB, and stores the **claimed** pitch. Point it at the running umbrella with
  `HKLO_URL=http://localhost:5170/orchestrator/` — do **not** spawn a competing server on 5176 or
  kill by port (it hits the umbrella's child; the proxy doesn't respawn). `persist-test.mjs` checks
  the localStorage reload round-trip.
- **Hardware** — interactive in a real browser with the user's MIDI device + audio input (the
  meter, real discovery, real capture, Send-to-HKL). `tools/audio-noise-scan.mjs <wav>` reports a
  recording's RMS/peak/clipping + tonal-vs-broadband noise signature (uses the discovery FFT) — for
  dialing input gain and diagnosing hum/whine before capturing.

The capture **input chain** is the fragile part, not the code — see lessons.md "Capturing a
hardware instrument's audio". A clean line-in source (the audio Connect step lists whatever ALSA
exposes) makes everything downstream just work.

Standard gates: `pnpm typecheck`, `pnpm -r build`, `pnpm check:boundaries`.
