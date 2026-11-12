// The Lumatone's pedal jacks and what each one does.
//
// Two jacks, each with a role of its own (state/pedal.ts): the expression jack
// (CC 4, continuous) and the sustain jack (CC 64, binary). A role is None,
// Sostenuto, Sustain (the damper) or Ctrl (the ref-edit modifier,
// input/ref-edit.ts). Both jacks may share a role: dampers combine by max,
// sostenuto and Ctrl are held while either pedal is down.
//
// Everything a jack does is derived here, in one place, from two facts: the
// jack's position and its role. applyJacks runs whenever either changes — a CC
// from the device (midi/handler.ts), a dropdown (ui/init.ts), the device
// leaving — so a role changed while the pedal is down is re-read from the
// pedal's position at once, with no transition written by hand.
//
// A binary role (Sostenuto, Ctrl) reads a pedal as down from CC 64 up, which is
// the sustain jack's own threshold. On the continuous expression jack that is
// one threshold with no hysteresis: a pedal resting exactly at its midpoint can
// chatter between down and up.

import { pedal, type PedalJack, type PedalRole } from '../state/pedal.js';
import { setDamperDepth, sostenutoOn, sostenutoOff } from '../audio/engine.js';
import { setRefEditSource } from '../input/ref-edit.js';

const JACKS: readonly PedalJack[] = ['expr', 'sus'];
const DOWN = 64 / 127;

/* Whether the jacks are holding the sostenuto: what they last asked of it, so
   the engine is told only when that changes. A sostenuto engaged by recording
   playback is not theirs to release, and one pedal going further down, or a
   second pedal joining, must not snapshot the held keys again. */
let sostenutoHeld = false;

function downAs(jack: PedalJack, role: PedalRole): boolean {
  return pedal.roles[jack] === role && pedal.position[jack] >= DOWN;
}

/* Let go of what the jacks no longer hold, then engage what they hold now. The
   order matters only when a role changes under a pedal that is down: a damper
   turned sostenuto first releases the notes it was sustaining and then catches
   only the keys still held, and a sostenuto turned damper first releases its
   caught notes and then damps from there. */
function applyJacks(): void {
  const sostenuto = JACKS.some((j) => downAs(j, 'sostenuto'));
  if (!sostenuto && sostenutoHeld) { sostenutoHeld = false; sostenutoOff(); }
  for (const j of JACKS) pedal.damper[j] = pedal.roles[j] === 'sustain' ? pedal.position[j] : 0;
  setDamperDepth();
  if (sostenuto && !sostenutoHeld) { sostenutoHeld = true; sostenutoOn(); }
  for (const j of JACKS) setRefEditSource(j, downAs(j, 'ctrl'));
}

/** The pedal on `jack` moved to `position` (0..1). */
export function setJackPosition(jack: PedalJack, position: number): void {
  pedal.position[jack] = position;
  applyJacks();
}

/** `jack` now has `role`. Its pedal's current position is re-read under it. */
export function setJackRole(jack: PedalJack, role: PedalRole): void {
  pedal.roles[jack] = role;
  applyJacks();
}

/** Both pedals read as released: the device is gone and can never send the
 *  release, or the user forced it (ui/pedalHud.ts). */
export function releaseJacks(): void {
  pedal.position.expr = 0;
  pedal.position.sus = 0;
  applyJacks();
}

/** Whether a jack is holding the ref-edit modifier (for the liveness heartbeat:
 *  a dead port would leave it held). */
export function jacksHoldRefEdit(): boolean {
  return JACKS.some((j) => downAs(j, 'ctrl'));
}
