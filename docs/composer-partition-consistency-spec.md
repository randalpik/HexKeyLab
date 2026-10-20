# Spec: one partition function for load and edit

**Status**: proposed 2026-10-19, for a new thread. Decision points for Max are
marked **[D1]**–**[D3]**. Background: decisions.md "Open: the bounded section
balance means undo need not restore a reflowed layout" and its addendum;
architecture: [architecture/composer.md](architecture/composer.md) → Page view.

## The defect

Page view computes the line partition two different ways:

- **On load** every section is balanced whole (`balanceInitialBand`,
  `render/linebreaks.ts`): the line count is the fewest lines at fill ≤ 1.0,
  the arrangement the minimum-variance one (`render/balance.ts`).
- **On an edit** `balanceTouched` balances only from the first line of the edit's
  page to the section's end — the bound added on 2026-10-08 so that "an edit
  never reaches a page before it" (Max).

The two disagree whenever a section's suffix, balanced alone, wants a different
line count or arrangement than the whole-section answer gives it.

**Evidence** (sonata, `test/composer-inspect/sonata-probes/balance-consistency.js
--arg "mi=250"`): movement III is mm. 226–325. A one-note delete at m. 250 (on
the page starting at m. 240) re-divides mm. 240–325 from 9 lines into 10
(line starts 245/249/254/… → 244/248/252/…), and every later page start shifts.
The note itself is irrelevant — the first edit of any kind on that page does
it. The undo restores the document byte-for-byte, but the bounded balance of the
restored content returns the edited partition unchanged (it is a fixed point of
the suffix balance), so the load's answer is never recomputed. A reload brings
it back. In a whole-score sweep these flips accumulate: one later edit cascaded
through 10 pages and created a page only because three earlier edits had flipped
their sections.

## Requirements

- **G1 — one function** (Max, 2026-09-17/18): the partition and pagination are a
  pure function of the document. A load and an edit compute the same layout for
  the same content; a reload never changes what is on screen.
- **G2 — no reach backwards** (Max, 2026-10-08): an edit never moves a page
  before the edit's page. (Today's one exception stays: a page's first system
  that shrinks may return to the page before — the boundary itself is shared.)
- **G3 — O(edit)**: an edit's cost is bounded by what it changes, not by the
  section or document length, except where the change itself propagates.
- **G4 — exact undo** (Max, 2026-10-19): undo and redo restore the exact
  previous layout, for any sequence of steps.

## Why the fix is a different partition function

G1 and G2 together force a **page-causal** partition: let F be the layout
function and p the edit's page. G2 says the edit leaves pages before p alone;
G1 says the result equals F(new content). So F's pages before p must not depend
on content at or after p — for every p. Whole-section balancing (today's load)
violates this: the balance of a section spanning pages 3–9 depends on all of it,
so content on page 9 decides lines on page 3. Any scheme that keeps that load
function and bounds the edit will disagree with the load somewhere, which is the
defect. G4 then follows for free: with a pure F, undoing the content undoes the
layout, for any sequence.

Rejected:

| Alternative | Why not |
|---|---|
| Whole-section balance on edits (the pre-10-08 behaviour) | Violates G2: a page break on page 4 moved lines three pages up. Ruled out by Max. |
| Undo restores a layout snapshot on every history entry (the machinery exists for line-break commands: `LayoutSnapshot`, `captureLayout` / `restoreLayout`) | Meets G4 only. Live and reload still differ, and the first edit on a later page of a section still reflows it for no reason. Useful as a safety net, not a fix. |
| Edits compute the whole-section answer and adopt it when earlier pages are unchanged, else fall back to the bounded balance | Path-dependent: a single undo is exact, but a chain of undos after a fallback is not, and live ≠ reload whenever the fallback fired. |
| Page-sequential suffix balance (each page takes the first lines of a balance from its first measure to the section end) | Page k still depends on content after it, so G2 still forces the edit path to diverge. Same defect, moved. |

## Proposed F: page-local balancing

Pages are laid out in order. Page k starts at measure `s_k` (the first measure
after page k−1, or a hard page start):

1. **Capacity.** From `s_k`, form greedy lines — each as many measures as fit at
   natural width (fill ≤ `BALANCE_SOFT_MAX` 1.0), breaking at hard line starts
   (locks, section starts) and at render-unit (multirest) boundaries — and add
   them to the page while they fit under the rule-v1 minimum placement
   (`placeSystems` + `foldIndex`, measured extents). A user page break or the end
   of the document ends the page. The page's measure range is `[s_k, e_k)`; a
   single system taller than the page still takes the page alone.
2. **Balance.** Within `[s_k, e_k)`, each segment between hard line starts gets
   the minimum-variance arrangement at the greedy line count, every line in
   [`MIN_FILL` 0.65, `FIT_MAX` 1.45] (`balanceSection`, `dpPartition`, reused
   as-is). A segment with no legal arrangement keeps its greedy lines.
3. **Verify.** Measure the balanced lines. If they no longer fit (an extreme
   measure moved into a taller line), drop the last greedy line from the range
   and repeat from 2. Terminates: the range only shrinks.
4. Page k+1 starts at `e_k`. Rule v2 distributes each page as today.

**Dependencies.** Page k depends on `s_k`, the content of `[s_k, e_k)`, and the
first greedy line after `e_k` (the one that did not fit) — nothing further.
Courtesy signatures at a page's last line come from the next measure but do not
enter the fill, so they redraw a line without changing the partition.

**Load** runs F page by page; it replaces `balanceInitialBand` + first-fit, and
fits the assembler's existing page-by-page close loop (`PageAssembler`).

**Edit** recomputes F from the edit's page — from the page before it when the
edit touches a page's first line — and stops at the first page whose
`(start, end)` and content signature match the previous layout: by causality
every later page is then unchanged. Typically one page; a cascade only when a
page's range changes, as today.

**Undo** needs nothing special: F of the restored content is the previous
layout. The line-break commands' `LayoutSnapshot` path becomes redundant (keep
it until the gates prove F alone restores exactly, then delete it).

## Decisions for Max

- **[D1] Section tails.** Whole-section balancing always leaves a section's last
  line legal. Page-local balancing cannot borrow across a page break, so a
  section whose remainder after a full page is one short line (below
  `MIN_FILL`) gets an unjustified stub on its last page. Options: (a) accept it;
  (b) a bounded exception: when the remainder after page k fits on page k+1 and
  would be an illegal final line, balance page k's last segment together with
  it — then an edit on a section's last page may move the page before it (one
  page, section ends only). Recommendation: measure first (Phase 0); choose (b)
  only if stubs actually occur on real scores.
- **[D2] Evenness per page, not per section.** Lines are even within a page;
  two pages of one section may differ in average fill (a page turn separates
  them). Phase 0 reports the per-page fill spread on the sonata against today's.
- **[D3] Capacity cost.** Step 1 needs extents of greedy lines that are mostly
  not the lines finally drawn, so a load may render lines twice (Verovio ~2.1 s
  → up to ~4 s on the sonata). Options: (a) accept, caching greedy-line extents
  by line signature (an edit re-renders only changed lines); (b) predict a
  line's height from per-measure vertical extents (the naturals windows already
  render every measure) and render only the final lines, re-checking the fold
  on measured extents. Recommendation: (a) first, measured; (b) if the load
  regresses noticeably in Firefox.

## Implementation plan

**Phase 0 — measure** (probes only, no app change). On the sonata and one
multi-instrument score, simulate F from the stored naturals and rendered
extents: line count, fill spread per page and per section, section-tail stubs
(D1), page count, and the number of extra line renders (D3), against today's
layout. Decide D1–D3.

**Phase 1 — F as one module.** A new `render/pagelayout.ts` exporting a pure
page step — `(start measure, naturals, extents provider, hard starts, units,
budget, page geometry) → { lines, end }` — reusing `greedyLines` /
`balanceSection` from `balance.ts` and `placeSystems` / `foldIndex` from
`pagefit.ts`. No DOM; the extents provider is injected (the assembler renders
on demand and memoizes by line signature).

**Phase 2 — load.** `Renderer.assembleDocument` (`render/render.ts`, which
calls `seedPartition` + `balanceInitialBand` before `PageAssembler.begin`) and
`PageAssembler` close pages through the page step instead of balancing first
and first-fitting after. The partition cache keeps working (keyed on the layout
inputs, checked against the document version).

**Phase 3 — edit.** `PageLineBreaks.tryRefill` / `repartition` stop repairing
and balancing; the refill computes the changed pages with the page step from the
first affected page until convergence, and hands the new lines and page starts
to the existing splice / `applyPartition` path. Remove `balanceTouched`, the
repair loop, `BALANCE_LAMBDA`, and the "Open" decisions entry's bound.

**Phase 4 — clean up.** Retire the line-break commands' `LayoutSnapshot`
restore if the gates show it redundant; update architecture/composer.md (Page
view → The partition / Pagination), the `balance.ts` header (whose "derive and
edit-rebalance agree by construction" is currently false), and decisions.md.

## Verification

- **Universal invariant**: replace `assertPaginationFirstFit`
  (`test/composer-test/lib/assertions.mjs`) with a page-local check — every
  mounted page's lines and end equal the page step's result from its first
  measure. This asserts load ≡ edit on every fixture.
- **New fixtures** (page-layout category): a section spanning two or more
  pages where the suffix-alone balance differs from the whole (reproduce the m.
  250 case small) — edit on the later page, assert no earlier page moved, undo,
  assert the partition and every system's geometry are back exactly; a chain of
  edits and undos returning to the load layout; a reload (re-derive) after edits
  matching the live layout; section-tail behaviour per D1.
- **Expected changes**: `pag_*` and `pageBalance*` fixtures that assert
  whole-section results, and full-page visual baselines of multi-page sections,
  will change; re-seed only after reviewing heatmaps of the new layout.
- **Probes** (`test/composer-inspect/sonata-probes/`): `balance-consistency.js`
  at several sites — `undo.startsDiffVsLoad` and `undo.pagesDiffVsLoad` empty;
  `undo-reversibility-gate.js` — `geomAfterUndo.changed` 0 for every case;
  `splice-exactness-census.js` — no row where a page before the edit's moved;
  `load-reference-gate.js`, `pagination-fold-check.js`; `edit-cost-attribution.js`
  and `load-profile-phases.js` for G3 and D3.

**Acceptance**: G1 — a reload after any sequence of edits and undos matches the
live layout; G2 — no page before the edit's page (other than a shared first
system returning) ever moves; G4 — the probes above show exact undo at every
site; G3 — steady edit cost within 10 % of today's 118–130 ms
([composer-render-perf.md](composer-render-perf.md)).
