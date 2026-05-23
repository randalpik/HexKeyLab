// Coordinate ↔ MIDI (note + pitch-bend) math for MPE export/import.
// Anchored on MIDI 69 = A4 = 440 Hz (the MIDI standard reference); HKL's A3 =
// 220 Hz lies at MIDI 57. Pitch-bend range is ±48 semitones encoded as 14-bit
// (0..16383, center 8192), wide enough to cover any JI offset under HKL's
// active layouts even when the 12-TET snap chooses an adjacent semitone.

import { keyFreqWithState } from '../tuning/frequency.js';
import type { LayoutSnapshot } from '../recording/types.js';
import type { TuningStateLike } from '../tuning/regions.js';

export const MPE_BEND_RANGE_SEMITONES = 48;

export function snapshotToTuningState(s: LayoutSnapshot): TuningStateLike {
  return {
    mode: s.tuning,
    equalEnabled: s.equalEnabled,
    septimalEnabled: s.septimalEnabled,
    septimalW: s.septimalW,
  };
}

/* Compute the MIDI note + 14-bit pitch-bend that represents the coordinate's
   frequency under the snapshot. bend14 is 0..16383 (unsigned); convert to
   signed (subtract 8192) when emitting via midi-file. */
export function coordToMidi(q: number, r: number, snapshot: LayoutSnapshot): { note: number; bend14: number } {
  const state = snapshotToTuningState(snapshot);
  const f = keyFreqWithState(q, r, state);
  const midiFloat = 69 + 12 * Math.log2(f / 440);
  const noteSnap = Math.max(0, Math.min(127, Math.round(midiFloat)));
  const bendSemis = midiFloat - noteSnap;
  const bend14 = Math.max(0, Math.min(16383,
    Math.round(8192 + (bendSemis / MPE_BEND_RANGE_SEMITONES) * 8192)));
  return { note: noteSnap, bend14 };
}

/* Inverse: derive the frequency a (note, bend) triple represents under the
   ±48-semitone bend range. */
export function midiToFreq(note: number, bend14: number): number {
  const bendSemis = ((bend14 - 8192) / 8192) * MPE_BEND_RANGE_SEMITONES;
  const midiFloat = note + bendSemis;
  return 440 * Math.pow(2, (midiFloat - 69) / 12);
}
