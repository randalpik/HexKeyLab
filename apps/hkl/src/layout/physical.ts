// The one map from physical keys to lattice cells. A physical key — Lumatone
// key i (baseKeys order: board group ⌊i/56⌋, key i mod 56) or a QWERTY
// event.code — sits at a fixed lattice OFFSET from the keyboard anchor
// (view.kbAnchorQ/R, derived in state/reference.ts); the cell it plays is
// offset + anchor. Every lattice-facing consumer reads the offsets or the
// anchored cells here: Lumatone input and colors, QWERTY input, the outline
// polygons, footprint, extents and canvas bounds. baseKeys and qwertyKeyMap
// keep only their physical meaning (board order, physical height, key codes).

import { baseKeys } from './baseKeys.js';
import { qwertyKeyMap, qwertyKeys } from '../input/qwerty.js';
import { view } from '../state/view.js';

export type Cell = readonly [number, number];

/** Lattice offset of each Lumatone key from the anchor; index = physical key. */
export const lumatoneCells: ReadonlyArray<Cell> = baseKeys;

/** Lattice offsets of the QWERTY note keys (the QWERTY outline's cell set). */
export const qwertyCells: ReadonlyArray<Cell> = qwertyKeys;

/** The cell Lumatone key i (0-279) plays at the current anchor. */
export function lumatoneCell(i: number): Cell {
  const c = lumatoneCells[i];
  return [c[0] + view.kbAnchorQ, c[1] + view.kbAnchorR];
}

/** The cell the QWERTY key with this event.code plays at the current anchor,
 *  or null when the code is not a note key. */
export function qwertyCell(code: string): Cell | null {
  const c = qwertyKeyMap[code];
  return c ? [c[0] + view.kbAnchorQ, c[1] + view.kbAnchorR] : null;
}
