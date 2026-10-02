// HKL damper gate: the sustain pedal never RAISES a voice's level.
//
// Invariant: while a note is held by the damper, pedal motion can only hold
// its level or lower it (per depth). A partial lift that attenuates a note,
// followed by re-pressing the pedal, must NOT swell the note back up — a real
// damper that has touched the string has already taken that energy. Same for
// sostenuto catching an already-attenuated note.
//
// Same harness shape as departure.mjs: the REAL modules imported live from the
// dev server, messages delivered through handleMidiMessage exactly as a
// Lumatone would send them. Uses an oscillator voice (no sample loading) and
// wraps the voice's damperGain AudioParam so every scheduled value is recorded
// — the assertion is on what the engine SCHEDULES, so it holds whether or not
// headless Chromium lets the AudioContext run.
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/damper.mjs        # exits non-zero on any failure
//
// Covers:
//   R1    partial lift lowers a sustained voice to the pedal depth
//   R2    THE BUG: re-pressing the pedal holds the lowered level (no swell)
//   R3    a deeper lift lowers further; a partial re-press still holds
//   R4    a re-strike under the pedal is a fresh voice at full level
//   R5    sostenuto catching an attenuated note does not restore it
//   R6    sostenuto-off with the damper down does not restore it either
//   R7    a 400-step random pedal walk never schedules a rise
//   R8    full lift still releases the note

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';

const URL = process.env.HKL_URL ?? 'http://localhost:5170/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  const [handler, midiState, sel, audioState, pedalState, engine] = await Promise.all([
    import('/src/midi/handler.ts'),
    import('/src/state/midi.ts'),
    import('/src/state/selection.ts'),
    import('/src/state/audio.ts'),
    import('/src/state/pedal.ts'),
    import('/src/audio/engine.ts'),
  ]);
  const { midi } = midiState, { selection } = sel, { audio } = audioState, { pedal } = pedalState;

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });
  const near = (name, got, want) =>
    results.push({ name, got, want, ok: typeof got === 'number' && Math.abs(got - want) < 1e-6 });

  const fakeIn = { id: 'fake-lumatone-in', name: 'Lumatone', state: 'connected', onmidimessage: null };
  midi.midiIn = fakeIn;
  midi.midiOut = { id: 'fake-lumatone-out', name: 'Lumatone', state: 'connected', send() {} };
  fakeIn.onmidimessage = handler.handleMidiMessage;
  const deliver = (...bytes) => fakeIn.onmidimessage({ data: new Uint8Array(bytes) });
  const cc4 = (v) => deliver(0xB0, 4, v);
  const depthOf = (v) => (v <= 1 ? 0 : v / 127);

  /* oscillator voice: no sample-set load, damperGain is a plain AudioParam */
  audio.activeWaveform = 'sine';
  audio.audioEnabled = true;
  engine.initAudio();

  const reset = () => {
    pedal.mode = 'sustain';
    cc4(0); deliver(0xB0, 64, 0);
    if (audio.sostenutoActive) engine.sostenutoOff();
    engine.stopAllNotes?.();
    selection.selectedKeys.clear(); audio.sustainedKeys.clear();
  };

  /* Strike + release (ch 0, note n) under whatever pedal is down; return the
     key and a log of every value scheduled on its damperGain from here on. */
  function sustainNote(n, vel = 100) {
    const before = new Set(selection.selectedKeys);
    deliver(0x90, n, vel);
    const key = [...selection.selectedKeys].find((k) => !before.has(k))
      ?? [...selection.selectedKeys].find((k) => audio.activeOscs[k] && !audio.sustainedKeys.has(k));
    deliver(0x80, n, 0);
    const v = key && audio.activeOscs[key];
    const log = [];
    if (v && v.type === 'osc') {
      const p = v.damperGain.gain;
      for (const m of ['setTargetAtTime', 'setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime']) {
        const orig = p[m].bind(p);
        p[m] = (val, ...rest) => { log.push(val); return orig(val, ...rest); };
      }
      const desc = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
      Object.defineProperty(p, 'value', {
        get() { return desc.get.call(p); },
        set(val) { log.push(val); desc.set.call(p, val); },
      });
    }
    return { key, v, log };
  }
  const level = (v) => v.damperLevel ?? 1;
  const maxRise = (log, start = 1) => {
    let lo = start, worst = 0;
    for (const x of log) { worst = Math.max(worst, x - lo); lo = Math.min(lo, x); }
    return worst;
  };

  /* ---- R1/R2. partial lift, then re-press ---- */
  reset();
  cc4(127);
  let s = sustainNote(10);
  check('setup: osc voice created', s.v && s.v.type, 'osc');
  check('setup: note sustained', audio.sustainedKeys.has(s.key), true);
  cc4(38);
  near('R1: partial lift lowers to depth', level(s.v), depthOf(38));
  cc4(127);
  near('R2: re-press holds the lowered level', level(s.v), depthOf(38));
  check('R2: nothing scheduled above the lowered level', maxRise(s.log), 0);
  check('R2: still sustained', audio.sustainedKeys.has(s.key), true);

  /* ---- R3. deeper lift lowers; partial re-press holds ---- */
  cc4(20);
  near('R3: deeper lift lowers further', level(s.v), depthOf(20));
  cc4(30); cc4(90); cc4(127);
  near('R3: partial/full re-press holds', level(s.v), depthOf(20));
  check('R3: no scheduled rise', maxRise(s.log), 0);

  /* ---- R4. re-strike under pedal = fresh voice at full level ---- */
  deliver(0x90, 10, 100);
  const fresh = audio.activeOscs[s.key];
  check('R4: re-strike makes a new voice', fresh !== s.v, true);
  check('R4: fresh voice at full level', level(fresh), 1);
  deliver(0x80, 10, 0);
  check('R4: fresh voice sustained at full level', level(audio.activeOscs[s.key]), 1);

  /* ---- R5/R6. sostenuto catching an attenuated note ---- */
  reset();
  pedal.mode = 'sostenuto';
  cc4(127);
  s = sustainNote(12);
  cc4(38);
  near('R5: attenuated before sostenuto', level(s.v), depthOf(38));
  deliver(0xB0, 64, 127);               /* sostenuto on */
  check('R5: sostenuto locked the key', audio.sostenutoLockedKeys.has(s.key), true);
  near('R5: sostenuto does not restore level', level(s.v), depthOf(38));
  cc4(127);
  near('R5: damper re-press while locked holds', level(s.v), depthOf(38));
  deliver(0xB0, 64, 0);                 /* sostenuto off, damper still down */
  near('R6: sostenuto-off does not restore level', level(s.v), depthOf(38));
  check('R5/R6: no scheduled rise', maxRise(s.log), 0);

  /* ---- R7. random pedal walk (seeded) ---- */
  reset();
  cc4(127);
  s = sustainNote(14);
  let seed = 0x2545F491, lo = 1, walkOk = true;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  let val = 127;
  for (let i = 0; i < 400; i++) {
    val = Math.max(8, Math.min(127, val + Math.round((rnd() - 0.5) * 40)));
    cc4(val);
    lo = Math.min(lo, depthOf(val));
    if (Math.abs(level(s.v) - lo) > 1e-9) { walkOk = false; break; }
  }
  check('R7: level tracks running minimum of depth', walkOk, true);
  check('R7: no scheduled rise over the walk', maxRise(s.log), 0);
  check('R7: still sustained above the floor', audio.sustainedKeys.has(s.key), true);

  /* ---- R8. full lift releases ---- */
  cc4(0);
  check('R8: full lift releases', audio.sustainedKeys.has(s.key), false);
  check('R8: voice gone from selection', selection.selectedKeys.has(s.key), false);

  reset();
  audio.audioEnabled = false;
  return { results, pass: results.every((r) => r.ok) };
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
