// Naming a physical Lumatone key by pressing it.
//
// The Calibration panel's Overrides list adds a key this way: Add arms the
// pick, and the next Lumatone note-on names its key ("ch,note") and ends it.
// The press is an ordinary note as well: it sounds, records and selects as it
// would unarmed (midi/handler.ts offers it here on its way through).

import type { LumatoneKeyId } from '../types.js';

let waiting: ((key: LumatoneKeyId) => void) | null = null;

/** Arm the pick: `fn` gets the next Lumatone key pressed, once. Arming again
 *  replaces a pick still waiting. */
export function armKeyPick(fn: (key: LumatoneKeyId) => void): void { waiting = fn; }

/** End a pick that is still waiting, without a key. */
export function cancelKeyPick(): void { waiting = null; }

export function keyPickArmed(): boolean { return waiting !== null; }

/** A Lumatone key was pressed. Nothing happens unless a pick is waiting. */
export function offerKeyPick(key: LumatoneKeyId): void {
  const fn = waiting;
  if (!fn) return;
  waiting = null;
  fn(key);
}
