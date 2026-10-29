// HKL layout screenshots: one full-page PNG per toolbar combination, for
// before/after comparison of a change that must not move a pixel (or must move
// exactly the expected ones). Pair with compare-shots.py.
//
// Requires `pnpm dev` running (umbrella proxy at :5170). One headless Chromium,
// on a private overlay relay (isolatedHklUrl), closed with stop() at the end.
//
//   node test/hkl-inspect/layout-shots.mjs <outDir>
//   python3 test/hkl-inspect/compare-shots.py <dirA> <dirB> [<heatmapDir>]
//
// Matrix: every outline × rotation × Extend pattern at the default reference
// (A3), then the physical outlines (and None) under a shifted score-ref, which
// moves the keyboard anchor off (0, 0), then Vertical Freq under the other two
// mappings. Order matters: the score-ref and mapping steps change state that
// later shots inherit.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const outDir = process.argv[2];
if (!outDir) { console.error('usage: node test/hkl-inspect/layout-shots.mjs <outDir>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OUTLINES = ['lumatone', 'qwerty', 'piano', 'none'];
const ROTATIONS = ['verticalFreq', 'lumatone', 'piano'];
const shots = [];
for (const outline of OUTLINES)
  for (const rotation of ROTATIONS)
    for (const extend of outline === 'none' ? [true] : [true, false])   /* None forces Extend on */
      shots.push({ outline, rotation, extend });
for (const outline of ['lumatone', 'qwerty', 'none'])
  for (const extend of outline === 'none' ? [true] : [true, false])
    shots.push({ outline, rotation: 'lumatone', extend, scoreRef: [6, -3] });
shots.push({ outline: 'lumatone', rotation: 'verticalFreq', extend: true, scoreRef: [6, -3], mapping: 'wickiHayden' });
shots.push({ outline: 'lumatone', rotation: 'verticalFreq', extend: true, scoreRef: [6, -3], mapping: 'chromatic' });

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

/* Apply one shot's state through the toolbar (change events, as a user would)
   and the Composer bridge (score-ref), then let the view settle. */
const apply = (s) => `(async () => {
  const s = ${JSON.stringify(s)};
  const sel = (id, v) => { const e = document.getElementById(id); if (e.value !== v) { e.value = v; e.dispatchEvent(new Event('change')); } };
  const tick = (id, on) => { const c = document.getElementById(id); if (c.checked !== on) { c.checked = on; c.dispatchEvent(new Event('change')); } };
  if (s.mapping) sel('selMapping', s.mapping);
  sel('selOutline', s.outline);
  sel('selRotation', s.rotation);
  tick('cbExtend', s.extend);
  if (s.scoreRef) {
    const ch = new BroadcastChannel('hkl-composer-bridge');
    ch.postMessage({ type: 'set-score-ref', q: s.scoreRef[0], r: s.scoreRef[1], mapping: 'euler' });
    ch.close();
  }
  await new Promise((r) => setTimeout(r, 900));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
})()`;

const manifest = [];
for (let i = 0; i < shots.length; i++) {
  const s = shots[i];
  await cdp.evalJSON(apply(s));
  const name = String(i).padStart(2, '0') + '-' + s.outline + '-' + s.rotation + '-' + (s.extend ? 'ext' : 'noext')
    + (s.scoreRef ? '-ref' + s.scoreRef.join('_') : '-a3') + (s.mapping ? '-' + s.mapping : '') + '.png';
  const m = await cdp.send('Page.getLayoutMetrics');
  const { width, height } = m.cssContentSize;
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'));
  manifest.push({ name, ...s });
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`${manifest.length} shots → ${outDir}`);
if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '));
await chrome.stop();
process.exit(errors.length ? 1 : 0);
