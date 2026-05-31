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
  buildHki.ts        analyze each layer → normalize gain → float-WAV encode → v2 HkiBundle

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
sends note-off only at the stop. Stop = elapsed ≥ 12 s, OR (after a minimum hold past the attack)
trailing RMS < −60 dBFS held for 250 ms. Note-on alignment need not be sample-accurate — the
analyzer trims leading silence itself.

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

Per capture (reusing `@hkl/analysis`): **quiet** (post-onset peak < −24 dBFS), **clip** (≥ −0.1
dBFS), **short** (audible length < 0.5 s), **pitch** (no fundamental near the expected MIDI pitch,
or > 50¢ drift). The pitch check uses `refineFundamentalPeriod` plus a half-period autocorrelation
guard to catch octave-up errors (which align at the hint lag). UI tiers: green pass, yellow
recoverable (quiet/short), red hard-fail (clip/pitch).

## `.hki` v2 + velocity layers

The bundle is the same `.hki` format bumped to version 2 (`packages/shared/src/hki.ts`):
`HkiSampleEntry` gains an optional `vel?` (reference velocity). A layered note is multiple flat
`samples[]` rows sharing `name`+`freq` at different `vel`. **Each layer is normalized to the same
−18 dBFS target** with the analyzer's gain finder, so at play time the engine picks the nearest
layer by velocity (`pickLayer` in `@hkl/engine`) and the existing house velocity curve owns
loudness — the layer choice changes timbre, not level. Single-layer notes omit `vel` and behave
identically to v1. `readHki` losslessly upcasts v1 bundles. Audio is encoded to 32-bit float WAV.

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
  Chromium against a dev server and calls `window.__hklo.*` hooks: loopback capture returns audio,
  a sweep runs end-to-end, the gates fire on synthesized PCM, a capture loop runs, and an
  end-to-end export builds a v2 `.hki` that round-trips and decodes (asserting the equal-loudness
  normalization invariant across layers).
- **Hardware** — interactive in a real browser with the user's MIDI device + interface (the meter,
  real discovery, real capture, Send-to-HKL).

Standard gates: `pnpm typecheck`, `pnpm -r build`, `pnpm check:boundaries`.
