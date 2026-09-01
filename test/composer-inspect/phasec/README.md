# Phase C large-score probes (sonata)

The composer-test suite gates the line-break ownership on SMALL docs; these
probes are the large-score battery (446-bar sonata) that validated Phase C-A
and will re-validate Phase C-B. They live here so they don't die with a
session scratchpad (the spike-1/2/3/5 probes did — re-deriving them costs a
session).

Requires: `pnpm dev` running, `chromium` in PATH, and the sonata at
`~/Documents/sonataBr1.musicxml` (override with `SONATA=<path>`).

```
node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/refill-smoke.js
node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/battery.js
```

- **runner.mjs** — loads `/composer/`, imports the sonata via
  `window.__composerImportMusicXml`, waits out the deferred render, then
  evals the probe file's contents as an async IIFE and prints its JSON.
  `--no-sonata` skips the import.
- **refill-smoke.js** — three sonata edits through the live app: asserts the
  refill path (not derive), pins honored verbatim on mounted pages, bounded
  cascade, no-op render stability, and prints the refill timing breakdown
  (`PageLineBreaks.lastRefillStats`).
- **battery.js** — the Phase C-A gate battery: enablement parity (pins +
  breaks:'line' vs the smartSb0 render, per-measure x/width deltas — expect
  0.0) + a six-edit battery (mid-line / line-start / overflow / volta /
  region-end / doc-end) asserting refill path, pins-verbatim, and
  untouched-line geometry stability. NOTE the two known benign readings:
  the edited line counts as "untouched" when the partition doesn't move
  (its internal justification legitimately shifts), and a boundary moving
  next to a scoreDef re-spaces the previous line's end-of-line courtesy
  signatures (~33 units) — the C-B re-splice-k−1 case. (Known wart: it
  waits on a renderer field `pendingDirty` that no longer exists, so each
  edit rides its 40 s waitFor timeout — functional but slow; the C-B
  battery below waits on the busy badge instead.)

Phase C-B probes (2026-08-30, findings baked into
`docs/composer-page-splice-design.md` → "Implementation (Phase C-B v1)"):

- **cb-structure.js** — page-mode structural survey: `g.ending` parentage
  (inside `g.system` → whole-system splices carry volta brackets), the
  vertical stacking model (content-driven clearance, no vertical
  justification, margin-anchored first systems), page bottom slack, existing
  system transforms (section-header reserve).
- **cb-window.js** — window fidelity: pin-anchored windowed sub-renders
  (synthetic mRest leader + sb pins, page geometry, tall page, breaks:'line')
  vs an offscreen pinned full render — per-measure x/width, staff-line ys,
  hanging extents, and consecutive-system spacing (the pairwise-locality
  check that lets the splice MEASURE follower dy). Expect delta 0.0 except
  line 0 and section-boundary zones.
- **cb-splice-battery.js** — the C-B acceptance-gate battery: eight edits
  through the live app, each asserting the splice/skip outcome AND a
  document-wide reference compare (every mounted page vs a fresh offscreen
  render of the same pinned MEI: system sequence, per-measure x/width,
  spacing, and — since B1 — **absolute** staff tops, because a cascade that
  shifted a whole page by a constant passes every spacing check; section-header
  pages exempt the vertical checks, their reserve translate is a main.ts
  injection). Expect allReferenceOk true and 7/8 spliced (the section-header
  line is the by-design fallback); spliced edits ~260–570 ms wall.

Phase C-B2b / B1 probes (2026-08-31, findings baked into the design doc →
"Implementation (Phase C-B2b / B1)" and lessons.md):

- **cb-dycascade.js** — the B1 spike, and the reason B1 was not a two-line
  change: runs page-first deletes on pages 3–7, captures the splicer's
  `lastVertical` plan, then measures what the ENSUING render actually did and
  reports predicted-vs-actual per system plus `maxPredictionError`. That number
  is the gate for any change to `verticalPlan` — it went 425 → 8 units when the
  window was made to paginate like the live document. Note the static cases
  read as "error" because the splice keeps live positions by design; only
  non-static rows are real evidence.
- **cb-anchor.js** — every mounted page's first system (margin ty, staff top,
  bbox top, hang). Shows the page-first anchor is NOT a constant bbox top:
  staff tops sit on a 10-unit snap grid with a floor, and bbox tops range
  297–612.
- **cb-topmost.js** — what actually reaches above a page-first system: the
  outliers are all `<text>` (`g.dir`, `g.tempo`, HEJI `g.accid`), which is why
  a bbox hang cannot stand in for Verovio's counted overflow.
- **cb-header-overlap.js** (run with `--no-sonata`) — the B4 repro: builds a doc
  with a section header, edits the line directly ABOVE it on the same page, and
  reports how far the header's system moved versus its title. `BUG: true` means
  the title was left behind (pre-fix: system 149 px, title 0). Also the quickest
  way to see the second half of that defect — pre-fix `dyFollow` is short by the
  full 900-unit reserve.
- **cb-cascade-overflow.js** (run with `--no-sonata`) — builds a packed page,
  then grows successive systems until the cascade exhausts page 1's slack;
  asserts the splice hands PAGINATION back (warn + derive) and that nothing is
  ever drawn past the paper. Reports per-step slack, so it also documents how
  much room a cascade actually has.
- **cb-focus.js** — three consecutive edits at one spot (sonata measure 100):
  the first may full-render (first-edit-in-region re-break), the rest must
  splice. The probe that found the end-of-score final-barline artifact
  (fixed by the synthetic trailer).

All probes read renderer internals via bracket access
(`renderer['pageBreaks']`, `renderer['pageSplicer']` etc.) — update them if
those fields move.

Conservative-repartition probes (2026-08-30, the reflow-reversibility ruling):

- **cb-noreflow.js** — the reversibility gate at sonata scale: for four edit
  sites, delete a note and undo THROUGH REAL KEYSTROKES (Backspace / Ctrl+Z,
  note-count-checked — a direct `model.deleteAtCursor()` skips `withHistory`,
  so undo silently no-ops and the probe eats a chord per cycle; see
  lessons.md), asserting the partition holds on both steps, `movedLines` is 0,
  and the post-undo geometry matches. Expect 4/4 held, 3/4 bit-exact and the
  4th within a few units of snap noise.
- **cb-noreflow2.js** — two identical delete+undo cycles at one site plus a
  live-vs-fresh-full-render comparison, to tell a one-time transition from a
  per-cycle drift. (Written before the keystroke fix; its numbers are the
  artifact — kept because the live-vs-reference comparator is the useful part.)
- **cb-undodiff.js** — model-level diff of a delete+undo round trip (serialized
  measures + whole-doc). The probe that identified the artifact above.
- **cb-stalemount.js** — after a real splice, force the edited page back to a
  placeholder and re-mount it: the freshly mounted page must draw the CURRENT
  document (pageVirt.stale → re-serialize + re-pin). Expect `staleFlag: true`,
  `ok: true`, remount ~1.5 s (one loadData, off the hot path).

Pagination-ownership + latency probes (2026-08-30):

- **cb-pagination.js** — the gating probe for owning pages: renders the same
  pinned document with `breaks:'line'` (sb pins) and `breaks:'encoded'` (sb +
  pb pins) and compares page count, per-page system split, per-measure
  geometry and load time. Expect identical pagination, 2× faster encoded
  load, and a non-zero justification delta (~52 px) — that delta is the
  accepted one-time respacing.
- **cb-pagerender.js** — renders ONE page in a chosen mode into `#score` for
  screenshotting: `--arg line:3` / `--arg encoded:3` with `--screenshot <path>`
  (both flags are new in runner.mjs, along with `--arg` → `window.__probeArg`).
  This is how the encoded-vs-line question was put in front of Max as images.
- **cb-pageown.js** — pagination-ownership acceptance: pins honored per page,
  no page overflows, live DOM self-consistent with a fresh full render of the
  same pinned MEI, and the user-`<pb>` quirk status (still 37 → 2 pages).
- **cb-profile.js** — attributes ONE steady-state spliced edit by wrapping the
  hot primitives (Verovio loadData/renderToSVG, XMLSerializer, model.serialize)
  and the phase boundaries (mutation, renderComposer, cursor.update). Mounts
  the pages around the edit first, and runs a throwaway edit before measuring
  (the first edit after a derive always full-renders). This is the probe that
  answers "why isn't a splice as fast as editing a short score".

Break-mode forensics + the castoff bootstrap (2026-08-30):

- **cb-modes.js** — renders the same document as `auto` / `smartSb0` / `line` /
  `encoded` and compares per-measure x and width, with a percentile
  distribution. The evidence that the modes space identically-broken music
  differently (median 26 units, max 516) and that `line` ≡ `smartSb0`.
- **cb-whymode.js** — isolates MODE from CONTENT: same pinned data under
  `line` vs `encoded` (409/446 measures differ) versus `encoded` with and
  without `<pb>` (0 differ). Proves the break algorithm is the cause and the
  page-break elements are inert.
- **cb-sbcorrelate.js** — classifies every line by its relation to document
  `<sb>`/`<pb>` and mid-piece `<scoreDef>` landmarks, to test whether the
  spacing difference is a section-break artifact. It is not: 85 of 118 lines
  are "plain" and still drift.
- **cb-linepb.js** — does `breaks:'line'` honor `<pb>`? It does (pagination
  follows the pins exactly, spacing unchanged) — correcting the C-A note.
- **cb-getmei.js / cb-tkapi.js / cb-pagebased.js** — the getMEI investigation:
  call shapes, what this build exposes, and the decisive check that page-based
  `getMEI({scoreBased:false})` yields a partition byte-identical to the SVG
  walk in ~98 ms instead of ~1830 ms.
- **cb-wholenote.js** — rebuilds the `phase3_section_header` fixture and
  measures the whole-note placement and system widths in each mode (the
  extreme case Max flagged). Run with `--no-sonata`.
- **cb-loadcost.js** — forces three derive renders and reports wall time,
  ownership state, whether an idle walk was armed, and whether the first edit
  afterwards splices. The check that the extra first-paint cost happens once.
- **cb-scale.js** — the scaling baseline: the SAME instrumented edit on an
  empty doc, a one-page doc, and the sonata (`--arg empty|page|sonata[:measure]`;
  use `--no-sonata` for the first two). Shows bucket-by-bucket which costs are
  O(document) and which are flat. Pick a measure index known to splice for the
  sonata (`--arg sonata:100`) — mid-document defaults can land in a zone that
  legitimately refuses.

Phase D (edit-path O(edit)) workflow, 2026-08-30:

- **`cb-scale.js --arg sonata:100` is the Phase D dial.** Its `steady` block
  (not `warmup` — the first edit after a derive differs) is the per-edit
  attribution: wall plus `querySelectorAll` / `XMLSerializer` / `getBBox`
  counts. Counts matter as much as milliseconds — a count that scales with the
  document is the bug, whatever it costs today.
- **`cb-splice-battery.js` is the behaviour gate for any edit-path change**,
  and the way to use it is on BOTH code states: `git stash push -- apps/composer/src`,
  run it, `git stash pop`, run it again, diff the table. What must be identical
  is the splice/skip OUTCOME per edit and `reference.ok` on every one; wall
  times are the win. This is what showed that two entries' `editOk: false`
  (`reinsert-mid-line`, `insert-rest-ripple`) is pre-existing rather than a
  regression — the probe records that flag but does not assert on it.
- **Don't edit app source while `pnpm test:composer` is running.** Vite HMR
  reloads the page mid-run and the injected `window.__test` hooks vanish, which
  surfaces as a few hundred fixtures failing with
  `Cannot read properties of undefined (reading 'assertPlaceholderInvariant')`.
  That signature means "the page reloaded", not "the change broke everything".

Phase D pass 4 probes (2026-08-31):

- **cb-editok.js** — why an edit doesn't apply. Reproduces one battery edit
  sequence per run (`--arg reinsert:before|reinsert:after|ripple:before|ripple:after`,
  pairs with `--screenshot`) and reports the tick arithmetic at the refused
  call: the target measure's free ticks, the NEXT measure's free ticks, and
  whether the documented rule ("content landing past the cursor's measure
  requires that target layer empty") permits the insert. This is the probe that
  showed the two `editOk: false` battery entries were asking for overflow into
  full measures — a test bug, not a model bug.
- **cb-zoomcache.js** — the A4 gate. Walks 50 → 100 → 50 → 100 (every step a
  REAL zoom change; `setZoom` to the current zoom renders nothing, which
  invalidated the first version of this probe) and instruments the decision
  points — `PageLineBreaks.restorePartition` for a cache hit,
  `adoptFromCastoff` for a real castoff — rather than inferring from `loadData`
  counts. Expect: first visit castoff, return visit cache hit with an identical
  partition hash, and a stale entry (after an edit) re-deriving. NOTE the
  subtlety that bit the first run: an edit's own re-render refreshes the CURRENT
  zoom's cache entry, so only the OTHER zoom's entry is stale afterwards.
- **cb-zoominvariant.js** — forces a real castoff at every zoom preset and at
  two page scales, and hashes each partition. The probe that refuted "zoom is
  pure magnification, so it can leave the cache key": zoom 75 yields 134 lines
  where 50 and 100 both yield 118.

**Measurement discipline for `cb-scale.js` (learned the hard way, 2026-08-31):**
single steady-state readings vary 166–206 ms on the same code. A 15 ms
difference between two single runs is NOISE. Run it **3× sequentially** (not in
parallel — concurrent Chromium instances contend for CPU and inflate every
bucket) and compare medians, and prefer the CALL COUNTS (`querySelectorAll`,
`XMLSerializer`, `getBBox` `n`) over the millisecond figures when judging
whether a change did what it intended: counts are deterministic, times are not.
This is how the A6 attempt was correctly identified as a no-op — 199 → 169
getBBox calls with the time unchanged, which is what "flush-bound, not
call-bound" looks like in the data.

C1 (user page break) probes, 2026-08-31:

- **cb-userpb.js** — the C1 repro and gate. Inserts a user `<pb>` at bar 60 via
  `togglePageBreakAt` (what Ctrl+B calls), then reports page count, systems per
  page, and any page whose last system hangs past the paper, before / with /
  after the break — plus an ownership block (does our page list match the DOM, is
  the break measure one of our page starts, does `verifyRenderedPartition` pass).
  Pre-fix: 37 → 2 pages with 6 800 px and 59 534 px overhang. Post-fix: 37 → 38,
  zero overhang, but `ownedPages` one short — the open half of C1.
- **cb-pbadopt.js** — why adoption misses the break's page. Dumps the page-based
  MEI structure (pages, systems per page, pages whose first system has no
  measure, where the break lands) for the SAME data under `line` vs `encoded`
  vs raw-without-sb-baking. This is what showed `'line'` putting the user break
  mid-page while `'encoded'` breaks there correctly.
- **cb-pbconverge.js** — does the resulting mismatch settle or loop? Five
  successive no-change renders plus an edit near the break, counting
  `[page-breaks]` warnings each round. Expect: converged (0 warnings after the
  first), pagination stable, and the edit safely skipping with
  `window paginated` rather than splicing.
