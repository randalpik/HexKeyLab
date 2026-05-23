// Ref-note change fan-out: when the reference note changes, the lattice
// slides under the static Lumatone/QWERTY/none outlines (via refSpine).
// Voices originating from PHYSICAL inputs (Lumatone MIDI, QWERTY keys) follow
// their physical key — they migrate from the old lattice cell to the new one
// so a held key keeps sounding the right relative pitch. Voices originating
// from MOUSE CLICKS stay anchored to the lattice cell they were clicked on.
//
// Call after referenceNote has been updated; pass the (dq, dr) delta of the
// refSpine that the lattice just shifted by.

import { migrateHeldQwertyVoices } from '../input/keyboard-notes.js';
import { migrateHeldLumatoneVoices } from '../midi/handler.js';
import { buildMidiReverse } from '../midi/engine.js';
import { broadcastAllToComposer } from '../bridge/hkl-side.js';

export function onRefChanged(dq: number, dr: number): void {
  if (dq === 0 && dr === 0) return;
  migrateHeldQwertyVoices(dq, dr);
  migrateHeldLumatoneVoices(dq, dr);
  /* Rebuild Lumatone MIDI output reverse-lookup so future note-ons land
     on the right (channel, note) for the new lattice shift. */
  buildMidiReverse();
  /* Resolved spelling/oct/midi of every held key changes when the lattice
     slides, even when the (q, r) set itself doesn't — and the piano-outline
     footprint tracks the ref. Push fresh payloads to Composer. */
  broadcastAllToComposer();
}
