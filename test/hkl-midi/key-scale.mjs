// Hardware-free gate for the Lumatone's per-key press-time scale.
// Run with the repo's .js → .ts resolution hook:
// node --import ./test/orchestrator-smoke/register-ts.mjs test/hkl-midi/key-scale.mjs
//
// The firmware reports a key's press time in ticks, and for the same touch a key's
// ticks follow its timing window in sensor counts (docs/lessons.md → "Press time
// follows the timing window"). velocityCal.applyKeyScale multiplies each key's ticks
// by one number per physical key before the velocity curve, so the same touch gives
// the same velocity on every key. HKL makes the numbers itself from the calibration
// the device holds, read over SysEx (lumatone/keyscales.ts): the median timing window
// over each key's own. Checks the transform against a model of the firmware's binning,
// the table's replacement and persistence, the arithmetic (against
// tools/lumatone-cal/keydata-compare.py --scales, which works from saved files, and
// against a saved device folder when one is on this machine), and the read itself
// against a scripted device.
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
const { midi } = await import('../../apps/hkl/src/state/midi.ts');
const { lumatone } = await import('../../apps/hkl/src/state/lumatone.ts');
const { sysex } = await import('../../apps/hkl/src/lumatone/sysex.ts');
const { sysexBoardFor, setBoards34Swapped } = await import('../../apps/hkl/src/lumatone/protocol.ts');
const { computeKeyScales, refreshKeyScales, keyScaleStatus } = await import('../../apps/hkl/src/lumatone/keyscales.ts');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = path.join(REPO, 'tools/lumatone-cal/keydata-compare.py');

let checks = 0;
const ok = (label) => { checks++; console.log('  ✓ ' + label); };
const near = (a, b, tol, label) => assert.equal(Math.abs(a - b) <= tol, true, label + ': ' + a + ' vs ' + b + ' (±' + tol + ')');
const stored = () => JSON.parse(localStorage.getItem('hkl.prefs.v1')).velocityCal;

/* The device, for a press seen between a key's thresholds on `ticks` scans: the board
   sends the count ticks − 1 (it starts at 0), and under the identity LUT the
   controller's bin is the first threshold the count does not exceed, 127 when it
   exceeds them all; bins 126 and 127 both send velocity 1. */
const table = velocityCal.buildIntervalTable();
assert.deepEqual([table[0], table[126]], [0, 126]);
const firmwareRaw = (ticks) => {
  const count = ticks - 1;
  let bin = 127;
  for (let i = 0; i < 127; i++) if (count <= table[i]) { bin = i; break; }
  return Math.max(1, 127 - bin);
};

// ── A: with no scale a key's velocity is untouched ──
velocityCal.setKeyScales({});
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
velocityCal.setKeyScales(scales);
assert.equal(velocityCal.calibratedKeyCount, 3);
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

// ── F: a new table replaces the old one; an entry that is not a key's scale is left out ──
velocityCal.setKeyScales({ '5,55': 2 });
assert.deepEqual({ ...velocityCal.keyScale }, { '5,55': 2 }, 'a new table replaces what was there');
velocityCal.setKeyScales({
  '1,0': 1.5, '-12,5': 1, '6,0': 1, '1,56': 1, '2,1': '2', '2,2': KEY_SCALE_MIN / 2, '2,3': KEY_SCALE_MAX * 2, '2,4': NaN,
});
assert.deepEqual({ ...velocityCal.keyScale }, { '1,0': 1.5 }, 'only a physical key with a scale in range is kept');
ok('setKeyScales: replaces the table; a non-key id or a scale out of range is left out');

// ── G: the table is saved, and nothing that was removed is ──
const saved = stored();
assert.equal(saved.version, 9);
assert.deepEqual(saved.keyScale, { '1,0': 1.5 });
for (const gone of ['perKey', 'intervalCurve', 'stats', 'statsEnabled']) assert.equal(gone in saved, false, gone + ' is not written');
velocityCal.setKeyScales({});
assert.deepEqual(stored().keyScale, {});
assert.equal(velocityCal.calibratedKeyCount, 0);
ok('saved under keyScale (velocityCal v9), with no per-key gain, interval table or statistics');

// ── H: the arithmetic: the median window over each key's window ──
/* Five boards of 56 keys, MIN 0. Board 1's windows run 40…95; the others are 60
   everywhere; two keys are special: one with no window, one narrow enough to be held. */
{
  const board = (maxOf, overhead) => ({ max: Array.from({ length: 56 }, (_, k) => maxOf(k)), min: new Array(56).fill(0), overhead });
  const boards = [board((k) => 58 + k, 18), board(() => 78, 18), board(() => 78, 18), board(() => 78, 18), board(() => 78, 18)];
  boards[2].max[7] = 18;  // window 0: the note-on point is at the timer's start
  boards[3].max[9] = 23;  // window 5: 60 / 5 = 12, over the range
  const r = computeKeyScales(boards);
  assert.equal(r.reference, 60, 'the median of 280 windows (the mean of the middle two)');
  near(r.scales['1,0'], 60 / 40, 1e-12, 'a narrow key: over 1');
  near(r.scales['1,55'], 60 / 95, 1e-12, 'a wide key: under 1');
  assert.equal(r.scales['2,30'], 1, 'a median key keeps its feel');
  assert.deepEqual(r.noWindow, ['3,7'], 'a key with no timing window is named');
  assert.equal('3,7' in r.scales, false, 'and gets no scale');
  assert.deepEqual(r.held, ['4,9']);
  assert.equal(r.scales['4,9'], KEY_SCALE_MAX, 'a scale over the range is held to it');
  assert.equal(Object.keys(r.scales).length, 279);
  /* The thresholds are part of the window: a board with more overhead has shorter windows. */
  boards[4].overhead = 28;
  near(computeKeyScales(boards).scales['5,0'], 60 / 50, 1e-12, 'max + min lo come off every window of the board');
  const none = computeKeyScales(boards.map(() => board(() => 10, 18)));
  assert.deepEqual([none.scales, none.noWindow.length], [{}, 280], 'no key with a window: no scales');
}
ok('computeKeyScales: window = MAX − MIN − (max + min lo); scale = the median window ÷ the key\'s');

// ── I: the same table as keydata-compare.py --scales, under either board map ──
const readFolder = (dir) => {
  const rows = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => l.replace(/,\s*$/, '').split(',').map(Number));
  const byBoard = {};
  for (let b = 1; b <= 5; b++) {
    const kd = rows('KeyData_' + b), th = rows('ThresholdData_' + b).map((r) => r[0]);
    byBoard[b] = { max: kd[0], min: kd[1], overhead: th[0] + th[3] };
  }
  /* What HKL reads: board group g is whichever SysEx board that group is wired to. */
  return [0, 1, 2, 3, 4].map((g) => byBoard[sysexBoardFor(g)]);
};
const sameTable = (mine, theirs, label) => {
  assert.deepEqual(Object.keys(mine).sort(), Object.keys(theirs).sort(), label + ': the same keys');
  /* the tool writes four decimals */
  for (const k of Object.keys(theirs)) near(mine[k], theirs[k], 5.01e-5, label + ', key ' + k);
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkl-key-scale-'));
try {
  const run = path.join(dir, 'run');
  fs.mkdirSync(run);
  /* MAX 60…115 across each board, shifted per board; MIN 0…6; overhead 15 + 14. */
  const maxOf = (b, k) => 60 + k + b, minOf = (b, k) => (b + k) % 7;
  for (let b = 1; b <= 5; b++) {
    const rows = [
      Array.from({ length: 56 }, (_, k) => maxOf(b, k)),
      Array.from({ length: 56 }, (_, k) => minOf(b, k)), new Array(56).fill(1), new Array(56).fill(254),
    ];
    fs.writeFileSync(path.join(run, 'KeyData_' + b), rows.map((r) => r.join(',')).join('\n') + '\n');
    fs.writeFileSync(path.join(run, 'ThresholdData_' + b), [15, 10, 15, 14, 2, 10, 7, 15, 800, 9].join('\n') + '\n');
  }
  for (const [swap, group5] of [[true, 4], [false, 5]]) {
    const out = path.join(dir, swap ? 'swapped.json' : 'standard.json');
    const r = spawnSync('python3', [TOOL, ...(swap ? ['--swap-boards-34'] : []), '--scales', out, run], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'keydata-compare.py --scales ran: ' + r.stderr);
    const data = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(Object.keys(data.scales).length, 280);
    setBoards34Swapped(swap);
    const mine = computeKeyScales(readFolder(run));
    assert.equal(mine.reference, data.referenceWindow, 'the same reference window');
    sameTable(mine.scales, data.scales, swap ? 'boards 3 and 4 swapped' : 'standard board map');
    /* KeyData_5 is the PIC's board 5: the 4th group of keys on a swapped unit. */
    near(mine.scales[group5 + ',10'], mine.reference / (maxOf(5, 10) - minOf(5, 10) - 29), 1e-12, 'KeyData_5 slot 10 is key ' + group5 + ',10');
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  setBoards34Swapped(false);
}
ok('the tool\'s table and HKL\'s agree on all 280 keys, under either board map');

// ── J: a saved device folder and the table the tool made from it (local files) ──
{
  const backups = path.join(REPO, 'tools/lumatone-cal/backups');
  const folder = path.join(backups, 'keydata-20261122-220310'), tableFile = path.join(backups, 'key-scales-20261122-minlo3.json');
  if (fs.existsSync(folder) && fs.existsSync(tableFile)) {
    const data = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
    setBoards34Swapped(data.swapBoards34);
    const mine = computeKeyScales(readFolder(folder));
    setBoards34Swapped(false);
    assert.equal(mine.reference, data.referenceWindow);
    sameTable(mine.scales, data.scales, 'the device folder of 2026-11-22');
    ok('the saved device folder gives the saved table: ' + Object.keys(mine.scales).length + ' keys, reference window ' + mine.reference);
  } else {
    console.log('  – skipped: no saved device folder on this machine (tools/lumatone-cal/backups is local)');
  }
}

// ── K: the read: 19h, 1Ah and 3Ah to every board, and nothing changes unless all answer ──
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nib = (vals) => vals.flatMap((v) => [v >> 4, v & 15]);
  const dev = { sent: [], refuse: null, busyOnce: null, silent: false };
  /* By SysEx board: MAX 70 + board + slot, MIN slot % 4, thresholds min hi 15, min lo 3, max 15. */
  const devMax = (b, k) => 70 + b + k, devMin = (b, k) => k % 4;
  const answer = (m) => {
    const b = m[4], cmd = m[5], keys = [...Array(56).keys()];
    if (dev.busyOnce === cmd) { dev.busyOnce = null; return [2]; }
    if (dev.refuse === cmd) return [4];
    if (cmd === 0x19) return [1, ...nib(keys.map((k) => devMax(b, k)))];
    if (cmd === 0x1A) return [1, ...nib(keys.map((k) => devMin(b, k)))];
    if (cmd === 0x3A) return [1, ...nib([15, 3, 15, 10, 7])];
    return [1];
  };
  midi.midiOut = { send: (m) => dev.sent.push([...m]) };
  midi.midiIn = {};
  const settle = async (ms = 3000) => {
    const t0 = Date.now();
    while (keyScaleStatus().state === 'reading') {
      if (sysex.inFlight && !dev.silent) {
        const m = sysex.inFlight;
        sysex.handleResponse(new Uint8Array([0xF0, 0x00, 0x21, 0x50, m[4], m[5], ...answer(m), 0xF7]));
      } else await sleep(5);
      assert(Date.now() - t0 < ms, 'the read did not settle');
    }
  };
  const expected = () => computeKeyScales([0, 1, 2, 3, 4].map((g) => {
    const b = sysexBoardFor(g), keys = [...Array(56).keys()];
    return { max: keys.map((k) => devMax(b, k)), min: keys.map((k) => devMin(b, k)), overhead: 18 };
  })).scales;

  assert.equal(keyScaleStatus().state, 'none');
  assert.equal(refreshKeyScales(), true);
  assert.equal(keyScaleStatus().state, 'reading');
  await settle();
  assert.equal(keyScaleStatus().state, 'read');
  assert.deepEqual(dev.sent.map((m) => m[4] + ':' + m[5].toString(16)).sort().join(' '),
    [1, 2, 3, 4, 5].flatMap((b) => [b + ':19', b + ':1a', b + ':3a']).sort().join(' '), 'fifteen requests, three per board');
  assert.equal(dev.sent.every((m) => m.length === 11 && m.slice(6, 10).every((x) => x === 0)), true, 'all read-only requests');
  assert.deepEqual({ ...velocityCal.keyScale }, expected());
  assert.equal(keyScaleStatus().count, 280);
  near(keyScaleStatus().max, Math.max(...Object.values(expected())), 1e-12, 'the largest scale');
  assert.deepEqual(stored().keyScale, expected(), 'and saved');

  /* Boards 3 and 4 swapped: group 4 (keys "4,…") is SysEx board 5. */
  setBoards34Swapped(true);
  refreshKeyScales(); await settle();
  near(velocityCal.keyScale['4,10'], expected()['4,10'], 0, 'the swapped map names the keys');
  assert.notEqual(expected()['4,10'], (() => { setBoards34Swapped(false); const v = expected()['4,10']; setBoards34Swapped(true); return v; })());
  setBoards34Swapped(false);
  refreshKeyScales(); await settle();
  const table0 = { ...velocityCal.keyScale };

  /* BUSY is not a refusal: the queue asks again. */
  dev.busyOnce = 0x1A;
  refreshKeyScales(); await settle();
  assert.equal(keyScaleStatus().state, 'read', 'a BUSY reply is retried');

  /* A refusal ends the read, and the table in use stays. */
  velocityCal.setKeyScales({ '1,0': 2 });
  dev.refuse = 0x1A;
  refreshKeyScales(); await settle();
  assert.equal(keyScaleStatus().state, 'failed');
  assert.deepEqual({ ...velocityCal.keyScale }, { '1,0': 2 }, 'a read that did not complete changes nothing');
  dev.refuse = null;
  refreshKeyScales(); await settle();
  assert.deepEqual({ ...velocityCal.keyScale }, table0, 'the next read replaces it');

  /* A device in its calibration routine answers nothing else: no read is started. */
  const before = dev.sent.length;
  lumatone.keyCal = 'key';
  assert.equal(refreshKeyScales(), false);
  lumatone.keyCal = 'idle';
  midi.midiOut = null;
  assert.equal(refreshKeyScales(), false, 'no Lumatone: nothing to read');
  assert.equal(dev.sent.length, before);
  velocityCal.setKeyScales({});
}
ok('refreshKeyScales: three reads per board; BUSY retried; a refusal or a calibration in progress leaves the table alone');

console.log('\nkey-scale: ' + checks + ' checks passed');
