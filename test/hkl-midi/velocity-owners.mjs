// HKL velocity-ownership gate: each velocity store has one owner.
//   • audio.keyVelocity is LIVE input's (Lumatone / QWERTY / piano strikes,
//     cleared on release). Composer playback carries its own velocity per
//     event and must neither leave entries there nor read them.
//   • Per-key velocity calibration (gain, capture, stats) belongs to the
//     PHYSICAL Lumatone key ("ch,note"), not the lattice cell under it, so it
//     survives a ref change that slides the lattice.
//
// Same harness as held-inputs.mjs: the REAL modules imported live from the dev
// server (resolved through their importers), Lumatone messages through a
// simulated MIDIInput, Composer playback through the live bridge channel.
// Voices are oscillators (no sample load); a voice's `vol` scales with its
// strike velocity, which is what the P checks compare.
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/velocity-owners.mjs     # exits non-zero on any failure
//
// Covers:
//   P1  a click after Composer playback of the same cell strikes at the
//       default dynamic, not the playback's (backlog: "notes stuck loud/soft")
//   P2  a playback event without a velocity ignores live-input state
//   R1  the same as P1 for .hkr recording playback
//   K1  per-key gain follows the physical key across an anchor change
//   K2  the key now under the calibrated key's old cell is not calibrated
//   K3  velocity stats accumulate per physical key across an anchor change
//   M   v3 prefs (lattice-keyed per-key data) migrate to physical keys under
//       the capture anchor the saved cells prove; unexplainable data is dropped

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  /* Resolve a module by the exact URL an importer uses (see held-inputs.mjs). */
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) throw new Error(depPath + ' is not imported by ' + fromPath);
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  const refUrl = await depUrl('/src/ui/init.ts', '/src/effects/onRefChanged.ts');
  const handlerUrl = await depUrl(refUrl, '/src/midi/handler.ts');
  const heldUrl = await depUrl(handlerUrl, '/src/input/held.ts');
  const selChangedUrl = await depUrl(heldUrl, '/src/effects/onSelectionChanged.ts');
  const midiEngUrl = await depUrl(handlerUrl, '/src/midi/engine.ts');
  const audioEngUrl = await depUrl(heldUrl, '/src/audio/engine.ts');
  const hkrPlayUrl = await depUrl(await depUrl('/src/ui/init.ts', '/src/ui/recorder.ts'), '/src/recording/playback.ts');
  const [selChanged, handler, held, midiEng, audioEng, hkrPlay, calMod, viewMod, selMod, audioMod, midiMod, tuningMod, heartbeat, sx] =
    await Promise.all([
      import(selChangedUrl), import(handlerUrl), import(heldUrl), import(midiEngUrl), import(audioEngUrl), import(hkrPlayUrl),
      depUrl(handlerUrl, '/src/audio/velocityCal.ts').then((u) => import(u)),
      depUrl(midiEngUrl, '/src/layout/physical.ts').then((u) => depUrl(u, '/src/state/view.ts')).then((u) => import(u)),
      depUrl(heldUrl, '/src/state/selection.ts').then((u) => import(u)),
      depUrl(heldUrl, '/src/state/audio.ts').then((u) => import(u)),
      depUrl(midiEngUrl, '/src/state/midi.ts').then((u) => import(u)),
      depUrl('/src/ui/init.ts', '/src/state/tuning.ts').then((u) => import(u)),
      depUrl(handlerUrl, '/src/midi/heartbeat.ts').then((u) => import(u)),
      depUrl(handlerUrl, '/src/lumatone/sysex.ts').then((u) => import(u)),
    ]);
  const { view } = viewMod, { selection } = selMod, { audio } = audioMod;
  const { midi } = midiMod, { tuning } = tuningMod, { velocityCal } = calMod;

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });
  const truthy = (name, got) => results.push({ name, got, want: true, ok: got === true });

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

  /* Oscillator voices: no sample-set load, and vol ∝ velocityBaseVol(velocity). */
  const savedWaveform = audio.activeWaveform;
  audio.activeWaveform = 'sine';
  audio.audioEnabled = true;
  audioEng.initAudio();

  const a0q = view.kbAnchorQ, a0r = view.kbAnchorR;
  const setAnchor = (q, r) => { view.kbAnchorQ = q; view.kbAnchorR = r; };
  const reset = () => {
    heartbeat.stopHeartbeat();
    audioEng.stopAllNotes();
    selection.selectedKeys.clear(); audio.sustainedKeys.clear();
    held.clearAllHeld();
    setAnchor(a0q, a0r);
  };

  /* A mouse click: the same two steps as the canvas click handler. Returns
     the struck voice's vol, then un-clicks. */
  const clickVol = (k) => {
    selection.selectedKeys.add(k); selChanged.onSelectionChanged();
    const vol = audio.activeOscs[k]?.vol;
    selection.selectedKeys.delete(k); selChanged.onSelectionChanged();
    return vol;
  };

  /* Composer playback of one short note on the live bridge channel. Resolves
     with the playback voice's vol once HKL reports playback-finished. */
  const bridgeCh = new BroadcastChannel('hkl-composer-bridge');
  const playOnce = (k, velocity) => new Promise((resolve) => {
    const [q, r] = k.split(',').map(Number);
    let vol;
    const poll = setInterval(() => { if (audio.activeOscs[k]) vol = audio.activeOscs[k].vol; }, 5);
    const done = () => { clearInterval(poll); bridgeCh.removeEventListener('message', onMsg); clearTimeout(t); setTimeout(() => resolve(vol), 50); };
    const onMsg = (e) => { if (e.data?.type === 'playback-finished') done(); };
    const t = setTimeout(done, 3000);
    bridgeCh.addEventListener('message', onMsg);
    const ev = { atMs: 0, durationMs: 120, notes: [{ q, r }] };
    if (velocity !== undefined) ev.velocity = velocity;
    bridgeCh.postMessage({ type: 'play-score', mapping: tuning.mapping, events: [ev], pedalEvents: [] });
  });

  /* ── P: Composer playback vs live input ── */
  reset();
  const K = '1,0';
  const vClick = clickVol(K);
  truthy('P0: a fresh click sounds', typeof vClick === 'number' && vClick > 0);
  const vPlay = await playOnce(K, 25);
  truthy('P1a: the playback voice took its pp dynamic', typeof vPlay === 'number' && vPlay < vClick);
  check('P1b: playback leaves no live-input velocity behind', audio.keyVelocity[K], undefined);
  check('P1c: a click after playback strikes at the default dynamic', clickVol(K), vClick);

  reset();
  const K2 = '2,0';
  const vClick2 = clickVol(K2);
  audio.keyVelocity[K2] = 25;                 /* live-input state for this cell */
  const vPlay2 = await playOnce(K2);          /* event carries no velocity */
  check('P2: a velocity-less playback event ignores live-input state', vPlay2, vClick2);
  delete audio.keyVelocity[K2];

  /* .hkr playback of one pp note. Both events fall inside the scheduler's
     first lookahead window, so they dispatch even if the audio clock is
     frozen headless. */
  reset();
  const K3 = '3,0';
  const vClick3 = clickVol(K3);
  const [q3, r3] = K3.split(',').map(Number);
  await new Promise((resolve) => {
    hkrPlay.startPlayback({
      format: 'hkr', version: 1, createdAt: '', durationSec: 0.05,
      timing: { unit: 'audioCtxSec', epoch: 0 },
      snapshot: { tuning: tuning.mode, mapping: tuning.mapping, anchor: tuning.anchor, banded: tuning.banded, septimalEnabled: false,
        equalEnabled: false, septimalW: 0, instrument: 'sine', pedalMode: 'sustain', refHz: 220 },
      events: [{ t: 0, k: 'on', q: q3, r: r3, v: 25 }, { t: 0.05, k: 'off', q: q3, r: r3 }],
    }, resolve);
    setTimeout(resolve, 3000);
  });
  check('R1a: .hkr playback leaves no live-input velocity behind', audio.keyVelocity[K3], undefined);
  check('R1b: a click after .hkr playback strikes at the default dynamic', clickVol(K3), vClick3);

  /* ── K: per-key calibration follows the physical key ── */
  /* Channel 1 note 24 is baseKeys [-12,5]; three columns to its left, note 21
     ([-15,5]) is the key an anchor shift of (+3, 0) puts on its old cell. */
  const CAL = 24;
  const on = (ch, note, v) => deliver(0x90 + ch - 1, note, v);
  const off = (ch, note) => deliver(0x80 + ch - 1, note, 0);
  const strikeVel = (ch, note) => {
    on(ch, note, 60);
    const v = audio.keyVelocity[midiEng.fixedMidiToKey(ch, note)];
    off(ch, note);
    return v;
  };

  reset();
  velocityCal.clearPerKey();
  velocityCal.startCapture();
  on(1, CAL, 60); off(1, CAL);
  velocityCal.stopCaptureAndCompute(120);      /* gain 2.0 for ch 1 note 24 */
  const calibrated = velocityCal.applyInputCurve(120);
  const plain = velocityCal.applyInputCurve(60);
  truthy('K0: the test velocities are distinguishable', calibrated !== plain);

  check('K1a: calibrated key, original anchor', strikeVel(1, CAL), calibrated);
  const oldCell = midiEng.fixedMidiToKey(1, CAL);
  setAnchor(a0q + 3, a0r);
  check('K1b: calibrated key, after an anchor change', strikeVel(1, CAL), calibrated);
  /* Whichever physical key now sits on the calibrated key's old cell. */
  let other = null;
  for (let ch = 1; ch <= 5 && !other; ch++)
    for (let n = 0; n < 56 && !other; n++)
      if (midiEng.fixedMidiToKey(ch, n) === oldCell) other = [ch, n];
  check('K2a: the key now on the old cell', JSON.stringify(other), JSON.stringify([1, 21]));
  if (other) check('K2b: that key is not calibrated', strikeVel(other[0], other[1]), plain);
  velocityCal.clearPerKey();

  reset();
  const statsWas = velocityCal.statsEnabled;
  velocityCal.setStatsEnabled(true);
  velocityCal.clearStats();
  on(1, CAL, 60); off(1, CAL);
  setAnchor(a0q + 3, a0r);
  on(1, CAL, 60); off(1, CAL);
  const all = velocityCal.getAllStats();
  check('K3a: one physical key → one stats entry', all.length, 1);
  check('K3b: both strikes counted for it', all[0]?.stats.n, 2);
  velocityCal.clearStats();
  velocityCal.setStatsEnabled(statsWas);

  /* leave nothing running */
  reset();
  bridgeCh.close();
  audio.activeWaveform = savedWaveform;
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

/* M: v3 prefs (per-key data keyed by the lattice cell a key struck: baseKeys[i]
   + the unrecorded capture-time anchor) migrate on load to v4 physical keys,
   under the anchor the saved cells prove. Each round seeds a v3 velocityCal,
   reloads, and checks. */
const MODS = `
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) throw new Error(depPath + ' is not imported by ' + fromPath);
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  const refUrl = await depUrl('/src/ui/init.ts', '/src/effects/onRefChanged.ts');
  const handlerUrl = await depUrl(refUrl, '/src/midi/handler.ts');
  const calUrl = await depUrl(handlerUrl, '/src/audio/velocityCal.ts');
  const { velocityCal } = await import(calUrl);
  const { baseKeys } = await import(await depUrl(calUrl, '/src/layout/baseKeys.ts'));
  const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });
`;
const V3_BASE = {
  version: 3, floor: 0.07, ceiling: 1, gamma: 1.5,
  inputCurve: { floor: 0.1, ceiling: 1, gamma: 15.5 },
  intervalCurve: { low: 1, high: 127, gamma: 1 },
};
const STAT = { n: 7, mean: 60, stddev: 3, cv: 0.05, p5: 55, p95: 65 };
async function migrationRound(seedBody, checkBody) {
  await cdp.evalJSON(`(async () => { ${MODS}
    const p = JSON.parse(localStorage.getItem('hkl.prefs.v1') || '{}');
    p.velocityCal = { ...${JSON.stringify(V3_BASE)}, ...(() => { ${seedBody} })() };
    localStorage.setItem('hkl.prefs.v1', JSON.stringify(p));
    return true;
  })()`);
  const reloaded = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
  await cdp.send('Page.reload', {});
  await reloaded;
  await sleep(2500);
  const r = await cdp.evalJSON(`(async () => { ${MODS}
    const stored = JSON.parse(localStorage.getItem('hkl.prefs.v1')).velocityCal;
    ${checkBody}
    return { results };
  })()`);
  return r?.results ?? [{ name: 'M: migration round ran', got: JSON.stringify(r), want: 'results', ok: false }];
}
const mig = [
  /* Captured at A3: [-12,5] is ch 1 note 24, [-15,5] ch 1 note 21. The
     non-default floor catches a wrongful re-run of the v1/v2 curve migration. */
  ...await migrationRound(
    `return { perKey: { '-12,5': 2, '-15,5': 0.5 }, stats: { '-12,5': ${JSON.stringify(STAT)} } };`,
    `check('M1: cells that all land on keys at A3 migrate there', sorted(velocityCal.perKey), sorted({ '1,24': 2, '1,21': 0.5 }));
     check('M2: stats migrate the same way', velocityCal.getAllStats().map((s) => s.key).join(' '), '1,24');
     check('M3: the migration is persisted as v4', stored.version, 4);
     check('M4: persisted gains are physical', sorted(stored.perKey), sorted({ '1,24': 2, '1,21': 0.5 }));
     check('M5: a v3 curve is not re-migrated', velocityCal.floor, 0.07);`),
  /* The whole keyboard captured under a ref whose anchor was (3, 0): A3 puts
     cells off the keyboard, and only (3, 0) puts them all on it. Stats mixing a
     key with an off-keyboard cell fit no single anchor. */
  ...await migrationRound(
    `const perKey = {};
     baseKeys.forEach(([q, r], i) => { perKey[(q + 3) + ',' + r] = 1 + i / 1000; });
     return { perKey, stats: { '-12,5': ${JSON.stringify(STAT)}, '99,99': ${JSON.stringify(STAT)} } };`,
    `let wrong = 0;
     baseKeys.forEach((_, i) => { if (velocityCal.perKey[(Math.floor(i / 56) + 1) + ',' + (i % 56)] !== 1 + i / 1000) wrong++; });
     check('M6a: a capture under another ref keeps every gain', Object.keys(velocityCal.perKey).length, 280);
     check('M6b: each gain lands on the key that was captured', wrong, 0);
     check('M7: data no single anchor explains is dropped, not guessed', velocityCal.getAllStats().length, 0);`),
];
if (out?.results) {
  out.results.push(...mig);
  out.pass = out.results.every((r) => r.ok);
}

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
