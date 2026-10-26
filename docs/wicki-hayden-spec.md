# Wicki-Hayden mapping — spec

Status: **proposed** (2026-10-25). No open decisions; nothing is implemented yet.

## 1. What it is

A **Mapping** option, orthogonal to tuning mode: **Euler** (default; today's lattice) or
**Wicki-Hayden**. It changes where note names sit, not the tuning, and it applies identically to
all six modes (Equal · Ptolemaic · Pythagorean · Semiditonal · Septimal · Schismatic): no per-mode
gating, staging, or mode-specific code in the mapping itself.

**UI.** A `Mapping:` dropdown directly under `Tuning:` in the toolbar, with options `Euler` and
`Wicki-Hayden`. The toolbar gains a row; that's accepted.

**Construction.** For each fifths column, add a column to its right holding the same notes as that
column, shifted **down 2 cells and exactly one octave (2:1)**. The new column is the old one as it
is: same names, no region / comma / schisma adjustment. Bands become 6 wide.

**Every cell is its own cell.** "Copy" describes only how a column's contents are derived. Cells
are stored, selected, recorded, picked and sent to Composer by their own coordinates, like any
other cell. No cell aliases another, even where pitches coincide.

- Row neighbors become whole tones, so the neighbor set is ±M2 (row), ±P5 (`r`), ±P4 `(−1,+1)`.
- Each column and its copy are an exact octave apart along `(+1,−2)`.
- **Accepted tradeoff:** the Lumatone's long axis `(+7,−2)` carries no net pitch, so the 280-key
  range drops from MIDI 4–113 (109 semitones) to 30–85 (55 semitones).

## 2. Coordinates

Under Wicki-Hayden, a cell's coordinate is its own `(Q, R)` on the existing hex grid (`hexToScreen`
geometry unchanged), and `KeyId` is `"Q,R"` in that mapping. Contents are defined from the Euler
lattice:

```
Q even:  the Euler cell (Q/2, R)
Q odd:   its left neighbor × 9/8   (= Euler column (Q−1)/2 shifted 2 cells down and an exact octave down)
```

| quantity | definition |
|---|---|
| prime exponents | `Q` even: `coordExps(Q/2, R, mode)`; `Q` odd: `coordExps((Q−1)/2, R, mode) + [−3, 2, 0, 0]` |
| note name | `Q` even: `noteName(Q/2, R)`; `Q` odd: `noteName((Q−1)/2, R+2)`; octave from the cell's own pitch |
| nominal MIDI | `57 + 2Q + 7R` |
| color, JI modes | the column's color. The JI hue is octave-invariant, so this is also the sounding color. Compute it at the Euler-equivalent coordinates: even `(Q/2, R)`, odd `((Q−1)/2 − 3, R+2)` |
| color, Equal | by sounding octave: `[BL,PU,PK][floor(midi/12) % 3]` with the cell's own nominal MIDI |
| light / dark | by the cell's own pitch class |

**6-band.** `b = floor((Q+2)/6)`, and `((Q+2) mod 6) = 0…5` gives the column order
**`[qm2, qm2′, qm0, qm0′, qm1, qm1′]`**. A3 sits at `(0,0)` (qm0), and qm0′ is at `(1,0)`.

**Reference.** The reference root stays on qm0 with qm0′ to its right, so the major scale from the
reference root occupies the middle four columns (qm2′, qm0, qm0′, qm1). Any cell can be the
reference. The spine (the cell centered under the outline) follows `refSpine`'s lineage rule in
this mapping:

| reference on | spine |
|---|---|
| qm0 | itself |
| qm1 | `(Q−2, R)` |
| qm2 | `(Q+2, R)` |
| a copy column | first `(Q−7, R+2)` (same name and nominal octave, on the original column), then the rule above |

The keyboard anchor (`kbAnchorQ/R`) is that spine cell, in this mapping.

## 3. Interval structure (test oracle)

These hold in every mode:

- `(+1, 0)` from an original column = **9/8** exactly.
- `(+1, −2)` from an original column = **1/2** exactly.
- `(+1, 0)` from a copy column = the mode's q-step ÷ 9/8.
- 6-column band `(6, 0)` = the mode's band octave (2/1; in Schismatic, octave + schisma).

Per mode, generated with `coordExps`. "Row" is qm2 → qm2′ → qm0 → qm0′ → qm1 → qm1′ → next qm2.
"Shape" is the Wicki-Hayden major-scale shape from the reference: offsets `(1,0) (2,0) (−1,1) (0,1)
(1,1) (2,1) (−1,2)`.

| mode | row | shape from reference |
|---|---|---|
| E | 200¢ ×6 | 2 4 5 7 9 11 12 semitones |
| 5 | 9/8 10/9 9/8 10/9 9/8 256/225 | 9/8 5/4 27/20 3/2 27/16 15/8 81/40 |
| P | 9/8 9/8 9/8 9/8 9/8 65536/59049 | 9/8 81/64 4/3 3/2 27/16 243/128 2/1 |
| D | 9/8 9/8 9/8 10/9 9/8 4096/3645 | 9/8 5/4 4/3 3/2 27/16 15/8 2/1 |
| 7 | 9/8 8/7 9/8 10/9 9/8 448/405 | 9/8 5/4 21/16 3/2 27/16 15/8 63/32 |
| V | 9/8 9/8 9/8 10/9 9/8 9/8 | 9/8 5/4 4/3 3/2 27/16 15/8 2/1 |

In Schismatic every row step is 9:8 or 10:9. The schisma stays on the band boundary, now spread over
6 columns instead of 3.

## 4. Frame and storage

`Mapping = 'euler' | 'wickiHayden'` is part of the coordinate frame, the way tuning mode is today:
`(Q, R)` means nothing without it. It is carried wherever the mode is:

- **HKL state:** pref `mapping` (default `'euler'`) in `state/persistence.ts`, with an
  `isMapping` guard. At runtime it sits beside `tuning.mode`, because every pitch path already
  receives `TuningStateLike`. It is not a tuning mode and never appears in `TUNING_MODES`.
- **`.hkr`:** a snapshot field, absent → `'euler'`. Playback applies it through its control
  handler, as `recording/apply.ts` already does with `setTuning()`.
- **Composer:** the score's required layout gains `mapping` beside its required tuning mode (a
  Setup control; absent → `'euler'`, so existing `.hkc` files are unchanged). HKL broadcasts its
  mapping with its mode, and the entry-mismatch gate and ✓/⚠ indicator compare both.
- **Overlay:** a published-state field. **MPE `.mid`:** round-trips the mapping with the
  coordinates.

**Frame conversion ("the retune formula")**:

- Euler `(q, r)` → `(2q, r)`, exact in every mode.
- Wicki-Hayden even `(Q, R)` → `(Q/2, R)`, exact.
- Wicki-Hayden odd `(Q, R)` → `((Q−1)/2 − 3, R+2)`. Exact in 5/P/D/7 (brute-force: 625/625 copies
  equal an Euler cell). In Schismatic no copy equals any Euler cell (0/625), so this lands one
  schisma (1.95¢) away; Composer retune reports it like any other inexact relocation.

Composer retune uses this closed form. It doesn't search, because a taxicab tiebreak is
meaningless across frames.

## 5. Switching mapping in HKL

`setMapping()` (in `ui/controls.ts`, beside `setTuning()`) does the following, in order:

1. **Reference and anchor** convert by the frame formula, so the reference keeps its note, and the
   anchor is recomputed from it via §2's spine rule. This must **not** go through `onRefChanged`'s
   held-voice migration (see 2).
2. **Held Lumatone and QWERTY voices keep their `(q,r)`** and retune in place to the new mapping's
   pitch at that `(q,r)`. This is the same path as a tuning-mode change (`rampActiveFreqs` in
   `effects/onTuningChanged.ts`).
   - Because the anchor converts, a held key's grid position can move (whenever the spine's `q` is
     nonzero, e.g. reference A4).
   - Release and aftertouch already resolve to the `KeyId` that was pressed: the held-input
     registry (`input/held.ts`, landed 2026-10-25, gate `test/hkl-midi/held-inputs.mjs`). So the
     switch simply does not call `migrateHeld` for Lumatone or QWERTY.
3. **Held mouse notes and piano-input notes** convert by the frame formula and keep sounding.
   Selection keys and the registry's `'piano'` records are rewritten in place (a new registry
   operation that re-keys records without moving voices).
4. **No drop case.** A converted note outside the drawn lattice stays held, as after a reference
   change; Clear releases it.
5. **Fan-out**, as `onTuningChanged` does: rebuild both offscreen layers (their contents depend on
   the mapping), regenerate the 88-cell footprint, resync Lumatone colors, broadcast to Composer.
   Then `savePrefs({ mapping })`.

## 6. Changes

- **Toolbar (`apps/hkl/index.html`, `#tb-group-layout`):** a new `.lsel` row,
  `<span>Mapping:</span><select id="selMapping">`, directly after the `#selTuning` row. Options:
  `euler` "Euler" (selected), `wickiHayden` "Wicki-Hayden".
- **Shared primitives** (`@hkl/shared` `freq.ts`, `notes.ts`; HKL `render/colors.ts`,
  `tuning/frequency.ts`, `tuning/regions.ts`, `layout/coords.ts`):
  - `coordExps`, `freqAt`, `coordToMidi`, `noteName`, `keyOctave`, `keyColorVariant`,
    `keyColorHex`, `keyFreq*`, `jiRatioWithState`, `bandOf` and `posInBand` follow §2.
  - Pass the mapping as a **required** parameter (or as part of the required state object) so
    `pnpm typecheck` enumerates every call site: about 94 across `apps` + `packages`.
  - The 14 hard-coded `57 + 4·q + 7·r` formulas (9 files, Composer included) route through
    `coordToMidi`.
- **`Record<TuningMode, …>` tables gain the mapping dimension:** `PIANO_BOUNDS_TABLE`,
  `VALID_REF_TABLE`, `validRefSetByMode` / `validRefPathsByMode`. They are regenerated by
  `test/bounds-probe`, not hand-edited.
- **Render (`render/draw.ts`):**
  - `buildGridKeys` and `hexAtPoint` are unchanged; cells are grid positions in both mappings.
  - The hex and text layers resolve content through §2.
  - Layers stay built at a fixed origin, and a reference slide only moves the blit offset, so the
    zero-cost-blit invariant holds.
- **Input:** `fixedMidiToKeyAt` (`midi/engine.ts`) and QWERTY are unchanged in form (`base +
  anchor`); the anchor is in the active mapping. The held-input maps are per §5. The fixed Lumatone
  note map (`CHANGE_KEY_NOTE` setup in `lumatone/sync.ts`) is mapping-free and unchanged.
- **Tilt (`layout/geometry.ts`):** `verticalFreq` uses a per-column gradient of `log(2)/6` instead
  of `log(2)/3`. The `lumatone` and `piano` tilts are unchanged.
- **88-cell picker (`compute88PianoCoords`):** copy columns are candidates like any cell.
  - Candidates satisfy `2Q + 7R = N`: start at `Q ≡ 4N (mod 7)` and step along the isotone
    `(7, −2)`.
  - Tiebreak projection is `7ΔQ − 2ΔR`, with the octave step `(6, 0)` → `PROJ_PER_OCT = 42`.
  - The ordering (reduced Tenney height, then |projection − octave target|) is unchanged.
    Pitch-equal cells one isotone step apart differ by 53 in projection, so the pick stays
    deterministic. The Schismatic → Semiditonal picker routing is unchanged.
- **MIDI out (`midi/engine.ts`):** `degreeMap` enumerates pitch classes over the active mapping's
  footprint; Schismatic copies add pitch classes of their own.
- **Composer:** a Setup `Mapping` control beside the required tuning, the mismatch gate and
  indicator, closed-form retune (§4), and `mapping` threaded through the shared primitives.

## 7. Non-goals

- No change to tuning math within a mapping, the Lumatone note map, or LED-on-keystroke.
- No per-mode gating: it lands for all six modes at once.
- No mitigation of the range reduction, and no new drop case on switching.

## 8. Verification

- **`test/wh-layout/oracle.mjs`** (new, Node, imports the real modules). Over the 280-key footprint
  for every mode it asserts:
  - the §3 invariants and tables;
  - the §2 name and color rules, including Equal by sounding octave;
  - frame-conversion round trips (exact except Schismatic copies, which land within one schisma);
  - the 280 Lumatone cells are 280 distinct `KeyId`s.
- **`test/hkl-midi/mapping-switch.mjs`** (new behavioral gate, modeled on `departure.mjs`):
  - with the reference at A4 (spine `q ≠ 0`, so the anchor moves), hold Lumatone keys, switch
    mapping both ways, then release;
  - held voices retune in place, nothing orphans, and nothing is dropped;
  - repeat with a reference change between switch and release.
- **`test/bounds-probe`:** regenerate the tables with Wicki-Hayden; `octave-consistency.mjs` passes
  with copy candidates in the picker.
- `pnpm typecheck`, `pnpm build`, `pnpm check:boundaries`.
- **Composer:** `pnpm test:composer` (full suite; the change is cross-cutting). New fixtures:
  - Setup switches mapping (retune both directions, Schismatic copies included);
  - the entry-mismatch gate fires on a mapping mismatch;
  - notes entered under Wicki-Hayden round-trip.
- `test/hkl-midi/sync-order.mjs`: ordering is unchanged on a mapping-triggered color push.
- `test/hkl-inspect` console scans (Chromium and Firefox) under Wicki-Hayden, plus a screenshot per
  mode for Max to review.
- Hardware: color push and play-through on the Lumatone; held keys across a mapping switch.

## 9. Docs on landing

- `docs/architecture.md` (Tuning system → a Wicki-Hayden mapping subsection) and
  `docs/architecture/hkl.md`, `composer.md`.
- `docs/guide/core.md` (the `Mapping:` dropdown) and `docs/guide/composer.md` (the Setup control).
- A `docs/decisions.md` entry: cells are stored in their own frame, mapping is part of the
  coordinate frame, and held physical voices stay on their `(q,r)` across a switch.
- CLAUDE.md: add the mapping dimension to the dual-definition checklist under Tuning modes.
