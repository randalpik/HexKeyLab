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

**State.** On the 446-bar sonata every edit splices: sweep 115/115, exhaustive
every-measure pass 420/420 (empty refusal inventory), battery 8/8
reference-clean, suite 360/360 under `HKL_INDEX_CHECK` (~4 min). A steady-state
one-note edit is ≈ 144 ms instrumented (was 258 before the A thread; bare is
lower — read shares, not walls). The splice's DOM work is now a single layout
flush, the post-surgery snap; everything the splice reads from its window comes
from SVG text and the window is never attached. Verovio's window `loadData` +
`renderToSVG` (~84 ms) is well over half of the edit and is fixed by the
window's shape.

**Governing principle (Max, 2026-09-01):** *"The goal is to hit O(edit) in ALL
cases. Any time the user is exposed to O(document) on a live path when they
didn't ask for a change to the full document is a failure, full stop."* A
fallback is never an invariant; anything that currently derives or full-renders
is a defect with a date on it.

**Next steps, in order of value:**

1. **B2 — line-count-changing refills and pagination changes.** The remaining
   O(document) paths an ordinary edit can hit: a repair that turns N systems
   into M (today: full render), and a repair that moves a line across a page
   boundary (today: pagination handed back — the splicer is not consulted and
   no diagnostic is left). Both need the splice to replace N systems with M and
   re-place pages, under the same gates.
2. **The window's shape is the last latency lever, and it is a gate question.**
   Leader and trailer cost ~3 ms and are gate-only; the two context lines and
   the courtesy-extension line are ~60 ms of Verovio time that exist for the
   live fidelity test (context lines must reproduce live) and the courtesy
   signature the following line generates. A replaced-lines-only window costs
   ~24 ms of Verovio against 84. Shrinking the window means replacing the live
   context comparison with another fidelity test — lessons.md's rule against
   gate exemptions applies. Max's call; not started.
3. **Remaining structural bails** (each a derive): head/interior `rest`
   (staffDefs, elements before the first measure, credits — C2), user breaks,
   foreign document; the repair-loop caps (`MAX_ENSURES`, `MAX_REPAIR_STEPS`);
   a replaced line on an unmounted page that a PREVIOUS splice marked stale
   (`changed line not mounted` — B5's cheap mount refuses stale pages).
4. Small items: A3 (collapse the two `cursor.update` calls, ~1.6 ms, blocked on
   bridge ordering), A5 (worker-offloaded castoff `loadData`, ~1.4 s on the
   derive — big refactor, `afterRender` is the seam), the test-mode residual
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
  task's queued idle step must never write (decisions.md 2026-09-01).
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
  barline); both are gate-only — without the leader the replaced line's
  geometry is identical, only the context-above line changes. `<pb>` pins at
  live page starts and the live page options verbatim, so the window paginates
  like the document and a page-first system's position is READ, never modelled.
  Sub-MEI via `serializeRangeForRender`: running key/meter/clef folded into the
  head — including the range's own leading clefs (dropped from the range) and
  never clearing `meter.sym` without a meter — boundary scoreDefs inline.
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
  - *Vertical plan*: measured from the window's staff-top spacing chain, applied
    all-or-nothing (page-first systems read absolutely; the chain resets at
    page boundaries; `dyFollow` moves the followers on the last replaced page;
    a plan within EPS pins live positions).
  - *Section headers*: the mount-time injector records `data-reserve` and
    `data-baseline`; the plan reasons in Verovio coordinates and re-places
    titles; an unreadable value refuses.
  - *No size caps*: a window costs linearly in measures up to the whole
    document, so a subset render is never the worse deal.
- **Surgery**: import the replaced systems (`mergeGlyphDefs` per page from the
  parsed window's `<defs>`), then post-process THEM in place — crisp barline and
  right-edge snaps, notehead z-order, HEJI, theme, scoped to the imported
  systems, in the live page's own device frame — re-place section titles, move
  the followers by `dyFollow`, `snapPage`, mark the edited pages stale for later
  mounts. The snap's flush is the one layout the splice causes; every geometry
  read before it is text. Diagnostics on the splicer: `lastOutcome /
  lastSkipReason / lastRun / lastWindow / lastWindowMei / lastVertical`, and on
  a context refusal `lastContextDiff` (full per-measure diff + glyph census —
  the first mismatch a refusal names is where drift became visible, not where
  it started). `Renderer.lastPostStats` times the post-processing passes.
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

After every splice, a fresh full render of the same pinned MEI is compared
against every mounted page: system sequence, per-measure x/width (TOL 30),
absolute staff tops (reserve subtracted), section-title bands, and clef/keySig/
meterSig glyph codepoints (reference post-processed like the live page; this
gate attaches a host by design — it is a test-mode verification, not the
splice). Render errors are logged and re-thrown under the flag — a caught throw
is not a gate. `pnpm test:composer` does NOT set the flag; run
`HKL_INDEX_CHECK=1 node test/composer-test/run.mjs full`.

## Verification

- **Suite** (~4 min under the flag): the page-splice fixtures cover every
  mechanism above; each landed with its bug or feature and was run against the
  unfixed source (`test/composer-test/run-unfixed.sh <fixtures>` stashes
  `apps/composer/src`, runs, restores). A visual mismatch appends
  `window.__visualDiag` (fixture-recorded geometry) to its detail.
- **Sonata gates** (`test/composer-inspect/phasec/`, README there):
  `cb-splice-battery.js` (8 edits, whole-document reference compare — the
  behaviour gate, run on both code states), `cb-sweep.js` (every line once
  through the real IntersectionObserver: hit rate, refusal histogram, latency,
  viewport drift), `allmeasures.sh` + `allmeasures-report.mjs` (every measure;
  the only way to reach multi-line replaced-set classes), `cb-ctxdiverge.js`
  (root-cause a context refusal in one run), `cb-splicecost.js` (steady-state
  attribution: phase-tagged buckets, forced-flush detection with call sites),
  `cb-pathprofile.js` (text vs bbox geometry side by side over every line — the
  A11 proof; re-run after any change to `systemProfile` or to what the snaps
  rewrite), `cb-checkcost.js` (test-mode overhead attribution), `cb-bigrange.js`
  (large governed ranges). Measurement probes whose findings are recorded in
  decisions.md and are not routine gates: `cb-scale.js`, `cb-naturalsalt.js`,
  `cb-windowalt.js`, `cb-svgopts.js`, `cb-naturalspath.js`, `cb-govdiag.js`.

## Where the time goes (2026-09-02, Chromium, sonata, instrumented)

Steady-state one-note edit ≈ 144 ms (`cb-splicecost.js`; wrapper overhead
inflates walls, read shares). Splice ≈ 90: Verovio window `loadData` +
`renderToSVG` ≈ 84 (two window pages, 20 measures — fixed by the window's
shape; drawing, not layout: `loadData` is ~0.6 ms/measure, `renderToSVG`
3–4.5, and the first draw after a load carries the lazy layout); `spliceDom`
≈ 10 (imported-system post-processing 5.5 sharing the snap's flush, snap 1.8,
text profiles + imports ≈ 3). Refill ≈ 33, all the naturals window (its
`renderToSVG` ≈ 15 dominates; the DOM side is a parse). Outside the render
≈ 22: mutation ~10, overlay-height read ~6 (paint layout brought forward),
`cursor.update` ×2, dispatch. The history snapshot is off the keystroke.

Large governed ranges: 17 lines / 78-measure window ≈ 1.2 s; 25 lines / 106
measures ≈ 1.3 s. The naturals window is ~5.5 ms/measure and the window render
~5 ms/measure, ~85% of both Verovio's draw; they scale with the range.

Before/after bucket detail and the shape experiments (leader/trailer, pinned
naturals, SVG options) are in decisions.md (2026-09-01 "A thread measured",
2026-09-02 "For the record").

## Open work

- **B2 — line-count-changing refills and pagination changes** (START HERE 1).
- **Window shape** (START HERE 2) — a gate question for Max.
- **C2** — first-page credits: composer/footer changes still derive (rare).
- **A3** — collapse the two `cursor.update` calls (~1.6 ms; blocked on the
  `onStateChange`-before-`onChange` bridge ordering).
- **A5** — worker-offloaded castoff `loadData` (~1.4 s on the derive).
- **Test-mode residual** — `assertVoiceIndexConsistent` ×
  `getMeasureStartCursorUncached`: 0.7 s per index build on the sonata under
  the flag. Tolerable; not O(edit).
- **D. Tuning and features (Max's call)**: D1 vertical justification within a
  page (shares a page-fit model with the segmented castoff; needs system-height
  tracking); D2 FIT_MAX / MIN_FILL to taste (legality bounds, not packing
  targets); D3 explicit "reflow document" command (reflow is path-dependent);
  D4 explicit move-measure-between-systems commands. Noted, not fixed: a clef
  set on an EMPTY layer does not roundtrip (`<clef/><space/>` loads back as
  `<space/><clef/>`).
- **Dead ends (do not retry without new evidence)**: pinned-lines naturals;
  `svgRemoveXlink`; naturals from the splice window's justified render;
  `getBBox` call-count reduction; leader/trailer removal (~3 ms, gate-only).

## Status log

One line per landing; the reasoning is the dated decisions.md entry.

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
