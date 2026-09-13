#!/usr/bin/env node
/**
 * hki-regain.mjs — perceptual re-gain of a velocity-layered decay `.hki`.
 *
 * Rewrites ONLY the per-sample `gain` values of a bundle (audio untouched) so
 * that perceived loudness is consistent across the instrument:
 *
 *   1. Measure each sample's Bark-sones (`@hkl/analysis/loudness.js`, relative,
 *      uncalibrated) over an attack window starting at the ENGINE's own
 *      perceptual onset (`findPerceptualOnset`, the point playback starts from),
 *      at the sample's current baked gain.
 *   2. Within a note: each layer's target = the note's reference (geometric-mean
 *      sones over its layers) × that layer's TIER factor^(--layer-span). The tier
 *      factor is the layer's measured deviation from the note reference, smoothed
 *      across notes (same local fit as step 3) and forced monotonic in velocity
 *      (pool-adjacent-violators). --layer-span 0 (default — Max's ruling
 *      2026-09-12: layers carry timbre, the house curve carries ALL loudness)
 *      equalizes the layers' baked sones, so a boundary crossing at the same
 *      input velocity is continuous and loudness-vs-velocity is monotonic by
 *      construction. --layer-span 1 keeps the instrument's own between-layer
 *      loudness tiers (brighter layers stay louder; on the SP-250 they added
 *      ≈ +75 % sones from v24 to v120, i.e. steps at every boundary), smoothed
 *      across notes. Either way this supersedes the sweep-derived layer softening
 *      HKLO bakes at export.
 *   3. Across notes: the per-note reference follows a Gaussian-weighted local
 *      linear fit of log-sones vs MIDI (σ = --sigma semitones), which removes
 *      note-to-note alternation while keeping the register curve; --tilt blends
 *      that curve toward the set median (0 = keep the instrument's own tilt,
 *      1 = flat).
 *   4. Correction in dB = --strength × 10·log2(target / measured) — the phon rule
 *      (×2 sones ≈ 10 dB at moderate levels), the same mapping the analyzer's
 *      loop-path `loudnessEvenness` uses. Boosts ARE allowed here (a quiet note
 *      is a hole the player hears), unlike the attenuation-only loop pass.
 *      Calibration caveat: the lite model itself scales as sones ∝ gain^0.46
 *      (≈ 13.1 dB per doubling), so RE-MEASURING a corrected bundle with it shows
 *      ≈ 24 % of each original deviation as residual. Which exponent the ear
 *      follows is the open question; --strength 1.31 would zero the residual under
 *      the model's own exponent (allowed range 0..1.5 — the ear-trim knob).
 *   5. No level cap by default. The analyzer's −3 dBFS per-sample peak target is a
 *      normalization convention (keep a single v127 voice under the master
 *      limiter), not a limit — Web Audio is float and the only hard clip is the
 *      DAC behind the limiter. Lowering the whole set to keep one boosted note
 *      under it would trade every note's RMS consistency for one transient.
 *      Instead the report lists each layer's PLAYED peak at the top of its
 *      velocity zone (pickLayer switches at the midpoints: v24 ≤36, v48 ≤60,
 *      v72 ≤84, v96 ≤108, v120 ≤127) so the samples that will touch the limiter
 *      are known. `--ceiling <dBFS>` opts back into the whole-set shift.
 *   6. Two endpoints, one slider. The bundle carries BOTH inter-layer matchings:
 *      `gain` = layers matched in Bark-sones, `gainLevel` = layers matched in
 *      K-weighted level over the same 400 ms window (same cross-note reference
 *      in both). The engine blends them log-linearly by its layer-blend setting
 *      (HKL lumadiag slider: 0 = level match, 1 = sones match). The slider is a
 *      PERMANENT control, not a calibration step (Max, 2026-09-13: "use cases for
 *      the whole spectrum"), so always emit both gains. `--bake-blend t` collapses
 *      them to a single blended `gain` only for consumers that can't expose the
 *      blend — external `@hexkeylab/engine` embedders, `handoff/` bundles.
 *
 * Usage:
 *   node apps/analyzer/cli/hki-regain.mjs <in.hki> [--out <out.hki>] [--report <json>]
 *        [--tilt 0..1] [--layer-span 0..1] [--strength 0..1.5] [--ceiling <dBFS>|none]
 *        [--window-ms N] [--sigma N] [--bake-blend 0..1]
 *
 * Without --out nothing is written but the report (dry run). Motivation and the
 * audit that led here: docs/decisions.md "Perceptual re-gain of layered decay
 * bundles" (2026-09-12).
 */

import fs from 'node:fs';
import path from 'node:path';
import { readHki, writeHki } from '@hkl/shared/hki.js';
import { sustainSones } from '@hkl/analysis/loudness.js';
import { measureLufs } from '@hkl/analysis/k-weighting.js';
import { findPerceptualOnset } from '@hkl/engine/samples-engine.js';

/* ── args ── */
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
  console.error('usage: hki-regain.mjs <in.hki> [--out <out.hki>] [--report <json>] [--tilt 0..1] [--layer-span 0..1] [--strength 0..1.5] [--ceiling <dBFS>|none] [--window-ms N] [--sigma N] [--bake-blend 0..1]');
  process.exit(argv.length === 0 ? 1 : 0);
}
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; };
const inPath = argv[0];
const outPath = opt('--out', null);
const reportPath = opt('--report', null);
const tilt = Math.min(1, Math.max(0, parseFloat(opt('--tilt', '0'))));
const layerSpan = Math.min(1, Math.max(0, parseFloat(opt('--layer-span', '0'))));
const strength = Math.min(1.5, Math.max(0, parseFloat(opt('--strength', '1'))));
const ceilingArg = opt('--ceiling', 'none');
const ceilingDb = ceilingArg === 'none' ? null : parseFloat(ceilingArg);
const windowMs = parseFloat(opt('--window-ms', '400'));
const sigma = parseFloat(opt('--sigma', '6'));
const bakeBlendArg = opt('--bake-blend', null);
const bakeBlend = bakeBlendArg == null ? null : Math.min(1, Math.max(0, parseFloat(bakeBlendArg)));

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const NOTE_RE = /^([A-G])(#|b)?(-?\d+)$/;
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midiOf(name, freq) {
  const m = NOTE_RE.exec(name);
  if (m) return 12 * (parseInt(m[3], 10) + 1) + SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

/* ── WAV decode (IEEE float32 or PCM 16/24/32) → { channels: Float32Array[], sr } ── */
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
  const bps = fmt.bits / 8, n = Math.floor(data.len / bps / fmt.ch);
  const channels = Array.from({ length: fmt.ch }, () => new Float32Array(n));
  let p = data.off;
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) {
    let v;
    if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(p, true);
    else if (fmt.bits === 16) v = dv.getInt16(p, true) / 32768;
    else if (fmt.bits === 24) v = ((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8 >> 8) / 8388608;
    else if (fmt.bits === 32) v = dv.getInt32(p, true) / 2147483648;
    else throw new Error(`unsupported WAV: format ${fmt.format} bits ${fmt.bits}`);
    channels[c][i] = v; p += bps;
  }
  return { channels, sr: fmt.sr };
}
function mono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length, coef = Math.sqrt(1 / channels.length), out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * coef;
  return out;
}

/* ── measure ── */
const bundle = readHki(new Uint8Array(fs.readFileSync(inPath)));
const { manifest } = bundle;
if (manifest.loop) { console.error('hki-regain: loop instruments are out of scope (decay bundles only)'); process.exit(2); }

const rows = [];
for (const s of manifest.samples) {
  const ext = path.extname(s.file).toLowerCase();
  if (ext !== '.wav') { console.error(`hki-regain: ${s.file} is not WAV — only lossless HKLO bundles are supported`); process.exit(2); }
  const { channels, sr } = decodeWav(bundle.audio[s.file]);
  const x = mono(channels);
  const gain = typeof s.gain === 'number' ? s.gain : 1;
  const onset = findPerceptualOnset(x, sr, gain);
  const winEnd = Math.min(x.length, onset + Math.round(windowMs / 1000 * sr));
  const so = sustainSones(x, sr, onset, winEnd, gain);
  if (!so) { console.error(`hki-regain: ${s.name} v${s.vel ?? '-'}: attack window too short for sones — skipped`); continue; }
  let peak = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  const stereo = new Float32Array(x.length * 2); for (let i = 0; i < x.length; i++) { stereo[2 * i] = x[i] * gain; stereo[2 * i + 1] = x[i] * gain; }
  const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * gain;
  const lufs = measureLufs(stereo, y, sr, { startSample: onset, endSample: x.length });
  // Level over the SAME attack window as the sones measurement (K-weighted, BS.1770 momentary).
  const l400 = measureLufs(stereo, y, sr, { startSample: onset, endSample: winEnd });
  if (l400.lufs == null) { console.error(`hki-regain: ${s.name} v${s.vel ?? '-'}: attack window too short for level — skipped`); continue; }
  rows.push({ name: s.name, vel: s.vel ?? null, midi: midiOf(s.name, s.freq), file: s.file, gainOld: gain, sones: so.sones, bands: so.occupiedBands, peakDb: db(peak * gain), lufs: lufs.lufs ?? null, lufs400: l400.lufs, onsetMs: onset / sr * 1000 });
  process.stderr.write('.');
}
process.stderr.write('\n');

/* ── targets ── */
const notes = new Map(); // name → { midi, rows[] }
for (const r of rows) { if (!notes.has(r.name)) notes.set(r.name, { midi: r.midi, rows: [] }); notes.get(r.name).rows.push(r); }
const noteList = [...notes.values()].sort((a, b) => a.midi - b.midi);
for (const n of noteList) n.logRef = n.rows.reduce((acc, r) => acc + Math.log(r.sones), 0) / n.rows.length; // geometric mean over layers
// Gaussian-weighted local linear fit (value at each point's own x) over (x, y) pairs.
function localLinearFit(pts, x0) {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) {
    const w = Math.exp(-0.5 * ((p.x - x0) / sigma) ** 2), x = p.x - x0;
    sw += w; sx += w * x; sy += w * p.y; sxx += w * x * x; sxy += w * x * p.y;
  }
  const den = sw * sxx - sx * sx;
  return Math.abs(den) > 1e-12 ? (sxx * sy - sx * sxy) / den : sy / sw; // intercept at x0
}
const refPts = noteList.map((n) => ({ x: n.midi, y: n.logRef }));
for (const n of noteList) n.logTrend = localLinearFit(refPts, n.midi);
const logMedian = (() => { const a = noteList.map((n) => n.logRef).sort((p, q) => p - q); return a[a.length >> 1]; })();
for (const n of noteList) n.logTarget = (1 - tilt) * n.logTrend + tilt * logMedian;

// Per-layer tier: deviation of each layer from the note reference, smoothed across
// the notes that have that layer, then forced monotonic in velocity per note (PAVA).
const layerVels = [...new Set(rows.map((r) => r.vel))].sort((a, b) => a - b);
const tierPts = new Map(layerVels.map((v) => [v, []]));
for (const n of noteList) for (const r of n.rows) tierPts.get(r.vel).push({ x: n.midi, y: Math.log(r.sones) - n.logRef });
for (const n of noteList) {
  const tiers = n.rows.map((r) => ({ vel: r.vel, t: localLinearFit(tierPts.get(r.vel), n.midi) })).sort((a, b) => a.vel - b.vel);
  // Pool adjacent violators → non-decreasing tier with velocity.
  const blocks = tiers.map((t) => ({ sum: t.t, cnt: 1, vels: [t.vel] }));
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].sum / blocks[i].cnt > blocks[i + 1].sum / blocks[i + 1].cnt) {
      blocks[i] = { sum: blocks[i].sum + blocks[i + 1].sum, cnt: blocks[i].cnt + blocks[i + 1].cnt, vels: blocks[i].vels.concat(blocks[i + 1].vels) };
      blocks.splice(i + 1, 1); if (i > 0) i--;
    } else i++;
  }
  n.logTier = new Map();
  for (const b of blocks) for (const v of b.vels) n.logTier.set(v, b.sum / b.cnt);
  // Re-center so the tiers' mean over this note's layers is 0 (the reference stays the geometric mean).
  const mean = [...n.logTier.values()].reduce((a, b) => a + b, 0) / n.logTier.size;
  for (const v of n.logTier.keys()) n.logTier.set(v, n.logTier.get(v) - mean);
}

/* ── corrections ──
   Decomposed so both endpoints share the cross-note part:
     crossDb  = 10·log2(target_note / geomean-sones_note)          (same for every layer of the note)
     sonesDb  = 10·log2(geomean-sones_note × tier^span / sones)      (inter-layer, Bark-sones metric)
     levelDb  = (1 − span) × (mean-lufs400_note − lufs400)          (inter-layer, K-weighted level metric)
   `gain` ← cross + sones; `gainLevel` ← cross + level. (For span > 0 the level
   endpoint simply scales its equalization by 1 − span; the smoothed-tier logic is
   defined in the sones domain only.) */
for (const n of noteList) {
  const meanL400 = n.rows.reduce((a, r) => a + r.lufs400, 0) / n.rows.length;
  for (const r of n.rows) {
    r.logTier = n.logTier.get(r.vel);
    r.target = Math.exp(n.logTarget + layerSpan * r.logTier);
    r.crossDb = strength * 10 * Math.log2(Math.exp(n.logTarget) / Math.exp(n.logRef));
    r.sonesLayerDb = strength * 10 * Math.log2(Math.exp(n.logRef + layerSpan * r.logTier) / r.sones);
    r.levelLayerDb = strength * (1 - layerSpan) * (meanL400 - r.lufs400);
    r.dDb = r.crossDb + r.sonesLayerDb;           // sones endpoint (drives the ceiling logic + report)
    r.dDbLevel = r.crossDb + r.levelLayerDb;      // level endpoint
  }
}
let shiftDb = 0;
if (ceilingDb != null) {
  const maxPeak = Math.max(...rows.map((r) => r.peakDb + r.dDb));
  if (maxPeak > ceilingDb) shiftDb = ceilingDb - maxPeak;
}
for (const r of rows) {
  r.dDbTotal = r.dDb + shiftDb;
  r.dDbLevelTotal = r.dDbLevel + shiftDb;
  r.gainNew = r.gainOld * Math.pow(10, r.dDbTotal / 20);
  r.gainLevelNew = r.gainOld * Math.pow(10, r.dDbLevelTotal / 20);
  if (bakeBlend != null) r.gainBaked = Math.pow(r.gainLevelNew, 1 - bakeBlend) * Math.pow(r.gainNew, bakeBlend);
  r.peakAfterDb = r.peakDb + r.dDbTotal;
  r.lufsAfter = r.lufs != null ? r.lufs + r.dDbTotal : null;
  // Predicted sones after, by the same phon rule the correction used (×2 per 10 dB).
  r.sonesAfterPred = r.sones * Math.pow(2, r.dDbTotal / 10);
}

/* ── report ── */
const params = { tilt, layerSpan, strength, ceilingDb, windowMs, sigma, shiftDb, bakeBlend, source: path.basename(inPath), date: new Date().toISOString() };
const layers = [...new Set(rows.map((r) => r.vel))].sort((a, b) => a - b);
const stat = (a) => { a = a.filter(Number.isFinite).sort((p, q) => p - q); return a.length ? { min: a[0], med: a[a.length >> 1], max: a[a.length - 1] } : null; };
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
console.error(`hki-regain: ${rows.length} samples, ${noteList.length} notes; tilt ${tilt}, layer-span ${layerSpan}, strength ${strength}, ceiling ${ceilingDb == null ? 'none' : ceilingDb + ' dBFS'}, window ${windowMs} ms, σ ${sigma} st`);
if (ceilingDb != null) {
  const drivers = [...rows].sort((a, b) => (b.peakDb + b.dDb) - (a.peakDb + a.dDb)).slice(0, 3).map((r) => `${r.name} v${r.vel} (${f(r.dDb, 1)} dB → peak ${f(r.peakDb + r.dDb, 1)} dBFS)`);
  console.error(`  whole-set shift for ceiling: ${f(shiftDb, 2)} dB — driven by ${drivers.join(', ')}`);
}
// Played peak at the top of each layer's velocity zone (house curve, no per-key trim).
const houseCurve = (v) => 0.05 + 0.95 * Math.pow(Math.min(v, 127) / 127, 1.5);
const zoneTop = (v) => { const i = layers.indexOf(v); return i < layers.length - 1 ? Math.floor((v + layers[i + 1]) / 2) : 127; };
const LIMITER_DB = -3;
for (const r of rows) r.playedPeakDb = r.peakAfterDb + db(houseCurve(zoneTop(r.vel)));
const over = rows.filter((r) => r.playedPeakDb > LIMITER_DB).sort((a, b) => b.playedPeakDb - a.playedPeakDb);
console.error(`  played peak at the top of each layer's zone: ${layers.map((v) => `v${v}@${zoneTop(v)} max ${f(Math.max(...rows.filter((r) => r.vel === v).map((r) => r.playedPeakDb)), 1)}`).join(', ')} dBFS`);
console.error(`  samples that would reach the master limiter (${LIMITER_DB} dBFS) at the top of their zone: ${over.length}${over.length ? ' — ' + over.slice(0, 6).map((r) => `${r.name} v${r.vel} ${f(r.playedPeakDb, 1)}`).join(', ') + (over.length > 6 ? ', …' : '') : ''}`);
const corr = stat(rows.map((r) => r.dDb));
console.error(`  per-sample correction (before shift): min ${f(corr.min)} med ${f(corr.med)} max ${f(corr.max)} dB`);
// Slider range: how far apart the two endpoints put the UPPER layer at each boundary (median over notes).
{
  const byNote = new Map(); for (const r of rows) { if (!byNote.has(r.name)) byNote.set(r.name, new Map()); byNote.get(r.name).set(r.vel, r); }
  const parts = [];
  for (let i = 0; i < layers.length - 1; i++) {
    const lo = layers[i], hi = layers[i + 1], d = [];
    for (const m of byNote.values()) if (m.has(lo) && m.has(hi)) d.push((m.get(hi).dDb - m.get(lo).dDb) - (m.get(hi).dDbLevel - m.get(lo).dDbLevel));
    d.sort((a, b) => a - b); if (d.length) parts.push(`${lo}→${hi} ${f(d[d.length >> 1], 1)} dB`);
  }
  console.error(`  sones endpoint vs level endpoint — upper layer relative to lower at each boundary (median): ${parts.join(', ')}`);
}
for (const v of layers) {
  const L = rows.filter((r) => r.vel === v);
  console.error(`  v${v}: correction ${f(stat(L.map((r) => r.dDb)).min)}…${f(stat(L.map((r) => r.dDb)).max)} dB; LUFS after med ${f(stat(L.map((r) => r.lufsAfter)).med)}; peak after max ${f(stat(L.map((r) => r.peakAfterDb)).max)} dBFS`);
}
if (reportPath) {
  fs.writeFileSync(reportPath, JSON.stringify({ params, notes: noteList.map((n) => ({ name: n.rows[0].name, midi: n.midi, logRef: n.logRef, logTrend: n.logTrend, logTarget: n.logTarget, logTier: Object.fromEntries(n.logTier) })), rows }, null, 1));
  console.error(`  report → ${reportPath}`);
}

/* ── write ── */
if (outPath) {
  const byFile = new Map(rows.map((r) => [r.file, r]));
  for (const s of manifest.samples) {
    const r = byFile.get(s.file); if (!r) continue;
    if (bakeBlend != null) { s.gain = r.gainBaked; delete s.gainLevel; }
    else { s.gain = r.gainNew; s.gainLevel = r.gainLevelNew; }
  }
  bundle.provenance = { ...(bundle.provenance || {}), regain: params };
  fs.writeFileSync(outPath, writeHki(bundle));
  console.error(`  wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB)`);
} else {
  console.error('  dry run — no bundle written (pass --out <file.hki>)');
}
