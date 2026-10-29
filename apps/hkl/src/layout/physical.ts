// The one map from physical keys to lattice cells. A physical key — Lumatone
// key i (baseKeys order: board group ⌊i/56⌋, key i mod 56) or a QWERTY
// event.code — sits at a fixed lattice OFFSET from the keyboard anchor
// (view.kbAnchorQ/R, derived in state/reference.ts); the cell it plays is
// offset + anchor. Every lattice-facing consumer reads the offsets or the
// anchored cells here: Lumatone input and colors, QWERTY input, the outline
// polygons, footprint, extents and canvas bounds. baseKeys and qwertyKeyMap
// keep only their physical meaning (board order, physical height, key codes).
//
// The ALIGNMENT poses the physical layout on the lattice: a key at physical
// offset (u, v) — its baseKeys / QWERTY position — sits at lattice offset
// ROTATE[alignment](u, v). Each is an exact 60° rotation of the hex lattice
// about (0, 0), so the outline's center keeps playing kbAnchor and every
// interval keeps its hand shape; only which lattice region the layout covers,
// and which way pitch runs across it, change.

import { baseKeys } from './baseKeys.js';
import { qwertyKeyMap } from '../input/qwerty.js';
import { view } from '../state/view.js';
import type { Alignment, OutlineMode } from '../state/persistence.js';

export type Cell = readonly [number, number];

/* Physical offset → lattice offset. The fifths axis (0, 1) lies along the
   physical 60° diagonal (0, 1) under 'vertical', along the 120° diagonal
   (−1, 1) under 'left', and along the key rows (1, 0) under 'right'. */
const ROTATE: Readonly<Record<Alignment, (u: number, v: number) => Cell>> = {
  vertical: (u, v) => [u, v],
  left: (u, v) => [u + v, -u],
  right: (u, v) => [-v, u + v],
};

/** Lattice offset of physical offset (u, v) under alignment `a`. */
export function poseOffset(a: Alignment, u: number, v: number): Cell {
  return ROTATE[a](u, v);
}

const ALIGNMENTS: ReadonlyArray<Alignment> = ['vertical', 'left', 'right'];
const posedLumatone = {} as Record<Alignment, ReadonlyArray<Cell>>;
const posedQwerty = {} as Record<Alignment, Readonly<Record<string, Cell>>>;
for (const a of ALIGNMENTS) {
  posedLumatone[a] = baseKeys.map(([u, v]) => ROTATE[a](u, v));
  const m: Record<string, Cell> = {};
  for (const code of Object.keys(qwertyKeyMap)) m[code] = ROTATE[a](qwertyKeyMap[code][0], qwertyKeyMap[code][1]);
  posedQwerty[a] = m;
}

/** The active alignment. Live binding; set only through setAlignment. */
export let alignment: Alignment = 'vertical';
/** Lattice offset of each Lumatone key from the anchor; index = physical key. */
export let lumatoneCells: ReadonlyArray<Cell> = posedLumatone.vertical;
/** Lattice offsets of the QWERTY note keys (the QWERTY outline's cell set). */
export let qwertyCells: ReadonlyArray<Cell> = Object.values(posedQwerty.vertical);

/** Pose the physical layout. Callers rebuild what derives from the cells
 *  (render/controls-core.ts applyAlignment). */
export function setAlignment(a: Alignment): void {
  alignment = a;
  lumatoneCells = posedLumatone[a];
  qwertyCells = Object.values(posedQwerty[a]);
}

/** The pose an outline is drawn in. The Lumatone and QWERTY outlines are the
 *  physical layout, so they take the alignment; the Piano outline (lattice
 *  cells) and None have no physical pose. */
export function outlinePose(outline: OutlineMode): Alignment {
  return outline === 'lumatone' || outline === 'qwerty' ? alignment : 'vertical';
}

/** A physical outline's cell set in a given pose (canvas bounds for None use
 *  the vertical pose whatever the alignment). */
export function outlineCells(device: 'lumatone' | 'qwerty', pose: Alignment): ReadonlyArray<Cell> {
  return device === 'lumatone' ? posedLumatone[pose] : Object.values(posedQwerty[pose]);
}

/** The cell Lumatone key i (0-279) plays at the current anchor. */
export function lumatoneCell(i: number): Cell {
  const c = lumatoneCells[i];
  return [c[0] + view.kbAnchorQ, c[1] + view.kbAnchorR];
}

/** The cell the QWERTY key with this event.code plays at the current anchor,
 *  or null when the code is not a note key. */
export function qwertyCell(code: string): Cell | null {
  const c = posedQwerty[alignment][code];
  return c ? [c[0] + view.kbAnchorQ, c[1] + view.kbAnchorR] : null;
}
