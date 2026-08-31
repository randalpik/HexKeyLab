# Composer page-view system-splice (Phase C) — design

**Goal:** page-view edits at scroll-splice latency (~150–300 ms) by re-engraving
only the system(s) an edit actually changes, instead of the whole document
(`loadData` alone is ~1.2 s Chromium / ~2–3 s Firefox on the sonata).

**Acceptance gate (Max, 2026-08-29): no visual change to cross-system actions
after enabling Phase C.** A spliced result must equal what a full re-engrave
would produce — including measure redistribution across system boundaries in
BOTH directions. This is testable: partition (which measures on which system)
plus per-measure geometry must match a reference full render.

Companion to [composer-spot-splice-design.md](composer-spot-splice-design.md)
(scroll splice, Phases A–B3) and [composer-render-perf.md](composer-render-perf.md)
(Tier 1–2, shipped). Status: **line-break ownership (Phase C-A) IMPLEMENTED
2026-08-30** — `apps/composer/src/render/linebreaks.ts`, see "Implementation
(Phase C-A)" below; the system-splice itself (Phase C-B) is designed, not built.

## Core idea: greedy refill, Verovio decides

The unit is the **system**. An edit does not "patch" the edited system's old
measure set — it **re-lays the system from its start measure and lets Verovio
re-decide how many measures fit**:

1. Build a windowed sub-MEI starting at the edited system's first measure,
   spanning the old system k + system k+1 + slack (via the existing
   `serializeRangeForRender`, which already stamps running clef/key/meter
   context into the head scoreDef).
2. Render it offscreen with the exact page options (`breaks:'auto'` — or the
   active strategy) at the same pageWidth. Verovio breaks the window into
   systems; **the sub-render's first system IS the new system k.**
3. Splice that first system's measures into the page SVG in place of old
   system k.
4. **Cascade:** the sub-render's second system tells us the new start measure
   of system k+1. If it differs from the old start — measures were pushed
   (insert grew the system) or pulled (delete shrank it: **reverse cascade**)
   — repeat from step 1 for system k+1 with the new start. Terminate when a
   recomputed system's (start measure, measure set) equals the old one:
   greedy line-filling means everything after is then unchanged, and the rest
   of the document just dy-translates.

Reverse cascade is not a special case: "refill greedily from the start
measure" pulls the next measure back in whenever it now fits, exactly as a
full re-layout would. Forward spill and backward pull are the same operation.

**Assumption to validate (spike 1):** Verovio's line-breaking is greedy/local —
a windowed sub-render starting at measure M reproduces the full render's
system starting at M (same measure set, same justified widths). If Verovio
does any global balancing, the local recompute diverges and the gate fails —
this is the make-or-break question, tested before any implementation.

## Mechanics

- **Per-system index** (captured at full render, updated by splices): for each
  system — page, measure ids, per-measure x/width, system bbox y/height, and
  the running scoreDef context at its start. Analog of the scroll splicer's
  `order`/`sig`/`tx`/`ty`.
- **Horizontal:** a page-view system is justified to a fixed width, so a
  spliced system's internal x-layout comes straight from the sub-render — no
  cascade of x-shifts within the system, and none to its right (nothing is to
  its right).
- **Vertical:** inter-staff gaps vary per system (content-driven), and system
  heights vary — a spliced system whose height changes dy-translates every
  later system on the page (transform on the system `<g>`s, like the scroll
  cascade's tx). The synthetic-spacer gap calibration (B2) transfers
  per-system if sub-render gaps disagree with the full render's — spike 2
  measures whether they actually disagree (they may not: unlike scroll, the
  sub-render contains the full system's own gap-driving content).
- **Page overflow / underflow:** if the dy-shifted systems exceed the page
  rectangle (or a pulled-up system leaves the next page's first system
  fitting), the boundary system moves between pages — re-render the affected
  page region. Page-granularity cascade; expected rare per edit. Placeholder
  pages (T2.1) that aren't mounted need only their index updated, not DOM.
- **System 1 / labels:** a sub-render's first system renders as a SCORE start —
  full instrument `<label>` + indent — while a mid-score system shows
  `<labelAbbr>` (or nothing). The sub-MEI's scoreDef must present the label
  state of the system being reproduced (swap label := labelAbbr, or strip).
  Spike 1 quantifies this.
- **Boundary courtesy elements:** a system-boundary move changes the PREVIOUS
  system's end-of-line courtesy signatures (and `relocateInitialClefs` places
  clef changes before the barline — i.e., in the previous system's last
  measure). Rule: when the cascade moves a boundary, the system LEFT of that
  boundary is re-rendered too if the incoming/outgoing boundary measure
  carries a leading clef/key/meter change. (Backlog item "no preview signature
  changes over section breaks" lives in this exact zone — coordinate.)
- **Off the hot path:** only the edited system must land synchronously; the
  cascade tail + page-boundary work can run deferred behind the T2.2 badge
  (the afterRender queue is the ready seam). Interruption rule: a new edit
  while a cascade is pending completes or invalidates the pending tail first
  (never interleave two cascades).
- **Fallbacks (full render, now ~1.25 s / 2–3 s behind the badge):** meter/key/
  staff-set changes, section-header insertion/removal, `<pb>`-strategy docs
  (layoutBreaks path), single-part view, zoom/pageScale, doc load — same
  philosophy as the scroll splicer's gates: splice only what is provably
  reproducible, full-render the rest LOUDLY (console.warn), never silently.

## The gate harness

A page-mode analog of `scrollWidthChangeCascadesRight`, run under
`HKL_INDEX_CHECK` + as composer-test fixtures:

- For a battery of edits — insert/delete at a system's first/last measure,
  mid-system, note lengthen/shorten near the boundary, measure add/remove,
  edits that trigger 0/1/N cascade steps in each direction — perform the
  splice, AND a full re-engrave of the same model into an offscreen reference.
- Assert: identical system partition (measure ids per system per page),
  per-measure x/width within tolerance, system y/height within tolerance,
  identical courtesy-signature presence at touched boundaries.
- Plus the pixel-clip VISUAL fixtures for representative cases.

## Spike 1 findings (2026-08-29, sonata, probes in session scratchpad)

Ran windowed sub-renders vs the full render, raw toolkit both sides, on 21–38
system boundaries across the document. Verdict: **approach viable; every
divergence has an identified cause; no black-box behavior left.**

1. **Range-serialize content fidelity is perfect**: every window measure is
   byte-identical between `serializeRangeForRender` and the full serialize.
   All divergence is Verovio drawing with missing CONTEXT, never wrong content.
2. **Score-system-1 control reproduces near-exactly**: same partition, same x,
   width noise 14 units (≈1.4 px), same height, cascade signal correct.
3. **Index coordinate gotcha — was a live scroll-splice bug family, FIXED
   2026-08-30** (lessons.md + decisions.md, same date): the model counts
   measures in document order (446, voltas included); the splicer +
   `serializeRangeForRender` counted direct `<section>` children (444) —
   post-volta converted edits and volta-internal edits spliced silently
   stale, and tstamp2-spanning hairpins were invisible to
   `expandForSpanners` (a host-measure edit deleted the wedge). All fixed by
   coordinate unification + `expandForEndings` + tstamp2 span resolution +
   a `g.ending` glyph reconcile, guarded by three regression fixtures that
   fail on the pre-fix code. Consequences Phase C inherits for free: the
   range serializer + spanner scan are now correct in document-order
   coordinates — the page-splice index MUST use the same convention, and its
   splice must reconcile Verovio's SYSTEM-level `g.ending` bracket groups
   (id = ending xml:id, measures stay flat system children) exactly as the
   scroll splicer now does.
4. **Labels**: a sub-render's first system gets score-start treatment (full
   `<label>` + indent ≈1450 units). Stripping `<label>` (promoting
   `<labelAbbr>` where present) reproduces mid-score indentation exactly.
5. **Boundary-crossing spanners are THE fidelity killer**: slur/hairpin/tie/
   octave elements live in their START measure — a window starting at system
   k omits every spanner arriving from k−1, silently changing spacing (width
   drift up to ~90 px), height (missing continuation arcs), and sometimes the
   fit decision itself (partition off by one measure). Explains all failures.
6. **Real-previous-system context fixes most of it**: starting the window at
   system k−1's start (a true system start → greedy refill reproduces k−1,
   then k breaks naturally with all k−1→k spanners present) raised the full
   pass rate (context + partition + cascade signal) to 15/21; 5 of 6
   remaining failures are the SAME problem one level up (spanners crossing
   into k−1 from k−2) — recursive, so:
7. **Window rule (to validate in spike 2): extend the window left along known
   system starts until no spanner crosses the window's first measure** (cap
   ~4 systems; over cap → full render). Expect ~100 % pass with width deltas
   at the ~1 px noise floor, matching the clean control.
8. **Cost**: ~125 ms per window engrave (serializeRange + loadData + render of
   2–3 systems + slack) — inside the latency target even with escalation.

## Spike 2 findings (2026-08-30, full 106-boundary battery on the sonata)

Ran the escalation rule (left-walk over system starts until the window
boundary is spanner-clean, cap 4; right-extension over exiting spanners;
`<ending>`-aware) with two fidelity fixes found along the way:

1. **Synthetic leading system** (one `mRest` measure + `<sb>`, discarded):
   absorbs ALL score-start artifacts of a sub-render — meter signature, full
   instrument label + indent, title block — so the real window begins on
   system 2 with genuine mid-score treatment (label/labelAbbr behavior
   correct without stripping). Replaces the label-strip hack.
2. **Boundary scoreDefs must render inline, not fold into the head**
   (SHIPPED to `serializeRangeForRender`, benefits the scroll splicer too):
   a key/meter change sitting directly before the window start was folded
   into the head scoreDef, erasing the signature-change glyphs the full
   render draws there (~a signature's width — flipped fills). Now
   `cloneRangeStructure` clones position-`lo` interiors inline and
   `runningScoreDefContext` commits scoreDefs only once a measure follows
   them (head+inline double-application would suppress the change glyph the
   other way). Gated by the 331-fixture suite.

**Battery results (Chromium):**

| Tier | Rule | Pass | Cost | Fidelity |
|---|---|---|---|---|
| A | escalated soft window (depth ≤4) | 92/106 (87 %) | ~180 ms | partition + cascade correct; residual width drift ≤127 units (~13 px), dH ≤879 |
| B | region window (nearest encoded `<sb>` / score start) | +10 of the 14 A-failures | 175 ms–1.26 s (18–116 measures) | **pixel-exact — width delta 0 on every pass** |
| C | full render | remaining 4 (one cluster, pages 26–28) + 10 cap-fallbacks | 1.25 s Chromium / 2–3 s Fx | exact by definition |

**The decisive discovery:** Verovio's castoff is forward-greedy and
insensitive to downstream edits (verified: a far-downstream width change
leaves upstream fills untouched), but carries CUMULATIVE state forward from
the last HARD break — windows anchored at encoded `<sb>`/score-start
reproduce **exactly** (wd 0), windows anchored at soft (auto-derived) system
starts never quite do, regardless of context depth or glyph parity (verified
at k=49: identical glyph counts and budget, different fill). Soft-window
drift therefore cannot be engineered away by more context.

**Design pivot this implies — own the line-breaking (the doc's original
idea, now evidenced):** bake the current partition as encoded `<sb>` before
every system (the `layoutBreaks`/'encoded' machinery already exists for
`<pb>` docs). Then EVERY system boundary is a hard anchor: every splice
window starts at one and is pixel-exact by construction at tier-A cost
(~180 ms); the cascade re-derives breaks locally by greedy refill and
re-encodes them. The initial partition still comes from Verovio (full render
→ read system starts → encode), so engraving quality is unchanged — we pin
it rather than recompute it. Open questions for spike 3: does an
encoded-`<sb>` full render reproduce the auto render byte-for-byte (the
`layoutBreaks` precedent says yes for `<pb>` docs); reflow semantics when a
cascade changes the partition (re-encode the affected `<sb>`s only); how
`hkl:` encoded breaks coexist with user page breaks and section `<sb>`s.

## Spike 3 findings (2026-08-30) — partition pinning VALIDATED

Max's characterization of the spike-2 residuals reframed them: k81 = a free
refill from a hard anchor choosing a DIFFERENT-but-valid fill than the
historical render (same elements, two defensible spacings); k87–89 = k81's
divergence cascading through shared region windows. Under pinning this whole
class dissolves by construction — we never ask Verovio to reproduce a
historical fill; the current partition is encoded, and whatever a refill
chooses gets re-encoded, so the next full render agrees definitionally. Two
things then need to be true, and both were tested:

1. **(A) Transition parity — HOLDS.** Baking `<sb xml:id="hklpin-N">` before
   every system-start measure and rendering with the same smartSb0 strategy
   reproduces the auto render EXACTLY: identical 118-system partition,
   identical 37-page distribution, max per-measure width delta 3 units
   (≈0.3 px rounding). 114 pins (4 boundaries already had section `<sb>`s).
   **Placement rule (Verovio gotcha, see lessons.md):** an `<sb>` directly
   AFTER an `<ending>` wrapper is silently ignored by smart castoff — it must
   be placed INSIDE the wrapper as its last child. (First pinning attempt
   diverged at exactly the volta boundary because of this.) A full
   `breaks:'encoded'` variant (sb + pb pins) is a DEAD END — it exploded 118
   systems into 154; smartSb0 over a fully-pinned doc is the mechanism.
2. **(B) Refill self-consistency — 9/10.** For each boundary k: window =
   [pinned k−1 .. k+1 + slack] with pins after k's start stripped (free
   tail) + the synthetic leading system; the refill's chosen break is
   re-pinned into the doc and a full render compared. Self-consistent with
   width delta 0 at k=20/40/49/50/60/81/88/89/100 — including every
   spike-2 residual. The one failure (k=87) is in RE-PIN placement, not the
   refill: its moved pin lands adjacent to a mid-piece `<scoreDef>` (the
   bar-347 key change) — same placement-sensitivity class as the ending
   quirk; resolve the ordering rule (sb before vs after an adjacent
   scoreDef) during implementation.

**Semantics note:** a free refill sometimes picks a different break than the
historical partition even without a width-relevant edit (`changedBreak` at
4/10 sampled boundaries). Under pinning this is deterministic and
gate-consistent (the re-render shows exactly what the splice computed), but
it means an edit can move a system boundary that the legacy auto render
would have kept — reflow semantics are "greedy from the edited system's
pinned start", not "minimal diff vs history". Acceptable; document in the
user guide when Phase C ships.

## Spike 5 findings (2026-08-30) — own line-breaking + own rebalance, VALIDATED

Max's rulings after the k87 dig: (i) the historical render is a baseline, not
truth — updating it is fine; (ii) a NO-OP free refill must never move a
boundary live; (iii) Verovio's castoff does (necessary) full-range
optimization between hard breaks — so reproducing its choices is a dead end,
and the cascade must be refill-based with a rebalancing step WE design:
if any line in the section falls under a minimum fill, move measures between
lines until every line clears it, unless structurally impossible.

Root-cause trail for k87 (probes, same day): glyph content across contexts is
IDENTICAL (accidentals, key sigs, clefs, notes); the divergence is purely the
castoff fit threshold, and it flips exactly when the window includes the
bar-18 key-change `<scoreDef>` — Verovio's wrap decision carries cumulative
state (fill was borderline: 18977 justified vs ~18976 available). smartSb0
can therefore auto-wrap even a PINNED line it deems overfull — pins alone
don't fully own the partition under smartSb0.

Prototype results (sonata):

1. **Empirical fill envelope** (Verovio's own 118 lines, naturals from one
   `breaks:none` render, W = 19042 units): non-final lines fill 0.706–1.426
   of natural width — justified lines COMPRESS up to ~1.43×, so an additive
   naturals model needs a compression allowance (FIT_MAX > 1).
2. **`breaks:'encoded'` is the display mode.** With `<pb>` REPLACING `<sb>`
   at page starts (the earlier "explosion" was a double-pin probe bug),
   encoded reproduces a pinned partition + pagination EXACTLY and never
   overrides a pin. Caveat: intra-line justification distribution differs
   from smartSb0 by up to ~516 units (~52 px) — a one-time respacing at
   transition, partition-identical. smartSb0 remains only for COMPUTING
   fills (windows), never for displaying pinned docs.
3. **The full loop closes**: naturals → our greedy partitioner (FIT_MAX 1.2,
   MIN_FILL 0.7, sig estimate) → backward min-fill rebalance → sb/pb pins →
   encoded render honors the partition VERBATIM (105/105 lines on the
   sonata; fills 0.711–1.193; zero under-min). Deterministic ⇒ no-op edits
   cannot move boundaries (ruling ii satisfied structurally), and the cascade
   extent is known BEFORE any DOM work (new pins vs old — ruling iii's
   "identify before committing").

Architecture consequence: Verovio = measure-level engraver + within-line
justifier; line-breaking, rebalancing, and pagination are Composer's
(naturals model + fill rules + pins). Initial adoption pins Verovio's own
partition (parity proven), so nothing moves at enablement except the
≤52 px encoded respacing — needs Max's eyes on a real page.

## Implementation (Phase C-A, 2026-08-30) — line-break ownership, shipped

`apps/composer/src/render/linebreaks.ts` (`PageLineBreaks`), wired into
`Renderer.renderPageComposer`. What shipped, and where it amends the spike-5
plan (every amendment probe-driven, same day, sonata):

- **Display strategy is `breaks:'line'`, not 'encoded'** — the decisive
  late probe: `line` honors every `<sb>` VERBATIM (an artificially merged
  8-measure line renders unwrapped; `smart` re-wraps it) while still
  paginating automatically by height. That is exactly "own the systems,
  Verovio keeps the pages", so the A-phase needs **no pager at all** and
  pagination stays height-true. 'encoded' remains the mode for docs with user
  `<pb>` (their verbatim-page semantics are today's) and for Phase C-B's
  window renders. smartSb0 as refill display is REFUTED: castoff re-wrapped
  every refilled 5-measure line (naturals fill ~1.0–1.1) — its internal fit
  metric is not reproducible from naturals, so verbatim honoring is the only
  real ownership.
- **Enablement is pixel-exact**: derive renders (doc load, zoom, pageScale,
  staff filter, fallbacks) are byte-identical to today's strategies; the
  partition is ADOPTED from the laid-out toolkit lazily (idle-chunked
  renderToSVG walk, ~2 s on the sonata, finished synchronously if an edit
  arrives first). Pins + `line` vs the smartSb0 render: max per-measure
  x/width delta **0.0** across sampled pages, identical 37-page distribution —
  the ≤52 px encoded respacing question (old item 1b) is moot.
- **Pins are render-time only.** Injected into the serialized render MEI
  (`injectPins`): plain `<sb xml:id="hklpin-N">` before each line start;
  inside an `<ending>` wrapper as last child when the position directly
  follows one (the lessons.md placement rule); directly after an adjacent
  `<scoreDef>` (matches the model's own section-break order `scoreDef, sb,
  measure`; both orders probe-identical for partition). The live doc, saves,
  undo snapshots and history never see a pin — no stripping exists anywhere.
- **The refill trusts only its own signature baseline.** `PageLineBreaks`
  keeps per-measure live-doc serializations from its last commit and finds
  the changed run by prefix/suffix diff — the model's `renderDirty` hint is
  never consumed (its reset-then-narrow lifecycle can swallow an earlier
  mutation's 'all' under batch-mutate-then-render flows; the test runner's
  doc reset is exactly such a flow). A wholesale id replacement (<50 % of
  line-start ids surviving) is treated as a foreign document → derive.
- **Naturals + greedy + rebalance as validated**: dirty-window naturals from
  offscreen breaks:'none' sub-renders (spanner/ending-complete via the scroll
  splicer's exported expansions, 2-left/1-right context, widths as successive
  bbox-x deltas, sigW measured per window from the leading clef+key block);
  FIT_MAX 1.2 / MIN_FILL 0.7; backward min-fill rebalance scoped to the
  refilled lines (doc-final + hard-start lines exempt); termination when a
  computed start rejoins a surviving old start beyond the changed run;
  escalating ensure-ladder (dirty+16 → +64 → +250, cap) then derive.
- **Fallbacks (derive, loud console.info when ownership was active)**:
  structural head/staff change (headSig), user-break toggle (userBreakSig),
  single-line partitions (`line` with zero `<sb>` warns and falls back to
  castoff internally — small docs just derive, they're under the deferral
  threshold anyway), foreign document, window/refill caps, filtered
  (single-part) view, missing pin ids.
- **Safety nets**: rendered-vs-pinned partition verification on mounted pages
  after every refill (warn + re-adopt in prod, throw under HKL_INDEX_CHECK);
  fixtures `pageLineBreaksRefill` / `pageLineBreaksNoopDeterminism` /
  `pageLineBreaksDeriveFallback` (+ visual baseline); suite 334/334. The
  large-score battery + smoke probes are PRESERVED (not scratchpad-lost like
  the spike probes) in `test/composer-inspect/phasec/` — rerun them for C-B.
- **Measured (Chromium, sonata)**: refill wall ~1.6–2.0 s per edit — the
  full `loadData` still dominates (that's Phase C-B's target); refill's own
  overhead is naturals 30–240 ms + inject ~50 ms + serialize ~80 ms.
  Cold-start edit (adoption finished synchronously) ~4 s once. `line` load
  ~1.25 s ≈ smartSb0; pure 'encoded' loads are ~0.6 s (2× faster — a C-B
  bonus once pagination is owned).
- **Reflow semantics now live** (documented in the user guide): the first
  edit in a region re-breaks that region from the edited line by OUR fill
  rules (bounded by hard breaks / re-join with the old partition), then stays
  deterministic — identical content always refills to the identical
  partition; a no-change render moves nothing (fixture-enforced).
- **Observed for C-B**: a boundary move next to a mid-piece scoreDef changes
  the PREVIOUS line's end-of-line courtesy signatures (~33 units of internal
  respacing on the sonata probe) — correct under A's full re-render, and
  exactly the "re-splice k−1 too" rule C-B must implement.
- **Pre-existing quirk surfaced (not introduced, unchanged)**: a LARGE doc
  with a user `<pb>` paginates ONLY at encoded breaks — the 446-bar sonata
  with one Ctrl+B break renders as 2 giant clipped pages today and under
  refill alike. Real fix belongs to C-B pagination ownership.

## Remaining for Phase C-B (the splice itself)

1. ~~k=87 class~~ — RESOLVED by spike 5: it was smartSb0's contextual fit
   threshold; verbatim display + our fit rules make it unreachable.
1b. ~~Encoded respacing acceptance~~ — MOOT: C-A displays via breaks:'line',
   pixel-exact vs smartSb0 (max delta 0.0 on the sonata battery).
1c. **FIT_MAX/MIN_FILL tuning to taste** (still open, Max's call): 1.2/0.7
   shipped; sigW is now measured per refill window (not the constant 900).
   Larger FIT_MAX = denser lines and fewer first-edit re-breaks vs the
   adopted Verovio partition; smaller = airier.
1d. **Pagination ownership** — deferred cleanly: breaks:'line' keeps Verovio's
   height-true pager for C-A. C-B's spliced pages need the dy/page-cascade
   machinery (and it would also fix the pre-existing giant-page quirk of
   user-`<pb>` docs).
2. ~~Pin lifecycle design~~ — RESOLVED: pins are render-time injections into
   the serialized MEI only; nothing to strip anywhere; recomputed per render;
   user breaks honored as hard line starts and never touched.
3. **Boundary courtesy behavior** — a boundary moving next to a clef/key
   change re-spaces the PREVIOUS line's end-of-line courtesy signatures
   (~33 units observed on the sonata). Correct under C-A's full re-render;
   C-B must re-splice k−1 whenever a moved boundary measure carries a leading
   signature change.
4. **Gap fidelity under pinning** — spike 2 showed hard-anchored windows match
   gaps exactly; confirm on the pinned battery during C-B implementation.
5. **The splice**: per-system index (document-order coordinates + `g.ending`
   reconcile, per the scroll splicer's lessons), windowed 'encoded' system
   renders anchored at pins (~0.6 s loadData already measured — and windows
   are far smaller), dy-translate below, page-boundary moves, defs merge,
   per-page post-pass interplay (section headers translate systems — mounts
   are not idempotent).

## Status log

- 2026-08-29 — design drafted (greedy-refill formulation unifies forward +
  reverse cascade; parity gate defined per Max: no visual change to
  cross-system actions).
- 2026-08-29 — spike 1 complete (findings above): mechanism viable, content
  fidelity byte-perfect, spanner context identified as the sole fidelity
  killer, previous-system-context window + left escalation is the fix to
  validate next.
- 2026-08-30 — spike 2 complete (findings above): escalation + synthetic
  leading system + inline boundary scoreDefs (shipped to the model) reach
  87 % at ~180 ms; region (hard-break-anchored) windows are PIXEL-EXACT;
  root cause of soft-window drift = Verovio castoff's forward cumulative
  state, reset only at hard breaks. Design pivots to encoded-break pinning
  (own the line-breaking); spike 3 validates it.
- 2026-08-30 — Max characterized the spike-2 residuals (k81 = valid alternate
  fill from a hard anchor; k87–89 = its cascade through shared windows) —
  screenshots in session scratchpad. Spike 3 run same day: **pinning
  VALIDATED** — transition parity exact (118 systems, wd ≤3 units, pins
  inside ending wrappers per the placement rule), refill self-consistency
  9/10 with wd 0 (k=87 = re-pin placement adjacent to a scoreDef, to fix in
  implementation). Phase C proceeds on the pinned-partition design.
- 2026-08-30 — **Phase C-A implemented** (`render/linebreaks.ts` + Renderer
  wiring; see "Implementation" above). Probe-driven amendments: breaks:'line'
  discovered as the verbatim-partition + auto-pagination display mode
  (smartSb0 display refuted — castoff re-wrapped refilled lines; 'encoded'
  alone would have required owning pagination now); refill drives off an
  owner-held per-measure sig baseline instead of the model's renderDirty
  (reset-then-narrow swallows 'all' under batch flows — found via the test
  runner's doc reset leaking a stale partition); single-line docs always
  derive. Gates: enablement parity exact; sonata edit battery — refill path,
  pins verbatim (voltas + key changes included), cascades 1–5 lines,
  untouched-line geometry bit-stable, round-trip + no-op deterministic;
  `HKL_INDEX_CHECK=1 test:composer` 334/334 (3 new fixtures + visual
  baseline); typecheck/build/boundaries clean.
