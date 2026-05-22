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
import { view } from '../state/view.js';
import { refSpine } from '../tuning/refspine.js';
import { referenceNote } from '../state/reference.js';
import {
  noteOn, noteOff, triggerRearticulateFlash, instrReplaysOnTranspose,
} from '../audio/engine.js';
import { SampleEngine } from '../audio/samples.js';
import { keyFreq } from '../tuning/frequency.js';
import { animation } from '../render/animation.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';
import { qwertyKeyMap } from './qwerty.js';
import { DEFAULT_DYNAMIC_MAP } from '../shared/dynamics.js';
import type { KeyId, Voice } from '../types.js';

const KEYBOARD_VELOCITY = DEFAULT_DYNAMIC_MAP.f;

/* Filled by the IIFE below so external modules (e.g., the ref-change handler)
   can ask for a smooth migration of QWERTY-held voices when the lattice
   shifts under the slab. */
export let migrateHeldQwertyVoices: (dq: number, dr: number) => void = () => {};

(function () {
  /* Set of event.code strings currently held by the computer keyboard.
     Tracked so blur / visibilitychange can release exactly the keys we hold. */
  const heldCodes = new Set<string>();

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

  function codeToKey(code: string): KeyId | null {
    const base = qwertyKeyMap[code];
    if (!base) return null;
    const sp = refSpine(referenceNote.q, referenceNote.r);
    return (base[0] + sp.q) + ',' + (base[1] + sp.r);
  }

  /* Compute the KeyId a held event.code maps to under an arbitrary shift,
     used to find OLD voices when ref changes. */
  function codeToKeyAt(code: string, qOff: number, rOff: number): KeyId | null {
    const base = qwertyKeyMap[code];
    if (!base) return null;
    return (base[0] + qOff) + ',' + (base[1] + rOff);
  }

  /* Smoothly migrate audio voices currently held via the computer keyboard
     when the layout shifts under a ref change. Mirrors the sustained branch
     of setLayout (controls.ts) but limited to QWERTY-originated voices.
     Sustained / Lumatone-originated voices are left alone. Selection is
     migrated for the same set of keys. Caller invokes this BEFORE the new
     refSpine takes effect (i.e., with the OLD spine as cur and the new one's
     delta as (dq, dr)). */
  migrateHeldQwertyVoices = function (dq: number, dr: number): void {
    if (heldCodes.size === 0) return;
    if (dq === 0 && dr === 0) return;
    /* OLD refSpine offsets (pre-mutation). Subtract dq/dr to find the old spine. */
    const sp = refSpine(referenceNote.q, referenceNote.r);
    const curQ = sp.q - dq, curR = sp.r - dr;
    /* gather (oldKey, newKey) pairs */
    const pairs: { code: string; oldKey: KeyId; newKey: KeyId }[] = [];
    heldCodes.forEach((code) => {
      const oldKey = codeToKeyAt(code, curQ, curR);
      const newKey = codeToKeyAt(code, sp.q, sp.r);
      if (oldKey && newKey && oldKey !== newKey) pairs.push({ code, oldKey, newKey });
    });
    if (pairs.length === 0) return;

    if (audio.audioEnabled && audio.audioCtx) {
      if (instrReplaysOnTranspose()) {
        /* decaying instruments (piano, etc.) or replay-on-transpose
           (organs): stop the old voice at its old pitch and re-attack at
           the new one. Limited to the migrated pairs so other held /
           sustained voices are untouched. */
        pairs.forEach((p) => {
          if (!audio.activeOscs[p.oldKey]) return;
          noteOff(p.oldKey);
          if (audio.keyVelocity[p.oldKey] !== undefined) {
            audio.keyVelocity[p.newKey] = audio.keyVelocity[p.oldKey];
            delete audio.keyVelocity[p.oldKey];
          }
          noteOn(p.newKey, audio.keyVelocity[p.newKey]);
        });
      } else {
        /* sustained: smooth ramp over animation duration */
        const now = audio.audioCtx.currentTime;
        const rampDur = animation.duration / 1000;
        const sampleMoves: { oldKey: KeyId; newKey: KeyId; newFreq: number; vol?: number }[] = [];
        pairs.forEach((p) => {
          const e = audio.activeOscs[p.oldKey];
          if (!e) return;
          const np = p.newKey.split(','), nq = +np[0], nr = +np[1];
          if (e.type === 'osc') {
            e.osc.frequency.setValueAtTime(e.osc.frequency.value, now);
            e.osc.frequency.exponentialRampToValueAtTime(keyFreq(nq, nr), now + rampDur);
            audio.activeOscs[p.newKey] = e;
            delete audio.activeOscs[p.oldKey];
          } else if (e.type === 'sample') {
            sampleMoves.push({ oldKey: p.oldKey, newKey: p.newKey, newFreq: keyFreq(nq, nr) });
          }
          if (audio.keyVelocity[p.oldKey] !== undefined) {
            audio.keyVelocity[p.newKey] = audio.keyVelocity[p.oldKey];
            delete audio.keyVelocity[p.oldKey];
          }
        });
        sampleMoves.forEach((m) => { m.vol = SampleEngine.slideAndFadeOut(m.oldKey, m.newFreq, rampDur); });
        sampleMoves.forEach((m) => {
          SampleEngine.noteOnFaded(m.newKey, m.newFreq, m.vol!, rampDur);
          audio.activeOscs[m.newKey] = { type: 'sample', freq: m.newFreq } as Voice;
          delete audio.activeOscs[m.oldKey];
        });
      }
    }

    /* migrate the corresponding selection entries (so the indicator follows) */
    pairs.forEach((p) => {
      if (selection.selectedKeys.has(p.oldKey)) {
        selection.selectedKeys.delete(p.oldKey);
        selection.selectedKeys.add(p.newKey);
      }
    });
    view.hexDirty = true;
    view.textDirty = true;
    onSelectionChanged();
  };

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

  /* Capture phase + early preventDefault: Firefox runs its built-in
     accelerators (Quick Find on "/" and "'", apostrophe-find, etc.) as the
     keydown default action, so we must cancel BEFORE the bubble phase or
     any later early-return. We still skip when focus is in a form field
     (shouldIgnore) — typing should never be hijacked. */
  window.addEventListener('keydown', function (e) {
    if (shouldIgnore()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!qwertyKeyMap[e.code]) return;
    e.preventDefault();
    if (e.repeat) return;
    if (heldCodes.has(e.code)) return; /* already held — defensive */
    noteOnFromKeyboard(e.code);
  }, { capture: true });

  window.addEventListener('keyup', function (e) {
    /* deliberately do NOT gate keyup on shouldIgnore() or modifiers — if the
       user moves focus into an input or presses Ctrl after a note-down, we
       still want a clean release on keyup. */
    if (!qwertyKeyMap[e.code]) return;
    e.preventDefault();
    if (!heldCodes.has(e.code)) return;
    noteOffFromKeyboard(e.code);
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
