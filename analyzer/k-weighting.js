/* K-weighted loudness measurement per ITU-R BS.1770-4, exported as
   measureDecayLufs for use by the decay-path gain normalizer in both
   generate-samples.js and backfill-gains.js.

   Why K-weighting (vs the previous 200ms post-trim RMS):
     The 200ms window was dominated by the hammer/attack transient. Two
     adjacent samples with matched attack RMS can have very different
     sustained loudness if their sources have inconsistent attack-vs-sustain
     ratios — a problem we hit on the Maestro grand piano (Eb5 ~8 dB louder
     than E5 in absolute level; matched attack normalization left the
     sustains drifting by 2–6 dB, audibly louder on E5 over the full
     ring-down). K-weighted integrated loudness with BS.1770 momentary-window
     gating measures over the audible portion of the entire decay, weighted
     for frequency sensitivity, and tracks perceived loudness across
     inconsistent source recordings far better than peak-anchored RMS.

   Pipeline:
     1. Pre-filter (high-shelf @1681 Hz, +4 dB, Q=0.707) on each channel —
        approximates the head-related boost in the ear's response.
     2. RLB filter (high-pass @38 Hz, Q=0.5) on each channel — removes sub-
        audible low-frequency energy that doesn't contribute to loudness.
     3. Momentary loudness curve: 400ms windows, 100ms hop, starting at the
        trim point. L_M = -0.691 + 10*log10(meansq_L + meansq_R).
     4. Absolute gate: discard windows below -70 LUFS.
     5. Relative gate: discard windows below (gate1_mean - 10 LU).
     6. Integrated loudness = mean of gated windows in the energy domain.

   Return shape mirrors the legacy measureDecay so the gain calculation in
   computeGain stays unchanged:
     rms  — stereo-RMS-equivalent (sqrt(integrated_combined/2)), matches the
            existing TARGET_RMS = sqrt(Σ(L²+R²)/2N) convention.
     peak — unfiltered stereo peak over the analysis horizon (clip protection
            is about raw sample values, not perceived loudness).
     lufs — integrated K-weighted loudness, for reporting.
*/

const PRE_FC = 1681.974450955533;
const PRE_G_DB = 3.999843853973347;
const PRE_Q = 0.7071752369554196;
const RLB_FC = 38.13547087602444;
const RLB_Q = 0.5003270373238773;
const LUFS_OFFSET = -0.691;

/* Build pre-filter (high-shelf) and RLB (high-pass) biquads via bilinear
   transform at the given sample rate. Verified against the BS.1770 reference
   coefficients at 48 kHz (e.g. pre-filter a1=-1.69065929..., a2=0.73248077...). */
export function kWeightingCoeffs(sr) {
  function highShelf(fc, G_db, Q) {
    const K = Math.tan(Math.PI * fc / sr);
    const Vh = Math.pow(10, G_db / 20);
    const Vb = Math.pow(Vh, 0.499666774155);
    const a0p = 1 + K / Q + K * K;
    return {
      b0: (Vh + Vb * K / Q + K * K) / a0p,
      b1: 2 * (K * K - Vh) / a0p,
      b2: (Vh - Vb * K / Q + K * K) / a0p,
      a1: 2 * (K * K - 1) / a0p,
      a2: (1 - K / Q + K * K) / a0p,
    };
  }
  function highPass(fc, Q) {
    const K = Math.tan(Math.PI * fc / sr);
    const a0p = 1 + K / Q + K * K;
    return {
      b0: 1 / a0p,
      b1: -2 / a0p,
      b2: 1 / a0p,
      a1: 2 * (K * K - 1) / a0p,
      a2: (1 - K / Q + K * K) / a0p,
    };
  }
  return {
    pre: highShelf(PRE_FC, PRE_G_DB, PRE_Q),
    rlb: highPass(RLB_FC, RLB_Q),
  };
}

/* Direct Form I biquad, in-place. State starts at zero so the IIR transient
   lives in the first ~10ms of output; callers should filter from sample 0
   (not from the trim point) so the filter settles before the analysis
   window starts at trim. */
export function applyBiquadInPlace(samples, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    samples[i] = y;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
}

export function findTrimStart(mono, thresh = 0.003) {
  for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > thresh) return i;
  return 0;
}

export function measureDecayLufs(stereo, mono, sr) {
  const trim = findTrimStart(mono);
  const frames = Math.floor(stereo.length / 2);
  if (frames <= trim) return { rms: null, peak: null, failReason: 'sample empty after trim' };

  const winLen = Math.round(sr * 0.4);
  const hop = Math.round(sr * 0.1);
  if (frames - trim < winLen) {
    return { rms: null, peak: null, failReason: 'sample shorter than 400ms after trim (need ≥1 momentary window)' };
  }

  /* De-interleave and K-weight each channel from sample 0 (not from trim) so
     the IIR filter has time to settle before the analysis windows begin. */
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    L[i] = stereo[2 * i];
    R[i] = stereo[2 * i + 1];
  }
  const coeffs = kWeightingCoeffs(sr);
  applyBiquadInPlace(L, coeffs.pre); applyBiquadInPlace(L, coeffs.rlb);
  applyBiquadInPlace(R, coeffs.pre); applyBiquadInPlace(R, coeffs.rlb);

  /* Momentary windows starting at trim. BS.1770 L_M(t) over channels L,R
     with channel-weighting G_L = G_R = 1.0 (stereo, no surround). */
  const windows = [];
  for (let s = trim; s + winLen <= frames; s += hop) {
    let sL = 0, sR = 0;
    for (let k = 0; k < winLen; k++) {
      const l = L[s + k], r = R[s + k];
      sL += l * l; sR += r * r;
    }
    const combined = (sL + sR) / winLen;
    if (combined > 0) {
      const lufs = LUFS_OFFSET + 10 * Math.log10(combined);
      windows.push({ combined, lufs });
    }
  }
  if (windows.length === 0) {
    return { rms: null, peak: null, failReason: 'no audible momentary windows after K-weighting' };
  }

  /* BS.1770 absolute gate at -70 LUFS. */
  const gate1 = windows.filter(w => w.lufs >= -70);
  if (gate1.length === 0) {
    return { rms: null, peak: null, failReason: 'all momentary windows below -70 LUFS absolute gate' };
  }

  /* BS.1770 relative gate at -10 LU below the absolute-gated mean. Fall back
     to gate1 if the relative gate empties the set (extremely short decays
     where most of the windowing horizon tails into near-silence). */
  let g1mean = 0;
  for (const w of gate1) g1mean += w.combined;
  g1mean /= gate1.length;
  const relGate = LUFS_OFFSET + 10 * Math.log10(g1mean) - 10;
  const gate2 = gate1.filter(w => w.lufs >= relGate);
  const gated = gate2.length > 0 ? gate2 : gate1;

  let integrated = 0;
  for (const w of gated) integrated += w.combined;
  integrated /= gated.length;
  const integratedLufs = LUFS_OFFSET + 10 * Math.log10(integrated);

  /* sqrt(integrated/2) yields a linear value scaled to match the existing
     stereoRmsOver convention sqrt(Σ(L²+R²)/2N), so the unchanged gain math
     (gain = TARGET_RMS / rms) operates on a K-weighted-equivalent stereo
     RMS. The absolute LUFS value drifts by a small offset relative to plain
     stereo RMS (~3 dB), but all decay samples drift by the same offset so
     inter-sample loudness consistency is what improves. */
  const rmsEq = Math.sqrt(integrated / 2);

  /* Peak on the UNFILTERED stereo over the post-trim region, capped at 3s.
     Clipping risk is per-frame raw value; the attack peak (well within 3s)
     dominates so the cap is safe. */
  const peakEnd = Math.min(frames, trim + Math.round(sr * 3));
  let peak = 0;
  for (let i = trim; i < peakEnd; i++) {
    const aL = Math.abs(stereo[2 * i]);
    const aR = Math.abs(stereo[2 * i + 1]);
    const a = aL > aR ? aL : aR;
    if (a > peak) peak = a;
  }

  return { rms: rmsEq, peak, lufs: integratedLufs, nWindows: gated.length, region: 'lufs' };
}
