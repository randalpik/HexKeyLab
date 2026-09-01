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
(Tier 1–2, shipped). **Every page render — derive included — now goes through
ONE break algorithm (`encoded` over our pins); the castoff pass that chooses
the partition is an internal bootstrap that is never painted.** Status:
**line-break ownership (Phase C-A) IMPLEMENTED
2026-08-30** (`apps/composer/src/render/linebreaks.ts`, see "Implementation
(Phase C-A)"); **the contained system splice (Phase C-B v1) IMPLEMENTED
2026-08-30** (`apps/composer/src/render/pagesplice.ts`, see "Implementation
(Phase C-B v1)"); reflow made CONSERVATIVE and **pagination ownership (Phase
C-B2a) IMPLEMENTED 2026-08-30** (`<pb>` pins + `breaks:'encoded'`). On the
sonata, the **dy-cascade (Phase C-B2b / B1) is IMPLEMENTED 2026-08-31** — the
vertical gate no longer refuses movement, it measures and applies it (see
"Implementation (Phase C-B2b / B1)") — and **7 of 8 battery edits splice**, all
8 apply and all are reference-clean (4 units x/width, 8 spacing, 6 absolute
staff top), with the first edit after a derive splicing instead of
full-rendering. The single remaining fallback is the by-design section-header
line.

**Phase D — making the edit path O(edit) rather than O(document) — IMPLEMENTED
2026-08-30/31** for every O(document) item identified: a steady-state spliced
edit is **~170 ms**, down from 308, of which ~56 ms is Verovio; per-edit
`querySelectorAll` fell 31 969 → 2 537 calls, `XMLSerializer` 495 → 54,
`cursor.update` 62.6 → ~4 ms, `normalizePlaceholdersAll` 17.1 → 0.9 ms. The
enabling mechanism is exact mutation-based cache invalidation (a
`MutationObserver` whose `takeRecords()` is synchronous), not call discipline —
see "The mechanism that made caching possible".

**Also 2026-08-31:** zoom is now layout-neutral (crisp presets moved to a
constant `unit: 8`, so every zoom produces the same partition AND every zoom
change is a partition-cache hit), and **user page breaks split their line and
cascade** (segmented castoff — C1 closed). See the TODO section, which opens
with a "START HERE NEXT THREAD" list.

## Core idea: greedy refill, Verovio decides

> **SUPERSEDED (2026-08-30) — kept for the reasoning trail.** Verovio no
> longer decides anything about breaks: Composer owns the line partition AND
> the pagination, and an edit REPAIRS the existing partition rather than
> re-deriving it (a greedy re-derivation made edits irreversible — see
> "Reflow semantics (current)"). The window mechanism below is still how a
> system gets re-engraved; the decision-making described here is not.
> Current behaviour: "Reflow semantics (current)", "Implementation (Phase C-A
> / C-B v1 / C-B2a)", and "One break algorithm everywhere".

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

> **PARTLY SUPERSEDED (2026-08-30)** — read against the Implementation
> sections. Notably: gaps needed no synthetic-spacer transfer (pin-anchored
> windows reproduce them exactly); the cascade is not "off the hot path"
> because a splice is now ~300 ms synchronous; and the fallback list has
> grown (see the TODO section).

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
- **Reflow semantics — SUPERSEDED 2026-08-30 by conservative repartition**
  (Max's ruling; see "Reflow semantics (current)" below). C-A originally
  re-derived the affected region greedily from the edited line, which made the
  first edit in a region re-break it. That is gone: the partition is now
  carried across edits and only repaired where a line became illegal.
- **Observed for C-B**: a boundary move next to a mid-piece scoreDef changes
  the PREVIOUS line's end-of-line courtesy signatures (~33 units of internal
  respacing on the sonata probe) — correct under A's full re-render, and
  exactly the "re-splice k−1 too" rule C-B must implement.
- **Pre-existing quirk surfaced (not introduced, unchanged)**: a LARGE doc
  with a user `<pb>` paginates ONLY at encoded breaks — the 446-bar sonata
  with one Ctrl+B break renders as 2 giant clipped pages today and under
  refill alike. Real fix belongs to C-B pagination ownership.

## Implementation (Phase C-B v1, 2026-08-30) — the contained system splice, shipped

`apps/composer/src/render/pagesplice.ts` (`PageSystemSplicer`), wired into
`Renderer.renderPageComposer` behind the refill. When `PageLineBreaks.tryRefill`
succeeds, the edit lands as a DOM splice of only the affected systems —
**no full-doc loadData** — whenever the v1 gates hold; anything else falls back
to the full refill render (loud `console.info`), exactly as before.

**Probes first** (persisted in `test/composer-inspect/phasec/`, results 2026-08-30):

- `cb-structure.js`: page-mode volta brackets (`g.ending`) are CHILDREN of
  `g.system` — whole-system splices carry them for free (no scroll-style
  reconcile). Verovio stacks page systems by CONTENT clearance (staff-frame
  gaps 145–267 units, bbox clearance ~31–37) with NO vertical justification
  (bottom slack 650–811); a page's first system anchors its content top at the
  margin. So system positions are content-dependent — the splice must not
  assume any spacing model.
- `cb-window.js`: a pin-anchored window (synthetic mRest LEADER + `<sb>` pins,
  page geometry, pageHeight 60000, breaks:'line') reproduces mid-score systems
  **pixel-exactly** — per-measure x/width, inter-staff gaps, hanging extents,
  and consecutive-system top-to-top spacing all delta 0.0 vs the full pinned
  render (10/12 sampled lines; 92–520 ms per window). The two exceptions:
  line 0 (score-start treatment differs without the title header, ~1 px) and
  the section-boundary zone (probe k=59, large divergence — same page as the
  section header + mid-piece scoreDef; the same "castoff cumulative state at
  a scoreDef" family as spike-5's k87).

**The v1 gates** (each failure = full render, reason in `lastSkipReason`):

1. Refill succeeded, strategy `'line'`, page DOM live (never across a
   view-mode switch), line COUNT unchanged (the common case now that the
   partition is repaired rather than re-derived). The replaced set L = the
   sig-diff run closed over spanners/`<ending>`s (a spanner draws a segment in
   every line it touches — all replaced together) plus both lines adjacent to
   any moved boundary; cap 5 lines (a one-note edit can legitimately touch
   several when a spanner chain closes over them — sonata measure 250 was
   full-rendering at 2.4 s for exactly that); line 0 excluded; section-header
   measures excluded (their title/reserve injections are mount-only).
2. All lines of L mounted, first-of-system, and DOM-consecutive; the window =
   L ± 1 context line, iteratively closed over spanners/endings to line
   boundaries (caps: 7 lines / 60 measures).
3. **Synthetic leader AND trailer**: the leader (mRest line, discarded)
   absorbs score-start artifacts; the TRAILER (mRest line after the window,
   discarded) absorbs the end-of-score FINAL barline — without it the
   window's last measure renders ~5 px wider than the live line's normal
   barline (found by the sonata battery's context check; windows ending at
   the true doc end need no trailer and match the live final barline).
4. **Context sanity**: the unchanged neighbour lines (a−1, b+1) must
   reproduce their live per-measure x/width within EPS (25 units ≈ 2.5 px;
   measured deltas are 0.0 + snap noise). This is the structural detector for
   the k59-class divergent zones — no zone blacklist needed.
5. **Vertical gate — measure, don't emulate** (the spike-5 lesson applied to
   the stacker): the window's own consecutive-system spacing chain must keep
   every replaced system exactly at its live position (spacing-above per
   line; content-top hang for page-first lines; spacing-below after the last
   replaced line; bottom-extent stability for page-last lines, which also
   pins pagination). Anything that would move ANY other system → full render.
   **SUPERSEDED 2026-08-31 by B1**: movement is now measured and applied (see
   "Implementation (Phase C-B2b / B1)"); this gate survives only as the
   `plan.static` fast path, which still pins systems to their live positions
   verbatim when nothing moves by more than EPS.

**Surgery**: offscreen render on `spliceTk` → `postProcessRendered` +
`styleVoltaNumbers` (moved to render.ts, shared with main.ts) on the host →
import each system `<g>`, transform anchored on the live system's staff-top +
first-measure x (composes with section-header reserves and snap transforms) →
per-page glyph-defs merge (`mergeGlyphDefs`, extracted from the scroll
splicer) → `snapSystems` per affected page → `verifyRenderedPartition`.
The splicer is **stateless** — everything it needs lives in the mounted DOM,
the refill result and the model; there is no index to invalidate.

**Supporting changes**: `tryRefill` now returns splice metadata (changed run,
old/new partition) and a LAZY `mei()` (the splice path never pays the full
serialize+pin ~130 ms); new refill guards — `computeInteriorSig` (mid-piece
section-level scoreDefs are invisible to the per-measure sig diff; a change
now derives) and composer/footer credits folded into `headSig` (their
injections are mount-only). **Stale-mount hole closed**: a splice edits the
mounted pages without re-loading the toolkit, so a page mounted afterwards
would have drawn PRE-EDIT content (found by the reflow probes). `pageVirt`
carries a `stale` flag set at splice time; the next mount re-serializes and
re-pins from the live model (`PageLineBreaks.pinRenderMei`) before rendering,
with `pageVirt.options` switched to the pinned `'line'` options that data
expects. Verified: after a splice, forcing the page back to a placeholder and
re-mounting draws the CURRENT document (~1.5 s, one loadData, off the hot
path) where it previously drew the stale one. A signature-identical render request is now a
**no-op skip** (DOM untouched — guards make it sound). `lastFullMs.page` only
updates on actual full engraves (a splice must not poison the heaviness
predictor). Under `HKL_INDEX_CHECK` every splice is verified inline against
an offscreen full render of the same pinned MEI (throws on divergence;
section-header pages exempt the spacing check — main.ts's reserve translate
isn't Verovio's).

**Measured (Chromium, sonata battery `cb-splice-battery.js`, after
conservative repartition)**: **7 of 8 battery edits splice, at 380–673 ms
wall** (splice's own work 160–190 ms; the rest is T2.2 deferral +
overlay/cursor update) vs ~1.95 s for the one full render; window loadData
~50–65 ms. Every spliced edit reported `refillLines: 0` — no boundary moved at
all. Reference parity held on EVERY battery edit across all 37 pages / 446
measures: max x/width delta ≤ 4 units (~0.4 px snap noise), max spacing delta
≤ 9 units. The single fallback is the section-header line, which is excluded
by design. (Before conservative repartition the hit rate was 3/8: the first
edit in a region re-derived its lines and usually changed the line count.
Fixing reflow reversibility fixed the hit rate with it.)

**Gates**: fixtures `pageSystemSpliceEdit` (splice + pins verbatim + inline
reference gate + visual baseline — and since conservative repartition it needs
no priming edit: the FIRST edit in a region splices), `pageSystemSpliceVerticalBail`
(bottom-extent refusal + full-render fallback), `pageSystemSpliceNoopSkip`
(no-op leaves DOM identity untouched), plus `pageLineBreaksUndoRestoresLayout`
(the reversibility gate); typecheck/build/boundaries clean.

## Reflow semantics (current) — conservative repartition, 2026-08-30

**Max's ruling, and now the top-priority invariant: an edit must not reflow
unless it makes a system ILLEGAL.** The observed failure it replaces: delete
one note → the system pulled in a measure → undo → the gained measure stayed.
That is threshold hysteresis, inherent to re-deriving a partition greedily —
the refill accepted any line up to FIT_MAX, so a measure that slid in on a
deletion was still "legal" once the deletion was undone. Layout drifted one
measure per edit and never drifted back.

What `PageLineBreaks.repartition` does instead:

1. **Carry the partition across the edit by MEMBERSHIP** — each old line keeps
   its first surviving member as its start. Deleting a line's first measure
   just moves that line's start to the next survivor; an inserted measure
   joins the line whose index range contains it; a line whose every member
   was deleted disappears. No widths are consulted.
2. **Repair only what became illegal.** Legality = fill ∈ [MIN_FILL, FIT_MAX].
   Only lines whose content changed are examined, plus whatever a repair
   cascades into. Each repair step moves ONE measure across ONE boundary
   (push the last measure forward when overfull; pull the next line's first
   measure back when underfull), so the reflow is as small as the illegality
   demands. Hard (user) breaks are never moved — an overfull line before one
   gets a new line instead. Guards: a line that pushed never pulls back
   (oscillation), an overfull line that can only trade one illegality for
   another is left alone (content over churn), and a step cap derives.
3. **Bounds are the tuning surface, set to contain Verovio's own output**:
   FIT_MAX 1.45 / MIN_FILL 0.65 vs the sonata's measured castoff envelope
   0.706–1.426. That matters twice over — an adopted partition is legal by
   construction (so the first edit in a region moves nothing), and the
   knobs now express taste directly: narrower = more eager reflow.

Consequences: reflow is path-dependent BY DESIGN (a partition reflects the
edits that reached it, not a fresh engraving of the current content) — that is
the point, and it is why the future explicit commands below matter. Undo
restores the layout exactly. The C-B splice hit-rate rises sharply as a side
effect, since most edits no longer change the line count.

**Deliberately out of scope for now** (Max): an explicit **reflow command**
that respaces the whole document as if freshly engraved, and explicit commands
to **move measures between systems** by hand. Both become natural once the
legality boundaries are the only automatic mover.

## Implementation (Phase C-B2a, 2026-08-30) — pagination ownership, shipped

Composer now owns PAGES as well as lines. `PageLineBreaks` adopts each page's
first line from the same derive-render walk that adopts the partition, pins
them as `<pb>` (`injectPins`' existing `pageStartIds` path), and every owned
render uses **`breaks:'encoded'`** — the only mode that honors `<pb>`.

- **Gating probe (`cb-pagination.js`)**: encoded over a fully pinned document
  reproduces the pagination EXACTLY (37 pages, identical systems-per-page on
  every page) and loads **2× faster (577 ms vs 1191 ms)**. It is NOT
  pixel-identical to `'line'` though: intra-line justification redistributes up
  to 516 units (~52 px) and system tops move up to 491 units (~49 px). Max
  reviewed both renders of sonata page 3 side by side (`cb-pagerender.js` +
  the runner's new `--screenshot`), saw no difference, and accepted on the
  condition that **the new system is self-consistent**.
- **Battery after enablement (`cb-splice-battery.js`, strategy-matched
  reference)**: 6/8 edits splice at **407–544 ms**, all 8 reference-clean
  (max 4 units over 37 pages / 446 measures). The two full renders are the
  documented first-edit-after-derive and the section-header line — and even
  those dropped from ~1.95 s to **~1.1 s**, because encoded loads 2× faster.
- **Self-consistency verified (`cb-pageown.js`)**: with pagination owned, the
  live DOM equals a fresh full render of the same pinned MEI — 446 measures
  compared, 0 system-sequence mismatches, max geometry delta 4 units (0.4 px
  snap noise); every mounted page begins at its pinned line; no page overflows.
- **Pages are carried, not recomputed** (same rule as lines): a page keeps its
  start id while that id still begins a line; one whose line was merged away
  moves to the next surviving line start, never backwards. A splice requires
  pagination to be UNCHANGED (`paginationHeld`) — moving systems between pages
  is C-B2b.
- **Safety net**: Verovio no longer re-paginates for us, so a pinned page that
  overflows its paper would simply draw past it. `Renderer.overflowingPage()`
  checks every mounted page after a pinned full render; a spill warns and
  hands pagination back (derive + re-adopt). `verifyRenderedPartition` also
  asserts each mounted page begins at its pinned line.
- **~~Known consequence~~ — RESOLVED same day by the never-painted castoff
  bootstrap (below).** Originally the first edit after a derive always
  full-rendered, because the live DOM carried the derive strategy's
  justification while windows rendered encoded. Max ruled that unacceptable
  ("first-interaction friction equal to the difference between full render
  latency and splice latency") and asked the obvious question: why not force
  Verovio to use one break algorithm everywhere?
- **NOT fixed by this chunk**: the user-`<pb>` giant-page quirk. A Ctrl+B page
  break still routes through the derive path (`layoutBreaks` + encoded), which
  paginates ONLY at encoded breaks → 2 giant pages on the sonata (probe
  confirms 37 → 2 → 37 on undo). Fixing it needs the derive path to paginate
  by height itself (bake sb via smartSb0, render `'line'` to get height-derived
  pages, then union the user's `<pb>` positions into our page starts) — the
  same page-fit machinery that vertical justification would build on.

## One break algorithm everywhere (2026-08-30) — the never-painted castoff bootstrap

**Why it was needed.** Max challenged the claim that the strategies justify
differently. Measured directly: on BYTE-IDENTICAL data (same `<sb>` pins, only
the `breaks` option changed) `line` vs `encoded` moves 409 of 446 measures —
median 26 units (~2.6 px), p90 121, max 515 (~52 px) — with identical
pagination and identical measures per system. Adding the `<pb>` elements
changes **0** measures, so the elements are inert and the ALGORITHM is the
whole cause. Nor is it a section-break artifact: 85 of 118 lines have no
encoded break or scoreDef anywhere near them and still average 77 units of
drift. (`line` ≡ `smartSb0` exactly — which is why this hid behind C-A's
parity claim. Also corrected: `breaks:'line'` DOES honor `<pb>`; the C-A note
saying otherwise is wrong, so ownership never actually required the mode
switch — it is just that `line` costs 1157 ms per full render vs `encoded`'s
538 ms, and Max declined that regression.)

**The fix.** Verovio can't castoff in `encoded` mode (it honors only encoded
breaks), so SOMETHING must cast off once. The mistake was painting that pass.
Now the derive render:

1. loads the document with the castoff strategy — **loadData only, never
   rendered to SVG, never painted**;
2. adopts the partition via `getMEI({scoreBased:false})`, which returns
   PAGE-BASED MEI (`<page>`/`<system>`) encoding exactly what castoff decided —
   ~100 ms including parse, versus ~1830 ms for the old page-by-page SVG walk,
   and byte-identical output (118 lines / 37 pages);
3. paints the pinned `encoded` render of that partition.

So every pixel the user ever sees comes from one algorithm, the first edit
splices like any other, and the idle adoption walk disappears. Anything
unreadable (getMEI failure, ids absent, overflow) falls back to painting the
castoff layout and arming the old idle walk — i.e. exactly the previous
behaviour.

**Verovio's two spacings, seen in the extreme** (the `phase3_section_header`
fixture: m1 = one whole note, m2 = empty with a forced section break, so both
systems are stretched far beyond their natural width — Max flagged the visual
diff and asked why). Same document, `line` byte-identical to `smartSb0`:

| | smartSb0 / line | encoded |
|---|---|---|
| system 1 measure width | 18790 | 18790 (same) |
| whole note from measure left | 1368 | **2935** |
| whole note past the clef/meter block | 298 | **1865** |
| system 2 (document-final) measure width | 18790 | **2553** |

Two distinct Verovio behaviours, both mode-driven, neither ours:
1. `encoded` leaves the DOCUMENT-FINAL system at its natural width instead of
   stretching it across the page — conventional engraving, and invisible on
   real scores (the sonata's systems are naturally near-full, max delta 516
   units over 446 measures).
2. Within a justified system the two modes distribute slack differently:
   `smart` puts nearly all of it AFTER the first event, `encoded` puts some
   BEFORE it. This is the same distribution difference measured document-wide
   (median 26 units ≈ 2.6 px); it reaches ~157 px here only because a single
   event is absorbing an entire page of slack. Baseline reseeded with Max's
   approval; the exact internal rule was characterised, not isolated.

**Measured (sonata):** first edit after a derive **1.2 s → 333 ms (splices)**;
derive itself 1.2 s → ~2.0 s (one extra loadData); the ~1830 ms idle walk is
gone. Load-plus-first-edit total work drops from ~4.2 s to ~2.3 s. Ownership
and pagination are live the instant the derive finishes, rather than ~2 s
later. Two gotchas worth remembering: `getMEI({pageNo:N, scoreBased:false})`
returns an EMPTY string (ask for the whole document), and Verovio echoes our
`hkl:` metadata without its `xmlns:hkl` declaration, so the output must have
the prefix re-declared before parsing.

## Splice latency — where the time actually goes (2026-08-30 profile)

`cb-profile.js` wraps the hot primitives and phase boundaries around one
steady-state spliced edit on the sonata (Chromium). **313 ms total:**

| bucket | ms | note |
|---|---|---|
| `renderer.renderComposer` | 164 | contains the two below |
| ├ `PageSystemSplicer.trySplice` | 108 | window render + DOM surgery |
| └ `PageLineBreaks.tryRefill` | 55 | naturals window 35 + sig diff 21 |
| `cursor.update` | 57 | **2 calls per edit**, whole-doc measure scans |
| `model.deleteAtCursor` | 45 | normalizePlaceholdersAll 18 + ties + clamp |
| everything else | ~47 | dispatch, overlay rebuild, selection, bridge |

**Verovio is only 58 ms of it** (`loadData` 17 ms for 33 KB of windows +
`renderToSVG` 41 ms). Max's intuition — "it should feel like editing a
few-system score" — is right about the engraving and wrong about the rest: the
other ~255 ms is whole-DOCUMENT bookkeeping that a small score simply doesn't
have. 31,968 `querySelectorAll` calls (30 ms) and 495 measure serializations
(21 ms) happen per edit regardless of how little changed.

Two self-inflicted costs found and FIXED here (they were the difference
between ~1.2 s and ~300 ms):
1. **The splice was invalidating the live toolkit** (`tkCurrent = false`)
   although it renders through `spliceTk` and never touches `tk`. The next
   lazy mount therefore reloaded the whole document (~590 ms) for nothing.
   Staleness is now per-page (`pageVirt.stalePages`): a splice only invalidates
   the pages it edited, and every other page still mounts from the loaded
   layout — correct, because a splice replaces only the systems it touched.
2. **Every page edit was deferred behind the busy badge** (two rAFs + a
   timeout) because `predictNextRenderHeavy` keyed off the last FULL render's
   duration. It now predicts light when the previous page render spliced, so
   splices run synchronously with no badge flash — mirroring the scroll path's
   `willSplice` heuristic.

## Phase D — make the EDIT PATH O(edit), not O(document)

**The diagnosis (Max, 2026-08-30, rejecting a list of 15 ms shavings as a
strategy): rendering is incremental now; everything wrapped around it is still
whole-document.** Per keystroke on the sonata, regardless of what changed:

- **495 `XMLSerializer` calls** — the refill re-serializes all 446 measures to
  diff signatures (21 ms)
- **26 `allMeasures()` calls** — each a fresh `querySelectorAll("measure")`
  over the entire document
- **~32 000 `querySelectorAll` calls** (30 ms) — mostly `expandForSpanners`
  rescanning all 446 measures INSIDE its growth loop, twice per edit, plus
  `computeUserBreakSig` / `computeHeadSig` / `computeInteriorSig` /
  `hardStartIds` each walking the whole section
- **`cursor.update` twice** (57 ms), each rebuilding from a full-document scan

That is ~130 ms of the 300 ms, and none of it depends on the edit. It is the
entire reason a one-page score feels instant and a 446-bar score does not —
and why per-item shavings are the wrong instrument. **Verovio is 58 ms and is
already incremental**; it is not the bottleneck. (Max's framing: a renderer
does not re-serialize its scene graph to text every frame. We do, per
keystroke.)

**The work, in size order:**

| step | saves | status |
|---|---|---|
| cheaper whole-document primitives (`layerInMeasure`, `flatChildren`, `expandForSpanners`/`ForEndings`, `normalizePlaceholders`) | ~65 ms | **DONE** — see "Phase D pass 1" |
| cached cursor-stop enumeration (`flatChildren`), mutation-invalidated | ~20 ms | **DONE** — see "Phase D pass 2" |
| incremental sig baseline — re-serialize only changed measures | ~20 ms | **DONE** — same mutation-tracking mechanism, in `PageLineBreaks` |
| version-stamped structural signatures instead of whole-section walks | ~10 ms | **not worth it** — measured: the three section walks (`headSig`/`interiorSig`/`userBreakSig`/`hardStartIds`) are a few hundred cheap iterations each, not the 10 ms the plan assumed |
| scope `normalizePlaceholdersAll` to the dirty range | ~15 ms | **DONE** — 17.1 → **0.9 ms**. See "Phase D pass 4" |
| cached measure list + partition cache across zoom | — | **DONE** — `allMeasures` 5.5 → 0.5 ms; a zoom return skips the castoff (2233 → 848 ms). See passes 3–4 |
| bounded-delta legality guard — skip the naturals render entirely when the line's fill margin exceeds the maximum width the edit could add | ~30 ms | OPEN (item A8) — needs a sound upper bound on the width an edit can add; naturals are already cached per measure and only dirty ids are re-measured |
| smaller splice window + fewer `getBBox` flushes in the splice | ~30 ms | OPEN (item A6) — measured at 16 ms, not 30 |

**Landing zone: ~130 ms, and flat in document size** — a 2000-bar score would
cost what a 50-bar one does. That is the property that matters; the absolute
number is secondary.

### The mechanism that made caching possible: exact mutation invalidation

Both caches below tried the obvious thing first — invalidate at
`invalidateMeterCache`, the model's existing single invalidation point — and
the `HKL_INDEX_CHECK` gate immediately proved it unsound: `insertWithSplit`
reads `flatChildren` in the MIDDLE of a mutation, between its own DOM writes
and its closing normalize. The design doc's own warning ("mutation code reads
it mid-operation") was exactly right, and no amount of discipline auditing
would have made a call-site-based scheme safe.

The fix is to stop relying on discipline: a **`MutationObserver` on the live
document**, whose `takeRecords()` drains SYNCHRONOUSLY and therefore sees every
DOM write, including ones made between two reads inside one operation. The
observer callback can drain the queue first on its microtask, so a `fired` flag
covers that path too; neither can be missed. Document-object swaps (load, undo,
redo) are detected by identity and re-arm. Consequences:

- `ComposerModel.flatChildren` caches per voice and clears whenever the document
  changed since the last call. Correct by construction rather than by audit —
  and strictly safer than the discipline it replaces.
- `PageLineBreaks` keeps `sigEl` (element identity per captured id) alongside
  `sig`, folds records into a dirty-MEASURE set, and reuses the captured string
  for any measure that is still the same element and was never mutated.
  Mutations above measure level (a `<section>` childList insert/remove, a
  mid-piece scoreDef, the head) set "assume all dirty", so the measure SET
  changing can never be mistaken for a clean document.

Both keep their `HKL_INDEX_CHECK` verifications permanently — the model
re-enumerates and compares on every cache hit, the owner re-serializes the whole
document and compares every string — so the 339-fixture suite is a standing gate
on the mechanism, not a one-time check.

### Phase D pass 1 (2026-08-30) — cheaper primitives, 308 → 243 ms

No caching, no semantic change; every one of these was a whole-document
primitive doing more DOM work per element than it needed:

- **`ComposerModel.layerInMeasure`** — was `measure.querySelectorAll('staff')`
  + `staff.querySelectorAll('layer')`, i.e. a full SUBTREE walk (every note in
  the measure) to find an element two levels down. MEI nests
  `measure > staff > layer`, so it now scans direct children, with the subtree
  query kept as a fallback for unexpected nesting. This one call is inside
  `flatChildren`, `tieEventSequence`, `allLayers` and `getVoiceLength` — it ran
  thousands of times per keystroke.
- **`flatChildren`** — `shouldEmitWrapper` re-derived the previous measure's
  layer, its content children, and its fullness on every measure, so the walk
  cost three `layerInMeasure` lookups and up to three `contentChildren` scans
  per measure. It now carries that state forward, keeping the previous layer's
  fullness lazily memoised exactly as `layerIsFull` was.
- **`expandForSpanners`** — rebuilt its whole-document note-id map and
  re-queried every measure's spanners INSIDE its growth loop, so one call was
  O(measures × iterations) `querySelectorAll`s. The DOM is now read once (a
  single union query per measure) into resolved `[min,max]` extents plus
  per-measure tie edges, and the growth loop is pure array arithmetic.
- **`expandForEndings`** — same shape: a wrapper→index-span map built in one
  pass instead of rescanning all measures per candidate per iteration.
- **`normalizePlaceholders`** — materialised `layer.children` three times per
  layer (content sum, mRest test, idempotency check) across ~1800 layers.

Measured on the sonata (steady-state spliced edit, `cb-scale.js`):
`querySelectorAll` **31 969 → 3 428 calls / 33.3 → 9.5 ms**, `cursor.update`
**62.6 → 22.4 ms**, `deleteAtCursor` 51 → 32.7, `normalizePlaceholdersAll`
17.1 → 11.7. Wall **308 → 243 ms**. Suite 339/339 under `HKL_INDEX_CHECK`.

### Phase D pass 2 (2026-08-30) — the caches, 243 → 206 ms

- **Cursor-stop cache.** One edit asks for `flatChildren` ~15 times:
  `cursor.update` resolves its anchor through five separate model queries
  (`isCursorAtPastEnd`, `getCurrentElement`, `getNextElement`,
  `getVoiceLength`, `getStaffIdAtCursor`) and runs twice per edit, and
  `clampCursors` asks once per voice. None of those mutate the document, so
  they now share one enumeration. `buildVoiceIndex` reads through the same
  accessor; `assertVoiceIndexConsistent` deliberately enumerates FRESH so that
  gate still cross-checks the index against the document rather than against
  the cache. **`cursor.update` 22.4 → 2.3 ms.**
- **Incremental sig baseline.** The refill's prefix/suffix diff re-serialized
  all 446 measures every keystroke to find the changed run. It now recomputes
  only measures the document actually mutated. This is the item that makes the
  diff O(edit) rather than O(document) — the constant saving is secondary to
  the flatness.

Wall **243 → 206 ms**; Verovio is 59 ms of that (`renderToSVG` 42 +
`loadData` 17), so our own overhead is down to ~150 ms from ~250.

`allMeasures()` is cached on the same signal (~17–26 whole-document
`querySelectorAll`s per edit), which completes the plan's "maintained model
indices" item as far as it is worth taking: an id→index map was NOT added,
because with the list cached the remaining lookups are a handful of `indexOf`s,
not a measured cost.

### Phase D pass 4 (2026-08-31) — scoped placeholders, cached measure list, partition cache: 206 → 168 ms

- **`normalizePlaceholdersAll` is scoped to the layers that changed** (17.1 ms at
  baseline → **0.9 ms**). The first attempt scoped it but bought only 1.6 ms,
  and the reason is worth recording: the attribution rule was "a mutation not
  inside a `<layer>` means every layer must be re-checked", and MEI puts control
  events at MEASURE level — so `normalizeTies`' `pruneDanglingSlurs` /
  `pruneDanglingArticControls` and `setBarlines`' measure attributes escalated
  essentially every edit to the full pass. None of those can change a layer's
  tick budget, so `cannotChangeLayerBudget` now exempts control events
  (`<slur>`, `<dynam>`, `<dir>`, `<artic>`, …) and the barline attributes,
  while anything else outside a layer — a measure added or removed, a
  `<scoreDef>` meter change, a new `<staff>`/`<layer>`, an unrecognised measure
  attribute — still forces the full pass. The whitelist is narrow on purpose and
  is verified empirically: under `HKL_INDEX_CHECK` the scoped pass is followed
  by a full pass that must find NOTHING left to rebuild, on all 339 fixtures.
- **`allMeasures()` cached** on the same mutation signal (5.5 → 0.5 ms).
- **Spanner/ending extents cached** (A9): `expandForSpanners` reads the document
  once per edit instead of once per call (~3 calls per edit) —
  `querySelectorAll` 3428 → 2537 calls.
- **A4, the partition cache**, keyed on (zoom, pageScale, heji) and guarded by
  the model's document version: a zoom RETURN on an unchanged document reuses
  the partition instead of re-running the castoff pass. Measured on the sonata
  with the decision points instrumented (`cb-zoomcache.js`): first visit to
  zoom 50 **2233 ms with a castoff**, return visit **848 ms with a cache hit and
  no castoff**, partition hash identical. A stale entry is correctly refused
  (castoff runs). Nothing is trusted blindly — a restored partition still goes
  through `verifyRenderedPartition` and the page-overflow check, so a bad entry
  degrades to a derive, never to a wrong layout.

**A near-miss worth recording (`cb-zoominvariant.js`).** The round-trip probe
showed zoom 50 and zoom 100 producing an IDENTICAL partition via two
independent castoffs, which suggested zoom is pure magnification (page
rectangle and content scale together) and could leave the cache key — making
even the FIRST zoom change skip the castoff. Forcing a real castoff at every
preset refuted it: **zoom 75 gives 134 lines where 50 and 100 both give 118.**
The crisp presets do not scale page and content by the same factor at every
level, so 50/100 agreeing is a coincidence. Zoom stays in the key. (pageScale
1.4 sampled identical to 1.0 at zoom 100; it stays in the key too, on the same
"one sample is not a proof" reasoning.)

### Zoom is layout-neutral — RESOLVED by a constant unit 8 (2026-08-31)

**Max's ruling: "zoom should be a no-op in terms of line count and
distribution, not add 8 pages."** It wasn't, and now it is.

Measures-per-line is governed by the music:paper ratio. `scalePageGeom` scales
the page rectangle by `pageScale` ONLY — never by zoom — while `buildOptions`
sets `unit` from the crisp preset, and the presets were not uniform in `unit`.
Verovio's `scale` has NO layout effect (proven: zoom 50 vs 100 differed only in
`scale`, identical `unit: 9`, byte-identical partitions), so `unit` was the
whole cause:

| | scale | unit | staff-space | sonata lines | pages |
|---|---|---|---|---|---|
| 50 before | 50 | 9 | 9 px | 118 | 37 |
| 75 before | 70 | **10** | 14 px | **134** | **45** |
| 100 before | 100 | 9 | 18 px | 118 | 37 |
| **50 / 75 / 100 after** | 50 / 75 / 100 | **8** | 8 / 12 / 16 px | **116** | **30** |

**Why unit 8 works, and why nobody had tried it.** Which scales are available at
a given unit depends on `gcd(unit, 50)`: a scale must be a multiple of
`50/gcd(unit,50)` for the staff-space (`unit × scale / 50` device px) to be an
integer. At unit 9 (gcd 1) that means multiples of 50 — only 50/100/150, with
NOTHING between 50 % and 100 %, which is why 75 % had to co-tune to unit 10. At
**unit 8** (gcd 2) it means multiples of 25, so **50/75/100 are all crisp at one
unit**. Stroke widths stay whole-device-px per preset
(`int(width × unit × 10) × scale/1000`): 0.25 → internal 20 → 1.0 px at scale 50
and 2.0 px at 100; 75 % uses 0.1625 → internal 13 → 0.975 px, the same ~1 px
approximation the old preset already shipped (0.98 px). Scales are now clean
multiples of 25, so Verovio's root-`<svg>` ceil drift (the old 70 → 0.0701 case)
is gone too.

The history, for the record: **unit 9 was never chosen** — lessons.md calls it
"Verovio's default", the 50/75/100 ladder predated the presets, and unit 10
arrived in a grab-bag commit ("dark mode and related tweaks") purely to rescue
75 %. decisions.md meanwhile asserted the opposite of the defect ("zoom is pure
magnification and does not change music-per-page"), so the cost was never
weighed. Searching for that justification before touching it was Max's
instruction and the right call.

**DEAD END on the way (do not retry): compensating the paper by `unit / 9`.**
Scaling pageWidth/pageHeight/margins by the unit ratio matched
`contentWidth / unit` to five digits (208.79 at zoom 75 vs 208.78 at zoom 100)
and STILL did not reproduce the partition — 134 → 113 lines where 118 was
wanted. Verovio's horizontal spacing contains terms that do not scale with
`unit`, so no paper size reproduces another unit's layout, and fitting the
factor empirically would be reverse-engineering the spacing model.

**Accepted cost** (Max, after a six-image side-by-side of sonata page 1 at all
three zooms): every level is ~11 % smaller — 100 % staff-space 18 px → 16 px —
so the sonata is more compact (30 pages instead of 37, 18 measures on page 1
instead of 14) and every score re-breaks once. 36 visual baselines reseeded.

**Battery after unit 8** (`cb-splice-battery.js`): all 8 edits apply, all
reference-clean, **6 of 8 splice** at 316–512 ms. That is one fewer splice than
before, and the cause is benign: the denser layout moved the `edit-page-first`
probe onto a measure with content above the staff, so the vertical gate refuses
with `vertical: page-first hang would move` — the window renders (5 lines,
20 measures, 96 ms) and the gate correctly declines because the page-first
system's hanging extent would change, which would move every system below it.
Safe fallback, parity intact; **B1 (dy-cascade)** is the item that converts this
class. Not a splice regression — the same gate, a different musical location.

**Consequence for the partition cache:** all zooms now share a single key
(`u8|s1|plain`), so **every zoom change is a cache hit** — measured 740 / 733 /
705 ms across 50 → 75 → 100 switches, versus up to 2134 ms when zoom 75 needed
its own castoff. `unit` stays in the key rather than being dropped, so that a
future ladder which reintroduced a per-zoom unit would stay correct instead of
silently serving another unit's partition. `cb-zoomunit.js` is the regression
gate: if `zoom75_differs` ever goes true, a preset has brought back a per-zoom
`unit`.

### Behaviour gate — the sonata battery run on BOTH code states

Stash the source, re-run `cb-splice-battery.js`, unstash. Splice/skip outcome is
identical edit-for-edit (7 of 8 splice; the section-header line is the by-design
skip), reference parity holds across all 37 pages / 446 measures in both (max
4 units, max spacing 9), and every edit got faster:

| edit | before | after |
|---|---|---|
| delete-mid-line | 402 ms | 358 ms |
| reinsert-mid-line | 428 | 322 |
| delete-line-start | 492 | 460 |
| insert-rest-ripple | 607 | 547 |
| edit-near-volta | 538 | 464 |
| edit-section-header-zone (skips) | 1353 | 1068 |
| edit-doc-end | 419 | 370 |
| edit-page-first | 467 | 384 |

(These walls exceed `cb-scale`'s 206 ms because the battery mounts every page
and runs a whole-document reference compare per edit.)

**Two battery edits were silently not applying — a TEST bug, now fixed
(2026-08-31).** `reinsert-mid-line` and `insert-rest-ripple` reported
`editOk: false` (pre-existing — identical on the stashed baseline), and the
probe recorded that flag without asserting on it, so it read as passing.

The insertion rule is settled and documented
([architecture/composer.md](architecture/composer.md), planner invariants):
*"Measures never exceed length. Content landing past the cursor's measure
requires that target layer EMPTY, else reject."* Measured at both sites
(`cb-editok.js`): bar 100 is dense 16ths with **bar 101 completely full**, and
bar 150 is full 8ths/16ths with **bar 151 completely full** — so both refusals
are exactly what the rule specifies. The probes were asking for the impossible:
edit 2 deleted a 16th (freeing 4 ticks) then inserted a QUARTER (16 ticks,
needing 12 ticks of overflow into a full measure); edit 4 deleted one 8th
(freeing 8 ticks) then inserted an 8th rest — which alone refilled the measure —
followed by an 8th chord with nowhere to go.

Fixed by matching the inserted durations to the space the delete frees (a 16th
for edit 2; a 16th rest + 16th chord for edit 4), and `allEditsApplied` /
`editsNotApplied` are now asserted in the battery result so this cannot go
silent again. **No model change: the planner was right throughout.**

**Scope boundary (Max, 2026-08-30, permanent): Verovio renders our scores;
we do not replicate musical spacing.** "Musical spacing is incredibly complex
in ways I don't even fully comprehend, and trying to replicate it ourselves
for tens of ms is always a losing battle." So owning intra-measure spacing is
NOT a future phase and should not be proposed again. The division of labour is
settled: **we own break decisions (lines, pages) and DOM surgery; Verovio owns
everything inside a system.**

That fixes the latency floor at the cost of one small window engrave per edit
— measured flat at ~17 ms `loadData` regardless of document length, plus
whatever the window's own musical density costs to draw. Every remaining
millisecond therefore has to come from OUR overhead: the O(document) tax
(Phase D), the mounted-DOM layout-flush cost, and the number of measurements
the splice takes. ~120–150 ms flat in document size is the realistic target,
and flatness is the property that matters — a 2000-bar score behaving like a
200-bar one is what makes engraving full pieces viable.

### Scaling baseline (2026-08-30, `cb-scale.js`) — measured, not hypothesised

Same edit (Backspace on a note mid-document, through the real input path,
steady-state second edit), three document sizes, identical instrumentation:

| | empty | 1 page | sonata |
|---|---|---|---|
| measures / systems | 1 / 1 | 16 / 3 | 446 / 118 |
| pages in DOM (mounted) | 1 (1) | 1 (1) | 37 (2) |
| SVG elements in `#score` | 119 | 930 | 3731 |
| outcome | derive | spliced | spliced |
| **WALL** | **30 ms** | **66 ms** | **303 ms** |
| `renderer.renderComposer` | 29 | 59 | 155 |
| ├ `trySplice` | 0 | 45 | 102 |
| └ `tryRefill` | 0 | 14 | 52 |
| `cursor.update` | 1 | 4 | **54** |
| `model.deleteAtCursor` | 0 | 1 | **52** |
| `verovio.renderToSVG` | 2 | 17 | 42 |
| `verovio.loadData` | 22 | 22 | **17** |
| `querySelectorAll` (ms / calls) | 0 / 85 | 1 / 1 475 | **31 / 31 969** |
| `XMLSerializer` (ms / calls) | 0 / 5 | 1 / 21 | **22 / 495** |
| `getBBox` (ms / calls) | 0 / 4 | 5 / 160 | **18 / 199** |
| `normalizePlaceholdersAll` | 0 | 0 | 17 |

**A one-page splice is already 66 ms — instant by our standard.** The whole
problem is the 237 ms the sonata adds, and it decomposes cleanly:

1. **~150 ms is pure O(document) tax** — `cursor.update` +50, model mutation
   +51, `querySelectorAll` +30 (21× the calls), sig diff +21 (24× the
   serializations). All of it eliminable by Phase D; none of it depends on the
   edit.
2. **~25–40 ms is layout-flush cost proportional to MOUNTED DOM** — the
   decisive tell: `getBBox` call count barely grows (160 → 199, +24 %) while
   its time more than triples (5 → 18 ms), because each flush now lays out 4×
   the elements (930 → 3731). This is the one cost that survives an O(edit)
   conversion; it scales with mounted pages (2 here), not document length, so
   mounting less and measuring less are the levers.
3. **~25 ms is musical density, not size** — `renderToSVG` grows 17 → 42
   because the sonata's window holds real chords, slurs and beams while the
   synthetic page holds plain quarters. A dense one-page score would pay this
   too. **`loadData` is FLAT (22 → 17 ms)**: the window is the same size
   regardless of document length.

**So Verovio genuinely does not scale with document size — our bookkeeping
does.** Projected after Phase D: sonata ≈ 150 ms, and ≈ 120 ms with the
bounded-delta guard removing the naturals render. Beyond that the remaining
costs are the mounted-DOM layout flushes (2) and the window's own drawing
cost (3); the engraver stays Verovio's job by ruling, so the lever is always
reducing our overhead, never replacing the spacing.

(Note the `empty` column measures a DERIVE, not a splice — a single-line
partition is never owned by design — so 30 ms is the floor cost of a full
render on a trivial document, not a splice baseline.)

## Implementation (Phase C-B2b / B1, 2026-08-31) — the dy-cascade, shipped

The v1 vertical gate refused whenever anything would move. It is replaced by a
**vertical plan** (`VerticalPlan` / `verticalPlan` in `pagesplice.ts`): where a
full re-engrave would put each replaced system, and the single dy every system
below it on its page would take. All four `vertical: …` skip reasons are gone.

**The window now mirrors live pagination.** Every window line that begins a
LIVE page is pinned as `<pb>` instead of `<sb>`, and the window renders with
the **live page options verbatim** (`'encoded'` paginates only at encoded
breaks, so the tall-page + `adjustPageHeight` + `header:'none'` trick that
`breaks:'line'` needed is unnecessary once pagination is owned). The window
therefore paginates exactly where the document does, one host `<div>` per
window page — the same shape a mounted page has, so `postProcess`,
`decorateHost` and `mergeGlyphDefs` (which reads ONE `<defs>`) all behave as on
the live path.

**Why that was necessary, not tidy.** v1 modelled a page's first system as
*"content top at the margin + hanging extent"*. Measured against real full
renders (`cb-dycascade.js`), that is off by up to **85 units** — Verovio places
systems from internal metrics that disagree with the rendered `getBBox`
whenever the topmost content is `<text>` (`g.dir`, `g.tempo`, HEJI `g.accid`) —
and the window's `header: 'none'` removed the running-header band that anchors
every page's first system, a uniform **~419 unit** offset that no relative
check can see. With the window paginated and its options matched, a page-first
system is page-first in the window and its staff top is READ, not derived
(both sides are page-margin relative). Worst prediction error over 19 samples:
**425 → 8 units**. Details in lessons.md.

**The plan.**

- page-FIRST replaced system → `newTop = window counterpart's staffTop`;
- any other → `newTop = previous newTop + the window's own spacing` (the chain
  is anchored at the unchanged context line above, and RESETS at every page
  boundary inside the run — which is what stops a dy leaking onto the next
  page);
- `dyFollow` = where the first unreplaced follower lands minus where it is.
  Only ONE page can have followers: a replaced system that is not its page's
  last is followed by another replaced system, so the only one that can be
  followed by unreplaced systems is the last replaced one.

**Applied all-or-nothing.** The plan is accurate to ~±8 units, so applying a
3-unit movement adds error rather than removing it and re-snaps a whole page
for a sub-pixel edit (it showed up at once as a visual-baseline diff on
`pageSystemSpliceEdit`). `plan.static` — nothing moves by more than EPS — pins
every system to its live staff top exactly as v1 did; otherwise the whole plan
lands and the followers (collected BEFORE the surgery, which detaches the last
replaced system from the DOM) take `dyFollow`. `snapPage` then re-lands staff
lines on the device grid, exactly as a full render does.

**Cross-page moves: repaginate, never splice across.** Under owned pagination a
full render does not move systems between pages either — page starts are
pinned — so a splice that did would diverge from the reference by construction.
What can happen is that a cascade pushes its page past the paper, and Verovio
draws past a pinned page rather than re-paginating. The splice therefore runs
the same `overflowingPage()` check the pinned full-render path uses (scoped to
the edited pages) and hands pagination back on a spill.

**One refusal remains in this area**: a live page-first system whose window page
boundary is missing (only possible when pagination is not owned — the tall-page
window has no `<pb>`). The section-header-page refusal this section originally
listed was removed the same day; see "Section headers" below.

### Section headers — reserve subtracted, titles cascaded (B4 half, 2026-08-31)

`injectSectionHeaders` (main.ts) runs at page MOUNT: it displaces the header's
system and every later system on that page by `SECTION_HEADER_RESERVE`, then
appends the title `<text>` to the PAGE-MARGIN at an absolute y. Verovio knows
neither fact, so once B1 began moving systems this produced two defects — the
title had nothing moving it (Max: *"the page reflows while the header stays in
place, overlapping it"*), and the plan's chain, which runs on LIVE staff tops,
was wrong by the whole reserve wherever a chained pair straddled the header
boundary (`dyFollow` 1536.9 where 2436.9 was right — a mis-placed system, not
just a mis-placed word).

The plan now runs in **Verovio coordinates**: each `LiveSys` carries its
accumulated reserve, the chain subtracts it before chaining and adds it back
after, and the cascade moves every title whose system it moves. The reserve is
READ BACK from the DOM — the injector records `data-reserve` on the title — so
there is one source of truth rather than a constant duplicated into the render
layer. An unreadable reserve refuses the splice; guessing is what caused the
overlap.

**The gate exemption was the bug-enabler.** Both reference gates skipped the
vertical checks on section-header pages, which is exactly why a 900-unit
misplacement passed. They now subtract the reserve and verify those pages like
any other (the sonata's three header pages are checked for the first time, max
absolute staff-top delta 6 units), and the inline gate asserts each title still
sits inside its own reserve band. Fixture `pageSectionHeaderCascade` grows then
shrinks the line directly above a header and asserts the title/system clearance
is unchanged in both directions; it fails on the pre-fix build with the reported
symptom.

**Measured (sonata battery)**: **7 of 8 edits splice** (was 6), all 8
reference-clean — max per-measure x/width delta 4 units, max spacing 8, max
**absolute** staff top 6, over 30 pages / 446 measures. `edit-page-first`
**1152 ms → ~440 ms**. The single remaining fallback is the by-design
section-header line.

**Gates**: the reference comparisons — both the inline `HKL_INDEX_CHECK` gate
and `cb-splice-battery.js` — now assert **absolute** staff tops, not just
consecutive spacing; a cascade that shifted a whole page by a constant would
otherwise pass every check. Fixtures: `pageSystemSpliceDyCascade` (splice +
non-static plan + the followers actually move), `pageSystemSpliceCascadeOverflow`
(grows successive systems until page 1's slack is exhausted, then asserts
pagination was handed back and nothing is drawn past the paper — it captures
the `console.warn` itself, since the suite fails on any warning), and
`pageSystemSpliceBottomExtent`, which REPLACES `pageSystemSpliceVerticalBail`:
growing the doc-last line's bottom extent moves nothing below it and now
legitimately splices. Suite 342/342 under `HKL_INDEX_CHECK`;
typecheck/build/boundaries clean.

## Window expansion — one containment pass, not a fixed point (2026-08-31)

**The rule (Max):** *a spanner with one end inside the replaced set needs the
window to cover its other end.* Nothing more. A spanner lying wholly outside the
replaced set cannot change how those lines draw, and one dangling out of a
CONTEXT line is harmless — context lines are only measured for per-measure
x/width, which slurs do not drive.

**What it replaced.** `expandForSpanners` grows a range until every spanner
overlapping it is contained, re-scanning after each growth — a transitive
closure over the interval graph of spanners. `trySplice` then wrapped that in an
8-iteration loop that rounded out to LINE boundaries and re-expanded, so
measures added purely by rounding fed their own spanners back in. The document
contains nothing pathological to justify it: **926 spanners, 922 of them slurs,
none longer than 3 measures, and none crossing more than one line boundary**
(`cb-spanchain.js`). Ordinary legato phrasing — each slur ending on the downbeat
where the next begins — was enough for one seed to walk **17 slurs deep, 24
measures, 6 lines**, entirely through lines nobody was re-rendering.

**Implementation**: `expandForSpannersOnce` (render/splice.ts) tests overlap
against the ORIGINAL range and does not iterate; ties still pull in one
neighbouring measure per edge. The page splicer uses it twice — once for the
replaced set L from the changed run, once for the window from L — then adds one
context line per side and contains any `<ending>` a context line half-covers
(voltas are structural; a bracket over a truncated member set is wrong). The
scroll splicer's run expansion and the naturals window keep the closure: a
different geometry, unmeasured, so unchanged.

**Measured** (per-measure seeds over all 446 measures): replaced set max 5 → 2
lines, window max 14 → 6, mean window 6.33 → 4.14, seeds over
`MAX_WINDOW_LINES` **52 → 0**. Worst-case (per-line) seeds: replaced 6 → 3,
window 16 → 7. Both caps stop binding and become backstops. Truncating a spanner
at the window edge (anchored to the synthetic leader/trailer) remains the answer
for a genuinely document-long spanner; the sonata has none, so it is not built.

## TODO — current state (updated 2026-08-31, end of session)

**Resolved 2026-08-30:** the k=87 castoff-threshold class; pin lifecycle
(render-time injection only); gap fidelity under pinning (delta 0.0);
pagination ownership (`<pb>` pins + `encoded`); the encoded-respacing question
(measured, reviewed by Max, four baselines reseeded — ACCEPTED, not moot);
reflow reversibility (conservative repartition); and the first-edit-after-derive
full render (never-painted castoff bootstrap).

**Resolved 2026-08-31:** Phase D (the edit path is O(edit); sonata splice
308 → ~170 ms) covering A2/A4/A7/A9 and the measure-list half of A3; **C3**
(zoom made layout-neutral by a constant `unit: 8`, and every zoom change is now
a cache hit); **C1** (user page breaks split their line and cascade — segmented
castoff); **B1** (the dy-cascade: the vertical gate measures and applies
movement instead of refusing it, battery 6/8 → 7/8); and a long-silent TEST bug
(two battery edits had not been applying for months because the probe recorded
`editOk` without asserting it).

### ► START HERE NEXT THREAD

Read this section first; the per-area lists below have the detail.

1. **The last 5 refusals, and whether they are worth it.** The sweep is at
   88.7 % (102/115; 102 of the 107 edits that actually change the document).
   What is left: 1 `section-header line` (B4 remainder), 2 `context line below
   diverged` (dW 49 and 347 — courtesy-like but not fixed by the B3 extension,
   so a different or compound cause), 1 top-edge `dRelX=36.0`, and the
   document's final line. Each looks individually small; measure before
   assuming any of them is a class.
2. **B4 remainder — the `section-header line` refusal and line 0.** The reserve
   half of B4 is DONE (see "Section headers"): the plan now reasons in Verovio
   coordinates, titles travel with their systems, and header pages are no longer
   exempt from either reference gate. What is left is the refusal when the
   REPLACED run itself contains a header measure — re-placing the title needs
   the injector's baseline rule, not just its reserve — and the line-0
   exclusion (score-start treatment differs in a window, probe k=0 ~1 px).
   Folding the reserve into the RENDER instead of a post-mount translate would
   retire the last refusal; it is also what D1 (vertical justification) needs.
3. **A6 — the splice's DOM cost, but NOT by cutting getBBox calls.** Measured
   and refuted: 199 → 169 calls changed the time by nothing (15.5/16.1/17.8 ms
   vs ~16.0). It is layout-FLUSH bound. The real levers are fewer MOUNTED pages
   and fewer read/write ALTERNATIONS (batch every read before any DOM surgery).
   ~16 ms available.
4. **Vertical justification (D1) + system-height tracking.** The backlog asks
   for "actually track system heights so we can decide whether to reflow systems
   in the first place (keep existing positioning whenever possible)" and
   "automatic vertical spacing of full pages". C1's segmented castoff
   deliberately avoided needing a height model — but D1 needs one, and once it
   exists the segmented castoff could become a straight page-fit loop.
5. **A5 — worker-offloaded castoff.** The largest single remaining block is pure
   Verovio on the main thread (~1.4 s on the sonata derive). Big refactor;
   `afterRender` is the seam. Only worth starting with a clear runway.

**Measurement discipline (learned the hard way this session).** `cb-scale.js`
single readings vary 166–206 ms on identical code: run it 3× SEQUENTIALLY and
compare medians, and trust the CALL COUNTS (`querySelectorAll`, `XMLSerializer`,
`getBBox` `n`) over milliseconds — counts are deterministic. For any edit-path
change, run `cb-splice-battery.js` on BOTH code states (`git stash push --
apps/composer/src`, run, pop, run) and diff: what must match is the splice/skip
OUTCOME per edit and `reference.ok`, not the wall times.

**Two standing traps.** Do not edit app source while `pnpm test:composer` is
running — Vite HMR reloads the page and the injected `window.__test` hooks
vanish, surfacing as hundreds of fixtures failing on
`Cannot read properties of undefined`. And the suite treats ANY console warning
as a failure, so two unrelated-looking fixtures failing on an identical warning
string means a shared render path started warning.

### A. Latency — the main thrust

- [~] **A1. Phase D: make the edit path O(edit)** — DONE for every O(document)
      item identified, 2026-08-30/31 (passes 1–4 above). Sonata steady-state
      splice **308 → 168 ms**, and the per-edit work is now edit-scaled:
      `querySelectorAll` 31 969 → 2 537 calls, `XMLSerializer` 495 → 54 calls,
      `cursor.update` 62.6 → 4.2 ms, `normalizePlaceholdersAll` 17.1 → 0.9 ms,
      `allMeasures` 5.5 → 0.5 ms. Of the 168 ms left, **56 ms is Verovio** (the
      documented floor) and the rest is no longer document-scaled. The gap to
      the ~130 ms landing zone is now A6 (16 ms of splice `getBBox`) and A8 (the
      second Verovio round-trip); everything else is small change.
- [x] **A7. Scope `normalizePlaceholdersAll` to the changed layers** — DONE
      2026-08-31: **17.1 → 0.9 ms**. Needed a second pass to be worth anything —
      the naive "any mutation outside a `<layer>` re-checks every layer" rule
      escalated on essentially every edit, because MEI control events live at
      MEASURE level and tie/slur pruning plus `setBarlines` touch them
      constantly. See "Phase D pass 4" for the exemption rule and its gate.
- [~] **A8. Bounded-delta legality guard — DROPPED** (Max, 2026-08-31: "Drop
      A8, I don't see a path forward there"). The idea was to skip the naturals
      render when the edited line's fill margin provably exceeded the width the
      edit could add. Not viable as specified: naturals are ALREADY cached per
      measure with only dirty ids re-measured, so the remaining render is exactly
      the one covering the edited measures, and bounding *their* new width
      without measuring means building a width model — which the Phase D scope
      boundary rules out permanently. The one window render per edit (~35 ms)
      stands as the accepted floor.
- [x] **A9. Cache the spanner/ending extents** — DONE 2026-08-31. The extents
      are built once per document version and reused across the ~3
      `expandForSpanners` calls an edit makes: `querySelectorAll` 3 428 → 2 537
      calls per edit.
- [x] **A2. `layoutBreaks` → page-based `getMEI`** — DONE 2026-08-30. The
      page-based read is now the shared helper `partitionFromLayout(tk)`
      (linebreaks.ts), used by BOTH `adoptFromCastoff` and `layoutBreaks`; the
      page-by-page `renderToSVG` walk survives in `layoutBreaks` only as the
      fallback for unreadable `getMEI` output. A user-`<pb>` document's derive
      no longer pays the ~1.8 s SVG walk. Prerequisite for C1, now met.
- [~] **A3. `cursor.update` dedupe** — the measure-list-cache half is DONE
      (pass 3/4: `cursor.update` 62.6 → 4.2 ms for BOTH calls, `allMeasures`
      0.5 ms), which removes almost all of the original ~40 ms without touching
      call ordering. Collapsing the two calls per edit is still **blocked on
      Max** (it touches the `onStateChange`-before-`onChange` ordering the
      bridge broadcast relies on) but is now worth ~2 ms, not 40 — effectively
      moot unless the ordering is being revisited anyway.
- [x] **A4. Partition cache keyed by (unit, pageScale, heji) + document
      version** — DONE 2026-08-31. Keyed on the LAYOUT INPUTS, not the zoom
      label; since C3 made `unit` constant across zooms it now holds ONE entry
      for every zoom, so a zoom change is always a cache hit (~750 ms, was up to
      2134 ms). A zoom RETURN on an unchanged document skips
      the castoff pass: sonata zoom-50 first visit **2233 ms (castoff)** →
      return **848 ms (cache hit, no castoff)**, partition identical; a stale
      entry is refused and re-derives. Instrumented at the decision points
      (`cb-zoomcache.js`), and a restored partition still passes through
      `verifyRenderedPartition` + the overflow check. Zoom must STAY in the key
      — see the near-miss in "Phase D pass 4" (zoom 75 breaks differently from
      50 and 100).
- [ ] **A5. Worker-offloaded castoff (T2.3)** — the castoff `loadData` is the
      largest single remaining block and is pure Verovio on the main thread.
      Only a worker removes it. Big refactor; `afterRender` is the seam.
- [~] **A6. Trim the splice's own DOM cost** — ATTEMPTED 2026-08-31, and the
      obvious form DOES NOT WORK. Cutting the splice's `getBBox` calls from 199
      to 169 (lazy per-measure boxes + reading only the first staff-line path)
      changed the measured time by **nothing**: 3 sequential runs at 169 calls
      gave 15.5 / 16.1 / 17.8 ms against ~16.0 ms at 199 calls, with wall inside
      run-to-run noise (166–176 either way). **This cost is bound by layout
      FLUSHES, not by call count** — which the scaling baseline already implied
      (call count +24 % from one page to 37, time +260 %). The assumption-free
      half (lazy per-measure boxes — nobody reads them for the replaced lines)
      is KEPT; the staff-line-order assumption was REVERTED, because an
      unverifiable claim about Verovio's emission order whose failure mode is
      silently mis-positioned systems is not worth zero milliseconds.
      **The real levers are therefore: fewer MOUNTED pages (each flush lays out
      all of them), and fewer read/write ALTERNATIONS in the splice** (batch all
      reads before any DOM surgery, so the phase costs one flush instead of
      several) — not fewer measurements. NOTE: owning intra-measure spacing
      remains permanently OUT OF SCOPE — see the Phase D scope boundary.

### B. Splice coverage — converting remaining fallbacks into splices

- [x] **B1. dy-cascade + cross-page moves (the C-B2b core)** — DONE
      2026-08-31; battery **6/8 → 7/8**, `edit-page-first` 1152 → ~440 ms. The
      premise ("the dy is known, just apply it") held for systems stacked
      inside a page and FAILED for a page's first system: v1's margin+hang
      model mis-predicts by up to 85 units because Verovio's placement metrics
      disagree with the rendered bbox for `<text>`, and the window's
      `header:'none'` hid a uniform ~419-unit anchor band. Fixed structurally —
      the window carries `<pb>` pins at the live page starts and uses the live
      page options verbatim, so the position is READ rather than modelled
      (prediction error 425 → 8 units). Cross-page moves cannot occur under
      pinned pagination; a cascade that would overflow its page hands
      pagination back instead. See "Implementation (Phase C-B2b / B1)".
- [ ] **B2. Line-count-changing refills** — replace N systems with M under the
      same machinery (today: full render).
- [x] **B3. Boundary courtesy** — DONE 2026-08-31, though NOT as framed here.
      The framing above (a boundary MOVING next to a clef/key change, fixed by
      re-splicing k−1) describes a case that does not occur: all 11 measured
      refusals had `refillLines: 0`. The real mechanism is that Verovio draws an
      end-of-line courtesy because of the line that FOLLOWS, and the window did
      not contain that line — so its last line rendered without a courtesy the
      live page has (`dRelX=0.0`, `dW` 43–347). The window now extends while the
      line just beyond begins a signature change (bounded at two — the sonata
      has consecutive meter changes). Diverged refusals **11 → 4**, hit rate
      **82.6 % → 88.7 %**, and the battery recovers `insert-rest-ripple`
      (**7/8**). Fixture `pageSystemSpliceCourtesySig`.
- [~] **B4. Section-boundary zones + line 0** — the SECTION-HEADER RESERVE half
      is DONE 2026-08-31 (see "Section headers"), and it was a live defect, not
      just missing coverage: an edit above a header cascaded the page while the
      title stayed put (Max), and the same missing knowledge made the cascade
      distance wrong by the whole 900-unit reserve. Both gates had EXEMPTED
      header pages from their vertical checks, which is why it went unseen.
      Remaining: the `section-header line` refusal (replaced run contains a
      header measure) and the line-0 exclusion (probe k=0, ~1 px score-start
      divergence). The k=59 zone is handled structurally by the context check.
- [x] **B5. Ensure-mount before the mounted gate** — DONE 2026-08-31. The
      splice now mounts a needed page from the already-loaded PRE-edit layout
      (`Renderer.mountPageIfCheap`, ~50 ms) instead of refusing, guarded on
      `tkCurrent` (else the mount would reload the whole document) and on the
      page not being stale (else it would render POST-edit content into a DOM
      the splice is about to patch). The page of a line comes from the pinned
      partition, not the DOM — an unmounted line has no element to look up.
      Sweep hit rate **66.1 % → 82.6 %**, mount refusals **19 → 0**; 95 of 107
      edits that actually change the document now splice. Fixture
      `pageSystemSpliceEnsureMount`.

### C. Known defects

- [x] **C3. Zoom is not layout-neutral — FIXED 2026-08-31.** The crisp presets
      now use a CONSTANT `unit: 8` at scales 50/75/100 (staff-space 8/12/16 px),
      so all three zooms produce an identical partition (sonata 116 lines /
      30 pages at every level, was 118/37 and 134/45) and every zoom change is a
      partition-cache hit (~750 ms, was up to 2134 ms). Accepted cost: ~11 %
      smaller notation at every level (100 % staff-space 18 → 16 px), reviewed
      side-by-side by Max; 36 visual baselines reseeded. Gate:
      `cb-zoomunit.js` (`zoom75_differs` must stay false). See "Zoom is
      layout-neutral".
- [x] **C1. User page breaks — FIXED 2026-08-31** (both the giant-page quirk
      and the missing reflow Max reported). Two changes:
      **(1)** the `<pb>` branch of `castoffPlan` casts off with `'line'`
      (height-derived) instead of `'encoded'` (breaks-only), which alone took the
      sonata with one Ctrl+B from **2 clipped pages to correct pagination**;
      **(2)** `castoffSegmentedByUserBreaks` computes pagination per inter-break
      SEGMENT, because no Verovio mode does both jobs — `'line'` paginates by
      height but treats `<pb>` as a SYSTEM break, `'encoded'` honors `<pb>` as a
      page break but never paginates by height. Previously we took `'line'`'s
      page starts (computed as if the break did not exist) and painted
      `'encoded'`, which honored the `<pb>` ON TOP of those unchanged pins —
      inserting a boundary without re-packing anything after it.
      The load-bearing detail: **a page break must SPLIT its line**, so the break
      measures are merged into the line partition before segmenting (smartSb0
      ignores `<pb>`, so they are mid-line in the base castoff). Without that
      merge the segment document begins at a measure the partition calls
      mid-line, Verovio necessarily starts a line there, and the partition check
      refuses — which is how the omission was caught. This merge is also what
      makes a mid-system break reflow its measures.
      Measured (sonata, `cb-pbcases.js`), both reported cases:

      | | mid-system break | break before a page's last line |
      |---|---|---|
      | break splits its line | ✓ | ✓ (already a line start) |
      | break starts a page | ✓ (was ✗) | ✓ (was ✗) |
      | page list == DOM | ✓ 31/31 (was 30/31) | ✓ 30/30 |
      | single-system page | none (was 1) | **none (was 1)** |
      | `verifyRenderedPartition` | ✓ (was ✗) | ✓ |
      | removing the break restores | ✓ | ✓ |

      Verovio stays the page-fit engine — we only choose where to cut — so no
      height model was needed. A one-line segment short-circuits without a
      layout pass (it cannot overflow a page, and handing `'line'` data with no
      encoded break makes Verovio warn). Fixture: `pageUserBreakReflows`.
- [ ] **C2. First-page credits** — composer/footer changes derive via
      `headSig`. Fine (rare), noted for completeness.

### D. Tuning and future features (Max's call)

- [ ] **D1. Vertical justification within a page** — absorb the 650–810 px of
      bottom slack Verovio leaves. Max wants this eventually; orthogonal to
      the splice, shares the page-fit model with C1.
- [ ] **D2. FIT_MAX / MIN_FILL to taste** — currently 1.45 / 0.65, set to
      contain Verovio's own castoff envelope (0.706–1.426) so an adopted
      partition is legal by construction. These are LEGALITY bounds, not
      packing targets: narrower = more eager reflow. (The old note about them
      driving the splice hit-rate is obsolete — first edits splice now.)
- [ ] **D3. Explicit "reflow document" command** — respace the whole document
      as if freshly engraved, since reflow is deliberately path-dependent now.
- [ ] **D4. Explicit move-measure-between-systems commands** — manual override
      of the automatic legality-driven mover.

## Status log

- 2026-08-31 — **B3 implemented, and the design doc's framing of it corrected.**
  The doc described a boundary MOVING beside a clef/key change; every measured
  refusal had `refillLines: 0`, so that case does not occur. The real mechanism
  is that an end-of-line courtesy signature is generated by the FOLLOWING line,
  which the window did not contain — the window now extends while the line just
  beyond begins a signature change (bounded at two). Diverged refusals 11 → 4,
  sweep hit rate **82.6 % → 88.7 %**, battery back to **7/8** with
  `insert-rest-ripple` recovered. Fixture `pageSystemSpliceCourtesySig`; probe
  `cb-courtesy.js` did the correlation first (9 of 11 explained).
- 2026-08-31 — **Page virtualization gets an EVICTION policy.** B5's mounts were
  measured at ~138 ms (not the ~50 ms estimated) and were the whole difference
  between a 377 ms and a 239 ms splice. Root cause of the drift-upward: nothing
  ever un-mounted, so `mounted` was monotonic between full renders and converged
  on every page visited (2 → 9 on the sweep, 30 in the battery) — and every
  `getBBox` flushes layout over all of them (A6). The mounted set is now a
  WINDOW: mount within one viewport plus the cursor's page ±1, evict beyond two
  viewports (the gap is hysteresis), scheduled on idle from every cursor update.
  Pages mounted at edit **9 → 3 max**, splices mounting mid-edit **19 → 0**,
  splice median/p95/max **266/494/534 → 236/340/381 ms**, hit rate unchanged at
  82.6 %. Safe only because the placeholder now matches the mounted box exactly;
  verification harnesses opt out via `setMountWindowEnabled(false)`.
- 2026-08-31 — **B5 implemented** (ensure-mount before the mounted gate). With
  realistic lazy mounting only 2–6 of 30 pages are live, so a context line —
  usually the one below, at a page boundary — was frequently a placeholder and
  refused outright. The splice now mounts it from the loaded pre-edit layout,
  guarded on `tkCurrent` and non-staleness. Sweep hit rate **66.1 % → 82.6 %**,
  mount refusals 19 → 0, 95/107 real edits splice; splice median 245 → 266 ms
  (the mount, paid on edits that previously cost ~1.2 s). Suite 344/344,
  battery unchanged 6/8 all reference-clean. B3 (courtesy signatures) is now
  the largest remaining class at 10 of 20.
- 2026-08-31 — **Coverage measured by SWEEP, and two defects it exposed.** Max
  reported that many systems refuse any splice and that every deletion nudged
  the view down a few px; neither was observable — the battery pre-mounts all
  pages (hiding B5 and reporting worst-case latency) and its reference compare
  is page-INTERNAL (a page box changing leaves every delta 0.0). `cb-sweep.js`
  walks all 116 lines through the real IntersectionObserver and records
  viewport/page-box state: baseline hit rate **56.5 %**.
  **(1) Placeholders were sized from the inner SVG (2794) before
  `finishPageMount`, while a mounted page is the div (2796) after** — every page
  grew 2 px on mount, so every full render shifted the document. Fixed;
  per-page error 0, `scrollHeightChanged` 24 → 0, next-page anchor drift 7/39
  (all exactly −2.0 px) → 0/20.
  **(2) Spanner expansion iterated to a fixed point**, making the window a
  transitive closure over a chain of ordinary 2-measure slurs (one seed walked
  17 slurs / 24 measures / 6 lines, `cb-spanchain.js`). Replaced by Max's rule —
  a spanner with one end inside the replaced set needs the window to cover its
  other end — as two single passes (`expandForSpannersOnce`). Window max
  14 → 6 lines, `window too many lines` 12 → 0, hit rate **56.5 % → 66.1 %**,
  splice max 526 → 389 ms. B5 is now the dominant refusal (19 of 39).
- 2026-08-31 — **B4 (section-header reserve) implemented**, fixing a defect B1
  introduced and the gates hid: `injectSectionHeaders` displaces systems at page
  MOUNT and places the title at an ABSOLUTE y, so the cascade stranded titles
  AND mis-computed `dyFollow` by the whole reserve (1536.9 vs 2436.9).
  Reproduced by `cb-header-overlap.js`, fixed by reasoning in Verovio
  coordinates (the injector now records `data-reserve`, the splicer reads it
  back) and moving titles with their systems. Both reference gates stopped
  exempting header pages — the sonata's three are verified for the first time.
  Fixture `pageSectionHeaderCascade` (fails pre-fix with the reported symptom);
  suite 343/343; battery 7/8 spliced, all reference-clean.
- 2026-08-31 — **Phase C-B2b / B1 implemented** (the dy-cascade; see
  "Implementation (Phase C-B2b / B1)"). The spike (`cb-dycascade.js`) compared
  the plan against what the ensuing full render actually did and refuted the
  v1 page-first anchor model — 85 units on the sonata, root-caused by `<text>`
  overflow Verovio does not count (`cb-topmost.js` / `cb-anchor.js`) and by the
  window suppressing the running-header band. Fixed by pinning the window's
  pages to the live page starts and matching the live options (error
  425 → 8 units), then applying the plan all-or-nothing. Battery 7/8 spliced,
  all reference-clean including a NEW absolute-staff-top check; suite 342/342
  with three new/changed fixtures; overflow safety net verified end-to-end
  (`cb-cascade-overflow.js`).
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
- 2026-08-30 — **Phase C-B v1 implemented** (`render/pagesplice.ts` + Renderer
  wiring; see "Implementation (Phase C-B v1)" above). Probes `cb-structure` /
  `cb-window` settled the mechanism (endings ride inside `g.system`;
  content-driven stacking, no vertical justification; pin-anchored windows
  pixel-exact with a synthetic leader); the sonata battery found the two
  fidelity killers — the window's END-OF-SCORE final barline (fixed by the
  synthetic TRAILER line) and the section-boundary window divergence (gated
  by the context-line sanity check). "Measure, don't emulate" became the
  vertical gate: the window's own spacing chain is compared against the live
  DOM and the splice lands only when nothing else would move. Battery:
  reference parity ≤ 5 units across all pages on every edit; splices
  398–628 ms wall vs 1.6–3.1 s full. New guards shipped along the way:
  interiorSig (mid-piece scoreDef edits are invisible to measure sigs) and
  credits-in-headSig; no-op renders now skip DOM work entirely.
- 2026-08-30 — **Reflow made conservative** (Max: "preventing no-op edits from
  ever being able to reflow from the original render should be top priority…
  delete one note, the system gains a measure, undo and the gained measure is
  still there"). `refillLines`/`rebalance` replaced by `repartition`: carry the
  partition by membership, repair only illegal lines, one measure per step;
  FIT_MAX 1.2→1.45 and MIN_FILL 0.7→0.65 so an adopted partition is legal by
  construction. Reflow is now path-dependent by design and the bounds are the
  tuning surface (see "Reflow semantics (current)"). Sonata via real
  keystrokes: 4/4 edits and undos held the partition, 0 moved lines, undo
  geometry bit-exact 3/4 (3 units in the 4th). Also fixed: lazily-mounted
  pages drew pre-edit content after a splice (`pageVirt.stale`). Caps raised
  (MAX_SPLICE_LINES 3→5) after a spanner-closed one-note edit was
  full-rendering at 2.4 s. Suite 337/339 — the two failures are visual
  baselines that legitimately changed (the layout no longer re-breaks), left
  for Max to accept.
- 2026-08-30 — **Pagination ownership (Phase C-B2a) implemented.** Page starts
  adopted from the same walk as the line partition, pinned as `<pb>`, rendered
  `breaks:'encoded'`. Gating probe: encoded reproduces the pagination and the
  per-page system split EXACTLY and loads 2× faster (577 ms vs 1191 ms), but
  is not pixel-identical to `line`. Max compared both renders of sonata page 3
  as images, saw no difference, and approved on the condition that the new
  system be self-consistent — verified: live DOM vs a fresh full render of the
  same pinned MEI, 446 measures, 0 sequence mismatches, max delta 4 units.
  Owning pages means owning overflow, so `overflowingPage()` hands pagination
  back to Verovio on a spill. Battery: 6/8 edits splice at 407–544 ms, all
  reference-clean; remaining full renders fell to ~1.1 s. Suite 339/339.
- 2026-08-30 — **Splice-latency profile + two self-inflicted fixes.** A
  steady-state splice is 313 ms of which **Verovio is 58 ms**; the rest is
  whole-document bookkeeping. Fixed: the splice invalidated the LIVE toolkit
  although it renders through `spliceTk` (forcing a ~590 ms reload on the next
  lazy mount — staleness is now per-page), and every page edit was deferred
  behind the busy badge because the heaviness predictor keyed off the last
  FULL render (it now predicts light after a splice).
- 2026-08-30 — **One break algorithm everywhere.** Max rejected the first edit
  after a derive full-rendering ("first-interaction friction equal to the
  difference between full render latency and splice latency"), challenged the
  premise that the modes differ at all, and asked why we don't force one
  algorithm. Measured: on byte-identical data `line` vs `encoded` moves 409 of
  446 measures (median 2.6 px, max 52 px) while the `<pb>` elements themselves
  change nothing — the ALGORITHM is the whole cause, and it is not a
  section-break artifact (85 of 118 "plain" lines drift too). Also corrected:
  `breaks:'line'` DOES honor `<pb>`; the C-A note was wrong. Fix: the castoff
  pass is now an internal bootstrap (loadData only, never painted), the
  partition is read via page-based `getMEI({scoreBased:false})` in **98 ms vs
  a 1830 ms SVG walk** (byte-identical), and the pinned `encoded` render is
  what gets painted. First edit after a derive: ~1.2 s → **333 ms splice**;
  idle adoption walk gone; first paint 1.2 s → ~2.0 s (accepted by Max as the
  one place extra time is acceptable, verified once-per-derive). Four
  page-mode baselines reseeded with his approval after reviewing the
  `phase3_section_header` case (whole note 1368 → 2935 from the measure left;
  document-final system 18790 → 2553 — encoded declines to stretch a final
  system, which is conventional engraving). Suite 339/339.
- 2026-08-30 — **Phase D scoped** (Max, rejecting a list of 15 ms shavings:
  "every steady-state step recommended gives 15 ms each… that does not explain
  why actions that are essentially instant on a one-page score are still
  unusably laggy on an arbitrarily large score"). Diagnosis: rendering is
  incremental; the pipeline around it is still whole-document — 495 measure
  serializations, 26 full-document measure scans, ~32 000 querySelectorAll
  calls and two whole-document cursor rebuilds per keystroke, ~130 ms of the
  300 that has nothing to do with the edit. Plan and costings in "Phase D";
  landing zone ~130 ms and FLAT in document size. Next: three-way baseline
  (empty / one-page / sonata) to confirm which buckets scale and what, if
  anything, still separates 1 page from 37 once the edit path is O(edit).
- 2026-08-30 — **Phase D implemented (passes 1–3) + A2 landed.** A2 first:
  `layoutBreaks` now reads the partition from page-based `getMEI` through the
  shared `partitionFromLayout(tk)` helper (the SVG walk stays as its fallback),
  so a user-`<pb>` derive no longer pays ~1.8 s. Then the edit path: pass 1
  made the whole-document primitives cheaper with no semantic change
  (`layerInMeasure` scans direct children instead of walking each measure's
  whole subtree; `flatChildren` carries the previous measure's layer state
  instead of re-deriving it three ways; `expandForSpanners` /
  `expandForEndings` build their index ONCE instead of inside their growth
  loops; `normalizePlaceholders` snapshots `layer.children` once) —
  **308 → 243 ms**, `querySelectorAll` 31 969 → 3 428 calls. Passes 2–3 added
  the two caches the plan called for, but the discipline-based invalidation the
  plan assumed was proven UNSOUND by the `HKL_INDEX_CHECK` gate on the first
  try (`insertWithSplit` reads `flatChildren` mid-mutation, exactly as the doc
  warned); the working mechanism is a **`MutationObserver` whose synchronous
  `takeRecords()` makes invalidation exact**, used for the model's
  `flatChildren` + `allMeasures` caches and for `PageLineBreaks`' incremental
  signature baseline. **243 → 206 ms**, `cursor.update` 62.6 → 1.8 ms,
  `XMLSerializer` 495 → 54 calls (the diff is now O(edit)). Verovio is 59 ms of
  what remains. Suite 339/339 under `HKL_INDEX_CHECK` (the verifications are
  permanent, so the suite is a standing gate on the mechanism); typecheck /
  build / boundaries clean.
- 2026-08-31 — **C1 FIXED in full: user page breaks split their line and
  cascade.** Landed in two steps. First the `<pb>` branch of `castoffPlan` moved
  from `'encoded'` (breaks-only) to `'line'` (height-derived), which took the
  sonata with one Ctrl+B from **2 clipped giant pages** to correct pagination.
  That half left the defect Max then described precisely — "it doesn't do a
  cascade reflow at all… a page break before the last line of a page creates a
  new page with just that line; a page break in the middle of a system also does
  not try to reflow measures" — and the measurements agreed (page list one short
  of the DOM, a 1-system page, `verifyRenderedPartition` false).
  Root cause: **no Verovio mode paginates by height AND honors `<pb>`** —
  `'line'` treats `<pb>` as a SYSTEM break (a document with one break returns the
  same page count as with none), `'encoded'` honors it as a page break but never
  paginates by height. We were taking `'line'`'s page starts, computed as if the
  break did not exist, and painting `'encoded'`, which layered the break on top
  of those unchanged pins: a boundary inserted with nothing after it re-packed.
  Fix: `castoffSegmentedByUserBreaks` paginates each inter-break SEGMENT
  independently (Verovio stays the page-fit engine; we only choose where to cut,
  so no height model was needed) — plus the step that makes it coherent, merging
  the break measures into the LINE partition first, since a page begins with a
  new system but smartSb0 ignores `<pb>` and leaves them mid-line. Omitting that
  merge was caught by the partition-equality check rather than shipped: the
  segment begins at a measure the partition calls mid-line, so Verovio starts a
  line there and the check refused. That same merge is what makes a MID-SYSTEM
  break reflow its measures. Both reported cases now measure clean
  (`cb-pbcases.js`): break splits its line, starts a page, page list == DOM,
  **no single-system page**, verify true, exact restore on removal. Suite
  **340/340** with the new `pageUserBreakReflows` fixture; boundaries + build
  clean. Also corrected en route: "breaks:'line' honors `<pb>`" holds for a
  fully PINNED document, not for sparse user breaks (lessons.md).
- 2026-08-31 — **Zoom made layout-neutral: crisp presets moved to a CONSTANT
  unit 8.** Keying the partition cache exposed that zoom re-broke the score —
  the presets used `unit: 9` at 50/100 but `unit: 10` at 75, and `scalePageGeom`
  scales the page by `pageScale` only, so zoom 75 rendered ~11 % larger music
  against the same paper: sonata 118 lines / 37 pages → **134 / 45**, eight extra
  pages from a zoom. Max: "that is a catastrophic result… zoom should be a no-op
  in terms of line count and distribution." Two dead ends before the answer:
  compensating the paper by `unit / 9` (matched `contentWidth / unit` to five
  digits and still gave 113 lines where 118 was wanted — Verovio's spacing has
  terms that do not scale with `unit`), and `unit: 9` at a fractional
  `scale: 77.78` (refuted by the presets' own derivation, which Max sent me to
  find rather than re-derive: it breaks the whole-device-px stroke rule and
  re-opens the root-`<svg>` ceil drift). The general rule is `gcd(unit, 50)` —
  scales must be multiples of `50/gcd`; unit 9 (gcd 1) allows only 50/100/150,
  **unit 8 (gcd 2) allows multiples of 25**, so 50/75/100 are all crisp at one
  unit (staff-space 8/12/16 px, strokes 1.0/0.975/2.0 px). Every zoom now
  produces an identical partition (116 lines / 30 pages) and **every zoom change
  is a partition-cache hit** (~750 ms, was up to 2134 ms). Accepted cost after a
  six-image side-by-side: ~11 % smaller notation at every level (100 %
  staff-space 18 → 16 px); 36 baselines reseeded. Also found: `unit: 9` was
  never chosen — it is Verovio's default, inherited, and `unit: 10` was a patch
  in a grab-bag commit to rescue an already-existing 75 % step, while
  decisions.md asserted the defect away ("zoom is pure magnification and does
  not change music-per-page" — true again as of this entry).
- 2026-08-31 — **Phase D pass 4 + A4 (partition cache), and a test bug fixed.**
  Max: "why did you stop? There's still a long way to go and I see more
  outstanding items than we started with" — fair; the previous session serialized
  on waiting for long test runs and split coarse plan items into finer ones
  without then doing them. This pass closed A4, A7 and A9 and the measure-list
  half of A3: sonata steady-state splice **206 → 168 ms**, with
  `normalizePlaceholdersAll` 17.1 → **0.9 ms**, `allMeasures` 5.5 → **0.5 ms**,
  `querySelectorAll` 3 428 → 2 537 calls, and a zoom RETURN skipping the castoff
  (2233 → 848 ms). A7 needed a second attempt: the naive escalation rule ("any
  mutation outside a `<layer>` re-checks every layer") fired on essentially every
  edit because MEI control events live at measure level and tie/slur pruning +
  `setBarlines` touch them constantly — the exemption list plus the
  scoped-equals-full gate is what made it worth 16 ms instead of 1.6.
  Also **two battery edits had not been applying for months**: the probe
  recorded `editOk` without asserting it, and both sequences asked for overflow
  into a completely full next measure, which the documented planner rule
  correctly rejects (Max: "it's been settled for months and very well
  documented… the insertion tests should work properly with it" — my "design
  question" framing was wrong). Durations corrected to fit the freed space and
  `allEditsApplied` is now asserted; no model change. And a near-miss avoided:
  zoom 50 and 100 produce identical partitions, but **zoom 75 gives 134 lines
  vs 118**, so zoom stays in the cache key. Suite 339/339 under
  `HKL_INDEX_CHECK`; battery 8/8 applied, 7/8 spliced, all reference-clean at
  4 units; typecheck/build/boundaries clean.
- 2026-08-30 — **Scaling baseline measured** (`cb-scale.js`, answering Max's
  "if we can truly get O(edit), what's the remaining difference between a
  single page and 37?"): one-page splice **66 ms**, sonata splice **303 ms**.
  The 237 ms gap is ~150 ms pure O(document) tax (cursor rebuilds, model
  mutation, 21× the querySelectorAll calls, 24× the serializations), ~25–40 ms
  layout-flush cost proportional to MOUNTED DOM (getBBox call count +24 % but
  its time +260 %, because each flush lays out 4× the elements), and ~25 ms of
  musical density in the window (not size). **Verovio's `loadData` is flat
  (22 → 17 ms)** — the engraver does not scale with document length; our
  bookkeeping does. Projects to ~150 ms after Phase D, ~120 ms with the
  bounded-delta guard.
