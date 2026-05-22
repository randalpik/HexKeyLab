// Keyboard shortcuts.
//
// ←/→  : switch horizontal layouts (♭ ♮ ♯) with wrap-around. Browser auto-repeat
//        is capped by the running layout animation (~500ms), so holding the key
//        gives one shift per animation cycle. Discrete presses faster than that
//        still land as distinct shifts.
// ↑/↓  : septimal seam shift, only in 7-limit mode (no-op otherwise). Uses our
//        own 400ms/80ms repeat timer to exactly match the mouse click-and-hold
//        cadence; browser auto-repeat events are ignored.
//
// Form controls (INPUT/SELECT/TEXTAREA) with focus bypass the handler so arrow
// keys still navigate them normally.

import { tuning } from '../state/tuning.js';
import { animation } from '../render/animation.js';
import { syncLumatoneColors } from '../lumatone/sync.js';
import { shiftSeams } from './controls.js';

(function () {
  /* keyboard seam-shift repeat state — mirrors the mouse IIFE's 400ms/80ms */
  let seamTid: number | null = null, seamIid: number | null = null, seamActiveKey: string | null = null;
  function seamKbStart(dir: number, key: string): void {
    /* clear any prior timer state without invoking the sync-on-release —
       seamKbStop is for external callers (keyup, blur) only. */
    if (seamTid !== null) { clearTimeout(seamTid); seamTid = null; }
    if (seamIid !== null) { clearInterval(seamIid); seamIid = null; }
    seamActiveKey = key;
    shiftSeams(dir);
    seamTid = window.setTimeout(function () {
      seamIid = window.setInterval(function () { shiftSeams(dir); }, 80);
    }, 400);
  }
  function seamKbStop(): void {
    const wasActive = !!(seamTid || seamIid);
    if (seamTid !== null) { clearTimeout(seamTid); seamTid = null; }
    if (seamIid !== null) { clearInterval(seamIid); seamIid = null; }
    seamActiveKey = null;
    if (wasActive) syncLumatoneColors();
  }
  /* SELECT/TEXTAREA (and text-like INPUTs) keep native arrow-key navigation;
     checkboxes and radios fall through so our handler can take priority. */
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
  window.addEventListener('keydown', function (e) {
    if (shouldIgnore()) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const isArrow = (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown');
    /* release focus from any checkbox/radio before acting so our arrow handler
       keeps priority on subsequent presses. Tab remains available for nav. */
    if (isArrow && document.activeElement && (document.activeElement as HTMLElement).blur) {
      (document.activeElement as HTMLElement).blur();
    }
    switch (e.key) {
      case 'ArrowUp':
        if (tuning.septimalEnabled) {
          e.preventDefault();
          /* ignore browser auto-repeat — our own timer handles repeat */
          if (!e.repeat) seamKbStart(1, 'ArrowUp');
        }
        break;
      case 'ArrowDown':
        if (tuning.septimalEnabled) {
          e.preventDefault();
          if (!e.repeat) seamKbStart(-1, 'ArrowDown');
        }
        break;
    }
  });
  window.addEventListener('keyup', function (e) {
    /* only stop if this keyup matches the key that started the repeat */
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && seamActiveKey === e.key) {
      seamKbStop();
    }
  });
  /* if the window loses focus mid-hold, the keyup may never arrive — clean up */
  window.addEventListener('blur', seamKbStop);
})();
