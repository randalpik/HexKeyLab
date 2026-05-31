// Per-velocity spectral fingerprint for discovery. For a ~1s probe recording we
// summarize the post-onset region with: 24 log-spaced band energies (timbre
// shape, level-independent), a spectral centroid (brightness), and a windowed
// RMS level. Velocity layers in a hardware engine differ in timbre AND level,
// so all three feed the bin-boundary detector.

import { magnitudeSpectrum } from './fft.js';
import type { CaptureRecord } from '../device/types.js';

export interface Fingerprint {
  velocity: number;
  /** 24 log-spaced band energies, normalized to sum=1 (shape, not level). */
  bands: number[];
  /** Spectral centroid in Hz. */
  centroidHz: number;
  /** Windowed level in dBFS. */
  levelDb: number;
}

const N_BANDS = 24;
const BAND_LO = 50;
const BAND_HI = 16000;
const FFT_SIZE = 2048;
const WINDOW_SEC = 0.4;

function monoDownmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const coef = Math.sqrt(1 / channels.length);
  const out = new Float32Array(n);
  for (const cd of channels) for (let i = 0; i < n; i++) out[i] += cd[i] * coef;
  return out;
}

/** First sample whose magnitude exceeds a small threshold (onset). */
function findOnset(s: Float32Array): number {
  for (let i = 0; i < s.length; i++) if (Math.abs(s[i]) > 0.003) return i;
  return 0;
}

/** Log-spaced filterbank points (N_BANDS+2 of them): band b is a triangular
 *  filter spanning points[b]..points[b+2], peaking at points[b+1]. Overlapping
 *  triangles + log compression (below) make the fingerprint stable for sparse
 *  tonal spectra — a partial near a band edge splits smoothly across neighbors
 *  instead of jumping bins between captures. */
function filterPoints(): number[] {
  const pts: number[] = [];
  const logLo = Math.log(BAND_LO), logHi = Math.log(BAND_HI);
  for (let i = 0; i < N_BANDS + 2; i++) pts.push(Math.exp(logLo + (logHi - logLo) * (i / (N_BANDS + 1))));
  return pts;
}

export function computeFingerprint(rec: CaptureRecord, velocity: number): Fingerprint {
  const sr = rec.sampleRate;
  const mono = monoDownmix(rec.channels);
  const onset = findOnset(mono);
  const winLen = Math.min(mono.length - onset, Math.round(WINDOW_SEC * sr));
  const start = onset;
  const end = start + Math.max(0, winLen);

  // Windowed RMS level.
  let sumSq = 0;
  for (let i = start; i < end; i++) sumSq += mono[i] * mono[i];
  const rms = end > start ? Math.sqrt(sumSq / (end - start)) : 0;
  const levelDb = rms > 0 ? 20 * Math.log10(rms) : -120;

  // Welch-style averaged magnitude spectrum over overlapping FFT frames.
  const acc = new Float64Array(FFT_SIZE >> 1);
  let frames = 0;
  const hop = FFT_SIZE >> 1;
  for (let off = start; off + FFT_SIZE <= end; off += hop) {
    const mag = magnitudeSpectrum(mono, off, FFT_SIZE);
    for (let i = 0; i < mag.length; i++) acc[i] += mag[i];
    frames++;
  }
  if (frames === 0) {
    // Window too short for even one frame — single frame from onset (zero-padded).
    const mag = magnitudeSpectrum(mono, start, FFT_SIZE);
    for (let i = 0; i < mag.length; i++) acc[i] = mag[i];
    frames = 1;
  }
  for (let i = 0; i < acc.length; i++) acc[i] /= frames;

  // Aggregate into a triangular (mel-style) filterbank; energy = magnitude².
  const pts = filterPoints();
  const bands = new Array<number>(N_BANDS).fill(0);
  const binHz = sr / FFT_SIZE;
  let centroidNum = 0, centroidDen = 0;
  for (let i = 1; i < acc.length; i++) {
    const f = i * binHz;
    const e = acc[i] * acc[i];
    centroidNum += f * acc[i];
    centroidDen += acc[i];
    if (f <= pts[0] || f >= pts[N_BANDS + 1]) continue;
    for (let b = 0; b < N_BANDS; b++) {
      const lo = pts[b], ctr = pts[b + 1], hi = pts[b + 2];
      if (f <= lo || f >= hi) continue;
      const w = f <= ctr ? (f - lo) / (ctr - lo) : (hi - f) / (hi - ctr);
      bands[b] += w * e;
    }
  }
  // Log-compression flattens the dominance of single strong partials, so the
  // shape vector reflects timbre rather than which bin a harmonic happened to
  // land in; then normalize to sum=1.
  for (let b = 0; b < N_BANDS; b++) bands[b] = Math.log1p(bands[b]);
  const bandSum = bands.reduce((a, b) => a + b, 0) || 1;
  for (let b = 0; b < N_BANDS; b++) bands[b] /= bandSum;
  const centroidHz = centroidDen > 0 ? centroidNum / centroidDen : 0;

  return { velocity, bands, centroidHz, levelDb };
}
