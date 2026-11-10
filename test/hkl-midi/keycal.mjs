// Hardware-free gate for the built-in key / aftertouch calibration (Lumatone firmware 1.5.0+).
// Run with the repo's .js → .ts resolution hook:
// node --import ./test/orchestrator-smoke/register-ts.mjs test/hkl-midi/keycal.mjs
//
// Drives the real lumatone/keycal.ts + sysex.ts + sync.ts against a scripted device that
// answers as LumatoneController 1.5.0 does (decodeMidiMessage, read from the binary):
// 24h / 0Fh (11 bytes, board 0) enter key / aftertouch calibration; while either runs,
// every command but 52h is answered STATE (4); 52h (board 0-5, value 0/1) is ACKed in a
// calibration mode and NACKed outside one; the mode returns to normal only once every
// board has reported back, which the model delays by a number of further requests.
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k),
};

const { midi } = await import('../../apps/hkl/src/state/midi.ts');
const { lumatone } = await import('../../apps/hkl/src/state/lumatone.ts');
const { selection } = await import('../../apps/hkl/src/state/selection.ts');
const { sysex } = await import('../../apps/hkl/src/lumatone/sysex.ts');
const { syncLumatoneColors, syncLumatoneHover } = await import('../../apps/hkl/src/lumatone/sync.ts');
const { lumatoneCell } = await import('../../apps/hkl/src/layout/physical.ts');
const { keyColorHex } = await import('../../apps/hkl/src/render/colors.ts');
const keycal = await import('../../apps/hkl/src/lumatone/keycal.ts');
const { startKeyCal, endKeyCal, adoptKeyCal, keyCalDeviceGone, keyCalStatus, onKeyCalChange,
        KEYCAL_REPLY_TIMEOUT_MS, KEYCAL_MODE_POLL_MS, KEYCAL_MODE_POLL_TRIES } = keycal;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = () => Array.from({ length: 280 }, (_, i) => { const [q, r] = lumatoneCell(i); return keyColorHex(q, r); });
const keyOf = (i) => { const [q, r] = lumatoneCell(i); return q + ',' + r; };

/* ── the scripted device ── */
const dev = { mode: 0, fw: [1, 5, 0], lag: 0, leaveIn: -1, silent: false, saved: null };
let sent = [];
function answer(m) {
  const board = m[4], cmd = m[5];
  /* boards report back between requests: the mode drops to normal `lag` requests after 52h */
  if (dev.leaveIn >= 0 && cmd !== 0x52) { if (dev.leaveIn === 0) { dev.mode = 0; dev.leaveIn = -1; } else dev.leaveIn--; }
  if ((dev.mode === 1 || dev.mode === 2) && cmd !== 0x52) return [4];
  if (dev.mode === 5 && cmd !== 0x38) return [4];
  switch (cmd) {
    case 0x24: case 0x0F:
      if (m.length !== 11 || board !== 0) return [3];
      dev.mode = cmd === 0x24 ? 1 : 2;
      return [1];
    case 0x52:
      if (m.length !== 11 || board > 5 || m[6] > 1) return [3];
      if (dev.mode !== 1 && dev.mode !== 2) return [0];
      dev.saved = m[6] === 1;
      dev.leaveIn = dev.lag;
      return [1];
    case 0x31: return [1, ...dev.fw];
    default: return [1];
  }
}
midi.midiOut = { send: (m) => sent.push(m) };
midi.midiIn = {}; // present, so the queue waits for real replies
/* Answer whatever is in flight; a silent device answers nothing. */
function pump() {
  let n = 0;
  while (sysex.inFlight && !dev.silent && n++ < 2000) {
    const m = sysex.inFlight;
    sysex.handleResponse(new Uint8Array([0xF0, 0x00, 0x21, 0x50, m[4], m[5], ...answer(m), 0xF7]));
  }
}
async function until(pred, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    pump();
    if (pred()) return;
    assert(Date.now() - t0 < ms, 'timed out waiting; phase=' + lumatone.keyCal + ' status=' + keyCalStatus());
    await sleep(10);
  }
}
const settled = () => !sysex.inFlight && lumatone.keyCal !== 'starting' && lumatone.keyCal !== 'ending';

function fresh(firmware = [1, 5, 0]) {
  keyCalDeviceGone();
  sysex.cancel(); sent = [];
  Object.assign(dev, { mode: 0, fw: [1, 5, 0], lag: 0, leaveIn: -1, silent: false, saved: null });
  selection.hoverKey = null;
  lumatone.autoSyncEnabled = true;
  lumatone.deviceColors = null;
  lumatone.fixedLayoutSent = false;
  lumatone.firmware = firmware;
  lumatone.hoverMirror = true;
  midi.midiOut = { send: (m) => sent.push(m) };
}
const bytes = (m) => [...m];
const cmds = () => sent.map((m) => m[5]);

let checks = 0;
const ok = (label) => { checks++; console.log('  ✓ ' + label); };
let changes = 0;
onKeyCalChange(() => { changes++; });

// ── A: never started where it could not be ended ──
fresh([1, 4, 0]);
startKeyCal('key');
assert.equal(sent.length, 0, 'nothing sent on 1.4.0');
assert.equal(lumatone.keyCal, 'idle');
assert.match(keyCalStatus(), /1\.5\.0/);
fresh(null);
startKeyCal('aftertouch');
assert.equal(sent.length, 0, 'nothing sent while the firmware version is unknown');
fresh(); midi.midiOut = null;
startKeyCal('key');
assert.equal(lumatone.keyCal, 'idle');
assert.match(keyCalStatus(), /No Lumatone/);
ok('no start on firmware < 1.5.0, unknown firmware, or without a device');

// ── B: key calibration start, color sync held off ──
fresh();
syncLumatoneColors(); await until(settled);
assert.deepEqual(lumatone.deviceColors, base());
sent = []; changes = 0;
startKeyCal('key');
assert.equal(lumatone.keyCal, 'starting');
assert.deepEqual(bytes(sent[0]), [0xF0, 0x00, 0x21, 0x50, 0x00, 0x24, 0x00, 0x00, 0x00, 0x00, 0xF7]);
await until(settled);
assert.equal(lumatone.keyCal, 'key');
assert.equal(dev.mode, 1);
assert(changes >= 2, 'listeners told of starting and running');
sent = [];
selection.hoverKey = keyOf(100); syncLumatoneHover();
lumatone.deviceColors = null; syncLumatoneColors();
assert.equal(sent.length, 0, 'no color traffic while calibrating');
startKeyCal('aftertouch');
assert.equal(sent.length, 0, 'a second start is ignored while one runs');
selection.hoverKey = null;
ok('24h starts key calibration; color sync sends nothing meanwhile');

// ── C: cancel → 52h value 0, wait for normal mode, full re-sync ──
dev.lag = 3;
endKeyCal(false);
assert.equal(lumatone.keyCal, 'ending');
assert.deepEqual(bytes(sent[0]), [0xF0, 0x00, 0x21, 0x50, 0x00, 0x52, 0x00, 0x00, 0x00, 0x00, 0xF7]);
await until(settled);
assert.equal(lumatone.keyCal, 'idle');
assert.equal(dev.saved, false, 'the device was told to discard');
assert.equal(dev.mode, 0);
assert(cmds().filter((c) => c === 0x31).length >= 3, 'polled until the mode gate opened');
assert.equal(cmds().filter((c) => c === 0x55).length, 1, 'one frame after the mode returned');
assert(cmds().indexOf(0x55) > cmds().lastIndexOf(0x31), 'no colors before the gate opened');
assert.deepEqual(lumatone.deviceColors, base(), 'device colors re-synced from scratch');
assert.match(keyCalStatus(), /cancel/i);
ok('Cancel: 52h 0, polls out the STATE gate, then re-syncs every key');

// ── D: aftertouch start, confirm → 52h value 1 ──
fresh();
startKeyCal('aftertouch');
assert.deepEqual(bytes(sent[0]), [0xF0, 0x00, 0x21, 0x50, 0x00, 0x0F, 0x00, 0x00, 0x00, 0x00, 0xF7]);
await until(settled);
assert.equal(lumatone.keyCal, 'aftertouch');
assert.equal(dev.mode, 2);
sent = [];
endKeyCal(true);
assert.deepEqual(bytes(sent[0]), [0xF0, 0x00, 0x21, 0x50, 0x00, 0x52, 0x01, 0x00, 0x00, 0x00, 0xF7]);
await until(settled);
assert.equal(lumatone.keyCal, 'idle');
assert.equal(dev.saved, true, 'the device was told to save');
assert.match(keyCalStatus(), /confirm/i);
ok('0Fh starts aftertouch calibration; Confirm sends 52h 1');

// ── E: a board that never reports back keeps Confirm / Cancel on offer ──
fresh();
startKeyCal('key'); await until(settled);
dev.lag = Infinity; sent = [];
endKeyCal(false);
await until(settled, KEYCAL_MODE_POLL_MS * (KEYCAL_MODE_POLL_TRIES + 4) + 2000);
assert.equal(lumatone.keyCal, 'key', 'still calibrating');
assert.equal(cmds().filter((c) => c === 0x31).length, KEYCAL_MODE_POLL_TRIES);
assert.equal(cmds().filter((c) => c === 0x55).length, 0, 'no colors into a calibrating device');
assert.match(keyCalStatus(), /both/i, 'points at the diagnostic display exit');
dev.mode = 0; dev.leaveIn = -1; sent = []; // the board left on its own meanwhile
endKeyCal(false);
await until(settled);
assert.equal(lumatone.keyCal, 'idle', 'a NACK to 52h means it is already out');
assert.equal(cmds().filter((c) => c === 0x55).length, 1);
ok('stuck board: back to Confirm / Cancel; a later NACK ends it');

// ── F: a device found already calibrating (page reload) is adopted ──
fresh(null);
dev.mode = 1;
sysex.queryFirmware(() => assert.fail('no version from a calibrating device'), adoptKeyCal);
syncLumatoneColors();
await until(settled);
assert.equal(lumatone.keyCal, 'unknown');
assert.equal(lumatone.firmware, null);
sent = [];
syncLumatoneColors();
assert.equal(sent.length, 0, 'sync held off for an adopted calibration');
endKeyCal(false);
await until(settled);
assert.equal(lumatone.keyCal, 'idle');
assert.deepEqual(lumatone.firmware, [1, 5, 0], 'version learned from the mode poll');
assert.equal(cmds().filter((c) => c === 0x55).length, 1, 'frame path once the version is known');
assert.deepEqual(lumatone.deviceColors, base());
ok('connect into a running calibration: adopted, canceled, version recovered');

// ── G: STATE to 52h = some other mode (pedal calibration, demo): let go of it ──
fresh(null);
dev.mode = 5;
sysex.queryFirmware(undefined, adoptKeyCal);
await until(settled);
assert.equal(lumatone.keyCal, 'unknown');
endKeyCal(false);
await until(settled);
assert.equal(lumatone.keyCal, 'idle');
assert.match(keyCalStatus(), /another mode/i);
ok('another mode refuses 52h with STATE: released, not stuck');

// ── H: the device leaves mid-calibration ──
fresh();
startKeyCal('key'); await until(settled);
keyCalDeviceGone();
assert.equal(lumatone.keyCal, 'idle');
ok('departure resets the phase');

// ── I: a start that is never answered, then a device found calibrating ──
fresh();
dev.silent = true; sent = [];
startKeyCal('key');
assert.equal(sent.length, 1);
await sleep(KEYCAL_REPLY_TIMEOUT_MS + 150);
assert.equal(lumatone.keyCal, 'idle', 'gave up waiting');
assert.match(keyCalStatus(), /no reply/i);
sysex.cancel();
dev.silent = false; dev.mode = 1; // it did enter calibration; only the ACK was lost
startKeyCal('key');
await until(settled);
assert.equal(lumatone.keyCal, 'unknown', 'STATE to a start: already in a mode, so offer the way out');
endKeyCal(false);
await until(settled);
assert.equal(lumatone.keyCal, 'idle');
assert.equal(dev.mode, 0);
ok('lost ACK: next Start meets STATE and offers Confirm / Cancel');

console.log(`keycal: ${checks} checks passed`);
