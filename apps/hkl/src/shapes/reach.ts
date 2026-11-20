// Reach: how far apart the keys of a shape lie for the hands that play it
// (Max, 2026-11-19; docs/decisions.md "Evaluating layouts").
//
// A hand's keys are measured by the diameter of the smallest circle around
// their centers, in real space: a number, not a pass or fail. Real space is
// the solver's (./solve.ts, `keyDistance`): a regular hexagonal grid, the
// centers of touching keys one key width apart. Two hands take the split of
// the keys whose larger diameter is least. `MAX_REACH` is where a hand stops.
//
// Diameter alone, for now: a hand is not isotropic once a shape is
// two-dimensional (the thumb reaches some spread shapes and not others), and
// nothing here knows that.
//
// What is measured is a chord in every voicing (`voicings`): each inversion,
// closed and open. A voicing is free on the keyboard: on its own bass note in
// any octave, and where a pitch has several keys, on the set with the smallest
// diameter, which is the correct arrangement (`reach`). This is not the
// Scales page's rule, which holds a chord to root position from one key
// (./profile.ts); that page takes only its choice among repeated keys from
// here (`tightestFrom`).
//
// Pure: no DOM, so Node tools (test/shapes/) import it.

import { coordExps } from '@hkl/shared/freq.js';
import { baseKeys } from '../layout/baseKeys.js';
import { OCTAVE, addExps, centsOf, expsKey, pitchClass, subExps, type Exps } from './catalog.js';
import { keyDistance, type Cell, type ShapeLayout } from './solve.js';

/** The widest a hand reaches, in key widths: a wider set of keys is out of reach. */
export const MAX_REACH = 7;

type Point = readonly [number, number];
const SQRT3_2 = Math.sqrt(3) / 2;
/* a key's center, in key widths: (dq, dr) is √(dq² + dq·dr + dr²) long, as `keyDistance` has it */
const center = ([q, r]: Cell): Point => [q + r / 2, r * SQRT3_2];
const NEAR = 1e-9;

/** The diameter of the smallest circle around the centers of `cells`, in key
 *  widths: 0 for one key, 1 for two that touch, 2/√3 for three that touch each
 *  other. The circle stands on two of the centers or on three, so every such
 *  circle is tried. */
export function span(cells: ReadonlyArray<Cell>): number {
  const pts = cells.map(center), n = pts.length;
  if (n < 2) return 0;
  let least = Infinity;
  const tryCircle = (x: number, y: number, radius: number): void => {
    if (radius >= least) return;
    if (pts.every(([px, py]) => Math.hypot(px - x, py - y) <= radius + NEAR)) least = radius;
  };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const [ax, ay] = pts[i]!, [bx, by] = pts[j]!;
    tryCircle((ax + bx) / 2, (ay + by) / 2, Math.hypot(bx - ax, by - ay) / 2);
    for (let k = j + 1; k < n; k++) {
      const [cx, cy] = pts[k]!;
      const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (Math.abs(d) < NEAR) continue; /* in a line: no circle through all three */
      const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
      const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
      tryCircle(x, y, Math.hypot(ax - x, ay - y));
    }
  }
  return 2 * least;
}

export interface TwoHands {
  /** The larger of the two hands' diameters, in key widths. */
  span: number;
  /** Each hand's keys, the hand with the first of `cells` first. */
  hands: [Cell[], Cell[]];
}

/** `cells` shared between two hands, each taking at least one key, so that the
 *  larger hand's diameter is least; of equal splits the first found, with
 *  the smaller other hand. Null for fewer than two keys. Every split is tried:
 *  a shape has few keys. */
export function twoHands(cells: ReadonlyArray<Cell>): TwoHands | null {
  const n = cells.length;
  if (n < 2) return null;
  let best: TwoHands | null = null, other = Infinity;
  /* the first key is always the first hand's, so each split is tried once */
  for (let mask = 1; mask < 1 << (n - 1); mask++) {
    const a: Cell[] = [cells[0]!], b: Cell[] = [];
    for (let i = 1; i < n; i++) (mask & (1 << (i - 1)) ? b : a).push(cells[i]!);
    const sa = span(a), sb = span(b), larger = Math.max(sa, sb), smaller = Math.min(sa, sb);
    if (!best || larger < best.span - NEAR || (Math.abs(larger - best.span) <= NEAR && smaller < other - NEAR)) { best = { span: larger, hands: [a, b] }; other = smaller; }
  }
  return best;
}

/* ── voicings ── */

export interface Voicing {
  /** Which member of the chord is the bass: 0 is root position. */
  inversion: number;
  /** Open: every other note from the bottom, the second and the fourth, is an octave up. */
  open: boolean;
  /** The notes from the bass, the bass (a unison) first. */
  members: Exps[];
}

/** Every voicing of a chord given in root position, closed (its members
 *  ascending from the root within an octave): each inversion, closed and open
 *  (Max, 2026-11-19). A triad has six, a seventh chord eight. */
export function voicings(members: ReadonlyArray<Exps>): Voicing[] {
  const cents = members.map(centsOf);
  if (cents[0] !== 0 || cents.some((c, i) => c >= 1200 || (i > 0 && c <= cents[i - 1]!))) throw new Error('voicings: a chord must be in root position, closed');
  const out: Voicing[] = [];
  members.forEach((bass, k) => {
    const closed = [...members.slice(k), ...members.slice(0, k).map((m) => addExps(m, OCTAVE))].map((m) => subExps(m, bass));
    out.push({ inversion: k, open: false, members: closed }, { inversion: k, open: true, members: closed.map((m, i) => (i % 2 ? addExps(m, OCTAVE) : m)) });
  });
  return out;
}

/* ── the keyboard ── */

interface Board { home: Exps; ref: Cell; byPitch: Map<string, Cell[]>; found: Map<string, Reach | null> }
const boards = new Map<string, Board>();

/* the 280 keys around `ref` by the pitch they sound (layout/baseKeys.ts, as the solver lays them) */
function boardOf(layout: ShapeLayout, ref: Cell): Board {
  const key = [layout.mode, layout.mapping, layout.anchor, layout.banded, ref].join('|');
  const hit = boards.get(key);
  if (hit) return hit;
  const exps = (c: Cell): Exps => coordExps(c[0], c[1], layout.mode, layout.mapping, layout.anchor, layout.banded);
  const byPitch = new Map<string, Cell[]>();
  for (const [u, v] of baseKeys) {
    const cell: Cell = [ref[0] + u, ref[1] + v], k = expsKey(exps(cell)), at = byPitch.get(k);
    if (at) at.push(cell); else byPitch.set(k, [cell]);
  }
  const board: Board = { home: exps(ref), ref, byPitch, found: new Map() };
  boards.set(key, board);
  return board;
}

/** Forget the keyboards and results kept so far (a run over many layouts). */
export function forgetReach(): void {
  boards.clear();
}

/* ── the arrangement ── */

interface Tight { span: number; apart: number; cells: Cell[] }

/* One key from each list, with the smallest diameter; of equally small choices the one whose
   keys are closest together, by the distances between every two summed (the guide's measure of
   closeness, ./solve.ts); of those the first found. A diameter only grows as keys are added, so
   a choice already wider than the best is dropped. */
function tightest(lists: ReadonlyArray<ReadonlyArray<Cell>>): Tight {
  let best: Tight = { span: Infinity, apart: Infinity, cells: [] };
  const choose = (chosen: Cell[], apart: number): void => {
    const width = span(chosen);
    if (width > best.span + NEAR) return;
    if (chosen.length === lists.length) {
      if (width < best.span - NEAR || apart < best.apart - NEAR) best = { span: width, apart, cells: chosen };
      return;
    }
    for (const c of lists[chosen.length]!) choose([...chosen, c], apart + chosen.reduce((n, o) => n + keyDistance(o, c), 0));
  };
  choose([], 0);
  return best;
}

/** The keys of `members` above the key `start` with the smallest diameter
 *  (`members` begins with the unison, which is `start`); null when the
 *  keyboard lacks a note. What the Scales page draws of a chord whose pitches
 *  repeat (Max, 2026-11-19). */
export function tightestFrom(start: Cell, members: ReadonlyArray<Exps>, layout: ShapeLayout, ref: Cell): Cell[] | null {
  const board = boardOf(layout, ref);
  const from = coordExps(start[0], start[1], layout.mode, layout.mapping, layout.anchor, layout.banded);
  const lists: Cell[][] = [[start]];
  for (const m of members.slice(1)) {
    const at = board.byPitch.get(expsKey(addExps(from, m)));
    if (!at) return null;
    lists.push(at);
  }
  return tightest(lists).cells;
}

/* ── a voicing on a keyboard ── */

export interface Hand {
  cells: Cell[];
  /** The diameter of the smallest circle around its keys, in key widths. */
  span: number;
  /** Its width across its longest axis: its two farthest keys apart. */
  width: number;
}

export interface Reach {
  /** One hand on every key: the arrangement with the smallest diameter. */
  one: Hand;
  /** Two hands: the arrangement and the split whose larger hand is smallest, the larger hand first. */
  two: [Hand, Hand];
  /** In how many octaves the keyboard holds the voicing at all, and in how
   *  many of them it is within `MAX_REACH` for one hand, and for two. */
  octaves: number;
  within: [one: number, two: number];
}

const hand = (cells: Cell[], width: number): Hand => ({ cells, span: width, width: Math.max(0, ...cells.flatMap((a, i) => cells.slice(i + 1).map((b) => keyDistance(a, b)))) });
/* the octaves to look in, nearest the reference's first, of two equally near the lower: of equally good arrangements the first found stays */
const OCTAVES = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8];

/** A voicing on the keyboard of `layout` around `ref` (the tonic's unaltered
 *  key): `members` from the bass, and `bass` the bass note as a pitch class
 *  from the tonic. The bass may lie in any octave and each note on any of its
 *  keys; one hand takes the arrangement with the smallest diameter, and two
 *  hands the arrangement and split whose larger hand is smallest (each hand's
 *  keys chosen for itself, since nothing ties one hand's keys to the
 *  other's). Null when the keyboard holds the voicing nowhere. */
export function reach(members: ReadonlyArray<Exps>, bass: Exps, layout: ShapeLayout, ref: Cell): Reach | null {
  const board = boardOf(layout, ref), n = members.length;
  const id = [expsKey(pitchClass(bass)), ...members.map(expsKey)].join(' ');
  const hit = board.found.get(id);
  if (hit !== undefined) return hit;
  let one: Tight | null = null, two: [Tight, Tight] | null = null, octaves = 0;
  const within: [number, number] = [0, 0];
  for (const octave of OCTAVES) {
    const from = addExps(addExps(board.home, pitchClass(bass)), [octave, 0, 0, 0]);
    const lists = members.map((m) => board.byPitch.get(expsKey(addExps(from, m))));
    if (lists.some((l) => !l)) continue;
    octaves++;
    /* the tightest keys of each set of notes, by its bits */
    const sets = new Map<number, Tight>();
    const of = (mask: number): Tight => {
      let t = sets.get(mask);
      if (!t) { t = tightest(lists.filter((_, i) => mask & (1 << i)) as Cell[][]); sets.set(mask, t); }
      return t;
    };
    const all = (1 << n) - 1, whole = of(all);
    if (!one || whole.span < one.span - NEAR) one = whole;
    if (whole.span <= MAX_REACH + NEAR) within[0]++;
    let here: [Tight, Tight] | null = null;
    /* the bass is always the first hand's, so each split is tried once */
    for (let mask = 1; mask < all; mask += 2) {
      const a = of(mask), b = of(all ^ mask), pair: [Tight, Tight] = a.span >= b.span ? [a, b] : [b, a];
      if (!here || pair[0].span < here[0].span - NEAR || (Math.abs(pair[0].span - here[0].span) <= NEAR && pair[1].span < here[1].span - NEAR)) here = pair;
    }
    if (here) {
      if (!two || here[0].span < two[0].span - NEAR || (Math.abs(here[0].span - two[0].span) <= NEAR && here[1].span < two[1].span - NEAR)) two = here;
      if (here[0].span <= MAX_REACH + NEAR) within[1]++;
    }
  }
  const out: Reach | null = one && two ? { one: hand(one.cells, one.span), two: [hand(two[0].cells, two[0].span), hand(two[1].cells, two[1].span)], octaves, within } : null;
  board.found.set(id, out);
  return out;
}
