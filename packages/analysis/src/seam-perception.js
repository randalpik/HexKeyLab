/* Seam-perception profile — the measurement layer behind the perceptual
   seam gates in selectSegmentsCore (analyzer-analysis.js).

   Ear-validated on the phil-cello Intonalogy rebuild (2026-08, compare
   harness): the audible loop artifacts are wrap-aligned "bumps/wahs" that
   the crossfade-residual gate (a click detector) cannot see. Two mechanisms:

   1. MODULATION-PHASE CHOP — the wrap splices vibrato mid-cycle: the
      modulation trajectory (FM cents / AM envelope / spectral tilt) jumps
      from phase(b) to phase(a). Severity tracks the phase distance.
      Vibrato detection = RATE AGREEMENT: cents tracks on independent loud
      harmonics peak at the same rate (fingered notes: 5.3–6.1 Hz across
      the whole phil-cello set) — bow jitter and sympathetic beats are
      common-mode or local but APERIODIC and fail the agreement test
      (open C2/G2). Correlation alone cannot make this cut (bow jitter
      correlates across harmonics).

   2. PER-PARTIAL SPLICE DISCONTINUITY — independent per-partial beats put
      each partial at a different point of its own beat cycle at a vs b:
      the wrap teleports the spectral snapshot (open C2, no vibrato at all:
      worst seam stepped a whole partial cluster, +7.4 dB at the top, with
      carrier phases aligned and residual −15 dB). Measured as per-partial
      level step and predicted mid-crossfade phase-cancellation dip,
      coherently (Hann single-bin at per-partial refined frequencies, window
      long enough to resolve the partial spacing).

   Everything here is pure DOM-free math over a mono Float32Array. The
   profile is built ONCE per sample (on the trend-flattened gate signal) and
   memoizes per-position lookups so the window-search / loop-window-ladder
   reruns of selectSegmentsCore stay cheap. */

var ENV_HOP = 0.005;

/* ── small DSP ─────────────────────────────────────────────────────────── */

function hopEnvelope(d, sr, winSec) {
  var w = Math.round(winSec * sr), h = Math.round(ENV_HOP * sr);
  var n = Math.max(0, Math.floor((d.length - w) / h));
  var cum = new Float64Array(d.length + 1);
  for (var i = 0; i < d.length; i++) cum[i + 1] = cum[i] + d[i] * d[i];
  var out = new Float64Array(n);
  for (var j = 0; j < n; j++) { var s = j * h; out[j] = Math.sqrt((cum[s + w] - cum[s]) / w); }
  return out;
}

function movingAvg(v, win) {
  var half = Math.max(1, win >> 1);
  var cum = new Float64Array(v.length + 1);
  for (var i = 0; i < v.length; i++) cum[i + 1] = cum[i] + v[i];
  var out = new Float64Array(v.length);
  for (var j = 0; j < v.length; j++) {
    var lo = Math.max(0, j - half), hi = Math.min(v.length, j + half + 1);
    out[j] = (cum[hi] - cum[lo]) / (hi - lo);
  }
  return out;
}

function detrendRatio(v) {
  var ma = movingAvg(v, Math.round(0.4 / ENV_HOP));
  var out = new Float64Array(v.length);
  for (var i = 0; i < v.length; i++) out[i] = v[i] / Math.max(ma[i], 1e-9);
  return out;
}

function detrendOffset(v) {
  var ma = movingAvg(v, Math.round(0.4 / ENV_HOP));
  var out = new Float64Array(v.length);
  for (var i = 0; i < v.length; i++) out[i] = v[i] - ma[i];
  return out;
}

function onePoleHP(d, sr, fc) {
  var rc = 1 / (2 * Math.PI * fc), dt = 1 / sr, a = rc / (rc + dt);
  var out = new Float64Array(d.length);
  var y = 0, xPrev = 0;
  for (var i = 0; i < d.length; i++) { y = a * (y + d[i] - xPrev); xPrev = d[i]; out[i] = y; }
  return out;
}

function biquadBP2(d, sr, fc, Q) {
  Q = Q || 8;
  var w0 = 2 * Math.PI * fc / sr, cosw = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q);
  var a0 = 1 + alpha;
  var b0 = alpha / a0, b2 = -alpha / a0, a1 = -2 * cosw / a0, a2 = (1 - alpha) / a0;
  var cur = d;
  for (var pass = 0; pass < 2; pass++) {
    var out = new Float64Array(cur.length);
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < cur.length; i++) {
      var y = b0 * cur[i] + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = cur[i]; y2 = y1; y1 = y;
      out[i] = y;
    }
    cur = out;
  }
  return cur;
}

/* Per-cycle +ZC pitch trajectory in cents rel kHarm*f0, on the ENV_HOP grid,
   tracked on the (strongest-)harmonic-isolated signal. */
function pitchTraj(d, sr, f0raw, nHops, kHarm) {
  var f0 = kHarm * f0raw;
  var lp = biquadBP2(d, sr, f0);
  var sum = new Float64Array(nHops), cnt = new Float64Array(nHops);
  var prevT = -1;
  for (var i = 1; i < lp.length; i++) {
    if (lp[i - 1] <= 0 && lp[i] > 0) {
      var t = (i - 1 + (-lp[i - 1]) / (lp[i] - lp[i - 1])) / sr;
      if (prevT >= 0) {
        var cents = 1200 * Math.log2((1 / (t - prevT)) / f0);
        if (Math.abs(cents) <= 250) {
          var b = Math.round(((t + prevT) / 2) / ENV_HOP);
          if (b >= 0 && b < nHops) { sum[b] += cents; cnt[b]++; }
        }
      }
      prevT = t;
    }
  }
  var out = new Float64Array(nHops);
  var lastVal = 0, lastIdx = -1;
  for (var j = 0; j < nHops; j++) {
    if (cnt[j] > 0) {
      var v = sum[j] / cnt[j];
      if (lastIdx < 0) { for (var q = 0; q < j; q++) out[q] = v; }
      else { for (var q2 = lastIdx + 1; q2 < j; q2++) out[q2] = lastVal + (v - lastVal) * (q2 - lastIdx) / (j - lastIdx); }
      out[j] = v; lastVal = v; lastIdx = j;
    }
  }
  for (var r = Math.max(0, lastIdx + 1); r < nHops; r++) out[r] = lastVal;
  return out;
}

/* Harmonics within 15 dB of the strongest (≤3, k 1..5) — FM tracking set. */
function pickFmHarmonics(d, sr, f0, la, lb) {
  var t0 = Math.min(la + 0.1, (la + lb) / 2);
  var i0 = Math.round(t0 * sr), n = Math.min(Math.round(0.5 * sr), d.length - i0);
  if (n < 1024) return [1];
  var mags = [];
  for (var k = 1; k <= 5; k++) {
    var f = k * f0;
    if (f > sr / 2 - 200) break;
    var re = 0, im = 0;
    for (var i = 0; i < n; i++) {
      var ph = 2 * Math.PI * f * i / sr;
      re += d[i0 + i] * Math.cos(ph); im -= d[i0 + i] * Math.sin(ph);
    }
    mags.push({ k: k, mag: re * re + im * im });
  }
  mags.sort(function (a, b) { return b.mag - a.mag; });
  var bar = mags[0].mag / Math.pow(10, 1.5);
  return mags.filter(function (m) { return m.mag >= bar; }).slice(0, 3).map(function (m) { return m.k; });
}

function rateAndAmp(v, i0, i1) {
  i0 = Math.max(0, i0); i1 = Math.min(v.length, i1);
  var n = i1 - i0;
  if (n < Math.round(0.5 / ENV_HOP)) return null;
  var mean = 0;
  for (var i = i0; i < i1; i++) mean += v[i];
  mean /= n;
  var bestF = 0, bestMag = -1;
  for (var f = 2.5; f <= 9.0; f += 0.05) {
    var re = 0, im = 0;
    for (var j = i0; j < i1; j++) {
      var ph = 2 * Math.PI * f * (j - i0) * ENV_HOP, x = v[j] - mean;
      re += x * Math.cos(ph); im -= x * Math.sin(ph);
    }
    var mag = re * re + im * im;
    if (mag > bestMag) { bestMag = mag; bestF = f; }
  }
  return { rate: bestF, amp: 2 * Math.sqrt(bestMag) / n };
}

/* Modulation phase (cycles [0,1)) at time t: single-bin DFT over 2 cycles. */
function phaseAtT(traj, t, rate) {
  var half = Math.round((1 / rate) / ENV_HOP);
  var c = Math.round(t / ENV_HOP);
  if (c - half < 0 || c + half > traj.length) return null;
  var mean = 0;
  for (var i = c - half; i < c + half; i++) mean += traj[i];
  mean /= 2 * half;
  var re = 0, im = 0;
  for (var j = c - half; j < c + half; j++) {
    var ph = 2 * Math.PI * rate * (j - c) * ENV_HOP, v = traj[j] - mean;
    re += v * Math.cos(ph); im -= v * Math.sin(ph);
  }
  return ((Math.atan2(im, re) / (2 * Math.PI)) % 1 + 1) % 1;
}

/* Modulation amplitude (sinusoid-equivalent, trajectory units) at time t —
   same single-bin DFT as phaseAtT, magnitude instead of angle. */
function ampAtT(traj, t, rate) {
  var half = Math.round((1 / rate) / ENV_HOP);
  var c = Math.round(t / ENV_HOP);
  if (c - half < 0 || c + half > traj.length) return null;
  var mean = 0;
  for (var i = c - half; i < c + half; i++) mean += traj[i];
  mean /= 2 * half;
  var re = 0, im = 0;
  for (var j = c - half; j < c + half; j++) {
    var ph = 2 * Math.PI * rate * (j - c) * ENV_HOP, v = traj[j] - mean;
    re += v * Math.cos(ph); im -= v * Math.sin(ph);
  }
  return Math.hypot(re, im) / half;
}

function circDist(p, q) {
  var d = Math.abs(p - q) % 1;
  return Math.min(d, 1 - d);
}

/* IEC A-weighting in dB — perceptual salience tilt for partial admission.
   At a low note's register the strongest partials sit where the ear is
   least sensitive; an unweighted relative threshold hides audible movers
   (phil-cello C2: the ~740 Hz h11 shift is what the ear locks onto even
   20+ dB below the 196 Hz h3). */
function aWeightDb(f) {
  var f2 = f * f;
  var num = 12194 * 12194 * f2 * f2;
  var den = (f2 + 20.6 * 20.6) * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) * (f2 + 12194 * 12194);
  return 20 * Math.log10(num / den) + 2.0;
}

/* Loud partials (k ≤ 12, < 5.5 kHz), admitted by A-WEIGHTED level relative
   to the A-weighted strongest, where each partial's level is its MAX over
   nine 100 ms windows spanning the loop region. Single-window admission was
   anti-correlated with risk: a partial whose level swings (exactly the kind
   that steps at seams) gets sampled at its beat dip and excluded — v3's C2
   dropped h11 that way and shipped an audibly stepping seam as green.
   Frequencies refined ±40 cents at mid-span — string partials sit off
   exact k·f0 and a mistuned reference corrupts the phase comparison. */
function loudPartials(d, sr, f0, la, lb) {
  var n = Math.min(Math.round(0.1 * sr), d.length);
  var singleBin = function (p0, f) {
    var re = 0, im = 0;
    for (var j = 0; j < n; j++) {
      var w = 0.5 - 0.5 * Math.cos(2 * Math.PI * j / n);
      var ph = 2 * Math.PI * f * j / sr, v = d[p0 + j] * w;
      re += v * Math.cos(ph); im -= v * Math.sin(ph);
    }
    return re * re + im * im;
  };
  var mid = Math.max(0, Math.min(d.length - n, Math.round(((la + lb) / 2 - 0.05) * sr)));
  var starts = [];
  for (var s = 0; s < 9; s++) {
    var t = la + (lb - la) * s / 8;
    starts.push(Math.max(0, Math.min(d.length - n, Math.round(t * sr))));
  }
  var out = [], maxW = -Infinity;
  for (var k = 1; k <= 12; k++) {
    var fn = k * f0;
    if (fn > 5500 || fn > sr / 2 - 200) break;
    var bestF = fn, bestMag = -1;
    for (var c = -40; c <= 40; c += 2) {
      var f = fn * Math.pow(2, c / 1200);
      var mag = singleBin(mid, f);
      if (mag > bestMag) { bestMag = mag; bestF = f; }
    }
    var maxPow = bestMag;
    for (var si = 0; si < starts.length; si++) {
      var m2 = singleBin(starts[si], bestF);
      if (m2 > maxPow) maxPow = m2;
    }
    var wDb = 10 * Math.log10(maxPow + 1e-30) + aWeightDb(bestF);
    out.push({ k: k, f: bestF, wDb: wDb, powDb: 10 * Math.log10(maxPow + 1e-30) });
    if (wDb > maxW) maxW = wDb;
  }
  var maxPowDb = Math.max.apply(null, out.map(function (p) { return p.powDb; }));
  return out
    .map(function (p) { return { k: p.k, f: p.f, relDb: p.powDb - maxPowDb, wRelDb: p.wDb - maxW }; })
    .filter(function (p) { return p.wRelDb >= -20; });
}

/* Complex amplitude of partial f starting at sample p. Window =
   max(2 cycles of f, 3 cycles of f0) so the Hann mainlobe resolves the
   partial spacing (a 2-cycle window on a high partial integrates its
   neighbors and the "per-partial" step becomes a band mush). */
function partialPhasor(d, sr, p, f, f0) {
  var n = Math.round(Math.max(2 * sr / f, 3 * sr / f0));
  if (p < 0 || p + n > d.length || n < 8) return null;
  var re = 0, im = 0, wsum = 0;
  for (var i = 0; i < n; i++) {
    var w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    var ph = 2 * Math.PI * f * i / sr, v = d[p + i] * w;
    re += v * Math.cos(ph); im -= v * Math.sin(ph); wsum += w;
  }
  return { re: 2 * re / wsum, im: 2 * im / wsum };
}

/* ── profile ───────────────────────────────────────────────────────────── */

/**
 * Build the per-sample seam-perception profile.
 * @param d   mono Float32Array (trend-flattened gate signal)
 * @param sr  sample rate
 * @param f0  fundamental (Hz)
 * @param la,lb  analysis span in seconds (steady region)
 * @returns profile with memoized per-position lookups, or null when the
 *          span is too short to characterize.
 */
export function buildSeamProfile(d, sr, f0, la, lb, trimStart) {
  if (!(lb - la > 0.3) || !(f0 > 0)) return null;
  var eWin = Math.max(0.010, 4 / f0);
  var envFlat = hopEnvelope(d, sr, eWin);
  if (envFlat.length < 32) return null;
  var nHops = envFlat.length;
  var i0 = Math.round(la / ENV_HOP), i1 = Math.min(nHops, Math.round(lb / ENV_HOP));
  var envDet = detrendRatio(envFlat);
  var envHP = hopEnvelope(onePoleHP(d, sr, 800), sr, eWin);
  var tiltRatio = new Float64Array(envHP.length);
  for (var i = 0; i < envHP.length; i++) tiltRatio[i] = envHP[i] / Math.max(envFlat[i], 1e-9);
  var tiltDet = detrendRatio(tiltRatio);

  /* FM: rate agreement across loud-harmonic tracks. Raw (undetrended)
     tracks are kept for the PITCH-STATE channel below. */
  var harms = pickFmHarmonics(d, sr, f0, la, lb);
  var rawTracks = harms.map(function (k) { return pitchTraj(d, sr, f0, nHops, k); });
  var tracks = rawTracks.map(detrendOffset);
  var peaks = tracks.map(function (t) { return rateAndAmp(t, i0, i1); });
  var fmDet = tracks[0], fmCoherent = false, fmRate = null, fmHarms = 'h' + harms[0];
  var fmRawCommon = rawTracks[0];
  if (tracks.length >= 2) {
    var bi = -1, bj = -1, bestAmp = -1;
    for (var a = 0; a < tracks.length; a++) for (var b = a + 1; b < tracks.length; b++) {
      var pa = peaks[a], pb = peaks[b];
      if (!pa || !pb || Math.abs(pa.rate - pb.rate) > 0.3) continue;
      var amp = Math.min(pa.amp, pb.amp);
      if (amp > bestAmp) { bestAmp = amp; bi = a; bj = b; }
    }
    if (bi >= 0) {
      fmCoherent = true;
      fmDet = new Float64Array(nHops);
      for (var q = 0; q < nHops; q++) fmDet[q] = (tracks[bi][q] + tracks[bj][q]) / 2;
      fmRate = (peaks[bi].rate + peaks[bj].rate) / 2;
      fmHarms = 'h' + harms[bi] + '+h' + harms[bj];
      fmRawCommon = new Float64Array(nHops);
      for (var q2 = 0; q2 < nHops; q2++) fmRawCommon[q2] = (rawTracks[bi][q2] + rawTracks[bj][q2]) / 2;
    }
  } else if (peaks[0]) {
    fmCoherent = true;
    fmRate = peaks[0].rate;
  }

  var stdOver = function (v, mapFn) {
    var mm = 0, m2 = 0, n = Math.max(1, i1 - i0);
    for (var s = i0; s < i1; s++) { var x = mapFn(v[s]); mm += x; m2 += x * x; }
    mm /= n; return Math.sqrt(Math.max(0, m2 / n - mm * mm));
  };
  var fmPeak = fmCoherent ? rateAndAmp(fmDet, i0, i1) : null;
  var fmDepthCents = fmPeak ? fmPeak.amp : 0;
  /* UNSTEADY-VIBRATO detector: sloppy vibrato spreads its FM energy across
     the band instead of concentrating at one rate, so the sinusoid-at-rate
     depth collapses (phil-cello Ds3: 1.9¢ rate-locked vs substantial band
     energy) and every modulation gate silently switches off — the sample
     falls in the crack between coherent-vibrato (gated) and no-vibrato
     (nothing to gate), while wraps chop the irregular cycles unpoliceably.
     Band std vs rate-locked amplitude is the discriminator. */
  /* Band-LIMITED: broadband std conflates tracker noise (low-note ZC
     jitter) with vibrato sloppiness — a first cut demoted clean Ds2/F2/C2
     and missed Ds3. Measure the 3–9 Hz modulation band spectrally (0.5 Hz
     bins) and subtract the dominant line: steady vibrato concentrates in
     one bin, sloppy vibrato spreads across the band, jitter barely enters
     the band at all. */
  var fmUnsteadyCents = 0, fmBandCents = 0;
  {
    var bn = Math.max(1, i1 - i0);
    var bm = 0;
    for (var bi4 = i0; bi4 < i1; bi4++) bm += fmDet[bi4];
    bm /= bn;
    var bandPow = 0, peakPow = 0;
    for (var bf = 3.0; bf <= 9.0; bf += 0.5) {
      var re4 = 0, im4 = 0;
      for (var bj = i0; bj < i1; bj++) {
        var ph4 = 2 * Math.PI * bf * (bj - i0) * ENV_HOP, v4 = fmDet[bj] - bm;
        re4 += v4 * Math.cos(ph4); im4 -= v4 * Math.sin(ph4);
      }
      var amp4 = 2 * Math.sqrt(re4 * re4 + im4 * im4) / bn;   // sinusoid-equivalent
      var pow4 = amp4 * amp4 / 2;
      bandPow += pow4;
      if (pow4 > peakPow) peakPow = pow4;
    }
    fmBandCents = Math.sqrt(2 * bandPow);
    fmUnsteadyCents = Math.sqrt(2 * Math.max(0, bandPow - peakPow));
  }
  var amDepthDb = stdOver(envDet, function (x) { return 20 * Math.log10(Math.max(x, 1e-9)); });
  var tiltDepthDb = stdOver(tiltDet, function (x) { return 20 * Math.log10(Math.max(x, 1e-9)); });
  var vibHz = (fmCoherent && fmRate != null) ? fmRate : (rateAndAmp(envDet, i0, i1) || {}).rate || null;

  /* Active modulation channels (depth floors: FM 3¢ coherent, AM 0.4 dB,
     tilt 0.5 dB — same calibration as the compare harness). */
  /* toDb converts a trajectory-unit modulation amplitude to dB-equivalents:
     ratio-detrended trajectories (am/tilt) via 8.686·amp; FM is already in
     cents (scale 1, handled by the caller's cents mapping). */
  var channels = [];
  if (vibHz != null) {
    if (fmCoherent && fmDepthCents >= 3) channels.push({ name: 'fm', traj: fmDet, isCents: true });
    if (amDepthDb >= 0.4) channels.push({ name: 'am', traj: envDet, isCents: false });
    if (tiltDepthDb >= 0.5) channels.push({ name: 'tilt', traj: tiltDet, isCents: false });
  }

  /* PITCH-STATE track: the raw common pitch track smoothed over ~400 ms
     (2+ vibrato cycles integrate out; constant per-harmonic inharmonicity
     offsets cancel in a-vs-b differences). Replaces the legacy 5-cent
     pitchStep gate in perception mode: that gate compared a 200 ms-smoothed
     curve whose residual vibrato wiggle rejected pairs by the hundreds of
     thousands (Fs4: 226k, costing a segment) without measuring what the
     ear tracks — the SUSTAINED pitch mismatch across the wrap. Also live on
     non-vibrato notes (bow-flattening drift is a real pitch state). */
  var pitchState = movingAvg(fmRawCommon, Math.round(0.4 / ENV_HOP));

  /* ONSET BLIP — the sample-level pre-processing defect (ear-found on
     phil-cello Gs5): a QUICK level excursion in the middle of an otherwise
     smooth onset trajectory, playing on every note-on, unreachable by seam
     selection. NOT onset overshoot — overshoot of any size or length is
     normal attack shape (brass lives on it) and must never gate. Detector:
     two-sided linear extrapolation on the 30 ms envelope — fit the left
     flank (i−150..−45 ms) and right flank (+45..+150 ms) separately and
     take min(|rl|,|rr|) when both residuals share a sign. A blip departs
     from BOTH flank predictions (it returns to the trajectory); a knee or
     slope change sits BETWEEN them and scores 0, so smooth swells, sags,
     and sharp-but-monotone transitions all pass. Normalized against the
     onset region's own p90 (local context — pre-vibrato, unlike the steady
     region, whose AM the flanks cannot track). ROI [trim+160 ms,
     steadyStart]; onsets shorter than 20 hops are unjudgeable (no middle
     to blip in) and emit null. */
  var onsetBlipDb = 0, onsetBlipAtSec = 0, onsetBlipRatio = null;
  {
    var envF = hopEnvelope(d, sr, 0.030);
    var envFdB = new Float64Array(envF.length);
    for (var oi = 0; oi < envF.length; oi++) envFdB[oi] = 20 * Math.log10(Math.max(envF[oi], 1e-9));
    var linExtrap = function (i, lo, hi) {
      var s0 = 0, s1 = 0, s2 = 0, t0 = 0, t1 = 0;
      for (var o = lo; o <= hi; o++) {
        var j = i + o;
        if (j < 0 || j >= envFdB.length) return null;
        s0++; s1 += o; s2 += o * o; t0 += envFdB[j]; t1 += o * envFdB[j];
      }
      var det = s0 * s2 - s1 * s1;
      if (Math.abs(det) < 1e-9) return null;
      return (t0 * s2 - t1 * s1) / det;
    };
    var r0 = Math.round(((trimStart || 0) + 0.16) / ENV_HOP);
    var r1 = Math.min(envFdB.length, Math.round(la / ENV_HOP));
    var scores = [];
    for (var bi2 = Math.max(0, r0); bi2 < r1; bi2++) {
      var pl = linExtrap(bi2, -30, -9), pr = linExtrap(bi2, 9, 30);
      var v = 0;
      if (pl != null && pr != null) {
        var rl = envFdB[bi2] - pl, rr = envFdB[bi2] - pr;
        if (rl * rr > 0) v = Math.min(Math.abs(rl), Math.abs(rr));
      }
      scores.push(v);
      if (v > onsetBlipDb) { onsetBlipDb = v; onsetBlipAtSec = bi2 * ENV_HOP; }
    }
    if (scores.length >= 20) {
      var sc = scores.slice().sort(function (x, y) { return x - y; });
      onsetBlipRatio = onsetBlipDb / Math.max(sc[Math.floor(sc.length * 0.9)], 0.2);
    } else {
      onsetBlipDb = 0; onsetBlipAtSec = 0; onsetBlipRatio = null;
    }
  }

  /* SET-RELATIVE sample features (consumed by the CLI pick gates — a
     sample can only be judged an outlier against its neighbors):
     attackTonalLagMs — time from trim to sustained harmonic dominance
     (harmonic-band energy fraction > 0.6 for 50 ms). phil-cello B3 speaks
     in 5 ms where its neighbors swell for 30–85 ms — the "articulated
     attack from a different dynamic band" percept.
     steadyBrightnessDb — HF(>1.5 kHz)/total energy over the steady region.
     B3: −6.0 dB vs −8..−14 for every neighbor. */
  var attackTonalLagMs = null, steadyBrightnessDb = null;
  {
    var totP = hopEnvelope(d, sr, 0.030);
    for (var tp = 0; tp < totP.length; tp++) totP[tp] = totP[tp] * totP[tp];
    var harmP = null;
    for (var hk = 1; hk <= 6; hk++) {
      var hf2 = hk * f0;
      if (hf2 > sr / 2 - 500) break;
      var he = hopEnvelope(biquadBP2(d, sr, hf2), sr, 0.030);
      if (!harmP) { harmP = new Float64Array(he.length); }
      for (var hj = 0; hj < Math.min(harmP.length, he.length); hj++) harmP[hj] += he[hj] * he[hj];
    }
    if (harmP) {
      var tt0 = Math.max(0, Math.round((trimStart || 0) / ENV_HOP));
      var laH = Math.round(la / ENV_HOP);
      for (var ti = tt0; ti < Math.min(harmP.length, laH); ti++) {
        var ok = true;
        for (var tj = 0; tj < 10; tj++) {
          var ix = ti + tj;
          if (ix >= harmP.length || harmP[ix] / Math.max(totP[ix], 1e-18) < 0.6) { ok = false; break; }
        }
        if (ok) { attackTonalLagMs = (ti * ENV_HOP - (trimStart || 0)) * 1000; break; }
      }
      if (attackTonalLagMs == null) attackTonalLagMs = (la - (trimStart || 0)) * 1000;
    }
    var hpEnv = hopEnvelope(onePoleHP(d, sr, 1500), sr, 0.030);
    var bLo = Math.round(la / ENV_HOP), bHi = Math.min(hpEnv.length, totP.length, Math.round(lb / ENV_HOP));
    var hs = 0, ts = 0;
    for (var bi3 = bLo; bi3 < bHi; bi3++) { hs += hpEnv[bi3] * hpEnv[bi3]; ts += totP[bi3]; }
    if (ts > 0) steadyBrightnessDb = 10 * Math.log10((hs + 1e-18) / ts);
  }

  var partials = loudPartials(d, sr, f0, la, lb);

  /* Per-partial SLOW envelopes (dB, ~300 ms smoothing — integrates out
     vibrato-rate AM). Feeds the SLOW-STATE STEP metric: the mismatch of
     each partial's smoothed level between the two splice points. Catches
     slow spectral settling — a wrap from a settled b back into an onset
     tail a resets the spectral evolution every pass (phil-cello C2 takes
     >1 s to settle; a=0.92 s caught the tail — level-flat overall, so RMS
     steadiness and trend flattening missed it). Deliberately NOT the
     interior drift RANGE: range grows with segment length and punishes
     long segments whose slow evolution is gentle and musical; the audible
     defect is the endpoint-state mismatch the wrap replays. */
  var partSlowEnvs = partials.map(function (p) {
    var env = hopEnvelope(biquadBP2(d, sr, p.f), sr, Math.max(0.010, 4 / p.f));
    var db = new Float64Array(env.length);
    for (var i = 0; i < env.length; i++) db[i] = 20 * Math.log10(Math.max(env[i], 1e-9));
    return movingAvg(db, Math.round(0.3 / ENV_HOP));
  });

  /* Memoized per-position lookups (positions repeat across the crossfade
     window search and loop-window ladder reruns). */
  var phaseCache = {};   /* key: chIdx|hopIdx  -> phase or null */
  var phasorCache = {};  /* key: partIdx|samplePos -> {re,im} or null */

  return {
    onsetBlipDb: onsetBlipDb, onsetBlipAtSec: onsetBlipAtSec, onsetBlipRatio: onsetBlipRatio,
    attackTonalLagMs: attackTonalLagMs, steadyBrightnessDb: steadyBrightnessDb,
    fmUnsteadyCents: fmUnsteadyCents, fmBandCents: fmBandCents,
    vibHz: vibHz, fmCoherent: fmCoherent, fmDepthCents: fmDepthCents,
    fmHarms: fmHarms, amDepthDb: amDepthDb, tiltDepthDb: tiltDepthDb,
    nModChannels: channels.length,
    nPartials: partials.length,
    partials: partials,

    /** Worst modulation-phase distance (cycles) across active channels for a
     *  wrap from bSec back to aSec. null when unmeasurable. */
    modPhaseDist: function (aSec, bSec) {
      if (!channels.length || vibHz == null) return null;
      var worst = null;
      for (var c = 0; c < channels.length; c++) {
        var ka = c + '|' + Math.round(aSec / ENV_HOP), kb = c + '|' + Math.round(bSec / ENV_HOP);
        var pa = (ka in phaseCache) ? phaseCache[ka] : (phaseCache[ka] = phaseAtT(channels[c].traj, aSec, vibHz));
        var pb = (kb in phaseCache) ? phaseCache[kb] : (phaseCache[kb] = phaseAtT(channels[c].traj, bSec, vibHz));
        if (pa == null || pb == null) continue;
        var dd = circDist(pa, pb);
        if (worst == null || dd > worst) worst = dd;
      }
      return worst;
    },

    /** Per-partial splice discontinuity for a wrap b→a with the b side
     *  shifted by lagSamples (lag refinement): worst |level step| and worst
     *  mid-fade dip in dB. Lag enters as an analytic phasor rotation. */
    partialSplice: function (aSec, bSec, lagSamples) {
      if (!partials.length) return null;
      var pa = Math.round(aSec * sr), pb = Math.round(bSec * sr);
      var worstStep = 0, worstDip = 0;
      for (var pi = 0; pi < partials.length; pi++) {
        var pr = partials[pi];
        var kA = pi + '|' + pa, kB = pi + '|' + pb;
        var za = (kA in phasorCache) ? phasorCache[kA] : (phasorCache[kA] = partialPhasor(d, sr, pa, pr.f, f0));
        var zb = (kB in phasorCache) ? phasorCache[kB] : (phasorCache[kB] = partialPhasor(d, sr, pb, pr.f, f0));
        if (!za || !zb) continue;
        var rot = 2 * Math.PI * pr.f * (lagSamples || 0) / sr;
        var zbRe = zb.re * Math.cos(rot) - zb.im * Math.sin(rot);
        var zbIm = zb.re * Math.sin(rot) + zb.im * Math.cos(rot);
        var Aa = Math.hypot(za.re, za.im), Ab = Math.hypot(zbRe, zbIm);
        var step = Math.abs(20 * Math.log10((Aa + 1e-12) / (Ab + 1e-12)));
        var mid = Math.hypot(za.re + zbRe, za.im + zbIm) / 2;
        var dip = 20 * Math.log10((mid + 1e-12) / (Math.max(Aa, Ab) + 1e-12));
        if (step > worstStep) worstStep = step;
        if (dip < worstDip) worstDip = dip;
      }
      return { stepDb: worstStep, dipDb: worstDip };
    },

    /** Worst modulation-DEPTH mismatch across the wrap — the pre-vibrato
     *  seam class (phil-cello G5: AM depth 0.186 at b vs 0.023 at a, an 8×
     *  vibrato collapse every wrap; Δφ is blind there — a flat trajectory
     *  has no phase). Returns { db, cents }: worst AM/tilt depth step in
     *  dB-equivalents and worst FM depth step in cents, among the sample's
     *  active channels. null when unmeasurable. */
    modDepthStep: function (aSec, bSec) {
      if (!channels.length || vibHz == null) return null;
      var db = 0, cents = 0, ratio = 1, any = false;
      for (var c = 0; c < channels.length; c++) {
        var da = ampAtT(channels[c].traj, aSec, vibHz), db2 = ampAtT(channels[c].traj, bSec, vibHz);
        if (da == null || db2 == null) continue;
        any = true;
        var step = Math.abs(da - db2);
        if (channels[c].isCents) { if (step > cents) cents = step; }
        else { var st = 8.686 * step; if (st > db) db = st; }
        /* PRESENCE ratio: vibrato 8× smaller = vibrato OFF, a qualitative
           collapse the dB step understates (G5 a=0.66: 1.4 dB step, 8×
           ratio, glaring by ear). Only meaningful when the louder side has
           real vibrato (channel floors: FM 3¢, AM 0.046≈0.4 dB, tilt 0.06). */
        var floor = channels[c].isCents ? 3 : (channels[c].name === 'am' ? 0.046 : 0.06);
        var hi2 = Math.max(da, db2), lo2 = Math.min(da, db2);
        if (hi2 >= floor) {
          var rr = hi2 / Math.max(lo2, 1e-6);
          if (rr > ratio) ratio = rr;
        }
      }
      return any ? { db: db, cents: cents, ratio: ratio } : null;
    },

    /** Sustained-pitch mismatch across the wrap, in cents (vibrato-
     *  integrated). null near buffer edges. */
    pitchStateStepCents: function (aSec, bSec) {
      var ia = Math.round(aSec / ENV_HOP), ib = Math.round(bSec / ENV_HOP);
      if (ia < 0 || ib < 0 || ia >= pitchState.length || ib >= pitchState.length) return null;
      return Math.abs(pitchState[ia] - pitchState[ib]);
    },

    /** Worst per-partial slow-state step (dB) between the two splice points
     *  — the spectral-settling channel. O(partials) per call. */
    partialSlowStepDb: function (aSec, bSec) {
      if (!partSlowEnvs.length) return null;
      var ia = Math.round(aSec / ENV_HOP), ib = Math.round(bSec / ENV_HOP);
      var worst = 0;
      for (var i = 0; i < partSlowEnvs.length; i++) {
        var e = partSlowEnvs[i];
        if (ia < 0 || ib < 0 || ia >= e.length || ib >= e.length) continue;
        var s = Math.abs(e[ia] - e[ib]);
        if (s > worst) worst = s;
      }
      return worst;
    },
  };
}
