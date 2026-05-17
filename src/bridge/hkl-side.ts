// HKL-side bridge. Lives in the main HKL app (index.html). Three jobs:
//
//   1. Broadcast held-keys to Composer whenever selection.selectedKeys
//      changes. Polled at requestAnimationFrame; payloads are fully resolved
//      (pname/accid/oct/midi/colorHex/velocity) so Composer doesn't need to
//      import HKL's tuning logic.
//
//   2. Respond to Composer handshake / state requests with hkl-hello plus
//      a fresh held-keys + tuning-changed broadcast.
//
//   3. Receive play-chord / play-score / stop-playback. Dispatch to the
//      audio engine; emit playback-position acks as each chord onset fires.
//
// No changes to existing HKL modules — this file imports the public
// selection/tuning/audio state and the audio engine's noteOn/noteOff.

import { createHklBridge, PROTOCOL_VERSION } from './channel.js';
import type {
  ComposerEvent, PlaybackEvent, ResolvedNote, CoordRef,
} from './protocol.js';
import { selection } from '../state/selection.js';
import { audio } from '../state/audio.js';
import { tuning } from '../state/tuning.js';
import { noteName, keyOctave, parseNote, accToVal } from '../tuning/notes.js';
import { darkColorHex, coordToMidi } from '../transcription/pitch.js';
import { noteOn, noteOff, stopAllNotes } from '../audio/engine.js';
import { draw } from '../render/draw.js';
import type { KeyId } from '../types.js';

const bridge = createHklBridge();

/* ── resolution helpers ──────────────────────────────────────────────────── */

function letterToPname(letter: string): ResolvedNote['pname'] {
  return letter.toLowerCase() as ResolvedNote['pname'];
}

/** Convert HKL's internal accidental count string (`#`/`b`) to the bridge's
 *  MEI-style count string (`s`/`f`). Empty alteration becomes `''`. No
 *  clamping — Composer handles arbitrary alteration depth by decomposing
 *  into canonical glyphs (x / ts / tf / ff) and stacking `<accid>` children
 *  for ±4+. */
function accToMei(acc: string): string {
  const v = accToVal(acc);
  if (v === 0) return '';
  const sign = v > 0 ? 's' : 'f';
  return sign.repeat(Math.abs(v));
}

function resolveKey(q: number, r: number): ResolvedNote {
  const name = noteName(q, r);
  const parsed = parseNote(name);
  const key: KeyId = q + ',' + r;
  return {
    q, r,
    pname: letterToPname(parsed.letter),
    accid: accToMei(parsed.acc),
    oct: keyOctave(q, r),
    midi: coordToMidi(q, r),
    colorHex: darkColorHex(q, r),
    velocity: audio.keyVelocity[key] ?? 64,
  };
}

function tuningDescription(): string {
  if (tuning.equalEnabled) return '12-TET';
  if (tuning.septimalEnabled) return '7-limit JI';
  return '5-limit JI';
}

function tuningMode(): string {
  if (tuning.equalEnabled) return 'E';
  if (tuning.septimalEnabled) return '7';
  return '5';
}

/* ── held-keys polling ───────────────────────────────────────────────────── */

let lastHeldSerialized = '';
let lastTuningMode = '';

/* Playback adds keys to selection.selectedKeys for visual highlight via the
   existing draw() path. To avoid Composer seeing its own playback echoed
   back as "held keys" (input-feedback loop), broadcasts are suppressed
   while playbackActive is true. */
let playbackActive = false;
/* Keys that the playback added to selectedKeys (vs. keys the user was
   already holding). On noteOff or abort, only these get removed — user's
   real held keys survive. */
const playbackOwnedKeys: Set<KeyId> = new Set();

function broadcastHeldKeysIfChanged(): void {
  if (playbackActive) return;
  const keys: ResolvedNote[] = [];
  for (const keyId of selection.selectedKeys) {
    const parts = keyId.split(',');
    const q = parseInt(parts[0], 10);
    const r = parseInt(parts[1], 10);
    if (Number.isFinite(q) && Number.isFinite(r)) {
      keys.push(resolveKey(q, r));
    }
  }
  keys.sort((a, b) => a.midi - b.midi);
  /* Use a coarse signature for change-detection (midi + velocity per note).
     Re-resolving when only color/tuning changed is handled separately. */
  const sig = keys.map((k) => k.midi + ':' + k.velocity).join(',');
  if (sig !== lastHeldSerialized) {
    lastHeldSerialized = sig;
    bridge.send({ type: 'held-keys', keys });
  }
}

function broadcastTuningIfChanged(): void {
  const mode = tuningMode();
  if (mode !== lastTuningMode) {
    lastTuningMode = mode;
    bridge.send({ type: 'tuning-changed', mode, description: tuningDescription() });
    /* Tuning change implies color/spelling may have shifted for the same
       coords. Force a held-keys re-broadcast. */
    lastHeldSerialized = '';
    broadcastHeldKeysIfChanged();
  }
}

let rafHandle = 0;
function tick(): void {
  broadcastHeldKeysIfChanged();
  broadcastTuningIfChanged();
  rafHandle = requestAnimationFrame(tick);
}

/* ── playback dispatch ───────────────────────────────────────────────────── */

interface ActivePlayback {
  cancelled: boolean;
  pending: Set<number>; /* setTimeout handles, so stop-playback can clear them */
  heldKeys: Set<KeyId>; /* keys we noteOn'd, for force-off on stop */
}

let active: ActivePlayback | null = null;

function newPlayback(): ActivePlayback {
  return { cancelled: false, pending: new Set(), heldKeys: new Set() };
}

function abortActive(): void {
  if (!active) return;
  active.cancelled = true;
  for (const h of active.pending) clearTimeout(h);
  for (const k of active.heldKeys) {
    noteOff(k);
    if (playbackOwnedKeys.has(k)) {
      selection.selectedKeys.delete(k);
      playbackOwnedKeys.delete(k);
    }
  }
  active = null;
  playbackActive = false;
  draw();
}

function coordToKeyId(c: CoordRef): KeyId {
  return c.q + ',' + c.r;
}

function dispatchChord(notes: ReadonlyArray<CoordRef>, durationMs: number, pb: ActivePlayback): void {
  if (pb.cancelled) return;
  const keys: KeyId[] = notes.map(coordToKeyId);
  for (const k of keys) {
    noteOn(k, audio.keyVelocity[k] ?? 80);
    pb.heldKeys.add(k);
    /* Add to selectedKeys for visual highlight via existing draw() path.
       Track ownership so we only remove keys that were not already held by
       the user. */
    if (!selection.selectedKeys.has(k)) {
      selection.selectedKeys.add(k);
      playbackOwnedKeys.add(k);
    }
  }
  draw();
  const offHandle = window.setTimeout(() => {
    pb.pending.delete(offHandle);
    if (pb.cancelled) return;
    for (const k of keys) {
      noteOff(k);
      pb.heldKeys.delete(k);
      if (playbackOwnedKeys.has(k)) {
        selection.selectedKeys.delete(k);
        playbackOwnedKeys.delete(k);
      }
    }
    draw();
  }, durationMs);
  pb.pending.add(offHandle);
}

function playScore(events: ReadonlyArray<PlaybackEvent>): void {
  abortActive();
  if (events.length === 0) {
    bridge.send({ type: 'playback-finished' });
    return;
  }
  const pb = newPlayback();
  active = pb;
  playbackActive = true;

  let lastEnd = 0;
  for (const ev of events) {
    const onHandle = window.setTimeout(() => {
      pb.pending.delete(onHandle);
      if (pb.cancelled) return;
      dispatchChord(ev.notes, ev.durationMs, pb);
      bridge.send({
        type: 'playback-position',
        meiId: ev.meiId ?? null,
        timeMs: ev.atMs,
      });
    }, ev.atMs);
    pb.pending.add(onHandle);
    lastEnd = Math.max(lastEnd, ev.atMs + ev.durationMs);
  }

  const finHandle = window.setTimeout(() => {
    pb.pending.delete(finHandle);
    if (pb.cancelled) return;
    bridge.send({ type: 'playback-position', meiId: null, timeMs: lastEnd });
    bridge.send({ type: 'playback-finished' });
    playbackActive = false;
    if (active === pb) active = null;
  }, lastEnd + 50);
  pb.pending.add(finHandle);
}

/* ── inbound message dispatch ────────────────────────────────────────────── */

function announce(): void {
  bridge.send({ type: 'hkl-hello', version: PROTOCOL_VERSION });
  bridge.send({ type: 'tuning-changed', mode: tuningMode(), description: tuningDescription() });
  /* Force a held-keys broadcast even if empty. */
  lastHeldSerialized = 'force-resend';
  broadcastHeldKeysIfChanged();
}

bridge.on((msg: ComposerEvent) => {
  switch (msg.type) {
    case 'composer-hello':
    case 'request-state':
      announce();
      break;
    case 'composer-bye':
      /* Composer disconnected. Stop any playback in progress so we're not
         left with stuck notes. */
      abortActive();
      break;
    case 'play-score':
      playScore(msg.events);
      break;
    case 'stop-playback':
      abortActive();
      bridge.send({ type: 'playback-finished' });
      break;
  }
});

/* ── lifecycle ───────────────────────────────────────────────────────────── */

window.addEventListener('beforeunload', () => {
  abortActive();
  bridge.send({ type: 'hkl-bye' });
});

let initialized = false;
export function initHklBridge(): void {
  if (initialized) return;
  initialized = true;
  announce();
  rafHandle = requestAnimationFrame(tick);
}

/* DevTools handle. */
(window as unknown as { __hkl_bridge: unknown }).__hkl_bridge = {
  bridge,
  resolveKey,
  abortActive,
  stopAllNotes,
  rafHandle: () => rafHandle,
};
