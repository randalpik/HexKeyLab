// Expression pedal calibration mode (Lumatone CMD 38h / 39h / 3Eh).
//
// CMD 38h puts the firmware into calibration mode: while active, it samples
// the ADC continuously and emits spontaneous CMD 3Eh status packets every
// ~100ms with the running min/max ADC bounds plus a "valid" flag. Stopping
// calibration commits the learned bounds to firmware. CMD 39h resets the
// bounds to factory defaults. CC 4 (Foot Controller) is the runtime
// expression-pedal output channel — hardcoded in firmware, not user-
// configurable.
//
// CMD 3Eh packets are NOT ACKs to a sent message — the MIDI input handler
// must check for them BEFORE routing to sysex.handleResponse, or they'd
// silently drop the queue head.

import { midi } from '../state/midi.js';
import { pedal } from '../state/pedal.js';
import {
  SYSEX_CMD_CALIBRATE_EXPRESSION_PEDAL,
  SYSEX_CMD_RESET_EXPRESSION_PEDAL_BOUNDS,
  buildToggleSysEx, buildRequestSysEx,
} from './protocol.js';
import { sysex } from './sysex.js';

export function togglePedalCalibration(): void {
  if (pedal.calibrating) stopPedalCalibration();
  else startPedalCalibration();
}

function startPedalCalibration(): void {
  if (!midi.midiOut) {
    console.warn('[Pedal Cal] No Lumatone connected — cannot start calibration');
    return;
  }
  pedal.calibrating = true;
  pedal.debug = true;
  pedal.lastMin = null;
  pedal.lastMax = null;
  pedal.lastValid = null;
  pedal.packetCount = 0;
  console.log('[Pedal Cal] ▶ Starting calibration mode — sweep pedal full range repeatedly');
  console.log('[Pedal Cal] Sending CMD 38h (CALIBRATE_EXPRESSION_PEDAL) value=1');
  sysex.enqueueControl(buildToggleSysEx(SYSEX_CMD_CALIBRATE_EXPRESSION_PEDAL, true));
  /* UI updates */
  const btn = document.getElementById('btnCalibPedal');
  if (btn) { btn.textContent = 'Stop Calibration'; btn.classList.add('active'); }
  const panel = document.getElementById('calibPanel');
  if (panel) panel.classList.add('active');
  updateCalibUI();
}

function stopPedalCalibration(): void {
  if (!pedal.calibrating) return;
  console.log('[Pedal Cal] ■ Stopping calibration mode — bounds will be committed to firmware');
  console.log('[Pedal Cal] Sending CMD 38h (CALIBRATE_EXPRESSION_PEDAL) value=0');
  console.log('[Pedal Cal] Session totals: ' + pedal.packetCount + ' calibration packets, '
    + 'final min=' + pedal.lastMin + ' max=' + pedal.lastMax + ' valid=' + pedal.lastValid);
  if (midi.midiOut) sysex.enqueueControl(buildToggleSysEx(SYSEX_CMD_CALIBRATE_EXPRESSION_PEDAL, false));
  pedal.calibrating = false;
  pedal.debug = false;
  /* UI updates */
  const btn = document.getElementById('btnCalibPedal');
  if (btn) { btn.textContent = 'Calibrate Pedal'; btn.classList.remove('active'); }
  const panel = document.getElementById('calibPanel');
  if (panel) panel.classList.remove('active');
}

export function resetPedalBounds(): void {
  if (!midi.midiOut) {
    console.warn('[Pedal Cal] No Lumatone connected — cannot reset bounds');
    return;
  }
  console.log('[Pedal Cal] ↻ Resetting expression pedal bounds to factory defaults');
  console.log('[Pedal Cal] Sending CMD 39h (RESET_EXPRESSION_PEDAL_BOUNDS)');
  sysex.enqueueControl(buildRequestSysEx(SYSEX_CMD_RESET_EXPRESSION_PEDAL_BOUNDS));
}

/* Parse spontaneous CMD 3Eh calibration status packet.
   Format (inferred from Terpstra firmware unpackExpressionPedalCalibrationPayload):
     F0 00 21 50 <board> 3E <ack> <calib_mode> <12-bit nibbles...> F7
   The 12-bit values are packed as 3 nibbles each. minBound = first 12-bit,
   maxBound = second 12-bit, valid flag is a separate byte further into
   the payload. We log the raw bytes so any parser drift can be diagnosed. */
export function handleCalibrationPacket(data: Uint8Array): void {
  pedal.packetCount++;
  /* Log raw payload for diagnostic purposes — first packet always, then every 10th */
  if (pedal.packetCount === 1 || pedal.packetCount % 10 === 0) {
    const hex: string[] = [];
    for (let i = 0; i < data.length; i++) hex.push(('0' + data[i].toString(16)).slice(-2));
    console.log('[Pedal Cal 3Eh #' + pedal.packetCount + '] raw: ' + hex.join(' '));
  }
  /* Defensive parse: payload starts after F0 + 3 manu + board + cmd = byte 6.
     Byte 6 is typically ack/status byte. Calibration data follows from byte 7+. */
  if (data.length < 13) {
    if (pedal.debug) console.warn('[Pedal Cal 3Eh] packet too short (' + data.length + ' bytes), skipping parse');
    return;
  }
  /* Try to extract two 12-bit values from nibbles starting at offset 7.
     Each value = (hi<<8) | (mid<<4) | lo from 3 successive bytes. */
  const off = 7;
  const minBound = ((data[off] & 0xF) << 8) | ((data[off + 1] & 0xF) << 4) | (data[off + 2] & 0xF);
  const maxBound = ((data[off + 3] & 0xF) << 8) | ((data[off + 4] & 0xF) << 4) | (data[off + 5] & 0xF);
  /* "valid" flag: location uncertain in firmware spec; try byte 13 (just after
     the two 12-bit values) and fall back to logging if it looks wrong. */
  const validByte = data.length > 13 ? data[13] : 0;
  /* Detect spurious large values — if either bound exceeds 12-bit max (4095),
     our parse offset is probably wrong. Log for diagnosis. */
  if (minBound > 0xFFF || maxBound > 0xFFF) {
    if (pedal.debug) console.warn('[Pedal Cal 3Eh] suspicious bounds (min=' + minBound + ' max=' + maxBound
      + '), parse offset may be wrong — please check raw bytes above');
  }
  pedal.lastMin = minBound;
  pedal.lastMax = maxBound;
  pedal.lastValid = validByte;
  updateCalibUI();
}

function updateCalibUI(): void {
  const minEl = document.getElementById('calibMin');
  const maxEl = document.getElementById('calibMax');
  const validEl = document.getElementById('calibValid');
  if (minEl) minEl.textContent = pedal.lastMin !== null ? String(pedal.lastMin) : '----';
  if (maxEl) maxEl.textContent = pedal.lastMax !== null ? String(pedal.lastMax) : '----';
  if (validEl) {
    validEl.textContent = pedal.lastValid !== null ? String(pedal.lastValid) : '-';
    validEl.classList.toggle('valid', pedal.lastValid === 1);
    validEl.classList.toggle('invalid', pedal.lastValid === 0);
  }
}
