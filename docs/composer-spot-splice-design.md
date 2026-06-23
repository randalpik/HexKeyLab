# Composer rendering & model — spot-splice redesign

**The idea in one line:** Verovio is an excellent one-shot engraver and a terrible
live editor — it re-lays-out the whole document on every `loadData` and has no
incremental API. So we render the whole score **once** into a single persistent
SVG and thereafter use Verovio only as a **spot-change tool**: re-engrave a small
run of measures and splice the result into the live SVG, leaving every other
measure untouched. The model likewise maintains incrementally-invalidated derived
state so navigation/tick lookups are O(1)/O(log n) by construction.

This supersedes the chunk-virtualization approach in
[composer-virtualization-handoff.md](composer-virtualization-handoff.md) (kept as
an archive of what we learned). The chunk modules (`virtualize.ts`,
`chunk-render.ts`, `measure-index.ts`) are deleted.

## Status at a glance

| Phase | What | State |
|---|---|---|
| **A** | Model navigation index (O(1) nav/tick) | ✅ **done** |
| **B1** | Single persistent-SVG scroll render | ✅ **done** |
| **B2** | Spot-splice on edit (surgical re-render) | ✅ **done — shipped** |
| **B3** | Incremental edit pipeline (per-edit latency) | ⏳ **next** — planned, see below |
| **C** | Page view (cascade systems off the hot path) | later |

A fresh thread picking up performance work wants **Phase B3**. Everything above
it is shipped and green (`pnpm test:composer` 311/311 + `HKL_INDEX_CHECK`).

## The four invariants (design contract — still hold)

1. **One persistent SVG.** The whole score (scroll view = one horizontal system)
   is rendered once and lives in the DOM. Scrolling is native — no JS, no
   mounting. The initial full-render cost (~3.8 s for the 446-bar sonata, instant
   for normal scores) is paid **once**, not per interaction.
2. **Vertical layout is immutable.** The full render fixes the staff Y positions
   (Verovio's one consistent set of inter-staff gaps). Edits never change Y.
3. **Edits mutate X and swap content only.** An edit re-engraves the affected
   measure run, places its glyphs at the fixed staff Ys, and shifts following
   measures in X. Followers' internals never move.
4. **No auto full-render fallback, ever.** A full re-engrave (file open / explicit
   reflow / a zoom-theme-view change) is the ONLY full render. A full re-engrave
   hangs the app for seconds — never acceptable as a silent fallback. (An
   unspliceable edit logs loudly and full-renders — a visible bring-up net.)

---

## Phase A — model navigation index ✅ done

`apps/composer/src/model/voice-index.ts` builds a per-voice index (stops, tick
positions, measure indices, boundaries, measure-stop prefixes) in one O(n) pass,
cached and invalidated via `invalidateMeterCache()` — the choke point every
mutation reaches through `normalizePlaceholdersAll`. Hot nav/tick functions
(`getTickPositionAt`, `measureBoundaryCursors`, `getFlatStopInfo`,
`cursorMeasureIdx`, `getMeasureStartCursor`, `getFirstVisualCursorInMeasure`) read
it. `measureBoundaryCursors` went 46 s → ~0 ms; Ctrl-arrow 46 s → ~31 ms.

- Test-mode consistency gate: `globalThis.__HKL_INDEX_CHECK` (env
  `HKL_INDEX_CHECK=1` in the runner) rebuilds and compares every index against the
  original per-query computation — **keep using this pattern after any model
  change** (B3 will lean on it heavily).
- `flatChildren` is deliberately **not** cached — mutation code reads it
  mid-operation, before invalidation; caching corrupts ties/beams/inserts.

---

## Phase B1 — single persistent-SVG scroll render ✅ done

`Renderer.renderSingleSystem()` engraves the whole score as one `breaks:'none'`
system into `#score` (bare SVG, styled by `#score.view-scroll svg`).
`postProcessRendered()` (crisp pinning, notehead z-order, HEJI glyph injection,
theming) is shared by page + scroll.

- `pageWidth`/`pageHeight` pinned to Verovio's maxima (100000 / 60000 MEI units —
  these are MEI units, not output px; the sonata's one system is ~190k px wide and
  renders fine). Known limit: ~500 bars at 100% zoom before content exceeds the
  budget and wraps.
- Page + scroll share ONE toolkit, so every per-mode option must be set EXPLICITLY
  each render (`setOptions` persists unspecified options).
- The nav `onChange → onCursorMove` fixes in `input.ts` (Ctrl-arrow bar-jump,
  expr/pedal/tempo mark-jump, Shift-arrow selection) removed a redundant reRender
  on pure navigation.

---

## Phase B2 — spot-splice on edit ✅ done (shipped)

Shipped in **`apps/composer/src/render/splice.ts`** (`ScrollSplicer`), wired
through `render.ts` (`renderComposer`/`renderScroll`) and `main.ts` (`reRender`).

### What happens on a render

`main.ts reRender()` → `renderer.renderComposer(model, viewStaves)`:
- **Page view** → full `serialize` + multi-page render (unchanged legacy path).
- **Scroll, full re-engrave** (file open / reflow / zoom-theme-view change, via
  `forceFullRerender()`; also single-part view) → `renderSingleSystem` +
  `splicer.capture()`, which records the per-measure index, measures the
  inter-staff gaps, and calibrates the `stem.len → gap` law.
- **Scroll, edit** → `splicer.splice(model, …)`: surgical, O(edited-range).

### The splice (per edit)

1. **Diff** the model's LIVE doc per-measure signatures (common prefix + suffix by
   id + serialized content) → the changed run `[lo..hi]`.
2. **Expand** the run outward until no spanner (tie/slur/hairpin/…) crosses an
   endpoint, so whole spanners re-render together (`expandForSpanners`).
3. **Sub-MEI** = `model.serializeRangeForRender(cLo, cHi, …)` (head scoreDef with
   running clef/key/meter folded in as of `lo`, interior scoreDefs preserved,
   transforms run over only the range) **+ one synthetic spacer measure**.
4. **Render** the sub-MEI on a **dedicated `spliceTk` toolkit** (never the live
   one — sharing it pollutes the score's toolkit state), `postProcess` it.
5. **Splice the DOM:** replace the changed `g.measure`s by `xml:id`; one
   `translate(dx, dy)` anchored on an UNCHANGED context measure (never the sub's
   system-first measure, which gets a spurious leading clef); merge glyph `<defs>`
   by SMuFL codepoint.
6. **X-cascade:** shift every following persistent measure by `Δ`. Old + new runs
   must expand symmetrically (`oldHi = hiNew + countDelta`) or measures duplicate.

### The vertical problem and the synthetic-spacer solution

A re-engraved sub-range has identical x + within-staff content but **different
inter-staff gaps** — Verovio sizes each gap to that *system's* max inter-staff
content, and a sub-range lacks the measures driving the full system's gaps. There
is no per-staff spacing control (`spacingStaff` etc. are global + range-limited).

**Solution (shipped):** append ONE **synthetic spacer measure** to the sub-render
that forces each inter-staff gap to the full render's exact px value, then discard
it (never spliced). The mechanism is **`stem.len` on a stemmed note** — linear,
fractional, floored at the min gap, so `gap = slope·stem.len + intercept` inverts
to any px target; calibrated once per full render (2 offscreen renders). Each
staff gets a LOCAL forced treble clef (confined to the discarded measure) so the
control note sits on one fixed line regardless of the real clef, and its down-stem
protrudes only below its staff. With gaps reproduced, the edited measures align
with a single `dy`; cross-staff spanners are correct by construction.

> **This replaced the original plan's "propper-finding"** (find the real measures
> that drive each gap). The spike disproved it — bbox clearance ignores horizontal
> collision, and even an x-aware sweep mispredicts Verovio (barlines/braces/
> cross-staff stems span the gap). See the Appendix and decisions.md.

### Where the details live

- **decisions.md:** synthetic-spacer (`stem.len`) approach; dedicated `spliceTk`;
  serialize-only-the-edited-range.
- **lessons.md:** glyph defs are `<g id>` not `<symbol>` (merge by codepoint);
  cursor-overlay cleanup (a splice doesn't reset `#score.innerHTML`);
  `normalizePlaceholders` must be idempotent (id churn defeats the diff);
  `normalizeTies` O(n²) prunes (the big edit-latency culprit); splice run-symmetry
  (expand old + new runs together or measures duplicate).
- **Guard fixture:** `scrollEditSplicesNotFullRender` (asserts a scroll edit
  splices — persistent SVG root node reused — not full-re-engraves).
- **Throwaway measurement harness:** `test/composer-inspect/spike-b2.mjs` (phases
  `realdelete` / `breakdown` time the mutation vs render vs sub-passes).

### B2 acceptance (met)

Single-note / insert / delete edit on the sonata splices (no full re-engrave),
pixel-identical to a full render for the edited measures (incl. cross-staff
spanners); file open / reflow / view-setting change are the only full renders.

---

## Phase B3 — incremental edit pipeline ⏳ NEXT (planned, not started)

B2 splice is shipped and correct; this is the **per-edit latency** follow-up.
Tackle on a fresh thread — measurements + strategy below are the handoff.

### Where we are (the latency journey)

Editing the 446-bar sonata was multi-second per keystroke. Fixed so far:
- **`normalizeTies` O(n²) prunes** — `pruneDanglingSlurs`/`pruneDanglingArticControls`
  scanned all notes *per spanner/control*. Now build the id-set once (O(n)). THE
  big one (~2.2 s of a 2.7 s hang).
- **`normalizePlaceholders` id churn** — regenerated every placeholder id every
  edit → made every measure look dirty to the splicer. Now idempotent.
- **Splice serializes only the edited range** — `model.serializeRangeForRender`
  (+ `cloneRangeStructure` clones only head + range, not the whole doc).

Result: **~2.7 s → ~400 ms** per edit on the sonata (Max's browser). Usable, not great.

### Remaining bottlenecks (DevTools @ ~400 ms)

No single culprit — **~6 O(total) passes per edit, each a slice**. An edit touches
1–2 measures but each pass walks all 446:

- **Mutation (~55%):** `normalizeTies` (strips/rebuilds ALL tie state, every
  measure × voice — now linear but O(total)); `normalizePlaceholdersAll` (walks
  every layer — idempotent but O(total)).
- **Splice (~45%):** the dirty diff re-serializes ALL live measures;
  `expandForSpanners` rebuilds a note→measure map over ALL measures;
  `renderToSVG` + `postProcess` are O(range) with fixed overhead (partly
  inherent); plus the browser re-laying-out / repainting the single giant SVG on
  mutation (likely the larger cost on slow renderers — NOT fixed by the strategy
  below).

> NB: `getElementById` does **not** resolve `xml:id` in the live MEI doc
> (verified), so spanner endpoints can't be resolved O(1) without a *maintained*
> note→measure index.

### Strategy: one dirty-measure range, consumed everywhere

Make the model track **which measures changed since the last render** — a small
`{lo, hi}` (or `Set<measureIndex>`) dirty range, set at the mutation choke point
(every structural edit funnels through `normalizePlaceholdersAll` /
`invalidateMeterCache`, and the edit knows its cursor measure). Then convert each
pass to O(edited-region), **one at a time, testing after each**:

1. **diff** → use the dirty range directly; stop re-serializing all live measures.
2. **`normalizeTies`** → re-realize only dirty measures ± 1 per voice (tie pairings
   only change within a measure and at its boundaries). Gate with an
   `HKL_INDEX_CHECK`-style consistency check (scoped result == full rebuild in test
   mode) — the riskiest piece.
3. **`normalizePlaceholders`** → only the dirty measures' layers.
4. **`expandForSpanners`** → maintain a note→measure index (forward
   `noteId→measureId` + reverse `measureId→noteIds`, updated O(range) per edit) so
   endpoints resolve without the O(notes) rebuild.

Target: ~tens of ms for model + splice JS. If the Verovio sub-render + giant-SVG
repaint then dominate, the next lever is reducing forced layout/paint of the
persistent SVG (CSS containment; or caching per-measure intrinsic geometry at
capture so the splice reads zero `getBBox` from `#score`).

**Risk:** dirty-range scoping touches core model invariants (tie/placeholder
correctness across measure boundaries). Gate with `test:composer` + the
consistency check, and add the spanner-crossing-the-run fixtures B2 acceptance
lists.

---

## Phase C — page view (later)

Page view keeps the current full-render path until this phase. The innovation:
own line-breaking over the measure-width index, and on insert **cascade one system
at a time off the hot path** (reflow the affected system synchronously, push
overflow to the next system, continue asynchronously) rather than re-engraving the
document. Out of scope for current work.

---

## Settled decisions

1. **Vertical conform = synthetic spacer measure** (`stem.len`-driven) — NOT
   propper-finding, NOT post-render per-staff translate, NOT fixed global spacing.
2. **Dirty detection = live-doc per-measure signature diff** (common prefix/suffix
   by id + serialized content). B3 replaces this with model-tracked dirty ranges.
3. **No auto full-render fallback**, ever. Full render = file open / explicit
   reflow / zoom-theme-view change only.
4. **Splice runs on a dedicated `spliceTk` toolkit**; splicing is gated to
   all-parts view (single-part view full-renders — the gap calibration assumes the
   full staff set).
5. `pageWidth`/`pageHeight` pinned to Verovio maxima (100000 / 60000); ~500-bar
   single-system ceiling accepted for now.

## Appendix — superseded B2 plan (propper-finding)

The original B2 plan reproduced the inter-staff gaps by **finding the real
measures that prop each gap** (`argmin_m clearance(m)` from the full render's DOM)
and including them as spacers in each sub-render. The spike disproved it:
whole-measure bbox clearance ignores horizontal position (two notes can overlap in
Y but sit at different beats), and even an x-aware collision sweep mispredicts
Verovio because barlines/braces span the gap and cross-staff stems cross the
midpoint. A render-based finder (solo-render each measure, argmax gap) was correct
but ~5–18 s. The synthetic-spacer approach (above) computes the gap-forcing
content by formula instead — zero render-time search. Kept here only so the
reasoning isn't re-discovered.
