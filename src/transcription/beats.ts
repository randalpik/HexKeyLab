// Ellis-style beat tracking by dynamic programming.
//
//   C(t) = s(t) + max(0, max_{t' in [t - dMax, t - dMin]} C(t') - λ(t - t' - T)²)
//
// At each time bin, the best score is either "this is the first beat"
// (zero cumulative penalty) or the best predecessor minus the squared
// deviation from the target period. Traceback from the best score in the
// final window gives the beat sequence. Operates on the 10 ms-binned onset
// envelope.

import type { Onset, TempoEstimate, BeatGrid, Beat } from './types.js';

const BIN_SEC = 0.01;
/** Period-adherence tightness in (bins⁻²). Higher = stricter constant tempo. */
const LAMBDA = 0.5;
/** Search radius around the target period, as a fraction of T. */
const SEARCH_RATIO = 0.5;

export function trackBeats(onsets: Onset[], tempo: TempoEstimate): BeatGrid {
  if (onsets.length === 0) return { beats: [], periodSec: tempo.periodSec };

  const T = tempo.periodSec / BIN_SEC;
  const tLast = Math.max(
    onsets[onsets.length - 1].t,
    onsets[onsets.length - 1].tOff ?? 0,
  );
  const N = Math.ceil((tLast + tempo.periodSec) / BIN_SEC);

  const env = new Float32Array(N);
  for (const o of onsets) {
    const i = Math.floor(o.t / BIN_SEC);
    if (i >= 0 && i < N) env[i] += o.strength;
  }

  const C = new Float32Array(N);
  const back = new Int32Array(N);
  const dMin = Math.max(1, Math.floor(T * (1 - SEARCH_RATIO)));
  const dMax = Math.ceil(T * (1 + SEARCH_RATIO));

  for (let t = 0; t < N; t++) {
    let bestScore = 0; /* "first beat" option */
    let bestPrev = -1;
    const tStart = Math.max(0, t - dMax);
    const tEnd = t - dMin;
    for (let tp = tStart; tp <= tEnd; tp++) {
      const dev = (t - tp) - T;
      const sc = C[tp] - LAMBDA * dev * dev;
      if (sc > bestScore) { bestScore = sc; bestPrev = tp; }
    }
    C[t] = env[t] + bestScore;
    back[t] = bestPrev;
  }

  /* Pick the highest-scoring beat in the final T-sized window. */
  const tailStart = Math.max(0, N - Math.ceil(T * 1.5));
  let endIdx = tailStart;
  let endScore = -Infinity;
  for (let t = tailStart; t < N; t++) {
    if (C[t] > endScore) { endScore = C[t]; endIdx = t; }
  }

  const beatBins: number[] = [];
  let cur = endIdx;
  while (cur >= 0) {
    beatBins.push(cur);
    cur = back[cur];
  }
  beatBins.reverse();

  const beats: Beat[] = beatBins.map((bin, idx) => ({ t: bin * BIN_SEC, idx }));
  return { beats, periodSec: tempo.periodSec };
}
