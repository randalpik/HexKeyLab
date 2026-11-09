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
// The slide runs on Date.now and requestAnimationFrame: both are driven by hand.
let now = 1_000_000;
Date.now = () => now;
let rafCb = null;
globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
globalThis.cancelAnimationFrame = () => { rafCb = null; };
const tick = () => { const cb = rafCb; rafCb = null; if (cb) cb(); };
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k),
};

const { midi } = await import('../../apps/hkl/src/state/midi.ts');
const { lumatone } = await import('../../apps/hkl/src/state/lumatone.ts');
const { selection } = await import('../../apps/hkl/src/state/selection.ts');
const { sysex } = await import('../../apps/hkl/src/lumatone/sysex.ts');
const { syncLumatoneColors, syncLumatoneHover, frameSyncActive, barycentric, sampleField,
        beginLumatoneSlide, cancelLumatoneSlide } = await import('../../apps/hkl/src/lumatone/sync.ts');
const { view } = await import('../../apps/hkl/src/state/view.ts');
const { setBoards34Swapped, sysexBoardFor, buildFrameSysEx, buildBoardRequestSysEx, firmwareAtLeast } =
  await import('../../apps/hkl/src/lumatone/protocol.ts');
const { lumatoneCell, lumatoneCells } = await import('../../apps/hkl/src/layout/physical.ts');
const { keyColorHex, lightenHex, HOVER_LIGHTEN } = await import('../../apps/hkl/src/render/colors.ts');
const { hexToOklab, oklabToHex } = await import('../../apps/hkl/src/lumatone/oklab.ts');
const { hueC } = await import('../../packages/shared/src/colors.ts');

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
const lit = (hex) => lightenHex(hex, HOVER_LIGHTEN); // the canvas hover rule

function fresh(firmware) {
  cancelLumatoneSlide();
  sysex.cancel(); sent = [];
  selection.hoverKey = null;
  lumatone.autoSyncEnabled = true;
  lumatone.deviceColors = null;
  lumatone.fixedLayoutSent = false;
  lumatone.firmware = firmware;
  lumatone.hoverMirror = true;
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
assert.equal(lumatone.deviceColors[k1], lit(base()[k1]), 'device state = acked frame');
assert.equal(sent.length, 2, 'one queued frame after the ACK');
const want3 = base(); want3[k3] = lit(want3[k3]);
checkFrame(sent[1], want3);
assert.equal(sent[1].cause, 'hover');
ackInFlight();
assert.equal(sysex.inFlight, null, 'k2 frame was superseded, never sent');
assert.deepEqual(lumatone.deviceColors, want3);
assert.notEqual(f1, sent[1]);
ok('latest wins: k2 frame superseded; hover key lightened by the canvas rule');

// ── D: hover returns to the in-flight state — the stale queued frame must not go out ──
sent = [];
selection.hoverKey = keyOf(k1); syncLumatoneHover();           // frame A in flight
selection.hoverKey = keyOf(k2); syncLumatoneHover();           // frame B queued
selection.hoverKey = keyOf(k1); syncLumatoneHover();           // back to A before A's ACK
ackInFlight();
assert.equal(sysex.inFlight, null, 'queued B dropped');
assert.equal(sent.length, 1);
const wantA = base(); wantA[k1] = lit(wantA[k1]);
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
assert.equal(lumatone.deviceColors[k3], lit(base()[k3]));
ok('ERROR (03h) frame is not counted and is resent');

// ── G: Hover checkbox off — no hover frames, and normal syncs still go out as frames ──
fresh([1, 5, 0]);
lumatone.hoverMirror = false;
syncLumatoneColors(); drain(); sent = [];
selection.hoverKey = keyOf(k1); syncLumatoneHover();
assert.equal(sent.length, 0, 'hover is not mirrored with the checkbox off');
syncLumatoneColors();
assert.equal(sent.length, 0, 'a sync while hovering shows no highlight either');
lumatone.hoverMirror = true;
syncLumatoneColors();                                          // what toggleLumatoneHover does
assert(isFrame(sysex.inFlight)); ackInFlight();
assert.equal(lumatone.deviceColors[k1], lit(base()[k1]), 'turning it on shows the current hover');
lumatone.hoverMirror = false;
syncLumatoneColors(); ackInFlight();
assert.deepEqual(lumatone.deviceColors, base(), 'turning it off clears the highlight');
ok('Hover checkbox gates the mirror; toggling re-syncs both ways');

// ── I: barycentric sampling on the hex lattice ──
const weights = (q, r) => Object.fromEntries(barycentric(q, r).filter(([, , w]) => w > 1e-12)
  .map(([a, b, w]) => [a + ',' + b, w]));
assert.deepEqual(weights(3, -2), { '3,-2': 1 }, 'an integer point is its own cell');
assert.deepEqual(weights(0.5, 0), { '0,0': 0.5, '1,0': 0.5 }, 'edge midpoint');
assert.deepEqual(weights(0.5, 0.5), { '1,0': 0.5, '0,1': 0.5 }, 'the m3 diagonal is a triangle edge');
assert.deepEqual(weights(0.75, 0.75), { '1,1': 0.5, '1,0': 0.25, '0,1': 0.25 }, 'upper triangle');
let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 20 - 10;
for (let n = 0; n < 2000; n++) {
  const q = rnd(), r = rnd(), ws = barycentric(q, r);
  assert(ws.every(([, , w]) => w >= -1e-12), 'weights are non-negative');
  assert(Math.abs(ws.reduce((a, [, , w]) => a + w, 0) - 1) < 1e-12, 'weights sum to 1');
  const lin = (a, b) => 3 * a - 2 * b + 5;
  assert(Math.abs(ws.reduce((acc, [a, b, w]) => acc + w * lin(a, b), 0) - lin(q, r)) < 1e-9,
         'a linear field is reproduced exactly');
}
for (const [q, r] of [[0.3, 0.7], [-1.2, 2.2], [4.9, -3.9]]) {
  const lo = weights(q - 1e-9, r), hi = weights(q + 1e-9, r);
  for (const k of new Set([...Object.keys(lo), ...Object.keys(hi)])) {
    assert(Math.abs((lo[k] ?? 0) - (hi[k] ?? 0)) < 1e-6, 'continuous across the diagonal');
  }
}
const two = (q, r) => (q === 0 && r === 0 ? '#000000' : '#c8c8c8');
const ch = (h) => [1, 3, 5].map((a) => parseInt(h.slice(a, a + 2), 16));
const near = (a, b, tol) => ch(a).every((v, i) => Math.abs(v - ch(b)[i]) <= tol);
assert(near(sampleField(0.5, 0, two), '#191919', 1), 'gray midpoint halves OKLab lightness (200 / 8 = 25)');
const palette = Object.values(hueC).flatMap((h) => [h.l, h.d, h.sl, h.sd]);
for (const hex of palette) assert(near(oklabToHex(hexToOklab(hex)), hex, 1), `OKLab round trip ${hex}`);
for (const h of Object.values(hueC)) {
  for (const [l, d] of [[h.l, h.d], [h.sl, h.sd]]) {
    const mid = sampleField(0.5, 0, (q, r) => (q === 0 && r === 0 ? l : d));
    const want = (hexToOklab(l)[0] + hexToOklab(d)[0]) / 2;
    assert(Math.abs(hexToOklab(mid)[0] - want) < 0.004, `dark/light halfway keeps mean lightness ${l}/${d}`);
  }
}
assert.equal(sampleField(2, 3, () => '#abcDEF'), '#abcDEF', 'a cell center returns the cell string verbatim');
ok('barycentric weights: exact cells, edges, diagonal, partition of unity, linear reproduction; OKLab blend keeps lightness');

// ── J: Ctrl+click slide on the frame path ──
const plain = (q, r) => keyColorHex(q, r);
const fieldAt = (aq, ar, color = plain) =>
  lumatoneCells.map(([u, v]) => sampleField(u + aq, v + ar, color));
fresh([1, 5, 0]);
syncLumatoneColors(); drain(); sent = [];
const [q0, r0] = [view.kbAnchorQ, view.kbAnchorR];
const setAnchor = (q, r) => { view.kbAnchorQ = q; view.kbAnchorR = r; }; // what reference.ts does first
const old = base();
setAnchor(q0 + 1, r0 + 1);                                     // M3 + P5: not an octave, so colors change
assert(base().filter((c, i) => c !== old[i]).length > 100, 'the move changes most keys');
beginLumatoneSlide(1, 1);
syncLumatoneColors();                                          // the remap's sync
assert.equal(sent.length, 0, 'the slide starts where the device is: no jump to the final layout');
assert(rafCb, 'slide tick scheduled');
now += 250; tick();                                            // smoothstep(0.5) = 0.5 → anchor + (0.5, 0.5)
assert(isFrame(sysex.inFlight));
assert.equal(sysex.inFlight.cause, 'slide');
assert.deepEqual(sysex.inFlight.frameColors, fieldAt(q0 + 0.5, r0 + 0.5), 'mid-slide frame = field at the eased anchor');
assert(sysex.inFlight.frameColors.filter((c, i) => c !== old[i] && c !== base()[i]).length > 100,
       'mid-slide colors are blends');
{
  // perceived lightness is redistributed, not created: each key's OKLab L is the
  // weighted mean of its cells' L (8-bit rounding and gamut clamping aside)
  let worst = 0;
  lumatoneCells.forEach(([u, v], i) => {
    const want = barycentric(u + q0 + 0.5, v + r0 + 0.5)
      .reduce((acc, [cq, cr, w]) => acc + w * hexToOklab(keyColorHex(cq, cr))[0], 0);
    worst = Math.max(worst, Math.abs(hexToOklab(sysex.inFlight.frameColors[i])[0] - want));
  });
  console.log(`    worst per-key OKLab L error mid-slide: ${worst.toFixed(4)}`);
  assert(worst < 0.01, 'every key keeps the weighted mean OKLab lightness of its cells');
}
ackInFlight();
now += 100; tick(); ackInFlight();                             // t = 350 ms
now += 200; tick();                                            // t = 550 ms: landed
assert.equal(rafCb, null, 'tick stops after landing');
drain();
assert.deepEqual(lumatone.deviceColors, base(), 'lands exactly on the new layout');
ok('slide: no jump at start, field-sampled mid frame, exact landing');

// redirect mid-slide: a second Ctrl+click starts from the interpolated anchor
sent = [];
setAnchor(q0 + 2, r0 + 2);
beginLumatoneSlide(1, 1);                                      // from (q0+1, r0+1) to (q0+2, r0+2)
now += 250; tick();                                            // anchor (q0+1.5, r0+1.5), in flight
const shown = sysex.inFlight.frameColors;
assert.deepEqual(shown, fieldAt(q0 + 1.5, r0 + 1.5));
setAnchor(q0 + 2, r0 + 3);
beginLumatoneSlide(0, 1);                                      // redirect at the same instant
syncLumatoneColors();
ackInFlight();
assert.equal(sysex.inFlight, null, 'a redirect starts from what the device shows: nothing new to send');
now += 600; tick(); drain();
assert.deepEqual(lumatone.deviceColors, base(), 'the redirected slide lands exactly');
ok('redirect mid-slide continues from the interpolated anchor');

// a snap mid-slide sends the exact layout
setAnchor(q0, r0);
beginLumatoneSlide(-2, -3);
now += 200; tick(); ackInFlight();
cancelLumatoneSlide();
assert.equal(rafCb, null);
syncLumatoneColors(); drain();
assert.deepEqual(lumatone.deviceColors, base(), 'snap lands exactly');
ok('cancel (snap) mid-slide sends the exact layout');

// hover rides the field: the hovered cell's lightening moves with it
selection.hoverKey = keyOf(140);
syncLumatoneColors(); drain();
const hcell = lumatoneCell(140);
setAnchor(q0 + 1, r0);
beginLumatoneSlide(1, 0);
now += 250; tick();
const lightened = (q, r) => (q + ',' + r === hcell.join(',') ? lit(keyColorHex(q, r)) : keyColorHex(q, r));
assert.deepEqual(sysex.inFlight.frameColors, fieldAt(q0 + 0.5, r0, lightened), 'hover cell blended like any cell');
cancelLumatoneSlide(); drain(); selection.hoverKey = null;
setAnchor(q0, r0);
ok('hover highlight slides with the field');

// older firmware never slides
fresh([1, 4, 0]);
syncLumatoneColors(); drain(); sent = [];
setAnchor(q0 + 1, r0);
beginLumatoneSlide(1, 0);
assert.equal(rafCb, null, 'no slide on the per-key path');
syncLumatoneColors(); drain();
assert(!sent.some(isFrame) && sent.length > 0, 'per-key snap as before');
assert.deepEqual(lumatone.deviceColors, base());
setAnchor(q0, r0);
ok('firmware < 1.5.0: no slide, per-key snap');

// ── H: timings, Auto-sync off ──
const t = sysex.frameTimings();
assert(t.length >= 5 && t.every((x) => x.rtt >= 0 && x.sinceCause >= x.rtt - 1e-9));
assert(t.some((x) => x.cause === 'hover') && t.some((x) => x.cause === 'sync'));
sent = []; lumatone.autoSyncEnabled = false;
selection.hoverKey = keyOf(k1); syncLumatoneHover();
assert.equal(sent.length, 0, 'nothing without Auto-sync');
ok('frame timings recorded; Auto-sync off sends nothing');

console.log(`frame-sync: ${checks} checks passed`);
