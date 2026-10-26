# HKL Composer — Architecture Reference

A keyboard-driven score editor that uses HKL as its input device. MEI is the
document and Verovio engraves it; Composer owns everything Verovio does not —
the cursor model, the line partition and pagination, engraving rules applied
before and after the engrave, and incremental re-rendering. How to *use* it is
in the [Composer guide](../guide/composer.md); tuning and coordinates are in
[architecture.md](../architecture.md), audio in [engine.md](engine.md). This
document describes what is. Why it is that way, and every dead end, is in
[decisions.md](../decisions.md) and [lessons.md](../lessons.md).

## Overview

Composer and HKL run as two tabs on one origin and share nothing but the
`@hkl/bridge` `BroadcastChannel`. Composer holds the score; HKL holds tuning,
audio and the Lumatone. Composer works standalone (open, edit, save); entering
held chords and playback need HKL. Composer depends on `@hkl/bridge`,
`@hkl/notation` and `@hkl/shared` only — never on HKL's audio, MIDI, state or
Lumatone code (`pnpm check:boundaries`).

One edit, end to end:

1. **Input** (`input.ts`) turns a key into a model command, wrapped in an undo
   entry.
2. **Model** (`model/`) mutates the live MEI `Document`, normalizes it
   (placeholders, ties) and records the measures it dirtied.
3. **Serialize for render** clones the document and applies render-only
   transforms — accidental display, HEJI, beaming, clef relocation, part
   filtering, engraving conventions. The saved document never sees them.
4. **Engrave**. Scroll view splices the changed measures into one persistent
   system. Page view re-engraves the changed lines, re-places the touched
   pages and re-paginates from one page before them. Nothing else is
   re-engraved.
5. **Post-process**: the DOM passes (HEJI glyphs, text and mark layout,
   instrument gaps, slur and tie re-draws), then placement.
6. **Overlays**: cursor, selection and padlocks redraw.

Playback is a separate path: `buildPlayback` turns the model into timed events
and sends them to HKL.

### Module map

Paths are under `apps/composer/src/` unless noted.

| Area | Modules |
|---|---|
| Wiring | `main.ts` (startup, the `window.__hkl_composer` handle, render orchestration, injected page text, transport), `input.ts` (key dispatch, `InputState`), `click.ts`, `keybindings.ts` (help catalog) |
| Model | `model/index.ts` (`ComposerModel`), `cursor-location.ts`, `voice-index.ts`, `insertion-plan.ts`, `placeholders.ts`, `ties.ts`, `tuplet-ops.ts`, `measure-ops.ts`, `clef-slot.ts`, `empty-flags.ts`, `multirest.ts`, `note-elements.ts`, `restfill.ts`, `ticks.ts` |
| Control events | `expressions.ts` (dynamics, hairpins, text, tempo, tstamp math, `<hkl:config>`), `pedal.ts`, `slurs.ts`, `articulations.ts` |
| Render-clone rules | `notation/`: `accidentals.ts`, `beams.ts`, `measurerests.ts`, `restlayout.ts`, `parts.ts`, `sectionRestart.ts`, `slurSides.ts`, `slurStems.ts`, `unstack.ts`, `staffpos.ts`; edit helpers `retune.ts`, `scTranspose.ts` |
| Renderer | `render/render.ts` (`Renderer`: toolkits, both views, post-processing, mounting) |
| Scroll view | `render/splice.ts` (`ScrollSplicer`), `render/scrollbox.ts` |
| Page view | `render/linebreaks.ts` (`PageLineBreaks`), `balance.ts`, `sigranges.ts`, `pagesplice.ts` (`PageSystemSplicer`), `pagefit.ts` (placement, `ExtentsStore`), `pageassembly.ts` (`PageAssembler`), `systemrender.ts`, `pageshell.ts`, `pageheader.ts`, `hiddenstaves.ts`, `lockmarks.ts` |
| DOM layout passes | `render/textlayout.ts`, `instrgap.ts`, `barlines.ts`, `tupletnums.ts`, `slurlayout.ts`, `tielayout.ts`, `curves.ts` |
| Overlays | `cursor/cursor.ts`, `cursor/expressionCursor.ts`, `cursor/refNote.ts`, `selection/selection.ts`, `selectionOverlay.ts`, `clipboard.ts` |
| Playback | `render/playback.ts`, `render/performance.ts` |
| Files | `save.ts` (`.hkc`, MusicXML export, PDF), `importMusicXml.ts`, `files.ts` |
| Dialogs | `setupDialog.ts`, `instrumentsDialog.ts`, `sigDialog.ts`, `clefDialog.ts`, `tempoDialog.ts`, `tupletDialog.ts`, `pickupDialog.ts`, `helpDialog.ts`, `ui/textEntryModal.ts` |
| Undo | `history.ts` |
| `packages/notation/src` | `mei-build.ts` (the `.hkc` dialect), `heji-render.ts`, `render-presets.ts`, `music-font.ts`, `notation-theme.ts`, `verovio.ts`, `chord-mei.ts`, `scroll-follow.ts`, `accidentals.ts`, `coord-spelling.ts` |

## Bridge

`packages/bridge/src/protocol.ts` is the source of truth for both message
unions (with doc comments). The channel is `'hkl-composer-bridge'`
(`PROTOCOL_VERSION` 1), built on `BridgeChannel` by `createHklBridge()` /
`createComposerBridge()`. HKL also runs `'hkl-analyzer-bridge'` and
`'hkl-orchestrator-bridge'`; all three are created in
`apps/hkl/src/bridge/hkl-side.ts`.

- **HKL → Composer**: `hkl-hello`/`hkl-bye`; `held-keys` (an array of
  `ResolvedNote`); `player-note-struck` (performance mode); `playback-position`
  (`{meiId, timeMs, voice?}` — a null `meiId` with a voice clears that voice's
  bar); `playback-finished`; `tuning-changed`; `hkl-layout-state`;
  `footprint-changed`; `import-score` (a transcription handed to Composer).
- **Composer → HKL**: `composer-hello`/`composer-bye`/`request-state`;
  `play-score` (`{events, pedalEvents?}`) / `stop-playback`;
  `start-performance`/`stop-performance`; `set-reference-note` /
  `set-score-ref`; `layout-req-changed` / `apply-layout` (tuning mode +
  note-name mapping);
  `composer-active-instrument` / `composer-instruments`; `composer-score` /
  `composer-cursor` / `composer-playback` / `composer-zoom` (HKL's read-only
  Composer-view frame).
- **`ResolvedNote`** `{q, r, pname, accid, oct, midi, colorHex, lightColorHex,
  velocity}` is fully resolved by HKL from `(q, r)` and the tuning, so
  Composer never needs the tuning to render. `accid` is count-form (`''`,
  `'s'`, `'ss'`, `'f'`, …, `'n'`), unclamped. `colorHex` is the ink variant
  (light theme), `lightColorHex` the light-source variant (dark theme).
- **Coordinate frames**: every coordinate-bearing message also carries the
  `mapping` its `(q, r)` are in (HKL's live mapping, or the score's). Composer
  keeps HKL's held keys and footprint raw and converts them into the score's
  frame on use (`heldKeysInScoreFrame`, `footprintInScoreFrame` in `main.ts`);
  HKL converts `play-score` notes and both refs into its own frame on receipt
  (`fromComposer`, `hkl-side.ts`). An absent `mapping` (older peer) is Euler.
- **Handshake**: Composer answers `hkl-hello` with `composer-hello` only on a
  fresh connection (answering every hello loops). The `#connStatus` badge
  reads `no HKL`, `HKL connected`, or `standalone` after 1 s without a hello.
- **HKL's broadcasts are event-driven**, from the effects fan-outs, and
  signature-diffed; `held-keys` is suppressed while HKL is playing Composer's
  score, or Composer would record its own playback.
- **Reference notes**: `set-reference-note` carries the note before the
  cursor (sent only when there is one). `set-score-ref` carries the
  key-signature tonic at the cursor's measure — or the sounding measure while
  a transport runs — on the Pythagorean spine nearest C4
  (`computeSongKeyRefAt`, `cursor/refNote.ts`). It is derived, never stored,
  and diff-gated. In HKL a Composer-sourced selection wins only in the `piano`
  outline mode; with "Sync to Composer" on, a score ref clears the selection.
- **Composer view in HKL**: `composer-score` carries the cursor instrument's
  MEI; `composer-cursor` carries a render-agnostic `VoiceCursorAnchor` that
  both sides draw with the shared `computeVoiceCursorRect`
  (`@hkl/shared/cursor-geom`), so HKL's cursor matches Composer's exactly;
  `composer-playback` does the same for playback bars.

**HKL-side playback** (`hkl-side.ts`): a lookahead scheduler plays `play-score`
through the engine. `playbackOwnedKeys` means only keys playback lit are
unlit; `playbackVoiceCount` refcounts each coordinate, and every light is
unlit exactly once, even when a later event re-articulated the voice's audio.
Finish and abort sweep whatever is still held (`sweepOrphanedVoices`, which
warns — reaching it means a scheduling bug).

## Document model

`ComposerModel` (`model/index.ts`) holds a live MEI `Document` (DOMParser XML)
and mutates it directly. A new document (`mei-build.ts`) is one measure, a
braced grand staff (staff 1 treble, 2 bass), two layers per staff, a `<tempo>`
in measure 1, and `<meiHead><extMeta><hkl:config>` (namespace
`https://hexkeylab.com/ns/mei`) holding the tuning requirement, the dynamic →
velocity map and the document flags (`heji`, `ignore-color`, `page-scale`).
`.hkc` is this MEI, saved as is.

**Identity.** Every `<note>` carries `data-q`/`data-r` (its lattice cell — the
pitch's source of truth); every note, staff and measure has an `xml:id`, set
with `setAttributeNS(XML_NS, …)` so `[*|id]` selectors resolve. MEI ignores
unknown attributes, so `.hkc` opens in other viewers.

**Instruments and voices.** `Voice` is a flat index over all instruments.
`instrumentTable()` (cached) walks the head `<staffGrp>`: a root group with
direct `<staffDef>`s is one implicit "Piano"; otherwise each nested group is
an instrument of one or two staves whose `<label>` is its name and sole
identity (HKL resolves the name against its instrument dropdown, falling back
to Piano). Each staff has two voices (layers 1, 2); staff `@n` is global.
Everything routes through `staffForVoice`, `layerForVoice`, `instrumentOf`,
`voicesForInstrument`, `totalVoices`, `totalStaves`. `addInstrument` promotes
the implicit shape to nested groups and `removeInstrument` demotes back; the
staged Instruments dialog applies its edits on Setup Save
(`reconcileInstruments`). Single-instrument documents are byte-identical to
before multi-instrument support.

**Loading** (`replaceDocument`) normalizes: braces and `bar.thru` only on
groups of two or more staves (`normalizeStaffGroupConventions`), mark places
(`normalizeMarkPlaces`), expression defaults, placeholders (which strips any
stored `<mRest>`), ties.

### Cursor and stops

Each voice has a cursor into its **flat stream**, `flatChildren(voice)`
(cached, invalidated by DOM mutation): every stop across all measures. Cursor
`c` means "past `flat[c]`" — the insert bar draws at `flat[c]`'s right edge.
Stops are the layer's `chord`/`note`/`rest`/`fTrem`/`bTrem`, a tuplet's wrapper
plus its inner stops, and the measure **wrapper** (the `<measure>` element):

| Measure k, for this voice | Stops |
|---|---|
| empty | `[wrapper]` |
| has content; k = 0, or measure k−1 empty or partial | `[wrapper, …content]` |
| has content; measure k−1 full | `[…content]` |
| past the end | one synthetic stop, only when the last measure is not full |

Placeholders (`<space data-placeholder>`), inline `<clef>`s and rests drawn by
the renderer are never stops. A partial measure's fill point is "past its last
content"; extending a measure vs entering the next is the user's choice
between two visibly different stops. `locateCursor` / `locateFlatElement`
(`model/cursor-location.ts`) resolve a cursor to `{measureIdx, layer,
withinIdx, inTuplet}`; past the end, the first returns a location in a
measure about to be appended.

Navigation reads a per-voice index (`model/voice-index.ts`: stops, ticks,
measure boundaries), rebuilt lazily after a structural change. Under
`HKL_INDEX_CHECK` every index is checked against the uncached computation.

**Backspace** deletes the element before the cursor and never auto-removes a
measure it empties: at an empty measure's wrapper it deletes the measure
(never the last one; never one holding a clef; a multimeasure-rest run only
whole and only if every member is empty on every staff); at a placeholder or
other wrapper it moves left; at an empty tuplet it deletes the tuplet.

### Mutation pipeline

- **Placeholders** (`normalizePlaceholders`): each layer's trailing `<space>`
  sums to the measure's budget minus its content. Idempotent (no id churn);
  also drops the empty-cell flags from a cell that gained content.
- **Insertion** (`planInsert`, `model/insertion-plan.ts`): a note longer than
  what remains splits at the barline into tied pieces (`decomposeTicks`); the
  cursor measure's later items and the next measure's items are repacked whole
  (ids and ties kept). Overflow reaches only the next measure: "Doesn't fit in
  next measure.", "Tuplet too large for measure.", "Doesn't fit.".
  `canInsertHere` runs the same planner dry so the status line matches.
- **Ties** (`model/ties.ts`): a note's **intent** (`@tie` `i`/`m`, or
  `data-pending-tie`) is persisted; its **realization** — `@tie` `i`/`m`/`t`
  (never compound), a forward `data-tie-partner`, and an `<lv>` stub when no
  same-pitch successor exists — is rebuilt by `normalizeTies` after every
  structural mutation. The walk follows a time-ordered event sequence that
  descends into tuplets; a measure with no content in the voice breaks a
  chain. A stub ends half a beat after its note, in that measure's meter.
  `=` flips intent (one chord member under a chord-internal selection).
  Deletion just removes and re-normalizes.
- **Dirty range** (`renderDirty`): `'all'` by default — every structural
  mutation resets it — and narrowed only by converted mutations, so a missed
  mark can only over-render. Ties are re-realized in the dirty range ±1
  measure, checked against a full pass under `HKL_INDEX_CHECK`.
- **Autofill** is off. Setup's *Fill incomplete measures* pads every partial
  non-empty layer with beat-aligned rests.

### Tuplets

`<tuplet num numbase data-tuplet-atomic-dur>`, a direct child of `<layer>`,
never nested, never across a barline. Its unfilled slots are
`<rest data-tuplet-placeholder="true">` hidden by CSS (Verovio only brackets
tuplets with visible content; `<space>` and `@visible` don't work), regrown
as atomic-sized rests after every change so fill and delete are reversible.
`@bracket.visible` is left unset, so Verovio brackets only tuplets not wholly
under one beam.

- **Creation**: `Ctrl+2..7` then a duration digit uses a fixed ratio table;
  `Ctrl+Shift+3` opens a modal for any count over any span (in eighths) with
  every valid written value listed and the numbase nearest the count
  pre-selected. Both call `createTupletAtCursor`.
- **Placement** (`resolveTupletTarget`): a tuplet lands whole in one measure.
  The stop at the end of a FULL measure is read as the head of the next (it
  has no capacity otherwise); a partial measure never spills. The fit test
  counts content after the cursor. A tuplet that an insert *displaces* may
  move whole into the next measure — displacement is not creation, and the two
  paths stay separate.
- **Stops**: the wrapper ("before the tuplet") and one stop per filled child
  plus the first placeholder ("inside"). Inserting inside consumes
  placeholders; overflow is refused.

### Signatures, clefs, pickups

- **Per-measure meter and key** live in in-section `<scoreDef>` overrides.
  `meterTable()` backs `measureTicksAt`, `measureStartTick`, `meterAt`,
  `keySigAt`. Anything computing a tstamp or a beat from ticks must use the
  meter in effect at that measure, never the head `<scoreDef>`.
- **Signature modal** (`Ctrl+Shift+S`, also Setup's Time/Key button at
  measure 0): diff-aware `setMeterAt`/`setKeySigAt` (an unchanged submit
  writes nothing; a mode-only change writes `@mode` alone). It sets `meter.sym`
  (common/cut) and `hkl:beat-groups` (an additive grouping for beaming only).
  In select mode it applies to the selected span with a bounded restore after
  it. Shrinking a meter truncates overflowing content per measure (shorten the
  first overflowing element, drop the rest, drop an overflowing tuplet whole);
  there is no reflow.
- **Clefs** are inline `<clef>` layer children (zero ticks, never a stop,
  break beams), written only through the clef dialog (`Ctrl+Shift+C`) — no
  delete path removes one. `clefSlotAt` (`model/clef-slot.ts`) resolves every
  read and write: the barline after a full measure is ONE slot reachable from
  two cursors, and a new clef there is written at the head of the next
  measure. Choosing the inherited clef removes the change.
- **Pickup** (`Ctrl+Shift+A`, length in eighths): a dedicated measure 0 with
  `hkl:pickup-ticks` and `@metcon="false"`, numbered 0. Every budget-aware
  path honours it, including the clock for control events. An instant
  downbeat tempo moves onto the pickup.

### Empty cells

`Ctrl+H` (hide empty staff) and `Ctrl+M` (multimeasure rest) set
`data-hkl-hide-empty` / `data-hkl-multirest` on a measure's `<staff>`
(`model/empty-flags.ts`). Only an empty cell — no content and no clef in any
layer — carries one; content entering it drops both. One command, two flags:
each target cell takes the state the fewest already hold. Both are
render-only: playback, the flat cursor and the saved structure ignore them.
Rendering: see Hidden staves and Multimeasure rests below.

### Undo

`history.ts`: full-state snapshots (the MEI plus cursors and the active
voice) before and after each user action, the AFTER snapshot taken lazily; a
cut followed by a paste merges into one entry. No entry carries layout: the
page-view partition is F of the document, so undo and redo restore it exactly,
line-break commands included.

## Input

`input.ts` dispatches keys (Speedy-Entry flow, Finale-style bindings); the
canonical list is `keybindings.ts`, rendered by the help modal. Highlights:

- **Entry**: digits `1`–`7` are durations (5 = quarter); held HKL keys make a
  chord, none a rest; any accidental magnitude is accepted. `.` cycles dots
  (overflow ties across the bar), `=` ties, `Insert` toggles insert/overwrite.
- **↑/↓** step a stop list built from the instrument table: tempo, then per
  instrument its voices, its expression layer and (two-staff instruments) its
  pedal layer — one piano: `tempo → 1 → 2 → expr → 3 → 4 → pedal`. It is
  limited to the viewed instrument in single-part view and skips empty layer
  stops and hidden staves. A voice switch lands on the note sounding at the
  current note's onset (`setVoicePreservingMeasure`); entering a layer lands
  on the nearest mark.
- **Transport**: `Space` stops whichever transport runs, else starts
  playback; `Shift+Space` starts performance mode when neither runs. The Play
  and Perform buttons switch transports. During a transport, plain ←/→ stop
  at the playhead and `Ctrl+←/→` seek by measure.
- **Files**: `Ctrl+S`, `Ctrl+O`.
- **Status line** (`#composerStatus`): four kinds by intent — `error`,
  `state` (persistent context: held notes, pending prompts, selection span),
  `action` (only with an undoable edit), `info`. Every keydown clears all but
  `state`. Voice switches post nothing; the toolbar's `#voiceIndicator` shows
  the voice or layer.
- **Pending states**: a hairpin, a slur (`Ctrl+L`) and a `Ctrl+N` tuplet wait
  for their second key; any other key cancels and falls through.

**Click** (`click.ts`): one listener on `#score` resolves every click to the
nearest of three target kinds by box distance — a note/chord/rest (cursor on
it, or before it if left of its left edge), an empty staff region (that
measure's start), or a control event (selects it in its layer). Clicks are
ignored during a transport.

### Selection and clipboard

Selection is a cursor mode (`'select'`, `selection/selection.ts`):

- **Beat mode** (`Shift+←/→`): one voice, contiguous beats, at least one;
  `{voice, origin, first, last, lastMoved}` with `first ≤ origin ≤ last`,
  growing from one side at a time. Entry on a beat boundary is
  direction-aware. `Ctrl+Shift+←/→` jumps to the barline.
- **Measure mode** (`Shift+↑/↓`, or promoting a beat selection, one way):
  contiguous measures over a range of staves.
- **Delete / cut**: a measure the span covers entirely becomes an empty cell;
  a partial span is refilled with rests. Clefs are never removed.
- **`Alt+V`** moves wholly selected measures to the staff's other voice,
  all or nothing, and the selection follows the music (so it is its own
  inverse).
- **Clipboard**: an `<hkl:clipboard>` MEI fragment (beat kind: content and
  duration; measure kind: measures, their meters, and their dynamics and
  hairpins), written and read only through DOM `copy`/`cut`/`paste` events —
  `navigator.clipboard` is unreliable in Firefox. Paste snaps to a beat (or
  replaces whole measures — each copied bar only onto a bar of the same
  meter), clears the destination and reselects what was pasted.
- **Overlay** (`selectionOverlay.ts`): one rect per system the selection
  touches; beats over empty space fall back to staff-height rects at the
  cursor's edge.

## Rendering

`Renderer` (`render/render.ts`, singleton `renderer`) loads Verovio WASM from
the CDN by script injection and keeps two toolkits: `tk` for full renders and
`spliceTk` for every window (splices, line windows, naturals, the reference
gate). Options are `buildOptions(strategy, geomMode)`: base options +
geometry + breaks + the zoom preset (`CRISP_PRESETS`: scale 50/75/100, `unit`
8 at every zoom) + line widths. Every per-mode option is set explicitly on
every render, because `setOptions` persists what it is not told.

- **Page geometry**: US Letter (`pageWidth` 2159, `pageHeight` 2794, 1/100 mm),
  scaled by the document's **page scale** (60–160 %, Setup "Page size") — the
  paper grows relative to the notation, so bars per system change while the
  notation keeps its on-screen size. Zoom sizes the notation; page scale sizes
  the paper.
- **Scroll geometry**: Verovio's maxima (100 000 × 60 000), `breaks:'none'`,
  one system; about 500 bars fit at 100 % before it would wrap.
- `condense` is `'none'` (Composer hides staves itself); `defaultBottomMargin`
  2.0 widens a staff gap only where content collides with the next staff;
  `dynamDist` 4.5.

`renderComposer(model, viewStaves)` is the entry point for both views; a full
engrave happens only on a forced cause (`forceFullRerender`: new document,
view staves, zoom, page scale). A render predicted heavier than 250 ms
(`predictNextRenderHeavy` — in page view, whether a local refill is possible)
defers one frame so the `#renderBusy` badge paints first, and requests
arriving meanwhile coalesce into one render of the latest state. Post-render
readers use `afterRender()`.

### Serialize for render

`model.serialize(forRender)` and `serializeRangeForRender` (the windows) build
the clone Verovio sees: `computeAccidentalDisplay` → `transformDocForHeji` →
ignore-color strip → `duplicateTempiAcrossParts` → `filterToStaves`
(single-part view) → `relocateInitialClefs` → `regroupBeams` →
`applyRenderConventions`. Every render path goes through it, so a full render
and a splice agree by construction. `filterToStaves` keeps the original staff
numbers (the cursor resolves staves by them) and drops a brace from a group
reduced to one staff.

`applyRenderConventions` (one module each, in this order):

| Pass | Rule |
|---|---|
| `unifySlurStems` (`slurStems.ts`) | In a single-voice staff, one stem direction under a slur: longest slur first, majority of the covered units' natural directions (predicted from pitch with Verovio's rule); fixed votes — an explicit `@stem.dir`, a longer slur's choice, a direction forced by a second voice — decide. Skipped when the minority would need stems more than `CAP_STEPS` (5) off the middle line. Runs first: the rest pass reads its `@stem.dir`. |
| `fillEmptyMeasureRests` (`measurerests.ts`) | Every content-free staff cell gets a rest in its lowest layer: `<mRest>` for a full bar in any meter, pickup-sized rests in a pickup (marked `data-hkl-cosmetic`, which click skips). The only source of a whole-bar rest; the cursor never stops on one. |
| `settleRestLocations` (`restlayout.ts`) | Two-layer staves: a rest meeting nothing visible in the other layer, or an identical rest, is pinned to its single-layer `@loc` (twins draw as one); a rest against notes stays on the staff above (voice 1) or below (voice 2) the other layer's predicted ink, half a space clear, else Verovio decides. Pinning `@loc` keeps every rest's element and id. |
| `applySectionRestarts` (`sectionRestart.ts`) | A section (movement) break draws no courtesy key, meter or clef and restates no instrument names; the new section starts in its own signatures. Built from a `<section restart>` wrapper plus plain nested sections for abbreviated labels and the section's clef (Verovio mechanics: lessons.md). |
| `settleSlurSides` (`slurSides.ts`) | A two-voice slur is flipped to its notehead side only when provably clear: every other-layer head in its span lies more than a fourth (`BLOCK_STEPS` 3) beyond the slur's farthest own head. Otherwise Verovio's side stays — it never collides; forced sides do. |
| `settleFermataSides` (`parts.ts`) | On a grand staff the top staff's fermata goes above, the bottom staff's below. |
| `separateSameMomentMarks` (`unstack.ts`) | A `<dir>` sharing tstamp, staff and place with a `<dynam>` moves `NUDGE_BEATS` (0.25) past it, so Verovio engraves one row instead of a stack and reserves space for one. |
| `collapseMultiRests` (`model/multirest.ts`) | Multimeasure-rest runs, one-staff views only. |

`duplicateTempiAcrossParts` (`parts.ts`) copies each `<tempo>` onto every
instrument's top staff (ids `<src>-p<staffN>`); it runs before
`filterToStaves` so a part view keeps its tempo marks. The model keeps one
`<tempo>`.

`svgAdditionalAttribute` surfaces the MEI attributes the DOM passes read —
note colour and coordinates, `staff@n`, `layer@n`, control events' `@staff`,
`@place`, `@tstamp`, `@startid`/`@endid`, `slur@curvedir`, the `hkl-*`
markers — as `data-*` attributes. Verovio prefixes `data-`, so
`data-tuplet-placeholder` arrives as `data-data-tuplet-placeholder`.

### Accidentals and HEJI

`computeAccidentalDisplay` (`notation/accidentals.ts`) decides which
accidentals show, per measure and staff with all layers merged in time order.
The alteration comes from `(q, r)`, not `@accid` (which is a ±3 display cache
only — there is no clamp anywhere in capability). Carry state is keyed by
`pname:oct` on the full HEJI identity `{alter, syn5, sept7}`, so with HEJI on,
F♯ and F♯↑ are different accidentals. Rules, in order: a parenthesized
cautionary (`P`) always shows; a tie destination hides but updates the carry;
two different identities at one position and tick (a chromatic cluster) both
show; a repeated identity hides — except on a unison partner drawn by another
layer at the same tick, after a clash, and after a tie into the bar whose
identity differs from the key. A clef change does not reset the carry.

HEJI glyphs are render-only (`packages/notation/src/heji-render.ts`). Verovio
cannot draw them and collapses repeated identical `<accid>`s, so
`transformDocForHeji` gives each note needing a comma or more than ±3 distinct
placeholder `<accid>` tokens tagged with the glyph to draw, and
`injectHejiGlyphs` redraws every accidental (key signatures and parentheses
included) as BravuraText text at the SMuFL codepoint, with a deliberate
downward house offset (`ACCID_BASELINE_CORRECTION_SPACES`). The score is
Leipzig; accidentals are Bravura; the C-clef family comes from Bravura through
the custom font `LeipzigHkl` (`music-font.ts`). HEJI is a document flag, on by
default.

### Beaming

`regroupBeams` (`notation/beams.ts`) beams on the clone; the live document has
no `<beam>`. Groups, per measure's meter: an `hkl:beat-groups` pattern if
present; in 4/4, each half bar is one group only when it is exactly four
eighths, else quarters; compound meters group in threes; otherwise one beat
unit per group. Rests and quarters or longer break a run, as does an inline
clef; `/` (`@hkl-beam-break`) inverts the natural break at a note. Tuplets are
beamed as their own group.

### Clefs before the barline

The engraving convention puts a measure-initial clef change before the
barline. `relocateInitialClefs` moves each measure-initial `<clef>` to the end
of the previous measure's same staff and layer on the clone, so a rendered
barline is never followed by a clef. Section starts keep their clef (the
restart pass draws it). Because of this relocation a measure's render depends
on the next measure's first clef, so both splicers widen a changed run one
measure left when its first measure holds one. Saved documents carry the
relocated spelling; `clefSlotAt` reads both. A clef written at a barline
(the clef dialog, `applyClefAt`) is STORED in that relocated spelling from the
start — at the end of the previous measure, where it is drawn and saved — and
an existing barline clef edited there moves to it, so what is shown, stored and
saved never differ (2026-10-20). A movement start keeps its head clef. Content
entered past a layer's last note lands before a trailing clef run
(`insertAt`), so filling a bar never pushes its closing barline clef to the
bar's start. The relocation pass remains for head clefs other paths still
produce (the MusicXML importer's boundary clefs, a delete that leaves a
mid-measure clef at a measure's start).

### Post-processing

`postProcessRendered` runs on every rendered system before placement measures
it: after a full render, on every window, and again on a zoom (which rescales
mounted pages through the same passes). Order:

1. `pinExactScale`; scroll view's title-block cleanup; barline snaps;
   noteheads moved last so the coloured head draws over its stem.
2. `injectHejiGlyphs` — first, because every later pass must measure the
   glyph that will be drawn.
3. `repairBarLines` — redraws the stretch of a grand-staff barline Verovio
   erased under a text mark.
4. `resetInstrumentGaps` → `layoutBelowStaffText` → `layoutInstrumentGaps`
   (multi-instrument), with a second `layoutBelowStaffText` round on the
   systems it shifted.
5. `layoutTupletNums` — moves a bracketless numeral clear of a steep beam.
6. `restoreTieRedraws` → `layoutFlippedSlurs` → `liftSlursOffShiftedNumerals`
   → `layoutCollidingTies`.
7. `applyNotationTheme`.

**Every pass is a fixed point under re-run**: it undoes its previous run before
measuring (`data-hkl-orig-d` restores, cleared shift tags,
`resetInstrumentGaps`), and it measures in the SVG's own user space through
the CTM, never screen rectangles. Boxes come from `textlayout.ts`: `svgBox`,
`strokedBox` (stems, whose bbox is zero-wide) and `inkBox` (text by
per-character ink — a BravuraText accidental's `getBBox` is a whole character
cell).

| Pass | Does |
|---|---|
| `layoutBelowStaffText` (`textlayout.ts`) | Moves a text mark off a barline into its measure; under a one-staff instrument puts a `<dir>` at the dynamics' clearance and a lone hairpin on the dynamics' line (clusters holding a dynamic stay Verovio's); stops a push toward another instrument `INSTR_CLEAR` (one space) short, recording the refusal in `data-hkl-clamped`; keeps a `between` mark off its own staff; lays same-tstamp groups the clone could not separate side by side; lifts above-staff text clear of slur and tie outlines. Reads everything, then writes. |
| `layoutInstrumentGaps` (`instrgap.ts`) | Moves each lower instrument down so a mark sits nearer its own staff than the next instrument's, plus an ink floor and textlayout's refusals, quantized to the device grid and recorded as `data-hkl-ishift` for `alignStaffRows` to apply. Every glyph is attributed to a staff explicitly; a system with anything unattributable is left alone with a warning. Marks are only tagged; their transform stays textlayout's. |
| `layoutFlippedSlurs` (`slurlayout.ts`) | Re-draws a flipped slur whose endpoint Verovio displaced, and each segment of a slur broken at a system break, as a curve clear of every glyph in its span; else keeps Verovio's. |
| `liftSlursOffShiftedNumerals` | Raises an unflipped slur that now crosses a moved tuplet numeral. |
| `layoutCollidingTies` (`tielayout.ts`) | Re-arches a tie drawn through another voice: same endpoints and side, the lowest arch that clears, never taller than wide. |

### Scroll view

One persistent SVG holds the score as a single system; scrolling is native.
The full render fixes the vertical layout; an edit re-engraves only the
changed measure run (`ScrollSplicer`, `render/splice.ts`) and splices it in:

- The run is found by diffing per-measure signatures and is widened over
  spanners — those the document draws now as well as those the edit added or
  removed (`expandForRenderedSpanners`) — and over a relocated clef.
- The sub-render places the run on the left context measure; following
  measures shift in X. A **synthetic spacer** measure (one discarded measure
  whose stem length, calibrated per full render, forces each inter-staff gap)
  makes the sub-render's staff spacing match the system's.
- The splicer owns the SVG box (`scrollbox.ts`: width re-fitted from the last
  measure per splice) and the system's vertical frame (from staff-line
  geometry; adopted only when it grows).
- System-initial furniture belongs to whichever measure is first, so a run
  starting at measure 0 re-engraves the incoming first measure.
- Refused (warn, then full re-engrave): a part view, active multimeasure
  rests, and an edit that changes inter-staff spacing.

### Page view

Composer owns the line partition, the pagination and every vertical position;
Verovio is asked only to lay out **line windows** horizontally. Nothing about
layout is stored in the model except the user's own breaks, so a document
reproduces its own layout.

**Line windows** (`render/systemrender.ts`): up to `CHUNK_LINES` (6) lines per
Verovio call, never across a change in hidden staves, each window = a leader
stub + the lines (closed over spanners and endings) + a courtesy stub when the
next line begins with a signature change + a trailer, with the line's hidden
staves removed and `<sb>` pins (`hklpin-N`, render-time MEI only) at every
line start. The window's systems are imported into Composer-drawn **page
shells** (`render/pageshell.ts`), which also draw the page header.

**The partition** (`PageLineBreaks`, `render/linebreaks.ts`, with
`balance.ts`):

- A line's fill = its leading block plus the sum of its measures' natural
  widths (measured in unjustified `breaks:'none'` windows, read from the SVG
  path text), over the budget `(pageWidth − margins) × 10`. The leading block
  is the clef + key a line starting at that measure draws (measured once per
  signature context, `sigWForLine`, from the staff line's start to the last
  signature glyph — never from the measure's bbox, which holds the
  system-start bar number centred on the staff start); the document's first
  line pays the
  instrument-name indent instead, since its clef and key sit inside measure
  0's natural width.
- **The partition is one pure function of the document, F**
  (`balance.ts` `partitionSection`). Per section — the measures
  between hard starts — over atoms (render units: a multirest run is one):
  greedy lines at fill ≤ 1.00 give the line count N (no line is ever
  compressed; a measure wider than a line sits alone); the reach-back curve
  re-divides the last k greedy lines most evenly (min Σ(1−f)², one DP for
  every k = 1..N); each distinct layout is scored on the lines it changes
  plus the untouched line before them, and the pick is max(min − spread −
  0.03 × boundaries moved). No `MIN_FILL`, no legality envelope. A FINAL
  section of fewer than 3 greedy lines stays greedy.
- The load runs F over every section before the first paint; an edit carries
  the partition by line membership (which says only which sections it
  touched; pages are never carried — every refill re-fits them, below), then
  runs the same F over every touched section in full. A load and an edit therefore compute the same layout, a
  reload never changes the screen, and undo restores the layout exactly. F
  reaches as far as its pick says — including onto earlier pages — and an
  inserted or deleted bar re-flows the rest of its section (inherent to a
  partition that is a function of the content). The suite checks it on every
  fixture ("partition is F": the committed starts equal
  `PageLineBreaks.partitionOfDocument`).
- **Requirements** (Max, 2026-10-19/20). **G1** one function: the partition
  is a pure function of the document — a load and an edit compute the same
  layout, a reload never changes the screen. **G2** quality is judged against
  the section's full balance (the curve's far end) on line appearance — the
  lowest fill and the spread — never on agreement of boundaries (near ties are
  real: whole movements rearrange for a spread change of 0.004). **G3** no cap
  on reach (Max: "There cannot be a hard cap on how far a repair can reach");
  edit cost is measured, not argued. **G4** exact undo, which follows from G1.
  No line is packed past its natural width (compressed lines collide); there
  is no MIN_FILL — a stub before another section or a lock is a bug, and only
  a FINAL section of fewer than 3 lines stays greedy (the small-document
  convenience MIN_FILL was for).
- **Accepted consequences** (Max, 2026-10-20). A section just over one line
  long becomes two lines around fill 0.5–0.6, never one compressed line. A
  long uniform section can keep a sparse-ish last line when the next
  improvement needs many moves at once (a 203-bar corpus section: 1 change →
  0.57, 9 → 0.85, nothing between) — locks are the remedy. Lines outside the
  picked window keep greedy's breaks (the sonata's movement II keeps a 0.681
  line, bars 52–53, which only the full balance would lift; reviewed by Max).
  An inserted or deleted bar re-flows the rest of its section in every scheme
  measured (p90 25–33 lines in the sonata simulation), so it is inherent; a
  ±5 % width edit moved nothing at p90 there.
- **Where it lives.** `balance.ts`: `partitionSection` (greedy, curve, pick,
  final-section rule), `sectionAtoms` (render units → atoms, each line paying
  its own leading block), `greedyStarts`, `curveTable`, `reachBackCurve`,
  `distinctLayouts`, `pickLayout`; `PARTITION_CAP` 1.00, `PARTITION_GAMMA`
  0.03, `FINAL_GREEDY_BELOW` 3. `linebreaks.ts`: `balanceInitialBand` (load,
  after `seedPartition` + `warmAllNaturals`), `repartition` →
  `balanceSectionLines` (edit), `partitionOfDocument` / `partitionCurrent`
  (read-only F of the document, and whether the committed partition is for the
  current version), `finalSystemJustified` (`FINAL_JUSTIFY_FILL` 0.70).
  Tests: `test/balance/run.mjs` holds F to its independent simulation twin
  (`test/balance/partition-f.mjs` + `curve-batch.mjs`) on the sonata's dumped
  inputs (`sonata-inputs.json`) and 600 random sections; the suite's universal
  "partition is F" (`assertPartitionIsF`) and the `partF_*` fixtures
  (page-layout); the corpus pipeline in `test/corpus/README.md`; the design
  record in decisions.md (2026-10-19 – 10-21, "Partition: …").
- Hard starts — locks, page breaks, section headers — split their section;
  removing one joins two sections, which F partitions whole. A page break or
  section header also re-fits pages from its page. A signature change
  re-engraves the range it governs (`render/sigranges.ts`: to the next change
  of the same kind on the same staff).
- Justification of the document's last system is the owner's call
  (`finalSystemJustified` → Verovio `minLastJustification` 0 or 1): always
  when the final section ran through F's pick, at fill ≥ 0.70 when it stayed
  greedy. A section-final line elsewhere is never Verovio's last system and
  always justifies.

**Manual line breaks** (`Alt+Shift+↓`, `linebreakCommands.ts`): a lock is a
plain `<sb>` in the document before the cursor's measure — saved in `.hkc`,
exported as `<print new-system="yes"/>`, and handled by the refill like any
hard start: it splits its section, and each side is partitioned by F (a
remainder just over a line becomes two lines, never one compressed one). The
document can say where a break must be, never where one must not — locks are
also how a user forces a layout F would not pick. A padlock
(`render/lockmarks.ts`) marks each locked break; a click unlocks, and the
joined section is re-partitioned (the layout a reload of the unlocked
document shows).

**One landing for every refill** (2026-10-21). The splicer
(`PageSystemSplicer`, `render/pagesplice.ts`) only ENGRAVES: it closes the
changed run over spanners (drawn and edited), endings and clef relocation,
clips the hunk to the band of mounted pages around the edit, and engraves
those lines in one window (no full-document `loadData`). It places nothing.
`PageAssembler.applyPartition` then lands every refill the same way: it takes
the splicer's systems (or engraves the changed lines on mounted pages one
window each when the splicer refused), re-runs first-fit from one page before
the first affected line, and compares the fit with what each page actually
holds — the systems in its DOM, mounted or parked; only a page with no DOM is
compared by its old pins. A page whose start and end the fit keeps is
refreshed in place (systems swapped, inserted or removed); a page whose
membership changes is rebuilt by moving systems between shells, or becomes a
deferred card when it is not mounted. The refill never carries page starts:
the pins stay provisional (old page starts that are still line starts) until
the fit commits. `verifyRenderedPartition` checks after every refill that each
mounted page holds exactly its pinned lines and logs an error otherwise (it
throws under `HKL_INDEX_CHECK`).

**Only mounted pages are engraved** (2026-10-20). Pagination (first-fit,
below) runs over every line, but a line on an unmounted page whose
membership F changed has no measured height yet: it counts with the height
of the line that held its first measure in the layout the pages were last
fitted for (`PageAssembler.heightOf`, assumed heights kept apart from
measured ones), so the unmounted region keeps its page count and scroll
height. Any page the re-fit rebuilds that is not mounted becomes a deferred
card, engraved from its committed lines when it mounts, after which the fit
re-runs from it (a page boundary may shift by a system then). A line the fit
lands on a mounted page with only an assumed height is engraved before the
page is shown, and the fit re-run from its page.

**Cross-measure render dependencies** — check this list when scoping any edit
(both splicers implement it):

- End-of-line courtesy signatures are drawn on line k but generated by line
  k+1's first measure (the window carries that measure as a stub).
- A measure-initial clef in measure i is drawn at the end of measure i−1
  (`relocateInitialClefs`).
- A clef, key or meter change governs every measure to the next change of
  the same kind on the same staff.
- A spanner with one end in the replaced set pulls its other end into the
  window (one pass, no fixed point); a tie pulls one neighbour; an ending is
  taken whole.

**Vertical placement** (`render/pagefit.ts`), in units of 80 SVG user units
(10 × Verovio's `unit`, constant across zoom presets):

- **Rule v1 (minimum)**: first content top = header bottom + 2 units (5.25
  without a header); between systems `max(below, 6) + G + max(above, 6)`, with
  G = 4, or 8 when the rendered score has one staff (a one-staff document or
  the part view of a one-staff instrument — keyed on the staff set, not per
  system, so hide-empty systems keep the score's spacing). A section header
  reserves a 15-unit band (`SECTION_HEADER_RESERVE`) above its system; its
  8-unit title's baseline sits 11 units in, putting the cap top ~5.7 units
  below the band top and the baseline 4 above the system's content, so the
  numeral reads with the system below it and clears a page header.
  Verovio's stacking is never read.
- **Rule v2 (distribution)**: the gaps between systems and below the last
  equalize at a level L solving `Σ max(gap_k, L) + L = C`, capped at 14 units
  so a sparse page looks sparse. The header gap opens only when the level is
  capped and the bottom gap still exceeds the cap (at most 10 units, never on
  page 1). The footer sits in the bottom margin, so it never affects
  pagination.
- Pagination is judged on v1; only then is the page distributed. Placement is
  non-local within a page, so any change to a page's systems re-places the
  whole page.
- **Staff grid**: `alignStaffRows` spaces a system's staff rows whole device
  pixels apart and `placeSystems` puts each system's first row on the grid,
  applied once as the emitted translate — positions accumulate unsnapped.
  Both run before `measureExtents`, so extents describe what is drawn.

**Pagination** (`PageAssembler`, `render/pageassembly.ts`): first-fit over
the measured extents in the `ExtentsStore` — a page's membership depends only
on the lines before it. A load creates a sized card for every expected page,
builds pages synchronously until the cursor's page closes, then in 60 ms
`MessageChannel` slices. Closing a page places it (v2), reveals it, runs the
page-mount hook and commits its page start. Every edit re-runs first-fit from
one page before the first affected line, against what the pages hold (above):
a page whose first and last line stay is refreshed in place, a page whose
first or last line changed is rebuilt, later pages are renumbered. Add instrument is the one edit
that re-assembles everything. Gate: the suite's `assertPaginationFirstFit` —
no mounted page overflows, none has room for the next page's first system.

**Page furniture**: page 1's title block, pages 2+'s outer-corner page number
and running title (`render/pageheader.ts` constants), all drawn by the shell
from nominal font metrics (no text is measured; `data-hkl-head-bottom` records
the band's bottom); the footer and section titles (`Ctrl+Shift+H`, drawn into
the band placement reserved) are injected by the page-mount hook
(`main.ts`). Injected text is positioned from the page's real column
(`pageFrameOf`), so it follows the page scale. A Setup apply redraws the
headers and re-fits from page 1 without rendering any system.

**Hidden staves** (page view only, `render/hiddenstaves.ts`): a staff is
omitted from a system when every measure on it carries the hide-empty flag
for it (the top staff stays if all would hide). Line windows are rendered
without their hidden staves; a system imported with all staves is re-rendered
alone without them before placement, so heights and pagination see the
reduced system. Navigation skips hidden cells (`isCellRendered`).

**Multimeasure rests** (`model/multirest.ts`): in a view with exactly one
staff, a run of two or more flagged empty measures renders as one measure
holding `<multiRest num>` — the run's first measure, keeping its ids. Runs
break at every hard boundary and at control events concerning the staff.
`renderUnits(viewStaves)` is the single source of truth: the clone pass takes
its runs, and the cursor, selection, click, range serializer (which snaps to
unit edges), refill and balancer map measures through it.

**Mounting**: every page has a card from the first paint; a closed page
outside the mount window (the viewport ± one viewport, and the cursor's page
± 1) is
**parked** — its SVG detached — and re-attached on mount without rendering.
An `IntersectionObserver` only wakes a pump that mounts one visible page per
frame, nearest the top first, and nothing while the viewport moves fast, so a
scrollbar drag draws its landing page ~120 ms after it stops. The cursor,
scroll-into-view and playback target the active layer's measure.

**Zoom renders nothing**: the inner SVG is identical at every zoom, so
`PageAssembler.rescale` resizes the shells and re-runs post-processing and
placement on built pages (parked pages on mount). Page scale changes the
budget and re-assembles.

**Reference gate** (`HKL_INDEX_CHECK` only): every splice is checked against
an offscreen full render of the same pinned MEI — per-measure x and width,
staff tops against the placement rule, signature glyphs, and a census of glyph
classes per measure and per system (a broken spanner's continuation is drawn
outside every measure). A failure throws.

### View modes, theme, overlays

- **View mode** (`#viewModeSelect`) and **theme** (`#themeSelect`:
  light/dark/transparent) persist in `localStorage`. Switching view restores
  the other mode's stashed DOM when the document, zoom and page scale are
  unchanged; otherwise it engraves fresh, never splicing into the other mode's
  DOM.
- **Theme** repaints in place (`applyThemeToRendered`): dark and transparent
  tag the container and every page wrapper so the shared notation CSS
  recolours ink, and noteheads switch to their light-source colour.
  Non-notehead ink uses `--notation-ink`; only the notehead carries lattice
  colour. Strokes use `shape-rendering: geometricPrecision`.
- **Cursor overlay**: a fresh `svg#cursorOverlay` per render, covering the
  whole score. Editing mode draws the voice cursor (`V<n>`) or the layer
  cursor (`EXPR`/`PED`/`TEMPO`); playback mode draws one bar per voice
  (left edge = sounding now; performance mode uses the right edge = just
  played). The anchor resolution (`resolveVoiceCursorAnchor`) and geometry
  (`computeVoiceCursorRect`) are shared with HKL's Composer view.
- Plain navigation and clicks move the cursor without re-rendering
  (`onCursorMove`).

## Control-event layers

Dynamics, hairpins, expressive text, pedal marks and tempo marks are
measure-level siblings of `<staff>` anchored by `@tstamp`/`@tstamp2`, never
note-attached, so they survive deletion of nearby notes (re-barring does not
carry them). A mark at a barline is expressed as beat 1 of the cursor's visual
measure, because Verovio draws a tstamp at that beat's note; tstamps use the
measure's own meter. Slurs, fermatas, trills and octaves are note-attached
(`@startid`); a breath is time-anchored at the end of its note.

- **Layers**: expression (per instrument; dynamics `1..8` / `Shift+1..8`,
  hairpins `<`/`>` as start-then-end), pedal (`Shift+P` down, `Shift+O`
  lift), tempo (score-global, `Ctrl+Shift+T` modal: instant marks with an
  optional shown metronome, gradual rit./accel., "a tempo"), expressive text
  (`Ctrl+Shift+E`, `<dir>` always with an explicit `fontstyle`).
- **Stops** (`cursor/expressionCursor.ts`): one per mark (a hairpin
  contributes its start and its end) plus a placeholder at every note onset
  without a mark; coincident marks are ordered top to bottom as rendered. A
  stop selects exactly its own mark — a placeholder selects nothing — and the
  cursor stays on the same mark across an edit. `Ctrl+←/→` jumps mark to
  mark; Backspace/Delete remove the selected mark only. The layer bar sits
  beside the selected mark's rendered box.
- **Placement**: a mark on the upper staff of a grand staff is
  `@place="between"` and Verovio centres it; anywhere else `below`. Applied on
  entry, import and every load; `Ctrl+↑/↓` sets it explicitly. Everything
  else vertical is `textlayout.ts`.
- **Playback**: a per-tick velocity timeline — the latest dynamic at or before
  an onset (default `mf` from the document's dynamic map), and inside a
  hairpin a linear ramp to the first dynamic within its span, else ±45. Only
  new attacks pick up a ramp. Tempo marks build a piecewise-linear tempo
  timeline (`buildTempoTimeline`) that all playback timing uses. Pedal marks
  travel as `pedalEvents` and HKL defers note-offs while the damper is down.

## Notation features

- **Articulations** (`articulations.ts`), on the note at the cursor:
  staccato/accent/tenuto as `<artic>` children; fermata as a `<staff>`
  sibling on `@startid`; breath as a time-anchored sibling at the end of the
  note. Playback: staccato halves, tenuto holds full value, fermata ×1.5,
  breath shortens, accent adds velocity. Also: `P` parenthesized cautionary
  accidental, `H` hide rest, `/` beam break, `L` / `Shift+L` stem / slur
  direction.
- **Slurs** (`slurs.ts`, `Ctrl+L` twice): `<slur @startid @endid>` between two
  slots. `Ctrl+L` deletes a slur only where the cursor bisects it (an interior
  slot) or from its first slot with nothing pending; on its last slot it starts
  a new slur, and with a slur pending it closes it there — so one slot can end
  a slur and begin the next (`input.ts` `slurContactAt`); closing onto an
  existing slur's two slots is refused. Slurs whose endpoint
  disappeared are pruned with the ties. Playback (HKL's `computeLegatoPlan`): an
  overlapping release on instruments that replay on transpose, a glide
  handoff on sustained ones, an overlap when the pedal is down.
- **Structure**: repeats `{`/`}`, endings `Ctrl+E`, double bar `]`, ottava
  `Ctrl+8` (sounds `q ± 3` per octave; a note's stored `data-q`/`oct` stay the
  written pitch, and playback and performance acceptance shift each note of the
  staff whose onset tick lies in `[data-hkl-t0, data-hkl-t1)`), trill/tremolo `Ctrl+R` (a tremolo
  occupies one wrapped note's value; playback alternates), page break
  `Ctrl+B`, section header `Ctrl+Shift+H` (measure numbering restarts).
  Playback expands repeats and endings (`expandPlayOrder`).
- **Instruments**: single-part view (`viewInstrSelect`) renders one
  instrument's staves; it is owned and balanced like the full score (its own
  partition and widths) and exported to PDF as that part. "pizz."/"arco" text
  switches playback to a pizzicato sample set. `Alt+H` marks a string
  harmonic (diamond head; sounds at the harmonic's pitch). *Ignore color*
  drops notehead colour on the render clone.
- **Retune**: changing the score's tuning mode or note-name mapping in Setup
  rewrites each note's `(q, r)` to keep its frequency (`notation/retune.ts`).
  A mapping change seeds each note's search at its closed-form frame
  conversion (`convertCell`), so every note relocates exactly except a
  Schismatic Wicki-Hayden copy going to Euler (≈1.95¢). Afterwards
  `model.recolorNotes()` rewrites every baked colour from the note's pitch
  under the new layout (colour is one function of the pitch,
  `@hkl/shared/keycolor.js`), so an inexact relocation no longer keeps a stale
  colour. A note whose `@color` isn't a lattice ink (an import's black) keeps it.
- **Syntonic / Polysyntonic anchor**: each note sounds under the anchor of the
  key signature at its measure — `model.anchorAt(mi)` = the band of the same
  key-tonic cell `set-score-ref` carries (`findTonicCoord`), so Composer and
  HKL agree by construction. Derived, never stored (no `.hkc` change). Render
  clones get a render-only `data-anchor` per note (`stampAnchors`, S/Y only;
  never on the save path) for the HEJI transform and accidental pass
  (`noteAnchor`, `@hkl/notation/heji-render`); retune and the performance
  matcher take it per measure. A key-signature edit (`setKeySigAt`) re-anchors
  the measures it governs, so their notes re-sound, re-arrow and recolour
  (`recolorNotes`). The ✓/⚠ indicator and the entry-mismatch gate also compare
  HKL's anchor (`hkl-layout-state.anchor`) with the score's at the
  position/cursor; `apply-layout` in S/Y drops HKL's manual Ctrl+click
  selection so the score-ref drives the anchor.
- **Note-name mapping**: `<hkl:layoutReq mapping="wickiHayden">` (absent =
  Euler, so Euler scores serialise exactly as before) is the frame of every
  `data-q`/`data-r`. Spelling, MIDI, HEJI, accidental display, harmonics,
  SC shifts and the performance matcher all read it; MusicXML import makes
  Euler scores. The clipboard records its source mapping and a paste into a
  score of another mapping converts coordinates (`selection/clipboard.ts`).

## Playback and performance

`buildPlayback(model, startMs)` (`render/playback.ts`) produces per-voice
events: tie chains coalesce, trills and tremolos expand into alternations,
visible rests emit silent events (so the playback bars step through them),
repeats expand, and events before the start are dropped. Playback starts at
the cursor; each `playback-position` moves that voice's bar (overlay only);
the end restores the editing cursor.

**Performance mode** (`render/performance.ts`) is input-driven playback for
filming a performance: the player plays the part on the Lumatone and each
voice's bar advances as its notes are struck (one instrument only; no audio is
sent).

- A step is a voice's set of notes attacking at one onset (tied-in notes are
  absent). Identity is pitch name and octave plus colour, the expected colour
  looked up by octave-invariant lattice class; a sounding note with no written
  colour matches on pitch alone. Pythagorean and Semiditonal modes also accept
  any same-pitch variant.
- A voice advances only when its whole step is struck; voices advance
  independently; an unmatched strike changes nothing. When several voices
  would take a strike, only those at the earliest onset do.
- Voices are listened to only in the current measure (that of the earliest
  pending step); a voice's bar shows only where it has content.
- A trill or tremolo is one step satisfied by any of its notes; when the next
  step's notes all belong to the ornament, its advance waits for the first
  strike outside them (the bar lags rather than runs ahead).
- The bar trails the player (right edge of the step just played). Reaching
  the end does not exit.
- **Invariant**: the take is performed correctly and in order, and a deviation
  halts the follow by design. No recovery, resync or tolerance
  (decisions.md "Performance mode halts on deviation, by design").

## Files and export

- **`.hkc`**: the MEI document (`save.ts` `hkcBlob` / `loadHkcFromFile`).
  Loading replaces the model, unbinds the file, clears history and forces a
  full render.
- **Where files go** (`files.ts`): with the overlay host's local file bridge
  up ([overlay.md](overlay.md)), Open and Import use native dialogs and Save
  writes in place (`write` conditioned on the file's mtime; a conflict asks
  before overwriting); a MusicXML import binds to its folder and saves a new
  `.hkc` beside it (numbered if the name is taken), never over the source. Without a host: file
  input and downloads named from the title. The binding is app state, never
  MEI. Exports always go through the save dialog, before rendering. One file
  operation at a time.
- **MusicXML import** (`importMusicXml.ts`) reads Finale's encoding of hidden
  staves and multimeasure rests into the empty-cell flags, breath marks, and
  parenthesized accidentals; it spells pitches onto lattice cells
  (`coord-spelling.ts`) and turns `<rest measure="yes">` into an empty layer.
  A file's bytes are decoded by `xmlText.ts` `decodeXmlText` (byte-order mark,
  then UTF-16's null-byte pattern, then the declared encoding; the host bridge
  decodes `/fs/read` with a twin in `fs-bridge.mjs`), so UTF-16 and single-byte
  encodings import. A part holding any `<unpitched>` note is dropped whole
  before anything reads it — Composer cannot write unpitched notes — and the
  status line names it; a score of nothing but such parts fails to import.
  Invisible playback notes (`<note print-object="no">`, e.g. Finale's
  realisation of a timpani roll — Composer owns tremolo playback) are dropped
  in `buildEvents`: an invisible onset becomes hidden time, merged and emitted
  like a voiced `<forward>`, so every later note keeps its beat; an invisible
  chord member vanishes; a visible member of a chord with an invisible head
  takes its place. Slurs pair per part in source document order (`pairSlurs`):
  a note's stop before its start (a note may end slur N and begin the next
  slur N), a stop with no open start waiting for a start in its measure that
  is no later in time (a slur written end-first across voices), every pair
  oriented forward in time.
- **MusicXML export** (`exportMusicXml`): one `<part>` per instrument, voices
  separated by `<backup>`, divisions 16 or its LCM with tuplet numbers,
  colour on noteheads, every tempo written into every part (`<sound tempo>`
  always, `<metronome>` where shown), directions interleaved into the note
  stream, slur numbers assigned in document order, pickups `implicit`, ottava
  pitches written as sounding, breaks as `<print>`. Not exported: section
  titles, HEJI commas, parenthesized accidentals; `<space>` comes back as a
  hidden rest. Parity census and probes: decisions.md "MusicXML export
  parity: the sonata census".
- **PDF** (`renderPdf`): the page view, page for page. Every page is mounted
  (`mountAllPages`), cloned synchronously, normalized for print (light theme,
  black non-notehead ink, hidden rests removed, computed stroke and text
  styles inlined — svg-to-pdfkit reads no stylesheets) and drawn with PDFKit
  with the embedded `BravuraText.otf`, so HEJI survives. Paper is US Letter;
  scroll view switches to page view for the export. Residual: `Times` text
  widths differ slightly from the screen.

## Setup and help

**Setup** (`setupDialog.ts`) edits title, subtitle, composer, footer, tuning
mode and note-name mapping (either retunes on change), HEJI, ignore colour,
page size, the dynamic map,
gradual-tempo percentages and instruments, applied as one undo entry. Buttons
open the signature modal and the tempo modal at measure 1 and run *Fill
incomplete measures*. The modals share `ui/textEntryModal.ts` (Enter submits
except on a focused button).

**Help** (`helpDialog.ts`) renders `KEYBINDINGS` from `keybindings.ts` —
documentation, not a dispatch table: change both together.

## Known limits

- Held notes don't follow a hairpin; only new attacks pick up its level.
- Nested tuplets and tuplets across barlines are not supported.
- Scroll view wraps past roughly 500 bars at 100 %.
- A selection's rects are per system, unconnected across a system break.
- Pizzicato sample sets beyond viola need their `.hki` and an entry in HKL's
  variant map.

## Testing

- **`test/composer-test/`** — the fixture suite (README there). For a scoped
  change: `pnpm test:composer:affected` (fixtures that execute the changed
  lines, plus the fast tier); for a broad one: `pnpm test:composer`. Every
  bug fix lands with a fixture.
- **`test/composer-inspect/inspect.mjs`** — evaluate an expression or take a
  screenshot in a headless page.
- **`test/composer-inspect/sonata-probes/`** — whole-document gates, censuses
  and cost probes on Max's sonata (README there).
- **`HKL_INDEX_CHECK=1`** turns on the in-app verifiers: navigation index,
  scoped ties and dirty ranges, multirest unit edges, and the page-splice
  reference gate.
