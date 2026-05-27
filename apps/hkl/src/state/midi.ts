import type { KeyId } from '../types.js';

// MIDI port + active-note state. midiToKey is a (note,channel) → "q,r" reverse
// lookup rebuilt by buildMidiReverse on layout change.

interface MidiNote {
  note: number;
  channel: number;
}

export const midi: {
  midiAccess: MIDIAccess | null;
  midiOut: MIDIOutput | null;
  midiIn: MIDIInput | null;
  /** Selected MIDI input for the Piano toolbar (12-TET keyboard). Distinct
   *  from midiIn — Lumatone keeps midiIn; piano traffic flows through this
   *  port instead and is dispatched separately by src/midi/piano.ts. */
  pianoIn: MIDIInput | null;
  /** Selected MIDI output for the Piano toolbar's "Piano output" feature —
   *  an external synth (e.g. Korg SP-250) driven with per-channel RPN
   *  fine-tuning for just-intonation playback. Auto-matched by name to the
   *  selected pianoIn device. Owned by src/midi/piano-out.ts. */
  pianoOut: MIDIOutput | null;
  activeMidiNotes: Record<KeyId, MidiNote>;
  /** "<note>,<channel>" → "q,r" */
  midiToKey: Record<string, KeyId>;
} = {
  midiAccess: null,
  midiOut: null,
  midiIn: null,
  pianoIn: null,
  pianoOut: null,
  activeMidiNotes: {},
  midiToKey: {},
};
