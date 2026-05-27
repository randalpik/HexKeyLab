// Pipeline Web Worker — runs analyzer.prepareLoop / analyzeDecay + gain
// normalization off the main thread. Long samples can push a single
// instrument's analysis past 30 s; the worker keeps the UI responsive
// while it churns.
//
// Vite imports this via `?worker` in pipeline.ts. The worker imports
// analyzer/analyzer-analysis.js and k-weighting.js directly — both are
// pure browser JS that runs anywhere the structured-clone subset works.
//
// The main thread does decodeAudioData() (workers don't have an
// AudioContext) and ships per-channel Float32Array slices to the worker
// via transferable. Inside, we wrap them in an AudioBuffer-shaped duck
// (the analyzer only touches .getChannelData()/.numberOfChannels/.length/
// .sampleRate/.duration) so analyzer-analysis.js imports unchanged.

import type { AnalysisResult } from './state.js';
import {
  buildInterleavedStereo,
  buildMonoDownmix,
  measureRmsLoop,
  measureDecay,
  computeGain,
  type MeasureResult,
} from './normalize.js';

// Engine modules — untyped, pulled in at worker init.
// @ts-ignore .js module
import { HKLAnalysis } from '../../../analyzer/analyzer-analysis.js';

interface AnalyzeRequest {
  type: 'analyze';
  sampleId: string;
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
  labeledFreq: number;
  decays: boolean;
  vibrato: boolean;
  opts: Record<string, unknown>;
}

export interface WorkerResultMessage {
  type: 'result';
  sampleId: string;
  result: AnalysisResult;
  gain: number | null;
  measuredLevel: number | null;
  measuredRegion?: string;
}

export interface WorkerErrorMessage {
  type: 'error';
  sampleId: string;
  message: string;
}

type WorkerOutMessage = WorkerResultMessage | WorkerErrorMessage;

interface AudioBufferDuck {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  duration: number;
  getChannelData(ch?: number): Float32Array;
}

function wrapBuffer(channels: Float32Array[], sampleRate: number): AudioBufferDuck {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0].length,
    duration: channels[0].length / sampleRate,
    getChannelData: (ch = 0) => channels[ch] ?? channels[0],
  };
}

/* analyzeDecay — port of analyzer/generate-samples.js:analyzeDecay. */
function analyzeDecay(buf: AudioBufferDuck, freq: number): AnalysisResult {
  const sr = buf.sampleRate;
  const d = buf.getChannelData(0);
  const trim = HKLAnalysis.trimSilence(d, sr) as { trimStart: number; trimEnd: number };
  const trimStart = trim.trimStart;
  const winLen = Math.round(sr * 0.5);
  if (d.length - trimStart < winLen + Math.round(sr * 0.05)) {
    return { failReason: 'sample too short for decay analysis', trimStart: trimStart / sr };
  }
  /* Slide a 500ms window forward, find the loudest position. */
  const hop = Math.round(sr * 0.05);
  let bestStart = trimStart;
  let bestRms = 0;
  for (let s = trimStart; s + winLen < d.length; s += hop) {
    let sum = 0;
    for (let k = 0; k < winLen; k++) sum += d[s + k] * d[s + k];
    if (sum > bestRms) { bestRms = sum; bestStart = s; }
  }
  const T = HKLAnalysis.refineFundamentalPeriod(d, sr, freq, bestStart, bestStart + winLen, {
    tRefineRange: 0.05,
    minPeakRatio: 0.5,
  }) as number | null;
  if (T == null) {
    return { failReason: 'no fundamental at labeled freq ±5%', trimStart: trimStart / sr };
  }
  const freqActual = 1 / T;
  return {
    trimStart: trimStart / sr,
    freqActual,
    stats: { driftCents: 1200 * Math.log2(freqActual / freq), method: 'decay' },
  } as AnalysisResult;
}

function runLoopPath(buf: AudioBufferDuck, freq: number, vibrato: boolean, opts: Record<string, unknown>): AnalysisResult {
  /* applyConfigDefaults layers vibrato hint + trend defaults into opts, same
     as generate-samples.js. Browser-form overrides live in `opts` already. */
  const merged = HKLAnalysis.applyConfigDefaults({ vibrato }, opts);
  return HKLAnalysis.prepareLoop(buf, freq, merged) as AnalysisResult;
}

self.addEventListener('message', (e: MessageEvent<AnalyzeRequest>) => {
  const msg = e.data;
  if (msg.type !== 'analyze') return;
  const { sampleId, channels, sampleRate, labeledFreq, decays, vibrato, opts } = msg;

  try {
    const buf = wrapBuffer(channels, sampleRate);
    const mono = buildMonoDownmix(channels);
    const stereo = buildInterleavedStereo(channels);

    const result: AnalysisResult = decays
      ? analyzeDecay(buf, labeledFreq)
      : runLoopPath(buf, labeledFreq, vibrato, opts);

    /* Gain measurement: loop uses steady region (or loudest-1s fallback);
       decay uses K-weighted integrated loudness over full post-trim audio. */
    const meas: MeasureResult = decays
      ? measureDecay(stereo, mono, sampleRate)
      : measureRmsLoop(stereo, mono, sampleRate, result);
    const gain = computeGain(meas);

    const out: WorkerResultMessage = {
      type: 'result',
      sampleId,
      result,
      gain,
      measuredLevel: meas?.rms ?? null,
      measuredRegion: meas?.region,
    };
    /* Don't transfer back — result objects contain analyzer-owned arrays
       (trend, segments, etc.) that may be reused. Cost of structured clone
       is negligible relative to the analysis. */
    (self as unknown as { postMessage(m: WorkerOutMessage): void }).postMessage(out);
  } catch (err) {
    const out: WorkerErrorMessage = {
      type: 'error',
      sampleId: msg.sampleId,
      message: (err as Error).message || String(err),
    };
    (self as unknown as { postMessage(m: WorkerOutMessage): void }).postMessage(out);
  }
});
