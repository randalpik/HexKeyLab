# Composer page splice — living reference

Updated 2026-10-09. This is the **current-state** reference for page-view
incremental rendering in Composer: what the machinery is, the rules it enforces,
how it is verified, what it costs, and what is open. History is not repeated
here: every design choice with its rationale is a dated entry in
[decisions.md](decisions.md) (2026-08-29 onward), every dead end and trap is in
[lessons.md](lessons.md), and the code comments carry the local reasoning.
Companions: [composer-spot-splice-design.md](composer-spot-splice-design.md)
(scroll splice) and [composer-render-perf.md](composer-render-perf.md).

## ► START HERE

Page view is ASSEMBLED by Composer: every system is a Verovio line window,
Composer draws the pages, decides which systems share a page (first-fit over
their measured extents), places them, and on an edit re-engraves only the
lines the edit reached and re-fits the pages from the first one affected.
Composer owns the line partition, the pagination and every vertical position;
Verovio is asked for the horizontal layout of a window of lines and nothing
else. There is no castoff and no full page render left in page view.

**Where it stands (2026-10-09, 446-bar sonata, headless Chromium):**

- Every edit is a splice. Suite 601/604 under `HKL_INDEX_CHECK` on
  2026-10-09 — the three were visual baselines off by a deterministic
  one-level anti-aliasing flip (≤38 px, max channel delta 3, at ledger-line
  ends and one brace) from the 10-08 profiling changes, reseeded 2026-10-09
  without a bisect (lessons.md; the gate stays sha1-exact). Checked sweep 114/114
  lines with the reference gate ON (0 divergences); battery 10/10;
  `cb-commands` 21 of 25 mutating commands
  splice, 3 apply a partition line by line (page break 258 ms, key change
  296 ms, pickup 1.3 s), 1 is the all-lines edit by nature (add instrument);
  NO derive remains. Section header 152 ms, meter change mid-piece 172 ms, a
  head meter change (every measure to the next change) 785 ms, all spliced.
- Steady one-note edit ≈ 120–160 ms (`cb-splicecost.js` steady 118–130 ms:
  render 95, splice 55, refill 38, naturals 34; unchecked sweep median
  124–165 ms). Window = leader? + hunk + courtesy stub? + trailer?.
- Load: the whole document assembles in 5.1–5.6 s (Verovio 2.1 s in 20
  six-line windows, post passes 0.9 s, the rest parse/measure/slices), the
  first page paints at 0.17 s, every page card exists from the first paint,
  a page being built is not painted. Zoom rescales in place: 0.93 s, zero
  Verovio loads. Firefox is Max's to measure (20+ s before the 2026-10-08
  profiling round; `docs/composer-render-perf.md` → Tier 4 has the levers).
- Vertical ownership is complete: minimum-clearance placement (rule v1) plus
  per-page distribution (rule v2: 14u max gap, a 10u top gap only as a last
  resort, page 1 exempt), the running footer in the bottom margin, the fold at
  the content column, and the crisp snap applied once, as output.
- Pagination is owned for real (2026-10-08, composer-pagination-design.md):
  first-fit over the `ExtentsStore`, pages first-fit from one page BEFORE the
  first affected line (a shrunk first line may go back to the page it left),
  rebuilding only the pages whose membership — start AND end — changed; the
  fresh-load reference gate (`cb-refgate.js`) is exact on all 31 pages.

**Governing principle (Max, 2026-09-01):** *"The goal is to hit O(edit) in ALL
cases. Any time the user is exposed to O(document) on a live path when they
didn't ask for a change to the full document is a failure, full stop."* A
fallback is never an invariant; anything that currently derives or full-renders
is a defect with a date on it.

**Read next.** Architecture → Ownership (partition, pagination, height), The
system splice, Reference gate. Verification for the gates and how to read a
failure. Open work for what is actually open. History is the Status log, with
the reasoning in [decisions.md](decisions.md) and the traps in
[lessons.md](lessons.md).

**Standing traps.**

1. **Snapping is an output transform, never an input.** A system's crisp
   nudge is applied once, when its translate is emitted; positions accumulate
   down the page unsnapped and the distribution level is solved on unsnapped
   geometry. A snapped value that feeds a later position turns sub-pixel
   nondeterminism into a cumulative drift (lessons.md, 2026-09-04).
2. **Placement is non-local within a page** (rule v2): the level is solved over
   all of a page's gaps, so every path that changes a page's system set must
   re-place the whole page (lessons.md, "Rule v2 made placement non-local").
3. **Never edit `apps/composer/src` while the suite or any phasec probe runs
   against the dev server** — Vite reloads the page and the run dies or lies.
   Docs, fixtures and probe files are safe at any time.
4. **No `pnpm build` and no second Chromium job alongside the suite**: a visual
   fixture once shot mid-relayout under a concurrent build; the phasec runner's
   300 s deadline times out under a concurrent suite. Long probes are chunked
   (`from=`/`limit=`), not sampled.

**Before declaring an edit-path change done:** battery on both code states
(stash / pop — identical splice/skip outcome per edit and `reference.ok`);
the full suite under the flag; `cb-splicecost.js` for the wall; the gated sweep
in chunks (`cb-sweep.js --arg "check=1,from=N,limit=24"`); `cb-commands.js`
(no command may start deriving); and, for anything that touches the window
recipe or the assembly, `cb-refgate.js` (every page of a fresh load against a
full engrave) and the `pag_*` fixtures. Any visual
disagreement goes to Max as a diff HEATMAP, never two images
(`test/composer-test/heatmap.py`, procedure in `test/composer-test/README.md`)
— surfaced before any numbers, uncropped, and labelled with WHICH pair:
baseline-vs-output only says the rendering changed; the defect question is
spliced vs a full re-engrave, which `run.mjs` shoots automatically on a
non-visual failure.

## Architecture

### Ownership: lines and pages (`render/linebreaks.ts`, `PageLineBreaks`)

- **Composer owns the partition and the pagination.** Every system start is
  pinned as an encoded `<sb>` (page starts as `<pb>`, replacing the `<sb>`) at
  render time only — nothing is stored in the model. Display renders use
  `breaks:'encoded'`, the only mode that honors pins verbatim. Pins after an
  `<ending>` wrapper go INSIDE it.
- **One break algorithm everywhere — and no castoff (2026-10-08).** The derive
  seeds the partition from Composer's own naturals (`seedPartition`: each
  section filled greedily at cap 1.0), the balancer computes it, and the pages
  are then ASSEMBLED from measured systems (`render/pageassembly.ts`): each
  line is rendered alone from a window (`render/systemrender.ts`, the
  splicer's recipe), post-processed and measured where it sits in a hidden
  Composer-drawn page shell (`render/pageshell.ts`), and the page closes when
  the next system fails the minimum-placement fold — first-fit, pure in the
  extents, a user `<pb>` a hard start. Nothing is adopted from Verovio and
  nothing is painted from a guess; the `<pb>` pins survive only for the
  reference gate's Verovio page. Until then Verovio's castoff seeded the lines
  AND its page starts were carried by line index onto the balanced lines
  (`balanceInitialBand`), which made it a second authority for pagination —
  the sonata's m. 76 "cresc." could flip a page boundary nobody could see
  move (lessons.md). The extents job and the lazy adoption task are gone with
  it: the assembly fills the `ExtentsStore` itself, in document order.
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
  paper; a page is legal when its components fit. Since 2026-10-08 the page
  header is Composer's too (`pageshell.ts`: title block / page number +
  running title at Verovio's header geometry, ink bottom recorded from the
  nominal em-boxes), and a page's system set is decided by first-fit over
  the measured extents — a splice re-runs it from one page before the first
  touched page (`PageAssembler.repaginateFrom`, both directions; the rebuild
  window is trimmed to the pages whose (start, end) membership changed, kept
  pages renumbered) in place of the overflow-only cascade.
- **A page distributes its own slack** (rule v2, 2026-09-04). The clearances
  above are MINIMUMS; on top of them each page shares out what it has left.
  The gaps that equalize are the inter-system gaps AND the gap between the
  last system and the bottom of the content column (the bottom-margin line) —
  their sum is fixed by the systems' own heights, so an ordinary page divides
  it evenly. The level is the L solving `Σ max(gap_k, L) + L = C`, not `C / n`,
  because a gap already wider than L by its own clearance cannot be
  compressed. It is capped at `maxGap` 14u: a page too sparse to fill is left
  sparse rather than smeared. The page-header → first-system gap is NOT an
  ordinary participant — it opens only when the level clamped at `maxGap` AND
  the bottom gap still exceeds `maxGap`, to at most `topMax` 10u, and never on
  page 1, whose first system keeps its distance to the title block. The
  running footer lives in the BOTTOM MARGIN (`FOOTER_Y`), so the column bottom
  is the column bottom and adding or removing a footer cannot change
  pagination. ORDERING: pagination is judged on the minimum-clearance
  placement and only then is the page distributed — `placeSystems` takes the
  distribution as an argument, `placePage` and the reference gate pass it,
  `foldOf` and `predictFoldFromStore` do not, since feeding a distributed
  placement to `foldIndex` would be circular. CONSEQUENCE: placement is
  non-local within a page, so every path that changes a page's system set must
  re-place the whole page (trap 0 in START HERE).
- **Ownership extends to the staff** (Phase 3.5, 2026-09-04). `alignStaffRows`
  spaces a system's staff rows a whole number of device pixels apart RELATIVE
  to the system's first row, and `placeSystems` carries the crisp phase so that
  first row lands on the device grid. Both run BEFORE `measureExtents`, so
  `above` is a property of the music and not of the render's origin. The
  separate post-placement snap has nothing left to do on the page path.
- **Zoom is layout-neutral AND render-neutral**: the crisp presets share
  `unit: 8`, so all zooms produce one partition (the partition cache is keyed
  on unit, pageScale, heji + document version; `cb-zoomunit.js` guards it),
  and the inner SVG coordinates are identical at every zoom, so a zoom
  renders nothing — `PageAssembler.rescale` resizes the shells, re-runs the
  post passes and the placement per page, and keeps the reader on the same
  page (2026-10-09; `pag_zoomRescalesInPlace`). Page scale changes the layout
  budget and still assembles.
- **User page breaks** are hard page starts for first-fit (and section
  boundaries for the balancer); a break splits its line. A page break, a
  section header and a pickup are LINE-START EDITS the refill carries like a
  lock (2026-10-08): an added one splits its line, a removed one examines its
  neighbours so the remnant is repaired; a page break with no line change
  still re-fits pages from its page (`breaksChanged`).

### The refill (`tryRefill` → `repartition`)

1. **Changed run** by prefix/suffix diff of per-measure serializations against
   an owner-held baseline. The baseline is incremental: a `MutationObserver` on
   the live document marks dirty measures and only those re-serialize
   (mutations above measure level mark everything dirty).
   TWO runs, from two diffs (2026-09-02): the FULL signature is the measure's
   serialized XML and answers "must this be REDRAWN"; the FLOW signature
   (`measureFlowSig` — the same XML with the measure's own `@n` stripped)
   answers "must its line be RE-FLOWED". They differ for one common shape:
   `renumberMeasures` is section-aware, so inserting a measure reports every
   measure to the end of its section as changed. Those lines really do need
   redrawing — measure numbers are rendered, one per line start — but a number
   is an overlay label above the staff, so no width and no line fill moves.
   The FLOW run drives the repair and its naturals; the FULL run is what the
   splicer replaces. An insert at m8 measured 137 naturals before, 19 after.
2. **Signature ranges** (`render/sigranges.ts`, both splicers): head and
   interior scoreDef key/meter changes and inline clef changes become the range
   they govern — to the next reset of the same kind on the same staff, one
   measure early (the predecessor takes the courtesy or the relocated clef
   glyph), inclusive of a mid-measure reset clef's measure — unioned into the
   run BEFORE repair. A head-context change (`rest`: staffDefs, elements
   before the first measure, credits) is the ONE all-lines edit — add
   instrument — and goes through the lazy assembly as `all lines (head
   context changed)`, never a different code path. Namespace declarations are
   not structure.
3. **Repair, never re-derive** (Max, 2026-08-30): the partition is carried by
   MEMBERSHIP (each old line keeps its first surviving measure), then only lines
   that became illegal are repaired, one measure across one boundary per step.
   Legality = fill ∈ [MIN_FILL 0.65, FIT_MAX 1.45] — bounds set in 2026-08 to
   contain Verovio's castoff envelope (0.706–1.426) and kept as the one
   legality rule the seed (`seedPartition`, since the castoff went) and the
   repair both answer to. Hard (user) breaks never move. Reflow is path-dependent by
   design; undo restores the layout exactly; a no-op edit moves nothing.
   **Section balancing** (`render/balance.ts`, 2026-09-05) is the repair for
   the one illegality this loop cannot fix — a SECTION-FINAL line below
   MIN_FILL, which has no next line to pull from: the seed's remainder (a
   lone bar before a movement break, a one-bar stub at the end), or what a push
   or deletion leaves at a section end. The section (lines between two hard
   starts) is redistributed: merge rule first (a sparse final line folds into
   its predecessor while the merged fill ≤ `MERGE_MAX` 1.2), then a DP
   minimising Σ(fill−mean)² at the current line count with every line legal,
   plus `BALANCE_LAMBDA` 0.02 per moved boundary while the section is on screen
   (0 when none of its lines is mounted). No legal partition → the repaired
   partition stands (document-final: the stub, unjustified — rule 2). On a
   load the whole document is balanced before anything paints
   (`balanceInitialBand`, after `seedPartition`'s greedy fill); in the refill
   it runs after the repair loop for the touched sections, BOUNDED to each
   section's suffix from the first line of the edit's PAGE (2026-10-08): an
   edit never reaches a page before it, while inside the edit's page the
   section is still balanced whole, so a one-page document behaves as before.
4. **Naturals** (unjustified measure widths) come from `breaks:'none'` window
   renders (the dirty range plus two left + one right context measures,
   spanners and endings whole), cached per measure id; the whole dirty range is
   measured in one window before the repair loop. A natural is the measure's
   staff-line path extent read from the SVG text via `DOMParser` — the window
   is never attached or laid out. Only `sigW` (the leading clef+key width,
   applied to every line's fill as a document-level constant) needs glyph
   metrics; it is measured with `getBBox` on an attached host only when the
   window's folded head (the sub-MEI before `<section>`, which alone determines
   the leading signature) differs from the head that last measured it. A long
   governed range is measured in windows of `ENSURE_CHUNK` (96) measures and
   the repair step cap scales with the lines examined (2026-10-08): the cost
   of a range is the range's, never a refusal.
5. **Pages are carried by LINE, inside the repair** (B2): a page keeps the line
   its old start carried to (membership), tracked as a line index through the
   repair loop (an inserted line shifts later pages' indices), so a surviving
   line never changes page because of an edit. A page whose every line vanished
   collapses into its successor. The carried pagination is PROVISIONAL: it
   tells the splicer which page each hunk line lands on; the pages are then
   first-fit over the extents store from one page before the first affected
   line (`PageAssembler.applyPartition`, below), which is where a page's
   system set is actually decided — pull and push are one predicate.

### The system splice (`render/pagesplice.ts`, `PageSystemSplicer`)

Runs on EVERY refill with a live page DOM (B2: no `line count changed`
refusal, no `paginationHeld` bypass). Replaces whole systems in place;
everything else on the page is untouched or re-placed. The renderer hands it
a `SpliceRequest` — old/new partition, old/new pagination, the changed run.
When it refuses, or when the change is not a hunk at all (a page break on an
existing line start), the renderer applies the partition line by line instead
(`PageAssembler.applyPartition`, below) — never a full render on an owned
document (2026-10-08, "Every edit is a splice").

- **Replaced set = a line HUNK** `old [a..bOld] → new [a..bNew]` (B2): the
  prefix/suffix diff of old vs new start ids (a changed boundary pulls the line
  above in — its extent moved), unioned with the changed run — one measure left
  when its first measure holds a layer clef (relocation), closed once over
  spanners with an end inside the run and over `<ending>`s, then to lines.
  Lines outside the hunk are identical on both
  sides, so the two coordinate systems agree there. Live systems are located by
  OLD start ids (even a deleted start measure is still in the pre-edit DOM);
  the window is built from NEW lines. Every old line must be in the DOM: an
  assembly still in flight is finished first (`finishSync`, before the refill
  even runs — the refill carries page starts by membership and must see the
  whole list, not a prefix).
- **Target pages**: each new line goes to the page the NEW pagination assigns
  it. A page that keeps a line outside the hunk is found through that line
  (the mounted context line on it); a page made only of hunk lines is the page
  its first line's measure sits on now (a moved start id, or a collapsed
  predecessor's successor). The splice never creates a page — a spill past the
  last page is the first-fit's. A source page left without systems is reported
  as emptied; the renderer removes it and renumbers the rest (`removePage`).
- **Clipped to the MOUNTED BAND** (2026-09-02). The replaced set is computed
  in line space over the whole document, so a wide changed run used to reach
  pages nobody had mounted: B5 DREW all eight of them (834 ms) so one window
  could re-engrave 146 measures (650 ms), synchronously, for an edit on page 1.
  A line on an unmounted page needs no DOM work — the pins are committed
  document-wide, and a page marked stale redraws from them on mount — so the
  splice processes only the lines whose old AND new page lie in the maximal
  contiguous run of mounted pages containing the edit (page granularity keeps
  those lines contiguous, which the window needs) and DEFERS the rest:
  `lastDeferredPages` are marked for rebuild (`markDeferred`) and any still
  drawn are returned to placeholders, because a drawn page holding pre-edit
  systems under post-edit pins is what `verifyRenderedPartition` rightly fails
  on; such a page re-renders from its committed lines on mount
  (`rebuildPage`), followed by a first-fit from it. B5's eager mount survives
  for the edit's own neighbourhood (lines a−1..a+1) so an evicted cursor page
  is still drawn.
- **Window**: the hunk lines ONLY — no context lines since Phase 3
  (2026-09-03) — plus, when the line beyond begins a
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
  - *Context lines* — there are none (Phase 3, 2026-09-03), so the live
    fidelity comparison that rode on them (per-measure x/width within EPS 25,
    identical signature glyph codepoints, `sigGlyphDiff`) is gone. It compared
    L−1 and L+1 only, detected nothing the reference gate does not, and masked a
    subset of the splicer's own replaced-set defects as slow renders — a
    fallback, not an invariant (Max). The REPLACED lines are what the edit told
    Verovio to redraw; the reference gate verifies them, and the stub, spanner
    and ending closure rules ARE the cross-measure dependency list, made
    executable (decisions.md 2026-09-03). The live neighbours are still read,
    but only as DOM structure (which page a line is on, the insertion anchor,
    the partition-drift detectors).
  - *Vertical position*: none is read from the window (Phase 1). After the
    surgery every touched page is handed to `Renderer.placePage`, which
    measures each system where it now sits and places the whole page by the
    rule (Ownership, above) — the imported systems in their new frame, the
    survivors unchanged, so a follower or a page that lost a system moves
    exactly by what the arithmetic says.
  - *Section headers across the hunk*: WHERE a title sits is the placement's
    (its band is a component); WHICH PAGE it is on is the splice's: a title
    whose line moves to another page (a cascade block carrying a header)
    migrates to that page's margin, and a title whose measure the edit
    deleted is removed (Phase 2: a header is a component of the model —
    deleting its measure removes the component; the former `section header
    measure removed` bail is gone).
  - *No size caps*: a window costs linearly in measures up to the whole
    document, so a subset render is never the worse deal.
- **Surgery**: per target page, import the new systems (horizontal frame
  only) before the first old hunk system on it (else before the page's first
  system, else append — `mergeGlyphDefs` per page from the parsed window's
  `<defs>`), remove the old hunk systems, post-process the IMPORTED systems in
  place — crisp barline and right-edge snaps, notehead z-order, HEJI, theme,
  scoped to the imported systems, in the live page's own device frame — then
  `placePage` on every touched page (staff rows phase-aligned BEFORE extents
  are measured; the crisp nudge is the emitted translate itself — there is no
  post-placement snap pass since Phase 3.5, and positions accumulate unsnapped
  since 2026-09-04); the renderer then removes emptied pages, marks deferred
  pages for rebuild, re-runs the mount hook on every touched page (a new
  section title is injected), and first-fits the pages from one before the
  first touched (`repaginateFrom` = `applyPartition` with nothing to render).
  The surgery costs ONE layout flush; the placement's `getBBox` reads share it. Diagnostics on the splicer: `lastOutcome / lastSkipReason /
  lastRun / lastWindow / lastWindowMei` (`lastVertical` is always null now),
  and on a context refusal `lastContextDiff`. `Renderer.lastPostStats` times
  the post-processing passes.
- **Pagination after a splice — `PageAssembler.applyPartition(oldLines,
  changedIds, touched)`** (2026-10-08, replacing the overflow-only cascade).
  The ONE edit operation. `oldLines` is the partition the DOM renders,
  `lines()` the one the refill committed, `changedIds` the lines the changed
  run reaches (`Renderer.changedLineIdsFor`: the run's lines, one line earlier
  when the run's first measure holds a layer clef; a signature range already
  starts one measure early). A line is re-rendered when it is in that set or
  when its member set differs from what its system was drawn with (same
  start, different end): the fresh system is engraved into a hidden staging
  shell, post-processed and measured there, exactly as the assembly measures
  a line. Every other line is reused from the DOM with its stored extents.
  Pages are then first-fit (`firstFitLines`: rule v1 fold, a user `<pb>` a
  hard start, 2 device px of tolerance) from one page BEFORE the first
  affected line — a changed line that starts a page may have shrunk enough to
  return to the page before it, and pagination must be the same for the same
  extents whatever the edit history — and the old and new page lists are
  compared by MEMBERSHIP (start AND end, and no re-rendered line inside) from
  both ends; only the window between is rebuilt (systems and their titles
  move between shells with their glyph defs, `moveSystems`; pages are created
  or removed; later pages are renumbered), every rebuilt page is placed by
  rule v2, revealed and furnished. A page start the owner dropped (a balance
  that shrank a section's line count) does not survive: every built page past
  the window is torn down when nothing is kept. Diagnostics: `lastRepaginate`
  (`fromPage`, `rebuiltPages`, `movedSystems`, `renderedLines`), mapped onto
  `Renderer.lastCascade` for the probes; the ledger outcome is `applied` when
  the splicer refused and this ran, `spliced` when it followed a splice.
- **The assembly, the cards and virtualization** (`render/pageassembly.ts`,
  `PageAssembler`; composer-pagination-design.md). A load (or a page-scale
  change, a view change, a new document, add instrument) assembles: line 0
  renders into a hidden shell (`score-page-building`, `visibility: hidden` —
  a page's content appears only once its systems are placed), the post passes
  run on it where it sits, its extents go into the `ExtentsStore`, and the
  next line is tested against the minimum placement; when it does not fit
  the page closes (placed, revealed, furnished, its start committed with
  `setPageStarts`) and the next opens with that system moved in. Synchronous
  until the cursor's page closes, then 60 ms macrotask slices. Verovio
  renders `CHUNK_LINES` (6) lines per window (`renderLineSystems`, never
  across a change in the hidden-staff set; a prepared chunk is dropped when
  the document version moves on). Every expected page has a sized card from
  the first paint — the same document's previous count on a zoom or page
  scale, the cached pagination's count on a round trip (stored only when an
  assembly was complete), else page 1's estimate made inside the synchronous
  burst — the open page takes over its placeholder in place, and the count
  is corrected only when the assembly ends with a different total. A closed
  page outside the mount window is PARKED (root detached, sized placeholder
  left) and re-attached on mount — no render; an unbuilt card stays blank
  until the assembly reaches it (the scroll path never builds synchronously;
  the cursor's page, an edit and the export do). A same-document re-assembly
  scales the kept scroll by the card-height ratio. Zoom does not assemble at
  all: `rescale` (Ownership, above). The mount pump, the mount window and the
  IntersectionObserver are unchanged in shape. Test hooks: `runExtentsJobNow`
  (finish the assembly + rebuild deferred pages), `pageVirt` (the assembler),
  `extentsJobState` (always null — the idle extents job is gone: the store
  is filled by the assembly and overwritten only for a splice's hunk).

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

After every splice or applied partition — once the first-fit has settled,
against the owner's CURRENT pins — a fresh full render of the pinned MEI is
compared against every page the splice touched or `applyPartition` rebuilt
(and, on a fresh load, every page: `cb-refgate.js`): system sequence,
per-measure x/width (TOL 10 — one device pixel, since Phase 3.5),
clef/keySig/meterSig glyph codepoints, a per-measure glyph-CLASS census and a
per-system RESIDUE census (reference post-processed, decorated and
phase-aligned exactly like the live page — `postProcess`, `decorateHost`,
`alignStaves`; a probe that skips any of the three reports a defect that is
not there), and — since Phase 1 — ABSOLUTE staff tops against Composer's
placement rule applied to the reference's systems, DISTRIBUTED on both sides
since rule v2 (`placeFor(systems, { distribute: true, pageNo })`), plus a
self-consistency check that the live page is placed by the same rule over its
own extents; section-title bands via `hdrTitles`. On a staff-top divergence
the error names both sides' extents and placed tops for EVERY system on the
page, so a per-gap constant (a level disagreement), a page shifted by a
constant (a frame error) and one system out of place (an extents error) are
distinguishable from the message. The accepted residual is one device pixel on
a single system — Verovio places content ~2 units differently between a
windowed and a full render, snapped once (decisions.md, `TOL` 10; not to be
revisited). Header pages are verified
like any other with nothing subtracted. The reference is RELOADED before each
page after the first: post-processing a reference page runs the hide-empty
substitution, which engraves a one-line window on the same toolkit and used
to replace the loaded reference ("reference lost page 8", 2026-10-08). This
gate attaches a host by design —
it is a test-mode verification, not the splice. Render errors are logged and
re-thrown under the flag — a caught throw is not a gate. `pnpm test:composer`
does NOT set the flag; run `HKL_INDEX_CHECK=1 node test/composer-test/run.mjs
full`.

## Verification

- **The SPLICE invariant** (2026-09-02): every fixture's own renders are
  recorded (`Renderer.renderLedger`, cleared after the setup builds its
  document — after a deferred setup render has landed, and BEFORE the failure
  shots) and a full engrave among them FAILS the fixture. Exemptions:
  `single-line partition` (a one-system document always derives, which most
  fixtures are); `forced full render (<cause>)` — `forceFullRerender`'s
  callers: new document, setup apply, view staves, zoom, page scale, string
  render; `all lines (head context changed)` — add instrument; and a fixture
  declaring `fullRender: '<reason>'` for a load or forced render it performs
  on purpose. No fixture asserts a derive of an EDIT any more (2026-10-08: the
  seven that did now assert the splice). The failure detail prints the render
  SEQUENCE (`F:<reason>@ms` / outcome), so a stray full render can be placed
  among the fixture's steps. This invariant exists because nothing asserted that a
  COMMAND splices, which is how Ctrl+M's 2.8 s derive survived unnoticed; the
  runner also prints the ledger triage and the slowest fixtures, so a slow or
  silently-deriving suite is diagnosable without a bisect.
- **Suite** (~5 min under the flag): the page-splice fixtures cover every
  mechanism above — B2's are `pageSpliceNewLineAtEnd` (N→N+1),
  `pageSpliceNewPageAtEnd` (spill onto a created page), `pageSpliceLineMerge`
  (N→N−1), `pageSplicePageCollapse` (page count −1, renumbered) and
  `pageSystemSpliceCascadeOverflow` (a spill moves the tail onto the next page)
  and `pageGrowFromOnePage` (the 1 → 2 transition, started from the BLANK
  document and deliberately NOT gated on `paginationOwned()` — that precondition
  is what blinded `pageSpliceNewPageAtEnd` to this state); the courtesy stub's are `pageSystemSpliceCourtesyStubChain` (two
  consecutive signature lines: one stub measure, the second line stays out)
  and `pageSystemSpliceCourtesyStubAfterEnding` (ending closure first, then
  the stub); Phase 1's are `pagePlacementOwned` (every mounted page satisfies
  live tops == rule over live extents, after the derive and after a splice),
  `pagePlacementTextTopped` (a tempo-topped first system: below the header,
  never higher than without the text) and `pageSpliceNoPbPins` (a page-first
  hunk from a one-page window, placed like the next page's first — compared
  UNDISTRIBUTED, since rule v2 legitimately moves each page's block by its own
  slack); `pagePlacementOwned` also pins snap-as-output (every system's crisp
  nudge ≤ half a device pixel from its unsnapped position, and `rawTop` must
  exist at all); the assembly's are the universal `assertPaginationFirstFit`
  (every mounted page neither overflows nor leaves room for the next page's
  first system) and the `pag_*` family — `pag_hideEmptyNoHole`,
  `pag_shrinkPulls`, `pag_growPushes`, `pag_userPbHonoured`,
  `pag_zoomRoundTripKeepsPages`, `pag_spillThenPullBack` (a spilled line
  returns when it shrinks back), `pag_courtesyAtLineEnd`,
  `pag_pageBreakSplices` / `pag_sectionHeaderSplices` /
  `pag_meterChangeSplices` (page 1's systems are the same DOM nodes
  afterwards), `pag_setupApplyKeepsSystems`, `pag_addInstrumentAllLines`,
  `pag_loadCardsUpFront`, `pag_zoomKeepsCardsAndScroll`,
  `pag_buildingPageHidden`, `pag_zoomRescalesInPlace` — with the pre-assembly
  cascade fixtures (`pageCascadePredictedFold`,
  `pageCascadeArithmeticPastMount`, `pageExtentsJob*`) rewritten to the
  assembly's semantics; each landed
  with its bug or feature and was run against the
  unfixed source (`test/composer-test/run-unfixed.sh <fixtures>` stashes
  `apps/composer/src`, runs, restores). A visual mismatch appends
  `window.__visualDiag` (fixture-recorded geometry) to its detail.
- **Sonata gates** (`test/composer-inspect/phasec/`, README there):
  `cb-splice-battery.js` (10 edits, whole-document reference compare — the
  behaviour gate, run on both code states; records EVERY deviating
  (page, system) in `reference.devs`, not only the worst, and
  `--arg "shot=<edit>,mode=spliced|reengrave,page=N"` leaves one page for a
  `--screenshot` so the self-consistency pair can be heatmapped),
  `cb-sweep.js` (every line once
  through the real IntersectionObserver: hit rate, refusal histogram, latency,
  viewport drift; with `--arg "check=1,from=N,limit=24"` the reference GATE
  runs on every position and its throw is recorded per row — without `check=1`
  the sweep verifies coverage and viewport stability ONLY, and "115/115" says
  nothing about splice-vs-re-engrave correctness; chunk with `from=`, never
  sample with `stride`, which read 0/23 where stride 1 read 4/25 — READ THE
  VIEWPORT COUNTERS, not only the
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
  (large governed ranges), `cb-commands.js` (the COMMAND inventory: every
  document-mutating user command, outcome + derive reason + wall — run it after
  anything that touches the refill's bails), `cb-insertpos.js` (insert-measure
  at a spread of positions: the probe that showed the cost was
  position-dependent), `cb-refgate.js` (every page of a fresh load against a
  full engrave — the window-recipe gate; run after any change to
  `renderLineSystems`, the courtesy rule or the post passes), `cb-pagefill.js`
  (page-by-page fold and slack of the assembled document plus the load
  stats), `cb-zoomtime.js` (a zoom round trip: ms, loads, outcome),
  `cb-loadprofile.js` / `cb-domcalls.js` / `cb-ctmattr.js` (where a full
  re-assembly's time goes, by function and by DOM call — the 2026-10-08
  profiling probes; `docs/composer-render-perf.md` → Tier 4). Measurement
  probes whose findings are recorded in decisions.md and are not routine
  gates: `cb-scale.js`, `cb-naturalsalt.js`, `cb-svgopts.js`,
  `cb-naturalspath.js`, `cb-govdiag.js`. Probes written against the castoff
  renderer may call internals that no longer exist; a probe that fails on a
  missing handle is stale, not a regression.

## Where the time goes (2026-10-09, Chromium, sonata)

- **Edit**: steady one-note edit 118–130 ms (`cb-splicecost.js`): render 95
  (the hunk window), splice 55, refill 38, naturals 34, DOM surgery 15,
  mutation 11, post passes 10. Unchecked sweep median 124–165 ms. The
  first edit after a load pays the in-flight assembly once (`finishSync`,
  ~7 s with the cursor deep — the load's own cost).
- **Structural edits** (`cb-commands.js`, cursor at m. 221): page break
  258 ms (applied), section header 152, meter change mid-piece 172, head
  meter change 785 (every measure to the next change re-flows — O(range) by
  nature), key change 296 (applied), pickup 1.3 s (applied), insert measure
  178, tempo 217; add instrument 11.8 s through the lazy assembly, the one
  all-lines edit.
- **Load** (a full assembly): 5.1–5.6 s for all 31 pages, first page 0.17 s.
  Verovio 2.1 s (20 six-line windows: `renderToSVG` 1.6, `loadData` 0.5),
  `DOMParser` 0.5, post passes 0.9 (ties 190, instrument gaps 180, text 150,
  snapBar 100, slurs 80), import + align + measure + fit ~0.4, serialize
  0.16, slice gaps ~0.4. The per-phase table, the remaining DOM-call counts
  and the next levers are in `docs/composer-render-perf.md` → Tier 4.
- **Zoom**: 0.93 s, zero Verovio loads, every system node kept
  (`rescale`).
- Before/after bucket detail of the 2026-09-02 edit profile and the window
  shape experiments are in decisions.md (2026-09-01 "A thread measured",
  2026-09-02 "For the record"); the 2026-10-08 load profiling is in
  lessons.md ("Profile the DOM calls").

## Open work

Only what is open. Landed work is in the Status log; reasoning in decisions.md.

- **What still assembles** (2026-10-09, after "Every edit is a splice"): a new
  document, a page-scale change, a view-staff change and add instrument
  (`all lines (head context changed)`) — each a load in all but name; a
  foreign document (line-start survival < 50 %); a single system taller than
  its page. User breaks, section headers, pickups and meter changes splice or
  apply now; zoom rescales in place.
- **Load cost** — the next levers (worker-rendered windows, a cross-pass box
  memo, chunk sizing, deferred cosmetic passes, query hygiene) are written up
  with numbers in `docs/composer-render-perf.md` → Tier 4. Firefox's number
  is Max's to measure.
- **A3** — collapse the two `cursor.update` calls (~1.6 ms; blocked on the
  `onStateChange`-before-`onChange` bridge ordering).
- **A created page's first layout scales with the mounted set** (~180 ms at 31
  mounted, 31 at 3) — measured in Phase 2, not yet attributed.
- **Test-mode residual** — `assertVoiceIndexConsistent` ×
  `getMeasureStartCursorUncached`: 0.7 s per index build on the sonata under
  the flag.
- **Test hygiene** — `test/composer-test/out/` is tracked in git; runner
  artifacts should not be (heatmaps and failure shots already go to tmp).
- **Tuning (Max's call)** — FIT_MAX 1.45 admits lines Verovio compresses to
  ~0.7 and warns about below 0.8 (seen composing at the end of a score);
  `maxGap` 14u and `topMax` 10u are the two distribution knobs, calibrated on
  the sonata; `BALANCE_LAMBDA` 0.02 / `MERGE_MAX` 1.2 / `INITIAL_BAND_PAGES` 2
  / `LAST_JUSTIFY_SLACK` 0.05 are the balancer's (decisions.md 2026-09-05).
- **Balancer residue** — a mid-document section too small to hold two legal
  lines is still stretched by Verovio (no option value helps; only an `<mdiv>`
  split could); undo after a push/merge does not restore the line count (as
  for every boundary-moving edit). The job's slices are ~250–420 ms of Verovio
  each — an idle callback's forced 1 s timeout can land one before a keystroke.
- **Features (Max's call)** — D3 explicit "reflow document" (reflow is
  path-dependent); D4 move-measure-between-systems commands.
- **Noted, not fixed** — a clef set on an EMPTY layer does not roundtrip
  (`<clef/><space/>` loads back as `<space/><clef/>`).

Dead ends are recorded where they were hit — lessons.md, and `placeSystems`
for the placement ones — and are not retried without new evidence: pinned-lines
naturals, `svgRemoveXlink`, naturals from the window's justified render,
`getBBox` call-count reduction, leader/trailer removal, quantizing per-system
placement terms, quantizing the distribution level.

## Status log

One line per landing; the reasoning is the dated decisions.md entry.

- 2026-09-05 — Section balancing (`render/balance.ts`): a section-final line
  below MIN_FILL is redistributed into its section (merge rule + λ-penalised
  min-variance DP at the current line count), synchronously for the first two
  pages before the paint, by an idle job for the rest (partition-only splice
  requests, deferred whole when unmounted), and on the edit path for touched
  sections with cached naturals. Sonata: 116 → 113 lines, movement minimum
  fills 0.16/0.56/0.32/0.25 → 0.81–0.84, page 1 unchanged after the job, sync
  band ≈ 0.8–1.0 s, job 5.7 s in 10 slices. `minLastJustification` moved to
  MIN_FILL − 0.05 (yardstick mismatch). Suite 392/392 + 4 balance fixtures;
  Node unit test `test/balance/run.mjs` on the sonata's measured widths.
- 2026-09-04 — Snap-as-output: `layoutSystems` accumulates on the unsnapped
  top and the distribution level is solved on unsnapped geometry; the crisp
  nudge is the emitted translate only. One system's ≤½-pixel rounding had been
  every later system's premise (a 2-pixel staircase on sonata page 18). Battery
  deviations 7 → 4, max 20 → 10; gated sweep 0/115 — the first sweep run with
  the reference gate on (`check=1`, chunked with `from=`). Three probe/gate
  drifts in the battery fixed (undistributed reference; no `alignStavesIn`; no
  `decorateHost`). Two baselines re-seeded (approved). Quantizing the level:
  measured dead end (7 → 13 deviations).
- 2026-09-04 — Phase 4, rule v2: each page solves one water level over its
  inter-system gaps AND the gap above the bottom margin, capped at 14u; the
  page-header gap opens only when that level clamped and the bottom gap still
  exceeds the cap, to at most 10u, never on page 1. The running footer moved
  into the bottom margin (it was inside the content column, costing every page
  10.1u and already colliding with the music on sonata pages 21 and 23) and the
  fold limit moved from the paper edge to the content column, which is what
  Verovio's castoff always used — pagination byte-identical either way. Sonata:
  26 of 30 pages uniform, top gap on exactly the four 3-system pages, footer
  0.378 in above the paper edge. Every-measure pass (allmeasures, 2026-09-04):
  420/420 edited at 100 % splice rate, 0 conflicts, 69 multi-line replaced sets
  with 0 failing, empty refusal inventory. Placement is now non-local within a page,
  which surfaced one path (`lazyMoveOut`) that shrank a mounted page without
  re-placing it. Suite 377/377.
- 2026-09-03 — Phase 3 + 3.5: the window drops its context lines (leader? +
  hunk + courtesy stub? + trailer?, nothing compared against the page) and
  ownership extends to the staff (relative row spacing + the crisp phase
  carried by placement, both before `measureExtents`); `TOL` 30 → 10. Window 3
  lines/15 measures → 1/7, Verovio 74.6 → 36.1 ms, steady edit 173.6 → 127.7.
- 2026-09-02 — An edit costs what is on screen: the replaced set is clipped to
  the mounted band (the rest deferred, stale, warmed by the idle job), re-flow
  split from re-draw in the sig diff, the user-break signature keyed on measure
  identity, and `insertMeasureAt`'s O(slurs × measures) endpoint scan made one
  pass. Insert-measure 2.9-4.1 s → 0.3-0.7 s; 19 of 24 mutating commands splice.
- 2026-09-02 — Phase 2, the cascade on the model: a step is a DOM transplant
  (no window), a last-page spill clones the spilling page's shell, steps past
  the mounted set are arithmetic over the `ExtentsStore`, an idle extents job
  fills it; `moveLines` and the splicer's page creation are gone. Battery
  identical both states, sweep 115/115 with `parkedSteps` 0, suite 374/374;
  composing at the end: 37 ms cascade.
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
- 2026-10-08 — Pagination owned for real: pages assembled from measured
  systems (first-fit over `ExtentsStore`), Composer-drawn page shells,
  castoff / pinned page paint / extents job / overflow cascade removed,
  two-way `repaginateFrom`. Root cause: the castoff's page counts were
  transplanted by line index onto the balanced lines (sonata p. 5/7 after a
  one-mark edit). Suite: universal `assertPaginationFirstFit`, `pag_*`.
  Gating fixes the same day: `repaginateFrom` starts one page before the
  first touched page and trims the rebuild window by (start, end)
  membership (`pag_spillThenPullBack`); the seed's signature window is
  spanner-expanded; the line window carries the splicer's courtesy stub
  (B3) — without it 8 of the sonata's 31 pages were off the reference on a
  fresh load (`pag_courtesyAtLineEnd`); forced full renders carry their
  cause into the ledger and the runner reads ledger + console before its
  failure shots and waits out a deferred setup render (lessons.md
  2026-10-08). Fresh-load reference gate over all 31 pages: clean.
- 2026-10-08 (second round) — Every edit is a splice: the derive branch is
  gone for owned documents (`PageAssembler.applyPartition`; the refill carries
  page breaks and section headers, measures signature ranges in chunks; the
  balance is bounded to the edit's page; Setup apply redraws headers; add
  instrument is the one all-lines edit). Fixtures `pag_pageBreakSplices`,
  `pag_sectionHeaderSplices`, `pag_meterChangeSplices`,
  `pag_setupApplyKeepsSystems`, `pag_addInstrumentAllLines`; the seven
  fixtures that declared a by-design derive now splice.
- 2026-10-08 (third round) — Page cards known at first paint (previous /
  cached / page-1 estimate), open page hidden until placed, scroll path never
  builds, zoom keeps the reader's page (`pag_loadCardsUpFront`,
  `pag_zoomKeepsCardsAndScroll`, `pag_buildingPageHidden`).
- 2026-10-08 (fourth round) — Load cost halved in Chromium (10.0 → 5.6 s):
  JS curve sampling (`render/curves.ts`), page-cached phase, chain-memoised
  CTM, six lines per Verovio window, macrotask slices; reference gate exact.
- 2026-10-09 (fifth round) — Zoom rescales in place (`rescale`, outcome
  `rescaled`; sonata 5.6 → 0.93 s); the step measures the system the post
  passes return (hide-empty substitution) and drops stale prepared chunks;
  the test reset restores zoom 100 (`pag_zoomRescalesInPlace`).
- 2026-09-01 — All remaining sonata refusals root-caused and fixed.
- 2026-08-31 — B1 dy-cascade, B3 courtesy window, B4 section headers, B5 lazy
  mount, eviction, zoom-neutral unit 8, user page breaks, Phase D (edit path
  O(edit), 308 → 168 ms).
- 2026-08-30 — Line-break and pagination ownership (pins + encoded), conservative
  repartition, never-painted castoff bootstrap, contained system splice v1.
- 2026-10-09 — Three visual baselines (`page_balance_section_final`,
  `page_system_splice_edit`, `hide_staff_system`) reseeded after a
  deterministic one-level anti-aliasing drift from the 10-08 profiling
  changes (ledger-line ends and one brace; 0 px between runs, the same ≤38 px
  against the old baselines in every capture). Plausible origins and the
  DOM-dump discriminator in lessons.md; `visualCheck` stays sha1-exact;
  `test/composer-test/heatmap.py` gains binary marks below max delta 20.
