// Hidden games: the motif listener's wiring and the Secrets toolbar
// (apps/hkl/src/games/discovery.ts, ui/secrets.ts; docs/architecture/hkl.md → Hidden games).
//
// The REAL modules imported live from the dev server (resolved through their
// importers, as in test/hkl-midi/ref-press.mjs), Lumatone presses through the
// input handler, a canvas click through a MouseEvent. The motif is written out
// here from the spec, not read from the module under test.
//
// Requires `pnpm dev` running (umbrella proxy at :5170). The page is pinned to
// a private overlay relay (never the live :5190), and Chromium is muted.
//
//   node test/games/secrets.mjs        # exits non-zero on any failure
//
// Covers:
//   S1  a fresh profile: the Secrets button and toolbar exist and are hidden;
//       no game is discovered
//   S2  the motif's first twelve notes change nothing, and each press is still
//       an ordinary note (selected while held, released after)
//   S3  the thirteenth reveals the button (active) and the toolbar, with a
//       Snake button and the count; the prefs hold the game and the toolbar
//   S4  the Secrets button toggles its toolbar like the other six
//   S5  Hide, declined at the confirmation: nothing changes
//   S6  Hide, confirmed: button and toolbar gone, prefs back to none
//   S7  under the QWERTY outline the same notes discover nothing
//   S8  back under the Lumatone outline, with the last note a canvas click
//       instead of a key: discovered (the click is heard too)
//   R1  after a reload the button and toolbar come back from the prefs
//   R2  the Reset button hides them and clears the discovered games

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PRELUDE = `
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) throw new Error(depPath + ' is not imported by ' + fromPath);
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  const root = '/src/ui/init.ts';
  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: JSON.stringify(got) === JSON.stringify(want) });
  const prefsMod = await import(await depUrl(root, '/src/state/persistence.ts'));
  const shown = (id) => {
    const el = document.getElementById(id);
    return !!el && getComputedStyle(el).display !== 'none';
  };
  const ui = () => ({
    button: shown('tbSecrets'),
    active: !!document.getElementById('tbSecrets')?.classList.contains('active'),
    toolbar: shown('tb-group-secrets'),
    games: Array.from(document.querySelectorAll('#tb-group-secrets button[data-game]')).map((b) => b.dataset.game + ':' + b.textContent.trim()),
    count: document.getElementById('secretsCount')?.textContent.trim() ?? null,
  });
  const stored = () => { const p = prefsMod.loadPrefs(); return { games: p.secretGames, toolbar: p.toolbars.secrets }; };
  const HIDDEN = { button: false, active: false, toolbar: false, games: [], count: '' };
  const FOUND = { button: true, active: true, toolbar: true, games: ['snake:Snake'], count: '1/2 secrets found' };
  const BOTH = { button: true, active: true, toolbar: true, games: ['snake:Snake', 'pong:Pong'], count: 'All secrets found' };
`;

const SCRIPT_A = `(async () => {
  ${PRELUDE}
  const drawUrl = await depUrl(root, '/src/render/draw.ts');
  const handlerUrl = await depUrl(root, '/src/midi/handler.ts');
  const engineUrl = await depUrl(handlerUrl, '/src/midi/engine.ts');
  const staffUrl = await depUrl(root, '/src/render/staff-inset.ts');
  const [viewMod, drawMod, handler, eng, selMod, midiMod, spell] = await Promise.all([
    import(await depUrl(root, '/src/state/view.ts')),
    import(drawUrl), import(handlerUrl), import(engineUrl),
    import(await depUrl(root, '/src/state/selection.ts')),
    import(await depUrl(engineUrl, '/src/state/midi.ts')),
    import(await depUrl(staffUrl, '/src/tuning/spell.ts')),
  ]);
  const { view } = viewMod, { selection } = selMod, { midi } = midiMod;
  const sel = (id, v) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('change')); };

  /* Live fake Lumatone (answers heartbeat pings and ACKs everything). */
  const fakeIn = { id: 'fake-lumatone-in', name: 'Lumatone', state: 'connected', onmidimessage: null };
  const fakeOut = {
    id: 'fake-lumatone-out', name: 'Lumatone', state: 'connected',
    send(m) {
      if (m[0] !== 0xF0) return;
      const answer = (data) => setTimeout(() => { if (fakeIn.onmidimessage) fakeIn.onmidimessage({ data }); }, 1);
      if (m[4] === 0x00 && m[5] === 0x33) { answer(new Uint8Array([0xF0, 0x00, 0x21, 0x50, 0x00, 0x33, 0x01, m[6], m[7], m[8], m[9], 0xF7])); return; }
      answer(new Uint8Array([0xF0, 0x00, 0x21, 0x50, m[4], m[5], 0x01, 0xF7]));
    },
  };
  midi.midiIn = fakeIn; midi.midiOut = fakeOut;
  fakeIn.onmidimessage = handler.handleMidiMessage;
  const deliver = (...bytes) => fakeIn.onmidimessage({ data: new Uint8Array(bytes) });
  const on = ([ch, n]) => deliver(0x90 | (ch - 1), n, 100);
  const off = ([ch, n]) => deliver(0x80 | (ch - 1), n, 0);

  /* The Nokia tune, from the spec: spelling and octave offset from the first note. */
  const MOTIF = 'E0 D0 F#-1 G#-1 C#0 B-1 D-1 E-1 B-1 A-1 C#-1 E-1 A-1'.split(' ').map((t) => {
    const m = /^([A-G][#b]*)(-?\\d+)$/.exec(t);
    return { name: m[1], octave: +m[2] };
  });
  const spelled = (cell) => {
    const [q, r] = cell.split(',').map(Number);
    const s = spell.resolveNoteSpec(q, r);
    return { name: s.pname.toUpperCase() + s.accid.replace(/s/g, '#').replace(/f/g, 'b'), oct: s.oct };
  };
  /* A physical key [channel, note] for each motif note, in the first base
     octave the Lumatone holds all of them in. */
  const locate = (motif) => {
    for (const b of [5, 4, 3, 6, 2]) {
      const found = motif.map((n) => {
        for (let ch = 1; ch <= 5; ch++) for (let k = 0; k < 56; k++) {
          const c = eng.fixedMidiToKey(ch, k);
          if (!c) continue;
          const s = spelled(c);
          if (s.name === n.name && s.oct === b + n.octave) return [ch, k];
        }
        return null;
      });
      if (found.every(Boolean)) return { keys: found, base: b };
    }
    return { keys: null, base: null };
  };
  const { keys, base } = locate(MOTIF);
  /* The Pong motif, from the spec: a B, five an octave below, one two below. */
  const pongKeys = locate('B0 B-1 B-1 B-1 B-1 B-1 B-2'.split(' ').map((t) => ({ name: t[0], octave: +t.slice(1) }))).keys;
  check('setup: the Lumatone holds every note of both motifs', [keys !== null, pongKeys !== null], [true, true]);
  if (!keys || !pongKeys) return { pass: false, results };
  const cellOf = ([ch, n]) => eng.fixedMidiToKey(ch, n);
  const tap = (k) => { on(k); off(k); };
  const clickCell = (cell) => {
    const cv = document.querySelector('canvas');
    let sxm = 0, sym = 0, n = 0;
    for (let y = 0; y < view.CH; y += 3) for (let x = 0; x < view.CW; x += 3)
      if (drawMod.hexAtPoint(x, y) === cell) { sxm += x; sym += y; n++; }
    if (!n) return false;
    const rect = cv.getBoundingClientRect();
    const o = { bubbles: true, clientX: rect.left + sxm / n, clientY: rect.top + sym / n, button: 0 };
    cv.dispatchEvent(new MouseEvent('mousedown', o));
    window.dispatchEvent(new MouseEvent('mouseup', o));
    return true;
  };

  /* ── S1 ── */
  check('S1a: the Secrets button and toolbar exist', [!!document.getElementById('tbSecrets'), !!document.getElementById('tb-group-secrets')], [true, true]);
  check('S1b: both hidden on a fresh profile', ui(), HIDDEN);
  check('S1c: nothing discovered', stored(), { games: [], toolbar: false });
  check('S1d: the outline is the Lumatone', document.getElementById('selOutline').value, 'lumatone');

  /* ── S2 ── */
  on(keys[0]);
  const heldFirst = selection.selectedKeys.has(cellOf(keys[0]));
  off(keys[0]);
  check('S2a: a motif note is an ordinary note', [heldFirst, selection.selectedKeys.size], [true, 0]);
  for (let i = 1; i < 12; i++) tap(keys[i]);
  check('S2b: twelve notes reveal nothing', [ui(), stored()], [HIDDEN, { games: [], toolbar: false }]);

  /* ── S3 ── */
  tap(keys[12]);
  check('S3a: the thirteenth reveals the button and toolbar', ui(), FOUND);
  check('S3b: the prefs hold the game', stored(), { games: ['snake'], toolbar: true });
  check('S3c: the selection is empty again', selection.selectedKeys.size, 0);

  /* ── S4 ── */
  document.getElementById('tbSecrets').click();
  check('S4a: the button toggles its toolbar off', [ui().button, ui().active, ui().toolbar, stored()], [true, false, false, { games: ['snake'], toolbar: false }]);
  document.getElementById('tbSecrets').click();
  check('S4b: and on again', [ui(), stored()], [FOUND, { games: ['snake'], toolbar: true }]);

  /* ── S5 / S6 ── */
  const realConfirm = window.confirm;
  let asked = 0;
  window.confirm = () => { asked++; return false; };
  document.getElementById('btnHideSecrets').click();
  check('S5: Hide declined changes nothing', [asked, ui(), stored()], [1, FOUND, { games: ['snake'], toolbar: true }]);
  window.confirm = () => { asked++; return true; };
  document.getElementById('btnHideSecrets').click();
  check('S6: Hide confirmed removes everything', [asked, ui(), stored()], [2, HIDDEN, { games: [], toolbar: false }]);

  /* ── S7 ── */
  sel('selOutline', 'qwerty');
  keys.forEach(tap);
  check('S7: under the QWERTY outline the motif discovers nothing', [ui(), stored()], [HIDDEN, { games: [], toolbar: false }]);
  sel('selOutline', 'lumatone');

  /* ── S8 ── */
  for (let i = 0; i < 12; i++) tap(keys[i]);
  const clicked = clickCell(cellOf(keys[12]));
  check('S8a: the last note is on screen to click', clicked, true);
  check('S8b: a canvas click completes the motif', [ui(), stored()], [FOUND, { games: ['snake'], toolbar: true }]);
  if (clicked) clickCell(cellOf(keys[12]));   /* deselect */

  /* ── S9 ── */
  for (let i = 0; i < 6; i++) tap(pongKeys[i]);
  check('S9a: six notes of the Pong motif reveal nothing more', [ui(), stored()], [FOUND, { games: ['snake'], toolbar: true }]);
  tap(pongKeys[6]);
  check('S9b: the seventh adds Pong, and every secret is found', [ui(), stored()], [BOTH, { games: ['snake', 'pong'], toolbar: true }]);
  window.confirm = realConfirm;
  return { pass: results.every((r) => r.ok), results, base };
})()`;

const SCRIPT_B = `(async () => {
  ${PRELUDE}
  check('R1: after a reload the prefs bring the button and toolbar back', [ui(), stored()], [BOTH, { games: ['snake', 'pong'], toolbar: true }]);
  const realConfirm = window.confirm;
  window.confirm = () => true;
  document.getElementById('btnResetPrefs').click();
  await new Promise((r) => setTimeout(r, 300));
  window.confirm = realConfirm;
  check('R2: Reset hides them and clears the games', [ui(), stored()], [HIDDEN, { games: [], toolbar: false }]);
  return { pass: results.every((r) => r.ok), results };
})()`;

const chrome = await launchChromium();
const cdp = new CDP(await newTabWsUrl(chrome.port));
await cdp.ready;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

/* Any console error fails the gate, except the one a headless browser always
   logs: it has no Web MIDI permission, and the gate supplies its own device. */
const EXPECTED_ERROR = /^MIDI access denied/;
const errors = [];
cdp.on('Runtime.exceptionThrown', (p) => errors.push(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? 'exception'));
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type !== 'error') return;
  const text = p.args.map((a) => a.value ?? a.description).join(' ');
  if (!EXPECTED_ERROR.test(text)) errors.push(text);
});

async function load(navigate) {
  const loaded = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
  await navigate();
  await loaded;
  await sleep(2500);
}

let exit = 0, total = 0, passed = 0;
function report(label, out) {
  if (!out || !out.results) {
    console.log(label + ' FAILED TO RUN:', JSON.stringify(out));
    exit = 1;
    return;
  }
  for (const r of out.results) {
    total++;
    if (r.ok) passed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}` + (r.ok ? '' : `\n        got  ${JSON.stringify(r.got)}\n        want ${JSON.stringify(r.want)}`));
  }
  if (!out.pass) exit = 1;
}

try {
  await load(() => cdp.send('Page.navigate', { url: URL }));
  report('first load', await cdp.evalJSON(SCRIPT_A));
  await load(() => cdp.send('Page.reload'));
  report('after reload', await cdp.evalJSON(SCRIPT_B));
} catch (e) {
  console.log('GATE ERROR:', e?.message ?? e);
  exit = 1;
}
console.log(`\n${passed}/${total} checks passed`);
if (errors.length) { console.log('\nCONSOLE ERRORS:\n  ' + errors.join('\n  ')); exit = 1; }
await chrome.stop();
process.exit(exit);
