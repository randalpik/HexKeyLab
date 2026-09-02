// Visual regression scaffolding. The `visual` tier captures a PNG for
// each fixture that declares a `visualBaseline` key, and compares it
// against tools/composer-test/baselines/<name>.png.
//
// First-run / missing baseline: writes the captured PNG to baselines/
// (treating it as a seed) and reports the fixture as ok-pending.
//
// Subsequent runs: compares pixel-by-pixel via per-pixel RGB diff.
// Reports the number of pixels exceeding a per-channel tolerance.
//
// TODO: install `pixelmatch` + `pngjs` for a proper perceptual diff
// (anti-aliased text, sub-pixel positioning). Current implementation
// reuses Chromium's screenshot output and a simple byte-level diff
// after stripping the PNG metadata — works as a regression sentinel
// when nothing has changed but is fragile to any layout shift.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = join(__dirname, '..', 'baselines');
const OUT_DIR = join(__dirname, '..', 'out');

mkdirSync(BASELINE_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

/** Capture a screenshot via CDP, compare against the baseline.
 *
 *  The page cards live inside #score (overflow: auto), and
 *  captureBeyondViewport only expands the DOCUMENT, never an inner
 *  scroller — anything outside the 1600×1200 window is dark capture fill,
 *  which silently cut page-mode captures on the right/bottom (found by
 *  Max 2026-08-30). Every page-mode capture therefore first resizes the
 *  viewport (device-metrics override) to hold the whole card stack — like
 *  a browser window sized to the document — waits for the layout to be
 *  STABLE (card + content geometry unchanged across consecutive frames;
 *  a fixed delay once shot a pageScale relayout mid-flight), takes the
 *  shot, and restores the metrics. The notation itself never reflows on a
 *  container resize (Verovio's layout is fixed at render time).
 *
 *  Clip framing: COMPACT content union by default (systems + selection +
 *  visible cursor visuals, padded) — the right frame for glyph-level
 *  fixtures. Fixtures about page-level behavior (page scale, system
 *  partition/line breaks) declare `visualFullPage: true` to capture the
 *  full card union instead, paper margins included. Multi-page full-page
 *  fixtures must mount later pages in their setup.
 *
 *  Scroll mode (no page cards) keeps the content-union clip at the normal
 *  window — the single continuous system can be ~190k px wide.
 *
 *  Every capture also reports `meta` (page count, card px dims, renderer
 *  zoom + pageScale, scroll offsets, clip) back to the runner, so a
 *  framing or page-size discrepancy is diagnosable from summary.json
 *  numbers instead of screenshot archaeology. */
export async function visualCheck(cdp, name, { updateBaselines = false, fullPage = false } = {}) {
  const info = await cdp.evalJSON(`(() => {
    const H = window.__hkl_composer;
    const score = document.getElementById('score');
    if (!score) return null;
    const pages = score.querySelectorAll('.score-page:not(.score-page-pending)').length;
    return {
      mode: pages ? 'page' : 'scroll',
      pages,
      zoom: H.renderer.getZoom(),
      pageScale: H.renderer.getPageScale(),
      scrollLeft: score.scrollLeft,
      scrollTop: score.scrollTop,
    };
  })()`);
  const meta = info
    ? { mode: info.mode, pages: info.pages, zoom: info.zoom, pageScale: info.pageScale,
        scrollLeft: info.scrollLeft, scrollTop: info.scrollTop }
    : {};

  /* One frame of geometry, measured in-page: card union + compact content
     union, with scroll normalized to origin. */
  const MEASURE = `(() => {
    const score = document.getElementById('score');
    if (!score) return null;
    score.scrollLeft = 0; score.scrollTop = 0;
    let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity;
    for (const p of score.querySelectorAll('.score-page:not(.score-page-pending)')) {
      const r = p.getBoundingClientRect();
      if (r.left < cMinX) cMinX = r.left;
      if (r.top < cMinY) cMinY = r.top;
      if (r.right > cMaxX) cMaxX = r.right;
      if (r.bottom > cMaxY) cMaxY = r.bottom;
    }
    const targets = [
      ...score.querySelectorAll('g.system'),
      ...score.querySelectorAll('rect[data-selection-rect="true"]'),
    ];
    for (const el of score.querySelectorAll('#cursorOverlay > *')) {
      const op = parseFloat(el.getAttribute('opacity') ?? '1');
      if (op > 0 && (el.tagName === 'rect' || el.tagName === 'text')) targets.push(el);
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of targets) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < minX) minX = r.left;
      if (r.top < minY) minY = r.top;
      if (r.right > maxX) maxX = r.right;
      if (r.bottom > maxY) maxY = r.bottom;
    }
    return {
      cards: isFinite(cMinX) ? { x: cMinX, y: cMinY, w: cMaxX - cMinX, h: cMaxY - cMinY } : null,
      content: isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null,
    };
  })()`;
  /* Wait until two consecutive frames agree on the geometry (relayouts,
     lazy mounts and injections have finished), up to ~1.5 s. */
  const settle = async () => {
    let prev = null;
    for (let i = 0; i < 30; i++) {
      await cdp.evalJSON(`new Promise((res) => requestAnimationFrame(() => setTimeout(res, 40)))`);
      const cur = await cdp.evalJSON(MEASURE);
      if (prev !== null && JSON.stringify(cur) === JSON.stringify(prev)) return cur;
      prev = cur;
    }
    return prev;
  };

  let clip = null;
  let overridden = false;
  if (info && info.mode === 'page') {
    /* Size the viewport to the whole content extent (score chrome + cards). */
    const need = await cdp.evalJSON(`(() => {
      const score = document.getElementById('score');
      const r = score.getBoundingClientRect();
      return {
        width: Math.ceil(r.left + score.scrollWidth + 24),
        height: Math.ceil(r.top + score.scrollHeight + 24),
      };
    })()`);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: Math.min(Math.max(need.width, 800), 8000),
      height: Math.min(Math.max(need.height, 600), 12000),
      deviceScaleFactor: 1,
      mobile: false,
    });
    overridden = true;
    const geom = await settle();
    if (geom) {
      const box = fullPage ? geom.cards : (geom.content ?? geom.cards);
      if (box) {
        const PAD = fullPage ? 8 /* card border + shadow */ : 16 /* glyph AA */;
        clip = {
          x: Math.max(0, Math.floor(box.x) - PAD),
          y: Math.max(0, Math.floor(box.y) - PAD),
          width: Math.ceil(box.w) + PAD * 2,
          height: Math.ceil(box.h) + PAD * 2,
          scale: 1,
        };
      }
      if (geom.cards) {
        meta.cardW = Math.round(geom.cards.w);
        meta.cardH = Math.round(geom.cards.h);
      }
      meta.fullPage = fullPage;
    }
  } else if (info) {
    /* Scroll mode: tight content union (systems + selection + visible
       cursor visuals), falling back to the bare SVG box. */
    const bbox = await cdp.evalJSON(`(() => {
      const score = document.getElementById('score');
      if (!score) return null;
      const targets = [
        ...score.querySelectorAll('g.system'),
        ...score.querySelectorAll('rect[data-selection-rect="true"]'),
      ];
      for (const el of score.querySelectorAll('#cursorOverlay > *')) {
        const op = parseFloat(el.getAttribute('opacity') ?? '1');
        if (op > 0 && (el.tagName === 'rect' || el.tagName === 'text')) targets.push(el);
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const el of targets) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.left < minX) minX = r.left;
        if (r.top < minY) minY = r.top;
        if (r.right > maxX) maxX = r.right;
        if (r.bottom > maxY) maxY = r.bottom;
      }
      if (!isFinite(minX)) {
        const svg = score.querySelector('svg:not(#cursorOverlay)');
        if (!svg) return null;
        const r = svg.getBoundingClientRect();
        return { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)),
                 width: Math.ceil(r.width), height: Math.ceil(r.height) };
      }
      const PAD = 16;
      return {
        x: Math.max(0, Math.floor(minX) - PAD),
        y: Math.max(0, Math.floor(minY) - PAD),
        width: Math.ceil(maxX - minX) + PAD * 2,
        height: Math.ceil(maxY - minY) + PAD * 2,
      };
    })()`);
    if (bbox && bbox.width > 0 && bbox.height > 0) clip = { ...bbox, scale: 1 };
  }

  const captureParams = { format: 'png', captureBeyondViewport: true };
  if (clip && clip.width > 0 && clip.height > 0) {
    captureParams.clip = clip;
  }

  const shot = await cdp.send('Page.captureScreenshot', captureParams);
  if (overridden) {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.evalJSON(`new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))`);
  }
  const png = Buffer.from(shot.data, 'base64');
  const baselinePath = join(BASELINE_DIR, name + '.png');
  const outPath = join(OUT_DIR, name + '.png');
  writeFileSync(outPath, png);

  if (updateBaselines || !existsSync(baselinePath)) {
    writeFileSync(baselinePath, png);
    return { ok: true, seeded: !existsSync(baselinePath) ? false : true, path: baselinePath, meta };
  }

  const baseline = readFileSync(baselinePath);
  if (baseline.equals(png)) {
    /* Consume any fixture diagnostic so it cannot attach to a later failure. */
    try { await cdp.evalJSON(`(window.__visualDiag = undefined, true)`); } catch { /* ignore */ }
    return { ok: true, path: baselinePath, meta };
  }

  /* Byte-identical comparison failed. Until pixelmatch lands, hash the
   * data to give a stable identity. */
  const hashB = createHash('sha1').update(baseline).digest('hex').slice(0, 8);
  const hashN = createHash('sha1').update(png).digest('hex').slice(0, 8);
  /* A fixture may leave geometry diagnostics in window.__visualDiag (e.g. the
     splice's applied translate in device px) — attach them so a one-off
     sub-pixel difference explains itself. */
  let diag = '';
  try { const d = await cdp.evalJSON(`(() => { const d = window.__visualDiag; window.__visualDiag = undefined; return d === undefined ? null : d; })()`); if (d) diag = `; fixture diag ${JSON.stringify(d)}`; } catch { /* ignore */ }
  return {
    ok: false,
    detail: `screenshot differs from baseline (${baseline.length}B vs ${png.length}B, sha1 ${hashB}/${hashN}); ` +
      `capture meta ${JSON.stringify(meta)}; saved out/${name}.png — review and re-run with --update-baselines to accept` + diag,
    outPath,
    baselinePath,
    meta,
  };
}
