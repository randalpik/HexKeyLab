// 12-TET MIDI → (q, r) resolver for piano-keyboard input.
//
// A standard MIDI piano sends pure 12-TET pitch numbers; every pitch class
// maps to infinitely many lattice cells (related by the enharmonic shift
// ±(7, -4) which preserves 4q + 7r mod 12 since 4·7 + 7·(-4) = 0). We pick the
// cell within the active footprint whose JI ratio to the current reference
// note has the lowest octave-and-complement-reduced Tenney Height — and break
// ties by smallest |proj − octaveTarget| where proj = 7(q−refQ) − 4(r−refR)
// and octaveTarget = 21 · round((midi − refMidi) / 12). The octave-normalized
// projection is invariant under same-pitch-class octave shifts (both proj
// and target shift by 21), so the chosen lineage stays consistent across
// octaves. At the ref's MIDI (target = 0) the rule picks (refQ, refR);
// at ref+12 it picks (refQ+3, refR); etc. This fixes the 7-limit bug where
// a B-region cell can reduce to exactly 1:1 against the ref (the syntonic
// adjustment cancels the (7,-4) shift's comma), tying TH=0 — the old
// largest-proj rule would pick the sibling and exile the ref note from
// its own footprint.

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
  /* Octave step in (q, r) is (+3, 0): 4·3 + 7·0 = 12 semitones. proj shifts
     by 7·3 − 4·0 = 21 per octave. */
  const PROJ_PER_OCT = 7 * 3 - 4 * 0;
  const refMidi = 57 + 4 * refQ + 7 * refR;
  const octaveDelta = Math.round((midiNote - refMidi) / 12);
  const projTarget = PROJ_PER_OCT * octaveDelta;
  let bestQ = 0, bestR = 0;
  let bestTh = Infinity;
  let bestAbsNProj = Infinity;
  let found = false;
  for (const id of footprint) {
    const ci = id.indexOf(',');
    if (ci < 0) continue;
    const q = +id.slice(0, ci);
    const r = +id.slice(ci + 1);
    if (coordToMidi(q, r) !== midiNote) continue;
    const ratio = jiRatio(refQ, refR, q, r);
    const th = tenneyHeightFromExps(ratio.e);
    const absNProj = Math.abs(7 * (q - refQ) - 4 * (r - refR) - projTarget);
    if (th < bestTh || (th === bestTh && absNProj < bestAbsNProj)) {
      bestTh = th;
      bestAbsNProj = absNProj;
      bestQ = q;
      bestR = r;
      found = true;
    }
  }
  return found ? { q: bestQ, r: bestR } : null;
}
