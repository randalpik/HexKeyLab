# HKL Analyzer (HKLA)

Tool for building HKL instruments from audio: loop-point detection, decay analysis, and RMS/loudness gain normalization. One package (`apps/analyzer/`) with three faces — a browser UI, a Node batch CLI, and the DOM-free DSP engine they share. Back to [architecture overview](../architecture.md). Audio audition/playback internals live in [engine.md](./engine.md); tuning concepts in [../architecture.md](../architecture.md).

## Package layout

```
apps/analyzer/
  index.html              browser UI entry (Vite)
  src/                    browser UI modules → import @hkl/{shared,engine,bridge}
  analysis/               DOM-free DSP engine (shared by UI + CLI)
    analyzer-analysis.js      HKLAnalysis: prepareLoop, refineFundamentalPeriod, trimSilence, applyConfigDefaults
    analyzer-instruments.js   HKLInstruments: URL construction, note enumeration, noteStyle dispatch
    analyzer-visualization.js HKLViz: diagnostic canvas + status text (reused by UI Inspect panel)
    k-weighting.js            ITU-R BS.1770-4 loudness (measureLufs, measureDecayLufs)
  cli/                    Node batch CLI
    generate-samples.js       run via `pnpm analyze`; emits a samples-data block
    insert-instrument.js      splices that block into apps/hkl/src/audio/samples-data.ts
    bundle.js, backfill-gains.js, backfill-patterns.js
  configs/*.json          per-instrument configs — source of truth for shipped instruments
  out/                    CLI artifacts: <key>-block.txt, <key>-report.md, <key>.hki
```

The CLI (`configs/*.json` → `samples-data.ts`) is canonical for shipped instruments; the browser UI is the end-user path.

---

## Signal-processing engine

### URL templating

Both CLI and runtime engine build sample URLs from the same config metadata, so changes propagate without engine edits.

- **`filePattern`** — `'{NOTE}{ext}'` default; non-default e.g. `'RenOrgan_8foot_Room_{NOTE}_rr1.wav'`.
- **`noteStyle`** — enharmonic spelling:

  | value | sharp spelling | source |
  |---|---|---|
  | `flat` | `Bb Db Eb Gb Ab` | gleitz / FluidR3 / MusyngKite / FatBoy (default) |
  | `sharp` | `C# D# F# G# A#` | VCSL |
  | `sharp_s` | `Cs Ds Fs Gs As` | nbrosowsky/tonejs (`s` = filename-safe) |
  | `sharp_lower` | `c# d# f# g# a#` | peastman/sso |
  | `salamander` | sparse `{0:C,3:Ds,6:Fs,9:A}` | paired with sparse sampling |

- **`noteSemis`** — per-octave semitones to enumerate. Default `[0..11]`; wholetone `[0,2,4,6,8,10]`; minor-third `[1,4,7,10]`.
- **`transpose`** — rational `audioFundamental ÷ filenameLabel`. Default `1`; `2` for Hammond convention, `0.5` for chamber organ.
- `#` is URL-encoded as `%23` automatically by both `buildUrl` (CLI) and the runtime engine.

### Per-instrument gate overrides (`gateOpts`)

Configurable per instrument: `rmsGate`, `specGate`, `cliqueThreshold`, `minSpacingSec`, `minBackwardSec`, `minForwardSec`, `xfadeSec`, `rmsStepThreshold`, `fwdStabilityThreshold`, `fwdStabilitySec`.

Defaults are counterintuitive (lower = tighter):
- `cliqueThreshold` = `0.25`, `rmsStepThreshold` = `0.25`
- `fwdStabilityThreshold` = `0.10` (±10% RMS deviation in a 300 ms forward window; `Infinity` disables)

reed_organ's `cliqueThreshold: 0.15` is a *tightening* (its samples are unusually steady). → see decisions.md "fwdStabilityThreshold brass-killer".

### Loop algorithms

Three loop-detection paths, all feeding the backward-clique post-process.

**Macro-period** (`prepareLoopMacroPeriod`):
- Steady-region detection via RMS envelope (50 ms window, 10 ms hop, ≥70% peak runs)
- Anchor candidates at quartile positions; pick anchor with largest qualifying-N pool
- Per candidate N: compare 60 ms Hann-windowed FFT log-mag spectrum + RMS to anchor; gate by `rmsGate`, `specGate`
- Score = `rmsRel × 10 + specMse`; `minSpacing` filter preserves diversity
- Snap each pick to nearest +going zero crossing within ±T/2 with anchor-matching local slope
- Returns `trimStart`, `loopPts[]`, `slopeCV` (std slope / mean slope)

**Freq-guided** (`prepareLoopFreqGuided`): fallback for clean periodic samples. Places K·T target positions in a loop window around the anchor, locks each to the nearest high-correlation +ZC within ±T/2. `corrThresh` default `0.85`.

**Vibrato-aware** (`prepareLoopVibrato`): for instruments flagged `vibrato: true` (violin, viola, cello, flute, drawbar_organ):
- RMS envelope (20 ms window, 5 ms step, ±30 ms smoothing); pitch via zero-crossing period tracking
- Auto-select AMP or PITCH signal by higher coefficient of variation
- Hysteresis state machine (H = 0.5 × std) extracts vibrato cycle boundaries
- Consistency filter: keep loop points within [0.75, 1.25] × median vibrato-period spacing
- Two-pass correlation-based waveform-phase snap

### Backward-clique filter (`filterToBackwardClique`)

Shared post-process for all three algorithms.
- Pair quality `xfadeDev(a, b)` — midpoint RMS deviation over central 20% of a 30 ms crossfade window
- Amplitude-step gate `ampStepDev(a, b) = |envRms[a] − envRms[b]| / max(envRms[a], envRms[b])` (50 ms envelope; orthogonal to phase coherence)
- Edge iff `xfadeDev ≤ cliqueThreshold` AND `ampStepDev ≤ rmsStepThreshold`
- Max-clique growth around each candidate; minimum-spacing collapse drops redundant points
- Output: `validStartsByEnd[b]` (graph form) ready for runtime

### Tier color coding

Result rows colored by algorithm + quality:
- `mp-{red,yellow,blue,green}` — macro-period (clique size + slopeCV + span)
- `fg-{red,orange,blue}` — freq-guided (kept-point count)
- `vb-{red,yellow,blue,green}` — vibrato (mirrors macro-period)
- `legacy` — deep-fallback correlation-anchor path

### Validation

Final pairwise correlations across kept loop points are typically ≥ 0.99 for a good sample. Bimodal clusters indicate mixed phases; two-pass re-anchoring isolates the main cluster.

### Gain normalization

After loop/decay analysis each sample is measured for amplitude:
- **Loop instruments** — stereo RMS over the steady region from `findSteadyRegion` (50 ms RMS window, 10 ms hop, ≥70% peak run). Vibrato instruments pre-smooth ±150 ms so AMP cycles don't shatter the span. Peak over the same window bounds the gain (single-voice peak post-boost ≤ −3 dBFS).
- **Decay instruments** — K-weighted integrated loudness (ITU-R BS.1770-4: high-shelf @1681 Hz +4 dB, RLB high-pass @38 Hz, 400 ms windows / 100 ms hop, absolute gate −70 LUFS, relative gate −10 LU below pre-gated mean), over the full post-trim region. Returned as stereo-RMS-equivalent (`sqrt(integrated_combined/2)`) so the formula is shared with the loop path. (`analysis/k-weighting.js`.)

```
gain = min(TARGET_RMS / rms, TARGET_PEAK / peak)   floored at GAIN_MIN
TARGET_DBFS = −18   PEAK_DBFS = −3   GAIN_MIN = 0.1
```

Constants live in both `cli/generate-samples.js` and `cli/backfill-gains.js`. `generate-samples.js` emits `gain` alongside `freq` per sample; `backfill-gains.js` patches the field into existing `samples-data.ts` entries in place (adds normalization without re-running the loop pipeline). Reports → `apps/analyzer/out/`.

---

## Browser UI

`index.html` is a Vite entry. Per the analyzer import constraints in CLAUDE.md, `apps/analyzer/src/*` may import `@hkl/shared`, `@hkl/engine`, `@hkl/bridge`, and `apps/analyzer/analysis/*.js` — never HKL-side audio/midi/state/lumatone/render/composer code. This keeps the analyzer independent of HKL state.

### Module map (`apps/analyzer/src/`)

| module | role |
|---|---|
| `main.ts` | entry. `loadDraft()` → `hydrate(state)` BEFORE views init, then mount + 250 ms debounced auto-save |
| `stage.ts` | single mutable `AnalyzerState` + pub/sub: `getState`, `setConfig/Source/Samples`, `updateSample`, `hydrate`, `reset`, `onChange` |
| `state.ts` | types: `AnalyzerState`, `ConfigState`, `SourceState` (`Local`\|`Cdn` union), `SampleSlot`, `GateOpts`, `Tier`, `AnalysisResult` |
| `sourceLocal.ts` | drag-drop + file picker; filename → note-name via inverse `noteStyle` regex (first match wins) |
| `sourceCdn.ts` | baseUrl + filePattern + fallback-pattern button; enumeration via `HKLInstruments.enumerateRange` |
| `pipeline.ts` | orchestrator. Owns `AudioContext` (decode on main thread) + lazy `pipeline-worker`. Per slot: `decodeAudioData` → ship per-channel `Float32Array`s as transferables → receive `{result, gain, …}` → classify tier → autoSelect |
| `pipeline-worker.ts` | Web Worker (`?worker`). `HKLAnalysis.prepareLoop` (loop) + port of `generate-samples.js:analyzeDecay` (decay) + gain via `k-weighting`. Wraps incoming channels in an `AudioBuffer`-shaped duck |
| `normalize.ts` | gain math lifted from `generate-samples.js`: `measureRmsLoop`, `measureDecay`, `computeGain` |
| `tier.ts` | `classifyTier(result, decays)`. Loop: `fail`/`red` (segs<3 or SCC broken)/`yellow` (3)/`blue` (4+, bridges≥half)/`green` (4+, bridges<half). Decay: `fail`/`yellow` (drift >50¢)/`green` |
| `autoSelect.ts` | port of `generate-samples.js:pickSamples`. Spine (green @~4-st) + fill (blue/yellow in >4-st gaps, min-sep 2). Decay keeps every valid sample |
| `audition.ts` | wrapper around `@hkl/engine` segmentLooper (sustain) + release-envelope single-source (decay). See [engine.md](./engine.md) |
| `playhead.ts` | time→x mapping (mirrors HKLViz `ml=50, mr=18`) + vertical-line render; driven by audition position events |
| `charts.ts` | adapter over `analyzer-visualization.js`: `drawSlotChart` → `HKLViz.renderGraphForEntry` |
| `configForm.ts` | two-way DOM form: instrumentKey, displayName, noteStyle, lowOct/highOct, transposeSemis, decays, vibrato, releaseTime, volume |
| `advancedPanel.ts` | collapsible `gateOpts` panel; empty inputs use engine defaults (shown as gray-italic placeholder) |
| `sampleTable.ts` | per-sample row (tier, segments, span, gain, status, checkbox), Play/Stop, Inspect expander mounting diag+playhead canvas |
| `output.ts` | builds `.hki` (`writeHki` from `@hkl/shared`) or `CdnInstrumentConfig` JSON; download + Send-to-HKL; import for round-tripping configs |
| `download.ts` | Blob URL + `<a download>` shim |
| `persist.ts` | IndexedDB draft store (`hkl-analyzer-drafts`); structured-clone `AnalyzerState`, strips `audioBuffer` |
| `bridge.ts` | analyzer-side bridge (below) |
| `sourceClear.ts` | Clear button: `clearDraft()` + `reset()` |

### Transpose semantics (semitones, not ratio)

Form input `Transpose (semitones)`, default `0`, integer; state `transposeSemis`. Semantic: `audioFreq = labeledFreq × 2^(semis/12)`. `semis = −12` → audio one octave below the label (Hammond: file `C4.mp3` contains C3 audio).

At output, the legacy playback-rate `transpose` field is computed as `2^(−semis/12)` and emitted only when non-zero; inverse on import `semis = round(−log2(transpose) × 12)`. `slot.midi` carries the LABELED midi (`{MIDI}` placeholder); `slot.freq` carries the AUDIO freq — they differ when `transposeSemis ≠ 0`.

### Persistence + audio rehydration

`persist.ts` writes the full `AnalyzerState` to IDB on every change (debounced 250 ms). On reload `main.ts` calls `loadDraft()` before view init so fields repopulate. `File` handles survive structured clone (local files round-trip, no re-pick).

`audioBuffer` is stripped on save (not cloneable). On reload slots keep `result`/`tier`/`picked` but no buffer; Audition → `ensureAudioBuffer(slot)` re-decodes the file and writes it back. (Firefox `decodeAudioData` quirk → see lessons.md.)

### Bridge to HKL (`'hkl-analyzer-bridge'`)

Same-origin `BroadcastChannel`, separate from the Composer channel. Uses `BridgeChannel<In,Out>` from `@hkl/bridge` with `ANALYZER_CHANNEL_NAME`.

**Analyzer → HKL** (`AnalyzerEvent`):
- `analyzer-hello` / `analyzer-bye` — lifecycle
- `import-hki { instrumentKey, bytes: Uint8Array }` — built `.hki` bundle, inlined → HKL writes to `InstrumentRegistry`, acks
- `import-cdn-config { instrumentKey, config: CdnInstrumentConfig }` — inlined → HKL writes to `cdnConfigRegistry`, acks

**HKL → Analyzer** (`HklAnalyzerEvent`): `hkl-hello`/`hkl-bye`; `import-ack { instrumentKey, ok, error? }`.

Bytes are inlined (not an IDB rendezvous) because the analyzer can't import HKL's `apps/hkl/src/state/`; structured clone handles 10–50 MB in ~50 ms and keeps the bridge stateless. → see decisions.md "analyzer bridge inline bytes".

- **HKL handler** (`apps/hkl/src/bridge/hkl-side.ts`): `analyzerBridge` instance with its own `on()` switch; `import-hki` → `InstrumentRegistry.importBundle`, `import-cdn-config` → `cdnConfigRegistry.importConfig`, both auto-select + ack. `initHklBridge()` calls `announceToAnalyzer()`.
- **Analyzer handler** (`bridge.ts`): `sendHkiToHkl` / `sendCdnConfigToHkl` send + await ack (10 s timeout); `onConnectionChange` drives the `#hklConn` badge and Send button.

### Verification

`pnpm dev` serves `/analyzer/` on the shared `:5170` origin. Manual e2e:
1. Open both pages in two Firefox tabs.
2. Analyzer: pick a source (drag local files or CDN URL), fill config, "Analyze all samples" — worker processes each sample, table populates, auto-select picks at ~4-st spacing.
3. Inspect a row → HKLViz chart + playhead (during Audition).
4. "Send to HKL" → instrument appears in HKL's waveform dropdown, auto-selects; play a note to fetch from CDN baseUrl or HKI bundle.
5. Reload Analyzer → form + samples + picks restore from IDB; Audition re-decodes on demand.

`state.ts`, `tier.ts`, `autoSelect.ts`, `normalize.ts`, and `@hkl/shared` segments are pure and unit-testable (deferred; backlog ARCHITECTURE entry covers HKL test scaffolding).
