// HKL outline-click gate (render/draw.ts hexAtPoint).
//
// With Extend pattern off, the overlay hides every key outside the outline, and
// a click must never reach one. The outline's edge runs a little outside the
// rim keys (outR = hexR + 1), past the midpoint to the hidden neighbor, so a
// hit-test that takes the nearest key center among everything drawn hands the
// strip along the rim to a key the user cannot see.
//
// Scans the whole canvas and requires every point to resolve to nothing or to a
// key of the outline, under each outline and hex size. With Extend pattern on,
// the keys outside are shown and stay clickable.
//
// Requires `pnpm dev` running (umbrella proxy at :5170). The page is pinned to
// a private overlay relay (never the live :5190), and Chromium is muted.
//
//   node test/hkl-midi/outline-clicks.mjs        # exits non-zero on any failure
//
// Covers:
//   C1  Extend off: Lumatone, QWERTY and Piano outlines at each hex size, a
//       1 px scan — no point resolves to a key outside the outline
//   C2  the same at half-pixel steps for the Lumatone outline, medium size
//   C3  the strip is not lost: at the end of every key row, a point just inside
//       the outline's edge, beyond the midpoint to the hidden neighbor, resolves
//       to the rim key, and a point past the edge to nothing
//   C4  Extend on: keys outside the outline are still clickable

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
  const root = '/src/ui/init.ts';
  const drawUrl = await depUrl(root, '/src/render/draw.ts');
  const [viewMod, drawMod, geo, selMod] = await Promise.all([
    import(await depUrl(root, '/src/state/view.ts')),
    import(drawUrl),
    import(await depUrl(drawUrl, '/src/layout/geometry.ts')),
    import(await depUrl(root, '/src/state/selection.ts')),
  ]);
  const { view } = viewMod, { selection } = selMod;
  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: JSON.stringify(got) === JSON.stringify(want) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sel = (id, v) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('change')); };
  const tick = (id, on) => { const c = document.getElementById(id); c.checked = on; c.dispatchEvent(new Event('change')); };

  /* Every canvas point at this step: how many resolve to a key, and how many of
     those to a key the outline does not contain. */
  const scan = (step) => {
    const inside = drawMod.activeFootprintSet();
    let hits = 0, outside = 0;
    const examples = [];
    for (let y = 0; y < view.CH; y += step) for (let x = 0; x < view.CW; x += step) {
      const k = drawMod.hexAtPoint(x, y);
      if (k === null) continue;
      hits++;
      if (!inside.has(k)) { outside++; if (examples.length < 2) examples.push([x, y, k]); }
    }
    return { hits, outside, examples };
  };

  tick('cbExtend', false);
  for (const outline of ['lumatone', 'qwerty', 'piano']) {
    sel('selOutline', outline);
    for (const size of ['small', 'medium', 'large']) {
      sel('selHexSize', size);
      await wait(200);
      const s = scan(1);
      check('C1: ' + outline + ', ' + size + ': no point reaches a key outside the outline (' + s.hits + ' points on keys)',
            [s.hits > 500, s.outside, s.examples], [true, 0, []]);
    }
  }
  sel('selOutline', 'lumatone'); sel('selHexSize', 'medium');
  await wait(200);
  const fine = scan(0.5);
  check('C2: Lumatone, medium, half-pixel steps (' + fine.hits + ' points on keys)', [fine.outside, fine.examples], [0, []]);

  /* C3: walk outward from a rim key's center, across the row, toward a hidden
     neighbor. Past the midpoint (half a column) and still inside the outline's
     edge (hexR + 1 from the center), the point must be the rim key's. */
  const inside = drawMod.activeFootprintSet();
  /* Key centers as the hit-test has them (unrotated, relative to the canvas
     center), and the way back from there to a canvas point. */
  const centerOf = (cell) => {
    const k = selection.drawnKeys.find((d) => d.q + ',' + d.r === cell);
    return k ? [k.ux, k.uy] : null;
  };
  const toCanvas = ([ux, uy]) => [
    ux * geo.cosT + uy * geo.sinT + view.CW / 2,
    -ux * geo.sinT + uy * geo.cosT + view.CH / 2 + view.kbOffY,
  ];
  const hitAt = (p) => drawMod.hexAtPoint(...toCanvas(p));
  let tried = 0, wrongStrip = 0, wrongPast = 0, wrongCenter = 0;
  for (const cell of inside) {
    const [q, r] = cell.split(',').map(Number);
    if (!inside.has((q - 1) + ',' + r) || inside.has((q + 1) + ',' + r)) continue;
    const a = centerOf(cell), b = centerOf((q - 1) + ',' + r);
    if (!a || !b) continue;
    tried++;
    /* unit vector from the inner neighbor to the rim key: the way out of the outline */
    const len = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const ux = (a[0] - b[0]) / len, uy = (a[1] - b[1]) / len;
    const reach = geo.hexR + 1;                       /* the outline's edge */
    const d = (len / 2 + reach) / 2;                  /* between the midpoint and the edge */
    if (!(d > len / 2 + 0.5)) wrongStrip++;           /* the probe must be past the midpoint */
    if (hitAt(a) !== cell) wrongCenter++;
    if (hitAt([a[0] + ux * d, a[1] + uy * d]) !== cell) wrongStrip++;
    if (hitAt([a[0] + ux * (reach + 3), a[1] + uy * (reach + 3)]) !== null) wrongPast++;
  }
  check('C3: on every row end, the strip past the midpoint belongs to the rim key; beyond the edge is nothing',
        [tried > 10, wrongCenter, wrongStrip, wrongPast], [true, 0, 0, 0]);

  tick('cbExtend', true);
  await wait(200);
  const shown = scan(2);
  check('C4: Extend on: keys outside the outline stay clickable', shown.outside > 0, true);
  return { pass: results.every((r) => r.ok), results };
})()`;

const chrome = await launchChromium();
const cdp = new CDP(await newTabWsUrl(chrome.port));
await cdp.ready;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

const EXPECTED_ERROR = /^MIDI access denied/;
const errors = [];
cdp.on('Runtime.exceptionThrown', (p) => errors.push(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? 'exception'));
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type !== 'error') return;
  const text = p.args.map((a) => a.value ?? a.description).join(' ');
  if (!EXPECTED_ERROR.test(text)) errors.push(text);
});

let exit = 0, total = 0, passed = 0;
try {
  const loaded = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
  await cdp.send('Page.navigate', { url: URL });
  await loaded;
  await sleep(2500);
  const out = await cdp.evalJSON(SCRIPT);
  if (!out || !out.results) {
    console.log('FAILED TO RUN:', JSON.stringify(out));
    exit = 1;
  } else {
    for (const r of out.results) {
      total++;
      if (r.ok) passed++;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}` + (r.ok ? '' : `\n        got  ${JSON.stringify(r.got)}\n        want ${JSON.stringify(r.want)}`));
    }
    if (!out.pass) exit = 1;
  }
} catch (e) {
  console.log('GATE ERROR:', e?.message ?? e);
  exit = 1;
}
console.log(`\n${passed}/${total} checks passed`);
if (errors.length) { console.log('\nCONSOLE ERRORS:\n  ' + errors.join('\n  ')); exit = 1; }
await chrome.stop();
process.exit(exit);
