/* loudness.js — Zwicker-lite relative loudness of a sustained region.
 *
 *   sustainSones(mono, sr, startSample, endSample, gain) -> {sones, occupiedBands} | null
 *
 * Purpose: per-note loudness-evenness correction across a sample set. RMS and
 * K-weighted (BS.1770) normalization equalize LEVEL, but perceived loudness of
 * sustained tonal material tracks CRITICAL-BAND OCCUPANCY: total loudness is
 * the sum of compressive per-band specific loudness (~E^0.23), so matched
 * power spread across 18 Bark bands (trombone C2: dense low-f0 partials) is
 * substantially louder than the same power in 5 bands (trombone Bb5) — the
 * 2026-08-18 finding that ear-validated on FluidR3 trombone (low zone
 * sustains 1.33–1.51x the set median at matched −18 dB K-weighted RMS).
 *
 * Model: Welch PSD (8192-sample Hann, hop 4096) over the span, Terhardt
 * outer-ear threshold-shape weighting (−a0(f)), Zwicker Bark-band summation
 * of E^0.23. UNCALIBRATED in absolute level — sones here are meaningful only
 * RELATIVELY across notes measured at their playback gains; consumers should
 * compare against the set median, never interpret absolute values. Loudness
 * exponents are mid-level approximations: full-strength correction from these
 * numbers may overshoot at real listening levels, so corrections should be
 * blended (see generate-samples.js `loudnessEvenness`) and ear-trimmed.
 *
 * Zero deps, DOM-free (package contract). Returns null when the span is
 * shorter than one analysis window — callers must skip, not default.
 */

var FFT_N = 8192, FFT_HOP = 4096;
var BARK_EDGES = [0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480,
  1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500];
var LOUDNESS_EXP = 0.23;
/* Occupied-band threshold: bands within 25 dB of the loudest band. Diagnostic
   only — not part of the sones sum. */
var OCCUPIED_REL = Math.pow(10, -2.5);

function fftInPlace(re, im) {
  var n = re.length;
  for (var i = 1, j = 0; i < n; i++) {
    var bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      var tr = re[i]; re[i] = re[j]; re[j] = tr;
      var ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (var len = 2; len <= n; len <<= 1) {
    var ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (var s = 0; s < n; s += len) {
      var cr = 1, ci = 0;
      for (var k = 0; k < len / 2; k++) {
        var ur = re[s + k], ui = im[s + k];
        var vr = re[s + k + len / 2] * cr - im[s + k + len / 2] * ci;
        var vi = re[s + k + len / 2] * ci + im[s + k + len / 2] * cr;
        re[s + k] = ur + vr; im[s + k] = ui + vi;
        re[s + k + len / 2] = ur - vr; im[s + k + len / 2] = ui - vi;
        var ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/* Terhardt threshold-shape a0(f) in dB; used inverted as a relative
   outer/middle-ear transfer. Clamped below 50 Hz where the formula blows up. */
function terhardtA0Db(fHz) {
  var f = Math.max(fHz, 50) / 1000;
  return 3.64 * Math.pow(f, -0.8)
       - 6.5 * Math.exp(-0.6 * (f - 3.3) * (f - 3.3))
       + 1e-3 * Math.pow(f, 4);
}

export function sustainSones(mono, sr, startSample, endSample, gain) {
  var g = (typeof gain === 'number' && gain > 0) ? gain : 1;
  var i0 = Math.max(0, startSample | 0);
  var i1 = Math.min(mono.length, endSample | 0);
  if (i1 - i0 < FFT_N) return null;
  var hann = new Float64Array(FFT_N);
  for (var h = 0; h < FFT_N; h++) hann[h] = 0.5 - 0.5 * Math.cos(2 * Math.PI * h / FFT_N);
  var psd = new Float64Array(FFT_N / 2);
  var wins = 0;
  var re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
  for (var st = i0; st + FFT_N <= i1; st += FFT_HOP, wins++) {
    for (var i = 0; i < FFT_N; i++) { re[i] = mono[st + i] * g * hann[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (var k = 1; k < FFT_N / 2; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
  }
  var bandE = new Float64Array(BARK_EDGES.length - 1);
  for (var kb = 1; kb < FFT_N / 2; kb++) {
    var f = kb * sr / FFT_N;
    if (f >= BARK_EDGES[BARK_EDGES.length - 1]) break;
    var w = Math.pow(10, -terhardtA0Db(f) / 10);
    var b = 0;
    while (BARK_EDGES[b + 1] <= f) b++;
    bandE[b] += (psd[kb] / wins) * w;
  }
  var maxE = 0;
  for (var m = 0; m < bandE.length; m++) if (bandE[m] > maxE) maxE = bandE[m];
  if (maxE <= 0) return null;
  var sones = 0, occupied = 0;
  for (var bi = 0; bi < bandE.length; bi++) {
    if (bandE[bi] <= 0) continue;
    sones += Math.pow(bandE[bi], LOUDNESS_EXP);
    if (bandE[bi] > maxE * OCCUPIED_REL) occupied++;
  }
  return { sones: sones, occupiedBands: occupied };
}
