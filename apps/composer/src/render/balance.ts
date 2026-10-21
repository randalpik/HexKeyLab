// The page-view line partition F (docs/composer-partition-consistency-spec.md;
// decisions.md "Partition: the reach-back curve", Max 2026-10-20).
//
// ONE pure function of a section's widths, run by the load (linebreaks.ts
// `balanceInitialBand`: every section, before the first paint) and by every
// edit (`repartition` → `balanceSectionLines`: every touched section, in full).
// A load and an edit therefore compute the same layout, a reload never changes
// the screen, and undo restores the layout exactly (spec G1, G4). There is no
// incumbent partition, no repair loop and no legality window. Per section:
//   1. greedy lines at ≤ PARTITION_CAP — N lines, the fewest possible;
//   2. for every k = 1..N, the last k greedy lines re-divided into the same k
//      lines, most evenly: minimum Σ(1 − f)², which at a fixed count ranks
//      arrangements as variance does and needs no window mean, so one
//      right-to-left DP serves every k (k = 1 is greedy, k = N the full
//      balance);
//   3. each DISTINCT layout scored on the lines it changes plus the untouched
//      line before them — `min` fill of the changed lines, `sd` over
//      neighbour + changed (the neighbour is what makes a stub look sparse),
//      `changes` = line starts off greedy;
//   4. the pick: max(min − sd − γ·changes), ties to fewer changes.
// No MIN_FILL and no compression: the only bound is the cap, and a single atom
// wider than a line sits alone. A FINAL section of fewer than
// FINAL_GREEDY_BELOW greedy lines stays greedy.
//
// Pure and DOM-free: fills are numbers (natural width / justified budget), and
// each line pays its own leading clef+key block (linebreaks.ts `sigWForLine`;
// the document's first line pays only the instrument-name indent — its block
// is drawn inside measure 0's natural).
// Simulation twin (Phase 0): test/balance/partition-f.mjs (`curve`,
// `curveTable`, `greedyStarts`) + curve-batch.mjs (`distinctLayouts`, `pick`);
// test/balance/run.mjs holds the two to identical answers.

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
