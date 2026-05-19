// MIDI port discovery + note-on/off output + the (q,r) ⇄ (note,channel) mapping
// for the fixed-layout output.
//
// Output mapping: each unique pitch class across all three layouts gets a
// degree number (0…N-1); the channel encodes the octave (oct + 6, clipped to
// 1-10). On a layout switch buildMidiReverse rebuilds the (note,channel) → "q,r"
// reverse lookup so MIDI input from the Lumatone hits the right lattice key.
//
// findLumatone is the auto-detect entry point: scans access.outputs/inputs for
// a port named "Lumatone", wires onmidimessage, and (on a fresh connection)
// queries firmware + maybe runs an Auto-sync color push.

import { tuning } from '../state/tuning.js';
import { selection } from '../state/selection.js';
import { midi } from '../state/midi.js';
import { lumatone } from '../state/lumatone.js';
import { baseKeys, layoutShifts } from '../layout/baseKeys.js';
import { posInBand } from '../layout/coords.js';
import { keyFreq } from '../tuning/frequency.js';
import { syncAudio } from '../audio/engine.js';
import { sysex } from '../lumatone/sysex.js';
import { syncLumatoneColors } from '../lumatone/sync.js';
import { DEFAULT_DYNAMIC_MAP } from '../shared/dynamics.js';
import type { KeyId } from '../types.js';

interface MidiTarget {
  note: number;
  channel: number;
}

/* build scale degree lookup: enumerate all unique pitch classes across all layouts */
const degreeMap: Record<string, number> = {};
(function () {
  const pcList: { pk: string; cents: number }[] = [];
  const pcSeen: Record<string, true> = {};
  [1, 2, 3].forEach(function (li) {
    const sh = layoutShifts[li];
    baseKeys.forEach(function (k) {
      const q = k[0] + sh[0], r = k[1] + sh[1];
      const p = posInBand(q) - 1;
      const pk = r + ',' + p;
      if (!pcSeen[pk]) {
        pcSeen[pk] = true;
        let cents = 1200 * (p * Math.log2(5 / 4) + r * Math.log2(3 / 2));
        cents = ((cents % 1200) + 1200) % 1200;
        pcList.push({ pk, cents });
      }
    });
  });
  pcList.sort(function (a, b) { return a.cents - b.cents; });
  pcList.forEach(function (pc, i) { degreeMap[pc.pk] = i; });
})();

export function keyToMidi(q: number, r: number): MidiTarget | null {
  const p = posInBand(q) - 1;
  const deg = degreeMap[r + ',' + p];
  if (deg === undefined) return null;
  const ratio = keyFreq(q, r) / 220;
  const oct = Math.floor(Math.log2(ratio) + 0.0001);
  const ch = oct + 6;
  if (ch < 1 || ch > 10) return null;
  return { note: deg, channel: ch };
}

/* reverse lookup: (note,channel) → "q,r" for MIDI input */
export function buildMidiReverse(): void {
  midi.midiToKey = {};
  const sh = layoutShifts[tuning.curLayout];
  baseKeys.forEach(function (k) {
    const q = k[0] + sh[0], r = k[1] + sh[1];
    const m = keyToMidi(q, r);
    if (m) midi.midiToKey[m.note + ',' + m.channel] = q + ',' + r;
  });
}
buildMidiReverse();

export function midiNoteOn(key: KeyId): void {
  if (!midi.midiOut) return;
  const parts = key.split(',');
  const m = keyToMidi(+parts[0], +parts[1]);
  if (!m) return;
  midi.midiOut.send([0x90 + (m.channel - 1), m.note, DEFAULT_DYNAMIC_MAP.f]);
  midi.activeMidiNotes[key] = m;
}

export function midiNoteOff(key: KeyId): void {
  const m = midi.activeMidiNotes[key];
  if (!m || !midi.midiOut) return;
  midi.midiOut.send([0x80 + (m.channel - 1), m.note, 0]);
  delete midi.activeMidiNotes[key];
}

export function stopAllMidi(): void { for (const k in midi.activeMidiNotes) midiNoteOff(k); }

export function syncMidi(): void {
  if (!midi.midiOut) { stopAllMidi(); return; }
  for (const k in midi.activeMidiNotes) {
    if (!selection.selectedKeys.has(k)) midiNoteOff(k);
  }
  selection.selectedKeys.forEach(function (k) {
    if (!midi.activeMidiNotes[k]) midiNoteOn(k);
  });
}

export function syncOutput(): void { syncAudio(); syncMidi(); }

/* fixed MIDI: (channel 1-5, note 0-55) → baseKeys index → lattice (q,r) */
export function fixedMidiToKey(ch: number, note: number): KeyId | null {
  const idx = (ch - 1) * 56 + note;
  if (idx < 0 || idx >= 280) return null;
  const base = baseKeys[idx];
  const sh = layoutShifts[tuning.curLayout];
  return (base[0] + sh[0]) + ',' + (base[1] + sh[1]);
}

type MidiMessageHandler = (e: MIDIMessageEvent) => void;

/* MIDI port discovery. Auto-detects a "Lumatone" output + input port. Caller
   provides the inbound message handler — typically lives in main.ts because
   it routes across audio + sysex + selection state. */
export function findLumatone(handleMidiMessage: MidiMessageHandler): void {
  if (!midi.midiAccess) return;
  let foundOut: MIDIOutput | null = null;
  for (const port of midi.midiAccess.outputs.values()) {
    if (port.name && port.name.indexOf('Lumatone') !== -1 && port.state === 'connected') {
      foundOut = port; break;
    }
  }
  let foundIn: MIDIInput | null = null;
  for (const port of midi.midiAccess.inputs.values()) {
    if (port.name && port.name.indexOf('Lumatone') !== -1 && port.state === 'connected') {
      foundIn = port; break;
    }
  }
  /* Compare by port.id rather than JS object identity. Firefox's MIDIAccess
     is a snapshot — to detect hotplug we re-request access on a poll
     (lessons.md), which yields fresh MIDIPort *objects* for the same physical
     device. Object-identity comparisons would falsely flag every poll as a
     new connection and re-fire queryFirmware. id is stable per device. */
  const oldOut = midi.midiOut;
  const oldIn = midi.midiIn;
  const oldOutId = oldOut ? oldOut.id : null;
  const oldInId = oldIn ? oldIn.id : null;
  const newOutId = foundOut ? foundOut.id : null;
  const newInId = foundIn ? foundIn.id : null;
  const changed = oldOutId !== newOutId || oldInId !== newInId;
  /* update output */
  midi.midiOut = foundOut;
  if (!midi.midiOut && oldOut) {
    /* Lost connection: cancel any in-flight work and forget device state */
    stopAllMidi();
    sysex.cancel();
    lumatone.deviceColors = null;
    lumatone.fixedLayoutSent = false;
  } else if (midi.midiOut && oldOutId !== newOutId) {
    syncMidi();
  }
  /* update input — only rewire the message handler when the port identity
     changes, so polling that returns the same physical device doesn't churn. */
  if (oldInId !== newInId) {
    if (oldIn) oldIn.onmidimessage = null;
    midi.midiIn = foundIn;
    if (foundIn) foundIn.onmidimessage = handleMidiMessage;
  } else if (foundIn && foundIn !== oldIn) {
    /* Same id, fresh JS object (Firefox re-request case) — keep the new
       reference so subsequent sends/queries target a non-stale port. */
    midi.midiIn = foundIn;
    foundIn.onmidimessage = handleMidiMessage;
  }
  /* update UI */
  const statusEl = document.getElementById('lumaStatus')!;
  const lumaGroup = document.getElementById('tb-group-lumatone');
  if (midi.midiOut) {
    const isNewConnection = oldOutId !== newOutId;
    statusEl.textContent = 'Lumatone Connected';
    statusEl.className = 'luma-connected';
    if (lumaGroup) lumaGroup.classList.add('lumatone-connected');
    if (isNewConnection) {
      /* Silent firmware probe, then (only if user opted in) sync colors.
         We DO NOT auto-configure the device without Auto-sync checked. */
      sysex.queryFirmware();
      if (lumatone.autoSyncEnabled) syncLumatoneColors();
    }
  } else {
    statusEl.textContent = 'Lumatone Not Connected';
    statusEl.className = 'luma-disconnected';
    if (lumaGroup) lumaGroup.classList.remove('lumatone-connected');
  }
  if (changed) {
    console.log('Lumatone search: out=' + (midi.midiOut ? (midi.midiOut as MIDIOutput).name : 'none')
      + ', in=' + (midi.midiIn ? (midi.midiIn as MIDIInput).name : 'none'));
  }
}

/* Request MIDI access at startup. Caller provides handleMidiMessage so that
   findLumatone can wire it onto the input port. The Lumatone toolbar's
   visibility is owned by the user pref (toolbars.lumatone) — MIDI state only
   drives the lumaStatus text/class, not the toolbar's display.

   Firefox's MIDIAccess is a snapshot: no statechange events, and port.state
   doesn't update on existing references (lessons.md). The only way to see a
   newly-plugged device is to re-call requestMIDIAccess. That call is heavy
   enough to glitch audio playback while a Lumatone is already in use, so we
   ONLY poll while disconnected — once connected, the poll stops and the user
   manually re-checks via a click on the lumaStatus indicator (or page
   refresh) if they unplug. Chromium honors statechange so unplug-while-
   connected is detected automatically there. */
const HOTPLUG_POLL_MS = 1500;
let hotplugPollTimer: number | null = null;

function refreshMidiAccess(handleMidiMessage: MidiMessageHandler): void {
  navigator.requestMIDIAccess({ sysex: true }).then(function (access) {
    midi.midiAccess = access;
    /* Re-wire on the fresh access object — Chromium will fire statechange
       on it; on Firefox it never fires but the assignment is cheap. No
       logging inside the callback: a fresh MIDIAccess fires statechange
       once per known port on creation, which would flood the console. */
    access.onstatechange = function () { findLumatone(handleMidiMessage); };
    findLumatone(handleMidiMessage);
  }).catch(function () { /* swallow poll-failure noise */ });
}

export function requestMidi(handleMidiMessage: MidiMessageHandler): void {
  if (!navigator.requestMIDIAccess) return;
  navigator.requestMIDIAccess({ sysex: true }).then(function (access) {
    console.log('MIDI access granted');
    midi.midiAccess = access;
    findLumatone(handleMidiMessage);
    access.onstatechange = function () { findLumatone(handleMidiMessage); };
    if (hotplugPollTimer === null) {
      hotplugPollTimer = window.setInterval(function () {
        if (midi.midiOut) return;
        /* Only scan while the user is actually looking at Lumatone status.
           Hidden toolbar = the user has opted out of seeing this, so don't
           do any background work for it. */
        const lumaGroup = document.getElementById('tb-group-lumatone');
        if (!lumaGroup || lumaGroup.classList.contains('tb-hidden')) return;
        refreshMidiAccess(handleMidiMessage);
      }, HOTPLUG_POLL_MS);
    }
    /* Click the status text to force a re-check. Useful on Firefox where
       statechange isn't fired and we don't auto-poll while connected, so
       unplug-while-in-use isn't detected automatically. */
    const statusEl = document.getElementById('lumaStatus');
    if (statusEl) {
      statusEl.style.cursor = 'pointer';
      statusEl.title = 'Click to re-check Lumatone connection';
      statusEl.addEventListener('click', function () {
        refreshMidiAccess(handleMidiMessage);
      });
    }
  }).catch(function (err) { console.error('MIDI access denied:', err); });
}
