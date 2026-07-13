# HKL Orchestrator (HKLO)

Browser app that samples a physical MIDI instrument's audio output into a velocity-layered `.hki`
instrument bundle, so users can play their own keyboard's sound inside HKL — legally, without
bundling someone else's samples. Served at `/orchestrator/` (port 5176 standalone). **For how to
*use* it — the five-step capture wizard — see the [Orchestrator guide](../guide/orchestrator.md).**
Back to [architecture overview](../architecture.md). Format details in [the `.hki` v2 section
below](#hki-v2--velocity-layers); shared DSP in [analyzer.md](./analyzer.md) / `@hkl/analysis`.

## What it does

A five-step wizard. The user routes the instrument's audio into an audio-interface input and
picks the MIDI output that triggers it (or selects the synthetic loopback for a hardware-free
dry run):

1. **Connect** — pick MIDI output (Web MIDI) + audio input (getUserMedia, all browser DSP off),
   build a `CaptureDevice`, test with a probe note + live level meter. Optional **Calibrate whine**:
   record ~3 s of idle output and auto-detect the device's fixed tonal artifact comb (the whine
   profile — see [Noise reduction](#noise-reduction)), notched from every capture.
2. **Discover** — sweep a probe note across the velocity band, fingerprint each, and detect the
   device's internal velocity-layer boundaries (or fall back to N even bins). User edits the bins.
   The sweep's per-velocity levels are also kept as the device's velocity→loudness response, used
   for per-layer softening at export (see [`.hki` v2](#hki-v2--velocity-layers)).
3. **Configure** — instrument key/name, note range, semitone stride, hold time.
4. **Capture** — record each (note × layer): hold the key, record the natural decay (12 s max or
   until −60 dBFS), run quality gates + a normalization assessment, **auto-retry once** on a
   yellow take (failed gate / too-noisy-after-boost / local gain outlier), flag the rest.
5. **Export** — per capture: de-whine (notch) → broadband NR (Wiener); per layer: normalize +
   perceptual-soften, then **drop layers whose boosted noise floor is too high** (fall back to the
   nearest surviving layer); assemble a v2 `.hki`, download or Send-to-HKL.

Decay instruments only (sustained is out of scope). Output provenance is tagged
`source: 'orchestrator'`.

## Package layout (`apps/orchestrator/src/`)

```
main.ts          wizard bootstrap + step router; window.__hklo test hook
state.ts         session: CaptureDevice, bins, CaptureConfig, whineProfile, velocityResponse (pub/sub)
persist.ts       localStorage: config + bins + device IDs + whineProfile + velocityResponse (reload/HMR)
bridge.ts        HKLO↔HKL bridge (hkl-orchestrator-bridge): sendHkiToHkl + conn badge

device/
  midiOut.ts         Web MIDI output: requestMIDIAccess, port select, noteOn/Off, allNotesOff
  audioIn.ts         getUserMedia input → CaptureGraph (AGC/NS/EC forced off)
  capture-worklet.ts AudioWorkletProcessor: copies Float32 quanta + per-quantum RMS to main thread
  captureGraph.ts    shared worklet wiring + capture concat + trailing-RMS (real + loopback)
  device.ts          RealDevice (MidiOut + AudioInput) implements CaptureDevice; midiToFreq
  loopback.ts        synthetic CaptureDevice (additive synth, discrete velocity layers; enableWhine) — no hardware
  recorder.ts        one capture: arm → noteOn → hold → stop on decay/12s → noteOff → take; recordIdle (whine cal)
  types.ts           CaptureRecord, CaptureDevice

discovery/
  fft.ts             radix-2 FFT + Hann magnitude spectrum
  fingerprint.ts     per-velocity fingerprint: triangular-filterbank+log band shape, centroid, level
  bins.ts            adjacent-distance peak-pick → boundaries (+ absFloor), even-bin fallback (pure)
  sweep.ts           velocity sweep (warm-up + ring-clearing gaps) → Fingerprint[]

capture/
  plan.ts            enumerate (note × layer) jobs
  loop.ts            sequential capture loop (assess + auto-retry-once) + single-job captureOne
  gates.ts           quality gates (quiet/clip/short/pitch) — reuses @hkl/analysis DSP
  store.ts           in-memory lossless PCM store + gate outcomes (not persisted — too big)
  whineCal.ts        record idle → detectCombTones → whine profile (device tonal artifacts)

analysis/
  shim.ts            single import point for @hkl/analysis DSP (computeGain, measureDecay, …)
  dewhine.ts         detectCombTones (idle → tone freqs) + dewhineChannels (zero-phase notch cascade)
  wiener.ts          decision-directed (Ephraim-Malah) Wiener broadband NR (pre-roll profile, WOLA)
  clean.ts           cleanCapture (de-whine→Wiener) + post-gain-noise assessment (assessRaw, skip threshold)
  buildHki.ts        clean → normalize + soften → per-layer skip (too noisy) → float-WAV → v2 HkiBundle

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

## Capture reliability — auto-retry + skip (high, soft notes)

A genuinely-quiet note (high register at low velocity) needs a large normalization gain (166–328×
was observed on the SP-250's top octave), which amplifies its noise floor. Two problems the gates
above don't catch, both driven by the **post-gain noise floor** = `gain × cleaned pre-roll floor`
(what the boosted broadband hiss actually measures — the reliable whine predictor; a *clean* high
note with a big gain is fine, a noisy one is not):

- **Auto-retry-once** (`loop.ts`): after each capture, the take is cleaned + assessed; it's re-recorded
  a single time if it comes out **yellow** — a failed gate, a post-gain noise floor over the skip
  threshold, or a **local gain outlier** (gain > 1.6× the median of the last few *same-velocity*
  gains — same-velocity gains trend smoothly with pitch, so an abnormally-quiet take like a
  soft/mis-struck strike stands out without flagging the whole legitimately-quiet top register). The
  cleaner take (non-clipped, lower post-gain noise) is kept.
- **Per-layer skip** (`buildHki`): a layer whose post-gain noise floor exceeds **−45 dBFS**
  (`POSTGAIN_NOISE_SKIP_DB`) can't be boosted cleanly, so it's dropped and reported; playback falls
  back to the note's nearest surviving layer via `pickLayer`. Never empties a note — if every layer
  is over threshold, the least-noisy one is kept.

**Short-decay gain fallback** (`@hkl/analysis` `measureDecay`): a note too short for the K-weighting
window (its momentary windows tail below the −70 LUFS gate) would leave `computeGain` null → the
caller defaults gain to 1.0 → the note is inaudible ("missing"). `measureDecay` now falls back to a
loudest-window RMS so those notes still normalize — distinguishing a *clean-but-short* note (kept
with a real gain) from a *noisy* one (which the skip then drops). We deliberately do **not** cap or
otherwise adjust note volume beyond the velocity + layer-softening system — a note is either kept at
its real gain or skipped.

## Noise reduction

Two stages on the raw capture, in order (`analysis/dewhine.ts` then `analysis/wiener.ts`, wired
together in `analysis/clean.ts` `cleanCapture`, used by both export and the capture-loop assessment):

**1. De-whine (tonal comb notch).** Many digital instruments emit a fixed narrowband whine — a
DAC/switching-clock artifact at stable frequencies (e.g. the Korg SP-250's ~1502 Hz-spaced comb
peaking at 12 kHz, plus a 15625 Hz timer tone). It's *ever-present* and *scales with the instrument's
master volume*, so it can't be dialed out at the input; it's *identical in every note*, so it stacks
coherently across a soft chord; and it's a *pure tone*, so spectral subtraction can neither lock onto
it nor remove it without musical noise. The right tool is a **notch**. `detectCombTones` finds the
tones from an idle recording (Welch spectrum → prominence + global-floor peak-pick, sub-bin
interpolated — the **whine calibration** in Connect), and `dewhineChannels` applies a **zero-phase
(filtfilt) RBJ notch** at each. Notching a few-Hz-wide tone costs essentially nothing on the piano
(whose energy there is broadband, not on those exact bins) and leaves no musical noise. Runs *first*,
so the pre-roll used by the next stage's profile is already tone-free. No profile ⇒ no-op.

**2. Broadband NR (decision-directed Wiener).** Replaces the former plain spectral subtraction, whose
per-bin magnitude subtraction flickered near-floor bins frame-to-frame and left musical-noise birdies
that stacked across soft chords. The pre-roll silence gives a per-bin noise-power profile; each frame
uses the Ephraim-Malah **decision-directed a-priori SNR** (recursive blend of the previous clean
estimate and the instantaneous SNR, α = 0.98) → Wiener gain `ξ/(1+ξ)`, floored at `gainMin` (0.06 ≈
−24 dB) so a natural bed remains instead of gated silence. The temporal smoothing is what kills the
birdies. STFT Hann, 75 % overlap, zero-padded edges for clean WOLA. Note body sits far above the
floor and passes through untouched; the work is in the decay tail + inter-note silence.

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
`samples[]` rows sharing `name`+`freq` at different `vel`. At play time the engine picks the nearest
layer by velocity (`pickLayer` in `@hkl/engine`) and the house velocity curve supplies the overall
dynamics; single-layer notes omit `vel` and behave identically to v1. `readHki` losslessly upcasts
v1 bundles. Audio is the cleaned capture encoded to 32-bit float WAV.

**Per-layer gain = flat normalization × perceptual softening.** Each layer is first normalized to the
−18 dBFS target (analyzer gain finder), then multiplied by a **softening scale** (`layerSofteningScale`
in `buildHki`). The scale is derived by comparing the device's *measured* velocity→loudness (the
Discover sweep's `velocityResponse`) against the house velocity curve `velocityCurveGain`
(`@hkl/shared/velocity.ts`, the single source of truth the HKL playback curve also wraps): for each
layer velocity `v`, residual `r(v) = L(v)/houseCurve(v)`, normalized to the max residual → a scale
`≤ 1` that **only attenuates**. This bakes in the keyboard's own inter-layer loudness balance so a
brighter layer no longer reads as a perceived-loudness *tier* — while the house curve keeps owning the
bulk of the dynamics (we don't touch the "proven" playback system). It only ever softens, so it can't
push a layer toward clipping; multi-layer notes only; no sweep data ⇒ scale 1.0 (flat, as before).

## Bridge to HKL

Own `BroadcastChannel('hkl-orchestrator-bridge')` mirroring the Analyzer: `orchestrator-hello`/
`-bye`, `import-hki { instrumentKey, bytes }` → HKL writes via `InstrumentRegistry.importBundle` →
`import-ack`. HKL's handler shares a factored `handleHkiImport()` with the Analyzer bridge
(`apps/hkl/src/bridge/hkl-side.ts`).

## Verification

HKLO's audio path can't be fully verified model-only. The split (see lessons.md "Orchestrator
capture/discovery gotchas"):
- **Pure logic, deterministic** — `test/orchestrator-smoke/bins-test.mjs` (node) asserts
  `detectBins` boundary positions on synthetic fingerprints. `dewhine-test.mjs` (node) asserts
  `detectCombTones` finds the comb (no spurious peaks), `dewhineChannels` notches it ≥20 dB while
  preserving the note, and `wienerDenoiseChannels` pulls the broadband floor down without eating the
  body. Both run via `node --import ./test/orchestrator-smoke/register-ts.mjs …` (a resolve hook that
  rewrites the modules' `.js` specifiers to their `.ts` siblings for Node's type-stripping).
  `pickLayer` is in `test/engine-smoke`.
- **Plumbing + browser-only logic** — `test/orchestrator-smoke/smoke.mjs` drives a headless
  Chromium and calls `window.__hklo.*` hooks: loopback capture returns audio, a sweep runs
  end-to-end, the gates fire on synthesized PCM (with a pre-roll noise floor so the SNR-relative
  logic is exercised), Wiener NR drops the floor while preserving the note body, `calibrateWhineTest`
  detects a synthetic comb the loopback emits (`enableWhine`), `softeningTest` checks the per-layer
  scale (strictly decreasing + anchored at 1.0 for a flat response, all-1.0 for none),
  `normalizationTest` checks the short-decay RMS fallback (a real gain, not 1.0) + the post-gain-noise
  skip metric (clean note kept, noisy note skipped), a capture loop runs, and an end-to-end export
  builds a v2 `.hki` that round-trips, decodes, normalizes layers to within ~1 dB, and stores the
  **claimed** pitch. Point it at the running umbrella with
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
