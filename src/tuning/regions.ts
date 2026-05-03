// @ts-nocheck
// 7-limit septimal A/B region partitioning.
// Each B band pairs with the A directly above it (higher r = bi+1).
// A bands carry syntonic adjustment ×(81/80)^d going up, ×(80/81)^d going down.
// B bands inherit their paired A's syntonic adjustment, then add ×63/64.
// Result: A↔B seams always 64:63, B↔nextA seams always 5120:5103.
// Regions are lattice-fixed modulo septimalShift.

import { septimalEnabled, septimalShift, septimalW } from '../state/tuning.js';

export function regionBandIdx(q, r) {
  return Math.floor((r - septimalShift) / septimalW);
}

/* original band assignment: odd bands are B (septimal), even bands are A */
export function isRegionB(q, r) {
  return (regionBandIdx(q, r) & 1) !== 0;
}

export function regionInfo(q, r) {
  if (!septimalEnabled) return { type: 'A', aDepth: 0, aUpper: false };
  const bi = regionBandIdx(q, r);
  const isB = (bi & 1) !== 0;
  const aBI = isB ? bi + 1 : bi; /* corresponding A band index */
  const aDepth = Math.abs(aBI) / 2;
  const aUpper = aBI > 0;
  return { type: isB ? 'B' : 'A', aDepth: aDepth, aUpper: aUpper };
}
