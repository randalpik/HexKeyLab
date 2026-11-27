#!/usr/bin/env node
// Deterministic unit test for the raw-takes export (pure logic, no audio device):
// buildRawBundle writes every take in the capture store exactly as recorded, as a valid
// .hki, so that cleaning (de-whine, noise reduction) can be redone or changed later.
//
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/orchestrator-smoke/raw-export-test.mjs
//
// The cleaned export keeps only what its cleaning leaves: a notch that took a note's
// fundamental (docs/lessons.md, 2026-11-26) could not be undone, because the recordings
// themselves were gone when the tab closed.

import assert from 'node:assert/strict';
import { putCapture, clearCaptures } from '../../apps/orchestrator/src/capture/store.ts';
import { buildRawBundle, buildBundle } from '../../apps/orchestrator/src/analysis/buildHki.ts';
import { readHki, writeHki } from '../../packages/shared/src/hki.ts';

const SR = 48000;
let checks = 0;
const ok = (label) => { checks++; console.log('  ok: ' + label); };
let seed = 12345;
const rnd = () => { seed = (1103515245 * seed + 12345) >>> 0; return seed / 0xffffffff * 2 - 1; };
function take(f0, seconds, channels) {
  const n = Math.round(seconds * SR), on = Math.round(0.2 * SR);
  return Array.from({ length: channels }, (_, c) => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0.0005 * Math.sin(2 * Math.PI * 660 * i / SR) + 0.001 * rnd();
      if (i >= on) v += (c ? 0.2 : 0.4) * Math.exp(-(i - on) / (0.3 * SR)) * Math.sin(2 * Math.PI * f0 * (i - on) / SR + c);
      x[i] = v;
    }
    return x;
  });
}
function unwavAll(bytes) {   // float32 WAV → { sr, channels[] }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ch = dv.getUint16(22, true), sr = dv.getUint32(24, true), bits = dv.getUint16(34, true), len = dv.getUint32(40, true);
  assert.equal(dv.getUint16(20, true), 3, 'IEEE float WAV'); assert.equal(bits, 32);
  const n = len / 4 / ch, out = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[c][i] = dv.getFloat32(44 + 4 * (i * ch + c), true);
  return { sr, channels: out };
}
const freq = (m) => 440 * Math.pow(2, (m - 69) / 12);
const job = (m, v) => ({ captureId: `${m}_v${v}`, midi: m, freq: freq(m), velocity: v });
const gate = (pass, flags = []) => ({ pass, flags, peakDb: -8, noiseFloorDb: -60, snrDb: 52, durSec: 1, driftCents: 0 });

clearCaptures();
const recs = { '60_v120': take(freq(60), 1.0, 1), '61_v120': take(freq(61), 1.0, 2), '62_v120': take(freq(62), 0.8, 1) };
for (const [id, channels] of Object.entries(recs)) putCapture(id, { channels, sampleRate: SR });
const outcomes = [
  { job: job(60, 120), gate: gate(true), gain: 2, postGainNoiseDb: -60, retried: false },
  { job: job(61, 120), gate: gate(true), gain: 2, postGainNoiseDb: -60, retried: true },
  { job: job(62, 120), gate: gate(false, ['quiet']), gain: 9, postGainNoiseDb: -30, retried: true },
  { job: job(63, 120), gate: gate(true), gain: 2, postGainNoiseDb: -60, retried: false },   // an outcome whose recording is gone
];
const config = { instrumentKey: 'piano', displayName: 'Piano', lowMidi: 60, highMidi: 63, semitoneStride: 1, probeNote: 60, holdMs: 150 };
const whine = { detectedHz: [540, 660, 4423, 15623], notchedHz: [4423, 15623] };

const { bundle, takeCount } = buildRawBundle(outcomes, config, 'device', whine);
assert.equal(takeCount, 3);
assert.deepEqual([bundle.manifest.instrumentKey, bundle.manifest.name], ['piano-raw', 'Piano (raw takes)']);
assert.deepEqual(bundle.manifest.samples.map((s) => s.name), ['C4', 'C#4', 'D4']);
ok('every take with a recording is in the bundle, the failed one included; an outcome with no recording is left out');

for (const s of bundle.manifest.samples) {
  const id = { C4: '60_v120', 'C#4': '61_v120', D4: '62_v120' }[s.name], w = unwavAll(bundle.audio[s.file]);
  assert.equal(w.sr, SR); assert.equal(w.channels.length, recs[id].length, s.name + ': every channel kept');
  for (let c = 0; c < w.channels.length; c++) assert.deepEqual(w.channels[c], recs[id][c], s.name + ' channel ' + c + ': sample for sample as recorded');
  assert.deepEqual(Object.keys(s).sort(), ['file', 'freq', 'name'], s.name + ': no gain, no trim, no layer tag on a single take');
  assert.equal(s.freq, freq({ C4: 60, 'C#4': 61, D4: 62 }[s.name]));
}
ok('each take is stored sample for sample as recorded, with all its channels, and carries no gain or trim');

const cleaned = buildBundle(outcomes.slice(0, 2), config, 'device', [660]).bundle;
const rawC4 = unwavAll(bundle.audio['samples/C4_v120.wav']).channels[0], cleanC4 = unwavAll(cleaned.audio['samples/C4_v120.wav']).channels[0];
let diff = 0; for (let i = 0; i < rawC4.length; i++) diff = Math.max(diff, Math.abs(rawC4[i] - cleanC4[i]));
assert.equal(diff > 1e-4, true, 'the cleaned export of the same take is a different signal (' + diff + ')');
ok('the cleaned export of the same take differs from it, so the two exports are not the same thing');

const raw = bundle.provenance.raw;
assert.deepEqual(raw.whine, whine);
assert.equal(raw.holdMs, 150);
assert.deepEqual(raw.takes.map((t) => [t.name, t.velocity, t.channels, t.pass, t.flags, t.retried]), [['C4', 120, 1, true, [], false], ['C#4', 120, 2, true, [], true], ['D4', 120, 1, false, ['quiet'], true]]);
ok('provenance records the whine profile (found and notched), the hold time, and each take\'s channels, gate result and retake');

const back = readHki(writeHki(bundle));
assert.deepEqual(back.manifest, bundle.manifest); assert.deepEqual(back.audio['samples/C#4_v120.wav'], bundle.audio['samples/C#4_v120.wav']);
ok('it is a valid .hki: written and read back unchanged');

// two layers of one note are told apart by vel, as in the cleaned export
putCapture('60_v60', { channels: take(freq(60), 0.6, 1), sampleRate: SR });
const two = buildRawBundle([...outcomes, { job: job(60, 60), gate: gate(true), gain: 4, postGainNoiseDb: -50, retried: false }], config, 'device').bundle;
assert.deepEqual(two.manifest.samples.filter((s) => s.name === 'C4').map((s) => [s.vel, s.file]), [[60, 'samples/C4_v60.wav'], [120, 'samples/C4_v120.wav']]);
assert.deepEqual(two.provenance.raw.whine, { detectedHz: [], notchedHz: [] });
clearCaptures();
assert.throws(() => buildRawBundle(outcomes, config, 'device'), /No recorded takes/);
ok('layers of one note carry their velocity; with nothing recorded it refuses');

console.log('\nraw-export: ' + checks + ' checks passed');
