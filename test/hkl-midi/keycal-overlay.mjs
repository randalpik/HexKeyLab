// Calibrate Keys → Built-in calibration: the overlay section, in a real browser.
//
// test/hkl-midi/keycal.mjs covers the state machine hardware-free; this covers the
// DOM around it: the section sits at the top of the overlay, Start key / Start
// aftertouch give way to Confirm / Cancel while a calibration runs, and the status
// line follows. The real buttons are clicked; a fake MIDI output answers as the
// firmware does (24h / 0Fh enter a mode, 52h leaves it, everything else is refused
// with STATE meanwhile).
//
// Requires `pnpm dev` running (umbrella proxy at :5170).
//
//   node test/hkl-midi/keycal-overlay.mjs      # exits non-zero on any failure

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  /* Import each module by the URL the running app imports it by (see departure.mjs). */
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) throw new Error(depPath + ' is not imported by ' + fromPath);
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  const diagUrl = await depUrl('/src/ui/init.ts', '/src/lumatone/lumadiag.ts');
  const [diag, { midi }, { lumatone }, { sysex }] = await Promise.all([
    import(diagUrl),
    depUrl(diagUrl, '/src/state/midi.ts').then((u) => import(u)),
    depUrl(diagUrl, '/src/state/lumatone.ts').then((u) => import(u)),
    depUrl(diagUrl, '/src/lumatone/sysex.ts').then((u) => import(u)),
  ]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: got === want });

  /* the fake device */
  const dev = { mode: 0, sent: [] };
  const answer = (m) => {
    const cmd = m[5];
    if (dev.mode !== 0 && cmd !== 0x52) return [4];
    if (cmd === 0x24) { dev.mode = 1; return [1]; }
    if (cmd === 0x0F) { dev.mode = 2; return [1]; }
    if (cmd === 0x52) { if (dev.mode === 0) return [0]; dev.mode = 0; return [1]; }
    if (cmd === 0x31) return [1, 1, 5, 0];
    return [1];
  };
  midi.midiIn = { id: 'fake-in', name: 'Lumatone', state: 'connected', onmidimessage: null };
  midi.midiOut = {
    id: 'fake-out', name: 'Lumatone', state: 'connected',
    send(m) {
      dev.sent.push([...m]);
      setTimeout(() => sysex.handleResponse(new Uint8Array([0xF0, 0x00, 0x21, 0x50, m[4], m[5], ...answer(m), 0xF7])), 1);
    },
  };
  lumatone.autoSyncEnabled = false;
  lumatone.firmware = [1, 5, 0];

  diag.ensureLumaDiag();
  diag.setLumaDiagVisible(true);
  await sleep(50);

  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  const shown = (label) => { const b = button(label); return !!b && b.style.display !== 'none'; };
  const state = () => ['Start key calibration', 'Start aftertouch calibration', 'Confirm (save)', 'Cancel (discard)']
    .map((l) => (shown(l) ? 1 : 0)).join('');
  const section = button('Start key calibration')?.parentElement?.parentElement;
  const statusText = () => section?.lastElementChild?.textContent ?? '';
  const calCmds = () => dev.sent.filter((m) => m[5] === 0x24 || m[5] === 0x0F || m[5] === 0x52).map((m) => m[5] + ':' + m[6]).join(' ');

  check('section is first under the header', section?.parentElement?.children[1] === section, true);
  check('section is titled', section?.firstElementChild?.textContent, 'Built-in calibration');
  check('idle: the two starts', state(), '1100');
  check('idle: no status line', statusText(), '');

  button('Start key calibration').click();
  await sleep(60);
  check('key running: Confirm / Cancel', state(), '0011');
  check('key running: phase', lumatone.keyCal, 'key');
  check('key running: status', statusText().startsWith('Key calibration running'), true);

  button('Cancel (discard)').click();
  await sleep(120);
  check('canceled: the two starts again', state(), '1100');
  check('canceled: status', statusText(), 'Calibration canceled: nothing was saved.');

  button('Start aftertouch calibration').click();
  await sleep(60);
  check('aftertouch running: Confirm / Cancel', state(), '0011');
  check('aftertouch running: status', statusText().startsWith('Aftertouch calibration running'), true);
  button('Confirm (save)').click();
  await sleep(120);
  check('confirmed: the two starts again', state(), '1100');
  check('confirmed: status', statusText().startsWith('Calibration confirmed'), true);
  check('wire: 24h, 52h 0, 0Fh, 52h 1', calCmds(), '36:0 82:0 15:0 82:1');
  check('values re-read after each calibration', dev.sent.filter((m) => m[5] === 0x3A).length >= 10, true);

  lumatone.firmware = [1, 4, 0];
  const before = dev.sent.length;
  button('Start key calibration').click();
  await sleep(60);
  check('1.4.0: nothing sent', dev.sent.length, before);
  check('1.4.0: still the two starts', state(), '1100');
  check('1.4.0: status says why', statusText().includes('1.5.0'), true);

  midi.midiOut = null; midi.midiIn = null;
  return { results, pass: results.every((r) => r.ok) };
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
  const passed = out.results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${out.results.length} checks passed`);
  if (!out.pass) exit = 1;
}
if (errors.length) { console.log('\nPAGE EXCEPTIONS:\n  ' + errors.join('\n  ')); exit = 1; }
await chrome.stop();
process.exit(exit);
