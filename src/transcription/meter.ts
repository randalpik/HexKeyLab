// Downbeat-phase search. Returns the phase (0..numerator-1) whose beat
// group carries the highest aggregate onset strength — i.e. which beat
// positions in the recording look most like downbeats. quantize.ts then
// extrapolates the chosen phase backwards by whole bars until the tick
// origin sits at or before the first onset, so no notes are dropped.

import type { Onset, BeatGrid, Meter } from './types.js';

const SUBDIVISIONS = 32;

export function findDownbeatPhase(
  onsets: Onset[],
  beats: BeatGrid,
  numerator: number,
): Meter {
  const num = Math.max(1, numerator);
  if (beats.beats.length === 0) {
    return { numerator: num, denominator: 4, downbeatBeatIdx: 0, subdivisions: SUBDIVISIONS };
  }

  /* Aggregate onset strength near each beat (±20 % of the beat period). */
  const window = beats.periodSec * 0.2;
  const beatStrengths: number[] = beats.beats.map((b) => {
    let s = 0;
    for (const o of onsets) {
      if (Math.abs(o.t - b.t) <= window) s += o.strength;
    }
    return s;
  });

  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < num; phase++) {
    let s = 0;
    for (let i = phase; i < beats.beats.length; i += num) {
      s += beatStrengths[i];
    }
    if (s > bestScore) { bestScore = s; bestPhase = phase; }
  }

  return {
    numerator: num,
    denominator: 4,
    downbeatBeatIdx: bestPhase,
    subdivisions: SUBDIVISIONS,
  };
}
