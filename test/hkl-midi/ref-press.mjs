// HKL ref-press gate: while the ref-edit modifier (Ctrl) is held, a Lumatone
// key press picks the reference note exactly as a Ctrl+click on that cell does
// (input/ref-edit.ts pickRef) instead of playing it.
//
// Same harness as held-inputs.mjs: the REAL modules imported live from the dev
// server (resolved through their importers), Lumatone messages through a
// simulated MIDIInput's onmidimessage, Ctrl through KeyboardEvents on window.
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/ref-press.mjs        # exits non-zero on any failure
//
// Covers:
//   P1  Ctrl held: a key press makes its cell the ref, sliding, and plays
//       nothing (no selection, no held record); the manual ref is persisted
//   P2  its note-off and aftertouch are no-ops
//   P3  pressing the current ref's key clears the manual ref (→ A3)
//   P4  a key whose cell is outside A0–C8 is rejected: ref unchanged, silent
//   P5  Ctrl released: the same key plays and releases normally
//   P6  a key already held when Ctrl goes down keeps sounding, follows the
//       ref change, and releases cleanly
//   P7  pressed under Ctrl, released after Ctrl: still a no-op
//   P8  window blur drops the keyboard's hold on the modifier
//   M1  with the modifier held, a mouse click picks the ref even when the
//       click itself carries no ctrlKey (one modifier for every input)

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  /* Resolve a module by the exact URL an importer uses (see departure.mjs). */
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) throw new Error(depPath + ' is not imported by ' + fromPath);
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  const root = '/src/ui/init.ts';
  const drawUrl = await depUrl(root, '/src/render/draw.ts');
  const handlerUrl = await depUrl(root, '/src/midi/handler.ts');
  const engineUrl = await depUrl(handlerUrl, '/src/midi/engine.ts');
  const heldUrl = await depUrl(handlerUrl, '/src/input/held.ts');
  const [viewMod, refState, drawMod, animMod, handler, held, eng, selMod, audioMod, midiMod, prefsMod, heartbeat, sx] =
    await Promise.all([
      import(await depUrl(root, '/src/state/view.ts')),
      import(await depUrl(root, '/src/state/reference.ts')),
      import(drawUrl),
      import(await depUrl(drawUrl, '/src/render/animation.ts')),
      import(handlerUrl), import(heldUrl), import(engineUrl),
      import(await depUrl(root, '/src/state/selection.ts')),
      import(await depUrl(root, '/src/state/audio.ts')),
      import(await depUrl(engineUrl, '/src/state/midi.ts')),
      import(await depUrl(root, '/src/state/persistence.ts')),
      import(await depUrl(handlerUrl, '/src/midi/heartbeat.ts')),
      import(await depUrl(handlerUrl, '/src/lumatone/sysex.ts')),
    ]);
  const { view } = viewMod, { selection } = selMod, { audio } = audioMod, { midi } = midiMod;
  const ref = refState.referenceNote;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const SLIDE = 750; /* > the 500 ms tween */

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });
  const sel = (id, v) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('change')); };
  const tick = (id, on) => { const c = document.getElementById(id); c.checked = on; c.dispatchEvent(new Event('change')); };

  /* Live fake Lumatone (answers heartbeat pings). */
  const isPing = (m) => m[4] === 0x00 && m[5] === 0x33;
  const pingReply = (m) => new Uint8Array([0xF0, 0x00, 0x21, 0x50, 0x00, 0x33, 0x01, m[6], m[7], m[8], m[9], 0xF7]);
  const fakeIn = { id: 'fake-lumatone-in', name: 'Lumatone', state: 'connected', onmidimessage: null };
  const fakeOut = {
    id: 'fake-lumatone-out', name: 'Lumatone', state: 'connected',
    send(m) { if (isPing(m)) setTimeout(() => { if (fakeIn.onmidimessage) fakeIn.onmidimessage({ data: pingReply(m) }); }, 1); },
  };
  const savedIn = midi.midiIn, savedOut = midi.midiOut;
  midi.midiIn = fakeIn; midi.midiOut = fakeOut;
  fakeIn.onmidimessage = handler.handleMidiMessage;
  const deliver = (...bytes) => fakeIn.onmidimessage({ data: new Uint8Array(bytes) });
  /* a physical key is [channel 1..5, note 0..55] */
  const on = ([ch, n]) => deliver(0x90 | (ch - 1), n, 100);
  const off = ([ch, n]) => deliver(0x80 | (ch - 1), n, 0);
  const touch = ([ch, n]) => deliver(0xA0 | (ch - 1), n, 64);
  const cellOf = ([ch, n]) => eng.fixedMidiToKey(ch, n);
  const findKey = (pred) => {
    for (let ch = 1; ch <= 5; ch++) for (let n = 0; n < 56; n++) {
      const c = eng.fixedMidiToKey(ch, n);
      if (c && pred(c)) return [ch, n];
    }
    return null;
  };
  const refKey = () => ref.q + ',' + ref.r;
  const valid = (c) => { const [q, r] = c.split(',').map(Number); return drawMod.validateRefNoteCandidate(q, r) === null; };

  const ctrl = (down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup',
    { key: 'Control', code: 'ControlLeft', ctrlKey: down, bubbles: true }));
  const quiet = () => {
    heartbeat.stopHeartbeat();
    selection.selectedKeys.clear(); audio.sustainedKeys.clear();
    held.clearAllHeld();
  };

  sel('selMapping', 'euler'); sel('selTuning', '5'); sel('selOutline', 'lumatone');
  tick('cbSyncToComposer', false);
  ctrl(false); quiet();
  await wait(150);
  check('setup: the ref starts at A3', refKey(), '0,0');

  /* ── P1–P2: a press under Ctrl is a ref pick ── */
  /* two keys beside the anchor key, which sits on the ref */
  const A = findKey((c) => c === '1,0'), B = findKey((c) => c === '0,1');
  const cellA = cellOf(A);
  check('setup: key A is not the ref and is a valid ref', cellA !== refKey() && valid(cellA), true);
  ctrl(true);
  on(A);
  check('P1a: the pressed cell is the ref', refKey(), cellA);
  check('P1b: nothing is selected', selection.selectedKeys.size, 0);
  check('P1c: no held record', held.heldCount('lumatone'), 0);
  check('P1d: the re-center slides, as a Ctrl+click does', animMod.animation.isAnimating, true);
  await wait(SLIDE);
  check('P1e: the keyboard anchor is the ref', view.kbAnchorQ + ',' + view.kbAnchorR, cellA);
  const saved = prefsMod.loadPrefs().manualRef;
  check('P1f: the manual ref is persisted', saved ? saved.q + ',' + saved.r : 'none', cellA);
  touch(A);
  check('P2a: aftertouch on that key reaches no cell', Object.keys(audio.aftertouchSnapshot).length, 0);
  off(A);
  check('P2b: its note-off changes nothing', selection.selectedKeys.size + held.heldCount('lumatone'), 0);
  check('P2c: the ref stays', refKey(), cellA);

  /* ── P3: the current ref's key clears the manual ref ── */
  const R = findKey((c) => c === refKey());
  check('setup: a key sits on the ref', R !== null, true);
  if (R) on(R);
  check('P3a: pressing the ref clears it → A3', refKey(), '0,0');
  check('P3b: nothing is selected', selection.selectedKeys.size, 0);
  check('P3c: the persisted manual ref is dropped', prefsMod.loadPrefs().manualRef === undefined, true);
  if (R) off(R);
  await wait(SLIDE);

  /* ── P4: a cell outside A0–C8 is rejected ── */
  ctrl(false);
  refState.setSelectionFromManual(0, 7);   /* MIDI 106: part of the keyboard is now above C8 */
  await wait(SLIDE);
  const X = findKey((c) => !valid(c));
  check('setup: a key sits outside the piano range', X !== null, true);
  ctrl(true);
  if (X) on(X);
  check('P4a: the ref is unchanged', refKey(), '0,7');
  check('P4b: the rejected press plays nothing', selection.selectedKeys.size + held.heldCount('lumatone'), 0);
  if (X) off(X);
  ctrl(false);
  refState.clearSelection();
  await wait(SLIDE);
  check('setup: back at A3', refKey(), '0,0');

  /* ── P5: without the modifier the key plays ── */
  quiet();
  on(A);
  check('P5a: the key plays', selection.selectedKeys.has(cellOf(A)), true);
  check('P5b: the ref is unchanged', refKey(), '0,0');
  off(A);
  check('P5c: and releases', selection.selectedKeys.size + held.heldCount('lumatone'), 0);

  /* ── P6: a key held before Ctrl follows the ref change ── */
  quiet();
  on(B);
  const cellB0 = cellOf(B);
  ctrl(true);
  on(A);
  const cellB1 = cellOf(B);
  check('P6a: the ref moved under the held key', cellB1 !== cellB0, true);
  check('P6b: the held voice followed its key', selection.selectedKeys.has(cellB1) && !selection.selectedKeys.has(cellB0), true);
  check('P6c: only the held key sounds', selection.selectedKeys.size, 1);
  off(A);
  off(B);
  check('P6d: the held key releases cleanly', selection.selectedKeys.size + held.heldCount('lumatone'), 0);
  await wait(SLIDE);

  /* ── P7: pressed under Ctrl, released after it ── */
  quiet();
  const C = findKey((c) => c !== refKey() && valid(c));
  on(C);
  ctrl(false);
  off(C);
  check('P7: the late note-off is a no-op', selection.selectedKeys.size + held.heldCount('lumatone'), 0);
  await wait(SLIDE);

  /* ── P8: blur drops the keyboard's hold ── */
  quiet();
  ctrl(true);
  window.dispatchEvent(new Event('blur'));
  const before = refKey();
  on(B);
  check('P8a: after blur the key plays', selection.selectedKeys.has(cellOf(B)), true);
  check('P8b: and the ref is unchanged', refKey(), before);
  off(B);

  /* ── M1: the modifier applies to a plain mouse click too ── */
  quiet();
  const clickCell = (q, r) => {
    const cv = document.querySelector('canvas');
    const want = q + ',' + r; let sxm = 0, sym = 0, n = 0;
    for (let y = 0; y < view.CH; y += 3) for (let x = 0; x < view.CW; x += 3)
      if (drawMod.hexAtPoint(x, y) === want) { sxm += x; sym += y; n++; }
    if (!n) return false;
    const rect = cv.getBoundingClientRect();
    const o = { bubbles: true, ctrlKey: false, clientX: rect.left + sxm / n, clientY: rect.top + sym / n, button: 0 };
    cv.dispatchEvent(new MouseEvent('mousedown', o));
    window.dispatchEvent(new MouseEvent('mouseup', o));
    return true;
  };
  const target = (ref.q + 1) + ',' + (ref.r + 1);
  ctrl(true);
  check('setup: the click target is on screen', clickCell(ref.q + 1, ref.r + 1), true);
  check('M1a: a plain click under the modifier picks the ref', refKey(), target);
  check('M1b: and selects nothing', selection.selectedKeys.size, 0);
  ctrl(false);
  await wait(SLIDE);

  /* leave nothing behind */
  refState.clearSelection();
  prefsMod.savePrefs({ manualRef: undefined });
  quiet();
  sx.sysex.cancel();
  midi.midiIn = savedIn; midi.midiOut = savedOut;

  return { pass: results.every(r => r.ok), results };
})()`;

const chrome = await launchChromium();
const cdp = new CDP(await newTabWsUrl(chrome.port));
await cdp.ready;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

const errors = [];
cdp.on('Runtime.exceptionThrown', (p) => errors.push(p?.exceptionDetails?.text ?? 'exception'));
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') errors.push(p.args.map(a => a.value ?? a.description).join(' '));
});

const loaded = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
await cdp.send('Page.navigate', { url: URL });
await loaded;
await sleep(2500);

const out = await cdp.evalJSON(SCRIPT);
let exit = 0;
if (!out || !out.results) {
  console.log('FAILED TO RUN:', JSON.stringify(out));
  exit = 1;
} else {
  for (const r of out.results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (got ${JSON.stringify(r.got)}, want ${JSON.stringify(r.want)})`);
  }
  const passed = out.results.filter(r => r.ok).length;
  console.log(`\n${passed}/${out.results.length} checks passed`);
  if (!out.pass) exit = 1;
}
if (errors.length) console.log('\nCONSOLE ERRORS:\n  ' + errors.join('\n  '));
await chrome.stop();
process.exit(exit);
