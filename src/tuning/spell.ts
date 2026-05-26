// Resolve a lattice coordinate to a fully-spelled note: pitch name, accidental
// (MEI count-form), octave, MIDI, and dark notehead color. This is the pure
// spelling/color core shared by the Composer bridge (which adds per-voice
// velocity) and the live-chord staff inset (which doesn't need velocity).
//
// Kept in tuning/ (not bridge/) so render-layer code can import it without
// pulling in the bridge's audio/MIDI/state dependencies.

import { noteName, keyOctave, parseNote, accToVal } from './notes.js';
import { darkColorHex, coordToMidi } from '../transcription/pitch.js';

export interface NoteSpec {
  q: number;
  r: number;
  pname: string;   // lowercase 'a'..'g'
  accid: string;   // MEI count-form: '', 's', 'ff', 'sss' …
  oct: number;
  midi: number;
  colorHex: string;
}

/** HKL's internal accidental count string (`#`/`b`) → MEI count string
 *  (`s`/`f`). Empty alteration becomes `''`. No clamping — downstream renders
 *  decompose arbitrary depth. */
export function accToMei(acc: string): string {
  const v = accToVal(acc);
  if (v === 0) return '';
  return (v > 0 ? 's' : 'f').repeat(Math.abs(v));
}

/** Resolve (q, r) to its spelled note + color. Velocity-free; callers that need
 *  velocity (the bridge) layer it on top. */
export function resolveNoteSpec(q: number, r: number): NoteSpec {
  const parsed = parseNote(noteName(q, r));
  return {
    q, r,
    pname: parsed.letter.toLowerCase(),
    accid: accToMei(parsed.acc),
    oct: keyOctave(q, r),
    midi: coordToMidi(q, r),
    colorHex: darkColorHex(q, r),
  };
}
