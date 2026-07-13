// Broadband noise reduction by decision-directed Wiener filtering (Ephraim-Malah
// a-priori SNR estimator). Replaces plain spectral subtraction, whose per-bin
// magnitude subtraction flickers bins near the profile frame-to-frame and leaves
// "musical noise" (warbly narrowband birdies that stack across a soft chord).
//
// The decision-directed a-priori SNR ξ is a recursive blend of the previous
// frame's clean estimate and the current instantaneous SNR; that temporal
// smoothing is what suppresses musical noise. The Wiener gain G = ξ/(1+ξ) is
// then a smooth function of ξ, floored at GAIN_MIN so a natural low-level bed
// remains instead of gated silence.
//
// Noise power is estimated per-bin from the recorder's pre-attack pre-roll (a
// clean profile of THAT capture's exact broadband floor). The tonal comb is
// removed upstream by the notch de-whiner (analysis/dewhine), so what reaches
// here is broadband hiss.

import { fftInPlace, ifftInPlace } from '../discovery/fft.js';

const FFT = 2048;
const HOP = FFT / 4;               // 75% overlap

export interface WienerOpts {
  /** Decision-directed smoothing factor (0..1). Higher = more temporal
   *  smoothing = less musical noise, slower to track transients. */
  ddAlpha?: number;
  /** Gain floor (linear) — the residual noise bed left in place. 0.06 ≈ −24 dB. */
  gainMin?: number;
  /** Overestimation of the noise power (>1 = more aggressive). */
  noiseOverEst?: number;
}

function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

function wienerOne(
  x: Float32Array, noiseEnd: number, win: Float64Array,
  ddAlpha: number, gainMin: number, noiseOverEst: number,
): Float32Array {
  const N = x.length;
  // Zero-pad both ends by a frame so every real sample sees a full overlap set
  // (partial edge frames otherwise divide by a near-zero window sum).
  const PAD = FFT;
  const M = N + 2 * PAD;
  const xp = new Float64Array(M);
  for (let i = 0; i < N; i++) xp[PAD + i] = x[i];

  const half = (FFT >> 1) + 1;

  // Per-bin noise POWER estimate: mean |X|² over the pre-attack (silence) frames.
  const noisePow = new Float64Array(half);
  let nFrames = 0;
  {
    const re = new Float64Array(FFT), im = new Float64Array(FFT);
    for (let p = PAD; p + FFT <= PAD + noiseEnd; p += HOP) {
      for (let i = 0; i < FFT; i++) { re[i] = xp[p + i] * win[i]; im[i] = 0; }
      fftInPlace(re, im);
      for (let k = 0; k < half; k++) noisePow[k] += re[k] * re[k] + im[k] * im[k];
      nFrames++;
    }
  }
  if (nFrames === 0) return x;                    // not enough profile — leave as-is
  for (let k = 0; k < half; k++) noisePow[k] = (noisePow[k] / nFrames) * noiseOverEst + 1e-20;

  // WOLA synthesis, normalized by the summed squared window.
  const out = new Float64Array(M);
  const norm = new Float64Array(M);
  const re = new Float64Array(FFT), im = new Float64Array(FFT);
  // Decision-directed state: previous frame's clean power estimate and gain.
  const prevCleanPow = new Float64Array(half);
  const prevGain = new Float64Array(half);
  let firstFrame = true;

  for (let p = 0; p + FFT <= M; p += HOP) {
    for (let i = 0; i < FFT; i++) { re[i] = xp[p + i] * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (let k = 0; k < half; k++) {
      const power = re[k] * re[k] + im[k] * im[k];
      const lambda = noisePow[k];
      const gammaPost = power / lambda;                       // a-posteriori SNR
      // Decision-directed a-priori SNR.
      const xi = firstFrame
        ? Math.max(gammaPost - 1, 0)
        : ddAlpha * (prevCleanPow[k] / lambda) + (1 - ddAlpha) * Math.max(gammaPost - 1, 0);
      let g = xi / (1 + xi);                                  // Wiener gain
      if (g < gainMin) g = gainMin;
      prevGain[k] = g;
      prevCleanPow[k] = (g * g) * power;                      // clean power for next frame's DD
      re[k] *= g; im[k] *= g;
      // Mirror the conjugate-symmetric upper half.
      if (k > 0 && k < FFT - k) { re[FFT - k] = re[k]; im[FFT - k] = -im[k]; }
    }
    firstFrame = false;
    ifftInPlace(re, im);
    for (let i = 0; i < FFT; i++) { out[p + i] += re[i] * win[i]; norm[p + i] += win[i] * win[i]; }
  }

  const y = new Float32Array(N);
  for (let i = 0; i < N; i++) { const idx = PAD + i; y[i] = norm[idx] > 1e-8 ? out[idx] / norm[idx] : 0; }
  return y;
}

/** Wiener-denoise each channel using the noise profile from [0, noiseEndSec).
 *  Returns the input unchanged when there isn't enough pre-roll for a profile. */
export function wienerDenoiseChannels(
  channels: Float32Array[], sampleRate: number, noiseEndSec: number, opts: WienerOpts = {},
): Float32Array[] {
  const ddAlpha = opts.ddAlpha ?? 0.98;
  const gainMin = opts.gainMin ?? 0.06;
  const noiseOverEst = opts.noiseOverEst ?? 1.5;
  const noiseEnd = Math.floor(noiseEndSec * sampleRate);
  if (noiseEnd < FFT) return channels;
  const win = hannWindow(FFT);
  return channels.map(ch => wienerOne(ch, noiseEnd, win, ddAlpha, gainMin, noiseOverEst));
}
