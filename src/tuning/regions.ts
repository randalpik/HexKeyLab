// 7-limit septimal A/B region partitioning — uniform mode.
//
// Every qm=2 cell is B-d1-upper (giving each qm=0 Pythag-spine cell its
// harmonic 7th (7/4) exactly two rows up in qm=2 of the same r), all other
// cells are A-d0. Pure function of qmod3 — octave-invariant since (q, r) and
// (q+3, r) share qmod3, and fully key-symmetric.

import { tuning } from '../state/tuning.js';
import type { RegionInfo } from '../types.js';

/** Tuning fields needed for frequency + region math. Subset of `tuning` so
 *  consumers (recording snapshot, MIDI import) can pass a stored state without
 *  mutating the live `tuning` module. */
export interface TuningStateLike {
  equalEnabled: boolean;
  septimalEnabled: boolean;
  septimalW: number;
}

const UNIFORM_QM2_REGION: RegionInfo = { type: 'B', aDepth: 1, aUpper: true };
const UNIFORM_A_REGION: RegionInfo = { type: 'A', aDepth: 0, aUpper: false };

export function regionInfoWithState(q: number, _r: number, s: TuningStateLike): RegionInfo {
  if (!s.septimalEnabled) return UNIFORM_A_REGION;
  return (((q % 3) + 3) % 3) === 2 ? UNIFORM_QM2_REGION : UNIFORM_A_REGION;
}
export function regionInfo(q: number, r: number): RegionInfo {
  return regionInfoWithState(q, r, tuning);
}
