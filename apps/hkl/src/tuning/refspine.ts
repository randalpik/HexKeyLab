// Normalize the reference note to its Pythagorean fifth-chain spine cell.
// The Lumatone outline is rendered statically on screen; the lattice cells
// underneath translate so that refSpine(ref) lands at the outline's center.
// Selecting any ref (regardless of qmod3) thus shifts the lattice such that
// the corresponding Pythag note is centered — replacing the legacy
// flat/natural/sharp layout buttons with a continuous ref-driven mechanism.
//
// Normalization rules (per design decision):
//   qmod3 = 0  → (q, r)              the cell IS on the Pythag spine
//   qmod3 = 1  → (q − 1, r)          5-limit M3 above same-row qm=0
//   qmod3 = 2  → (q + 1, r)          5-limit m3 above same-row qm=0
//                                    (same-row Pythag spine; matches the
//                                    5-limit interpretation)

export function refSpine(refQ: number, refR: number): { q: number; r: number } {
  const qm = ((refQ % 3) + 3) % 3;
  if (qm === 0) return { q: refQ, r: refR };
  if (qm === 1) return { q: refQ - 1, r: refR };
  return { q: refQ + 1, r: refR };
}
