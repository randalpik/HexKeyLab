// PDF WYSIWYG probe: load Composer, import the sonata, export the PDF from the
// LIVE page DOM (Renderer.mountAllPages → downloadPdf), save it, and take a
// clipped screenshot of chosen live pages for raster comparison.
//   node test/composer-inspect/phasec/pdf-wysiwyg.mjs <outDir> [pages=1,2]
// Then: pdftoppm -r 254 -f N -l N -png -singlefile <outDir>/sonata.pdf <outDir>/pdf-pN
//       python3 test/composer-test/heatmap.py <outDir>/live-pN.png <outDir>/pdf-pN.png <outDir>/heat-pN.png
// (254 dpi = the screen's 2159 px across 8.5 in at zoom 100; sizes must match exactly.)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2];
const PAGES = (process.argv[3] ?? '1,2').split(',').map(Number);
const url = 'http://localhost:5170/composer/';
const SONATA = process.env.SONATA ?? '/home/max/Documents/sonataBr1.musicxml';
const DEBUG_PORT = 9222 + Math.floor(Math.random() * 1000);
const profileDir = mkdtempSync(join(tmpdir(), 'hkl-pdfw-'));
const chromium = spawn('chromium', ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`, '--window-size=1600,1200', 'about:blank'], { stdio: 'pipe' });
const cleanup = (code = 0) => { try { chromium.kill('SIGTERM'); } catch {} try { rmSync(profileDir, { recursive: true, force: true }); } catch {} process.exit(code); };
process.on('SIGINT', () => cleanup(130)); process.on('SIGTERM', () => cleanup(143));
async function waitForEndpoint() { const dl = Date.now() + 10_000; while (Date.now() < dl) { try { const r = await fetch(`http://localhost:${DEBUG_PORT}/json/version`); if (r.ok) return r.json(); } catch {} await new Promise((r) => setTimeout(r, 80)); } throw new Error('no debug endpoint'); }
async function newTab() { const r = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' }); return (await r.json()).webSocketDebuggerUrl; }
class CDP { constructor(ws) { this.ws = new WebSocket(ws); this.id = 0; this.pending = new Map();
  this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); });
  this.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id != null && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { try { this.ws.close(); } catch {} } }
async function evalIn(cdp, expr, timeoutMs = 300_000) {
  const result = await Promise.race([cdp.send('Runtime.evaluate', { expression: `(async () => { try { return JSON.stringify(await Promise.resolve(${expr})); } catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); } })()`, returnByValue: true, awaitPromise: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), timeoutMs))]);
  return result.result.value;
}
const PROBE = `(async () => {
  const h = window.__hkl_composer;
  const blobs = [];
  const oc = URL.createObjectURL; URL.createObjectURL = (b) => { blobs.push(b); return 'blob:x'; };
  const ok = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function(){};
  try {
    const t0 = performance.now();
    const pages = h.renderer.mountAllPages();
    const tMount = performance.now() - t0;
    const mod = await import('/composer/src/save.ts');
    const t1 = performance.now();
    await mod.downloadPdf(pages);
    const tPdf = performance.now() - t1;
    const blob = blobs.find(b => b && b.size > 0);
    if (!blob) return { error: 'no blob' };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const count = (bin.match(/[/]Type [/]Pages[^]{0,120}?[/]Count ([0-9]+)/) || [])[1];
    const meta = pages.map((p, i) => { const inner = p.querySelector('svg.definition-scale'); return { page: i + 1, w: p.getAttribute('width'), h: p.getAttribute('height'), vb: inner && inner.getAttribute('viewBox') }; });
    return { domPages: document.querySelectorAll('#score .score-page').length, pending: document.querySelectorAll('#score .score-page.score-page-pending').length,
      exported: pages.length, pdfPages: Number(count), size: bytes.length, tMount: Math.round(tMount), tPdf: Math.round(tPdf), meta, b64: btoa(bin) };
  } finally { URL.createObjectURL = oc; HTMLAnchorElement.prototype.click = ok; }
})()`;
try {
  await waitForEndpoint();
  const cdp = new CDP(await newTab()); await cdp.ready;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  await new Promise((res) => cdp.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Page.loadEventFired') res(); }));
  for (let i = 0; i < 200; i++) { if (await evalIn(cdp, `!!(window.__hkl_composer && window.__hkl_composer.renderer && document.querySelector('#score svg'))`) === 'true') break; await new Promise((r) => setTimeout(r, 250)); }
  const xml = readFileSync(SONATA, 'utf8');
  await evalIn(cdp, `(window.__sonataXml = ${JSON.stringify(xml)}, true)`);
  await evalIn(cdp, `(window.__composerImportMusicXml(window.__sonataXml), true)`);
  for (let i = 0; i < 400; i++) { if (await evalIn(cdp, `(() => { const b = document.getElementById('renderBusy'); return !!document.querySelector('.score-page svg') && (!b || b.hidden); })()`) === 'true') break; await new Promise((r) => setTimeout(r, 250)); }
  const out = JSON.parse(await evalIn(cdp, PROBE));
  if (out.__error || out.error) { console.error(out); cleanup(1); }
  writeFileSync(join(OUT, 'sonata.pdf'), Buffer.from(out.b64, 'base64'));
  delete out.b64;
  out.meta = out.meta.slice(0, 3).concat(['…'], out.meta.slice(-1));
  console.log(JSON.stringify(out, null, 2));
  /* Clipped screenshots of the chosen live pages: grow the viewport past the
     page box, scroll the page to the top of #score, clip to its rect. */
  const pw = Number(String(out.meta[0].w).replace('px', '')), ph = Number(String(out.meta[0].h).replace('px', ''));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.ceil(pw) + 300, height: Math.ceil(ph) + 300, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 500));
  for (const n of PAGES) {
    /* The mount window may have evicted this page since the export (it runs on
       the next idle tick); scrolling its placeholder into view re-mounts it. */
    await evalIn(cdp, `(() => { const d = document.querySelector('#score .score-page[data-page="${n}"]'); if (d) d.scrollIntoView({ block: 'start' }); return !!d; })()`);
    await new Promise((r) => setTimeout(r, 700));
    const rect = JSON.parse(await evalIn(cdp, `(() => { const el = document.querySelector('#score .score-page[data-page="${n}"] > svg'); if (!el) return null; el.scrollIntoView({ block: 'start' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`));
    if (!rect) { console.error('page ' + n + ' not found'); continue; }
    await new Promise((r) => setTimeout(r, 300));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } });
    writeFileSync(join(OUT, `live-p${n}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`live page ${n}: ${JSON.stringify(rect)}`);
  }
  cdp.close(); cleanup(0);
} catch (e) { console.error('probe failed:', e?.message ?? e); cleanup(1); }
