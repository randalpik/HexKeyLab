// 7-limit septimal A/B region partitioning.
// Each B band pairs with the A directly above it (higher r = bi+1).
// A bands carry syntonic adjustment ×(81/80)^d going up, ×(80/81)^d going down.
// B bands inherit their paired A's syntonic adjustment, then add ×63/64.
// Result: A↔B seams always 64:63, B↔nextA seams always 5120:5103.
// Regions are lattice-fixed modulo septimalShift.
//
// Uniform mode (new '7' tuning): every qm=2 cell is B-d1-upper (giving each
// qm=0 spine cell its harmonic 7th two rows up in qm=2), all other cells are
// A-d0. Pure function of qmod3 — octave-invariance is automatic since (q, r)
// and (q+3, r) share qmod3. Replaces the prior per-hex EXP_REGION_MAP scheme.

import { tuning } from '../state/tuning.js';
import type { RegionInfo } from '../types.js';

/** Tuning fields needed for frequency + region math. Subset of `tuning` so
 *  consumers (recording snapshot, MIDI import) can pass a stored state without
 *  mutating the live `tuning` module. */
export interface TuningStateLike {
  equalEnabled: boolean;
  septimalEnabled: boolean;
  septimalShift: number;
  septimalW: number;
  septimalMode?: 'global' | 'uniform';
}

/** Uniform-mode region rule: qm=2 cells are B-d1-upper (yielding 7/4 of the
 *  qm=0 cell two rows below); qm=0 and qm=1 are A-d0. */
const UNIFORM_QM2_REGION: RegionInfo = { type: 'B', aDepth: 1, aUpper: true };
const UNIFORM_A_REGION: RegionInfo = { type: 'A', aDepth: 0, aUpper: false };
function uniformRegion(q: number, _r: number): RegionInfo {
  return (((q % 3) + 3) % 3) === 2 ? UNIFORM_QM2_REGION : UNIFORM_A_REGION;
}

export function regionBandIdxWithState(r: number, s: TuningStateLike): number {
  return Math.floor((r - s.septimalShift) / s.septimalW);
}
export function regionBandIdx(q: number, r: number): number {
  return regionBandIdxWithState(r, tuning);
}

/* original band assignment: odd bands are B (septimal), even bands are A */
export function isRegionB(q: number, r: number): boolean {
  return (regionBandIdx(q, r) & 1) !== 0;
}

export function regionInfoWithState(q: number, r: number, s: TuningStateLike): RegionInfo {
  if (!s.septimalEnabled) return { type: 'A', aDepth: 0, aUpper: false };
  if (s.septimalMode === 'uniform') {
    return uniformRegion(q, r);
  }
  const bi = regionBandIdxWithState(r, s);
  const isB = (bi & 1) !== 0;
  const aBI = isB ? bi + 1 : bi; /* corresponding A band index */
  const aDepth = Math.abs(aBI) / 2;
  const aUpper = aBI > 0;
  return { type: isB ? 'B' : 'A', aDepth, aUpper };
}
export function regionInfo(q: number, r: number): RegionInfo {
  return regionInfoWithState(q, r, tuning);
}
