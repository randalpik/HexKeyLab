/* K-weighted loudness measurement per ITU-R BS.1770-4.

   Two entry points:
     measureLufs(stereo, mono, sr, {startSample, endSample})
       Region-aware. Runs the full pipeline over the [startSample, endSample)
       frame window. Used by both the decay-path and loop-path gain
       normalizers in generate-samples.js. Caller picks the region:
         - Decay path: (trimStart, length) — full post-trim audio.
         - Loop path: the analyzer's steady region (or a fallback 1s window).
     measureDecayLufs(stereo, mono, sr)
       Back-compat wrapper. Trims silence, then calls measureLufs over
       (trimStart, length). Used by backfill-gains.js and any caller that
       wants the original decay-path semantics.

   Why K-weighting:
     The previous 200ms post-trim RMS for decays was dominated by the
     hammer/attack transient. Two adjacent samples with matched attack RMS
     can have very different sustained loudness if their sources have
     inconsistent attack-vs-sustain ratios — a problem we hit on the Maestro
     grand piano (Eb5 ~8 dB louder than E5 in absolute level; matched attack
     normalization left the sustains drifting by 2–6 dB, audibly louder on
     E5 over the full ring-down). The loop path's prior stereo RMS over the
     steady region had the same family of failure: timbrally-different
     samples (e.g. viola across its range) measure identical RMS but sound
     very different in perceived loudness. K-weighting frequency-weights
     the energy to match the ear's response and tracks perceived loudness
     across inconsistent recordings far better than plain RMS.

   Pipeline:
     1. Pre-filter (high-shelf @1681 Hz, +4 dB, Q=0.707) on each channel —
        approximates the head-related boost in the ear's response.
     2. RLB filter (high-pass @38 Hz, Q=0.5) on each channel — removes sub-
        audible low-frequency energy that doesn't contribute to loudness.
        Filters run from sample 0 through the FULL buffer length so the IIR
        transient settles before the analysis region begins (the region's
        startSample may be arbitrary; we never restart the filter mid-buffer).
     3. Momentary loudness curve: 400ms windows, 100ms hop, starting at
        startSample and ending at endSample-winLen.
        L_M = -0.691 + 10*log10(meansq_L + meansq_R).
     4. Absolute gate: discard windows below -70 LUFS.
     5. Relative gate: discard windows below (gate1_mean - 10 LU).
     6. Integrated loudness = mean of gated windows in the energy domain.

   Return shape (both functions):
     rms  — stereo-RMS-equivalent (sqrt(integrated_combined/2)), matches the
            existing TARGET_RMS = sqrt(Σ(L²+R²)/2N) convention.
     peak — unfiltered stereo peak over a peak-measurement region. For
            measureLufs this is the same (startSample, endSample) window;
            for measureDecayLufs it's the legacy (trimStart, trimStart+3s)
            window (clip risk is dominated by the attack transient).
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

/* Core K-weighting measurement over an arbitrary frame region. Both the loop
   and decay paths call this; the caller's job is to pick the right region
   (steady region for loops; post-trim for decays). */
export function measureLufs(stereo, mono, sr, opts) {
  opts = opts || {};
  const frames = Math.floor(stereo.length / 2);
  const startSample = Math.max(0, Math.min(frames, opts.startSample | 0));
  const endSample = Math.max(startSample, Math.min(frames, opts.endSample == null ? frames : opts.endSample | 0));
  /* Peak window — if the caller wants peak measured over a different region
     than the LUFS region (decay-path uses (trim, trim+3s) for clip-protection
     headroom), they can pass {peakStartSample, peakEndSample} explicitly.
     Default: same as the LUFS region. */
  const peakStart = Math.max(0, Math.min(frames, opts.peakStartSample == null ? startSample : opts.peakStartSample | 0));
  const peakEnd = Math.max(peakStart, Math.min(frames, opts.peakEndSample == null ? endSample : opts.peakEndSample | 0));

  const winLen = Math.round(sr * 0.4);
  const hop = Math.round(sr * 0.1);
  if (endSample - startSample < winLen) {
    return { rms: null, peak: null, failReason: 'region shorter than 400ms (need ≥1 momentary window)' };
  }

  /* De-interleave and K-weight each channel from sample 0 through the full
     buffer so the IIR filter settles before whatever startSample the caller
     picked. Filtering only [startSample, endSample) would leave the first
     ~10ms of the analysis region carrying the filter transient. */
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    L[i] = stereo[2 * i];
    R[i] = stereo[2 * i + 1];
  }
  const coeffs = kWeightingCoeffs(sr);
  applyBiquadInPlace(L, coeffs.pre); applyBiquadInPlace(L, coeffs.rlb);
  applyBiquadInPlace(R, coeffs.pre); applyBiquadInPlace(R, coeffs.rlb);

  /* Momentary windows within [startSample, endSample). BS.1770 L_M(t) over
     channels L,R with channel-weighting G_L = G_R = 1.0 (stereo, no surround). */
  const windows = [];
  for (let s = startSample; s + winLen <= endSample; s += hop) {
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
     stereo RMS (~3 dB), but all samples drift by the same offset so
     inter-sample loudness consistency is what improves. */
  const rmsEq = Math.sqrt(integrated / 2);

  /* Peak on the UNFILTERED stereo over the peak window. */
  let peak = 0;
  for (let i = peakStart; i < peakEnd; i++) {
    const aL = Math.abs(stereo[2 * i]);
    const aR = Math.abs(stereo[2 * i + 1]);
    const a = aL > aR ? aL : aR;
    if (a > peak) peak = a;
  }

  return { rms: rmsEq, peak, lufs: integratedLufs, nWindows: gated.length, region: 'lufs' };
}

/* Back-compat wrapper: trim silence, then measure LUFS over the post-trim
   region. Peak window is capped at 3s past trimStart (the attack transient
   dominates clip risk). Called by analyzer/backfill-gains.js and any other
   legacy caller that expects "decay-style" semantics. */
export function measureDecayLufs(stereo, mono, sr) {
  const trim = findTrimStart(mono);
  const frames = Math.floor(stereo.length / 2);
  if (frames <= trim) return { rms: null, peak: null, failReason: 'sample empty after trim' };
  return measureLufs(stereo, mono, sr, {
    startSample: trim,
    endSample: frames,
    peakStartSample: trim,
    peakEndSample: Math.min(frames, trim + Math.round(sr * 3)),
  });
}
