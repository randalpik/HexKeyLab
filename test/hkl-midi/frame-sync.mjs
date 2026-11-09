// Hardware-free gate for whole-keyboard 55h color sync (Lumatone firmware 1.5.0+).
// Run with the repo's .js → .ts resolution hook:
// node --import ./test/orchestrator-smoke/register-ts.mjs test/hkl-midi/frame-sync.mjs
//
// Drives the real lumatone/sync.ts + lumatone/sysex.ts against a scripted device that
// ACKs only when told to, which is how the firmware behaves: a frame's ACK arrives
// once every board has its colours, and nothing else is in flight meanwhile.
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
const { syncLumatoneColors, syncLumatoneHover, frameSyncActive } = await import('../../apps/hkl/src/lumatone/sync.ts');
const { setBoards34Swapped, sysexBoardFor, buildFrameSysEx, buildBoardRequestSysEx, firmwareAtLeast } =
  await import('../../apps/hkl/src/lumatone/protocol.ts');
const { lumatoneCell } = await import('../../apps/hkl/src/layout/physical.ts');
const { keyColorHex } = await import('../../apps/hkl/src/render/colors.ts');

let sent = [];
midi.midiOut = { send: (m) => sent.push(m) };
midi.midiIn = {}; // present, so the queue waits for real ACKs

const reply = (m, status = 1, extra = []) =>
  sysex.handleResponse(new Uint8Array([0xF0, 0x00, 0x21, 0x50, m[4], m[5], status, ...extra, 0xF7]));
const ackInFlight = (status = 1) => { const m = sysex.inFlight; assert(m, 'something in flight'); reply(m, status); return m; };
const drain = () => { while (sysex.inFlight) ackInFlight(); };
const cmds = (list) => list.map((m) => m[5]);
const isFrame = (m) => m[5] === 0x55;
const keyOf = (i) => { const [q, r] = lumatoneCell(i); return q + ',' + r; };
const base = () => Array.from({ length: 280 }, (_, i) => { const [q, r] = lumatoneCell(i); return keyColorHex(q, r); });
const half = (hex) => '#' + [1, 3, 5].map((a) => {
  const v = parseInt(hex.slice(a, a + 2), 16); return Math.round(v + (255 - v) / 2).toString(16).padStart(2, '0');
}).join('');

function fresh(firmware) {
  sysex.cancel(); sent = [];
  selection.hoverKey = null;
  lumatone.autoSyncEnabled = true;
  lumatone.deviceColors = null;
  lumatone.fixedLayoutSent = false;
  lumatone.firmware = firmware;
}

function checkFrame(m, colors) {
  assert.equal(m.length, 847, 'frame is exactly 847 bytes');
  assert.deepEqual([...m.slice(0, 6)], [0xF0, 0x00, 0x21, 0x50, 0x00, 0x55]);
  assert.equal(m[846], 0xF7);
  for (let i = 0; i < 280; i++) {
    const at = 6 + ((sysexBoardFor(Math.floor(i / 56)) - 1) * 56 + i % 56) * 3;
    const want = [1, 3, 5].map((a) => parseInt(colors[i].slice(a, a + 2), 16) >> 1);
    assert.deepEqual([...m.slice(at, at + 3)], want, `key ${i} at its SysEx board slot`);
  }
}

let checks = 0;
const ok = (label) => { checks++; console.log('  ✓ ' + label); };

// ── firmware gate ──
assert(firmwareAtLeast([1, 5, 0], [1, 5, 0]) && firmwareAtLeast([2, 0, 0], [1, 5, 0]) && firmwareAtLeast([1, 5, 3], [1, 5, 0]));
assert(!firmwareAtLeast([1, 4, 9], [1, 5, 0]) && !firmwareAtLeast(null, [1, 5, 0]) && !firmwareAtLeast([1, 0, 12], [1, 5, 0]));
ok('firmwareAtLeast orders versions');

// ── A: firmware < 1.5.0 keeps the per-key path, and hover is not mirrored ──
fresh([1, 4, 0]);
syncLumatoneColors();
drain();
assert.equal(cmds(sent).filter((c) => c === 0x00).length, 280);
assert.equal(cmds(sent).filter((c) => c === 0x01).length, 280);
assert(!sent.some(isFrame), 'no 55h on 1.4.0');
assert.deepEqual(lumatone.deviceColors, base());
sent = [];
selection.hoverKey = keyOf(100);
syncLumatoneHover();
assert.equal(sent.length, 0, 'hover sends nothing on the per-key path');
ok('1.4.0: per-key wipe, no frames, no hover mirror');

// ── B: connect sequence — firmware answers 1.5.0 after the first sync was queued ──
for (const swap of [false, true]) {
  setBoards34Swapped(swap);
  fresh(null);
  let known = 0;
  sysex.queryFirmware(() => { known++; if (frameSyncActive()) syncLumatoneColors(); });
  syncLumatoneColors(); // built before the version is known: setup + per-key colors
  assert.equal(sent.length, 1, 'firmware query goes out first');
  reply(sysex.inFlight, 1, [1, 5, 0]);
  assert.equal(known, 1);
  assert.deepEqual(lumatone.firmware, [1, 5, 0]);
  drain();
  const c = cmds(sent);
  assert.equal(c.filter((x) => x === 0x00).length, 280, 'layout setup survives the re-sync');
  assert(c.includes(0x0E) && c.includes(0x07), 'setup flags survive the re-sync');
  assert.equal(c.filter((x) => x === 0x01).length, 0, 'queued per-key colors were replaced');
  const frames = sent.filter(isFrame);
  assert.equal(frames.length, 1, 'exactly one frame');
  checkFrame(frames[0], base());
  assert(c.indexOf(0x55) > c.lastIndexOf(0x00), 'frame after the layout');
  assert.deepEqual(lumatone.deviceColors, base(), 'deviceColors take the whole frame on ACK');
  ok(`1.5.0 connect: setup kept, one frame, payload routed (swap ${swap ? 'on' : 'off'})`);
}
setBoards34Swapped(false);

// ── C: latest wins, and the hovered key is highlighted ──
fresh([1, 5, 0]);
syncLumatoneColors(); drain(); sent = [];
const [k1, k2, k3] = [10, 140, 270];
selection.hoverKey = keyOf(k1); syncLumatoneHover();
assert.equal(sent.length, 1, 'first hover frame goes straight out');
selection.hoverKey = keyOf(k2); syncLumatoneHover();
selection.hoverKey = keyOf(k3); syncLumatoneHover();
assert.equal(sent.length, 1, 'nothing else on the wire while a frame is in flight');
const f1 = ackInFlight();
assert.equal(lumatone.deviceColors[k1], half(base()[k1]), 'device state = acked frame');
assert.equal(sent.length, 2, 'one queued frame after the ACK');
const want3 = base(); want3[k3] = half(want3[k3]);
checkFrame(sent[1], want3);
assert.equal(sent[1].cause, 'hover');
ackInFlight();
assert.equal(sysex.inFlight, null, 'k2 frame was superseded, never sent');
assert.deepEqual(lumatone.deviceColors, want3);
assert.notEqual(f1, sent[1]);
ok('latest wins: k2 frame superseded; hover key mixed halfway to white');

// ── D: hover returns to the in-flight state — the stale queued frame must not go out ──
sent = [];
selection.hoverKey = keyOf(k1); syncLumatoneHover();           // frame A in flight
selection.hoverKey = keyOf(k2); syncLumatoneHover();           // frame B queued
selection.hoverKey = keyOf(k1); syncLumatoneHover();           // back to A before A's ACK
ackInFlight();
assert.equal(sysex.inFlight, null, 'queued B dropped');
assert.equal(sent.length, 1);
const wantA = base(); wantA[k1] = half(wantA[k1]);
assert.deepEqual(lumatone.deviceColors, wantA);
ok('return to in-flight state drops the stale queued frame');

// ── E: control messages survive a re-sync ──
sent = [];
selection.hoverKey = null; syncLumatoneHover();                // frame in flight
const query = buildBoardRequestSysEx(3, 0x3A);
sysex.enqueueControl(query);
selection.hoverKey = keyOf(k2); syncLumatoneHover();           // replaces the colors only
ackInFlight();
assert.equal(sysex.inFlight, query, 'control query sent next');
ackInFlight();
assert(isFrame(sysex.inFlight), 'then the newest frame');
ackInFlight();
ok('replaceQueue keeps queued control messages ahead of new colors');

// ── F: a frame answered ERROR does not update device state; the next sync resends ──
sent = [];
const before = lumatone.deviceColors.slice();
selection.hoverKey = keyOf(k3); syncLumatoneHover();
ackInFlight(3);
assert.deepEqual(lumatone.deviceColors, before, 'ERROR leaves device state alone');
syncLumatoneColors();
assert(isFrame(sysex.inFlight), 'resent');
ackInFlight();
assert.equal(lumatone.deviceColors[k3], half(base()[k3]));
ok('ERROR (03h) frame is not counted and is resent');

// ── G: timings, Auto-sync off ──
const t = sysex.frameTimings();
assert(t.length >= 5 && t.every((x) => x.rtt >= 0 && x.sinceCause >= x.rtt - 1e-9));
assert(t.some((x) => x.cause === 'hover') && t.some((x) => x.cause === 'sync'));
sent = []; lumatone.autoSyncEnabled = false;
selection.hoverKey = keyOf(k1); syncLumatoneHover();
assert.equal(sent.length, 0, 'nothing without Auto-sync');
ok('frame timings recorded; Auto-sync off sends nothing');

console.log(`frame-sync: ${checks} checks passed`);
