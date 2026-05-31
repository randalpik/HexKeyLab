// Compact iterative radix-2 Cooley-Tukey FFT, used by the discovery fingerprint
// (loop/decay analysis in @hkl/analysis is phase/loop-oriented and exposes no
// general magnitude spectrum). In-place; arrays must be a power-of-two length.

export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** In-place inverse FFT (via the conjugation trick), normalized by 1/N. */
export function ifftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fftInPlace(re, im);
  for (let i = 0; i < n; i++) { re[i] = re[i] / n; im[i] = -im[i] / n; }
}

/** Hann-windowed magnitude spectrum of a real frame of length `size` (power of
 *  two) starting at `offset`. Returns magnitudes for bins 0..size/2-1. */
export function magnitudeSpectrum(samples: Float32Array, offset: number, size: number): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const s = (offset + i < samples.length) ? samples[offset + i] : 0;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)); // Hann
    re[i] = s * w;
  }
  fftInPlace(re, im);
  const half = size >> 1;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}
