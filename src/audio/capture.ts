// Audio-output capture lifecycle. Loads the AudioWorklet that taps the master
// limiter in parallel, accumulates Float32 frames on the main thread, and
// encodes a WAV blob on stop. Wired in from src/audio/engine.ts (init) and
// src/ui/recorder.ts (start/stop bracketed around .hkr record / playback).
//
// initCapture is best-effort: a worklet load failure leaves capture
// unsupported but never breaks the audio engine. startCapture is a no-op if
// the worklet isn't ready, so a fast first-session record won't error out.

import { audio } from '../state/audio.js';
import { encodeWav16 } from './wav.js';
/* `?url` keeps Vite from inlining the worklet as a data: URL — some browser
   versions reject data: URLs in audioWorklet.addModule(). The query returns
   the asset's served path (dev) or content-hashed file URL (prod). */
import captureWorkletUrl from './capture-worklet.js?url';

let node: AudioWorkletNode | null = null;
let supported = false;
let capturing = false;
let chunksL: Float32Array[] = [];
let chunksR: Float32Array[] = [];
let totalFrames = 0;
let sampleRate = 44100;

export function isCaptureSupported(): boolean { return supported; }
export function isCapturing(): boolean { return capturing; }

export async function initCapture(ctx: AudioContext): Promise<void> {
  if (supported) return;
  try {
    await ctx.audioWorklet.addModule(captureWorkletUrl);
    node = new AudioWorkletNode(ctx, 'hkl-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    node.port.onmessage = (ev: MessageEvent): void => {
      if (!capturing) return;
      const m = ev.data as { L: Float32Array; R: Float32Array };
      chunksL.push(m.L);
      chunksR.push(m.R);
      totalFrames += m.L.length;
    };
    sampleRate = ctx.sampleRate;
    supported = true;
  } catch (e) {
    console.warn('hkl: audio capture unavailable —', (e as Error).message);
    supported = false;
  }
}

export function startCapture(): void {
  if (!supported || !node || capturing) return;
  const lim = audio.limiter;
  if (!lim) return;
  chunksL = [];
  chunksR = [];
  totalFrames = 0;
  /* Parallel sink off the limiter — `limiter → destination` (existing edge)
     stays untouched; we add `limiter → node` so capture matches what the
     listener actually hears. node has 0 outputs, so nothing feeds back. */
  lim.connect(node);
  capturing = true;
}

export async function stopCapture(): Promise<Blob | null> {
  if (!capturing) return null;
  capturing = false;
  const lim = audio.limiter;
  if (lim && node) {
    try { lim.disconnect(node); } catch { /* already disconnected */ }
  }
  if (totalFrames === 0) {
    chunksL = []; chunksR = [];
    return null;
  }
  const L = new Float32Array(totalFrames);
  const R = new Float32Array(totalFrames);
  let off = 0;
  for (let i = 0; i < chunksL.length; i++) {
    L.set(chunksL[i], off);
    R.set(chunksR[i], off);
    off += chunksL[i].length;
  }
  chunksL = []; chunksR = [];
  totalFrames = 0;
  return encodeWav16([L, R], sampleRate);
}
