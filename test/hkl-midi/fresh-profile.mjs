// HKL fresh-profile gate (state/persistence.ts DEFAULT_PREFS → ui/init.ts).
//
// A fresh profile (launchChromium's temp user-data dir: no saved prefs) must
// come up with every pref-backed <select> showing its DEFAULT_PREFS value.
// Assigning a value that has no <option> silently leaves the select blank, so
// a default that drifts from the menu (as `waveform` did when the "Piano"
// option moved from maestro_piano to splendid_piano) shows up here as a FAIL.
// The audio engine's starting instrument must agree with the pref, too.
//
// Requires `pnpm dev` running (umbrella proxy at :5170). The page is pinned to
// a private overlay relay (never the live :5190).
//
//   node test/hkl-midi/fresh-profile.mjs        # exits non-zero on any failure
//
// Covers:
//   D1-D7  selOutline, selRotation, selTuning, selMapping, selHexSize,
//          waveform, pedalMode each show their DEFAULT_PREFS value
//   D8     audio.activeWaveform === DEFAULT_PREFS.waveform
//   H1     Shift+\ opens Calibrate Keys before its overlay was ever built
//          (the listener used to be registered only by the first build)
//   H2     a plain D holds a QWERTY note
//   H3     Shift+D holds none (any modifier means a hotkey, never a note)
//   H4     with Diagnostics open, Ctrl+D is claimed by the overlay (freeze)
//          and holds no note

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
  const [prefsMod, audioMod] = await Promise.all([
    import(await depUrl(root, '/src/state/persistence.ts')),
    import(await depUrl(root, '/src/state/audio.ts')),
  ]);
  const D = prefsMod.DEFAULT_PREFS, { audio } = audioMod;
  const results = [];
  const SELECTS = [
    ['D1', 'selOutline', 'outline'], ['D2', 'selRotation', 'rotation'],
    ['D3', 'selTuning', 'tuning'], ['D4', 'selMapping', 'mapping'],
    ['D5', 'selHexSize', 'hexSize'], ['D6', 'waveform', 'waveform'],
    ['D7', 'pedalMode', 'pedalMode'],
  ];
  for (const [id, el, key] of SELECTS) {
    const sel = document.getElementById(el);
    const got = sel ? sel.value : '(no #' + el + ')';
    results.push({ name: id + ': #' + el + ' shows DEFAULT_PREFS.' + key, ok: got === String(D[key]), got, want: String(D[key]) });
  }
  results.push({ name: 'D8: audio.activeWaveform matches the default pref', ok: audio.activeWaveform === D.waveform, got: audio.activeWaveform, want: D.waveform });
  const cb = document.getElementById('cbCalibrateKeys');
  const before = cb.checked;
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backslash', key: '|', shiftKey: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  results.push({ name: 'H1: Shift+\\\\ opens Calibrate Keys on a fresh session', ok: !before && cb.checked, got: before + ' -> ' + cb.checked, want: 'false -> true' });
  if (cb.checked) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backslash', key: '|', shiftKey: true, bubbles: true }));

  const kn = await depUrl(root, '/src/input/keyboard-notes.ts');
  const held = await import(await depUrl(kn, '/src/input/held.ts'));
  const key = (type, mods) => {
    const ev = new KeyboardEvent(type, { code: 'KeyD', key: mods.shiftKey ? 'D' : 'd', bubbles: true, cancelable: true, ...mods });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const isHeld = () => held.heldKey('qwerty', 'KeyD') !== undefined;
  key('keydown', {});
  results.push({ name: 'H2: a plain D holds a QWERTY note', ok: isHeld(), got: isHeld(), want: true });
  key('keyup', {});
  key('keydown', { shiftKey: true });
  results.push({ name: 'H3: Shift+D holds no QWERTY note', ok: !isHeld(), got: isHeld(), want: false });
  key('keyup', { shiftKey: true });
  const diag = document.getElementById('cbShowDiag');
  diag.checked = true; diag.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 200));
  const claimed = key('keydown', { ctrlKey: true });
  const heldAfter = isHeld();
  key('keyup', { ctrlKey: true });
  results.push({ name: 'H4: Ctrl+D with Diagnostics open is claimed and holds no note', ok: claimed && !heldAfter, got: { claimed, held: heldAfter }, want: { claimed: true, held: false } });
  diag.checked = false; diag.dispatchEvent(new Event('change'));
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
