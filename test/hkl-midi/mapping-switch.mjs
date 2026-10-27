// HKL mapping-switch gate (docs/architecture.md → Note-name mapping): switching the
// note-name mapping while keys are held.
//
// Same harness as held-inputs.mjs (live modules resolved through their
// importers; Lumatone messages through a simulated MIDIInput). The reference
// is A4 — its spine has q ≠ 0, so the anchor MOVES on a switch (Euler (3,0) →
// Wicki-Hayden (6,0)); at the default A3 every key keeps its KeyId and the
// release bug this guards against would be invisible.
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/mapping-switch.mjs        # exits non-zero on any failure
//
// Covers:
//   M1  a held Lumatone key keeps its (q,r) and retunes in place to the new
//       mapping's pitch there; the anchor converts; release clears it (no orphan)
//   M2  a held mouse note converts by the frame formula, keeping its pitch
//   M3  the reverse switch (Wicki-Hayden → Euler) with a held key
//   M4  a reference change between the switch and the release
//   M5  the reference note keeps its pitch across the switch

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) return depPath;
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  const controlsUrl = await depUrl('/src/ui/init.ts', '/src/ui/controls.ts');
  const refUrl = await depUrl('/src/ui/init.ts', '/src/effects/onRefChanged.ts');
  const handlerUrl = await depUrl(refUrl, '/src/midi/handler.ts');
  const heldUrl = await depUrl(handlerUrl, '/src/input/held.ts');
  const engineUrl = await depUrl(handlerUrl, '/src/midi/engine.ts');
  const [controls, handler, held, eng, viewMod, selMod, audioMod, midiMod, tuningMod, refState, freqMod, heartbeat, sx] =
    await Promise.all([
      import(controlsUrl), import(handlerUrl), import(heldUrl), import(engineUrl),
      depUrl(engineUrl, '/src/state/view.ts').then((u) => import(u)),
      depUrl(heldUrl, '/src/state/selection.ts').then((u) => import(u)),
      depUrl(heldUrl, '/src/state/audio.ts').then((u) => import(u)),
      depUrl(engineUrl, '/src/state/midi.ts').then((u) => import(u)),
      depUrl(engineUrl, '/src/state/tuning.ts').then((u) => import(u)),
      depUrl(controlsUrl, '/src/state/reference.ts').then((u) => import(u)),
      depUrl(heldUrl, '/src/tuning/frequency.ts').then((u) => import(u)),
      depUrl(handlerUrl, '/src/midi/heartbeat.ts').then((u) => import(u)),
      depUrl(handlerUrl, '/src/lumatone/sysex.ts').then((u) => import(u)),
    ]);
  const { view } = viewMod, { selection } = selMod, { audio } = audioMod;
  const { midi } = midiMod, { tuning } = tuningMod, { keyFreq } = freqMod;

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });
  const near = (a, b) => Math.abs(1200 * Math.log2(a / b)) < 0.001;

  /* live fake Lumatone (answers heartbeat pings) */
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

  const selMapping = document.getElementById('selMapping');
  const switchTo = (m) => { selMapping.value = m; controls.setMapping(); };
  /* Ctrl+click-equivalent: set a manual ref — reference.ts re-anchors and
     onRefChanged migrates held physical voices */
  const setRef = (q, r) => { refState.setSelectionFromManual(q, r); };
  const reset = () => {
    heartbeat.stopHeartbeat();
    selection.selectedKeys.clear(); audio.sustainedKeys.clear();
    held.clearAllHeld();
    audio.sustainPedalDown = false;
  };
  const savedMapping = tuning.mapping;

  /* ── start: Euler, reference A4 = Euler (3, 0) ── */
  reset();
  if (tuning.mapping !== 'euler') switchTo('euler');
  setRef(3, 0);
  check('setup: Euler anchor on A4', view.kbAnchorQ + ',' + view.kbAnchorR, '3,0');

  /* M1 + M2: hold a Lumatone key and a mouse note, switch to Wicki-Hayden */
  deliver(0x90, 21, 100);
  const K0 = held.heldKey('lumatone', '1,21');
  const mouseKey = '1,0';                       /* Euler C#4 */
  selection.selectedKeys.add(mouseKey);
  const mouseHz = keyFreq(1, 0);
  const refHz = keyFreq(refState.referenceNote.q, refState.referenceNote.r);
  switchTo('wickiHayden');
  check('M1a: mapping switched', tuning.mapping, 'wickiHayden');
  check('M1b: anchor converted (A4 stays centred)', view.kbAnchorQ + ',' + view.kbAnchorR, '6,0');
  check('M1c: the key now sits on a different cell', eng.fixedMidiToKey(1, 21) === K0, false);
  check('M1d: held key keeps its (q,r)', held.heldKey('lumatone', '1,21'), K0);
  check('M1e: held key still selected (retunes in place)', selection.selectedKeys.has(K0), true);
  check('M2a: mouse note converted', selection.selectedKeys.has('2,0'), true);
  check('M2b: mouse note left its Euler coordinate', selection.selectedKeys.has(mouseKey) && mouseKey !== '2,0', false);
  check('M2c: mouse note keeps its pitch', near(keyFreq(2, 0), mouseHz), true);
  check('M5: reference keeps its pitch', near(keyFreq(refState.referenceNote.q, refState.referenceNote.r), refHz), true);
  deliver(0x80, 21, 0);
  check('M1f: release clears the held key (no orphan)', selection.selectedKeys.has(K0), false);
  check('M1g: no Lumatone record left', held.heldCount('lumatone'), 0);
  check('M2d: mouse note still held after the release (nothing dropped)', selection.selectedKeys.has('2,0'), true);

  /* M3: reverse switch with a held key */
  reset();
  deliver(0x90, 21, 100);
  const K1 = held.heldKey('lumatone', '1,21');
  switchTo('euler');
  check('M3a: back to Euler', tuning.mapping, 'euler');
  check('M3b: anchor converted back', view.kbAnchorQ + ',' + view.kbAnchorR, '3,0');
  check('M3c: held key keeps its (q,r)', held.heldKey('lumatone', '1,21'), K1);
  deliver(0x80, 21, 0);
  check('M3d: release clears it', selection.selectedKeys.size, 0);

  /* M4: switch, then a reference change, then release */
  reset();
  deliver(0x90, 21, 100);
  switchTo('wickiHayden');
  setRef(0, 0);                                  /* A3: the anchor moves again */
  const K2 = held.heldKey('lumatone', '1,21');
  check('M4a: ref change migrated the held key to the cell under it', K2, eng.fixedMidiToKey(1, 21));
  check('M4b: its selection followed', selection.selectedKeys.has(K2), true);
  deliver(0x80, 21, 0);
  check('M4c: release clears it', selection.selectedKeys.size, 0);
  check('M4d: no record left', held.heldCount('lumatone'), 0);

  /* leave the page as found */
  reset();
  setRef(0, 0);
  refState.clearSelection();
  if (tuning.mapping !== savedMapping) switchTo(savedMapping);
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
try { chrome.kill?.(); } catch {}
process.exit(exit);
