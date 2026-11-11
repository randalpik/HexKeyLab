# HexKeyLab Architecture — Overview

The source-of-truth reference for what HexKeyLab is and how it's organized. This file holds the
**cross-cutting** concepts (tuning, color, coordinate system, file formats, inter-app data flows)
and the repo map. Per-app deep-dives live alongside it:

- [**hkl.md**](architecture/hkl.md) — the core viewer/player app: hardware I/O, display, controls,
  Lumatone in/out, recording, transcription, render subsystems.
- [**composer.md**](architecture/composer.md) — HKL Composer: the Verovio score editor, bridge,
  MEI model, cursor/input, ties, tuplets, selection.
- [**analyzer.md**](architecture/analyzer.md) — HKL Analyzer: the sample-analysis UI + Node CLI +
  the shared `@hkl/analysis` DSP.
- [**orchestrator.md**](architecture/orchestrator.md) — HKL Orchestrator: samples a physical MIDI
  device into a velocity-layered `.hki` (discovery + capture + quality gates).
- [**engine.md**](architecture/engine.md) — `@hkl/engine`: the standalone sample playback library
  (loop scheduling, crossfade, velocity layers, `.hki`), plus the other shared libs.
- [**overlay.md**](architecture/overlay.md) — OBS live overlay: transparent lattice + Composer view
  into OBS via the `apps/overlay-host` distributable (relay + lean read-only build).

**User-facing guides** — how to *use* each app — live in [`guide/`](guide/): [core](guide/core.md),
[composer](guide/composer.md), [analyzer](guide/analyzer.md), [orchestrator](guide/orchestrator.md),
[overlay](guide/overlay.md). The architecture docs above are the developer reference.

Design *rationale and history* live in [`decisions.md`](decisions.md); gotchas in
[`lessons.md`](lessons.md); the agent operating-manual + critical hardware constants in
[`AGENTS.md`](../AGENTS.md).

## Repo layout

A pnpm monorepo. There is no top-level `src/`.

```
apps/
  hkl/          core viewer/player        (@hkl/hkl)          → hkl.md
  composer/     score editor              (@hkl/composer)     → composer.md
  analyzer/     sample analyzer UI+CLI     (@hkl/analyzer)     → analyzer.md
  orchestrator/ MIDI-device sampler        (@hkl/orchestrator) → orchestrator.md
  overlay-host/ OBS overlay distributable  (@hkl/overlay-host) → overlay.md
                (Node relay + serves the lean read-only overlay build; NOT a dev-proxy app)
packages/
  shared/     pure data: tuning math, note naming, segments, dynamics, hki, colors, heji
  engine/     @hkl/engine — sample playback                → engine.md
  notation/   @hkl/notation — Verovio/MEI rendering
  bridge/     @hkl/bridge — BroadcastChannel protocol + message types; analytics.ts (usage events)
  analysis/   @hkl/analysis — DOM-free sample-analysis DSP (Analyzer + Orchestrator) → analyzer.md
test/         composer-test, composer-inspect, picker, interval-names, engine-smoke, orchestrator-smoke, *-check.mjs
tools/        lumatone-cal, reset-calibration.sh   (hardware/ops)
vite/         dev-proxy.mjs + middleware (the dev umbrella); assemble-dist.mjs (the publish dir,
              `pnpm assemble`) + third-party-notices.mjs (its THIRD-PARTY-NOTICES.txt: the license
              notices of the apps' runtime npm dependency closure, written at the site root)
              + analytics-tag.mjs (the usage-analytics tag, added at assemble time → Usage analytics)
```

Dependency DAG: `@hkl/shared ← {engine, notation, bridge} ← apps`, plus `@hkl/analysis` (zero deps)
← {analyzer, orchestrator}. `pnpm dev` runs all four app servers behind a single-origin reverse
proxy at `http://localhost:5170` (`/`→hkl, `/composer/`, `/analyzer/`, `/orchestrator/`) — same
origin is required because the HKL↔Composer/Analyzer/Orchestrator `BroadcastChannel` bridges and the
`IndexedDB` instrument registry are per-origin. See [AGENTS.md](../AGENTS.md) for the run/build/test
commands.

Imports use bare `@hkl/*` specifiers: each package's `exports` maps `./*.js` → `./src/*.ts`
(`@hkl/analysis` mixes `.js` and `.ts`, so its map is `["./src/*.js","./src/*.ts"]`); imports inside a
package stay relative. Verovio's WASM is CDN-loaded by `@hkl/notation`, pinned to an exact release (`VEROVIO_URL`, 6.3.0; never `latest`, decisions.md 2026-10-30 "Pin Verovio"); the analyzer and orchestrator
bundle their own workers. The root `pnpm build` is `pnpm -r --filter='!./test/**' build`: test
packages are excluded because `test/react-consumer` links the git-ignored `packages/engine/dist`, which
breaks fresh-clone/Netlify builds (its smoke gate builds itself via `run.mjs`). `allowBuilds` in
`pnpm-workspace.yaml` gates dependency install scripts — esbuild must stay enabled.

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
  (128:125) is unreachable in 5-limit but reachable in 7-limit. The unbanded layout removes the
  bands (*Unbanded layout* below).

### Coordinate summary

| sym | meaning |
|---|---|
| `q` | major-third axis (5:4) |
| `r` | fifths axis (3:2) |
| `p` | `posInBand(q)` — position in the 3-wide octave band (0,1,2) |
| `qmod3` | `((q%3)+3)%3` — the three q-lineages: 0 = Pythagorean fifth-chain spine, 1 = 5-limit M3 above qm0, 2 = 5-limit m3 above qm0 |

Origin: **A3 = 220 Hz** at `(0,0)` (`bandOf=0, posInBand=1`), middle of the board.

### Tuning modes

`TuningMode = 'E' | '5' | 'P' | 'D' | '7' | 'V' | 'S' | 'Y'`, declared in **both**
`apps/hkl/src/state/persistence.ts` (app state) and `@hkl/shared/freq.js` (shared, self-contained)
— keep them in sync (checklist under *Adding a tuning mode* below). The per-mode tuning lives in exactly one place,
`coordExps` in `@hkl/shared/freq.js`: a per-`qmod3` column shift (SC = 81/80, septimal 63/64) on
the 5-limit base, plus a per-band offset for Schismatic and Syntonic/Polysyntonic. Frequency,
ratios, HEJI arrows and color all derive from it. Selector order:
**Equal · Ptolemaic · Pythagorean · Semiditonal · Septimal · Schismatic · Syntonic · Polysyntonic**.

| Mode | qm0 | qm1 | qm2 | Produces |
|---|---|---|---|---|
| `'E'` Equal | — 12-TET, regions not consulted — | | | Pure equal temperament. |
| `'5'` Ptolemaic *(default)* | A-d0 | A-d0 | A-d0 | 5-limit JI base; full 5-limit major + minor. |
| `'P'` Pythagorean | A-d0 | +SC | −SC | Every M3 = 81/64, every m3 = 32/27; no 5-limit ratios. Study layout. |
| `'D'` Semiditonal | A-d0 | A-d0 | −SC | 5-limit major; Pythagorean minor (32/27) band-local in qm2. |
| `'7'` Septimal | A-d0 | A-d0 | B (−SC + 63/64) | Uniform 7-limit (below). |
| `'V'` Schismatic | A-d0 | A-d0 | −SC | Like Semiditonal, but `freqAt` also multiplies the band factor by `SCHISMA^band` (≈1.95¢) — pure-thirds octave stretch; the band crossing spells as a `d4`. Study mode. |
| `'S'` Syntonic | A-d0 | +SC | −SC | Every band Pythagorean; whole bands shifted by `k` SC around the home band: `k = 0, +1, 0, −1` by band distance (period 4). Designed for Wicki-Hayden. |
| `'Y'` Polysyntonic | A-d0 | +SC | −SC | As Syntonic, but `k` = band distance, unbounded (stacks on the whole lattice). |

**Uniform septimal (`'7'`)** — qm2 is region B `(aDepth=1, aUpper=true)`, qm∈{0,1} is region A.
Octave-invariant (shares `qmod3`). Every qm0 spine cell has its harmonic 7th (7/4) two rows up in
qm2 at the same `r`, so dominant 7 (4:5:6:7) is reachable from any qm0 root and half-diminished 7
(5:6:7:9) from any qm1 root; major triads stay 5-limit-pure. Key-symmetric (the "root" is the ref
note, not tuning state). **Trade**: 5-limit minor (10:12:15) is unreachable from the ref column.
A qm0 root's minor third is the qm2 cell, and its 5-limit 6/5 is the Pythagorean 32/27 raised a
syntonic comma; the septimal column replaces exactly those notes, so minor there becomes septimal
subminor (7:6) or Pythagorean (32:27, from farther keys). A minor triad on a qm1 root keeps
10:12:15, since its third lies in qm0. Use `'5'` for 5-limit minor everywhere. The same trade
applies to `'D'`/`'V'`, whose qm2 is Pythagorean.

**Syntonic / Polysyntonic (`'S'`/`'Y'`)** — 5-limit for the Wicki-Hayden mapping. Each band is
internally Pythagorean (pure octaves and scales within a band) and whole bands are shifted by
syntonic commas around the **home band**, which is always unaltered. Offset `k` (in SC, + = raised
×81/80) of a band at distance `d = band − home` (`bandOffset(mode, d)`):

| d | … −4 | −3 | −2 | −1 | 0 | +1 | +2 | +3 | +4 … |
|---|---|---|---|---|---|---|---|---|---|
| Syntonic (`[0, +1, 0, −1][d mod 4]`) | 0 | +1 | 0 | −1 | 0 | +1 | 0 | −1 | 0 |
| Polysyntonic (`d`) | −4 | −3 | −2 | −1 | 0 | +1 | +2 | +3 | +4 |

- **Pitch**: `coordExps(q, r, 'P', mapping) + k(pitchBandOf(q, r, mapping) − anchor)·SC`, SC =
  `[−4, 4, −1, 0]`. The band is the one whose offset the cell **carries**: its own frame band
  (a Wicki-Hayden copy shares its column's 6-band), except a chromatic column copied from the band
  to its left (below), which keeps that band's offset.
  - The band step `(6, 0)` is 81/40 everywhere in Polysyntonic.
  - In Syntonic, by transition `0→1, 1→2, 2→3, 3→0`, it is 81/40, 160/81, 160/81, 81/40.
  - Both rules hold on the whole lattice, not just the Lumatone (which shows `d = −3…+3` under
    Wicki-Hayden: 48 keys in each of −2…+2, fragments of 22 at −3 and 18 at +3).
- **Chromatic home band.** Under the chromatic mapping, the F# and G# columns (positions 1 and 3)
  are copies from the band to the left, and **carry** its offset. So the home band is Pythagorean
  except for the ref's M6 and M7, which arrive one comma lower, i.e. just: on A3, F#3 = 5/6 and
  G#3 = 15/16, the leading tone beside the ref.
  - The ref's just I, IV and V each lie within 3 keys of A3, each using one borrowed column:
    - I: A3 – C#4↓ `(−3,1)` – E4
    - IV: D3 – F#3↓ – A3
    - V: E3 – G#3↓ – B3
  - Syntonic's period 4 makes the borrowed columns lowered relative to their spatial band in the
    home band and the band to its right, and raised in the two bands to its left. Polysyntonic
    lowers them in every band.
- **Why lowered is LEFT**: under Wicki-Hayden each band holds at most one key per MIDI note (the
  12-TET unison vector `(7,−2)` outruns the 6-wide band), so comma alternatives (9/8 vs 10/9, 81/64
  vs 5/4) can only coexist in different bands. A band's note window drifts ~12/7 fifths sharpward
  per octave, so the left neighbor holds the sharp-side spellings a 5-limit third lowers (C#, F#,
  G#, B, D# over A): a just third lies 4–4.5 key-widths from its root, versus 7.5–8 the other way
  round. Hole census, ref A3, A1–A6: the left band lacks only D#2 of the lowered set; the right
  band lacks nine notes between B1 and D#4. Under Euler the same rule runs on 3-wide bands, where
  the `+3q` octaves become ±SC — allowed, unrecommended, not gated.
- **The anchor** (home band) is `anchorOf(refQ, refR, mapping)` = the (spatial) band of the *anchor
  reference*, so the clicked band becomes home. A borrowed chromatic key keeps its comma relative
  to home: clicked in another band, it makes that band home and stays one comma below
  Pythagorean; clicked in the home band, it just becomes the ref. The anchor reference is
  manual Ctrl+click selection ?? score-ref ?? A3. Composer's cursor prior-note selection never
  moves it (it can sit in another band, and one entered note must not retune the layout and the
  score). Ctrl+clicking an altered key makes its band home, so that key's own pitch changes by its
  comma count — no comma drift. Moving the anchor re-anchors: pitch, HEJI arrows and color
  change; MIDI, spelling and band boundaries never do (while banded: unbanded, spelling follows
  the anchor too). Polysyntonic re-anchoring is a global
  −n·SC shift (every interval preserved); Syntonic depends only on `anchor mod 4`.
- **Live**: `state/reference.ts` derives `tuning.anchor` and `kbAnchor` from the same home ref
  (below, Ref-driven layout shift); an anchor change in S/Y (any mode unbanded:
  `readsAnchor`) runs `onAnchorChanged` (=
  `onTuningChanged`: held voices ramp in place, re-render, Lumatone color diff, Composer
  rebroadcast) in a microtask, after the synchronous ref fan-out (`onRefChanged`) has run. The
  anchor is part of the
  piano-outline cache key, the `hkl-layout-state` signature and the overlay structure signature.
  Recording playback and the overlay mirror pin it (`setAnchorOverride`). Piano input follows the
  one 88-cell picker rule (below) under S/Y's own ratios, so it plays 5-limit wherever the bands
  offer it.
- **Other modes**: while banded, the band offset is constant in E/5/P/D/7, so the anchor drops
  out (`tuning.anchor` exists; nothing reads it). Schismatic is the one other band-indexed mode — one
  schisma per band counted from A3's band, a fixed-anchor stacking.
- Gates: `test/syntonic/oracle.mjs` (pitch, k, band steps, re-anchoring, color, HEJI),
  `test/hkl-midi/anchor.mjs` (live tiers, re-anchor fan-out, piano input, `.hkr`), the Composer
  `syntonic` fixtures. Decisions: decisions.md 2026-10-26.

Persistence has no back-compat shims: any unrecognized `tuning` value reverts to `'5'`. `tuning.mode`
is canonical; `tuning.equalEnabled` / `tuning.septimalEnabled` are derived booleans kept in lockstep
by `setTuning()` (`apps/hkl/src/ui/controls.ts`) and still carried in the `.hkr` snapshot.

### Unbanded layout

**Status (2026-10-29)**: `banded` threads through every pitch, spelling, color and HEJI primitive,
and rides prefs, the `.hkr` snapshot, the bridge and overlay messages and `<hkl:layoutReq
banded="false">`. HKL's *Banded layout* checkbox sets it (hkl.md → toolbar); Composer has no Setup
control yet and doesn't yet respell on key changes or pastes. Rulings: decisions.md 2026-10-29
(the model, then HKL's toggle).

With `banded` false the octave bands no longer exist. Every seam is retuned to one of the mode's own
in-band q-steps, so no interval occurs only at a seam, and each band is respelled 12 fifths from its
neighbor. Bands count from the **anchor**, the reference's band (`anchorOf`, as in S/Y), so the
ref's band is exactly the banded layout and a ref far from A3 starts with no arrows.

- **Pitch** (`coordExps(…, anchor, false)`; the `UNBANDED` table in `@hkl/shared/freq.js`):
  `base + (band − anchor)·comma`, the band being `pitchBandOf` (a chromatic borrowed column stays an
  exact octave above its source), except Schismatic's spatial band.

  | mode | Euler q-steps | seam | comma per band | 3-column step |
  |---|---|---|---|---|
  | P, S, Y | 81:64 ×3 | 8192:6561 → 81:64 | Pythagorean comma | 1223.46¢ |
  | 5 | 5:4 ×3 | 32:25 → 5:4 | 125/128 | 1158.94¢ |
  | D | 81:64, 5:4, 5:4 | 512:405 → 5:4 | 2025/2048 | 1180.45¢ |
  | 7 | 9:7, 5:4, 5:4 | 56:45 → 5:4 | 225/224 | 1207.71¢ |
  | V | 81:64, 5:4, 81:64 | kept (already 81:64) | schisma, spatial band | 1201.95¢ |
  | E | 12-TET | — | — | 1200¢ |

  - Syntonic and Polysyntonic become Pythagorean: their definition is the seam.
  - Schismatic keeps its tuning per key and is only respelled; its schisma now counts from the
    anchor, so unbanded V = banded V × schisma^−anchor over the whole board.
  - Equal sounds 12-TET in both layouts. Its JI reading (ratios, the piano picker) is
    Ptolemaic's in both, so unbanded it takes 125/128 per band; without it, unbanded Equal's
    picker ranked banded ratios against unbanded spelling and no ref was valid.
- **Piano picker**: every mode ranks under its own unbanded ratios. Schismatic's banded-only
  exception (ranking as Semiditonal, decisions.md 2026-05-25) answered its banded spelling
  disagreeing with its schisma-stacked pitch; unbanded spelling agrees, and ranking unbanded V as
  banded D left no footprint within ±3 accidentals. The piano canvas height is computed per
  banding (Piano canvas height, below).
- **Spelling** (`noteName` / `keyOctave(…, anchor, banded)`): the banded spelling plus 12 fifths
  per pitch band from the anchor's, one rule for every mode, Equal included.
  - A band step `(W, 0)` is spelled as an augmented seventh (A → G𝄪).
  - The octave number follows the respelled letter (C4 → B#3).
  - Nominal MIDI never changes, so light/dark, the picker's MIDI range and Piano output are
    unaffected.
- **Re-anchoring** shifts the whole board by one comma per band and respells it 12 fifths per band.
  So unbanded, the anchor matters in every mode: `readsAnchor(mode, banded)` gates the anchor
  fan-out, per-note `.hkr` anchors, playback pinning and Composer's per-measure `data-anchor`.
- **Properties** (`test/unbanded/oracle.mjs` pins each):
  - Wicki-Hayden Pythagorean is isomorphic and unimodular, with every 3-limit pitch on exactly one
    key; `(−1, 2)` is a spelled, exact octave.
  - Chromatic Pythagorean is Polysyntonic × schisma^(pitch band − anchor): leading-tone
    respellings and no 2¢ drift across bands. Even-Δq vectors are isomorphic and odd-Δq vectors
    alternate by a Pythagorean comma; `(−2, 2)` is a spelled, exact octave.
  - Septimal keeps a closed 4:5:6:7 from every root right of a 9:7 step (one shape per column
    class), with 1207.71¢ near-octaves.
  - Euler has no spelled octave vector. Euler and Wicki-Hayden spell each (note, octave) once;
    chromatic has spelled twins.
- **HEJI** compares against Pythagorean unbanded with the same anchor, whose Pythagorean comma per
  band matches the respelling. Per band to the right, `(syn5, sept7)` steps by 5 (+3, 0),
  D (+2, 0), 7 (+2, −1), V (+1, 0), P/S/Y (0, 0). Hooks stack (`hejiChain`: a single hook, then
  two-hook glyphs U+E2E0/E2E1); HKL labels collapse more than two hooks into one hook with an
  exponent (hkl.md → Note naming).
- **Color**: the spine rule on the unbanded pitches, nothing added (*Color scheme*). Unbanded
  Ptolemaic on a 3-wide layout (Euler, Gerhard, Randal) is one stripe per octave. Pythagorean
  hues are unchanged on either spine: 12 fifths span 7 octaves and 12 fourths span 5, a whole turn
  of each spine's cycle (7 hues, 5 hues). Septimal factors stack half-step hue rotations.

### Adding a tuning mode

- `TuningMode` is declared twice — `apps/hkl/src/state/persistence.ts` and `@hkl/shared/freq.js` —
  update both, plus `TUNING_MODES` in `@hkl/shared/freq.js` (every `isTuningMode` guard derives from it).
- `Record<TuningMode, …>` tables the compiler flags: `MODE_LABELS`
  (`apps/composer/src/notation/retune.ts`) and `TUNING_LABELS` (`apps/composer/src/setupDialog.ts`,
  `apps/hkl/src/bridge/hkl-side.ts`). One it won't: the `Record<string, …>` `TUNING_LABELS` in
  `apps/composer/src/input.ts`.
- The selector `<option>` in `apps/hkl/index.html` and the `tuningDescription()` switch in
  `apps/hkl/src/bridge/hkl-side.ts`.
- Run both `test/picker/` gates (they run the real picker over `TUNING_MODES`). Nothing is
  generated: the piano canvas height is computed at runtime.
- Its unbanded seam: an entry in `UNBANDED` (`@hkl/shared/freq.js`, a `Record<TuningMode, …>` the
  compiler flags) and in `test/unbanded/oracle.mjs`.
- Nothing per mode for color (one pitch function, `@hkl/shared/keycolor.js`) or HEJI (derived from
  `coordExps`).

### Frequency formulas

```
5-limit:  freq(q,r) = 220 · 2^bandOf(q) · (5/4)^(posInBand(q)−1) · (3/2)^r
          bandOf(q) = floor((q+1)/3);  posInBand(q) = ((q+1)%3 + 3)%3
Equal:    freq(q,r) = 220 · 2^((4q + 7r)/12)
```

Modes `'P'/'D'/'7'/'V'` use the 5-limit base times the column shifts above (`'V'` adds
`SCHISMA^band`; `'S'`/`'Y'` are `'P'` times `(81/80)^bandOffset(mode, band − anchor)`). The
canonical quantity is `coordExps(q, r, mode, mapping, anchor, banded)` (`@hkl/shared/freq.js`;
`anchor` is read only by S/Y while banded, and by every mode unbanded, but both are required, so
every caller decides): a cell's
prime-exponent vector `[e2,e3,e5,e7]` relative to 220 Hz, with the per-mode region/schisma shifts
baked in. `freqAt` multiplies it into Hz once (`220·2^e2·3^e3·5^e5·7^e7`); the **JI ratio** between
two keys is just the difference of their `coordExps` vectors (base layout: `e5=Δp`, `e3=Δr`,
`e2=Δb − 2Δp − Δr`, plus the shift deltas). One source of truth means frequency and interval
analysis can't diverge. Tenney Height derives from the exponent vector too — the only place exps are
multiplied into integers/Hz for *display* is the analysis box. Implemented in `@hkl/shared/freq.js` +
`apps/hkl/src/tuning/`.

**HEJI accidentals** (`hejiCommasFor`, `@hkl/shared/heji.js`): every cell's lattice spelling is
Pythagorean exactly under `'P'`, so a cell's arrows and hooks are the syntonic / septimal commas
between its pitch and its `'P'` pitch (`solveCommas` on the exponent difference; `syn5 > 0` → down
arrows, `sept7 > 0` → down hooks). A schisma (Schismatic's band stacking) is not notated — it
re-spells, and color carries it. No per-mode table: S/Y get `syn5 = −k` for free. Unbanded, the
reference is unbanded `'P'` with the same anchor (*Unbanded layout*).

### Ref-driven layout shift

The reference note (Ctrl+click any hex, or set from Composer) slides the lattice under the static
outline so the ref lands exactly at the outline center, banded or unbanded.

**One authority** (`state/reference.ts`). The tiers are a selection — two slots, the user's
Ctrl+click and Composer's cursor note — then the score-ref, then A3. The *home ref* is Ctrl+click ??
score-ref ?? A3; the *effective ref* is the home ref, except in the piano outline, where the cursor
note is the ref when it is newer than the Ctrl+click (elsewhere the cursor note is ignored and never
displaces a Ctrl+click). The keyboard anchor `kbAnchor` = the home ref itself — where the
Lumatone/QWERTY layout sits and where every non-piano view centers — and the S/Y `tuning.anchor` are
derived there and nowhere else (the overlay mirror alone copies the publisher's). A physical key
(Lumatone key, QWERTY code) plays its lattice offset + `kbAnchor` — the offset is its physical
position posed by the Layout toolbar's Alignment, a 60° lattice rotation about the anchor; that map
lives in one place,
`apps/hkl/src/layout/physical.ts` (`lumatoneCells` / `qwertyCells`, `lumatoneCell(i)` /
`qwertyCell(code)`), which MIDI input, QWERTY input, Lumatone colors and the outline footprint all
read. Every tier change
recomputes both and, if the effective ref or `kbAnchor` moved, runs one listener synchronously,
`effects/onRefChanged(dq, dr)`: held physical voices migrate by the `kbAnchor` delta, Lumatone colors, piano-outline invalidation, view re-center, redraw, Composer broadcast. A
Ctrl+click slides (`withRefSlide`) while the old and new views overlap (a screen displacement under
one canvas width and height); a farther target snaps, as everything else does, and a snap while a
slide is in flight redirects the slide rather than letting it drag the view back to its old target. Handlers only
mutate tiers — none can move a ref without re-centering (decisions.md 2026-10-27).

Because the anchor is the ref, banded or not, the seams fall wherever the ref puts them: the ref's
position in its band picks the seam alignment under the physical keyboard, and toggling the banding
never moves the keyboard. (Until 2026-11-09 the banded layout centered `refSpine(ref)`, the qm0
column of the ref's band in its row, which pinned one alignment: decisions.md 2026-11-09.)

Applies in all outline modes (`lumatone`/`qwerty`/`none`) and all tuning modes; ref changes tween
via `apps/hkl/src/render/animation.ts`. Piano outline is the exception — it uses
`computePianoViewCenter(...)` to solve a tilt-dependent placement instead.

**Held physical inputs** (`apps/hkl/src/input/held.ts`): every note struck by a physical key —
Lumatone `"ch,note"`, QWERTY `e.code`, piano MIDI note — records the `KeyId` it struck. Release,
aftertouch and forced release (device departure, piano disable) resolve through that record, never by
recomputing the key from the current anchor, so an anchor change can never orphan a voice; the Clear
button forgets all records. **Held-voice migration**: on ref change, Lumatone and QWERTY voices migrate
with the lattice (`migrateHeld`) so a held key keeps its relative pitch; piano and *mouse-click* voices
stay on their cell. Fan-out: `apps/hkl/src/effects/onRefChanged.ts`.

**Ref validation** (`validateRefNoteCandidate` in `apps/hkl/src/render/draw.ts`): the ref's MIDI is in
the 88-key piano range, `coordToMidi(q,r) ∈ [21,108]`. That is the whole rule (Max, 2026-10-30;
decisions.md), so it doesn't depend on mode or banding, and switching either keeps the ref. The dotted
"valid ref bounds" overlay traces that strip live (`validRefPaths`): each row's in-range cells are
one interval, 88/c keys wide.

**88-cell picker** (`apps/hkl/src/tuning/picker.ts`, wrapped by `compute88PianoCoords`; the canvas
height and `test/picker/` run the same module): for each MIDI 21..108, among the cells with that nominal MIDI, ONE
ranking rule in every mode and mapping. The three rules are:
(1) lowest reduced Tenney Height of the ratio from the ref
under the mode's own ratios; (2) if the lowest-TH cells differ in pitch — only at the tritone, whose
two spellings are complements (45/32 vs 64/45) — the **augmented 4th** (the spelling a fourth above
the ref by letter; any other tie would fall back to the ref's octave line); (3) among
cells of that pitch (Wicki-Hayden twins, P/D comma siblings, in-band vs cross-band octaves), the one
fewest key steps from the ref — so the footprint clusters on the ref's band. TH is octave-invariant,
so spelling is octave-consistent by construction.
- `test/picker/octave-consistency.mjs` finds 0 breaks outside S/Y, and also in Wicki-Hayden
  and chromatic Syntonic.
- In Euler S/Y and in Wicki-Hayden and chromatic Polysyntonic, a spelling's 5-limit pitch can
  exist in one octave's band and not the next, so some drift is expected and reported. The ref maps to itself. `'V'` ranks under `'D'` ratios so
schisma exponents don't distort the spelling. → decisions.md 2026-10-26 "One picker rule".

**Piano canvas height** (`apps/hkl/src/render/canvas.ts`): constant across ref changes within a
mapping, mode, banding and rotation, and tall enough for every ref (the canvas scrolls vertically).
The footprint relative to its ref depends only on the mapping, mode, banding and the ref's position
in its band: a step along the pure line, or one band over with the anchor following, preserves
every relative interval, and the ref's MIDI only slides the 88-note window.
- **Computing it.** `footprintExtents` picks, per position, one footprint over relative MIDI
  −87…+87 (2W picker runs, cached per mapping, mode and banding). `footprintHalfHeight` is the
  largest |sy − sy(MIDI 64's cell)| over every window, since the piano view centers MIDI 64's
  cell vertically.
- **Anchor offset.** Composer's cursor ref (or recording playback, or the overlay) can sit d bands
  from the home band. Only banded Syntonic's footprint depends on d, with period 4: its band offset
  is the one that isn't linear in the band distance. So the runtime measures its four phases
  (`footprintAnchorOffsets`), at four times the cost. In Gerhard, Janko and Park a phase other
  than d = 0 is the tallest.
- **Gate:** `test/picker/footprint-extent.mjs` (reduction, heights against brute force, every
  anchor offset repeating a measured one). → decisions.md 2026-10-30 "Ref validity is the piano range; canvas heights at
  runtime".

Coverage: ~55 unique MIDI/ref in 5-limit; 88-cell footprint per ref in 7-limit (~208–210 unique
pitches reachable from a central key). One LTN file gives every physical key a stable
`(channel, note)`; all tuning/layout interpretation is runtime software state — no per-layout LTN,
`.scl`/`.kbm`, or external synth config.

### Note-name mapping (Euler / Wicki-Hayden / Chromatic)

A second axis, orthogonal to the tuning mode: **where note names sit** on the hex grid
(`Mapping`, single definition in `@hkl/shared/mapping.js`; toolbar `Mapping:` dropdown). It applies
identically to every tuning mode — no per-mode gating.

**A layout is its three values**, `(division, shear, invert)` (`LayoutSpec`): keys per octave along
a row (3, 4, 6 or 12), whole keys each row slides right of the row below, and whether the pure line
is a fourth instead of a fifth. The eight presets go by name (`PresetMapping`; `MAPPINGS` in
dropdown order, `MAPPING_LABELS`, `PRESETS` for their values); every other valid triple goes by a
custom id, `<division>:<shear>` plus `:i` when inverted (`6:-2:i`, `CustomMapping`). A custom id
never names a preset's values, so a layout has exactly one id and ids compare with `===`
(`mappingOf(spec)`, `specOf(id)`). The one bound is on the row step, `7 − shear·c` (`5 − shear·c`
inverted): 1 to 12 semitones and not equal to the column step `c`. That allows 48 layouts
(`isValidSpec`, `shearRange`, `clampShear`, `allMappings`). `isMapping` accepts any of them,
`isPresetMapping` only the eight. HKL accepts any layout wherever it reads a mapping (prefs,
`.hkr`, the overlay snapshot, bridge messages in) and builds custom ones in its layout builder
(docs/architecture/hkl.md → Layout builder). **A score's mapping is one of the eight presets**
(Composer's `LayoutReq.mapping` is a `PresetMapping`; Setup offers the eight): Composer cannot
build a custom layout, so it never stores one. It does accept any layout id on a bridge message
and converts from it into the score's frame (`convertCell`), and HKL's Export to Composer
re-expresses a custom-layout recording in the finest preset of its orientation, Chromatic for a
plain layout and Park for an inverted one (best effort: docs/architecture/hkl.md → `.hkr` → `.hkc`
transcription).

**The layout matrix.** Every layout samples the chromatic frame: cell `(q, r)` is the chromatic
cell `(c·q + s·r, r)` — or, inverted, `(c·q + s·r, −r)` raised `r` exact octaves (`toChromatic`).
`layoutOf(id)` derives each layout's `(c, s, invert)` from its values: `c = 12/division` the column
step in semitones, `s = −shear·c` the shear in chromatic columns per row. The three mappings here are unsheared and plain, so `r` is the fifth
and a column step `(+1, 0)` is `c` semitones: 4 Euler, 2 Wicki-Hayden, 1 chromatic. Every
primitive goes through the sampled chromatic cell:
- `coordToMidi = 57 + Q + 7R + 12·oct` (`57 + c·q + 7r` for the three); `coordExps` is the
  chromatic cell's, plus its exact octaves;
- the band is the chromatic cell's, `floor((Q + 4)/12)`, so `bandOfCell`, `posInBandOf`,
  `pitchBandOf` and `anchorOf` take `(q, r)`. Band width is `W = 12/c`; for the three,
  `bandOfCell = floor((q + W/3)/W)` and `posInBandOf = (q + W/3) mod W`;
- `eulerOf` is the chromatic cell's Euler-equivalent, raised `oct` bands. `fromEuler`,
  `vecFromEuler`, `convertCell` and `octaveVector` derive from the chromatic frame; for the three,
  `fromEuler` / `vecFromEuler` scale `q` by `4/c`;
- three quantities still read only `c`, which is exact for these three: the ref's qm0 column at
  position `W/3`, the picker's isotone `(7, −c)`, and the `verticalFreq` column gradient
  `log(2)·c/12`.

These are the only three fifth-axis hex layouts whose steps all lie within a fifth, up to
reflection: `q`-step `a` and `(−1,+1)` = `7 − a` are mirror images. Each one doubles `q`: Euler
`(q, r)` = Wicki-Hayden `(2q, r)` = chromatic `(4q, r)`.

**Euler** is everything above. **Wicki-Hayden** inserts, after every fifths column, a column holding the same notes
shifted down 2 cells and exactly one octave, unadjusted (no region / comma / schisma change): a copy
cell is its left neighbor × 9/8 (`coordExps` of the column + `[−3, 2, 0, 0]`). Rows step in whole
tones (9:8 / 10:9 / mode-dependent), so the neighbor set is ±M2 (row), ±P5 (`r`), ±P4 `(−1,+1)`, and
each column and its copy are an exact octave apart along `(+1,−2)`. Bands are 6 wide
(`bandOfCell`: `floor((Q+2)/6)`), column order per band `[qm2, qm2′, qm0, qm0′, qm1, qm1′]` by
`((Q+2) mod 6)`, A3 at `(0,0)` (qm0) with qm0′ at `(1,0)`, so the major scale from a qm0 root
occupies the middle four columns.

- **Cells are their own cells.** The mapping is part of the coordinate frame, like the tuning mode:
  a `(q, r)` means nothing without it. Every Wicki-Hayden cell has an **Euler-equivalent**
  (`eulerOf`: even `Q` → `(Q/2, R)`, odd → `((Q−1)/2 − 3, R+2)`) with the same name, spelled octave and
  nominal MIDI (`57 + 2Q + 7R`), and the same pitch except a Schismatic copy (one schisma higher — it
  keeps its column's band). The shared primitives (`coordExps`, `freqAt`, `coordToMidi`, `noteName`,
  `keyOctave`, `hejiCommasFor`) take a required `mapping` and resolve through it; HKL's state-based
  helpers read `tuning.mapping` (carried on `TuningStateLike`).
- **Frame conversion** (`convertCell`): Euler → Wicki-Hayden exact (original column `(2q, r)`).
  Wicki-Hayden → Euler is pitch-exact in the band-uniform modes (brute force: 625/625 copies equal
  an Euler cell in 5/P/D/7). In the band-indexed modes every copy is off, because its
  Euler-equivalent sits one band lower: in Schismatic by one schisma (1.95¢), in Syntonic /
  Polysyntonic by a syntonic comma (1025/2075 cells exact in V, S and Y alike, i.e. the originals).
  Used by Composer
  retune (as the seed of its search — a taxicab tiebreak means nothing across frames), the bridge
  (every coordinate-bearing message carries its `mapping`; receivers convert on use), and
  cross-score paste. Lattice *vectors* (transpose buttons, SC shifts, harmonics) map via `vecFromEuler`
  (q doubles — parity-preserving, so the step means the same interval from originals and copies).
- **Reference**: centered exactly, copy or original, as in every mapping (Ref-driven layout shift).
  **Picker / resolver**: candidates satisfy
  `c·q + ρ·r = N` (c = 4 Euler, 2 Wicki-Hayden, 1 chromatic; ρ the row step, 7 in all three),
  stepping along the isotone `(ρ, −c)` over ±⌈80/c⌉ steps centered on the ref's row (the same
  ±80-row span in every mapping); projection `ρΔq − c·Δr`; copies are candidates like any cell.
- **Switching mapping** (`applyMapping(id)`, `apps/hkl/src/ui/controls.ts`, the one path for every
  writer: the toolbar select, the layout builder, a recording's snapshot, Composer's layout request,
  Reset): the reference, anchor, held mouse /
  piano-input / pedal-sustained notes convert by the frame formula (same pitch); held Lumatone / QWERTY
  voices keep their `(q,r)` and retune in place (they release through the key they struck,
  `input/held.ts`); nothing is dropped. The `verticalFreq` tilt uses a `log(2)/6` column gradient — under
  Wicki-Hayden it coincides with the Lumatone case-row tilt, because the Lumatone's long axis `(7, −2)`
  carries no net pitch (the accepted range cost: the 280 keys span MIDI 30–85, 55 semitones, instead
  of 4–113, 109; not mitigated).
- **Interval structure** (every mode; `test/wh-layout/oracle.mjs` asserts these): `(+1, 0)` from an
  original column is 9/8 and `(+1, −2)` is 1/2 exactly; `(+1, 0)` from a copy is the mode's q-step ÷
  9/8; the band step `(6, 0)` is the mode's band octave (2/1; Schismatic octave + schisma; S/Y per
  their band offset). "Row" is qm2 → qm2′ → qm0 → qm0′ → qm1 → qm1′ → next qm2; "shape" is the major
  scale from the reference, offsets `(1,0) (2,0) (−1,1) (0,1) (1,1) (2,1) (−1,2)`:

  | mode | row | shape from reference |
  |---|---|---|
  | E | 200¢ ×6 | 2 4 5 7 9 11 12 semitones |
  | 5 | 9/8 10/9 9/8 10/9 9/8 256/225 | 9/8 5/4 27/20 3/2 27/16 15/8 81/40 |
  | P | 9/8 9/8 9/8 9/8 9/8 65536/59049 | 9/8 81/64 4/3 3/2 27/16 243/128 2/1 |
  | D | 9/8 9/8 9/8 10/9 9/8 4096/3645 | 9/8 5/4 4/3 3/2 27/16 15/8 2/1 |
  | 7 | 9/8 8/7 9/8 10/9 9/8 448/405 | 9/8 5/4 21/16 3/2 27/16 15/8 63/32 |
  | V | 9/8 9/8 9/8 10/9 9/8 9/8 | 9/8 5/4 4/3 3/2 27/16 15/8 2/1 |
  | S / Y | within a band, as P | as P in the home band |

  In Schismatic every row step is 9:8 or 10:9; the schisma stays on the band boundary, spread over 6
  columns instead of 3.
- Gates: `test/wh-layout/oracle.mjs` (structure, names, colors, frame round trips, 280 distinct
  Lumatone cells), `test/hkl-midi/mapping-switch.mjs` (held keys across a switch), the Composer
  `mapping` fixtures. Decisions: decisions.md 2026-10-26 "Wicki-Hayden note-name mapping".

#### Chromatic

**Construction.** Chromatic keeps every Wicki-Hayden column (at even `Q`, pitch-exact in every
mode). It interpolates six new columns per band at odd `Q`, so rows step in semitones and bands
are 12 wide.
- Each new column is the cell one `(5,1)` octave-vector to its left, up an exact octave and
  unadjusted: `(Q, R) = (Q−5, R−1) × 2`. Equivalently, right of each column sits its M7 below,
  up an octave.
- The neighbor set is ±m2 (row), ±P5 (`r`) and ±A4/d5 `(−1,+1)`. The isotone (12-TET unison)
  is `(7, −1)`.

**Euler-equivalent** (`eulerOf`), with `Q = 4k + j`:

| j | column | Euler-equivalent |
|---|---|---|
| 0 | the original | `(k, R)` |
| 1 | its m2 above | `(k+2, R−1)` |
| 2 | the Wicki-Hayden copy | `(k−3, R+2)` |
| 3 | the original's m3 above | `(k−1, R+1)` |

**Band layout.** Column order by `(Q+4) mod 12` is `[qm2, ·, qm2′, ·, qm0, ·, qm0′, ·, qm1, ·,
qm1′, ·]` (· = new). A3 sits at `(0,0)`, position 4, and A's row reads
F F# G G# A Bb B C C# D D# E.

**Why this construction** (decisions.md 2026-10-27):
- In every row it gives the **5-limit duodene of the ref**: Ellis's 3 rows × 4 fifths, the rows a
  5:4 apart (Bb F C G / D A E B / F# C# G# D# on A). The ref's just major and minor lie along its
  own row.
- The alternatives were all rejected:
  - the mirror rule `(Q+5, R+1) ÷ 2`, i.e. the M7 left of each column, gives the duodene of E,
    with an acute 4th and 6th from the ref;
  - real leading tones everywhere give B# and C## in the ref's m3/P4 slots;
  - adjacent-column copies give remote spellings and wolf intervals.

**Two band functions.**
- `bandOfCell` is the spatial band. It drives seams, position in band, the anchor,
  the Schismatic schisma and the schismatic-chord check.
- `pitchBandOf` is the band whose Syntonic/Polysyntonic offset a cell carries. It equals
  `bandOfCell(Q−5)` at the two positions whose source is in the band to the left (1 and 3:
  F#, G# on A's row), and the own band everywhere else.
- So under S/Y the borrowed columns carry the left band's comma: the home band is Pythagorean
  except the ref's just M6 and leading tone (Tuning modes → Syntonic / Polysyntonic).
- Schismatic deliberately does **not** carry: it is Semiditonal × schisma^(spatial band). The
  borrowed columns therefore keep 5/6 and 15/16, and a new column against `(Q−5, R−1)` is
  2/1 × schisma at those two positions.

**Conversion.**
- The frames nest, so `convertCell` maps a cell that exists in the target frame to that same cell,
  exact in every mode. Euler / Wicki-Hayden → chromatic therefore always is exact. Other cells
  go through their Euler-equivalent.
- Chromatic → Euler is pitch-exact in 5/P/D/7. In V and S/Y it is exact for 525 of 1050 new
  columns (the same class as Wicki-Hayden copies).

**Interval structure** (`test/chromatic-layout/oracle.mjs` asserts these):
- An even column equals its Wicki-Hayden cell.
- `(+4, 0)` is the mode's Euler `(1, 0)` step.
- The band step `(12, 0)` is the mode's band octave. In S it follows the transition of the cell's
  pitch band.

The ref's row at A3, read upward:

| mode | `(+1,0)…(+12,0)` from the ref |
|---|---|
| E | 1 … 12 semitones |
| 5 | 16/15 9/8 6/5 5/4 4/3 45/32 3/2 8/5 5/3 9/5 15/8 2/1 |
| P | 256/243 9/8 32/27 81/64 4/3 729/512 3/2 128/81 27/16 16/9 243/128 2/1 |
| D | 256/243 9/8 32/27 5/4 4/3 45/32 3/2 128/81 5/3 16/9 15/8 2/1 |
| 7 | 28/27 9/8 7/6 5/4 4/3 45/32 3/2 14/9 5/3 7/4 15/8 2/1 (4:5:6:7 along the row) |
| V | as D within the band; the crossing E→F is 135/128 (limma·schisma) |
| S / Y | home band F→E: 64/81 5/6 8/9 15/16 1 256/243 9/8 32/27 81/64 4/3 729/512 3/2 |

**Tritone-axis octaves (an emergent property, found 2026-10-27, not designed).** Two steps along
the tritone axis, `(Q,R)` above `(Q+2,R−2)`, are an octave.
- **Where they are pure.** They are pure everywhere except where the upper cell sits at band
  position 3 or 10, i.e. the lower cell is in the first or sixth column of a band.
  - Those two columns are where two tritone steps run past the ends of the row's 12-fifth
    spelling window, so the pair is spelled as an enharmonic augmented 7th: flat-side note below,
    its sharp-side twin above.
  - On A's row that is Ab→G# and Eb→D#. Because each column holds every pitch class as the rows
    step by fifths, all 12 pitch classes occur.
- **What carry does.** Pythagorean must tune those pairs 2/1 × Pythagorean comma (23.46¢ wide). Carry puts
  **both** positions on a pitch-band boundary:
  - Eb→D# crosses the visual seam;
  - Ab→G# reaches the borrowed G#, which carries the band to the left.
  So the band offset applies at exactly those places:
  - Polysyntonic always steps one comma there, leaving 2/1 × schisma: every tritone-axis octave is
    pure or 1.95¢ wide.
  - Syntonic's 0, +1, 0, −1 cycle steps the comma back at two of every four transitions. Those
    pairs come out 2/1 × PC × SC (45¢ wide).

Census of the 223 such octaves on the Lumatone (ref A3):

| mode | pure | other |
|---|---|---|
| E | 223 (12-TET) | — |
| Y | 188 | 35 × +schisma |
| P | 188 | 35 × +PC |
| S | 188 | 26 × +schisma, 9 × +PC+SC |
| D | 150 | 35 × +schisma, 38 × +SC |
| V | 166 | 19 × +schisma, 20 × +SC, 18 × +diaschisma |
| 5 | 112 | 76 × +SC, 35 × −diaschisma |
| 7 | 112 | 38 × +SC, 38 × −64/63, 35 × +schisma+64/63 |

Without carry, Polysyntonic would give 170 pure, 16 × +schisma, 19 × +PC and 18 × −SC. So this is
a consequence of carry, not its definition. `test/chromatic-layout/oracle.mjs` section K pins it.

**Twins.** A band holds most notes twice, one isotone apart (7 keys).
- They are identical, except at the duodene's 5-row seam (G/G at 80/81; Septimal 64/63) and,
  under S/Y, the borrowed F#/G# against their Pythagorean twins.
- The 280 Lumatone keys carry 136 distinct 5-limit pitches over 58 pitch classes (Wicki-Hayden
  168 / 57, Euler 280 / 55).

**Lumatone.** The case axis `(7, −2)` carries −7 semitones, so each board sits a fifth below its
left neighbor.
- From left to right the boards span 40–102 … 12–74, and each one alone spans ~62 semitones
  vertically.
- All 280 keys cover MIDI 12–102 with 88 distinct notes.
- This is accepted and not mitigated: fixing it would break numerical isomorphism.

**Gates:**
- `test/chromatic-layout/oracle.mjs`;
- the chromatic rows of `test/syntonic/oracle.mjs`, `test/color-gate/`, `test/picker/` and
  `test/hkl-midi/mapping-switch.mjs`;
- the Composer `mapping` and `syntonic` fixtures.

#### Sheared and inverted layouts

The matrix defines five more layouts, selectable in HKL and in a Composer score's Setup alongside
the three (`MAPPINGS` lists all eight in dropdown order). Composer's notation paths go through the
shared primitives (spelling, `fromEuler` for the key-tonic ref, `vecFromEuler` for SC shifts and
harmonics, `bandWidth` for an ottava's band per octave), so a score in any of the eight is
first-class; HKL coordinates in another mapping reach it converted (`convertCell`).

| layout | (c, s, invert) | q / r / (−1,1) | band W | pure line |
|---|---|---|---|---|
| Gerhard | 4, −4, no | M3 / m3 / −m2 | 3 | P5 at (1,1) |
| Janko | 2, −6, no | M2 / ±semitone / ∓semitone | 6 | P5 at (3,1) |
| Accordion (C-system) | 2, −2, yes | M2 / m3 / m2 | 6 | P4 at (1,1) |
| Randal | 4, 0, yes | M3 / P4 / m2 | 3 | P4 axis |
| Park | 2, 0, yes | M2 / P4 / m3 | 6 | P4 axis |

- **Pure line** `(−s/c, 1)`: a lattice vector because `c | s`. It is an exact 3/2 (4/3 inverted) in
  every JI mode, banded and unbanded.
- **Seams** slant `−s/c` keys per row, along the pure line, which therefore never crosses one.
- **Inverted** layouts keep their fourth exact in every mode. Their fifth, the band step minus the
  fourth, is exact in 5/P/D/7 only: in V/S/Y it carries the band term.
- **Cell sets**: Gerhard and Randal sample Euler's cells (Gerhard = Euler(q − r, r)), Janko, Park
  and the Accordion Wicki-Hayden's (Park = WH(q, −r)·2^r, Accordion = Park(q − r, r)). Each
  sheared preset is a fifths or fourths layout's cells, sheared one key per
  row (Janko three): the dropdown lists them after the fifths layouts, before the fourths.
- **The Accordion is Park sheared** (2026-11-01). It is the C-system button accordion turned 60°:
  posed Right it is the old `(3, −6)` Accordion posed Vertical, key for key. Its 6-wide band holds a
  diatonic scale: in Ptolemaic the all-adjacent major scale of the ref is the just one, in one band.
  On the old 4-wide band the same scale crossed four bands and came out 1, 10/9, 5/4, 4/3, 40/27,
  5/3, 256/135, 160/81.
- **Spelled octaves**: unbanded, `octaveVector` is (5, 2) Janko, (3, 2) Accordion and (1, 2) Park;
  Gerhard and Randal have none. Chromatic (c = 1) samples every chromatic column, so it has spelled
  twins; the others spell each note once.
- **Transposes**: every preset has every Euler vector. `vecFromEuler` returns null only on a 4-wide
  band (c = 3, from the builder) for an M3 count that isn't a multiple of 3, which turns its M3, m3
  and SC buttons off (`syncBandedControls`).
- **Spine column**: a band's qm0 chromatic column (chromatic position 4), layout column `⌊4/c⌋` of
  the band: `W/3` in every preset, column 1 in a 4-wide band. Every row samples it, since `c | s`.
  (It no longer sets the centering: the ref itself is centered, Ref-driven layout shift.)
- **Vertical Freq tilt** (`layout/geometry.ts`): c semitones per column, and per row the fifths
  layouts' average fifth shifted by the row step's distance from 7 equal semitones.
- **Piano picker**: candidates are the layout's own family `(q_N + ρk, r_N − c·k)`, ρ the row step
  (Piano canvas height, above).
- **Syntonic / Polysyntonic**: a cell carries its pitch band's comma offset (`pitchBandOf`), and an
  odd chromatic column carries the band five columns left. Among the presets only Chromatic
  (c = 1) has odd columns.
- **MIDI import** (`midi-io/import.ts`): the index covers rows ±16 and, in each, the cells whose
  chromatic column, raised by its octaves, lies within ±120 of A3's: the same pitch span in every
  layout, and in the fifths layouts the old ±30-Euler-column box exactly.
- Gates: `test/layout-presets/oracle.mjs` (all 48 layouts) and `test/layout-presets/tray.mjs` (the
  HKL builder tray, headless); `test/picker/`, `test/syntonic/`, `test/unbanded/`,
  `test/color-gate/` and `test/alignment/` run over all eight.

---

## Color scheme

**Color is the spine rule: one function of the pitch and the layout's orientation** (Max,
2026-11-09). A mode or mapping only decides which pitch sits on a cell, and the same pitch gets the
same color wherever it appears among the layouts of one orientation (color is a reading aid for
pitch identity across layouts). Light/dark encodes the 12-TET black/white key.
Implemented once, purely, in `@hkl/shared/keycolor.js` (`keyColor`, `keyColorHex`,
`lightSourceHex`, `inkColorHex`); HKL's `render/colors.ts` only supplies its live layout, and
Composer recolors notes with the same functions.

- **The spine rule — one hue cycle per spine, × {light,dark}.** The
  Pythagorean spine is the chain of pure fifths from A3, and of pure fourths in an inverted layout
  (the Accordion, Randal, Park: `layoutOf(…).invert`). It holds one color per nominal octave, purple
  in octave 3: spine note n sits at MIDI `57 + 7n` (`57 + 5n` on the fourths spine), and the hues
  step through the spine's cycle octave by octave, the other way round on the fourths spine. A note
  reached from the spine by chaining 5:4 major thirds takes the spine's color at its own octave (a
  major third is 4 semitones); 2:1 carries no color. On `coordExps`' `[e2, e3, e5, e7]`:
  - fifths spine: index `floor((57 + 7·e3 + 4·e5) / 12) − 4 (mod 7)` into
    `FIFTHS_CYCLE = [PU,PK,OR,YE,GR,TE,BL]`;
  - fourths spine: index `−(floor((57 − 5·e3 + 4·e5) / 12) − 4) (mod 5)` into
    `FOURTHS_CYCLE = [PU,PK,DA,SG,BL]`.
- **A cycle is as long as its spine step has semitones** (Max, 2026-11-10; `hueCycleOf(invert)`):
  twelve spine steps span that many octaves (12 fifths 7, 12 fourths 5), a whole turn of the
  cycle, so a Pythagorean comma keeps the hue on either spine and shows as a diminished second in
  one color. The two cycles share purple and its neighbors, pink and blue, with the half steps
  between them. Where the fifths cycle goes on through orange, yellow, green and teal, the fourths
  cycle closes the wheel with two hues of its own, dandelion (`DA`) and spring green (`SG`). The
  seven hues are the ruler: pink → blue is five of their equal steps, and the two cut it in
  thirds, 2/3 of the way from orange to yellow and 1/3 of the way from green to teal, light and
  dark alike. `hueC` derives them, so they follow those four.
- **Nothing else is a rule.** Every JI mode and mapping, banded and unbanded, is that expression on
  the cell's pitch. What a comma does to the hue follows from where it lands on the spine: there
  are no comma terms and no per-mode or per-layout branch. Consequences, each derived:
  - Ptolemaic's banded blocks read `floor(midi/12) − band` (band − MIDI octave on the fourths
    spine), since a band step is 2:1; unbanded Ptolemaic on a 3-wide layout is one stripe per
    octave.
  - A syntonic comma is 2 hue steps on either spine: P/D's "color as the SC sibling", and
    Syntonic/Polysyntonic's +2 per comma (purple A → orange → green … raised, teal → yellow …
    lowered; on the fourths cycle dandelion → blue … raised, spring green → pink … lowered).
  - A Wicki-Hayden copy takes its column's color and a chromatic borrowed column its source's:
    they are exact octaves.
  - With the Pythagorean comma a whole turn, the hue shift between two enharmonic notes is twice
    their syntonic-comma difference, mod the cycle, on both spines: a schisma is −2, a diaschisma
    +4, a lesser diesis 6 (−1 of 7 hues, +1 of 5). The fifths cycle tells seven comma levels
    apart and the fourths cycle five. (On the seven-hue cycle the inverted layouts had until
    2026-11-10, a Pythagorean comma moved the hue by 5 ≡ −2, the shift of a syntonic comma down.)
- **Inverted layouts**: each row lifts an octave, so the fifths spine's colors would straddle
  octaves there (Randal's home-band pink ran G2–C#4). On the fourths spine the blocks read
  **band − MIDI octave**: on Randal's home band purple is C3–B♭3 and blue C♯4–B4, 7 or 8 keys a
  block (a fourths band holds ~7.2 keys per octave against Euler's ~5). A copy column in Park or
  the Accordion takes its source's color although it sits rows away, so every inverted layout
  colors a pitch as Randal does, just as every plain one colors it as Euler does. A pitch's color
  therefore differs between an inverted layout and the others; relative color within the layout is
  what carries comma identity.
- **Septimal half steps**: each factor of 7 is first replaced by the 5-limit note it stands for
  (×36/35, the Ptolemaic cell a septimal column replaces), which takes the spine color; unbanded
  Septimal's replaced pitches are exactly unbanded Ptolemaic's (225/224 × 35/36 = 125/128). Each
  factor then turns the hue half a step warm (cycle index − e7/2, signed, the same in
  both orientations), so an odd `e7` takes `.sl`/`.sd` (a 50% lerp
  toward the next warmer step of the same cycle: `keyColor.half`; a half step belongs to its
  cycle, so blue's leans to teal on fifths and to spring green on fourths) and `e7 = ±2` is a whole
  step. Banded layouts only reach
  `e7 ∈ {0, 1}`; the unbanded Septimal layout stacks them, which is consistent with Schismatic's
  near-octave changing color on the same spelling. `keyColor.isSept` (`e7 ≠ 0`) is the info
  panel's "7" tag.
- **Equal — the layout's cycle by MIDI octave**: index `±(floor(midi/12) − 4)` into the spine's
  cycle (7 hues, or 5 inverted), in the spine's direction: purple is C3–B3, and the octave above
  is pink on a plain layout and blue on an inverted one. It ignores the anchor and the banding,
  and a 12-TET pitch has one color wherever it sits. The one genuinely separate rule, since 12-TET
  has no place on the spine; on a 3-wide layout it draws unbanded Ptolemaic's stripes with A3's
  band as home.
- **Light vs dark**: by the cell's own MIDI pitch class — light if ∈ {0,2,4,5,7,9,11}, else dark.

Regression gate: `test/color-gate/gate.mjs` pins hue/light/septimal and the three hex outputs for
every mode × mapping over q, r ∈ [−40, 40] (re-seed only for an intended color change; hexes are
recorded per orientation); `test/layout-presets/oracle.mjs` section L checks the rule itself on
all 48 layouts: both cycle lengths, Equal, the hues the cycles share, and distinct inks.

Base palette (light/dark hex): PK `#FF4C79`/`#59002C`, PU `#C94CFF`/`#3E0059`, BL `#4C96FF`/`#002559`,
TE `#4CFFBA`/`#005937`, GR `#55FF4C`/`#045900`, YE `#FFF94C`/`#595600`, OR `#FF884C`/`#591D00`;
fourths cycle only, derived: DA `#FFD34C`/`#594300`, SG `#52FF71`/`#035912`.

**Ink on paper** (Composer's light theme, `inkColorHex`): a notehead on white takes its hue's
ink, a third field of the hue (`hueC[…].ink`), whatever the variant: a half step takes its hue's
ink too, so a septimal note is not told apart by ink (its accidental says it). The seven inks
are tuned for paper: PK `#f90673`, PU `#9405d1`, BL `#055ad1`, TE `#05c7c0`, GR `#52b80a`,
YE `#bd890f`, OR `#eb6200`. Dandelion's and spring green's are derived as the hues are, 2/3 of
the way from orange's ink to yellow's (`#cc7c0a`) and 1/3 of the way from green's to teal's
(`#38bd47`).

---

## File formats

| Format | What | Owner / detail |
|---|---|---|
| `.hkr` | Native recording: layout snapshot + flat coordinate-event stream. Source of identity is lattice coords, not pitch. | hkl.md "Recording & playback" |
| `.mid` | MPE export/import of a recording (manager ch 1, members 2–16, ±48st bend) so per-voice JI survives a DAW round-trip. | hkl.md |
| `.hki` | Instrument bundle (manifest + audio) produced by the Analyzer CLI, consumed by `@hkl/engine`; imported ones persist in IndexedDB. | engine.md, analyzer.md |
| `.hkc` | Composer document: MEI XML with HKL attrs (`data-q`, `data-r`) on each note. Also the output of the `.hkr` → sheet-music transcription pipeline (colored noteheads), which builds it via the shared `@hkl/notation/mei-build` builder. | composer.md, hkl.md "Transcription" |
| `.musicxml` | Composer one-way export: one `<part>` per instrument, per-measure sigs/clefs, lattice color on noteheads. Lossy on dynamics/hairpins/repeats. | composer.md "Save / load / export" |
| `.pdf` | Composer one-way export: vector, WYSIWYG (PDFKit + embedded Bravura OTF), honors the single-part view. | composer.md "PDF export" |

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
- **HKL → OBS overlay**: the performing HKL (publisher) mirrors its lattice + Composer-frame render
  state over a **localhost WebSocket relay** to a read-only `?overlay` instance loaded as an OBS
  Browser Source. Unlike the same-origin bridges above, OBS's CEF is a separate browser, so this hop
  is WebSocket (not BroadcastChannel) and is served by the standalone `apps/overlay-host`. See
  overlay.md.

---

## Usage analytics

The deployed site reports anonymous usage to [Umami Cloud](https://umami.is/): a pageview per app
load (the URL path says which app) and the custom events below. There is no backend of our own.

**Only the deployed build carries the tracker.** `vite/assemble-dist.mjs` adds an inline loader to
each app's `index.html` when `UMAMI_WEBSITE_ID` is set (`netlify.toml` → `[build.environment]`);
`vite/analytics-tag.mjs` builds it. The loader does nothing on any host but the production one
(`ANALYTICS_HOST`) and nothing in a `?overlay` instance (an OBS Browser Source reloads with every
scene change and is not a visit). `pnpm dev`, the test suites and a per-app build have no tracker.

**One reporting function.** App code calls `track(name, props)` / `trackOnce(name, props)` from
`@hkl/bridge/analytics.js` and never touches `window.umami`. Without a tracker (dev, tests, a
content blocker) both are no-ops; an event that precedes the async tracker is held for up to 10 s.
`trackOnce` reports a name at most once per page load, for things that recur within a session.

**Served from our origin.** Content blockers list the Umami hosts, so both halves are served under
`ANALYTICS_PREFIX` (`/u`). The tracker script is a rewrite in `netlify.toml` (`/u/s.js` →
`cloud.umami.is/script.js`). The tracker posts to `<data-host-url>/api/send`, and `/u/api/send` is
the Netlify Edge Function `netlify/edge-functions/umami-send.js`, which relays the event to
`gateway.umami.is/api/send` with the visitor's address in the payload's `ip` field. A plain rewrite
is not enough there: Umami then sees only the Netlify node that made the request, so it locates
every visitor in a data-center city, and it merges visitors who share a node and a user agent,
because the address is an input to its session id. The function forwards the user agent and the
tracker's `x-umami-*` headers and nothing else. The rewrite, the function's path and
`ANALYTICS_PREFIX` must agree.

| Event | Properties | Reported from | Per page load |
|---|---|---|---|
| `midi-access` | `result`: `granted` / `denied` / `unsupported` | `requestMidi` (`apps/hkl/src/midi/engine.ts`) | once |
| `lumatone-connect` | `firmware`: `"1.5.0"`, or `unknown` | the connect-time firmware query's answer (`midi/engine.ts`) | once |
| `midi-connect` | — | Piano input bound to a port (`midi/piano.ts`) | once |
| `overlay-connect` | — | the overlay publisher's socket opened (`bridge/overlay-publish.ts`): a relay answered on this machine, whether or not an OBS source is subscribed | once |
| `first-note` | `source`: `lumatone` / `qwerty` / `piano` / `pointer`; `mode`; `mapping` | `input/first-note.ts`, from `pressHeld` and the canvas click. Playback and Composer-driven selection do not count | once |
| `recording-export` | `kind`: `hkr` / `mid` / `hkc` / `composer` (sent straight to the Composer tab) | `ui/recorder.ts` | every time |
| `composer-save` | `via`: `host` / `download`; `as` | `saveDocument` (`apps/composer/src/files.ts`), on success | once |
| `composer-export` | `kind`: `pdf` / `musicxml`; `via` | `exportDocument` (`files.ts`), on success | every time |

**What may be sent.** A fixed event name, and properties that are short enumerations. Never a file
name or path, a MIDI device name, note data, score or recording content, or anything a user typed.
The tracker adds the page URL, `document.title`, the referrer, screen size and language to every
payload, so **no app may put user content in the URL or the title** (none does: only the Guide sets
a title, to its tab name). It sets no cookie; the one thing it reads from storage is the opt-out
flag `localStorage['umami.disabled']`. Umami receives the visitor's IP address (from the edge
function, as it would from a direct connection); its published source uses it for the location
lookup and as an input to the hashed session id, and its schema has no column for it. The About
dialog's Privacy paragraph tells users that
anonymous statistics are collected and lists what is never seen or sent (scores, recordings, custom
instruments, file names, notes, device names, anything identifying); every event must keep that
list true.

Adding an event: pick a name of at most 50 characters, call `track`/`trackOnce` at the single point
every path to the action goes through, add the row above, and check the Privacy paragraph still
holds.
