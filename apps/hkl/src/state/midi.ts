// MIDI port state: the Lumatone ports and the Piano toolbar's ports.

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
} = {
  midiAccess: null,
  midiOut: null,
  midiIn: null,
  pianoIn: null,
  pianoOut: null,
};
