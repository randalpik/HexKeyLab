// The Lumatone Calibration overlay, in a real browser.
//
// test/hkl-midi/keycal.mjs covers the built-in calibration's state machine
// hardware-free; this covers the DOM around it and the rest of the panel:
//   - the title, the order of the sections (velocity curve, built-in calibration,
//     the five boards with Reset all 5 boards under them, the board swap), and
//     that the controls removed on 2026-11-24 are gone;
//   - Start key / Start aftertouch give way to Confirm / Cancel while a
//     calibration runs, and the status line follows;
//   - the key scales are read from the device after a calibration and after a
//     board's `max` is changed, and the line under the curve says where they stand;
//   - Reset all calibration and Reset all 5 boards send nothing when declined,
//     and when accepted the factory resets, after which the setup (the two
//     velocity tables among it) goes out again;
//   - the scroll bar has a strip of its own;
//   - the Overrides list: Add names a key by the next press (through the real
//     note-on handler), its slider sets the key's scale from half to double the
//     computed one, a device read leaves it alone, and Remove ends it.
// The real controls are used; a fake MIDI output answers as the firmware does
// (24h / 0Fh enter a mode, 52h leaves it, everything else is refused with STATE
// meanwhile; 19h / 1Ah / 3Ah / 3Bh answer with a synthetic calibration).
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
  const dev = { mode: 0, sent: [], maxOf: {} };
  /* A synthetic calibration: each key's MAX and MIN by SysEx board and slot, and
     the per-board thresholds (min hi 15, min lo 3, max 15, AT 10, CC 7). */
  const calMax = (board, k) => 100 + ((board * 7 + k) % 40);
  const calMin = (board, k) => k % 5;
  const nib = (vals) => vals.flatMap((v) => [v >> 4, v & 15]);
  const keys56 = [...Array(56).keys()];
  const answer = (m) => {
    const cmd = m[5];
    if (dev.mode !== 0 && cmd !== 0x52) return [4];
    if (cmd === 0x19) return [1, ...nib(keys56.map((k) => calMax(m[4], k)))];
    if (cmd === 0x1A) return [1, ...nib(keys56.map((k) => calMin(m[4], k)))];
    if (cmd === 0x3A) return [1, ...nib([15, 3, dev.maxOf[m[4]] ?? 15, 10, 7])];
    if (cmd === 0x3B) return [1, ...nib([8, 8])];
    if (cmd === 0x29) { dev.maxOf[m[4]] = m[7]; return [1]; }
    if (cmd === 0x34) { delete dev.maxOf[m[4]]; return [1]; }
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

  const panel = document.getElementById('lumaDiagOverlay');
  const kids = [...panel.children];
  const firstText = (el) => el?.querySelector('strong, button, label')?.textContent ?? '';
  check('title', kids[0]?.textContent, 'Lumatone Calibration');
  check('order: curve, calibration, boards 1-5, reset all boards, swap',
    kids.slice(1).map((el) => firstText(el).split(' (SysEx')[0]).join(' | '),
    'Lumatone velocity curve | Built-in calibration | Board 1 | Board 2 | Board 3 | Board 4 | Board 5 | Reset all 5 boards\u2026 | Swap boards 3 \u2194 4 (this unit)');
  const gone = ['Get all values', 'Push identity LUT', 'Push to Lumatone', 'Import key scales', 'Start capture', 'Clear all per-key',
    'Reset velocity LUT', 'Reset AT LUT', 'Reset Lumatouch LUT', 'Layer loudness', 'Per-key velocity statistics',
    'Hardware velocity intervals', 'Distinct velocities', 'lumadiag'];
  check('removed controls are gone', gone.filter((t) => panel.textContent.includes(t)).join(', '), '');
  check('one graph', panel.querySelectorAll('canvas').length, 1);
  check('the scroll bar has its own strip',
    getComputedStyle(panel).scrollbarGutter === 'stable' && (panel.offsetWidth - panel.clientWidth > 2 || panel.style.paddingRight === '12px'), true);
  const scaleLine = () => [...panel.querySelectorAll('div')].find((d) => d.firstChild?.nodeValue === 'Key scales: ')?.textContent ?? '';
  check('key scales: nothing read yet', scaleLine().startsWith('Key scales: '), true);
  check('section is second, under the curve', kids[2] === section, true);
  check('section is titled', section?.firstElementChild?.textContent, 'Built-in calibration');
  check('idle: Reset all calibration is offered', shown('Reset all calibration\u2026'), true);
  check('idle: the two starts', state(), '1100');
  check('idle: no status line', statusText(), '');

  button('Start key calibration').click();
  await sleep(60);
  check('key running: Confirm / Cancel', state(), '0011');
  check('key running: no Reset all calibration', shown('Reset all calibration\u2026'), false);
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

  /* The key scales, read after the calibration: the median window over each key's. */
  const count = (cmd) => dev.sent.filter((m) => m[5] === cmd).length;
  const expectScales = (maxOfBoard1) => {
    const w = [];
    for (let b = 1; b <= 5; b++) for (const k of keys56) w.push(calMax(b, k) - calMin(b, k) - ((b === 1 ? maxOfBoard1 : 15) + 3));
    const so = [...w].sort((x, y) => x - y), ref = (so[139] + so[140]) / 2;
    return '280 keys, ' + (ref / so[279]).toFixed(2) + '\u2013' + (ref / so[0]).toFixed(2);
  };
  await sleep(300);
  check('key scales read after a calibration: 19h and 1Ah to each board', [count(0x19) >= 5, count(0x1A) >= 5].join(), 'true,true');
  check('key scales: the line under the curve', scaleLine(), 'Key scales: ' + expectScales(15));

  /* A board\u2019s max changed: the windows changed, so the scales are read again. */
  const maxSlider = kids[3].querySelector('input[type=range]');
  const reads = count(0x19);
  maxSlider.value = '9';
  maxSlider.dispatchEvent(new Event('input'));
  maxSlider.dispatchEvent(new Event('change'));
  await sleep(900);
  check('max changed: 29h sent to board 1', dev.sent.some((m) => m[5] === 0x29 && m[4] === 1 && m[7] === 9), true);
  check('max changed: the scales are read again', count(0x19) - reads, 5);
  check('max changed: the line follows', scaleLine(), 'Key scales: ' + expectScales(9));

  /* Reset all 5 boards: declined sends nothing; accepted, five 34h. */
  const realConfirm = window.confirm;
  let asked = 0;
  window.confirm = () => { asked++; return false; };
  let at = dev.sent.length;
  button('Reset all 5 boards\u2026').click();
  await sleep(100);
  check('reset all boards, declined: asked, nothing sent', asked + ':' + (dev.sent.length - at), '1:0');
  window.confirm = () => { asked++; return true; };
  button('Reset all 5 boards\u2026').click();
  await sleep(900);
  check('reset all boards, accepted: 34h to boards 1-5', dev.sent.slice(at).filter((m) => m[5] === 0x34).map((m) => m[4]).sort().join(''), '12345');

  /* Reset all calibration: declined sends nothing; accepted, the three table
     resets and five 34h, then the setup again with HKL\u2019s two velocity tables. */
  window.confirm = () => { asked++; return false; };
  at = dev.sent.length;
  button('Reset all calibration\u2026').click();
  await sleep(100);
  check('reset all calibration, declined: asked, nothing sent', asked + ':' + (dev.sent.length - at), '3:0');
  window.confirm = () => { asked++; return true; };
  lumatone.autoSyncEnabled = true;
  button('Reset all calibration\u2026').click();
  for (let i = 0; i < 100 && !(dev.sent.slice(at).some((m) => m[5] === 0x20) && count(0x19) >= reads + 15); i++) await sleep(100);
  await sleep(300);
  lumatone.autoSyncEnabled = false;
  window.confirm = realConfirm;
  const after = dev.sent.slice(at).map((m) => m[5]);
  check('reset all calibration, accepted: 0Ah, 12h, 2Fh, then 34h x 5', after.slice(0, 8).join(' '), '10 18 47 52 52 52 52 52');
  check('then the setup again: both velocity tables after the resets',
    after.indexOf(0x08) > 7 && after.indexOf(0x20) > 7, true);
  check('and the key scales are read again', after.filter((c) => c === 0x19).length >= 5, true);

  lumatone.firmware = [1, 4, 0];
  const before = dev.sent.length;
  button('Start key calibration').click();
  await sleep(60);
  check('1.4.0: nothing sent', dev.sent.length, before);
  check('1.4.0: still the two starts', state(), '1100');
  check('1.4.0: status says why', statusText().includes('1.5.0'), true);

  /* Overrides: a key named by pressing it, its scale set on a slider. The press
     goes through the real note-on handler. */
  {
    const { velocityCal } = await depUrl(diagUrl, '/src/audio/velocityCal.ts').then((u) => import(u));
    const { refreshKeyScales } = await depUrl(diagUrl, '/src/lumatone/keyscales.ts').then((u) => import(u));
    const handler = await depUrl('/src/ui/init.ts', '/src/effects/onRefChanged.ts')
      .then((u) => depUrl(u, '/src/midi/handler.ts')).then((u) => import(u));
    const press = (ch, note) => {
      handler.handleMidiMessage({ data: new Uint8Array([0x90 + ch - 1, note, 100]) });
      handler.handleMidiMessage({ data: new Uint8Array([0x80 + ch - 1, note, 0]) });
    };
    const title = [...panel.querySelectorAll('span')].find((s) => s.textContent === 'Overrides:');
    const block = title?.parentElement?.parentElement;
    const list = block?.lastElementChild;
    const rows = () => [...(list?.children ?? [])].filter((r) => r.querySelector('input[type=range]'));
    const addBtn = () => [...(block?.querySelectorAll('button') ?? [])].find((b) => b.title.startsWith('Add a key'));
    const rowText = (r) => [...r.querySelectorAll('span')].map((s) => s.textContent).join(' | ');
    const overrides = () => JSON.stringify(velocityCal.keyOverride);
    const computed = velocityCal.computedScaleOf('3,36');

    check('overrides: under the key scales line', block?.previousElementSibling?.textContent.startsWith('Key scales: '), true);
    check('overrides: none to begin with', list?.textContent + ' ' + overrides(), 'none {}');
    check('overrides: Add and Copy', [...block.querySelectorAll('button')].map((b) => b.textContent).join(','), 'Add,Copy');
    check('overrides: the key has a computed scale other than 1', computed !== 1 && computed > 0, true);

    press(3, 30);
    check('not armed: a press adds nothing', overrides(), '{}');
    addBtn().click();
    check('Add: waiting for a key', addBtn().textContent, 'Press a key… (cancel)');
    press(3, 36);
    check('the pressed key is listed at its computed scale', overrides(), JSON.stringify({ '3,36': computed }));
    check('its row: place on the keyboard, scale, computed scale',
      rows().map(rowText).join(' / '), '(3, −1) | ' + computed.toFixed(2) + ' | ' + computed.toFixed(2));
    check('the slider starts in the middle', rows()[0].querySelector('input').value, '0');
    check('the pick is over', addBtn().textContent, 'Add');
    press(3, 30);
    check('the next press adds nothing', rows().length, 1);

    const slide = (v) => { const s = rows()[0].querySelector('input'); s.value = String(v); s.dispatchEvent(new Event('input')); };
    slide(50);
    check('slider +50: the computed scale times the square root of 2', Math.abs(velocityCal.scaleOf('3,36') - computed * Math.SQRT2) < 1e-12, true);
    check('the row shows it', rowText(rows()[0]), '(3, −1) | ' + (computed * Math.SQRT2).toFixed(2) + ' | ' + computed.toFixed(2));
    slide(-100);
    check('slider at its low end: half the computed scale', Math.abs(velocityCal.scaleOf('3,36') - computed / 2) < 1e-12, true);
    slide(50);

    /* A second key, listed in key order; a key already listed is not added twice. */
    addBtn().click(); press(1, 5);
    addBtn().click(); press(3, 36);
    check('two rows, in key order', rows().map((r) => r.querySelector('span').textContent).join(' '), '(−15, 8) (3, −1)');
    check('a listed key keeps its scale when picked again', Math.abs(velocityCal.scaleOf('3,36') - computed * Math.SQRT2) < 1e-12, true);

    /* Reading the calibration again leaves the override and its row as they were. */
    lumatone.firmware = [1, 5, 0];
    refreshKeyScales();
    await sleep(250);
    check('after a device read: the override stands', Math.abs(velocityCal.scaleOf('3,36') - computed * Math.SQRT2) < 1e-12, true);
    check('after a device read: the slider is where it was', rows()[1].querySelector('input').value, '50');

    rows()[1].querySelector('button').click();
    check('Remove: the row goes and the key is back at its computed scale',
      rows().length + ' ' + velocityCal.scaleOf('3,36'), '1 ' + computed);
    rows()[0].querySelector('button').click();
    check('all removed: none', list.textContent + ' ' + overrides(), 'none {}');

    addBtn().click(); addBtn().click();
    press(3, 36);
    check('Add twice cancels: a press adds nothing', addBtn().textContent + ' ' + overrides(), 'Add {}');
    addBtn().click();
    diag.setLumaDiagVisible(false);
    press(3, 36);
    check('hiding the panel ends a waiting pick', overrides(), '{}');
    diag.setLumaDiagVisible(true);
    check('and the button says Add again', addBtn().textContent, 'Add');

    const copyBtn = [...block.querySelectorAll('button')].find((b) => b.textContent === 'Copy');
    copyBtn.click();
    await sleep(100);
    check('Copy: answers on the button', ['Copied', 'In the console'].includes(copyBtn.textContent), true);
  }

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
