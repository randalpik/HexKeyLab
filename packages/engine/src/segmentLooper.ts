// Single-voice segment-loop executor. Plays an AudioBuffer through a
// crossfaded chain of AudioBufferSourceNodes, with each wrap landing on a
// randomly-chosen next segment via pickNextSeam. Mirrors the segments path
// of samples-engine.ts:scheduleSegmentSwitch but factored as a self-
// contained single-voice unit so it can be reused by:
//
//   - HKL's main audio engine (src/audio/samples-engine.ts) — per-voice
//     instance, integrated with rate ramps, range attenuation, etc.
//   - The Analyzer UI's audition (src/analyzer/audition.ts) — single voice
//     at native rate, faithful preview of what production will sound like.
//   - The future extracted HKLE library (per docs/backlog.md ENGINE).
//
// Web Audio APIs are runtime, so this module lives under src/engine/ (not
// src/shared/). The pure algorithm — pickNextSeam — is in shared/segments.ts.

import { pickNextSeam, findInitialSegIdx, type Segment } from '@hkl/shared/segments.js';

const DEFAULT_CROSSFADE_SEC = 0.030;

export interface SegmentLooperOpts {
  ctx: AudioContext;
  buffer: AudioBuffer;
  /** Where the looper's output connects. Caller owns post-routing. */
  destination: AudioNode;
  segments: ReadonlyArray<Segment>;
  /** Linear gain multiplier (applied to each source's gain node). */
  gain: number;
  /** Initial buffer offset (silence trim). Default 0. */
  trimStart?: number;
  /** Crossfade duration in seconds. Default 30 ms — matches production. */
  crossfadeSec?: number;
  /** Constant playback rate multiplier. 1.0 = native pitch. Rate ramps mid-
   *  playback are NOT supported here (production needs them; the looper
   *  caller would handle that path separately). */
  playbackRate?: number;
}

export interface SegmentLooper {
  /** Stop playback, disconnect all live sources, free resources. Idempotent. */
  stop(): void;
  /** Current buffer position in seconds. Jumps at each wrap; advances
   *  linearly between wraps. */
  getPosition(): number;
  /** Whether the looper is still active (stop() not yet called). */
  isActive(): boolean;
}

interface PendingSwitch {
  newSrc: AudioBufferSourceNode;
  newGain: GainNode;
  switchTime: number;
  startOffset: number;
  endAt: number;
  newSegIdx: number;
}

/** Start a multi-segment crossfade-chained playback. Begins immediately
 *  (the first source's start() is scheduled at ctx.currentTime + trimStart
 *  offset; the chain continues until stop() is called). */
export function startSegmentLooper(opts: SegmentLooperOpts): SegmentLooper {
  const ctx = opts.ctx;
  const buffer = opts.buffer;
  const segments = opts.segments;
  const gain = opts.gain;
  const trimStart = opts.trimStart ?? 0;
  const crossfadeSec = opts.crossfadeSec ?? DEFAULT_CROSSFADE_SEC;
  const rate = opts.playbackRate ?? 1;
  const destination = opts.destination;

  if (segments.length === 0) {
    throw new Error('startSegmentLooper: segments cannot be empty');
  }

  let active = true;
  let pending: PendingSwitch | null = null;

  /* Create the initial source. */
  const initialSegIdx = findInitialSegIdx(segments, trimStart);
  const src0 = ctx.createBufferSource();
  src0.buffer = buffer;
  src0.loop = false;
  src0.playbackRate.value = rate;
  const g0 = ctx.createGain();
  g0.gain.value = gain;
  src0.connect(g0).connect(destination);
  const startedAt = ctx.currentTime;
  src0.start(startedAt, trimStart);

  let currentSrc: AudioBufferSourceNode = src0;
  let currentGain: GainNode = g0;
  let currentStartCtx = startedAt;
  let currentStartOffset = trimStart;
  let currentEndAt = segments[initialSegIdx].b;
  let currentSegIdx = initialSegIdx;

  function schedulePending(): void {
    if (!active || pending) return;
    /* Audio-clock-anchored switch time: when the current source's playback
       position reaches its wrap point (segments[currentSegIdx].b), accounting
       for rate. Clamped to "just past now" so a pathologically late call
       still produces a coherent next source. */
    const naturalSwitch = currentStartCtx + (currentEndAt - currentStartOffset) / rate;
    const switchTime = Math.max(naturalSwitch, ctx.currentTime + 0.005);
    const picked = pickNextSeam(segments, currentSegIdx);
    const newSrc = ctx.createBufferSource();
    newSrc.buffer = buffer;
    newSrc.loop = false;
    newSrc.playbackRate.value = rate;
    const newGain = ctx.createGain();
    /* Fade in from silence to full gain over crossfadeSec. */
    newGain.gain.setValueAtTime(0, switchTime);
    newGain.gain.linearRampToValueAtTime(gain, switchTime + crossfadeSec);
    newSrc.connect(newGain).connect(destination);
    newSrc.start(switchTime, picked.a);
    /* Fade out the current source over the same window, then schedule a
       stop a beat later to free GPU resources. */
    currentGain.gain.cancelScheduledValues(switchTime);
    currentGain.gain.setValueAtTime(gain, switchTime);
    currentGain.gain.linearRampToValueAtTime(0, switchTime + crossfadeSec);
    try {
      currentSrc.stop(switchTime + crossfadeSec + 0.05);
    } catch {
      /* Already stopped or scheduled — fine. */
    }
    pending = {
      newSrc,
      newGain,
      switchTime,
      startOffset: picked.a,
      endAt: picked.b,
      newSegIdx: picked.nextSegIdx,
    };
  }

  /** Promote pending → current when ctx.currentTime crosses switchTime.
   *  Called by getPosition (so callers driving via rAF get the transition
   *  reflected in the same frame). */
  function commitIfDue(): void {
    if (!pending) return;
    if (ctx.currentTime < pending.switchTime) return;
    currentSrc = pending.newSrc;
    currentGain = pending.newGain;
    currentStartCtx = pending.switchTime;
    currentStartOffset = pending.startOffset;
    currentEndAt = pending.endAt;
    currentSegIdx = pending.newSegIdx;
    pending = null;
    schedulePending();
  }

  function getPosition(): number {
    commitIfDue();
    return currentStartOffset + (ctx.currentTime - currentStartCtx) * rate;
  }

  function stop(): void {
    if (!active) return;
    active = false;
    try { currentSrc.stop(); } catch {}
    try { currentSrc.disconnect(); } catch {}
    try { currentGain.disconnect(); } catch {}
    if (pending) {
      try { pending.newSrc.stop(); } catch {}
      try { pending.newSrc.disconnect(); } catch {}
      try { pending.newGain.disconnect(); } catch {}
      pending = null;
    }
  }

  /* Kick off the first scheduled switch. */
  schedulePending();

  return {
    stop,
    getPosition,
    isActive: () => active,
  };
}
