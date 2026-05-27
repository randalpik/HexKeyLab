# HexKeyLab Architecture — Overview

The source-of-truth reference for what HexKeyLab is and how it's organized. This file holds the
**cross-cutting** concepts (tuning, color, coordinate system, file formats, inter-app data flows)
and the repo map. Per-app deep-dives live alongside it:

- [**hkl.md**](architecture/hkl.md) — the core viewer/player app: hardware I/O, display, controls,
  Lumatone in/out, recording, transcription, render subsystems.
- [**composer.md**](architecture/composer.md) — HKL Composer: the Verovio score editor, bridge,
  MEI model, cursor/input, ties, tuplets, selection.
- [**analyzer.md**](architecture/analyzer.md) — HKL Analyzer: the sample-analysis UI + Node CLI +
  shared DSP engine.
- [**engine.md**](architecture/engine.md) — `@hkl/engine`: the standalone sample playback library
  (loop scheduling, crossfade, velocity, `.hki`), plus the other shared libs.

Design *rationale and history* live in [`decisions.md`](decisions.md); gotchas in
[`lessons.md`](lessons.md); the agent operating-manual + critical hardware constants in
[`CLAUDE.md`](../CLAUDE.md).

## Repo layout

A pnpm monorepo. There is no top-level `src/`.

```
apps/
  hkl/        core viewer/player          (@hkl/hkl)      → hkl.md
  composer/   score editor                (@hkl/composer) → composer.md
  analyzer/   sample analyzer UI+CLI       (@hkl/analyzer) → analyzer.md
packages/
  shared/     pure data: tuning math, note naming, segments, dynamics, hki, colors, heji
  engine/     @hkl/engine — sample playback                → engine.md
  notation/   @hkl/notation — Verovio/MEI rendering
  bridge/     @hkl/bridge — BroadcastChannel protocol + message types
test/         composer-test, composer-inspect, bounds-probe, interval-names, engine-smoke, *-check.mjs
tools/        lumatone-cal, reset-calibration.sh   (hardware/ops)
vite/         dev-proxy.mjs + middleware (the dev umbrella)
```

Dependency DAG: `@hkl/shared ← {engine, notation, bridge} ← apps`. `pnpm dev` runs all three app
servers behind a single-origin reverse proxy at `http://localhost:5170` (`/`→hkl, `/composer/`,
`/analyzer/`) — same origin is required because the HKL↔Composer/Analyzer `BroadcastChannel` bridge
and the `IndexedDB` instrument registry are per-origin. See [CLAUDE.md](../CLAUDE.md) for the run/
build/test commands.

---

## Tuning system

The lattice, tuning modes, and frequency math are shared by HKL and Composer (via
`@hkl/shared/freq.js`).

### Lattice (Harmonic Table)

- **q-axis** → major thirds (5:4).
- **r-axis** → perfect **fifths** (3:2), NOT minor thirds (verified from LTN data: (0,1) → 3/2).
- Minor third (6:5) is the derived direction `(−1, +1)` since `(5/4)⁻¹ × (3/2) = 6/5`.
- **Banded JI**: the board is 3-key-wide **bands** along q; within a band intervals are pure
  5-limit JI, with **seams** between bands. Every key is exactly 2:1 above the key 3 positions left
  on q. 5-limit constrains the prime-5 exponent to ±2 (`posInBand ∈ {0,1,2}`), so the diesis
  (128:125) is unreachable in 5-limit but reachable in 7-limit.

### Coordinate summary

| sym | meaning |
|---|---|
| `q` | major-third axis (5:4) |
| `r` | fifths axis (3:2) |
| `p` | `posInBand(q)` — position in the 3-wide octave band (0,1,2) |
| `qmod3` | `((q%3)+3)%3` — the three q-lineages: 0 = Pythagorean fifth-chain spine, 1 = 5-limit M3 above qm0, 2 = 5-limit m3 above qm0 |

Origin: **A3 = 220 Hz** at `(0,0)` (`bandOf=0, posInBand=1`), middle of the board.

### Tuning modes

`TuningMode = 'E' | '5' | 'P' | 'D' | '7' | 'V'`, declared in **both**
`apps/hkl/src/state/persistence.ts` (app state) and `@hkl/shared/freq.js` (shared, self-contained)
— keep them in sync (see CLAUDE.md). Each cell's offset is a
`RegionInfo = {type:'A'|'B', aDepth, aUpper}`; `apps/hkl/src/tuning/regions.ts:regionInfoWithState`
maps `(mode, qmod3)` → RegionInfo, and the frequency builder applies it: `aDepth>0` multiplies by
`(80/81)^d` (aUpper) or `(81/80)^d`; `type='B'` additionally multiplies by `63/64`. Selector order:
**Equal · Ptolemaic · Pythagorean · Semiditonal · Septimal · Schismatic**.

| Mode | qm0 | qm1 | qm2 | Produces |
|---|---|---|---|---|
| `'E'` Equal | — 12-TET, regions not consulted — | | | Pure equal temperament. |
| `'5'` Ptolemaic *(default)* | A-d0 | A-d0 | A-d0 | 5-limit JI base; full 5-limit major + minor. |
| `'P'` Pythagorean | A-d0 | +SC | −SC | Every M3 = 81/64, every m3 = 32/27; no 5-limit ratios. Study layout. |
| `'D'` Semiditonal | A-d0 | A-d0 | −SC | 5-limit major; Pythagorean minor (32/27) band-local in qm2. |
| `'7'` Septimal | A-d0 | A-d0 | B (−SC + 63/64) | Uniform 7-limit (below). |
| `'V'` Schismatic | A-d0 | A-d0 | −SC | Like Semiditonal, but `freqAt` also multiplies the band factor by `SCHISMA^band` (≈1.95¢) — pure-thirds octave stretch; the band crossing spells as a `d4`. Study mode. |

**Uniform septimal (`'7'`)** — qm2 is region B `(aDepth=1, aUpper=true)`, qm∈{0,1} is region A.
Octave-invariant (shares `qmod3`). Every qm0 spine cell has its harmonic 7th (7/4) two rows up in
qm2 at the same `r`, so dominant 7 (4:5:6:7) is reachable from any qm0 root and half-diminished 7
(5:6:7:9) from any qm1 root; major triads stay 5-limit-pure. Key-symmetric (the "root" is the ref
note, not tuning state). **Trade**: 5-limit minor (10:12:15) is unreachable — minor becomes
Pythagorean (32:27) or septimal subminor (7:6); use `'5'` for 5-limit minor. The same trade applies
to `'D'`/`'V'`.

Persistence has no back-compat shims: any unrecognized `tuning` value reverts to `'5'`.

### Frequency formulas

```
5-limit:  freq(q,r) = 220 · 2^bandOf(q) · (5/4)^(posInBand(q)−1) · (3/2)^r
          bandOf(q) = floor((q+1)/3);  posInBand(q) = ((q+1)%3 + 3)%3
Equal:    freq(q,r) = 220 · 2^((4q + 7r)/12)
```

Modes `'P'/'D'/'7'/'V'` use the 5-limit base times the RegionInfo multiplications above (`'V'` adds
`SCHISMA^band`). **JI ratio** between two keys factors as `2^e2·3^e3·5^e5` with `e5=Δp`, `e3=Δr`,
`e2=Δb − 2Δp − Δr`; 7-limit extends with a prime-7 exponent, and each region adjustment shifts the
exponent vector. Implemented in `@hkl/shared/freq.js` + `apps/hkl/src/tuning/`.

### Ref-driven layout shift

The reference note (Ctrl+click any hex, or set from Composer) slides the lattice under the static
outline so the ref's spine cell lands at the outline center:

```ts
// apps/hkl/src/tuning/refspine.ts
refSpine(refQ, refR) = qmod3 0 → (refQ,   refR)      // Pythag spine
                       qmod3 1 → (refQ−1, refR)      // 5-limit M3 above qm0
                       qmod3 2 → (refQ+1, refR)      // same-row Pythag spine
```

Applies in all outline modes (`lumatone`/`qwerty`/`none`) and all tuning modes; ref changes tween
via `apps/hkl/src/render/animation.ts`. Piano outline is the exception — it uses
`computePianoViewCenter(...)` to solve a tilt-dependent placement instead.

**Held-voice migration**: on ref change, voices from *physical* inputs migrate with the lattice
(Lumatone `"ch,note"` in `apps/hkl/src/midi/handler.ts:heldLumatonePhys`; QWERTY `e.code` in
`apps/hkl/src/input/keyboard-notes.ts:heldCodes`) so a held key keeps its relative pitch;
*mouse-click* voices stay anchored to their lattice cell. Fan-out: `apps/hkl/src/effects/onRefChanged.ts`.

**Ref validation** (`validateRefNoteCandidate` in `apps/hkl/src/render/draw.ts`): two constraints —
(1) `coordToMidi(q,r) = 57 + 4q + 7r ∈ [21,108]`; (2) the 88-cell footprint spells with ≤ ±3
accidentals. The dotted "valid ref bounds" overlay is a cached visual aid from the same check, not a
separate gate.

**Octave-consistent 88-cell picker** (`compute88PianoCoords`): for each MIDI 21..108, picks the
`(q,r)` with `4q+7r = midi−57` minimizing reduced Tenney Height to the ref, tiebroken by an
octave-normalized projection so each pitch class stays on its ref-aligned lineage (Eb3/Eb4 share
spelling; the ref maps to itself). `'V'` routes the picker through `'D'` state so schisma exponents
don't distort the spelling. → see decisions.md "V-mode picker routes through D state".

Coverage: ~55 unique MIDI/ref in 5-limit; 88-cell footprint per ref in 7-limit (~208–210 unique
pitches reachable from a central key). One LTN file gives every physical key a stable
`(channel, note)`; all tuning/layout interpretation is runtime software state — no per-layout LTN,
`.scl`/`.kbm`, or external synth config.

---

## Color scheme

Hue encodes lattice position; light/dark encodes the 12-TET black/white key.

- **5-/7-limit — 7 hues × {light,dark}** (+14 B-region warm-shifted variants in 7-limit):
  `hueCycle = [PU,PK,OR,YE,GR,TE,BL]`, indexed by `(floor(midi/12) − bandOf(q) − 4) % 7`
  (`midi = 57+4q+7r`). B-region (septimal qm2) keys get `.sl`/`.sd` variants, a 50% lerp toward the
  next hue. Pure-SC-shift modes (`'P'`/`'D'`/`'V'`) color shifted cells as their SC sibling via
  `keyColorVariant` in `apps/hkl/src/render/colors.ts` (no new variants needed).
- **Equal — 3 hues**: `[BL,PU,PK][floor(midi/12) % 3]`, rotated so A3 = purple.
- **Light vs dark**: by pitch class `(57+4q+7r) % 12` — light if ∈ {0,2,4,5,7,9,11}, else dark.

Base palette (light/dark hex): PK `#FF4C79`/`#59002C`, PU `#C94CFF`/`#3E0059`, BL `#4C96FF`/`#002559`,
TE `#4CFFBA`/`#005937`, GR `#55FF4C`/`#045900`, YE `#FFF94C`/`#595600`, OR `#FF884C`/`#591D00`.

---

## File formats

| Format | What | Owner / detail |
|---|---|---|
| `.hkr` | Native recording: layout snapshot + flat coordinate-event stream. Source of identity is lattice coords, not pitch. | hkl.md "Recording & playback" |
| `.mid` | MPE export/import of a recording (manager ch 1, members 2–16, ±48st bend) so per-voice JI survives a DAW round-trip. | hkl.md |
| `.hki` | Instrument bundle (manifest + audio) produced by the Analyzer CLI, consumed by `@hkl/engine`; imported ones persist in IndexedDB. | engine.md, analyzer.md |
| `.hkc` | Composer document: MEI XML with HKL attrs (`data-q`, `data-r`) on each note. Also the output of the `.hkr` → sheet-music transcription pipeline (colored noteheads), which builds it via the shared `@hkl/notation/mei-build` builder. | composer.md, hkl.md "Transcription" |

---

## Cross-app data flows

- **Play → record → sheet music**: input (QWERTY/mouse/Lumatone) → `@hkl/engine` voices, captured
  as a `.hkr` coordinate stream → playback drives the same engine path → the transcription pipeline
  turns a `.hkr` into a Composer-native `.hkc`, which is either downloaded or bridged straight to
  Composer (`import-score`) for editing. (Emit is HKL-side — see hkl.md.)
- **HKL ↔ Composer**: same-origin `BroadcastChannel('hkl-composer-bridge')`. HKL sends resolved
  held-chord records (`{q,r,pname,accid,oct,midi,colorHex,velocity}`); Composer holds MEI state and
  emits `play-score` requests that HKL plays through `@hkl/engine`. Composer imports none of HKL's
  audio/MIDI/state — only `@hkl/bridge`/`@hkl/notation`/`@hkl/shared`. See composer.md.
- **Analyzer → HKL**: the Analyzer CLI generates instrument blocks (spliced into
  `apps/hkl/src/audio/samples-data.ts`) and `.hki` bundles; the Analyzer tab writes imported
  bundles to the shared IndexedDB registry that HKL reads (same origin). See analyzer.md, engine.md.
