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
`docs/composer-page-splice-design.md` → "The system splice"; the v1 account is
in decisions.md, 2026-08-30):

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
- **cb-placement.js** — Phase 1 measurement/proof of the vertical-ownership
  plan (2026-09-02): mounts every sonata page and, per system, reads the
  staff-line frame, the post-processed bbox extents (above / below) and the
  header reserve, then tests Composer's clearance rule
  (`render/pagefit.ts`: `max(below,F) + G + max(above,F)` between systems,
  `pageHeaderBottom + 2u + max(above,F)` for a page's first — C0 when the
  page has no `g.pgHead`) against the actual staff tops.
  On the pre-ownership build this calibrated F/G/C0 (86 pairs: 73 within 1
  unit, 85 within 3; 30 page-firsts: residual ≤ 0.1 unit on glyph-topped
  pages); on the owned build it is the self-consistency check (every gap and
  every first within 1 unit of the rule). Diff two runs offline for the
  per-system before/after table.
- **cb-courtesystub.js** — Phase 0 proof of the vertical-ownership plan
  (2026-09-02): one deletion per sonata line, restored between edits; records
  the splice outcome, window shape, Verovio cost of re-rendering the window and
  every window system's per-measure relX/width, staff top and signature glyph
  codepoints (text-based). Run on BOTH code states (stash / pop, two halves
  with `--arg "from=0,limit=58"` / `"from=58,limit=60"` to stay under the
  runner's 300 s eval limit) and diff offline by position — ids do not compare
  across runs. Expect identical systems for L−1 / hunk / L+1 everywhere and a
  one-measure stub where the extension line used to be.
- **cb-splice-battery.js** — the C-B acceptance-gate battery: ten edits (eight originally)
  through the live app, each asserting the splice/skip outcome AND a
  document-wide reference compare (every mounted page vs a fresh offscreen
  render of the same pinned MEI: system sequence, per-measure x/width,
  spacing, and — since B1 — **absolute** staff tops, because a cascade that
  shifted a whole page by a constant passes every spacing check; section-header
  pages are verified like any other since B4 — only an unreadable reserve is
  exempt). Expect allReferenceOk true, allEditsApplied true and **10/10
  spliced** as of 2026-09-02: B2 added `append-at-end` (four bars appended in
  one render — a new final line AND, on the sonata, a spill into a CREATED page;
  ~700 ms wall) and `delete-whole-line` (a mid-document line's measures removed
  in every voice — the line vanishes; `setVoice` before each voice's deletes, since
  `deleteAtCursor` acts on the current voice). The eight prior edits splice at
  ~140–380 ms wall.

Phase C-B2b / B1 probes (2026-08-31, findings baked into the design doc →
"Implementation (Phase C-B2b / B1)" and lessons.md):

- **cb-dycascade.js** — the B1 spike, and the reason B1 was not a two-line
  change: runs page-first deletes on pages 3–7, captures the splicer's
  `lastVertical` plan, then measures what the ENSUING render actually did and
  reports predicted-vs-actual per system plus `maxPredictionError`. That number
  was the gate for any change to `verticalPlan` — it went 425 → 8 units when the
  window was made to paginate like the live document. HISTORICAL since the
  vertical-ownership plan's Phase 1 (2026-09-02): `verticalPlan` is gone and
  `lastVertical` is always null; placement is gated by `cb-placement.js` and the
  reference gate's staff-top check instead. Note the static cases
  read as "error" because the splice keeps live positions by design; only
  non-static rows are real evidence.
- **cb-anchor.js** — every mounted page's first system (margin ty, staff top,
  bbox top, hang). Shows the page-first anchor is NOT a constant bbox top:
  staff tops sit on a 10-unit snap grid with a floor, and bbox tops range
  297–612.
- **cb-topmost.js** — what actually reaches above a page-first system: the
  outliers are all `<text>` (`g.dir`, `g.tempo`, HEJI `g.accid`), which is why
  a bbox hang cannot stand in for Verovio's counted overflow.
- **cb-sweep.js** — the COVERAGE + viewport gate, and the one to run when asking
  "how often does a splice actually land?". Walks every line, scrolls each into
  view through the real IntersectionObserver (it never calls `mountPage`, unlike
  the battery), edits, and restores via `restoreSnapshot` so each line is
  measured against the same baseline document. Emits a hit rate, a skip-reason
  HISTOGRAM, latency split by outcome, pages mounted at edit time, and
  viewport stability (`scrollTop`, container `scrollHeight`, per-page
  `offsetHeight`/`viewBox`, and document-space drift of anchors above/at/below
  the edit). This is the ROUTINE gate: it reaches 127 of the 170 replaced sets
  and 6 of the 7 known refusal causes; its one blind spot is `m-cy6 dW=89`, seen
  only at a line edge (the document's last line) — use `allmeasures.sh` for that.
  The viewport counters ARE part of the gate: `summary.pageBoxChanged`,
  `summary.scrollHeightChanged` and the per-row next-page anchor drift must all
  be 0 (2026-09-02: they had read 3 / 6 / 90 px since A8 while the hit rate
  stayed 115/115 — a header page resized on its first splice — and nobody had
  looked). Targets the first note/chord on each line in whichever voice has
  one — a measure-start cursor lands on a measure or tuplet placeholder, where a
  delete is a cursor move by design and the line measures nothing (8 of 115 on
  the sonata). Args: `--arg "stride=4,limit=20,undo=0"`. Use the NEXT-PAGE anchor
  to judge drift — the page-top anchor can itself sit inside the replaced run,
  in which case it moves legitimately.
  Phase 2 (2026-09-02) adds the cascade counters `summary.cascadeSteps` /
  `cascadeTransplanted` / `cascadeArithmetic` / `cascadeCreated` /
  `parkedSteps` (per row: `row.cascade` = `Renderer.lastCascade`); `parkedSteps`
  must be 0 once the extents job has run.
- **cb-allmeasures.js** + **allmeasures.sh** + **allmeasures-report.mjs** — the
  EXHAUSTIVE pass: edits every measure that has deletable content, records the
  replaced set and outcome, restores between edits. Run it via the shell script
  (chunked at 70 measures — the runner's `Runtime.evaluate` deadline is 300 s and
  the full walk needs ~4× that; chunks are saved as they complete, so re-running
  resumes), then report:

  ```
  test/composer-inspect/phasec/allmeasures.sh /tmp/hkl-allmeasures
  node test/composer-inspect/phasec/allmeasures-report.mjs /tmp/hkl-allmeasures
  ```

  The report answers the four questions the pass exists for: is the outcome a
  function of the replaced set (2026-09-01: yes — 170 sets, 0 conflicts); does a
  multi-line set ever fail while all its constituents splice (no — 0 of 62, all
  5 failures inherited); the full refusal inventory; and whether position within
  the line matters (it does not — 92.7/91.5/92.6 %). Use this when a change could
  plausibly introduce a failure mode specific to MULTI-LINE replaced sets, which
  `cb-sweep.js` cannot reach.
- **cb-startzone.js** — the two refusals that were excluded BY NAME rather than
  by measurement: the score-start line (line 0) and section-header lines. Edits
  one seed line, reports the splicer's verdict, then compares the resulting live
  page against a full re-engrave of the same model — the same comparison
  `verifyAgainstReference` makes, but REPORTING every delta instead of throwing
  on the first, so a refusal and a divergence are legible in one run. It also
  reports each section title's `titleGap` (its baseline's distance to its own
  system's content top), which is the invariant `injectSectionHeaders`
  establishes and a splice of the header's own system must reproduce —
  `reserve - baseline`, 540 units on this document.
  `--arg "case=line0"` / `"case=header,seed=0"` / `"case=line,line=57"`, plus
  `check=1` to run the inline `HKL_INDEX_CHECK` gate (its throw is caught and
  reported), `edit=0` to measure a zone without touching it, and
  `shot=live|ref` to leave either the spliced page or a freshly-mounted
  reference render alone in `#score`. Run it twice with the two `shot` values
  and one `--screenshot` each to hand Max two flippable images of the same page.
- **cb-ctxdiverge.js** — root-causes a `context line ... diverged` refusal in
  one run. Edits one seed per requested line (`--arg "seeds=54;55;57;59@241;77@326;115"`,
  `line@measure` pins the target — the replaced set depends on which measure's
  spanners the edit touches) and dumps everything the splicer records on the
  refusal path: `lastWindow` (lines, measures, leader/trailer, pins, courtesy
  extension), `lastContextDiff` (the FULL per-measure x/width diff of the
  diverged line — `profilesMatch` names only the first mismatch, which is where
  drift becomes visible, not where it starts — plus a glyph-class census of
  window vs live per measure and the clef glyphs' SMuFL codepoints), the range
  head vs the full render's effective clef/key/meter at the window start, the
  measure just beyond the window (would live draw a courtesy there?), and every
  range measure whose serialized MEI differs from `serialize()`'s. This is what
  reduced the six remaining sonata refusal signatures to three mechanisms in
  one afternoon (2026-09-01): the courtesy check missing `scoreDef > sb >
  measure` and non-first staves, the range head keeping the OLD clef when the
  range opens at a leading clef, and the `relocateInitialClefs` cross-measure
  dependency. Every edit is undone via `restoreSnapshot`.
- **cb-clefprop.js** (run with `--no-sonata`) — the clef-propagation finding:
  builds the `pageSystemSpliceRelocatedClef` document, sets a clef after a
  line-start measure's first chord, renders, deletes that chord (the clef becomes
  measure-initial and `relocateInitialClefs` moves it onto the line above),
  renders again, and compares page 1 system by system — pre-edit live, post-edit
  live, the splicer's vertical plan (pre-Phase 1; null now), and a fresh full-render reference, each with
  system heights and clef glyph codepoints. Pre-fix the PRE-edit page already
  showed the lines after the clef in the old clef (`E050` vs reference `E062`,
  −960 units of height): a clef edit had spliced one line and left the rest of
  the staff stale. Inline clefs are interior structure now (clef edits derive).
- **cb-scrollsig.js** (run with `--no-sonata`) — scroll-view signature edits: a
  mid-piece key change and a mid-measure clef change through the model, reporting
  whether the persistent SVG root survived and which glyphs the changed measure
  draws. Found (2026-09-01) that a mid-piece key change in scroll view rendered
  NOTHING — the scroll splicer's per-measure diff cannot see a section-level
  scoreDef — which the governed-range rule (`render/sigranges.ts`) fixes.
- **cb-bigrange.js** — large governed ranges after the size caps were dropped
  (2026-09-01): a key change, a staff-1 clef change and a width-neutral meter
  change far from their next reset, each followed by its undo. Reports outcome,
  run, window size, wall, the edit/refill split and the naturals-window cost;
  `--arg "check=1"` verifies under the reference gate (~2–3 s over production
  per case since 2026-09-01 — the reference full render + VoiceIndex
  cross-check; it was ~40 s — see lessons.md on cache re-verification and
  `cb-checkcost.js`). The large-edit cost baseline for the A thread: 17 / 25
  lines splice in 1.18 / 1.32 s, naturals ~5.5 ms/measure, window `loadData`
  ~5 ms/measure.
- **cb-checkcost.js** — attributes HKL_INDEX_CHECK (test-mode) overhead: runs
  the bigrange key case with the flag off and then on, wrapping every
  flag-gated verifier, the cached accessors and the Verovio toolkit with
  timers, and prints call count + inclusive wall per wrapper. Found
  (2026-09-01) that after the caches went once-per-version, 24 of the
  remaining 27 s were `assertVoiceIndexConsistent` — `locateCursor` was
  re-enumerating the document on every per-stop call. `--arg "case=meter"`
  runs the meter case instead. Note the second (flag-on) pass can refuse with
  `changed line not mounted` because the first pass's restore leaves stale
  pages; the attribution is unaffected.
- **cb-commands.js** — the COMMAND inventory (2026-09-02): fires every
  document-mutating user command on the sonata from one baseline and reports
  outcome, derive reason and wall. Dialog commands are driven at the model
  level; selection commands enter selection through the real Shift+arrow keys;
  clipboard cases harvest the text through a real `copy`/`cut` event and hand
  it back through a real `paste` event (Ctrl+V does nothing on its own — paste
  is a ClipboardEvent handler). Exists because nothing ASSERTED that a command
  splices, which is how Ctrl+M's 2.8 s derive survived unnoticed. Run it after
  any change to the refill's bails. Current: 24 mutating, 19 spliced; of the
  five derives, three genuinely add a user break (Ctrl+B, section header,
  pickup), one exhausts the repair cap (mid-piece meter) and one is structural
  (add instrument).
- **cb-insertpos.js** — insert-measure at a spread of positions, plus a measure
  delete and a note delete as controls, reporting the replaced LINE run, the
  window size and the refill breakdown per position. This is what showed the
  cost was position-dependent (2.9 s at a section start, 4.1 s in the last
  section, 0.4 s mid-section) and that every run ended on a section boundary.
  `--arg "pos=2,8,60"` picks the positions.
- **cb-splicecost.js** — the A-thread attribution probe (2026-09-01): a
  steady-state Backspace mid-document (warm-up + two steady runs) with every
  cost tagged by the phase it ran in (mutate / refill / naturals / splice /
  liveSys / spliceDom / post / snap / cursor); every `getBBox` and
  `getBoundingClientRect` is timed and a call over 0.5 ms is reported as a
  forced layout flush WITH its call site; then the captured window MEI is
  re-timed as full / no leader+trailer / replaced-lines-only. Wrapper overhead
  inflates the wall (~258 vs ~170 ms bare) — read the shares. Found: Verovio
  window 84 ms, host post-processing 30 ms, five flushes ~27 ms, history
  snapshot 12 ms. `--arg "mi=<n>"` picks the measure. Phase 2 (2026-09-02):
  `--arg "edit=append"` runs the battery's append-at-end edit with every page
  mounted (attributes the cascade onto a created page: `cascade`, `mountPass`,
  `createShell` phases, `cascade` record per run), `edit=appendnear` the same
  with only the last three pages mounted (the user's condition — 37 ms
  cascade), `edit=appendskipdefs` without copying glyph defs (the experiment
  that priced them at ~30 ms).
- **cb-naturalsalt.js** — naturals shape: the same 100-measure range as one
  giant `breaks:'none'` system (today), pinned at the live line starts with
  `noJustification`, and pinned justified; load/render wall and per-measure
  width agreement (interior / system-first minus sigW / system-last). Found
  the giant system is NOT superlinear (5.2 vs 5.4 vs 5.3 ms/measure) and
  `renderToSVG` is ~85% of it. Dead end recorded in the design doc.
  `--arg "lo=<mi>,n=<count>"`.
- **cb-windowalt.js** — is the synthetic leader load-bearing? Performs the
  splicecost edit, re-renders the window without the leader and without
  leader+trailer, and reports per-system geometry deltas (measure x/width,
  staff top, spacing from the system above, height) for the context and
  replaced lines. Found: replaced and below lines identical (delta 0); only the
  context-above line changes; leader + trailer ≈ 3 ms of Verovio.
- **cb-naturalspath.js** — the A7 proof: renders every sonata measure through
  the naturals recipe in ~150-measure windows and compares, per measure, the
  staff-line span read from the SVG text (`M x1 y L x2 y`, no layout) with the
  `getBBox` natural the refill used to read (`next.x − this.x`; last measure
  `bbox.width`), plus the left overhang that explains any difference and the
  cost of each reading path. 2026-09-01: 441/443 interior + all window-last
  measures identical; the two deltas are window-first measures over-counted by
  the 144-unit system-start brace. Text path 233 ms vs bbox path 672 ms.
  `--arg "win=<n>"` sets the window size.
- **cb-pathprofile.js** — the A11 proof (2026-09-02): drives real edits on the
  sonata (`--arg "stride=1,from=1,limit=58,edit=delete|key"`; a deletion per
  line, or a governed-range key change at a line start), and for every splice
  re-renders the captured window MEI and computes, for each window system and
  its PRE-edit live counterpart, the bbox-based profile (what `systemProfile`
  read until A11) and the path-based one (staff-line spans + transforms).
  Reports per edit the context-gate deltas under each basis, each side's
  internal bbox-vs-path disagreement, the placement dx/dy under each basis,
  and aggregates with outliers. Result over 126 edits / 117 splices: staff
  top, dx, dy and gate verdicts identical (Δ 0; max gate width delta 3 under
  both — the live right-edge snap). Re-run after any change to
  `systemProfile` or to what the snaps rewrite.
- **cb-govdiag.js** (run with `--no-sonata`) — mirror of the composer-test
  fixture `pageKeyChangeSplicesGovernedRange`: builds its 40-measure document,
  applies the reset key change (line 5) and the edit (line 2), and prints every
  refill input the legality decisions depend on — sigW, budgetW, per-line
  natural sums and fills — plus the partition before/after and the splicer's
  run. Written while hunting that fixture's intermittent full-suite failure
  (2026-09-01); showed fills of 0.96–1.02, nowhere near the bounds, which ruled
  out a marginal repair and pointed at a foreign write of `startIds` (the
  stale-adoption re-commit, since fixed).
- **cb-svgopts.js** — Verovio SVG output options (`svgFormatRaw`,
  `svgRemoveXlink`) vs `renderToSVG` wall, string size, node count and
  `innerHTML` parse time, on the naturals shape (100 measures) and a window
  shape (18 measures). Found: render unchanged, bytes −40% and parse −36% under
  `svgFormatRaw`; `svgRemoveXlink` nothing; the first `renderToSVG` after a
  `loadData` is 30–40% slower than a repeat (lazy layout).
- **cb-courtesy.js** — correlates the `context line ... diverged` refusals
  against the document structure: does a clef/key/meter change begin the line
  just BEYOND the splice window? That is what identified the end-of-line
  courtesy signature as the cause of 9 of 11 such refusals and made B3 a
  three-line fix. Read-only.
- **cb-seedreach.js** — seeds the replaced-set closure at every measure in the
  document and reports how often it crosses a line boundary, split by the
  measure's position within its line. Answers "does it matter which measure in a
  system you edit?" — it does: first/last measures reach the neighbouring system
  ~48 % of the time (they are endpoints of boundary-crossing slurs and ties),
  middle measures 0.9 %. Read-only, no renders.
- **cb-noopedits.js** — replays the sweep's target selection per line against
  the MODEL only (no renders, so it is fast) and dumps the contents of every
  measure whose delete changed nothing. This is what showed those lines are not
  empty measures: the edited VOICE is empty, holding only a placeholder mRest
  while the music sits in other staves. Every edit is undone via
  `restoreSnapshot`.
- **cb-pagebox.js** — placeholder height vs real mounted height, per page. The
  drift bug was every page growing exactly 2 px on mount; `totalHeightError`
  must stay 0.
- **cb-window-walk.js** — replays the window algorithm for every line and
  reports the size distribution, the per-pass trace, and how many lines exceed
  `MAX_WINDOW_LINES`. Read-only.
- **cb-spanchain.js** — WHY a window grows: rebuilds the splicer's own spanner
  extents but keeps element identity, then attributes every growth step to the
  slur that caused it. This is what showed the sonata has no spanner longer than
  one line boundary and that the growth was a 17-slur chain. Also tallies the
  replaced-set/window distributions for the current vs one-pass rules.
- **cb-header-overlap.js** (run with `--no-sonata`) — the B4 repro: builds a doc
  with a section header, edits the line directly ABOVE it on the same page, and
  reports how far the header's system moved versus its title. `BUG: true` means
  the title was left behind (pre-fix: system 149 px, title 0). Also the quickest
  way to see the second half of that defect — pre-fix `dyFollow` is short by the
  full 900-unit reserve.
- **cb-cascade-overflow.js** (B2 note, 2026-09-02: the hand-back it looked
  for no longer happens — a spill is repaired by moving the tail onto the next
  page, so `handedBackAt` reads −1 and no page overflows; the probe's
  per-step `overflowing` list is the check that still matters) (run with `--no-sonata`) — builds a packed page,
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

- **cb-slack.js** — Phase 4 measurement (2026-09-03): every sonata page's
  inter-system gaps, its trailing gap to the content column, and a simulated
  distribution for a range of `MAX_GAP` caps. This is where 14u came from.
- **cb-slackshot.js** — Phase 4 mock-up: `--arg "page=N,cap=U,top=U,minfoot=U"`
  re-writes one mounted page's system transforms the way rule v2 would and
  strips the other pages so `--screenshot` frames it. Drops `#cursorOverlay`
  (its markers are in `#score` coordinates and go stale when pages are removed).
- **cb-distcheck.js** — Phase 4 acceptance on the live build: per page the top
  gap, the equalizing gaps and the footer gap, evenness, overflow, credit pages.
- **cb-topdev.js** — attributes a reference-gate staff-top deviation: per
  system, live vs rule-over-reference, plus the page-header delta and the
  distributed/undistributed levels; `--arg edit=1` makes one mid-line edit
  first. Prepares its reference host exactly as the gate does.
- **cb-splice-battery.js** (2026-09-04 changes) — the reference compare places
  both sides DISTRIBUTED and gives the host `decorateHost` + `alignStavesIn`
  (three ways it had drifted from the gate, each reporting rule v2 as a
  defect); records every deviation in `reference.devs`, not only the worst;
  `--arg "shot=<edit>,mode=spliced|reengrave,page=N"` runs up to that edit and
  leaves one page for `--screenshot`, so the SELF-CONSISTENCY pair can be
  heatmapped (`test/composer-test/heatmap.py`).
- **cb-sweep.js** (2026-09-04 changes) — `check=1` enables the reference gate
  for the whole sweep and records its throw per position (`row.gate`); without
  it the sweep verifies coverage and viewport stability only. `from=` chunks a
  gated pass under the runner's 300 s cap: `check=1,from=1,limit=24`, then
  25, 49, 73, 97. Do not sample with `stride` for this — stride 5 read 0/23
  where stride 1 read 4/25.

- **cb-balance.js** (2026-09-05) — the section balancer on the sonata: the SYNC
  band balance the derive ran before the first paint (`lastInitialBalance`),
  then waits for the idle job and reports per-movement line counts and fills
  (min/max/mean/sd, final line), whether page 1's measure set changed after
  the paint (must be false), job slices with their wall time, and every
  `[page-balance]`/`[page-breaks]` notice or uncaught error. `--arg nojob=1`
  skips the wait. Expected: four movements at min fill ≥ 0.8, 113 lines,
  `page1Changed: false`, `notices: []`.

**Not described above** (written in earlier sessions; see the matching
docs/decisions.md entries for what they established): `cb-getmei2.js`,
`cb-pbcases.js`, `cb-pbunion.js`, `cb-segdiag.js` (user page breaks / segmented
castoff, 2026-08-31), `cb-zoomshot.js`, `cb-zoomunit.js` (the constant-`unit`
zoom work — `cb-zoomunit.js` is a live regression gate: `zoom75_differs` must
stay false).
