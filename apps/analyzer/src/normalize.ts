// Gain normalization — RMS / K-weighted loudness measurement.
//
// Port of analyzer/generate-samples.js gain block. Both branches target
// TARGET_DBFS (−18 dBFS) RMS with a peak ceiling at TARGET_PEAK_DBFS
// (−3 dBFS); the floor is GAIN_MIN (0.1×). The measurement window is what
// differs: loop path uses the analyzer's steady region (fallback: loudest
// 1s post-trim); decay path uses K-weighted integrated loudness over the
// full post-trim audio.
//
// K-weighting helpers come from analyzer/k-weighting.js (browser-runnable
// ES module). This module passes through `stereo` (interleaved L,R Float32)
// and `mono` (single-channel Float32) untouched.

import type { AnalysisResult } from './state.js';
// k-weighting.js is an untyped engine module; the imports are runtime-checked
// at the call sites below.
// @ts-ignore - .js module with no .d.ts
import { measureLufs, measureDecayLufs } from '../../../analyzer/k-weighting.js';

const TARGET_DBFS = -18;
const TARGET_RMS = Math.pow(10, TARGET_DBFS / 20);     /* ≈ 0.12589 */
const TARGET_PEAK_DBFS = -3;
const TARGET_PEAK = Math.pow(10, TARGET_PEAK_DBFS / 20); /* ≈ 0.70795 */
const GAIN_MIN = 0.1;

export interface MeasureResult {
  /** Stereo-combined RMS-equivalent (linear). */
  rms: number | null;
  /** Stereo peak (linear, max absolute over both channels). */
  peak: number | null;
  /** ITU-R BS.1770 LUFS (informational). */
  lufs?: number;
  /** Number of momentary windows the LUFS integrator saw. */
  nWindows?: number;
  /** Where the measurement happened (steady / lufs / loudest1s / etc.). */
  region?: string;
  failReason?: string;
}

function stereoRmsOver(stereo: Float32Array, start: number, end: number): number {
  if (end <= start) return 0;
  let sumSq = 0;
  for (let i = start; i < end; i++) {
    const l = stereo[2 * i];
    const r = stereo[2 * i + 1];
    sumSq += l * l + r * r;
  }
  return Math.sqrt(sumSq / (2 * (end - start)));
}

/** Loop-path loudness measurement: K-weighted integrated loudness over the
 *  analyzer's steady region. Falls back to loudest 1s post-trim window when
 *  the steady region is <400ms (below the K-weighting minimum) or missing.
 *  Mirrors analyzer/generate-samples.js:measureRmsLoop. */
export function measureRmsLoop(
  stereo: Float32Array,
  mono: Float32Array,
  sr: number,
  res: AnalysisResult | null,
): MeasureResult {
  const stats = (res && (res.stats as { steadyStartSec?: number; steadyEndSec?: number } | undefined)) || undefined;
  if (stats && typeof stats.steadyStartSec === 'number' && typeof stats.steadyEndSec === 'number') {
    const start = Math.round(stats.steadyStartSec * sr);
    const end = Math.round(stats.steadyEndSec * sr);
    if (end - start >= Math.round(sr * 0.4)) {
      const m = measureLufs(stereo, mono, sr, { startSample: start, endSample: end }) as MeasureResult;
      if (m && m.rms != null) return { ...m, region: 'steady' };
    }
  }
  /* Fallback: scan for the loudest 1s window (cheap RMS), then run K-weighting
     on the winning region. Matches generate-samples.js:measureRmsLoop. */
  const trimStartSec = (res && typeof res.trimStart === 'number') ? res.trimStart : 0;
  const start = Math.max(0, Math.round(trimStartSec * sr));
  const end = mono.length;
  if (end - start < Math.round(sr * 0.4)) {
    return { rms: null, peak: null, failReason: 'post-trim region too short for measurement' };
  }
  const winSamp = Math.min(end - start, Math.round(sr * 1.0));
  const hopSamp = Math.max(1, Math.round(sr * 0.1));
  let bestRms = 0;
  let bestStart = start;
  for (let s = start; s + winSamp <= end; s += hopSamp) {
    const r = stereoRmsOver(stereo, s, s + winSamp);
    if (r > bestRms) { bestRms = r; bestStart = s; }
  }
  const lastStart = end - winSamp;
  if (lastStart > start) {
    const r = stereoRmsOver(stereo, lastStart, end);
    if (r > bestRms) { bestRms = r; bestStart = lastStart; }
  }
  if (bestRms <= 0) return { rms: null, peak: null, failReason: 'no audible region found' };
  const m = measureLufs(stereo, mono, sr, { startSample: bestStart, endSample: bestStart + winSamp }) as MeasureResult;
  if (!m || m.rms == null) {
    return m || { rms: null, peak: null, failReason: 'k-weighting returned no result' };
  }
  return { ...m, region: 'loudest1s' };
}

/** Decay-path loudness measurement: K-weighted integrated loudness over the
 *  full post-trim audio. Mirrors generate-samples.js:measureDecay. */
export function measureDecay(stereo: Float32Array, mono: Float32Array, sr: number): MeasureResult {
  const m = measureDecayLufs(stereo, mono, sr) as MeasureResult;
  if (!m || m.rms == null) {
    return m || { rms: null, peak: null, failReason: 'k-weighting returned no result' };
  }
  return { ...m, region: m.region || 'lufs-decay' };
}

/** Unified gain calculation for both loop and decay paths:
 *    gain = min(TARGET_RMS / rms, TARGET_PEAK / peak), floored at GAIN_MIN.
 *  Returns null when the measurement was invalid. */
export function computeGain(meas: MeasureResult | null): number | null {
  if (!meas || meas.rms == null || meas.rms <= 0) return null;
  const gainRms = TARGET_RMS / meas.rms;
  const gainPeakCeiling = (meas.peak != null && meas.peak > 0) ? (TARGET_PEAK / meas.peak) : Infinity;
  return Math.max(GAIN_MIN, Math.min(gainRms, gainPeakCeiling));
}

/** Build an interleaved stereo Float32Array from a 1- or 2-channel buffer.
 *  Used by the worker to feed K-weighting (which expects [L,R,L,R,…]).
 *  Single-channel input is duplicated to L=R. */
export function buildInterleavedStereo(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  const n = channels[0].length;
  const out = new Float32Array(n * 2);
  const l = channels[0];
  const r = channels.length > 1 ? channels[1] : l;
  for (let i = 0; i < n; i++) {
    out[2 * i] = l[i];
    out[2 * i + 1] = r[i];
  }
  return out;
}

/** Energy-preserving mono downmix: y[n] = sqrt(1/N) * sum(channels). Matches
 *  ffmpeg's `-ac 1` for N=2 (coef = sqrt(0.5) per channel). Single-channel
 *  input is returned as-is. */
export function buildMonoDownmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const coef = Math.sqrt(1 / channels.length);
  const out = new Float32Array(n);
  for (let ch = 0; ch < channels.length; ch++) {
    const cd = channels[ch];
    for (let i = 0; i < n; i++) out[i] += cd[i] * coef;
  }
  return out;
}
