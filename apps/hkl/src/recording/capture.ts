// Recording capture: hooks called from the audio engine when notes / aftertouch /
// pedal events occur. The buffer is module-private; consumers see only the
// transport API (start, stop, isRecording) and per-event recorder shims.
//
// Capture point design: the audio engine is the convergence point downstream
// of every input source (Lumatone, QWERTY, mouse-click). Hooking here means
// `if (audio.audioEnabled === false)` silent input is naturally not recorded.

import { audio } from '../state/audio.js';
import { tuning } from '../state/tuning.js';
import { readsAnchor } from '@hkl/shared/freq.js';
import { nowSec } from './clock.js';
import { captureSnapshot, snapshotMatchesLive } from './snapshot.js';
import { DEFAULT_DYNAMIC_MAP } from '@hkl/shared/dynamics.js';
import type {
  HkrEvent, HkrSession, LayoutSnapshot,
} from './types.js';
import { coordOf } from '../types.js';
import type { KeyId } from '../types.js';

let active = false;
let buffer: HkrEvent[] = [];
let snapshot: LayoutSnapshot | null = null;
let t0 = 0;
let t0Anchored = false;
let divergenceWarned = false;
/* The two pedal streams record what the pedals DO, never which jack or device
   did it (docs/architecture/hkl.md → Recording): `cc4` is the damper depth,
   from whatever holds the damper, and `cc64` is the sostenuto. The event names
   are the file format's, from when each stream was one jack. */
let lastDamper = -1;
let lastSostenuto = -1;

const DAMPER_EPSILON = 1 / 256;

export function isRecording(): boolean { return active; }

function pushEvent(ev: HkrEvent): void {
  buffer.push(ev);
}

/* Lazy-anchor t0 at the first event push, so dead time before the first
   action (button-press → first note/pedal move) is trimmed. Seed pushes at
   record-start anchor immediately so held-note/pedal context sits at t=0. */
function tNow(): number {
  if (!t0Anchored) {
    t0 = nowSec();
    t0Anchored = true;
    return 0;
  }
  return nowSec() - t0;
}

function checkDivergence(): void {
  if (divergenceWarned || !snapshot) return;
  if (!snapshotMatchesLive(snapshot)) {
    divergenceWarned = true;
    pushEvent({ t: tNow(), k: 'warn', msg: 'layoutChanged' });
  }
}

/* A note-on's own anchor, when a re-anchor (Syntonic / Polysyntonic, or any
   mode unbanded) has moved it off the snapshot's — playback and export then
   sound it under that anchor. */
function eventAnchor(): { a?: number } {
  if (!snapshot || !readsAnchor(tuning.mode, tuning.banded)) return {};
  return tuning.anchor === snapshot.anchor ? {} : { a: tuning.anchor };
}

export function startRecording(): void {
  if (active) return;
  snapshot = captureSnapshot();
  buffer = [];
  divergenceWarned = false;
  lastDamper = audio.damperDepth;
  lastSostenuto = audio.sostenutoActive ? 1 : 0;
  t0Anchored = false;
  active = true;
  /* Seed pedal state at t=0 so playback starts with the right context.
     First seed call anchors t0; subsequent ones return ~0. */
  if (lastDamper > 0) pushEvent({ t: tNow(), k: 'cc4', v: lastDamper });
  if (lastSostenuto > 0) pushEvent({ t: tNow(), k: 'cc64', v: lastSostenuto });
  /* Auto-balance: synthetic note-ons for voices already held when recording
     started, so playback reproduces a recording that begins mid-chord. */
  for (const key in audio.activeOscs) {
    if (coordOf(key) !== key) continue; /* live voices only; skip playback voices */
    const parts = key.split(',');
    const q = +parts[0], r = +parts[1];
    const v = audio.keyVelocity[key] ?? DEFAULT_DYNAMIC_MAP.f;
    pushEvent({ t: tNow(), k: 'on', q, r, v, ...eventAnchor() });
  }
}

export function stopRecording(): HkrSession | null {
  if (!active || !snapshot) { active = false; return null; }
  const tEnd = tNow();
  /* Auto-balance: synthetic note-offs for voices still held. */
  for (const key in audio.activeOscs) {
    if (coordOf(key) !== key) continue; /* live voices only; skip playback voices */
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
  pushEvent({ t: tNow(), k: 'on', q: +parts[0], r: +parts[1], v: velocity, ...eventAnchor() });
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

/* Hook from setDamperDepth(), after it has combined every damper source:
   emits a cc4 event whenever the depth has changed since the last emission. */
export function recordDamper(): void {
  if (!active) return;
  if (Math.abs(audio.damperDepth - lastDamper) > DAMPER_EPSILON) {
    pushEvent({ t: tNow(), k: 'cc4', v: audio.damperDepth });
    lastDamper = audio.damperDepth;
  }
}

/* Hook from sostenutoOn/Off(): emits a cc64 event when the sostenuto changes. */
export function recordSostenuto(on: boolean): void {
  if (!active) return;
  const v = on ? 1 : 0;
  if (v !== lastSostenuto) {
    pushEvent({ t: tNow(), k: 'cc64', v });
    lastSostenuto = v;
  }
}
