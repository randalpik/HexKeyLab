// Layout-builder tray gate (docs/architecture/hkl.md → Layout builder).
//
// Headless Chromium against the running dev server (`pnpm dev`, http://localhost:5170/). Drives
// the real tray through its own controls and compares what it shows with the REAL @hkl/shared
// model, imported here through the repo's TS loader:
//
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/layout-presets/tray.mjs
//
//   A  the Mapping dropdown: eight presets, then "Custom…"; choosing it opens the tray on the
//      current layout and changes nothing
//   B  the tray is non-modal, hangs from the top edge, centered, ends above the lattice, and a real mouse
//      press on the lattice below it selects a key
//   C  all 48 layouts, reached by division × invert × shear steps: the live mapping and the saved
//      pref are the model's id; the toolbar dropdown names the preset or reads Custom…; the
//      shear buttons disable exactly at the bound; the three axis intervals; no control keeps
//      the focus
//   D  shear clamping on a division or invert change
//   E  the toolbar dropdown, the tray's only preset picker, drives an open tray
//   F  render paths on custom layouts: every tuning × banded × outline × alignment, console clean
//   G  QWERTY keys play while the tray is open
//   H  Close and Escape; "Custom…" reopens while the layout is custom; a custom layout survives a
//      reload; Reset returns to Euler
//
// Exit code 0 iff every check passes and the console stayed clean.
//
// Silent by construction: the shared launcher mutes the browser's output (`--mute-audio`), and
// the gate clears every key it selects before it switches layouts.

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { attachConsoleCapture } from '../composer-test/lib/console-capture.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';
import { writeFileSync } from 'node:fs';
import {
  allMappings, mappingOf, shearRange, clampShear, isPresetMapping, MAPPINGS, MAPPING_LABELS, DIVISIONS,
} from '../../packages/shared/src/mapping.ts';
import { coordToMidi } from '../../packages/shared/src/freq.ts';

const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const shotIdx = process.argv.indexOf('--screenshot');
const screenshotPath = shotIdx >= 0 ? process.argv[shotIdx + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let checks = 0;
const failures = [];
function check(ok, what) {
  checks++;
  if (!ok) { failures.push(what); console.log('FAIL ' + what); }
}
const eq = (got, want, what) => check(got === want, what + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));

/* the gate's own table, deliberately not the tray's */
const NAMES = ['unison', 'semitone', 'major second', 'minor third', 'major third', 'perfect fourth', 'tritone',
  'perfect fifth', 'minor sixth', 'major sixth', 'minor seventh', 'major seventh', 'octave'];
const name = (n) => (n < 0 ? 'descending ' : '') + NAMES[Math.abs(n)];
const step = (m, dq, dr) => name(coordToMidi(dq, dr, m) - coordToMidi(0, 0, m));

/* In-page driver. The state modules must be the app's own instances: after a hot reload the dev
   server serves a module under a ?t=… URL, so each URL is read out of its importer's source (as
   the test/hkl-midi gates do) instead of being typed here. */
const DRIVER = `(async () => {
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) throw new Error(depPath + ' is not imported by ' + fromPath);
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  const controlsUrl = await depUrl('/src/ui/init.ts', '/src/ui/controls.ts');
  const { tuning } = await import(await depUrl('/src/ui/init.ts', '/src/state/tuning.ts'));
  const { selection } = await import(await depUrl(controlsUrl, '/src/state/selection.ts'));
  const el = (id) => document.getElementById(id);
  const pick = (id, v) => { el(id).value = v; el(id).dispatchEvent(new Event('change', { bubbles: true })); };
  const shear = () => Number(el('lbShear').textContent.replace('−', '-'));
  window.__lb = {
    pick,
    click: (id) => el(id).click(),
    /* reach (division, shear, invert) the way a user does */
    go(d, k, inv) {
      pick('lbDivision', String(d));
      if (el('lbInvert').checked !== inv) el('lbInvert').click();
      for (let i = 0; i < 40 && shear() !== k; i++) el(shear() < k ? 'lbShearUp' : 'lbShearDown').click();
    },
    state() {
      const d = el('layoutBuilder'), sel = el('selMapping'), r = d.getBoundingClientRect();
      return {
        mapping: tuning.mapping,
        pref: JSON.parse(localStorage.getItem('hkl.prefs.v1') || '{}').mapping,
        open: d.open, modal: d.matches(':modal'),
        rect: { top: r.top, bottom: r.bottom, mid: (r.left + r.right) / 2, vw: innerWidth, vh: innerHeight,
          lattice: el('cv').getBoundingClientRect().top },
        sel: sel.value, selText: sel.selectedOptions[0] ? sel.selectedOptions[0].text : null,
        selOptions: [...sel.options].filter((o) => !o.hidden).map((o) => o.text),
        pickers: d.querySelectorAll('select').length,
        division: el('lbDivision').value, shear: el('lbShear').textContent, invert: el('lbInvert').checked,
        down: el('lbShearDown').disabled, up: el('lbShearUp').disabled,
        rows: el('lbRows').textContent, columns: el('lbColumns').textContent, diagonal: el('lbDiagonal').textContent,
        unfocused: document.activeElement === document.body,
        selected: selection.selectedKeys.size,
      };
    },
  };
  return true;
})()`;

const chrome = await launchChromium();
let exit = 1;
try {
  const cdp = new CDP(await newTabWsUrl(chrome.port));
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  /* headless-only boot noise: no user gesture for audio, no Web MIDI permission */
  const consoleCap = attachConsoleCapture(cdp, { allow: [/favicon\.ico/i, /AudioContext was not allowed to start/, /MIDI access denied/] });
  const clean = (where) => {
    const recs = consoleCap.drain();
    check(recs.length === 0, where + (recs.length ? ': ' + recs.slice(0, 3).map((r) => r.text.slice(0, 200)).join(' | ') : ''));
  };

  const load = async () => {
    const loaded = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
    await cdp.send('Page.navigate', { url: URL });
    await loaded;
    await sleep(2000);
    check(await cdp.evalJSON(DRIVER) === true, 'driver installed');
  };
  const run = (expr) => cdp.evalJSON(`(() => { ${expr}; return window.__lb.state(); })()`);
  const state = () => run('');

  /* what the toolbar dropdown and the tray must show for layout id `m` */
  function checkShown(s, m, spec, where) {
    const preset = isPresetMapping(m);
    eq(s.mapping, m, where + ' live mapping');
    eq(s.pref, m, where + ' saved pref');
    eq(s.sel, preset ? m : 'custom-shown', where + ' toolbar value');
    eq(s.selText, preset ? MAPPING_LABELS[m] : 'Custom…', where + ' toolbar text');
    eq(s.division, String(spec.division), where + ' division');
    eq(s.shear, String(spec.shear).replace('-', '−'), where + ' shear');
    eq(s.invert, spec.invert, where + ' invert');
    const [lo, hi] = shearRange(spec.division, spec.invert);
    eq(s.down, spec.shear <= lo, where + ' shear-down disabled');
    eq(s.up, spec.shear >= hi, where + ' shear-up disabled');
    eq(s.rows, step(m, 1, 0), where + ' rows');
    eq(s.columns, step(m, 0, 1), where + ' columns');
    eq(s.diagonal, step(m, -1, 1), where + ' diagonal');
    check(s.unfocused, where + ' no control keeps the focus');
    check(s.open && !s.modal, where + ' tray open, non-modal');
  }

  await load();

  /* ── A ── */
  let s = await state();
  check(!s.open, 'A tray closed at start');
  eq(s.mapping, 'euler', 'A default layout');
  eq(JSON.stringify(s.selOptions), JSON.stringify([...MAPPINGS.map((m) => MAPPING_LABELS[m]), 'Custom…']), 'A dropdown entries');
  s = await run(`__lb.pick('selMapping', 'custom')`);
  await sleep(400); /* the slide-in */
  s = await state();
  check(s.open && !s.modal, 'A "Custom…" opens the tray, non-modal');
  eq(s.mapping, 'euler', 'A opening changes nothing');
  eq(s.sel, 'euler', 'A toolbar back on the current preset');
  eq(s.pickers, 1, 'A the tray has one select (Octave division), no mapping picker of its own');
  eq([s.rows, s.columns, s.diagonal].join(' / '), 'major third / perfect fifth / minor third', 'A Euler axes');

  /* ── B ── */
  eq(s.rect.top, 0, 'B tray at the top edge');
  check(Math.abs(s.rect.mid - s.rect.vw / 2) <= 1, 'B tray centered (mid ' + s.rect.mid + ' of ' + s.rect.vw + ')');
  check(s.rect.bottom > 0 && s.rect.bottom <= s.rect.lattice, 'B tray ends above the lattice (bottom ' + s.rect.bottom + ', lattice top ' + s.rect.lattice + ')');
  if (screenshotPath) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
  }
  const cx = Math.round(s.rect.vw / 2), cy = Math.round(s.rect.vh * 0.6);
  const mouse = (type) => cdp.send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', clickCount: 1 });
  await mouse('mousePressed');
  await sleep(80);
  check((await state()).selected > 0, 'B a press on the lattice under an open tray selects a key');
  await mouse('mouseReleased');
  await sleep(80);
  /* release it: nothing may stay selected (and sounding) through the layout walk below */
  eq((await run(`__lb.click('btnClear')`)).selected, 0, 'B selection cleared');

  /* ── C ── */
  const seen = new Set();
  for (const division of DIVISIONS) {
    for (const invert of [false, true]) {
      const [lo, hi] = shearRange(division, invert);
      for (let shear = lo; shear <= hi; shear++) {
        const m = mappingOf({ division, shear, invert });
        s = await run(`__lb.go(${division}, ${shear}, ${invert})`);
        checkShown(s, m, { division, shear, invert }, 'C ' + m);
        seen.add(s.mapping);
      }
    }
  }
  const all = allMappings();
  check(seen.size === all.length && all.every((m) => seen.has(m)), 'C the tray reached all ' + all.length + ' layouts (' + seen.size + ')');
  /* the axes as Max's backlog words them */
  const AXES = {
    gerhard: 'major third / minor third / descending semitone',
    janko: 'major second / semitone / descending semitone',
    accordion: 'major second / minor third / semitone',
    randal: 'major third / perfect fourth / semitone',
    park: 'major second / perfect fourth / minor third',
  };
  for (const [m, want] of Object.entries(AXES)) {
    s = await run(`__lb.pick('selMapping', '${m}')`);
    eq([s.rows, s.columns, s.diagonal].join(' / '), want, 'C ' + m + ' axes');
  }

  /* ── D ── */
  s = await run(`__lb.go(12, 5, false); __lb.pick('lbDivision', '3')`);
  checkShown(s, mappingOf({ division: 3, shear: clampShear(3, 5, false), invert: false }), { division: 3, shear: 1, invert: false }, 'D 12:5 → division 3');
  s = await run(`__lb.go(12, -7, true); __lb.pick('lbDivision', '4')`);
  checkShown(s, mappingOf({ division: 4, shear: -2, invert: true }), { division: 4, shear: -2, invert: true }, 'D 12:-7:i → division 4');
  s = await run(`__lb.pick('selMapping', 'janko'); __lb.click('lbInvert')`);
  checkShown(s, mappingOf({ division: 6, shear: 2, invert: true }), { division: 6, shear: 2, invert: true }, 'D Janko inverted');

  /* ── E ── */
  s = await run(`__lb.pick('selMapping', 'accordion')`);
  checkShown(s, 'accordion', { division: 6, shear: 1, invert: true }, 'E toolbar → Accordion');
  s = await run(`__lb.pick('selMapping', 'chromatic')`);
  checkShown(s, 'chromatic', { division: 12, shear: 0, invert: false }, 'E toolbar → Chromatic');
  s = await run(`__lb.click('lbInvert')`);
  checkShown(s, '12:0:i', { division: 12, shear: 0, invert: true }, 'E Chromatic inverted (Bass)');

  /* ── F ── */
  clean('console clean through A–E');
  for (const [d, k, inv] of [[4, 0, false], [4, 1, true], [12, 0, true], [12, -5, false], [3, -1, false], [6, -2, true]]) {
    await run(`__lb.go(${d}, ${k}, ${inv})`);
    for (const mode of ['E', '5', 'P', 'D', '7', 'V', 'S', 'Y']) {
      for (const banded of [true, false]) {
        await run(`__lb.pick('selTuning', '${mode}'); if (document.getElementById('cbBanded').checked !== ${banded}) __lb.click('cbBanded')`);
        await sleep(40);
      }
    }
    await run(`__lb.pick('selTuning', '5'); if (!document.getElementById('cbBanded').checked) __lb.click('cbBanded')`);
    for (const outline of ['qwerty', 'piano', 'none', 'lumatone']) {
      for (const alignment of ['left', 'right', 'vertical']) {
        await run(`__lb.pick('selOutline', '${outline}'); __lb.pick('selAlignment', '${alignment}')`);
        await sleep(40);
      }
    }
    clean('F console clean on ' + mappingOf({ division: d, shear: k, invert: inv }));
  }

  /* ── G ── */
  const key = (type, code) => cdp.send('Input.dispatchKeyEvent', { type, code, key: code.slice(3).toLowerCase(), windowsVirtualKeyCode: 0 });
  s = await run(`__lb.click('lbShearUp')`);
  const before = s.selected;
  for (const code of ['KeyA', 'KeyS', 'KeyD']) await key('rawKeyDown', code);
  await sleep(120);
  s = await state();
  check(s.selected >= before + 3, 'G three QWERTY keys held with the tray open (' + before + ' → ' + s.selected + ')');
  for (const code of ['KeyA', 'KeyS', 'KeyD']) await key('keyUp', code);
  await sleep(120);
  eq((await run(`__lb.click('btnClear')`)).selected, 0, 'G keys released');

  /* ── H ── */
  s = await run(`__lb.go(6, -2, true); __lb.click('lbClose')`);
  check(!s.open, 'H Close closes');
  eq(s.mapping, '6:-2:i', 'H the layout stays after Close');
  eq(s.selText, 'Custom…', 'H toolbar reads Custom… with the tray closed');
  s = await run(`__lb.pick('selMapping', 'custom')`);
  check(s.open, 'H "Custom…" reopens on a custom layout');
  checkShown(s, '6:-2:i', { division: 6, shear: -2, invert: true }, 'H reopened');
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
  s = await state();
  check(!s.open, 'H Escape closes');

  await load();
  s = await state();
  eq(s.mapping, '6:-2:i', 'H custom layout restored after a reload');
  eq(s.selText, 'Custom…', 'H toolbar reads Custom… after a reload');
  check(!s.open, 'H tray stays closed after a reload');
  s = await run(`__lb.click('btnResetPrefs')`);
  eq(s.mapping, 'euler', 'H Reset returns to Euler');
  eq(s.sel, 'euler', 'H toolbar on Euler after Reset');
  clean('console clean through G–H');

  cdp.close();
  console.log(`\nlayout-builder tray: ${checks} checks, ${failures.length} failures`);
  exit = failures.length ? 1 : 0;
} catch (e) {
  console.error(e);
} finally {
  await chrome.stop();
}
process.exit(exit);
