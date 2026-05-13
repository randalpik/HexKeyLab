// 7-limit septimal A/B region partitioning.
// Each B band pairs with the A directly above it (higher r = bi+1).
// A bands carry syntonic adjustment ×(81/80)^d going up, ×(80/81)^d going down.
// B bands inherit their paired A's syntonic adjustment, then add ×63/64.
// Result: A↔B seams always 64:63, B↔nextA seams always 5120:5103.
// Regions are lattice-fixed modulo septimalShift.

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
