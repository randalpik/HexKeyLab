# Spec: one partition function for load and edit

**Status**: rewritten 2026-10-19 after Max's review; replaces the page-causal
proposal of the same day. Decision points for Max are marked **[D1]**–**[D3]**.
Background: decisions.md "Open: the bounded section balance means undo need not
restore a reflowed layout", its addendum, and "Partition: whole-section greedy
lines with deficit windows" (2026-10-19); architecture:
[architecture/composer.md](architecture/composer.md) → Page view.

## The defect

Page view computes the line partition two different ways:

- **On load** every section is balanced whole (`balanceInitialBand`,
  `render/linebreaks.ts`): the line count is the fewest lines at fill ≤ 1.0,
  the arrangement the minimum-variance one (`balanceSection`,
  `render/balance.ts`).
- **On an edit** a one-measure repair loop runs, then `balanceTouched` balances
  only from the first line of the edit's page to the section's end — the bound
  added on 2026-10-08 so that "an edit never reaches a page before it".

The two disagree whenever a section's suffix, balanced alone, wants a different
line count or arrangement than the whole-section answer gives it.

**Evidence** (sonata, `test/composer-inspect/sonata-probes/balance-consistency.js
--arg "mi=250"`): movement III is mm. 226–325. A one-note delete at m. 250 (on
the page starting at m. 240) re-divides mm. 240–325 from 9 lines into 10, and
every later page start shifts. The first edit of any kind on that page does it.
Undo restores the document byte-for-byte, but the restored content is a fixed
point of the suffix balance, so the load's answer is never recomputed; a reload
brings it back. In a whole-score sweep these flips accumulate (one later edit
cascaded through 10 pages and created a page).

## Requirements

- **G1 — one function** (Max, 2026-09-17/18): the partition and pagination are a
  pure function of the document. A load and an edit compute the same layout for
  the same content; a reload never changes what is on screen.
- **G2 — whole-section quality** (Max, 2026-10-19): a section balances as a
  whole. Every line reaches the target fill wherever the content allows it; a
  stub — at a section's end or anywhere else — is unacceptable.
- **G3 — minimal reach, measured** (Max, 2026-10-19): an edit changes only the
  lines the content ties to it, and F is designed to reach back as little as
  possible. There is **no cap** on how far a repair reaches (Max: "There cannot
  be a hard cap on how far a repair can reach. That reintroduces the exact
  discrepancy that we're trying to remove."). Edit cost is measured precisely,
  not argued (Phase 0, Phase 3).
- **G4 — exact undo** (Max, 2026-10-19): undo and redo restore the exact
  previous layout, for any sequence of steps. Follows from G1.

**Retired: "no reach backwards"** (2026-10-08, "an edit never moves a page
before the edit's page"). G1 and that rule together force a page-causal
partition — F's pages before page p must not depend on content at or after p,
for every p — and a page-causal partition cannot borrow across a page break, so
it leaves stubs at section ends and balances per page, not per section. Max
ruled it out (2026-10-19). An edit near a section's end may now move lines on
earlier pages, exactly as far as the content requires.

## F: greedy lines, then deficit windows

F runs per **segment**: the measures between hard starts (every measure after
an `sb` or `pb` — `hardStartIds`; line locks, page breaks and section breaks).
Measures never cross a hard start. Atoms are render units (`model/multirest.ts`
— a multirest run is one atom, so no break falls inside it). A line's fill is
(its leading clef+key block + Σ naturals) / justified budget, with each line's
**own** leading block (`sigWForLine`) — this removes `balanceSectionLines`'
one-block-per-section approximation. Constants: `S` = `BALANCE_SOFT_MAX` 1.00,
`MIN_FILL` 0.65, `FIT_MAX` 1.45, `T` the target fill **[D1]**.

1. **Greedy.** Pack atoms left to right, each line taking as many as fit at
   fill ≤ S. An atom wider than S takes a line alone. This is `greedyLines`,
   which already decides today's line COUNT; F also keeps its BREAKS. Result: N
   lines, the fewest possible at ≤ S (the same count as today's load).
2. **Deficit windows, right to left.** Visit the lines from the last to the
   first. A line i with fill < T is a **deficit**. Its **window** is the
   smallest run of lines [j..i] whose measures can be re-divided into the same
   number of lines with every fill in [T, S]: try j = i−1, i−2, … down to the
   segment's first line, with no cap. The window's outer edges (the start of
   line j, the end of line i) stay where they are and it keeps its line count;
   inside, it takes the minimum-variance arrangement within [T, S] (`dpPartition`
   with `minFill` T and `fitMax` S) **[D2]**. Line j−1 — the first line that
   does not need adjustment — is untouched, and the visit continues there.
3. **No window.** When no window down to the segment's first line is feasible:
   a deficit with fill ≥ MIN_FILL stays as greedy made it (a light but legal
   line — e.g. one holding a wide bar whose neighbours are too wide to join
   it); one below MIN_FILL is illegal, and the run from the segment's first line
   to line i takes `balanceSection`'s answer at the legality bounds (today's
   ladder: N, N+1, N−1 lines). This is the only path that changes the line
   count **[D3]**.

This is the hand method applied line by line: fix the number of lines, then
reach back exactly far enough to gather the measures that make every system
look full. Step 2 covers the mid-section dips greedy leaves wherever the next
bar is too wide to join a line, not only a section's last line.

**Properties.** F is a pure function of (naturals, leading blocks, hard starts,
units, budget, T): load and edit call the same code, which gives G1 and G4.
Every line is at most S (never compressed past its natural width) except a
lone over-wide atom. Every line is at least T wherever step 2 found a window.
A line keeps its greedy breaks unless a deficit's window covers it — unlike
whole-section minimum-variance, which re-divides every line of the section.

**What an edit changes.** For an edit at measure m on line L:

- greedy lines before L are unchanged (greedy depends only on what precedes);
- from L on, greedy breaks differ until they coincide with the old ones again
  (the **resync** line R); from R on the greedy lines are identical;
- windows built only from lines after R are unchanged. A deficit at or after L
  whose window changes may grow back past L, as far as its content requires.
  Once the right-to-left visit reaches a line before L in the same state as
  before (same position, same greedy lines to its left), every line further
  left is unchanged.

The changed lines are therefore the span from L (or the start of the furthest
window that grew back past it) to R (or the end of the last window overlapping
it). Backward reach happens only when a deficit lies at or after the edit, and
its length is a property of the content.

**The edit computes F in full.** The early stop above is a property of F's
OUTPUT, not a separate edit algorithm: an edit recomputes F over every touched
segment entirely and diffs the line starts by measure id. That keeps G1 exact
by construction — there is no stopping rule to prove equivalent. The
computation is arithmetic over cached naturals (`warmAllNaturals` fills them
before the first paint; today's whole-section DP took ≤ 1.8 ms on the 139-bar
movement against a 342 ms edit). The cost to bound is the number of CHANGED
lines, which the splice re-renders and the pagination re-fits.

**Why T is fixed, not derived from the section.** A target derived from the
section's average fill depends on the section's total width, so every edit
would move it, and any window in the section could re-divide — the edge case
where every edit is costly. With T fixed, the remaining cost risk comes from
the content: a segment whose greedy fills average only a little above T leaves
each donor line little slack, so its windows grow long. As an estimate (not a
measurement), a window spans about shortfall / (average fill − T) lines; Phase 0
reports the real distribution per segment.

## Rejected

| Alternative | Why not |
|---|---|
| Page-causal, page-local balancing (this spec's first revision) | Cannot borrow across a page break: stubs at section ends, evenness per page rather than per section, and greedy capacity lines rendered on top of the final ones (load up to ~2×). Ruled out by Max, 2026-10-19. |
| Whole-section minimum-variance on every edit (the pre-10-08 behaviour) | Pure, but globally unstable: 30 / 38 / 70 boundaries moved per added bar (median / p90 / max) on the sonata (`balance.ts` λ table, 2026-09-17). Its optimum can re-divide every line of a section for one bar. |
| Bounded suffix balance (today's edit path) | The defect. |
| A cap on how far a window reaches | Max: reintroduces the discrepancy. A capped repair gives an answer that depends on the cap, not the content. |
| T derived from the section's average | Every edit shifts T; see above. |
| Undo restores a layout snapshot on every history entry (`LayoutSnapshot`, `captureLayout` / `restoreLayout`) | Meets G4 only; live and reload still differ. |

## Decisions for Max

- **[D1] T.** A fixed fill between MIN_FILL (0.65) and S (1.00). Higher means
  fuller tails and dips and longer windows. Phase 0 sweeps 0.70, 0.75, 0.80,
  0.85 and 0.90 and reports quality against reach for each.
- **[D2] Arrangement inside a window.** (a) minimum-variance: the window's lines
  come out even, as a hand balance of the reached-back systems would; (b)
  anchored to the greedy breaks — `dpPartition`'s λ applied to line starts
  absent from the GREEDY partition (still pure, since greedy is a function of
  the content), which moves fewer boundaries per window. Recommendation: (a),
  unless Phase 0 shows window churn.
- **[D3] A deficit with no window** (step 3). Phase 0 lists every occurrence on
  real scores; expected rare, since it needs a segment that cannot hold its
  lines at T anywhere back to its start.

## Implementation plan

**Phase 0 — measure** (probes only, no app change).

- A new sonata probe dumps F's inputs from the live document (Max's working
  copy, `~/Documents/sonata.hkc`): per-measure naturals, per-line leading blocks,
  hard starts, render units, the budget, and today's committed line and page
  starts. `test/balance/sonata-fills.json` (measured 2026-09-05 from the
  MusicXML import) is not current.
- A Node simulation in `test/balance/` runs F at each T from D1 and today's
  whole-section balance on the dump, and reports:
  1. **quality** per segment: line count; fill min / mean / sd; the tail fill;
     lines below T — against today's load;
  2. **reach**: window length in lines per deficit (median / p90 / max);
  3. **churn**, over an every-measure sweep (delete the measure, duplicate it,
     scale its natural by 0.85 and by 1.15): line starts changed before the
     edit's line (backward reach) and from it on (forward), and the resync
     distance — median / p90 / max, for F and for today's whole-section balance;
  4. every step-3 occurrence;
  5. F's compute time per segment.
- The same on one multi-instrument score.

Decide D1–D3 from the tables.

**Phase 1 — F as one module.** `render/balance.ts` gains the segment function
(greedy breaks, deficit windows, step-3 ladder) beside `greedyLines`,
`dpPartition` and `balanceSection`, with `dpPartition` and `fillsOf` taking a
leading block per line start. No DOM. `test/balance/run.mjs` covers: purity
(independent of the incumbent), line count = greedy count outside step 3, every
line in [T, S] where a window exists, window minimality against brute force on
small random widths, the step-3 cases, and atoms never split.

**Phase 2 — load.** `balanceSectionLines` (used by `balanceInitialBand`, which
already balances every section after `warmAllNaturals`) calls F per segment in
place of `balanceSection`. Pagination is unchanged: first-fit over F's lines,
then rule v2 distribution per page.

**Phase 3 — edit.** `PageLineBreaks.tryRefill` computes F over every touched
segment (one whose content, naturals or hard starts changed) in full, diffs the
starts by measure id, and hands the changed lines to the existing splice /
`PageAssembler.applyPartition` path; pagination re-fits from the page holding
the first changed line until a page's start, end and content signature match
the previous layout. Remove the repair loop in `repartition`, `balanceTouched`
and its page bound, and `BALANCE_LAMBDA`. Measure `edit-cost-attribution.js` and
`splice-every-measure` in Firefox on Max's machine (Chromium under-reports
Firefox layout costs).

**Phase 4 — clean up.** Retire the line-break commands' `LayoutSnapshot` restore
if the gates show it redundant; update architecture/composer.md (Page view → The
partition), the `balance.ts` and `linebreaks.ts` headers (the "partition is
never re-derived" and "derive and edit-rebalance agree by construction" claims),
and decisions.md.

## Verification

- **Universal invariant**: on every fixture, the mounted partition equals F of
  the document (load ≡ edit), alongside the existing first-fit pagination check
  (`assertPaginationFirstFit`, `test/composer-test/lib/assertions.mjs`).
- **New fixtures** (page-layout category): the m. 250 case reproduced small — an
  edit on a later page of a multi-page section, then undo, with the partition
  and every system's geometry back exactly; a chain of edits and undos returning
  to the load layout; a reload after edits matching the live layout; a section
  ending in a one-bar remainder (the window reaches back, no stub); a
  mid-section dip from a wide bar; a deficit whose window crosses a page break
  (an earlier page moves, by design); each step-3 case.
- **Expected changes**: `pag_*` and `pageBalance*` fixtures that assert
  minimum-variance results, and visual baselines of multi-line sections; re-seed
  only after reviewing heatmaps of the new layout.
- **Probes** (`test/composer-inspect/sonata-probes/`): `balance-consistency.js`
  at several sites — `undo.startsDiffVsLoad` and `undo.pagesDiffVsLoad` empty;
  `undo-reversibility-gate.js` — `geomAfterUndo.changed` 0 for every case;
  `splice-exactness-census.js` — each edit's changed lines equal F's diff;
  `load-reference-gate.js`, `pagination-fold-check.js`, `load-profile-phases.js`.

**Acceptance**: G1 — a reload after any sequence of edits and undos matches the
live layout, and the invariant holds on every fixture; G2 — no line below T
outside the listed step-3 cases; G3 — Phase 0 churn and reach tables reviewed by
Max, and steady edit cost within 10 % of today's 118–130 ms
([composer-render-perf.md](composer-render-perf.md)) measured in Firefox; G4 —
exact undo at every probe site.
