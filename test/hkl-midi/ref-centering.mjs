// HKL ref-centering gate (state/reference.ts → effects/onRefChanged).
//
// The keyboard anchor (view.kbAnchorQ/R) is derived in ONE place from the home
// ref (manual Ctrl+click ?? score-ref ?? A3) and every tier change fans out
// through one listener. This walks every path that moves a ref tier — a real
// Ctrl+click on the canvas, and Composer's messages posted on the live bridge
// channel — and checks after each that the effective ref is the one the tiers
// call for and the view is centered on it: in a non-piano outline view =
// kbAnchor = refSpine(ref); in the piano outline view = the piano center for
// the ref, with kbAnchor where the step says.
//
// Requires `pnpm dev` running (umbrella proxy at :5170). The page is pinned to
// a private overlay relay (never the live :5190).
//
//   node test/hkl-midi/ref-centering.mjs        # exits non-zero on any failure
//
// Covers (Euler, Ptolemaic, Lumatone outline unless noted):
//   C1  Ctrl+click re-centers (slide)
//   C2  a Composer cursor note never displaces a Ctrl+click outside the piano
//       outline (it used to clobber it, leaving the view on the old anchor)
//   C3  Sync off: a score-ref arrival leaves the Ctrl+click in place
//   C4  composer-bye keeps the Ctrl+click
//   C5  Ctrl+click on the current ref clears it → A3
//   C6  score-ref drives the ref; C7 composer-bye re-centers on what remains
//       (it used to leave the view on the dropped score-ref)
//   C8  Sync on: a score-ref arrival clears a Ctrl+click
//   C9  a snap during a Ctrl+click slide redirects the slide (a stale slide
//       target never wins)
//   C10 enabling Sync drops a Ctrl+click that differs from the score-ref
//   C11 piano outline: the newer of Ctrl+click / cursor note is the ref; the
//       cursor never moves kbAnchor
//   C12 leaving the piano outline resurfaces the Ctrl+click under the cursor
//   C13 a mapping round-trip keeps the view centered
//   C14 applying a Syntonic layout drops the Ctrl+click and re-centers

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) throw new Error(depPath + ' not imported by ' + fromPath);
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  const root = '/src/ui/init.ts';
  const drawUrl = await depUrl(root, '/src/render/draw.ts');
  const refStateUrl = await depUrl(root, '/src/state/reference.ts');
  const [viewMod, tuningMod, refState, spineMod, drawMod, canvasMod] = await Promise.all([
    import(await depUrl(root, '/src/state/view.ts')),
    import(await depUrl(root, '/src/state/tuning.ts')),
    import(refStateUrl),
    import(await depUrl(refStateUrl, '/src/tuning/refspine.ts')),
    import(drawUrl),
    import(await depUrl(drawUrl, '/src/render/canvas.ts')),
  ]);
  const { view } = viewMod, { tuning } = tuningMod, ref = refState.referenceNote;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const SLIDE = 750; /* > the 500 ms tween */
  const ch = new BroadcastChannel('hkl-composer-bridge');
  const send = (m) => ch.postMessage(m);
  const post = async (m) => { send(m); await wait(150); };
  const sel = (id, v) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('change')); };
  const tick = (id, on) => { const c = document.getElementById(id); c.checked = on; c.dispatchEvent(new Event('change')); };
  const outline = () => document.getElementById('selOutline').value;
  const results = [];
  const fail = (name, why) => results.push({ name, ok: false, got: why, want: 'clickable cell' });

  /* a real Ctrl+click on the canvas at the cell's center */
  const clickCell = (q, r) => {
    const cv = document.querySelector('canvas');
    const want = q + ',' + r; let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < view.CH; y += 3) for (let x = 0; x < view.CW; x += 3)
      if (drawMod.hexAtPoint(x, y) === want) { sx += x; sy += y; n++; }
    if (!n) return false;
    const rect = cv.getBoundingClientRect();
    const o = { bubbles: true, ctrlKey: true, clientX: rect.left + sx / n, clientY: rect.top + sy / n, button: 0 };
    cv.dispatchEvent(new MouseEvent('mousedown', o));
    window.dispatchEvent(new MouseEvent('mouseup', o));
    return true;
  };
  const ctrlClick = async (name, q, r) => { if (!clickCell(q, r)) fail(name, 'cell ' + q + ',' + r + ' not on screen'); await wait(SLIDE); };

  const centered = () => {
    if (outline() === 'piano') {
      const [m64Q, m64R] = drawMod.currentMidi64Cell();
      const [vQ, vR] = canvasMod.computePianoViewCenter(ref.q, ref.r, m64Q, m64R);
      return Math.abs(view.viewQ - vQ) < 1e-9 && Math.abs(view.viewR - vR) < 1e-9;
    }
    const sp = spineMod.refSpine(ref.q, ref.r, tuning.mapping);
    return view.kbAnchorQ === sp.q && view.kbAnchorR === sp.r && view.viewQ === sp.q && view.viewR === sp.r;
  };
  /* wantKb: the expected kbAnchor (piano outline); elsewhere it must be the ref's spine */
  const expect = (name, wantRef, wantKb) => {
    const got = { ref: ref.q + ',' + ref.r, kbAnchor: view.kbAnchorQ + ',' + view.kbAnchorR,
      view: (+view.viewQ.toFixed(3)) + ',' + (+view.viewR.toFixed(3)), centered: centered() };
    const ok = got.ref === wantRef && got.centered && (wantKb === undefined || got.kbAnchor === wantKb);
    results.push({ name, ok, got, want: { ref: wantRef, kbAnchor: wantKb ?? 'spine(ref)', centered: true } });
  };
  const EU = 'euler';

  sel('selMapping', EU); sel('selTuning', '5'); sel('selOutline', 'lumatone');
  tick('cbSyncToComposer', false);
  await post({ type: 'composer-hello', version: 1 });

  await ctrlClick('C1', -3, 3);                                     expect('C1  Ctrl+click (-3,3) re-centers', '-3,3');
  await post({ type: 'set-reference-note', q: 1, r: -1, mapping: EU }); expect('C2  cursor note keeps the Ctrl+click (Lumatone outline)', '-3,3');
  await post({ type: 'set-score-ref', q: 6, r: -3, mapping: EU });  expect('C3  Sync off: score-ref keeps the Ctrl+click', '-3,3');
  await post({ type: 'composer-bye' });                             expect('C4  composer-bye keeps the Ctrl+click', '-3,3');
  await ctrlClick('C5', -3, 3);                                     expect('C5  Ctrl+click on the ref clears it', '0,0');
  await post({ type: 'composer-hello', version: 1 });
  await post({ type: 'set-score-ref', q: 6, r: -3, mapping: EU });  expect('C6  score-ref drives the ref', '6,-3');
  await post({ type: 'composer-bye' });                             expect('C7  composer-bye re-centers on what remains', '0,0');

  await post({ type: 'composer-hello', version: 1 });
  tick('cbSyncToComposer', true);
  await post({ type: 'set-score-ref', q: 6, r: -3, mapping: EU });
  await ctrlClick('C8', 2, -1);
  await post({ type: 'set-score-ref', q: 3, r: -1, mapping: EU });  expect('C8  Sync on: score-ref clears the Ctrl+click', '3,-1');

  if (!clickCell(-1, 1)) fail('C9', 'cell -1,1 not on screen');
  send({ type: 'set-score-ref', q: 6, r: -3, mapping: EU });         /* lands mid-slide */
  await wait(SLIDE);                                                expect('C9  a snap mid-slide redirects the slide', '6,-3');

  tick('cbSyncToComposer', false);
  await ctrlClick('C10', 2, -1);
  tick('cbSyncToComposer', true); await wait(150);                  expect('C10 enabling Sync drops a differing Ctrl+click', '6,-3');

  tick('cbSyncToComposer', false);
  sel('selOutline', 'piano'); await wait(150);
  await ctrlClick('C11', 0, 1);                                     expect('C11a piano: Ctrl+click is the ref', '0,1', '0,1');
  await post({ type: 'set-reference-note', q: -2, r: 2, mapping: EU }); expect('C11b piano: a newer cursor note is the ref, kbAnchor stays', '-2,2', '0,1');
  sel('selOutline', 'lumatone'); await wait(150);                   expect('C12 leaving piano resurfaces the Ctrl+click', '0,1');

  sel('selMapping', 'wickiHayden'); await wait(150);
  const whOk = centered();
  results.push({ name: 'C13a Wicki-Hayden: centered after the switch', ok: whOk, got: { ref: ref.q + ',' + ref.r, kbAnchor: view.kbAnchorQ + ',' + view.kbAnchorR, view: view.viewQ + ',' + view.viewR }, want: 'view = kbAnchor = spine(ref)' });
  sel('selMapping', EU); await wait(150);                           expect('C13b back to Euler: same ref, centered', '0,1');

  await post({ type: 'apply-layout', tuningMode: 'S', mapping: EU }); expect('C14 Syntonic layout drops the Ctrl+click', '6,-3');

  sel('selTuning', '5'); tick('cbSyncToComposer', false);
  refState.clearSelection();
  await post({ type: 'composer-bye' });
  return { pass: results.every((r) => r.ok), results };
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
await cdp.send('Page.bringToFront'); /* the slide runs on rAF */

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
