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
//   • Every inbound message is reported to the liveness heartbeat
//     (midi/heartbeat.ts) as proof of life; ping replies (CMD 33h) stop there.
//   • Note-on/off → Lumatone velocity calibration + Composer strike broadcast,
//     then the shared held-input strike/release bodies in input/held.ts
//     (selection, sustain, velocity, re-articulation flash, onSelectionChanged).

import { audio } from '../state/audio.js';
import { pedal, pushPedalEvent } from '../state/pedal.js';
import {
  SYSEX_MANU, SYSEX_CMD_PERIPHERAL_CALIBRATION_DATA, isPingReply,
} from '../lumatone/protocol.js';
import { heartbeatInbound, setHeartbeatHoldingProbe, stopHeartbeat } from './heartbeat.js';
import { sysex } from '../lumatone/sysex.js';
import { handleCalibrationPacket } from '../lumatone/calibration.js';
import {
  handleAftertouch,
  setDamperDepth, sostenutoOn, sostenutoOff,
} from '../audio/engine.js';
import { filterPA } from '../audio/aftertouch.js';
import { velocityCal } from '../audio/velocityCal.js';
import { fixedMidiToKey, setLumatoneLostHandler } from './engine.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';
import { broadcastPlayerNote } from '../bridge/hkl-side.js';
import {
  heldKey, heldCount, clearHeld, pressHeld, releaseHeld, dropHeld, migrateHeld,
} from '../input/held.js';
import type { KeyId } from '../types.js';

/* Lumatone physical inputs are tracked in input/held.ts under source
   'lumatone', id "ch,note", each recording the KeyId it struck. */
export function clearHeldLumatoneTracking(): void { clearHeld('lumatone'); }

function physToKey(id: string): KeyId | null {
  const ci = id.indexOf(',');
  return fixedMidiToKey(+id.slice(0, ci), +id.slice(ci + 1));
}

/* Release everything the Lumatone was holding, because the device is gone.
   Registered with midi/engine.ts, which calls this from both departure paths
   (observed port loss, and the liveness heartbeat in midi/heartbeat.ts).

   A dead port can never deliver the note-offs or the pedal release, so every
   voice it was holding would otherwise ring indefinitely. That includes the
   pedal: CC 4 / CC 64 come from the Lumatone's own jacks, so a damper that
   was down at power-off stays down forever. Mouse and computer-keyboard
   voices are deliberately untouched — they have their own release paths — but
   forcing the damper to released does drop anything IT was sustaining, which
   is correct: the pedal is a Lumatone peripheral. */
export function releaseLumatoneInput(): void {
  stopHeartbeat();
  const keys = dropHeld('lumatone');
  pedal.cc4Depth = 0;
  pedal.cc64Depth = 0;
  setDamperDepth();  /* walks sustainedKeys and releases them */
  sostenutoOff();    /* no-op unless a sostenuto lock is active */
  onSelectionChanged();
  if (keys.length) console.warn('Lumatone: released ' + keys.length + ' held key(s) on departure');
}
setLumatoneLostHandler(releaseLumatoneInput);
/* The heartbeat only runs while the Lumatone holds something that a dead port
   would leave stuck: keys down, or a damper / sostenuto from its pedal jacks. */
setHeartbeatHoldingProbe(() =>
  heldCount('lumatone') > 0 || audio.sustainPedalDown || audio.sostenutoActive);

/** Ref-change migration for Lumatone-held voices: each held key re-resolves
 *  under the new kbAnchor (caller has already advanced it). Returns the number
 *  of voices moved; onRefChanged runs the selection sync. */
export function migrateHeldLumatoneVoices(): number {
  return migrateHeld('lumatone', physToKey);
}

/* Passive inbound-message observer. Registered by diagnostics (lumatone/probe.ts)
   that need to see raw traffic without altering routing: the monitor cannot
   consume a message, so the SysEx queue and note path behave identically
   whether or not one is attached. */
let midiMonitor: ((data: Uint8Array) => void) | null = null;
export function setMidiMonitor(fn: ((data: Uint8Array) => void) | null): void { midiMonitor = fn; }

export function handleMidiMessage(e: MIDIMessageEvent): void {
  const data = e.data;
  if (!data) return;
  if (midiMonitor) { try { midiMonitor(data); } catch { /* a diagnostic must never break input */ } }
  heartbeatInbound();
  /* route SysEx responses to push-color ACK handler, except spontaneous
     calibration packets (CMD 3Eh) which are not ACKs to a sent message
     but periodic firmware status emissions during calibration mode, and
     heartbeat ping replies, whose whole job was done by heartbeatInbound. */
  if (data[0] === 0xF0) {
    if (data.length >= 6
      && data[1] === SYSEX_MANU[0] && data[2] === SYSEX_MANU[1] && data[3] === SYSEX_MANU[2]
      && data[5] === SYSEX_CMD_PERIPHERAL_CALIBRATION_DATA) {
      handleCalibrationPacket(data);
      return;
    }
    if (isPingReply(data)) return;
    sysex.handleResponse(data);
    return;
  }
  routeChannelMessage(data);
}

function routeChannelMessage(data: Uint8Array): void {
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
         also be slightly off). Diagnosed via the pedalHud +
         pedal.dumpRecent(): a stuck occurrence consistently showed CC 4 = 1
         as the final value rather than CC 4 = 0.

         This clamp is no longer what rescues that case — CC 4 = 1 is
         1/127 ≈ 0.008, well under the damper-contact threshold
         (DAMPER_RELEASE_FLOOR = 0.05), so the release loop now claims it
         regardless. It is kept because it is still correct at the input
         boundary: cc4Depth should read a true 0 when the pedal is at rest,
         and the HUD displays it directly. */
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
    const atKey = heldKey('lumatone', ch + ',' + d1);
    if (atKey) {
      audio.aftertouchSnapshot[atKey] = d2;
      const ctxTime = audio.audioCtx ? audio.audioCtx.currentTime : 0;
      const filtered = filterPA(atKey, d2, ctxTime);
      handleAftertouch(atKey, filtered);
    }
    return;
  }
  /* Note messages. Release resolves through the key recorded at strike time
     (input/held.ts), never through the current anchor. */
  const physId = ch + ',' + d1;
  if (status === 0x90 && d2 > 0) {
    const key = heldKey('lumatone', physId) ?? fixedMidiToKey(ch, d1);
    if (!key) return;
    /* Per-key velocity statistics: always-on rolling sample collection when
       statsEnabled (toggled in lumadiag). RAW velocity here — the (p5, p95)
       scatter must reflect the firmware's natural output, not whatever the
       input curve has been tuned to, so we can keep diagnosing the
       underlying hardware envelope. Single boolean check when disabled. */
    velocityCal.recordForStats(physId, d2);
    /* Distinct-velocity tracker — feeds the lumadiag counter and lets
       loopdiag flag velocities outside the predicted-reachable-bin set. */
    velocityCal.recordObservedVelocity(d2);
    /* Lumatone-only input velocity curve. Identity by default; user dials it
       in via lumadiag to compensate for compressed firmware velocity range.
       Everything downstream (audio engine, recording, MIDI export) sees the
       shaped value. */
    /* Lumatone → canonical musical velocity: per-key gain (hardware variance
       correction) then the decompression input curve, both at input time.
       keyVelocity now holds musical velocity (the house curve maps it to gain at
       audio time). */
    const velocity = velocityCal.applyInputCurve(velocityCal.applyPerKeyGain(physId, d2));
    /* Per-key gain auto-capture samples RAW d2 — per-key gain corrects the raw
       firmware velocity before the curve. Keyed by the physical key, like the
       gain and the stats. Out of capture mode, a boolean check. */
    velocityCal.recordSample(physId, d2);
    /* Forward the strike to Composer for Performance mode. No-op unless that
       mode is active; fires on every note-on (incl. re-articulations) in the
       MIDI handler's synchronous call stack (low-latency, tab-throttle-proof). */
    {
      const ci = key.indexOf(',');
      broadcastPlayerNote(+key.slice(0, ci), +key.slice(ci + 1));
    }
    /* Shared strike body: re-articulates a voice already sounding (typically
       held by the sustain pedal), selects, records, re-attacks the external
       synth, then onSelectionChanged. */
    pressHeld('lumatone', physId, key, velocity);
  } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
    /* damper or sostenuto keeps the note sounding (→ sustainedKeys) */
    releaseHeld('lumatone', physId);
  }
}
