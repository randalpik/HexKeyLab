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
reference-clean. Steady-state edit ≈ 170 ms in Chromium. Size caps are gone
(2026-09-01): a 25-line governed range splices in ~1.3 s where a full render is
~1.7 s. Suite green under `HKL_INDEX_CHECK`.

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

**Next thread: A — splice cost.** A typical splice is ~170 ms, so the items
below that target tens of milliseconds are worth pursuing, and the large-range
numbers show where the linear costs sit. Start from "Where the time goes".

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
   exceeded.
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
  the flag off and on, every flag-gated verifier wrapped with a timer).
- **Behaviour gate for any edit-path change**: battery on both code states
  (stash / pop) — the splice/skip outcome per edit and `reference.ok` must be
  identical; wall is the win.
- **Visual discrepancies go to Max** as two images, uninterpreted.

## Where the time goes (2026-09-01, Chromium, sonata)

Steady-state one-note edit ≈ 170 ms (`cb-scale.js`): Verovio window `loadData`
+ `renderToSVG` ≈ 56 ms; splice DOM work ≈ 16 ms and FLUSH-bound (199 → 169
`getBBox` calls changed nothing — the levers are fewer mounted pages and fewer
read/write alternations); refill (sig diff + naturals) tens of ms;
`cursor.update` ×2 ≈ 4 ms; the rest dispatch/overlay/bridge. Per-edit work no
longer scales with the document (`querySelectorAll` 31 969 → 2 537,
`XMLSerializer` 495 → 54).

Large governed ranges (caps dropped): 17 lines / 78-measure window 1.18 s;
25 lines / 106 measures 1.32 s. The naturals window is ~5.5 ms per measure
(440–590 ms for 71–107 measures — four times a full render's per-measure
`loadData`, `breaks:'none'` on one giant system) and the window `loadData`
~0.4 s. Both scale with the range and are the first A targets for large edits.

## Open work

### A. Splice cost (next thread)

- **A6** — the splice's DOM cost is flush-bound: batch every read before any DOM
  surgery; keep fewer pages mounted. ~16 ms available.
- **Naturals window cost** — ~5.5 ms/measure on one giant system; measure
  whether layout or per-measure `getBBox` dominates, and whether naturals can
  be read from the window render the splice already does.
- **Window `loadData`** — ~5 ms per window measure; measure what a minimal
  window (no context/leader/trailer) would cost and what fidelity it loses.
- **A3** — collapse the two `cursor.update` calls (~2 ms; blocked on the
  `onStateChange`-before-`onChange` bridge ordering).
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
