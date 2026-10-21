# Spec: one partition function for load and edit

**Status (2026-10-20)**: design DECIDED by Max; Phase 0 (measurement) DONE;
**Phases 1–3 IMPLEMENTED** — F is `apps/composer/src/render/balance.ts`
`partitionSection` (+ `sectionAtoms`), run by `linebreaks.ts` on load
(`balanceInitialBand`) and edit (`repartition`); the repair loop,
`balanceTouched` and MIN_FILL / FIT_MAX are gone. Pagination of a re-flowed
unmounted tail: decisions.md "Partition F lands". Phase 3's Firefox
measurement is DONE (headless Firefox, `run-probe.mjs --firefox`, sonata,
median of 3): a note delete 102–162 ms and its undo 182–265 ms (F ≤ 1 ms); a
bar inserted at m. 3 re-flows movement I's tail (38 boundaries) in 397 ms,
leaving 7 unmounted pages deferred, each engraved on mount in ~480 ms; a bar
at m. 241 445 ms. Phase 4 (retiring the line-break commands' `LayoutSnapshot`
restore) is open. The simulation twin stays as the
reference: `test/balance/partition-f.mjs` + `curve-batch.mjs`.
Supersedes this spec's two 2026-10-19 revisions (page-causal; greedy + one
target T). Decisions: decisions.md "Partition: whole-section greedy lines with
deficit windows" (superseded) and "Partition: the reach-back curve" (current).

## The defect

On load each section is balanced whole (`balanceInitialBand`); on an edit,
`balanceTouched` balances only from the edit's page to the section end. The two
disagree whenever the suffix alone wants a different line count or
arrangement. Sonata movement III: a one-note delete at m. 250 re-divides
mm. 240–325 from 9 lines into 10; undo restores the document but not the
layout (the suffix balance is a fixed point); a reload brings it back. Measured
directly: a NO-OP edit on the pages starting at m. 180 and m. 240 moves 15 and
19 boundaries.

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
  when it stayed greedy (Phase 2).

Retired: "no reach backwards" (2026-10-08) and any single target fill T (Max:
0.70 is MIN_FILL by another name; acceptability is relative to the
alternatives).

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
   (`best[c][x]`) yields every point. k = 1 is greedy; k = N is the full
   balance.
3. **Score each distinct layout** on the lines it changes (a line changes when
   its start OR end moved — the donor above a reworked tail counts) plus the
   untouched line just before them: `min` = the lowest fill among the changed
   lines, `sd` = the spread over neighbour + changed (the neighbour is what
   makes a stub look sparse), `chg` = line starts that differ from greedy.
4. **Pick** max(`min` − `sd` − γ·`chg`), **γ = 0.03**, ties to fewer changes.
   A flat cost per change is intended: a user forces another layout with
   locks. (On the sonata γ 0.03 reproduces Max's own picks — I: 1 change,
   II: 0, III: 3, IV: 1.)

**Accepted consequences** (Max, 2026-10-20): a section just over one line long
becomes two lines around 0.5–0.6 rather than one compressed line (today
compresses to 1.03–1.09); a long uniform section can keep a sparse-ish last
line when the next improvement needs many moves at once (a 203-bar corpus
section: 1 change → 0.57, 9 → 0.85, nothing between) — locks are the remedy.
Body lines outside the chosen window keep greedy breaks (sonata movement II's
0.681 line, bars 52–53, which only the full balance lifts — Max reviewed the
screenshots).

**Edit path**: an edit recomputes F over every touched section in full (cheap:
the curve DP is O(atoms × band × N); ≤ 0.3 ms per sonata movement), diffs the
line starts by measure id, splices the changed lines and re-paginates from the
first changed page until a page's start, end and content signature match. There
is no separate edit algorithm to keep equivalent.

## Phase 0 results (done)

Tooling: `test/composer-inspect/sonata-probes/partition-inputs.js` (dump F's
inputs from the live page), `test/corpus/batch-import.mjs` (import many MusicXML files in
one Chromium and dump each), `test/balance/curve-batch.mjs` (per-document
curves), `test/corpus/corpus-report.mjs` (aggregate), the corpus pipeline in
`test/corpus/README.md`. The simulation reproduces today's committed
sonata partition exactly (4/4 movements), so the inputs are right.

**Sonata** (distinct layouts; changes → min / spread): I 0 → .600/.145,
1 → .672/.089, 8 → .762/.043, full 27 → .746/.049; II needs nothing; III 0 →
.331/.317, 3 → .693/.082, 10 → .806/.053, full 20 → .794/.068; IV 1 →
.691/.051 (= full).

**MuseScore corpus sample** (450 files: 300 random, 150 large; γ 0.03):

| | random (275 sections) | large (189) |
|---|---|---|
| greedy last line < 0.65 | 60% | 65% |
| last ≥ 0.65 — pick / full / today | 261 / 263 / 274 | 161 / 166 / 187 |
| sections moving 5+ boundaries — pick / full | 8 / 47 | 14 / 110 |
| last-line loss vs full, p90 | 0.153 | 0.209 |
| today compresses a line (> 1.00) | 33 sections | 67 sections |

**Edit churn** (sonata, simulated, first edit after load): inserting or
deleting a bar reflows the rest of the section in every scheme (p90 ≈ 25–33
lines — inherent); the curve variants reach back ≤ 1 line on early edits where
today's page-bounded rebalance reaches 3; for ±5 % width edits every pure
variant changes nothing at p90, while today's edit path shows p90 10 lines
partly from the defect itself (the no-op reflows above).

Rejected on the way, with the data: the page-causal partition (stubs at
section ends); greedy + one target T with deficit windows (a single T is too
strict or is MIN_FILL; no-window cases on every sonata movement — uniform bars
make a window infeasible at any length; greedy's body made medium width edits
change p90 6 lines against 2); merge windows compressing past 1.00 (collisions);
anchoring the full balance to greedy or end-packed greedy breaks (anchors move
with the content; 25–40 % of inserts changed MORE lines than the full balance).

## Implementation plan (not started)

**Phase 1 — F as one module.** Port `curveTable` / `curve` / `distinctLayouts`
/ `pick` into `apps/composer/src/render/balance.ts` beside `greedyLines`,
`dpPartition`, `balanceSection`, with a per-line leading block. No DOM. Node
tests in `test/balance/run.mjs`: purity, line count = greedy count, every line
≤ 1.00 except a lone over-wide atom, the curve's far end equals the full
balance at [0, 1.00], the final-section-under-3-lines rule, atoms never split.

**Phase 2 — load.** `balanceSectionLines` (used by `balanceInitialBand` after
`warmAllNaturals`) calls F per section instead of `balanceSection`.
**Final-system justification** (Max, 2026-10-20): today MIN_FILL also sets
it (`render.ts` `buildOptions` → Verovio `minLastJustification`: the
document's last line is justified only at fill ≥ 0.65). New rule: when the
final section ran through the balancer (3+ lines), its last system is ALWAYS
justified; when it stayed greedy (a final section of 1–2 lines), the last
system is justified only at fill ≥ **0.70** — a little less eager than 0.65.

**Phase 3 — edit.** `PageLineBreaks.tryRefill` computes F over every touched
section in full, diffs, and hands the changed lines to the existing splice /
`PageAssembler.applyPartition` path. Remove the repair loop in `repartition`,
`balanceTouched` and its page bound, `BALANCE_LAMBDA`, and every use of
MIN_FILL / FIT_MAX > 1 as a partition bound. Measure `edit-cost-attribution.js`
and the splice gates in Firefox on Max's machine.

**Phase 4 — clean up.** Retire the line-break commands' `LayoutSnapshot`
restore if the gates show it redundant; update architecture/composer.md (Page
view → The partition), the `balance.ts` / `linebreaks.ts` headers, decisions.md.

## Verification

- **Universal invariant**: on every fixture the mounted partition equals F of
  the document (load ≡ edit), beside `assertPaginationFirstFit`.
- **Fixtures** (page-layout): the m. 250 case small — edit a later page, undo,
  partition and geometry back exactly; edit/undo chains back to the load
  layout; reload ≡ live; a tail stub repaired by a short reach; the
  just-over-one-line section → two lines; a final section under 3 lines stays
  greedy; a measure wider than a line sits alone.
- **Expected baseline changes**: `pag_*` / `pageBalance*` and multi-line visual
  baselines; re-seed only after heatmap review.
- **Probes**: `balance-consistency.js` (undo diffs empty), `undo-reversibility-gate.js`,
  `splice-exactness-census.js`, `load-reference-gate.js`, `pagination-fold-check.js`.
- **Corpus**: re-run `batch-import.mjs` + `corpus-report.mjs` on the sample
  and compare against the Phase 0 tables (the app's F should match the
  simulation's pick exactly).
