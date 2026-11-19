// Where a structure's keys sit on the lattice, for the shape guide.
//
// A structure (./catalog.ts) is exact ratios from its bass. Under a layout — a
// mapping, a JI tuning mode, banded or not — the solver finds the cells that
// sound those ratios exactly (coordExps):
//   - the bass: a key of the given name. Every such key in reach of the
//     reference is tried: they differ in their band position, in the comma
//     marks they carry (C, C↓, a hooked C) and, in the modes that tune each
//     band differently, in what they hold. The plainest that holds the
//     structure is the one drawn (Max, 2026-11-18);
//   - the arrangement: where a pitch has several keys, the one nearest the bass,
//     and of the arrangements the plainest basses give, the closest one. That
//     one is the shape; a farther copy of it is not shown;
//   - the positions the shape can start from: those where the same keys, moved
//     with a bass of that position, sound the same members;
//   - the path keys that link the members;
//   - the band seams the shape crosses.
// A choice between different keys that the rules leave equal goes to the one
// higher on the page; a choice between two equally plain basses for one shape,
// to the one that writes the shape with the fewest HEJI arrows (Max,
// 2026-11-18). What even those cannot tell apart is listed in the shape's
// `undecided`.
// Nothing here is specific to one mapping or mode: it searches the lattice the
// layout defines. Equal has no exponent vectors, so it is not solved.
//
// Pure: no DOM and no state, so the Node oracle (test/shapes/) imports it.

import { coordExps, coordToMidi, freqAt } from '@hkl/shared/freq.js';
import { hejiCommasFor } from '@hkl/shared/heji.js';
import { bandOfCell, bandWidth, layoutOf, posInBandOf } from '@hkl/shared/mapping.js';
import { noteName } from '@hkl/shared/notes.js';
import type { TuningStateLike } from '../tuning/regions.js';
import { addExps, expsKey, type Exps } from './catalog.js';

export type Cell = readonly [number, number];
/** The layout a shape is solved in. */
export type ShapeLayout = Pick<TuningStateLike, 'mode' | 'mapping' | 'anchor' | 'banded'>;

export interface Shape {
  /** Every band position this shape can start from, ascending (0 = leftmost):
   *  where these keys, moved with a bass of that position, sound the members,
   *  whatever marks that bass carries. A position that holds the members only
   *  on other, farther keys is not one of them. */
  positions: number[];
  /** The position drawn: the one of the bass. */
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
  /** The choices no rule decided, which fell to the order the lattice is
   *  scanned in; empty for a shape the rules decide in full. "bass": two
   *  basses of one position hold the shape alike and are as near the
   *  reference. "keys": two choices of equally near keys tie. "position": two equally plain basses hold
   *  different, equally close arrangements. "column": the shape starts from
   *  two equally plain basses, in columns equally near the spine column, that
   *  write it with as many HEJI arrows; it is drawn from the left one. "path":
   *  two sets of path keys tie. */
  undecided: Array<'bass' | 'keys' | 'position' | 'column' | 'path'>;
}

/** How far the search reaches from a key: in bands along q, in rows along r. */
const REACH_BANDS = 4;
const REACH_ROWS = 9;

/** How many key steps apart two keys are. */
export function hexDistance(a: Cell, b: Cell): number {
  const dq = b[0] - a[0], dr = b[1] - a[1];
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}

/* How close a shape is, is measured in real space, not in key steps (Max,
   2026-11-18): two keys seven steps apart are nearer when the walk between
   them turns after three steps than when it turns after six. The lattice is
   taken as a regular hexagonal grid, keys one key width apart, so (dq, dr) is
   √(dq² + dq·dr + dr²) key widths long. The square is a whole number, which
   compares two distances exactly; sums of distances are compared to within
   NEAR. */
const distance2 = (a: Cell, b: Cell): number => {
  const dq = b[0] - a[0], dr = b[1] - a[1];
  return dq * dq + dq * dr + dr * dr;
};
/** The distance between two keys in real space, in key widths. */
export const keyDistance = (a: Cell, b: Cell): number => Math.sqrt(distance2(a, b));
const NEAR = 1e-9;
/** a against b as lengths: 0 when they are the same length. */
const byLength = (a: number, b: number): number => (Math.abs(a - b) < NEAR ? 0 : a - b);

/* Higher on the page. The guide is drawn in the Lumatone rotation at Vertical
   alignment (GUIDE_ROTATION, GUIDE_ALIGNMENT; ./page.ts sets them), which
   lays the Lumatone's case row, the step (+7, −2), level. A key's height on
   the page is then in proportion to its cross product with that step,
   2q + 7r: a whole number, so two keys compare exactly. Two keys are level
   only when they are whole case-row steps apart. */
export const GUIDE_ROTATION = 'lumatone', GUIDE_ALIGNMENT = 'vertical';
const LEVEL: Cell = [7, -2];
const height = (c: Cell): number => LEVEL[0] * c[1] - LEVEL[1] * c[0];
const heights = (cells: ReadonlyArray<Cell>): number => cells.reduce((n, c) => n + height(c), 0);

/** The comma marks a key's label carries: its syntonic arrows and its
 *  septimal hooks. None on a key of the Pythagorean chain from the reference. */
function marksOn(c: Cell, l: ShapeLayout): number {
  const h = hejiCommasFor(l.mode, c[0], c[1], l.mapping, l.anchor, l.banded);
  return Math.abs(h.syn5) + Math.abs(h.sept7);
}

const layoutKey = (l: ShapeLayout): string => [l.mode, l.mapping, l.anchor, l.banded].join('|');
const exps = (c: Cell, l: ShapeLayout): Exps => coordExps(c[0], c[1], l.mode, l.mapping, l.anchor, l.banded);

/* ── the bass ── */

interface Bass {
  position: number;
  /** The comma marks on the key itself. */
  marks: number;
  cell: Cell;
  /** How near `ref`: its distance, then its distance in pitch (MIDI), then its
   *  pitch, then how high it stands on the page (higher first); compared in
   *  that order. */
  near: readonly [number, number, number, number];
}
const nearer = (a: Bass, b: Bass): number => a.near[0] - b.near[0] || a.near[1] - b.near[1] || a.near[2] - b.near[2] || a.near[3] - b.near[3];
const bassCache = new Map<string, Bass[]>();

/** The keys a shape may start from: every key named `name` in reach of `ref`.
 *  In most modes those of one band position are the same key an octave or a
 *  band apart, and hold the same shapes; Syntonic and Polysyntonic shift each
 *  band by commas, so there they differ in their marks and in what they hold.
 *  By position, then nearest `ref` first. */
function bassCells(name: string, layout: ShapeLayout, ref: Cell): Bass[] {
  const key = [layoutKey(layout), name, ref].join('|');
  const hit = bassCache.get(key);
  if (hit) return hit;
  const { mapping, anchor, banded } = layout;
  const refMidi = coordToMidi(ref[0], ref[1], mapping);
  const basses: Bass[] = [];
  const reachQ = REACH_BANDS * bandWidth(mapping);
  for (let q = ref[0] - reachQ; q <= ref[0] + reachQ; q++) for (let r = ref[1] - REACH_ROWS; r <= ref[1] + REACH_ROWS; r++) {
    if (noteName(q, r, mapping, anchor, banded) !== name) continue;
    const cell: Cell = [q, r], midi = coordToMidi(q, r, mapping);
    basses.push({ position: posInBandOf(q, r, mapping), marks: marksOn(cell, layout), cell, near: [hexDistance(ref, cell), Math.abs(midi - refMidi), midi, -height(cell)] });
  }
  basses.sort((a, b) => a.position - b.position || nearer(a, b));
  bassCache.set(key, basses);
  return basses;
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
 *  lattice. Where a pitch has several keys, the one nearest the bass, in real
 *  space; where several are equally near, the choice that keeps the members
 *  closest together, by the distances between every two of them summed; of
 *  equally close choices, the one higher on the page, by its keys' heights
 *  summed (`tied` when even that is equal). */
function place(bass: Cell, members: ReadonlyArray<Exps>, layout: ShapeLayout): { cells: Cell[]; tied: boolean } | null {
  const index = pitchIndex(bass, layout), from = exps(bass, layout);
  const nearest: Cell[][] = [];
  for (const m of members) {
    const at = index.get(expsKey(addExps(from, m)));
    if (!at) return null;
    const d = Math.min(...at.map((c) => distance2(bass, c)));
    nearest.push(at.filter((c) => distance2(bass, c) === d));
  }
  if (nearest.every((n) => n.length === 1)) return { cells: nearest.map((n) => n[0]), tied: false };
  let best: Cell[] = [], least = Infinity, top = -Infinity, tied = false;
  const choose = (chosen: Cell[], apart: number): void => {
    if (byLength(apart, least) > 0) return;
    if (chosen.length === nearest.length) {
      const up = heights(chosen);
      if (byLength(apart, least) < 0 || up > top) { best = chosen; least = apart; top = up; tied = false; } else if (up === top) tied = true;
      return;
    }
    for (const c of nearest[chosen.length]) choose([...chosen, c], apart + chosen.reduce((n, o) => n + keyDistance(o, c), 0));
  };
  choose([], 0);
  return { cells: best, tied };
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
 *  by its highest key and then its next; of sets alike in pitch (where
 *  pitches repeat), the one higher on the page, by its keys' heights summed
 *  (`tied` when even that is equal). Returned low to high. */
function pathKeys(cells: ReadonlyArray<Cell>, layout: ShapeLayout): { keys: Cell[]; tied: boolean } {
  const pitch = (c: Cell): number => freqAt(c[0], c[1], layout.mode, layout.mapping, layout.anchor, layout.banded);
  /* a against b in pitch: 0 for two keys of one pitch, exactly (their frequencies may round apart) */
  const byPitch = (a: Cell, b: Cell): number => (expsKey(exps(a, layout)) === expsKey(exps(b, layout)) ? 0 : pitch(a) - pitch(b));
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
  /* of equally small sets: the most edges between a path key and a member, then the highest in
     pitch, then the higher on the page */
  const touches = (set: ReadonlySet<string>): number => {
    let n = 0;
    for (const k of set) for (const m of cells) if (hexDistance(cellOf.get(k)!, m) === 1) n++;
    return n;
  };
  const most = Math.max(...smallest.map(touches));
  const highFirst = smallest.filter((set) => touches(set) === most)
    .map((set) => [...set].map((k) => cellOf.get(k)!).sort((a, b) => byPitch(b, a) || height(b) - height(a)));
  const over = (x: Cell[], y: Cell[]): number => {
    for (let i = 0; i < x.length; i++) { const d = byPitch(x[i], y[i]); if (d) return d; }
    return heights(x) - heights(y);
  };
  let best = highFirst[0], tied = false;
  for (const set of highFirst.slice(1)) {
    const d = over(set, best);
    if (d > 0) { best = set; tied = false; } else if (d === 0) tied = true;
  }
  return { keys: best.slice().reverse(), tied };
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

/** `members` on the lattice of `layout`, with the bass on a key named
 *  `bassName` near `ref`; null when no such key holds every member.
 *
 *  Every key named `bassName` in reach is tried, and the one drawn is chosen
 *  in this order (Max, 2026-11-17 and -18):
 *   1. the plainest: the fewest comma marks on the bass itself, so a plain C
 *      before a C↓ or a hooked C, wherever a plain one holds the structure;
 *   2. the closest arrangement: where pitches repeat, basses hold the members
 *      on different keys, and the one whose keys lie nearest its bass, by
 *      their distances in real space summed (`keyDistance`), is the shape;
 *   3. the one from nearest the band's spine column;
 *   4. the one that stands higher above its bass on the page;
 *   5. the one that writes the shape with the fewest HEJI arrows: the
 *      syntonic arrows on the members' labels, summed (septimal hooks and the
 *      path keys' labels do not count). This is what tells two columns apart
 *      for one shape;
 *   6. the left one, which no ruling stands behind (`undecided`).
 *  Basses of one position that hold the shape alike are the same shape in
 *  another octave or band: of those, the one nearest `ref`.
 *
 *  Rule 1 stands before rule 2 (Max, 2026-11-18): the plain C is the example
 *  even where a marked one would hold the shape a little nearer. Over the 48
 *  layouts the gate runs that happens in 7 shapes, all in Syntonic, by at most
 *  0.54 key widths summed over the shape (test/shapes/oracle.mjs pins them). */
export function solve(members: ReadonlyArray<Exps>, layout: ShapeLayout, bassName = 'C', ref: Cell = [0, 0]): Shape | null {
  const basses = bassCells(bassName, layout, ref);
  interface Placed extends Bass { cells: Cell[]; keysTied: boolean; spread: number; rise: number; arrows: number; offsets: string }
  const arrowsOn = (c: Cell): number => Math.abs(hejiCommasFor(layout.mode, c[0], c[1], layout.mapping, layout.anchor, layout.banded).syn5);
  const placed: Placed[] = [];
  for (const bass of basses) {
    const at = place(bass.cell, members, layout);
    if (!at) continue;
    placed.push({
      ...bass, cells: at.cells, keysTied: at.tied,
      spread: at.cells.reduce((n, c) => n + keyDistance(bass.cell, c), 0),
      rise: heights(at.cells) - at.cells.length * height(bass.cell),
      arrows: at.cells.reduce((n, c) => n + arrowsOn(c), 0),
      offsets: at.cells.map((c) => [c[0] - bass.cell[0], c[1] - bass.cell[1]]).join(' '),
    });
  }
  if (!placed.length) return null;
  const spine = Math.floor(4 / layoutOf(layout.mapping).c);
  /* x against y, by rules 1 to 5 (one shape stands as high from any bass, so 4 never parts it) */
  const better = (x: Placed, y: Placed): number =>
    y.marks - x.marks || byLength(y.spread, x.spread) || Math.abs(y.position - spine) - Math.abs(x.position - spine) || x.rise - y.rise || y.arrows - x.arrows;
  /* `placed` runs left to right and, within a position, from nearest `ref`: of equals the first stays */
  const drawn = placed.reduce((a, b) => (better(b, a) > 0 ? b : a));
  const { cells, position } = drawn;
  const undecided: Shape['undecided'] = [];
  const level = placed.filter((x) => x !== drawn && better(x, drawn) === 0);
  if (level.some((x) => x.position === position && x.offsets === drawn.offsets && nearer(x, drawn) === 0)) undecided.push('bass');
  if (drawn.keysTied) undecided.push('keys');
  if (level.some((x) => x.offsets !== drawn.offsets)) undecided.push('position');
  if (level.some((x) => x.position !== position && x.offsets === drawn.offsets)) undecided.push('column');
  /* the positions this shape starts from: where the same keys, moved with a bass of that
     position, sound the same members */
  const holds = (bass: Cell): boolean => {
    const from = exps(bass, layout);
    return members.every((m, i) => {
      const at: Cell = [bass[0] + cells[i][0] - cells[0][0], bass[1] + cells[i][1] - cells[0][1]];
      return expsKey(exps(at, layout)) === expsKey(addExps(from, m));
    });
  };
  const positions = [...new Set(basses.filter((b) => holds(b.cell)).map((b) => b.position))].sort((a, b) => a - b);
  const { keys: path, tied: pathTied } = pathKeys(cells, layout);
  if (pathTied) undecided.push('path');
  /* a shape that fits from any position reads the same wherever the seams fall, so it shows none */
  const anywhere = positions.length === bandWidth(layout.mapping);
  return { positions, position, bass: cells[0], cells, path, seams: anywhere ? [] : seamsAcross([...cells, ...path], layout), undecided };
}

const THREE = ['left', 'center', 'right'];

/** Where the bass can start, in words: "left or center", "any". A band of
 *  another width has no such names, so its columns are numbered from 1:
 *  "column 3 or 4 or 5". */
export function positionLabel(positions: ReadonlyArray<number>, width: number): string {
  if (positions.length === width) return 'any';
  return width === 3 ? positions.map((p) => THREE[p]).join(' or ') : 'column ' + positions.map((p) => p + 1).join(' or ');
}
