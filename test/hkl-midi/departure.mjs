// HKL Lumatone MIDI-input gate: departure handling + the liveness heartbeat.
//
// HKL has no test harness of its own, so this reuses Composer's app-agnostic
// CDP layer pointed at the HKL core app. It drives the REAL modules — imported
// live from the dev server, so they are the same singletons the app uses — and
// delivers every message THROUGH a simulated MIDIInput's onmidimessage, which
// is what makes the port-detach assertions meaningful rather than cosmetic.
// The simulated MIDIOutput answers heartbeat pings (CMD 33h) when "alive" and
// swallows them when "dead", which is how a powered-off Lumatone behaves.
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/departure.mjs        # exits non-zero on any failure
//
// Covers:
//   A/A2  normal playing latches voices; a pitch bend is IGNORED
//   B     a departure releases held voices and detaches the port
//   C/C2  a burst arriving after detach cannot be latched; probe degradation
//   D     a damper held at power-off is forced released (CC 4/64 are the
//         device's own jacks, so their release can never arrive)
//   E     a throwing release handler must not eat the status-badge update
//   F     a reconnect re-attaches and plays normally
//   G1-G7 the heartbeat: idle when nothing is held, velocity 127 plays with no
//         delay, a live device survives a held chord, active traffic sends no
//         pings, a dead device's burst / damper is released, a janked wait is
//         inconclusive rather than a miss
//   H     a re-check while connected (fresh MIDIInput object, same port id)
//         detaches the old object, so a burst can't leak through it
//   I     after a self-declared departure, a reappearing port is adopted only
//         once it answers a ping

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';

const URL = process.env.HKL_URL ?? 'http://localhost:5170/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  /* Import engine/heartbeat by the exact URL handler.ts imports them by. Once
     a module has been hot-reloaded, Vite serves its importers a '?t=<stamp>'
     URL, so a bare '/src/midi/engine.ts' import here would be a SECOND engine
     instance — one with no release handler registered — and the departure
     checks would silently test the wrong object. */
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) return depPath;
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  const [handler, midiState, sel, audioState, pedalState, eng, heartbeat] = await Promise.all([
    import('/src/midi/handler.ts'),
    import('/src/state/midi.ts'),
    import('/src/state/selection.ts'),
    import('/src/state/audio.ts'),
    import('/src/state/pedal.ts'),
    depUrl('/src/midi/handler.ts', '/src/midi/engine.ts').then((u) => import(u)),
    depUrl('/src/midi/handler.ts', '/src/midi/heartbeat.ts').then((u) => import(u)),
  ]);
  const { midi } = midiState, { selection } = sel, { audio } = audioState, { pedal } = pedalState;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });

  /* Ping reply exactly as sysexResponsePing writes it:
     F0 00 21 50 00 33 01 <the 4 data bytes echoed> F7 */
  const isPing = (m) => m[4] === 0x00 && m[5] === 0x33;
  const pingReply = (m) => new Uint8Array([0xF0, 0x00, 0x21, 0x50, 0x00, 0x33, 0x01, m[6], m[7], m[8], m[9], 0xF7]);

  /* A fake port pair that behaves like a real Lumatone: every inbound message
     is delivered THROUGH onmidimessage, so detaching it drops messages exactly
     as the browser would; when alive, the output answers pings on the input. */
  let fakeIn, fakeOut, pingCount = 0;
  function install(alive = true) {
    fakeIn = { id: 'fake-lumatone-in', name: 'Lumatone', state: 'connected', onmidimessage: null };
    const inPort = fakeIn;
    fakeOut = {
      id: 'fake-lumatone-out', name: 'Lumatone', state: 'connected',
      send(m) {
        if (!isPing(m)) return;
        pingCount++;
        if (alive) setTimeout(() => { if (inPort.onmidimessage) inPort.onmidimessage({ data: pingReply(m) }); }, 1);
      },
    };
    midi.midiIn = fakeIn; midi.midiOut = fakeOut;
    fakeIn.onmidimessage = handler.handleMidiMessage;
    pingCount = 0;
    /* put the badge in the state a real connection leaves it in, so the
       departure has something to flip */
    const el = document.getElementById('lumaStatus');
    const grp = document.getElementById('tb-group-lumatone');
    if (el) { el.textContent = 'Lumatone connected'; el.className = 'luma-connected'; }
    if (grp) grp.classList.add('lumatone-connected');
  }
  const badge = () => {
    const el = document.getElementById('lumaStatus');
    return el ? el.textContent + '|' + el.className : 'MISSING';
  };
  const groupConnected = () =>
    !!document.getElementById('tb-group-lumatone')?.classList.contains('lumatone-connected');
  const deliver = (...bytes) => {
    if (fakeIn.onmidimessage) fakeIn.onmidimessage({ data: new Uint8Array(bytes) });
  };
  const reset = () => {
    heartbeat.stopHeartbeat();
    selection.selectedKeys.clear(); audio.sustainedKeys.clear();
    handler.clearHeldLumatoneTracking();
    pedal.cc4Depth = 0; pedal.cc64Depth = 0; audio.damperDepth = 0; audio.sustainPedalDown = false;
  };
  const gone = (why = 'test') => eng.markLumatoneGone(why);

  /* ---- 0. probe instrument loads and degrades gracefully ---- */
  const probe = await import('/src/lumatone/probe.ts');
  check('0: lumaprobe exposed', typeof window.lumaprobe?.latency, 'function');
  check('0: monitor attached', typeof probe.probeMonitor, 'function');
  midi.midiOut = null;
  const r0 = await probe.probeOnce(1);
  check('0: probe with no port is graceful', r0.status, 'no-port');

  /* ---- A. control: real playing latches voices ---- */
  reset(); install();
  deliver(0x90, 0, 100);
  deliver(0x90, 5, 90);
  check('A: two real note-ons held', selection.selectedKeys.size, 2);
  check('A: port still attached', typeof fakeIn.onmidimessage, 'function');
  check('A: badge reads connected', badge(), 'Lumatone connected|luma-connected');

  /* ---- A2. a pitch bend is IGNORED (it was too unreliable to commit on) ---- */
  deliver(0xE0, 127, 127);
  check('A2: pitch bend does not trigger departure', selection.selectedKeys.size, 2);
  check('A2: port still attached after bend', typeof fakeIn.onmidimessage, 'function');

  /* ---- B. a departure releases + detaches ---- */
  gone();
  check('B: held voices released', selection.selectedKeys.size, 0);
  check('B: input port detached', fakeIn.onmidimessage, null);
  check('B: midi.midiIn nulled', midi.midiIn, null);
  check('B: midi.midiOut nulled', midi.midiOut, null);
  check('B: badge flipped to disconnected', badge(), 'Lumatone Not Connected|luma-disconnected');
  check('B: card lost connected class', groupConnected(), false);

  /* ---- C. anything arriving after the detach must not latch ---- */
  const burst = [[1,7],[1,23],[2,4],[3,41],[4,12],[5,33],[5,50]];
  for (const [ch, note] of burst) deliver(0x90 + (ch - 1), note, 127);
  check('C: late burst dropped, nothing sounding', selection.selectedKeys.size, 0);
  check('C: nothing sustained', audio.sustainedKeys.size, 0);

  /* ---- C2. probe timeout path resolves (fake port answers only pings) ---- */
  reset(); install();
  const rT = await probe.probeOnce(1, 0x3A, 60);
  check('C2: unanswered probe times out', rT.status, 'timeout');
  check('C2: real playing unaffected by monitor', (deliver(0x90, 11, 55), selection.selectedKeys.size), 1);

  /* ---- D. pedal held down at power-off must also release ---- */
  reset(); install();
  deliver(0xB0, 64, 127);           // sustain pedal down
  check('D: damper engaged', audio.sustainPedalDown, true);
  deliver(0x90, 9, 80);             // strike
  deliver(0x80, 9, 0);              // release under pedal -> sustained
  check('D: note sustained by pedal', audio.sustainedKeys.size, 1);
  gone();
  check('D: sustained note released', audio.sustainedKeys.size, 0);
  check('D: damper forced released', audio.sustainPedalDown, false);
  check('D: cc64 cleared', pedal.cc64Depth, 0);

  /* ---- E. a failing release must not eat the badge update ---- */
  reset(); install();
  deliver(0x90, 2, 64);
  eng.setLumatoneLostHandler(() => { throw new Error('simulated cleanup failure'); });
  gone();
  check('E: badge still flips when release throws', badge(), 'Lumatone Not Connected|luma-disconnected');
  check('E: port still detached when release throws', fakeIn.onmidimessage, null);
  eng.setLumatoneLostHandler(handler.releaseLumatoneInput);  /* restore */

  /* ---- F. re-arm: a reconnect re-attaches and plays normally ---- */
  reset(); install();
  deliver(0x90, 3, 77);
  check('F: plays again after reconnect', selection.selectedKeys.size, 1);

  /* ══ G. liveness heartbeat ══════════════════════════════════════════════ */
  const Q = heartbeat.HEARTBEAT_QUIET_MS, T = heartbeat.HEARTBEAT_REPLY_TIMEOUT_MS;
  const M = heartbeat.HEARTBEAT_MISSES_TO_DEPART;
  const departWithin = Q + M * T + 300;  /* quiet, M timed-out pings, margin */

  /* G1 — nothing held: no pings at all */
  reset(); install(true);
  deliver(0x90, 20, 100);
  deliver(0x80, 20, 0);
  await sleep(Q + 150);
  check('G1: idle when nothing is held', pingCount, 0);

  /* G2 — velocity 127 plays immediately: no hold, no guard */
  reset(); install(true);
  deliver(0x90, 21, 127);
  check('G2a: v127 sounds with no delay', selection.selectedKeys.size, 1);
  check('G2b: guard API removed', typeof handler.setPowerOffNoteGuard, 'undefined');

  /* G3 — a live device survives a held, motionless chord */
  reset(); install(true);
  deliver(0x90, 22, 127);
  deliver(0x91, 10, 127);
  await sleep(Q + 3 * T);
  check('G3a: pings sent while quiet + holding', pingCount >= 1, true);
  check('G3b: still connected', midi.midiOut === fakeOut, true);
  check('G3c: chord still held', selection.selectedKeys.size, 2);

  /* G4 — active traffic is proof of life: no pings at all */
  reset(); install(true);
  deliver(0x90, 24, 100);
  for (let i = 0; i < 8; i++) { await sleep(50); deliver(0xA0, 24, 40 + i); }
  check('G4: no pings during active traffic', pingCount, 0);

  /* G5 — THE CASE: a dead device's burst (mixed velocities, as captured) is
     NOT filtered — it sounds — and is released once the pings go unanswered */
  reset(); install(false);
  const powerOff = [[2,15,127],[3,32,122],[3,33,117],[3,34,109],[5,36,127]];
  for (const [ch, note, v] of powerOff) deliver(0x90 + (ch - 1), note, v);
  check('G5a: burst latches at first', selection.selectedKeys.size, 5);
  await sleep(departWithin);
  check('G5b: burst released', selection.selectedKeys.size, 0);
  check('G5c: port detached', fakeIn.onmidimessage, null);
  check('G5d: midiOut nulled', midi.midiOut, null);
  check('G5e: badge flipped', badge(), 'Lumatone Not Connected|luma-disconnected');
  check('G5f: took ' + M + ' pings', pingCount >= M, true);

  /* G6 — a damper alone (no keys) on a dead device is also released */
  reset(); install(false);
  deliver(0xB0, 64, 127);
  check('G6a: damper engaged', audio.sustainPedalDown, true);
  await sleep(departWithin);
  check('G6b: damper released', audio.sustainPedalDown, false);
  check('G6c: departed', midi.midiOut, null);

  /* G7 — a janked wait is inconclusive, never a miss */
  reset(); install(false);
  deliver(0x90, 23, 100);
  await sleep(Q + 20);                       /* first ping now in flight */
  const busyUntil = performance.now() + T + 200;
  while (performance.now() < busyUntil) { /* block the main thread */ }
  await sleep(10);
  check('G7a: no departure from a janked wait', midi.midiOut === fakeOut, true);
  await sleep(M * T + 300);
  check('G7b: departs once waits are clean', midi.midiOut, null);

  /* ══ H. a re-check while connected must not leave two port objects wired ══
     Firefox's re-check (status-badge click) re-requests MIDIAccess, which
     yields a FRESH MIDIInput object for the same physical port. Both stay
     open, so the browser delivers each message to every object that still has
     a handler. If findLumatone leaves the old one wired, every message is
     handled twice, and markLumatoneGone (which detaches only midi.midiIn)
     leaves the old object feeding anything still in flight into the app. */
  reset(); install(true);
  const staleIn = fakeIn;
  const freshIn = { id: staleIn.id, name: 'Lumatone', state: 'connected', onmidimessage: null };
  const freshOut = { id: midi.midiOut.id, name: 'Lumatone', state: 'connected', send() {} };
  const savedAccess = midi.midiAccess;
  midi.midiAccess = {
    inputs: new Map([[freshIn.id, freshIn]]),
    outputs: new Map([[freshOut.id, freshOut]]),
  };
  eng.findLumatone(handler.handleMidiMessage);
  midi.midiAccess = savedAccess;
  check('H1: re-check adopts the fresh object', midi.midiIn === freshIn, true);
  check('H2: stale object detached', staleIn.onmidimessage, null);
  /* the browser's view: one physical message reaches every wired object */
  const deliverPhys = (...bytes) => {
    for (const p of [staleIn, freshIn]) if (p.onmidimessage) p.onmidimessage({ data: new Uint8Array(bytes) });
  };
  gone();
  deliverPhys(0x90, 31, 100);
  check('H3: nothing latches after departure', selection.selectedKeys.size, 0);
  check('H4: no object left wired after departure', !!(staleIn.onmidimessage || freshIn.onmidimessage), false);

  /* ══ I. after a self-declared departure, re-adopt only a port that answers ══
     Firefox keeps listing a powered-off Lumatone as connected while its USB
     link lingers, so the hotplug poll would otherwise re-adopt a dead device
     and show "connected" indefinitely. */
  reset(); install(true);
  gone();                                    /* sets pendingReconnect */
  const mkPair = (alive) => {
    const inp = { id: 'fake-lumatone-in', name: 'Lumatone', state: 'connected', onmidimessage: null };
    const out = {
      id: 'fake-lumatone-out', name: 'Lumatone', state: 'connected',
      send(m) { if (alive && isPing(m)) setTimeout(() => { if (inp.onmidimessage) inp.onmidimessage({ data: pingReply(m) }); }, 1); },
    };
    return { inp, out, access: { inputs: new Map([[inp.id, inp]]), outputs: new Map([[out.id, out]]) } };
  };
  const dead = mkPair(false);
  midi.midiAccess = dead.access;
  eng.findLumatone(handler.handleMidiMessage);
  check('I1: dead candidate not adopted', midi.midiOut, null);
  check('I2: badge stays disconnected', badge(), 'Lumatone Not Connected|luma-disconnected');
  await sleep(600);
  check('I3: dead candidate dropped after timeout', dead.inp.onmidimessage, null);
  check('I4: still not adopted', midi.midiOut, null);
  const live = mkPair(true);
  midi.midiAccess = live.access;
  eng.findLumatone(handler.handleMidiMessage);
  check('I5: not adopted before the reply', midi.midiOut, null);
  await sleep(40);
  check('I6: adopted once it answers', midi.midiOut === live.out, true);
  check('I7: input wired to the app', live.inp.onmidimessage === handler.handleMidiMessage, true);
  check('I8: badge reads connected', badge(), 'Lumatone connected|luma-connected');
  midi.midiAccess = savedAccess;

  /* leave nothing running */
  reset();
  const sx = await import('/src/lumatone/sysex.ts');
  sx.sysex.cancel();
  midi.midiIn = null; midi.midiOut = null;

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
