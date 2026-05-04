// Lumatone SysEx queue (encapsulated).
//
// Single-message-in-flight queue with ACK matching, busy-retry, and a no-MIDI-
// input fallback delay. New syncs swap the queue in place — the in-flight
// message completes naturally (Option B from lessons.md). The caller then
// builds a fresh diff against `lumatone.deviceColors`, which is updated on
// every ACK so the cache reflects what the device has actually committed.
//
// Predicted snapshot: syncLumatoneColors reads `sysex.inFlight` and folds the
// in-flight message's intended state into its diff, so an ACK landing after
// the new queue is built can't leave a stuck color (lessons.md).
//
// Two push modes:
//   • silent  — control commands (firmware query, pedal calibration). UI status
//               stays "Idle"; queue is appended-to if a push is already running.
//   • visible — color sync (replaceQueue). UI shows N/M progress.

import { midi } from '../state/midi.js';
import { lumatone } from '../state/lumatone.js';
import {
  SYSEX_MANU, SYSEX_ACK, SYSEX_NACK, SYSEX_BUSY,
  SYSEX_CMD_GET_FIRMWARE_REVISION,
  buildRequestSysEx,
} from './protocol.js';
import type { SysexMessage, SysexQueueModule } from '../types.js';

const TIMEOUT_MS = 2000;
const BUSY_DELAY_MS = 500;
const NOINPUT_DELAY_MS = 35; /* fire-and-forget delay when no MIDI input */

let queue: SysexMessage[] = [];          /* array of Uint8Array messages */
let waiting: SysexMessage | null = null; /* message currently awaiting ACK */
let ackTimer: number | null = null;      /* timeout id for ACK wait */
let busyTimer: number | null = null;     /* timeout id for busy-retry delay */
let pushTotal = 0, pushSent = 0;
let pushInProgress = false;
let pushSilent = false;  /* true = skip UI updates (e.g. firmware query) */

function updateUI(): void {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  if (pushInProgress && !pushSilent) {
    el.textContent = pushSent + '/' + pushTotal;
    el.classList.add('pushing');
  } else {
    el.textContent = 'Idle';
    el.classList.remove('pushing');
  }
}

function finish(ok: boolean): void {
  pushInProgress = false;
  pushSilent = false;
  updateUI();
  if (ok) console.log('Sync complete: ' + pushSent + ' messages sent');
  else console.warn('Sync aborted');
}

function sendNext(): void {
  if (queue.length === 0) {
    waiting = null;
    if (pushInProgress) finish(true);
    return;
  }
  waiting = queue.shift()!;
  if (!midi.midiOut) { waiting = null; if (pushInProgress) finish(false); return; }
  midi.midiOut.send(waiting);
  pushSent++;
  updateUI();
  /* if no MIDI input for ACK, use fixed delay and best-effort device state update */
  if (!midi.midiIn) {
    ackTimer = window.setTimeout(function () {
      ackTimer = null;
      if (waiting && waiting.keyIdx !== undefined && lumatone.deviceColors) {
        lumatone.deviceColors[waiting.keyIdx] = waiting.color ?? null;
      }
      waiting = null;
      sendNext();
    }, NOINPUT_DELAY_MS);
  } else {
    ackTimer = window.setTimeout(onTimeout, TIMEOUT_MS);
  }
}

function onTimeout(): void {
  ackTimer = null;
  console.warn('SysEx: no response (timeout), continuing');
  waiting = null;
  sendNext();
}

export const sysex: SysexQueueModule = {
  /* in-flight message (or null). Used by syncLumatoneColors for predicted snapshot. */
  get inFlight(): SysexMessage | null { return waiting; },
  get isInProgress(): boolean { return pushInProgress; },

  /* Append a single message to the queue. If idle, starts a SILENT push
     (no UI status updates). Used by control commands (firmware query,
     pedal calibration). Returns false if no MIDI output connected. */
  enqueueControl(msg: SysexMessage): boolean {
    if (!midi.midiOut) return false;
    if (!pushInProgress) {
      queue = [msg];
      pushTotal = 1;
      pushSent = 0;
      pushInProgress = true;
      pushSilent = true;
      updateUI();
      sendNext();
    } else {
      queue.push(msg);
      pushTotal++;
      updateUI();
    }
    return true;
  },

  /* Replace the queue with a new batch (visible push). The in-flight
     message completes naturally; the new queue takes over after that.
     Counters reset so progress reflects the new sync. */
  replaceQueue(messages: SysexMessage[]): void {
    queue = messages;
    pushTotal = messages.length;
    pushSent = 0;
    pushSilent = false;
    if (!pushInProgress) {
      pushInProgress = true;
      updateUI();
      sendNext();
    } else {
      updateUI();
    }
  },

  /* Cancel any in-flight work and clear the queue. Called on MIDI port
     disconnect or when Auto-sync is turned off. */
  cancel(): void {
    if (ackTimer !== null) { clearTimeout(ackTimer); ackTimer = null; }
    if (busyTimer !== null) { clearTimeout(busyTimer); busyTimer = null; }
    queue = [];
    waiting = null;
    if (pushInProgress) finish(false);
  },

  /* Route an incoming F0… SysEx response to the in-flight message.
     The MIDI input handler MUST first check for spontaneous CMD 3Eh
     calibration packets and route those elsewhere — they are NOT ACKs
     to a sent message and would silently drop the queue head if mis-routed
     here (lessons.md). */
  handleResponse(data: Uint8Array): void {
    if (!waiting) return;
    /* verify manufacturer ID + board + command match */
    if (data.length < 7) return;
    if (data[1] !== SYSEX_MANU[0] || data[2] !== SYSEX_MANU[1] || data[3] !== SYSEX_MANU[2]) return;
    if (data[4] !== waiting[4] || data[5] !== waiting[5]) return;
    if (ackTimer !== null) { clearTimeout(ackTimer); ackTimer = null; }
    const status = data[6];
    /* one-shot response callback (firmware query, etc.) */
    if (waiting.onResponse) {
      try { waiting.onResponse(data); } catch (e) { console.error(e); }
    }
    if (status === SYSEX_BUSY) {
      /* retry after delay */
      const stuck = waiting;
      busyTimer = window.setTimeout(function () {
        busyTimer = null;
        if (!midi.midiOut) { if (pushInProgress) finish(false); return; }
        pushSent--; /* don't double-count */
        queue.unshift(stuck);
        waiting = null;
        sendNext();
      }, BUSY_DELAY_MS);
    } else {
      /* ACK, NACK, ERROR, STATE — move on (don't retry NACK/ERROR forever) */
      if (status === SYSEX_ACK && waiting.keyIdx !== undefined && lumatone.deviceColors) {
        lumatone.deviceColors[waiting.keyIdx] = waiting.color ?? null;
      }
      waiting = null;
      sendNext();
    }
  },

  /* Silent firmware revision query at connect time. Logs the result. */
  queryFirmware(): void {
    if (!midi.midiOut) return;
    const msg = buildRequestSysEx(SYSEX_CMD_GET_FIRMWARE_REVISION);
    msg.onResponse = function (data: Uint8Array): void {
      /* Response: F0 00 21 50 00 31 <ack> <major> <minor> <revision> F7 */
      if (data[6] === SYSEX_ACK && data.length >= 11) {
        console.log('Lumatone firmware: v' + data[7] + '.' + data[8] + '.' + data[9]);
      } else if (data[6] === SYSEX_NACK) {
        console.log('Lumatone firmware query: not acknowledged (pre-1.0.8 firmware?)');
      } else {
        console.log('Lumatone firmware query: unexpected response status 0x' + data[6].toString(16));
      }
    };
    sysex.enqueueControl(msg);
  },
};
