// Recording capture: hooks called from the audio engine when notes / aftertouch /
// pedal events occur. The buffer is module-private; consumers see only the
// transport API (start, stop, isRecording) and per-event recorder shims.
//
// Capture point design: the audio engine is the convergence point downstream
// of every input source (Lumatone, QWERTY, mouse-click). Hooking here means
// `if (audio.audioEnabled === false)` silent input is naturally not recorded.

import { audio } from '../state/audio.js';
import { pedal } from '../state/pedal.js';
import { nowSec } from './clock.js';
import { captureSnapshot, snapshotMatchesLive } from './snapshot.js';
import type {
  HkrEvent, HkrSession, LayoutSnapshot,
} from './types.js';
import type { KeyId } from '../types.js';

let active = false;
let buffer: HkrEvent[] = [];
let snapshot: LayoutSnapshot | null = null;
let t0 = 0;
let divergenceWarned = false;
let lastCc4 = -1;
let lastCc64 = -1;

const CC4_EPSILON = 1 / 256;

export function isRecording(): boolean { return active; }

function effectiveCc64(): number {
  if (pedal.mode === 'sostenuto') return audio.sostenutoActive ? 1 : 0;
  return pedal.cc64Depth;
}

function pushEvent(ev: HkrEvent): void {
  buffer.push(ev);
}

function tNow(): number {
  return nowSec() - t0;
}

function checkDivergence(): void {
  if (divergenceWarned || !snapshot) return;
  if (!snapshotMatchesLive(snapshot)) {
    divergenceWarned = true;
    pushEvent({ t: tNow(), k: 'warn', msg: 'layoutChanged' });
  }
}

export function startRecording(): void {
  if (active) return;
  snapshot = captureSnapshot();
  buffer = [];
  divergenceWarned = false;
  lastCc4 = pedal.cc4Depth;
  lastCc64 = effectiveCc64();
  t0 = nowSec();
  /* Seed pedal state at t=0 so playback starts with the right context. */
  if (lastCc4 > 0) pushEvent({ t: 0, k: 'cc4', v: lastCc4 });
  if (lastCc64 > 0) pushEvent({ t: 0, k: 'cc64', v: lastCc64 });
  /* Auto-balance: synthetic note-ons for voices already held when recording
     started, so playback reproduces a recording that begins mid-chord. */
  for (const key in audio.activeOscs) {
    const parts = key.split(',');
    const q = +parts[0], r = +parts[1];
    const v = audio.keyVelocity[key] ?? 100;
    pushEvent({ t: 0, k: 'on', q, r, v });
  }
  active = true;
}

export function stopRecording(): HkrSession | null {
  if (!active || !snapshot) { active = false; return null; }
  const tEnd = tNow();
  /* Auto-balance: synthetic note-offs for voices still held. */
  for (const key in audio.activeOscs) {
    const parts = key.split(',');
    const q = +parts[0], r = +parts[1];
    pushEvent({ t: tEnd, k: 'off', q, r });
  }
  const session: HkrSession = {
    format: 'hkr',
    version: 1,
    createdAt: new Date().toISOString(),
    durationSec: Math.max(0, tEnd),
    timing: { unit: 'audioCtxSec', epoch: 0 },
    snapshot,
    events: buffer.slice(),
  };
  buffer = [];
  snapshot = null;
  active = false;
  return session;
}

export function recordOn(key: KeyId, velocity: number): void {
  if (!active) return;
  const parts = key.split(',');
  pushEvent({ t: tNow(), k: 'on', q: +parts[0], r: +parts[1], v: velocity });
  checkDivergence();
}

export function recordOff(key: KeyId): void {
  if (!active) return;
  const parts = key.split(',');
  pushEvent({ t: tNow(), k: 'off', q: +parts[0], r: +parts[1] });
}

export function recordPa(key: KeyId, pressure: number): void {
  if (!active) return;
  const parts = key.split(',');
  pushEvent({ t: tNow(), k: 'pa', q: +parts[0], r: +parts[1], p: pressure });
}

/* Hook from setDamperDepth(): emits cc4 and/or cc64 events whenever the
   pedal-state has changed since the last emission. Reads pedal.cc4Depth /
   pedal.cc64Depth directly. In sostenuto mode, cc64Depth is always 0 here —
   sostenutoOn/Off drives the cc64 channel via recordSostenuto. */
export function recordPedalDepthsChange(): void {
  if (!active) return;
  const t = tNow();
  if (Math.abs(pedal.cc4Depth - lastCc4) > CC4_EPSILON) {
    pushEvent({ t, k: 'cc4', v: pedal.cc4Depth });
    lastCc4 = pedal.cc4Depth;
  }
  if (pedal.mode === 'sustain' && pedal.cc64Depth !== lastCc64) {
    pushEvent({ t, k: 'cc64', v: pedal.cc64Depth });
    lastCc64 = pedal.cc64Depth;
  }
}

export function recordSostenuto(on: boolean): void {
  if (!active) return;
  const v = on ? 1 : 0;
  if (v !== lastCc64) {
    pushEvent({ t: tNow(), k: 'cc64', v });
    lastCc64 = v;
  }
}
