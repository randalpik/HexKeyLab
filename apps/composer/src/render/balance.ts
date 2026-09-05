// Section balancing — the one illegality the page-view repair loop cannot fix.
//
// `repartition` (linebreaks.ts) repairs a line by moving ONE measure across ONE
// boundary, and it can only pull from the NEXT line. A section-final line — the
// last line before a hard break, or the last line of the document — has no next
// line, so when it falls below MIN_FILL (a lone bar justified across the page
// before a movement break; a one-bar stub while composing at the end) nothing
// repairs it. Verovio's castoff produces exactly that remainder for every
// section: on the sonata all four movements ended below MIN_FILL (fills 0.16,
// 0.56, 0.32, 0.25; 2026-09-05).
//
// The balancer redistributes a whole section's measures over its lines so every
// line has a similar fill (Max's rule 1), by a dynamic program that minimises
// Σ (fill − mean)² subject to MIN_FILL ≤ fill ≤ FIT_MAX. Two additions make it
// LOCAL rather than a re-derivation (the plain DP rewrote 70 of 35 boundaries
// when one bar was deleted at the end of movement I — the 3-vs-4-bar
// interleaving flips globally):
//   - a change penalty λ for every line start that is not in the current
//     partition, so a boundary moves only when it buys more than λ of variance
//     (λ = 0.02 turned a delete-at-section-end into "pull one bar back" or
//     "fold the sparse final line into its neighbour"; λ ≤ 0.005 still rippled);
//   - a merge rule before the DP: a final line below MIN_FILL is folded into its
//     predecessor while the merged line stays ≤ MERGE_MAX (1.2 — one line of
//     modest compression beats two sparse ones; at 1.0 merges never fired and a
//     section thinned toward MIN_FILL under deletion).
// N (the line count) is otherwise kept: pagination is carried by line, so an
// unchanged N moves no page boundary. When no legal partition exists at N (or
// at N−1 within MERGE_MAX) the balancer returns null and the caller keeps the
// repaired partition — for the document-final section that is Max's rule 2:
// a small document keeps its stub, unjustified by `minLastJustification`.
//
// Pure and DOM-free: fills are numbers (natural width / justified budget), the
// leading clef+key block is one constant per line. Tested directly under Node
// (test/balance/run.mjs) on the sonata's measured widths.

export interface BalanceParams {
  /** Fill below which a line is illegal (linebreaks.ts MIN_FILL). */
  minFill: number;
  /** Fill above which a line is illegal (linebreaks.ts FIT_MAX). */
  fitMax: number;
  /** Change penalty per line start not present in the reference partition. */
  lambda: number;
  /** Merge ceiling: a sparse final line folds into its predecessor while the
   *  merged line's fill stays at or below this; also the ceiling for the N−1
   *  fallback's densest line. */
  mergeMax: number;
}

export interface BalanceResult {
  /** Measures per line, section order. */
  lens: number[];
  /** Lines the merge rule / N−1 fallback removed (0 when N is unchanged). */
  removed: number;
}

/** Fill of each line for a partition given as line lengths. */
export function fillsOf(ws: readonly number[], sigFill: number, lens: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  for (const L of lens) {
    let s = sigFill;
    for (let t = 0; t < L; t++) s += ws[i + t] ?? 0;
    out.push(s);
    i += L;
  }
  return out;
}

/** Line-start measure indices (section-relative) of a partition. */
export function startsOf(lens: readonly number[]): number[] {
  const s: number[] = [];
  let acc = 0;
  for (const L of lens) { s.push(acc); acc += L; }
  return s;
}

/** Minimum-variance partition of `ws` into exactly `N` lines with every line's
 *  fill inside [minFill, fitMax], penalising line starts absent from
 *  `refStarts` by `lambda` each. O(M²·N). Null when no legal partition exists. */
export function dpPartition(
  ws: readonly number[], sigFill: number, N: number,
  refStarts: ReadonlySet<number>, p: BalanceParams,
): number[] | null {
  const M = ws.length;
  if (N < 1 || N > M) return null;
  const pre = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) pre[i + 1] = pre[i] + ws[i];
  const mu = (pre[M] + N * sigFill) / N;
  const INF = Number.POSITIVE_INFINITY;
  let prev = new Float64Array(M + 1).fill(INF);
  prev[0] = 0;
  const back: Int32Array[] = [];
  for (let k = 1; k <= N; k++) {
    const cur = new Float64Array(M + 1).fill(INF);
    const bk = new Int32Array(M + 1).fill(-1);
    for (let j = k; j <= M; j++) {
      let best = INF, bi = -1;
      for (let i = k - 1; i < j; i++) {
        const base = prev[i];
        if (base === INF) continue;
        const f = pre[j] - pre[i] + sigFill;
        if (f < p.minFill || f > p.fitMax) continue;
        const d = f - mu;
        const c = base + d * d + (i > 0 && !refStarts.has(i) ? p.lambda : 0);
        if (c < best) { best = c; bi = i; }
      }
      cur[j] = best; bk[j] = bi;
    }
    back.push(bk);
    prev = cur;
  }
  if (prev[M] === INF) return null;
  const lens: number[] = new Array(N);
  let j = M;
  for (let k = N - 1; k >= 0; k--) {
    const i = back[k][j];
    lens[k] = j - i;
    j = i;
  }
  return lens;
}

/** Balance one section. `refLens` is its current partition (line lengths,
 *  after the repair loop); the result keeps that line count unless the merge
 *  rule or the N−1 fallback removed lines. Null = no legal balanced partition:
 *  the caller keeps `refLens` (document-final: the stub stays). */
export function balanceSection(
  ws: readonly number[], sigFill: number, refLens: readonly number[], p: BalanceParams,
): BalanceResult | null {
  const M = ws.length;
  let lens = refLens.slice();
  if (!lens.length || lens.reduce((a, b) => a + b, 0) !== M) return null;
  const refStarts = new Set(startsOf(lens));
  /* Merge rule. */
  let removed = 0;
  for (;;) {
    if (lens.length < 2) break;
    const f = fillsOf(ws, sigFill, lens);
    const last = f[f.length - 1], prev = f[f.length - 2];
    if (last >= p.minFill) break;
    if (last + prev - sigFill > p.mergeMax) break;
    lens[lens.length - 2] += lens[lens.length - 1];
    lens.pop();
    removed++;
  }
  if (lens.length === 1) return { lens, removed };
  const N = lens.length;
  const atN = dpPartition(ws, sigFill, N, refStarts, p);
  if (atN) return { lens: atN, removed };
  if (N - 1 >= 1) {
    const atN1 = dpPartition(ws, sigFill, N - 1, refStarts, p);
    if (atN1 && Math.max(...fillsOf(ws, sigFill, atN1)) <= p.mergeMax) {
      return { lens: atN1, removed: removed + 1 };
    }
  }
  return null;
}

/** Count of line starts that differ between two partitions of the same
 *  measures (symmetric difference; the number of boundaries that moved). */
export function boundariesChanged(a: readonly number[], b: readonly number[]): number {
  const A = new Set(startsOf(a)), B = new Set(startsOf(b));
  let c = 0;
  for (const x of A) if (!B.has(x)) c++;
  for (const x of B) if (!A.has(x)) c++;
  return c;
}
