// 12-TET MIDI → (q, r) resolver for piano-keyboard input.
//
// A standard MIDI piano sends pure 12-TET pitch numbers; every pitch class
// maps to infinitely many lattice cells (related by the enharmonic shift
// ±(7, -4) which preserves 4q + 7r mod 12 since 4·7 + 7·(-4) = 0). We pick the
// cell within the active footprint whose JI ratio to the current reference
// note has the lowest octave-and-complement-reduced Tenney Height — and break
// ties by largest syntonic-axis projection (7·(q−refQ) − 4·(r−refR)). This
// tiebreak is octave-invariant: an octave shift (+3q) adds 21 to projection
// while a syntonic-comma shift (±7q, ∓4r) adds ±65, so the larger-projection
// candidate is preserved across octaves. Taxicab-from-refNote, the previous
// rule, was not octave-invariant — it picked different enharmonics for the
// same pitch class at different octaves (see tools/bounds-probe/
// octave-consistency.mjs).

import { jiRatio, tenneyHeightFromExps } from './ratios.js';
import { coordToMidi } from '../transcription/pitch.js';
import type { KeyId } from '../types.js';

export interface ResolvedCoord { q: number; r: number; }

/** Resolve a 12-TET MIDI note to the best (q, r) within `footprint`, ranked
 *  by reduced Tenney Height of the JI interval to (refQ, refR); ties broken
 *  by largest syntonic-axis projection. Returns null when no candidate in
 *  the footprint matches the target MIDI exactly (octave-aware). */
export function resolve12TetToCoord(
  midiNote: number,
  refQ: number,
  refR: number,
  footprint: Set<KeyId>,
): ResolvedCoord | null {
  let bestQ = 0, bestR = 0;
  let bestTh = Infinity;
  let bestProj = -Infinity;
  let found = false;
  for (const id of footprint) {
    const ci = id.indexOf(',');
    if (ci < 0) continue;
    const q = +id.slice(0, ci);
    const r = +id.slice(ci + 1);
    if (coordToMidi(q, r) !== midiNote) continue;
    const ratio = jiRatio(refQ, refR, q, r);
    const th = tenneyHeightFromExps(ratio.e);
    const proj = 7 * (q - refQ) - 4 * (r - refR);
    if (th < bestTh || (th === bestTh && proj > bestProj)) {
      bestTh = th;
      bestProj = proj;
      bestQ = q;
      bestR = r;
      found = true;
    }
  }
  return found ? { q: bestQ, r: bestR } : null;
}
