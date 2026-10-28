// Normalize the reference note to its Pythagorean fifth-chain spine cell.
// The Lumatone outline is rendered statically on screen; the lattice cells
// underneath translate so that refSpine(ref) lands at the outline's center.
// Selecting any ref (regardless of qmod3) thus shifts the lattice such that
// the corresponding Pythag note is centered — replacing the legacy
// flat/natural/sharp layout buttons with a continuous ref-driven mechanism.
//
// The spine is the qm0 column of the ref's OWN octave band, in the ref's row,
// so the ref stays where it sits within its band, next to the center.
//
// Euler (3-wide bands, per design decision):
//   qmod3 = 0  → (q, r)              the cell IS on the Pythag spine
//   qmod3 = 1  → (q − 1, r)          5-limit M3 above same-row qm=0
//   qmod3 = 2  → (q + 1, r)          5-limit m3 above same-row qm=0
//                                    (same-row Pythag spine; matches the
//                                    5-limit interpretation)
//
// Wicki-Hayden (6-wide bands [qm2, qm2′, qm0, qm0′, qm1, qm1′] by (Q+2) mod 6,
// docs/architecture.md → Note-name mapping): the band's qm0 ORIGINAL column — at most 3
// columns away — so the spine always has its copy qm0′ immediately to the
// right: qm2 → Q+2, qm2′ → Q+1, qm0′ → Q−1, qm1 → Q−2, qm1′ → Q−3.
//
// Chromatic (12-wide bands, qm0 at position 4): the same rule — the ref sits
// at most 4 columns left or 7 right of the spine.
//
// One formula covers all three: q − posInBand + W/3 (W = band width, qm0 at
// position W/3).

import { bandWidth, posInBandOf, type Mapping } from '@hkl/shared/mapping.js';

export function refSpine(refQ: number, refR: number, mapping: Mapping): { q: number; r: number } {
  return { q: refQ - posInBandOf(refQ, mapping) + bandWidth(mapping) / 3, r: refR };
}
