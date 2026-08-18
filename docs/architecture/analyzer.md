# HKL Analyzer (HKLA)

Tool for building HKL instruments from audio: loop-point detection, decay analysis, and RMS/loudness gain normalization. One package (`apps/analyzer/`) with three faces — a browser UI, a Node batch CLI, and the DOM-free DSP engine they share. **For how to *use* it — the build-an-instrument workflow — see the [Analyzer guide](../guide/analyzer.md).** Back to [architecture overview](../architecture.md). Audio audition/playback internals live in [engine.md](./engine.md); tuning concepts in [../architecture.md](../architecture.md).

## Package layout

The DOM-free DSP now lives in **`@hkl/analysis`** (`packages/analysis/`), shared by the Analyzer
and the Orchestrator (and the CLI): `analyzer-analysis.js` (HKLAnalysis: prepareLoop,
refineFundamentalPeriod, trimSilence, applyConfigDefaults), `analyzer-instruments.js`
(HKLInstruments: URL/note enumeration), `k-weighting.js` (ITU-R BS.1770-4 loudness), and the pure
TS `normalize.ts` (measure*/computeGain/buffer builders), `tier.ts`, `autoSelect.ts`, `types.ts`.
Only the DOM-bound `analyzer-visualization.js` (HKLViz canvas) stays app-local.

```
apps/analyzer/
  index.html              browser UI entry (Vite)
  src/                    browser UI modules → import @hkl/{shared,engine,bridge,analysis}
  analysis/
    analyzer-visualization.js HKLViz: diagnostic canvas + status text (DOM; stays app-local)
  cli/                    Node batch CLI (imports @hkl/analysis for k-weighting etc.)
    generate-samples.js       run via `pnpm analyze`; emits a samples-data block
    insert-instrument.js      splices that block into apps/hkl/src/audio/samples-data.ts
    batch-musiquest.js        run via `pnpm analyze:musiquest`; runs configs/musiquest/*,
                              stages .hki + defs into handoff/musiquest/ + aggregate report
    bundle.js, backfill-gains.js, backfill-patterns.js
  configs/*.json          per-instrument configs — source of truth for shipped instruments
  configs/musiquest/*.json  the MusiQuest conversion set (local-source, pickSpacing 3)
  out/                    CLI artifacts: <key>-block.txt, <key>-report.md, <key>.hki,
                          <key>-def.json (InstrumentDef for external consumers),
                          <key>-summary.json (machine-readable run summary)
packages/analysis/src/    @hkl/analysis — the DOM-free DSP listed above
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
- **`lowNote` / `highNote`** — note-level range trim (inclusive, e.g. `"G3"`), refining the octave-granular `lowOct`/`highOct` sweep. Filters enumeration *before* fetch/decode/analyze, so out-of-range files are never touched. Used to cut a chromatic library down to an instrument's natural range (the engine interpolates outside kept samples).
- `#` is URL-encoded as `%23` automatically by both `buildUrl` (CLI) and the runtime engine.

### Sample picking & thinning (CLI `pickSamples`)

- **`pickSpacing`** — target semitone spacing for the picker (default `4`, the historical spacing; `3` = minor thirds). Window is `±floor(S/2)`, gap threshold `> S`. **Presence matters**: the decay path keeps *every* usable sample when `pickSpacing` is absent (legacy behavior — soundfont decay sets are pre-curated) and thins at the configured spacing when present (dense chromatic sources like the MusiQuest library).
- **`keepAllGreenRange: [lo, hi]`** — keeps every *green*-tier sample in the range (defeats the spacing picker inside it).
- **`keepAllRange: [lo, hi]`** — tier-inclusive sibling: keeps every usable (green/blue/yellow) sample in range. For voice sets whose short samples tier below green — a yellow vocal sample still loops fine, and dropping it to the picker would reintroduce audible vowel seams. `keepAllGreenRange` retains its green-only meaning for backward compatibility.

### Per-instrument gate overrides (`gateOpts`)

Configurable per instrument: `rmsGate`, `specGate`, `cliqueThreshold`, `minSpacingSec`, `minBackwardSec`, `minForwardSec`, `xfadeSec`, `rmsStepThreshold`, `fwdStabilityThreshold`, `fwdStabilitySec`, `xfadeResidualDbMax`, `xfadeCandidatesSec`, `seamLagRefine`, `seamLagSearchPeriods`.

### Crossfade-residual gate + per-sample crossfade window (`selectSegments`)

Every candidate pair that survives the cheap gates + correlation is additionally validated by **rendering what the engine actually plays at the seam**: the RMS of `x(a+t) − x(b+t)` over the crossfade window, in dB relative to local signal RMS. Pairs above **`xfadeResidualDbMax`** (default **−10 dB**; `null` disables) are rejected. Rationale: the Pearson gate ran over ~3 fundamental periods (~11 ms at C4) while the engine crossfades 30 ms, so slowly-diverging pairs shipped as "green" with audible seam wobble (bassoon F4 had a −6.6 dB seam).

Because divergent material (vibrato FM) seams better over shorter windows (measured: female-voice pairs at +2.0 dB @30 ms drop to −9.7 dB @8 ms) while phase-stable material barely moves, selection runs once per candidate window (**`xfadeCandidatesSec`**, default `[0.030, 0.015, 0.008]`, floored at 1.5 fundamental periods) and the winner — most surviving segments, then lowest worst residual, then longer window — decides both the kept pairs and the sample's emitted **`crossfadeSec`** (omitted when it equals the 30 ms engine default). The engine (`samples-engine.ts`, `segmentLooper.ts`) plays seams at the per-sample duration. Reports show `xf (ms)` and `worstRes (dB)` per pick; summaries carry `worstResDb` + a crossfade histogram.

### Seam-lag refinement (`seamLagRefine`, opt-in)

On vibrato-FM material the +ZC candidate grid aligns two seam points only up to the *average* period — the instantaneous phase at `b` can sit a fraction of a cycle off from `a`, so fixed-phase validation rejects (or barely admits) pairs that a few samples of b-side shift would make clean. Measured on the shipped phil-cello: the Fs4 seam went −3.3 dB → −11.0 dB with a 6-sample shift, and forte G2 went from 3 valid pairs (red tier → the fortissimo `filePatterns` fallback fired) to 24. With `gateOpts.seamLagRefine: true`, every pair surviving the O(1) gates gets `b` snapped to the residual-minimizing lag within ±`seamLagSearchPeriods` fundamental periods (default 0.6) **before** the corr + residual gates — the rescue class is precisely pairs that fail correlation at grid phase but pass at the refined lag — and the refined `b` is what the pair emits (per-seam `bLag` lands in `selectedSeamStats`). Coarse-to-fine search (stride T/16, then ±stride at step 1), lags clamped so the full window stays in-buffer. Cost is negligible (full 49-note phil-cello run: ~15 s). Opt-in until the brass/winds control reruns validate it as a default.

Caveat discovered while tuning phil-cello v2: the residual gate is **non-monotonic in picks** — loosening −14 → −12 *lost* C2 while gaining the mid-band, because the distance-descending greedy prefers long pairs and a looser gate admits long-but-marginal pairs that displace short clean ones via endpoint separation (then SCC pruning lands elsewhere). Gate choice is a per-note tradeoff; the perceptual selection layer below resolves this by minimizing rather than gate-laddering.

### Perceptual seam selection (`seamPerception`, opt-in)

The residual gate is a **click** detector; the artifacts that remained audible on held loops are wrap-aligned **bumps/wahs** it cannot see. Two ear-validated mechanisms (compare-harness listening sessions, 2026-08; measurement layer in `packages/analysis/src/seam-perception.js`):

- **Modulation-phase chop** — the wrap splices vibrato mid-cycle: the FM (pitch cents) / AM (envelope) / tilt (high-band ratio) trajectory jumps from phase(b) to phase(a); severity tracks the phase distance Δφ. Vibrato is detected by **cross-harmonic rate agreement** (cents tracks on independent loud harmonics peaking within 0.3 Hz) — correlation alone is fooled by bow jitter, which is genuinely common-mode across harmonics but aperiodic (open C2: per-harmonic rates scatter 2.5–4.7 Hz; fingered notes: all 5.3–6.1 Hz). Depth = sinusoid amplitude at the agreed rate, not track std.
- **Per-partial splice discontinuity** — independent per-partial beats put each partial at a different point of its own beat cycle at a vs b: the wrap teleports the spectral snapshot (per-partial level step, plus a mid-fade phase-cancellation dip), even when carrier phases align and residual is −15 dB. Energy redistributed *between* partials is invisible to a waveform difference. Measured coherently per partial at refined frequencies, window ≥ max(2 cycles of partial, 3 cycles of f0) so partials resolve. Partial **admission** is by max **A-weighted** level over nine windows spanning the loop (k ≤ 12, < 5.5 kHz, A-rel ≥ −20 dB): single-window admission sampled beating partials at their dip and hid audible movers (C2's ~740 Hz h11 shift shipped as a green seam), and unweighted thresholds hide high-frequency movers at a low note's register.
- **Per-partial slow-state step** — the spectral-settling channel: |300 ms-smoothed per-partial envelope at a − at b|. A wrap from a settled b back into an onset tail a resets the spectral evolution every pass (C2 settles for >1 s), invisible to RMS steadiness, trend flattening, and the instantaneous splice step alike. Deliberately the endpoint mismatch, NOT the interior range — range grows with segment length and wrongly punishes long segments whose slow evolution is musical (a range-based first cut reshuffled the whole pick set toward short segments).

`gateOpts.seamPerception: true` (or an options object) enables three layers in `selectSegmentsCore` — **minimize, don't just filter** (hard-gating at audibility thresholds deletes whole notes on sources whose seams are inherently bumpy):

1. **Admission** at catastrophe level only (`modPhaseMax` 0.45 cyc; `partialStepDbMax`/`partialDipDbMax`/`partialSlowDbMax` 12 dB; `pitchStateCentsMax` 12¢ — admission must not kill notes; that call belongs to the prune, and 8 dB bars silently deleted E3 once the fixed admission exposed more audible partials). **Perception mode retires the legacy gates whose thresholds were never audibility-tied** (2026-08-18 audit): the 1% amp-step default (0.09 dB) rejected 20k–1.7M pairs per note — the actual cause of the 3-segment ceiling — and is kept only as a loose 0.30 (≈3 dB) perf bar; slope/tilt/tiltSlope go to ∞; corr is subsumed by residual; the 5¢ `pitchStep` (rejecting on smoothed-curve vibrato wiggle, 226k pairs on Fs4) is replaced by the **pitch-state channel** — vibrato-integrated (400 ms) common pitch-track mismatch at the splice points (`pitchStateCentsTarget` 3¢, severity ¢/20) — the tuning-honest formulation, live on non-vibrato notes too (bow-flattening drift). Explicit config values always win. Candidates are thinned to a ~10 ms grid in perception mode (the retired amp gate had been the accidental perf throttle; sub-ms +ZC candidates are redundant under 100 ms endpoint separation + lag refinement). Result: 46/49 phil-cello notes usable (was 14–20), C4/D4 pickable for the first time, E4/Fs4 at 4 mostly-green segments.
2. **Quality-first greedy ordering** (severity bucketed to 0.05, then distance) with an automatic **coverage fallback** to distance ordering when quality-first strands the SCC (clean pairs that don't overlap).
3. **Quality prune** after SCC/maxSegments: iteratively drop the worst-excess non-bridge while > `minKeepSegments` (3) remain and it exceeds the ear targets (`modPhaseTarget` 0.15 cyc, `partialStepDbTarget` 2.5 dB, `partialDipDbTarget` 3 dB, `partialSlowDbTarget` 2.5 dB), targets scaled down linearly below `wrapRefSec` (0.5 s) of pair length — **wrap-rate weighting**: a 0.1 s segment wraps ~9×/s, so repetition makes small discontinuities salient.

**Sample-level onset-blip gate** (pre-processing, ear-found on phil-cello Gs5): a QUICK level excursion in the middle of an otherwise smooth onset trajectory — plays on every note-on, unreachable by seam selection. Detector: two-sided flank extrapolation on the 30 ms envelope (fit left and right flanks ±45–150 ms separately; score = min(|rl|,|rr|) when both residuals share a sign). A blip departs from BOTH flank predictions; a knee or slope change sits between them and scores 0 — so **onset overshoot of any size or duration never gates** (it is normal attack shape; a first-cut overshoot gate wrongly demoted E5 and would have destroyed brass). Normalized against the onset region's own p90 (local, pre-vibrato context — steady-region AM is not a fair reference since the flanks cannot track it). Emitted as `stats.onsetBlipDb/AtSec/Ratio`; red iff ≥ 2.5 dB AND ≥ 2× local (`gateOpts.onsetBlipDbMax`/`onsetBlipRatioMin`), with a report reason; sub-bar blips (≥1.5 dB, ≥1.5×) compete in the pick tiebreak at /16. Onsets shorter than 20 hops are unjudgeable and never gate. Calibration: Gs5 3.4 dB@2.3×, G3 6.4@2.4×, D4 3.8@2.7×, G4 3.5@2.1× fire; E5 (6.7 dB but 1.3× — rough context, no isolated event) and every clean member pass.

**Modulation-depth-step seam channel**: the wrap compares vibrato DEPTH as well as phase — a seam from developed vibrato back into a pre-vibrato region collapses the vibrato every pass (phil-cello G5: 8× AM-depth mismatch; Δφ is blind there, a flat trajectory has no phase). Per active channel: |depth(a) − depth(b)| (AM/tilt in dB-equivalents, FM in cents; single-bin DFT magnitude at the vibrato rate) plus a PRESENCE ratio (max/min when the louder side clears the channel floor). Admission bars `modDepthDbMax` 3 dB / `modDepthCentsMax` 15¢ / `modDepthRatioMax` 3× (the ratio form matters: presence collapse understates in dB — G5's 8× was only 1.4 dB); prune targets 0.6 dB / 4¢; severity dB/4, ¢/20.

**Set-relative outlier gate** (`pickSamples` — the project-brief "coherence of the set as a whole" gate): per-sample features `attackTonalLagMs` (trim → sustained harmonic dominance; the articulation-speed percept) and `steadyBrightnessDb` (HF>1.5 kHz/total over steady) are judged against the median of usable neighbors within ±6 st (self excluded, ≥3 neighbors). Demotion (red, with reasons in the report) ONLY from post-normalization-audible dimensions at severity ≥ 0.4 — source-level deviation is inaudible after gain normalization and stays a weak tiebreak signal (a first cut demoted half the set on level alone). phil-cello: B3 demoted at 0.62 (speaks in 5 ms vs neighbors' 70 ms, 4.6 dB brighter — the different-dynamic-band percept), D2/G2/E2 likewise; the 0.31–0.34 borderline cluster merely loses pick votes.

The CLI picker's window tiebreak also ranks by worst kept-seam severity (bucketed 0.1) between tier and segment count, so a near-silent note beats a bumpy neighbor for a pick slot. Per-seam `modPhase`/`pStepDb`/`pDipDb` land in `selectedSeamStats`; `nQualityPruned`, `rejectByModPhase`, `rejectByPartial`, and `seamOrderFallback` in diag. Profile is built once per sample on the trend-flattened gate signal and memoized across window/ladder reruns (~+30% CLI runtime). Result on phil-cello v3 (forte-only, residual relaxed to −10): worst-case-study C2 went from p7/p6/p3 seams to all ≤ p2; 14 picks C2–B5 with max 6-semitone gap; remaining red seams are min-keep-floor "best this source can do" cases and are visible in the harness.

### Compare harness (`compare.html`)

Offline A/B tool for auditing rebuilt `.hki`s against shipped ones by ear + metrics: `/analyzer/compare.html` (second Vite entry, `src/compare/main.ts`). Loads two bundles (dropdowns fed by `out/compare/index.json`, or `?a=<url>&b=<url>`), plays matching samples through the **production engine path** (`@hkl/engine` loadInstrument/sNoteOn with `instrumentProvider` — trend bake, segment looper, per-sample `crossfadeSec`, fixed velocity 100 both sides), and cross-references with **as-played** metrics computed in-page on the decoded shipped audio with the manifest trend applied engine-style. Blind mode randomizes the 1/2 → A/B mapping; Δpost > 1 dB flags loudness bias.

The primary per-seam metric is **Δφ — the vibrato-modulation phase jump at the wrap** (cycles: 0 = wrap lands in-phase, 0.5 = anti-phase), measured on three channels: **FM** (pitch trajectory in cents via fundamental-isolated +ZC periods — the dominant channel for string vibrato), **AM** (pitch-aware-windowed RMS envelope), **tilt** (high-band ratio). Chips show FM·AM in centicycles, colored by the worst channel that clears its depth floor (FM ≥ 3¢, AM ≥ 0.4 dB, tilt ≥ 0.5 dB; neutral when none do); thresholds green ≤ 0.12 / yellow ≤ 0.25 are provisional. **Ear-validated 2026-08 on phil-cello: the audible loop "bump/wah" is wrap-aligned (H1) and severity tracks Δφ** — crossfade-window residual dB (the click metric) does not predict it and is demoted to tooltips. Click-to-zoom shows four strips: FM and AM trajectories ±2.5 vibrato cycles around `a` vs `b` (the mismatch the wrap splices), the RAW pre-trend envelope across the segment interior (exposes H2 interior events like bow retakes that trend-flattening hides from the level gates — phil-cello F2's −8 dB retake dip is the type specimen), and the carrier click view. **"Loop this seam"** solos one validated pair through the production `segmentLooper` starting at the loop point (attack skipped), with a wrap flash + counter — a bump at the flash is H1, a bump at a fixed position between flashes is H2.

Historical note: as-played residuals disagree with pipeline-predicted ones on tail-cut lossy samples (+529-sample decode shift from the copyCut remux dropping the gapless header — see `cli/bundle.js:copyCut`; known, compensated downstream, left as-is).

### Loop window + bundle tail-cut (source-length control)

Long sources (VSCO sustains run 4–14 s of internally cut-and-pasted material) would otherwise bloat bundles: the distance-descending picker spreads pairs across the whole file, and the bundler used to keep every byte. Two mechanisms fix this:

- **`gateOpts.loopWindowSec`** — clamps loop candidates to the first N seconds of the steady region. A number fixes the clamp; `null`/`0` forces the full region (legacy); **unset = AUTO** (the default): selection runs the full window first as the quality reference, then takes the smallest window from an ascending ladder (2.5/4/6/9 s) that preserves the segment count (capped at 5). Per-note optimal — a note whose loopable material sits late keeps its full window instead of losing coverage; the ladder floor keeps seam density at or below ~1 wrap/s. The chosen window lands in `stats.loopWindowSec`.
- **Bundle tail-cut (always on, loop path)** — audio past `maxSegB + crossfade + releaseTime + margin` never plays by design and never enters the archive: generate-samples marks `bundleCutSec` per pick; `bundle.js` cuts lossy sources by stream-copy (no re-encode, same extension, ~26 ms frame granularity) and folds the cut into the Opus encode for lossless sources. Decay instruments play full-length and are never cut.

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

`index.html` is a Vite entry. Per the analyzer import constraints in CLAUDE.md, `apps/analyzer/src/*` may import `@hkl/shared`, `@hkl/engine`, `@hkl/bridge`, `@hkl/analysis`, and its app-local `apps/analyzer/analysis/analyzer-visualization.js` — never HKL-side audio/midi/state/lumatone/render/composer code. This keeps the analyzer independent of HKL state.

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
