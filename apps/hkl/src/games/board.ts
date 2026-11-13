// The Lumatone as a game board: its 280 keys by index, with the neighbors, edges
// and halves a game needs. Pure data derived from baseKeys (physical offsets
// (u, v), index = board group × 56 + key), so it is the same under every
// alignment, mapping and reference note: a game lives on the physical keys, and
// the lattice under them only supplies colors and notes.

import { baseKeys } from '../layout/baseKeys.js';

export const KEY_COUNT = baseKeys.length;

/** The six directions on the board, as (u, v) steps, counter-clockwise starting
 *  along the key row (+v is up on the canvas). Turning clockwise is one place
 *  back in this ring, counter-clockwise one place forward. */
export const HEADINGS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1],
];

const indexAt = new Map<string, number>();
baseKeys.forEach(([u, v], i) => { indexAt.set(u + ',' + v, i); });

/** Index of the key at physical offset (u, v), or −1 where the board has none. */
export function keyAt(u: number, v: number): number {
  return indexAt.get(u + ',' + v) ?? -1;
}

/** Physical offset (u, v) of key `i`. */
export function keyOffset(i: number): readonly [number, number] {
  return baseKeys[i];
}

/** The key one step from key `i` along `heading` (an index into HEADINGS), or −1
 *  when that step leaves the board. */
export function neighbor(i: number, heading: number): number {
  const [u, v] = baseKeys[i];
  const [du, dv] = HEADINGS[heading];
  return keyAt(u + du, v + dv);
}

const neighborLists: ReadonlyArray<ReadonlyArray<number>> = baseKeys.map((_, i) =>
  HEADINGS.map((_h, h) => neighbor(i, h)).filter((n) => n >= 0));

/** The keys touching key `i` (two to six of them). */
export function neighbors(i: number): ReadonlyArray<number> {
  return neighborLists[i];
}

/** True when key `i` is on the board's rim: a step in some direction leaves it. */
export function touchesEdge(i: number): boolean {
  return neighborLists[i].length < HEADINGS.length;
}

export type Half = 'left' | 'right';

/* The halves split at the midline of the case. The case's long direction is the
   board step (+7, −2) (layout/geometry.ts caseLevelTilt); on regular hexagons a
   key's position along it is proportional to 4u + v, and the midline is where
   that equals the mean over all keys. A key whose center is exactly on the line
   goes to the side it sits on along its own row (u + v/2 against the centroid),
   which keeps the halves equal and matches the canvas, whose hexagons are 0.1%
   off regular and put those keys on the same sides. */
const along = baseKeys.map(([u, v]) => 4 * u + v);
const alongMid = along.reduce((a, b) => a + b, 0) / KEY_COUNT;
const rowPos = baseKeys.map(([u, v]) => u + v / 2);
const rowMid = rowPos.reduce((a, b) => a + b, 0) / KEY_COUNT;
const halves: ReadonlyArray<Half> = baseKeys.map((_, i) => {
  const d = along[i] !== alongMid ? along[i] - alongMid : rowPos[i] - rowMid;
  return d < 0 ? 'left' : 'right';
});

/** Which half of the case key `i` belongs to. */
export function halfOf(i: number): Half {
  return halves[i];
}

/* The case's frame, for a game that draws shapes between the keys: lengths in
   key widths (the distance between neighboring keys' centers, on regular
   hexagons), x along the case's long direction toward the right half, y toward
   the top wall, and the origin at the centroid of the keys, which is on the
   halves' midline and midway between the long sides. The board step (+7, −2)
   is the vector (6, −√3) there, and the frame is turned so that it lies along
   x: the key rows come out tilted 16.1° from it. */
const ROOT3 = Math.sqrt(3);
const CASE_STEP = Math.hypot(6, ROOT3);

/** The frame vector of a physical offset step (du, dv); fractions are allowed. */
export function frameStep(du: number, dv: number): readonly [number, number] {
  const x = du + dv / 2, y = dv * ROOT3 / 2;
  return [(6 * x - ROOT3 * y) / CASE_STEP, (ROOT3 * x + 6 * y) / CASE_STEP];
}

const meanU = baseKeys.reduce((sum, k) => sum + k[0], 0) / KEY_COUNT;
const meanV = baseKeys.reduce((sum, k) => sum + k[1], 0) / KEY_COUNT;
const points: ReadonlyArray<readonly [number, number]> =
  baseKeys.map(([u, v]) => frameStep(u - meanU, v - meanV));

/** The center of key `i` in the case's frame. */
export function keyPoint(i: number): readonly [number, number] {
  return points[i];
}
