// Where a structure's keys sit on the lattice, for the shape guide.
//
// A structure (./catalog.ts) is exact ratios from its bass. Under a layout — a
// mapping, a JI tuning mode, banded or not — the solver finds the cells that
// sound those ratios exactly (coordExps):
//   - the keyboard: what a shape may use is a Lumatone's 280 keys, set down
//     with the reference on the starting note's unaltered key (`keyboard`);
//     all its notes, and the path between them, lie on it (Max, 2026-11-19);
//   - the bass: any key of that keyboard, whatever its name (Max, 2026-11-19):
//     a shape is in the guide when the keyboard holds it from anywhere, not
//     only from the starting note. Basses differ in their band position, in
//     the comma marks they carry (C, C↓, a hooked C) and, in the modes that
//     tune each band differently, in what they hold. The plainest that holds
//     the structure is the one drawn (Max, 2026-11-18);
//   - the arrangement: where a pitch has several keys, the one nearest the bass,
//     and of the arrangements the plainest basses give, the closest one. That
//     one is the shape; a farther copy of it is not shown. Of the basses that
//     hold it as close, the one whose note is nearest the starting note by
//     fifths: the starting note itself wherever it can be;
//   - the positions the shape can start from: those where the same keys, moved
//     with any bass of that position, lie on the keyboard and sound the same
//     members;
//   - the path keys that link the members;
//   - the band seams the shape crosses.
// A choice between different keys that the rules leave equal goes to the one
// higher on the page; a choice between two equally plain basses for one shape,
// to the one that writes the shape with the fewest HEJI arrows, then to the
// one nearest the reference (Max, 2026-11-18 and -19). What even those cannot
// tell apart is listed in the shape's `undecided`; on one keyboard nothing is.
// Nothing here is specific to one mapping or mode: it searches the lattice the
// layout defines. Equal has no exponent vectors, so it is not solved.
//
// Pure: no DOM and no state, so the Node oracle (test/shapes/) imports it.

import { coordExps, coordToMidi, freqAt } from '@hkl/shared/freq.js';
import { hejiCommasFor } from '@hkl/shared/heji.js';
import { bandOfCell, bandWidth, layoutOf, posInBandOf } from '@hkl/shared/mapping.js';
import { baseKeys } from '../layout/baseKeys.js';
import { fifthIndex, noteName } from '@hkl/shared/notes.js';
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

/* ── the keyboard, and the basses on it ── */

interface Bass {
  position: number;
  /** The comma marks on the key itself. */
  marks: number;
  /** How many fifths its note is from the starting note, by name (a C↓ is a C). */
  fifths: number;
  cell: Cell;
  /** How near `ref`: its distance, then its distance in pitch (MIDI), then its
   *  pitch, then how high it stands on the page (higher first); compared in
   *  that order. */
  near: readonly [number, number, number, number];
}
const nearer = (a: Bass, b: Bass): number => a.near[0] - b.near[0] || a.near[1] - b.near[1] || a.near[2] - b.near[2] || a.near[3] - b.near[3];

/** A Lumatone set down on the lattice: its 280 keys, each as a bass a shape
 *  may start from, and its keys by pitch. */
interface Keyboard {
  center: Cell;
  cells: ReadonlyArray<Cell>;
  /** A key's number, by its place; and for each key the numbers of the keys it touches. */
  at: ReadonlyMap<string, number>;
  links: ReadonlyArray<ReadonlyArray<number>>;
  has: ReadonlySet<string>;
  basses: Bass[];
  byPitch: Map<string, Cell[]>;
}
const keyboardCache = new Map<string, Keyboard>();

/** The keyboard a guide's shapes are played on (Max, 2026-11-19). What a
 *  layout holds is what a Lumatone holds: a shape is in a guide when all its
 *  notes, and the path between them, lie on the instrument's 280 keys. A key's
 *  place on the lattice is its offset from the reference (layout/baseKeys.ts;
 *  in Vertical alignment, the guide's pose, the offset as it stands), and the
 *  reference sits at the keyboard's center. The reference is the starting
 *  note's unaltered key (`ref`, where Composer puts a key's reference), so a
 *  starting note, a mapping and a tuning have exactly one set of 280 keys, and
 *  every shape of their guide is drawn on it.
 *
 *  This replaces a window of four bands and nine rows around each bass, which
 *  was arbitrary, and wider or narrower as the bands were (3 keys to 12). */
function keyboard(name: string, layout: ShapeLayout, ref: Cell): Keyboard {
  const key = [layoutKey(layout), name, ref].join('|');
  const hit = keyboardCache.get(key);
  if (hit) return hit;
  const { mapping, anchor, banded } = layout;
  const refMidi = coordToMidi(ref[0], ref[1], mapping);
  const cells: Cell[] = baseKeys.map(([u, v]) => [ref[0] + u, ref[1] + v]);
  const byPitch = new Map<string, Cell[]>(), basses: Bass[] = [], home = fifthIndex(name);
  for (const cell of cells) {
    const k = expsKey(exps(cell, layout)), at = byPitch.get(k);
    if (at) at.push(cell); else byPitch.set(k, [cell]);
    const midi = coordToMidi(cell[0], cell[1], mapping);
    basses.push({
      position: posInBandOf(cell[0], cell[1], mapping), marks: marksOn(cell, layout),
      fifths: Math.abs(fifthIndex(noteName(cell[0], cell[1], mapping, anchor, banded)) - home),
      cell, near: [hexDistance(ref, cell), Math.abs(midi - refMidi), midi, -height(cell)],
    });
  }
  const at = new Map(cells.map((c, i) => [String(c), i]));
  const links = cells.map(([q, r]) => AROUND.map(([dq, dr]) => at.get(`${q + dq},${r + dr}`)).filter((i): i is number => i !== undefined));
  const board: Keyboard = { center: ref, cells, at, links, has: new Set(cells.map(String)), basses, byPitch };
  keyboardCache.set(key, board);
  return board;
}

/** Forget the keyboards laid down so far. The solver keeps one for every
 *  reference it has solved from; a page solves from one reference and never
 *  needs this, but a run over many (the roots gate) should not hold them all. */
export function forgetShapes(): void {
  keyboardCache.clear();
}

/* ── the members ── */

/** The keys of `board` sounding `members` above `bass`, or null when one is
 *  not on it. Where a pitch has several keys, the one nearest the bass, in real
 *  space; where several are equally near, the choice that keeps the members
 *  closest together, by the distances between every two of them summed; of
 *  equally close choices, the one higher on the page, by its keys' heights
 *  summed (`tied` when even that is equal). */
function place(bass: Cell, members: ReadonlyArray<Exps>, layout: ShapeLayout, board: Keyboard): { cells: Cell[]; tied: boolean } | null {
  const index = board.byPitch, from = exps(bass, layout);
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

/* The six neighbors of a key. */
const AROUND: ReadonlyArray<Cell> = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
/* A path key costs UNIT, less one for every member it touches: the fewest keys first, then the
   most edges between a path key and a member (a key touches six keys at most). */
const UNIT = 4096;

/** The path keys (Max, 2026-11-17 and -19): the keys a player follows from one
 *  note of the shape to the next. They are keys of the keyboard, the fewest
 *  that join the members into one connected patch; of equally small sets, the
 *  one whose path keys touch the members along the most edges, which keeps
 *  the shape compact; of those, the highest: by its highest key in pitch, then
 *  its next (two keys of one pitch by the higher on the page). Returned low
 *  to high.
 *
 *  Between two members that is a shortest walk which turns once, through its
 *  higher corner, wherever the keyboard has room for it: the rule this
 *  replaced asked for one-turn walks outright, and could leave the keyboard.
 *
 *  A smallest connecting set is a Steiner tree, found the classical way
 *  (Dreyfus and Wagner): the best tree over each group of members ending at
 *  each key, built up from smaller groups. Members that already touch are one
 *  to begin with, so a chord or a scale is seldom more than three groups. */
function pathKeys(cells: ReadonlyArray<Cell>, layout: ShapeLayout, board: Keyboard): { keys: Cell[]; tied: boolean } {
  const n = board.cells.length;
  const isMember = new Uint8Array(n);
  const members = cells.map((c) => board.at.get(String(c))!);
  for (const m of members) isMember[m] = 1;
  /* the members in touching groups */
  const group = new Int32Array(n).fill(-1);
  let groups = 0;
  for (const m of members) {
    if (group[m] >= 0) continue;
    const stack = [m];
    group[m] = groups;
    while (stack.length) for (const u of board.links[stack.pop()!]) if (isMember[u] && group[u] < 0) { group[u] = groups; stack.push(u); }
    groups++;
  }
  if (groups === 1) return { keys: [], tied: false };
  /* what a key costs, and its place from the highest down */
  const weight = new Int32Array(n);
  for (let v = 0; v < n; v++) if (!isMember[v]) weight[v] = UNIT - board.links[v].reduce((t, u) => t + isMember[u], 0);
  const pitch = (v: number): number => freqAt(board.cells[v][0], board.cells[v][1], layout.mode, layout.mapping, layout.anchor, layout.banded);
  const pitchKey = board.cells.map((c) => expsKey(exps(c, layout)));
  const order = [...Array(n).keys()].sort((a, b) => (pitchKey[a] === pitchKey[b] ? 0 : pitch(b) - pitch(a)) || height(board.cells[b]) - height(board.cells[a]) || a - b);
  const rank = new Int32Array(n);
  order.forEach((v, i) => { rank[v] = i; });
  /* a tree's path keys as their ranks, ascending: of two as long, the one that reads lower first is higher */
  const higher = (a: number[], b: number[]): number => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const joined = (a: number[], b: number[], shared: number): number[] => {
    const out: number[] = [];
    let i = 0, j = 0, dropped = shared < 0;
    while (i < a.length || j < b.length) {
      const x = j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i++] : b[j++];
      if (!dropped && x === shared) { dropped = true; continue; }
      out.push(x);
    }
    return out;
  };
  const withKey = (a: number[], r: number): number[] => { const i = a.findIndex((x) => x > r); return i < 0 ? [...a, r] : [...a.slice(0, i), r, ...a.slice(i)]; };
  const FAR = 0x3fffffff, FULL = (1 << groups) - 1;
  const cost: Int32Array[] = [], keys: Array<Array<number[] | null>> = [];
  for (let S = 1; S <= FULL; S++) {
    const c = new Int32Array(n).fill(FAR), k: Array<number[] | null> = new Array(n).fill(null);
    cost[S] = c; keys[S] = k;
    if ((S & (S - 1)) === 0) {
      /* one group: its members cost nothing */
      const g = Math.log2(S);
      for (const m of members) if (group[m] === g) { c[m] = 0; k[m] = []; }
    } else {
      /* two smaller trees meeting at v; the key v, if it is a path key, is in both */
      const low = S & -S;
      for (let v = 0; v < n; v++) for (let A = (S - 1) & S; A > 0; A = (A - 1) & S) {
        if (!(A & low)) continue;
        const B = S ^ A, ca = cost[A][v], cb = cost[B][v];
        if (ca === FAR || cb === FAR) continue;
        const total = ca + cb - weight[v];
        if (total > c[v]) continue;
        const made = joined(keys[A][v]!, keys[B][v]!, isMember[v] ? -1 : rank[v]);
        if (total < c[v] || higher(made, k[v]!) < 0) { c[v] = total; k[v] = made; }
      }
    }
    /* and out from there, a key at a time */
    const queue: number[] = [];
    for (let v = 0; v < n; v++) if (c[v] !== FAR) queue.push(v);
    for (let at = 0; at < queue.length; at++) {
      const v = queue[at];
      for (const u of board.links[v]) {
        const total = c[v] + weight[u];
        if (total > c[u]) continue;
        const made = isMember[u] ? k[v]! : withKey(k[v]!, rank[u]);
        if (total < c[u] || higher(made, k[u]!) < 0) { c[u] = total; k[u] = made; queue.push(u); }
      }
    }
  }
  const best = keys[FULL][members[0]]!;
  return { keys: best.map((r) => board.cells[order[r]]).reverse(), tied: false };
}

/* ── the seams ── */

/* The lattice's three straight axes: Q, R and the composed X = (−Q, +R). */
const Q: Cell = [1, 0], R: Cell = [0, 1], X: Cell = [-1, 1];

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

/* A seam looks only at the keys beside it: those in this many columns on either side. */
const BESIDE = 2;

/** The seams between the bands `keys` occupy: none when they sit in one band.
 *  A seam runs along the layout's pure line, which is the R axis on an
 *  unsheared layout. Each seam is as long as the keys beside it need (Max,
 *  2026-11-19): it covers the reach along that line of the keys in the two
 *  columns on either side of it, and one segment past that at either end. The
 *  keys farther off do not lengthen it, so a long shape is no taller than its
 *  keys, and the seams of one shape need not start or end level. The reach is
 *  measured square to the line. */
export function seamsAcross(keys: ReadonlyArray<Cell>, layout: ShapeLayout): Array<readonly [Cell, Cell]> {
  const band = (c: Cell): number => bandOfCell(c[0], c[1], layout.mapping);
  const column = (c: Cell): number => posInBandOf(c[0], c[1], layout.mapping);
  const width = bandWidth(layout.mapping);
  const bands = keys.map(band), bLo = Math.min(...bands), bHi = Math.max(...bands);
  if (bLo === bHi) return [];
  /* position along the seams' direction */
  const { c, s } = layoutOf(layout.mapping);
  const [dx, dy] = place2d([-s / c, 1]), len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
  const along = (x: number, y: number): number => x * ux + y * uy;
  const reach = keyReach(ux, uy);
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
  for (const [lo, segs] of bySeam) {
    /* the keys beside this seam: the last two columns of the band before it, the first two of the band after */
    const near = keys.filter((k) => (band(k) === lo && column(k) >= width - BESIDE) || (band(k) === lo + 1 && column(k) < BESIDE));
    if (!near.length) continue;
    const centers = near.map((k) => along(...place2d(k)));
    const from = Math.min(...centers) - reach, to = Math.max(...centers) + reach;
    const beside = segs.filter((g) => g.to > from + EPS && g.from < to - EPS);
    const before = segs.filter((g) => g.to <= from + EPS).sort((x, y) => y.to - x.to)[0];
    const after = segs.filter((g) => g.from >= to - EPS).sort((x, y) => x.from - y.from)[0];
    for (const g of [before, ...beside, after]) if (g) seams.push(g.pair);
  }
  return seams;
}

/* ── the shape ── */

/** `members` on the keyboard of `layout` whose reference `ref` is the
 *  unaltered key of the starting note `root`; null when no key of it holds
 *  every member.
 *
 *  Every key of the keyboard is tried as the bass, whatever its name (Max,
 *  2026-11-19: in the key of C a diminished seventh is wanted on B or F♯, not
 *  on C, and an isomorphic shape starts from any column it fits). The one
 *  drawn is chosen in this order (Max, 2026-11-17 to -19):
 *   1. the closest arrangement, whatever its bass: where pitches repeat,
 *      basses hold the members on different keys, and the one whose keys lie
 *      nearest its bass, by their distances in real space summed
 *      (`keyDistance`), is the shape;
 *   2. of equally close ones, the plainest: the fewest comma marks on the
 *      bass itself, so a plain key before one with an arrow or a hook;
 *   3. the bass whose note is nearest `root` by fifths, by name: C, then G or
 *      F, then D or B♭. Closeness comes first; among equally close shapes
 *      the starting note itself is drawn wherever it holds one;
 *   4. the one from nearest the band's spine column;
 *   5. the one that stands higher above its bass on the page;
 *   6. the one that writes the shape with the fewest HEJI arrows: the
 *      syntonic arrows on the members' labels, summed (septimal hooks and the
 *      path keys' labels do not count);
 *   7. the one nearest `ref`: by its distance, then in pitch, then the lower,
 *      then the higher on the page. It settles the octaves of one column;
 *   8. the left one, which no ruling stands behind (`undecided`).
 *
 *  With `start`, the bass is not free: it is that key (a scale of a key runs
 *  from the reference key, and a chord of the key starts on its root's key:
 *  ./profile.ts). Nothing is then left to choose but the members' keys, and
 *  the one position is that key's. With `keys` as well those are given too,
 *  the bass first (the Scales page draws a chord on the keys with the
 *  smallest diameter: ./reach.ts), and only the path and the seams are found.
 *
 *  Closeness comes before plainness (Max, 2026-11-19). It was the other way
 *  round from 2026-11-18, when a plain bass cost at most 0.54 key widths
 *  summed over a shape, in 9 shapes, all Syntonic. Septimal's copy rule
 *  (packages/shared/src/freq.ts) put marked keys beside plain ones on the wider
 *  bands, and there a plain bass cost up to 11.53 in 54 shapes
 *  (test/shapes/oracle.mjs pins what a plain bass would now cost). */
export function solve(members: ReadonlyArray<Exps>, layout: ShapeLayout, root = 'C', ref: Cell = [0, 0], start?: Cell, keys?: ReadonlyArray<Cell>): Shape | null {
  const board = keyboard(root, layout, ref);
  const basses = start ? board.basses.filter((b) => b.cell[0] === start[0] && b.cell[1] === start[1]) : board.basses;
  interface Placed extends Bass { cells: Cell[]; keysTied: boolean; spread: number; rise: number; arrows: number; offsets: string }
  const arrowsOn = (c: Cell): number => Math.abs(hejiCommasFor(layout.mode, c[0], c[1], layout.mapping, layout.anchor, layout.banded).syn5);
  /* every bass on the keyboard, with the members on the keyboard's keys */
  const placed: Placed[] = [];
  for (const bass of basses) {
    const at = start && keys ? { cells: [...keys], tied: false } : place(bass.cell, members, layout, board);
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
  placed.sort((a, b) => a.position - b.position || nearer(a, b));
  const spine = Math.floor(4 / layoutOf(layout.mapping).c);
  /* x against y, by rules 1 to 7 (one shape stands as high from any bass, so 5 never parts it) */
  const better = (x: Placed, y: Placed): number =>
    byLength(y.spread, x.spread) || y.marks - x.marks || y.fifths - x.fifths
    || Math.abs(y.position - spine) - Math.abs(x.position - spine) || x.rise - y.rise || y.arrows - x.arrows || nearer(y, x);
  /* `placed` runs left to right: of equals the left one stays */
  const drawn = placed.reduce((a, b) => (better(b, a) > 0 ? b : a));
  const { cells, position } = drawn;
  const undecided: Shape['undecided'] = [];
  const level = placed.filter((x) => x !== drawn && better(x, drawn) === 0);
  if (level.some((x) => x.position === position && x.offsets === drawn.offsets)) undecided.push('bass');
  if (drawn.keysTied) undecided.push('keys');
  if (level.some((x) => x.offsets !== drawn.offsets)) undecided.push('position');
  if (level.some((x) => x.position !== position && x.offsets === drawn.offsets)) undecided.push('column');
  /* the positions this shape starts from: where the same keys, moved with a bass of that
     position, lie on its keyboard and sound the same members */
  const holds = (bass: Cell): boolean => {
    const from = exps(bass, layout);
    return members.every((m, i) => {
      const at: Cell = [bass[0] + cells[i][0] - cells[0][0], bass[1] + cells[i][1] - cells[0][1]];
      return board.has.has(String(at)) && expsKey(exps(at, layout)) === expsKey(addExps(from, m));
    });
  };
  const positions = [...new Set(basses.filter((b) => holds(b.cell)).map((b) => b.position))].sort((a, b) => a - b);
  const { keys: path, tied: pathTied } = pathKeys(cells, layout, board);
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
