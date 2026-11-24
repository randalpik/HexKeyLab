// Hardware-free gate for the Lumatone's per-key press-time scale.
// Run with the repo's .js → .ts resolution hook:
// node --import ./test/orchestrator-smoke/register-ts.mjs test/hkl-midi/key-scale.mjs
//
// The firmware reports a key's press time in ticks, and for the same touch a key's
// ticks follow its timing window in sensor counts (docs/lessons.md → "Press time
// follows the timing window"). velocityCal.applyKeyScale multiplies each key's ticks
// by one number per physical key before the velocity curve, so the same touch gives
// the same velocity on every key. The numbers come from a table that
// tools/lumatone-cal/keydata-compare.py --scales writes from saved calibration runs,
// or from a capture pass. Checks the transform against a model of the firmware's
// binning, the import, the persistence, the capture, and the tool's own output.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };
globalThis.location = { search: '' }; // savePrefs reads it (the ?overlay build saves nothing)
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k),
};

const { velocityCal, KEY_SCALE_MIN, KEY_SCALE_MAX } = await import('../../apps/hkl/src/audio/velocityCal.ts');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = path.join(REPO, 'tools/lumatone-cal/keydata-compare.py');

let checks = 0;
const ok = (label) => { checks++; console.log('  ✓ ' + label); };
const near = (a, b, tol, label) => assert.equal(Math.abs(a - b) <= tol, true, label + ': ' + a + ' vs ' + b + ' (±' + tol + ')');
const file = (scales) => ({ format: 'hkl-key-scales', version: 1, scales });
const stored = () => JSON.parse(localStorage.getItem('hkl.prefs.v1')).velocityCal;

/* The device, for a press seen between a key's thresholds on `ticks` scans: the board
   sends the count ticks − 1 (it starts at 0), and under the identity LUT the
   controller's bin is the first threshold the count does not exceed, 127 when it
   exceeds them all; bins 126 and 127 both send velocity 1. */
velocityCal.resetIntervalCurve(); // thresholds 0…126: one count per velocity
const table = velocityCal.buildIntervalTable();
assert.deepEqual([table[0], table[126]], [0, 126]);
const firmwareRaw = (ticks) => {
  const count = ticks - 1;
  let bin = 127;
  for (let i = 0; i < 127; i++) if (count <= table[i]) { bin = i; break; }
  return Math.max(1, 127 - bin);
};

// ── A: with no scale a key's velocity is untouched ──
velocityCal.clearKeyScale();
assert.equal(velocityCal.calibratedKeyCount, 0);
for (let raw = 1; raw <= 127; raw++) assert.equal(velocityCal.applyKeyScale('1,0', raw), raw);
assert.equal(velocityCal.applyKeyScale('1,0', 0), 0, 'velocity 0 stays a note-off');
ok('no scale: every velocity passes through exactly');

// ── B: ticks ↔ velocity round-trips on the one-count table ──
for (let t = 1; t <= 126; t++) {
  assert.equal(firmwareRaw(t), 128 - t, t + ' ticks is velocity 128 − ' + t);
  assert.equal(velocityCal.ticksOf(firmwareRaw(t)), t, t + ' ticks read back');
  assert.equal(velocityCal.velocityForTicks(t), firmwareRaw(t), t + ' ticks → the velocity the firmware sends');
}
assert.equal(velocityCal.velocityForTicks(1.5), 126.5, 'one scan and two have their own velocities, and the map is linear between them');
assert.equal(velocityCal.velocityForTicks(0.25), 127, 'faster than the table: 127');
assert.equal(velocityCal.velocityForTicks(5000), 1, 'slower than the table: 1');
near(velocityCal.velocityForTicks(16.5), 111.5, 1e-9, 'between two thresholds the velocity is fractional');
ok('ticks → velocity is the firmware\'s map on whole ticks and continuous between them');

// ── C: the same touch gives the same velocity on a wide, a median and a narrow key ──
/* Windows of 78, 49 and 13 counts (the widest, median and narrowest keys of the
   2026-11-16 calibration), scaled to the median. A touch that takes `touch` ticks on
   the median key takes touch × window / 49 on another, in whole ticks. */
const WIN = { '1,39': 78, '3,10': 49, '4,18': 13 };
const scales = Object.fromEntries(Object.entries(WIN).map(([k, w]) => [k, 49 / w]));
assert.deepEqual(velocityCal.importKeyScales(file(scales)), { ok: true, count: 3 });
let worstScaled = 0, worstRaw = 0;
for (let touch = 4; touch <= 70; touch++) {
  const eq = {}, raws = {};
  for (const [k, w] of Object.entries(WIN)) {
    const ticks = Math.round(touch * w / 49);
    raws[k] = firmwareRaw(ticks);
    eq[k] = velocityCal.applyKeyScale(k, raws[k]);
    /* Whole ticks cost half a tick of the key's own time: half its scale after scaling. */
    near(128 - eq[k], touch, 0.5 * scales[k] + 1e-9, 'touch ' + touch + ' on ' + k);
  }
  worstScaled = Math.max(worstScaled, Math.max(...Object.values(eq)) - Math.min(...Object.values(eq)));
  worstRaw = Math.max(worstRaw, Math.max(...Object.values(raws)) - Math.min(...Object.values(raws)));
}
assert.equal(worstScaled <= 0.5 * (49 / 13) + 0.5 * (49 / 78) + 1e-9, true, 'scaled keys agree to their tick rounding: ' + worstScaled);
assert.equal(worstRaw >= 80, true, 'unscaled, the same touch is ' + worstRaw + ' velocity steps apart');
ok('one touch, three windows: within ' + worstScaled.toFixed(2) + ' velocity steps scaled, ' + worstRaw + ' unscaled');

// ── D: order is kept, and the ends clamp ──
for (const k of Object.keys(WIN)) {
  let prev = Infinity;
  for (let ticks = 1; ticks <= 400; ticks++) {
    const v = velocityCal.applyKeyScale(k, firmwareRaw(ticks));
    assert.equal(v <= prev && v >= 1 && v <= 127, true, k + ': ' + ticks + ' ticks → ' + v + ' after ' + prev);
    prev = v;
  }
}
assert.equal(velocityCal.applyKeyScale('1,39', 127), 127, 'a wide key\'s fastest press is 127');
near(velocityCal.applyKeyScale('4,18', 127), 128 - 49 / 13, 1e-9, 'a narrow key\'s fastest press: one tick, scaled');
assert.equal(velocityCal.applyKeyScale('4,18', firmwareRaw(60)), 1, 'scaled past the table\'s end: 1');
assert.equal(velocityCal.applyKeyScale('2,2', 77), 77, 'a key with no entry is untouched');
ok('a slower press is never louder; the fastest and slowest clamp to 127 and 1');

// ── E: the scaled velocity feeds the curve as it is, fraction included ──
const a = velocityCal.applyInputCurve(velocityCal.applyKeyScale('4,18', firmwareRaw(4)));
const b = velocityCal.applyInputCurve(velocityCal.applyKeyScale('3,10', firmwareRaw(15)));
near(a, b, 2, 'narrow key at 4 ticks ≈ median key at 15 ticks, in musical velocity');
assert.equal(Number.isInteger(a) && a >= 1 && a <= 127, true, 'the curve still returns a whole velocity');
ok('through the curve: a narrow key at 4 ticks lands with the median key at 15');

// ── F: import replaces the table, and refuses a file that is not one ──
assert.deepEqual(velocityCal.importKeyScales(file({ '5,55': 2 })), { ok: true, count: 1 });
assert.deepEqual({ ...velocityCal.keyScale }, { '5,55': 2 }, 'an import replaces what was there');
for (const [label, bad] of [
  ['not an object', 'x'],
  ['another format', { format: 'something-else', version: 1, scales: { '1,0': 1 } }],
  ['a newer version', { format: 'hkl-key-scales', version: 2, scales: { '1,0': 1 } }],
  ['no scales', { format: 'hkl-key-scales', version: 1 }],
  ['empty scales', file({})],
  ['a key that is not ch,note', file({ '1,0': 1, '-12,5': 1 })],
  ['board 6', file({ '6,0': 1 })],
  ['key 56', file({ '1,56': 1 })],
  ['a scale that is not a number', file({ '1,0': '2' })],
  ['a scale below the range', file({ '1,0': KEY_SCALE_MIN / 2 })],
  ['a scale above the range', file({ '1,0': KEY_SCALE_MAX * 2 })],
]) {
  const r = velocityCal.importKeyScales(bad);
  assert.equal(r.ok, false, label + ' is refused');
  assert.equal(typeof r.error, 'string');
  assert.deepEqual({ ...velocityCal.keyScale }, { '5,55': 2 }, label + ': the table in use is untouched');
}
ok('import: a well-formed file replaces the table; eleven malformed ones change nothing');

// ── G: the table is saved, with no per-key gain ──
assert.equal(stored().version, 8);
assert.deepEqual(stored().keyScale, { '5,55': 2 });
assert.equal('perKey' in stored(), false, 'the old per-key gain is not written');
velocityCal.clearKeyScale();
assert.deepEqual(stored().keyScale, {});
assert.equal(velocityCal.calibratedKeyCount, 0);
ok('saved under keyScale with no perKey (velocityCal v8); Clear empties it');

// ── H: a capture pass sets a key's scale from its median press time ──
velocityCal.startCapture();
for (const ticks of [19, 20, 20, 21, 60]) velocityCal.recordSample('2,3', firmwareRaw(ticks));
velocityCal.recordSample('2,4', firmwareRaw(10));
assert.equal(velocityCal.stopCaptureAndCompute(firmwareRaw(10)), 2);
near(velocityCal.keyScale['2,3'], 0.5, 1e-9, 'median 20 ticks, target 10: half');
near(velocityCal.keyScale['2,4'], 1, 1e-9, 'already at the target: 1');
assert.equal(velocityCal.applyKeyScale('2,3', firmwareRaw(20)), firmwareRaw(10), 'the captured touch now reads as the target');
velocityCal.startCapture();
velocityCal.recordSample('2,3', firmwareRaw(126));
velocityCal.stopCaptureAndCompute(firmwareRaw(1));
assert.equal(velocityCal.keyScale['2,3'], KEY_SCALE_MIN, 'a capture is held to the same range as an import');
velocityCal.clearKeyScale();
ok('capture: scale = target press time ÷ the key\'s median press time');

// ── I: keydata-compare.py --scales writes a file this import takes ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkl-key-scale-'));
try {
  const run = path.join(dir, 'run');
  fs.mkdirSync(run);
  /* MAX 60…115 across each board, shifted per board; MIN 0; overhead 15 + 14. */
  const maxOf = (b, k) => 60 + k + b;
  for (let b = 1; b <= 5; b++) {
    const rows = [
      Array.from({ length: 56 }, (_, k) => maxOf(b, k)),
      new Array(56).fill(0), new Array(56).fill(1), new Array(56).fill(254),
    ];
    fs.writeFileSync(path.join(run, 'KeyData_' + b), rows.map((r) => r.join(',')).join('\n') + '\n');
    fs.writeFileSync(path.join(run, 'ThresholdData_' + b), [15, 10, 15, 14, 2, 10, 7, 15, 800, 9].join('\n') + '\n');
  }
  const windows = [];
  for (let b = 1; b <= 5; b++) for (let k = 0; k < 56; k++) windows.push(maxOf(b, k) - 29);
  windows.sort((x, y) => x - y);
  const median = (windows[139] + windows[140]) / 2;
  for (const [swap, group5] of [[true, 4], [false, 5]]) {
    const out = path.join(dir, swap ? 'swapped.json' : 'standard.json');
    const r = spawnSync('python3', [TOOL, ...(swap ? ['--swap-boards-34'] : []), '--scales', out, run], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'keydata-compare.py --scales ran: ' + r.stderr);
    const data = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(data.format, 'hkl-key-scales');
    assert.equal(data.version, 1);
    assert.equal(data.referenceWindow, median);
    assert.equal(data.swapBoards34, swap);
    assert.equal(Object.keys(data.scales).length, 280);
    /* KeyData_5 is the PIC's board 5: the 4th group of keys on a swapped unit. */
    near(data.scales[group5 + ',10'], median / (maxOf(5, 10) - 29), 1e-4, 'KeyData_5 slot 10 is key ' + group5 + ',10');
    near(data.scales['1,0'], median / (maxOf(1, 0) - 29), 1e-4, 'KeyData_1 slot 0 is key 1,0');
    assert.deepEqual(velocityCal.importKeyScales(data), { ok: true, count: 280 });
    assert.equal(velocityCal.calibratedKeyCount, 280);
  }
  const again = spawnSync('python3', [TOOL, '--scales', path.join(dir, 'standard.json'), run], { encoding: 'utf8' });
  assert.notEqual(again.status, 0, '--scales does not overwrite a file');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  velocityCal.clearKeyScale();
}
ok('the tool\'s table: median window ÷ each key\'s window, keyed by board group under either board map, importable');

console.log('\nkey-scale: ' + checks + ' checks passed');
