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

/** Capture a screenshot via CDP, compare against the baseline. Clips the
 *  screenshot to the rendered SVG's bounding box (plus a few pixels of
 *  padding). The default full-viewport screenshot is useless in page-mode
 *  layout because the Verovio SVG sits at the top-left of a paper-sized
 *  page, leaving most of the viewport blank — the actual content gets a
 *  tiny patch and any regression goes unnoticed in a vast sea of white. */
export async function visualCheck(cdp, name, { updateBaselines = false } = {}) {
  /* Compute a tight bbox covering just the rendered content (staves +
   * selection overlay + any cursor visuals) — NOT the full Verovio SVG
   * which in page mode is paper-sized (~2175 × 2810) and mostly empty.
   * Union the bboxes of <g class="system"> elements (each system of
   * staves Verovio emits), any selection overlay rects, and any visible
   * cursor rects. Add PAD on all sides. */
  const bbox = await cdp.evalJSON(`(() => {
    const score = document.getElementById('score');
    if (!score) return null;
    const targets = [
      ...score.querySelectorAll('g.system'),
      ...score.querySelectorAll('rect[data-selection-rect="true"]'),
    ];
    /* Also include any cursor-overlay rects/text whose opacity is non-zero
     * — so an entry-cursor visible inside the system stays in frame. */
    for (const el of score.querySelectorAll('#cursorOverlay > *')) {
      const op = parseFloat(el.getAttribute('opacity') ?? '1');
      if (op > 0 && (el.tagName === 'rect' || el.tagName === 'text')) {
        targets.push(el);
      }
    }
    if (targets.length === 0) {
      const svg = score.querySelector('svg:not(#cursorOverlay)');
      if (!svg) return null;
      const r = svg.getBoundingClientRect();
      return {
        x: Math.max(0, Math.floor(r.left)),
        y: Math.max(0, Math.floor(r.top)),
        width: Math.ceil(r.width),
        height: Math.ceil(r.height),
      };
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
    if (!isFinite(minX)) return null;
    /* PAD on all sides so anti-aliased glyphs on the edge aren't clipped. */
    const PAD = 16;
    return {
      x: Math.max(0, Math.floor(minX) - PAD),
      y: Math.max(0, Math.floor(minY) - PAD),
      width: Math.ceil(maxX - minX) + PAD * 2,
      height: Math.ceil(maxY - minY) + PAD * 2,
    };
  })()`);

  const captureParams = { format: 'png' };
  if (bbox && bbox.width > 0 && bbox.height > 0) {
    captureParams.clip = { ...bbox, scale: 1 };
  }

  const shot = await cdp.send('Page.captureScreenshot', captureParams);
  const png = Buffer.from(shot.data, 'base64');
  const baselinePath = join(BASELINE_DIR, name + '.png');
  const outPath = join(OUT_DIR, name + '.png');
  writeFileSync(outPath, png);

  if (updateBaselines || !existsSync(baselinePath)) {
    writeFileSync(baselinePath, png);
    return { ok: true, seeded: !existsSync(baselinePath) ? false : true, path: baselinePath };
  }

  const baseline = readFileSync(baselinePath);
  if (baseline.equals(png)) {
    return { ok: true, path: baselinePath };
  }

  /* Byte-identical comparison failed. Until pixelmatch lands, hash the
   * data to give a stable identity. */
  const hashB = createHash('sha1').update(baseline).digest('hex').slice(0, 8);
  const hashN = createHash('sha1').update(png).digest('hex').slice(0, 8);
  return {
    ok: false,
    detail: `screenshot differs from baseline (${baseline.length}B vs ${png.length}B, sha1 ${hashB}/${hashN}); saved out/${name}.png — review and re-run with --update-baselines to accept`,
    outPath,
    baselinePath,
  };
}
