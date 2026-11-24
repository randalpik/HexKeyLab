#!/usr/bin/env node
/**
 * hki-timbre.mjs — turn a velocity-layered decay `.hki` into one sample per note
 * plus a brightness curve.
 *
 * Some instruments make every dynamic of a note from ONE waveform, through a
 * lowpass that opens with velocity and a gain. The Korg SP-250's piano does: each
 * of its captured layers is the note's top layer through a 12 dB/oct lowpass whose
 * cutoff depends on the velocity alone, not on the pitch (docs/lessons.md → "Each
 * layer is the note's top layer through one 12 dB/oct lowpass"). For such an
 * instrument a set of discrete layers is a coarse copy of something continuous:
 * the engine switches sample at each boundary, and the timbre jumps there.
 *
 * This tool measures that filter and writes a bundle that carries it instead of
 * the layers:
 *
 *   1. Per note, every lower layer is time-aligned to the top layer (the highest
 *      `vel`) by cross-correlation, starting from each capture's rough onset: its
 *      first sample at a tenth of its own peak. (Not the engine's
 *      `findPerceptualOnset`, which reads the level through the sample's stored
 *      gain and returns 0 for a capture that gain leaves very quiet.)
 *   2. Both are measured in 1/6-octave bands over the first half second, and only
 *      bands that stand 10 dB clear of EACH capture's own noise floor (its
 *      pre-roll) and lie from the fundamental up are compared.
 *   3. Per layer velocity, ONE cutoff and ONE passband gain are fitted for the
 *      whole keyboard: the cutoff that leaves the layer-over-filtered-top ratio
 *      flattest across all bands of all notes, and the median of the notes' ratios
 *      as the gain. The filter is the one a BiquadFilterNode lowpass computes at
 *      the engine's Q (`TIMBRE_LOWPASS_Q_DB`, linear 0.7071).
 *   4. Every lower layer of every note is rebuilt from its top layer with that
 *      filter and gain, run sample by sample, and scored against the real capture
 *      (correlation, level, spectrum). The report is the evidence for the model;
 *      read it before trusting the output.
 *   5. The output keeps each note's top layer untouched (audio, `gain`,
 *      `gainLevel`), drops the other layers, and adds `manifest.timbre`: the
 *      fitted (passband gain, cutoff) of each layer, lowest first, then the top
 *      layer as (0 dB, --open-hz). The engine reads a note's level off this curve
 *      and sets one lowpass per voice (@hkl/engine `timbreCutoff`).
 *
 * The filter is fixed for the length of a note. The SP-250's own closes further
 * as a soft note decays; that is left out on purpose (Max, 2026-11-23).
 *
 * Usage:
 *   node apps/analyzer/cli/hki-timbre.mjs <in.hki> [--out <out.hki>] [--report <json>]
 *        [--key <instrumentKey>] [--name <name>] [--open-hz N]
 *
 * Without --out nothing is written but the report (dry run). An existing --out
 * file is not overwritten. Default key and name: the source's with `-curve` and
 * ` (brightness curve)` appended, so both instruments can be loaded side by side.
 * Decay bundles with WAV audio only. Gate: test/hki-timbre/run.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readHki, writeHki } from '@hkl/shared/hki.js';
import { TIMBRE_LOWPASS_Q_DB } from '@hkl/engine/samples-engine.js';

/* ── args ── */
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
  console.error('usage: hki-timbre.mjs <in.hki> [--out <out.hki>] [--report <json>] [--key <instrumentKey>] [--name <name>] [--open-hz N]');
  process.exit(argv.length === 0 ? 1 : 0);
}
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; };
const fail = (msg) => { console.error('hki-timbre: ' + msg); process.exit(2); };
const inPath = argv[0];
const outPath = opt('--out', null);
const reportPath = opt('--report', null);
const openHz = parseFloat(opt('--open-hz', '20000'));
if (outPath && fs.existsSync(outPath)) fail(`${outPath} exists — not overwritten`);

const db = (x) => (x > 0 ? 10 * Math.log10(x) : -Infinity); // of a power
const median = (a) => { const s = [...a].sort((p, q) => p - q); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/* ── WAV decode (IEEE float32 or PCM 16/24/32) → mono Float64Array ── */
function decodeWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= bytes.length) {
    const id = tag(off), len = dv.getUint32(off + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(off + 8, true), ch: dv.getUint16(off + 10, true), sr: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    else if (id === 'data') { data = { off: off + 8, len: Math.min(len, bytes.length - off - 8) }; break; }
    off += 8 + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt/data');
  const bps = fmt.bits / 8, n = Math.floor(data.len / bps / fmt.ch), x = new Float64Array(n), coef = fmt.ch === 1 ? 1 : Math.sqrt(1 / fmt.ch);
  let p = data.off;
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) {
    let v;
    if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(p, true);
    else if (fmt.bits === 16) v = dv.getInt16(p, true) / 32768;
    else if (fmt.bits === 24) v = ((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8 >> 8) / 8388608;
    else if (fmt.bits === 32) v = dv.getInt32(p, true) / 2147483648;
    else throw new Error(`unsupported WAV: format ${fmt.format} bits ${fmt.bits}`);
    x[i] += v * coef; p += bps;
  }
  return { x, sr: fmt.sr };
}

/* ── spectrum in 1/6-octave bands ── */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const BAND_LO = 20, BAND_HI = 16000, BANDS = Math.round(Math.log2(BAND_HI / BAND_LO) * 6);
const EDGES = Array.from({ length: BANDS + 1 }, (_, i) => BAND_LO * Math.pow(BAND_HI / BAND_LO, i / BANDS));
const CENTERS = EDGES.slice(0, -1).map((e, i) => Math.sqrt(e * EDGES[i + 1]));
/* Power per band of x[start, start + n), Hann-windowed, normalized so that a
   stationary signal reads the same whatever n is (noise floors are taken from a
   shorter stretch than the note). */
function bandPowers(x, start, n, sr) {
  let nfft = 1; while (nfft < n) nfft <<= 1;
  const re = new Float64Array(nfft), im = new Float64Array(nfft); let w2 = 0;
  for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); re[i] = x[start + i] * w; w2 += w * w; }
  fft(re, im);
  const out = new Float64Array(BANDS), norm = 1 / (w2 * nfft);
  for (let b = 0; b < BANDS; b++) {
    const k0 = Math.ceil(EDGES[b] * nfft / sr), k1 = Math.min(nfft / 2, Math.ceil(EDGES[b + 1] * nfft / sr));
    let s = 0; for (let k = k0; k < k1; k++) s += re[k] * re[k] + im[k] * im[k];
    out[b] = s * norm;
  }
  return out;
}

/* ── the filter: a BiquadFilterNode lowpass (Web Audio spec), Q in dB ── */
function lowpassCoeffs(fc, sr) {
  const w0 = 2 * Math.PI * fc / sr, c = Math.cos(w0), al = Math.sin(w0) / (2 * Math.pow(10, TIMBRE_LOWPASS_Q_DB / 20)), a0 = 1 + al;
  return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 };
}
function lowpassPower(fc, sr, f) {
  const k = lowpassCoeffs(fc, sr), w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = k.b0 + k.b1 * c1 + k.b2 * c2, ni = -(k.b1 * s1 + k.b2 * s2), dr = 1 + k.a1 * c1 + k.a2 * c2, di = -(k.a1 * s1 + k.a2 * s2);
  return (nr * nr + ni * ni) / (dr * dr + di * di);
}
function lowpassRun(x, start, n, fc, sr, gain) {
  const k = lowpassCoeffs(fc, sr), y = new Float64Array(n); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) { const xi = x[start + i], v = k.b0 * xi + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = v; y[i] = v * gain; }
  return y;
}

/* ── read ── */
const bundle = readHki(new Uint8Array(fs.readFileSync(inPath)));
const { manifest } = bundle;
if (manifest.loop) fail('loop instruments are out of scope (decay bundles only)');
if (manifest.timbre) fail('this bundle already carries a brightness curve');
const byNote = new Map();
for (const s of manifest.samples) {
  if (path.extname(s.file).toLowerCase() !== '.wav') fail(`${s.file} is not WAV — only lossless bundles are supported`);
  if (!byNote.has(s.name)) byNote.set(s.name, []);
  byNote.get(s.name).push(s);
}
if (![...byNote.values()].some((rows) => rows.length >= 2 && rows.every((r) => typeof r.vel === 'number'))) {
  fail('no note has velocity layers — there is nothing to fit a curve to');
}

let sr = 0;
const notes = [];
for (const [name, rows] of byNote) {
  const layers = rows.filter((r) => typeof r.vel === 'number').sort((a, b) => a.vel - b.vel);
  if (layers.length < 2) { notes.push({ name, freq: rows[0].freq, top: rows[0], lower: [] }); continue; }
  const dec = layers.map((s) => {
    const w = decodeWav(bundle.audio[s.file]);
    if (sr && w.sr !== sr) fail(`${s.file}: sample rate ${w.sr} differs from ${sr}`);
    sr = w.sr;
    let peak = 0; for (let i = 0; i < w.x.length; i++) { const a = Math.abs(w.x[i]); if (a > peak) peak = a; }
    let on = 0; while (on < w.x.length && Math.abs(w.x[on]) < 0.1 * peak) on++;
    return { s, x: w.x, on };
  });
  const top = dec[dec.length - 1], f0 = top.s.freq;
  /* Align each lower layer to the top one: the lag of best correlation over the
     first half second, searched a period and a half either way (5 ms at least). */
  const LAG = Math.round(Math.max(0.005, 1.5 / f0) * sr), s0 = Math.round(0.02 * sr) + LAG;
  const room = Math.min(...dec.map((d) => d.x.length - d.on));
  const N = Math.min(Math.round(0.45 * sr), room - s0 - 2 * LAG - 64);
  const note = { name, freq: f0, top: top.s, topX: top.x, topOn: top.on, room, lower: [] };
  if (N >= Math.round(0.05 * sr)) {
    const a0 = top.on + s0; let ea = 0; for (let i = 0; i < N; i++) ea += top.x[a0 + i] * top.x[a0 + i];
    for (const d of dec.slice(0, -1)) {
      const b0 = d.on + s0; if (b0 - LAG < 0) continue;
      let best = -Infinity, lag = 0;
      for (let l = -LAG; l <= LAG; l++) {
        let c = 0, eb = 0; const o = b0 + l;
        for (let i = 0; i < N; i++) { const v = d.x[o + i]; c += top.x[a0 + i] * v; eb += v * v; }
        const r = c / Math.sqrt(ea * eb + 1e-300); if (r > best) { best = r; lag = l; }
      }
      note.lower.push({ s: d.s, vel: d.s.vel, x: d.x, on: d.on + lag, alignCorr: best });
    }
    note.N = N; note.LAG = LAG;
  }
  notes.push(note);
  process.stderr.write('.');
}
process.stderr.write('\n');
notes.sort((a, b) => a.freq - b.freq);

/* ── measure: layer over top, per band, where both stand clear of their noise ── */
const W0 = 0.02; // seconds after the onset
const noiseOf = (x, on) => { const a = Math.max(0, on - Math.round(0.13 * sr)), n = on - Math.round(0.015 * sr) - a; return n >= Math.round(0.02 * sr) ? bandPowers(x, a, n, sr) : new Float64Array(BANDS); };
for (const note of notes) {
  if (!note.lower.length) continue;
  const n = note.N, start = Math.round(W0 * sr);
  note.topP = bandPowers(note.topX, note.topOn + start, n, sr); note.topNoise = noiseOf(note.topX, note.topOn);
  for (const l of note.lower) {
    l.P = bandPowers(l.x, l.on + start, n, sr); l.noise = noiseOf(l.x, l.on);
    l.valid = []; for (let b = 0; b < BANDS; b++) if (CENTERS[b] > 0.7 * note.freq && l.P[b] > 10 * l.noise[b] && note.topP[b] > 10 * note.topNoise[b] && l.P[b] > 0) l.valid.push(b);
  }
}

/* ── fit: one cutoff and one passband gain per layer velocity, all notes pooled ── */
const vels = [...new Set(notes.flatMap((n) => n.lower.map((l) => l.vel)))].sort((a, b) => a - b);
const GRID = Array.from({ length: 220 }, (_, i) => 100 * Math.pow(16000 / 100, i / 219));
const fits = [];
for (const vel of vels) {
  const rows = notes.flatMap((n) => n.lower.filter((l) => l.vel === vel && l.valid.length >= 4).map((l) => ({ n, l })));
  if (!rows.length) fail(`layer ${vel}: no note has enough bands clear of its noise floor`);
  let best = { err: Infinity };
  for (const fc of GRID) {
    const H = CENTERS.map((f) => lowpassPower(fc, sr, f)), per = [], means = [];
    for (const { n, l } of rows) { const d = l.valid.map((b) => db(l.P[b] / (n.topP[b] * H[b]))); per.push(d); means.push(d.reduce((a, v) => a + v, 0) / d.length); }
    const g = median(means); let se = 0, cnt = 0;
    for (const d of per) for (const v of d) { se += (v - g) * (v - g); cnt++; }
    const err = Math.sqrt(se / cnt);
    if (err < best.err) best = { err, fc, g, notes: rows.length };
  }
  /* How much there is to explain: the same residual with no filter at all. */
  const flat = (() => { const per = [], means = []; for (const { n, l } of rows) { const d = l.valid.map((b) => db(l.P[b] / n.topP[b])); per.push(d); means.push(d.reduce((a, v) => a + v, 0) / d.length); } const g = median(means); let se = 0, cnt = 0; for (const d of per) for (const v of d) { se += (v - g) * (v - g); cnt++; } return Math.sqrt(se / cnt); })();
  fits.push({ vel, cutoffHz: Math.round(best.fc), gainDb: Math.round(best.g * 100) / 100, spectrumErrorDb: Math.round(best.err * 100) / 100, unfilteredErrorDb: Math.round(flat * 100) / 100, notes: best.notes });
}

/* ── rebuild every lower layer from its top layer, and score it ── */
const rebuilt = [];
for (const note of notes) for (const l of note.lower) {
  const f = fits.find((q) => q.vel === l.vel), pre = Math.round(0.005 * sr);
  const n = Math.min(Math.round(1.005 * sr), note.room - (note.LAG || 0) - 2048);
  if (n < Math.round(0.1 * sr) || note.topOn - pre < 0 || l.on - pre < 0 || l.on - pre + n > l.x.length || note.topOn - pre + n > note.topX.length) continue;
  const y = lowpassRun(note.topX, note.topOn - pre, n, f.cutoffHz, sr, Math.pow(10, f.gainDb / 20));
  const real = l.x.subarray(l.on - pre, l.on - pre + n);
  /* Correlation at the best lag. The search covers the note's own alignment range:
     a heavily filtered layer can sit one whole period from the top layer after
     step 1, which the band comparison does not mind and this would. Found on the
     first half second, then taken over the whole span. */
  const M = (note.LAG || 0) + 96, head = Math.min(n - 2 * M, Math.round(0.5 * sr));
  let lagBest = 0, rBest = -Infinity;
  if (head > 0) for (let lag = -M; lag <= M; lag++) { let c = 0, ey0 = 0, er0 = 0; for (let i = M; i < M + head; i++) { const p = y[i + lag], q = real[i]; c += p * q; ey0 += p * p; er0 += q * q; } const r = c / Math.sqrt(ey0 * er0 + 1e-300); if (r > rBest) { rBest = r; lagBest = lag; } }
  let corr = -1;
  { let c = 0, ey0 = 0, er0 = 0; for (let i = M; i < n - M; i++) { const p = y[i + lagBest], q = real[i]; c += p * q; ey0 += p * p; er0 += q * q; } corr = c / Math.sqrt(ey0 * er0 + 1e-300); }
  let ey = 0, er = 0; for (let i = 0; i < n; i++) { ey += y[i] * y[i]; er += real[i] * real[i]; }
  const Py = bandPowers(y, 0, n, sr), Pr = bandPowers(real, 0, n, sr); let pmax = 0; for (const v of Pr) pmax = Math.max(pmax, v);
  let se = 0, cnt = 0; for (let b = 0; b < BANDS; b++) if (Pr[b] > 10 * l.noise[b] && Pr[b] > pmax * 1e-4) { const d = db(Py[b] / Pr[b]); se += d * d; cnt++; }
  rebuilt.push({ name: note.name, freq: note.freq, vel: l.vel, correlation: Math.round(corr * 1e4) / 1e4, levelErrorDb: Math.round(db(ey / er) * 100) / 100, spectrumErrorDb: cnt ? Math.round(Math.sqrt(se / cnt) * 100) / 100 : null });
}

/* ── the curve ── */
const points = fits.map((f) => ({ gainDb: f.gainDb, cutoffHz: Math.min(f.cutoffHz, openHz) }));
points.push({ gainDb: 0, cutoffHz: openHz });
for (let i = 1; i < points.length; i++) {
  if (!(points[i].gainDb > points[i - 1].gainDb) || points[i].cutoffHz < points[i - 1].cutoffHz) {
    fail(`the fitted layers do not form a curve (${points.map((p) => `${p.gainDb} dB → ${p.cutoffHz} Hz`).join(', ')}): this instrument's layers are not one waveform through an opening lowpass`);
  }
}
const timbre = { type: 'lowpass12', points };

/* ── report ── */
const f1 = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
console.error(`hki-timbre: ${manifest.samples.length} samples, ${notes.length} notes, ${vels.length} lower layers; lowpass 12 dB/oct at Q ${f1(TIMBRE_LOWPASS_Q_DB, 2)} dB, fitted over ${W0}–${f1(W0 + 0.45, 2)} s`);
for (const f of fits) console.error(`  layer ${String(f.vel).padStart(3)}: cutoff ${String(f.cutoffHz).padStart(5)} Hz, passband gain ${f1(f.gainDb).padStart(6)} dB; spectrum error ${f1(f.spectrumErrorDb)} dB rms over ${f.notes} notes (${f1(f.unfilteredErrorDb)} dB with no filter)`);
console.error('  rebuilt from the top layer against the real capture, first second (median / worst):');
for (const vel of vels) {
  const r = rebuilt.filter((q) => q.vel === vel); if (!r.length) continue;
  const worst = (k) => r.reduce((m, q) => (Math.abs(q[k]) > Math.abs(m) ? q[k] : m), 0);
  console.error(`    layer ${String(vel).padStart(3)}: correlation ${f1(median(r.map((q) => q.correlation)), 3)} / ${f1(Math.min(...r.map((q) => q.correlation)), 3)}, level ${f1(median(r.map((q) => q.levelErrorDb)))} / ${f1(worst('levelErrorDb'))} dB, spectrum ${f1(median(r.filter((q) => q.spectrumErrorDb != null).map((q) => q.spectrumErrorDb)))} / ${f1(Math.max(...r.filter((q) => q.spectrumErrorDb != null).map((q) => q.spectrumErrorDb)))} dB`);
}
console.error(`  curve: ${points.map((p) => `${f1(p.gainDb)} dB → ${p.cutoffHz} Hz`).join(',  ')}`);
if (reportPath) { fs.writeFileSync(reportPath, JSON.stringify({ source: path.basename(inPath), timbre, fits, rebuilt }, null, 1)); console.error(`  report → ${reportPath}`); }

/* ── write ── */
if (outPath) {
  const samples = notes.sort((a, b) => manifest.samples.indexOf(a.top) - manifest.samples.indexOf(b.top)).map((n) => { const { vel: _layer, ...row } = n.top; return row; });
  const audio = Object.fromEntries(samples.map((s) => [s.file, bundle.audio[s.file]]));
  const out = {
    manifest: { ...manifest, instrumentKey: opt('--key', manifest.instrumentKey + '-curve'), name: opt('--name', manifest.name + ' (brightness curve)'), samples, timbre },
    audio,
    provenance: { ...(bundle.provenance || {}), timbre: { source: path.basename(inPath), date: new Date().toISOString(), type: timbre.type, windowSec: [W0, W0 + 0.45], openHz, layers: fits } },
  };
  fs.writeFileSync(outPath, writeHki(out));
  console.error(`  wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB, ${samples.length} samples)`);
} else {
  console.error('  dry run — no bundle written (pass --out <file.hki>)');
}
