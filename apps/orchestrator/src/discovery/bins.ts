// Velocity-bin detection from a velocity sweep of fingerprints. Within a device
// velocity layer the timbre/level are near-constant; at a layer boundary they
// jump. We build an adjacent-distance curve over the swept velocities and peak-
// pick boundaries where the distance spikes above mean + k·std. No discrete
// jumps (a smooth velocity-curve instrument) ⇒ fall back to N even bins.
//
// Pure + deterministic — unit-tested in test/orchestrator-smoke.

import type { Fingerprint } from './fingerprint.js';
import type { VelocityBin } from '../state.js';

export interface DiscoveryResult {
  distanceCurve: Array<{ v: number; d: number }>;
  boundaries: number[];
  bins: VelocityBin[];
  detected: boolean;
}

export interface DetectOpts {
  /** Boundary threshold = mean(d) + k·std(d). */
  k?: number;
  /** Min separation between boundaries, in sweep steps. */
  minSepSteps?: number;
  /** Fallback bin count when no discrete layers are detected. */
  fallbackBins?: number;
  /** Absolute minimum distance for a boundary, on top of the statistical test.
   *  Prevents a near-featureless (velocity-invariant) device from flagging
   *  noise as boundaries — there the distances are all tiny, so mean+k·std
   *  thresholds on noise. A real layer jump clears this comfortably. */
  absFloor?: number;
  /** Feature weights. */
  wBands?: number;
  wCentroid?: number;
  wLevel?: number;
}

function range(vals: number[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (hi === lo) hi = lo + 1;
  return [lo, hi];
}

function featureVector(fp: Fingerprint, cLo: number, cHi: number, lLo: number, lHi: number, w: Required<DetectOpts>): number[] {
  const v: number[] = [];
  for (const b of fp.bands) v.push(b * w.wBands);
  v.push(((fp.centroidHz - cLo) / (cHi - cLo)) * w.wCentroid);
  v.push(((fp.levelDb - lLo) / (lHi - lLo)) * w.wLevel);
  return v;
}

function l2(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

/** Split 1..127 into `n` contiguous bins; sample velocity = upper-mid of each. */
export function evenBins(n: number, vMin = 1, vMax = 127): VelocityBin[] {
  const out: VelocityBin[] = [];
  const span = (vMax - vMin + 1) / n;
  for (let i = 0; i < n; i++) {
    const lo = Math.round(vMin + i * span);
    const hi = i === n - 1 ? vMax : Math.round(vMin + (i + 1) * span) - 1;
    out.push({ lo, hi, sampleVel: Math.round(lo + 0.75 * (hi - lo)) });
  }
  return out;
}

/** Build bins from sorted boundary velocities partitioning vMin..vMax. */
export function binsFromBoundaries(boundaries: number[], vMin = 1, vMax = 127): VelocityBin[] {
  const cuts = boundaries.filter(b => b > vMin && b < vMax).sort((a, b) => a - b);
  const out: VelocityBin[] = [];
  let lo = vMin;
  for (const c of cuts) {
    const hi = c;
    out.push({ lo, hi, sampleVel: Math.round(lo + 0.75 * (hi - lo)) });
    lo = c + 1;
  }
  out.push({ lo, hi: vMax, sampleVel: Math.round(lo + 0.75 * (vMax - lo)) });
  return out;
}

export function detectBins(fingerprints: Fingerprint[], opts: DetectOpts = {}): DiscoveryResult {
  const w: Required<DetectOpts> = {
    k: opts.k ?? 1.5,
    minSepSteps: opts.minSepSteps ?? 2,
    fallbackBins: opts.fallbackBins ?? 4,
    absFloor: opts.absFloor ?? 0.12,
    wBands: opts.wBands ?? 1,
    wCentroid: opts.wCentroid ?? 0.5,
    wLevel: opts.wLevel ?? 1,
  };
  const fps = fingerprints.slice().sort((a, b) => a.velocity - b.velocity);
  if (fps.length < 3) {
    const bins = evenBins(w.fallbackBins);
    return { distanceCurve: [], boundaries: [], bins, detected: false };
  }

  const [cLo, cHi] = range(fps.map(f => f.centroidHz));
  const [lLo, lHi] = range(fps.map(f => f.levelDb));
  const feats = fps.map(f => featureVector(f, cLo, cHi, lLo, lHi, w));

  // Adjacent-distance curve (placed at the midpoint velocity of each pair).
  const distanceCurve: Array<{ v: number; d: number }> = [];
  for (let i = 0; i < fps.length - 1; i++) {
    distanceCurve.push({ v: (fps[i].velocity + fps[i + 1].velocity) / 2, d: l2(feats[i], feats[i + 1]) });
  }

  const ds = distanceCurve.map(p => p.d);
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  const variance = ds.reduce((a, b) => a + (b - mean) * (b - mean), 0) / ds.length;
  const std = Math.sqrt(variance);
  const threshold = Math.max(mean + w.k * std, w.absFloor);

  // Local maxima above threshold, min-separation enforced.
  const peaks: number[] = [];
  for (let i = 0; i < ds.length; i++) {
    if (ds[i] < threshold) continue;
    const leftOk = i === 0 || ds[i] >= ds[i - 1];
    const rightOk = i === ds.length - 1 || ds[i] >= ds[i + 1];
    if (leftOk && rightOk) {
      if (peaks.length && i - peaks[peaks.length - 1] < w.minSepSteps) {
        if (ds[i] > ds[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
      } else {
        peaks.push(i);
      }
    }
  }

  const boundaries = peaks.map(i => Math.round(distanceCurve[i].v));
  if (boundaries.length === 0) {
    return { distanceCurve, boundaries: [], bins: evenBins(w.fallbackBins), detected: false };
  }
  return { distanceCurve, boundaries, bins: binsFromBoundaries(boundaries), detected: true };
}
