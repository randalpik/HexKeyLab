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
