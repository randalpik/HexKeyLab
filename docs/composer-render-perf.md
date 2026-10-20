# Composer performance — baselines and open levers

Where Composer's time goes on a large document, and the levers not yet
pulled. The architecture is in [architecture/composer.md](architecture/composer.md);
what was tried and why is in decisions.md / lessons.md under the dates cited.
Update this document as levers land or are rejected.

Backlog items this covers: "Improve speed in page view", plus Max's Performance
items on moving pagination, inactive-view re-engraves and PDF export off the
main thread.

## Baselines (2026-10-09, headless Chromium, `~/Documents/sonata.hkc`, 115 lines, 31 pages)

Probes are in `test/composer-inspect/sonata-probes/` (README there).

- **Edit**: a steady one-note edit costs 118–130 ms (`edit-cost-attribution.js`):
  render of the hunk window 95, splice 55, refill 38, naturals 34, DOM surgery
  15, mutation 11, post passes 10 (overlapping buckets). Unchecked sweep median
  124–165 ms (`splice-sweep.js`). The first edit after a load pays the
  in-flight assembly once (`finishSync`, ~7 s with the cursor deep).
- **Structural edits** (`command-splice-inventory.js`, cursor at m. 221): page
  break 258 ms, section header 152, mid-piece meter change 172, head meter
  change 785 (every measure to the next change re-flows — O(range) by nature),
  key change 296, pickup 1.3 s, insert measure 178, tempo 217; add instrument
  11.8 s through a full re-assembly, the one all-lines edit.
- **Zoom**: 0.93 s, zero Verovio loads, every system node kept
  (`zoom-roundtrip-cost.js`).
- **Load** (a full re-assembly — also what a page-scale change costs):

| Phase | Chromium | Calls | Notes |
|---|---|---|---|
| Verovio `renderToSVG` | 1.6 s | 20 windows | ~80 ms per 6-line window; per-system layout dominates |
| Verovio `loadData` | 0.5 s | 20 | parse + setup per window |
| `DOMParser` (window SVG + range MEI) | 0.5 s | 60 | |
| Post passes (`postProcessRendered`) | 0.9 s | 115 systems | text 150, instrument gaps 180, slurs 80, ties 190, barline snap 100 |
| Import + align + measure + fit + close | ~0.4 s | | one layout per system is inherent |
| `model.serializeRangeForRender` | 0.16 s | 20 | |
| Slice gaps (macrotask hops) | ~0.4 s | | was ~2 s with `requestIdleCallback` |
| **Whole document** | **5.1–5.6 s** | | first page 0.17 s (synchronous to the cursor's page) |

DOM calls per load, the ones Gecko charges for: `getBBox` 82 000 (79 ms here),
`querySelector`/`querySelectorAll` 200 000 (250 ms), `closest` 73 000, `getCTM`
3 400, `getScreenCTM` 684 (97 ms). Forced reflows ~450 — the passes are
already read-then-write batched; a reflow here is mostly the one layout a
freshly imported system must get. Probes: `load-profile-phases.js`,
`load-profile-dom-calls.js`, `load-profile-reflows.js`,
`pagination-fold-check.js`; run `load-reference-gate.js` after any change
here.

**Firefox is not measured** since the 2026-10-08/09 rounds (Max reported 20+ s
loads before them). Every lever below says which engine it should help most.

## Open levers, in the order to try them

Each is independent of the others.

1. **Verovio in a Web Worker** (expected: the biggest remaining win in both
   engines). Window renders are pure functions of a MEI string: a worker with
   its own Verovio can render chunk N+1 while the main thread imports,
   post-processes and measures chunk N. Main-thread work per load is ~2 s,
   Verovio ~2.1 s, so a pipelined load approaches max(2, 2.1) rather than the
   sum — roughly 5.1 → 3 s here, more in Firefox. Preconditions: load the WASM
   in the worker (`@hkl/notation` loads it from the CDN on the main thread
   today; the analyzer/orchestrator workers show the bundling pattern);
   `renderLineSystems` must send window MEI + options and receive SVG strings;
   `applyPartition` and the splicer can keep the main-thread toolkit. Risk: the
   second toolkit's output must be byte-identical (same build, options, font)
   — gate with `load-reference-gate.js`.
2. **Cross-pass `getBBox` memo** (expected: Gecko). The heavy passes measure
   the same ~150 elements per system once per curve or mark: 82 000 reads for
   ~17 000 elements. A memo keyed by element, cleared on any geometry write
   (~24 write sites across tielayout, slurlayout, instrgap, textlayout), would
   cut the count 4–5×. Worth it only if Firefox still shows the passes as a
   hotspot; the risk is a stale box after an unannounced write — gate with
   `load-reference-gate.js` and the engraving/tie/slur visual fixtures.
3. **Bigger chunks, small first chunk** (expected: small, both engines).
   `CHUNK_LINES` 6 → 12 halves `loadData` and the parses (~0.5 → ~0.3 s)
   at the cost of a longer first window; render the first chunk as 2–3 lines
   so the first page still paints in well under 200 ms.
4. **Deferred cosmetic passes** (expected: Gecko). Notehead z-order, theme and
   the snaps do not change a system's extents and could run at reveal rather
   than before the fold. The passes that change extents (instrument gaps,
   below-staff text, tuplet numbers, raised ties) grew 61 of 115 systems'
   bottoms by up to 420 units and must stay before measurement, and HEJI
   injection must run before all of them (2026-10-18). Saves ~250 ms here;
   worth it only with 2.
5. **Query hygiene** (expected: small). 200 000 `querySelector(All)` calls per
   load — the passes re-query obstacles per curve. A per-system element index
   built once and handed to every pass would remove most; same invalidation
   story as 2.

Not levers (measured): the slice scheduler (~0.4 s of gaps; a macrotask hop
is the floor); the number of forced reflows (~4 per system, each inherent to a
pass boundary); `serializeRangeForRender` (0.16 s).

## Other open items

- **Two `cursor.update` calls per edit**: `doReRender` and
  `composerOnStateChange` (both `main.ts`) each update the cursor; callers fire
  `onStateChange()` then `onChange()` (e.g. `linebreakCommands.ts`). Collapse
  to one.
- **Test-mode residual**: under `HKL_INDEX_CHECK`,
  `assertVoiceIndexConsistent` still calls the uncached measure-start lookup
  per stop (`model/index.ts`); cost unmeasured since 2026-09-01.
- **Firefox re-measure** of load, edit and zoom after the 2026-10-08/09
  rounds (Max).

## Rejected / dead ends (don't retry)

- `display:none` on `#score` to skip layout flushes — forces a from-scratch
  relayout on restore (~4× worse; lessons.md).
- Chunk virtualization of scroll view — superseded by one persistent SVG with
  spot splices (decisions.md "Scroll view: one persistent SVG…").
- Verovio `select` (measureRange) as a page-view window — a selection's layout
  re-breaks lines (lessons.md).
- Naturals from pinned lines or from a justified render, `svgRemoveXlink`,
  `getBBox` call-count reduction alone, leader/trailer removal, quantizing
  per-system placement terms or the distribution level — each measured and
  recorded in decisions.md / lessons.md (2026-09-01 to 09-04).
