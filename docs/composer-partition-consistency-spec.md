# Spec: one partition function for load and edit

**Status (end of 2026-10-20)**: design DECIDED by Max; Phases 0–4 DONE and
verified (Phase 4 = clean-up); what remains is under "Open items". The
implementation is in the working tree and was NOT committed at the end of the
session (commits are Max's). Decisions: decisions.md "Partition: the reach-back
curve" (the design), "Partition F lands: one function for load and edit; only
mounted pages are engraved" (the implementation, superseded rulings,
pagination of unmounted tails) and "Partition F clean-up: line-break undo
carries no layout; the pre-F balancer removed" (Phase 4). Supersedes this
spec's two 2026-10-19 revisions (page-causal; greedy + one target T).

## Where it lives

- **F**: `apps/composer/src/render/balance.ts` — `partitionSection` (greedy,
  curve, pick, final-section rule), `sectionAtoms` (render units → atoms with a
  per-line leading block), `greedyStarts`, `curveTable`, `reachBackCurve`,
  `distinctLayouts`, `pickLayout`; constants `PARTITION_CAP` 1.00,
  `PARTITION_GAMMA` 0.03, `FINAL_GREEDY_BELOW` 3.
- **Load**: `linebreaks.ts` `balanceInitialBand` runs F over every section
  (after `seedPartition` + `warmAllNaturals`) before the first paint.
- **Edit**: `linebreaks.ts` `repartition` carries the partition by line
  membership (which sections were touched; pages kept by line), splits/joins at
  added/removed hard starts, then runs F over every touched section in full
  (`balanceSectionLines`). No repair loop, no legality envelope, no page bound.
- **Final-system justification**: `PageLineBreaks.finalSystemJustified` →
  `render.ts` `buildOptions` → Verovio `minLastJustification` 0 (justify) or 1
  (natural width); `FINAL_JUSTIFY_FILL` 0.70 for a greedy final section.
- **Read-only F of the document**: `PageLineBreaks.partitionOfDocument`
  (`partitionCurrent` says whether the committed partition is for the current
  document version).
- **Undo**: no history entry carries layout, line-break commands included —
  the refill of the restored document lands on F (G4).
- **Pagination of a re-flowed unmounted tail**: `pageassembly.ts`
  `applyPartition` / `heightOf` / `paginatedLines` (see "Edit path").
- **Simulation twin** (Phase 0, kept as the reference the port is tested
  against): `test/balance/partition-f.mjs` + `curve-batch.mjs`.

## The defect (fixed)

On load each section was balanced whole (`balanceInitialBand`); on an edit,
`balanceTouched` balanced only from the edit's page to the section end. The two
disagreed whenever the suffix alone wanted a different line count or
arrangement. Sonata movement III: a one-note delete at m. 250 re-divided
mm. 240–325 from 9 lines into 10 (19 boundaries); undo restored the document
but not the layout; a reload brought it back.

**After F** (`balance-consistency.js --arg mi=250`, Chromium and Firefox): the
edit moves 0 boundaries, the undo restores lines and pages exactly, the MEI is
byte-identical.

## Requirements

- **G1 — one function**: the partition is a pure function of the document; a
  load and an edit compute the same layout; a reload never changes the screen.
- **G2 — judged against the full balance**: quality is validated against the
  minimum-variance balance of the whole section (the curve's far end), on line
  appearance — minimum fill and spread — not on agreement of boundaries (near
  ties are real: whole movements rearrange for a spread change of 0.004).
- **G3 — minimal reach, no cap** (Max: "There cannot be a hard cap on how far a
  repair can reach"); edit cost measured, not argued.
- **G4 — exact undo**: follows from G1.
- **No compression**: no line is packed past its natural width (fill ≤ 1.00) —
  compressed lines collide. A single measure wider than a line sits alone.
- **No MIN_FILL** in the partition. The only exception: a FINAL section of
  fewer than 3 lines stays pure greedy (the small-document convenience MIN_FILL
  was for). A stub before another section or a lock is a bug. The final
  system is justified whenever its section was balanced, and at fill ≥ 0.70
  when it stayed greedy.

## F, per section

A section is the measures between hard starts (every measure after an `sb` or
`pb` — `hardStartIds`); atoms are render units (a multirest run is one atom).
A line's fill = (its own leading clef+key block — `sigWForLine` — plus Σ
naturals) / justified budget.

1. **Greedy** at ≤ 1.00: N lines, the fewest possible.
2. **The reach-back curve**: for every k = 1..N, the last k greedy lines
   re-divided into the same k lines, most evenly. "Most even" at a fixed count
   and content = minimum Σ(1 − f)², which ranks arrangements exactly as
   variance does and needs no window mean, so ONE right-to-left DP
   (`curveTable`) yields every point. k = 1 is greedy; k = N is the full
   balance.
3. **Score each distinct layout** on the lines it changes (a line changes when
   its start OR end moved — the donor above a reworked tail counts) plus the
   untouched line just before them: `min` = the lowest fill among the changed
   lines, `sd` = the spread over neighbour + changed (the neighbour is what
   makes a stub look sparse), `changes` = line starts that differ from greedy.
4. **Pick** max(`min` − `sd` − γ·`changes`), **γ = 0.03**, ties to fewer
   changes. A flat cost per change is intended: a user forces another layout
   with locks. (On the sonata γ 0.03 reproduces Max's own picks — I: 1 change,
   II: 0, III: 3, IV: 1.)

**Accepted consequences** (Max, 2026-10-20): a section just over one line long
becomes two lines around 0.5–0.6 rather than one compressed line (the old
balancer compressed it to 1.03–1.09); a long uniform section can keep a
sparse-ish last line when the next improvement needs many moves at once (a
203-bar corpus section: 1 change → 0.57, 9 → 0.85, nothing between) — locks are
the remedy. Body lines outside the chosen window keep greedy breaks (sonata
movement II's 0.681 line, bars 52–53, which only the full balance lifts — Max
reviewed the screenshots). An inserted or deleted bar re-flows the rest of its
section (inherent to any partition that is a function of the content).

**Superseded rulings**: "no reach backwards" (2026-10-08) — F's pick may reach
onto an earlier page; "unlock is pin-removed-only" (2026-09-12) — removing a
lock joins two sections, which F partitions whole (a kept layout is one a
reload could not reproduce); any single target fill T (Max: 0.70 is MIN_FILL
by another name).

## Edit path

An edit recomputes F over every touched section in full (≤ 1 ms per sonata
movement), diffs line starts by measure id, splices the changed lines on the
mounted pages and re-fits pagination (first-fit) from the first changed page.

**Unmounted pages are not engraved** (Max, 2026-10-20). A line's height exists
only once it is engraved, and heights are cached per line membership, not
composable from measures (cross-measure spanners — composing them is out of
scope). So a re-flowed line on an unmounted page counts with the height of the
line that held its first measure in the layout the pages were last fitted for
(`heightOf`; assumed heights kept apart from measured ones); a page the re-fit
rebuilds that is not mounted becomes a deferred card, engraved on mount, after
which the fit re-runs from it (a shift by a system there is accepted); a line
the fit lands on a MOUNTED page with only an assumed height is engraved before
the page shows and the fit re-runs.

## Verification (done)

- **Unit**: `test/balance/run.mjs` — F ≡ simulation on the sonata (dumped
  inputs: `test/balance/sonata-inputs.json`) and 600 random sections; the
  sonata picks I 1 / II 0 / III 3 / IV 1; purity, line count, no compression,
  far end = full balance (vs the old minimum-variance DP, inlined in the test,
  and brute force), final-section rule, atoms never split, over-wide atom
  alone.
- **Composer suite**: 651/651 at the end of the session. Universal invariant
  "partition is F" (`assertPartitionIsF`: committed starts = F of the document;
  mounted systems agree). New fixtures (page-layout): `partF_laterPageEditUndo`,
  `partF_editUndoChain`, `partF_reloadEqualsLive`, `partF_tailStubShortReach`,
  `partF_wideMeasureAlone`, `partF_clefInitialReload`,
  `partF_deferredTailMountsExact`. Fixtures that asserted the old balancer
  (`pageBalance*`, `lock_*`, `pag_meterChangeSplices`,
  `pageKeyChangeSplicesGovernedRange`, `pageRenumberIsRedrawOnly`,
  `engr_slurLiftedOffShiftedNumeral`) were restated as F's rules. Visual
  baselines `lock_down_splits` and `page_balance_section_final` re-seeded with
  Max's approval after heatmap review.
- **Sonata gates**, Chromium and headless Firefox (`run-probe.mjs --firefox
  --window 2600x1400`): `load-reference-gate` 32/32; `undo-reversibility-gate`
  4/4 exact; `balance-consistency` m. 250 exact; `pagination-fold-check` clean
  in Chromium (Firefox: see findings). `splice-exactness-census` now uses the
  gate's own reference (`PageSystemSplicer.referenceTops`): Chromium 322/344
  pairs exact, 11 one device pixel (the `renderToSVG` header residual), 11 over
  a pixel — all on untouched neighbour pages (p. 12 for edits on lines 49–52,
  p. 18 for 70–72, p. 20 for 76–79), where Verovio's whole-document engrave
  disagrees with Composer's line windows; spliced ≡ fresh assembly was checked
  directly at lines 49, 70, 76 and 79. These gates ran after the reload ≡ live
  clef fix and before the barline-clef storage change (decisions.md "Barline
  clefs are stored where they are drawn"), which touches clef writes only.
- **Corpus** (450-file MuseScore sample, `test/corpus/README.md`): all 445
  owned documents (511 sections) partition exactly as the simulation's pick;
  0 console errors; Verovio "highly compressed" warnings 29 → 24.
- **Phase 3 cost, Firefox** (sonata, median of 3, `run-probe.mjs --firefox`):
  a note delete 102–162 ms, its undo 182–265 ms (F ≤ 1 ms); a bar inserted at
  m. 3 re-flows movement I's tail (38 boundaries) in 397 ms, leaving 7
  unmounted pages deferred, each engraved on mount in ~480 ms; a bar at m. 241
  445 ms. (`edit-cost-attribution.js --arg mi=250`'s two steady-state edits
  came back `noop` — its Backspace there changes nothing — so the numbers come
  from a dedicated probe.)
- **Phase 4 clean-up**: with the line-break commands' `LayoutSnapshot` restore
  disabled, `sonata-probes/line-lock-undo-gate.js` (five sites; lock and
  unlock with undo/redo chains, 45 steps) landed every step exactly on the
  expected line and page starts, F of the document, in Chromium and headless
  Firefox — so the restore was removed, and the gate passes the same on the
  code without it (`line-lock-commands.js` too: undo and redo identical, no
  derive). Cost: an undo/redo that re-adds a lock now costs the lock command
  itself (Firefox, up to 1.0–1.2 s against ≤ 0.65 s; median of all undo/redo
  steps 519 → 555 ms). `test/balance/run.mjs` 29/29 after the old balancer
  and its cases went (F output identical to before, line for line); suite
  651/651; `pnpm typecheck`, `check:boundaries`, Composer build clean.

## Open items

1. **Leading-block width depends on the measure number it was measured under**
   (Max to decide). `measureLeadingSigW` measures from the first measure's bbox
   x, which includes the measure number hanging left of the staff; the same
   clef+key context measured under bar "11" and bar "12" differs by ~10 units
   (688.70 vs 678.08), and the cache keeps whichever was measured first, so a
   near-tie could still make a reload differ from the live layout. Measuring
   from the staff line's start removes it but moves every leading block by the
   overhang (line breaks shift everywhere; visual baselines would need review).
   Not done without Max.
2. **Firefox-only sub-pixel findings** (pre-existing, not F; lessons.md
   2026-10-20): a spliced system's crisp right edge follows the page's
   fractional horizontal scroll (a window narrower than the page; ≤ 0.35 device
   px; exact in a wide window); `renderer.placeFor`'s first-content top differs
   from the assembler's fit by a few units, so the fold check reads p. 8 at 21
   units over a 20-unit tolerance the fit itself placed at 17.75.
3. **Measure-start clef paths**: the MusicXML importer's boundary clefs and a
   delete that leaves a mid-measure clef at a measure's start still store a
   head clef (drawn and saved before the barline by `relocateInitialClefs`).
   Max, 2026-10-20: do not touch these. The width model handles them (a
   layer-initial clef keys its leading block from its own measure; an edit
   re-measures one measure to the left — `partF_clefInitialReload`).

## Phase 0 results (the design measurements)

Tooling: `test/composer-inspect/sonata-probes/partition-inputs.js` (dump F's
inputs from the live page), `test/corpus/batch-import.mjs` (import many
MusicXML files in one Chromium and dump each), `test/balance/curve-batch.mjs`
(per-document curves), `test/corpus/corpus-report.mjs` (aggregate), the corpus
pipeline in `test/corpus/README.md`. The simulation reproduced the old
balancer's committed sonata partition exactly (4/4 movements), so the inputs
were right.

**Sonata** (distinct layouts; changes → min / spread): I 0 → .600/.145,
1 → .672/.089, 8 → .762/.043, full 27 → .746/.049; II needs nothing; III 0 →
.331/.317, 3 → .693/.082, 10 → .806/.053, full 20 → .794/.068; IV 1 →
.691/.051 (= full).

**MuseScore corpus sample** (450 files: 300 random, 150 large; γ 0.03; "old" =
the pre-F balancer):

| | random (275 sections) | large (189) |
|---|---|---|
| greedy last line < 0.65 | 60% | 65% |
| last ≥ 0.65 — pick / full / old | 261 / 263 / 274 | 161 / 166 / 187 |
| sections moving 5+ boundaries — pick / full | 8 / 47 | 14 / 110 |
| last-line loss vs full, p90 | 0.153 | 0.209 |
| old balancer compresses a line (> 1.00) | 33 sections | 67 sections |

**Edit churn** (sonata, simulated, first edit after load): inserting or
deleting a bar reflows the rest of the section in every scheme (p90 ≈ 25–33
lines — inherent); the curve variants reach back ≤ 1 line on early edits where
the old page-bounded rebalance reached 3; for ±5 % width edits every pure
variant changes nothing at p90, while the old edit path showed p90 10 lines
partly from the defect itself.

Rejected on the way, with the data: the page-causal partition (stubs at
section ends); greedy + one target T with deficit windows (a single T is too
strict or is MIN_FILL; no-window cases on every sonata movement — uniform bars
make a window infeasible at any length; greedy's body made medium width edits
change p90 6 lines against 2); merge windows compressing past 1.00 (collisions);
anchoring the full balance to greedy or end-packed greedy breaks (anchors move
with the content; 25–40 % of inserts changed MORE lines than the full balance).
