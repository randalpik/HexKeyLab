// The ref-edit modifier.
//
// One modifier for every input: while it is held, a canvas click or a Lumatone
// key press picks the reference note (input/ref-pick.ts) instead of selecting /
// playing the cell, and the canvas dims everything outside the valid-ref region
// (render/draw.ts). Each source that can hold it reports here, and the modifier
// is held while any of them does: the computer keyboard's Ctrl (ui/keyboard.ts)
// and the two Lumatone pedal jacks in their Ctrl role (midi/handler.ts).
// Sources are kept apart so one releasing — a window blur drops the keyboard's
// — never clears what another still holds.
//
// State only, and engine-free: render/draw.ts reads it, and draw.ts is in the
// lean overlay build's import graph (docs/architecture/overlay.md).

import { draw } from '../render/draw.js';

export type RefEditSource = 'keyboard' | 'expr' | 'sus';

const holding = new Set<RefEditSource>();

export function isRefEditHeld(): boolean { return holding.size > 0; }

/** `source` now holds (or no longer holds) the modifier. Redraws when the
 *  modifier itself changes, for the valid-ref dimming. */
export function setRefEditSource(source: RefEditSource, on: boolean): void {
  const was = isRefEditHeld();
  if (on) holding.add(source); else holding.delete(source);
  if (was !== isRefEditHeld()) draw();
}
