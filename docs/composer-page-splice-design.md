# Composer page splice — living reference

Updated 2026-09-02. This is the **current-state** reference for page-view
incremental rendering in Composer: what the machinery is, the rules it enforces,
how it is verified, what it costs, and what is open. History is not repeated
here: every design choice with its rationale is a dated entry in
[decisions.md](decisions.md) (2026-08-29 onward), every dead end and trap is in
[lessons.md](lessons.md), and the code comments carry the local reasoning.
Companions: [composer-spot-splice-design.md](composer-spot-splice-design.md)
(scroll splice) and [composer-render-perf.md](composer-render-perf.md).

## ► START HERE

**State.** On the 446-bar sonata every edit splices: sweep 115/115 (viewport
counters 0), exhaustive every-measure pass 420/420 (empty refusal inventory),
battery 10/10 reference-clean (B2, 2026-09-02: a line-count change, a collapse
and an overflow onto a created page are splices too; headers are page budget),
suite 370/370 under `HKL_INDEX_CHECK` (~6 min; the courtesy stub's two and
Phase 1's three placement fixtures landed 2026-09-02). Composer owns height
(vertical-ownership plan Phase 1, landed 2026-09-02): every system on every
page is placed by Composer's rule over measured extents; nothing vertical is
read from Verovio's stacking or from the splice window. A steady-state one-note
edit is ≈ 144 ms instrumented (was 258 before the A thread; bare is lower —
read shares, not walls). The splice's DOM work is a single layout flush, the
post-surgery snap; everything the splice reads from its window comes from SVG
text and the window is never attached. Verovio's window `loadData` +
`renderToSVG` (~84 ms) is well over half of the edit; since Phase 1 the ~60 ms
it spends on the context lines buys gate work only (the fidelity comparison,
courtesy / spanner endpoints), so the window's shape is a pure gate question
(the plan's Phase 3), no longer a geometry constraint.

**Governing principle (Max, 2026-09-01):** *"The goal is to hit O(edit) in ALL
cases. Any time the user is exposed to O(document) on a live path when they
didn't ask for a change to the full document is a failure, full stop."* A
fallback is never an invariant; anything that currently derives or full-renders
is a defect with a date on it.

**Next steps.** The former steps 1 and 2 (the scheduled cascade continuation
and the window's shape) were folded into ONE sequenced plan,
[composer-vertical-ownership-plan.md](composer-vertical-ownership-plan.md)
(2026-09-02, approved), and are superseded by its sequence:

1. **Own height first — LANDED (Phases 0 and 1, 2026-09-02).** The courtesy
   stub (Phase 0: the courtesy-generating line enters the window as a
   one-measure stub, not a line) and Composer's placement of every system by
   one rule over measured extents (Phase 1: `render/pagefit.ts`,
   `Renderer.placePage` on every mount and splice, `ExtentsStore`, the
   predicted fold, the reference gate reading the rule — Ownership, below).
   This removed the context lines' THIRD job. As inventoried until 2026-09-02
   they did two (the live fidelity comparison; courtesy generation / spanner
   endpoints); they also were the two ends of the READ vertical chain
   (`verticalPlan` chained the first replaced system from the window's L−1,
   `dyFollow` the followers from its L+1) — geometry, which is what had kept
   the window's shape from being a gate question (lessons.md, "An inventory of
   a component's jobs"). The two gate jobs remain.
2. **The cascade on the model (Phase 2) — NEXT.** B2's overflow repair runs
   one measured step per page synchronously across the mounted set (cursor
   page ± 1) and parks the rest at the mount boundary (the receiving page draws
   the moved block and continues the cascade when it mounts — one document
   reload on that mount). With extents owned, a step becomes a DOM transplant
   placed by the rule (the fold is already predicted, `foldIndex`), and the
   continuation past the mounted set becomes an idle EXTENTS job beside
   adoption — measuring the lines of not-yet-mounted pages into the
   `ExtentsStore` so pages below the cursor's surroundings settle without a
   reload and without holding the keystroke. `Renderer.repairPagination`'s
   `pending` list is the seam; new test types come with it (edit-during-
   cascade, scroll-during-cascade).
3. **The window's shape (Phase 3) — a pure gate question now.** The context
   lines cost ~60 ms of the ~84 ms window and do gate work only; dropping them
   is gated on the plan's six preconditions, chiefly that the reference gate
   and the replaced-set closure stand in for the live fidelity comparison.
   Max's ruling: the live context comparison is a fallback masking replaced-
   set defects, not an invariant.
4. **Distribution (Phase 4, D1 proper).** Slack within the fixed budget; only
   `placeSystems` changes.
5. **Remaining structural bails** (each a derive): head/interior `rest`
   (staffDefs, elements before the first measure, credits — C2), user breaks,
   foreign document; the repair-loop caps (`MAX_ENSURES`, `MAX_REPAIR_STEPS`);
   a replaced line on an unmounted page that a PREVIOUS splice marked stale
   (`changed line not mounted` — B5's cheap mount refuses stale pages). B2's
   own dated refusals (2026-09-02): a section-header measure deleted by the
   edit (`section header measure removed`), a single system taller than its
   page, and a cascade beyond `MAX_CASCADE_STEPS` 64.
6. Small items: A3 (collapse the two `cursor.update` calls, ~1.6 ms, blocked on
   bridge ordering), A5 (worker-offloaded castoff `loadData`, ~1.4 s on the
   derive — big refactor, `afterRender` is the seam; the remaining latency
   lever once the window's shape is settled), the test-mode residual
   (`assertVoiceIndexConsistent` is O(measures²) once per index build, 0.7 s
   on the sonata under the flag).

**Two standing traps.** (1) Never edit `apps/composer/src` while the suite or
ANY phasec probe/sweep runs against the dev server — Vite reloads the page and
the run dies or lies. Docs, fixtures and probe files are safe at any time.
(2) Do not run `pnpm build` or a second Chromium job alongside the suite: a
visual fixture once shot mid-relayout under a concurrent build and passed alone;
the sweep's 300 s runner deadline times out under a concurrent suite. Test mode
adds ~2–3 s to a large-range edit (the reference gate's full render + the
VoiceIndex cross-check); if it gets slow again, `cb-checkcost.js` attributes it
in one run.

**Before declaring any edit-path change done**: battery on both code states
(stash / pop) — the splice/skip outcome per edit and `reference.ok` must be
identical, wall is the win; then the full suite under the flag; then
`cb-splicecost.js` for the wall. For anything touching what the splice
measures, `cb-pathprofile.js` (old and new readings side by side over every
sonata line) is the proof template. Visual discrepancies go to Max as two
images, uninterpreted; pixel-diff them first (`lessons.md`, 2026-09-01).

## Architecture

### Ownership: lines and pages (`render/linebreaks.ts`, `PageLineBreaks`)

- **Composer owns the partition and the pagination.** Every system start is
  pinned as an encoded `<sb>` (page starts as `<pb>`, replacing the `<sb>`) at
  render time only — nothing is stored in the model. Display renders use
  `breaks:'encoded'`, the only mode that honors pins verbatim. Pins after an
  `<ending>` wrapper go INSIDE it.
- **One break algorithm everywhere.** The derive does a castoff `loadData` with
  the castoff strategy, reads the partition and pagination from page-based
  `getMEI({scoreBased:false})` (~100 ms, never painted), then paints the pinned
  encoded render. Every pixel comes from one algorithm and the first edit after
  a load splices like any other. Unreadable output falls back to painting the
  castoff layout and adopting it lazily in idle slices (`armAdoption`); only
  the CURRENT adoption task may commit, once — a superseded or already-finished
  task's queued idle step must never write (decisions.md 2026-09-01). Phase 2
  of the vertical-ownership plan adds a second idle job beside adoption, the
  EXTENTS job: measuring the lines of not-yet-mounted pages into the
  `ExtentsStore` (next bullet) so the cascade can place and fold pages it has
  not mounted; same ownership discipline (only the current task commits).
- **Composer owns height** (Max, 2026-09-02; vertical-ownership plan Phase 1,
  `render/pagefit.ts`). The paper is fixed — Verovio's page box, one size for
  every page, the scale pinned at that box — and the components that fill it
  are the PAGE HEADER (Verovio's `g.pgHead`: the title on page 1, the
  autogenerated page number elsewhere; measured), SYSTEMS (measured extents:
  content above the first staff line and below the last, from the
  post-processed bbox, staff frame from the path text) and SECTION HEADERS (a
  fixed reserve, `SECTION_HEADER_RESERVE`, a band above the system holding the
  header's measure; the title baseline `SECTION_HEADER_BASELINE` into it).
  `Renderer.placePage` places every system on a page by ONE rule — first
  content top = header bottom + 2u (C0 = 5.25u without a header); then
  `max(below, F) + G + max(above, F)` between systems, F 6u, G 4u; a unit is
  80 SVG user units at `unit: 8`, zoom-invariant — on every mount and after
  every splice (before the snap), stamps `data-hkl-band-top` on header systems
  for the title injector (which only draws now), and records extents per line
  (`ExtentsStore`, Phase 2's feed). Verovio's own stacking is never read: a
  derive's page and a spliced page agree by construction, the reference gate
  compares against the rule, and the fold is predicted from it. The rule
  restates Verovio 6.3's clearance so pages moved only where Verovio's text
  metrics and the browser's bbox disagree (sonata: 92 of 116 systems within
  1u of the old placement, max 5.1u). A header consumes budget, it never adds
  paper; a page is legal when its components fit; overflow from any cause is
  repaired by the cascade (`repairPagination`). Distribution of slack within
  the budget is Phase 4; only `placeSystems` changes for it.
- **Zoom is layout-neutral**: the crisp presets share `unit: 8`, so all zooms
  produce one partition and every zoom change is a partition-cache hit (keyed on
  unit, pageScale, heji + document version; `cb-zoomunit.js` guards it).
- **User page breaks** cast off per inter-break segment; a break splits its
  line.

### The refill (`tryRefill` → `repartition`)

1. **Changed run** by prefix/suffix diff of per-measure serializations against
   an owner-held baseline. The baseline is incremental: a `MutationObserver` on
   the live document marks dirty measures and only those re-serialize
   (mutations above measure level mark everything dirty).
2. **Signature ranges** (`render/sigranges.ts`, both splicers): head and
   interior scoreDef key/meter changes and inline clef changes become the range
   they govern — to the next reset of the same kind on the same staff, one
   measure early (the predecessor takes the courtesy or the relocated clef
   glyph), inclusive of a mid-measure reset clef's measure — unioned into the
   run BEFORE repair. Only structural changes (`rest`: staffDefs, elements
   before the first measure, credits) still derive. Namespace declarations are
   not structure.
3. **Repair, never re-derive** (Max, 2026-08-30): the partition is carried by
   MEMBERSHIP (each old line keeps its first surviving measure), then only lines
   that became illegal are repaired, one measure across one boundary per step.
   Legality = fill ∈ [MIN_FILL 0.65, FIT_MAX 1.45], set to contain Verovio's own
   castoff envelope (0.706–1.426) so an adopted partition is legal by
   construction. Hard (user) breaks never move. Reflow is path-dependent by
   design; undo restores the layout exactly; a no-op edit moves nothing.
4. **Naturals** (unjustified measure widths) come from `breaks:'none'` window
   renders (the dirty range plus two left + one right context measures,
   spanners and endings whole), cached per measure id; the whole dirty range is
   measured in one window before the repair loop. A natural is the measure's
   staff-line path extent read from the SVG text via `DOMParser` — the window
   is never attached or laid out. Only `sigW` (the leading clef+key width,
   applied to every line's fill as a document-level constant) needs glyph
   metrics; it is measured with `getBBox` on an attached host only when the
   window's folded head (the sub-MEI before `<section>`, which alone determines
   the leading signature) differs from the head that last measured it. Repair-
   loop ensures are capped (`MAX_ENSURES` windows, `MAX_REPAIR_STEPS` 64) — a
   derive when exceeded.
5. **Pages are carried by LINE, inside the repair** (B2): a page keeps the line
   its old start carried to (membership), tracked as a line index through the
   repair loop (an inserted line shifts later pages' indices), so a surviving
   line never changes page because of an edit. A page whose every line vanished
   collapses into its successor. Page legality is overflow-only and is judged
   AFTER the splice, live (`repairPagination`, below); a deletion leaves its
   slack (content over churn — a page-side minimum, like vertical
   justification, is a D1/D2 question). `replacePageStarts` lets the cascade
   commit a moved boundary or a new page; the signature baseline is untouched.

### The system splice (`render/pagesplice.ts`, `PageSystemSplicer`)

Runs on EVERY refill with a live page DOM (B2: no `line count changed`
refusal, no `paginationHeld` bypass). Replaces whole systems in place;
everything else on the page is untouched or dy-translated. The renderer hands
it a `SpliceRequest` — old/new partition, old/new pagination, the changed run,
and for a cascade step the moved block (`moveLines`).

- **Replaced set = a line HUNK** `old [a..bOld] → new [a..bNew]` (B2): the
  prefix/suffix diff of old vs new start ids (a changed boundary pulls the line
  above in — its extent moved), unioned with the changed run — one measure left
  when its first measure holds a layer clef (relocation), closed once over
  spanners with an end inside the run and over `<ending>`s, then to lines — and
  with the cascade's moved block. Lines outside the hunk are identical on both
  sides, so the two coordinate systems agree there. Live systems are located by
  OLD start ids (even a deleted start measure is still in the pre-edit DOM);
  the window is built from NEW lines. Every old line must be mounted; a
  missing page is mounted from the loaded pre-edit layout (B5).
- **Target pages**: each new line goes to the page the NEW pagination assigns
  it. A page that keeps a line outside the hunk is found through that line
  (the mounted context line on it); a page made only of hunk lines is the page
  its first line's measure sits on now (a moved start id, or a collapsed
  predecessor's successor); a cascade block landing past the last page gets a
  page CREATED from the window's own page SVG with the systems stripped (same
  page options → same furniture), which then takes the full mount pass. A
  source page left without systems is reported as emptied; the renderer removes
  it, renumbers the rest and marks them stale (`removePage`).
- **Window**: L ± 1 context line, plus — when the line beyond begins a
  signature change (scoreDef possibly behind a section `<sb>`, or a leading
  clef/key/meter on ANY staff; the courtesy is generated by the FOLLOWING
  line) — that line's FIRST MEASURE as a pinned one-measure STUB system
  (`lastWindow.stubId`; since 2026-09-02, replacing the whole-line pull
  bounded at two: a stub has no chain, and the sonata's 20 extension
  positions dropped from 22.4 to 18.1 window measures, Verovio 103 → 86 ms,
  everything compared identical — `cb-courtesystub.js` on both code states).
  The ending closure runs BEFORE the courtesy rule and treats the measure past
  the range as touched, so a stub is never an `<ending>` member: an ending
  starting right past the window joins it whole and the stub is the first
  measure of the line after (`pageSystemSpliceCourtesyStubAfterEnding`).
  Synthetic `mRest` LEADER (absorbs score-start artifacts; omitted when the
  window is the score start) and TRAILER (absorbs the final barline); both are
  gate-only. **No `<pb>` pins** (Phase 1): the window is ONE page and nothing
  is read from its vertical layout — a page-first hunk line and a cascade's
  moved block are placed on their live page like any other system. Sub-MEI via
  `serializeRangeForRender`: running key/meter/clef folded into the head —
  including the range's own leading clefs (dropped from the range) and never
  clearing `meter.sym` without a meter — boundary scoreDefs inline.
- **The window is text.** Each window page is a `DOMParser` document that is
  never attached to the page. `systemProfile` reads geometry from the SVG text
  on BOTH sides (window and live): a measure's x/width is its staff-line path
  span (`M x1 y L x2 y`), the staff top is that line's y, plus the staff and
  system `transform`s. No system extents are read (nothing needs them; page-fit
  reads the live page after surgery). Glyph identity (`sigGlyphs`) reads a
  `use` href or, for a HEJI-injected glyph, the codepoint the replacing `text`
  carries, so a raw window compares against a HEJI-processed page.
- **Gates (refusal → full render, reason in `lastSkipReason`)**:
  - *Context lines* must reproduce live: per-measure x/width within EPS 25 and
    identical clef/keySig/meterSig glyph codepoints (`sigGlyphDiff`). This is
    the only live fidelity test and it has no exemptions. (The observed
    residual is ≤ 3 units: the live right-edge snap moving a staff-line end by
    ½ device px.) The REPLACED lines are never compared live — they are what
    the edit told Verovio to redraw; the reference gate verifies them.
  - *Vertical position*: none is read from the window (Phase 1). After the
    surgery every touched page is handed to `Renderer.placePage`, which
    measures each system where it now sits and places the whole page by the
    rule (Ownership, above) — the imported systems in their new frame, the
    survivors unchanged, so a follower or a page that lost a system moves
    exactly by what the arithmetic says.
  - *Section headers across the hunk*: WHERE a title sits is the placement's
    (its band is a component); WHICH PAGE it is on is the splice's: a title
    whose line moves to another page (a cascade block carrying a header)
    migrates to that page's margin, one landing on a page being created is
    dropped and re-injected by that page's mount pass, and a title whose
    measure the edit deleted refuses (dated B2 bail).
  - *No size caps*: a window costs linearly in measures up to the whole
    document, so a subset render is never the worse deal.
- **Surgery**: per target page, import the new systems (horizontal frame
  only) before the first old hunk system on it (else before the page's first
  system, else append — `mergeGlyphDefs` per page from the parsed window's
  `<defs>`), remove the old hunk systems, post-process the IMPORTED systems in
  place — crisp barline and right-edge snaps, notehead z-order, HEJI, theme,
  scoped to the imported systems, in the live page's own device frame — then
  `placePage` and `snapPage` on every touched page (a created page gets the
  whole mount pass); the renderer then removes emptied pages, marks every
  touched page stale for later mounts and runs the pagination repair. The
  snap's flush is the one layout the splice causes; the placement's `getBBox`
  reads share it. Diagnostics on the splicer: `lastOutcome / lastSkipReason /
  lastRun / lastWindow / lastWindowMei` (`lastVertical` is always null now),
  and on a context refusal `lastContextDiff`. `Renderer.lastPostStats` times
  the post-processing passes.
- **Pagination repair — the overflow cascade** (`Renderer.repairPagination`,
  B2). After a landed splice (and after any lazy mount) every touched page is
  checked for its FOLD: the first system whose content bottom passes the paper
  (`foldOf` — since Phase 1 PREDICTED by `foldIndex` over the read-only
  placement, against the paper bottom read from Verovio's inner
  `definition-scale` viewBox, 2 device px of tolerance; under `HKL_INDEX_CHECK`
  the prediction must equal the measured fold). A page that spills is repaired
  the way a castoff would: the tail from the fold on moves to the head of the
  next page — the owner's page start moves to the block's first line
  (`replacePageStarts`; a last page appends one) and the move lands as a splice
  whose hunk is the block with unchanged content and a new target page; the
  receiving page is placed by the rule like any other. Then the receiving page
  is checked, and so on. When the receiving page is a placeholder that cannot
  be mounted cheaply (stale, or the toolkit not current), the step is LAZY: the
  block is removed from the spilling page, both pages are marked stale, and
  the receiving page draws the block — and checks its own fold — when it
  mounts. So the synchronous cost is one step per mounted page below the edit
  and the rest settles at mount time (Phase 2 makes a step a DOM transplant and
  the continuation an extents job). A step that cannot land (a single system
  taller than a page, a refused window, `MAX_CASCADE_STEPS`) restores the last
  consistent pins and the edit derives (edit path) or warns (mount path).
  Under `HKL_INDEX_CHECK` a mount-time repair is verified against a fresh full
  render like an edit-path splice (`repairAtMount`).
- **Page virtualization**: the mounted set is a window around the viewport and
  cursor, with eviction; placeholders match mounted boxes exactly. Pages are
  created (cascade past the last page) and removed (collapse) in place:
  `createPage` appends a mounted, stale page; `removePage` renumbers what
  follows and marks it stale, so the first re-mount rebuilds the toolkit's
  layout from the current pins once.

### Cross-measure render dependencies (check this list when scoping any edit)

- End-of-line courtesy signatures: drawn on line k, generated by line k+1's
  first measure (the window carries that one measure as a stub).
- `relocateInitialClefs`: measure i's measure-initial clef is drawn at the end
  of measure i−1.
- Prevailing state: a clef/key/meter change governs every measure to the next
  change of the same kind on the same staff.
- Spanners: one end inside the replaced set → the other end must be in the
  window (one pass, no fixed point). Ties pull one neighbour. Endings whole.

### Scroll splicer (`render/splice.ts`)

Same signature-range rule and same diff; renders the run (two left context
measures, one right) with a synthetic spacer reproducing inter-staff gaps;
anchors on the left context; no run cap. Full-renders on structural change.
Still renders into an attached host and post-processes it there (not converted
to text reads).

### History (`history.ts`, model `snapshotStateLazy`)

A keystroke edit's AFTER snapshot serialises lazily — on idle, or synchronously
before anything that could change the document (a BEFORE snapshot, a restore,
a document replace, all of which materialise a pending one). No-op detection:
equal document versions push nothing; different versions push optimistically
and the string comparison is settled when the AFTER materialises, retracting
the entry (and restoring the redo stack) if the MEI turned out identical.
Under `HKL_INDEX_CHECK`, materialising after the version moved throws.

### Reference gate (`HKL_INDEX_CHECK`)

After every splice — once its pagination repair has settled, against the
owner's CURRENT pins — a fresh full render of the pinned MEI is compared
against every page the splice and its cascade touched: system sequence,
per-measure x/width (TOL 30), clef/keySig/meterSig glyph codepoints (reference
post-processed like the live page), and — since Phase 1 — ABSOLUTE staff tops
against Composer's placement rule applied to the reference's systems
(`placeFor` on the reference host: their extents, the rule), plus a
self-consistency check that the live page is placed by the same rule over its
own extents; section-title bands via `hdrTitles`. Header pages are verified
like any other with nothing subtracted. This gate attaches a host by design —
it is a test-mode verification, not the splice. Render errors are logged and
re-thrown under the flag — a caught throw is not a gate. `pnpm test:composer`
does NOT set the flag; run `HKL_INDEX_CHECK=1 node test/composer-test/run.mjs
full`.

## Verification

- **Suite** (~4 min under the flag): the page-splice fixtures cover every
  mechanism above — B2's are `pageSpliceNewLineAtEnd` (N→N+1),
  `pageSpliceNewPageAtEnd` (spill onto a created page), `pageSpliceLineMerge`
  (N→N−1), `pageSplicePageCollapse` (page count −1, renumbered) and
  `pageSystemSpliceCascadeOverflow` (a spill moves the tail onto the next page); the courtesy stub's are `pageSystemSpliceCourtesyStubChain` (two
  consecutive signature lines: one stub measure, the second line stays out)
  and `pageSystemSpliceCourtesyStubAfterEnding` (ending closure first, then
  the stub); Phase 1's are `pagePlacementOwned` (every mounted page satisfies
  live tops == rule over live extents, after the derive and after a splice),
  `pagePlacementTextTopped` (a tempo-topped first system: below the header,
  never higher than without the text) and `pageSpliceNoPbPins` (a page-first
  hunk from a one-page window, placed like the next page's first); each landed
  with its bug or feature and was run against the
  unfixed source (`test/composer-test/run-unfixed.sh <fixtures>` stashes
  `apps/composer/src`, runs, restores). A visual mismatch appends
  `window.__visualDiag` (fixture-recorded geometry) to its detail.
- **Sonata gates** (`test/composer-inspect/phasec/`, README there):
  `cb-splice-battery.js` (8 edits, whole-document reference compare — the
  behaviour gate, run on both code states), `cb-sweep.js` (every line once
  through the real IntersectionObserver: hit rate, refusal histogram, latency,
  viewport drift — READ THE VIEWPORT COUNTERS, not only the
  hit rate: `pageBoxChanged`, `scrollHeightChanged` and the next-page anchor
  must be 0; they were 0 on 2026-08-31, nobody read them again until
  2026-09-02, and the 90 px header-page jump had been in them since A8), `allmeasures.sh` + `allmeasures-report.mjs` (every measure;
  the only way to reach multi-line replaced-set classes), `cb-ctxdiverge.js`
  (root-cause a context refusal in one run), `cb-splicecost.js` (steady-state
  attribution: phase-tagged buckets, forced-flush detection with call sites),
  `cb-pathprofile.js` (text vs bbox geometry side by side over every line — the
  A11 proof; re-run after any change to `systemProfile` or to what the snaps
  rewrite), `cb-placement.js` (every sonata page: each system's staff frame,
  bbox extents and header reserve against the placement rule — the Phase 1
  calibration on the pre-ownership build and the self-consistency check on the
  owned one; diff two runs for the per-system before/after table), `cb-checkcost.js` (test-mode overhead attribution), `cb-bigrange.js`
  (large governed ranges). Measurement probes whose findings are recorded in
  decisions.md and are not routine gates: `cb-scale.js`, `cb-naturalsalt.js`,
  `cb-windowalt.js`, `cb-svgopts.js`, `cb-naturalspath.js`, `cb-govdiag.js`.

## Where the time goes (2026-09-02, Chromium, sonata, instrumented)

Steady-state one-note edit ≈ 144 ms (`cb-splicecost.js`; wrapper overhead
inflates walls, read shares). Splice ≈ 90: Verovio window `loadData` +
`renderToSVG` ≈ 84 (two window pages, 20 measures — since the courtesy stub
this default position is 15 measures, window ≈ 78–82 — the window's shape is
the lever, since Phase 1 a pure gate question (plan Phase 3); drawing, not
layout: `loadData` is ~0.6 ms/measure, `renderToSVG`
3–4.5, and the first draw after a load carries the lazy layout); `spliceDom`
≈ 10 (imported-system post-processing 5.5 sharing the snap's flush, snap 1.8,
text profiles + imports ≈ 3). Refill ≈ 33, all the naturals window (its
`renderToSVG` ≈ 15 dominates; the DOM side is a parse). Outside the render
≈ 22: mutation ~10, overlay-height read ~6 (paint layout brought forward),
`cursor.update` ×2, dispatch. The history snapshot is off the keystroke.

An overflow event (B2) costs one more small window: the spilled block is
rendered again, page-first, in the cascade step — plus the mount pass when it
lands on a created page. Sonata `append-at-end` (new line + spill onto a new
page 31) ≈ 700 ms wall in the battery's worst-case mounting; the small-doc
fixtures land a move in the same budget as a plain splice.

Large governed ranges: 17 lines / 78-measure window ≈ 1.2 s; 25 lines / 106
measures ≈ 1.3 s. The naturals window is ~5.5 ms/measure and the window render
~5 ms/measure, ~85% of both Verovio's draw; they scale with the range.

Before/after bucket detail and the shape experiments (leader/trailer, pinned
naturals, SVG options) are in decisions.md (2026-09-01 "A thread measured",
2026-09-02 "For the record").

## Open work

- **Cascade on the model** (vertical-ownership plan Phase 2; START HERE 2) —
  DOM-transplant steps placed by the rule, the continuation past the mounted
  set as an idle extents job beside adoption. The fold is already predicted
  (Phase 1); the steps' measuring is what goes.
- **Vertical ownership plan** —
  [composer-vertical-ownership-plan.md](composer-vertical-ownership-plan.md);
  Phases 0 and 1 landed 2026-09-02 (D1 groundwork → D1 placement); Phase 2
  (cascade on the model) next, then Phase 3 (the window's shape, a pure gate
  question), then Phase 4 (distribution, D1 proper).
- **B2 dated bails** (START HERE 5): header measure removed; single system
  taller than a page.
- **D1 groundwork and placement landed 2026-09-02**: a section header's
  reserve is page budget and Composer places every system by one rule over
  measured extents (Ownership, above) — the injector only draws, a page that
  no longer fits below its headers spills into the cascade, a spilled header
  line carries its title. What remains of D1 is the distribution rule itself:
  slack within the fixed budget (Phase 4; only `placeSystems` changes).
- **C2** — first-page credits: composer/footer changes still derive (rare).
- **A3** — collapse the two `cursor.update` calls (~1.6 ms; blocked on the
  `onStateChange`-before-`onChange` bridge ordering).
- **A5** — worker-offloaded castoff `loadData` (~1.4 s on the derive); the
  remaining latency lever once the window's shape (Phase 3) is settled.
- **Test-mode residual** — `assertVoiceIndexConsistent` ×
  `getMeasureStartCursorUncached`: 0.7 s per index build on the sonata under
  the flag. Tolerable; not O(edit).
- **D. Tuning and features (Max's call)**: D1 vertical distribution within a
  page (the page-fit model and extents exist since Phase 1 — Phase 4 changes
  `placeSystems` only); D2 FIT_MAX / MIN_FILL
  to taste (legality bounds, not packing targets — note that FIT_MAX 1.45
  admits lines Verovio compresses to ~0.7 and warns about below 0.8, seen while
  composing at the end of a score; and whether a PAGE should have a minimum
  fill, which B2 deliberately left out: deletions leave their slack); D3 explicit "reflow document" command (reflow is path-dependent);
  D4 explicit move-measure-between-systems commands. Noted, not fixed: a clef
  set on an EMPTY layer does not roundtrip (`<clef/><space/>` loads back as
  `<space/><clef/>`).
- **Dead ends (do not retry without new evidence)**: pinned-lines naturals;
  `svgRemoveXlink`; naturals from the splice window's justified render;
  `getBBox` call-count reduction; leader/trailer removal (~3 ms, gate-only).

## Status log

One line per landing; the reasoning is the dated decisions.md entry.

- 2026-09-02 — Phase 1, Composer owns height: `render/pagefit.ts` + `Renderer.placePage`
  on every mount and splice; the vertical plan, `dyFollow`, the header-reserve
  arithmetic and the window's `<pb>` pins are gone; reference gate and fold
  read the rule. Sonata: 92/116 systems within 1u of Verovio's placement, max
  5.1u; page 1's title gains clearance.
- 2026-09-02 — Courtesy stub (vertical-ownership plan, Phase 0): the courtesy-
  generating line enters the window as its first measure only; proof over all
  116 sonata positions identical, extension windows −4.3 measures / −17 ms.
- 2026-09-02 — Section headers are page budget: the injector stops growing the
  viewBox (header pages were drawn ~3 % small, then jumped 90 px on their
  first splice — found by the sweep's viewport counters), a header line that
  spills migrates its title, mount-time repairs are reference-gated under the
  flag. Sweep 115/115, splice median 250 ms (99–459), nothing derived.
- 2026-09-02 — B2: the replaced set is a line hunk (N→M), pages carry by line,
  overflow is repaired by a measured cascade (lazy at the mount boundary), pages
  are created and removed in place. Battery 10/10 incl. append-at-end (new
  page) and delete-whole-line; five fixtures.
- 2026-09-02 — A11: text-based profiles on both sides, window never laid out,
  imported systems post-processed in place. Proof 126 edits / 117 splices,
  verdicts identical. Steady edit 214 → 144 instrumented; battery walls halved.
- 2026-09-01 — Owner bug: a finished adoption task's queued idle step
  re-committed a stale one-line partition (intermittent suite failure); commit
  is now current-task-only, once.
- 2026-09-01 — A7 layout-free naturals, A8 scoped post-processing (exposed the
  host-layout floor), A9 raw SVG, A10 lazy history snapshot: 258 → 214.
- 2026-09-01 — A thread measured before building; test-mode O(n²) fixed
  (large-range edit under the flag 45 s → 3.8 s; suite 13 → 4 min).
- 2026-09-01 — Size caps dropped (both splicers); signature changes govern
  RANGES; replaced lines never compared live; glyph-identity gates. Sonata
  115/115, 420/420, 8/8.
- 2026-09-01 — All remaining sonata refusals root-caused and fixed.
- 2026-08-31 — B1 dy-cascade, B3 courtesy window, B4 section headers, B5 lazy
  mount, eviction, zoom-neutral unit 8, user page breaks, Phase D (edit path
  O(edit), 308 → 168 ms).
- 2026-08-30 — Line-break and pagination ownership (pins + encoded), conservative
  repartition, never-painted castoff bootstrap, contained system splice v1.
