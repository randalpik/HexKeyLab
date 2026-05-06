// Computer-keyboard note input — always-on listeners on `window`. Maps physical
// keys (event.code) via qwertyKeyMap to a BASE (q, r); we then add the active
// layoutShifts at note-on/off time, mirroring fixedMidiToKey(). The same
// physical key plays a different lattice cell in each layout, so the keyboard
// rides with ♭/♮/♯ exactly like the Lumatone.
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
// Tracking is by event.code (not KeyId) so a layout switch mid-hold still
// resolves keyup to the correct (now-shifted) lattice cell — and the existing
// setLayout migration of selectedKeys/activeOscs keeps audio + selection in
// sync without us having to migrate anything in this module.
//
// Side-effect import: ui/init.ts must `import './input/keyboard-notes.js'` to
// activate the listeners.

import { audio } from '../state/audio.js';
import { selection } from '../state/selection.js';
import { tuning } from '../state/tuning.js';
import { layoutShifts } from '../layout/baseKeys.js';
import { noteOff, triggerRearticulateFlash } from '../audio/engine.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';
import { qwertyKeyMap } from './qwerty.js';
import type { KeyId } from '../types.js';

const KEYBOARD_VELOCITY = 96;

(function () {
  /* Set of event.code strings currently held by the computer keyboard.
     Tracked so blur / visibilitychange can release exactly the keys we hold. */
  const heldCodes = new Set<string>();

  function shouldIgnore(): boolean {
    const ae = document.activeElement;
    if (!ae) return false;
    if (ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA') return true;
    if (ae.tagName === 'INPUT') {
      const t = ((ae as HTMLInputElement).type || '').toLowerCase();
      return t !== 'checkbox' && t !== 'radio' && t !== 'button' && t !== 'submit' && t !== 'reset';
    }
    return false;
  }

  function codeToKey(code: string): KeyId | null {
    const base = qwertyKeyMap[code];
    if (!base) return null;
    const sh = layoutShifts[tuning.curLayout];
    return (base[0] + sh[0]) + ',' + (base[1] + sh[1]);
  }

  function noteOnFromKeyboard(code: string): void {
    const key = codeToKey(code);
    if (!key) return;
    if (audio.activeOscs[key]) {
      /* voice already sounding (e.g. via sustain pedal) — restart with a fresh
         strike, mirroring midi/handler.ts:99–106 */
      noteOff(key);
      triggerRearticulateFlash(key);
    }
    audio.sustainedKeys.delete(key);
    selection.selectedKeys.add(key);
    audio.keyVelocity[key] = KEYBOARD_VELOCITY;
    heldCodes.add(code);
    onSelectionChanged();
  }

  function noteOffFromKeyboard(code: string): void {
    const key = codeToKey(code);
    if (!key) return;
    heldCodes.delete(code);
    if (audio.sustainPedalDown || audio.sostenutoLockedKeys.has(key)) {
      audio.sustainedKeys.add(key);
    } else {
      selection.selectedKeys.delete(key);
      delete audio.keyVelocity[key];
    }
    onSelectionChanged();
  }

  function releaseAll(): void {
    if (heldCodes.size === 0) return;
    /* snapshot first since noteOffFromKeyboard mutates heldCodes */
    Array.from(heldCodes).forEach((c) => { noteOffFromKeyboard(c); });
  }

  window.addEventListener('keydown', function (e) {
    if (shouldIgnore()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.repeat) return;
    if (!qwertyKeyMap[e.code]) return;
    if (heldCodes.has(e.code)) return; /* already held — defensive */
    e.preventDefault();
    noteOnFromKeyboard(e.code);
  });

  window.addEventListener('keyup', function (e) {
    /* deliberately do NOT gate keyup on shouldIgnore() or modifiers — if the
       user moves focus into an input or presses Ctrl after a note-down, we
       still want a clean release on keyup. */
    if (!qwertyKeyMap[e.code]) return;
    if (!heldCodes.has(e.code)) return;
    e.preventDefault();
    noteOffFromKeyboard(e.code);
  });

  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) releaseAll();
  });
})();
