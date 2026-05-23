// Window-level keyboard shortcuts. The legacy ♭/♮/♯ layout cycle and
// seam-shift on arrow keys are gone (refSpine took over layout positioning
// and uniform septimal mode dropped the shift parameter). What lives here
// now is global modifier-key state for transient UI cues — currently just
// Ctrl, used by the render layer to dim everything outside the valid-ref
// region while the user is about to Ctrl+click a new reference note.
//
// Derive state from `e.ctrlKey` rather than tracking left/right Ctrl
// separately: both Ctrls map to the same flag, and a Ctrl-combo (Ctrl+Tab,
// Ctrl+C in another tab) that eats one of our key events still leaves the
// next event with an accurate ctrlKey value.

import { draw } from '../render/draw.js';

let ctrlHeld = false;

export function isCtrlHeld(): boolean { return ctrlHeld; }

function setCtrl(next: boolean): void {
  if (ctrlHeld === next) return;
  ctrlHeld = next;
  draw();
}

window.addEventListener('keydown', (e) => { setCtrl(e.ctrlKey); }, { capture: true });
window.addEventListener('keyup', (e) => { setCtrl(e.ctrlKey); }, { capture: true });

/* Recover from stuck-Ctrl when focus leaves the window — mirrors the
   QWERTY note-input cleanup in src/input/keyboard-notes.ts. Without this,
   pressing Ctrl, Alt+Tab away, and releasing Ctrl in another app would
   leave the overlay on until the user tapped Ctrl again here. */
window.addEventListener('blur', () => { setCtrl(false); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) setCtrl(false);
});
