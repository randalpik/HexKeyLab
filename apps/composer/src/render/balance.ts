// Section balancing — the partition authority for page view.
//
// `repartition` (linebreaks.ts) repairs a line by moving ONE measure across ONE
// boundary. That is enough to keep every line LEGAL, but not to keep a section
// looking engraved: while measures are appended, the final line grows from
// MIN_FILL all the way to FIT_MAX before the repair sheds anything, so a
// section being composed drifted to shapes like 4,5,5,5,5,9 — one line frozen
// at fill 0.70 and its last at 1.42 (reproduced 2026-09-17). The repair also
// cannot fix a section-final line BELOW MIN_FILL at all: it pulls only from
// the next line, and the last line of a section has none. Verovio's castoff
// leaves exactly that remainder for every section (on the sonata all four
// movements ended below MIN_FILL: fills 0.16, 0.56, 0.32, 0.25).
//
// So the balancer, not the repair loop and not castoff, decides the partition:
//   - the line COUNT is `greedyLines(ws, sig, softMax)` — the fewest lines that
//     keep every line at or under softMax = 1.00 ("never compress a line past
//     its natural width"). At that cap it reproduces castoff's own line count
//     exactly on the sonata, so adopting the partition never moves a page.
//   - the ARRANGEMENT at that count is the minimum-variance partition, by a
//     dynamic program over Σ (fill − mean)² subject to MIN_FILL ≤ fill ≤
//     FIT_MAX.
// Both depend only on the widths, so the partition is a PURE FUNCTION OF
// CONTENT: derive and edit-rebalance agree by construction (Max's
// single-authority ruling, 2026-09-17), undo restores the layout exactly, and
// there is no first-edit settling because a document is balanced before its
// first paint. The earlier design's merge rule and N−1 fallback are gone —
// choosing N from the content subsumes them.
//
// `lambda` (a penalty per line start absent from the incumbent partition) is
// retained as the tuning surface but is 0 in every caller. It buys churn at
// the cost of agreement, measured over the sonata's four movements and a
// 30-bar append trace (2026-09-17):
//     λ      derive≡edit     boundaries moved per +1 bar     worst fill spread
//                            (median / p90 / max)
//     0      23/23           30 / 38 / 70                    0.15
//     0.005  17/23            2 / 16 / 20                    0.16
//     0.02   15/23            0 /  6 / 12                     0.32
// λ > 0 is what froze that 4-bar first line: at 0.02 the even partition was
// 15× better on variance but cost 5 × 0.02 in penalty, so the ragged one won.
//
// Pure and DOM-free: fills are numbers (natural width / justified budget), the
// leading clef+key block is one constant per line. Tested directly under Node
// (test/balance/run.mjs) on the sonata's measured widths.

export interface BalanceParams {
  /** Fill below which a line is illegal (linebreaks.ts MIN_FILL). */
  minFill: number;
  /** Fill above which a line is illegal (linebreaks.ts FIT_MAX). */
  fitMax: number;
  /** Fill a line is not packed past when CHOOSING the line count: the density
   *  at which a fresh engrave breaks (`greedyLines`). Tighter than `fitMax`,
   *  which stays the legality bound the DP must respect. */
  softMax: number;
  /** Change penalty per line start not present in the reference partition.
   *  0 makes the partition a pure function of content — see `balanceSection`. */
  lambda: number;
}

export interface BalanceResult {
  /** Measures per line, section order. */
  lens: number[];
  /** Lines the new count removed relative to the incumbent; negative when the
   *  section GREW a line (the content now needs one more). */
  removed: number;
}

/** `sigFirst` (every function below) is the leading-block fill of the FIRST
 *  line of the section, when it differs from `sigFill`. It exists because the
 *  DOCUMENT's first line has no repeated clef+key block to pay for: that block
 *  is drawn inside its first measure and is therefore already counted in that
 *  measure's natural width (verified 2026-09-18 — in an unwrapped render the
 *  clef's bbox sits at x≈99 INSIDE measure 0's bbox, which starts at 0, and
 *  measure 0 measures 3963 against 2930 for a plain measure). Adding `sigFill`
 *  there too double-counted it, pushing a six-measure first line to fill 1.008
 *  against a 1.00 ceiling — which is exactly why the first line held one
 *  measure fewer than every other line, and fewer than castoff itself places.
 *  For a score with instrument names, `sigFirst` instead carries the measured
 *  label indent, which IS outside the first measure. */

/** Fill of each line for a partition given as line lengths. */
export function fillsOf(
  ws: readonly number[], sigFill: number, lens: readonly number[], sigFirst = sigFill,
): number[] {
  const out: number[] = [];
  let i = 0;
  for (const L of lens) {
    let s = out.length === 0 ? sigFirst : sigFill;
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

/** Fewest lines that keep every line's fill at or under `cap`, packing
 *  greedily. Greedy is optimal for a CONTIGUOUS capacity partition (any
 *  shorter first line can be extended without hurting the tail — the standard
 *  exchange argument), so this is the exact minimum, and it depends only on
 *  the widths: the line COUNT is therefore a pure function of content.
 *
 *  Calibrated at cap 1.00 — "a line never compresses past its natural width;
 *  if it would, use another line" — which reproduces Verovio's own castoff
 *  line count EXACTLY on the sonata (36/21/22/37 per movement, 2026-09-17).
 *  That agreement is what lets us take the partition over from castoff without
 *  changing any section's line count, and so without moving a page boundary. */
export function greedyLines(
  ws: readonly number[], sigFill: number, cap: number, sigFirst = sigFill,
): number {
  let n = 1, f = sigFirst;
  for (const w of ws) {
    if (f + w > cap && f > (n === 1 ? sigFirst : sigFill)) { n++; f = sigFill + w; }
    else f += w;
  }
  return n;
}

/** Minimum-variance partition of `ws` into exactly `N` lines with every line's
 *  fill inside [minFill, fitMax], penalising line starts absent from
 *  `refStarts` by `lambda` each. O(M²·N). Null when no legal partition exists. */
export function dpPartition(
  ws: readonly number[], sigFill: number, N: number,
  refStarts: ReadonlySet<number>, p: BalanceParams, sigFirst = sigFill,
): number[] | null {
  const M = ws.length;
  if (N < 1 || N > M) return null;
  const pre = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) pre[i + 1] = pre[i] + ws[i];
  /* The document's first line carries no repeated clef+key block — that block
     is already inside its first measure's natural (see `sigFirst`). */
  const mu = (pre[M] + sigFirst + (N - 1) * sigFill) / N;
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
        const f = pre[j] - pre[i] + (i === 0 ? sigFirst : sigFill);
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

/** Balance one section.
 *
 *  The line COUNT comes from `greedyLines` at `softMax` — a pure function of
 *  the widths — and the partition is the minimum-variance arrangement at that
 *  count. With `lambda` 0 (the default everywhere; see linebreaks.ts
 *  BALANCE_LAMBDA) the whole result is a pure function of (widths, sigFill,
 *  params): the partition a fresh derive computes for some content and the one
 *  an edit computes for that same content are THE SAME PARTITION. That is the
 *  single-authority requirement (Max, 2026-09-17: "we don't want to have 2
 *  different systems competing; the derived partition of a measure count
 *  should be equal to an edit-triggered section rebalance of the same
 *  content") — and, being history-free, it also has no threshold hysteresis,
 *  which is what the 2026-08-30 "never re-derived" ruling was protecting: an
 *  undone edit restores the layout exactly because the layout is a function of
 *  the document alone.
 *
 *  `refLens` is only the incumbent, used to report whether anything moved (and
 *  to anchor the DP when `lambda` > 0, kept as the tuning surface: λ trades
 *  agreement for churn — at 0.02 the sonata moved ≤ 12 boundaries per inserted
 *  bar but the edit path disagreed with a fresh derive on 8 of 23 bar counts
 *  and let fills spread 0.32; at 0 agreement is exact and the spread is 0.15).
 *
 *  Null = no legal partition at any candidate count: the caller keeps
 *  `refLens`. For a section too small to fill two legal lines that is Max's
 *  rule 2 — the stub stays, unjustified by `minLastJustification`. */
export function balanceSection(
  ws: readonly number[], sigFill: number, refLens: readonly number[], p: BalanceParams,
  sigFirst = sigFill,
): BalanceResult | null {
  const M = ws.length;
  if (!refLens.length || refLens.reduce((a, b) => a + b, 0) !== M) return null;
  /* A section that cannot hold two lines is already the only layout it has —
     a lock's one-measure remainder, a tiny document. Report it unchanged
     rather than null, which the caller would log as a failed balance. */
  if (M < 2) return { lens: [M], removed: refLens.length - 1 };
  const refStarts = new Set(startsOf(refLens));
  const N0 = Math.min(M, greedyLines(ws, sigFill, p.softMax, sigFirst));
  /* Greedy guarantees every line fits `softMax` ≤ `fitMax`, so only MIN_FILL
     can make N0 infeasible — a line too sparse, which wants FEWER lines. N0+1
     is tried first all the same: when a measure is too wide for `softMax` on
     its own, greedy undercounts and the extra line is what makes the rest
     legal (and when N0 fails on min-fill, N0+1 fails worse, so the order costs
     nothing).
     N may be 1: a section whose measures cannot fill two legal lines belongs on
     ONE modestly compressed line rather than two sparse ones — what the old
     merge rule did explicitly, now just the candidate that survives. Whether a
     one-line DOCUMENT is ownable at all is the caller's rule, not this one
     (linebreaks.ts 'single-line result'); flooring N at 2 here left a lock's
     7-measure remainder stranded as 6+1 (fixture lock_down_splits). */
  for (const N of [N0, N0 + 1, N0 - 1]) {
    if (N < 1 || N > M) continue;
    const lens = dpPartition(ws, sigFill, N, refStarts, p, sigFirst);
    if (lens) return { lens, removed: refLens.length - lens.length };
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

/* ── F: the reach-back curve (docs/composer-partition-consistency-spec.md) ──
 *
 * The partition as ONE pure function of a section's widths, for load and edit
 * alike (decisions.md "Partition: the reach-back curve", Max 2026-10-20):
 *   1. greedy lines at ≤ PARTITION_CAP — N lines, no line compressed;
 *   2. for every k = 1..N, the last k greedy lines re-divided into the same k
 *      lines, most evenly: minimum Σ(1 − f)², which at a fixed count ranks
 *      arrangements as variance does and needs no window mean, so one
 *      right-to-left DP serves every k (k = 1 is greedy, k = N the full
 *      balance);
 *   3. each DISTINCT layout scored on the lines it changes plus the untouched
 *      line before them — `min` fill of the changed lines, `sd` over
 *      neighbour + changed (the neighbour is what makes a stub look sparse),
 *      `changes` = line starts off greedy;
 *   4. the pick: max(min − sd − γ·changes), ties to fewer changes.
 * No MIN_FILL, no compression: the only bound is the cap, and a single atom
 * wider than a line sits alone. A FINAL section of fewer than
 * FINAL_GREEDY_BELOW greedy lines stays greedy.
 *
 * Simulation twin (Phase 0): test/balance/partition-f.mjs (`curve`,
 * `curveTable`, `greedyStarts`) + curve-batch.mjs (`distinctLayouts`, `pick`);
 * test/balance/run.mjs holds the two to identical answers. */

/** No line is packed past its natural width: greedy's cap and the curve's
 *  ceiling. Compressed lines collide. */
export const PARTITION_CAP = 1.00;
/** Flat cost per line start moved off greedy (on the sonata 0.03 reproduces
 *  Max's own picks: I 1 change, II 0, III 3, IV 1). Intended flat: a user
 *  forces another layout with locks. */
export const PARTITION_GAMMA = 0.03;
/** A FINAL section with fewer greedy lines than this stays greedy — the
 *  small-document convenience MIN_FILL used to provide. Any other section is
 *  always picked from the curve (a stub before a section or a lock is a bug). */
export const FINAL_GREEDY_BELOW = 3;

/** One section's input to F. An atom is a render unit (a multirest run is one
 *  atom, so no line starts inside it). `ws[a]` = atom a's natural fill (natural
 *  width / justified budget); `sigs[a]` = the leading-block fill a line
 *  STARTING at atom a pays (linebreaks.ts `sigWForLine`). Line k of a partition
 *  is atoms [starts[k], starts[k+1]); its fill is sigs[starts[k]] + Σ ws. */
export interface SectionAtoms {
  readonly ws: readonly number[];
  readonly sigs: readonly number[];
}

function prefixOf(ws: readonly number[]): Float64Array {
  const pre = new Float64Array(ws.length + 1);
  for (let i = 0; i < ws.length; i++) pre[i + 1] = pre[i] + ws[i];
  return pre;
}

/** Fill of every line of a partition given as atom starts. */
export function lineFills(s: SectionAtoms, starts: readonly number[]): number[] {
  const pre = prefixOf(s.ws), M = s.ws.length;
  return starts.map((a, k) => s.sigs[a] + pre[k + 1 < starts.length ? starts[k + 1] : M] - pre[a]);
}

/** Greedy line starts at `cap`: a line breaks before an atom that would push
 *  it past the cap, unless the line is still empty (so an over-wide atom sits
 *  alone instead of looping). N = its length is the section's line count at
 *  every point of the curve. */
export function greedyStarts(s: SectionAtoms, cap = PARTITION_CAP): number[] {
  const M = s.ws.length;
  if (!M) return [];
  const st = [0];
  let f = s.sigs[0];
  for (let a = 0; a < M; a++) {
    const w = s.ws[a];
    if (f + w > cap && a > st[st.length - 1]) { st.push(a); f = s.sigs[a] + w; } else f += w;
  }
  return st;
}

/** The curve's DP, right to left: back[c][x] = the end of the first line in
 *  the minimum-Σ(1 − f)² split of atoms [x, M) into c lines, every line ≤ cap
 *  except a lone over-wide atom (−1 when no such split exists). Ties take the
 *  shorter first line. O(N · M · band). */
export function curveTable(s: SectionAtoms, N: number, cap = PARTITION_CAP): Int32Array[] {
  const M = s.ws.length, pre = prefixOf(s.ws), INF = Number.POSITIVE_INFINITY;
  let prev = new Float64Array(M + 1).fill(INF);
  prev[M] = 0;
  const back: Int32Array[] = [new Int32Array(0)];
  for (let c = 1; c <= N; c++) {
    const cur = new Float64Array(M + 1).fill(INF), bk = new Int32Array(M + 1).fill(-1);
    for (let x = M - 1; x >= 0; x--) {
      let bv = INF, by = -1;
      for (let y = x + 1; y <= M; y++) {
        const f = s.sigs[x] + pre[y] - pre[x];
        if (f > cap && y > x + 1) break;
        const rest = prev[y];
        if (rest === INF) continue;
        const v = (1 - f) * (1 - f) + rest;
        if (v < bv) { bv = v; by = y; }
      }
      cur[x] = bv; bk[x] = by;
    }
    back.push(bk);
    prev = cur;
  }
  return back;
}

/** Point k of the curve: the first N − k greedy lines kept, the last k
 *  re-divided into their most even k lines. */
export interface CurvePoint { k: number; starts: number[]; fills: number[] }

/** Every point of one section's reach-back curve, k = 1..N. */
export function reachBackCurve(
  s: SectionAtoms, cap = PARTITION_CAP,
): { greedy: number[]; points: CurvePoint[] } {
  const greedy = greedyStarts(s, cap), N = greedy.length;
  const back = curveTable(s, N, cap);
  const points: CurvePoint[] = [];
  for (let k = 1; k <= N; k++) {
    const starts = greedy.slice(0, N - k);
    let x = greedy[N - k];
    for (let c = k; c >= 1; c--) { starts.push(x); x = back[c][x]; }
    points.push({ k, starts, fills: lineFills(s, starts) });
  }
  return { greedy, points };
}

/** A distinct layout on the curve, scored on the lines it changes. */
export interface CurveLayout {
  /** Reach-back range that produces it. */
  kFrom: number;
  kTo: number;
  starts: number[];
  fills: number[];
  /** Line starts absent from greedy (boundaries moved). */
  changes: number;
  /** Lines scored as changed: those whose start OR end moved (the donor above
   *  a reworked tail counts); greedy itself scores its last line. */
  lines: number;
  /** Lowest fill among the changed lines. */
  min: number;
  /** Population spread over the untouched line before them + the changed. */
  sd: number;
}

function scoreLayout(
  greedy: readonly number[], G: ReadonlySet<number>, starts: number[], fills: number[], k: number,
): CurveLayout {
  const N = starts.length;
  const firstDiff = starts.findIndex((x, i) => x !== greedy[i]);
  const firstChanged = firstDiff < 0 ? N - 1 : firstDiff - 1;
  const changed = fills.slice(firstChanged);
  const scored = firstChanged > 0 ? [fills[firstChanged - 1], ...changed] : changed;
  const mu = scored.reduce((a, b) => a + b, 0) / scored.length;
  const sd = Math.sqrt(scored.reduce((a, b) => a + (b - mu) ** 2, 0) / scored.length);
  let changes = 0;
  for (const x of starts) if (!G.has(x)) changes++;
  return { kFrom: k, kTo: k, starts, fills, changes, lines: changed.length, min: Math.min(...changed), sd };
}

/** The curve's distinct layouts, in reach-back order (consecutive equal
 *  points merge into one row; layouts[0] is greedy). */
export function distinctLayouts(
  s: SectionAtoms, cap = PARTITION_CAP,
): { greedy: number[]; layouts: CurveLayout[] } {
  const { greedy, points } = reachBackCurve(s, cap);
  const G = new Set(greedy);
  const layouts: CurveLayout[] = [];
  let prevKey: string | null = null;
  for (const p of points) {
    const key = p.starts.join();
    if (key === prevKey) { layouts[layouts.length - 1].kTo = p.k; continue; }
    prevKey = key;
    layouts.push(scoreLayout(greedy, G, p.starts, p.fills, p.k));
  }
  return { greedy, layouts };
}

/** max(min − sd − γ·changes); a tie (within 1e-12) goes to fewer changes,
 *  then to the shorter reach. */
export function pickLayout(layouts: readonly CurveLayout[], gamma = PARTITION_GAMMA): CurveLayout {
  const score = (L: CurveLayout) => L.min - L.sd - gamma * L.changes;
  let best = layouts[0], bs = score(best);
  for (let i = 1; i < layouts.length; i++) {
    const L = layouts[i], v = score(L);
    if (v > bs + 1e-12 || (v > bs - 1e-12 && L.changes < best.changes)) { best = L; bs = v; }
  }
  return best;
}

export interface SectionPartition {
  /** Line starts, atom indices (section-relative); [] for an empty section. */
  starts: number[];
  /** Greedy's starts (its length is the line count). */
  greedy: number[];
  /** The picked layout (diagnostics: changes, min, sd, reach). Null when empty. */
  layout: CurveLayout | null;
  /** Distinct layouts the curve offered. */
  layouts: number;
  /** A final section under FINAL_GREEDY_BELOW lines: kept greedy, not picked. */
  exempt: boolean;
}

/** F for one section. `final` = the section ends the document. */
export function partitionSection(
  s: SectionAtoms, final: boolean, gamma = PARTITION_GAMMA, cap = PARTITION_CAP,
): SectionPartition {
  if (!s.ws.length) return { starts: [], greedy: [], layout: null, layouts: 0, exempt: false };
  const greedy = greedyStarts(s, cap);
  const exempt = final && greedy.length < FINAL_GREEDY_BELOW;
  if (exempt || greedy.length === 1) {
    const layout = scoreLayout(greedy, new Set(greedy), greedy.slice(), lineFills(s, greedy), 1);
    return { starts: greedy.slice(), greedy, layout, layouts: 1, exempt };
  }
  const { layouts } = distinctLayouts(s, cap);
  const layout = pickLayout(layouts, gamma);
  return { starts: layout.starts.slice(), greedy, layout, layouts: layouts.length, exempt: false };
}

/** F's atoms for measures [lo, hi): one atom per render unit — `unitOf(i)` is
 *  the first and last measure of i's unit (model/multirest.ts), a multirest run
 *  is one atom whose fill is its members' naturals summed — and each atom's
 *  leading block `sigAt(first measure)`. `atomStart[a]` maps an atom back to
 *  its first measure. Null when any width is unknown: F never balances against
 *  a phantom document. */
export function sectionAtoms(
  lo: number, hi: number, budget: number,
  natural: (i: number) => number | null | undefined,
  sigAt: (i: number) => number | null | undefined,
  unitOf: (i: number) => readonly [number, number],
): (SectionAtoms & { atomStart: number[] }) | null {
  const ws: number[] = [], sigs: number[] = [], atomStart: number[] = [];
  for (let i = lo; i < hi;) {
    const [uLo, uHi] = unitOf(i);
    const first = Math.max(uLo, lo), last = Math.min(uHi, hi - 1);
    let w = 0;
    for (let k = first; k <= last; k++) {
      const x = natural(k);
      if (x == null) return null;
      w += x;
    }
    const sg = sigAt(first);
    if (sg == null) return null;
    ws.push(w / budget);
    sigs.push(sg / budget);
    atomStart.push(first);
    i = Math.max(last, i) + 1;
  }
  return { ws, sigs, atomStart };
}
