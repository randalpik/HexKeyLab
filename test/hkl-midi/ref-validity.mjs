// HKL ref-validity and piano-canvas gate (docs/architecture.md → Ref validation,
// Piano canvas height): a ref is valid iff its MIDI is in A0–C8, and the piano
// outline's canvas height fits every ref without changing when the ref does.
//
// Same harness as anchor.mjs (live modules resolved through their importers).
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/ref-validity.mjs        # exits non-zero on any failure
//
// Covers:
//   R1  a far enharmonic ref, whose footprint spells beyond ±3 accidentals (the
//       former rule's rejection), is accepted
//   R2  every tuning switch keeps it
//   R3  the banding switch keeps it
//   R4  the piano range: MIDI 21 and 108 accepted, 17, 109 and 112 rejected
//   R5  Piano outline, Pythagorean and Polysyntonic, Vertical Freq and Piano
//       rotations: refs across the range never change the canvas height, and
//       each footprint fits it (|sy − sy(MIDI 64's cell)| ≤ CH/2 − padY)

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
  const pkgUrl = async (fromPath, frag) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(frag);
    let a = i, b = i;
    while (a > 0 && src[a - 1] !== '"' && src[a - 1] !== "'") a--;
    while (b < src.length && src[b] !== '"' && src[b] !== "'") b++;
    return src.slice(a, b);
  };
  const controlsUrl = await depUrl('/src/ui/init.ts', '/src/ui/controls.ts');
  const drawUrl = await depUrl(controlsUrl, '/src/render/draw.ts');
  const [controls, drawMod, viewMod, tuningMod, refState, geo, notes] = await Promise.all([
    import(controlsUrl), import(drawUrl),
    depUrl(controlsUrl, '/src/state/view.ts').then((u) => import(u)),
    depUrl(controlsUrl, '/src/state/tuning.ts').then((u) => import(u)),
    depUrl(controlsUrl, '/src/state/reference.ts').then((u) => import(u)),
    depUrl(drawUrl, '/src/layout/geometry.ts').then((u) => import(u)),
    pkgUrl(drawUrl, '/packages/shared/src/notes.ts').then((u) => import(u)),
  ]);
  const { view } = viewMod, { tuning } = tuningMod;

  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const $ = (id) => document.getElementById(id);
  const sel = (id, v) => { const e = $(id); if (e.value !== v) { e.value = v; e.dispatchEvent(new Event('change')); } };
  const setBanded = (b) => { $('cbBanded').checked = b; controls.setBanded(); };
  const switchTuning = (t) => { $('selTuning').value = t; controls.setTuning(); };
  const setRef = (q, r) => refState.setSelectionFromManual(q, r);
  const refStr = () => refState.referenceNote.q + ',' + refState.referenceNote.r;
  const valid = (q, r) => drawMod.validateRefNoteCandidate(q, r) === null;
  const saved = {
    mode: tuning.mode, banded: tuning.banded, mapping: tuning.mapping,
    outline: $('selOutline').value, rotation: $('selRotation').value,
  };

  /* ── setup: Euler, Pythagorean, banded ── */
  if (tuning.mapping !== 'euler') { $('selMapping').value = 'euler'; controls.setMapping(); }
  if (!tuning.banded) setBanded(true);
  switchTuning('P');

  /* R1: C♯𝄪4 (C triple sharp), MIDI 63: the nearest ref to A3 along the
     sharp side whose footprint spells beyond ±3 (a C♯𝄪 major footprint
     reaches quadruple sharps) */
  const FAR = [-23, 14];
  check('R1a: far ref valid', valid(...FAR), true);
  setRef(...FAR);
  await tick();
  check('R1b: far ref set', refStr(), FAR.join(','));
  const maxAcc = Math.max(...drawMod.compute88PianoCoords(...FAR).map(([q, r]) =>
    Math.abs(notes.accToVal(notes.parseNote(notes.noteName(q, r, tuning.mapping, tuning.anchor, tuning.banded)).acc))));
  check('R1c: its footprint spells beyond ±3 (the former rule rejected it)', maxAcc > 3, true);

  /* R2: every tuning keeps it */
  for (const m of ['S', 'Y', '5', '7', 'V', 'D', 'E', 'P']) {
    switchTuning(m);
    await tick();
    check('R2: ' + m + ' keeps the ref', refStr(), FAR.join(','));
  }

  /* R3: banding keeps it */
  setBanded(false);
  await tick();
  check('R3a: unbanded keeps the ref', refStr(), FAR.join(','));
  setBanded(true);
  await tick();
  check('R3b: banded again keeps the ref', refStr(), FAR.join(','));

  /* R4: the piano range */
  check('R4a: MIDI 21 (−9,0) valid', valid(-9, 0), true);
  check('R4b: MIDI 108 (11,1) valid', valid(11, 1), true);
  check('R4c: MIDI 17 (−10,0) rejected', valid(-10, 0), false);
  check('R4d: MIDI 109 (13,0) rejected', valid(13, 0), false);
  check('R4e: MIDI 112 (12,1) rejected', valid(12, 1), false);

  /* R5: the piano canvas fits every ref without resizing */
  sel('selOutline', 'piano');
  /* MIDI 57, 63, 66, 21, 21, 108, 44: both ends of the range, and the far
     sharp (C♯𝄪) and far flat (A♭♭♭) refs whose footprints pass ±3 */
  const REFS = [[0, 0], FAR, [32, -17], [12, -12], [-9, 0], [11, 1], [2, -3]];
  for (const mode of ['P', 'Y']) {
    switchTuning(mode);
    for (const rot of ['verticalFreq', 'piano']) {
      sel('selRotation', rot);
      await tick();
      const CH = view.CH;
      const room = CH / 2 - (geo.hexR + geo.dxH * 0.5);
      let steady = true, fits = true;
      for (const [q, r] of REFS) {
        setRef(q, r);
        await tick();
        if (view.CH !== CH) steady = false;
        const fp = drawMod.compute88PianoCoords(q, r);
        const y64 = geo.hexToScreen(fp[64 - 21][0], fp[64 - 21][1]).sy;
        for (const [cq, cr] of fp) if (Math.abs(geo.hexToScreen(cq, cr).sy - y64) > room + 1e-6) fits = false;
      }
      check('R5: ' + mode + ' ' + rot + ' height steady across refs', steady, true);
      check('R5: ' + mode + ' ' + rot + ' every footprint fits', fits, true);
    }
  }

  /* restore */
  refState.clearSelection();
  sel('selRotation', saved.rotation);
  sel('selOutline', saved.outline);
  if (tuning.banded !== saved.banded) setBanded(saved.banded);
  if (tuning.mode !== saved.mode) switchTuning(saved.mode);
  if (tuning.mapping !== saved.mapping) { $('selMapping').value = saved.mapping; controls.setMapping(); }

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
await chrome.stop();
process.exit(exit);
