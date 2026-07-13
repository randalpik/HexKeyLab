// De-whine: remove a device's fixed tonal artifacts (DAC/switching-clock combs,
// timer tones) from a capture. Unlike broadband noise, these are STABLE, NARROW-
// BAND tones at fixed frequencies, IDENTICAL in every note — so they stack
// coherently across a chord and spectral subtraction (which profiles broadband
// noise from the pre-roll) neither locks onto nor fully removes them. The right
// tool for a pure fixed tone is a NOTCH, not subtraction: it leaves no musical
// noise and costs almost nothing on the (broadband) program material sitting
// around it.
//
// Two halves:
//   detectCombTones(idleMono, sr) — from an idle recording (device on, no note),
//     find the prominent narrowband tones (the whine profile).
//   dewhineChannels(channels, sr, toneHz) — zero-phase biquad notch at each tone.
//
// The notches run on the RAW capture, BEFORE broadband NR, where the comb is at
// full strength (see analysis/buildHki cleanOf).

import { fftInPlace } from '../discovery/fft.js';

export interface DetectOpts {
  /** FFT size for the averaged spectrum (fine resolution → separate close tones). */
  fftSize?: number;
  /** A tone must exceed the local median by this many dB to count (prominence). */
  prominenceDb?: number;
  /** A tone must exceed the GLOBAL spectrum median (broadband floor) by this many
   *  dB — rejects noise-level bins that happen to be local maxima. */
  aboveFloorDb?: number;
  /** Ignore peaks weaker than (strongest peak − dynamicRangeDb). */
  dynamicRangeDb?: number;
  /** Only consider tones at or above this frequency (Hz). Device combs are HF;
   *  this keeps the detector from notching musical low-end / mains hum, which the
   *  broadband NR handles. */
  minHz?: number;
  /** Cap on the number of tones returned (strongest first). */
  maxTones?: number;
}

const DEFAULT_FFT = 16384;

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** Welch-averaged magnitude spectrum (linear) of `mono`, one bin per sr/N Hz. */
function avgSpectrum(mono: Float32Array, N: number): Float64Array {
  const win = hann(N);
  const half = N >> 1;
  const acc = new Float64Array(half);
  const re = new Float64Array(N), im = new Float64Array(N);
  const hop = N >> 1;
  let frames = 0;
  for (let off = 0; off + N <= mono.length; off += hop) {
    for (let i = 0; i < N; i++) { re[i] = mono[off + i] * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (let i = 0; i < half; i++) acc[i] += Math.hypot(re[i], im[i]);
    frames++;
  }
  if (frames === 0) {
    // Signal shorter than one frame: single zero-padded frame.
    for (let i = 0; i < N; i++) { re[i] = (i < mono.length ? mono[i] : 0) * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (let i = 0; i < half; i++) acc[i] = Math.hypot(re[i], im[i]);
    frames = 1;
  }
  for (let i = 0; i < half; i++) acc[i] /= frames;
  return acc;
}

const db = (x: number): number => (x > 1e-12 ? 20 * Math.log10(x) : -140);

/** Detect the prominent narrowband tones in an idle recording — the device's
 *  whine profile. Returns tone center frequencies (Hz), strongest first. Pure. */
export function detectCombTones(idleMono: Float32Array, sr: number, opts: DetectOpts = {}): number[] {
  const N = opts.fftSize ?? DEFAULT_FFT;
  const promDb = opts.prominenceDb ?? 10;
  const floorDb = opts.aboveFloorDb ?? 12;
  const dynDb = opts.dynamicRangeDb ?? 30;
  const minHz = opts.minHz ?? 500;
  const maxTones = opts.maxTones ?? 24;
  if (idleMono.length < 64) return [];

  const spec = avgSpectrum(idleMono, N);
  const half = spec.length;
  const binHz = sr / N;
  const minBin = Math.max(2, Math.ceil(minHz / binHz));
  // Local-median window (~±150 Hz) for prominence; robust to the broadband tilt.
  const medHalf = Math.max(8, Math.round(150 / binHz));
  // Global broadband floor: median over the considered band. A real tone stands
  // well above it; a noise bin that's merely a local maximum does not.
  const globalSorted = Array.from(spec.subarray(minBin)).sort((a, b) => a - b);
  const globalFloorDb = db(globalSorted[globalSorted.length >> 1] || 1e-12);

  const peaks: Array<{ hz: number; db: number }> = [];
  for (let i = minBin; i < half - 2; i++) {
    if (!(spec[i] > spec[i - 1] && spec[i] >= spec[i + 1])) continue;
    const peakDb = db(spec[i]);
    if (peakDb - globalFloorDb < floorDb) continue;
    const lo = Math.max(0, i - medHalf), hi = Math.min(half, i + medHalf);
    const window = Array.from(spec.subarray(lo, hi)).sort((a, b) => a - b);
    const med = window[window.length >> 1] || 1e-12;
    if (peakDb - db(med) < promDb) continue;
    // Parabolic interpolation for sub-bin center frequency.
    const a = db(spec[i - 1]), b = db(spec[i]), c = db(spec[i + 1]);
    const denom = a - 2 * b + c;
    const delta = denom !== 0 ? 0.5 * (a - c) / denom : 0;
    peaks.push({ hz: (i + delta) * binHz, db: peakDb });
  }
  if (peaks.length === 0) return [];
  const strongest = Math.max(...peaks.map(p => p.db));
  return peaks
    .filter(p => p.db >= strongest - dynDb)
    .sort((x, y) => y.db - x.db)
    .slice(0, maxTones)
    .map(p => p.hz);
}

export interface NotchOpts {
  /** Notch −3 dB bandwidth in Hz (narrow → surgical). */
  bandwidthHz?: number;
}

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number; }

/** RBJ cookbook notch (a0-normalized) at f0 with the given −3 dB bandwidth. */
function notchBiquad(f0: number, sr: number, bwHz: number): Biquad {
  const w0 = (2 * Math.PI * f0) / sr;
  const Q = f0 / bwHz;
  const alpha = Math.sin(w0) / (2 * Q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  return { b0: 1 / a0, b1: (-2 * cos) / a0, b2: 1 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/** Direct-form-I biquad over `x` (new array). */
function biquad(x: Float64Array, bq: Biquad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < x.length; n++) {
    const xn = x[n];
    const yn = bq.b0 * xn + bq.b1 * x1 + bq.b2 * x2 - bq.a1 * y1 - bq.a2 * y2;
    y[n] = yn; x2 = x1; x1 = xn; y2 = y1; y1 = yn;
  }
  return y;
}

/** Zero-phase (forward-backward) biquad — squares the magnitude response, so no
 *  phase distortion and a deeper notch. Offline only. */
function filtfilt(x: Float64Array, bq: Biquad): Float64Array {
  const fwd = biquad(x, bq);
  fwd.reverse();
  const back = biquad(fwd, bq);
  back.reverse();
  return back;
}

/** Notch out each tone in `toneHz` from every channel, zero-phase. Tones at or
 *  above Nyquist (−100 Hz guard) are skipped. Returns NEW arrays; input
 *  untouched. A null/empty tone list returns the channels unchanged (copied). */
export function dewhineChannels(
  channels: Float32Array[],
  sr: number,
  toneHz: number[] | null | undefined,
  opts: NotchOpts = {},
): Float32Array[] {
  if (!toneHz || toneHz.length === 0) return channels.map(ch => ch.slice());
  const bw = opts.bandwidthHz ?? 12;
  const nyq = sr / 2 - 100;
  const notches = toneHz.filter(f => f > 0 && f < nyq).map(f => notchBiquad(f, sr, bw));
  return channels.map(ch => {
    let buf: Float64Array = new Float64Array(ch);
    for (const bq of notches) buf = filtfilt(buf, bq);
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i];
    return out;
  });
}
