// Frequency calculation per tuning system. A3 = 220 Hz is the central reference.
// The pure math lives in src/shared/freq.ts so the Composer side can use it
// without pulling in live HKL state. This file is the HKL-side wrapper.

import type { TuningStateLike } from './regions.js';
import { freqAt } from '@hkl/shared/freq.js';
import { tuning } from '../state/tuning.js';

/** Compute frequency under an arbitrary tuning state — used by the recording
 *  layer to resolve coordinates against a stored snapshot without mutating
 *  live `tuning`. The zero-arg `keyFreq` is a wrapper that passes live state. */
export function keyFreqWithState(q: number, r: number, s: TuningStateLike): number {
  return freqAt(q, r, s.mode);
}

export function keyFreq(q: number, r: number): number {
  return freqAt(q, r, tuning.mode);
}
