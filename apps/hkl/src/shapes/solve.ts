// Where a structure's keys sit on the lattice, for the shape guide.
//
// A structure (./catalog.ts) is exact ratios from its bass. Under a layout — a
// mapping, a JI tuning mode, banded or not — the solver finds, for each band
// position the bass can start from, the cells that sound those ratios exactly
// (coordExps), and for the position the guide draws:
//   - the bass: the key of the given name nearest the reference, in that position;
//   - the path keys between consecutive members;
//   - the band seams the shape crosses.
// Nothing here is specific to one mapping or mode: it searches the lattice the
// layout defines. Equal has no exponent vectors, so it is not solved.
//
// Pure: no DOM and no state, so the Node oracle (test/shapes/) imports it.

import { coordExps, coordToMidi, freqAt } from '@hkl/shared/freq.js';
import { bandOfCell, bandWidth, layoutOf, posInBandOf } from '@hkl/shared/mapping.js';
import { noteName } from '@hkl/shared/notes.js';
import type { TuningStateLike } from '../tuning/regions.js';
import { addExps, expsKey, type Exps } from './catalog.js';

export type Cell = readonly [number, number];
/** The layout a shape is solved in. */
export type ShapeLayout = Pick<TuningStateLike, 'mode' | 'mapping' | 'anchor' | 'banded'>;

export interface Shape {
  /** Every band position the bass can start from, ascending (0 = leftmost). */
  positions: number[];
  /** The position drawn: the valid one nearest the band's spine column. */
  position: number;
  /** The bass key, in `position`. */
  bass: Cell;
  /** The members' keys, in the structure's order; the first is `bass`. */
  cells: Cell[];
  /** The path keys: the keys that are not members but link them, low to high. */
  path: Cell[];
  /** The band seams the shape crosses, as the pairs of adjacent keys each seam
   *  segment runs between. Empty when the bass can start from any position. */
  seams: Array<readonly [Cell, Cell]>;
}

/** How far the search reaches from a key: in bands along q, in rows along r. */
const REACH_BANDS = 4;
const REACH_ROWS = 9;

export function hexDistance(a: Cell, b: Cell): number {
  const dq = b[0] - a[0], dr = b[1] - a[1];
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}

const layoutKey = (l: ShapeLayout): string => [l.mode, l.mapping, l.anchor, l.banded].join('|');
const exps = (c: Cell, l: ShapeLayout): Exps => coordExps(c[0], c[1], l.mode, l.mapping, l.anchor, l.banded);

/* ── the bass ── */

const bassCache = new Map<string, Map<number, Cell>>();

/** For each band position, the key named `name` nearest `ref`; of two equally
 *  near, the one nearer `ref` in pitch, then the lower. A position with no
 *  such key in reach has no entry. */
function bassCells(name: string, layout: ShapeLayout, ref: Cell): Map<number, Cell> {
  const key = [layoutKey(layout), name, ref].join('|');
  const hit = bassCache.get(key);
  if (hit) return hit;
  const { mapping, anchor, banded } = layout;
  const refMidi = coordToMidi(ref[0], ref[1], mapping);
  const rank = (c: Cell): [number, number, number] =>
    [hexDistance(ref, c), Math.abs(coordToMidi(c[0], c[1], mapping) - refMidi), coordToMidi(c[0], c[1], mapping)];
  const best = new Map<number, Cell>();
  const reachQ = REACH_BANDS * bandWidth(mapping);
  for (let q = ref[0] - reachQ; q <= ref[0] + reachQ; q++) for (let r = ref[1] - REACH_ROWS; r <= ref[1] + REACH_ROWS; r++) {
    if (noteName(q, r, mapping, anchor, banded) !== name) continue;
    const p = posInBandOf(q, r, mapping), c: Cell = [q, r], held = best.get(p);
    if (!held) { best.set(p, c); continue; }
    const a = rank(c), b = rank(held);
    if ((a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) < 0) best.set(p, c);
  }
  bassCache.set(key, best);
  return best;
}

/* ── the members ── */

const indexCache = new Map<string, Map<string, Cell[]>>();

/** The keys in reach of `bass`, by pitch. */
function pitchIndex(bass: Cell, layout: ShapeLayout): Map<string, Cell[]> {
  const key = [layoutKey(layout), bass].join('|');
  const hit = indexCache.get(key);
  if (hit) return hit;
  const index = new Map<string, Cell[]>();
  const reachQ = REACH_BANDS * bandWidth(layout.mapping);
  for (let q = bass[0] - reachQ; q <= bass[0] + reachQ; q++) for (let r = bass[1] - REACH_ROWS; r <= bass[1] + REACH_ROWS; r++) {
    const k = expsKey(exps([q, r], layout)), at = index.get(k);
    if (at) at.push([q, r]); else index.set(k, [[q, r]]);
  }
  indexCache.set(key, index);
  return index;
}

/** The keys sounding `members` above `bass`, or null when one is not on the
 *  lattice. Where a pitch has several keys, the one nearest the bass. */
function place(bass: Cell, members: ReadonlyArray<Exps>, layout: ShapeLayout): Cell[] | null {
  const index = pitchIndex(bass, layout), from = exps(bass, layout);
  const cells: Cell[] = [];
  for (const m of members) {
    const at = index.get(expsKey(addExps(from, m)));
    if (!at) return null;
    cells.push(at.reduce((a, b) => (hexDistance(bass, b) < hexDistance(bass, a) ? b : a)));
  }
  return cells;
}

/* ── the path keys ── */

/* The lattice's three straight axes: Q, R and the composed X = (−Q, +R). */
const Q: Cell = [1, 0], R: Cell = [0, 1], X: Cell = [-1, 1];
type Leg = readonly [axis: Cell, steps: number];

/** (dq, dr) as its shortest walk: along one axis, or along two. */
function legsOf(dq: number, dr: number): Leg[] {
  const legs: Leg[] = dq * dr >= 0 ? [[Q, dq], [R, dr]]
    : Math.abs(dq) >= Math.abs(dr) ? [[Q, dq + dr], [X, dr]]
      : [[X, -dq], [R, dq + dr]];
  return legs.filter(([, n]) => n !== 0);
}

/** The keys strictly between `a` and the end of `legs`, in walking order. */
function walk(a: Cell, legs: ReadonlyArray<Leg>): Cell[] {
  const out: Cell[] = [];
  let [q, r] = a;
  for (const [axis, n] of legs) for (let i = 0; i < Math.abs(n); i++) {
    q += Math.sign(n) * axis[0]; r += Math.sign(n) * axis[1];
    out.push([q, r]);
  }
  out.pop();
  return out;
}

/** The shortest paths from `a` to `b` that turn at most once, each as the keys
 *  strictly between them: one when the two share an axis, otherwise two. */
function oneTurnPaths(a: Cell, b: Cell): Cell[][] {
  const legs = legsOf(b[0] - a[0], b[1] - a[1]);
  return legs.length < 2 ? [walk(a, legs)] : [walk(a, legs), walk(a, [legs[1], legs[0]])];
}

/** The path keys: the fewest keys that, with the members, hold a one-turn path
 *  between enough pairs of members to link them all. Any two members may be
 *  joined, not only neighbors in the structure's order. Of equally small sets,
 *  the one whose path keys touch the members along the most edges, which
 *  keeps the shape compact; of those, the one that reaches highest in pitch,
 *  by its highest key and then its next. Returned low to high. */
function pathKeys(cells: ReadonlyArray<Cell>, layout: ShapeLayout): Cell[] {
  const pitch = (c: Cell): number => freqAt(c[0], c[1], layout.mode, layout.mapping, layout.anchor, layout.banded);
  const members = new Set(cells.map(String));
  /* every one-turn path between two members, as the keys on it that are not members */
  const cellOf = new Map<string, Cell>();
  const links: Array<{ i: number; j: number; keys: string[] }> = [];
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    for (const path of oneTurnPaths(cells[i], cells[j])) {
      const extra = path.filter((c) => !members.has(String(c)));
      extra.forEach((c) => cellOf.set(String(c), c));
      links.push({ i, j, keys: extra.map(String) });
    }
  }
  /* which members are linked once `shown` is drawn: a group id per member */
  const groups = (shown: ReadonlySet<string>): number[] => {
    const parent = cells.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const l of links) if (l.keys.every((k) => shown.has(k))) parent[find(l.i)] = find(l.j);
    return cells.map((_, i) => find(i));
  };
  /* grow sets one link at a time, smallest first, each link joining two groups (one inside a
     group never helps); the first size at which a set links everything is the smallest */
  const seen = new Set<string>(['']);
  const bySize: Array<Array<Set<string>>> = [[new Set<string>()]];
  const smallest: Array<Set<string>> = [];
  for (let size = 0; size < bySize.length && !smallest.length; size++) for (const shown of bySize[size] ?? []) {
    const g = groups(shown);
    if (g.every((x) => x === g[0])) { smallest.push(shown); continue; }
    for (const l of links) {
      if (g[l.i] === g[l.j]) continue;
      const next = new Set(shown);
      l.keys.forEach((k) => next.add(k));
      const id = [...next].sort().join(' ');
      if (seen.has(id)) continue;
      seen.add(id);
      (bySize[next.size] ??= []).push(next);
    }
  }
  /* of equally small sets: the most edges between a path key and a member, then the highest */
  const touches = (set: ReadonlySet<string>): number => {
    let n = 0;
    for (const k of set) for (const m of cells) if (hexDistance(cellOf.get(k)!, m) === 1) n++;
    return n;
  };
  const most = Math.max(...smallest.map(touches));
  const highFirst = smallest.filter((set) => touches(set) === most)
    .map((set) => [...set].map((k) => cellOf.get(k)!).sort((a, b) => pitch(b) - pitch(a)));
  const higher = (x: Cell[], y: Cell[]): boolean => {
    for (let i = 0; i < x.length; i++) { const d = pitch(x[i]) - pitch(y[i]); if (d) return d > 0; }
    return false;
  };
  return highFirst.reduce((a, b) => (higher(b, a) ? b : a)).reverse();
}

/* ── the seams ── */

/* Where things lie on the lattice as a regular hexagonal grid: keys one unit
   apart, each a hexagon with a corner straight up. */
const ROOT3 = Math.sqrt(3);
const place2d = ([q, r]: readonly [number, number]): [number, number] => [q + r / 2, (r * ROOT3) / 2];

/** How far a key reaches to either side of its center along the unit
 *  direction (ux, uy): half a key along an axis, a little more between two. */
function keyReach(ux: number, uy: number): number {
  let reach = 0;
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3;
    reach = Math.max(reach, (Math.cos(a) * ux + Math.sin(a) * uy) / ROOT3);
  }
  return reach;
}

/** The seams between the bands `keys` occupy: none when they sit in one band.
 *  A seam runs along the layout's pure line, which is the R axis on an
 *  unsheared layout. Each seam is given for as far as the keys reach along
 *  that line, and one segment past that at either end. The reach is measured
 *  square to the line, so all the seams of a shape start level and end level. */
function seamsAcross(keys: ReadonlyArray<Cell>, layout: ShapeLayout): Array<readonly [Cell, Cell]> {
  const band = (c: Cell): number => bandOfCell(c[0], c[1], layout.mapping);
  const bands = keys.map(band), bLo = Math.min(...bands), bHi = Math.max(...bands);
  if (bLo === bHi) return [];
  /* position along the seams' direction */
  const { c, s } = layoutOf(layout.mapping);
  const [dx, dy] = place2d([-s / c, 1]), len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
  const along = (x: number, y: number): number => x * ux + y * uy;
  const reach = keyReach(ux, uy);
  const centers = keys.map((k) => along(...place2d(k)));
  const from = Math.min(...centers) - reach, to = Math.max(...centers) + reach;
  /* every segment of the seams between the occupied bands, anywhere near the keys: the pair of
     adjacent keys it runs between, and the stretch of the direction it covers */
  const qs = keys.map((k) => k[0]), rs = keys.map((k) => k[1]);
  const qLo = Math.min(...qs), qHi = Math.max(...qs), rLo = Math.min(...rs), rHi = Math.max(...rs);
  const margin = (qHi - qLo) + (rHi - rLo) + bandWidth(layout.mapping) + 3;
  interface Segment { from: number; to: number; pair: readonly [Cell, Cell] }
  const bySeam = new Map<number, Segment[]>();
  for (let r = rLo - margin; r <= rHi + margin; r++) for (let q = qLo - margin; q <= qHi + margin; q++) {
    for (const axis of [Q, R, X]) {
      const a: Cell = [q, r], b: Cell = [q + axis[0], r + axis[1]];
      const lo = Math.min(band(a), band(b)), hi = Math.max(band(a), band(b));
      if (hi !== lo + 1 || lo < bLo || hi > bHi) continue;
      const [ax, ay] = place2d(a), [bx, by] = place2d(b);
      const mid = along((ax + bx) / 2, (ay + by) / 2);
      /* the segment lies square to the line between its two keys, and is 1/√3 long */
      const half = Math.abs(along(ay - by, bx - ax)) / (2 * ROOT3);
      const segs = bySeam.get(lo) ?? [];
      segs.push({ from: mid - half, to: mid + half, pair: [a, b] });
      bySeam.set(lo, segs);
    }
  }
  const EPS = 1e-9;
  const seams: Array<readonly [Cell, Cell]> = [];
  for (const segs of bySeam.values()) {
    const beside = segs.filter((g) => g.to > from + EPS && g.from < to - EPS);
    const before = segs.filter((g) => g.to <= from + EPS).sort((x, y) => y.to - x.to)[0];
    const after = segs.filter((g) => g.from >= to - EPS).sort((x, y) => x.from - y.from)[0];
    for (const g of [before, ...beside, after]) if (g) seams.push(g.pair);
  }
  return seams;
}

/* ── the shape ── */

/** `members` on the lattice of `layout`, with the bass on the key named
 *  `bassName` nearest `ref`; null when no band position holds every member. */
export function solve(members: ReadonlyArray<Exps>, layout: ShapeLayout, bassName = 'C', ref: Cell = [0, 0]): Shape | null {
  const placed = new Map<number, Cell[]>();
  for (const [p, bass] of bassCells(bassName, layout, ref)) {
    const cells = place(bass, members, layout);
    if (cells) placed.set(p, cells);
  }
  if (!placed.size) return null;
  const positions = [...placed.keys()].sort((a, b) => a - b);
  const spine = Math.floor(4 / layoutOf(layout.mapping).c);
  const position = positions.reduce((a, b) => (Math.abs(b - spine) < Math.abs(a - spine) ? b : a));
  const cells = placed.get(position)!;
  const path = pathKeys(cells, layout);
  /* a shape that fits from any position reads the same wherever the seams fall, so it shows none */
  const anywhere = positions.length === bandWidth(layout.mapping);
  return { positions, position, bass: cells[0], cells, path, seams: anywhere ? [] : seamsAcross([...cells, ...path], layout) };
}

const THREE = ['left', 'center', 'right'];

/** Where the bass can start, in words: "left or center", "any". A band wider
 *  than three keys has no such names, so its positions are numbered from 1. */
export function positionLabel(positions: ReadonlyArray<number>, width: number): string {
  if (positions.length === width) return 'any';
  return positions.map((p) => (width === 3 ? THREE[p] : 'column ' + (p + 1))).join(' or ');
}
