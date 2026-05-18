// Inbound MIDI message router. Wired onto midi.midiIn.onmidimessage by
// findLumatone (see midi/engine.ts). Routes:
//
//   • F0… SysEx responses → either spontaneous CMD 3Eh calibration packets
//     (handleCalibrationPacket) or ACK/NACK/BUSY for the in-flight queue
//     message (sysex.handleResponse). Calibration packets MUST be checked
//     FIRST — they are not ACKs and would silently drop the queue head if
//     misrouted (lessons.md).
//   • CC 4 (expression pedal, hardcoded in firmware) → setDamperDepth as
//     continuous damper. CC 64 (sustain jack, binary) → setDamperDepth in
//     'sustain' mode, or sostenutoOn/Off in 'sostenuto' mode (per pedal.mode).
//   • Polyphonic aftertouch (0xA0) → handleAftertouch, also stashed in
//     audio.aftertouchSnapshot for debug polling.
//   • Note-on/off → mutate selection.selectedKeys + audio.sustainedKeys +
//     audio.keyVelocity, fire re-articulation flash if striking a sustaining
//     voice, then onSelectionChanged() to drive audio + MIDI + redraw.

import { audio } from '../state/audio.js';
import { pedal, pushPedalEvent } from '../state/pedal.js';
import { selection } from '../state/selection.js';
import {
  SYSEX_MANU, SYSEX_CMD_PERIPHERAL_CALIBRATION_DATA,
} from '../lumatone/protocol.js';
import { sysex } from '../lumatone/sysex.js';
import { handleCalibrationPacket } from '../lumatone/calibration.js';
import {
  noteOff, handleAftertouch, triggerRearticulateFlash,
  setDamperDepth, sostenutoOn, sostenutoOff,
} from '../audio/engine.js';
import { filterPA } from '../audio/aftertouch.js';
import { velocityCal } from '../audio/velocityCal.js';
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
  /* CC messages: foot controller (CC 4, expression jack — continuous damper)
     and sustain (CC 64, sustain jack — binary, role per pedal.mode). The
     expression pedal's CC# is hardcoded to 4 in firmware and cannot be
     remapped via SysEx, so we route it here. */
  if (status === 0xB0) {
    if (d1 === 4) {
      const nowMs = performance.now();
      const dt = pedal.lastCC4Time ? (nowMs - pedal.lastCC4Time) : 0;
      const changed = pedal.lastCC4Value !== d2;
      pedal.lastCC4Value = d2; pedal.lastCC4Time = nowMs;
      if (pedal.debug) {
        console.log('[Pedal CC4] value=' + d2 + ' (depth=' + (d2 / 127).toFixed(3) + ')'
          + (dt > 0 ? ' Δt=' + dt.toFixed(0) + 'ms' : '')
          + ' ch=' + ch);
      } else if (changed && (d2 === 0 || d2 === 127)) {
        /* outside cal mode, only log endpoint hits to keep console clean */
        console.log('[Pedal CC4] ' + d2 + ' (ch=' + ch + ')');
      }
      /* Treat d2 ≤ 1 as fully released. The expression pedal's at-rest ADC
         reading sometimes lands a count or two above zero (see lessons.md
         — the firmware calibration peak is symmetric, so the bottom can
         also be slightly off). Without this clamp, an at-rest CC 4 = 1
         leaves cc4Depth at 1/127 ≈ 0.008 — above DAMPER_RELEASE_FLOOR
         (0.005) — and notes stay sustained indefinitely. Diagnosed via
         the pedalHud + pedal.dumpRecent(): a stuck occurrence consistently
         showed CC 4 = 1 as the final value rather than CC 4 = 0. */
      pedal.cc4Depth = (d2 <= 1) ? 0 : d2 / 127;
      setDamperDepth();
      pushPedalEvent({ t: nowMs, cc: 4, value: d2, ch, depthAfter: audio.damperDepth });
      return;
    }
    if (d1 === 64) {
      if (pedal.debug) console.log('[Pedal CC64] ' + d2 + ' (ch=' + ch + ')');
      pedal.lastCC64Value = d2;
      if (pedal.mode === 'sostenuto') {
        if (d2 >= 64) sostenutoOn(); else sostenutoOff();
      } else {
        pedal.cc64Depth = (d2 >= 64) ? 1 : 0;
        setDamperDepth();
      }
      pushPedalEvent({ t: performance.now(), cc: 64, value: d2, ch, depthAfter: audio.damperDepth });
    }
    return;
  }
  /* Polyphonic aftertouch (0xA0): modulate per-voice volume via pressureGain.
     Raw d2 is stashed in aftertouchSnapshot for diagnostics; the value fed
     to handleAftertouch is filterPA's gated + smoothed output (rejects the
     0/1 onset flicker and the 7-bit stair-stepping). */
  if (status === 0xA0) {
    const atKey = fixedMidiToKey(ch, d1);
    if (atKey) {
      audio.aftertouchSnapshot[atKey] = d2;
      const ctxTime = audio.audioCtx ? audio.audioCtx.currentTime : 0;
      const filtered = filterPA(atKey, d2, ctxTime);
      handleAftertouch(atKey, filtered);
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
    /* Per-key velocity statistics: always-on rolling sample collection when
       statsEnabled (toggled in lumadiag). RAW velocity here — the (p5, p95)
       scatter must reflect the firmware's natural output, not whatever the
       input curve has been tuned to, so we can keep diagnosing the
       underlying hardware envelope. Single boolean check when disabled. */
    velocityCal.recordForStats(key, d2);
    /* Distinct-velocity tracker — feeds the lumadiag counter and lets
       loopdiag flag velocities outside the predicted-reachable-bin set. */
    velocityCal.recordObservedVelocity(d2);
    /* Lumatone-only input velocity curve. Identity by default; user dials it
       in via lumadiag to compensate for compressed firmware velocity range.
       Everything downstream (audio engine, recording, MIDI export) sees the
       shaped value. */
    const vShaped = velocityCal.isInputCurveIdentity() ? d2 : velocityCal.applyInputCurve(d2);
    audio.keyVelocity[key] = vShaped;
    /* Per-key gain auto-capture: capture the shaped value so per-key gain
       compensates outliers in the same domain that audio sees. Out of capture
       mode this is a single boolean check. */
    velocityCal.recordSample(key, vShaped);
  } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
    if (audio.sustainPedalDown || audio.sostenutoLockedKeys.has(key)) {
      /* damper or sostenuto holds the note — keep sounding, mark as sustained */
      audio.sustainedKeys.add(key);
    } else {
      selection.selectedKeys.delete(key);
      delete audio.keyVelocity[key];
      delete audio.aftertouchSnapshot[key];
      delete audio.paFilter[key];
    }
  } else return;
  onSelectionChanged();
}
