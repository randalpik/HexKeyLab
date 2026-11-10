// Built-in key / aftertouch calibration, started and ended from HKL
// (Lumatone firmware 1.5.0+).
//
// The firmware's own routine learns every key's thresholds from touch: 24h
// (keys) or 0Fh (aftertouch) puts all five boards in calibration mode, the
// player presses the keys, and the routine ends when it is confirmed (the
// learned values replace the stored per-key thresholds) or canceled (nothing
// is saved). Before 1.5.0 only a board's two macro buttons could end it; 1.5.0
// adds 52h, which does it from software. A start is therefore only ever sent to
// 1.5.0+ — on older firmware a unit without working macro buttons would stay in
// calibration mode until it is power-cycled.
//
// While a calibration runs the firmware answers every command except 52h with
// STATE, so the phase (lumatone.keyCal, written only here) holds color sync off;
// when the routine ends, the keys it repainted are re-synced from scratch.
//
// After 52h is ACKed, the mode returns to normal only once every board has
// reported back, so the end is confirmed by polling a harmless request (the
// firmware revision) until it is no longer answered STATE. A board that never
// reports back — one sitting in the routine's key diagnostic display, which only
// that board's two macro buttons leave — puts the phase back to running, with
// Confirm and Cancel still on offer.
//
// The device is the authority on its mode; HKL's phase follows what it answers:
// STATE to a start, or to the connect-time firmware query, means it is already
// in a mode (a page reloaded mid-calibration), so the way out is offered
// ('unknown'); NACK to 52h means it was not calibrating; STATE to 52h means the
// mode is not a key calibration (pedal calibration, demo), and HKL lets go.

import { midi } from '../state/midi.js';
import { lumatone, type KeyCalPhase } from '../state/lumatone.js';
import { sysex } from './sysex.js';
import { syncLumatoneColors } from './sync.js';
import {
  SYSEX_ACK, SYSEX_NACK, SYSEX_BUSY, SYSEX_STATE,
  SYSEX_CMD_CALIBRATE_KEYS, SYSEX_CMD_CALIBRATE_AFTERTOUCH,
  SYSEX_CMD_CONFIRM_CALIBRATION, SYSEX_CMD_GET_FIRMWARE_REVISION,
  CONFIRM_CALIBRATION_FIRMWARE,
  firmwareAtLeast, buildRequestSysEx, buildToggleSysEx,
} from './protocol.js';
import type { SysexMessage } from '../types.js';

export type KeyCalKind = 'key' | 'aftertouch';

/* The queue drops a message it gets no answer to without telling its sender, so
   a request here gives up on its own clock (longer than the queue's). */
export const KEYCAL_REPLY_TIMEOUT_MS = 3000;
/* After 52h: how often, and how many times, to ask whether the mode is back to normal. */
export const KEYCAL_MODE_POLL_MS = 300;
export const KEYCAL_MODE_POLL_TRIES = 20;

const RUNNING: Record<KeyCalKind, string> = {
  key: 'Key calibration running: press every key all the way down, then Confirm to save or Cancel to discard. '
    + 'A macro button on a board switches that board to its sensor colors; hold both of its macro buttons to leave them.',
  aftertouch: 'Aftertouch calibration running: press every key hard to the bottom, then Confirm to save or Cancel to discard.',
};
const ADOPTED = 'The Lumatone is already in a calibration mode. Confirm saves what it has learned; Cancel discards it.';

let status = '';
const listeners: (() => void)[] = [];

/** Text for the Calibrate Keys status line. */
export function keyCalStatus(): string { return status; }

/** Called after every phase or status change. */
export function onKeyCalChange(fn: () => void): void { listeners.push(fn); }

function set(phase: KeyCalPhase, text: string): void {
  lumatone.keyCal = phase;
  status = text;
  for (const fn of listeners) fn();
}

/* Send one control message. onReply gets its answer (BUSY is the queue's to
   retry); onSilence runs if none has come by the timeout. A late answer still
   reaches onReply. Returns false when there is no device. */
function request(msg: SysexMessage, onReply: (st: number, data: Uint8Array) => void, onSilence: () => void): boolean {
  let timer: number | null = window.setTimeout(() => { timer = null; onSilence(); }, KEYCAL_REPLY_TIMEOUT_MS);
  msg.onResponse = (data: Uint8Array) => {
    if (data[6] === SYSEX_BUSY) return;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    onReply(data[6], data);
  };
  if (sysex.enqueueControl(msg)) return true;
  if (timer !== null) { clearTimeout(timer); timer = null; }
  return false;
}

/** Start the firmware's key or aftertouch calibration. */
export function startKeyCal(kind: KeyCalKind): void {
  if (lumatone.keyCal !== 'idle') return;
  if (!midi.midiOut) { set('idle', 'No Lumatone connected.'); return; }
  if (!firmwareAtLeast(lumatone.firmware, CONFIRM_CALIBRATION_FIRMWARE)) {
    const fw = lumatone.firmware;
    set('idle', 'Needs firmware 1.5.0 or later ('
      + (fw ? 'this Lumatone reports ' + fw.join('.') : 'this Lumatone has not reported its version')
      + '): older firmware ends a calibration only with the macro buttons.');
    return;
  }
  set('starting', 'Starting ' + kind + ' calibration…');
  /* colors still queued would only be refused once the mode changes */
  if (sysex.isInProgress) sysex.replaceQueue([]);
  const cmd = kind === 'key' ? SYSEX_CMD_CALIBRATE_KEYS : SYSEX_CMD_CALIBRATE_AFTERTOUCH;
  const sent = request(buildRequestSysEx(cmd), (st) => {
    if (st === SYSEX_ACK) set(kind, RUNNING[kind]);
    else if (st === SYSEX_STATE) set('unknown', ADOPTED);
    else set('idle', 'The Lumatone refused to start the calibration (status ' + st + ').');
  }, () => {
    if (lumatone.keyCal === 'starting') set('idle', 'No reply from the Lumatone; calibration not started.');
  });
  if (!sent) set('idle', 'No Lumatone connected.');
}

/** End the running calibration: confirm saves the learned thresholds on the
 *  device, cancel discards them. */
export function endKeyCal(confirm: boolean): void {
  const running = lumatone.keyCal;
  if (running !== 'key' && running !== 'aftertouch' && running !== 'unknown') return;
  set('ending', confirm ? 'Confirming…' : 'Canceling…');
  const back = (text: string): void => { if (lumatone.keyCal === 'ending') set(running, text); };
  const sent = request(buildToggleSysEx(SYSEX_CMD_CONFIRM_CALIBRATION, confirm), (st) => {
    if (st === SYSEX_ACK) awaitNormalMode(running, confirm, KEYCAL_MODE_POLL_TRIES);
    else if (st === SYSEX_NACK) finish('The Lumatone was not in a calibration.', true);
    else if (st === SYSEX_STATE) finish('The Lumatone is in another mode (pedal calibration or demo), not a key calibration.');
    else back('The Lumatone refused (status ' + st + '); the calibration is still running.');
  }, () => back('No reply from the Lumatone; the calibration may still be running.'));
  if (!sent) back('No Lumatone connected.');
}

/* 52h was ACKed. Ask for the firmware revision until the answer is not STATE. */
function awaitNormalMode(running: KeyCalPhase, confirm: boolean, triesLeft: number): void {
  const back = (text: string): void => { if (lumatone.keyCal === 'ending') set(running, text); };
  const sent = request(buildRequestSysEx(SYSEX_CMD_GET_FIRMWARE_REVISION), (st, data) => {
    if (lumatone.keyCal !== 'ending') return;
    if (st !== SYSEX_STATE) {
      if (st === SYSEX_ACK && data.length >= 11) lumatone.firmware = [data[7], data[8], data[9]];
      finish(confirm ? 'Calibration confirmed: the Lumatone saved the learned thresholds.'
                     : 'Calibration canceled: nothing was saved.');
    } else if (triesLeft <= 1) {
      back('A board has not left calibration mode. If one is showing its sensor colors, hold both of its '
        + 'macro buttons, then Confirm or Cancel again.');
    } else {
      window.setTimeout(() => {
        if (lumatone.keyCal === 'ending') awaitNormalMode(running, confirm, triesLeft - 1);
      }, KEYCAL_MODE_POLL_MS);
    }
  }, () => back('No reply from the Lumatone; the calibration may still be running.'));
  if (!sent) back('No Lumatone connected.');
}

/* The device is out of calibration mode. The routine repainted the keys, so
   the color cache is void: sync every key again. askVersion: the device is in
   normal mode but an adopted calibration left its version unknown, so ask as a
   connect does. */
function finish(text: string, askVersion = false): void {
  set('idle', text);
  lumatone.deviceColors = null;
  if (askVersion && !lumatone.firmware) sysex.queryFirmware(() => syncLumatoneColors(), adoptKeyCal);
  syncLumatoneColors();
}

/** Connect-time firmware query refused with `st` (sysex.queryFirmware's
 *  onRefused): STATE means the device is in a calibration mode already. */
export function adoptKeyCal(st: number): void {
  if (st === SYSEX_STATE && lumatone.keyCal === 'idle') set('unknown', ADOPTED);
}

/** The device left (power-off, unplug): whatever mode it was in is over. */
export function keyCalDeviceGone(): void {
  if (lumatone.keyCal !== 'idle') set('idle', 'Lumatone disconnected.');
}
