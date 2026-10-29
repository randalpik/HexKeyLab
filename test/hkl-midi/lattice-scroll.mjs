// HKL lattice scroll-box gate: a canvas taller than the space the toolbars and
// the analysis row's 180 px minimum leave scrolls inside #cvScroll
// (index.html, render/controls-core.ts applyCanvasHeight) instead of pushing
// the analysis row off the page.
//
// Same harness as held-inputs.mjs (live modules through the app's own import
// edges; depUrl throws on a missing edge). Toolbar state is driven through the
// selects' change events; clicks are real mousedown events at client
// coordinates, as the canvas handler reads them.
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/lattice-scroll.mjs     # exits non-zero on any failure
//
// Covers:
//   S1  a lattice that fits: no scrolling, the box is the canvas's height
//   S2  a lattice that doesn't (Lumatone outline, Vertical Freq, Right): the box
//       scrolls, the analysis row keeps ≥ 180 px and stays on the page; the
//       same in Composer view
//   S3  a height change centers the scroll; a redraw that keeps the height
//       keeps the user's scroll
//   S4  clicks after scrolling select the key under the pointer (top and
//       bottom of the lattice)
//   S5  the canvas fits the box's width (no clipping); touch never scrolls
//   O   the OBS overlay page keeps the pre-scroll layout (no scroll box, no
//       reserved analysis row, canvas width innerWidth − 24)

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
  const initUrl = '/src/ui/init.ts';
  const controlsUrl = await depUrl(initUrl, '/src/ui/controls.ts');
  const physUrl = await depUrl(controlsUrl, '/src/layout/physical.ts');
  const coreUrl = await depUrl(controlsUrl, '/src/render/controls-core.ts');
  const [phys, geo, viewMod, selMod] = await Promise.all([
    import(physUrl),
    depUrl(coreUrl, '/src/layout/geometry.ts').then((u) => import(u)),
    depUrl(physUrl, '/src/state/view.ts').then((u) => import(u)),
    depUrl(initUrl, '/src/state/selection.ts').then((u) => import(u)),
  ]);
  const { view } = viewMod, { selection } = selMod;

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });
  const settle = async () => { await new Promise((r) => setTimeout(r, 700)); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); };
  const sel = async (id, v) => { const e = document.getElementById(id); if (e.value !== v) { e.value = v; e.dispatchEvent(new Event('change')); } await settle(); };
  const box = document.getElementById('cvScroll');
  const cv = document.getElementById('cv');
  const row = document.querySelector('.info-row');

  /* S1 */
  await sel('selOutline', 'lumatone'); await sel('selRotation', 'lumatone'); await sel('selAlignment', 'vertical');
  check('S1a: a lattice that fits does not scroll', box.scrollHeight === box.clientHeight, true);
  check('S1b: the box is the canvas height', box.clientHeight, cv.offsetHeight);

  /* S2 */
  await sel('selRotation', 'verticalFreq'); await sel('selAlignment', 'right');
  check('S2a: a taller lattice scrolls', box.scrollHeight > box.clientHeight, true);
  check('S2b: the analysis row keeps its 180 px', row.offsetHeight >= 180, true);
  check('S2c: the analysis row stays on the page', Math.round(row.getBoundingClientRect().bottom) <= window.innerHeight, true);

  /* S3 */
  const mid = (box.scrollHeight - box.clientHeight) / 2;
  check('S3a: a height change centers the scroll', Math.abs(box.scrollTop - mid) <= 1, true);
  box.scrollTop = 0; await settle();
  document.getElementById('cbNotes').click(); await settle();
  document.getElementById('cbNotes').click(); await settle();
  check('S3b: a redraw at the same height keeps the scroll', box.scrollTop, 0);

  /* S4: the topmost and bottommost Lumatone keys, clicked after scrolling to them. */
  const pos = ([q, r]) => {
    const p = geo.hexToScreen(q + view.kbAnchorQ - view.viewQ, r + view.kbAnchorR - view.viewR);
    return [view.CW / 2 + p.sx, view.CH / 2 + view.kbOffY + p.sy];
  };
  const keys = phys.lumatoneCells.map((c) => ({ id: (c[0] + view.kbAnchorQ) + ',' + (c[1] + view.kbAnchorR), xy: pos(c) }));
  keys.sort((a, b) => a.xy[1] - b.xy[1]);
  const click = (xy) => {
    const rect = cv.getBoundingClientRect();
    const o = { clientX: rect.left + xy[0], clientY: rect.top + xy[1], button: 0, bubbles: true };
    cv.dispatchEvent(new MouseEvent('mousedown', o));
    cv.dispatchEvent(new MouseEvent('mouseup', o));
  };
  selection.selectedKeys.clear();
  box.scrollTop = 0; await settle();
  click(keys[0].xy); await settle();
  check('S4a: scrolled to the top, a click selects the topmost key', selection.selectedKeys.has(keys[0].id), true);
  box.scrollTop = box.scrollHeight; await settle();
  const last = keys[keys.length - 1];
  click(last.xy); await settle();
  check('S4b: scrolled to the bottom, a click selects the bottommost key', selection.selectedKeys.has(last.id), true);
  check('S4c: and nothing else', selection.selectedKeys.size, 2);
  selection.selectedKeys.clear();

  /* S5 */
  check('S5a: the canvas fits the box width', cv.offsetWidth <= box.clientWidth, true);
  check('S5b: touch never scrolls the lattice', getComputedStyle(box).touchAction, 'none');

  /* S2d: Composer view shares the row */
  const cbCV = document.getElementById('cbComposerView');
  if (!cbCV.checked) { cbCV.click(); await settle(); }
  check('S2d: in Composer view the row keeps its 180 px', row.offsetHeight >= 180, true);
  cbCV.click(); await settle();

  await sel('selAlignment', 'vertical'); await sel('selRotation', 'lumatone');
  check('S1c: back to a lattice that fits, no scrolling', box.scrollHeight === box.clientHeight, true);

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

/* O: the OBS overlay page (?overlay, on its own private relay) keeps the
   pre-scroll layout — the whole canvas at the OBS source size. */
const overlayLoaded = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
await cdp.send('Page.navigate', { url: await isolatedHklUrl((process.env.HKL_URL ?? 'http://localhost:5170/') + '?overlay') });
await overlayLoaded;
await sleep(2500);
const ov = await cdp.evalJSON(`(async () => {
  const box = getComputedStyle(document.getElementById('cvScroll'));
  const cv = document.getElementById('cv');
  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });
  check('O1: overlay page', document.documentElement.classList.contains('overlay'), true);
  check('O2: the overlay box neither scrolls nor clips', box.overflowY, 'visible');
  check('O3: the overlay box does not shrink', box.flexShrink, '0');
  check('O4: no analysis-row minimum in the overlay', getComputedStyle(document.querySelector('.info-row')).minHeight, '0px');
  check('O5: overlay canvas width is innerWidth − 24, as before', cv.offsetWidth, Math.max(400, window.innerWidth - 24));
  return { results };
})()`);
if (out?.results) {
  out.results.push(...(ov?.results ?? [{ name: 'O: overlay checks ran', got: JSON.stringify(ov), want: 'results', ok: false }]));
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
