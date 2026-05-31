// Spectral-subtraction noise reduction. Every capture opens with the recorder's
// pre-roll silence — a clean noise profile of THAT capture's exact noise — so we
// estimate the noise magnitude spectrum from it and subtract it from the whole
// signal, per channel, via weighted overlap-add STFT.
//
// Magnitude subtraction with oversubtraction (alpha) and a spectral floor (beta):
// each bin is reduced by alpha·noiseMag but never below beta·|X| — that floor is
// what avoids "musical noise" (warbly artifacts). Phase is preserved. The note
// body sits far above the noise so it passes through nearly untouched; the work
// happens in the decay tail and inter-note silence, which is the chord-hiss source.

import { fftInPlace, ifftInPlace } from '../discovery/fft.js';

const FFT = 2048;
const HOP = FFT / 4;            // 75% overlap

export interface DenoiseOpts {
  /** Oversubtraction factor (higher = more aggressive). */
  alpha?: number;
  /** Spectral floor as a fraction of the original magnitude (caps the reduction
   *  ~−28 dB at 0.04; prevents musical noise). */
  floor?: number;
}

function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

function denoiseOne(x: Float32Array, noiseEnd: number, win: Float64Array, alpha: number, floorBeta: number): Float32Array {
  const N = x.length;
  // Zero-pad both ends by one frame so every real sample is covered by a full set
  // of overlapping frames — otherwise the leading/trailing partial frames divide
  // by a window value near zero and blow up the edges.
  const PAD = FFT;
  const M = N + 2 * PAD;
  const xp = new Float64Array(M);
  for (let i = 0; i < N; i++) xp[PAD + i] = x[i];

  // Noise magnitude estimate: average |X| over the pre-attack (silence) frames.
  const noiseMag = new Float64Array(FFT);
  let nFrames = 0;
  for (let p = PAD; p + FFT <= PAD + noiseEnd; p += HOP) {
    const re = new Float64Array(FFT), im = new Float64Array(FFT);
    for (let i = 0; i < FFT; i++) re[i] = xp[p + i] * win[i];
    fftInPlace(re, im);
    for (let i = 0; i < FFT; i++) noiseMag[i] += Math.hypot(re[i], im[i]);
    nFrames++;
  }
  if (nFrames === 0) return x;                 // not enough profile — leave as-is
  for (let i = 0; i < FFT; i++) noiseMag[i] /= nFrames;

  // Weighted overlap-add: analysis Hann → magnitude subtraction → synthesis Hann,
  // normalized by the summed squared window so reconstruction is gain-correct.
  const out = new Float64Array(M);
  const norm = new Float64Array(M);
  const re = new Float64Array(FFT), im = new Float64Array(FFT);
  for (let p = 0; p + FFT <= M; p += HOP) {
    for (let i = 0; i < FFT; i++) { re[i] = xp[p + i] * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (let i = 0; i < FFT; i++) {
      const mag = Math.hypot(re[i], im[i]);
      if (mag < 1e-12) continue;
      const reduced = Math.max(mag - alpha * noiseMag[i], floorBeta * mag);
      const g = reduced / mag;
      re[i] *= g; im[i] *= g;
    }
    ifftInPlace(re, im);
    for (let i = 0; i < FFT; i++) { out[p + i] += re[i] * win[i]; norm[p + i] += win[i] * win[i]; }
  }
  const y = new Float32Array(N);
  for (let i = 0; i < N; i++) { const idx = PAD + i; y[i] = norm[idx] > 1e-8 ? out[idx] / norm[idx] : 0; }
  return y;
}

/** Denoise each channel using the noise profile from [0, noiseEndSec). Returns
 *  the original channels unchanged if there isn't enough pre-roll for a profile. */
export function denoiseChannels(channels: Float32Array[], sampleRate: number, noiseEndSec: number, opts: DenoiseOpts = {}): Float32Array[] {
  const alpha = opts.alpha ?? 1.5;
  const floorBeta = opts.floor ?? 0.04;
  const noiseEnd = Math.floor(noiseEndSec * sampleRate);
  if (noiseEnd < FFT) return channels;
  const win = hannWindow(FFT);
  return channels.map(ch => denoiseOne(ch, noiseEnd, win, alpha, floorBeta));
}
