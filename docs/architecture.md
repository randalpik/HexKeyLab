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
[`CLAUDE.md`](../CLAUDE.md).

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
  bridge/     @hkl/bridge — BroadcastChannel protocol + message types
  analysis/   @hkl/analysis — DOM-free sample-analysis DSP (Analyzer + Orchestrator) → analyzer.md
test/         composer-test, composer-inspect, bounds-probe, interval-names, engine-smoke, orchestrator-smoke, *-check.mjs
tools/        lumatone-cal, reset-calibration.sh   (hardware/ops)
vite/         dev-proxy.mjs + middleware (the dev umbrella)
```

Dependency DAG: `@hkl/shared ← {engine, notation, bridge} ← apps`, plus `@hkl/analysis` (zero deps)
← {analyzer, orchestrator}. `pnpm dev` runs all four app servers behind a single-origin reverse
proxy at `http://localhost:5170` (`/`→hkl, `/composer/`, `/analyzer/`, `/orchestrator/`) — same
origin is required because the HKL↔Composer/Analyzer/Orchestrator `BroadcastChannel` bridges and the
`IndexedDB` instrument registry are per-origin. See [CLAUDE.md](../CLAUDE.md) for the run/build/test
commands.

Imports use bare `@hkl/*` specifiers: each package's `exports` maps `./*.js` → `./src/*.ts`
(`@hkl/analysis` mixes `.js` and `.ts`, so its map is `["./src/*.js","./src/*.ts"]`); imports inside a
package stay relative. Verovio's WASM is CDN-loaded by `@hkl/notation`; the analyzer and orchestrator
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
note, not tuning state). **Trade**: 5-limit minor (10:12:15) is unreachable — minor becomes
Pythagorean (32:27) or septimal subminor (7:6); use `'5'` for 5-limit minor. The same trade applies
to `'D'`/`'V'`.

**Syntonic / Polysyntonic (`'S'`/`'Y'`)** — 5-limit for the Wicki-Hayden mapping. Each band is
internally Pythagorean (pure octaves and scales within a band) and whole bands are shifted by
syntonic commas around the **home band**, which is always unaltered. Offset `k` (in SC, + = raised
×81/80) of a band at distance `d = band − home` (`bandOffset(mode, d)`):

| d | … −4 | −3 | −2 | −1 | 0 | +1 | +2 | +3 | +4 … |
|---|---|---|---|---|---|---|---|---|---|
| Syntonic (`[0, +1, 0, −1][d mod 4]`) | 0 | +1 | 0 | −1 | 0 | +1 | 0 | −1 | 0 |
| Polysyntonic (`d`) | −4 | −3 | −2 | −1 | 0 | +1 | +2 | +3 | +4 |

- **Pitch**: `coordExps(q, r, 'P', mapping) + k(pitchBandOf(q, mapping) − anchor)·SC`, SC =
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
- **The anchor** (home band) is `anchorOf(refQ, mapping)` = the (spatial) band of the *anchor
  reference*, so the clicked band becomes home. A borrowed chromatic key keeps its comma relative
  to home: clicked in another band, it makes that band home and stays one comma below
  Pythagorean; clicked in the home band, it just becomes the ref. The anchor reference is
  manual Ctrl+click selection ?? score-ref ?? A3. Composer's cursor prior-note selection never
  moves it (it can sit in another band, and one entered note must not retune the layout and the
  score). Ctrl+clicking an altered key makes its band home, so that key's own pitch changes by its
  comma count — no comma drift. Moving the anchor re-anchors: pitch, HEJI arrows and color
  change; MIDI, spelling and band boundaries never do. Polysyntonic re-anchoring is a global
  −n·SC shift (every interval preserved); Syntonic depends only on `anchor mod 4`.
- **Live**: `state/reference.ts` derives `tuning.anchor` and `kbAnchor` from the same home ref
  (below, Ref-driven layout shift); an anchor change in S/Y runs `onAnchorChanged` (=
  `onTuningChanged`: held voices ramp in place, re-render, Lumatone color diff, Composer
  rebroadcast) in a microtask, after the synchronous ref fan-out (`onRefChanged`) has run. The
  anchor is part of the
  piano-outline cache key, the `hkl-layout-state` signature and the overlay structure signature.
  Recording playback and the overlay mirror pin it (`setAnchorOverride`). Piano input follows the
  one 88-cell picker rule (below) under S/Y's own ratios, so it plays 5-limit wherever the bands
  offer it.
- **Other modes**: the band offset is constant in E/5/P/D/7, so the anchor drops out
  (`tuning.anchor` exists; nothing reads it). Schismatic is the one other band-indexed mode — one
  schisma per band counted from A3's band, a fixed-anchor stacking.
- Gates: `test/syntonic/oracle.mjs` (pitch, k, band steps, re-anchoring, color, HEJI),
  `test/hkl-midi/anchor.mjs` (live tiers, re-anchor fan-out, piano input, `.hkr`), the Composer
  `syntonic` fixtures. Decisions: decisions.md 2026-10-26.

Persistence has no back-compat shims: any unrecognized `tuning` value reverts to `'5'`. `tuning.mode`
is canonical; `tuning.equalEnabled` / `tuning.septimalEnabled` are derived booleans kept in lockstep
by `setTuning()` (`apps/hkl/src/ui/controls.ts`) and still carried in the `.hkr` snapshot.

### Adding a tuning mode

- `TuningMode` is declared twice — `apps/hkl/src/state/persistence.ts` and `@hkl/shared/freq.js` —
  update both, plus `TUNING_MODES` in `@hkl/shared/freq.js` (every `isTuningMode` guard derives from it).
- `Record<TuningMode, …>` tables the compiler flags: `MODE_LABELS`
  (`apps/composer/src/notation/retune.ts`) and `TUNING_LABELS` (`apps/composer/src/setupDialog.ts`,
  `apps/hkl/src/bridge/hkl-side.ts`). One it won't: the `Record<string, …>` `TUNING_LABELS` in
  `apps/composer/src/input.ts`.
- The selector `<option>` in `apps/hkl/index.html` and the `tuningDescription()` switch in
  `apps/hkl/src/bridge/hkl-side.ts`.
- Re-run both `test/bounds-probe/` probes (they run the real picker over `TUNING_MODES`) so
  `PIANO_BOUNDS_TABLE` and `VALID_REF_TABLE` get the new mode's bucket under every mapping.
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
canonical quantity is `coordExps(q, r, mode, mapping, anchor)` (`@hkl/shared/freq.js`; `anchor` is
read only by S/Y but required, so every caller decides): a cell's
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
re-spells, and color carries it. No per-mode table: S/Y get `syn5 = −k` for free.

### Ref-driven layout shift

The reference note (Ctrl+click any hex, or set from Composer) slides the lattice under the static
outline so the ref's spine cell lands at the outline center.

**One authority** (`state/reference.ts`). The tiers are a selection — two slots, the user's
Ctrl+click and Composer's cursor note — then the score-ref, then A3. The *home ref* is Ctrl+click ??
score-ref ?? A3; the *effective ref* is the home ref, except in the piano outline, where the cursor
note is the ref when it is newer than the Ctrl+click (elsewhere the cursor note is ignored and never
displaces a Ctrl+click). The keyboard anchor `kbAnchor` = `refSpine(home ref)` — where the
Lumatone/QWERTY layout sits and where every non-piano view centers — and the S/Y `tuning.anchor` are
derived there and nowhere else (the overlay mirror alone copies the publisher's). Every tier change
recomputes both and, if the effective ref or `kbAnchor` moved, runs one listener synchronously,
`effects/onRefChanged(dq, dr)`: held physical voices migrate by the `kbAnchor` delta, MIDI reverse
map + Lumatone colors, piano-outline invalidation, view re-center, redraw, Composer broadcast. A
Ctrl+click slides (`withRefSlide`); everything else snaps, and a snap while a slide is in flight
redirects the slide rather than letting it drag the view back to its old target. Handlers only
mutate tiers — none can move a ref without re-centering (decisions.md 2026-10-27).

```ts
// apps/hkl/src/tuning/refspine.ts
refSpine(refQ, refR) = qmod3 0 → (refQ,   refR)      // Pythag spine
                       qmod3 1 → (refQ−1, refR)      // 5-limit M3 above qm0
                       qmod3 2 → (refQ+1, refR)      // same-row Pythag spine
```

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

**Ref validation** (`validateRefNoteCandidate` in `apps/hkl/src/render/draw.ts`): two constraints —
(1) `coordToMidi(q,r) ∈ [21,108]` (`57 + 4q + 7r` Euler); (2) the 88-cell footprint spells with ≤ ±3
accidentals. The dotted "valid ref bounds" overlay is a cached visual aid from the same check, not a
separate gate.

**88-cell picker** (`apps/hkl/src/tuning/picker.ts`, wrapped by `compute88PianoCoords`; the bounds
probes run the same module): for each MIDI 21..108, among the cells with that nominal MIDI, ONE
ranking rule in every mode and mapping. The three rules are:
(1) lowest reduced Tenney Height of the ratio from the ref
under the mode's own ratios; (2) if the lowest-TH cells differ in pitch — only at the tritone, whose
two spellings are complements (45/32 vs 64/45) — the **augmented 4th** (the spelling a fourth above
the ref by letter; any other tie would fall back to the ref's octave line); (3) among
cells of that pitch (Wicki-Hayden twins, P/D comma siblings, in-band vs cross-band octaves), the one
fewest key steps from the ref — so the footprint clusters on the ref's band. TH is octave-invariant,
so spelling is octave-consistent by construction.
- `test/bounds-probe/octave-consistency.mjs` finds 0 breaks outside S/Y, and also in Wicki-Hayden
  and chromatic Syntonic.
- In Euler S/Y and in Wicki-Hayden and chromatic Polysyntonic, a spelling's 5-limit pitch can
  exist in one octave's band and not the next, so some drift is expected and reported. The ref maps to itself. `'V'` ranks under `'D'` ratios so
schisma exponents don't distort the spelling. → decisions.md 2026-10-26 "One picker rule".

Coverage: ~55 unique MIDI/ref in 5-limit; 88-cell footprint per ref in 7-limit (~208–210 unique
pitches reachable from a central key). One LTN file gives every physical key a stable
`(channel, note)`; all tuning/layout interpretation is runtime software state — no per-layout LTN,
`.scl`/`.kbm`, or external synth config.

### Note-name mapping (Euler / Wicki-Hayden / Chromatic)

A second axis, orthogonal to the tuning mode: **where note names sit** on the hex grid
(`Mapping = 'euler' | 'wickiHayden' | 'chromatic'`, single definition in `@hkl/shared/mapping.js`
with `MAPPINGS`, `MAPPING_LABELS`; toolbar `Mapping:` dropdown). It applies identically to every
tuning mode — no per-mode gating.

**One column step.** `r` is always the fifth, and a column step `(+1, 0)` is `COLUMN_STEP`
semitones: 4 Euler, 2 Wicki-Hayden, 1 chromatic. Everything except `eulerOf` derives from it:
- `coordToMidi = 57 + c·q + 7r`;
- band width `W = 12/c`, with `bandOfCell = floor((q + W/3)/W)` and `posInBandOf = (q + W/3) mod W`;
- the ref's qm0 column at position `W/3`;
- `fromEuler` / `vecFromEuler` scale `q` by `4/c`;
- the picker's isotone `(7, −c)`;
- the `verticalFreq` column gradient `log(2)·c/12`.

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
- **Reference**: `refSpine` centers the qm0 *original* column of the ref's own 6-band, in the ref's
  row (at most 3 columns away), so the spine has its copy qm0′ to the right and the ref stays where
  it sits in its band — Euler's rule (`qm1 → q−1`, `qm2 → q+1`) with 6-wide bands; the anchor is
  that cell. (A first rule moved a copy ref to its same-name original one board away, `(Q−7, R+2)`;
  that misaligned the ref horizontally and was replaced.) **Picker / resolver**: candidates satisfy
  `c·q + 7r = N` (c = 4 Euler, 2 Wicki-Hayden, 1 chromatic), stepping along the isotone `(7, −c)`
  over `k ∈ ±80/c` (the same ±80-fifth span in every mapping); projection `7Δq − c·Δr`; copies are
  candidates like any cell. `VALID_REF_TABLE` / `PIANO_BOUNDS_TABLE` carry an
  outer mapping dimension (regenerated by `test/bounds-probe/`).
- **Switching mapping** (`setMapping`, `apps/hkl/src/ui/controls.ts`): the reference, anchor, held mouse /
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
- `bandOfCell` is the spatial band. It drives seams, position in band, `refSpine`, the anchor,
  the Schismatic schisma and the schismatic-chord check.
- `pitchBandOf` is the band whose Syntonic/Polysyntonic offset a cell carries. It equals
  `bandOfCell(Q−5)` at the two positions whose source is in the band to the left (1 and 3:
  F#, G# on A's row), and the own band everywhere else.
- So under S/Y the borrowed columns carry the left band's comma: the home band is Pythagorean
  except the ref's just M6 and leading tone (Tuning modes → Syntonic / Polysyntonic).
- Schismatic deliberately does **not** carry: it is Semiditonal × schisma^(spatial band). The
  borrowed columns therefore keep 5/6 and 15/16, and a new column against `(Q−5, R−1)` is
  2/1 × schisma at those two positions.

**Spine and conversion.**
- `refSpine` centers the qm0 of the ref's own band, in its row, so the ref sits ≤4 columns left
  or ≤7 right of center.
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
- the chromatic rows of `test/syntonic/oracle.mjs`, `test/color-gate/`, `test/bounds-probe/` and
  `test/hkl-midi/mapping-switch.mjs`;
- the Composer `mapping` and `syntonic` fixtures.

---

## Color scheme

**Color belongs to the pitch, not the layout**: one function of a cell's prime exponents colors
every JI mode under both mappings, so the same pitch gets the same color wherever it appears; a
mode only decides which pitch sits on a cell. Light/dark encodes the 12-TET black/white key.
Implemented once, purely, in `@hkl/shared/keycolor.js` (`keyColor`, `keyColorHex`,
`lightSourceHex`, `inkColorHex`); HKL's `render/colors.ts` only supplies its live layout, and
Composer recolors notes with the same functions.

- **JI modes — 7 hues × {light,dark}**, `hueCycleOrder = [PU,PK,OR,YE,GR,TE,BL]` indexed by
  `floor((57 + 7·e3 + 4·e5 + 10·e7) / 12) − 4 (mod 7)` on `coordExps`. Each prime is weighted by its
  12-TET step reduced into the octave (3/2 = 7, 5/4 = 4, 7/4 = 10), so the hue is the pitch's 12-TET
  octave minus the octaves its factorization contains; octave (`e2`) never enters. Steps per comma:
  syntonic 2, schisma 5, Pythagorean 7 ≡ 0, 35/36 0. Hence Ptolemaic's `floor(midi/12) − band`,
  P/D's "color as the SC sibling", Schismatic's +5 per band, Septimal's "Ptolemaic hue", a
  Wicki-Hayden copy's "its column's color", a chromatic borrowed column's "its source band's
  hue" under S/Y, and Syntonic/Polysyntonic's +2 per comma (purple A → orange → green … raised,
  teal → yellow … lowered) are all this one function.
- **Septimal variant**: a cell with `e7 ≠ 0` takes `.sl`/`.sd`, a 50% lerp toward the next hue.
- **Equal — 3 hues**: `[BL,PU,PK][floor(midi/12) % 3]` by sounding octave, rotated so A3 = purple —
  the one genuinely separate rule.
- **Light vs dark**: by the cell's own MIDI pitch class — light if ∈ {0,2,4,5,7,9,11}, else dark.

Regression gate: `test/color-gate/gate.mjs` pins hue/light/septimal and the three hex outputs for
every mode × mapping over q, r ∈ [−40, 40] (re-seed only for an intended color change).

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
