// HKL held-physical-input gate: every note struck by a physical key (Lumatone
// "ch,note", QWERTY event.code) releases the KeyId it actually struck
// (input/held.ts), whatever the lattice anchor is at release time.
//
// Same harness as departure.mjs: Composer's app-agnostic CDP layer pointed at
// the HKL core app, driving the REAL modules imported live from the dev server
// (resolved through their importers, so HMR-stamped modules are the same
// singletons the app uses). Lumatone messages go through a simulated
// MIDIInput's onmidimessage; QWERTY through KeyboardEvents on window.
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/held-inputs.mjs        # exits non-zero on any failure
//
// Covers:
//   L1-L3  Lumatone strike records its key; a ref change migrates voice +
//          record; release after migration clears everything
//   L4     an anchor change WITHOUT migration still releases the struck key
//   L5     aftertouch routes to the struck key, not the cell now under it
//   L6     after the Clear button, a physical release is a no-op (it must not
//          deselect a cell selected since)
//   Q1-Q5  QWERTY: strike, ref-change migration, keyup release, unmigrated
//          anchor change, blur releases everything held
//   S1     damper down: release moves the key to sustainedKeys; pedal up ends it
//   N1     nothing but SysEx reaches the Lumatone port (no note echo)

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  /* Resolve a module by the exact URL an importer uses — once a module has been
     hot-reloaded Vite serves it as '?t=<stamp>', and a bare import would be a
     SECOND instance (see departure.mjs). */
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) throw new Error(depPath + ' is not imported by ' + fromPath);
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  const controlsUrl = await depUrl('/src/ui/init.ts', '/src/ui/controls.ts');
  const refUrl = await depUrl('/src/ui/init.ts', '/src/effects/onRefChanged.ts');
  const handlerUrl = await depUrl(refUrl, '/src/midi/handler.ts');
  const heldUrl = await depUrl(handlerUrl, '/src/input/held.ts');
  const engineUrl = await depUrl(handlerUrl, '/src/midi/engine.ts');
  const [controls, refMod, handler, held, eng, viewMod, selMod, audioMod, midiMod, pedalMod, heartbeat, sx] =
    await Promise.all([
      import(controlsUrl), import(refUrl), import(handlerUrl), import(heldUrl), import(engineUrl),
      depUrl(engineUrl, '/src/layout/physical.ts').then((u) => depUrl(u, '/src/state/view.ts')).then((u) => import(u)),
      depUrl(heldUrl, '/src/state/selection.ts').then((u) => import(u)),
      depUrl(heldUrl, '/src/state/audio.ts').then((u) => import(u)),
      depUrl(engineUrl, '/src/state/midi.ts').then((u) => import(u)),
      depUrl(handlerUrl, '/src/state/pedal.ts').then((u) => import(u)),
      depUrl(handlerUrl, '/src/midi/heartbeat.ts').then((u) => import(u)),
      depUrl(handlerUrl, '/src/lumatone/sysex.ts').then((u) => import(u)),
    ]);
  const { view } = viewMod, { selection } = selMod, { audio } = audioMod;
  const { midi } = midiMod, { pedal } = pedalMod;

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });

  /* Live fake Lumatone (answers heartbeat pings) so holding keys never trips
     the departure path mid-test. */
  const isPing = (m) => m[4] === 0x00 && m[5] === 0x33;
  const pingReply = (m) => new Uint8Array([0xF0, 0x00, 0x21, 0x50, 0x00, 0x33, 0x01, m[6], m[7], m[8], m[9], 0xF7]);
  const fakeIn = { id: 'fake-lumatone-in', name: 'Lumatone', state: 'connected', onmidimessage: null };
  const notSysex = [];   /* status bytes of anything but SysEx sent to the device */
  const fakeOut = {
    id: 'fake-lumatone-out', name: 'Lumatone', state: 'connected',
    send(m) {
      if (m[0] !== 0xF0) notSysex.push(m[0]);
      if (isPing(m)) setTimeout(() => { if (fakeIn.onmidimessage) fakeIn.onmidimessage({ data: pingReply(m) }); }, 1);
    },
  };
  const savedIn = midi.midiIn, savedOut = midi.midiOut;
  midi.midiIn = fakeIn; midi.midiOut = fakeOut;
  fakeIn.onmidimessage = handler.handleMidiMessage;
  const deliver = (...bytes) => fakeIn.onmidimessage({ data: new Uint8Array(bytes) });

  const a0q = view.kbAnchorQ, a0r = view.kbAnchorR;
  const setAnchor = (q, r) => { view.kbAnchorQ = q; view.kbAnchorR = r; };
  const savedPedalMode = pedal.mode;
  pedal.mode = 'sustain';
  const reset = () => {
    heartbeat.stopHeartbeat();
    selection.selectedKeys.clear(); audio.sustainedKeys.clear();
    held.clearAllHeld();
    pedal.cc4Depth = 0; pedal.cc64Depth = 0; audio.damperDepth = 0; audio.sustainPedalDown = false;
    setAnchor(a0q, a0r);
  };
  const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
  const shiftQ = (k, dq) => { const [q, r] = k.split(',').map(Number); return (q + dq) + ',' + r; };

  /* ── Lumatone ── */
  reset();
  deliver(0x90, 21, 100);
  const K0 = eng.fixedMidiToKey(1, 21);
  check('L1a: strike selects the key', selection.selectedKeys.has(K0), true);
  check('L1b: strike records the key', held.heldKey('lumatone', '1,21'), K0);

  setAnchor(a0q + 3, a0r);
  refMod.onRefChanged(3, 0);
  const K1 = eng.fixedMidiToKey(1, 21);
  check('L2a: anchor moved the cell under the key', K1 === K0, false);
  check('L2b: ref change migrates selection to the new cell', selection.selectedKeys.has(K1), true);
  check('L2c: ref change leaves nothing on the old cell', selection.selectedKeys.has(K0), false);
  check('L2d: ref change migrates the record', held.heldKey('lumatone', '1,21'), K1);
  deliver(0x80, 21, 0);
  check('L3a: release after migration clears selection', selection.selectedKeys.size, 0);
  check('L3b: release after migration clears the record', held.heldCount('lumatone'), 0);

  reset();
  deliver(0x90, 21, 100);
  setAnchor(a0q + 3, a0r);           /* no onRefChanged: the voice is NOT migrated */
  deliver(0x80, 21, 0);
  check('L4a: unmigrated anchor change still releases the struck key', selection.selectedKeys.has(K0), false);
  check('L4b: nothing left selected', selection.selectedKeys.size, 0);
  check('L4c: record cleared', held.heldCount('lumatone'), 0);

  reset();
  deliver(0x90, 21, 100);
  setAnchor(a0q + 3, a0r);
  deliver(0xA0, 21, 64);
  check('L5a: aftertouch reaches the struck key', audio.aftertouchSnapshot[K0], 64);
  check('L5b: aftertouch skips the cell now under the key', audio.aftertouchSnapshot[eng.fixedMidiToKey(1, 21)], undefined);
  deliver(0x80, 21, 0);
  check('L5c: release clears the aftertouch snapshot', audio.aftertouchSnapshot[K0], undefined);

  reset();
  deliver(0x90, 21, 100);
  controls.clearSelection();
  check('L6a: Clear forgets held records', held.heldCount('lumatone'), 0);
  selection.selectedKeys.add(K0);    /* the cell is selected again, e.g. by mouse */
  deliver(0x80, 21, 0);
  check('L6b: physical release after Clear is a no-op', selection.selectedKeys.has(K0), true);

  /* ── QWERTY ── */
  reset();
  key('keydown', 'KeyA');
  const Q0 = held.heldKey('qwerty', 'KeyA');
  check('Q1a: keydown records a key', typeof Q0, 'string');
  check('Q1b: keydown selects it', selection.selectedKeys.has(Q0), true);
  setAnchor(a0q + 3, a0r);
  refMod.onRefChanged(3, 0);
  check('Q2a: ref change migrates the record', held.heldKey('qwerty', 'KeyA'), shiftQ(Q0, 3));
  check('Q2b: ref change migrates the selection', selection.selectedKeys.has(shiftQ(Q0, 3)), true);
  check('Q2c: nothing left on the old cell', selection.selectedKeys.has(Q0), false);
  key('keyup', 'KeyA');
  check('Q3a: keyup clears selection', selection.selectedKeys.size, 0);
  check('Q3b: keyup clears the record', held.heldCount('qwerty'), 0);

  reset();
  key('keydown', 'KeyA');
  setAnchor(a0q + 3, a0r);           /* unmigrated */
  key('keyup', 'KeyA');
  check('Q4: unmigrated anchor change still releases the struck key', selection.selectedKeys.size, 0);

  reset();
  key('keydown', 'KeyA'); key('keydown', 'KeyS');
  window.dispatchEvent(new Event('blur'));
  check('Q5a: blur releases every held code', held.heldCount('qwerty'), 0);
  check('Q5b: blur clears selection', selection.selectedKeys.size, 0);

  /* ── sustain handoff ── */
  reset();
  deliver(0xB0, 64, 127);
  deliver(0x90, 21, 100);
  deliver(0x80, 21, 0);
  check('S1a: release under the damper sustains the struck key', audio.sustainedKeys.has(K0), true);
  check('S1b: release under the damper clears the record', held.heldCount('lumatone'), 0);
  deliver(0xB0, 64, 0);
  check('S1c: pedal up ends the sustain', audio.sustainedKeys.has(K0), false);

  /* Every strike above (Lumatone, QWERTY, sustain) went through the selection
     sync; HKL talks to the Lumatone in SysEx only, never echoing notes. */
  check('N1: the Lumatone port carries only SysEx', notSysex.map((b) => b.toString(16)).join(' '), '');

  /* leave nothing running */
  reset();
  pedal.mode = savedPedalMode;
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
