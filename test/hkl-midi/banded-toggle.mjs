// HKL banded-layout toggle gate (docs/architecture.md → Unbanded layout):
// switching the Banded layout checkbox, with keys held.
//
// Same harness as mapping-switch.mjs (live modules resolved through their
// importers; Lumatone messages through a simulated MIDIInput). Pythagorean,
// whose unbanded comma is the Pythagorean comma (23.46¢ per band).
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/banded-toggle.mjs        # exits non-zero on any failure
//
// Covers:
//   B1  off at A3: the lattice is static (keys keep their (q,r), the ref band's
//       pitches are unchanged, the band to its right rises by a PC), Show bands
//       and Euler's P8 / SC transposes disable, the pref persists, the
//       snapshot records it
//   B2  centering: a ref off its band's spine sits at the center unbanded and
//       back on the spine banded; held Lumatone keys follow their key
//   B3  Wicki-Hayden unbanded: P8 transposes by (−1, 2), an exact octave
//   B4  chromatic unbanded: P8 by (−2, 2), an exact octave; SC stays off
//   B5  a recording snapshot restores the banding it was made in

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
  const controlsUrl = await depUrl('/src/ui/init.ts', '/src/ui/controls.ts');
  const refUrl = await depUrl('/src/ui/init.ts', '/src/effects/onRefChanged.ts');
  const handlerUrl = await depUrl(refUrl, '/src/midi/handler.ts');
  const heldUrl = await depUrl(handlerUrl, '/src/input/held.ts');
  const engineUrl = await depUrl(handlerUrl, '/src/midi/engine.ts');
  const recorderUrl = await depUrl('/src/ui/init.ts', '/src/ui/recorder.ts');
  const [controls, handler, held, eng, viewMod, selMod, audioMod, midiMod, tuningMod, refState, freqMod, heartbeat, sx, prefsMod, applyMod, snapMod] =
    await Promise.all([
      import(controlsUrl), import(handlerUrl), import(heldUrl), import(engineUrl),
      depUrl(engineUrl, '/src/layout/physical.ts').then((u) => depUrl(u, '/src/state/view.ts')).then((u) => import(u)),
      depUrl(heldUrl, '/src/state/selection.ts').then((u) => import(u)),
      depUrl(heldUrl, '/src/state/audio.ts').then((u) => import(u)),
      depUrl(engineUrl, '/src/state/midi.ts').then((u) => import(u)),
      depUrl('/src/ui/init.ts', '/src/state/tuning.ts').then((u) => import(u)),
      depUrl(controlsUrl, '/src/state/reference.ts').then((u) => import(u)),
      depUrl(heldUrl, '/src/tuning/frequency.ts').then((u) => import(u)),
      depUrl(handlerUrl, '/src/midi/heartbeat.ts').then((u) => import(u)),
      depUrl(handlerUrl, '/src/lumatone/sysex.ts').then((u) => import(u)),
      depUrl(controlsUrl, '/src/state/persistence.ts').then((u) => import(u)),
      depUrl(recorderUrl, '/src/recording/apply.ts').then((u) => import(u)),
      depUrl(recorderUrl, '/src/recording/snapshot.ts').then((u) => import(u)),
    ]);
  const { view } = viewMod, { selection } = selMod, { audio } = audioMod;
  const { midi } = midiMod, { tuning } = tuningMod, { keyFreq } = freqMod;

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });
  const cents = (a, b) => (1200 * Math.log2(a / b)).toFixed(2);

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

  const $ = (id) => document.getElementById(id);
  const setBanded = (b) => { $('cbBanded').checked = b; controls.setBanded(); };
  const switchMapping = (m) => { $('selMapping').value = m; controls.setMapping(); };
  const switchTuning = (t) => { $('selTuning').value = t; controls.setTuning(); };
  const btn = (kind) => document.querySelector('.tpab[data-kind="' + kind + '"]');
  const setRef = (q, r) => { refState.setSelectionFromManual(q, r); };
  const anchorStr = () => view.kbAnchorQ + ',' + view.kbAnchorR;
  const reset = () => {
    heartbeat.stopHeartbeat();
    selection.selectedKeys.clear(); audio.sustainedKeys.clear();
    held.clearAllHeld();
    audio.sustainPedalDown = false;
  };
  const saved = { mode: tuning.mode, mapping: tuning.mapping, banded: tuning.banded };

  /* ── start: Pythagorean, Euler, banded, ref A3 ── */
  reset();
  if (!tuning.banded) setBanded(true);
  if (tuning.mapping !== 'euler') switchMapping('euler');
  switchTuning('P');
  setRef(0, 0);
  check('setup: banded', tuning.banded, true);
  check('setup: Show bands enabled', $('cbBands').disabled, false);
  check('setup: Euler P8 enabled banded', btn('octave').disabled, false);

  /* B1: off at A3, with a Lumatone key and a mouse note held */
  deliver(0x90, 21, 100);
  const K0 = held.heldKey('lumatone', '1,21');
  selection.selectedKeys.add('1,0');
  const hzRef = keyFreq(0, 0), hzBand = keyFreq(3, 0), hzLow = keyFreq(-3, 0);
  setBanded(false);
  check('B1a: unbanded', tuning.banded, false);
  check('B1b: checkbox reflects it', $('cbBanded').checked, false);
  check('B1c: Show bands disabled', $('cbBands').disabled, true);
  check('B1d: Euler P8 disabled (no spelled octave)', btn('octave').disabled, true);
  check('B1e: SC disabled', btn('comma').disabled, true);
  check('B1f: A3 is on its spine, so the keyboard stays', anchorStr(), '0,0');
  check('B1g: held key keeps its (q,r)', held.heldKey('lumatone', '1,21'), K0);
  check('B1h: held key still sounding', selection.selectedKeys.has(K0), true);
  check('B1i: mouse note keeps its (q,r)', selection.selectedKeys.has('1,0'), true);
  check('B1j: the ref band is unchanged', cents(keyFreq(0, 0), hzRef), '0.00');
  check('B1k: the band to the right rises a PC', cents(keyFreq(3, 0), hzBand), '23.46');
  check('B1l: the band to the left falls a PC', cents(keyFreq(-3, 0), hzLow), '-23.46');
  check('B1m: pref saved', prefsMod.loadPrefs().banded, false);
  check('B1n: snapshot records it', snapMod.captureSnapshot().banded, false);
  deliver(0x80, 21, 0);
  check('B1o: release clears the held key', selection.selectedKeys.has(K0), false);

  /* B2: centering — C#4 (1,0) sits off its band's spine (0,0) */
  reset();
  setRef(1, 0);
  check('B2a: unbanded centers the ref itself', anchorStr(), '1,0');
  deliver(0x90, 21, 100);
  const K1 = held.heldKey('lumatone', '1,21');
  setBanded(true);
  check('B2b: banded centers the band spine', anchorStr(), '0,0');
  check('B2c: the held key followed its key', held.heldKey('lumatone', '1,21'), eng.fixedMidiToKey(1, 21));
  check('B2d: … to a different cell', held.heldKey('lumatone', '1,21') !== K1, true);
  check('B2e: Show bands enabled again', $('cbBands').disabled, false);
  deliver(0x80, 21, 0);
  check('B2f: release clears it', held.heldCount('lumatone'), 0);
  setBanded(false);
  check('B2g: and back to the ref', anchorStr(), '1,0');

  /* B3: Wicki-Hayden unbanded — P8 is (−1, 2), an exact octave */
  reset();
  setRef(0, 0);
  switchMapping('wickiHayden');
  check('B3a: WH P8 enabled unbanded', btn('octave').disabled, false);
  check('B3b: WH SC disabled unbanded', btn('comma').disabled, true);
  selection.selectedKeys.add('0,0');
  const hz0 = keyFreq(0, 0);
  controls.transposeSelection(3, 0, 'octave');
  check('B3c: P8 moved the note by (−1, 2)', selection.selectedKeys.has('-1,2'), true);
  check('B3d: … an exact octave', cents(keyFreq(-1, 2), hz0), '1200.00');
  controls.transposeSelection(7, -4, 'comma');
  check('B3e: SC does nothing unbanded', selection.selectedKeys.has('-1,2'), true);

  /* B4: chromatic unbanded — P8 is (−2, 2) */
  reset();
  switchMapping('chromatic');
  setRef(0, 0);
  check('B4a: chromatic P8 enabled unbanded', btn('octave').disabled, false);
  selection.selectedKeys.add('0,0');
  controls.transposeSelection(3, 0, 'octave');
  check('B4b: P8 moved the note by (−2, 2)', selection.selectedKeys.has('-2,2'), true);
  check('B4c: … an exact octave', cents(keyFreq(-2, 2), keyFreq(0, 0)), '1200.00');
  controls.transposeSelection(-3, 0, 'octave');
  check('B4d: and back down', selection.selectedKeys.has('0,0'), true);

  /* B5: a recording snapshot restores its banding */
  reset();
  switchMapping('euler');
  setRef(0, 0);
  const snap = { ...snapMod.captureSnapshot(), banded: true };
  check('B5a: live is unbanded before the apply', tuning.banded, false);
  check('B5b: the snapshot no longer matches live', snapMod.snapshotMatchesLive(snap), false);
  await applyMod.applySnapshot(snap);
  check('B5c: apply restored banded', tuning.banded, true);
  check('B5d: checkbox follows', $('cbBanded').checked, true);
  check('B5e: snapshot matches live', snapMod.snapshotMatchesLive(snap), true);

  /* leave the page as found */
  reset();
  setRef(0, 0);
  refState.clearSelection();
  if (tuning.banded !== saved.banded) setBanded(saved.banded);
  if (tuning.mapping !== saved.mapping) switchMapping(saved.mapping);
  if (tuning.mode !== saved.mode) switchTuning(saved.mode);
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
