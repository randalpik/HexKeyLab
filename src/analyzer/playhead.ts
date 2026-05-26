// Playhead helpers — pure functions for time→x mapping + vertical-line render.
//
// Mirrors HKLViz's coordinate system (analyzer/analyzer-visualization.js:
// ml=50, mr=18, mt=12, mb=22). The playhead canvas is a transparent
// overlay sized 1:1 with the diagnostic canvas; we clear it each frame and
// redraw a single vertical line at the current playback position.

import type { AnalysisResult } from './state.js';

/* Chart margins — keep in sync with analyzer/analyzer-visualization.js. */
const CHART_ML = 50;
const CHART_MR = 18;
const CHART_MT = 12;
const CHART_MB = 22;

/** Compute the time axis range used by HKLViz for this result. Matches
 *  the formula at analyzer-visualization.js:251–253. */
export function computeTMax(result: AnalysisResult | null | undefined): number {
  const diag = (result?.diag || {}) as {
    envCurve?: { startSec: number; hopSec: number; values: ArrayLike<number> };
    trimEndSec?: number;
  };
  const env = diag.envCurve;
  if (!env || !env.values) return 1;
  const totalSec = env.startSec + env.values.length * env.hopSec;
  const trimEnd = diag.trimEndSec ?? 0;
  return Math.max(totalSec, trimEnd + 0.1, 0.01);
}

/** Map time-in-buffer → x pixel on the playhead canvas. */
export function timeToX(t: number, tMax: number, canvasW: number): number {
  const pw = canvasW - CHART_ML - CHART_MR;
  return CHART_ML + (t / tMax) * pw;
}

/** Clear + redraw the playhead at the given buffer time. */
export function drawPlayhead(canvas: HTMLCanvasElement, timeSec: number, tMax: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!isFinite(timeSec) || timeSec < 0) return;
  const x = timeToX(timeSec, tMax, W);
  if (x < CHART_ML - 1 || x > W - CHART_MR + 1) return;
  /* Vertical line spanning the plot area (above the time-axis labels). */
  ctx.strokeStyle = '#FF4C79';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, CHART_MT);
  ctx.lineTo(x + 0.5, H - CHART_MB);
  ctx.stroke();
  /* Tiny down-pointing triangle at the top for visual prominence. */
  ctx.fillStyle = '#FF4C79';
  ctx.beginPath();
  ctx.moveTo(x - 4, CHART_MT);
  ctx.lineTo(x + 4, CHART_MT);
  ctx.lineTo(x, CHART_MT + 6);
  ctx.closePath();
  ctx.fill();
}

/** Clear the playhead canvas (used on stop). */
export function clearPlayhead(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
