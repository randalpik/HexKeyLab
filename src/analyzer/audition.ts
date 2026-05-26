// Audition — thin wrapper around the shared SegmentLooper for sustain
// samples, plus a one-shot path with release envelope for decay samples.
//
// All the segment-switching state machine lives in src/engine/segmentLooper.ts.
// This module just owns the AudioContext, manages the subscribe-based
// position/stop event surface, and dispatches per-frame playhead updates
// via requestAnimationFrame.

import { startSegmentLooper, type SegmentLooper } from '../engine/segmentLooper.js';

let _ctx: AudioContext | null = null;
let _looper: SegmentLooper | null = null;

interface DecayPlayback {
  src: AudioBufferSourceNode;
  gain: GainNode;
  startedAt: number;
  trimStart: number;
  bufferDur: number;
}
let _decay: DecayPlayback | null = null;

let _activeId: string | null = null;
let _rafHandle = 0;

type PositionFn = (id: string, timeSec: number) => void;
type StopFn = (id: string) => void;
const positionSubs = new Set<PositionFn>();
const stopSubs = new Set<StopFn>();

function getCtx(): AudioContext {
  if (_ctx) return _ctx;
  const AC = (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
    .AudioContext
    || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  _ctx = new AC();
  return _ctx;
}

function getCurrentPosition(): number | null {
  if (_looper) return _looper.getPosition();
  if (_decay && _ctx) {
    const t = _decay.trimStart + (_ctx.currentTime - _decay.startedAt);
    return Math.min(t, _decay.bufferDur);
  }
  return null;
}

function tickPlayhead(): void {
  if (_activeId == null) { _rafHandle = 0; return; }
  const t = getCurrentPosition();
  if (t != null) {
    for (const fn of positionSubs) {
      try { fn(_activeId, t); }
      catch (e) { console.error('audition position listener', e); }
    }
  }
  _rafHandle = requestAnimationFrame(tickPlayhead);
}

function fireStop(id: string): void {
  for (const fn of stopSubs) {
    try { fn(id); } catch (e) { console.error('audition stop listener', e); }
  }
}

/** Stop any in-flight audition. Fires onAuditionStop. No-op if idle. */
export function stopAudition(): void {
  if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = 0; }
  if (_activeId == null) return;
  const id = _activeId;
  if (_looper) { _looper.stop(); _looper = null; }
  if (_decay) {
    try { _decay.src.stop(); } catch {}
    try { _decay.src.disconnect(); } catch {}
    try { _decay.gain.disconnect(); } catch {}
    _decay = null;
  }
  _activeId = null;
  fireStop(id);
}

export interface AuditionOpts {
  gain?: number;
  segments?: ReadonlyArray<{ a: number; b: number }>;
  releaseTime?: number;
  trimStart?: number;
}

/** Play `buffer` through the AudioContext. `id` is an opaque caller-supplied
 *  string used to correlate position/stop events. */
export function audition(id: string, buffer: AudioBuffer, opts: AuditionOpts = {}): void {
  /* Stop the previous audition so subscribers see a clean stop for the
     old id before the new one starts. */
  stopAudition();
  const ctx = getCtx();
  if (ctx.state === 'suspended') void ctx.resume();

  const trim = opts.trimStart ?? 0;
  const gain = (opts.gain ?? 1) * 0.9;  /* small headroom */
  const segments = (opts.segments && opts.segments.length > 0) ? opts.segments : null;
  _activeId = id;

  if (segments) {
    /* Sustain path — delegate to the shared SegmentLooper. */
    _looper = startSegmentLooper({
      ctx,
      buffer,
      destination: ctx.destination,
      segments,
      gain,
      trimStart: trim,
    });
  } else {
    /* Decay path — single-shot playback with a release envelope. */
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = false;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(ctx.destination);
    const startedAt = ctx.currentTime;
    src.start(startedAt, trim);
    const releaseTime = opts.releaseTime ?? 0.3;
    const dur = Math.max(0.1, buffer.duration - trim);
    g.gain.setValueAtTime(gain, startedAt + dur - releaseTime);
    g.gain.linearRampToValueAtTime(0, startedAt + dur);
    try { src.stop(startedAt + dur); } catch {}
    src.onended = () => {
      if (_decay && _decay.src === src) stopAudition();
    };
    _decay = { src, gain: g, startedAt, trimStart: trim, bufferDur: buffer.duration };
  }

  if (!_rafHandle) _rafHandle = requestAnimationFrame(tickPlayhead);
}

/** Subscribe to audition position updates. Returns unsubscribe. */
export function onAuditionPosition(fn: PositionFn): () => void {
  positionSubs.add(fn);
  return () => { positionSubs.delete(fn); };
}

/** Subscribe to audition stop events. Returns unsubscribe. */
export function onAuditionStop(fn: StopFn): () => void {
  stopSubs.add(fn);
  return () => { stopSubs.delete(fn); };
}

/** Current audition id (caller-supplied), or null if nothing is playing. */
export function activeAuditionId(): string | null {
  return _activeId;
}
