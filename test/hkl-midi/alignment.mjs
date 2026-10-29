// HKL Alignment gate: the live behavior of the Layout toolbar's Alignment
// select (layout/physical.ts, ui/controls.ts setAlignmentFromDom), driven
// through the real <select> change event.
//
// Same harness as held-inputs.mjs: the REAL modules imported live from the dev
// server through the app's own import edges (depUrl throws on a missing edge),
// Lumatone messages through a simulated MIDIInput, QWERTY through KeyboardEvents.
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/alignment.mjs        # exits non-zero on any failure
//
// Covers:
//   A1  the select's options and default; the saved pref follows a change
//   A2  every Lumatone key plays its Right-posed cell (−v, u+v) + kbAnchor,
//       QWERTY too; under the Piano outline the device still follows
//   A3  held Lumatone and QWERTY keys move with their key on a change, and
//       release cleanly afterwards
//   A4  Lumatone rotation levels the posed outline (the lattice turns); Vertical
//       Freq and Piano keep the lattice; the Piano outline has no pose
//   A5  the Lumatone footprint Composer sees is the posed cells + kbAnchor

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) throw new Error(depPath + ' is not imported by ' + fromPath);
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  const initUrl = '/src/ui/init.ts';
  const controlsUrl = await depUrl(initUrl, '/src/ui/controls.ts');
  const refUrl = await depUrl(initUrl, '/src/effects/onRefChanged.ts');
  const handlerUrl = await depUrl(refUrl, '/src/midi/handler.ts');
  const heldUrl = await depUrl(handlerUrl, '/src/input/held.ts');
  const engineUrl = await depUrl(handlerUrl, '/src/midi/engine.ts');
  const physUrl = await depUrl(controlsUrl, '/src/layout/physical.ts');
  const coreUrl = await depUrl(controlsUrl, '/src/render/controls-core.ts');
  const [held, eng, phys, geo, draw, viewMod, selMod, midiMod, baseMod, qwertyMod, heartbeat, sx] = await Promise.all([
    import(heldUrl), import(engineUrl), import(physUrl),
    depUrl(coreUrl, '/src/layout/geometry.ts').then((u) => import(u)),
    depUrl(controlsUrl, '/src/render/draw.ts').then((u) => import(u)),
    depUrl(physUrl, '/src/state/view.ts').then((u) => import(u)),
    depUrl(heldUrl, '/src/state/selection.ts').then((u) => import(u)),
    depUrl(engineUrl, '/src/state/midi.ts').then((u) => import(u)),
    depUrl(physUrl, '/src/layout/baseKeys.ts').then((u) => import(u)),
    depUrl(physUrl, '/src/input/qwerty.ts').then((u) => import(u)),
    depUrl(handlerUrl, '/src/midi/heartbeat.ts').then((u) => import(u)),
    depUrl(handlerUrl, '/src/lumatone/sysex.ts').then((u) => import(u)),
  ]);
  const { view } = viewMod, { selection } = selMod, { midi } = midiMod;
  const { baseKeys } = baseMod, { qwertyKeyMap } = qwertyMod;

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });

  const isPing = (m) => m[4] === 0x00 && m[5] === 0x33;
  const pingReply = (m) => new Uint8Array([0xF0, 0x00, 0x21, 0x50, 0x00, 0x33, 0x01, m[6], m[7], m[8], m[9], 0xF7]);
  const fakeIn = { id: 'fake-lumatone-in', name: 'Lumatone', state: 'connected', onmidimessage: null };
  const fakeOut = {
    id: 'fake-lumatone-out', name: 'Lumatone', state: 'connected',
    send(m) { if (isPing(m)) setTimeout(() => { if (fakeIn.onmidimessage) fakeIn.onmidimessage({ data: pingReply(m) }); }, 1); },
  };
  const savedIn = midi.midiIn, savedOut = midi.midiOut;
  midi.midiIn = fakeIn; midi.midiOut = fakeOut;
  fakeIn.onmidimessage = (await import(handlerUrl)).handleMidiMessage;
  const deliver = (...bytes) => fakeIn.onmidimessage({ data: new Uint8Array(bytes) });
  const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));

  const sel = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change')); };
  const k = (q, r) => q + ',' + r;
  const right = (u, v) => [-v, u + v];
  const anchored = ([q, r]) => k(q + view.kbAnchorQ, r + view.kbAnchorR);

  /* A1 */
  const opts = [...document.getElementById('selAlignment').options].map((o) => o.value).join(' ');
  check('A1a: options', opts, 'vertical left right');
  check('A1b: default', document.getElementById('selAlignment').value, 'vertical');
  sel('selOutline', 'lumatone'); sel('selRotation', 'lumatone');

  /* A3 setup at Vertical: hold Lumatone ch 1 note 24 and QWERTY S. */
  deliver(0x90, 24, 90);
  key('keydown', 'KeyS');
  const lumOld = held.heldKey('lumatone', '1,24'), qOld = held.heldKey('qwerty', 'KeyS');

  const tiltV = geo.tiltAngle;
  sel('selAlignment', 'right');
  check('A1c: the alignment pref is saved', JSON.parse(localStorage.getItem('hkl.prefs.v1')).alignment, 'right');

  /* A2 */
  let wrong = 0;
  for (let i = 0; i < 280; i++) {
    const want = anchored(right(...baseKeys[i]));
    if (eng.fixedMidiToKey(Math.floor(i / 56) + 1, i % 56) !== want) wrong++;
  }
  check('A2a: every Lumatone key plays its Right-posed cell', wrong, 0);
  const lumNew = anchored(right(...baseKeys[24]));
  const qNew = anchored(right(...qwertyKeyMap.KeyS));

  /* A3 */
  check('A3a: held Lumatone key moved with its key', held.heldKey('lumatone', '1,24'), lumNew);
  check('A3b: held QWERTY key moved with its key', held.heldKey('qwerty', 'KeyS'), qNew);
  check('A3c: the new cells are selected', selection.selectedKeys.has(lumNew) && selection.selectedKeys.has(qNew), true);
  check('A3d: the old cells are not', selection.selectedKeys.has(lumOld) || selection.selectedKeys.has(qOld), false);
  deliver(0x80, 24, 0);
  key('keyup', 'KeyS');
  check('A3e: release leaves nothing selected', selection.selectedKeys.size, 0);

  key('keydown', 'KeyW');
  check('A2b: a QWERTY key plays its Right-posed cell', held.heldKey('qwerty', 'KeyW'), anchored(right(...qwertyKeyMap.KeyW)));
  key('keyup', 'KeyW');

  /* A4 */
  const lev = (q, r) => -Math.atan((r * geo.dyH) / ((q + r * 0.5) * geo.dxH));
  check('A4a: Lumatone rotation levels the Right-posed case row', geo.tiltAngle, lev(...right(7, -2)));
  check('A4b: ... which turns the lattice', geo.tiltAngle !== tiltV, true);
  sel('selOutline', 'piano');
  check('A4c: the Piano outline has no pose (Lumatone tilt as at Vertical)', geo.tiltAngle, tiltV);
  wrong = 0;
  for (let i = 0; i < 280; i++)
    if (eng.fixedMidiToKey(Math.floor(i / 56) + 1, i % 56) !== anchored(right(...baseKeys[i]))) wrong++;
  check('A2c: under the Piano outline the device still plays Right', wrong, 0);
  sel('selOutline', 'lumatone');
  for (const rot of ['verticalFreq', 'piano']) {
    sel('selRotation', rot);
    const t = geo.tiltAngle;
    sel('selAlignment', 'left');
    check('A4d ' + rot + ': the lattice stays (tilt unchanged by alignment)', geo.tiltAngle, t);
    sel('selAlignment', 'right');
  }
  sel('selRotation', 'lumatone');

  /* A5 */
  const fp = draw.activeFootprintSet();
  let off = 0;
  for (const [u, v] of baseKeys) if (!fp.has(anchored(right(u, v)))) off++;
  check('A5: the footprint is the posed cells + kbAnchor', off + ':' + fp.size, '0:280');

  /* leave Vertical, nothing running */
  sel('selAlignment', 'vertical');
  check('A1d: back to Vertical restores the physical layout', eng.fixedMidiToKey(1, 24), anchored(baseKeys[24]));
  heartbeat.stopHeartbeat();
  held.clearAllHeld();
  selection.selectedKeys.clear();
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
