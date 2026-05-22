// Lumatone color sync: diff-based push of all 280 key colors over SysEx.
//
// Builds a fresh target snapshot from current tuning/layout state, computes
// the diff against `lumatone.deviceColors` (with the predicted snapshot
// trick from lessons.md to absorb the in-flight message), and hands the
// resulting message batch to the encapsulated SysEx queue.
//
// First-time-this-connection setup: a one-shot batch of 280 CHANGE_KEY_NOTE
// messages (fixed MIDI layout: channels 1-5 × notes 0-55) plus the global
// aftertouch + keystroke-light flags. Gated by lumatone.fixedLayoutSent so
// re-syncs don't repeat the setup.

import { midi } from '../state/midi.js';
import { lumatone } from '../state/lumatone.js';
import { savePrefs } from '../state/persistence.js';
import { baseKeys } from '../layout/baseKeys.js';
import { referenceNote } from '../state/reference.js';
import { refSpine } from '../tuning/refspine.js';
import { keyColorHex } from '../render/colors.js';
import {
  sysexBoardMap, fixedMidiChannelMap,
  SYSEX_CMD_SET_AFTERTOUCH_FLAG, SYSEX_CMD_SET_LIGHT_ON_KEYSTROKES,
  buildNoteSysEx, buildColorSysEx, buildToggleSysEx,
} from './protocol.js';
import { sysex } from './sysex.js';
import type { SysexMessage } from '../types.js';

/* Unified sync entry point. Builds the full queue (setup if needed + color diff),
   then either starts sending or swaps the queue if a push is already running. */
export function syncLumatoneColors(): void {
  if (!midi.midiOut || !lumatone.autoSyncEnabled) return;

  /* Compute target colors for all 280 physical keys. The Lumatone outline
     is statically positioned on screen; the lattice underneath shifts by
     refSpine of the current reference note (§ refSpine). */
  const sp = refSpine(referenceNote.q, referenceNote.r);
  const target: string[] = [];
  for (let i = 0; i < 280; i++) {
    const q = baseKeys[i][0] + sp.q, r = baseKeys[i][1] + sp.r;
    target.push(keyColorHex(q, r));
  }
  if (!lumatone.deviceColors) lumatone.deviceColors = new Array<string | null>(280).fill(null);

  /* Predicted post-ACK lumatone.deviceColors: factor in the in-flight message.
     Without this, a color message on the wire can ACK after our new queue is
     already built, landing its (now-obsolete) color on the device and leaving
     that key stuck — because the new diff saw lumatone.deviceColors before the ACK
     and decided the key didn't need an update. Prediction closes that race. */
  let predicted: (string | null)[] = lumatone.deviceColors;
  const inFlight = sysex.inFlight;
  if (inFlight && inFlight.keyIdx !== undefined) {
    predicted = lumatone.deviceColors.slice();
    predicted[inFlight.keyIdx] = inFlight.color ?? null;
  }

  const newQ: SysexMessage[] = [];

  /* One-time setup: fixed MIDI layout + aftertouch flag + keystroke-light flag */
  if (!lumatone.fixedLayoutSent) {
    const typeByte = (1 << 4) | 1; /* faderUpIsNull=1, keyType=noteOnNoteOff=1 → 0x11 */
    for (let i = 0; i < 280; i++) {
      const group = Math.floor(i / 56), keyIdx = i % 56;
      const board = sysexBoardMap[group];
      const channel = fixedMidiChannelMap[group];
      newQ.push(buildNoteSysEx(board, keyIdx, keyIdx, channel, typeByte));
    }
    newQ.push(buildToggleSysEx(SYSEX_CMD_SET_AFTERTOUCH_FLAG, 1));
    newQ.push(buildToggleSysEx(SYSEX_CMD_SET_LIGHT_ON_KEYSTROKES, 1));
    lumatone.fixedLayoutSent = true;
  }

  /* Diff predicted vs target — collect changed key indices */
  const changedIdx: number[] = [];
  for (let i = 0; i < 280; i++) {
    if (predicted[i] === target[i]) continue;
    changedIdx.push(i);
  }
  /* Sort left→right: +q overall, −r within same q (visual wipe) */
  changedIdx.sort(function (a, b) {
    const dq = baseKeys[a][0] - baseKeys[b][0];
    if (dq !== 0) return dq;
    return baseKeys[b][1] - baseKeys[a][1];
  });
  for (let j = 0; j < changedIdx.length; j++) {
    const i = changedIdx[j];
    const group = Math.floor(i / 56), keyIdx = i % 56;
    const board = sysexBoardMap[group];
    newQ.push(buildColorSysEx(board, keyIdx, target[i], i));
  }

  if (newQ.length === 0) return; /* already in sync */

  /* Option B: swap queue in place, let in-flight message complete naturally.
     The new queue takes over once the wire is free. */
  sysex.replaceQueue(newQ);
}

/* Auto-sync checkbox handler. */
export function toggleAutoSync(): void {
  const cb = document.getElementById('cbAutoSync') as HTMLInputElement;
  lumatone.autoSyncEnabled = cb.checked;
  savePrefs({ autoSync: lumatone.autoSyncEnabled });
  if (lumatone.autoSyncEnabled) {
    /* OFF → ON: full initial sync (setup + all colors). If no device connected
       yet, this no-ops; findLumatone will pick up the state on next connection. */
    if (midi.midiOut) syncLumatoneColors();
  } else {
    /* ON → OFF: cancel in-flight work. Leave device in whatever state it's in;
       lumatone.deviceColors remains valid best-known state for a future re-enable. */
    sysex.cancel();
  }
}
