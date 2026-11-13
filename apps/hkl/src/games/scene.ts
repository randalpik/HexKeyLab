// What a running game shows, as a scene: which keys are darkened, and white
// shapes on top. Both renderers work from the one scene. The canvas draws the
// shapes as they are (render/draw.ts); the device shows on each key the share
// of its tile that the shapes cover (lumatone/sync.ts), blended as the lattice
// slide blends. So a shape reads clearly on screen and its light on the keys is
// the same wherever it sits.
//
// Shapes are in the case's frame (games/board.ts keyPoint): lengths in key
// widths, origin at the field's center, +y toward the top wall. A key's tile is
// its hexagon, and the tiles fill the frame without overlap.
//
// Pure: no DOM and no state, so the device sync, the canvas and the Node oracle
// all import it.

import { KEY_COUNT, keyPoint, frameStep } from './board.js';

export type Shape =
  /** The whole tile of key `key`. */
  | { readonly kind: 'tile'; readonly key: number }
  /** A disc of radius `r` centered on (x, y). */
  | { readonly kind: 'circle'; readonly x: number; readonly y: number; readonly r: number }
  /** A line from (x1, y1) to (x2, y2), `half` wide on each side of it. Its ends
   *  are half-discs when `round`, and cut square at the end points otherwise. */
  | {
    readonly kind: 'line';
    readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number;
    readonly half: number; readonly round: boolean;
  };

export interface Scene {
  /** Whether key `key` shows its layout color darkened. */
  dark(key: number): boolean;
  /** White shapes, on top of the keys. Where they overlap, the area counts once. */
  readonly shapes: ReadonlyArray<Shape>;
}

/* A tile's share is measured along the key rows. Turned so the rows are level
   (X along a row, Y across the rows), every tile is the same upright hexagon:
   corners at Y = ±1/√3 above and below its key, and at height y from the key
   it reaches min(1/2, 1 − √3|y|) to each side. */
const [ROW_X, ROW_Y] = frameStep(1, 0);
const alongRows = (x: number, y: number): readonly [number, number] =>
  [x * ROW_X + y * ROW_Y, y * ROW_X - x * ROW_Y];
const ROOT3 = Math.sqrt(3);
const TILE_TOP = 1 / ROOT3;
const TILE_AREA = ROOT3 / 2;
const centers: ReadonlyArray<readonly [number, number]> =
  Array.from({ length: KEY_COUNT }, (_, key) => alongRows(...keyPoint(key)));

/** How many level strips a tile is cut into. The part of a strip under the
 *  shapes is exact along its middle line: every shape is convex, so it crosses
 *  the line in one stretch, and overlapping stretches are merged. Only the
 *  strips' height is a step, so a share is good to a fraction of a percent
 *  (test/games/oracle.mjs). A multiple of 4, which puts the hexagon's corners
 *  on strip edges and makes a wholly covered tile exactly 1. */
export const TILE_STRIPS = 96;

/* A drawn shape with the rows level: a disc, or the four corners of a line's
   body plus, when its ends are round, the discs on them. */
interface Level {
  readonly discs: ReadonlyArray<readonly [number, number, number]>;
  readonly corners: ReadonlyArray<readonly [number, number]>;
  /* A disc that holds the whole shape: center and radius. */
  readonly bound: readonly [number, number, number];
}

function level(shape: Exclude<Shape, { kind: 'tile' }>): Level {
  if (shape.kind === 'circle') {
    const [x, y] = alongRows(shape.x, shape.y);
    return { discs: [[x, y, shape.r]], corners: [], bound: [x, y, shape.r] };
  }
  const [x1, y1] = alongRows(shape.x1, shape.y1), [x2, y2] = alongRows(shape.x2, shape.y2);
  const length = Math.hypot(x2 - x1, y2 - y1);
  const bound: readonly [number, number, number] = [
    (x1 + x2) / 2, (y1 + y2) / 2,
    shape.round ? length / 2 + shape.half : Math.hypot(length / 2, shape.half),
  ];
  const discs: [number, number, number][] = shape.round ? [[x1, y1, shape.half], [x2, y2, shape.half]] : [];
  if (length === 0) return { discs, corners: [], bound };
  /* The body's half width, as a step square to the line. */
  const sx = -(y2 - y1) / length * shape.half, sy = (x2 - x1) / length * shape.half;
  return {
    discs,
    corners: [[x1 + sx, y1 + sy], [x2 + sx, y2 + sy], [x2 - sx, y2 - sy], [x1 - sx, y1 - sy]],
    bound,
  };
}

/* The stretch of the level line at height Y that `shape` covers, as [from, to],
   or null when the line misses it. One stretch, because the shape is convex. */
function stretch(shape: Level, Y: number): [number, number] | null {
  let from = Infinity, to = -Infinity;
  for (const [x, y, r] of shape.discs) {
    const d = Y - y;
    if (Math.abs(d) >= r) continue;
    const reach = Math.sqrt(r * r - d * d);
    from = Math.min(from, x - reach);
    to = Math.max(to, x + reach);
  }
  const c = shape.corners;
  for (let i = 0; i < c.length; i++) {
    const p = c[i], q = c[(i + 1) % c.length];
    if ((p[1] - Y) * (q[1] - Y) > 0 || p[1] === q[1]) continue;
    const x = p[0] + (Y - p[1]) * (q[0] - p[0]) / (q[1] - p[1]);
    from = Math.min(from, x);
    to = Math.max(to, x);
  }
  return from < to ? [from, to] : null;
}

/** The share of each key's tile that `shapes` cover, 0 to 1, by key index. A
 *  tile shape is exactly 1 on its key, and a tile no shape reaches exactly 0. */
export function whiteShares(shapes: ReadonlyArray<Shape>): number[] {
  const shares = new Array<number>(KEY_COUNT).fill(0);
  const drawn: Level[] = [];
  for (const s of shapes) {
    if (s.kind === 'tile') shares[s.key] = 1;
    else drawn.push(level(s));
  }
  if (drawn.length === 0) return shares;
  const height = 2 * TILE_TOP / TILE_STRIPS;
  for (let key = 0; key < KEY_COUNT; key++) {
    if (shares[key] === 1) continue;
    const [kx, ky] = centers[key];
    const near = drawn.filter(({ bound: [bx, by, br] }) => Math.hypot(kx - bx, ky - by) < br + TILE_TOP);
    if (near.length === 0) continue;
    let covered = 0;
    for (let i = 0; i < TILE_STRIPS; i++) {
      const y = -TILE_TOP + (i + 0.5) * height;
      const reach = Math.min(0.5, 1 - ROOT3 * Math.abs(y));
      const left = kx - reach, right = kx + reach;
      /* The shapes' stretches inside the tile, merged from the left. */
      const parts: [number, number][] = [];
      for (const s of near) {
        const part = stretch(s, ky + y);
        if (!part) continue;
        const from = Math.max(left, part[0]), to = Math.min(right, part[1]);
        if (to > from) parts.push([from, to]);
      }
      parts.sort((a, b) => a[0] - b[0]);
      let end = -Infinity;
      for (const [from, to] of parts) {
        if (to <= end) continue;
        covered += to - Math.max(from, end);
        end = to;
      }
    }
    const share = covered * height / TILE_AREA;
    /* Rounding in the last places must not turn a whole tile or an untouched
       one into a blend. */
    shares[key] = share > 1 - 1e-9 ? 1 : share < 1e-9 ? 0 : share;
  }
  return shares;
}
