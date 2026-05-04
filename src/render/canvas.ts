// Canvas size + viewport range. Initialization runs at module load from baseKeys.

import { baseKeys } from '../layout/baseKeys.js';
import { hexR, dxH, dyH, cosT, sinT, hexToScreen } from '../layout/geometry.js';
import { view } from '../state/view.js';

(function () {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  baseKeys.forEach(function (k) {
    const p = hexToScreen(k[0], k[1]);
    if (p.sx < minX) minX = p.sx;
    if (p.sx > maxX) maxX = p.sx;
    if (p.sy < minY) minY = p.sy;
    if (p.sy > maxY) maxY = p.sy;
  });
  const padY = hexR + dxH * 0.5; /* 1 key width gap beyond outline */
  const padX = dxH * 1.5 + hexR;
  view.kbMinW = Math.ceil((Math.max(-minX, maxX) + padX) * 2);
  view.CH = Math.ceil(maxY - minY + 2 * padY); /* actual extent, not symmetrized */
  view.kbOffY = -(minY + maxY) / 2; /* shift to center keyboard in CH */
})();

export function sizeCanvas(): void {
  const wrapPad = 24; /* 12px padding each side of .wrap */
  view.CW = Math.max(400, window.innerWidth - wrapPad);
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
