// Computer-keyboard note input — always-on listeners on `window`. Maps physical
// keys (event.code) via qwertyKeyMap to a BASE (q, r); we then add the active
// kbAnchor offset at note-on time, mirroring fixedMidiToKey(). The same
// physical key plays a different lattice cell at each user-driven ref change,
// so the keyboard rides with the layout shift exactly like the Lumatone.
//
// Skipped on:
//   • form-field focus (typing must not play notes)
//   • Ctrl/Alt/Meta held (browser/system shortcuts pass through). Shift is OK
//     because event.code is layout-independent.
//   • event.repeat (auto-repeat must not retrigger)
//
// Sustain pedal interaction matches MIDI: if the pedal is down at keyup, the
// note moves to audio.sustainedKeys instead of releasing.
//
// Held codes are tracked in input/held.ts (source 'qwerty'), each recording the
// KeyId it struck, so keyup releases that cell whatever the anchor is now.
// migrateHeldQwertyVoices, called from onRefChanged, re-targets held voices
// and the selection set to follow the lattice shift.
//
// Side-effect import: ui/init.ts must `import './input/keyboard-notes.js'` to
// activate the listeners.

import { view } from '../state/view.js';
import { qwertyKeyMap } from './qwerty.js';
import { heldKey, pressHeld, releaseHeld, releaseAllHeld, migrateHeld } from './held.js';
import { DEFAULT_DYNAMIC_MAP } from '@hkl/shared/dynamics.js';
import type { KeyId } from '../types.js';

const KEYBOARD_VELOCITY = DEFAULT_DYNAMIC_MAP.f;

function codeToKey(code: string): KeyId | null {
  const base = qwertyKeyMap[code];
  if (!base) return null;
  return (base[0] + view.kbAnchorQ) + ',' + (base[1] + view.kbAnchorR);
}

/** Ref-change migration for QWERTY-held voices: each held code re-resolves
 *  under the new kbAnchor (caller has already advanced it). Returns the number
 *  of voices moved; onRefChanged runs the selection sync. */
export function migrateHeldQwertyVoices(): number {
  return migrateHeld('qwerty', codeToKey);
}

(function () {
  function elCapturesKeys(el: Element | null): boolean {
    if (!el) return false;
    if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const t = ((el as HTMLInputElement).type || '').toLowerCase();
      return t !== 'checkbox' && t !== 'radio' && t !== 'button' && t !== 'submit' && t !== 'reset';
    }
    return false;
  }
  function shouldIgnore(): boolean { return elCapturesKeys(document.activeElement); }

  function noteOnFromKeyboard(code: string): void {
    const key = codeToKey(code);
    if (!key) return;
    pressHeld('qwerty', code, key, KEYBOARD_VELOCITY);
  }

  /* Release exactly the keys we hold (blur / visibilitychange / focus into a
     key-capturing field) — ordinary note-offs, so the pedal still applies. */
  function releaseAll(): void { releaseAllHeld('qwerty'); }

  /* Capture phase + early preventDefault: Firefox runs its built-in
     accelerators (Quick Find on "/" and "'", apostrophe-find, etc.) as the
     keydown default action, so we must cancel BEFORE the bubble phase or
     any later early-return. We still skip when focus is in a form field
     (shouldIgnore) — typing should never be hijacked. */
  window.addEventListener('keydown', function (e) {
    if (shouldIgnore()) return;
    /* Any modifier means a hotkey, never a note (Shift+D, Ctrl+D, …). */
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (!qwertyKeyMap[e.code]) return;
    e.preventDefault();
    if (e.repeat) return;
    if (heldKey('qwerty', e.code) !== undefined) return; /* already held — defensive */
    noteOnFromKeyboard(e.code);
  }, { capture: true });

  window.addEventListener('keyup', function (e) {
    /* deliberately do NOT gate keyup on shouldIgnore() or modifiers — if the
       user moves focus into an input or presses Ctrl after a note-down, we
       still want a clean release on keyup. */
    if (!qwertyKeyMap[e.code]) return;
    e.preventDefault();
    releaseHeld('qwerty', e.code); /* no-op unless held */
  }, { capture: true });

  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) releaseAll();
  });

  /* When focus enters a form field that captures key events (notably an open
     SELECT dropdown — its popup steals subsequent keyup events from our
     window listener), release any currently-held QWERTY notes. Without this,
     clicking a dropdown while a key is held leaves the note stuck. */
  document.addEventListener('focusin', function (e) {
    if (elCapturesKeys(e.target as Element | null)) releaseAll();
  });
})();
