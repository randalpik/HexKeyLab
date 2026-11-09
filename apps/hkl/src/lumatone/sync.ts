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
import { selection } from '../state/selection.js';
import { savePrefs } from '../state/persistence.js';
import { lumatoneCell } from '../layout/physical.js';
/* The LED color is the same hueC variant the canvas lightens on hover, so applying
   HOVER_LIGHTEN here changes the device key exactly as the screen key changes. */
import { keyColorHex, lightenHex, HOVER_LIGHTEN } from '../render/colors.js';
import {
  sysexBoardFor, fixedMidiChannelMap,
  SYSEX_CMD_SET_AFTERTOUCH_FLAG, SYSEX_CMD_SET_LIGHT_ON_KEYSTROKES,
  FRAME_FIRMWARE, firmwareAtLeast,
  buildNoteSysEx, buildColorSysEx, buildToggleSysEx, buildFrameSysEx,
} from './protocol.js';
import { sysex } from './sysex.js';
import { orderColorSync } from './sync-order.js';
import type { SysexMessage } from '../types.js';

/* Firmware 1.5.0+ takes all 280 colors in one 55h frame (~17ms to land on every
   board); older firmware gets the per-key 01h wipe. */
export function frameSyncActive(): boolean {
  return firmwareAtLeast(lumatone.firmware, FRAME_FIRMWARE);
}

/* Canvas hover changed (ui/init.ts mousemove/mouseleave). Mirrored onto the device
   only with the Hover checkbox on, and only on the frame path. */
export function syncLumatoneHover(): void {
  if (lumatone.hoverMirror && frameSyncActive()) syncLumatoneColors('hover');
}

/* Hover checkbox handler. Re-syncs at once, so turning it off clears a highlight
   the device is showing and turning it on shows the current hover. */
export function toggleLumatoneHover(): void {
  const cb = document.getElementById('cbLumaHover') as HTMLInputElement;
  lumatone.hoverMirror = cb.checked;
  savePrefs({ lumatoneHover: lumatone.hoverMirror });
  syncLumatoneColors();
}

/* Unified sync entry point. Builds the full queue (setup if needed + color diff),
   then either starts sending or swaps the queue if a push is already running. */
export function syncLumatoneColors(cause: 'hover' | 'sync' = 'sync'): void {
  if (!midi.midiOut || !lumatone.autoSyncEnabled) return;
  const causeAt = performance.now();
  const frames = frameSyncActive();

  /* Compute target colors for all 280 physical keys: the color of the cell
     each key plays (layout/physical.ts). The Lumatone outline is statically
     positioned on screen; the lattice underneath shifts by kbAnchor (only
     updated by user-driven ref changes). On the frame path, with Hover on, the
     hovered cell's key is lightened as on the canvas. */
  const target: string[] = [];
  for (let i = 0; i < 280; i++) {
    const [q, r] = lumatoneCell(i);
    const color = keyColorHex(q, r);
    const hovered = frames && lumatone.hoverMirror && selection.hoverKey === q + ',' + r;
    target.push(hovered ? lightenHex(color, HOVER_LIGHTEN) : color);
  }
  if (!lumatone.deviceColors) lumatone.deviceColors = new Array<string | null>(280).fill(null);

  /* Predicted post-ACK lumatone.deviceColors: factor in the in-flight message.
     Without this, a color message on the wire can ACK after our new queue is
     already built, landing its (now-obsolete) color on the device and leaving
     that key stuck — because the new diff saw lumatone.deviceColors before the ACK
     and decided the key didn't need an update. Prediction closes that race. */
  let predicted: (string | null)[] = lumatone.deviceColors;
  const inFlight = sysex.inFlight;
  if (inFlight && inFlight.frameColors) {
    predicted = inFlight.frameColors;
  } else if (inFlight && inFlight.keyIdx !== undefined) {
    predicted = lumatone.deviceColors.slice();
    predicted[inFlight.keyIdx] = inFlight.color ?? null;
  }

  const newQ: SysexMessage[] = [];

  /* One-time setup: fixed MIDI layout + aftertouch flag + keystroke-light flag */
  if (!lumatone.fixedLayoutSent) {
    const typeByte = (1 << 4) | 1; /* faderUpIsNull=1, keyType=noteOnNoteOff=1 → 0x11 */
    for (let i = 0; i < 280; i++) {
      const group = Math.floor(i / 56), keyIdx = i % 56;
      const board = sysexBoardFor(group);
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
  if (frames) {
    /* One frame carries the whole target; latest wins (replaceQueue swaps out any
       frame still waiting behind the one in flight). */
    if (changedIdx.length) {
      const frame = buildFrameSysEx(target);
      frame.cause = cause;
      frame.causeAt = causeAt;
      newQ.push(frame);
    }
  } else {
    /* Top→bottom physical wipe with unconditional board alternation where
       possible. Setup precedes colors; otherwise the in-flight board seeds
       ordering so a mid-push replacement also avoids repeating that board. */
    const previousBoard = newQ.length ? newQ[newQ.length - 1][4] : inFlight?.[4];
    for (const i of orderColorSync(changedIdx, previousBoard)) {
      const group = Math.floor(i / 56), keyIdx = i % 56;
      const board = sysexBoardFor(group);
      newQ.push(buildColorSysEx(board, keyIdx, target[i], i));
    }
  }

  /* Already in sync with the device's predicted state. If a push is running,
     still replace the queue: colors queued behind the in-flight message are now
     stale (e.g. hover left and came back before the in-flight frame's ACK), and
     sending them would leave the device showing the wrong state. */
  if (newQ.length === 0 && !sysex.isInProgress) return;

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
