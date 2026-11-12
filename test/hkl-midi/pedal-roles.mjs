// HKL pedal-role gate: each Lumatone pedal jack (Expr = CC 4, continuous;
// Sus = CC 64, binary) has its own role — None, Sostenuto, Sustain or Ctrl —
// chosen in its own dropdown (midi/pedals.ts), and a recording stores what the
// pedals did (damper depth, sostenuto), not which jack did it.
//
// Same harness as held-inputs.mjs: the REAL modules imported live from the dev
// server (resolved through their importers), pedal and key messages through a
// simulated MIDIInput's onmidimessage, roles through the real <select>s.
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/pedal-roles.mjs        # exits non-zero on any failure
//
// Covers:
//   U   the two dropdowns: options, order, defaults, saved prefs, and the old
//       single-dropdown pref carried over
//   E   the Expr jack in each role (the binary roles read it from CC ≥ 64)
//   S   the Sus jack in each role
//   B   both jacks in one role: dampers combine by max, sostenuto and Ctrl by
//       OR, and a second pedal never re-snapshots a sostenuto
//   X   Expr = Sustain with Sus = Ctrl: the modifier never touches the damper,
//       and a key pressed under the pedal picks the ref
//   M   a role changed while the pedal is down re-reads the pedal at once
//   D   departure releases what the jacks held (damper, sostenuto, Ctrl) and
//       nothing another source holds
//   R   recording: damper → cc4, sostenuto → cc64, pedalMode 'sostenuto',
//       whatever the jacks; a Ctrl pedal records nothing
//   P   playback: an old Sustain-mode take's cc64 is a damper, a new take's is
//       a sostenuto; neither changes the dropdowns; stop releases both

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
  const handlerUrl = await depUrl(root, '/src/midi/handler.ts');
  const midiEngineUrl = await depUrl(handlerUrl, '/src/midi/engine.ts');
  const audioEngineUrl = await depUrl(handlerUrl, '/src/audio/engine.ts');
  const recorderUrl = await depUrl(root, '/src/ui/recorder.ts');
  const [handler, eng, engine, held, refEdit, refState, selMod, audioMod, midiMod, pedalMod, prefsMod,
         heartbeat, capture, playback, apply, snapMod] = await Promise.all([
    import(handlerUrl), import(midiEngineUrl), import(audioEngineUrl),
    import(await depUrl(handlerUrl, '/src/input/held.ts')),
    import(await depUrl(handlerUrl, '/src/input/ref-edit.ts')),
    import(await depUrl(root, '/src/state/reference.ts')),
    import(await depUrl(root, '/src/state/selection.ts')),
    import(await depUrl(root, '/src/state/audio.ts')),
    import(await depUrl(midiEngineUrl, '/src/state/midi.ts')),
    import(await depUrl(handlerUrl, '/src/state/pedal.ts')),
    import(await depUrl(root, '/src/state/persistence.ts')),
    import(await depUrl(handlerUrl, '/src/midi/heartbeat.ts')),
    import(await depUrl(audioEngineUrl, '/src/recording/capture.ts')),
    import(await depUrl(recorderUrl, '/src/recording/playback.ts')),
    import(await depUrl(recorderUrl, '/src/recording/apply.ts')),
    import(await depUrl(recorderUrl, '/src/recording/snapshot.ts')),
  ]);
  const { selection } = selMod, { audio } = audioMod, { midi } = midiMod, { pedal } = pedalMod;
  const ref = refState.referenceNote;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });
  const near = (name, got, want) =>
    results.push({ name, got, want, ok: typeof got === 'number' && Math.abs(got - want) < 1e-6 });
  /* A section that throws (a control or field the app does not have) fails by name. */
  const section = async (name, fn) => {
    try { await fn(); } catch (e) { results.push({ name: name + ': ran to the end', got: String(e && e.message || e), want: 'no error', ok: false }); }
  };

  const fakeIn = { id: 'fake-lumatone-in', name: 'Lumatone', state: 'connected', onmidimessage: null };
  const isPing = (m) => m[4] === 0x00 && m[5] === 0x33;
  const pingReply = (m) => new Uint8Array([0xF0, 0x00, 0x21, 0x50, 0x00, 0x33, 0x01, m[6], m[7], m[8], m[9], 0xF7]);
  const fakeOut = {
    id: 'fake-lumatone-out', name: 'Lumatone', state: 'connected',
    send(m) { if (isPing(m)) setTimeout(() => { if (fakeIn.onmidimessage) fakeIn.onmidimessage({ data: pingReply(m) }); }, 1); },
  };
  const savedIn = midi.midiIn, savedOut = midi.midiOut;
  const plug = () => { midi.midiIn = fakeIn; midi.midiOut = fakeOut; fakeIn.onmidimessage = handler.handleMidiMessage; };
  plug();
  const deliver = (...bytes) => fakeIn.onmidimessage({ data: new Uint8Array(bytes) });
  const cc4 = (v) => deliver(0xB0, 4, v);
  const cc64 = (v) => deliver(0xB0, 64, v);
  const on = (n) => deliver(0x90, n, 100), off = (n) => deliver(0x80, n, 0);

  const selEl = (jack) => {
    const el = document.getElementById(jack === 'expr' ? 'pedalExpr' : 'pedalSus');
    if (!el) throw new Error('no dropdown for the ' + jack + ' jack');
    return el;
  };
  const role = (jack, v) => { const el = selEl(jack); el.value = v; el.dispatchEvent(new Event('change')); };
  const roles = (expr, sus) => { role('expr', expr); role('sus', sus); };
  const quiet = () => {
    cc4(0); cc64(0);
    heartbeat.stopHeartbeat();
    if (audio.sostenutoActive) engine.sostenutoOff();
    selection.selectedKeys.clear(); audio.sustainedKeys.clear();
    held.clearAllHeld();
  };
  const state = () => ({
    damper: +audio.damperDepth.toFixed(4), sostenuto: audio.sostenutoActive, ctrl: refEdit.isRefEditHeld(),
  });
  const is = (name, damper, sostenuto, ctrl) => {
    const s = state();
    results.push({ name, got: JSON.stringify(s), want: JSON.stringify({ damper, sostenuto, ctrl }),
      ok: s.damper === damper && s.sostenuto === sostenuto && s.ctrl === ctrl });
  };
  const d = (v) => +(v / 127).toFixed(4);

  /* ── U: the dropdowns ── */
  await section('U', async () => {
    for (const jack of ['expr', 'sus']) {
      const el = selEl(jack);
      check('U1: ' + jack + ' options, in order', [...el.options].map((o) => o.value + '=' + o.textContent.trim()).join(' '),
        'none=None sostenuto=Sostenuto sustain=Sustain ctrl=Ctrl');
      check('U2: ' + jack + ' defaults to Sustain', el.value, 'sustain');
    }
    check('U3: the two dropdowns share a row', selEl('expr').closest('div') === selEl('sus').closest('div'), true);
    check('U4: the single Pedals dropdown is gone', document.getElementById('pedalMode'), null);
    roles('none', 'ctrl');
    const p = prefsMod.loadPrefs();
    check('U5: each choice is saved', p.pedalExpr + ' ' + p.pedalSus, 'none ctrl');
    check('U6: and is live', pedal.roles.expr + ' ' + pedal.roles.sus, 'none ctrl');
    /* a profile saved by the single dropdown */
    const KEY = 'hkl.prefs.v1', savedRaw = localStorage.getItem(KEY);
    const old = JSON.parse(savedRaw); delete old.pedalExpr; delete old.pedalSus;
    localStorage.setItem(KEY, JSON.stringify({ ...old, pedalMode: 'sostenuto' }));
    const m1 = prefsMod.loadPrefs();
    check('U7: old "Sostenuto + Sustain" → Expr Sustain, Sus Sostenuto', m1.pedalExpr + ' ' + m1.pedalSus, 'sustain sostenuto');
    localStorage.setItem(KEY, JSON.stringify({ ...old, pedalMode: 'sustain' }));
    const m2 = prefsMod.loadPrefs();
    check('U8: old "Sustain" → both Sustain', m2.pedalExpr + ' ' + m2.pedalSus, 'sustain sustain');
    localStorage.setItem(KEY, savedRaw);
  });

  /* ── E: the Expr jack, the Sus jack doing nothing ── */
  await section('E', async () => {
    quiet(); roles('sustain', 'none');
    cc4(80);  is('E1a: Sustain is a continuous damper', d(80), false, false);
    cc4(1);   is('E1b: CC 4 ≤ 1 is released', 0, false, false);
    cc64(127); is('E1c: the Sus jack as None does nothing', 0, false, false);
    quiet(); roles('sostenuto', 'none');
    on(10);
    cc4(63);  is('E2a: Sostenuto: below CC 64 is up', 0, false, false);
    cc4(64);  is('E2b: Sostenuto: CC 64 is down', 0, true, false);
    check('E2c: it caught the held key', audio.sostenutoLockedKeys.size, 1);
    on(11); cc4(100);
    check('E2d: moving further down does not re-snapshot', audio.sostenutoLockedKeys.size, 1);
    cc4(20);  is('E2e: Sostenuto released', 0, false, false);
    off(10); off(11);
    quiet(); roles('ctrl', 'none');
    cc4(100); is('E3a: Ctrl holds the ref-edit modifier', 0, false, true);
    cc4(10);  is('E3b: Ctrl released', 0, false, false);
    quiet(); roles('none', 'none');
    cc4(127); is('E4: None does nothing', 0, false, false);
  });

  /* ── S: the Sus jack, the Expr jack doing nothing ── */
  await section('S', async () => {
    quiet(); roles('none', 'sustain');
    cc64(127); is('S1a: Sustain is a full damper', 1, false, false);
    cc4(127);  is('S1b: the Expr jack as None does nothing', 1, false, false);
    cc64(0);   is('S1c: Sustain released', 0, false, false);
    quiet(); roles('none', 'sostenuto');
    on(10); cc64(127); is('S2a: Sostenuto', 0, true, false);
    check('S2b: it caught the held key', audio.sostenutoLockedKeys.size, 1);
    off(10);
    check('S2c: the caught key rings on after release', audio.sustainedKeys.size, 1);
    cc64(0);   is('S2d: Sostenuto released', 0, false, false);
    check('S2e: and the key with it', audio.sustainedKeys.size + selection.selectedKeys.size, 0);
    quiet(); roles('none', 'ctrl');
    cc64(127); is('S3a: Ctrl holds the ref-edit modifier', 0, false, true);
    cc64(0);   is('S3b: Ctrl released', 0, false, false);
    quiet(); roles('none', 'none');
    cc64(127); is('S4: None does nothing', 0, false, false);
  });

  /* ── B: both jacks in the same role ── */
  await section('B', async () => {
    quiet(); roles('sustain', 'sustain');
    cc4(40);   is('B1a: Expr alone', d(40), false, false);
    cc64(127); is('B1b: the deeper of the two', 1, false, false);
    cc64(0);   is('B1c: back to Expr', d(40), false, false);
    quiet(); roles('sostenuto', 'sostenuto');
    on(10); cc64(127); on(11); cc4(100);
    check('B2a: the second pedal does not re-snapshot', audio.sostenutoLockedKeys.size, 1);
    cc64(0);   is('B2b: held while either is down', 0, true, false);
    cc4(0);    is('B2c: released when both are up', 0, false, false);
    off(10); off(11);
    quiet(); roles('ctrl', 'ctrl');
    cc64(127); cc4(100); cc64(0); is('B3a: Ctrl held while either is down', 0, false, true);
    cc4(0);    is('B3b: released when both are up', 0, false, false);
  });

  /* ── X: Expr = Sustain, Sus = Ctrl ── */
  await section('X', async () => {
    quiet(); roles('sustain', 'ctrl');
    cc4(90); cc64(127); is('X1: the damper and the modifier are independent', d(90), false, true);
    const before = ref.q + ',' + ref.r;
    const key = (() => { for (let n = 0; n < 56; n++) { const c = eng.fixedMidiToKey(3, n); if (c === (ref.q + 1) + ',' + ref.r) return n; } return -1; })();
    deliver(0x92, key, 100);
    check('X2: a key pressed under the pedal picks the ref', ref.q + ',' + ref.r === before, false);
    check('X3: and does not sound', selection.selectedKeys.size, 0);
    deliver(0x82, key, 0);
    cc64(0); is('X4: pedal up: the damper is untouched', d(90), false, false);
    cc4(0);
    refState.clearSelection();
    await wait(750);
  });

  /* ── M: a role changed while the pedal is down ── */
  await section('M', async () => {
    quiet(); roles('none', 'sustain');
    on(10); cc64(127); off(10);
    is('M1a: Sus down as Sustain', 1, false, false);
    check('M1b: a released key is sustained', audio.sustainedKeys.size, 1);
    role('sus', 'sostenuto');
    is('M2a: → Sostenuto: the damper lets go, the sostenuto engages', 0, true, false);
    check('M2b: the damper\\'s note was released first, so the sostenuto caught nothing', audio.sustainedKeys.size + audio.sostenutoLockedKeys.size, 0);
    role('sus', 'ctrl');      is('M3: → Ctrl', 0, false, true);
    role('sus', 'none');      is('M4: → None', 0, false, false);
    role('sus', 'sustain');   is('M5: → Sustain again', 1, false, false);
    cc64(0);                  is('M6: pedal up', 0, false, false);
    roles('sustain', 'none');
    cc4(100); role('expr', 'ctrl'); is('M7: Expr down, Sustain → Ctrl', 0, false, true);
    role('expr', 'sustain');        is('M8: and back', d(100), false, false);
    cc4(0);
  });

  /* ── D: departure ── */
  await section('D', async () => {
    quiet(); roles('sustain', 'ctrl');
    cc4(100); cc64(127);
    pedal.damper.piano = 0.5;            /* another device's pedal, held */
    handler.releaseLumatoneInput();
    is('D1: the jacks let go of the damper and the modifier; the piano keeps its own', 0.5, false, false);
    pedal.damper.piano = 0; engine.setDamperDepth();
    plug(); quiet(); roles('none', 'sostenuto');
    on(10); cc64(127);
    handler.releaseLumatoneInput();
    is('D2: a sostenuto held by a jack is released', 0, false, false);
    plug(); quiet();
  });

  /* ── R: recording stores effects ── */
  await section('R', async () => {
    const kinds = (s) => s.events.map((e) => e.k + ':' + (+e.v.toFixed(3))).join(' ');
    quiet(); roles('sustain', 'sostenuto');
    capture.startRecording();
    cc4(100); cc64(127); cc64(0); cc4(0);
    let s = capture.stopRecording();
    check('R1a: damper on cc4, sostenuto on cc64', kinds(s), 'cc4:' + (+(100 / 127).toFixed(3)) + ' cc64:1 cc64:0 cc4:0');
    check('R1b: the snapshot says cc64 is the sostenuto', s.snapshot.pedalMode, 'sostenuto');
    quiet(); roles('sostenuto', 'sustain');           /* the same pedals, swapped */
    capture.startRecording();
    cc64(127); cc4(100); cc4(0); cc64(0);
    s = capture.stopRecording();
    check('R2a: swapped jacks record the same streams', kinds(s), 'cc4:1 cc64:1 cc64:0 cc4:0');
    check('R2b: and the same snapshot', s.snapshot.pedalMode, 'sostenuto');
    quiet(); roles('sustain', 'sustain');
    capture.startRecording();
    cc4(50); cc64(127); cc64(0); cc4(0);
    s = capture.stopRecording();
    check('R3: two dampers record as one depth', kinds(s), 'cc4:' + (+(50 / 127).toFixed(3)) + ' cc4:1 cc4:' + (+(50 / 127).toFixed(3)) + ' cc4:0');
    quiet(); roles('none', 'ctrl');
    capture.startRecording();
    cc64(127); cc4(100); cc4(0); cc64(0);
    s = capture.stopRecording();
    check('R4: Ctrl and None record nothing', s.events.length, 0);
    quiet(); roles('sustain', 'none');
    cc4(100);
    capture.startRecording();
    s = capture.stopRecording();
    check('R5: a damper already down is seeded at the start', kinds(s), 'cc4:' + (+(100 / 127).toFixed(3)));
    cc4(0);
  });

  /* ── P: playback reads the take, not the dropdowns ── */
  await section('P', async () => {
    quiet(); roles('none', 'ctrl');
    audio.activeWaveform = 'sine'; audio.audioEnabled = true; engine.initAudio();
    const snap = (pedalMode) => ({ ...snapMod.captureSnapshot(), instrument: 'sine', pedalMode });
    /* a far-off last event keeps playback open until the gate stops it */
    const play = async (pedalMode, events) => {
      playback.startPlayback({ format: 'hkr', version: 1, createdAt: '', durationSec: 60,
        timing: { unit: 'audioCtxSec', epoch: 0 }, snapshot: snap(pedalMode),
        events: [...events, { t: 60, k: 'warn', msg: 'hold' }] });
      await wait(200);
    };
    await play('sustain', [{ t: 0, k: 'cc4', v: 0.4 }, { t: 0.01, k: 'cc64', v: 1 }]);
    is('P1a: an old Sustain-mode take: cc64 is a second damper', 1, false, false);
    playback.stopPlayback();
    is('P1b: stop releases the take\\'s damper', 0, false, false);
    await play('sostenuto', [{ t: 0, k: 'cc4', v: 0.4 }, { t: 0.01, k: 'cc64', v: 1 }]);
    is('P2a: a new take: cc4 the damper, cc64 the sostenuto', 0.4, true, false);
    cc64(127);
    is('P2b: a live Ctrl pedal during playback is still Ctrl', 0.4, true, true);
    cc64(0);
    playback.stopPlayback();
    is('P2c: stop releases the take\\'s damper and sostenuto', 0, false, false);
    await apply.applySnapshot(snap('sustain'));
    check('P3: applying a take\\'s snapshot leaves the dropdowns alone',
      selEl('expr').value + ' ' + selEl('sus').value + ' ' + pedal.roles.expr + ' ' + pedal.roles.sus, 'none ctrl none ctrl');
    check('P4: a take matches live whatever its pedalMode', snapMod.snapshotMatchesLive(snap('sustain')), true);
    audio.audioEnabled = false;
  });

  /* leave nothing behind */
  try { quiet(); roles('sustain', 'sustain'); } catch (e) { /* reported above */ }
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
