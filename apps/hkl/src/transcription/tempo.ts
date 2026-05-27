// IOI autocorrelation with a log-Gaussian tempo prior. Operates on a
// time-discretized onset-strength envelope (10 ms bins). Search range is
// 40..240 BPM, narrowed to ±15 % around an explicit BPM hint when supplied.
// Parabolic peak interpolation gives sub-bin accuracy.

import type { Onset, TempoEstimate } from './types.js';

const BIN_SEC = 0.01;
const MIN_PERIOD_SEC = 0.25; /* 240 BPM */
const MAX_PERIOD_SEC = 1.50; /* 40 BPM */
const PRIOR_CENTER_BPM = 100;
const PRIOR_SIGMA_LOG = 0.3;
const HINT_TOLERANCE = 0.15;

export function estimateTempo(onsets: Onset[], hint: number | null): TempoEstimate {
  if (onsets.length < 2) {
    const bpm = hint ?? 120;
    return { bpm, periodSec: 60 / bpm, confidence: 0 };
  }

  /* Build onset envelope. */
  const tLast = onsets[onsets.length - 1].t;
  const N = Math.max(1, Math.ceil((tLast + 1) / BIN_SEC));
  const env = new Float32Array(N);
  for (const o of onsets) {
    const i = Math.floor(o.t / BIN_SEC);
    if (i >= 0 && i < N) env[i] += o.strength;
  }

  /* Candidate lag range (in bins). */
  let lo = Math.floor(MIN_PERIOD_SEC / BIN_SEC);
  let hi = Math.floor(MAX_PERIOD_SEC / BIN_SEC);
  if (hint !== null && hint > 0) {
    const hp = 60 / hint;
    lo = Math.max(lo, Math.floor(hp * (1 - HINT_TOLERANCE) / BIN_SEC));
    hi = Math.min(hi, Math.ceil(hp * (1 + HINT_TOLERANCE) / BIN_SEC));
  }
  if (hi <= lo) hi = lo + 1;
  if (hi >= N) hi = N - 1;
  if (lo < 1) lo = 1;

  const logCenter = Math.log(60 / PRIOR_CENTER_BPM);
  const sigma2 = PRIOR_SIGMA_LOG * PRIOR_SIGMA_LOG;

  /* Pre-compute autocorrelation at each candidate lag. */
  const ac = new Float64Array(hi - lo + 1);
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    const lim = N - lag;
    for (let i = 0; i < lim; i++) s += env[i] * env[i + lag];
    ac[lag - lo] = s;
  }

  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let k = 0; k < ac.length; k++) {
    const lag = lo + k;
    const logP = Math.log(lag * BIN_SEC);
    const prior = Math.exp(-((logP - logCenter) ** 2) / (2 * sigma2));
    const score = ac[k] * prior;
    if (score > bestScore) { bestScore = score; bestIdx = k; }
  }

  /* Parabolic interpolation for sub-bin peak. */
  let lagFinal = lo + bestIdx;
  if (bestIdx > 0 && bestIdx < ac.length - 1) {
    const y0 = ac[bestIdx - 1], y1 = ac[bestIdx], y2 = ac[bestIdx + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) {
      const delta = 0.5 * (y0 - y2) / denom;
      if (delta > -1 && delta < 1) lagFinal = lo + bestIdx + delta;
    }
  }

  const periodSec = lagFinal * BIN_SEC;
  const bpm = 60 / periodSec;

  let totalEnergy = 0;
  for (let i = 0; i < N; i++) totalEnergy += env[i] * env[i];
  const confidence = totalEnergy > 0 ? Math.min(1, ac[bestIdx] / totalEnergy) : 0;

  return { bpm, periodSec, confidence };
}
