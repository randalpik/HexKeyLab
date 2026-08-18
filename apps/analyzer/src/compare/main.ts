// Instrument Compare — offline A/B harness for .hki builds.
//
// Purpose: put two .hki bundles side by side, play matching samples through
// the PRODUCTION engine path (trend bake, segment looper, per-sample
// crossfadeSec — exactly what an external consumer like Intonalogy hears),
// and cross-reference with as-played seam metrics + waveform/seam visuals
// computed independently in-page. Loads builds listed in out/compare/index.json
// (regenerate via the staging step that copies builds there); query params
// ?a=<url>&b=<url> override the initial pair.
//
// This page deliberately does NOT reuse the analyzer pipeline: metrics here
// are measured on the decoded shipped audio with the manifest's trend applied
// the same way the engine bakes it, so the numbers describe what plays, not
// what the pipeline predicted.

import { readHkiInstrument } from '@hkl/engine/hki-instrument.js';
import { startSegmentLooper, type SegmentLooper } from '@hkl/engine/segmentLooper.js';
import type { InstrumentDef, SampleDef } from '@hkl/engine/samples-engine.js';
import {
  init as engineInit,
  loadInstrument,
  sNoteOn,
  sNoteOff,
  isInstrumentLoaded,
  unloadInstrument,
} from '@hkl/engine/samples-engine.js';

const VELOCITY = 100;           // fixed for both sides — no loudness bias from velocity
const DEFAULT_XFADE = 0.030;    // engine default when a sample omits crossfadeSec
const RES_GOOD = -14, RES_OK = -10;

interface SideData {
  label: string;
  url: string;
  def: InstrumentDef;
  audio: Record<string, Uint8Array>;
  engineKey: string;            // 'cmpA' | 'cmpB' — decoupled from bundle instrumentKey
  metrics: Map<string, SampleMetrics>;
}
interface SegMetric {
  a: number; b: number; resDb: number;
  /** Vibrato-modulation phase jump at the wrap, in cycles [0, 0.5]:
   *  0 = the wrap lands in-phase with where it left; 0.5 = anti-phase.
   *  FM = pitch (cents — the dominant channel for string vibrato: the
   *  finger-roll is pitch modulation first), AM = amplitude envelope,
   *  Tilt = brightness (high-band ratio). Ear-validated (2026-08): the
   *  audible "bump/wah" is flash-aligned (H1) and severity tracks Δφ.
   *  null = no rate found or seam too close to the buffer edge. */
  dphiFM: number | null;
  dphiAM: number | null;
  dphiTilt: number | null;
  /** Modulation-DEPTH step across the wrap: worst AM/tilt depth mismatch in
   *  dB-equivalents and FM depth mismatch in cents among active channels —
   *  the pre-vibrato seam class Δφ is blind to (G5: 8× AM-depth collapse). */
  dDepthDb: number | null;
  dDepthC: number | null;
  /** Per-partial splice discontinuity — the vibrato-free bump mechanism
   *  (ear-validated on phil-cello open C2, where every seam bumps with no
   *  vibrato present). Independent per-partial beats put each partial at a
   *  different point of its own beat cycle at a vs b, so the wrap teleports
   *  the spectral snapshot: partial k's level STEPS by stepDb instantly
   *  (C2 seg0, the worst by ear: h8/h9/h11 stepping +1.3/+2.3/+4.4 dB as a
   *  cluster) even when carrier phases align and total residual is −15 dB —
   *  energy redistributed BETWEEN partials is invisible to a waveform
   *  difference. dipDb is the phase-mismatch sibling: a partial near
   *  anti-phase nulls mid-crossfade. Both measured coherently (Hann
   *  single-bin, 2 cycles, per-partial refined frequency). */
  partials: Array<{ k: number; relDb: number; aDb: number; bDb: number; dipDb: number }>;
  pStepDb: number;   // worst |aDb - bDb| among loud partials (signed, a rel b)
  pDipDb: number;    // most negative mid-fade dip among loud partials
  /** Worst per-partial SLOW-STATE step (|300ms-smoothed envelope at a −
   *  at b| in dB) — the spectral-settling channel. A wrap from a settled b
   *  back into an onset tail a resets the spectral evolution every pass
   *  (phil-cello C2 settles for >1 s; a=0.92 s caught the tail). Endpoint
   *  mismatch, NOT interior range: range grows with segment length and
   *  wrongly punishes long segments whose slow evolution is musical. */
  pSlowDb: number;
  /** Sustained-pitch mismatch across the wrap in cents (vibrato-integrated
   *  400ms-smoothed common pitch track at a vs b). The honest replacement
   *  for the legacy 5-cent pitchStep gate; tuning-critical channel. */
  pStateC: number | null;
}
interface SampleMetrics {
  freq: number; gain: number; xfade: number;
  susDb: number; postDb: number;
  segs: SegMetric[]; worst: number; median: number;
  trendMin: number; trendMax: number;
  wave: Float32Array<ArrayBuffer>; // trend-flattened mono, for canvases + solo loop
  sr: number; trimStart: number; dur: number;
  /** 10ms-RMS envelopes at ENV_HOP: raw (pre-flatten, exposes interior
   *  events the trend bake hides from level gates — e.g. bow retakes) and
   *  detrended flattened AM / tilt trajectories (~1.0-centered). */
  envRaw: Float32Array;
  envDet: Float32Array;
  tiltDet: Float32Array;
  /** Detrended pitch trajectory in cents (FM channel), same hop grid. */
  fmDet: Float32Array;
  vibHz: number | null;
  fmDepthCents: number;
  /** Which harmonics the FM common-mode track averages (display label). */
  fmHarms: string;
  /** True iff two independent harmonic tracks peak at the same modulation
   *  rate (±0.3 Hz) — the vibrato test. False = the pitch motion is bow
   *  jitter or beats (open strings: phil-cello C2/G2), which is common-mode
   *  but aperiodic; it must not count toward seam severity. */
  fmCoherent: boolean;
  amDepthDb: number;
  tiltDepthDb: number;
  /** Sample-level onset blip: a quick excursion in the middle of the onset
   *  trajectory (two-sided flank-extrapolation detector — knees and
   *  overshoots score 0; overshoot is normal attack shape and never
   *  flags). ratio = blip / onset-local p90; null when the onset is too
   *  short to judge. (phil-cello Gs5: 3.4 dB @0.93s, 2.3x — ear-reported.) */
  onsetBlipDb: number;
  onsetBlipAtSec: number;
  onsetBlipRatio: number | null;
  playBuf?: AudioBuffer;        // lazy, for the solo-seam looper
}

const $ = (id: string) => document.getElementById(id)!;
const status = (m: string) => { $('status').textContent = m; };

let sideA: SideData | null = null;
let sideB: SideData | null = null;
let ctx: AudioContext | null = null;
let playingBtn: HTMLButtonElement | null = null;
let voiceSeq = 0;
let activeVoice: string | null = null;

/* ── decode + metrics ────────────────────────────────────────────────────── */

/** Mirror engine applyTrendNormalization: divide by linearly-interpolated trend. */
function applyTrend(d: Float32Array, sr: number, trend: number[] | undefined,
                    hopMs: number, startSec: number): void {
  if (!trend || trend.length < 2 || !(hopMs > 0)) return;
  const nLast = trend.length - 1;
  const startSample = Math.round(startSec * sr);
  const hopSamples = (hopMs / 1000) * sr;
  for (let i = 0; i < d.length; i++) {
    const f = (i - startSample) / hopSamples;
    if (f <= 0 || f >= nLast) continue;
    const i0 = f | 0;
    const frac = f - i0;
    const t = trend[i0] * (1 - frac) + trend[i0 + 1] * frac;
    if (t > 0) d[i] = d[i] / t;
  }
}

/** Analyzer's xfadeResidualDb, verbatim semantics (mono, dB rel mean endpoint RMS). */
function residualDb(d: Float32Array, sr: number, a: number, b: number, w: number): number {
  const pa = Math.round(a * sr), pb = Math.round(b * sr);
  const ws = Math.round(w * sr);
  const wEff = Math.min(ws, d.length - pa, d.length - pb);
  if (wEff < 32) return -Infinity;
  let res = 0, sa = 0, sb = 0;
  for (let i = 0; i < wEff; i++) {
    const va = d[pa + i], vb = d[pb + i], e = va - vb;
    res += e * e; sa += va * va; sb += vb * vb;
  }
  const rRms = Math.sqrt(res / wEff);
  const sRms = (Math.sqrt(sa / wEff) + Math.sqrt(sb / wEff)) / 2;
  return 20 * Math.log10((rRms + 1e-12) / (sRms + 1e-12));
}

/* ── modulation-trajectory DSP (H1 diagnosis) ────────────────────────────── */

const ENV_HOP = 0.005;

/** RMS envelope sampled every ENV_HOP seconds. `winSec` must span several
 *  carrier periods (pass ≥ 4/f0) or the envelope tracks per-period ripple
 *  instead of vibrato AM — visible as sawtooth on low notes. */
function hopEnvelope(d: Float32Array, sr: number, winSec: number): Float32Array {
  const w = Math.round(winSec * sr), h = Math.round(ENV_HOP * sr);
  const n = Math.max(0, Math.floor((d.length - w) / h));
  const cum = new Float64Array(d.length + 1);
  for (let i = 0; i < d.length; i++) cum[i + 1] = cum[i] + d[i] * d[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const s = i * h; out[i] = Math.sqrt((cum[s + w] - cum[s]) / w); }
  return out;
}

/** Centered moving average (edge-clamped). */
function movingAvg(v: Float32Array, win: number): Float32Array {
  const half = Math.max(1, win >> 1);
  const cum = new Float64Array(v.length + 1);
  for (let i = 0; i < v.length; i++) cum[i + 1] = cum[i] + v[i];
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(v.length, i + half + 1);
    out[i] = (cum[hi] - cum[lo]) / (hi - lo);
  }
  return out;
}

/** v / movingAvg(v, ~400ms) — isolates vibrato-rate modulation around 1.0. */
function detrendRatio(v: Float32Array): Float32Array {
  const ma = movingAvg(v, Math.round(0.4 / ENV_HOP));
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / Math.max(ma[i], 1e-9);
  return out;
}

/** One-pole high-pass (brightness-band extraction for the tilt trajectory). */
function onePoleHP(d: Float32Array, sr: number, fc: number): Float32Array {
  const rc = 1 / (2 * Math.PI * fc), dt = 1 / sr, a = rc / (rc + dt);
  const out = new Float32Array(d.length);
  let y = 0, xPrev = 0;
  for (let i = 0; i < d.length; i++) { y = a * (y + d[i] - xPrev); xPrev = d[i]; out[i] = y; }
  return out;
}

/** Dominant modulation rate in 2.5–9 Hz plus the sinusoid-equivalent
 *  amplitude at that rate (2|z|/N). Amplitude-at-rate is the honest depth
 *  number: track std inflates with broadband tracker noise (phil-cello Ds2
 *  read ±17¢ by std where the actual vibrato component is ±4¢). */
function rateAndAmp(v: Float32Array, i0: number, i1: number): { rate: number; amp: number } | null {
  i0 = Math.max(0, i0); i1 = Math.min(v.length, i1);
  const n = i1 - i0;
  if (n < Math.round(0.5 / ENV_HOP)) return null;
  let mean = 0;
  for (let i = i0; i < i1; i++) mean += v[i];
  mean /= n;
  let bestF = 0, bestMag = -1;
  for (let f = 2.5; f <= 9.0; f += 0.05) {
    let re = 0, im = 0;
    for (let i = i0; i < i1; i++) {
      const ph = 2 * Math.PI * f * (i - i0) * ENV_HOP, x = v[i] - mean;
      re += x * Math.cos(ph); im -= x * Math.sin(ph);
    }
    const mag = re * re + im * im;
    if (mag > bestMag) { bestMag = mag; bestF = f; }
  }
  return { rate: bestF, amp: 2 * Math.sqrt(bestMag) / n };
}

/** Dominant modulation rate in 3–9 Hz over env[i0..i1] (detrended, ~1-centered). */
function dominantRate(env: Float32Array, i0: number, i1: number): number | null {
  i0 = Math.max(0, i0); i1 = Math.min(env.length, i1);
  const n = i1 - i0;
  if (n < Math.round(0.5 / ENV_HOP)) return null;
  let mean = 0;
  for (let i = i0; i < i1; i++) mean += env[i];
  mean /= n;
  let bestF = 0, bestMag = -1;
  for (let f = 3.0; f <= 9.0; f += 0.05) {
    let re = 0, im = 0;
    for (let i = i0; i < i1; i++) {
      const ph = 2 * Math.PI * f * (i - i0) * ENV_HOP, v = env[i] - mean;
      re += v * Math.cos(ph); im -= v * Math.sin(ph);
    }
    const mag = re * re + im * im;
    if (mag > bestMag) { bestMag = mag; bestF = f; }
  }
  return bestF;
}

/** Modulation phase (in cycles [0,1)) at time t: single-bin DFT over a
 *  2-cycle window centered on t. null when the window leaves the buffer. */
function phaseAtT(env: Float32Array, t: number, rate: number): number | null {
  const half = Math.round((1 / rate) / ENV_HOP);
  const c = Math.round(t / ENV_HOP);
  if (c - half < 0 || c + half > env.length) return null;
  let mean = 0;
  for (let i = c - half; i < c + half; i++) mean += env[i];
  mean /= 2 * half;
  let re = 0, im = 0;
  for (let i = c - half; i < c + half; i++) {
    const ph = 2 * Math.PI * rate * (i - c) * ENV_HOP, v = env[i] - mean;
    re += v * Math.cos(ph); im -= v * Math.sin(ph);
  }
  return ((Math.atan2(im, re) / (2 * Math.PI)) % 1 + 1) % 1;
}

function circDist(p: number, q: number): number {
  const d = Math.abs(p - q) % 1;
  return Math.min(d, 1 - d);
}

/** RBJ biquad band-pass (constant peak gain), cascaded twice by callers to
 *  isolate ONE harmonic so zero-crossing spacing reads cycle periods. */
function biquadBP(d: Float32Array, sr: number, fc: number, Q = 8): Float32Array {
  const w0 = 2 * Math.PI * fc / sr, cosw = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0;
  const a1 = -2 * cosw / a0, a2 = (1 - alpha) / a0;
  const out = new Float32Array(d.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < d.length; i++) {
    const y = b0 * d[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = d[i]; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

/** Up to 3 harmonics k ∈ 1..5 within 15 dB of the strongest, strongest
 *  first (single-bin DFT magnitudes over a mid-sustain window). Low string
 *  fundamentals can sit 20+ dB under h2 (phil-cello Ds2: h1 −23 dB; C2: h1
 *  −42 dB) — a fundamental-locked pitch tracker rejects every cycle there
 *  as octave junk. Cents deviation is identical on every harmonic, so track
 *  the loud ones; weak harmonics produce junk tracks that poison the
 *  coherence test (Gs3's −28 dB h2), hence the 15 dB admission bar. */
function pickHarmonics(d: Float32Array, sr: number, f0: number, la: number, lb: number): number[] {
  const t0 = Math.min(la + 0.1, (la + lb) / 2);
  const i0 = Math.round(t0 * sr), n = Math.min(Math.round(0.5 * sr), d.length - i0);
  if (n < 1024) return [1];
  const mags: Array<{ k: number; mag: number }> = [];
  for (let k = 1; k <= 5; k++) {
    const f = k * f0;
    if (f > sr / 2 - 200) break;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const ph = 2 * Math.PI * f * i / sr;
      re += d[i0 + i] * Math.cos(ph); im -= d[i0 + i] * Math.sin(ph);
    }
    mags.push({ k, mag: re * re + im * im });
  }
  mags.sort((a, b) => b.mag - a.mag);
  const bar = mags[0].mag / Math.pow(10, 15 / 10);   // −15 dB in power
  return mags.filter(m => m.mag >= bar).slice(0, 3).map(m => m.k);
}

/** Instantaneous pitch trajectory (FM channel) in cents relative to f0, on
 *  the ENV_HOP grid. Per-cycle +ZC spacing on the strongest-harmonic-locked
 *  signal (sub-sample interpolated), cents referenced to kHarm·f0; cycles
 *  landing in the same hop bucket average; empty buckets take the nearest
 *  filled value. Cycles more than ±250 cents off are junk (onset noise,
 *  octave errors) and are dropped. */
function pitchTraj(d: Float32Array, sr: number, f0raw: number, nHops: number, kHarm: number): Float32Array {
  const f0 = kHarm * f0raw;
  const lp = biquadBP(biquadBP(d, sr, f0), sr, f0);
  const sum = new Float64Array(nHops), cnt = new Float64Array(nHops);
  let prevT = -1;
  for (let i = 1; i < lp.length; i++) {
    if (lp[i - 1] <= 0 && lp[i] > 0) {
      const t = (i - 1 + (-lp[i - 1]) / (lp[i] - lp[i - 1])) / sr;
      if (prevT >= 0) {
        const cents = 1200 * Math.log2((1 / (t - prevT)) / f0);
        if (Math.abs(cents) <= 250) {
          const bucket = Math.round(((t + prevT) / 2) / ENV_HOP);
          if (bucket >= 0 && bucket < nHops) { sum[bucket] += cents; cnt[bucket]++; }
        }
      }
      prevT = t;
    }
  }
  const out = new Float32Array(nHops);
  let lastVal = 0, lastIdx = -1;
  for (let i = 0; i < nHops; i++) {
    if (cnt[i] > 0) {
      const v = sum[i] / cnt[i];
      if (lastIdx < 0) { for (let j = 0; j < i; j++) out[j] = v; }
      else { for (let j = lastIdx + 1; j < i; j++) out[j] = lastVal + (v - lastVal) * (j - lastIdx) / (i - lastIdx); }
      out[i] = v; lastVal = v; lastIdx = i;
    }
  }
  for (let i = Math.max(0, lastIdx + 1); i < nHops; i++) out[i] = lastVal;
  return out;
}

/** Complex amplitude of partial `f` starting at sample p (Hann-windowed
 *  single-bin DFT). Window = max(2 cycles of f, 3 cycles of f0Sep): the Hann
 *  mainlobe must resolve the inter-partial spacing or the measurement
 *  integrates neighbors (a 2-cycle window on h11 is ~3 ms — its mainlobe
 *  swallows h5..h16 and the "per-partial" step becomes a band mush).
 *  null when the window leaves the buffer. */
function partialAt(d: Float32Array, sr: number, p: number, f: number, f0Sep: number): { re: number; im: number } | null {
  const n = Math.round(Math.max(2 * sr / f, 3 * sr / f0Sep));
  if (p < 0 || p + n > d.length || n < 8) return null;
  let re = 0, im = 0, wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    const ph = 2 * Math.PI * f * i / sr, v = d[p + i] * w;
    re += v * Math.cos(ph); im -= v * Math.sin(ph); wsum += w;
  }
  return { re: 2 * re / wsum, im: 2 * im / wsum };
}

/** IEC A-weighting in dB — salience tilt for partial admission (a 740 Hz
 *  mover is audible far below a 196 Hz anchor's level at C2's register). */
function aWeightDb(f: number): number {
  const f2 = f * f;
  const num = 12194 ** 2 * f2 * f2;
  const den = (f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2);
  return 20 * Math.log10(num / den) + 2.0;
}

/** Loud partials, admitted by A-WEIGHTED level rel the A-weighted strongest,
 *  each partial's level being its MAX over nine 100ms windows across the
 *  loop span. Single-window admission sampled beating partials at their dip
 *  and hid audible movers (v3 C2 dropped h11; its stepping seam shipped
 *  green). Frequencies refined ±40 cents at mid-span. */
function loudPartials(d: Float32Array, sr: number, f0: number, la: number, lb: number):
    Array<{ k: number; f: number; relDb: number }> {
  const n = Math.min(Math.round(0.1 * sr), d.length);
  const singleBin = (p0: number, f: number): number => {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
      const ph = 2 * Math.PI * f * i / sr, v = d[p0 + i] * w;
      re += v * Math.cos(ph); im -= v * Math.sin(ph);
    }
    return re * re + im * im;
  };
  const mid = Math.max(0, Math.min(d.length - n, Math.round(((la + lb) / 2 - 0.05) * sr)));
  const starts: number[] = [];
  for (let s = 0; s < 9; s++) {
    starts.push(Math.max(0, Math.min(d.length - n, Math.round((la + (lb - la) * s / 8) * sr))));
  }
  const rows: Array<{ k: number; f: number; powDb: number; wDb: number }> = [];
  for (let k = 1; k <= 12; k++) {
    const fn = k * f0;
    if (fn > 5500 || fn > sr / 2 - 200) break;
    let bestF = fn, bestMag = -1;
    for (let c = -40; c <= 40; c += 2) {
      const f = fn * Math.pow(2, c / 1200);
      const mag = singleBin(mid, f);
      if (mag > bestMag) { bestMag = mag; bestF = f; }
    }
    let maxPow = bestMag;
    for (const s of starts) maxPow = Math.max(maxPow, singleBin(s, bestF));
    const powDb = 10 * Math.log10(maxPow + 1e-30);
    rows.push({ k, f: bestF, powDb, wDb: powDb + aWeightDb(bestF) });
  }
  const maxPowDb = Math.max(...rows.map(r => r.powDb));
  const maxW = Math.max(...rows.map(r => r.wDb));
  return rows
    .filter(r => r.wDb - maxW >= -20)
    .map(r => ({ k: r.k, f: r.f, relDb: r.powDb - maxPowDb }));
}

/** Subtract the ~400ms moving average — vibrato-rate FM around 0 cents. */
function detrendOffset(v: Float32Array): Float32Array {
  const ma = movingAvg(v, Math.round(0.4 / ENV_HOP));
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] - ma[i];
  return out;
}

function rmsRange(d: Float32Array, i0: number, i1: number): number {
  let s = 0; const lo = Math.max(0, i0), hi = Math.min(d.length, i1);
  if (hi <= lo) return 0;
  for (let i = lo; i < hi; i++) s += d[i] * d[i];
  return Math.sqrt(s / (hi - lo));
}
const dB = (v: number) => 20 * Math.log10(v + 1e-12);

async function computeMetrics(def: InstrumentDef, audio: Record<string, Uint8Array>):
    Promise<Map<string, SampleMetrics>> {
  const out = new Map<string, SampleMetrics>();
  // OfflineAudioContext decodes without a user gesture; rate is a decode hint,
  // decodeAudioData resamples to it so positions stay in seconds regardless.
  const oc = new OfflineAudioContext(1, 1, 44100);
  for (const smp of def.samples as SampleDef[]) {
    const bytes = audio[smp.file as string];
    if (!bytes || !smp.segments || !smp.segments.length) continue;
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    let buf: AudioBuffer;
    try { buf = await oc.decodeAudioData(ab); } catch { continue; }
    const sr = buf.sampleRate;
    const d = new Float32Array(buf.getChannelData(0));
    const eWin = Math.max(0.010, 4 / (smp.freq as number));   // ≥4 carrier periods
    const envRaw = hopEnvelope(d, sr, eWin);  // pre-flatten: interior events (H2) visible
    applyTrend(d, sr, smp.trend, smp.trendHopMs ?? 50, smp.trendStartSec ?? 0);
    const xfade = smp.crossfadeSec ?? DEFAULT_XFADE;
    const la = Math.min(...smp.segments.map(s => s.a));
    const lb = Math.max(...smp.segments.map(s => s.b));
    /* Modulation trajectories on the as-played (flattened) signal. */
    const envFlat = hopEnvelope(d, sr, eWin);
    const envDet = detrendRatio(envFlat);
    const envHP = hopEnvelope(onePoleHP(d, sr, 800), sr, eWin);
    const tiltRatio = new Float32Array(envHP.length);
    for (let i = 0; i < envHP.length; i++) tiltRatio[i] = envHP[i] / Math.max(envFlat[i], 1e-9);
    const tiltDet = detrendRatio(tiltRatio);
    const i0 = Math.round(la / ENV_HOP), i1 = Math.min(envDet.length, Math.round(lb / ENV_HOP));
    /* FM vibrato detection = RATE AGREEMENT across independent harmonic
       tracks. Finger vibrato is one periodic source: every harmonic's cents
       track peaks at the same modulation rate (phil-cello Ds2: h1–h4 all
       5.40–5.50 Hz). Bow jitter / beats are common-mode or local but
       APERIODIC: per-track dominant rates scatter (open C2: 2.5–4.7 Hz).
       Waveform correlation alone cannot make this cut — bow jitter is
       genuinely common-mode across harmonics and correlates (C2 h3↔h2 at
       +0.80 fooled the corr gate) — but noise cannot fake two independent
       narrowband peaks at the same frequency. Vibrato confirmed iff two
       loud-harmonic tracks peak within 0.3 Hz; the pair's mean is the
       common vibrato track. */
    const harms = pickHarmonics(d, sr, smp.freq as number, la, lb);
    const rawTracks = harms.map(k => pitchTraj(d, sr, smp.freq as number, envDet.length, k));
    const tracks = rawTracks.map(detrendOffset);
    const peaks = tracks.map(t => rateAndAmp(t, i0, i1));
    let fmDet = tracks[0], fmHarms = `h${harms[0]}`;
    let fmRaw = rawTracks[0];
    let fmRate: number | null = null, fmCoherent = false;
    if (tracks.length >= 2) {
      let bi = -1, bj = -1, bestAmp = -1;
      for (let i = 0; i < tracks.length; i++) for (let j = i + 1; j < tracks.length; j++) {
        const pi = peaks[i], pj = peaks[j];
        if (!pi || !pj || Math.abs(pi.rate - pj.rate) > 0.3) continue;
        const amp = Math.min(pi.amp, pj.amp);
        if (amp > bestAmp) { bestAmp = amp; bi = i; bj = j; }
      }
      if (bi >= 0) {
        fmCoherent = true;
        fmDet = new Float32Array(tracks[bi].length);
        for (let i = 0; i < fmDet.length; i++) fmDet[i] = (tracks[bi][i] + tracks[bj][i]) / 2;
        fmHarms = `h${harms[bi]}+h${harms[bj]}`;
        fmRate = (peaks[bi]!.rate + peaks[bj]!.rate) / 2;
        fmRaw = new Float32Array(rawTracks[bi].length);
        for (let i = 0; i < fmRaw.length; i++) fmRaw[i] = (rawTracks[bi][i] + rawTracks[bj][i]) / 2;
      }
    } else if (peaks[0]) {
      /* Single loud harmonic — no agreement test possible; accept rather
         than silently discard real vibrato. */
      fmCoherent = true;
      fmRate = peaks[0].rate;
    }
    const stdOver = (v: Float32Array, map: (x: number) => number): number => {
      let mm = 0, m2 = 0; const n = Math.max(1, i1 - i0);
      for (let i = i0; i < i1; i++) { const x = map(v[i]); mm += x; m2 += x * x; }
      mm /= n; return Math.sqrt(Math.max(0, m2 / n - mm * mm));
    };
    const fmDepthCents = fmCoherent ? (rateAndAmp(fmDet, i0, i1)?.amp ?? 0) : 0;
    const amDepthDb = stdOver(envDet, x => 20 * Math.log10(Math.max(x, 1e-9)));
    const tiltDepthDb = stdOver(tiltDet, x => 20 * Math.log10(Math.max(x, 1e-9)));
    /* One vibrato source drives all three channels; the agreed FM rate is
       the cleanest reference. AM-scan fallback when FM is not vibrato. */
    const vibHz = fmCoherent && fmRate != null ? fmRate : dominantRate(envDet, i0, i1);
    const dphi = (traj: Float32Array, s: { a: number; b: number }): number | null => {
      if (vibHz == null) return null;
      const pa = phaseAtT(traj, s.a, vibHz), pb = phaseAtT(traj, s.b, vibHz);
      return pa == null || pb == null ? null : circDist(pa, pb);
    };
    const ampAt = (traj: Float32Array, t: number): number | null => {
      if (vibHz == null) return null;
      const half = Math.round((1 / vibHz) / ENV_HOP), c = Math.round(t / ENV_HOP);
      if (c - half < 0 || c + half > traj.length) return null;
      let mean = 0;
      for (let i = c - half; i < c + half; i++) mean += traj[i];
      mean /= 2 * half;
      let re = 0, im = 0;
      for (let j = c - half; j < c + half; j++) {
        const ph = 2 * Math.PI * vibHz * (j - c) * ENV_HOP, v = traj[j] - mean;
        re += v * Math.cos(ph); im -= v * Math.sin(ph);
      }
      return Math.hypot(re, im) / half;
    };
    const depthStep = (s: { a: number; b: number }): { db: number | null; cents: number | null } => {
      let db: number | null = null, cents: number | null = null;
      const chans: Array<[Float32Array, boolean, boolean]> = [
        [fmDet, true, fmCoherent && fmDepthCents >= 3],
        [envDet, false, amDepthDb >= 0.4],
        [tiltDet, false, tiltDepthDb >= 0.5],
      ];
      for (const [traj, isCents, active] of chans) {
        if (!active) continue;
        const da = ampAt(traj, s.a), dbb = ampAt(traj, s.b);
        if (da == null || dbb == null) continue;
        const step = Math.abs(da - dbb);
        if (isCents) cents = Math.max(cents ?? 0, step);
        else db = Math.max(db ?? 0, 8.686 * step);
      }
      return { db, cents };
    };
    const pitchState = movingAvg(fmRaw, Math.round(0.4 / ENV_HOP));
    let onsetBlipDb = 0, onsetBlipAtSec = 0, onsetBlipRatio: number | null = null;
    {
      const eDb = new Float32Array(envFlat.length);
      for (let i = 0; i < envFlat.length; i++) eDb[i] = 20 * Math.log10(Math.max(envFlat[i], 1e-9));
      const linExtrap = (i: number, lo: number, hi: number): number | null => {
        let s0 = 0, s1 = 0, s2 = 0, t0 = 0, t1 = 0;
        for (let o = lo; o <= hi; o++) {
          const j = i + o;
          if (j < 0 || j >= eDb.length) return null;
          s0++; s1 += o; s2 += o * o; t0 += eDb[j]; t1 += o * eDb[j];
        }
        const det = s0 * s2 - s1 * s1;
        return Math.abs(det) < 1e-9 ? null : (t0 * s2 - t1 * s1) / det;
      };
      const r0 = Math.max(0, Math.round((((smp.trimStart as number) ?? 0) + 0.16) / ENV_HOP));
      const r1 = Math.min(eDb.length, Math.round(la / ENV_HOP));
      const scores: number[] = [];
      for (let i = r0; i < r1; i++) {
        const pl = linExtrap(i, -30, -9), pr = linExtrap(i, 9, 30);
        let v = 0;
        if (pl != null && pr != null) {
          const rl = eDb[i] - pl, rr = eDb[i] - pr;
          if (rl * rr > 0) v = Math.min(Math.abs(rl), Math.abs(rr));
        }
        scores.push(v);
        if (v > onsetBlipDb) { onsetBlipDb = v; onsetBlipAtSec = i * ENV_HOP; }
      }
      if (scores.length >= 20) {
        const p90 = scores.slice().sort((x, y) => x - y)[Math.floor(scores.length * 0.9)];
        onsetBlipRatio = onsetBlipDb / Math.max(p90, 0.2);
      } else { onsetBlipDb = 0; onsetBlipAtSec = 0; }
    }
    const parts = loudPartials(d, sr, smp.freq as number, la, lb);
    /* Per-partial slow envelopes (dB, 300ms smoothing) for the interior-
       drift channel. */
    const partEnvs = parts.map(p => {
      const bp = biquadBP(biquadBP(d, sr, p.f), sr, p.f);
      const env = hopEnvelope(bp, sr, Math.max(0.010, 4 / p.f));
      const db = new Float32Array(env.length);
      for (let i = 0; i < env.length; i++) db[i] = 20 * Math.log10(Math.max(env[i], 1e-9));
      return movingAvg(db, Math.round(0.3 / ENV_HOP));
    });
    const segs: SegMetric[] = smp.segments.map(s => {
      const pa = Math.round(s.a * sr), pb = Math.round(s.b * sr);
      const rows: SegMetric['partials'] = [];
      let pStepDb = 0, pDipDb = 0, pSlowDb = 0;
      const isa = Math.round(s.a / ENV_HOP), isb = Math.round(s.b / ENV_HOP);
      const pStateC = (isa >= 0 && isb >= 0 && isa < pitchState.length && isb < pitchState.length)
        ? Math.abs(pitchState[isa] - pitchState[isb]) : null;
      const ia = Math.round(s.a / ENV_HOP), ib = Math.round(s.b / ENV_HOP);
      for (const env of partEnvs) {
        if (ia < 0 || ib < 0 || ia >= env.length || ib >= env.length) continue;
        pSlowDb = Math.max(pSlowDb, Math.abs(env[ia] - env[ib]));
      }
      for (const p of parts) {
        const za = partialAt(d, sr, pa, p.f, smp.freq as number),
              zb = partialAt(d, sr, pb, p.f, smp.freq as number);
        if (!za || !zb) continue;
        const Aa = Math.hypot(za.re, za.im), Ab = Math.hypot(zb.re, zb.im);
        const mid = Math.hypot(za.re + zb.re, za.im + zb.im) / 2;
        const aDb = 20 * Math.log10(Aa + 1e-12), bDb = 20 * Math.log10(Ab + 1e-12);
        const dipDb = 20 * Math.log10((mid + 1e-12) / (Math.max(Aa, Ab) + 1e-12));
        rows.push({ k: p.k, relDb: p.relDb, aDb, bDb, dipDb });
        if (Math.abs(aDb - bDb) > Math.abs(pStepDb)) pStepDb = aDb - bDb;
        if (dipDb < pDipDb) pDipDb = dipDb;
      }
      const dd = depthStep(s);
      return {
        a: s.a, b: s.b, resDb: residualDb(d, sr, s.a, s.b, xfade),
        dphiFM: dphi(fmDet, s), dphiAM: dphi(envDet, s), dphiTilt: dphi(tiltDet, s),
        dDepthDb: dd.db, dDepthC: dd.cents,
        partials: rows, pStepDb, pDipDb, pSlowDb, pStateC,
      };
    });
    const resAll = segs.map(s => s.resDb).sort((x, y) => x - y);
    const sus = rmsRange(d, Math.round(la * sr), Math.round(lb * sr));
    const gain = (smp.gain as number) ?? 1;
    const trend = (smp.trend as number[] | undefined) ?? [1];
    out.set(smp.name as string, {
      freq: smp.freq as number, gain, xfade,
      susDb: dB(sus), postDb: dB(sus * gain),
      segs, worst: Math.max(...resAll), median: resAll[resAll.length >> 1],
      trendMin: Math.min(...trend), trendMax: Math.max(...trend),
      wave: d, sr, trimStart: (smp.trimStart as number) ?? 0, dur: buf.duration,
      envRaw, envDet, tiltDet, fmDet, vibHz, fmDepthCents, fmHarms, fmCoherent, amDepthDb, tiltDepthDb,
      onsetBlipDb, onsetBlipAtSec, onsetBlipRatio,
    });
  }
  return out;
}

/* ── canvases ────────────────────────────────────────────────────────────── */

/* Δφ chip classes — ear-validated ordering (red > yellow > green tracks the
   audible bump). Thresholds still provisional: ≤0.12 cycles green, ≤0.25 yellow. */
function phiClass(p: number | null): string { return p == null ? '' : p <= 0.12 ? 'g' : p <= 0.25 ? 'y' : 'r'; }
function phiColor(p: number | null): string { return p == null ? '#8b93a2' : p <= 0.12 ? '#7fd08a' : p <= 0.25 ? '#d8c56b' : '#e08585'; }

/* A channel only counts toward seam severity when the sample actually has
   depth in it (no point scoring the phase of modulation that isn't there).
   Floors: FM 3 cents, AM 0.4 dB, tilt 0.5 dB. */
const FM_FLOOR = 3, AM_FLOOR = 0.4, TILT_FLOOR = 0.5;
/** dB of per-partial splice discontinuity mapped onto the Δφ severity scale:
 *  /16 puts the ear-calibration points where they belong (C2's audible
 *  2.6–4.4 dB steps → 0.16–0.28 = yellow/red; Gs3's clean ≤1.2 dB → green). */
const PARTIAL_DB_TO_SEV = 1 / 16;
function segSeverity(m: SampleMetrics, s: SegMetric): number | null {
  const parts: number[] = [];
  if (m.fmCoherent && m.fmDepthCents >= FM_FLOOR && s.dphiFM != null) parts.push(s.dphiFM);
  if (m.amDepthDb >= AM_FLOOR && s.dphiAM != null) parts.push(s.dphiAM);
  if (m.tiltDepthDb >= TILT_FLOOR && s.dphiTilt != null) parts.push(s.dphiTilt);
  /* Partial-splice channel needs no modulation depth gate — it is a direct
     measurement at the seam itself. */
  parts.push(Math.min(0.5, Math.max(Math.abs(s.pStepDb), Math.abs(s.pDipDb), s.pSlowDb) * PARTIAL_DB_TO_SEV));
  if (s.pStateC != null) parts.push(Math.min(0.5, s.pStateC / 20));
  if (s.dDepthDb != null) parts.push(Math.min(0.5, s.dDepthDb / 4));
  if (s.dDepthC != null) parts.push(Math.min(0.5, s.dDepthC / 20));
  return parts.length ? Math.max(...parts) : null;
}

function drawWave(cv: HTMLCanvasElement, m: SampleMetrics): void {
  const W = cv.width, H = cv.height;
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  const n = m.wave.length, step = Math.max(1, Math.floor(n / W));
  g.fillStyle = '#3d4450';
  for (let x = 0; x < W; x++) {
    const i0 = x * step, i1 = Math.min(n, i0 + step);
    let mn = 1, mx = -1;
    for (let i = i0; i < i1; i++) { const v = m.wave[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mx < mn) break;
    const yc = H * 0.62;
    const half = Math.max(1, (mx - mn) * 0.5 * H * 0.55 / Math.max(0.3, 1));
    g.fillRect(x, yc - half, 1, half * 2);
  }
  const toX = (t: number) => (t / m.dur) * W;
  g.fillStyle = '#5c8fd8';
  g.fillRect(toX(m.trimStart), 0, 1, H);
  m.segs.forEach((s, i) => {
    const y = 4 + i * 5;
    g.strokeStyle = g.fillStyle = phiColor(segSeverity(m, s));
    g.beginPath(); g.moveTo(toX(s.a), y); g.lineTo(toX(s.b), y); g.stroke();
    g.fillRect(toX(s.a), y - 2, 1, 4);
    g.fillRect(toX(s.b), y - 2, 1, 4);
  });
}

let zoomTarget: { side: SideData; m: SampleMetrics; seg: SegMetric } | null = null;

function drawZoom(side: SideData, m: SampleMetrics, seg: SegMetric, cap: string): void {
  zoomTarget = { side, m, seg };
  const wrap = $('zoomwrap') as HTMLDivElement;
  const cv = $('zoom') as HTMLCanvasElement;
  wrap.style.display = 'block';
  $('zoomcap').textContent =
    `${cap} — seam a=${seg.a.toFixed(3)}s b=${seg.b.toFixed(3)}s · ` +
    `Δφ FM ${seg.dphiFM?.toFixed(2) ?? '—'} / AM ${seg.dphiAM?.toFixed(2) ?? '—'} / tilt ${seg.dphiTilt?.toFixed(2) ?? '—'} cycles ` +
    `(vib ${m.vibHz?.toFixed(1) ?? '—'} Hz · FM ${m.fmCoherent ? `±${m.fmDepthCents.toFixed(0)}¢@${m.fmHarms}` : '✗ no common rate'} · AM ±${m.amDepthDb.toFixed(1)} dB · tilt ±${m.tiltDepthDb.toFixed(1)} dB) · ` +
    `partial step ${seg.pStepDb >= 0 ? '+' : ''}${seg.pStepDb.toFixed(1)} dB / dip ${seg.pDipDb.toFixed(1)} dB / slow ${seg.pSlowDb.toFixed(1)} dB / pitch ${seg.pStateC?.toFixed(1) ?? '—'}¢ / vibDepth ${seg.dDepthDb?.toFixed(1) ?? '—'}dB·${seg.dDepthC?.toFixed(0) ?? '—'}¢ · ` +
    `res ${seg.resDb.toFixed(1)} dB @ ${(m.xfade * 1000).toFixed(0)}ms`;
  const g = cv.getContext('2d')!;
  const W = cv.width;
  g.clearRect(0, 0, cv.width, cv.height);
  g.font = '11px system-ui';

  /* Strips 1+2: modulation trajectories ±2.5 vibrato cycles around a (blue)
     vs b (orange). The wrap replaces the orange future with the blue one —
     a phase mismatch here IS the H1 bump. FM first: string vibrato is pitch
     modulation before it is amplitude modulation. */
  const overlayStrip = (traj: Float32Array, sy: number, sh: number, label: string) => {
    g.fillStyle = '#8b93a2';
    g.fillText(label, 4, sy - 3);
    if (!m.vibHz) { g.fillStyle = '#6b7280'; g.fillText('no vibrato rate detected', 4, sy + 30); return; }
    const half = Math.round(2.5 / m.vibHz / ENV_HOP);
    const idx = (t: number) => Math.round(t / ENV_HOP);
    let lo = Infinity, hi = -Infinity;
    for (const c of [idx(seg.a), idx(seg.b)]) {
      for (let i = Math.max(0, c - half); i < Math.min(traj.length, c + half); i++) {
        lo = Math.min(lo, traj[i]); hi = Math.max(hi, traj[i]);
      }
    }
    const span = Math.max(1e-6, hi - lo);
    const trace = (c: number, color: string) => {
      g.strokeStyle = color; g.lineWidth = 1.2; g.beginPath();
      let started = false;
      for (let x = 0; x < W; x++) {
        const i = c - half + Math.floor((x / W) * 2 * half);
        if (i < 0 || i >= traj.length) { started = false; continue; }
        const y = sy + sh - ((traj[i] - lo) / span) * sh;
        started ? g.lineTo(x, y) : g.moveTo(x, y); started = true;
      }
      g.stroke();
    };
    trace(idx(seg.a), '#5c8fd8');
    trace(idx(seg.b), '#e0a85c');
    g.fillStyle = '#4a4f5a'; g.fillRect(W / 2, sy, 1, sh);
  };
  overlayStrip(m.fmDet, 12, 58,
    'FM (pitch, cents) ±2.5 vibrato cycles — blue: around a (wrap target), orange: around b (wrap source); seam at center line');
  overlayStrip(m.envDet, 86, 58, 'AM (envelope) ±2.5 vibrato cycles');

  /* Strip 3: RAW envelope (pre trend-flatten) over the segment span in dB —
     interior events the trend bake hides (bow retakes etc., H2) show as
     dips/humps replayed every cycle. */
  const s2y = 162, s2h = 60;
  g.fillStyle = '#8b93a2';
  g.fillText('raw envelope (dB rel median) across segment interior — a fixed-position dip/hump here is an H2 interior event', 4, s2y - 5);
  {
    const t0 = Math.max(0, seg.a - 0.1), t1 = seg.b + 0.1;
    const i0 = Math.round(t0 / ENV_HOP), i1 = Math.min(m.envRaw.length, Math.round(t1 / ENV_HOP));
    const vals: number[] = [];
    for (let i = i0; i < i1; i++) vals.push(m.envRaw[i]);
    const med = vals.slice().sort((a, b) => a - b)[vals.length >> 1] || 1e-9;
    const toX = (t: number) => ((t - t0) / (t1 - t0)) * W;
    g.fillStyle = '#23262d';
    g.fillRect(toX(seg.a), s2y, toX(seg.b) - toX(seg.a), s2h);
    g.strokeStyle = '#9ab0d8'; g.lineWidth = 1; g.beginPath();
    let started = false;
    for (let x = 0; x < W; x++) {
      const i = i0 + Math.floor((x / W) * (i1 - i0));
      if (i >= i1) break;
      const db = Math.max(-12, Math.min(12, 20 * Math.log10(Math.max(m.envRaw[i], 1e-9) / med)));
      const y = s2y + s2h / 2 - (db / 12) * (s2h / 2);
      started ? g.lineTo(x, y) : g.moveTo(x, y); started = true;
    }
    g.stroke();
    g.fillStyle = '#5c8fd8'; g.fillRect(toX(seg.a), s2y, 1, s2h);
    g.fillStyle = '#e0a85c'; g.fillRect(toX(seg.b), s2y, 1, s2h);
  }

  /* Strip 4: per-partial spectral snapshots at the two splice points — the
     vibrato-free bump mechanism. Each partial gets a bar pair: orange = its
     level at b (what the ear was hearing), blue = at a (what the wrap
     switches to). A tall mismatch = that partial audibly steps at the wrap;
     the red tick below marks a mid-fade phase-cancellation dip. (Replaced
     the carrier click view — that class is solved and its info lives in the
     residual number.) */
  const s3y = 252, s3h = 46;
  g.fillStyle = '#8b93a2';
  g.fillText('partial levels at b (orange, pre-wrap) vs a (blue, post-wrap) — dB rel strongest; red tick = mid-fade dip', 4, s3y - 5);
  if (seg.partials.length) {
    const maxDb = Math.max(...seg.partials.map(p => Math.max(p.aDb, p.bDb)));
    const bw = Math.min(40, W / (seg.partials.length * 3));
    seg.partials.forEach((p, i) => {
      const x0 = 30 + i * bw * 3;
      const hOf = (db: number) => Math.max(2, s3h - Math.min(30, maxDb - db) * (s3h / 30));
      g.fillStyle = '#e0a85c';
      g.fillRect(x0, s3y + s3h - hOf(p.bDb), bw, hOf(p.bDb));
      g.fillStyle = '#5c8fd8';
      g.fillRect(x0 + bw + 1, s3y + s3h - hOf(p.aDb), bw, hOf(p.aDb));
      g.fillStyle = Math.abs(p.aDb - p.bDb) >= 2 ? '#e08585' : '#8b93a2';
      g.fillText(`h${p.k}`, x0 + bw - 6, s3y + s3h + 11);
      if (p.dipDb <= -1.5) { g.fillStyle = '#e08585'; g.fillRect(x0, s3y + s3h + 13, bw * 2 + 1, 2); }
    });
  } else {
    g.fillStyle = '#6b7280'; g.fillText('no loud partials measured', 4, s3y + 20);
  }
}

/* ── solo-seam loop (production segmentLooper, single validated pair) ────── */

let solo: SegmentLooper | null = null;
let soloRaf = 0;

function stopSolo(): void {
  if (solo) { solo.stop(); solo = null; }
  cancelAnimationFrame(soloRaf);
  const b = $('soloBtn');
  b.classList.remove('playing');
  b.textContent = 'Loop this seam';
  $('soloInfo').textContent = '';
}

function startSolo(): void {
  if (!zoomTarget) return;
  const { m, seg } = zoomTarget;
  const c = ensureCtx();
  if (c.state === 'suspended') void c.resume();
  stopAll();
  if (!m.playBuf) {
    m.playBuf = c.createBuffer(1, m.wave.length, m.sr);
    m.playBuf.copyToChannel(m.wave, 0);
  }
  solo = startSegmentLooper({
    ctx: c,
    buffer: m.playBuf,
    destination: c.destination,
    segments: [{ a: seg.a, b: seg.b }],
    gain: m.gain * (VELOCITY / 127),
    trimStart: seg.a,          // start at the loop point — attack skipped, seam isolated
    crossfadeSec: m.xfade,
  });
  let last = -1, wraps = 0;
  const info = $('soloInfo'), flash = $('wrapFlash') as HTMLSpanElement;
  const btn = $('soloBtn');
  btn.classList.add('playing');
  btn.textContent = 'Stop seam loop';
  const tick = () => {
    if (!solo || !solo.isActive()) return;
    const pos = solo.getPosition();
    if (last >= 0 && pos < last - 0.02) {
      wraps++;
      flash.style.background = '#e0a85c';
      setTimeout(() => { flash.style.background = '#2a2e36'; }, 140);
    }
    last = pos;
    info.textContent = `pos ${pos.toFixed(2)}s · wraps ${wraps}`;
    soloRaf = requestAnimationFrame(tick);
  };
  soloRaf = requestAnimationFrame(tick);
}

/* ── playback ────────────────────────────────────────────────────────────── */

function ensureCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    engineInit(ctx, ctx.destination, {
      instrumentProvider: async (k: string) => {
        if (sideA && k === sideA.engineKey) return sideA.audio;
        if (sideB && k === sideB.engineKey) return sideB.audio;
        return null;
      },
    });
  }
  return ctx;
}

function stopAll(): void {
  if (activeVoice !== null) { sNoteOff(activeVoice); activeVoice = null; }
  if (playingBtn) { playingBtn.classList.remove('playing'); playingBtn = null; }
  stopSolo();
}

async function play(side: SideData, freq: number, btn: HTMLButtonElement): Promise<void> {
  const c = ensureCtx();
  if (c.state === 'suspended') await c.resume();
  if (!isInstrumentLoaded(side.engineKey)) {
    status(`loading ${side.label} into engine…`);
    await loadInstrument(side.engineKey, side.def);
    status('ready');
  }
  stopAll();
  activeVoice = `cmp-${voiceSeq++}`;
  sNoteOn(activeVoice, freq, VELOCITY, side.engineKey);
  playingBtn = btn;
  btn.classList.add('playing');
}

/* ── table ───────────────────────────────────────────────────────────────── */

function fmt(v: number, digits = 1): string { return isFinite(v) ? v.toFixed(digits) : '—'; }

function sideCells(tr: HTMLTableRowElement, side: SideData | null, name: string,
                   rowLabel: string): void {
  const m = side?.metrics.get(name);
  const tdPlay = tr.insertCell(); tdPlay.className = 'side';
  const tdSeg = tr.insertCell();
  const tdRes = tr.insertCell(); tdRes.className = 'num';
  const tdWave = tr.insertCell();
  if (!side || !m) { tdSeg.textContent = '—'; return; }
  const btn = document.createElement('button');
  btn.textContent = rowLabel;
  btn.onclick = () => (playingBtn === btn ? stopAll() : void play(side, m.freq, btn));
  tdPlay.appendChild(btn);
  m.segs.forEach(s => {
    const chip = document.createElement('span');
    /* Chip = Δφ (AM·tilt, centicycles) — the bump/wah candidate. Residual dB
       lives in the tooltip + zoom: click-free seams can still bump. */
    const cc = (p: number | null) => p == null ? '–' : String(Math.round(p * 100)).padStart(2, '0');
    /* Color = worst Δφ across the channels this sample has real depth in;
       neutral only when no channel clears its floor. */
    chip.className = `segchip ${phiClass(segSeverity(m, s))}`;
    const pEff = Math.max(Math.abs(s.pStepDb), Math.abs(s.pDipDb), s.pSlowDb);
    chip.textContent = `${cc(s.dphiFM)}·${cc(s.dphiAM)}·p${pEff.toFixed(0)}`;
    chip.title = `Δφ FM ${s.dphiFM?.toFixed(2) ?? '—'} / AM ${s.dphiAM?.toFixed(2) ?? '—'} / tilt ${s.dphiTilt?.toFixed(2) ?? '—'} cycles · ` +
      `partial step ${s.pStepDb >= 0 ? '+' : ''}${s.pStepDb.toFixed(1)} dB / dip ${s.pDipDb.toFixed(1)} dB / slow ${s.pSlowDb.toFixed(1)} dB / pitch ${s.pStateC?.toFixed(1) ?? '—'}¢ / vibDepth ${s.dDepthDb?.toFixed(1) ?? '—'}dB·${s.dDepthC?.toFixed(0) ?? '—'}¢ · ` +
      `res ${fmt(s.resDb, 1)} dB · a=${s.a.toFixed(3)} b=${s.b.toFixed(3)} (${((s.b - s.a) * 1000).toFixed(0)}ms) — click to zoom + solo`;
    chip.onclick = () => drawZoom(side!, m, s, `${side.label} · ${name}`);
    tdSeg.appendChild(chip);
  });
  tdRes.innerHTML =
    `<span class="${m.worst <= RES_GOOD ? 'good' : m.worst <= RES_OK ? '' : 'bad'}">${fmt(m.worst)}</span>` +
    ` / ${fmt(m.median)}<br><span class="mono" style="color:#8b93a2">` +
    `${(m.xfade * 1000).toFixed(0)}ms · g ${fmt(m.gain, 2)} · tr ${fmt(m.trendMin, 2)}–${fmt(m.trendMax, 2)}` +
    `<br>vib ${m.vibHz ? m.vibHz.toFixed(1) + 'Hz' : '—'} · FM ${m.fmCoherent ? `±${fmt(m.fmDepthCents, 0)}¢@${m.fmHarms}` : '✗ no common rate'}` +
    ` · AM ±${fmt(m.amDepthDb, 1)}dB · tilt ±${fmt(m.tiltDepthDb, 1)}dB` +
    (m.onsetBlipRatio != null && m.onsetBlipDb >= 1.5 && m.onsetBlipRatio >= 1.5
      ? `<br><span class="${m.onsetBlipDb >= 2.5 && m.onsetBlipRatio >= 2 ? 'bad' : 'warn'}">onset blip ${fmt(m.onsetBlipDb, 1)}dB @${fmt(m.onsetBlipAtSec, 2)}s (${fmt(m.onsetBlipRatio, 1)}×)</span>`
      : '') + `</span>`;
  const cv = document.createElement('canvas');
  cv.className = 'wave'; cv.width = 260; cv.height = 46;
  tdWave.appendChild(cv);
  drawWave(cv, m);
}

function renderTable(): void {
  const wrap = $('tablewrap');
  wrap.innerHTML = '';
  if (!sideA || !sideB) return;
  const blind = ($('blind') as HTMLInputElement).checked;
  const names = new Set<string>([...sideA.metrics.keys(), ...sideB.metrics.keys()]);
  // sort by frequency (union, prefer whichever side has the sample)
  const rows = [...names].sort((x, y) =>
    (sideA!.metrics.get(x)?.freq ?? sideB!.metrics.get(x)?.freq ?? 0) -
    (sideA!.metrics.get(y)?.freq ?? sideB!.metrics.get(y)?.freq ?? 0));
  const [first, second] = blind && Math.random() < 0.5 ? [sideB, sideA] : [sideA, sideB];
  const tbl = document.createElement('table');
  tbl.innerHTML =
    `<thead><tr><th>sample</th><th class="num">freq</th>` +
    `<th>${blind ? 'play 1' : 'A: ' + sideA.label}</th><th>seams ΔφFM·ΔφAM·pΔdB</th><th class="num">res worst/med</th><th>wave</th>` +
    `<th>${blind ? 'play 2' : 'B: ' + sideB.label}</th><th>seams ΔφFM·ΔφAM·pΔdB</th><th class="num">res worst/med</th><th>wave</th>` +
    `<th class="num">Δpost dB</th></tr></thead>`;
  const tb = document.createElement('tbody');
  for (const name of rows) {
    const tr = tb.insertRow();
    const mA = first.metrics.get(name), mB = second.metrics.get(name);
    tr.insertCell().textContent = name;
    const f = mA?.freq ?? mB?.freq ?? 0;
    const tdF = tr.insertCell(); tdF.className = 'num'; tdF.textContent = f.toFixed(1);
    sideCells(tr, first, name, blind ? '▶ 1' : first === sideA ? '▶ A' : '▶ B');
    sideCells(tr, second, name, blind ? '▶ 2' : second === sideA ? '▶ A' : '▶ B');
    const tdD = tr.insertCell(); tdD.className = 'num';
    if (mA && mB) {
      const dl = mB.postDb - mA.postDb;
      tdD.textContent = (dl >= 0 ? '+' : '') + dl.toFixed(1);
      if (Math.abs(dl) > 1) tdD.classList.add('warn'), tdD.title = 'post-gain level differs > 1 dB — mind loudness bias in A/B';
    } else tdD.textContent = '—';
    tr.insertCell();
  }
  tbl.appendChild(tb);
  wrap.appendChild(tbl);
  if (blind) status('blind mode: 1/2 assignment is randomized per load — uncheck to reveal');
}

/* ── loading ─────────────────────────────────────────────────────────────── */

async function loadSide(url: string, label: string, engineKey: string): Promise<SideData> {
  status(`fetching ${label}…`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const { def, audio } = readHkiInstrument(bytes);
  status(`analyzing ${label}…`);
  const metrics = await computeMetrics(def, audio);
  return { label, url, def, audio, engineKey, metrics };
}

async function loadPair(urlA: string, labA: string, urlB: string, labB: string): Promise<void> {
  stopAll();
  // engine caches buffers by key — drop stale entries when reloading a side
  unloadInstrument('cmpA'); unloadInstrument('cmpB');
  try {
    [sideA, sideB] = await Promise.all([
      loadSide(urlA, labA, 'cmpA'),
      loadSide(urlB, labB, 'cmpB'),
    ]);
  } catch (e) {
    status(String(e));
    return;
  }
  renderTable();
  status(`ready — A: ${labA} (${sideA.metrics.size}) vs B: ${labB} (${sideB.metrics.size})`);
}

interface CompareIndex { options: Array<{ label: string; url: string }>; defaultA?: string; defaultB?: string; }

async function boot(): Promise<void> {
  let index: CompareIndex = { options: [] };
  try {
    const r = await fetch('out/compare/index.json');
    if (r.ok) index = await r.json();
  } catch { /* no index — rely on query params */ }
  const selA = $('selA') as HTMLSelectElement, selB = $('selB') as HTMLSelectElement;
  for (const o of index.options) {
    selA.add(new Option(o.label, o.url));
    selB.add(new Option(o.label, o.url));
  }
  const q = new URLSearchParams(location.search);
  const a = q.get('a') ?? index.defaultA ?? index.options[0]?.url;
  const b = q.get('b') ?? index.defaultB ?? index.options[1]?.url;
  if (a) selA.value = a;
  if (b) selB.value = b;
  const labelOf = (sel: HTMLSelectElement) =>
    sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : sel.value.split('/').pop() ?? '?';
  $('loadBtn').onclick = () => void loadPair(selA.value, labelOf(selA), selB.value, labelOf(selB));
  $('stopBtn').onclick = stopAll;
  $('soloBtn').onclick = () => (solo ? stopSolo() : startSolo());
  ($('blind') as HTMLInputElement).onchange = renderTable;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); stopAll(); } });
  if (a && b) void loadPair(a, labelOf(selA), b, labelOf(selB));
}

void boot();
