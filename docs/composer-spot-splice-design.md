# Composer rendering & model — spot-splice redesign

**Status:** Phase A (model index) **done**; Phase B1 (single-SVG scroll render,
chunk system deleted) **done**; Phase B2 (spot-splice on edit) **planned, not
started** — this doc is the handoff for B2. Supersedes the chunk-virtualization
approach in [composer-virtualization-handoff.md](composer-virtualization-handoff.md)
(archived record of what we learned, not the plan). The chunk modules
(`virtualize.ts`, `chunk-render.ts`, `measure-index.ts`) are deleted.

### Current state (what a fresh thread inherits)

- **Phase A — model navigation index (done, committed-quality, 310/310 tests).**
  `apps/composer/src/model/voice-index.ts` builds a per-voice index (stops,
  tick positions, measure indices, boundaries, measure-stop prefixes) in one
  O(n) pass, cached and invalidated via `invalidateMeterCache()` (the choke
  point every mutation reaches through `normalizePlaceholdersAll`). The hot
  nav/tick functions (`getTickPositionAt`, `measureBoundaryCursors`,
  `getFlatStopInfo`, `cursorMeasureIdx`, `getMeasureStartCursor`,
  `getFirstVisualCursorInMeasure`) read the index. `measureBoundaryCursors`
  went 46 s → ~0 ms; Ctrl-arrow 46 s → ~31 ms; Shift-arrow → ~80 ms. A
  test-mode consistency check (`globalThis.__HKL_INDEX_CHECK`, env
  `HKL_INDEX_CHECK=1` in the test runner) rebuilds and compares every index
  against the original per-query computations — keep using it after any model
  change. `flatChildren` is deliberately **not** cached (mutation code reads it
  mid-operation, before invalidation — caching it corrupts ties/beams/inserts).
- **Phase B1 — single-SVG scroll render (done).** `Renderer.render()` →
  `renderSingleSystem()` engraves the whole score as one `breaks:'none'` system
  into `#score` (no `.score-page` wrapper; the bare SVG is styled by
  `#score.view-scroll svg`). `postProcessRendered()` is shared by page + scroll.
  **`pageWidth`/`pageHeight` are pinned to Verovio's maxima (100000 / 60000 MEI
  units)** — these are MEI units, not output px (the sonata's one system is
  ~190k px wide and renders fine at `pageWidth 100000`, zero console errors).
  Known limit: ~500 bars at 100% zoom before content exceeds the budget and
  wraps; revisit if a real score hits it. Page + scroll share ONE toolkit, so
  every per-mode option must be set EXPLICITLY each render (Verovio's
  `setOptions` persists unspecified options — `adjustPageHeight` is set per-mode
  in `buildOptions` for exactly this reason). **B1 makes every scroll edit a
  full re-engrave (~4 s on the sonata) — that is what B2 fixes.**
- The nav `onChange → onCursorMove` fixes in `input.ts` (Ctrl-arrow bar-jump,
  expr/pedal/tempo mark-jump, Shift-arrow selection, Escape-from-selection) are
  in and correct — they removed a redundant reRender on pure navigation.

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

## Phase A — model index (DONE)

See "Current state" above. Implemented in `voice-index.ts`; nav/tick functions
read the cached index; 310/310 with the `HKL_INDEX_CHECK` consistency gate green.
Dirty-measure tracking for B2 will use **signature-diff** (cache each measure's
serialized source, diff on render; ~9 ms for 446 bars, pure string work, robust,
central) — not yet wired (B1 re-renders whole, so nothing consumes it yet).

---

## Phase B1 — single-SVG scroll render (DONE)

See "Current state" above. The persistent SVG is the whole score as one
`breaks:'none'` system in `#score`. Every scroll edit currently full-re-engraves
(~4 s on the sonata) — B2 makes it surgical.

---

## Phase B2 — spot-splice on edit (THE PLAN — not started)

**Hard rule from Max:** *nothing* may auto-trigger a full re-engrave. Verovio
does a full render ONLY on file open or an explicit user "reflow" command.
Every edit is surgical. (A full re-engrave hangs the app for seconds — never
acceptable as a silent fallback.)

### The vertical problem and the spacer-measure solution

A re-engraved sub-range and the full render produce **identical x and
within-staff content** (spike: 0.01 px) but **different inter-staff gaps**:
Verovio sizes each staff-pair gap to that *system's* max inter-staff content, and
a sub-range lacks whatever measure(s) drive the full system's gaps. Measured
(sonata, `pageWidth 100000`): full gaps 251/272 px; sub-ranges 180/180, 184/220,
etc. — never matching.

Verovio offers **no per-staff spacing control** (`spacingStaff`/
`spacingBraceGroup`/`spacingBracketGroup` are global, max 48 MEI units) and the
content-driven gaps exceed those, so we cannot *tell* Verovio the target gaps.
Two rejected approaches: (1) post-render per-staff translate of the sub-render's
staves — disrupts Verovio's natural staff flow and requires re-syncing every
cross-staff spanner (massive headache); (2) a fixed wide spacing on all renders —
disturbs natural spacing globally.

**Chosen approach (Max's): spacer measures.** Find the measure(s) that *prop up*
each inter-staff gap in the full render. When building a sub-render, include those
propping measures as **spacers** alongside the real edited range. Verovio then
naturally produces the **same gaps** as the full render (dy = 0), so the real
edited measures splice in with a trivial single x-translate, and cross-staff
elements (slurs, beams, barlines) are correct *by construction* — Verovio drew
them at the right gap. The spacer measures are **rendered but never spliced** into
the real score; they exist only to reproduce the spacing, then are discarded.

### Finding the propping measures (the hard part)

A gap between staff *k* and *k+1* is sized to the measure with the least
inter-staff clearance — i.e. `argmin_m ( minY(content of staff k+1 in m) −
maxY(content of staff k in m) )`. Determine this **from the full render's DOM**
(done once at full render, so it accounts for ALL content — notes, ledgers,
dynamics, fingerings, everything — not just pitches):

1. After the full render, for each measure `m` and each adjacent staff pair
   `(k, k+1)`, measure `maxY` of staff-k content and `minY` of staff-(k+1)
   content within `m` (bounding boxes of the measure's per-staff `g.staff`
   content, excluding the staff lines themselves if needed).
2. `propper[k] = argmin_m clearance(m, k)` per pair. Store the propper measure
   index per gap (often 1–2 distinct measures for a 3-staff score).
3. Recompute the proppers only on a full render (file open / reflow) — they're
   stable across surgical edits (an edit that *would* change them is the
   accepted spacing-drift case, fixed by a manual reflow).

### Sub-render + splice

Per edit (dirty measure set from the model's signature-diff):
1. **Expand** the dirty set to a contiguous run `[lo..hi]`, then outward until no
   spanner (tie/slur/hairpin/tuplet/beam) crosses an endpoint — so the run holds
   whole spanners. Cap ~30 measures (instant); `log()` if hit.
2. **Build the sub-MEI:** running clef/key/meter context folded into the head
   scoreDef as of `lo`; the edited run `[lo..hi]` **with interior `scoreDef`
   changes preserved** (drop only scoreDefs *before* the run — the spike proved
   dropping interior ones causes a ~45 px/measure drift); PLUS the propping
   measures (those not already in `[lo..hi]`) appended as spacers, each carrying
   its own running clef context so it renders at the correct vertical extent.
   `breaks:'none'` → one system containing edited run + spacers.
3. **Render** the sub-MEI with the **same options as the full render** (so gaps
   match). Verify (test-mode) that the sub's staff Ys == the persistent staff Ys
   (dy ≈ 0); a mismatch means propper-finding missed a driver — fix the finder,
   NOT a runtime fallback.
4. **Splice** the edited run's `g.measure` elements (by `xml:id`) into the
   persistent SVG: replace each persistent `g.measure[i]` (i∈[lo..hi]) with the
   sub's, single translate `dx = persistentX[lo] − subX[lo]` (dy = 0). Discard
   the spacer measures.
5. **X-cascade:** `Δ = newRunWidth − oldRunWidth`; translate every persistent
   measure after `hi` by `Δ`; update the per-measure x/width index. Each measure
   is self-contained (staff lines, barline, slurs are all children of
   `g.measure`), so no system-level staff-line surgery is needed.
6. **Insert/delete measure** = the same splice with a count change; followers
   translate, internals untouched.
7. **`<defs>` merge:** add any glyph `<symbol>`s the sub-render uses that the
   persistent `<defs>` lacks — compare by **SMuFL codepoint**, not the full
   element id (Verovio suffixes ids per render, e.g. `E05C-d1vbkxxq`).

### The spike (do FIRST, throwaway)

Validate before implementing:
1. **Spacer reproduces spacing:** build a sub-MEI of an edited range + the
   computed propping measures; assert its staff Ys == the full render's (dy ≈ 0).
   Try several edit ranges (near and far from the proppers).
2. **Propper-finding is correct:** the clearance-argmin from the full DOM picks
   measures that actually reproduce every gap; if any gap stays short, the finder
   needs more (e.g. include max-down-of-k and max-up-of-(k+1) measures separately).
3. **Trivial splice matches full:** with dy = 0, splicing the edited measures
   (single x-translate) reproduces the full render's pixels for those measures
   (position-compare by `xml:id`, incl. a measure with a cross-staff slur if the
   sonata has one).
4. **Edit latency:** single-note edit re-engraves edited-run + spacers (≤ ~30
   measures) and splices in tens of ms, not seconds.

Spike harness pattern (build fresh; prior session's `spike.mjs` is gone): a Node
script that launches headless Chromium with remote debugging, navigates to the
running dev server's `/composer/`, imports the reference sonata via
`window.__composerImportMusicXml(xml)` (`~/Documents/sonataBr1.musicxml`,
446 bars), gets MEI via `model.serialize(...)`, then in-page builds sub-MEIs with
a fresh Verovio toolkit and measures staff-top Ys (`g.system g.staff path`
bbox top) and note positions (`#<xml:id> .notehead` bbox) to compare full vs.
sub. The sub-MEI builder must: fold running clef/key/meter into the head
scoreDef as of `lo`, keep measures `[lo..hi]` **with interior scoreDefs** (drop
only section children outside the kept measure span — dropping interior
scoreDefs caused the spike's ~45 px/measure drift), and append propping measures
as spacers. Render options must match the renderer's `buildOptions('none')`
(breaks:none, pageWidth 100000, pageHeight 60000, adjustPageHeight, scale/unit
from the active crisp preset). Use `code <png>` to show Max any visual; he views
in VSCode (don't pre-analyze images meant for him).

### Phase B2 acceptance

- Single-note / insert / delete edit on the sonata: only the edited run +
  spacers re-engrave; splice in tens of ms; **no full re-engrave**.
- Spliced result is pixel-identical to a full re-render for the edited measures
  (incl. cross-staff spanners).
- An explicit "reflow" command (and file open) are the ONLY full renders.
- Tests: large-score fixture; splice-identity (spliced edit == full render,
  position-compare); insert/delete-measure invariants; edit-latency assertion;
  spanner-crossing-the-run-boundary fixtures.

---

## Phase C — page view (later)

Page view keeps the current full-render path until this phase. The innovation:
own the line-breaking over the measure-width index, and on insert **cascade one
system at a time off the hot path** (reflow the affected system synchronously,
push overflow to the next system, continue asynchronously) rather than
re-engraving the document. Out of scope for the current work.

## Migration / what changes

- **Done:** chunk modules deleted (`virtualize.ts`, `chunk-render.ts`,
  `measure-index.ts`); `scrollOverlayWidth`/`leftMargin`/chunk-toolkit machinery
  gone; issue 1–3 CSS reverted to the single-svg `#score.view-scroll svg`
  margin; nav `onChange → onCursorMove` fixes in `input.ts`; the model index
  (Phase A).
- **B2 adds:** a splice module (new file under `apps/composer/src/render/`, e.g.
  `splice.ts`) owning the persistent SVG's per-measure x/width index, the
  propping-measure finder, the sub-MEI builder (running context + interior
  scoreDefs + spacers), and the splice surgery. `render(mei)` (scroll) decides
  full-render vs. splice via the model's signature-diff dirty set; a "reflow"
  command (and file open) force the full path.
- **Keep the `buildChunkMei` running-context logic** (it was in the deleted
  `chunk-render.ts` — re-derive it in the splice module, CORRECTED to preserve
  interior scoreDefs; the original dropped them).

## Testing

- Phase A (done): suite + `HKL_INDEX_CHECK` consistency gate;
  `voiceIndexBoundariesAreCheap` perf fixture; `voiceIndexConsistencyUnderEdits`.
- B2: large-score fixture; splice-identity (spliced edit == full render,
  position-compare at several measures, incl. cross-staff); insert/delete-measure
  invariants; edit-latency assertion (`performance.now()` ≤ budget, only the run
  + spacers re-engraved); spanner-crossing-the-run-boundary fixtures; a fixture
  asserting NO full re-render fires on a plain edit (mirror of
  `navDoesNotReRender` — e.g. the persistent SVG root node is NOT replaced on an
  edit). Every Composer fix still lands with a fixture.

## Settled decisions

1. Dirty-measure mechanism: **signature-diff** (cache per-measure serialized
   source, diff on render).
2. Vertical conform: **spacer measures** (Max's approach) — NOT post-render
   per-staff translate, NOT fixed global spacing.
3. **No auto full-render fallback**, ever. Full render = file open or explicit
   reflow command only.
4. `pageWidth`/`pageHeight` pinned to Verovio maxima (100000 / 60000); ~500-bar
   single-system ceiling accepted for now.
