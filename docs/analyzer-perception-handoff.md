# Analyzer Perceptual Pipeline — Handoff (2026-08-17/18)

Two-day session rebuilding the analyzer's loop-quality machinery around what
the ear actually hears, driven by Max's iterative listening on the Intonalogy
cello set. Result: `phil-cello-v11` — every sample passes Max's preliminary
ear test — staged for in-context Intonalogy testing. This document is the
canonical record of every methodology change, the reasoning (including the
rejected formulations — several were instructive failures), and the staged
next plan. Per-round detail lives in [decisions.md](decisions.md) (entries
dated 2026-08-17/18); the developer reference is
[architecture/analyzer.md](architecture/analyzer.md).

**Calibration caveat (Max, closing the session)**: every threshold below was
ear-calibrated on ONE sample set (Philharmonia solo cello, 1.5 s forte
bucket). They crossed "good enough" for this set; further precision-tuning
without data from other instruments risks specializing to this set. Collect
brass/winds/piano experience before tightening anything globally.

---

## 1. The problem, reframed twice

The session began as "improve seam quality" and was reframed by listening:

1. **Clicks are not the problem.** The crossfade-residual gate (a click
   detector) was already live; clicks are solved both here and in
   Intonalogy. Optimizing residual dB further optimized the measurable, not
   the audible — a mistake made and corrected early (including a wasted
   detour into the tail-cut decode-offset, already known and compensated
   downstream; see §8).
2. **The audible artifacts are wrap-aligned "bumps/wahs"** — confirmed by
   ear via the harness's solo-seam looper (bumps land on the wrap flash) —
   plus a family of *sample-level* defects no seam selection can reach.

## 2. The compare harness (`apps/analyzer/compare.html`)

The instrument that made ear-driven iteration possible; an offline second
Vite entry. Loads two `.hki` bundles (dropdowns from `out/compare/index.json`
or `?a=&b=`), plays samples through the **production engine path**
(`@hkl/engine` with `instrumentProvider`; trend bake, segment looper,
per-sample `crossfadeSec`, fixed velocity both sides), and cross-references
with **as-played** metrics recomputed in-page on the decoded shipped audio.
Key affordances: per-seam metric chips (click → 4-strip zoom: FM/AM
modulation overlays around both splice points, raw-envelope interior,
per-partial level bars), **"Loop this seam"** (solo one validated pair via
the production `segmentLooper`, wrap flash + counter — bump AT the flash =
modulation chop; bump at a fixed position = interior event), blind A/B,
Δlevel bias warnings. All measurements mirror `seam-perception.js` so the
harness and selector speak one language.

## 3. Seam-level channels (why each exists)

All in `packages/analysis/src/seam-perception.js` (profile built once per
sample on the trend-flattened gate signal, memoized across window/ladder
reruns) and consumed by `selectSegmentsCore`. Severity currency: Δφ in
cycles; dB-family metrics map at /16 (ear-calibrated: audible partial steps
started ~2.6 dB, clean control ≤1.2 dB); cents at /20; depth-dB at /4.

- **Seam-lag refinement** (`seamLagRefine`): the +ZC candidate grid aligns
  vibrato-FM material only to the average period; snapping `b` to the
  residual-minimizing lag (±0.6 periods, coarse-to-fine, pre-corr-gate)
  rescued whole notes (forte G2: 3 → 24 valid pairs) and let the forte-only
  single-dynamic set exist at all.
- **Δφ modulation-phase** (FM/AM/tilt): the wrap splices vibrato mid-cycle.
  Ear-validated ordering (red>yellow>green tracks audibility). Vibrato
  detection is **cross-harmonic rate agreement** (tracks on independent loud
  harmonics peaking within 0.3 Hz) — correlation alone is fooled by bow
  jitter, which is common-mode but aperiodic (open C2: rates scatter
  2.5–4.7 Hz; fingered notes: uniformly 5.3–6.1 Hz). Depth =
  sinusoid-amplitude-at-rate, NOT track std (std is inflated by tracker
  noise).
- **Per-partial splice step + mid-fade dip**: independent per-partial beats
  teleport the spectral snapshot at the wrap even when carrier phases align
  and total residual is −15 dB (open C2: +7.4 dB partial step; energy
  redistributed BETWEEN partials is invisible to a waveform difference).
  Coherent Hann single-bin per partial at refined frequencies; the window
  must resolve the partial spacing (≥ max(2 cycles of partial, 3 cycles of
  f0)) or "per-partial" degenerates into band mush.
- **Per-partial slow-state step**: |300 ms-smoothed per-partial envelope at
  a − at b| — the spectral-settling channel (C2 settles >1 s; a wrap into
  the onset tail resets the evolution every pass, invisible to RMS
  steadiness, trend flattening, and the instantaneous splice step alike).
  Deliberately the ENDPOINT mismatch, not interior range — range grows with
  segment length and wrongly punishes long, musical evolutions.
- **Pitch-state step**: |400 ms-smoothed common pitch track at a − at b| in
  cents — sustained pitch mismatch (tuning-critical). Replaces the legacy
  5¢ pitchStep gate, which rejected on smoothed-curve vibrato *wiggle*
  (226k pairs on Fs4, costing segments) rather than sustained mismatch.
- **Modulation-depth step + presence ratio**: the wrap compares vibrato
  DEPTH as well as phase — a seam from developed vibrato into a pre-vibrato
  region collapses the vibrato every pass (G5: 8× AM-depth mismatch; Δφ is
  blind there — a flat trajectory has no phase). The RATIO form is
  essential: 8× presence collapse is only 1.4 dB of depth difference.

## 4. Selection architecture: minimize, don't filter

Hard-gating at audibility thresholds deletes whole notes on sources whose
seams are inherently bumpy. Three layers instead:

1. **Admission** at catastrophe level only (0.45 cyc / 12 dB / 12¢ / 3×
   ratio) — admission must never kill a note; that call belongs to the
   prune (8 dB bars once silently deleted E3).
2. **Quality-bucket-first greedy ordering** (0.05 buckets, length breaks
   ties) with an automatic **distance-ordering fallback** when quality-first
   strands the SCC (clean pairs that don't overlap). Ordering severity is
   uncapped (a 0.5 cap collapsed rough material into one bucket where
   length won ties toward WORSE).
3. **Quality prune** to ear targets (0.15 cyc / 2.5 dB / 3 dB dip / 2.5 dB
   slow / 3¢ pitch / 0.6 dB / 4¢ depth), wrap-rate-scaled below 0.5 s pair
   length (a 0.1 s segment wraps ~9×/s; repetition is a salience
   multiplier), while > `minKeepSegments` (4) remain — plus a **soft floor**:
   a 4th seam beyond 2× targets is a defect, not variety (hard floor 3).

Perf notes: perception mode thins candidates to a ~10 ms grid (the retired
1% amp gate had been the accidental throttle — pools exploded to 10⁵–10⁶
pairs without it; sub-ms candidates are redundant under endpoint separation
+ lag refinement), and the lag-invariant partial-step bar runs before the
O(window·lags) lag search. `minEndpointSepSec` drops to 0.05 in perception
mode (0.1 predated perceptual scoring; 50 ms apart = 0.27 vibrato cycles =
genuinely distinct seams) — this is what lifted segment counts to 4–6.

**Legacy gates retired in perception mode** (audited 2026-08-18): the 1%
amp-step default (0.09 dB — 30× below audibility, rejecting 20k–1.7M pairs
per note and causing the 3-segment ceiling) → kept only as a loose 0.30
(≈3 dB) perf bar; slope/tilt/tiltSlope → ∞ (perceptual channels subsume
them); Pearson corr → disabled (residual subsumes it); pitchStep 5¢ →
replaced by pitch-state. Explicit config values always win.

## 5. Sample-level pre-gates

- **Onset blip** (`onsetBlipDb/Ratio`, red ≥2.5 dB AND ≥2× local): a QUICK
  excursion mid-onset, detected by **two-sided flank extrapolation** (linear
  fits on ±45–150 ms flanks; score only when the center departs from BOTH
  predictions in the same direction). A knee/swell/sag sits BETWEEN the
  predictions and scores 0 by construction — **onset overshoot of any size
  or length never gates** (it is normal attack shape; a first-cut overshoot
  gate wrongly demoted E5 and would have destroyed brass). Normalized to the
  onset's own p90 (steady-region vibrato is not a fair reference). Onsets
  too short to have a middle emit null and never gate.
- **Unsteady vibrato** (`fmUnsteadyCents`, red ≥4¢ off-line AND ≥2.5× the
  rate line): 3–9 Hz FM band energy minus the dominant line — rateless FM
  energy that no per-seam gate can lock onto (D3, A3). A broadband-std
  first cut demoted clean low notes on ZC tracker noise — band-limit or bust.

## 6. Set-relative gates (`pickSamples`) — the "coherence of the set" gate

A sample can be individually flawless yet not belong. Features (emitted in
`stats`, judged vs the median of usable neighbors within ±6 st, self
excluded, ≥3 neighbors): **attackTonalLagMs** (trim → sustained
harmonic-fraction >0.6; B3 speaks in 5 ms where neighbors swell 30–85 ms —
the "different dynamic band" percept; note the ear reported it inverted, as
B3 being "late"), **steadyBrightnessDb** (HF>1.5 kHz/total; B3 −6.2 vs
−10.8), **vibrato depth** (rate-line cents, log-domain; Ds3 ±1.9¢ vs ~±7¢ —
its absolute numbers were the smallest in the set; only neighbor contrast is
audible). Demotion at severity ≥0.4 from AUDIBLE dimensions only —
**source-level deviation never demotes** (inaudible after gain
normalization; a first cut demoted half the set on level alone) and is a
half-weight tiebreak signal.

**WARNING for brass**: FluidR3 trombone is zone-stitched with 2–8 dB
brightness/attack cliffs between adjacent notes that Max explicitly accepts
as realism. The set-relative gate WILL fire on those cliffs. Widen or
disable it per-config for brass (`gateOpts` overrides exist for everything)
— this is the first thing to check in the brass rebuild.

## 7. The picker (quality-first, perception mode)

Severity-bucket greedy (legacy tiebreak inside a bucket) at ≥2 st
separation; **sub-red bar (0.3, `pickWorstSevMax`) applies to SEAM severity
only** (set-deviation ranks but doesn't bar below its own 0.4 demotion
level); coverage pass fills gaps > `pickSpacing` with the best remaining
sub-red at relaxed ≥1 st separation. **Gaps appear exactly where no sub-red
material exists — preferred over bridging with an audible defect (Max,
repeatedly and explicitly).** The legacy spine/fill walker had tier
outranking severity (green-but-red-seamed D3 beat clean-but-blue Cs3 —
bridge-count is variety shape, not audibility) and window geometry that
skipped notes entirely (pristine A2). `excludeNotes` config array = manual
veto hatch (first use: A2). `HKL_PICK_DEBUG=1` dumps picker severities.
Fixed en route: empty-spine gap flags in the fill pass silently dropped the
lowest usable note whenever a set had zero greens.

## 8. Known quirks & open ends

- **Tail-cut decode shift (+529 samples)**: `bundle.js` stream-copy cutting
  drops the mp3 gapless header; cut samples decode ~12 ms late vs analysis
  coordinates. **Intonalogy compensates on their side (validated); HKL and
  the harness do NOT.** Do not "fix" the bundler — it would break their
  compensation (comment at `bundle.js:copyCut`). Consequence: harness
  as-played metrics/audition on cut samples are pessimistic vs Intonalogy
  reality (A2's ambiguous seam-1 verdict came from this path; vetoed rather
  than litigated).
- Fast-pop onset detection deferred (slope-lag flags legitimate attacks;
  needs slope-aware fitting if the defect class ever materializes).
- The harness AM/FM strips and the tooltip carry every per-seam metric;
  chips show ΔφFM·ΔφAM·p-effect.
- Probe scripts from this session live in the session scratchpad (gone next
  session); their logic is captured here and in decisions.md.
- Thresholds are phil-cello-calibrated (see caveat at top).

## 9. Current state

- **`phil-cello-v11`** (= configs/phil-cello-v11.json): 17 picks C#2–C6,
  every sample passes Max's preliminary ear test; deliberate gaps at
  Gs2–Cs3, Cs3–Fs3, Gs3–Cs4, Fs4–As4 (all in-gap candidates measure red or
  outlier). Excluded with reasons: B3/As3/E2/G2/D2/F3 (set outliers),
  G3/D4/G4/Gs5 (onset blips), D3/A3 (unsteady vibrato), A2 (veto), Ds3
  (vibrato-depth outlier), E3/G5 (−5/−6 dB mid-fade partial dips; Fs5 —
  clean but **not yet ear-vetted** — covers the G5 slot).
- **Ship candidate built**: `configs/phil-cello-ship.json` = v11 under the
  production `instrumentKey: cello_phil` → `out/cello_phil.hki` (verified
  identical pick set), staged in the harness as "strings SHIP CANDIDATE".
- Compare harness index carries v1/v6/v8–v11/ship for A/B archaeology.

## 10. Next plan (staged)

1. **Ship strings** (Max-gated):
   - Max: final harness pass on the ship candidate (esp. Fs5).
   - Copy `apps/analyzer/out/cello_phil.hki` → `handoff/intonalogy/strings.hki`
     (Max approves/executes; provenance travels inside the bundle).
   - In-context Intonalogy test — note their decode compensation makes
     their playback the source-aligned one (better than the harness).
2. **Brass (FluidR3 trombone)** — the deferred session-one items:
   - Rerun through the perceptual pipeline (`seamPerception: true`,
     `seamLagRefine: true`); **first check**: set-relative gate vs the zone
     cliffs (§6 warning) — widen/disable per-config as needed.
   - **Attack-consistency shaping** (session-one plan, still unbuilt): the
     Bb1–G2 zone has 5–6 dB attack splats vs ~0.5 dB for the rest of the
     set; the fix is trend-head authoring at build time (the engine already
     bakes trend into PCM) — trim-only, never inflate. The onset-blip
     detector's overshoot-immunity gets its first real test here.
   - No in-place replacements exist within FluidR3 (zone-locked); source
     search remains out of scope until Max deems it necessary.
3. **Winds (FatBoy clarinet) control rerun**: the healthiest set (attack
   spread 0.5 dB) — expect near-zero change; it validates that perception
   defaults don't damage good material. Ship only after A/B confirms no
   regression.
4. **Longer term**: gate-threshold refinement wants MORE instrument
   families first (Max: avoid specializing to one set). The harness +
   `HKL_PICK_DEBUG` + per-report reasons are the calibration instruments.
