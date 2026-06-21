// HKL core-app console-warning scanner.
//
// There is no test harness on the HKL side (only Composer has one), so this
// reuses Composer's app-agnostic CDP layer (test/composer-test/lib/*) pointed
// at the HKL core app at http://localhost:5170/. It is an *inspection* tool: it
// drives the app into a state that exercises the noisy code paths, captures
// every console warning/error + failed network request, and prints a grouped
// report. It always exits 0 — it is not a pass/fail gate.
//
// Requires `pnpm dev` running (the umbrella proxy at :5170) in another terminal.
//
// Usage:
//   node test/hkl-inspect/console-scan.mjs                 # scan + report
//   node test/hkl-inspect/console-scan.mjs --screenshot out.png
//   HKL_URL=http://localhost:5170/ WAIT_MS=3000 node test/hkl-inspect/console-scan.mjs
//
// Why it plays a note: the staff-inset (and thus Verovio's WASM, the font load,
// and MEI rendering) loads lazily — only once the "Show staff notation" toggle
// is on AND at least one note is held. So the scan enables cbStaff + cbHeji,
// then holds a 3-note chord via CDP key events to trigger the render before
// reading the console.
//
// Source-map caveat: Chrome's "DevTools failed to load source map" messages are
// emitted by the DevTools *frontend*, not over CDP, and headless Chromium never
// fetches source maps at all — so that specific warning cannot be reproduced
// here. The Network section below catches the *underlying* failed requests
// (e.g. a missing font or a 404'd asset), which is the actionable signal.

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { attachConsoleCapture } from '../composer-test/lib/console-capture.mjs';
import { HR, tally, printConsole } from './report.mjs';
import { writeFileSync } from 'node:fs';

const URL = process.env.HKL_URL ?? 'http://localhost:5170/';
const WAIT_MS = Number(process.env.WAIT_MS ?? 2500);
const VEROVIO_MS = Number(process.env.VEROVIO_MS ?? 2500);

const argv = process.argv.slice(2);
const shotIdx = argv.indexOf('--screenshot');
const screenshotPath = shotIdx >= 0 ? argv[shotIdx + 1] : null;

/* Discovery allowlist: only drop genuinely-irrelevant noise. Everything else
 * is reported so we can see it. */
const ALLOW = [/favicon\.ico/i];
const isAllowed = (t) => ALLOW.some((re) => re.test(t));

/* Hold a QWERTY key down (no auto-up): HKL's keyboard-notes handler maps on
 * e.code, so the `key` value is cosmetic. rawKeyDown leaves the note held. */
function keyEvent(cdp, type, code, key) {
  return cdp.send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: 0 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = await launchChromium();
  const cdp = new CDP(await newTabWsUrl(chrome.port));
  await cdp.ready;

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  /* Attach captures BEFORE navigation so boot-time warnings (fonts, asset
   * 404s, eager module errors) are not missed. */
  const consoleCap = attachConsoleCapture(cdp, { allow: ALLOW });

  /* Network: map requestId -> url, then record >=400 responses and hard
   * loading failures. Catches the font/asset/source-map underlying requests. */
  const urlById = new Map();
  const netFailures = [];
  cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
    urlById.set(requestId, request.url);
  });
  cdp.on('Network.responseReceived', ({ requestId, response }) => {
    const url = response.url ?? urlById.get(requestId) ?? '?';
    if (response.status >= 400 && !isAllowed(url)) {
      netFailures.push({ kind: 'http ' + response.status, url });
    }
  });
  cdp.on('Network.loadingFailed', ({ requestId, errorText, blockedReason }) => {
    const url = urlById.get(requestId) ?? '?';
    if (isAllowed(url)) return;
    /* net::ERR_ABORTED on navigations/cancellations is noise; skip it. */
    if (errorText === 'net::ERR_ABORTED') return;
    netFailures.push({ kind: 'failed' + (blockedReason ? ' (' + blockedReason + ')' : ''), url, detail: errorText });
  });

  const loaded = new Promise((res) => {
    const off = cdp.on('Page.loadEventFired', () => { off(); res(); });
  });
  await cdp.send('Page.navigate', { url: URL });
  await loaded;
  await sleep(WAIT_MS);

  /* Enable the staff inset + HEJI accidentals so the note triggers Verovio +
   * the BravuraText font path. staff-inset reads these checkboxes live. */
  const enabled = await cdp.evalJSON(`(() => {
    const ids = ['cbStaff', 'cbHeji'];
    const out = {};
    for (const id of ids) {
      const cb = document.getElementById(id);
      out[id] = !!cb;
      if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    return out;
  })()`);
  if (!enabled || !enabled.cbStaff) {
    console.error('WARNING: #cbStaff not found — staff inset may not render. (Is this the HKL core app?)');
  }

  /* Hold a 3-note chord (A/S/D row = r=0) to drive a Verovio staff render. */
  const chord = [['KeyA', 'a'], ['KeyS', 's'], ['KeyD', 'd']];
  for (const [code, key] of chord) await keyEvent(cdp, 'rawKeyDown', code, key);
  await sleep(VEROVIO_MS); /* first render also downloads + inits Verovio WASM */

  /* Confirm the inset actually rendered (so a clean report means "clean", not
   * "never triggered"). */
  const insetHtml = await cdp.evalJSON(
    `(() => { const e = document.getElementById('staffInset'); return e ? e.innerHTML.slice(0, 120) : null; })()`,
  );
  const rendered = typeof insetHtml === 'string' && insetHtml.includes('<svg');

  if (screenshotPath) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
  }

  for (const [code, key] of chord) await keyEvent(cdp, 'keyUp', code, key);
  await sleep(300);

  const consoleRecs = consoleCap.drain();
  report({ consoleRecs, netFailures, rendered, insetHtml, screenshotPath });

  cdp.close();
  chrome.stop();
}

function report({ consoleRecs, netFailures, rendered, insetHtml, screenshotPath }) {
  console.log('\n' + HR);
  console.log('HKL console scan (Chromium) — ' + URL);
  console.log(HR);
  console.log('staff inset rendered: ' + (rendered ? 'yes (SVG present)' : 'NO — Verovio did not render; warnings below may be incomplete'));
  if (!rendered && insetHtml != null) console.log('  inset content: ' + JSON.stringify(insetHtml));
  if (screenshotPath) console.log('screenshot: ' + screenshotPath);

  printConsole(consoleRecs);

  const net = tally(netFailures, (r) => r.kind + '|' + r.url);
  console.log('\nNETWORK failures (' + net.length + ' distinct)');
  if (net.length === 0) console.log('  (none)');
  for (const r of net.sort((a, b) => a.url.localeCompare(b.url))) {
    console.log('  [' + r.kind + ']' + (r.count > 1 ? ' x' + r.count : '') + ' ' + r.url + (r.detail ? ' — ' + r.detail : ''));
  }

  console.log('\nNote: "DevTools failed to load source map" messages are DevTools-frontend');
  console.log('only and cannot be captured over CDP; check the NETWORK section for the');
  console.log('underlying failed asset/.map requests instead.');
  console.log(HR + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
