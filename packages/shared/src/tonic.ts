// Where a key's tonic sits on the lattice.
//
// One rule, for every consumer: Composer's score reference (the key signature's
// tonic, which HKL follows) and the starting note of the lattice shape guide
// (apps/hkl/src/shapes). Pure: no DOM, no state.

import { coordToMidi } from './freq.js';
import { fromEuler, type Mapping } from './mapping.js';
import { fifthName } from './notes.js';

export interface TonicCoord { q: number; r: number }

/** tonic → r on the qm=0 spine (fifth-chain from A). Derived once from
 *  fifthName() so the table stays in sync with the lattice naming algorithm.
 *  Major tonics span r ∈ [-10, 4] (C♭ … C♯); relative-minor tonics shift up by
 *  three fifths, so a♭…a♯ spans r ∈ [-7, 7]. The combined range is [-10, 7]. */
const TONIC_R: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (let r = -10; r <= 7; r++) m.set(fifthName(r), r);
  return m;
})();

/** Place a tonic on the qm=0 Pythagorean spine at the octave CLOSEST TO C4
 *  (MIDI 60). The spine *is* the fifth-chain, so r is fixed by tonic identity
 *  and only the octave is free; walk q by ±3 (one octave per step) into the
 *  12-semitone window [54, 66).
 *
 *  That window is exactly "nearest C4": tonics a fifth-or-less above C land in
 *  C4..F4, the rest in F#3..B3. The tritone (F#/Gb) is genuinely equidistant
 *  (54 and 66 are both 6 semitones out) and the half-open window resolves it
 *  DOWNWARD, to F#3.
 *
 *  Every tonic coord lands in MIDI 54–65, inside HKL's piano range
 *  (validateRefNoteCandidate), so a key-derived ref is never rejected on arrival.
 *
 *  Placed in Euler coordinates, then expressed in `mapping` by fromEuler (the
 *  cell with that Euler-equivalent; under Wicki-Hayden the spine's original
 *  column, with its copy to the right). An octave step is a band step, so the
 *  key is on the spine column of whichever band holds that octave: taken as
 *  the reference, with the anchor following it, it keeps every interval the
 *  spine's own key would have. */
export function findTonicCoord(tonic: string, mapping: Mapping): TonicCoord {
  const r = TONIC_R.get(tonic) ?? -3; /* fall back to C-spine coord if somehow off-table */
  let q = 0;
  while (coordToMidi(q, r, 'euler') < 54) q += 3;
  while (coordToMidi(q, r, 'euler') >= 66) q -= 3;
  const [fq, fr] = fromEuler(q, r, mapping);
  return { q: fq, r: fr };
}

/** The fifteen major-key tonics, the roots of the key signatures from seven
 *  flats to seven sharps, in fifths: Cb Gb Db Ab Eb Bb F C G D A E B F# C#. */
export const MAJOR_TONICS: ReadonlyArray<string> = Array.from({ length: 15 }, (_, i) => fifthName(i - 10));

/** A tonic as a URL can carry it ("F#" → "Fs"), and back; null for anything
 *  that is not one of MAJOR_TONICS. */
export const tonicId = (tonic: string): string => tonic.replace(/#/g, 's');
export function tonicOfId(id: string | null | undefined): string | null {
  return MAJOR_TONICS.find((t) => tonicId(t) === id) ?? null;
}

/** A tonic as it is printed: "E♭", "F♯". */
export const tonicLabel = (tonic: string): string => tonic[0] + tonic.slice(1).replace(/b/g, '♭').replace(/#/g, '♯');
