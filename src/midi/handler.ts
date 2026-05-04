// Inbound MIDI message router. Wired onto midi.midiIn.onmidimessage by
// findLumatone (see midi/engine.ts). Routes:
//
//   • F0… SysEx responses → either spontaneous CMD 3Eh calibration packets
//     (handleCalibrationPacket) or ACK/NACK/BUSY for the in-flight queue
//     message (sysex.handleResponse). Calibration packets MUST be checked
//     FIRST — they are not ACKs and would silently drop the queue head if
//     misrouted (lessons.md).
//   • CC 4 (expression pedal, hardcoded in firmware) and CC 64 (sustain) →
//     sustainPedalOn/Off; CC 4 also drives the live-readout during pedal
//     calibration mode.
//   • Polyphonic aftertouch (0xA0) → handleAftertouch, also stashed in
//     audio.aftertouchSnapshot for debug polling.
//   • Note-on/off → mutate selection.selectedKeys + audio.sustainedKeys +
//     audio.keyVelocity, fire re-articulation flash if striking a sustaining
//     voice, then onSelectionChanged() to drive audio + MIDI + redraw.

import { audio } from '../state/audio.js';
import { pedal } from '../state/pedal.js';
import { selection } from '../state/selection.js';
import {
  SYSEX_MANU, SYSEX_CMD_PERIPHERAL_CALIBRATION_DATA,
} from '../lumatone/protocol.js';
import { sysex } from '../lumatone/sysex.js';
import { handleCalibrationPacket } from '../lumatone/calibration.js';
import {
  noteOff, handleAftertouch, triggerRearticulateFlash,
  sustainPedalOn, sustainPedalOff,
} from '../audio/engine.js';
import { fixedMidiToKey } from './engine.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';

export function handleMidiMessage(e: MIDIMessageEvent): void {
  const data = e.data;
  if (!data) return;
  /* route SysEx responses to push-color ACK handler, except spontaneous
     calibration packets (CMD 3Eh) which are not ACKs to a sent message
     but periodic firmware status emissions during calibration mode. */
  if (data[0] === 0xF0) {
    if (data.length >= 6
      && data[1] === SYSEX_MANU[0] && data[2] === SYSEX_MANU[1] && data[3] === SYSEX_MANU[2]
      && data[5] === SYSEX_CMD_PERIPHERAL_CALIBRATION_DATA) {
      handleCalibrationPacket(data);
      return;
    }
    sysex.handleResponse(data);
    return;
  }
  const status = data[0] & 0xf0;
  const ch = (data[0] & 0x0f) + 1;
  const d1 = data[1];
  const d2 = data.length > 2 ? data[2] : 0;
  /* CC messages: handle sustain pedal (CC 64, sustain jack) and
     foot controller (CC 4, expression jack). The expression pedal's CC#
     is hardcoded to 4 in firmware and cannot be remapped via SysEx, so
     we route it here. For now both pedals collapse to the existing
     binary audio.sustainPedalDown via a 0.5 threshold; continuous-damper
     audio modeling is a later v0.9 task once calibration is verified. */
  if (status === 0xB0) {
    if (d1 === 4) {
      /* CC 4: expression pedal. Log every value during calibration mode
         (or first transition outside cal mode), and apply binary fallback. */
      const now = performance.now();
      const dt = pedal.lastCC4Time ? (now - pedal.lastCC4Time) : 0;
      const changed = pedal.lastCC4Value !== d2;
      pedal.lastCC4Value = d2; pedal.lastCC4Time = now;
      if (pedal.debug) {
        console.log('[Pedal CC4] value=' + d2 + ' (depth=' + (d2 / 127).toFixed(3) + ')'
          + (dt > 0 ? ' Δt=' + dt.toFixed(0) + 'ms' : '')
          + ' ch=' + ch);
        const liveEl = document.getElementById('calibLive');
        if (liveEl) liveEl.textContent = String(d2);
      } else if (changed && (d2 === 0 || d2 === 127)) {
        /* outside cal mode, only log endpoint hits to keep console clean */
        console.log('[Pedal CC4] ' + d2 + ' (ch=' + ch + ')');
      }
      /* binary fallback: depth >= 0.5 holds sustain. Mirrors CC 64 behavior. */
      if (d2 >= 64) sustainPedalOn(); else sustainPedalOff();
      return;
    }
    if (d1 === 64) {
      if (pedal.debug) console.log('[Pedal CC64] ' + d2 + ' (ch=' + ch + ')');
      if (d2 >= 64) sustainPedalOn(); else sustainPedalOff();
    }
    return;
  }
  /* Polyphonic aftertouch (0xA0): modulate per-voice volume via pressureGain */
  if (status === 0xA0) {
    const atKey = fixedMidiToKey(ch, d1);
    if (atKey) {
      audio.aftertouchSnapshot[atKey] = d2;
      handleAftertouch(atKey, d2);
    }
    return;
  }
  /* Note messages */
  const key = fixedMidiToKey(ch, d1);
  if (!key) return;
  if (status === 0x90 && d2 > 0) {
    if (audio.activeOscs[key]) {
      /* Voice is already playing — typically because sustain pedal is holding it.
         Stop the old voice so syncAudio creates a fresh one with the new velocity,
         and flash the selection briefly to confirm the re-trigger. */
      noteOff(key);
      triggerRearticulateFlash(key);
    }
    audio.sustainedKeys.delete(key); /* re-struck while sustained → back to normal */
    selection.selectedKeys.add(key);
    audio.keyVelocity[key] = d2;
  } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
    if (audio.sustainPedalDown) {
      /* pedal is held — keep note sounding, mark as sustained */
      audio.sustainedKeys.add(key);
    } else {
      selection.selectedKeys.delete(key);
      delete audio.keyVelocity[key];
    }
  } else return;
  onSelectionChanged();
}
