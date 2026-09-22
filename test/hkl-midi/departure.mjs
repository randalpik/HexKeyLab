// HKL Lumatone MIDI-input gate: departure handling + the power-off note guard.
//
// HKL has no test harness of its own, so this reuses Composer's app-agnostic
// CDP layer pointed at the HKL core app. It drives the REAL modules — imported
// live from the dev server, so they are the same singletons the app uses — and
// delivers every message THROUGH a simulated MIDIInput's onmidimessage, which
// is what makes the port-detach assertions meaningful rather than cosmetic.
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/departure.mjs        # exits non-zero on any failure
//
// Covers:
//   A/A2  normal playing latches voices; a pitch bend is IGNORED
//   B     the velocity-127 burst releases held voices and detaches the port
//   C/C2  a burst arriving after detach cannot be latched; probe degradation
//   D     a damper held at power-off is forced released (CC 4/64 are the
//         device's own jacks, so their release can never arrive)
//   E     a throwing release handler must not eat the status-badge update
//   F     a reconnect re-attaches and plays normally
//   G1-G7 the guard: off by default, holds a lone v127 and releases it,
//         condemns on the second, replays mixed traffic in arrival order,
//         never strands a held note when toggled off, ignores sub-127 notes
//
// Behavioral check for the Lumatone power-off departure handling.
// Drives the REAL app modules through a simulated MIDI input port, replaying
// the captured power-off sequence: pitch bend, then a velocity-127 burst.
//
// Requires `pnpm dev` (umbrella proxy at :5170) running.

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';

const URL = process.env.HKL_URL ?? 'http://localhost:5170/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  const [handler, midiState, sel, audioState, pedalState] = await Promise.all([
    import('/src/midi/handler.ts'),
    import('/src/state/midi.ts'),
    import('/src/state/selection.ts'),
    import('/src/state/audio.ts'),
    import('/src/state/pedal.ts'),
  ]);
  const { midi } = midiState, { selection } = sel, { audio } = audioState, { pedal } = pedalState;

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });

  /* A fake port that behaves like a real MIDIInput: every message is delivered
     THROUGH onmidimessage, so detaching it drops messages exactly as the
     browser would. */
  let fakeIn;
  function install() {
    fakeIn = { id: 'fake-lumatone-in', name: 'Lumatone', state: 'connected', onmidimessage: null };
    const fakeOut = { id: 'fake-lumatone-out', name: 'Lumatone', state: 'connected', send() {} };
    midi.midiIn = fakeIn; midi.midiOut = fakeOut;
    fakeIn.onmidimessage = handler.handleMidiMessage;
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
  /* the burst signature: two velocity-127 note-ons inside the guard window */
  const condemn = () => { deliver(0x90, 50, 127); deliver(0x91, 10, 127); };
  const reset = () => {
    selection.selectedKeys.clear(); audio.sustainedKeys.clear();
    pedal.cc4Depth = 0; pedal.cc64Depth = 0; audio.damperDepth = 0; audio.sustainPedalDown = false;
  };

  /* ---- 0. probe instrument loads and degrades gracefully ---- */
  const probe = await import('/src/lumatone/probe.ts');
  check('0: lumaprobe exposed', typeof window.lumaprobe?.latency, 'function');
  check('0: monitor attached', typeof probe.probeMonitor, 'function');
  const r0 = await probe.probeOnce(1);
  check('0: probe with no port is graceful', r0.status, 'no-port');

  /* ---- A. control: real playing latches voices ---- */
  reset(); install();
  deliver(0x90, 0, 100);
  deliver(0x90, 5, 90);
  check('A: two real note-ons held', selection.selectedKeys.size, 2);
  check('A: port still attached', typeof fakeIn.onmidimessage, 'function');
  check('A: badge reads connected', badge(), 'Lumatone connected|luma-connected');

  /* ---- A2. a pitch bend is now IGNORED (it was too unreliable to commit on) ---- */
  deliver(0xE0, 127, 127);
  check('A2: pitch bend no longer triggers departure', selection.selectedKeys.size, 2);
  check('A2: port still attached after bend', typeof fakeIn.onmidimessage, 'function');

  /* ---- B. the v127 burst releases + detaches ---- */
  handler.setPowerOffNoteGuard(true);
  condemn();
  check('B: held voices released', selection.selectedKeys.size, 0);
  check('B: input port detached', fakeIn.onmidimessage, null);
  check('B: midi.midiIn nulled', midi.midiIn, null);
  check('B: midi.midiOut nulled', midi.midiOut, null);
  check('B: badge flipped to disconnected', badge(), 'Lumatone Not Connected|luma-disconnected');
  check('B: card lost connected class', groupConnected(), false);

  /* ---- C. THE BUG: the garbage burst that follows must not latch ---- */
  const burst = [[1,7],[1,23],[2,4],[3,41],[4,12],[5,33],[5,50]];
  for (const [ch, note] of burst) deliver(0x90 + (ch - 1), note, 127);
  check('C: burst dropped, nothing sounding', selection.selectedKeys.size, 0);
  check('C: nothing sustained', audio.sustainedKeys.size, 0);

  /* ---- C2. probe timeout path resolves (fake port swallows the send) ---- */
  reset(); install();
  const rT = await probe.probeOnce(1, 0x3A, 60);
  check('C2: unanswered probe times out', rT.status, 'timeout');
  check('C2: real playing unaffected by monitor', (deliver(0x90, 11, 55), selection.selectedKeys.size), 1);

  /* ---- D. pedal held down at power-off must also release ---- */
  reset(); install(); handler.setPowerOffNoteGuard(true);
  deliver(0xB0, 64, 127);           // sustain pedal down
  check('D: damper engaged', audio.sustainPedalDown, true);
  deliver(0x90, 9, 80);             // strike
  deliver(0x80, 9, 0);              // release under pedal -> sustained
  check('D: note sustained by pedal', audio.sustainedKeys.size, 1);
  condemn();                        // the burst signature
  check('D: sustained note released', audio.sustainedKeys.size, 0);
  check('D: damper forced released', audio.sustainPedalDown, false);
  check('D: cc64 cleared', pedal.cc64Depth, 0);

  /* ---- E. a failing release must not eat the badge update ---- */
  reset(); install(); handler.setPowerOffNoteGuard(true);
  deliver(0x90, 2, 64);
  const engine = await import('/src/midi/engine.ts');
  engine.setLumatoneLostHandler(() => { throw new Error('simulated cleanup failure'); });
  condemn();
  check('E: badge still flips when release throws', badge(), 'Lumatone Not Connected|luma-disconnected');
  check('E: port still detached when release throws', fakeIn.onmidimessage, null);
  engine.setLumatoneLostHandler(handler.releaseLumatoneInput);  /* restore */

  /* ---- F. re-arm: a reconnect re-attaches and plays normally ---- */
  reset(); install(); handler.setPowerOffNoteGuard(false);
  deliver(0x90, 3, 77);
  check('F: plays again after reconnect', selection.selectedKeys.size, 1);

  /* ══ G. power-off note guard ══════════════════════════════════════════ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const eng = await import('/src/midi/engine.ts');
  const keyOf = (ch, note) => eng.fixedMidiToKey(ch, note);

  /* G1 — off by default: a velocity-127 note is untouched */
  reset(); install(); handler.setPowerOffNoteGuard(false);
  deliver(0x90, 20, 127);
  check('G1: guard off -> v127 plays immediately', selection.selectedKeys.size, 1);

  /* G2 — a lone v127 is held, then released: delayed, never lost */
  reset(); install(); handler.setPowerOffNoteGuard(true);
  deliver(0x90, 21, 127);
  check('G2a: v127 silent during the window', selection.selectedKeys.size, 0);
  await sleep(80);
  check('G2b: lone v127 flushed after the window', selection.selectedKeys.size, 1);

  /* G3 — THE BUG: a second v127 inside the window condemns the burst */
  reset(); install();
  deliver(0x90, 22, 127);
  deliver(0x90, 23, 127);
  check('G3a: burst never sounds', selection.selectedKeys.size, 0);
  check('G3b: port detached', fakeIn.onmidimessage, null);
  await sleep(80);
  check('G3c: still silent after the window elapses', selection.selectedKeys.size, 0);

  /* G4 — mixed traffic inside a hold replays in arrival order */
  reset(); install(); handler.setPowerOffNoteGuard(true);
  deliver(0x90, 24, 127);   /* opens the hold */
  deliver(0x90, 25, 60);    /* ordinary note, buffered behind it */
  deliver(0x80, 24, 0);     /* release of the first, buffered */
  check('G4a: everything held during the window', selection.selectedKeys.size, 0);
  await sleep(80);
  check('G4b: replayed in order -> only the un-released note sounds', selection.selectedKeys.size, 1);
  check('G4c: the released note did not stick', selection.selectedKeys.has(keyOf(1, 24)), false);
  check('G4d: the ordinary note survived', selection.selectedKeys.has(keyOf(1, 25)), true);

  /* G5 — a full 5-note burst across boards */
  reset(); install();
  for (const [ch, note] of [[1,7],[1,23],[2,4],[3,41],[4,12]]) deliver(0x90 + (ch - 1), note, 127);
  check('G5a: full burst silent', selection.selectedKeys.size, 0);
  check('G5b: port detached', fakeIn.onmidimessage, null);
  await sleep(80);
  check('G5c: nothing sustained', audio.sustainedKeys.size, 0);

  /* G6 — turning the guard off mid-hold must not strand the held note */
  reset(); install(); handler.setPowerOffNoteGuard(true);
  deliver(0x90, 26, 127);
  check('G6a: held', selection.selectedKeys.size, 0);
  handler.setPowerOffNoteGuard(false);
  check('G6b: toggling off flushes rather than stranding', selection.selectedKeys.size, 1);

  /* G7 — ordinary playing is completely untouched with the guard ON */
  reset(); install(); handler.setPowerOffNoteGuard(true);
  deliver(0x90, 27, 100);
  deliver(0x90, 28, 126);
  check('G7: sub-127 notes are never held', selection.selectedKeys.size, 2);
  handler.setPowerOffNoteGuard(false);

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
