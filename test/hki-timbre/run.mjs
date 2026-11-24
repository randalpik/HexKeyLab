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
// recovers, the bundle it writes, the cases it refuses, and the field's validation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { readHki, writeHki } = await import('../../packages/shared/src/hki.ts');
const { timbreCutoff, TIMBRE_LOWPASS_Q_DB } = await import('../../packages/engine/src/samples-engine.ts');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = path.join(REPO, 'apps/analyzer/cli/hki-timbre.mjs');
const SR = 48000;

let checks = 0;
const ok = (label) => { checks++; console.log('  ✓ ' + label); };
const near = (a, b, tol, label) => assert.equal(Math.abs(a - b) <= tol, true, label + ': ' + a + ' vs ' + b + ' (±' + tol + ')');

/* ── a synthetic layered bundle ── */
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
/* The lowpass a BiquadFilterNode computes (Web Audio: alpha = sin(w0) / (2 · 10^(Q/20))), run
   sample by sample. */
function lowpass(x, fc) {
  const w0 = 2 * Math.PI * fc / SR, c = Math.cos(w0), al = Math.sin(w0) / (2 * Math.pow(10, TIMBRE_LOWPASS_Q_DB / 20));
  const a0 = 1 + al, b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
function tone(f0) {
  const n = Math.round(1.6 * SR), x = new Float64Array(n);
  for (let k = 1; k * f0 < 18000 && k <= 60; k++) {
    const amp = Math.pow(k, -0.7), ph = Math.PI * rnd(), tau = 1.2 / (1 + 0.1 * k), f = k * f0;
    for (let i = 0; i < n; i++) x[i] += amp * Math.sin(2 * Math.PI * f * i / SR + ph) * Math.exp(-i / SR / tau);
  }
  let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) x[i] *= 0.5 / peak;
  return x;
}
function wav(samples) {
  const b = Buffer.alloc(44 + samples.length * 4);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + samples.length * 4, 4); b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(samples.length * 4, 40);
  for (let i = 0; i < samples.length; i++) b.writeFloatLE(samples[i], 44 + i * 4);
  return new Uint8Array(b);
}
/* A capture: `pre` seconds of noise floor, then the note, with noise throughout. */
function capture(note, pre) {
  const p = Math.round(pre * SR), out = new Float32Array(p + note.length);
  for (let i = 0; i < out.length; i++) out[i] = 1e-5 * rnd() + (i >= p ? note[i - p] : 0);
  return out;
}
const TRUTH = { 24: { fc: 350, db: -22 }, 48: { fc: 800, db: -14 }, 72: { fc: 1600, db: -8.5 }, 96: { fc: 5000, db: -3.5 } };
const PRE = { 24: 0.148, 48: 0.161, 72: 0.1456, 96: 0.1508, 120: 0.15 };
const NOTES = [['A1', 55], ['A2', 110], ['A3', 220], ['A4', 440], ['A5', 880], ['A6', 1760], ['A7', 3520]];
function layeredBundle(extra = {}) {
  const samples = [], audio = {};
  for (const [name, f0] of NOTES) {
    const top = tone(f0);
    for (const vel of [24, 48, 72, 96, 120]) {
      const t = TRUTH[vel], note = t ? lowpass(top, t.fc).map((v) => v * Math.pow(10, t.db / 20)) : top;
      const file = 'samples/' + name + '_v' + vel + '.wav';
      audio[file] = wav(capture(note, PRE[vel]));
      samples.push({ name, file, freq: f0, vel, gain: 0.4 + vel / 1000 + f0 / 1e5, gainLevel: 0.6 + vel / 500, trimStart: PRE[vel] - 0.01 });
    }
  }
  return { manifest: { version: 2, instrumentKey: 'synth-5layer', name: 'Synthetic piano', loop: false, decays: true, releaseTime: 0.15, volume: 1, samples, ...extra },
    audio, provenance: { source: 'gate' } };
}

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
    assert.equal(s.gain, src.gain, s.name + ': the top layer\'s gain is kept');
    assert.equal(s.gainLevel, src.gainLevel);
    assert.deepEqual(out.audio[s.file], source.audio[src.file], s.name + ': the top layer\'s audio is kept byte for byte');
  }
  assert.equal(Object.keys(out.audio).length, NOTES.length, 'no other audio is carried');
  for (const k of ['loop', 'decays', 'releaseTime', 'volume']) assert.equal(out.manifest[k], source.manifest[k]);
  assert.equal(out.provenance.source, 'gate', 'the source bundle\'s provenance is kept');
  assert.equal(out.provenance.timbre.source, 'in.hki');
  assert.equal(out.provenance.timbre.layers.length, 4);
  for (const l of out.provenance.timbre.layers) assert.equal(l.spectrumErrorDb < 1, true, 'layer ' + l.vel + ' fit error ' + l.spectrumErrorDb);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.rebuilt.length, NOTES.length * 4, 'every lower layer of every note is rebuilt and scored');
  for (const q of report.rebuilt) {
    assert.equal(q.correlation > 0.995, true, q.name + ' v' + q.vel + ' rebuilt correlation ' + q.correlation);
    assert.equal(Math.abs(q.levelErrorDb) < 0.6, true, q.name + ' v' + q.vel + ' level error ' + q.levelErrorDb);
  }
  ok('the output holds each note\'s top layer unchanged (audio, gain, gainLevel), the curve, and a record of the fit; every rebuilt layer matches its source');

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
  const tryWrite = (timbre) => writeHki({ manifest: { ...base, timbre }, audio: out.audio });
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
  const { timbre: _gone, ...plain } = base;
  assert.equal('timbre' in readHki(writeHki({ manifest: plain, audio: out.audio })).manifest, false, 'a bundle without a curve has none');
  ok('manifest.timbre: a valid curve round-trips; eight malformed ones are refused; absent stays absent');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\nhki-timbre: ' + checks + ' checks passed');
