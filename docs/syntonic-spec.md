# Syntonic / Polysyntonic tuning modes — design

Status: **implemented 2026-10-26** (uncommitted); §9 decisions ruled by Max the same day. The
colour section (§4) unifies colour for every JI mode, not only S/Y. Where the build departs from
this draft, §4 says so ("Built:").

## 1. What they are

Two new `TuningMode` values in the Tuning dropdown (proposed persistence keys `'S'`, `'Y'`;
listed after Schismatic):

- **Syntonic**: one comma level on each side of home.
- **Polysyntonic**: comma levels stack without bound.

In both, **every band is internally Pythagorean** (identical to Pythagorean mode within the band),
and whole bands are shifted by syntonic commas (81:80) relative to the **home band**, the band
holding the reference. The home band is always unaltered.

Offset `k` (in SC, + = raised ×81/80) of a band at distance `d = band − home`:

| d | … −4 | −3 | −2 | −1 | 0 | +1 | +2 | +3 | +4 … |
|---|---|---|---|---|---|---|---|---|---|
| Syntonic (`k = [0, +1, 0, −1][d mod 4]`) | 0 | +1 | 0 | −1 | 0 | +1 | 0 | −1 | 0 |
| Polysyntonic (`k = d`) | −4 | −3 | −2 | −1 | 0 | +1 | +2 | +3 | +4 |

Both rules are defined on the whole lattice. The Lumatone happens to show `d = −3…+3` under
Wicki-Hayden (48 keys in each of −2…+2; fragments of 22 keys at −3 and 18 at +3), but nothing
assumes that.

**Why lowered is on the left.** Under Wicki-Hayden each band holds at most one key per MIDI note:
the 12-TET unison vector `(7,−2)` (one board) is longer than the 6-wide band. So the 9/8 and 10/9
supertonics, or any other comma pair, can only coexist in different bands. A band's note window
drifts about 12/7 fifths sharpward per octave, so at a given register the left neighbour holds the
sharp side of the chain of fifths. That is where the spellings that get lowered sit (C#, F#, G#,
B, D# over A). With lowered on the left, a just third lies 4–4.5 key-widths from its root; the
other way round it lies 7.5–8. Hole census, ref A3, A1–A6:
- the left band lacks only D#2 of the lowered set;
- the right band lacks nine notes between B1 and D#4.

**Mapping.** Designed for Wicki-Hayden. Under Euler the same rule applies to 3-wide bands, where
the `+3q` octaves become ±SC. It is available there, unrecommended, and not gated (the
Wicki-Hayden spec's "no per-mode gating").

## 2. Pitch

```
exps(q, r, mode, mapping, anchor) = coordExps(q, r, 'P', mapping)
                                    + k(bandOfCell(q, mapping) − anchor) · SC
SC = 81/80 → [e2, e3, e5, e7] = [−4, +4, −1, 0]
```

- The band comes from the cell's **own** frame. A Wicki-Hayden copy column uses its own 6-band,
  shared with its source column, never its Euler-equivalent's band (the same rule as Schismatic
  copies).
- Within any band: identical to Pythagorean (all row steps 9/8; `(−1,+2)` octaves as in P).
- `(6,0)` band octave:
  - Polysyntonic: 81/40 everywhere.
  - Syntonic, by transition `0→1, 1→2, 2→3, 3→0`: 81/40, 160/81, 160/81, 81/40.
- Moving the anchor by `n` bands:
  - Polysyntonic: a global −n·SC shift. Every interval between two cells is unchanged.
  - Syntonic: depends only on `anchor mod 4`; moving it reshapes intervals between bands.

## 3. The anchor

```
anchor = bandOfCell(anchorRef.q, mapping)
anchorRef = manual selection ?? score-ref ?? default A3
```

- **The composer-source selection tier does not move the anchor.** That tier is Composer's
  cursor prior note, active only with the piano outline. If it moved the anchor, entering one
  note in a neighbouring band would retune the whole layout and the score. The effective ref is
  unchanged: it still slides the lattice and resolves piano input as today. (§9.1)
- **The home band is always unaltered:** its pitches are Pythagorean mode's, measured from
  A3 = 220 Hz.
- **Re-anchoring changes pitch, HEJI arrows and colour.** It never changes MIDI values, band
  boundaries or note letters.
- **No comma drift.** Ctrl+clicking an altered key makes its band home, so that key's own pitch
  moves by its comma count (§9.2).
- **HKL state.** `anchor` joins `TuningStateLike` (beside `mode`, `mapping`) and is recomputed in
  `state/reference.ts`'s tier recompute. An anchor change is a retune event, run by a new
  `onAnchorChanged`:
  - **Held voices:** physical-input voices migrate as today. Voices that stay on their cell
    (mouse, piano) retune in place to the cell's new pitch (the `setMapping` precedent).
  - **Lumatone LEDs:** a full colour diff via `syncLumatoneColors`, at most 280 keys.
  - **Caches** (audited 2026-10-26). Three signatures are keyed on `(ref, mode, mapping)` and must
    add `anchor`, because the anchor can change while the effective ref does not:
    - `ensurePianoOutline`'s `pianoOutlineCacheKey` (`render/draw.ts`); the S/Y footprint prefers
      `k = 0` bands, so it depends on the anchor;
    - `broadcastLayoutState`'s `lastLayoutStateSig` (`bridge/hkl-side.ts`), alongside the new
      `anchor` field;
    - `structSigOf` (`bridge/overlay-publish.ts`), alongside the published `anchor` (§6).

    The bridge's footprint signature already includes each cell's colour, so a recolour
    rebroadcasts on its own. Lumatone sync diffs against the device's actual colours. Lattice
    colours aren't cached anywhere; they're computed per draw.
  - **Composer:** a broadcast via `broadcastAllToComposer`.
- `onRefChanged` returns early when the spine doesn't move. The anchor can change without the
  spine moving (a score-ref change while a composer selection holds the effective ref), so
  `onAnchorChanged` cannot just piggyback on it.

## 4. Shared API and HKL internals

- **Pitch functions.** `coordExps`, `freqAt` and `hejiCommasFor` gain a **required**
  `anchor: number`, which only S/Y read. It is required so every caller has to decide, as with
  the mapping. New helper: `anchorOf(refQ, mapping)`.
- **`TuningMode` plumbing.**
  - `TuningMode` and `TUNING_MODES` in both definitions.
  - Built: no region branches. HKL's `regionInfo` / `modeHasShifts` table was dead once colour
    moved to exponents and was deleted; `coordExps` is the one place per-mode tuning lives.
- **HEJI.** Built: no S/Y branch either — `hejiCommasFor` now derives the arrows/hooks from
  `coordExps` (the syntonic / septimal commas between the cell's pitch and its `'P'` pitch;
  schisma not notated), which reproduced the old per-mode table on 175,692 cells and gives
  `syn5 = −k` in S/Y. `hejiChain` already renders any count (≤2 arrows per glyph, overflow onto
  natural-sign carriers).
- **Colour: one function of the pitch, for every JI mode.** Colour belongs to the pitch, not to the
  layout. A mode or mapping only decides which pitch sits on a cell; the same pitch gets the same
  colour wherever it appears. For a cell with exponents `e = [e2, e3, e5, e7]`:
  ```
  hue      = hueCycleOrder[ floor((57 + 7·e3 + 4·e5 + 10·e7) / 12) − 4   mod 7 ]
  septimal = e7 ≠ 0            (the .sl / .sd half-lerp variant)
  white    = MIDI pitch class ∈ whiteSet
  ```
  Each prime is weighted by its 12-TET step reduced into the octave (3/2 = 7, 5/4 = 4, 7/4 = 10).
  Equivalently, hue = 12-TET MIDI octave − the octaves contained in the prime factorisation, which
  is `computeHue`'s `floor(midi/12) − band` generalised. Octave (`e2`) never enters.
  - **It is today's colouring, exactly.** On 2026-10-26 the current `keyColorVariant` and this
    function agreed on every cell of q, r ∈ [−60, 60], for modes 5/P/D/7/V under both mappings:
    146,410 cells, 0 hue mismatches, 0 septimal-variant mismatches.
  - **The special cases it replaces**, each of which was that function computed another way:
    - `computeHue` (MIDI octave − band) on Ptolemaic cells;
    - the Pythagorean/Semiditonal SC-sibling redirect to `(q∓7, r±4)`, a cell with the same `(e3, e5)`;
    - Schismatic's Semiditonal-plus-5-per-band rotation (one schisma = 7·8 + 4·1 = 60 = 5 steps);
    - Septimal's region-B branch (the 35/36 shift is −14 + 4 + 10 = 0 steps, hence "Ptolemaic hue
      plus warm variant");
    - Wicki-Hayden's `columnSourceOf` redirect (a copy differs from its column by octaves only).
  - **Equal stays separate.** Its octave-based 3-hue cycle (`equalHueCycle` by sounding octave) is a
    genuinely different rule and is kept as is.
  - **Steps per comma.** SC = 2, schisma = 5, Pythagorean comma = 7 ≡ 0, 35/36 = 0. Under S/Y a
    pitch class therefore runs through all 7 hues across 7 comma levels (purple A → orange → green …
    raised; teal → yellow … lowered). **S and Y need no colour code of their own:** they only
    produce exponents (two or more commas from home) that no mode produced before.
  - **Placement.** The function is pure in `(q, r, mode, mapping, anchor)`, and the palette, ink
    profiles and HSL helpers already live in `@hkl/shared/colors`. So it moves there as
    `keyColor(q, r, mode, mapping, anchor) → { hue, isW, isB }` plus the hex helpers (`keyColorHex`,
    `lightSourceHex`, the ink remap `darkColorHex` uses). HKL's `render/colors.ts` becomes thin
    wrappers that read `tuning`. Composer can then compute a note's colour itself (§5).
  - **Clean-up.** `computeHue`, the V/B/`aDepth` branches and the `columnSourceOf` call go. The
    unused `isShifted` field goes (nothing reads it), as does `draw.ts`'s unused `computeHue`
    import. The stale comments go too: `shared/colors.ts` ("computeHue … is the single source of
    base hue") and `retune.ts` (a footprint recolour pass that doesn't exist, §5).
- **Ref picker / validation** (`compute88PianoCoords`, `validateRefNoteCandidate`). The ref is
  unaltered by construction, so route through Pythagorean state (precedent: Schismatic routes
  through Semiditonal). Built: the bounds tables are keyed by `ProbedMode` and S/Y read P's
  buckets via `probedMode()` at the lookups (the generated files stay probe-owned); they only draw
  the valid-ref boundary and size the canvas — re-probe on graduation.
- **Piano-input footprint.** Prefer cells in bands with `k = 0`:
  - Syntonic: complete. The return bands (d = ±2) hold every note the home band lacks, sharp
    spellings on the left and flat on the right.
  - Polysyntonic: only home has `k = 0`. The ~1/7 of notes absent from home take the nearest band
    (±1 SC) (§9.4).
- **Remaining checklist.** `isTuningMode` guards (`state/persistence.ts`, `recording/hkr.ts`,
  Composer `main.ts`, `bridge/hkl-side.ts`); the selector `<option>`s; `tuningDescription()`;
  `MODE_LABELS` / `TUNING_LABELS`; `validRefSetByMode` / `validRefPathsByMode`.
- **Other HKL consumers** of the pitch, HEJI and colour functions, which must pass the anchor:
  - `lumatone/sync.ts`
  - `render/draw.ts`
  - `render/info.ts` (analysis box)
  - `transcription/pitch.ts`
  - `tuning/frequency.ts`
  - `tuning/heji.ts`
  - `tuning/ratios.ts`

## 5. Composer

- **Each note takes the anchor of the key signature at its measure.** That is
  `anchorOf(findTonicCoord(tonic).q, mapping)`, the same derivation as the score-ref, so it is
  derived and never stored. No `.hkc` change.
- **Entry consistency.** With Sync on and no manual Ctrl+click selection, the score-ref drives
  HKL's anchor, so notes are entered under the score's anchor. In S/Y the existing ✓/⚠
  layout-match gate also compares HKL's anchor (added to `hkl-layout-state`) with the score
  anchor at the cursor. A mismatch gates entry like a mode mismatch.
- **Callers that need the per-measure anchor:**
  - `apps/composer/src/notation/accidentals.ts`
  - `apps/composer/src/notation/retune.ts`
  - `apps/composer/src/render/performance.ts`
  - `packages/notation/src/chord-mei.ts`
  - `packages/notation/src/coord-spelling.ts`
  - `packages/notation/src/heji-render.ts`
- **Key-signature edits retune.** Changing a key signature changes the anchor of the measures it
  governs, so existing notes there re-spell, recolour and re-sound (§9.3).
- **Note colours.** Composer stores `@color` / `data-light-color` at entry and never refreshes
  them. `footprint-changed` only caches cells for SC-transpose; no recolour pass exists, despite
  `retune.ts`'s comment. Today that is almost always harmless: retune preserves frequency, and
  colour is a function of pitch, so every exact match keeps a correct colour. Only inexact matches
  go stale, which is a latent bug. In S/Y a key-signature edit keeps the cell and changes the
  pitch, so the stored colour would be wrong every time. With `keyColor` in `@hkl/shared` (§4),
  the stored colours become a cache Composer rewrites from `(q, r, mode, mapping, anchor)`:
  - for the affected measures after a key-signature edit;
  - for every relocated note in a retune, which also fixes the latent inexact-match case.

  No bridge round-trip is needed.
- **Performance mode** compares played notes with expected notes partly by colour
  (`render/performance.ts`). This stays consistent because the anchor-mismatch gate keeps HKL's
  anchor equal to the score's.
- **Retune into or out of S/Y** uses the per-measure anchor.

## 6. Recording, overlay

- **`.hkr`.** The snapshot gains `anchor`. Note events in S/Y recordings carry an `a` (anchor)
  field; when it's absent, the snapshot's anchor applies. Mid-take re-anchoring then plays back
  exactly with no control-event channel, and MPE export and transcription read the same field.
  Old recordings are unaffected.
- **Overlay.** Publish `anchor` explicitly. The published `refQ` / `refR` are the effective ref,
  which can be the composer-source selection, and that doesn't drive the anchor.

## 7. Verification

- **`test/wh-layout/oracle.mjs`**, new S/Y rows:
  - in-band rows identical to P;
  - `(6,0)` per transition (§2);
  - Polysyntonic: re-anchoring is a global shift;
  - Syntonic: period 4.
- **Colour regression gate.** Before the refactor, snapshot current `keyColorVariant` (hue,
  septimal, white) for modes E/5/P/D/7/V × both mappings over q, r ∈ [−60, 60]. After the refactor
  the new `keyColor` must reproduce the snapshot exactly. After that, a live identity test would be
  tautological, so the snapshot is the gate. S/Y rows check +2 steps per comma from home.
- **HEJI:** chains for ±1…±4 commas.
- **Interval names** (`test/interval-names/smoke.ts` over S/Y). Checked 2026-10-26 against
  `findBaseName` for 14 classes × s = −4…+4. Two or more SCs already name losslessly: the nearest
  override becomes the base and the rest prints as grouped commas. For example 100/81 is "major
  3rd − syntonic comma", and its complement is "minor 6th + syntonic comma". No new overrides are
  required; dedicated adjectives for two-comma intervals would be Max's call.
- **Bounds-probe octave consistency.**
- **Composer:** a new `syntonic` fixture category:
  - entry in home and lowered bands;
  - key change re-anchors;
  - key-signature edit retunes;
  - ±2-arrow HEJI;
  - anchor-mismatch gate.
- `pnpm typecheck`, `pnpm build`, `pnpm check:boundaries`.

## 8. Anchoring in the other modes

Every mode has a band offset `k(d)`; the anchor matters only where `k` varies with the band.
- **E, 5, P, D, 7:** a cell's comma shift depends only on its position within the band, so `k` is
  constant. Every band carries the same comma pattern, so whichever band holds the ref is
  unaltered and the anchor drops out.
- **V (Schismatic):** stacks one schisma per band, counted from A3's band (`coordExps` takes no
  ref). In effect it is a fixed-anchor stacked mode. It is unchanged here. Its colour already
  follows its exponents (§4), so a later re-anchoring would need no colour work.

No change to any existing mode's pitches. Colours are unchanged too (§4 is a refactor, gated by §7).

## 9. Decisions (ruled 2026-10-26)

1. **The anchor ignores the composer-source selection tier** (cursor prior note, piano outline
   only), because that tier can wander into another band.
2. **Ctrl+click on an altered key re-anchors to its band.** That key's pitch changes by its comma
   count; there is no comma drift.
3. **A key-signature edit in an S/Y score retunes the notes in the affected measures.**
4. **Polysyntonic piano input:** notes absent from the home band (~1/7) come from the nearest band
   (±1 SC).
5. **Persistence keys** `'S'` / `'Y'`; dropdown order after Schismatic.
6. **Euler mapping** allowed, not hidden.

## 10. Docs on landing

- `docs/architecture.md`: tuning modes table, anchor, formulas, colour rule.
- `docs/architecture/composer.md`: per-measure anchor.
- `docs/decisions.md`.
- `docs/guide/core.md`.
- `CLAUDE.md`: the `TuningMode` list and the dual-definition checklist.
- The backlog's Layout and Color guides are Max's.
