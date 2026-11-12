// Hardware-free gate for the re-sync after a preset switch on the Lumatone.
// Run with the repo's .js → .ts resolution hook:
// node --import ./test/orchestrator-smoke/register-ts.mjs test/hkl-midi/preset-resync.mjs
//
// A preset button reloads the device's key map, key types and colors from the preset,
// board by board, and the firmware ends the switch with All Notes Off then Reset All
// Controllers on channel 1 (B0 7B 00, B0 79 00; docs/lessons.md → "Macro buttons in
// normal mode"). Drives the real lumatone/sync.ts + lumatone/sysex.ts against a scripted
// device that ACKs on command, and checks that the pair, and only the pair, pushes the
// fixed layout, the flags and the colors again.
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k),
};

const { midi } = await import('../../apps/hkl/src/state/midi.ts');
const { lumatone } = await import('../../apps/hkl/src/state/lumatone.ts');
const { selection } = await import('../../apps/hkl/src/state/selection.ts');
const { sysex } = await import('../../apps/hkl/src/lumatone/sysex.ts');
const { syncLumatoneColors, syncLumatoneHover, cancelLumatoneSlide, watchPresetSwitch } =
  await import('../../apps/hkl/src/lumatone/sync.ts');
const { lumatoneCell } = await import('../../apps/hkl/src/layout/physical.ts');
const { keyColorHex, lightenHex, HOVER_LIGHTEN } = await import('../../apps/hkl/src/render/colors.ts');

assert.equal(typeof watchPresetSwitch, 'function', 'lumatone/sync.ts exports watchPresetSwitch');

let sent = [];
midi.midiOut = { send: (m) => sent.push(m) };
midi.midiIn = {}; // present, so the queue waits for real ACKs

const reply = (m, status = 1) =>
  sysex.handleResponse(new Uint8Array([0xF0, 0x00, 0x21, 0x50, m[4], m[5], status, 0xF7]));
const ackInFlight = () => { const m = sysex.inFlight; assert(m, 'something in flight'); reply(m); return m; };
const drain = () => { while (sysex.inFlight) ackInFlight(); };
const count = (cmd) => sent.filter((m) => m[5] === cmd).length;
const bytes = (list) => list.map((m) => [...m]);
const keyOf = (i) => { const [q, r] = lumatoneCell(i); return q + ',' + r; };
const base = () => Array.from({ length: 280 }, (_, i) => { const [q, r] = lumatoneCell(i); return keyColorHex(q, r); });

const feed = (...b) => watchPresetSwitch(new Uint8Array(b));
const marker = () => { feed(0xB0, 123, 0); feed(0xB0, 121, 0); };

/* A connected, fully synced device; returns what the connect put on the wire. */
function synced(firmware) {
  cancelLumatoneSlide();
  sysex.cancel(); sent = [];
  selection.hoverKey = null;
  lumatone.autoSyncEnabled = true;
  lumatone.deviceColors = null;
  lumatone.fixedLayoutSent = false;
  lumatone.firmware = firmware;
  lumatone.hoverMirror = true;
  lumatone.keyCal = 'idle';
  syncLumatoneColors();
  drain();
  const connect = sent;
  sent = [];
  return connect;
}

let checks = 0;
const ok = (label) => { checks++; console.log('  ✓ ' + label); };

// ── A: the pair re-pushes everything a connect pushes (frame path) ──
let connect = synced([1, 5, 0]);
assert.equal(connect.length, 283, 'connect: 280 key writes, 2 flags, 1 frame');
marker();
drain();
assert.deepEqual(bytes(sent), bytes(connect), 'the same messages, in the same order, as a connect');
assert.deepEqual(lumatone.deviceColors, base());
assert.equal(lumatone.fixedLayoutSent, true);
ok('1.5.0: the pair re-pushes the fixed layout, the flags and one frame');

// ── B: the per-key path (firmware < 1.5.0) ──
connect = synced([1, 4, 0]);
assert.equal(connect.length, 562, 'connect: 280 key writes, 2 flags, 280 colors');
marker();
drain();
assert.deepEqual(bytes(sent), bytes(connect));
assert.deepEqual(lumatone.deviceColors, base());
ok('1.4.0: the pair re-pushes the fixed layout, the flags and 280 colors');

// ── C: nothing but the exact pair triggers ──
synced([1, 5, 0]);
const quiet = (label, ...msgs) => {
  for (const m of msgs) feed(...m);
  assert.equal(sent.length, 0, label + ': nothing sent');
  assert.equal(lumatone.fixedLayoutSent, true, label + ': layout still counted as sent');
  assert.deepEqual(lumatone.deviceColors, base(), label + ': color mirror kept');
};
quiet('All Notes Off alone', [0xB0, 123, 0]);
quiet('a note between the two', [0x90, 10, 100]);       // disarms the 7B above
quiet('Reset All Controllers alone', [0xB0, 121, 0]);
quiet('interrupted pair', [0xB0, 123, 0], [0x90, 10, 100], [0xB0, 121, 0]);
quiet('reversed pair', [0xB0, 121, 0], [0xB0, 123, 0]);
feed(0x80, 10, 0);                                      // disarm
quiet('another channel', [0xB1, 123, 0], [0xB1, 121, 0]);
quiet('non-zero values', [0xB0, 123, 1], [0xB0, 121, 0]);
quiet('non-zero reset value', [0xB0, 123, 0], [0xB0, 121, 5]);
quiet('pedals', [0xB0, 64, 127], [0xB0, 4, 60], [0xB0, 64, 0]);
feed(0xB0, 123, 0); feed(0xB0, 123, 0); feed(0xB0, 121, 0);
drain();
assert.equal(count(0x00), 280, 'a repeated All Notes Off still arms');
ok('only B0 7B 00 directly followed by B0 79 00 triggers');

// ── D: a frame awaiting its ACK at the pair is not trusted ──
// It may have reached the device mid-switch, where a board's preset load overwrites it.
synced([1, 5, 0]);
selection.hoverKey = keyOf(0);
syncLumatoneHover();
const before = sysex.inFlight;
assert(before && before.frameColors, 'a hover frame is in flight');
const want = base(); want[0] = lightenHex(want[0], HOVER_LIGHTEN);
sent = [];
marker();
syncLumatoneColors();                 // any sync before the old frame's ACK must not undo it
syncLumatoneHover();
reply(before);                        // the old frame's ACK
assert(!lumatone.deviceColors.some((c) => c !== null), 'the old frame is not recorded as the device state');
drain();
assert.equal(count(0x00), 280);
assert.equal(count(0x55), 1, 'one new frame after the pair');
assert.equal(sent[sent.length - 1][5], 0x55, 'the frame goes last, after the layout');
assert.deepEqual(sent[sent.length - 1].frameColors, want);
assert.deepEqual(lumatone.deviceColors, want);
selection.hoverKey = null;
ok('a frame in flight at the pair is followed by a fresh one');

// ── E: a second switch while the re-push is running ──
synced([1, 5, 0]);
marker();
for (let i = 0; i < 100; i++) ackInFlight();
sent = [];
marker();
drain();
assert(count(0x00) >= 280, 'every key is written again after the second pair');
assert.equal(sent[sent.length - 1][5], 0x55);
assert.deepEqual(lumatone.deviceColors, base());
assert.equal(lumatone.fixedLayoutSent, true);
ok('a second pair mid-push re-pushes every key again');

// ── F: Auto-sync off sends nothing, and the next sync is a full one ──
synced([1, 5, 0]);
lumatone.autoSyncEnabled = false;
marker();
assert.equal(sent.length, 0, 'nothing without Auto-sync');
lumatone.autoSyncEnabled = true;
syncLumatoneColors();
drain();
assert.equal(count(0x00), 280);
assert.equal(count(0x55), 1);
ok('Auto-sync off: nothing sent; turning it on pushes everything');

// ── G: during the built-in calibration nothing is sent; the sync after it is a full one ──
synced([1, 5, 0]);
lumatone.keyCal = 'key';
marker();
assert.equal(sent.length, 0, 'nothing while a calibration runs');
lumatone.keyCal = 'idle';
syncLumatoneColors();
drain();
assert.equal(count(0x00), 280);
assert.equal(count(0x55), 1);
ok('calibration running: nothing sent; the sync after it pushes everything');

console.log(`preset-resync: ${checks} checks passed`);
