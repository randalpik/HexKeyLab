// Hardware-free gate for the brightness-curve bundle tool and the manifest field it writes.
// Run with the repo's .js → .ts resolution hook:
// node --import ./test/orchestrator-smoke/register-ts.mjs test/hki-timbre/run.mjs
//
// apps/analyzer/cli/hki-timbre.mjs takes a velocity-layered decay bundle whose layers are
// one waveform through a lowpass that opens with velocity (the Korg SP-250's piano:
// docs/lessons.md), fits one cutoff and one passband gain per layer for the whole
// keyboard, and writes a bundle holding each note's top layer plus the curve
// (`manifest.timbre`, @hkl/shared/hki.js), which the engine plays through one lowpass per
// voice. This builds a synthetic layered bundle with known filters, start offsets that
// differ from layer to layer, and noise; runs the tool on it; and checks the curve it
// recovers, the bundle it writes (one gain per note, and the level its filter takes from
// each note, to be put back), the cases it refuses, and the field's validation.
// It also runs the tool's two other ways in: --stretch (a sample's freq moved onto the
// instrument's own tuning) and --curve (a bundle with one layer per note, the curve given).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { readHki, writeHki } = await import('../../packages/shared/src/hki.ts');
const { timbreCutoff, findPerceptualOnset, bakeOnsetFade, TIMBRE_LOWPASS_Q_DB, TIMBRE_MIN_HZ } = await import('../../packages/engine/src/samples-engine.ts');
const { kWeightingCoeffs, applyBiquadInPlace } = await import('../../packages/analysis/src/k-weighting.js');
const { SR, Q_DB, TRUTH, NOTES, layeredBundle, lowpass, unwav } = await import('./synth.mjs');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = path.join(REPO, 'apps/analyzer/cli/hki-timbre.mjs');

let checks = 0;
const ok = (label) => { checks++; console.log('  ✓ ' + label); };
const near = (a, b, tol, label) => assert.equal(Math.abs(a - b) <= tol, true, label + ': ' + a + ' vs ' + b + ' (±' + tol + ')');
near(Q_DB, TIMBRE_LOWPASS_Q_DB, 1e-9, 'the gate\'s lowpass Q is the engine\'s');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkl-hki-timbre-'));
const run = (...args) => spawnSync('node', ['--max-old-space-size=1024', TOOL, ...args], { encoding: 'utf8' });
try {
  const inPath = path.join(dir, 'in.hki'), outPath = path.join(dir, 'out.hki'), reportPath = path.join(dir, 'report.json');
  const source = layeredBundle();
  fs.writeFileSync(inPath, writeHki(source));

  // ── A: a dry run reports and writes nothing ──
  const dry = run(inPath);
  assert.equal(dry.status, 0, 'dry run: ' + dry.stderr);
  assert.equal(fs.existsSync(outPath), false);
  assert.match(dry.stderr, /dry run/);
  console.log(dry.stderr.trim().split('\n').map((l) => '    | ' + l).join('\n'));
  ok('without --out the tool reports the fit and writes no bundle');

  // ── B: the curve it recovers ──
  const r = run(inPath, '--out', outPath, '--report', reportPath);
  assert.equal(r.status, 0, 'hki-timbre ran: ' + r.stderr);
  const out = readHki(new Uint8Array(fs.readFileSync(outPath)));
  const t = out.manifest.timbre;
  assert.equal(t.type, 'lowpass12');
  assert.equal(t.points.length, 5, 'one point per lower layer and one for the top');
  [24, 48, 72, 96].forEach((vel, i) => {
    near(t.points[i].gainDb, TRUTH[vel].db, 0.5, 'layer ' + vel + ' passband gain');
    near(Math.log2(t.points[i].cutoffHz / TRUTH[vel].fc), 0, Math.log2(1.06), 'layer ' + vel + ' cutoff, in octaves');
  });
  assert.deepEqual(t.points[4], { gainDb: 0, cutoffHz: 20000 }, 'the top layer is the open end of the curve');
  near(Math.log2(timbreCutoff(t, Math.pow(10, -8.5 / 20)) / 1600), 0, Math.log2(1.06), 'the engine reads 1600 Hz at −8.5 dB');
  ok('known lowpasses at 350 / 800 / 1600 / 5000 Hz and −22 / −14 / −8.5 / −3.5 dB are recovered within 6 % and 0.5 dB, despite differing start offsets');

  // ── C: the bundle it writes ──
  assert.equal(out.manifest.instrumentKey, 'synth-5layer-curve');
  assert.equal(out.manifest.name, 'Synthetic piano (brightness curve)');
  assert.equal(out.manifest.samples.length, NOTES.length, 'one sample per note');
  for (const s of out.manifest.samples) {
    assert.equal('vel' in s, false, s.name + ' is a single-layer sample');
    const src = source.manifest.samples.find((q) => q.name === s.name && q.vel === 120);
    assert.equal(s.file, src.file);
    assert.equal(s.gain, src.gain, s.name + ': its one gain is the top layer\'s gain');
    assert.equal('gainLevel' in s, false, s.name + ': no second gain');
    assert.deepEqual(out.audio[s.file], source.audio[src.file], s.name + ': the top layer\'s audio is kept byte for byte');
  }
  assert.equal(Object.keys(out.audio).length, NOTES.length, 'no other audio is carried');
  for (const k of ['loop', 'decays', 'releaseTime', 'volume']) assert.equal(out.manifest[k], source.manifest[k]);
  assert.equal(out.provenance.source, 'gate', 'the source bundle\'s provenance is kept');
  assert.equal(out.provenance.timbre.source, 'in.hki');
  assert.equal(out.provenance.timbre.layers.length, 4);
  assert.deepEqual([out.provenance.timbre.makeup.match, out.provenance.timbre.makeup.sonesNotes], ['sones', NOTES.length], 'the record says how the add-back was matched');
  for (const l of out.provenance.timbre.layers) assert.equal(l.spectrumErrorDb < 1, true, 'layer ' + l.vel + ' fit error ' + l.spectrumErrorDb);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.rebuilt.length, NOTES.length * 4, 'every lower layer of every note is rebuilt and scored');
  for (const q of report.rebuilt) {
    assert.equal(q.correlation > 0.995, true, q.name + ' v' + q.vel + ' rebuilt correlation ' + q.correlation);
    assert.equal(Math.abs(q.levelErrorDb) < 0.6, true, q.name + ' v' + q.vel + ' level error ' + q.levelErrorDb);
  }
  ok('the output holds each note\'s top layer\'s audio unchanged, one gain per note, the curve, and a record of the fit; every rebuilt layer matches its source');

  // ── G: what the filter takes from each note, to be put back ──
  // Recomputed here from the written bundle and the source's manifest alone. The level part:
  // what the engine plays of a note (from its onset at the note's gain, with the engine's
  // onset fade) through the lowpass at a cutoff of the list, measured K-weighted over the
  // first 400 ms. The loudness part: each source layer's gain over its gainLevel, against the
  // top layer's, at that layer's fitted cutoff, read linearly in dB against log frequency,
  // held under the lowest and 0 at the open end. Filtered level plus the stored add-back must
  // be the unfiltered level plus the loudness part.
  const kc = kWeightingCoeffs(SR);
  const kLevelDb = (seg) => { const y = Float64Array.from(seg); applyBiquadInPlace(y, kc.pre); applyBiquadInPlace(y, kc.rlb); let e = 0; for (const v of y) e += v * v; return 10 * Math.log10(e / y.length); };
  const loudness = (src, curve) => (name, f) => {
    const row = (vel) => src.manifest.samples.find((q) => q.name === name && q.vel === vel);
    if (!row(120).gainLevel) return 0;
    const over = (q) => 20 * Math.log10(q.gain / q.gainLevel), top = over(row(120));
    const pts = [24, 48, 72, 96].map((vel, i) => ({ hz: curve.points[i].cutoffHz, db: over(row(vel)) - top })).concat({ hz: 20000, db: 0 });
    if (f <= pts[0].hz) return pts[0].db;
    let i = 1; while (i < pts.length - 1 && f > pts[i].hz) i++;
    return pts[i - 1].db + (pts[i].db - pts[i - 1].db) * Math.log(f / pts[i - 1].hz) / Math.log(pts[i].hz / pts[i - 1].hz);
  };
  /* Checks one written bundle against `want(name, hz)`, the loudness part it should hold. */
  const checkMakeup = (bundle, want, label) => {
    const hz = bundle.manifest.timbre.makeupHz;
    assert.equal(Array.isArray(hz) && hz.length >= 2, true, label + ': timbre.makeupHz is a list');
    assert.equal(hz[0] <= TIMBRE_MIN_HZ * 0.8, true, label + ': the list starts under the lowest cutoff the engine sets (' + hz[0] + ' Hz)');
    assert.equal(hz[hz.length - 1], 20000, label + ': and ends at the open end of the curve');
    for (let i = 1; i < hz.length; i++) near(Math.log2(hz[i] / hz[i - 1]), 1 / 6, 1e-3, label + ': a 1/6-octave list');
    let worst = 0, most = 0, loud = 0;
    for (const s of bundle.manifest.samples) {
      const m = s.timbreMakeupDb;
      assert.equal(Array.isArray(m) && m.length === hz.length, true, label + ' ' + s.name + ': one add-back per cutoff');
      const x = unwav(bundle.audio[s.file]), on = findPerceptualOnset(x, SR, s.gain);
      bakeOnsetFade({ numberOfChannels: 1, length: x.length, sampleRate: SR, getChannelData: () => x }, on);
      const seg = x.subarray(on, on + Math.round(0.4 * SR)), base = kLevelDb(seg);
      for (let i = 0; i < hz.length; i += 4) {
        const err = kLevelDb(lowpass(seg, hz[i])) + m[i] - base - want(s.name, hz[i]);
        worst = Math.max(worst, Math.abs(err));
        near(err, 0, 0.02, label + ' ' + s.name + ' at ' + hz[i] + ' Hz: filtered level plus the add-back, against the unfiltered level plus the loudness part');
      }
      for (let i = 1; i < m.length; i++) assert.equal(m[i] <= m[i - 1] + 0.011, true, label + ' ' + s.name + ': a wider filter never needs more put back (' + hz[i] + ' Hz)');
      near(m[m.length - 1], 0, 0.1, label + ' ' + s.name + ': almost nothing to put back at 20 kHz');
      most = Math.max(most, m[0]); loud = Math.max(loud, Math.abs(want(s.name, hz[0])));
    }
    assert.equal(most > 20, true, label + ': a low cutoff takes a lot of level from a high note (' + most + ' dB)');
    return { worst, loud };
  };
  const sones = checkMakeup(out, loudness(source, t), 'sones');
  assert.equal(sones.loud > 0.3, true, 'the source\'s two gains differ, so the loudness part is there to be checked (' + sones.loud.toFixed(2) + ' dB)');
  const rep = JSON.parse(fs.readFileSync(reportPath, 'utf8')).makeup;
  assert.equal(rep.length, NOTES.length, 'the report carries every note\'s figures');
  for (const q of rep) {
    assert.equal(q.matched, 'sones', q.name + ': matched in sones');
    assert.equal(Math.abs(q.interpErrDb) < 0.1, true, q.name + ': a straight line between cutoffs of the list is ' + q.interpErrDb + ' dB off');
    assert.equal(q.atPoints.length === 4 && q.atPoints.every((p) => Number.isFinite(p.makeupDb) && Number.isFinite(p.rmsDb) && Math.abs(p.levelDb + p.loudnessDb - p.makeupDb) < 0.011), true, q.name + ': both parts and both measures at each layer\'s cutoff');
  }
  ok('every note carries, for each cutoff of a 1/6-octave list, the K-weighted level its filter takes plus the loudness its source layers\' two gains say that brightness was worth (recomputed here within ' + sones.worst.toFixed(3) + ' dB)');

  // ── G2: --match level puts back the level alone, and the note's gain is its gainLevel ──
  const levelPath = path.join(dir, 'level.hki');
  assert.equal(run(inPath, '--out', levelPath, '--match', 'level').status, 0);
  const lev = readHki(new Uint8Array(fs.readFileSync(levelPath)));
  for (const s of lev.manifest.samples) {
    assert.equal(s.gain, source.manifest.samples.find((q) => q.name === s.name && q.vel === 120).gainLevel, s.name + ': its one gain is the top layer\'s gainLevel');
    assert.equal('gainLevel' in s, false);
  }
  const level = checkMakeup(lev, () => 0, 'level');
  assert.equal(lev.provenance.timbre.makeup.match, 'level');
  assert.notEqual(run(inPath, '--out', path.join(dir, 'x0.hki'), '--match', 'loud').status, 0, 'an unknown --match is refused');
  ok('--match level: every note has one K-weighted level at every cutoff (within ' + level.worst.toFixed(3) + ' dB) and plays at its gainLevel');

  // ── G3: a source that was never re-gained (one gain per row) gets the level part alone ──
  const flat = layeredBundle();
  for (const q of flat.manifest.samples) delete q.gainLevel;
  fs.writeFileSync(path.join(dir, 'flat.hki'), writeHki(flat));
  assert.equal(run(path.join(dir, 'flat.hki'), '--out', path.join(dir, 'flat-out.hki')).status, 0);
  const flatOut = readHki(new Uint8Array(fs.readFileSync(path.join(dir, 'flat-out.hki'))));
  for (const s of flatOut.manifest.samples) assert.equal(s.gain, flat.manifest.samples.find((q) => q.name === s.name && q.vel === 120).gain, s.name + ': gain kept');
  checkMakeup(flatOut, () => 0, 'one gain');
  assert.equal(flatOut.provenance.timbre.makeup.sonesNotes, 0);
  ok('a source with one gain per row keeps the top layer\'s gain and gets the level part alone');

  // ── H: --stretch moves each sample's freq onto the instrument's tuning, and nothing else ──
  const stretchedPath = path.join(dir, 'stretched.hki');
  const rsx = run(inPath, '--out', stretchedPath, '--stretch', '60:-0.3,78:0.4');
  assert.equal(rsx.status, 0, '--stretch ran: ' + rsx.stderr);
  assert.match(rsx.stderr, /stretch: -0\.3 cents per semitone under key 60, 0\.4 over key 78/);
  const sx = readHki(new Uint8Array(fs.readFileSync(stretchedPath)));
  const WANT = { A1: -8.1, A2: -4.5, A3: -0.9, A4: 0, A5: 1.2, A6: 6.0, A7: 10.8 }; // cents: 0.3 per semitone under C4, 0.4 over F#5
  assert.deepEqual(sx.manifest.samples.map((s) => s.name).sort(), Object.keys(WANT).sort(), 'the gate\'s table covers every note');
  for (const s of sx.manifest.samples) {
    const plain = out.manifest.samples.find((q) => q.name === s.name);
    near(1200 * Math.log2(s.freq / plain.freq), WANT[s.name], 1e-9, s.name + ': freq against its claimed pitch, in cents');
    assert.deepEqual({ ...s, freq: plain.freq }, plain, s.name + ': nothing but freq differs from the run without --stretch');
    assert.deepEqual(sx.audio[s.file], out.audio[plain.file], s.name + ': same audio');
  }
  assert.deepEqual(sx.manifest.timbre, out.manifest.timbre, 'the curve and its grid are the same with and without --stretch');
  assert.deepEqual(sx.provenance.timbre.stretch, { lowKey: 60, centsPerSemitoneBelow: -0.3, highKey: 78, centsPerSemitoneAbove: 0.4 });
  assert.equal('stretch' in out.provenance.timbre, false, 'no --stretch, no record of one');
  const sharp = layeredBundle();
  for (const q of sharp.manifest.samples) if (q.name === 'A3') q.freq *= Math.pow(2, 5 / 1200);
  fs.writeFileSync(path.join(dir, 'sharp.hki'), writeHki(sharp));
  const rsharp = run(path.join(dir, 'sharp.hki'), '--out', path.join(dir, 'x3.hki'), '--stretch', '60:-0.3,78:0.4');
  assert.notEqual(rsharp.status, 0); assert.match(rsharp.stderr, /A3.*not a 12-TET pitch/);
  for (const bad of ['60:-0.3', '78:0.4,60:-0.3', 'C4:-0.3,F#5:0.4']) {
    const rb = run(inPath, '--out', path.join(dir, 'x3.hki'), '--stretch', bad);
    assert.notEqual(rb.status, 0, '--stretch ' + bad + ' is refused'); assert.match(rb.stderr, /--stretch/);
  }
  assert.equal(fs.existsSync(path.join(dir, 'x3.hki')), false);
  ok('--stretch 60:-0.3,78:0.4 puts every freq on the curve (−8.1 cents at A1 to +10.8 at A7) and changes nothing else; a freq that is not a 12-TET pitch and three malformed curves are refused, with nothing written');

  // ── D: names, and no overwriting ──
  const again = run(inPath, '--out', outPath);
  assert.notEqual(again.status, 0, 'an existing output is not overwritten');
  const named = path.join(dir, 'named.hki');
  assert.equal(run(inPath, '--out', named, '--key', 'my-piano', '--name', 'My piano').status, 0);
  const nm = readHki(new Uint8Array(fs.readFileSync(named))).manifest;
  assert.deepEqual([nm.instrumentKey, nm.name], ['my-piano', 'My piano']);
  ok('--key and --name set the new instrument\'s identity; an existing file is refused');

  // ── E: bundles it refuses ──
  const single = layeredBundle();
  single.manifest.samples = single.manifest.samples.filter((s) => s.vel === 120).map(({ vel, ...s }) => s);
  single.audio = Object.fromEntries(single.manifest.samples.map((s) => [s.file, single.audio[s.file]]));
  fs.writeFileSync(path.join(dir, 'single.hki'), writeHki(single));
  const rs = run(path.join(dir, 'single.hki'), '--out', path.join(dir, 'x1.hki'));
  assert.notEqual(rs.status, 0); assert.match(rs.stderr, /layer/);
  fs.writeFileSync(path.join(dir, 'loop.hki'), writeHki(layeredBundle({ loop: true, decays: false })));
  const rl = run(path.join(dir, 'loop.hki'), '--out', path.join(dir, 'x2.hki'));
  assert.notEqual(rl.status, 0); assert.match(rl.stderr, /loop/);
  assert.equal(fs.existsSync(path.join(dir, 'x1.hki')) || fs.existsSync(path.join(dir, 'x2.hki')), false);
  ok('a single-layer bundle and a loop instrument are refused, with nothing written');

  // ── I: one layer per note: the curve is given, and the loudness part is read from the note's own audio ──
  const { sustainSones } = await import('../../packages/analysis/src/loudness.js');
  const CURVE = [24, 48, 72, 96].map((vel) => TRUTH[vel].db + ':' + TRUTH[vel].fc).join(',');
  const givenPath = path.join(dir, 'given.hki'), givenReport = path.join(dir, 'given.json');
  const rg = run(path.join(dir, 'single.hki'), '--out', givenPath, '--report', givenReport, '--curve', CURVE);
  assert.equal(rg.status, 0, '--curve on a single-layer bundle ran: ' + rg.stderr);
  assert.match(rg.stderr, /one layer per note: the curve is the one given/);
  const gv = readHki(new Uint8Array(fs.readFileSync(givenPath)));
  assert.deepEqual(gv.manifest.timbre.points, [24, 48, 72, 96].map((vel) => ({ gainDb: TRUTH[vel].db, cutoffHz: TRUTH[vel].fc })).concat({ gainDb: 0, cutoffHz: 20000 }), 'the curve written is the curve given, with the open end added');
  assert.equal(gv.manifest.samples.length, NOTES.length);
  for (const s of gv.manifest.samples) {
    const src = single.manifest.samples.find((q) => q.name === s.name);
    assert.equal(s.gain, src.gain, s.name + ': the note keeps the gain it came with');
    assert.equal('vel' in s || 'gainLevel' in s, false, s.name + ': a single-layer sample with one gain');
    assert.deepEqual(gv.audio[s.file], single.audio[src.file], s.name + ': audio kept byte for byte');
  }
  /* The loudness part, worked out here from the written bundle alone: the filtered note at the open
     note's K-weighted level, in sones, 10 dB per doubling, held under the curve's lowest cutoff. */
  const heard = new Map();
  const fromAudio = (bundle) => (name, f) => {
    const key = name + '@' + f; if (heard.has(key)) return heard.get(key);
    const s = bundle.manifest.samples.find((q) => q.name === name), x = unwav(bundle.audio[s.file]), on = findPerceptualOnset(x, SR, s.gain);
    bakeOnsetFade({ numberOfChannels: 1, length: x.length, sampleRate: SR, getChannelData: () => x }, on);
    const seg = x.subarray(on, on + Math.round(0.4 * SR)), y = Float64Array.from(lowpass(seg, Math.max(f, TRUTH[24].fc)));
    const back = Math.pow(10, (kLevelDb(seg) - kLevelDb(y)) / 20); for (let i = 0; i < y.length; i++) y[i] *= back;
    const v = 10 * Math.log2(sustainSones(seg, SR, 0, seg.length, s.gain).sones / sustainSones(y, SR, 0, y.length, s.gain).sones);
    heard.set(key, v); return v;
  };
  const given = checkMakeup(gv, fromAudio(gv), 'one layer');
  assert.equal(given.loud > 0.3, true, 'a low cutoff changes how loud the level-matched note is, so the loudness part is there to be checked (' + given.loud.toFixed(2) + ' dB)');
  assert.deepEqual([gv.provenance.timbre.curve, gv.provenance.timbre.makeup.sonesNotes, gv.provenance.timbre.layers], ['given', NOTES.length, []]);
  const gr = JSON.parse(fs.readFileSync(givenReport, 'utf8'));
  assert.deepEqual([gr.fits, gr.rebuilt, gr.makeup.length], [[], [], NOTES.length], 'nothing fitted, nothing rebuilt, every note measured');
  const givenLevel = path.join(dir, 'given-level.hki');
  assert.equal(run(path.join(dir, 'single.hki'), '--out', givenLevel, '--curve', CURVE, '--match', 'level').status, 0);
  checkMakeup(readHki(new Uint8Array(fs.readFileSync(givenLevel))), () => 0, 'one layer, level');
  const rlay = run(inPath, '--out', path.join(dir, 'x4.hki'), '--curve', CURVE);
  assert.notEqual(rlay.status, 0, 'a layered bundle is refused with --curve'); assert.match(rlay.stderr, /--curve/);
  for (const bad of ['abc', '-10:0', '0:500', '-8:1600,-14:800', '-14:800,-8:700']) {
    const rb = run(path.join(dir, 'single.hki'), '--out', path.join(dir, 'x4.hki'), '--curve', bad);
    assert.notEqual(rb.status, 0, '--curve ' + bad + ' is refused'); assert.match(rb.stderr, /--curve/);
  }
  assert.equal(fs.existsSync(path.join(dir, 'x4.hki')), false);
  ok('--curve takes a bundle with one layer per note: the curve given is the curve written, each note keeps its gain and audio, and the loudness part is the one worked out here from the note\'s own audio (within ' + given.worst.toFixed(3) + ' dB); --match level leaves the level part alone; a layered bundle and five malformed curves are refused');

  // ── F: the manifest field is validated on read and on write ──
  const curve = t;
  const base = { ...out.manifest };
  const tryWrite = (timbre, samples = base.samples) => writeHki({ manifest: { ...base, timbre, samples }, audio: out.audio });
  assert.deepEqual(readHki(tryWrite(curve)).manifest.timbre, curve, 'a valid curve survives a write and a read');
  for (const [why, bad] of [
    ['an unknown filter type', { type: 'lowpass24', points: curve.points }],
    ['a single point', { type: 'lowpass12', points: [curve.points[0]] }],
    ['no points', { type: 'lowpass12' }],
    ['descending gainDb', { type: 'lowpass12', points: [curve.points[1], curve.points[0]] }],
    ['a cutoff that falls as the level rises', { type: 'lowpass12', points: [{ gainDb: -10, cutoffHz: 900 }, { gainDb: 0, cutoffHz: 800 }] }],
    ['a cutoff of 0', { type: 'lowpass12', points: [{ gainDb: -10, cutoffHz: 0 }, { gainDb: 0, cutoffHz: 800 }] }],
    ['a point with no cutoff', { type: 'lowpass12', points: [{ gainDb: -10 }, { gainDb: 0, cutoffHz: 800 }] }],
    ['a string', 'lowpass12'],
  ]) assert.throws(() => tryWrite(bad), /timbre/, why + ' is refused');
  /* A curve is not valid without the level to put back: the grid, and a list on every sample. */
  const { makeupHz: _grid, ...noGrid } = curve;
  const first = (change) => base.samples.map((q, i) => (i === 0 ? change(q) : q));
  for (const [why, badTimbre, badSamples] of [
    ['a curve with no makeupHz', noGrid],
    ['a makeupHz that does not ascend', { ...curve, makeupHz: [...curve.makeupHz].reverse() }],
    ['a makeupHz with a cutoff of 0', { ...curve, makeupHz: [0, ...curve.makeupHz.slice(1)] }],
    ['a single-entry makeupHz', { ...curve, makeupHz: [1000] }],
    ['a sample with no timbreMakeupDb', curve, first(({ timbreMakeupDb: _m, ...q }) => q)],
    ['a timbreMakeupDb of the wrong length', curve, first((q) => ({ ...q, timbreMakeupDb: q.timbreMakeupDb.slice(1) }))],
    ['a timbreMakeupDb entry that is not a number', curve, first((q) => ({ ...q, timbreMakeupDb: q.timbreMakeupDb.map((v, i) => (i === 3 ? null : v)) }))],
  ]) assert.throws(() => tryWrite(badTimbre, badSamples), /timbre/i, why + ' is refused');
  const { timbre: _gone, ...plain } = base;
  assert.equal('timbre' in readHki(writeHki({ manifest: plain, audio: out.audio })).manifest, false, 'a bundle without a curve has none');
  ok('manifest.timbre: a valid curve round-trips; eight malformed ones are refused, and seven with the level to put back missing or malformed; absent stays absent');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\nhki-timbre: ' + checks + ' checks passed');
