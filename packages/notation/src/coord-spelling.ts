// Spelling-preserving pitch → (q, r) picker, used by MusicXML import.
//
// A named pitch + octave (e.g. "Gb4") pins a 12-TET MIDI note exactly, so the
// lattice constraint 4q + 7r = MIDI − 57 fixes a single line of cells stepping
// by (Δq, Δr) = (7, −4) — the syntonic-comma direction. Walking that line,
// noteName(q, r) cycles through enharmonic spellings: for MIDI 57, (0,0) /
// (7,−4) / (−7,4) all spell "A3" (comma-variants of the same name), while
// (14,−8) spells "Bbb3". So a given (letter, accidental, octave) corresponds
// to a small cluster of same-named comma-variants, and the lattice holds a
// correct (q, r) for ANY spelling at ANY accidental count.
//
// Unlike the piano-layout picker (compute88PianoCoords), which canonicalizes
// each MIDI to one cell and would re-spell Gb→F#, this preserves the source's
// exact enharmonic spelling and only chooses WHICH comma-variant — the one
// most simply related (lowest Tenney height) to the key center.

import { coordExps, tenneyHeightFromExps } from '@hkl/shared/freq.js';
import { noteName, keyOctave, valToAcc } from '@hkl/shared/notes.js';

/** Pitch class in semitones above C, for the MusicXML <step> letter. */
const PC_FROM_C: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 12-TET MIDI of a spelled pitch (scientific octave; C4 = 60, A3 = 57).
 *  Matches coordToMidi's origin (A3 = 57) so 4q + 7r = midi − 57. */
function spellingToMidi(letter: string, alter: number, octave: number): number {
  return (octave + 1) * 12 + PC_FROM_C[letter] + alter;
}

/** 5-limit base used to rank comma-variants. Import forces Equal tuning, but
 *  the lattice spelling itself is the pure 5-limit chain — coordExps('5')
 *  gives the canonical exponent vector that makes "closest to the tonic" mean
 *  "simplest just relationship to the tonic". */
const RANK_MODE = '5' as const;

/** Window of comma-steps (±) searched along the (7,−4) line. The matching
 *  enharmonic and its comma-variants always fall within a few steps even for
 *  double accidentals; 16 is generous. */
const K_WINDOW = 16;

/** Resolve a source spelling (MusicXML <step>/<alter>/<octave>) to the lattice
 *  cell that preserves that exact spelling, choosing the comma-variant with
 *  minimum Tenney height relative to the key center (centerQ, centerR).
 *
 *  Returns null if no cell in the search window matches the spelling — should
 *  not happen for well-formed input (the lattice contains every spelling). */
export function coordForSpelling(
  letter: string,
  alter: number,
  octave: number,
  centerQ: number,
  centerR: number,
): [number, number] | null {
  const L = letter.toUpperCase();
  if (!(L in PC_FROM_C)) return null;
  const targetName = L + valToAcc(alter);
  const M = spellingToMidi(L, alter, octave) - 57;

  /* One solution of 4q + 7r = M: 4⁻¹ ≡ 2 (mod 7), so q ≡ 2M (mod 7). */
  const q0 = (((2 * M) % 7) + 7) % 7;
  const r0 = (M - 4 * q0) / 7;

  const center = coordExps(centerQ, centerR, RANK_MODE);

  let bestQ = 0, bestR = 0, bestTh = Infinity, found = false;
  for (let k = -K_WINDOW; k <= K_WINDOW; k++) {
    const q = q0 + 7 * k;
    const r = r0 - 4 * k;
    if (noteName(q, r) !== targetName) continue;
    if (keyOctave(q, r) !== octave) continue;
    const e = coordExps(q, r, RANK_MODE);
    const th = tenneyHeightFromExps([
      e[0] - center[0], e[1] - center[1], e[2] - center[2], e[3] - center[3],
    ]);
    if (!found || th < bestTh) {
      bestTh = th; bestQ = q; bestR = r; found = true;
    }
  }
  return found ? [bestQ, bestR] : null;
}
