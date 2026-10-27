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
— keep them in sync (see CLAUDE.md). The per-mode tuning lives in exactly one place,
`coordExps` in `@hkl/shared/freq.js`: a per-`qmod3` column shift (SC = 81/80, septimal 63/64) on
the 5-limit base, plus a per-band offset for Schismatic and Syntonic/Polysyntonic. Frequency,
ratios, HEJI arrows and colour all derive from it. Selector order:
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

**Syntonic / Polysyntonic (`'S'`/`'Y'`)** — each band is internally Pythagorean (pure octaves and
scales within a band, the Wicki-Hayden use case), and the bands around it are shifted by whole
syntonic commas, lowered band LEFT / raised RIGHT — under Wicki-Hayden each band holds at most one
key per MIDI note (the 12-TET unison vector `(7,−2)` outruns the 6-wide band), so comma
alternatives (9/8 vs 10/9, 81/64 vs 5/4) live in neighbouring bands, and the left neighbour holds
the sharp-side spellings a 5-limit third lowers. **The home band is always unaltered**: it is the
**anchor**, `anchorOf(refQ, mapping)` = the band (in the cell's own frame) of the *anchor reference*
— manual Ctrl+click selection ?? score-ref ?? A3; Composer's cursor prior-note selection never moves
it (it can sit in another band, and one entered note must not retune everything). Moving the
anchor re-anchors: pitch, HEJI arrows and colour change; MIDI, spelling and band boundaries never
do. Polysyntonic re-anchoring is a global −n·SC shift (every interval preserved); Syntonic depends
only on `anchor mod 4`. In every other mode the band offset is constant, so the anchor drops out
(`tuning.anchor` still exists; nothing reads it). `state/reference.ts` recomputes `tuning.anchor`
with the ref tiers; a change in S/Y runs `onAnchorChanged` (= `onTuningChanged`: held voices ramp,
re-render, Lumatone colour diff, Composer rebroadcast). Recording playback and the overlay mirror pin
it (`setAnchorOverride`). Piano input follows the one 88-cell picker rule (below) under S/Y's own
ratios, so it plays 5-limit wherever the bands offer it. Spec: `docs/syntonic-spec.md`.

Persistence has no back-compat shims: any unrecognized `tuning` value reverts to `'5'`.

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
ranking rule in every mode and mapping — (1) lowest reduced Tenney Height of the ratio from the ref
under the mode's own ratios; (2) if the lowest-TH cells differ in pitch, the ref's octave line picks
the pitch (only at the tritone, whose two spellings are complements: 45/32 vs 64/45); (3) among
cells of that pitch (Wicki-Hayden twins, P/D comma siblings, in-band vs cross-band octaves), the one
fewest key steps from the ref — so the footprint clusters on the ref's band. TH is octave-invariant,
so spelling is octave-consistent by construction (`test/bounds-probe/octave-consistency.mjs`: 0 breaks
outside S/Y; in S/Y a spelling's 5-limit pitch can exist in one octave's band and not the next, so
some drift is expected and reported). The ref maps to itself. `'V'` ranks under `'D'` ratios so
schisma exponents don't distort the spelling. → decisions.md 2026-10-26 "One picker rule".

Coverage: ~55 unique MIDI/ref in 5-limit; 88-cell footprint per ref in 7-limit (~208–210 unique
pitches reachable from a central key). One LTN file gives every physical key a stable
`(channel, note)`; all tuning/layout interpretation is runtime software state — no per-layout LTN,
`.scl`/`.kbm`, or external synth config.

### Note-name mapping (Euler / Wicki-Hayden)

A second axis, orthogonal to the tuning mode: **where note names sit** on the hex grid
(`Mapping = 'euler' | 'wickiHayden'`, single definition in `@hkl/shared/mapping.js`; toolbar
`Mapping:` dropdown; spec `docs/wicki-hayden-spec.md`). **Euler** is everything above. **Wicki-Hayden**
inserts, after every fifths column, a column holding the same notes shifted down 2 cells and exactly one
octave — rows step in whole tones (9:8 / 10:9 / mode-dependent), bands are 6 wide, column order per
band `[qm2, qm2′, qm0, qm0′, qm1, qm1′]` by `((Q+2) mod 6)`, A3 at `(0,0)`.

- **Cells are their own cells.** The mapping is part of the coordinate frame, like the tuning mode:
  a `(q, r)` means nothing without it. Every Wicki-Hayden cell has an **Euler-equivalent**
  (`eulerOf`: even `Q` → `(Q/2, R)`, odd → `((Q−1)/2 − 3, R+2)`) with the same name, spelled octave and
  nominal MIDI (`57 + 2Q + 7R`), and the same pitch except a Schismatic copy (one schisma higher — it
  keeps its column's band). The shared primitives (`coordExps`, `freqAt`, `coordToMidi`, `noteName`,
  `keyOctave`, `hejiCommasFor`) take a required `mapping` and resolve through it; HKL's state-based
  helpers read `tuning.mapping` (carried on `TuningStateLike`).
- **Frame conversion** (`convertCell`): Euler → Wicki-Hayden exact (original column `(2q, r)`);
  Wicki-Hayden → Euler pitch-exact except Schismatic copies. Used by Composer retune, the bridge, and
  cross-score paste. Lattice *vectors* (transpose buttons, SC shifts, harmonics) map via `vecFromEuler`
  (q doubles — parity-preserving, so the step means the same interval from originals and copies).
- **Reference**: `refSpine` centres the qm0 *original* column of the ref's own 6-band, in the ref's
  row (at most 3 columns away), so the spine has its copy qm0′ to the right and the ref stays where
  it sits in its band — Euler's rule (`qm1 → q−1`, `qm2 → q+1`) with 6-wide bands; the anchor is
  that cell. **Picker / resolver**: candidates satisfy
  `c·q + 7r = N` (c = 4 Euler, 2 Wicki-Hayden), stepping along the isotone `(7, −c)`; projection
  `7Δq − c·Δr`; copies are candidates like any cell. `VALID_REF_TABLE` / `PIANO_BOUNDS_TABLE` carry an
  outer mapping dimension (regenerated by `test/bounds-probe/`).
- **Switching mapping** (`setMapping`, `apps/hkl/src/ui/controls.ts`): the reference, anchor, held mouse /
  piano-input / pedal-sustained notes convert by the frame formula (same pitch); held Lumatone / QWERTY
  voices keep their `(q,r)` and retune in place (they release through the key they struck,
  `input/held.ts`); nothing is dropped. The `verticalFreq` tilt uses a `log(2)/6` column gradient — under
  Wicki-Hayden it coincides with the Lumatone case-row tilt, because the Lumatone's long axis `(7, −2)`
  carries no net pitch (the accepted range cost: 55 semitones on the 280 keys).

---

## Color scheme

**Colour belongs to the pitch, not the layout**: one function of a cell's prime exponents colours
every JI mode under both mappings, so the same pitch gets the same colour wherever it appears; a
mode only decides which pitch sits on a cell. Light/dark encodes the 12-TET black/white key.
Implemented once, purely, in `@hkl/shared/keycolor.js` (`keyColor`, `keyColorHex`,
`lightSourceHex`, `inkColorHex`); HKL's `render/colors.ts` only supplies its live layout, and
Composer recolours notes with the same functions.

- **JI modes — 7 hues × {light,dark}**, `hueCycleOrder = [PU,PK,OR,YE,GR,TE,BL]` indexed by
  `floor((57 + 7·e3 + 4·e5 + 10·e7) / 12) − 4 (mod 7)` on `coordExps`. Each prime is weighted by its
  12-TET step reduced into the octave (3/2 = 7, 5/4 = 4, 7/4 = 10), so the hue is the pitch's 12-TET
  octave minus the octaves its factorisation contains; octave (`e2`) never enters. Steps per comma:
  syntonic 2, schisma 5, Pythagorean 7 ≡ 0, 35/36 0. Hence Ptolemaic's `floor(midi/12) − band`,
  P/D's "colour as the SC sibling", Schismatic's +5 per band, Septimal's "Ptolemaic hue", a
  Wicki-Hayden copy's "its column's colour", and Syntonic/Polysyntonic's +2 per comma (purple A →
  orange → green … raised, teal → yellow … lowered) are all this one function.
- **Septimal variant**: a cell with `e7 ≠ 0` takes `.sl`/`.sd`, a 50% lerp toward the next hue.
- **Equal — 3 hues**: `[BL,PU,PK][floor(midi/12) % 3]` by sounding octave, rotated so A3 = purple —
  the one genuinely separate rule.
- **Light vs dark**: by the cell's own MIDI pitch class — light if ∈ {0,2,4,5,7,9,11}, else dark.

Regression gate: `test/color-gate/gate.mjs` pins hue/light/septimal and the three hex outputs for
every mode × mapping over q, r ∈ [−40, 40] (re-seed only for an intended colour change).

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
