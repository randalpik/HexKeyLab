// 7-limit septimal A/B region partitioning.
// Each B band pairs with the A directly above it (higher r = bi+1).
// A bands carry syntonic adjustment ×(81/80)^d going up, ×(80/81)^d going down.
// B bands inherit their paired A's syntonic adjustment, then add ×63/64.
// Result: A↔B seams always 64:63, B↔nextA seams always 5120:5103.
// Regions are lattice-fixed modulo septimalShift.

import { tuning } from '../state/tuning.js';
import type { RegionInfo } from '../types.js';

export function regionBandIdx(q: number, r: number): number {
  return Math.floor((r - tuning.septimalShift) / tuning.septimalW);
}

/* original band assignment: odd bands are B (septimal), even bands are A */
export function isRegionB(q: number, r: number): boolean {
  return (regionBandIdx(q, r) & 1) !== 0;
}

export function regionInfo(q: number, r: number): RegionInfo {
  if (!tuning.septimalEnabled) return { type: 'A', aDepth: 0, aUpper: false };
  const bi = regionBandIdx(q, r);
  const isB = (bi & 1) !== 0;
  const aBI = isB ? bi + 1 : bi; /* corresponding A band index */
  const aDepth = Math.abs(aBI) / 2;
  const aUpper = aBI > 0;
  return { type: isB ? 'B' : 'A', aDepth, aUpper };
}
