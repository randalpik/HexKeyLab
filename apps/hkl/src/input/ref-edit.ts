// The ref-edit modifier.
//
// One modifier for every input: while it is held, a canvas click or a Lumatone
// key press picks the reference note (input/ref-pick.ts) instead of selecting /
// playing the cell, the canvas dims everything outside the valid-ref region
// (render/draw.ts), and with Key effects on the Lumatone dims the same cells
// (lumatone/sync.ts). Each source that can hold it reports here, and the
// modifier is held while any of them does: the computer keyboard's Ctrl
// (ui/keyboard.ts) and the two Lumatone pedal jacks in their Ctrl role
// (midi/handler.ts). Sources are kept apart so one releasing — a window blur
// drops the keyboard's — never clears what another still holds.
//
// State only, with no imports: render/draw.ts reads it and is in the lean
// overlay build's import graph (docs/architecture/overlay.md), and
// lumatone/sync.ts reads it and is loaded without a DOM by its gate. What a
// change of the modifier causes (redraw, Lumatone color sync) is the listener
// ui/init.ts registers.

export type RefEditSource = 'keyboard' | 'expr' | 'sus';

const holding = new Set<RefEditSource>();
let onChange: (() => void) | null = null;

export function isRefEditHeld(): boolean { return holding.size > 0; }

/** Register the one listener run whenever the modifier (not merely one of its
 *  sources) changes. */
export function setRefEditListener(fn: () => void): void { onChange = fn; }

/** `source` now holds (or no longer holds) the modifier. */
export function setRefEditSource(source: RefEditSource, on: boolean): void {
  const was = isRefEditHeld();
  if (on) holding.add(source); else holding.delete(source);
  if (was !== isRefEditHeld() && onChange) onChange();
}
