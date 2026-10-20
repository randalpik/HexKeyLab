# Sonata probes

Whole-document gates, censuses and cost probes run against a large real score:
Max's Op. 12 sonata (`~/Documents/sonata.hkc`, his working copy — quote page
and measure numbers from it). The composer-test suite checks the same
invariants on small documents; these check them across ~450 bars and measure
what an edit, a load or a zoom actually costs.

Requires `pnpm dev`, `chromium` on `PATH`, and the sonata (override with
`SONATA=<path>`; a `.musicxml` path is imported instead of loaded).

```bash
node test/composer-inspect/sonata-probes/run-probe.mjs \
  test/composer-inspect/sonata-probes/<probe>.js [--arg "k=v,k2=v2"] [--no-sonata] [--screenshot out.png]
```

`run-probe.mjs` loads Composer in its own headless Chromium, loads the
sonata through `window.__composerLoadHkc`, waits for the render to settle,
evals the probe as an async IIFE (`--arg` → `window.__probeArg`) and prints its
JSON. One eval may take at most 300 s; long probes chunk with `from=`/`limit=`.
The `.mjs` files are standalone (their own Chromium).

Probes reach renderer internals by bracket access (`r['pageBreaks']`), so a
probe that fails on a missing handle is stale, not a regression — fix the
probe. Rules learned the hard way:

- **Nothing else on the machine meanwhile**: no suite, no build, no second
  probe. Concurrent Chromium inflates every bucket and pushes long probes past
  the 300 s eval deadline.
- **Don't edit app source while a probe or the suite runs.** Vite reloads the
  page and the injected hooks vanish (hundreds of "Cannot read properties of
  undefined" failures mean "the page reloaded").
- **Timing**: single readings vary ±15 %. Run 3× sequentially, compare medians,
  and prefer call counts (`querySelectorAll`, `getBBox`, `XMLSerializer`) —
  counts are deterministic, and a count that scales with the document is the
  bug whatever it costs today.
- **Inventories, not breadcrumbs**: record every deviation, never just the
  worst; chunk with `from=`/`limit=`, never sample with `stride` (stride 5 read
  0/23 where stride 1 read 4/25).

## Edit-path gates

Run these after any change to the refill, splicer, partition or pagination.

- **`splice-battery.js`** — ten edits through the live app, each asserting the
  splice outcome and a document-wide reference compare (every mounted page vs
  a fresh offscreen render of the same pinned MEI: system sequence,
  per-measure x/width, absolute staff tops, distributed on both sides; every
  deviation in `reference.devs`). Expect all edits spliced and
  `allReferenceOk: true`. `--arg "shot=<edit>,mode=spliced|reengrave,page=N"`
  stops after that edit and leaves one page for `--screenshot`, so the
  spliced/re-engraved pair can be heatmapped.
- **`splice-sweep.js`** — coverage + viewport gate: scrolls each line into view
  through the real IntersectionObserver, edits, restores. Reports hit rate, a
  refusal histogram, latency by outcome and viewport stability;
  `summary.pageBoxChanged`, `summary.scrollHeightChanged` and next-page anchor
  drift must all be 0. `check=1` adds the reference gate per position (chunk
  it: `check=1,from=1,limit=24`, then 25, 49, …).
- **`splice-every-measure.sh <outDir>`** + **`splice-every-measure-report.mjs
  <outDir>`** — the exhaustive pass (`splice-every-measure.js`, chunked at 70
  measures, resumable): edits every measure with deletable content. The report
  answers whether the outcome is a function of the replaced set, whether a
  multi-line set ever fails while its parts splice, the full refusal
  inventory, and whether position in the line matters. Use when a change could
  break multi-line replaced sets, which the sweep cannot reach.
- **`command-splice-inventory.js`** — fires every document-mutating command
  from one baseline (dialogs at model level, selections and clipboard through
  real events) and reports outcome, derive reason and wall. Nothing else
  asserts that a *command* splices.
- **`line-lock-commands.js`** — Alt+Shift+↓ locks with undo/redo and the
  padlock: derive reason must be empty and undo byte-identical.
- **`governed-range-edits.js`** — key, clef and meter changes far from their
  next reset, each with its undo; `check=1` under the reference gate.
- **`undo-reversibility-gate.js`** — delete + undo at several sites: the undo
  must restore partition and geometry exactly (`geomAfterUndo.changed` 0).
  The edit itself may reflow its section.
- **`splice-exactness-census.js`** — no-tolerance census of spliced pages vs
  the reference after every edit (the evidence behind the gate's `TOL`).
- **`load-reference-gate.js`** — fresh load, every page through
  `verifyAgainstReference`.
- **`pagination-fold-check.js`** — page-by-page first-fit check plus assembly
  load stats.
- **`page-distribution-check.js`** — rule-v2 acceptance per page: top gap,
  equalizing gaps, footer gap, evenness, overflow.
- **`staff-pixel-snap-audit.js`** — every staff on every mounted page on the
  device-pixel grid, before and after an edit.
- **`mount-scheduling-gate.js`** — the visible-first mount pump, after the
  assembly finishes: jumps and drags via `#score.scrollTop`, recording every
  page `mountOne` actually attaches, in order, and when the landing page
  appeared. Expect `ok: true` (visible page first, at most three mounts per
  run, no `loadData`).
- **`env-partition-sweep.mjs`** — the same document under DPR / window size /
  headless variations; the settled partition must not depend on them.

## Engraving censuses

Whole-document inventories for the render-clone and DOM layout passes.

- **`instrument-gap-census.js`** — inter-instrument clearance per adjacent
  instrument pair per system (`dOwn`, `dOther`, demand), plus the residue
  inventory of non-staff glyphs. `--arg "rows=0"` for the summary;
  `from=N,limit=M` to chunk the per-mark rows.
- **`mark-placement-census.js`** — every dynamic/text/hairpin: placement mode,
  clearance, collisions.
- **`part-marks-census.js`** — tempo restatement per part and fermata sides.
- **`same-moment-unstack-census.js`** — same-tstamp mark separation and the
  inter-staff gap it reclaims.
- **`slur-stem-census.js`** — per slur: stem directions under it, its side vs
  beams and tuplet brackets, the `data-hkl-stems` tag. `--arg all=1` lists
  every slur on a beam or bracket side.
- **`tie-clearance-census.js`** — every tie's outline vs the glyphs in its
  span, using the layout pass's own ink boxes.
- **`musicxml-export-coverage.js`**, **`musicxml-duration-gate.js`**,
  **`musicxml-roundtrip-gate.js`** — feature counts model vs exported XML;
  every measure of every part sums to its budget with no dangling spanner;
  export → re-import → census delta.

## Cost attribution

- **`edit-cost-attribution.js`** — a steady-state edit with every cost tagged
  by phase and every forced layout flush reported with its call site
  (`--arg "mi=<n>"`; `edit=append|appendnear|appendskipdefs`). Wrapper overhead
  inflates the wall — read the shares.
- **`load-profile-phases.js`**, **`load-profile-dom-calls.js`**,
  **`load-profile-reflows.js`** — a full re-assembly by function, by DOM call
  (count + time), and by forced reflow / curve sampling.
- **`zoom-roundtrip-cost.js`** — zoom round trip: wall, Verovio loads (must be
  0), outcome.
- **`index-check-overhead.js`** — what `HKL_INDEX_CHECK` costs and where
  (`--arg "case=meter"` for the meter case).

## Tools

- **`page-screenshots.mjs <outDir> 1,16,17 [probe.js]`** — one clipped PNG per
  requested page, optionally after a probe.
- **`pdf-wysiwyg.mjs <outDir> [1,2,5]`** — exports the PDF from the live page
  DOM, checks page-count parity and shoots the live pages; compare with
  `pdftoppm -r 254 -f N -l N -png -singlefile sonata.pdf pdf-pN` and
  `test/composer-test/heatmap.py` (254 dpi = the screen's 2159 px over 8.5 in at
  zoom 100). Expect edge anti-aliasing only, plus the known `Times, serif`
  width residual.

Findings from these probes are recorded in docs/decisions.md and
docs/lessons.md under the dates they were made.
