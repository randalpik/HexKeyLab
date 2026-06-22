# Composer rendering & model — spot-splice redesign

**Status:** design, not yet implemented. Supersedes the chunk-virtualization
approach in [composer-virtualization-handoff.md](composer-virtualization-handoff.md)
(which is now an archived record of what we learned, not the plan).

## Why we're rewriting

Chunk virtualization treated the score as many independent Verovio renders that
must be *made to agree*. Every bug we hit came from that premise:
- a stray CSS margin shifted each chunk vs. its clip (handoff issues 1–3);
- chunks compute their own content-driven inter-staff gaps, so multi-staff
  systems disagree across seams (issue 4); `spacingStaff` is non-monotonic and
  can't force agreement;
- navigation/tick math is O(n²) (`measureBoundaryCursors` = 46 s on the 446-bar
  sonata) because the model recomputes `flatChildren` + `locateCursor` per element.

The realization: **Verovio is an excellent one-shot engraver and a terrible live
editor.** It re-lays-out the whole document on every `loadData` and has no
incremental API. So we stop asking it to be live. We render the whole score
**once** into a single SVG, and thereafter use Verovio only as a **spot-change
tool**: re-engrave a small contiguous run of measures and splice the result into
the persistent SVG, leaving every other measure's internals untouched.

And the model stops recomputing derived data per query: it maintains a small,
incrementally-invalidated index so navigation and tick lookups are O(1)/O(log n)
**by construction**, not by workaround.

## Core principles

1. **One persistent SVG.** The whole score (scroll view = one horizontal system)
   is rendered once and lives in the DOM. Scrolling is native — no JS, no
   mounting. Initial render cost is the pre-virtualization cost (~3.8 s for the
   sonata, instant for normal scores) and is paid **once**, not per interaction.
2. **Vertical layout is immutable.** The full render fixes the staff Y positions
   (Verovio's one consistent set of inter-staff gaps). Edits never change Y. This
   is what dissolves issue 4: there is exactly one vertical layout, forever.
3. **Edits mutate X and swap content only.** An edit changes a measure's content
   and width. We re-engrave the affected measure run, place its glyphs at the
   fixed staff Ys, and shift following measures in X. Followers' internals never
   move.
4. **The model is the index.** Cursor stops, tick positions, measure boundaries,
   and per-measure metadata are maintained derived state, invalidated atomically
   on edit — never recomputed per query or per render.

## Scope (decided)

- **Scroll view only** for this work. Page view keeps the existing full-render
  path for now; its eventual innovation is to **cascade one system at a time off
  the hot path** on insert (Phase C, later). Scroll is where editing happens.
- **Spanners: splice whole measures.** We never hand-edit ties/slurs/hairpins or
  other cross-measure fixtures. When an edit's dirty set touches a spanner, we
  expand the re-rendered run to whole measures that fully contain it. Re-rendering
  up to ~30 measures is effectively instant (that was the working score size
  pre-virtualization), so we have headroom; we prefer fewer measures but never at
  the cost of splitting a spanner.

---

## Phase A — model index (do first)

The quickest win and the correct foundation for the splice. Independently
shippable and fully testable against the 308-fixture suite with **no renderer
change**.

### Problem

`getTickPositionAt(voice, c)` rebuilds `flatChildren` (O(n)) and calls
`locateCursor` (O(c)) every call; `measureBoundaryCursors` calls it per element →
O(n²). Plain arrow is fast only because `moveCursor` is O(1) and avoids this math.

### Design

A per-voice cached index, lazily (re)built when stale:

```ts
interface VoiceIndex {
  stops: Element[];          // === flatChildren(voice) (reuse the proven logic)
  tickPos: Float64Array;     // absolute tick of stop c, c ∈ [0, stops.length]
  measureIdx: Int32Array;    // measure index of stop c
  inTuplet: Uint8Array;      // 1 iff stop c is strictly inside a tuplet body
  boundaries: number[];      // sorted cursor indices on a measure boundary
}
// plus doc-level: measureStartTick[], measureBudget[] (per measure)
```

- **Build (O(n), once per edit):** call `flatChildren(voice)` once (correctness
  preserved — same proven function), then a **single incremental pass** over the
  stops accumulating tick position (carry a running within-measure tick counter,
  reset at measure transitions, descend into tuplets) — i.e., compute what
  `getTickPositionAt` computes, but for all stops in one walk instead of one call
  per stop. Derive `boundaries` from `tickPos` vs `measureStartTick` using the
  existing `TICK_EPS` rule.
- **Cache + invalidation:** `model.revision` counter, bumped by every mutator.
  Each `VoiceIndex` records the revision it was built at; access rebuilds iff
  stale. Navigation (no edit) builds once, then every query is O(1)/O(log n).
- **Hot functions become lookups:** `getTickPositionAt` → `tickPos[c]`;
  `measureBoundaryCursors` → `boundaries`; `getFlatStopInfo`, `isCursorAtPastEnd`,
  `getVoiceLength` → O(1). Ctrl-arrow = binary search over `boundaries`.

### Invalidation safety

`this.doc` is written at ~dozens of sites; a missed `bump()` = stale render.
Mitigations:
- Centralize: bump in the public mutation entry points (insert/delete/replace,
  tuplet/tie ops, sig/clef/key, instrument ops, `replaceDocument`,
  `restoreSnapshot`, import). Enumerate during implementation.
- **Test-mode consistency check:** when a debug flag is set, every index access
  also does a fresh rebuild and asserts equality with the cached copy. Run it
  across the whole suite so a missed bump fails a test, not Max's session.

### Dirty-measure tracking (consumed by Phase B)

The same `revision` bump records, per edit, the set of measures whose **source**
changed, so Phase B knows what to re-engrave. Two candidate mechanisms (decide in
implementation):
- **(a) Mutator-reported:** each edit op reports the measure id(s) it touched.
  Precise, O(edit), but spread across ops.
- **(b) Signature diff:** cache each measure's serialized source; on access, diff
  (measured ~9 ms for 446 bars — pure string work, no parse). Robust, central,
  O(total)-but-cheap.

Recommendation: start with (b) (robust, central, cheap), move hot ops to (a) if
the 9 ms ever shows up. Either way the renderer consumes a measure-id dirty set.

### Phase A acceptance

- `measureBoundaryCursors` and `getTickPositionAt` are O(1) after one O(n) build;
  ctrl-arrow on the sonata drops from 46 s to sub-ms (excluding render).
- 308-suite green; test-mode index-consistency check green.
- No renderer changes.

---

## Phase B — single-SVG renderer + spot-splice (scroll)

Replaces the chunk renderer (`virtualize.ts`, `chunk-render.ts`,
`measure-index.ts` get deleted).

### Full render

`render(mei)` (scroll) engraves the whole doc as **one system** (`breaks:'none'`,
`pageWidth > total`) into a single persistent `<svg>` in `#score`. Capture:
- per-measure **x and width** (a measure index, like the old `measure-index.ts`
  but for the persistent SVG, no estimation — real widths from the full render);
- per-staff **Y** (the immutable vertical layout);
- the `<defs>` glyph table.

### Splice on edit

Given the dirty measure-id set from the model:
1. **Expand to a contiguous run** `[lo..hi]` covering all dirty measures, then
   extend outward while any spanner crosses an endpoint (so the run contains
   whole spanners — per the scope decision). Cap is generous (~30 measures); log
   if hit.
2. **Re-engrave** `[lo..hi]` as a sub-MEI with the running clef/key/meter context
   at `lo` (reuse `buildChunkMei`'s context logic — the one piece of the chunk
   code worth keeping).
3. **Splice into the persistent SVG:**
   - Place the run's glyphs at the **fixed persistent staff Ys** (a note's
     within-staff y = pitch+clef offset, independent of inter-staff gap — so this
     is a per-staff translate by `persistentStaffTopY − subRenderStaffTopY`, and
     it aligns exactly).
   - Replace the old `[lo..hi]` measure `<g>`s with the new ones at `x = measureX[lo]`.
   - **X cascade:** `Δ = newRunWidth − oldRunWidth`; translate every measure after
     `hi` by `Δ`; extend the system staff-line paths by `Δ`; update the measure
     index (`width[lo..hi]`, shift `x[hi+1..]`).
   - Rewrite the run's **barline** y-spans to the persistent staff Ys (barlines
     are simple verticals; cheap to retarget), and merge any **new `<defs>`**
     glyph symbols the sub-render introduced.
4. **Insert/delete measure** is the same splice with a measure count change: the
   run includes the new/removed measure; the X cascade absorbs the width change;
   followers' internals are untouched (just translated). No full re-engrave.

### The load-bearing assumptions (→ spike)

Before writing Phase B, a focused throwaway spike validates:
- **Per-staff placement** of a re-engraved measure run lands glyphs exactly on a
  different render's staff Ys (pixel-compare against the full render at that
  measure) — including beams, accidentals, ledger lines.
- **Barline retarget** and **staff-line extension** produce no seams/slivers.
- **Big single SVG** (sonata, ~82 000 px wide): initial render time, DOM/memory,
  scroll smoothness, and that the browser doesn't clamp SVG dimensions.
- **`<defs>` merge** covers glyphs absent from the initial render.

If per-staff placement proves fussy, fallback: re-render the run with vertical
layout pinned to the persistent Ys (inject spacer extremes or pin staff Ys) so
the run's `<g>`s splice without per-glyph translation — heavier, kept in reserve.

### Phase B acceptance

- Single-note edit on the sonata re-engraves only its measure run and splices in
  ≤ a few tens of ms; no full re-engrave; visually identical to a from-scratch
  full render at every measure (pixel-compare).
- Insert/delete measure: followers translate, internals stable.
- Issue 4 gone (one vertical layout). Chunk modules deleted.

---

## Phase C — page view (later)

Page view keeps the current full-render path until this phase. The innovation:
own the line-breaking over the measure-width index, and on insert **cascade one
system at a time off the hot path** (reflow the affected system synchronously,
push overflow to the next system, continue asynchronously) rather than
re-engraving the document. Out of scope for the current work.

## Migration / what changes

- **Delete (Phase B):** `render/virtualize.ts`, `render/chunk-render.ts`
  (keep its `buildChunkMei` context logic), `render/measure-index.ts`, the
  `scrollOverlayWidth`/`leftMargin`/chunk-toolkit machinery, the issue 1–3 CSS
  fix (moot once chunks are gone).
- **Keep:** the nav `onChange → onCursorMove` fix in `input.ts` (removes a
  redundant reRender independent of this rewrite); the cursor overlay (now sized
  to the single SVG).
- **Phase A** touches only the model (`model/index.ts`, `model/cursor-location.ts`).

## Testing

- Phase A: existing suite + index-consistency check; a perf assertion that
  ctrl-arrow / `measureBoundaryCursors` is O(1)-after-build on a large fixture.
- Phase B: a large-score fixture; splice-identity (pixel-compare a spliced edit
  vs. a full re-render at several measures); insert/delete-measure invariants;
  edit-latency assertion (`performance.now()` ≤ budget, only the run re-engraved);
  spanner-crossing-the-run-boundary fixtures. Every Composer fix still lands with
  a fixture.

## Open questions for Max

1. Dirty-measure mechanism: signature-diff (b) to start, or go straight to
   mutator-reported (a)? (I lean b.)
2. Spike: OK to spend a short throwaway spike on the per-staff-placement +
   big-SVG assumptions before Phase B, as we did for the original chunk proof?
