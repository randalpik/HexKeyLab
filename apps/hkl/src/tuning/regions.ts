// Mode-keyed region partitioning. Each lattice cell maps to a RegionInfo
// describing its shift profile relative to the 5-limit (Ptolemaic) base:
//   - aDepth/aUpper: count and direction of syntonic-comma shifts applied
//     (aUpper=true → ×80/81 lowering; aUpper=false → ×81/80 raising)
//   - type: 'A' = no septimal comma; 'B' = additional ×63/64 (septimal)
//
// The frequency/ratio math in frequency.ts and ratios.ts is shift-agnostic
// and just applies whatever RegionInfo this returns, so adding new layouts
// is a question of returning the right RegionInfo per (mode, qmod3).
//
// Per qm column:
//   Ptolemaic ('5')   | A-d0  A-d0  A-d0
//   Pythagorean ('P') | A-d0  A-d1↓ A-d1↑     (qm=1 raised by SC, qm=2 lowered)
//   Semiditonal ('D') | A-d0  A-d0  A-d1↑     (qm=2 lowered by SC only)
//   Septimal ('7')    | A-d0  A-d0  B-d1↑     (qm=2 −SC + septimal 63/64)
//   Schismatic ('V') | A-d0  A-d0  A-d1↑     (same shifts as Semiditonal; V
//                                              differs by an extra schisma^b
//                                              octave-stacking factor in
//                                              freqAt and a matching prime
//                                              decomposition in jiRatioWithState.
//                                              Within-band intervals become
//                                              (PM3, M3); the band-crossing M3
//                                              is spelled d4 and rings as a PM3.)
//   Equal ('E')       — not consulted; frequency.ts has its own early return.

import { tuning } from '../state/tuning.js';
import type { RegionInfo } from '../types.js';
import type { TuningMode } from '../state/persistence.js';

/** Tuning fields needed for frequency + region math. Subset of `tuning` so
 *  consumers (recording snapshot, MIDI import) can pass a stored state without
 *  mutating the live `tuning` module. */
export interface TuningStateLike {
  mode: TuningMode;
  equalEnabled: boolean;
  septimalEnabled: boolean;
  septimalW: number;
}

const A_D0: RegionInfo = { type: 'A', aDepth: 0, aUpper: false };
const A_D1_UPPER: RegionInfo = { type: 'A', aDepth: 1, aUpper: true };   /* −SC */
const A_D1_LOWER: RegionInfo = { type: 'A', aDepth: 1, aUpper: false };  /* +SC */
const B_D1_UPPER: RegionInfo = { type: 'B', aDepth: 1, aUpper: true };   /* Septimal qm=2 */

export function regionInfoWithState(q: number, _r: number, s: TuningStateLike): RegionInfo {
  const qm = ((q % 3) + 3) % 3;
  switch (s.mode) {
    case 'E':
    case '5':
      return A_D0;
    case 'D':
    case 'V':
      return qm === 2 ? A_D1_UPPER : A_D0;
    case 'P':
      return qm === 2 ? A_D1_UPPER : qm === 1 ? A_D1_LOWER : A_D0;
    case '7':
      return qm === 2 ? B_D1_UPPER : A_D0;
  }
}
export function regionInfo(q: number, r: number): RegionInfo {
  return regionInfoWithState(q, r, tuning);
}

/** True iff any cell under this mode has a non-trivial RegionInfo (aDepth>0
 *  or type='B'). Used to gate the region-adjustment loops in frequency.ts /
 *  ratios.ts; Ptolemaic and Equal skip the loop entirely as a fast path. */
export function modeHasShifts(mode: TuningMode): boolean {
  return mode === 'P' || mode === 'D' || mode === '7' || mode === 'V';
}
