// HKL offscreen-layer sync gate: the hex and text layers are blitted with one
// shared geometry (render/draw.ts gridRef / pad / size), so every frame must
// equal a from-scratch rebuild of both layers. Found 2026-10-29 by Max: change
// the ref (a sliding Ctrl+click builds both layers at the tween's midpoint),
// then toggle Note names — only the text layer rebuilt, at the final view, and
// the lattice desynced from the text and the outline.
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/layer-sync.mjs        # exits non-zero on any failure
//
// Covers:
//   L1  sliding ref change, then Note names off: frame = full rebuild
//   L2  Note names back on: frame = full rebuild
//   L3  the same after a slide back to A3

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
  const refUrl = await depUrl('/src/ui/init.ts', '/src/effects/onRefChanged.ts');
  const drawUrl = await depUrl('/src/ui/init.ts', '/src/render/draw.ts');
  const [refFx, drawMod, refState, viewMod, animMod] = await Promise.all([
    import(refUrl), import(drawUrl),
    depUrl('/src/ui/init.ts', '/src/state/reference.ts').then((u) => import(u)),
    depUrl(drawUrl, '/src/state/view.ts').then((u) => import(u)),
    depUrl(drawUrl, '/src/render/animation.ts').then((u) => import(u)),
  ]);
  const { view } = viewMod, { animation } = animMod;
  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });

  const settle = async () => {
    for (let i = 0; i < 100 && animation.isAnimating; i++) await new Promise((r) => setTimeout(r, 30));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  };
  const frame = () => document.getElementById('cv').toDataURL();
  const rebuilt = () => { view.hexDirty = true; view.textDirty = true; drawMod.draw(); return frame(); };
  const notes = (on) => { const c = document.getElementById('cbNotes'); c.checked = on; c.dispatchEvent(new Event('change')); };
  /* the Ctrl+click path: reference.ts re-anchors, onRefChanged slides the view */
  const click = (q, r) => refFx.withRefSlide(() => refState.setSelectionFromManual(q, r));

  click(3, 0);
  await settle();
  check('setup: the keyboard anchor moved', view.kbAnchorQ + ',' + view.kbAnchorR, '3,0');
  notes(false);
  const l1 = frame();
  check('L1: Note names off after a sliding ref change = full rebuild', l1 === rebuilt(), true);
  notes(true);
  const l2 = frame();
  check('L2: Note names on = full rebuild', l2 === rebuilt(), true);

  click(0, 0);
  await settle();
  notes(false);
  const l3 = frame();
  check('L3: after sliding back, Note names off = full rebuild', l3 === rebuilt(), true);
  notes(true);

  refState.clearSelection();
  await settle();
  return { pass: results.every(r => r.ok), results };
})()`;

const chrome = await launchChromium();
const cdp = new CDP(await newTabWsUrl(chrome.port));
await cdp.ready;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

const errors = [];
cdp.on('Runtime.exceptionThrown', (p) => errors.push(p?.exceptionDetails?.text ?? 'exception'));

const loaded = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
await cdp.send('Page.navigate', { url: URL });
await loaded;
await cdp.evalJSON('document.fonts.ready.then(() => true)');
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
if (errors.length) console.log('\nPAGE ERRORS:\n  ' + errors.join('\n  '));
await chrome.stop();
process.exit(exit);
