# Composer pagination design — pages assembled from measured systems

**Status: approved by Max 2026-10-08 (all seven decisions; shells are Composer-drawn) and IMPLEMENTED the same day — `render/pageassembly.ts`, `render/pageshell.ts`, `render/systemrender.ts`, `pagefit.ts` `firstFitLines`, `linebreaks.ts` `seedPartition`. The living description is in [architecture/composer.md](architecture/composer.md) ("Page-view pagination") and [composer-page-splice-design.md](composer-page-splice-design.md); this file is the design record and the decisions log entry of 2026-10-08 the reasoning.**

## ► START HERE

Page view today owns the line partition (the balancer, from measured natural
widths), every vertical position (rule v1 minimum clearance, rule v2
distribution) and the repair of an overfull page (the cascade). It does NOT own
the initial page membership: `derivePageRender` casts off the document with
Verovio (`breaks:'smart'`, every staff visible, Verovio's own line breaks),
adopts the castoff's page starts, re-balances the lines, and then carries the
page starts across the re-balance BY LINE INDEX (`balanceInitialBand`:
`pageStartIds = pageLines.map((li) => newStarts[li])`). The castoff's
systems-per-page counts are thereby transplanted onto systems it never laid
out, and nothing ever revisits an under-full page — the cascade repairs
overflow only.

Measured on the sonata (2026-10-08, lessons.md "Page-view pagination is
Verovio's castoff count transplanted by line index"): the castoff's lines run
m66–69, 70–73, 74–77, 78–80 … where the balanced ones run m64–67, 68–71, 72–75,
76–79 …; one expressive text in m76 flips the castoff's counts over pages 4–8
between [4,4,4,4,4] and [4,4,3,3,4]; and a page the castoff filled with
three-staff systems holds 216-px one-staff systems after hide-empty
substitution, leaving a 738-px hole above a 606-px system that would fit.

**The contract this design restores (Max):** Composer owns pagination. Verovio
lays out systems — their horizontal layout, their staff spacing, their spanner
shapes, everything inside a system — and never decides which systems share a
page. No page is ever painted from a guess.

## Decisions for approval

1. **Pagination is first-fit over measured system heights, in document order.**
   A page is full when the next system does not fit under the MINIMUM
   placement (rule v1: first content top, `max(below, F) + G + max(above, F)`
   between systems, the content column's bottom as the limit, page 1's title
   block included). Push and pull are the same predicate read in both
   directions; there is no iteration and nothing to oscillate. Pagination is a
   pure function of (document, layout budget), so the document reproduces its
   own pages.
2. **A system's height comes from Verovio laying that system out**, with every
   Composer DOM pass applied (hide-empty substitution, textlayout, instrgap,
   the between clamp, barline repair, …), measured once into the per-line
   `ExtentsStore`. We never estimate a height arithmetically (retracted
   2026-10-08: spanner shapes and nested staff gaps are Verovio's problem and
   it solves them).
3. **The store is the source of truth.** Filled by the load in line order;
   overwritten only for the systems a splice re-renders (it re-renders them
   anyway); refreshed by any full render; invalidated with the owner's keys
   (unit / page scale / HEJI / view staff set / document replace). No system is
   ever re-measured because a neighbour changed.
4. **Forward-only dependency.** Page p's membership depends on the heights of
   the systems before and on it, never on anything after. Once page p is
   full it distributes its lines (rule v2) and renders while later systems are
   still being measured. A change on page p can move boundaries from p
   onward and never before p.
5. **Pages are assembled, not cast off.** Verovio renders a system from a line
   window (the system splicer's path, which the reference gate already proves
   identical to a page render); Composer moves the measured `g.system` into a
   page shell it draws itself (page box, margin frame, title block / running
   header / page number / footer — `render/pageheader.ts` and the injected
   furniture already own these) and places it. The castoff pass, the
   castoff-derived page starts, the line-index transplant, the pinned
   `breaks:'encoded'` page paint, the "toolkit holds the page layout" warm
   reloads and the stale-page machinery all go away.
6. **Edits are O(edit).** The splice updates the store for its hunk and runs an
   arithmetic check over each page it touched: membership unchanged → re-place
   that page (today's behaviour); a system grew past its page, or shrank so
   that the next page's first system now fits → first-fit from that page over
   the store, transplanting systems between pages (today's cascade transplant)
   and re-placing only pages whose membership or count changed. No render that
   the splice would not have done anyway. (Landed as: first-fit from one page
   BEFORE the first touched page — a touched line that starts its page may
   have shrunk enough to return to the page before, and pagination must be the
   same for the same extents whatever the edit history — with the rebuild
   window trimmed to the pages whose (start, end) membership changed.)
7. **Document order is accepted.** Page N on a fresh load waits for the systems
   of pages 1..N−1 to be measured (once per load; ~36 ms a line-window on the
   sonata, idle-sliced). Max: "I don't care about the document-order tradeoff."

## Architecture

### Components (existing, re-purposed)

| piece | today | in this design |
|---|---|---|
| `PageLineBreaks` (`render/linebreaks.ts`) | owns `startIds` (balanced) and `pageStartIds` (castoff-derived, index-transplanted) | owns both; `pageStartIds` is the OUTPUT of first-fit over the store; `replacePageStarts` validation unchanged (every page start a line start, page 1 the document start, ascending) |
| `ExtentsStore` (`render/pagefit.ts`) | per-line `SysExtents`, a by-product of placement, filled for unmounted pages by the idle extents job from toolkit page renders | THE height table; filled by the load's sequential system measurement and by splices; the only input to pagination |
| `placeFor` / `foldIndex` (`render/pagefit.ts`) | read-only rule v1 placement and fold prediction over a page's extents | the fit predicate: a candidate system fits on page p iff `foldIndex(placeFor(systems ∪ candidate), limit) === -1` |
| `placePage` / `placeSystems` (rule v2) | per page after mount and after splice | unchanged; runs once a page's membership is final (load) or changed (edit) |
| `PageSystemSplicer` (`render/pagesplice.ts`) | re-engraves a hunk of lines from a window MEI and swaps the systems into mounted pages | the ONLY Verovio render path for page view: the load uses it line by line (window = one line, hidden staves removed per `hiddenStavesFor`), the edit path as today |
| `substituteHiddenStaffSystems` | re-renders a hide-empty system alone and swaps it in after the page paint | subsumed: the load window is built with the hidden set already removed, so the measured system is the final one |
| `Renderer.repairPagination` (cascade transplant) | moves systems forward out of an overfull page | the two-way cascade: moves systems in either direction per first-fit from page p |
| extents job (`armExtentsJob`) | measures unmounted pages offscreen from the toolkit's page layout | replaced by the load's sequential measurement (which IS the render); nothing is measured twice |
| page shell | Verovio's page SVG (`renderToSVG(p)`), `g.pgHead` measured, furniture injected | Composer-drawn shell: the paper, the margin frame at the pinned scale, header / page number / footer (already Composer's conventions), an empty `g.page-margin` the systems are moved into |

### Removed

`castoffPlan`, `buildOptions('auto' | 'smartSb0' | 'line')`, `adoptFromCastoff`,
`partitionFromLayout`, `castoffSegmentedByUserBreaks`, the page-index transplant
in `balanceInitialBand`, `settlePaginationForAdoptedPartition`,
`ensureTkHoldsPageLayout` / `pageVirt.tkCurrent` / `stalePages` (a page is
never stale: it is either assembled from current systems or not mounted),
`repairAtMount`, `measurePageExtentsOffscreen`, `pinRenderMei` for page paints
(pins remain for the splice WINDOW only — `<sb>` between the window's lines).
`foldOf` survives as an ASSERTION (a mounted page must never fold, since its
membership was decided from the same extents it is placed with).

### The load (derive)

1. **Lines**: as today — `warmAllNaturals`, then the balancer over the whole
   document. Pagination plays no part in the balance (today's `pages` argument
   to `balanceInitialBand` becomes the whole partition).
2. **Measure in line order**: for line i, build the window MEI for that one
   line (view ∖ hidden staves, leader/trailer stubs as the splicer does),
   render it in the measurement host at page geometry, run
   `postProcessRendered`, `alignStaffRows`, measure `SysExtents` → store.
   ~36 ms a line on the sonata; the first page's four lines are ready in
   ~150 ms. Idle-sliced after the first page the user is looking at, in
   document order, with the mount window (cursor page) prioritised only by
   order — there is no way to reach page N before N−1 is closed, by decision 7.
3. **Close pages as they fill**: after each measurement, test the fit of line i
   on the open page p. Fits → append. Does not fit → page p is final: commit
   its page start, `placePage` (rule v2), move its systems from the host into
   the shell, mount; open page p+1 with line i. A user `<pb>` before line i
   closes the page unconditionally; a section break is a line break only (as
   today) — a section header's reserve band is part of its system's `above`.
4. **The last page** closes at the last line. The page count is whatever the
   fold produced; `pageVirt` keeps the divs, placeholders for pages not yet
   closed (the mount pump's pending state, reused).
5. **Cache**: `partitionCache` stores lines, page starts AND the store for the
   (docVersion, budget) key, so a zoom round-trip restores all three and
   re-assembles pages without a render, exactly as the width caches are
   restored today.

### The edit

1. The splice computes its hunk and re-engraves it from the window (unchanged),
   runs the DOM passes on the host, and writes the hunk lines' `SysExtents`
   into the store (lines that left the partition are deleted from it).
2. **Focused check** over the set of pages that received a hunk line, in page
   order: run first-fit from that page's first line over the store, stopping
   as soon as a page boundary comes out where it already is (forward-only:
   an unchanged boundary at page q means every page after q is unchanged
   too, because their inputs did not change).
   - No boundary moved → `placePage` on the touched pages (today's behaviour).
   - A boundary moved → the cascade from that page: commit the new page starts
     (`replacePageStarts`), transplant systems between the affected pages
     (`repairPagination`'s DOM moves, now in either direction), create or
     remove page divs as the count changes, `placePage` each affected page.
     Pages beyond the mounted band only get their page start committed; they
     assemble from the store and fresh windows on mount.
3. Both triggers Max named fall out of the same predicate: a system that grew
   past its page fails the fit on its own page; a system that shrank lets the
   next page's first system pass the fit on this page.

### What Verovio is asked for

A window of pinned lines at page width, horizontal layout and intra-system
vertical layout included. Nothing else: no castoff, no page, no `<pb>`.
Scroll view is untouched (its own splicer, no pages).

### Scope boundaries

- The single-part view keeps its own partition and gets its own store entries
  (keyed with the view's staff set, as the owner already keys its partition).
- Page 1's content height differs (title block); the shell knows its page
  number, so the fit predicate takes the limit from the shell.
- Endings, spanners across lines, layer clefs: the hunk-closure rules of the
  splicer already cover them; the load's one-line windows carry the same
  leader/trailer stubs.
- PDF export reads the page DOM (unchanged).

## Invariants and gates

- **Pagination is a pure function**: `pageStartIds === firstFit(startIds, store)`
  at every settled moment; a mounted page's membership equals that; no mounted
  page folds (`foldOf` assertion). Checked by `verifyRenderedPartition`
  extended to pages, under `HKL_INDEX_CHECK` in the gated sweep (`cb-sweep.js
  --arg "check=1,from=N,limit=24"`, chunked) and the battery.
- **Reference gate**: a live assembled page vs a page assembled from fresh
  windows of the same lines — the splice/derive agreement the gate already
  asserts, with the castoff reference replaced by the assembly reference.
- **Fixtures** (`test/composer-test`): (a) the sonata case — a hide-empty run
  whose castoff count differs from the measured fit: the one-staff systems'
  page has no hole and the next page's first system is pulled up; (b) a system
  that grows past its page pushes; (c) a system that shrinks pulls the next
  page's first system up; (d) a user page break is honoured; (e) page 1's
  title block shortens its budget; (f) a mid-session zoom round-trip restores
  pages without a render; (g) `cb-commands.js`: no command derives because of
  pagination.
- **Cost**: `cb-splicecost.js` wall unchanged for edits (the check is
  arithmetic); load: naturals warm as today + 115 line windows on the sonata
  instead of the 1 s castoff + page paints — measure and record in
  `composer-render-perf.md`.

## Phasing

1. **Store-driven pagination, two-way cascade** (the authority fix): first-fit
   over the store; the edit check; the cascade in both directions. Lands with
   fixtures (a)–(d). On a load the store is still filled by today's means
   (page paints + extents job), so the castoff seed persists for ONE paint —
   this phase is only acceptable as a stepping stone if the next lands with
   it; it must not ship alone (decision: "no page is ever painted from a
   guess").
2. **Assembled pages**: the load measures line windows in order and assembles
   shells; castoff and pinned page paint removed; stale/warm machinery
   removed; fixtures (e)–(g); the gated sweep and battery re-baselined.
3. **Cleanup**: `foldOf` → assertion; `partitionCache` carries the store; docs
   (architecture/composer.md pagination section, the splice design doc's
   Ownership section, decisions.md entry).

Phases 1 and 2 ship together.

## Open questions

- Shell drawing: reuse the existing header/footer injectors as-is, or render
  one empty Verovio page per scale as the shell template and inject into it?
  (Recommendation: Composer-drawn — one less Verovio dependency, and the
  furniture rules are already ours.)
- Measurement host geometry: the splicer's host is one page wide with no
  `<pb>`; the load reuses it unchanged (recommendation) — confirm nothing in
  `postProcessRendered` reads the page number.
- Idle slicing of the load: measure strictly in order with a 40 ms budget per
  slice (the extents job's rhythm), or burst until the cursor's page closes?
  (Recommendation: burst to the cursor's page, then slices.)


## Every edit is a splice (approved by Max 2026-10-08, second round)

The first landing kept the old derive branch for edits the refill would not
carry: a structural lock diff (`user breaks changed` — page break, section
header, pickup), a signature range longer than one window (`repartition
window/cap exhausted` — a meter change mid-piece) and a head-context change
(`head context changed` — add instrument). Each re-assembled the document
synchronously up to the cursor's page: 8–11 s deep in the sonata against
~1.2 s for the old castoff. Max: *"Any O(document) cost from an edit that
doesn't affect the whole document is a failure … now that we own the full
page-level layout and not Verovio, what is the distinction of a 'full derive'
anyway? Every single edit now should only touch the systems that it affects.
Every single edit is effectively a splice."*

Decisions:

1. **The refill always returns a partition.** The structural bails go. An
   added or removed page break changes no line: it is a hard page start handed
   to first-fit. A section header is a line lock plus its reserve band plus a
   restart on that line. A signature range is measured in chunked windows, not
   refused past one window's cap.
2. **One assembler operation applies any partition change**:
   `PageAssembler.applyPartition(newLines, changedLineIds)`, a generalisation of
   `repaginateFrom`. Lines in the changed set get a fresh line window
   (`renderLineSystem`); every other line is reused from the DOM bank with its
   stored extents; pages are first-fit from the first affected page and systems
   move between shells. No Verovio call for an unchanged line, ever. The
   splicer's hunk path (`trySplice`) stays as the fast case inside this; when it
   refuses, or when the refill's change is not a hunk, `applyPartition` runs —
   never a full assembly on an owned document.
3. **The changed set is derived, not guessed**: lines holding a dirty measure;
   lines whose membership changed; the line BEFORE a new or removed signature
   change (its end-of-line courtesy); lines inside a signature range whose
   naturals changed; a section's first line on header add or remove; every line
   for add instrument (the staff set changes on every system — the one
   legitimately all-lines edit, still through the same path).
4. **Setup apply** redraws the shells' headers and re-places page 1 — no system
   renders. Zoom, page scale, view-staff change and new document stay full
   assemblies by definition (every window renders at a new scale, or it is a
   load).
5. **Gate**: `cb-commands` must show every mutating command spliced, with add
   instrument the only all-lines case; the checked sweep and the suite stay
   green; page break, section header, meter change and setup apply land well
   under a second deep in the sonata. Fixtures: `pag_pageBreakSplices`,
   `pag_sectionHeaderSplices`, `pag_meterChangeSplices`,
   `pag_setupApplyKeepsSystems`, `pag_addInstrumentAllLines`.

## Implementation plan (2026-10-08, after approval)

File by file. Everything not listed is untouched.

**`render/pagefit.ts`** — add `firstFitPages(lines, store, reserveOf, k, limitOf, hardStarts)`:
greedy over line ids; a page closes when `foldIndex(placeSystems(items, k, y0(p)), limit(p)) >= 0`
for the candidate set, or at a hard start; returns page-start ids. Pure; unit-testable.

**`render/pageshell.ts`** (new) — Composer draws the page: `createPageShell(pageNo, geom, meta)`
returns `{ svg, margin, headBottom }` with the exact nesting a Verovio page has
(`svg > defs + svg.definition-scale[viewBox] > g.page-margin[translate]`), so `pageSystems`,
`svgBox`, `pageFrameOf`, the splicer and the PDF export read it unchanged. `g.pgHead` is drawn
here: page 1 = title / subtitle / composer credit at `pageheader.ts`'s sizes and em-box rules;
pages 2+ = page number in the outer top corner and the running title centred (what
`styleRunningHeader` produced). `data-hkl-head-bottom` is set analytically from the em-boxes,
so `headBottomOf` never measures a header. `pageheader.ts` keeps its constants and em-box
helpers; `styleTitleBlock` / `styleRunningHeader` (restyling Verovio's header) go.

**`render/systemrender.ts`** (new, extracted from `substituteHiddenStaffSystems` +
`PageSystemSplicer.trySplice`'s window path) — `renderLineSystem(model, li, ctx)`: window MEI for
ONE line (view ∖ hidden staves, spanner/ending closure, leader/trailer stubs, the whole-document
`'auto'` case), `spliceTk.loadData`, `renderToSVG(1)`, pick the `g.system` whose first measure is
the line's start, import it. Used by the load (every line) and by hide-empty on the edit path.

**`render/render.ts`**:
- `pageVirt` becomes `{ pageCount, open: { pageNo, div, lines } | null, mounted, parked: Map<page, svg>, io, pageW, pageH }`; `mei`, `options`, `tkCurrent`, `stalePages` go.
- `derivePageRender` → after the balance, `assemblePages(model, fromLine = 0, fromPage = 1)`: open a hidden shell, then per line: `renderLineSystem` → append to the open margin (`mergeGlyphDefs`) → `postProcessRendered(div, [sys])` → `alignStaffRows` → `measureExtents` → store → fit test (`firstFit` over the open page's lines + this one; a hard start closes) → on close: `placePage` (rule v2), reveal, `onPageMountedCb`, commit the page start (`pageBreaks.setPageStarts`), open the next shell with the overflowing system moved in. Runs synchronously until the cursor's page closes, then in idle slices (40 ms budget, the extents job's rhythm). `renderPending()` includes the job. The last page closes at the last line.
- `mountPage` / `unmountPage` → attach / detach the parked shell (no render); `placePage` on re-attach (cheap, deterministic). Placeholders keep the pageW×pageH box.
- Edit path: after `trySplice` lands → `repaginate(firstTouchedPage)`: `firstFitPages` from that page's first line over the store (hunk lines were re-measured by `placePage`); if the page starts differ → `replacePageStarts`, move systems between pages with `moveBlock` in either direction (parked pages: move between parked margins, mark `needsPlace`), create/remove page divs, `placePage` on every page whose membership changed. Replaces `repairPagination`; `foldOf` becomes the assertion `overflowingPage() === 0` under `HKL_INDEX_CHECK`.
- Removed: `castoffPlan`, `layoutBreaks`, `castoffSegmentedByUserBreaks`, `settlePaginationForAdoptedPartition`, `ensureTkHoldsPageLayout`, `measurePageExtentsOffscreen`, the extents job, `repairAtMount`, `createPageFromShell` (shells come from `pageshell.ts`), `headIsTitleBlock`, the `renderPage(mei, virtualize)` page paint (scroll keeps its own path).
- `partitionCache` entries carry `pages` and the store; a hit restores lines + pages but systems are re-rendered at the new budget (the assembly runs with known page starts — no fit decisions, no shifts).

**`render/linebreaks.ts`**: `adoptFromCastoff`, `partitionFromLayout`, `armAdoption` / the adoption task, the `pages` remap in `balanceInitialBand` go; `setPageStarts(pages)` (same validation as `replacePageStarts`, partial lists allowed while assembling); `tryRefill` keeps computing the PROVISIONAL `newPageStartIds` by line membership — the splicer's target pages — and the renderer's `repaginate` is the authority afterwards. `pinRenderMei` with `<pb>` pins survives for the reference gate only.

**`render/pagesplice.ts`**: unchanged in shape; `substituteHiddenStaffSystems` on the splice path calls `systemrender.ts`.

**`main.ts`**: `injectHeaderFooter` keeps the footer; the header restyles are gone (the shell drew it); `injectSectionHeaders` and `styleVoltaNumbers` unchanged, run once per page at close.

**Tests** (`test/composer-test`): universal invariant `assertPaginationFirstFit` (page view: every mounted page folds at −1 under `placeFor`, and the next page's first system does NOT fit under it — read from the DOM, so it runs on the pre-fix code too); fixtures `pag_hideEmptyNoHole`, `pag_growPushes`, `pag_shrinkPulls`, `pag_userPbHonoured`, `pag_zoomRoundTripKeepsPages`; `cb-commands.js` unchanged.
