# Composer page splice — living reference

Updated 2026-09-01. This is the **current-state** reference for page-view
incremental rendering in Composer: what the machinery is, the rules it enforces,
how it is verified, what it costs, and what is open. History is not repeated
here: every design choice with its rationale is a dated entry in
[decisions.md](decisions.md) (2026-08-29 onward), every dead end and trap is in
[lessons.md](lessons.md), and the code comments carry the local reasoning.
Companions: [composer-spot-splice-design.md](composer-spot-splice-design.md)
(scroll splice) and [composer-render-perf.md](composer-render-perf.md).

## ► START HERE

**State.** On the 446-bar sonata every edit splices: routine sweep 115/115,
exhaustive every-measure pass 420/420 (empty refusal inventory), battery 8/8
reference-clean. Steady-state edit ≈ 170 ms in Chromium before the A thread;
A7–A11 (2026-09-01/02) took the instrumented wall 258 → 144 ms (≈ −44%), the
battery's walls roughly halved (e.g. 695 → 369, 679 → 259 ms), sweep 115/115.
Size caps are gone (2026-09-01): a 25-line governed range splices in ~1.3 s
where a full render is ~1.7 s. Suite green under `HKL_INDEX_CHECK` (~4 min).

**Governing principle (Max, 2026-09-01):** *"The goal is to hit O(edit) in ALL
cases. Any time the user is exposed to O(document) on a live path when they
didn't ask for a change to the full document is a failure, full stop."* A
fallback is never an invariant; anything that currently derives or full-renders
is a defect with a date on it.

**Remaining O(document) paths** (B2, below): a refill whose repair changes the
line count (N systems → M); a refill whose repair changes pagination
(`paginationHeld` false — the splicer is not even consulted, and no diagnostic is
left); the structural bails (head/interior `rest`, user breaks, foreign
document); the repair-loop caps (`MAX_ENSURES`, `MAX_REPAIR_STEPS`); a replaced
line on an unmounted page that a PREVIOUS splice marked stale (`changed line not
mounted` — B5's cheap mount refuses stale pages).

**A thread status (2026-09-02).** Shipped: A7 layout-free naturals, A8 scoped
post-processing, A9 raw SVG, A10 lazy history snapshot, A11 path-based
profiles with a never-laid-out window — all gate-neutral, battery identical to
base at every step. The splice's DOM side is now the one layout flush the
post-surgery snap needs (post-processing of the imported systems shares it:
5.5 ms; snap 1.8; no live flush before surgery). Verovio's window `loadData`
+ `renderToSVG` (~84 ms) is the floor for the current window shape and now
well over half of the edit; the next lever would be the window's shape, which
is a gate question. Start from "Where the time goes" and the A list.

**Two standing traps.** (1) Never edit `apps/composer/src` while the suite or
ANY phasec probe/sweep runs against the dev server — Vite reloads the page and
the run dies or lies. Docs, fixtures and probe files are safe at any time.
(2) Do not run `pnpm build` or a second Chromium job alongside the suite: a
visual fixture once shot mid-relayout under a concurrent build and passed alone;
the sweep's 300 s runner deadline times out under a concurrent suite. Under
`HKL_INDEX_CHECK` a large-range edit costs ~2–3 s over production (the
reference gate's full render ~1.7 s + the VoiceIndex cross-check ~0.8 s); until
2026-09-01 it was ~40 s.
If test mode gets slow again, `cb-checkcost.js` attributes it in one run.

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
  castoff layout and adopting lazily.
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
4. **Naturals** come from `breaks:'none'` windows (two left + one right context
   measures, spanners and endings whole), cached per measure; the whole dirty
   range is measured in one window before the repair loop. Repair-loop ensures
   are capped (`MAX_ENSURES` windows, `MAX_REPAIR_STEPS` 64) — a derive when
   exceeded. **Layout-free (A7, 2026-09-01):** a natural is the measure's
   staff-line path extent read from the SVG text via `DOMParser`; the window is
   never attached or laid out. Only `sigW` (leading clef+key) needs glyph
   metrics; it is measured with `getBBox` on an attached host only when the
   window's folded head (the sub-MEI before `<section>`, which alone determines
   the leading signature) differs from the head that last measured it.
5. **Pages are carried like lines**: a page keeps its start id while that id
   still begins a line, else moves to the next surviving start. A spill past the
   paper hands pagination back (`overflowingPage`).

### The system splice (`render/pagesplice.ts`, `PageSystemSplicer`)

Runs when the refill succeeded, the page DOM is live, pagination held, and the
line count is unchanged. Replaces whole systems in place; everything else on the
page is untouched or dy-translated.

- **Replaced set L**: the changed run, one measure left when its first measure
  holds a layer clef (relocation), closed once over spanners with an end inside
  the run and over `<ending>`s, then to lines. Every line of L must be mounted;
  a missing page is mounted from the loaded pre-edit layout (B5).
- **Window**: L ± 1 context line, plus the line beyond when it begins a
  signature change — scoreDef possibly behind a section `<sb>`, or a leading
  clef/key/meter on ANY staff (the courtesy is generated by the FOLLOWING line;
  bounded at two). Synthetic `mRest` LEADER (absorbs score-start artifacts;
  omitted when the window is the score start) and TRAILER (absorbs the final
  barline). `<pb>` pins at live page starts and the live page options verbatim,
  so the window paginates like the document and a page-first system's position
  is READ, never modelled (`header:'none'` hides the anchor band). Sub-MEI via
  `serializeRangeForRender`: running key/meter/clef folded into the head —
  including the range's own leading clefs (dropped from the range) and never
  clearing `meter.sym` without a meter — boundary scoreDefs inline.
- **Gates (refusal → full render, reason in `lastSkipReason`)**:
  - *Context lines* must reproduce live: per-measure x/width within EPS 25 and
    identical clef/keySig/meterSig glyph codepoints (`sigGlyphDiff`). This is
    the only live fidelity test and it has no exemptions. The REPLACED lines
    are never compared live — they are what the edit told Verovio to redraw;
    the reference gate verifies them.
  - *Vertical plan*: measured from the window's spacing chain, applied
    all-or-nothing (page-first systems read absolutely; the chain resets at
    page boundaries; `dyFollow` moves the followers on the last replaced page;
    a plan within EPS pins live positions).
  - *Section headers*: the mount-time injector records `data-reserve` and
    `data-baseline`; the plan reasons in Verovio coordinates and re-places
    titles; an unreadable value refuses.
  - *No size caps* (2026-09-01): a window costs linearly in measures up to the
    whole document, so a subset render is never the worse deal.
- **Surgery**: import systems, `mergeGlyphDefs` per page, `snapPage`, mark the
  edited pages stale for later mounts. Diagnostics on the splicer:
  `lastOutcome / lastSkipReason / lastRun / lastWindow / lastWindowMei /
  lastVertical`, and on a context refusal `lastContextDiff` (full per-measure
  diff + glyph census — the first mismatch a refusal names is where drift became
  visible, not where it started).
- **Page virtualization**: the mounted set is a window around the viewport and
  cursor, with eviction; placeholders match mounted boxes exactly.

### Cross-measure render dependencies (check this list when scoping any edit)

- End-of-line courtesy signatures: drawn on line k, generated by line k+1's
  first measure.
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

### Reference gate (`HKL_INDEX_CHECK`)

After every splice, a fresh full render of the same pinned MEI is compared
against every mounted page: system sequence, per-measure x/width (TOL 30),
absolute staff tops (reserve subtracted), section-title bands, and clef/keySig/
meterSig glyph codepoints (reference post-processed like the live page). Render
errors are logged and re-thrown under the flag — a caught throw is not a gate.
`pnpm test:composer` does NOT set the flag; run
`HKL_INDEX_CHECK=1 node test/composer-test/run.mjs full`.

## Verification

- **Suite** (~4 min under the flag since the 2026-09-01 test-mode fix; ~13 min
  before it): the page-splice fixtures cover every
  mechanism above; each landed with its bug and was run against the unfixed
  source (`test/composer-test/run-unfixed.sh <fixtures>` stashes
  `apps/composer/src`, runs, restores).
- **Sonata gates** (`test/composer-inspect/phasec/`, README there):
  `cb-splice-battery.js` (8 edits, whole-document reference compare),
  `cb-sweep.js` (every line once through the real IntersectionObserver: hit
  rate, refusal histogram, latency, viewport drift), `allmeasures.sh` +
  `allmeasures-report.mjs` (every measure; the only way to reach multi-line
  replaced-set classes), `cb-ctxdiverge.js` (root-cause a context refusal in
  one run), `cb-scale.js --arg sonata:100` (steady-state attribution: wall +
  `querySelectorAll` / `XMLSerializer` / `getBBox` counts — counts are
  deterministic, walls vary 166–206 ms; run 3× sequentially),
  `cb-checkcost.js` (test-mode overhead attribution: the bigrange key case with
  the flag off and on, every flag-gated verifier wrapped with a timer),
  `cb-splicecost.js` (A-thread attribution: phase-tagged buckets, forced-flush
  detection with call sites, window-variant re-timing), `cb-naturalsalt.js`
  (naturals shape: giant system vs pinned lines), `cb-windowalt.js` (leader /
  trailer removal: geometry deltas per system), `cb-svgopts.js` (Verovio SVG
  output options vs `renderToSVG` / parse cost).
- **Behaviour gate for any edit-path change**: battery on both code states
  (stash / pop) — the splice/skip outcome per edit and `reference.ok` must be
  identical; wall is the win.
- **Visual discrepancies go to Max** as two images, uninterpreted.

## Where the time goes (2026-09-01, Chromium, sonata)

Steady-state one-note edit, Backspace mid-document, `cb-splicecost.js`
(phase-tagged wrappers; instrumented wall 258 ms against ~170 ms bare — the
wrapper overhead is spread over ~4 000 wrapped calls, so the SHARES are what to
read). Window: 1 replaced line, 4 window lines (above + replaced + below + one
courtesy extension) + leader + trailer = 20 measures on 2 window pages.

- **Splice 158 ms.** Verovio `loadData` 25.5 + `renderToSVG` 59 (2 pages) =
  **84 ms**; `innerHTML` parse of the two hosts 10; **post-processing of the
  two window hosts 30** (pinExactScale / snapBarlines / snapSystemRightEdge /
  notehead reorder / HEJI / theme over 20 measures, of which only 6 are
  imported); window MEI build 9 (serializeRangeForRender 4.7, DOMParser 2.9,
  XMLSerializer 1.2); `liveSystem` ×3 7 ms (one 5.3 ms flush); `spliceDom` 14
  (one 3.5 ms flush reading the window profiles, snapPage 5.2 with one 4.5 ms
  flush). 44 + 114 `getBBox` in spliceDom/snap; ~2 200 `querySelectorAll`.
- **Refill 49 ms**, all naturals: a 5-measure `breaks:'none'` window costs
  `renderToSVG` 15.2, `getBBox` 8 (one flush; 118 reads), `loadData` 6.3,
  serializeRangeForRender 2.9, 1 405 `querySelectorAll` 2.5, `innerHTML` 2, and
  ~11 ms of walk. Fixed cost dominates small windows (~10 ms/measure here vs
  5.2 ms/measure at 100 measures).
- **Outside the render 50 ms**: model mutation 14, history snapshot
  `XMLSerializer` 12 (the reused-MEI half), the overlay-height layout read
  after the splice 5.5 (paint layout brought forward — not extra work),
  `cursor.update` ×2 1.6, dispatch / bridge / poll granularity ~16.
- **Forced layout flushes ≈ 27 ms**: naturals host 8, first live `getBBox` 5.3
  (the live layout is dirty because the naturals host was attached and removed
  from `<body>`), window-host profiles 3.5, snap after surgery 4.5, overlay
  read 5.5. Every one lays out a page-sized SVG; the number of `getBBox` calls
  is irrelevant (A6's 199 → 169 experiment).

**Verovio is drawing, not laying out.** On the 100-measure naturals shape
`loadData` is 64 ms and `renderToSVG` 335–453 ms (0.6 vs 3.4–4.5 ms/measure);
on the 18-measure window shape 26 vs 43 ms. The first `renderToSVG` after a
`loadData` is 30–40% slower than a repeat (460 vs 330; 56 vs 43 ms) — the
layout is lazy and lands in the first draw — and production always pays the
first. `svgFormatRaw` leaves `renderToSVG` unchanged (335 → 327) but cuts the
SVG string 40% (1.68 MB → 1.0 MB per 100 measures) and the `innerHTML` parse
36% (41.8 → 26.8 ms; 8.5 → 6.3 on the window); `svgRemoveXlink` changes nothing
(`cb-svgopts.js`).

**Window shape experiments** (`cb-windowalt.js`, `cb-splicecost.js` variants):
without the leader the REPLACED line and the line below are identical to the
full window (every measure x/width, staff top, height: delta 0); only the
context-above line changes (page-top anchoring, widths −219..−363, x up to 803)
— the leader is gate-only. Leader + trailer together cost ~3 ms of Verovio
(27 + 58.4 → 24.6 + 57.3). Replaced-lines-only (6 measures, 1 page) costs
`loadData` 8.9 + `renderToSVG` 15 = 24 ms against 84 — a ~60 ms Verovio saving
plus ~15 ms of DOM, at the price of the context gate (the only live fidelity
test), the courtesy the following line generates for the replaced line, and
every spanner endpoint outside the replaced set.

**Naturals shape experiment** (`cb-naturalsalt.js`, 100 measures, 25 lines):
one giant `breaks:'none'` system 63.6 + 453 ms; pinned at the live line starts
with `noJustification` 117 + 423; pinned justified 117 + 413 — 5.2 / 5.4 / 5.3
ms per measure. The giant system is NOT superlinear; pinned lines are no
cheaper and their system-first widths need a per-system clef/key correction
(interior widths agree exactly, max delta 0). Dead end.

Large governed ranges (caps dropped): 17 lines / 78-measure window 1.18 s;
25 lines / 106 measures 1.32 s. The naturals window is ~5.5 ms per measure
(440–590 ms for 71–107 measures; ~85% of it Verovio's `renderToSVG`, ~1.5 ms of
it DOM parse + layout + `getBBox`) and the window `loadData` ~0.4 s. Both scale
with the range; only the DOM share is removable (below).

## Open work

### A. Splice cost (next thread)

Measured 2026-09-01 (see "Where the time goes"). Estimated savings are against
the ~170 ms steady-state edit; none of the items marked *gate-neutral* changes
what any gate compares.

- **A7 — layout-free naturals — SHIPPED 2026-09-01.** Proof
  (`cb-naturalspath.js`, every sonata measure): staff-line span = the old
  `getBBox` natural on 441/443 interior measures and every window-last measure
  (delta 0); the two exceptions are a window's FIRST measure, whose bbox began
  144 units left of its staff line (system-start brace/barline) — the old
  reading over-counted measure 0 by the brace. Result on the steady edit:
  naturals 48 → 37 ms, first live `getBBox` 7.3 → 2.2 ms (flush gone),
  instrumented wall 258 → 234. Battery identical to base, suite 358/358.
- **A8 — post-process only the replaced systems — SHIPPED 2026-09-01, small
  win, big finding.** `postProcessRendered(container, scope?)` runs the
  per-system passes (barline / right-edge snaps, notehead reorder, theme) only
  on the systems the splice will import; root-svg pinning and HEJI injection
  stay host-wide (the context gate compares HEJI-processed key-signature
  glyphs). Post 30 → 24 ms, splice 147 → 143. The pass timings
  (`Renderer.lastPostStats`) show why so little: on ONE scoped system
  `snapBarlines` is still ~22 ms, and it is the first `getScreenCTM` — the
  FIRST geometry query on a freshly parsed page-sized host forces its layout
  (~20 ms), and that flush was hiding inside "post". The per-barline work is
  sub-millisecond. So the window host's initial layout is the DOM-side floor
  while any read on it needs layout. Battery identical, suite green (one
  marginal fixture flaked once, 6/6 on re-run both states).
  Still open for Max: barline x-snapping happens in the HOST frame before the
  `translate(dx,dy)`; a non-integer device `dx` would un-snap imported
  barlines. `dx` is ~0 when margins match; a screenshot with `dx ≠ 0` settles it.
- **A11 — the window is never laid out — SHIPPED 2026-09-02** (Max: pursue
  in place of the fragile A6, "but we have to thoroughly prove the path-based
  profile is actually reliable"). `systemProfile` now reads geometry from the
  SVG text on BOTH sides: a measure's x/width is its staff-line path span
  (`M x1 y L x2 y`), the staff top is that line's y, plus the staff and system
  transforms. The window is a `DOMParser` document that is never attached; the
  imported systems are post-processed (snaps, notehead order, HEJI, theme)
  scoped, in the live page, in its own device frame — which also removes the
  host-frame barline snap that a fractional `dx` used to un-snap. The system
  extents (`bboxTop/Bot`, `newBottom/liveBottom`) are gone: nothing consumed
  them beyond diagnostics, and page-fit reads the live page after surgery.
  `sigGlyphs` reads a HEJI-injected `text` as the codepoint it carries, so a
  raw window compares against a HEJI-processed live page.
  **Proof** (`cb-pathprofile.js`): 126 real edits — a deletion on every sonata
  line (114) and 12 governed-range key changes with replaced sets of 3–16
  lines — 117 splices, 118 context lines; against the bbox reading the path
  reading gave the identical staff top, `dx` and `dy` on every system (Δ 0)
  and the identical gate verdicts (max width delta ≤ 3 units under both: the
  live right-edge snap moving a staff-line end by ½ device px, which both
  readings see because the snap rewrites the path). The bbox reading was the
  polluted one: a measure's bbox includes spanners overhanging into neighbours
  and, on system-first measures, the brace (144 units). Fixture
  `pageSpliceNoHostAttach` (a MutationObserver on `<body>` sees nothing
  attached during a splice; fails on pre-A11 code). **Gates**: suite 360/360
  under the flag, battery identical to base (walls 272/109/369/370/231/259/
  309/181 vs 389/300/695/627/547/679/442/368 ms), sweep 115/115 spliced,
  `cb-splicecost.js` steady edit 214 → 144 ms instrumented (splice 147 → 90,
  post 24 → 5.5, first live read 2.2 → 0.4, snap 4.7 → 1.8).
- **A6** — subsumed by A11 (the snap flush is now the one layout the splice
  needs, shared with the retitle and the imported systems' post-processing).
- **A9 — `svgFormatRaw: true` — SHIPPED 2026-09-01** (in `BASE_OPTIONS`, so
  every render, window and naturals toolkit inherits it). Whitespace-only:
  identical element counts, no indentation or inter-element newlines. Measured
  on the steady edit: the two window hosts' `innerHTML` 10 → 5.7 ms, naturals
  `DOMParser` 2.3 → 1.9; SVG bytes −40%. Battery identical to base; every visual
  baseline in the suite unchanged. The PDF export sets its own options on a
  shared toolkit — Verovio persists unspecified options, so exported SVG is raw
  too, which is only whitespace.
- **A10 — lazy history AFTER snapshot — SHIPPED 2026-09-01.** `withHistory`
  takes its AFTER via `model.snapshotStateLazy()`: the MEI is a getter that
  serialises on idle (`requestIdleCallback`, 300 ms timeout) or synchronously
  before anything that could change the document — the model materialises a
  pending lazy snapshot in `snapshotState`, `snapshotStateReusing` (every
  mutation path takes a BEFORE first), `restoreSnapshot*` and
  `replaceDocument`; the HistoryManager resolves it before push / undo / redo.
  Under HKL_INDEX_CHECK, materialising after the document version moved throws
  (a mutation path that took no BEFORE snapshot). No-op detection: equal
  document versions = identical document, nothing pushed; different versions
  push optimistically and the string comparison is settled at resolution,
  retracting the entry (and restoring the redo stack) if the MEI turned out
  identical — an attribute rewritten to its own value bumps the version. The
  cut→paste merge path settles eagerly. Fixture `undo_lazy_snapshot`. Measured:
  the `XMLSerializer` bucket (~12 ms) is gone from the keystroke; instrumented
  steady-state wall 258 → 214 ms across A7–A10 (bare ≈ 170 → ~140).
- **A6 — one layout per host** (~4.5 ms, fragile — do LAST). After A7 the
  remaining forced flushes are the window-host profile read (needed: system
  bbox extents need glyph metrics) and the post-surgery snap (`snapStaffLines
  ToGrid` reads `getScreenCTM` + `getBBox` per staff). The snap could be
  computed from the host's already-laid-out staff-line y plus the applied
  `dy` (and `dyFollow` for the cascade followers) — a restructuring of
  `snapPage` to accept known geometry. Fewer mounted pages: negligible (the
  flushes lay out one page-sized SVG each regardless).
- **Window shrinkage — not available without a gate change.** Leader and
  trailer are ~3 ms; dropping the courtesy-extension line (~15 ms when it is
  pulled in) or the context lines (~75 ms) each requires exempting a
  context-line width or the whole live comparison. lessons.md ("The gate
  exemption is the real lesson") says no; Verovio's 84 ms is the floor for the
  current window shape. Revisit only with a replacement fidelity test.
- **A3** — collapse the two `cursor.update` calls (~1.6 ms; blocked on the
  `onStateChange`-before-`onChange` bridge ordering).
- **Dead ends (2026-09-01, do not retry without new evidence)**: pinned-lines
  naturals (no cheaper, needs system-first corrections); `svgRemoveXlink`
  (no effect); reading naturals from the splice window's justified render (the
  naturals must be position-independent; the splice window is justified and
  line-shaped); `getBBox` call-count reduction (flush-bound).
- **A5** — worker-offloaded castoff `loadData` (~1.4 s on the derive); big
  refactor; `afterRender` is the seam.
- **Test-mode residual** — `assertVoiceIndexConsistent` calls
  `getMeasureStartCursorUncached` once per measure, each O(measure index):
  0.7 s per index build on the sonata under the flag. Tolerable; not O(edit).

### B2. Line-count-changing refills and pagination changes

Replace N systems with M under the same machinery (today: full render), then
moves across a page boundary (today: pagination handed back). These are the
remaining O(document) paths an ordinary edit can hit.

### C2. First-page credits — composer/footer changes still derive (rare).

### D. Tuning and features (Max's call)

- **D1** vertical justification within a page (shares a page-fit model with the
  segmented castoff; needs system-height tracking).
- **D2** FIT_MAX / MIN_FILL to taste (legality bounds, not packing targets).
- **D3** explicit "reflow document" command (reflow is path-dependent now).
- **D4** explicit move-measure-between-systems commands.
- Noted, not fixed: a clef set on an EMPTY layer does not roundtrip
  (`<clef/><space/>` loads back as `<space/><clef/>`).

## Status log

Chronological detail is in decisions.md (dated entries from 2026-08-29). Most
recent, one line each:

- 2026-09-02 — A11 shipped: path-based profiles on both sides, window parsed
  and never laid out, post-processing on the imported systems in the live page.
  Proof over 126 edits / 117 splices: identical staff tops, dx/dy and gate
  verdicts to the bbox reading. Extent fields dropped. A6 subsumed.
- 2026-09-01 — Owner bug fixed: `commitAdoption` now writes only for the
  CURRENT task, once. `finishAdoptionNow` (an edit arriving mid-walk) left the
  task's scheduled idle `step` armed; it later re-installed the task's stale
  start list over the refill's partition — the suite's intermittent
  `pageKeyChangeSplicesGovernedRange` failure (one-line partition after a
  successful splice), traced by a setter trap on `startIds`.
- 2026-09-01 — A10 shipped: the history AFTER snapshot is lazy (idle or before
  the next document change); the ~12 ms whole-document serialize leaves the
  keystroke path. Fixture `undo_lazy_snapshot`.
- 2026-09-01 — A8 shipped (scoped post-processing, post 30 → 24 ms) and
  exposed the real DOM-side floor: the window host's first geometry query is a
  ~20 ms layout flush; recorded as A11. A9 shipped (`svgFormatRaw`: host parse
  10 → 5.7 ms, visual baselines unchanged).
- 2026-09-01 — A7 shipped: naturals read from staff-line paths on a
  never-attached parse; `sigW` re-measured only when the window's folded head
  changes. Steady edit −24 ms instrumented (naturals 48 → 37, live flush gone);
  battery identical, suite 358/358.
- 2026-09-01 — A thread measured (`cb-splicecost.js` + 3 shape probes):
  Verovio window 84 ms is half the edit and the floor for this window shape;
  DOM side ~50 ms (host post-processing 30, flushes ~21), history snapshot 12.
  Leader is gate-only and cheap; pinned-lines naturals and `svgRemoveXlink` are
  dead ends; `svgFormatRaw` saves parse only. Plan: A7 layout-free naturals,
  A8 post-process replaced systems only, A9 svgFormatRaw, A10 lazy history
  snapshot ≈ 40–45 ms (25%) without touching a gate.
- 2026-09-01 — Test-mode O(n²) fixed: `flatChildren` / `allMeasures` verify
  once per document version (not per hit), and `locateCursor` reads the cached
  stops — the VoiceIndex cross-check was re-enumerating the document once per
  stop (24 s of the 27 s that remained). Bigrange under the flag: key case
  45.1 → 3.8 s, meter 38.8 → 2.5 s, outcomes and reference identical. New
  probe `cb-checkcost.js`.
- 2026-09-01 — Size caps dropped (both splicers); 17/25-line governed ranges
  splice at 1.2–1.3 s, their undos at 0.6–2.0 s (interior scoreDefs matched by
  successor id, not element identity — a document swap must not derive).
  Signature changes govern RANGES, not derives; replaced lines never compared
  live; context-line and reference-gate glyph identity. Sonata 115/115,
  420/420, 8/8; suite green under the flag.
- 2026-09-01 — All remaining sonata refusals root-caused (courtesy check holes,
  range head clef, relocated clef) and fixed; `meter.sym` kept at the score
  start; clef edits no longer leave later lines stale.
- 2026-08-31 — B1 dy-cascade, B3 courtesy window, B4 section headers, B5 lazy
  mount, eviction, zoom-neutral unit 8, user page breaks, Phase D (edit path
  O(edit), 308 → 168 ms).
- 2026-08-30 — Line-break and pagination ownership (pins + encoded), conservative
  repartition, never-painted castoff bootstrap, contained system splice v1.
