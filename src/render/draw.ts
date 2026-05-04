// Main canvas + draw pipeline.
//
// Architecture invariant from lessons.md: offscreen hex/text layers are built
// at fixed origin (gridRefQ=gridRefR=0) with padding sufficient for ALL
// possible layout shifts. Layout switches change ONLY the blit OFFSET — they
// do NOT dirty the offscreen layers (zero-cost-blit invariant). Setting
// view.hexDirty/textDirty=true on a layout switch would force a rebuild and
// destroy the optimization.
//
// Selection state is per-frame: selection.drawnKeys is rebuilt every draw()
// call from the current view + layout shift; the click hit-test reads it as
// the screen-space lookup table.

import { baseKeys, layoutShifts } from '../layout/baseKeys.js';
import { bandOf } from '../layout/coords.js';
import { hexR, dxH, dyH, tiltAngle, cosT, sinT } from '../layout/geometry.js';
import { tuning } from '../state/tuning.js';
import { view } from '../state/view.js';
import { selection, type DrawnKey } from '../state/selection.js';
import { audio } from '../state/audio.js';
import { whiteSet, hueC, computeHue } from './colors.js';
import { sizeCanvas, getVisibleRange } from './canvas.js';
import { animation } from './animation.js';
import { updateInfo } from './info.js';
import {
  parseNote, accToVal, noteName,
  SHARP, DBLSHARP, FLAT, DBLFLAT,
} from '../tuning/notes.js';
import type { KeyId } from '../types.js';

// ── canvas setup ───────────────────────────────────────────────────────────
export const cv = document.getElementById('cv') as HTMLCanvasElement;
sizeCanvas();
cv.style.width = view.CW + 'px';
cv.style.height = view.CH + 'px';
(cv.parentElement as HTMLElement).style.minWidth = '424px'; /* 400px canvas + 24px wrap padding */
export let ctx: CanvasRenderingContext2D = cv.getContext('2d')!;

// ── layout-anim raf scheduler ──────────────────────────────────────────────
let layoutAnimId: number | null = null;
function animateLayout(): void {
  const stillRunning = animation.step();
  draw();
  layoutAnimId = stillRunning ? requestAnimationFrame(animateLayout) : null;
}
/** Schedule (or re-schedule) the layout-switch animation raf loop. */
export function startLayoutAnim(): void {
  if (layoutAnimId) cancelAnimationFrame(layoutAnimId);
  layoutAnimId = requestAnimationFrame(animateLayout);
}

// ── outline geometry (precomputed at module load) ──────────────────────────
const kbBaseSet = new Set<string>();
baseKeys.forEach((k) => { kbBaseSet.add(k[0] + ',' + k[1]); });

const outR = hexR + 1;
const olDirs: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const hdx: number[] = [], hdy: number[] = [], epx: number[] = [], epy: number[] = [];
for (let _di = 0; _di < 6; _di++) {
  const _rx = olDirs[_di][0] * dxH + olDirs[_di][1] * dxH * 0.5, _ry = -olDirs[_di][1] * dyH;
  const _rl = Math.sqrt(_rx * _rx + _ry * _ry);
  hdx[_di] = _rx / _rl; hdy[_di] = _ry / _rl;
  epx[_di] = -hdy[_di]; epy[_di] = hdx[_di];
}
function edgeIsect(hx1: number, hy1: number, d1: number, hx2: number, hy2: number, d2: number): [number, number] {
  const px1 = hx1 + outR * hdx[d1], py1 = hy1 + outR * hdy[d1];
  const px2 = hx2 + outR * hdx[d2], py2 = hy2 + outR * hdy[d2];
  const det = epx[d2] * epy[d1] - epx[d1] * epy[d2];
  if (Math.abs(det) < 1e-9) return [px1, py1];
  const ddx = px2 - px1, ddy = py2 - py1;
  const t = (epx[d2] * ddy - epy[d2] * ddx) / det;
  return [px1 + t * epx[d1], py1 + t * epy[d1]];
}

type Point = [number, number];
const kbOutlinePaths: Point[][] = []; /* array of closed polyline arrays [[x,y],[x,y],...] */
(function () {
  const eDirs: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  /* base positions */
  const bPos: Record<string, { ux: number; uy: number }> = {};
  baseKeys.forEach((bk) => {
    bPos[bk[0] + ',' + bk[1]] = { ux: bk[0] * dxH + bk[1] * dxH * 0.5, uy: -bk[1] * dyH };
  });
  /* find boundary edges */
  const bEdges: Record<string, boolean> = {};
  baseKeys.forEach((bk) => {
    const bq = bk[0], br = bk[1];
    for (let d = 0; d < 6; d++) {
      if (!kbBaseSet.has((bq + eDirs[d][0]) + ',' + (br + eDirs[d][1])))
        bEdges[bq + ',' + br + ',' + d] = true;
    }
  });
  function nextBEdge(q: number, r: number, d: number): [number, number, number] | null {
    let nd = (d + 5) % 6;
    for (let s = 0; s < 12; s++) {
      if (bEdges[q + ',' + r + ',' + nd]) return [q, r, nd];
      const nq = q + eDirs[nd][0], nr = r + eDirs[nd][1];
      nd = ((nd + 3) % 6 + 5) % 6; q = nq; r = nr;
    }
    return null;
  }
  /* trace chains */
  const bUsed: Record<string, boolean> = {};
  for (const ek in bEdges) {
    if (bUsed[ek]) continue;
    const ep = ek.split(','); let cq = +ep[0], cr = +ep[1], cd = +ep[2];
    const sq = cq, sr = cr, sd = cd;
    const chain: [number, number, number][] = [];
    do {
      chain.push([cq, cr, cd]);
      bUsed[cq + ',' + cr + ',' + cd] = true;
      const nx = nextBEdge(cq, cr, cd);
      if (!nx) break;
      cq = nx[0]; cr = nx[1]; cd = nx[2];
    } while (cq !== sq || cr !== sr || cd !== sd);
    if (chain.length < 3) continue;
    const poly: Point[] = [];
    for (let ci = 0; ci < chain.length; ci++) {
      const cur = chain[ci], nxt = chain[(ci + 1) % chain.length];
      const h1 = bPos[cur[0] + ',' + cur[1]], h2 = bPos[nxt[0] + ',' + nxt[1]];
      if (!h1 || !h2) continue;
      const pt = edgeIsect(h1.ux, h1.uy, cur[2], h2.ux, h2.uy, nxt[2]);
      poly.push(pt);
    }
    if (poly.length >= 3) kbOutlinePaths.push(poly);
  }
})();

// ── hit-test ───────────────────────────────────────────────────────────────
/** Map screen coordinates to a "q,r" lattice key, or null if too far from any. */
export function hexAtPoint(mx: number, my: number): KeyId | null {
  /* transform to unrotated coords */
  const dx = mx - view.CW / 2, dy = my - (view.CH / 2 + view.kbOffY);
  const ux = dx * cosT - dy * sinT;
  const uy = dx * sinT + dy * cosT;
  /* find nearest hex by unrotated distance */
  let best: DrawnKey | null = null, bestD = Infinity;
  for (let i = 0; i < selection.drawnKeys.length; i++) {
    const k = selection.drawnKeys[i];
    const ddx = ux - k.ux, ddy = uy - k.uy, d2 = ddx * ddx + ddy * ddy;
    if (d2 < bestD) { bestD = d2; best = k; }
  }
  if (!best || bestD > hexR * hexR * 1.5) return null;
  return best.q + ',' + best.r;
}

// ── drawing helpers ────────────────────────────────────────────────────────
function drawHexPath(cx: number, cy: number, r: number): void { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)); } ctx.closePath(); }
function lightenHex(hex: string, amt: number): string {
  let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  r = Math.min(255, r + amt); g = Math.min(255, g + amt); b = Math.min(255, b + amt);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
function drawNoteName(cx: number, cy: number, name: string, isW: boolean, isExt: boolean): void {
  if (name === '?') return;
  const p = parseNote(name); const v = accToVal(p.acc); const absV = Math.abs(v);
  ctx.fillStyle = isW ? (isExt ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.8)') : (isExt ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.9)');
  const baseFontSize = 14;
  ctx.font = '500 ' + baseFontSize + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (v === 0) { ctx.fillText(p.letter, cx, cy); return; }
  /* decompose accidental into single+double glyphs */
  const single = v > 0 ? SHARP : FLAT, dbl = v > 0 ? DBLSHARP : DBLFLAT;
  const glyphs = [];
  if (absV % 2 === 1) glyphs.push(single);
  for (let i = 0; i < Math.floor(absV / 2); i++) glyphs.push(dbl);
  /* measure total width at base size to determine scale factor */
  const dblFlatScale = 0.90;
  const lw = ctx.measureText(p.letter).width;
  let totalW = lw;
  for (let i = 0; i < glyphs.length; i++) {
    const gScale = (glyphs[i] === DBLFLAT) ? dblFlatScale : 1;
    ctx.font = '500 ' + Math.round(baseFontSize * gScale) + 'px sans-serif';
    totalW += ctx.measureText(glyphs[i]).width + 0.5;
    /* cascading nudge for double flats: count consecutive double flats */
    if (glyphs[i] === DBLFLAT) {
      let dblIdx = 0; for (let j = 0; j < i; j++) if (glyphs[j] === DBLFLAT) dblIdx++;
      if (dblIdx > 0) totalW -= baseFontSize * 0.14 * dblIdx;
    }
  }
  ctx.font = '500 ' + baseFontSize + 'px sans-serif';
  const maxW = hexR * 1.3;
  const scale = Math.min(1, maxW / totalW);
  const fontSize = Math.max(6, Math.round(baseFontSize * scale));
  /* compute nudges and glyph widths at final size */
  ctx.font = '500 ' + fontSize + 'px sans-serif';
  const flw = ctx.measureText(p.letter).width;
  const gws = [], nudges = [];
  let dblCount = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const gScale = (glyphs[i] === DBLFLAT) ? dblFlatScale : 1;
    ctx.font = '500 ' + Math.round(fontSize * gScale) + 'px sans-serif';
    gws.push(ctx.measureText(glyphs[i]).width);
    if (glyphs[i] === DBLFLAT) {
      nudges.push(dblCount > 0 ? -fontSize * 0.14 * dblCount : 0);
      dblCount++;
    } else {
      nudges.push(0);
    }
  }
  ctx.font = '500 ' + fontSize + 'px sans-serif';
  /* compute total rendered width for centering */
  let tw = flw; for (let i = 0; i < gws.length; i++) tw += gws[i] + 0.5 + nudges[i];
  let x = cx - tw / 2 + flw / 2;
  ctx.fillText(p.letter, x, cy);
  x += flw / 2;
  for (let i = 0; i < glyphs.length; i++) {
    x += 0.5 + gws[i] / 2 + nudges[i];
    if (glyphs[i] === DBLFLAT) {
      ctx.font = '500 ' + Math.round(fontSize * dblFlatScale) + 'px sans-serif';
      ctx.fillText(glyphs[i], x, cy - fontSize * 0.04);
      ctx.font = '500 ' + fontSize + 'px sans-serif';
    } else {
      const yOff = glyphs[i] === DBLSHARP ? fontSize * 0.22 : 0;
      ctx.fillText(glyphs[i], x, cy + yOff);
    }
    x += gws[i] / 2;
  }
}

// ── offscreen layers: hexCanvas (fills) + textCanvas (labels) ──────────────
let hexCanvas: HTMLCanvasElement | null = null, textCanvas: HTMLCanvasElement | null = null;
let gridRefQ = 0, gridRefR = 0, gridPadX = 0, gridPadY = 0, gridW = 0, gridH = 0, gridDpr = 1;

interface GridRange { qMin: number; qMax: number; rMin: number; rMax: number; }

/* keyboard extent across all layouts for tight bounds when Extend is off */
let kbQMin: number, kbQMax: number, kbRMin: number, kbRMax: number;
(function () {
  kbQMin = 1e9; kbQMax = -1e9; kbRMin = 1e9; kbRMax = -1e9;
  ([1, 2, 3] as const).forEach((li) => {
    const sh = layoutShifts[li];
    baseKeys.forEach((k) => {
      const q = k[0] + sh[0], r = k[1] + sh[1];
      if (q < kbQMin) kbQMin = q; if (q > kbQMax) kbQMax = q;
      if (r < kbRMin) kbRMin = r; if (r > kbRMax) kbRMax = r;
    });
  });
  kbQMin -= 2; kbQMax += 2; kbRMin -= 2; kbRMax += 2;
})();

function sizeGridCanvases(): void {
  gridRefQ = 0; gridRefR = 0;
  let mxDx = 0, mxDy = 0;
  ([1, 2, 3] as const).forEach((li) => {
    const sh = layoutShifts[li];
    const dux = sh[0] * dxH + sh[1] * dxH * 0.5, duy = -sh[1] * dyH;
    mxDx = Math.max(mxDx, Math.abs(dux * cosT + duy * sinT));
    mxDy = Math.max(mxDy, Math.abs(-dux * sinT + duy * cosT));
  });
  gridPadX = Math.ceil(mxDx) + hexR * 3;
  gridPadY = Math.ceil(mxDy) + hexR * 3;
  gridW = view.CW + gridPadX * 2; gridH = view.CH + gridPadY * 2;
  gridDpr = window.devicePixelRatio || 1;
}

function gridRange(extended: boolean): GridRange {
  const gCorners: Point[] = [[-gridW / 2, -(gridH / 2 + view.kbOffY)], [gridW / 2, -(gridH / 2 + view.kbOffY)],
    [gridW / 2, gridH / 2 - view.kbOffY], [-gridW / 2, gridH / 2 - view.kbOffY]];
  let qLo = 1e9, qHi = -1e9, rLo = 1e9, rHi = -1e9;
  gCorners.forEach((c) => {
    const ux = c[0] * cosT - c[1] * sinT, uy = c[0] * sinT + c[1] * cosT;
    const rRel = -uy / dyH, qRel = (ux - rRel * dxH * 0.5) / dxH;
    if (qRel + gridRefQ < qLo) qLo = qRel + gridRefQ; if (qRel + gridRefQ > qHi) qHi = qRel + gridRefQ;
    if (rRel + gridRefR < rLo) rLo = rRel + gridRefR; if (rRel + gridRefR > rHi) rHi = rRel + gridRefR;
  });
  qLo = Math.floor(qLo) - 2; qHi = Math.ceil(qHi) + 2; rLo = Math.floor(rLo) - 2; rHi = Math.ceil(rHi) + 2;
  if (!extended) {
    qLo = Math.max(qLo, kbQMin); qHi = Math.min(qHi, kbQMax);
    rLo = Math.max(rLo, kbRMin); rHi = Math.min(rHi, kbRMax);
  }
  return { qMin: qLo, qMax: qHi, rMin: rLo, rMax: rHi };
}

function buildGridKeys(range: GridRange): DrawnKey[] {
  const gcx = gridW / 2, gcy = gridH / 2 + view.kbOffY;
  const kbSet = new Set<string>(); baseKeys.forEach((k) => { kbSet.add(k[0] + ',' + k[1]); });
  const gKeys: DrawnKey[] = [];
  for (let r = range.rMax; r >= range.rMin; r--) for (let q = range.qMin; q <= range.qMax; q++) {
    const isKb = kbSet.has(q + ',' + r);
    const ux = (q - gridRefQ) * dxH + (r - gridRefR) * dxH * 0.5, uy = -(r - gridRefR) * dyH;
    const sx = ux * cosT + uy * sinT + gcx, sy = -ux * sinT + uy * cosT + gcy;
    if (sx < -hexR * 3 || sx > gridW + hexR * 3 || sy < -hexR * 3 || sy > gridH + hexR * 3) continue;
    gKeys.push({ q: q, r: r, ux: ux, uy: uy, sx: sx, sy: sy, isKb: isKb });
  }
  return gKeys;
}

function buildHexLayer(): void {
  sizeGridCanvases();
  const extended = (document.getElementById('cbExtend') as HTMLInputElement).checked;
  const range = gridRange(extended);
  const gKeys = buildGridKeys(range);
  if (!hexCanvas) hexCanvas = document.createElement('canvas');
  hexCanvas.width = gridW * gridDpr; hexCanvas.height = gridH * gridDpr;
  const gc = hexCanvas.getContext('2d')!;
  gc.setTransform(gridDpr, 0, 0, gridDpr, 0, 0);
  gc.fillStyle = '#111'; gc.fillRect(0, 0, gridW, gridH);
  const gcx = gridW / 2, gcy = gridH / 2 + view.kbOffY;
  const savedCtx = ctx; ctx = gc;
  ctx.save(); ctx.translate(gcx, gcy); ctx.rotate(-tiltAngle);
  ctx.fillStyle = '#111'; gKeys.forEach((k) => { if (k.isKb) { drawHexPath(k.ux, k.uy, hexR + 0.5); ctx.fill(); } });
  gKeys.forEach((k) => {
    const midi = 57 + 4 * k.q + 7 * k.r; const pc = ((midi % 12) + 12) % 12; const isW = whiteSet.has(pc);
    const mh = computeHue(k.q, k.r);
    const inB = tuning.septimalEnabled && ((Math.floor((k.r - tuning.septimalShift) / tuning.septimalW) & 1) !== 0);
    const col = inB ? (isW ? hueC[mh].sl! : hueC[mh].sd!) : (isW ? hueC[mh].l : hueC[mh].d);
    drawHexPath(k.ux, k.uy, hexR - 0.5); ctx.fillStyle = col; ctx.fill();
  });
  ctx.restore();
  ctx = savedCtx;
  view.hexDirty = false;
}

function buildTextLayer(): void {
  sizeGridCanvases();
  const extended = (document.getElementById('cbExtend') as HTMLInputElement).checked;
  const range = gridRange(extended);
  const gKeys = buildGridKeys(range);
  if (!textCanvas) textCanvas = document.createElement('canvas');
  textCanvas.width = gridW * gridDpr; textCanvas.height = gridH * gridDpr;
  const gc = textCanvas.getContext('2d')!;
  gc.setTransform(gridDpr, 0, 0, gridDpr, 0, 0);
  /* transparent background — composites over hex layer */
  gc.clearRect(0, 0, gridW, gridH);
  if ((document.getElementById('cbNotes') as HTMLInputElement).checked) {
    const savedCtx = ctx; ctx = gc;
    gKeys.forEach((k) => {
      const midi = 57 + 4 * k.q + 7 * k.r; const pc = ((midi % 12) + 12) % 12; const isW = whiteSet.has(pc);
      drawNoteName(k.sx, k.sy, noteName(k.q, k.r), isW, false);
    });
    ctx = savedCtx;
  }
  view.textDirty = false;
}

// ── main draw ──────────────────────────────────────────────────────────────
export function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  cv.width = view.CW * dpr; cv.height = view.CH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, view.CW, view.CH);
  const cyC = view.CH / 2 + view.kbOffY;
  const showN = (document.getElementById('cbNotes') as HTMLInputElement).checked;
  const showB = (document.getElementById('cbBands') as HTMLInputElement).checked;
  const showE = (document.getElementById('cbExtend') as HTMLInputElement).checked;

  /* rebuild layers if needed (not during animation) */
  if (!animation.isAnimating) {
    if (view.hexDirty) buildHexLayer();
    if (view.textDirty) buildTextLayer();
  }

  /* blit hex + text layers at current view offset */
  if (hexCanvas) {
    const dQ = view.viewQ - gridRefQ, dR = view.viewR - gridRefR;
    const dux = dQ * dxH + dR * dxH * 0.5, duy = -dR * dyH;
    const offX = dux * cosT + duy * sinT;
    const offY = -dux * sinT + duy * cosT;
    const srcX = (gridPadX + offX) * gridDpr, srcY = (gridPadY + offY) * gridDpr, srcW = view.CW * gridDpr, srcH = view.CH * gridDpr;
    ctx.drawImage(hexCanvas, srcX, srcY, srcW, srcH, 0, 0, view.CW, view.CH);
    if (textCanvas) ctx.drawImage(textCanvas, srcX, srcY, srcW, srcH, 0, 0, view.CW, view.CH);
  }

  /* build allKeys for seams + click detection (arithmetic only, no rendering) */
  const kbShQ = animation.isAnimating ? Math.round(view.viewQ) : layoutShifts[tuning.curLayout][0];
  const kbShR = animation.isAnimating ? Math.round(view.viewR) : layoutShifts[tuning.curLayout][1];
  const kbSet = new Set<string>(); baseKeys.forEach((k) => { kbSet.add((k[0] + kbShQ) + ',' + (k[1] + kbShR)); });
  const vis = getVisibleRange(view.viewQ, view.viewR);
  const allKeys: DrawnKey[] = [];
  for (let r = vis.rMax; r >= vis.rMin; r--) for (let q = vis.qMin; q <= vis.qMax; q++) {
    const isKb = kbSet.has(q + ',' + r);
    const ux = (q - view.viewQ) * dxH + (r - view.viewR) * dxH * 0.5;
    const uy = -(r - view.viewR) * dyH;
    const sx = ux * cosT + uy * sinT + view.CW / 2;
    const sy = -ux * sinT + uy * cosT + cyC;
    if (!isKb && (sx < -hexR * 3 || sx > view.CW + hexR * 3 || sy < -hexR * 3 || sy > view.CH + hexR * 3)) continue;
    allKeys.push({ q: q, r: r, ux: ux, uy: uy, sx: sx, sy: sy, isKb: isKb });
  }
  selection.drawnKeys = allKeys;
  const posMap: Record<KeyId, DrawnKey> = {};
  allKeys.forEach((k) => { posMap[k.q + ',' + k.r] = k; });
  kbSet.forEach((key) => {
    if (!posMap[key]) {
      const p = key.split(','), q = +p[0], r = +p[1];
      const ux = (q - view.viewQ) * dxH + (r - view.viewR) * dxH * 0.5, uy = -(r - view.viewR) * dyH;
      const sx = ux * cosT + uy * sinT + view.CW / 2, sy = -ux * sinT + uy * cosT + cyC;
      const k: DrawnKey = { q: q, r: r, ux: ux, uy: uy, sx: sx, sy: sy, isKb: true };
      allKeys.push(k); posMap[key] = k;
    }
  });

  /* === selection highlights + seams (rotated context) === */
  ctx.save();
  ctx.translate(view.CW / 2, cyC);
  ctx.rotate(-tiltAngle);

  /* hover: subtle lightening of the hex under the cursor (drawn under selection
     so a selected+hovered key still reads as selected). */
  if (selection.hoverKey) {
    const hk = posMap[selection.hoverKey];
    if (hk) {
      const hmidi = 57 + 4 * hk.q + 7 * hk.r; const hpc = ((hmidi % 12) + 12) % 12; const hW = whiteSet.has(hpc);
      const hmh = computeHue(hk.q, hk.r);
      const hInB = tuning.septimalEnabled && ((Math.floor((hk.r - tuning.septimalShift) / tuning.septimalW) & 1) !== 0);
      const hCol = hInB ? (hW ? hueC[hmh].sl! : hueC[hmh].sd!) : (hW ? hueC[hmh].l : hueC[hmh].d);
      drawHexPath(hk.ux, hk.uy, hexR - 0.5); ctx.fillStyle = lightenHex(hCol, 30); ctx.fill();
    }
  }

  /* selection: brightened hex fills */
  const flashNow = performance.now();
  const flashingSet = new Set<KeyId>();
  for (const fk in audio.rearticulateFlashUntil) {
    if (audio.rearticulateFlashUntil[fk] > flashNow) flashingSet.add(fk);
    else delete audio.rearticulateFlashUntil[fk];
  }
  selection.selectedKeys.forEach((key) => {
    if (flashingSet.has(key)) return;
    const k = posMap[key]; if (!k) return;
    const midi = 57 + 4 * k.q + 7 * k.r; const pc = ((midi % 12) + 12) % 12; const isW = whiteSet.has(pc);
    const mh = computeHue(k.q, k.r);
    const inB = tuning.septimalEnabled && ((Math.floor((k.r - tuning.septimalShift) / tuning.septimalW) & 1) !== 0);
    let col = inB ? (isW ? hueC[mh].sl! : hueC[mh].sd!) : (isW ? hueC[mh].l : hueC[mh].d);
    col = lightenHex(col, 90);
    drawHexPath(k.ux, k.uy, hexR - 0.5); ctx.fillStyle = col; ctx.fill();
  });

  /* selection rings */
  selection.selectedKeys.forEach((key) => {
    if (flashingSet.has(key)) return;
    const k = posMap[key]; if (!k) return;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
    drawHexPath(k.ux, k.uy, hexR - 0.5); ctx.stroke();
  });

  /* lattice seams — skip in Equal mode (no seams) */
  if (showB && !tuning.equalEnabled) {
    const eHL = hexR * 0.55; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.lineCap = 'butt';
    const drawnSeams = new Set<string>();
    const allSet = new Set<string>(allKeys.map((k) => k.q + ',' + k.r));
    const dirs: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [-1, 1], [1, -1]];
    const animT = animation.progress;
    const seamBlend = animT < 0 ? 1 : Math.pow(Math.abs(2 * animT - 1), 6);
    const olOX = (kbShQ - view.viewQ) * dxH + (kbShR - view.viewR) * dxH * 0.5;
    const olOY = -(kbShR - view.viewR) * dyH;
    function snapVtx(px: number, py: number): { d: number; x: number; y: number } | null {
      let bd = Infinity, bpx = 0, bpy = 0;
      for (let pi = 0; pi < kbOutlinePaths.length; pi++) {
        const poly = kbOutlinePaths[pi];
        for (let i = 0; i < poly.length; i++) {
          const vx = poly[i][0] + olOX, vy = poly[i][1] + olOY;
          const d2 = (px - vx) * (px - vx) + (py - vy) * (py - vy);
          if (d2 < bd) { bd = d2; bpx = vx; bpy = vy; }
        }
      }
      return bd < 36 ? { d: Math.sqrt(bd), x: bpx, y: bpy } : null;
    }
    const seamSegs: [number, number, number, number][] = [];
    allKeys.forEach((k) => {
      dirs.forEach((d) => {
        const nq = k.q + d[0], nr = k.r + d[1], nk = nq + ',' + nr;
        if (!allSet.has(nk)) return;
        const sameBand = bandOf(k.q) === bandOf(nq);
        const sameRegion = !tuning.septimalEnabled || ((Math.floor((k.r - tuning.septimalShift) / tuning.septimalW) & 1) === (Math.floor((nr - tuning.septimalShift) / tuning.septimalW) & 1));
        if (sameBand && sameRegion) return;
        const sk = k.q < nq || (k.q === nq && k.r < nr) ? k.q + ',' + k.r + '/' + nq + ',' + nr : nq + ',' + nr + '/' + k.q + ',' + k.r;
        if (drawnSeams.has(sk)) return; drawnSeams.add(sk);
        const nb = posMap[nk]; if (!nb) return;
        const mx = (k.ux + nb.ux) / 2, my = (k.uy + nb.uy) / 2;
        const dx2 = nb.ux - k.ux, dy2 = nb.uy - k.uy, len = Math.sqrt(dx2 * dx2 + dy2 * dy2);
        const nx = -dy2 / len, ny = dx2 / len;
        let p1x = mx + nx * eHL, p1y = my + ny * eHL;
        let p2x = mx - nx * eHL, p2y = my - ny * eHL;
        if (seamBlend > 0.01) {
          const r1 = snapVtx(p1x, p1y);
          if (r1) { p1x += (r1.x - p1x) * seamBlend; p1y += (r1.y - p1y) * seamBlend; }
          const r2 = snapVtx(p2x, p2y);
          if (r2) { p2x += (r2.x - p2x) * seamBlend; p2y += (r2.y - p2y) * seamBlend; }
        }
        seamSegs.push([p1x, p1y, p2x, p2y]);
      });
    });
    if (seamSegs.length) {
      ctx.beginPath();
      seamSegs.forEach((s) => { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); });
      ctx.stroke();
    }
  }

  ctx.restore();

  /* re-render text for selected keys on top of selection fills */
  if (showN && selection.selectedKeys.size > 0) {
    selection.selectedKeys.forEach((key) => {
      if (flashingSet.has(key)) return;
      const k = posMap[key]; if (!k) return;
      const midi = 57 + 4 * k.q + 7 * k.r; const pc = ((midi % 12) + 12) % 12; const isW = whiteSet.has(pc);
      drawNoteName(k.sx, k.sy, noteName(k.q, k.r), isW, false);
    });
  }
  /* re-render hovered key's note name on top of hover fill (skip if already
     handled by the selection re-render above). */
  if (showN && selection.hoverKey && !selection.selectedKeys.has(selection.hoverKey)) {
    const hk = posMap[selection.hoverKey];
    if (hk) {
      const hmidi = 57 + 4 * hk.q + 7 * hk.r; const hpc = ((hmidi % 12) + 12) % 12; const hW = whiteSet.has(hpc);
      drawNoteName(hk.sx, hk.sy, noteName(hk.q, hk.r), hW, false);
    }
  }

  /* === overlay + outline (rotated context, on top of everything) === */
  ctx.save();
  ctx.translate(view.CW / 2, cyC);
  ctx.rotate(-tiltAngle);

  const diag = Math.ceil(Math.sqrt(view.CW * view.CW + view.CH * view.CH));
  ctx.beginPath();
  ctx.rect(-diag, -diag, diag * 2, diag * 2);
  kbOutlinePaths.forEach((poly) => {
    for (let i = 0; i < poly.length; i++) {
      if (i === 0) ctx.moveTo(poly[i][0], poly[i][1]);
      else ctx.lineTo(poly[i][0], poly[i][1]);
    }
    ctx.closePath();
  });
  ctx.fillStyle = showE ? 'rgba(17,17,17,0.65)' : 'rgba(17,17,17,1.0)';
  ctx.fill('evenodd');

  ctx.strokeStyle = '#fff'; ctx.lineWidth = 3.5; ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
  ctx.beginPath();
  kbOutlinePaths.forEach((poly) => {
    for (let i = 0; i < poly.length; i++) {
      if (i === 0) ctx.moveTo(poly[i][0], poly[i][1]);
      else ctx.lineTo(poly[i][0], poly[i][1]);
    }
    ctx.closePath();
  });
  ctx.stroke();

  ctx.restore();

  updateInfo();
}
