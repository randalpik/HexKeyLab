// Window-level keyboard modifier state. The legacy ♭/♮/♯ layout cycle and
// seam-shift on arrow keys are gone (the ref-driven shift took over layout positioning
// and uniform septimal mode dropped the shift parameter). What lives here
// now is the computer keyboard's hold on the ref-edit modifier: Ctrl, reported
// to input/ref-edit.ts as its 'keyboard' source.
//
// Derive state from `e.ctrlKey` rather than tracking left/right Ctrl
// separately: both Ctrls map to the same flag, and a Ctrl-combo (Ctrl+Tab,
// Ctrl+C in another tab) that eats one of our key events still leaves the
// next event with an accurate ctrlKey value.

import { setRefEditSource } from '../input/ref-edit.js';

const setCtrl = (down: boolean): void => { setRefEditSource('keyboard', down); };

window.addEventListener('keydown', (e) => { setCtrl(e.ctrlKey); }, { capture: true });
window.addEventListener('keyup', (e) => { setCtrl(e.ctrlKey); }, { capture: true });

/* Recover from stuck-Ctrl when focus leaves the window — mirrors the
   QWERTY note-input cleanup in src/input/keyboard-notes.ts. Without this,
   pressing Ctrl, Alt+Tab away, and releasing Ctrl in another app would
   leave the modifier held until the user tapped Ctrl again here. Only the
   keyboard's hold is dropped: a pedal holding the modifier is unaffected. */
window.addEventListener('blur', () => { setCtrl(false); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) setCtrl(false);
});
