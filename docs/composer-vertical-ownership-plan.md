# Composer vertical ownership — plan (the design doc's former START HERE 1 + 2, and D1)

Status: **proposal, not approved.** Written 2026-09-02, revised the same day
after Max's observation that D1 ("we always own height") dissolves the vertical
dependence that makes the window question hard. Folds together the design
doc's next steps 1 (scheduled cascade continuation) and 2 (window shape) and
the D1 feature (vertical distribution within the fixed budget) into one
sequence. On approval, each phase's landing gets its own dated decisions.md
entry and rewrites the matching design-doc sections; this file then goes.

## 1. Why the order is what it is

**What the context lines do today** (`render/pagesplice.ts`): three jobs, not
the two the design doc lists.

1. The live fidelity comparison (per-measure x/width + signature glyphs of
   L−1 and L+1 against the mounted page) — the only live detector of a window
   that is not equivalent to the document at that location.
2. Courtesy generation and spanner endpoints — L+1's first measure generates
   L's end-of-line courtesy; a slur into the hunk needs its other end present.
3. **The two ends of the read spacing chain.** `verticalPlan` places the first
   replaced system by `ctxPrev.staffTop + (window L − window L−1)` and moves
   the followers by `(window L+1 − window L_last)`. Both spacings are READ from
   the window, which is why L−1 and L+1 are rendered in it.

Job 3 is geometry, and it is what blocks the ~60 ms: with it in place, dropping
the lines means modelling Verovio's vertical stacking. Verovio 6.3.0-dev (the
build the CDN serves, commit 425dd7b, checked in source) stacks systems as
`B(k) + G + A(k+1)` — a constant plus one content-overflow term from each
neighbour, computed inside each system by `StaffAlignment::
CalcMinimumRequiredSpacing`, with the overflow-aware inter-system variant
present but commented out ("currently not used"). A model on that is exact
today and one Verovio release away from wrong, and the CDN URL is `latest`.

**D1 removes job 3 entirely.** Once Composer places every system from its own
tracked extents and its own rule, Verovio is asked only for horizontal layout,
which is per-system and proven pixel-exact from a window. The chain,
`dyFollow`, the page-first absolute read, and the window's `<pb>` pins all go;
the cascade stops re-rendering moved blocks and stops measuring after surgery;
and the window question collapses to the gate question the design doc posed.
So: own height first (Phase 1), rebuild the cascade on it (Phase 2, absorbing
step 1), then decide the window's shape as a pure gate question (Phase 3), then
the distribution rule that is D1's user-facing feature (Phase 4). The courtesy
stub (Phase 0) is independent and needed by Phase 3 either way.

Census for scale (sonata, every line once as the edited line): 116 lines, 446
measures, 3.84 measures/line; window median 14 measures — 31 % hunk, 62 %
context L±1, 7 % courtesy-extension line (fires on 19 of 116 positions),
leader + trailer. Verovio ≈ 5.9 ms per window measure all-in (84 ms).

## 2. The vertical model (shared by every phase)

- **Extents** of a system (a partition line), in Verovio units, relative to its
  own staff lines: `above` = content top to the first staff's top line;
  `below` = last staff's bottom line to content bottom; `span` = first staff
  top to last staff bottom (text-readable from the staff-line paths). Content =
  the post-processed system's bbox (HEJI text included, section titles
  excluded — they are page components, not system content). Read with
  `getBBox` on an attached system: at mount (shares the mount flush), after a
  splice imports it (shares the snap flush). Never from Verovio's internal
  overflow — that number is not ours and not readable.
- **Components of a page**: systems (extents) and section headers (a fixed
  reserve, `SECTION_HEADER_RESERVE`, before the system that carries the
  header's measure). The paper is fixed; the scale is pinned at the box.
- **Placement rule** `placePage(lines, headers) → staffTop[]`, in a new
  `render/pagefit.ts` (`PageFit`: the extents store + rule + fold). Rule v1
  restates Verovio's clearance so the visual change is confined to where the
  two extents definitions differ: `y = contentTop; for k: y += reserve(k);
  staffTop(k) = y + max(above(k), FLOOR); y = staffTop(k) + span(k) +
  max(below(k), FLOOR) + G`. `G` and `FLOOR` are Composer constants,
  calibrated once against today's pages (Phase 1's proof probe), then owned.
  Rule v2 (Phase 4) distributes slack; only this function changes.
- **Fold** `fold(lines, headers) → first index whose bottom passes the budget`
  — arithmetic over extents, no `getBoundingClientRect`.
- **Store**: per line-start id, `{above, below, span}` keyed like the partition
  cache (unit, pageScale, heji + document version). Invalidated for the hunk's
  lines on every splice (they are re-measured after import), for a page's lines
  on every mount (re-measured), for everything on document replace / key
  change. Lines on never-mounted pages have no extents until Phase 2's idle
  job or their mount.

Everything that reasons about vertical position after this reads the page
model, not `data-reserve` attributes and not Verovio's stacking: the splice,
the cascade, the header injector, the reference gate.

## 3. Phases

### Phase 0 — courtesy stub (independent, small) — LANDED 2026-09-02

Landed as planned (decisions.md 2026-09-02 "Courtesy stub"); one deviation:
the "stub inside an ending" fixture was unposable because the ending closure
swallows an ending that begins right past the window before the courtesy rule
runs, so the stub is never an ending member — the fixture became
`pageSystemSpliceCourtesyStubAfterEnding`, which pins that invariant.

The courtesy-extension line is in the window only so the compared L+1 draws
the end-of-line courtesy that L+2's first measure generates. Append that ONE
measure as a pinned stub system before the trailer, like leader and trailer;
drop the whole-line pull and its bound-at-two.

- `trySplice`: replace the `courtesyExt` loop — if line `wHi+1` begins a
  signature change, `stubId = newStartIds[wHi+1]`, `mHi = spans[wHi+1][0]`;
  `wHi` unchanged. `buildWindowMei` pins leader? + winStarts + stub? +
  trailer?; `spliceDom`'s `expected` likewise; `winProf` untouched.
  `lastWindow.courtesyStub`.
- Proof `cb-courtesystub.js` (the `cb-windowalt.js` template): every sonata
  line, old window vs stub window rendered on `spliceTk`; L−1, hunk, L+1
  per-measure x/width, staff y, `sigGlyphs`, spacing — **delta 0.0**, MEI
  byte-identical on the 97 positions without an extension; Verovio ms on the
  19 with one (expect −20…25 ms there, −4 ms mean).
- Fixtures: update the three courtesy fixtures' stat assertion; new
  `pageSystemSpliceCourtesyStubChain` (signature changes at L+2 and L+3) and
  `pageSystemSpliceCourtesyStubInEnding`; `run-unfixed.sh` on both (they fail
  on the unfixed source on the window-stat assertion).
- Ritual (§4). Gate-neutral by construction.

### Phase 1 — own height: extents, placement, and the gate (the large phase)

**Status 2026-09-02: LANDED — ritual green on the second build; visual baselines re-seeded after Max's review.**
Second build after Max's screenshot review: the page header (Verovio's
`g.pgHead`, title on page 1, page number elsewhere) is a page component — the
first content top is its bottom + 2u, and the calibrated C0 turned out to be
exactly that for the one-line page-number header. Page 1's first system now
sits 1u lower than Verovio's, never higher.
`render/pagefit.ts` (constants F = 6u, G = 4u, C0 = 5.25u calibrated by
`cb-placement.js`; extents from the post-processed bbox; `placeSystems`;
`foldIndex`; `ExtentsStore`), `Renderer.placePage` on every mount and after
every splice (before the snap), `placeFor` for the reference gate and the
predicted fold (measured cross-check under the flag), the injector draws only,
the window has no `<pb>` pins, `verticalPlan`/`dyFollow` are gone.

Ritual (§4) on the second build, all on the current source:
1. `pnpm typecheck`, `pnpm build`, `pnpm check:boundaries` — clean.
2. Proof probe `cb-placement.js` (unfixed record vs owned build): 92 of 116
   systems within 1 unit of Verovio's old placement, 19 within 3, 5 beyond
   (max 5.13 units: page 23 system 3, whose predecessor's bbox below-extent
   exceeds Verovio's overflow by ~3 units). Self-consistency on the owned
   build: 86/86 gaps and 30/30 page-firsts within 1 unit of the rule.
   Reference placement (`cb-refplace.js`): 30 pages, 0 divergences.
3. `cb-splice-battery.js` both code states: 10/10 spliced, identical outcome
   per edit, `reference.ok` on all; `maxD` 4 → 0, `maxTopD` reaches 30 (= TOL)
   on two edits.
4. `cb-sweep.js`: 115/115, refusal histogram empty, viewport counters 0/0/0;
   the 4 drifted rows are the pre-Phase-1 set.
5. `allmeasures`: 420/420 edited, splice rate 100 %, 0 conflicts, 69
   multi-line sets with 0 failing.
6. `HKL_INDEX_CHECK=1` full tier 370/370 (367/367 before the new fixtures were
   added); new fixtures `pagePlacementOwned`
   (self-consistency on every mounted page after the derive and after a
   splice), `pagePlacementTextTopped` (tempo-topped first system: below the
   header, never higher, self-consistent), `pageSpliceNoPbPins` (page-first
   hunk from a one-page window, placed like page 3's first) pass on the owned
   build and fail on the unfixed one (`run-unfixed.sh`).
7. `cb-splicecost.js`: default mid-document Backspace 147 ms steady (166 on
   the pre-Phase-1 build); `mi=47` is a no-op on both builds, as before.
8. Visual: 35 baselines changed — 31 glyph-level fixtures by sub-pixel
   shifts, the 4 page-view fixtures (`pageview_multisystem_crisp`,
   `pagescale_140`, `page_linebreaks_refill`, `page_system_splice_edit`) by
   0.5k–87k px on the second build; Max reviewed all as sub-pixel shifts and
   approved the re-seed (`--update-baselines`, 367/367).

1. `render/pagefit.ts` per §2; unit tests on recorded system SVGs.
2. **Mount path**: `finishPageMount` → post-process → measure extents of every
   system on the page → `placePage` → translate each `g.system` to its top →
   draw titles at their band (`injectSectionHeaders` stops translating systems
   and stops recording `data-reserve`/`data-baseline`; it draws from the page
   model) → snap. The derive's pages and the splice's pages are now placed by
   the same rule, which is the condition for the reference gate to ever be
   clean.
3. **Splice path** (`spliceDom`): import → post-process → measure the imported
   systems' extents → `placePage` for each target page (unchanged lines from
   the store, hunk lines fresh) → set every system's top on those pages
   (followers included: `dyFollow`, `verticalPlan`, `followerReserveDelta`,
   the header re-place/migrate arithmetic and the `winIsPageFirst` check are
   all subsumed) → titles → snap. Same single flush as today.
4. **Window**: no `<pb>` pins (nothing is read page-first any more), so one
   window page always; `wantPages` check goes. Context lines stay — they are
   still the live comparison until Phase 3.
5. **Reference gate**: reference render → post-process → measure its systems'
   extents → `placePage` → compare live staff tops (TOL 30) and title bands;
   plus the self-consistency invariant `live tops == placePage(live extents)`
   on every touched page (cheap, and the first thing to fire if a pass forgets
   to re-place). `pageHeaders` / `hdrTitles` read the model.
6. `foldOf` / `overflowingPage`: predicted from extents; under the flag, also
   measured (`getBoundingClientRect`) and the two compared — the prediction is
   what Phase 2 builds on, so it is verified here.

Proof probe `cb-placement.js`: mount all 30 sonata pages on the unfixed build,
record every system's staff top; on the new build, `placePage` over the same
systems; delta table per system. Expect ≤ 3 units everywhere except systems
whose topmost/bottommost content is a `<text>` (dir, tempo, HEJI accid) —
list those with magnitudes; Max sees the before/after page images of any
visible change, uninterpreted. This is also where `G` and `FLOOR` are
calibrated. Fixtures: `pagePlacementOwned` (every mounted page satisfies the
self-consistency invariant), `pagePlacementTextTopped`, `pageSpliceNoPbPins`
(page-first hunk placed by rule from a one-page window), header fixtures
re-pointed at the model (`pageSectionHeaderOverflow` must still pass), all
existing page-splice fixtures; visual baselines re-seeded after Max eyeballs
the diffs. Ritual (§4) with the battery on both code states — outcomes
identical, `reference.ok` under the new gate.

### Phase 2 — the cascade on the model (absorbs the design doc's former START HERE 1)

1. **Predicted fold.** `repairPagination` reads `fold()` from extents instead
   of measuring after surgery.
2. **A step is a DOM transplant, not a render.** The spilled tail's `g.system`
   elements (and their titles) move to the head of the next mounted page;
   `mergeGlyphDefs` into its `<defs>`; both pages re-placed by rule; re-snap;
   `replacePageStarts`. No window, no `SpliceRequest` with `moveLines`, no
   `window page boundary missing` class. A last-page spill creates the page
   from the spilling page's own SVG with systems stripped (same furniture) and
   runs the mount pass. Expect the battery's append-at-end (~700 ms today, one
   window + mount) to fall to the mount pass alone.
3. **Past the mounted set: arithmetic.** When the receiving page is unmounted
   but its lines' extents are known, the step is pure bookkeeping —
   `replacePageStarts`, mark stale, predict that page's fold, continue — O(pages)
   additions, synchronous. When extents are unknown, park exactly as today
   (`lazyMoveOut`; the page draws the block and checks its fold at mount).
4. **The scheduled continuation is an extents job.** After a derive or
   adoption, an idle task (adoption's discipline: current task only, cancelled
   by any document change, never on the edit path) renders each unmounted page
   offscreen, measures its systems' extents, discards the SVG — ~100 ms per
   page, ~3 s on the sonata, cancellable per page. Once it has passed a page,
   cascades through that page never park. This is step 1's "idle/rAF
   continuation finished before the next edit", with the work moved from DOM
   surgery to measurement; the `pending` seam stays where it is.
5. Bails that become arithmetic: `section header measure removed` (a header is
   a component of the model; deleting its measure removes the component — no
   title to strand), `spilled block is not the page tail` (the fold is the
   model's), `single system taller than a page` (predictable before surgery,
   still a bail). `MAX_CASCADE_STEPS` stays as a sanity bound.

Fixtures: the five B2 cascade fixtures re-asserted (`lastOutcome` no longer a
splice for the moved block — assert the transplant); `pageCascadePredictedFold`
(predicted fold == measured fold under the flag, over the cascade fixtures);
`pageCascadeArithmeticPastMount` (spill into an unmounted page with known
extents: pins change, page marked stale, nothing rendered; mount draws it
right); the two new test types from the former START HERE 1 — `pageExtentsJobEditDuring`
(edit while the idle job runs: job cancelled/re-armed, edit unaffected, no
double placement) and `pageExtentsJobScrollDuring` (mount during the job: the
mount measures, the job skips that page); sweep counters `pageBoxChanged` /
`scrollHeightChanged` / next-page anchor still 0, plus a new counter for
parked steps (expect → 0 once the job has run). Ritual (§4).

### Phase 3 — window shape: the gate question, now purely that

After Phases 1–2 the context lines serve the live comparison and nothing else
(courtesy: Phase 0's stub; spanner endpoints: the same mechanism, endpoint
measures as stubs — `expandForSpannersOnce` gives the measures).

**What the live comparison is, stated exactly** (Max, 2026-09-02). It compares
L−1 and L+1 only. A replaced set that is short by one line becomes a full
re-render with a reason nobody reads in production; one short by two lines,
or a same-width effect (a dropped slur segment, an articulation), is a wrong
page with or without it. In test runs it detects nothing the reference gate
does not: every touched page, context lines included, is compared against a
fresh full render under the flag, and every dependency the list holds was
discovered in such a run. So the live comparison is a fallback that masks a
subset of our own replaced-set defects — the pattern the governing principle
rejects — and dropping it changes a not-yet-known dependency from a silent
slow render into a visible wrong page. The replaced set and the window's
absorbers are Composer's responsibility either way; once the context lines go,
the stub rules ARE the cross-measure dependency list made executable.

**Decision: drop them**, window = leader + hunk + stubs + trailer (≈ 6.5
measures against 14.3; Verovio ≈ 84 → ~38 ms; steady edit ≈ 144 → ~100 ms
instrumented), once the preconditions below hold. A partial drop (one side) is
a gate exemption and is not on the table.

**Preconditions (each is a task; the drop lands after the last):**

1. `spannerExtents` provably covers every time-spanning element Composer can
   emit — `tstamp2` forms on hairpins, dirs and dynamics, octave lines, pedal
   marks, bracket spans — not only slurs and ties. Enumerate from the
   Composer emitters, not from the sonata.
2. Adjacent repeat barlines, if Composer emits repeats: Verovio merges a
   repeat end with a following repeat start into one barline, so an edit to
   measure i+1's left barline redraws measure i's right barline across a line
   boundary. Either add the rule (a measure whose left barline changes pulls
   its predecessor) or establish that Composer cannot produce the case.
3. `beginsSignatureChange` sees both encodings of a change — attribute form on
   a scoreDef/staffDef and element form in a staff/layer — since the stub rule
   becomes load-bearing for the replaced line's own courtesy.
4. The reference gate gains a per-measure glyph-class census against the
   reference (attribute reads, no flush): today it compares x/width, staff
   tops and signature glyphs only, so a dropped spanner segment or
   articulation at equal width is invisible to every gate, context lines or
   not.
5. **The dependency fixture matrix**: dependency class (courtesy key / meter /
   clef, relocated clef, prevailing-state range, slur, tie, hairpin/dir with
   `tstamp2`, ending, repeat barline if applicable) × edit type (insert,
   delete, replace) × position (line start, mid-line, line end, across a line
   boundary, across a page boundary), on a corpus document that contains
   every construct Composer can emit — not the 4/4-without-a-symbol shape.
   Each cell runs under the flag; each fixture passes on the new build and is
   run through `run-unfixed.sh` where a build difference exists.
6. On the new build: `context line diverged` count over sweep + allmeasures
   is zero (the detector has nothing left to detect on known documents), and
   the window bucket is measured with one window page (the saving may differ
   from the estimate).

Landing the drop: `trySplice` builds the window without `wLo−1`/`wHi+1`;
`ctxPrev`/`ctxNext` lookups and `profilesMatch`/`sigGlyphDiff` on them go;
`dxFrame` reads from the old hunk system's x0 against the window's; the
`pageSystemSpliceRefusesGlyphMismatch` fixture (forges a context glyph)
becomes a reference-gate fixture on the replaced line. Ritual (§4); the sweep
histogram must be empty.

### Phase 4 — the distribution rule (D1 proper)

Rule v2 in `placePage`: distribute a page's slack across its inter-system gaps
(and header bands), with the exceptions Max wants — the last page of the
document, pages under a fill threshold (the page-side MIN_FILL question B2
left open, D2), a maximum gap. One function changes; every consumer (mount,
splice, cascade, reference gate) follows because they all call it. The
existing fixtures gain `visualBaseline`s for a justified page, a last page, a
header page. D3 (explicit reflow) and D4 (move-measure commands) sit on the
same model and are out of scope here.

## 4. Verification ritual (every phase, in order)

1. `pnpm typecheck`, `pnpm build`, `pnpm check:boundaries`.
2. The phase's proof probe (delta table; zero or explained, never a tolerance).
3. `cb-splice-battery.js` on BOTH code states (stash / pop): identical
   splice/skip outcome per edit and `reference.ok`; wall is the win.
4. `cb-sweep.js`: 115/115, refusal histogram empty, **viewport counters 0**
   (`pageBoxChanged`, `scrollHeightChanged`, next-page anchor; Phase 2 adds
   the parked-step counter).
5. `allmeasures.sh` + `allmeasures-report.mjs`: 420/420, empty refusal
   inventory.
6. `HKL_INDEX_CHECK=1 node test/composer-test/run.mjs full`; new fixtures also
   through `run-unfixed.sh`.
7. `cb-splicecost.js` at the default position and at a courtesy position;
   Phase 2 also the battery's append-at-end wall.
8. Visual: any changed baseline goes to Max as two images, uninterpreted,
   before `--update-baselines`.

Standing traps: no `apps/composer/src` edits while anything runs against the
dev server; no `pnpm build` or second Chromium alongside the suite.

## 5. Doc changes on approval (not before) — standing policy; done for Phases 0–1 on 2026-09-02

- Design doc START HERE: steps 1 and 2 replaced by this sequence; the
  "context lines exist for the live fidelity test and the courtesy" sentence
  corrected to the three jobs; "the window's shape is the last latency lever"
  re-stated as a gate question that Phase 1 makes pure.
- Architecture: "Composer owns the page's vertical budget" extended to
  placement (§2 here); "The system splice" Window / Vertical plan / Section
  headers bullets rewritten; "Pagination repair" rewritten for predicted
  folds and transplants; the extents job added beside adoption.
- decisions.md: one entry per landed phase; lessons.md: the three-jobs
  omission (an inventory that names a component's jobs must be checked
  against the code that reads it, not the comment above it), and the Verovio
  commented-out block as a drift hazard for anything that ever models
  stacking.
- Open work: D1 groundwork → D1 placement (Phase 1) → distribution (Phase 4);
  A5's worker seam noted as the remaining lever after the window.
