// Lumatone liveness heartbeat: notices a power-off by the device going silent
// and hands it to markLumatoneGone, which releases everything it was holding.
//
// Why: a Lumatone switched off emits a short burst of spurious note-ons —
// protocol-valid, indistinguishable from playing (lessons.md) — and never
// sends their note-offs. Firefox never reports the port vanishing (MIDIAccess
// is a snapshot), so nothing else would release them. Nothing at runtime
// separates the burst from a dense loud chord, so the burst is NOT filtered:
// it sounds briefly and is cleared once the device stops answering.
//
// Mechanism: while the Lumatone is holding anything (keys down, damper or
// sostenuto engaged) and has sent nothing for QUIET_MS, ping it (CMD 0x33).
// ANY inbound message from the port is proof of life, so active playing sends
// no pings at all — it is the silence after the burst that triggers one.
// Measured on Max's unit: the BBB stops answering SysEx within ~100ms of the
// burst.
//
// The ping is the lightest request the firmware handles — preamble + one
// write(), no PIC traffic — a strict subset of an LED update, which HKL sends
// at ~300/s during color sync. Verified on hardware at 50 pings/s with no
// effect on playing.
//
// Jank: the reply is dispatched on our main thread, so a blocked main thread
// looks exactly like a silent device (lessons.md, "A Web MIDI round trip
// cannot measure device health"). The wait is therefore ticked in TICK_MS
// steps, and a wait in which any tick ran late is INCONCLUSIVE: not counted,
// just re-asked. Only a wait the main thread was demonstrably free for counts
// as a miss, and MISSES_TO_DEPART consecutive misses declare the device gone.

import { midi } from '../state/midi.js';
import { buildPingSysEx } from '../lumatone/protocol.js';
import { markLumatoneGone } from './engine.js';

export const HEARTBEAT_QUIET_MS = 200;
export const HEARTBEAT_REPLY_TIMEOUT_MS = 250;
export const HEARTBEAT_MISSES_TO_DEPART = 2;
const TICK_MS = 50;
/* a tick this much later than scheduled means the main thread was blocked */
const JANK_SLACK_MS = 75;

/* Supplied by handler.ts, which owns the held-key tracking. */
let holding: () => boolean = () => false;
export function setHeartbeatHoldingProbe(fn: () => boolean): void { holding = fn; }

let lastInboundAt = 0;
let quietTimer: number | null = null;
let waitTimer: number | null = null;
let awaiting = false;
let pingSentAt = 0;
let lastTickAt = 0;
let jankSeen = false;
let misses = 0;
let seq = 0;

/** Called for every inbound message on the Lumatone port: proof of life. */
export function heartbeatInbound(): void {
  lastInboundAt = performance.now();
  misses = 0;
  if (awaiting) endWait();
  if (quietTimer === null) armQuiet(HEARTBEAT_QUIET_MS);
}

/** Stop all timers and forget the miss count (departure, tests). */
export function stopHeartbeat(): void {
  if (quietTimer !== null) { clearTimeout(quietTimer); quietTimer = null; }
  endWait();
  misses = 0;
}

function armQuiet(ms: number): void {
  quietTimer = window.setTimeout(onQuiet, ms);
}

function endWait(): void {
  awaiting = false;
  if (waitTimer !== null) { clearTimeout(waitTimer); waitTimer = null; }
}

function onQuiet(): void {
  quietTimer = null;
  const idle = performance.now() - lastInboundAt;
  if (idle < HEARTBEAT_QUIET_MS) { armQuiet(HEARTBEAT_QUIET_MS - idle); return; }
  ping();
}

function ping(): void {
  /* Nothing held means nothing can be left stuck: go idle until the next
     inbound message re-arms the quiet timer. */
  if (!midi.midiOut || !holding()) { misses = 0; return; }
  awaiting = true;
  jankSeen = false;
  pingSentAt = lastTickAt = performance.now();
  try { midi.midiOut.send(buildPingSysEx(seq++)); }
  catch { /* a throwing send means a dead port; the wait runs out as a miss */ }
  waitTimer = window.setTimeout(onTick, TICK_MS);
}

function onTick(): void {
  waitTimer = null;
  if (!awaiting) return;
  const now = performance.now();
  if (now - lastTickAt > TICK_MS + JANK_SLACK_MS) jankSeen = true;
  lastTickAt = now;
  if (now - pingSentAt < HEARTBEAT_REPLY_TIMEOUT_MS) {
    waitTimer = window.setTimeout(onTick, TICK_MS);
    return;
  }
  awaiting = false;
  if (!jankSeen && ++misses >= HEARTBEAT_MISSES_TO_DEPART) {
    misses = 0;
    markLumatoneGone('no reply to ' + HEARTBEAT_MISSES_TO_DEPART + ' pings while holding notes');
    return;
  }
  ping();
}
