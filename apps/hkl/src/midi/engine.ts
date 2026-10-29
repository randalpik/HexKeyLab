// Lumatone MIDI port discovery and liveness, plus the fixed-layout input map
// (fixedMidiToKey: channel 1-5 × note 0-55 → lattice key). HKL sends the device
// SysEx only; notes are never echoed back to it.
//
// findLumatone is the auto-detect entry point: scans access.outputs/inputs for
// a port named "Lumatone", wires onmidimessage, and (on a fresh connection)
// queries firmware + maybe runs an Auto-sync color push.

import { midi } from '../state/midi.js';
import { lumatone } from '../state/lumatone.js';
import { lumatoneCell } from '../layout/physical.js';
import { syncAudio } from '../audio/engine.js';
import { syncPianoOut } from './piano-out.js';
import { sysex } from '../lumatone/sysex.js';
import { syncLumatoneColors } from '../lumatone/sync.js';
import { buildPingSysEx, isPingReply } from '../lumatone/protocol.js';
import type { KeyId } from '../types.js';

export function syncOutput(): void { syncAudio(); syncPianoOut(); }

/* fixed MIDI: (channel 1-5, note 0-55) → physical key → the lattice cell it
   plays at the current anchor (layout/physical.ts), so the lattice slides
   under the static Lumatone outline on user-driven ref change. Resolves a
   STRIKE only: held keys release through the KeyId recorded at strike time
   (input/held.ts). */
export function fixedMidiToKey(ch: number, note: number): KeyId | null {
  const idx = (ch - 1) * 56 + note;
  if (idx < 0 || idx >= 280) return null;
  const [q, r] = lumatoneCell(idx);
  return q + ',' + r;
}

type MidiMessageHandler = (e: MIDIMessageEvent) => void;

/* Invoked when the Lumatone is determined to be gone, to release everything
   the device was holding (see midi/handler.ts releaseLumatoneInput). Wired by
   handler.ts at module load rather than imported directly: handler.ts already
   imports this module, so importing it back would make a cycle. */
let deviceLostHandler: (() => void) | null = null;
export function setLumatoneLostHandler(fn: () => void): void { deviceLostHandler = fn; }

/* Set when WE declared the device gone (rather than observing the port
   vanish). The hotplug poll normally skips work while the Lumatone toolbar is
   hidden; after a self-declared departure we still need it to run, or a
   false positive would leave the device deaf until a manual re-check.

   While set, a Lumatone port that (re)appears is only a CANDIDATE: Firefox's
   fresh MIDIAccess keeps listing a powered-off Lumatone as connected for as
   long as its USB link lingers (observed: re-attached ~100ms after the
   device stopped answering, then showed "connected" indefinitely). So the
   candidate must answer a ping before it is adopted (confirmCandidate). */
let pendingReconnect = false;
const CONFIRM_TIMEOUT_MS = 500;
let candidate: { inPort: MIDIInput; timer: number } | null = null;

function dropCandidate(): void {
  if (!candidate) return;
  clearTimeout(candidate.timer);
  candidate.inPort.onmidimessage = null;
  candidate = null;
}

/* Ping a candidate port pair; adopt it (by re-running findLumatone with the
   pending flag cleared) only on a reply. No reply: drop it and let the next
   poll tick try again. Only a ping reply counts here — a straggling note from
   a dying device must not confirm it. */
function confirmCandidate(out: MIDIOutput, inp: MIDIInput, handleMidiMessage: MidiMessageHandler): void {
  if (candidate && candidate.inPort === inp) return; /* already asking this one */
  dropCandidate();
  const timer = window.setTimeout(dropCandidate, CONFIRM_TIMEOUT_MS);
  candidate = { inPort: inp, timer };
  inp.onmidimessage = function (e: MIDIMessageEvent) {
    if (!e.data || !isPingReply(e.data)) return;
    dropCandidate();
    pendingReconnect = false;
    findLumatone(handleMidiMessage);
  };
  try { out.send(buildPingSysEx(0)); }
  catch { /* dead port: the timer drops the candidate */ }
}

function updateLumatoneStatusUI(): void {
  const statusEl = document.getElementById('lumaStatus');
  const lumaGroup = document.getElementById('tb-group-lumatone');
  if (!statusEl) return;
  if (midi.midiOut) {
    statusEl.textContent = 'Lumatone connected';
    statusEl.className = 'luma-connected';
    if (lumaGroup) lumaGroup.classList.add('lumatone-connected');
  } else {
    statusEl.textContent = 'Lumatone Not Connected';
    statusEl.className = 'luma-disconnected';
    if (lumaGroup) lumaGroup.classList.remove('lumatone-connected');
  }
}

/* Declare the Lumatone gone on evidence other than the port vanishing.
   The live trigger is the liveness heartbeat (midi/heartbeat.ts): the device
   stopped answering pings while holding notes, which on Firefox is the only
   way a power-off is ever noticed.

   Detaching onmidimessage stops anything still in flight from latching, and
   the release handler clears what the burst already latched. Nulling midiOut
   also re-arms the hotplug poll; a port that reappears must answer a ping
   before it is re-adopted (confirmCandidate), so a false positive costs a
   brief dropout and a dead device can't be re-adopted as "connected". */
export function markLumatoneGone(reason: string): void {
  if (!midi.midiOut && !midi.midiIn) return; /* already gone */
  console.warn('Lumatone: treating as disconnected \u2014 ' + reason);
  if (midi.midiIn) { midi.midiIn.onmidimessage = null; midi.midiIn = null; }
  midi.midiOut = null;
  sysex.cancel();
  lumatone.deviceColors = null;
  lumatone.fixedLayoutSent = false;
  pendingReconnect = true;
  /* Port state has already changed, so the badge must reflect it NOW — before
     the voice release, which is the part with any chance of failing. Ordering
     it the other way round made a throw in cleanup leave the indicator still
     claiming "connected" while the notes had in fact been released. */
  updateLumatoneStatusUI();
  if (deviceLostHandler) {
    try { deviceLostHandler(); }
    catch (e) { console.error('Lumatone: releasing held input on departure failed', e); }
  }
}

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
  /* After a self-declared departure, a reappearing port is only a candidate
     until it answers a ping. Nothing below applies meanwhile: markLumatoneGone
     already tore the device state down and set the badge. */
  if (pendingReconnect && !midi.midiOut) {
    if (foundOut && foundIn) confirmCandidate(foundOut, foundIn, handleMidiMessage);
    return;
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
    /* Lost connection: cancel any in-flight work and forget device state.
       Also release everything the device was holding — note-offs and pedal
       CCs can never arrive from a port that's gone, so held voices would
       otherwise hang forever (Chromium reaches here via statechange; Firefox
       never does — it departs via the heartbeat's markLumatoneGone instead). */
    sysex.cancel();
    lumatone.deviceColors = null;
    lumatone.fixedLayoutSent = false;
    if (deviceLostHandler) {
      try { deviceLostHandler(); }
      catch (e) { console.error('Lumatone: releasing held input on departure failed', e); }
    }
  }
  /* update input — only rewire the message handler when the port identity
     changes, so polling that returns the same physical device doesn't churn. */
  if (oldInId !== newInId) {
    if (oldIn) oldIn.onmidimessage = null;
    midi.midiIn = foundIn;
    if (foundIn) foundIn.onmidimessage = handleMidiMessage;
  } else if (foundIn && foundIn !== oldIn) {
    /* Same id, fresh JS object (Firefox re-request case) — keep the new
       reference so subsequent sends/queries target a non-stale port. The old
       object must be detached: both stay open on the same physical port, so
       leaving it wired delivers every message twice, and markLumatoneGone
       (which detaches only midi.midiIn) would leave the old one feeding the
       rest of a power-off burst into the handler. */
    if (oldIn) oldIn.onmidimessage = null;
    midi.midiIn = foundIn;
    foundIn.onmidimessage = handleMidiMessage;
  }
  /* update UI */
  updateLumatoneStatusUI();
  if (midi.midiOut) {
    pendingReconnect = false;
    if (oldOutId !== newOutId) {
      /* Silent firmware probe, then (only if user opted in) sync colors.
         We DO NOT auto-configure the device without Auto-sync checked. */
      sysex.queryFirmware();
      if (lumatone.autoSyncEnabled) syncLumatoneColors();
    }
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

/** Resolves with the MIDIAccess once requestMidi's initial promise lands.
 *  Other modules (e.g. midi/piano.ts) await this to bind to a persisted
 *  device immediately on app load rather than waiting for a hotplug-poll
 *  tick (~1.5s). Rejected if `navigator.requestMIDIAccess` isn't available
 *  or the permission was denied. */
let midiAccessReadyPromise: Promise<MIDIAccess> | null = null;
let midiAccessReadyResolve: ((a: MIDIAccess) => void) | null = null;
let midiAccessReadyReject: ((e: unknown) => void) | null = null;
function ensureMidiAccessReadyPromise(): Promise<MIDIAccess> {
  if (midiAccessReadyPromise) return midiAccessReadyPromise;
  midiAccessReadyPromise = new Promise((resolve, reject) => {
    midiAccessReadyResolve = resolve;
    midiAccessReadyReject = reject;
  });
  return midiAccessReadyPromise;
}
export function whenMidiAccessReady(): Promise<MIDIAccess> {
  return ensureMidiAccessReadyPromise();
}

export function requestMidi(handleMidiMessage: MidiMessageHandler): void {
  if (!navigator.requestMIDIAccess) {
    ensureMidiAccessReadyPromise();
    if (midiAccessReadyReject) midiAccessReadyReject(new Error('Web MIDI not available'));
    return;
  }
  ensureMidiAccessReadyPromise();
  navigator.requestMIDIAccess({ sysex: true }).then(function (access) {
    console.log('MIDI access granted');
    midi.midiAccess = access;
    findLumatone(handleMidiMessage);
    access.onstatechange = function () { findLumatone(handleMidiMessage); };
    /* Fire the access-ready promise so listeners (Piano toolbar in
       particular) can run their device-binding logic immediately rather
       than waiting on the 1.5s hotplug poll. */
    if (midiAccessReadyResolve) midiAccessReadyResolve(access);
    if (hotplugPollTimer === null) {
      hotplugPollTimer = window.setInterval(function () {
        if (midi.midiOut) return;
        /* Only scan while the user is actually looking at Lumatone status.
           Hidden toolbar = the user has opted out of seeing this, so don't
           do any background work for it. */
        const lumaGroup = document.getElementById('tb-group-lumatone');
        const hidden = !lumaGroup || lumaGroup.classList.contains('tb-hidden');
        if (hidden && !pendingReconnect) return;
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
  }).catch(function (err) {
    console.error('MIDI access denied:', err);
    if (midiAccessReadyReject) midiAccessReadyReject(err);
  });
}
