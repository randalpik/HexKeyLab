// Recording playback: walks an HkrSession's event stream and triggers the
// audio engine on schedule. Uses a Web-Audio-clock look-ahead scheduler (the
// Chris-Wilson pattern) so timing is sample-accurate.
//
// Playback owns a separate `playbackKeys` ledger so it can release only the
// voices it created. Live user input during playback (Lumatone, QWERTY,
// mouse) flows through the normal path and mixes with playback audio.
//
// Visual highlight: playback writes to `selection.selectedKeys` and calls
// draw() so keys flash on the hex canvas as they play, mirroring live input.

import { audio } from '../state/audio.js';
import { pedal } from '../state/pedal.js';
import { selection } from '../state/selection.js';
import {
  noteOn, noteOff, handleAftertouch,
  setDamperDepth, sostenutoOn, sostenutoOff,
} from '../audio/engine.js';
import { draw } from '../render/draw.js';
import type { HkrEvent, HkrSession } from './types.js';
import type { KeyId } from '../types.js';

const LOOKAHEAD_SEC = 0.1;
const TICK_INTERVAL_MS = 25;

let playing = false;
let curSession: HkrSession | null = null;
let nextIdx = 0;
let playT0 = 0;
let tickTimer: number | null = null;
let onEndCb: (() => void) | null = null;
const playbackKeys = new Set<KeyId>();
const scheduledTimers = new Set<number>();

export function isPlaying(): boolean { return playing; }

export function getPlaybackStartTime(): number { return playT0; }

export function getPlaybackSession(): HkrSession | null { return curSession; }

export function startPlayback(session: HkrSession, onEnd?: () => void): void {
  if (playing) return;
  if (!audio.audioCtx) return;
  curSession = session;
  nextIdx = 0;
  onEndCb = onEnd ?? null;
  playT0 = audio.audioCtx.currentTime;
  playing = true;
  scheduleTick();
}

function scheduleTick(): void {
  if (tickTimer !== null) clearTimeout(tickTimer);
  tickTimer = window.setTimeout(tick, TICK_INTERVAL_MS);
}

function tick(): void {
  tickTimer = null;
  if (!playing || !curSession || !audio.audioCtx) return;
  const ctx = audio.audioCtx;
  const elapsed = ctx.currentTime - playT0;
  const horizon = elapsed + LOOKAHEAD_SEC;
  const events = curSession.events;
  while (nextIdx < events.length && events[nextIdx].t <= horizon) {
    const ev = events[nextIdx++];
    const delayMs = Math.max(0, (ev.t - elapsed) * 1000);
    const timer = window.setTimeout(() => {
      scheduledTimers.delete(timer);
      dispatch(ev);
    }, delayMs);
    scheduledTimers.add(timer);
  }
  if (nextIdx >= events.length) {
    /* Wait for the last scheduled event to fire, plus a small tail. */
    const lastT = events.length > 0 ? events[events.length - 1].t : 0;
    const tailMs = Math.max(0, (lastT - (ctx.currentTime - playT0)) * 1000 + 100);
    tickTimer = window.setTimeout(finishPlayback, tailMs);
  } else {
    scheduleTick();
  }
}

function finishPlayback(): void {
  tickTimer = null;
  stopPlayback();
}

function dispatch(ev: HkrEvent): void {
  if (!playing) return;
  switch (ev.k) {
    case 'on': {
      const key: KeyId = ev.q + ',' + ev.r;
      /* Only claim ownership of voices we created — if a user-held voice
         exists for this coordinate, leave it alone so our 'off' doesn't kill
         their key. The audio engine's noteOn is a no-op in that case anyway. */
      if (!audio.activeOscs[key]) {
        audio.keyVelocity[key] = ev.v;
        noteOn(key, ev.v);
        if (audio.activeOscs[key]) playbackKeys.add(key);
      }
      selection.selectedKeys.add(key);
      draw();
      break;
    }
    case 'off': {
      const key: KeyId = ev.q + ',' + ev.r;
      if (playbackKeys.has(key)) {
        noteOff(key);
        playbackKeys.delete(key);
        selection.selectedKeys.delete(key);
        draw();
      }
      break;
    }
    case 'pa': {
      const key: KeyId = ev.q + ',' + ev.r;
      handleAftertouch(key, ev.p);
      break;
    }
    case 'cc4': {
      pedal.cc4Depth = ev.v;
      setDamperDepth();
      break;
    }
    case 'cc64': {
      if (pedal.mode === 'sostenuto') {
        if (ev.v >= 0.5) sostenutoOn(); else sostenutoOff();
      } else {
        pedal.cc64Depth = ev.v;
        setDamperDepth();
      }
      break;
    }
    case 'warn':
      break;
  }
}

export function stopPlayback(): void {
  if (!playing && tickTimer === null && scheduledTimers.size === 0) return;
  playing = false;
  if (tickTimer !== null) { clearTimeout(tickTimer); tickTimer = null; }
  scheduledTimers.forEach((t) => clearTimeout(t));
  scheduledTimers.clear();
  /* Release only voices we created. */
  playbackKeys.forEach((key) => {
    if (audio.activeOscs[key]) noteOff(key);
    selection.selectedKeys.delete(key);
  });
  playbackKeys.clear();
  draw();
  if (onEndCb) {
    const cb = onEndCb;
    onEndCb = null;
    cb();
  }
}
