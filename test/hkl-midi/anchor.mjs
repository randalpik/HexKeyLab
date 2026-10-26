// HKL Syntonic / Polysyntonic anchor gate (docs/syntonic-spec.md §3, §4, §6).
//
// Same harness as mapping-switch.mjs (live modules resolved through their
// importers). Drives the reference tiers and checks the anchor (home band) the
// live app derives from them, what a re-anchor does, and piano input.
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/anchor.mjs        # exits non-zero on any failure
//
// Covers (Syntonic, Wicki-Hayden unless noted):
//   N1  default ref A3 → anchor 0; a band-1 cell sounds one comma up
//   N2  Ctrl+click in band 1 re-anchors: that cell becomes Pythagorean, its
//       colour changes, and the fan-out (onAnchorChanged) runs once
//   N3  a composer-source selection in another band never moves the anchor
//   N4  the score-ref drives the anchor when there is no manual selection;
//       a manual selection overrides it
//   N5  setAnchorOverride pins it (playback / overlay) and null releases it
//   N6  piano input: Syntonic's 88-cell footprint lies wholly in k = 0 bands;
//       Polysyntonic's is mostly home, the rest one band away
//   N7  a note-on recorded after a mid-take re-anchor carries `a`
//   N8  outside S/Y the anchor still tracks the ref but no pitch depends on it

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';

const URL = process.env.HKL_URL ?? 'http://localhost:5170/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) return depPath;
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  /* a workspace package import, served as /@fs/<abs path>?t=… — expand the
     match to the whole quoted specifier */
  const pkgUrl = async (fromPath, frag) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(frag);
    let a = i, b = i;
    while (a > 0 && src[a - 1] !== '"' && src[a - 1] !== "'") a--;
    while (b < src.length && src[b] !== '"' && src[b] !== "'") b++;
    return src.slice(a, b);
  };
  const controlsUrl = await depUrl('/src/ui/init.ts', '/src/ui/controls.ts');
  const anchorFxUrl = await depUrl('/src/ui/init.ts', '/src/effects/onAnchorChanged.ts');
  const refUrl = await depUrl(controlsUrl, '/src/effects/onRefChanged.ts');
  const drawUrl = await depUrl(controlsUrl, '/src/render/draw.ts');
  const engineUrl = await depUrl(controlsUrl, '/src/audio/engine.ts');
  const [controls, anchorFx, refMod, drawMod, captureMod, viewMod, tuningMod, refState, spineMod, freqMod, colorsMod, sharedFreq, sharedMap] =
    await Promise.all([
      import(controlsUrl), import(anchorFxUrl), import(refUrl), import(drawUrl),
      depUrl(engineUrl, '/src/recording/capture.ts').then((u) => import(u)),
      depUrl(controlsUrl, '/src/state/view.ts').then((u) => import(u)),
      depUrl(controlsUrl, '/src/state/tuning.ts').then((u) => import(u)),
      depUrl(controlsUrl, '/src/state/reference.ts').then((u) => import(u)),
      depUrl(controlsUrl, '/src/tuning/refspine.ts').then((u) => import(u)),
      depUrl(engineUrl, '/src/tuning/frequency.ts').then((u) => import(u)),
      depUrl(drawUrl, '/src/render/colors.ts').then((u) => import(u)),
      pkgUrl(drawUrl, '/packages/shared/src/freq.ts').then((u) => import(u)),
      pkgUrl(drawUrl, '/packages/shared/src/mapping.ts').then((u) => import(u)),
    ]);
  const { view } = viewMod, { tuning } = tuningMod, { keyFreq } = freqMod, { keyColorHex } = colorsMod;

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });
  const cents = (a, b) => Math.round(1200 * Math.log2(a / b) * 1000) / 1000;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let fanouts = 0;
  refState.setAnchorListener(() => { fanouts++; anchorFx.onAnchorChanged(); });

  const selTuning = document.getElementById('selTuning');
  const selMapping = document.getElementById('selMapping');
  const setMode = (m) => { if (selTuning.value !== m) { selTuning.value = m; controls.setTuning(); } };
  const setMapping = (m) => { if (selMapping.value !== m) { selMapping.value = m; controls.setMapping(); } };
  const setRef = (q, r) => {
    const oldAQ = view.kbAnchorQ, oldAR = view.kbAnchorR;
    refState.setSelectionFromManual(q, r);
    const sp = spineMod.refSpine(refState.referenceNote.q, refState.referenceNote.r, tuning.mapping);
    view.kbAnchorQ = sp.q; view.kbAnchorR = sp.r;
    refMod.onRefChanged(sp.q - oldAQ, sp.r - oldAR);
  };
  const savedMode = tuning.mode, savedMapping = tuning.mapping;

  /* ── setup: Syntonic, Wicki-Hayden, ref A3 ── */
  setMapping('wickiHayden');
  setMode('S');
  refState.clearSelection(); refState.clearScoreRef();
  await tick(); fanouts = 0;
  check('N1a: anchor 0 at A3', tuning.anchor, 0);
  /* (6,0) = A4 in band 1: one comma up in Syntonic */
  check('N1b: band-1 A4 sounds 440·81/80', cents(keyFreq(6, 0), 440 * 81 / 80), 0);
  const colourBefore = keyColorHex(6, 0);

  /* N2: Ctrl+click A4 (band 1) */
  setRef(6, 0);
  check('N2a: anchor follows the manual ref', tuning.anchor, 1);
  check('N2b: A4 is now Pythagorean 440', cents(keyFreq(6, 0), 440), 0);
  check('N2c: A3 (now band −1) is one comma down', cents(keyFreq(0, 0), 220 * 80 / 81), 0);
  check('N2d: A4 recoloured', keyColorHex(6, 0) !== colourBefore, true);
  await tick();
  check('N2e: one fan-out, after the caller finished', fanouts, 1);

  /* N3: composer-source selection (piano outline) in band 2 */
  refState.setSelectionFromComposer(12, 0);
  check('N3: composer-source selection leaves the anchor (falls back to score-ref/A3)', tuning.anchor, 0);
  refState.clearSelection();

  /* N4: score-ref in band 2, no manual selection → anchor 2; manual overrides */
  refState.setScoreRef(12, -3);
  check('N4a: score-ref drives the anchor', tuning.anchor, 2);
  refState.setSelectionFromManual(6, 0);
  check('N4b: manual selection overrides it', tuning.anchor, 1);
  refState.clearSelection();
  check('N4c: cleared → back to the score-ref', tuning.anchor, 2);

  /* N5: override */
  refState.setAnchorOverride(5);
  check('N5a: override pins', tuning.anchor, 5);
  refState.setScoreRef(0, 0);
  check('N5b: tiers ignored while pinned', tuning.anchor, 5);
  refState.setAnchorOverride(null);
  check('N5c: released → tiers again', tuning.anchor, 0);
  refState.clearScoreRef();
  await tick();

  /* N6: piano footprint */
  const kOf = (q) => Math.abs(sharedFreq.bandOffset(tuning.mode, sharedMap.bandOfCell(q, tuning.mapping) - tuning.anchor));
  const offHome = (cells) => cells.filter(([q]) => kOf(q) !== 0).length;
  check('N6a: Syntonic footprint wholly in k = 0 bands', offHome(drawMod.compute88PianoCoords(0, 0)), 0);
  setMode('Y');
  const yCells = drawMod.compute88PianoCoords(0, 0);
  check('N6b: Polysyntonic: off-home cells are one band away', yCells.every(([q]) => kOf(q) <= 1), true);
  check('N6c: Polysyntonic: off-home cells are the minority (' + offHome(yCells) + '/88)', offHome(yCells) < 20, true);
  setMode('S');

  /* N7: recording */
  captureMod.startRecording();
  captureMod.recordOn('6,0', 80);
  setRef(6, 0);
  captureMod.recordOn('6,0', 80);
  const session = captureMod.stopRecording();
  const ons = session.events.filter((e) => e.k === 'on');
  check('N7a: snapshot anchor 0', session.snapshot.anchor, 0);
  check('N7b: first note-on carries no a', 'a' in ons[0], false);
  check('N7c: post-re-anchor note-on carries a = 1', ons[1].a, 1);
  refState.clearSelection();
  await tick();

  /* N8: outside S/Y the anchor is tracked but read by nothing */
  setMode('P');
  await tick();
  const pBefore = [keyFreq(6, 0), keyFreq(0, 0), keyColorHex(6, 0)].join('|');
  refState.setSelectionFromManual(6, 0);
  check('N8a: Pythagorean still tracks the anchor', tuning.anchor, 1);
  check('N8b: no pitch or colour depends on it', [keyFreq(6, 0), keyFreq(0, 0), keyColorHex(6, 0)].join('|'), pBefore);
  refState.clearSelection();

  /* leave the page as found */
  await tick();
  refState.setAnchorListener(anchorFx.onAnchorChanged);
  setMode(savedMode);
  setMapping(savedMapping);
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
