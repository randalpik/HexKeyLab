// Canvas size + viewport range.
//
// Bounds are per-outline: each outline mode picks its own cell set so the
// canvas fits exactly what's visible. Within (rotation, outline, tuning)
// the canvas height is static — refNote changes don't trigger resizes.
//
// The piano outline's height fits every ref. tuning/picker.ts
// footprintExtents gives, per position in band, the one stitched footprint
// every ref's 88 cells are a window of (2W picker runs; four times that in
// banded Syntonic, whose footprint depends on the ref's band offset from the
// anchor), cached here per (mapping, mode, banding); footprintHalfHeight
// measures it under the live tilt and hex size.
//
// kbOffY is forced to 0 — content is symmetric about the canvas vertical
// midline; CH grows to fit the larger of |minY| / |maxY|.

import { outlineCells, outlinePose } from '../layout/physical.js';
import { hexR, dxH, dyH, cosT, sinT, hexToScreen } from '../layout/geometry.js';
import type { OutlineMode } from '../state/persistence.js';
import { tuning } from '../state/tuning.js';
import { view } from '../state/view.js';
import { footprintAnchorOffsets, footprintExtents, footprintHalfHeight } from '../tuning/picker.js';

/** Solve for the lattice viewport center (viewQ, viewR) such that
 *  hexToScreen places refNote at screen-X = 0 (horizontal center) and
 *  MIDI 64's cell at screen-Y = 0 (vertical center) under the active tilt.
 *
 *  hexToScreen (geometry.ts) factors out to (with y = r·dyH):
 *    sx(q, r) = q·dxH·cosT + r·(dxH·0.5·cosT − dyH·sinT) = A·q + B·r
 *    sy(q, r) = −q·dxH·sinT − r·(dxH·0.5·sinT + dyH·cosT) = C·q + D·r
 *  We want screen positions of (refQ − viewQ, refR − viewR) → sx = 0
 *  and (m64Q − viewQ, m64R − viewR) → sy = 0, giving the linear system
 *    A·viewQ + B·viewR = A·refQ + B·refR
 *    C·viewQ + D·viewR = C·m64Q + D·m64R
 *  whose determinant A·D − B·C = −dxH·dyH is tilt-independent. */
export function computePianoViewCenter(
  refQ: number, refR: number, m64Q: number, m64R: number,
): [number, number] {
  const A = dxH * cosT;
  const B = dxH * 0.5 * cosT - dyH * sinT;
  const C = -dxH * sinT;
  const D = -dxH * 0.5 * sinT - dyH * cosT;
  const rhsX = A * refQ + B * refR;
  const rhsY = C * m64Q + D * m64R;
  const det = A * D - B * C;
  return [
    (D * rhsX - B * rhsY) / det,
    (-C * rhsX + A * rhsY) / det,
  ];
}

/* The piano footprint extents per (mapping, mode, banding), one set per
   ref-to-anchor offset that can change them (footprintAnchorOffsets: four in
   banded Syntonic, one otherwise): the picker runs that size the piano outline,
   cached so a rotation, hex-size or outline change is arithmetic.
   test/picker/footprint-extent.mjs gates the offsets. */
const extentCache = new Map<string, Array<Array<Array<[number, number]>>>>();
function pianoHalfHeight(): number {
  const key = tuning.mapping + '|' + tuning.mode + '|' + tuning.banded;
  let exts = extentCache.get(key);
  if (!exts) {
    exts = footprintAnchorOffsets(tuning).map((d) => footprintExtents(tuning, d));
    extentCache.set(key, exts);
  }
  return Math.max(...exts.map((ext) => footprintHalfHeight(ext, (q, r) => hexToScreen(q, r).sy)));
}

/* Lumatone / QWERTY are static cell sets (no tuning dependence). Project
   live each time — it's fast and avoids the hardcoding-staleness risk for
   sets that aren't expensive. */
function staticOutlineCells(device: 'lumatone' | 'qwerty', outline: OutlineMode): ReadonlyArray<readonly [number, number]> {
  /* A physical outline is bounded as posed (layout/physical.ts); None's union
     uses the vertical pose (outlinePose('none')), so its canvas never changes
     with the alignment. */
  return outlineCells(device, outlinePose(outline));
}

interface ScreenBounds { minX: number; maxX: number; minY: number; maxY: number; }

function projectStatic(cells: ReadonlyArray<readonly [number, number]>, b: ScreenBounds): void {
  for (const [q, r] of cells) {
    const p = hexToScreen(q, r);
    if (p.sx < b.minX) b.minX = p.sx;
    if (p.sx > b.maxX) b.maxX = p.sx;
    if (p.sy < b.minY) b.minY = p.sy;
    if (p.sy > b.maxY) b.maxY = p.sy;
  }
}

/* Resolve the live outline mode from the DOM. Falls back to 'lumatone' when
   the select element is absent (e.g. very early init before HTML parsed). */
function currentOutlineMode(): OutlineMode {
  const sel = document.getElementById('selOutline') as HTMLSelectElement | null;
  const v = sel?.value;
  if (v === 'qwerty' || v === 'piano' || v === 'none') return v;
  return 'lumatone';
}

/* Re-project the active outline through current tilt and refresh view.CH.
   Called at module load and on rotation/outline/tuning/hex-size change.
   Lumatone/QWERTY are projected live; the piano outline is measured from its
   cached footprint extents. */
export function recomputeCanvasBounds(outlineOverride?: OutlineMode): void {
  const outline = outlineOverride ?? currentOutlineMode();
  const padY = hexR + dxH * 0.5;
  let CH = 0;

  if (outline === 'lumatone' || outline === 'qwerty' || outline === 'none') {
    const b: ScreenBounds = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9 };
    if (outline === 'lumatone' || outline === 'none') projectStatic(staticOutlineCells('lumatone', outline), b);
    if (outline === 'qwerty' || outline === 'none') projectStatic(staticOutlineCells('qwerty', outline), b);
    CH = Math.ceil(2 * Math.max(Math.abs(b.minY), Math.abs(b.maxY)) + 2 * padY);
  }
  if (outline === 'piano' || outline === 'none') {
    /* For "none", take the max of piano vs lumatone+qwerty already computed. */
    CH = Math.max(CH, Math.ceil(2 * pianoHalfHeight() + 2 * padY));
  }
  view.CH = CH;
  view.kbOffY = 0;
}
recomputeCanvasBounds();

export function sizeCanvas(): void {
  const wrapPad = 24; /* 12px padding each side of .wrap */
  /* Less a classic (non-overlay) scrollbar while the lattice's scroll box
     scrolls (#cvScroll, index.html); 0 otherwise, and in the OBS overlay. */
  const box = document.getElementById('cvScroll');
  const bar = box ? box.offsetWidth - box.clientWidth : 0;
  view.CW = Math.max(400, window.innerWidth - wrapPad - bar);
}

export interface VisibleRange {
  qMin: number;
  qMax: number;
  rMin: number;
  rMax: number;
}

/* visible range computed per-frame based on current view */
export function getVisibleRange(vq: number, vr: number): VisibleRange {
  const corners: [number, number][] = [
    [-view.CW / 2, -(view.CH / 2 + view.kbOffY)],
    [view.CW / 2, -(view.CH / 2 + view.kbOffY)],
    [view.CW / 2, view.CH / 2 - view.kbOffY],
    [-view.CW / 2, view.CH / 2 - view.kbOffY],
  ];
  let qLo = 1e9, qHi = -1e9, rLo = 1e9, rHi = -1e9;
  corners.forEach(function (c) {
    const ux = c[0] * cosT - c[1] * sinT;
    const uy = c[0] * sinT + c[1] * cosT;
    const rRel = -uy / dyH;
    const qRel = (ux - rRel * dxH * 0.5) / dxH;
    const qAbs = qRel + vq, rAbs = rRel + vr;
    if (qAbs < qLo) qLo = qAbs;
    if (qAbs > qHi) qHi = qAbs;
    if (rAbs < rLo) rLo = rAbs;
    if (rAbs > rHi) rHi = rAbs;
  });
  return {
    qMin: Math.floor(qLo) - 2, qMax: Math.ceil(qHi) + 2,
    rMin: Math.floor(rLo) - 2, rMax: Math.ceil(rHi) + 2,
  };
}
