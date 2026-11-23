// Hardware-free gate for the Lumatone's two velocity tables.
// Run with the repo's .js → .ts resolution hook:
// node --import ./test/orchestrator-smoke/register-ts.mjs test/hkl-midi/velocity-tables.mjs
//
// The device keeps its velocity LUT (CMD 08h) and press-time interval table (CMD 20h)
// in RAM and reloads both from the preset file on a power cycle or a preset button
// (docs/lessons.md → "The device ran its preset's velocity tables"). HKL's curve is
// only meaningful over the tables HKL defines, so both are part of the connect-time
// setup batch and of the re-push after a preset switch. Drives the real
// lumatone/sync.ts + lumatone/sysex.ts against a scripted device, and checks the
// decode from a raw velocity back to press-time ticks against a model of the
// firmware's binning.
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.location = { search: '' }; // savePrefs reads it (the ?overlay build saves nothing)
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k),
};

const { midi } = await import('../../apps/hkl/src/state/midi.ts');
const { lumatone } = await import('../../apps/hkl/src/state/lumatone.ts');
const { selection } = await import('../../apps/hkl/src/state/selection.ts');
const { sysex } = await import('../../apps/hkl/src/lumatone/sysex.ts');
const { syncLumatoneColors, syncLumatoneKeyEffects, cancelLumatoneSlide, watchPresetSwitch } =
  await import('../../apps/hkl/src/lumatone/sync.ts');
const { velocityCal } = await import('../../apps/hkl/src/audio/velocityCal.ts');
const { lumatoneCell } = await import('../../apps/hkl/src/layout/physical.ts');

const LUT = 0x08, INTERVALS = 0x20, KEY = 0x00, AT_FLAG = 0x0E, LIGHT_FLAG = 0x07, FRAME = 0x55;

let sent = [];
midi.midiOut = { send: (m) => sent.push(m) };
midi.midiIn = {}; // present, so the queue waits for real ACKs

const reply = (m, status = 1) =>
  sysex.handleResponse(new Uint8Array([0xF0, 0x00, 0x21, 0x50, m[4], m[5], status, 0xF7]));
const drain = () => { while (sysex.inFlight) reply(sysex.inFlight); };
const only = (cmd) => sent.filter((m) => m[5] === cmd);
const marker = () => {
  watchPresetSwitch(new Uint8Array([0xB0, 123, 0]));
  watchPresetSwitch(new Uint8Array([0xB0, 121, 0]));
};

function connect(firmware = [1, 5, 0]) {
  cancelLumatoneSlide();
  sysex.cancel(); sent = [];
  selection.hoverKey = null;
  lumatone.autoSyncEnabled = true;
  lumatone.deviceColors = null;
  lumatone.fixedLayoutSent = false;
  lumatone.firmware = firmware;
  lumatone.keyEffects = true;
  lumatone.keyCal = 'idle';
  syncLumatoneColors();
  drain();
}

/* The two messages, decoded from the wire as the firmware stores them: the LUT by
   bin (bin 0 = the shortest press), the intervals as 127 twelve-bit thresholds. */
function wireLut(m) {
  assert.equal(m.length, 6 + 128 + 1, '08h: header, 128 values, F7');
  assert.equal(m[4], 0, '08h goes to board 0');
  return [...m.slice(6, 134)];
}
function wireIntervals(m) {
  assert.equal(m.length, 6 + 254 + 1, '20h: header, 127 pairs, F7');
  assert.equal(m[4], 0, '20h goes to board 0');
  const out = [];
  for (let i = 0; i < 127; i++) out.push((m[6 + 2 * i] << 6) | m[7 + 2 * i]);
  return out;
}

let checks = 0;
const ok = (label) => { checks++; console.log('  ✓ ' + label); };

// ── A: a connect carries both tables, after the layout and the flags ──
velocityCal.resetIntervalCurve();
connect();
assert.equal(only(LUT).length, 1, 'one 08h in the connect batch');
assert.equal(only(INTERVALS).length, 1, 'one 20h in the connect batch');
const order = sent.map((m) => m[5]);
assert.equal(order.lastIndexOf(KEY) < order.indexOf(AT_FLAG), true);
assert.equal(order.indexOf(LIGHT_FLAG) < order.indexOf(LUT), true, 'tables follow the flags');
assert.equal(order.indexOf(LUT) < order.indexOf(INTERVALS), true);
assert.equal(order.indexOf(INTERVALS) < order.indexOf(FRAME), true, 'colors come last');
const identityByBin = Array.from({ length: 128 }, (_, bin) => Math.max(1, 127 - bin));
assert.deepEqual(wireLut(only(LUT)[0]), identityByBin, 'identity LUT: bin 0 → 127 … bins 126 and 127 → 1');
assert.deepEqual(wireIntervals(only(INTERVALS)[0]), velocityCal.buildIntervalTable(),
  'the interval table is the one velocityCal builds');
assert.deepEqual(velocityCal.buildIntervalTable(), Array.from({ length: 127 }, (_, i) => i + 1),
  'default curve (low 1, high 127, gamma 1): thresholds 1…127, one tick each');
ok('a connect sends the identity LUT and the interval table once each, before the colors');

// ── B: a sync that is not a setup sends neither ──
sent = [];
selection.hoverKey = (() => { const [q, r] = lumatoneCell(0); return q + ',' + r; })();
syncLumatoneKeyEffects();
drain();
assert.equal(sent.length > 0, true, 'the hover did put a frame on the wire');
assert.equal(only(LUT).length + only(INTERVALS).length, 0);
selection.hoverKey = null;
syncLumatoneKeyEffects();
drain();
ok('a color-only sync sends no table');

// ── C: the preset-switch pair pushes both again ──
sent = [];
marker();
drain();
assert.equal(only(LUT).length, 1);
assert.equal(only(INTERVALS).length, 1);
assert.deepEqual(wireLut(only(LUT)[0]), identityByBin);
ok('after a preset switch both tables are pushed again');

// ── D: the pushed interval table follows the curve's settings ──
velocityCal.setIntervalCurveLow(3);
velocityCal.setIntervalCurveHigh(60);
connect();
assert.deepEqual(wireIntervals(only(INTERVALS)[0]), velocityCal.buildIntervalTable());
assert.equal(wireIntervals(only(INTERVALS)[0])[0], 3);
assert.equal(wireIntervals(only(INTERVALS)[0])[126], 60);
ok('the table on the wire is built from the current low / high / gamma');

// ── E: per-key firmware (1.4.0) gets the tables too ──
velocityCal.resetIntervalCurve();
connect([1, 4, 0]);
assert.equal(only(LUT).length, 1);
assert.equal(only(INTERVALS).length, 1);
ok('1.4.0: both tables are in the connect batch');

// ── F: with Auto-sync off nothing is sent ──
sysex.cancel(); sent = [];
lumatone.autoSyncEnabled = false; lumatone.fixedLayoutSent = false; lumatone.deviceColors = null;
syncLumatoneColors();
assert.equal(sent.length, 0);
lumatone.autoSyncEnabled = true;
ok('Auto-sync off: no table, like the rest of the setup');

// ── G: raw velocity → press-time ticks, against the firmware's binning ──
/* The controller's SendMidiKeyStroke: a bisection over the 127 thresholds. A press
   time equal to a threshold takes the index the bisection finds it at, which in a
   run of equal thresholds is one inside the run; any other takes the first
   threshold above it, 127 when there is none. The velocity is the LUT's entry for
   that bin (docs/lessons.md → "Lumatone velocity pipeline", "binary_search on
   duplicates"). */
const firmwareRaw = (ticks, table) => {
  let lo = 0, hi = 126;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid] === ticks) return identityByBin[mid];
    if (table[mid] < ticks) lo = mid + 1; else hi = mid - 1;
  }
  return identityByBin[lo];
};
function decodeHolds(label) {
  const table = velocityCal.buildIntervalTable();
  const reached = new Set();
  for (let t = 0; t <= 400; t++) {
    const raw = firmwareRaw(t, table);
    const range = velocityCal.pressTicks(raw);
    assert(range, label + ': raw ' + raw + ' decodes');
    reached.add(raw);
    assert.equal(range.lo <= t && (range.hi === null || t <= range.hi), true,
      label + ': ' + t + ' ticks → raw ' + raw + ' → ' + range.lo + '…' + range.hi);
  }
  return reached;
}
velocityCal.resetIntervalCurve();
decodeHolds('1…127');
for (let t = 2; t <= 126; t++) {
  assert.deepEqual(velocityCal.pressTicks(firmwareRaw(t, velocityCal.buildIntervalTable())), { lo: t, hi: t },
    'one-tick table: ' + t + ' ticks decodes to itself');
}
assert.equal(velocityCal.pressTicksLabel(127), '≤1');
assert.equal(velocityCal.pressTicksLabel(112), '16');
assert.equal(velocityCal.pressTicksLabel(2), '126');
assert.equal(velocityCal.pressTicksLabel(1), '≥127');
ok('thresholds 1…127: every press time from 2 to 126 ticks decodes to itself');

velocityCal.setIntervalCurveHigh(128);
decodeHolds('1…128');
const t128 = velocityCal.buildIntervalTable();
assert.equal(t128.includes(64), false, 'low 1, high 128 has no threshold at 64');
assert.deepEqual(velocityCal.pressTicks(firmwareRaw(64, t128)), { lo: 64, hi: 65 });
assert.equal(velocityCal.pressTicksLabel(firmwareRaw(65, t128)), '64–65');
ok('low 1, high 128: 64 and 65 ticks share a bin, and the label says so');

velocityCal.setIntervalCurveLow(3);
velocityCal.setIntervalCurveHigh(50);
const repeated = velocityCal.buildIntervalTable();
assert.equal(new Set(repeated).size < 127, true, 'low 3, high 50 repeats thresholds');
const reached = decodeHolds('3…50 (repeated thresholds)');
/* Every tick from 4 to 49 has a run of equal thresholds, and for some of them the
   bisection finds the tick inside the run, not at its start. Whichever bin it is,
   the velocity decodes to that tick alone. */
let insideRun = 0;
for (let t = 4; t <= 49; t++) {
  const raw = firmwareRaw(t, repeated);
  if (raw !== identityByBin[repeated.indexOf(t)]) insideRun++;
  assert.deepEqual(velocityCal.pressTicks(raw), { lo: t, hi: t }, t + ' ticks → raw ' + raw);
}
assert.equal(insideRun > 0, true, 'the bisection lands inside a run for ' + insideRun + ' of the 46 ticks');
assert.equal(reached.size, 50, '3…50 reaches 48 one-tick bins and the two open ends');
ok('repeated thresholds: the velocity the firmware\'s bisection sends decodes to its own tick');
velocityCal.resetIntervalCurve();

// ── H: the overlay finds a voice's strike: its raw velocity and its input velocity ──
/* A voice carries only the musical velocity it sounds at. The overlay shows the
   velocity that goes INTO the Lumatone curve (the hardware velocity after the key's
   scale), and the press time decoded from the raw one. */
velocityCal.noteStrike('0,0', 127, 124.23, 96);
assert.deepEqual(velocityCal.strikeOf('0,0', 96), { raw: 127, input: 124.23 });
assert.equal(velocityCal.strikeOf('0,0', 80), undefined, 'another velocity on that key is not that strike');
assert.equal(velocityCal.strikeOf('1,0', 96), undefined);
assert.equal(velocityCal.inputVelocityLabel(124.23), '124.2', 'a scaled key\'s input velocity keeps one decimal');
assert.equal(velocityCal.inputVelocityLabel(122), '122', 'a whole one is printed whole');
assert.equal(velocityCal.inputVelocityLabel(121.96), '122', 'and one that rounds to whole, whole');
ok('a voice\'s strike gives its raw and input velocities, only for the strike that made it');

console.log('\nvelocity-tables: ' + checks + ' checks passed');
