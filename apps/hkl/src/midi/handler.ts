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
//   • Pitch bend (0xE0) → NOT a musical event: it is the device's power-off
//     tell, and routes to markLumatoneGone so the port is detached before the
//     spurious keystrokes that follow it can be latched (see the comment at
//     the check itself for why the ordering is guaranteed).
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
  noteOff, handleAftertouch,
  setDamperDepth, sostenutoOn, sostenutoOff,
} from '../audio/engine.js';
import { filterPA } from '../audio/aftertouch.js';
import { velocityCal } from '../audio/velocityCal.js';
import { fixedMidiToKey, fixedMidiToKeyAt, markLumatoneGone, setLumatoneLostHandler } from './engine.js';
import { restrikePianoOut } from './piano-out.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';
import { broadcastPlayerNote } from '../bridge/hkl-side.js';
import { view } from '../state/view.js';
import { keyFreq } from '../tuning/frequency.js';
import { SampleEngine } from '../audio/samples.js';
import { animation } from '../render/animation.js';
import { instrReplaysOnTranspose, noteOn } from '../audio/engine.js';
import type { KeyId, Voice } from '../types.js';
import { flashKey } from '../render/key-flash.js';

/* Set of Lumatone physical inputs currently held. Used by
   migrateHeldLumatoneVoices to find which voices to re-target when the
   kbAnchor shifts under the static Lumatone outline. Format: "ch,note". */
const heldLumatonePhys = new Set<string>();
export function clearHeldLumatoneTracking(): void { heldLumatonePhys.clear(); }

/* Release everything the Lumatone was holding, because the device is gone.
   Registered with midi/engine.ts, which calls this from both departure paths
   (observed port loss, and the pitch-bend tell below).

   A dead port can never deliver the note-offs or the pedal release, so every
   voice it was holding would otherwise ring indefinitely. That includes the
   pedal: CC 4 / CC 64 come from the Lumatone's own jacks, so a damper that
   was down at power-off stays down forever. Mouse and computer-keyboard
   voices are deliberately untouched — they have their own release paths — but
   forcing the damper to released does drop anything IT was sustaining, which
   is correct: the pedal is a Lumatone peripheral. */
export function releaseLumatoneInput(): void {
  const keys: KeyId[] = [];
  heldLumatonePhys.forEach((id) => {
    const ci = id.indexOf(',');
    const key = fixedMidiToKey(+id.slice(0, ci), +id.slice(ci + 1));
    if (key) keys.push(key);
  });
  heldLumatonePhys.clear();
  keys.forEach((key) => {
    selection.selectedKeys.delete(key);
    audio.sustainedKeys.delete(key);
    delete audio.keyVelocity[key];
    delete audio.aftertouchSnapshot[key];
    delete audio.paFilter[key];
  });
  pedal.cc4Depth = 0;
  pedal.cc64Depth = 0;
  setDamperDepth();  /* walks sustainedKeys and releases them */
  sostenutoOff();    /* no-op unless a sostenuto lock is active */
  onSelectionChanged();
  if (keys.length) console.warn('Lumatone: released ' + keys.length + ' held key(s) on departure');
}
setLumatoneLostHandler(releaseLumatoneInput);

export function migrateHeldLumatoneVoices(dq: number, dr: number): void {
  if (heldLumatonePhys.size === 0) return;
  if (dq === 0 && dr === 0) return;
  /* kbAnchor has already been advanced to its new value by the caller; back-
     derive the old anchor from the delta. */
  const newAQ = view.kbAnchorQ, newAR = view.kbAnchorR;
  const oldAQ = newAQ - dq, oldAR = newAR - dr;
  const pairs: { oldKey: KeyId; newKey: KeyId }[] = [];
  heldLumatonePhys.forEach((id) => {
    const [chStr, noteStr] = id.split(',');
    const ch = +chStr, note = +noteStr;
    const oldKey = fixedMidiToKeyAt(ch, note, oldAQ, oldAR);
    const newKey = fixedMidiToKeyAt(ch, note, newAQ, newAR);
    if (oldKey && newKey && oldKey !== newKey) pairs.push({ oldKey, newKey });
  });
  if (pairs.length === 0) return;
  if (audio.audioEnabled && audio.audioCtx) {
    if (instrReplaysOnTranspose()) {
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
      const now = audio.audioCtx.currentTime;
      const rampDur = animation.duration / 1000;
      const sampleMoves: { oldKey: KeyId; newKey: KeyId; nq: number; nr: number; newFreq: number; instr: string; vol?: number }[] = [];
      pairs.forEach((p) => {
        const e = audio.activeOscs[p.oldKey];
        if (!e) return;
        const np = p.newKey.split(','), nq = +np[0], nr = +np[1];
        if (e.type === 'osc') {
          e.osc.frequency.setValueAtTime(e.osc.frequency.value, now);
          e.osc.frequency.exponentialRampToValueAtTime(keyFreq(nq, nr), now + rampDur);
          e.q = nq; e.r = nr;
          audio.activeOscs[p.newKey] = e;
          delete audio.activeOscs[p.oldKey];
        } else if (e.type === 'sample') {
          sampleMoves.push({ oldKey: p.oldKey, newKey: p.newKey, nq, nr, newFreq: keyFreq(nq, nr), instr: e.instr });
        }
        if (audio.keyVelocity[p.oldKey] !== undefined) {
          audio.keyVelocity[p.newKey] = audio.keyVelocity[p.oldKey];
          delete audio.keyVelocity[p.oldKey];
        }
      });
      sampleMoves.forEach((m) => { m.vol = SampleEngine.slideAndFadeOut(m.oldKey, m.newFreq, rampDur); });
      sampleMoves.forEach((m) => {
        SampleEngine.noteOnFaded(m.newKey, m.newFreq, m.vol!, rampDur, m.instr);
        audio.activeOscs[m.newKey] = { type: 'sample', freq: m.newFreq, instr: m.instr, q: m.nq, r: m.nr };
        delete audio.activeOscs[m.oldKey];
      });
    }
  }
  /* migrate selection entries so the highlight follows the physical key */
  pairs.forEach((p) => {
    if (selection.selectedKeys.has(p.oldKey)) {
      selection.selectedKeys.delete(p.oldKey);
      selection.selectedKeys.add(p.newKey);
    }
    if (audio.sustainedKeys.has(p.oldKey)) {
      audio.sustainedKeys.delete(p.oldKey);
      audio.sustainedKeys.add(p.newKey);
    }
  });
}

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
  /* Pitch bend (0xE0) is the Lumatone's power-off tell, not a musical event.
     The wheel is read over I2C by the firmware's readWheelADC, which runs on
     every pass of its main loop, whereas a keystroke first needs the octave
     board's PIC to raise its data line and complete a CTS handshake. So when
     the rails collapse at power-off, the wheel's ADC read degenerates and
     emits a bend a full loop-iteration BEFORE any PIC can get a keystroke
     frame out — which is what makes this a usable trigger rather than a
     post-hoc cleanup. The firmware also keeps a dead-zone around centre
     (SetPitchBendZeroThreshold), so an emitted bend is always a large
     excursion, never idle noise.

     The spurious note-ons that follow are protocol-valid frames from a
     browning-out key scanner — indistinguishable from real playing at the
     byte level — so filtering them after the fact isn't possible. Acting on
     the bend instead means detaching the input port before they arrive.

     Nothing on this unit emits bend in normal use (the wheel is physically
     disconnected). If one is ever reconnected, tighten this to fire only on
     a full-scale excursion — the degenerate read pins to 0 or 16383, which
     a played wheel reaches only at its extremes. */
  if (status === 0xE0) {
    const bend = (d2 << 7) | d1;
    markLumatoneGone('pitch bend received (value ' + bend + ')');
    return;
  }
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
  const physId = ch + ',' + d1;
  if (status === 0x90 && d2 > 0) {
    heldLumatonePhys.add(physId);
    if (audio.activeOscs[key]) {
      /* Voice is already playing — typically because sustain pedal is holding it.
         Stop the old voice so syncAudio creates a fresh one with the new velocity,
         and flash the selection briefly to confirm the re-trigger. */
      noteOff(key);
      flashKey(key);
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
    /* Lumatone → canonical musical velocity: per-key gain (hardware variance
       correction) then the decompression input curve, both at input time.
       keyVelocity now holds musical velocity (the house curve maps it to gain at
       audio time). */
    audio.keyVelocity[key] = velocityCal.applyInputCurve(velocityCal.applyPerKeyGain(key, d2));
    /* Per-key gain auto-capture samples RAW d2 — per-key gain corrects the raw
       firmware velocity before the curve. Out of capture mode, a boolean check. */
    velocityCal.recordSample(key, d2);
    /* Forward the strike to Composer for Performance mode. No-op unless that
       mode is active; fires on every note-on (incl. re-articulations) in the
       MIDI handler's synchronous call stack (low-latency, tab-throttle-proof). */
    {
      const ci = key.indexOf(',');
      broadcastPlayerNote(+key.slice(0, ci), +key.slice(ci + 1));
    }
    restrikePianoOut(key); /* re-attack on the external synth if already sounding */
  } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
    heldLumatonePhys.delete(physId);
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
