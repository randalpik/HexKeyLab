// Phase 1 measurement (vertical-ownership plan, 2026-09-02): does a clearance
// rule over COMPOSER-measured extents reproduce Verovio's vertical placement?
// Mounts every sonata page and, per system, reads the staff-line frame (first
// staff top line, last staff bottom line), the post-processed bbox (above /
// below extents), the system transform and any section-header reserve. Tests
//   gap(k, k+1) = max(below(k), F) + G + max(above(k+1), F)
//   pageFirst    = contentTop + C0 + max(above, F)   (C0 = 5.25 units, calibrated)
// with F = 3 staff-line spacings (6 units), G = 2 (4 units), in SVG user units
// read from the staff lines themselves. Reports the delta distribution and the
// outliers with the class of the element that sets the extreme.
const H = window.__hkl_composer; const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null, 120000, 100); await waitFor(badgeHidden, 90000, 40);
r.setMountWindowEnabled(false);
for (const page of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) r['mountPage'](+page.dataset.page);
await sleep(200);
const tf = (el) => { const t = el.getAttribute('transform') || ''; const mm = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(t); return mm ? { tx: +mm[1], ty: +mm[2] } : { tx: 0, ty: 0 }; };
const parseD = (d) => { const mm = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d || ''); if (!mm) return null; if (Math.abs(+mm[2] - +mm[4]) > 1e-6) return null; return { x1: +mm[1], y: +mm[2], x2: +mm[3] }; };
const staffLines = (staff) => { const ys = []; for (const p of Array.from(staff.children)) { if (p.localName !== 'path') continue; const d = parseD(p.getAttribute('d')); if (d) ys.push(d.y); } return ys.sort((a, b) => a - b); };
const extremeClass = (sys, which) => { let best = null, bv = which === 'top' ? Infinity : -Infinity; for (const g of Array.from(sys.querySelectorAll('g[class]'))) { if (/^(system|measure|staff|layer|systemMilestone)/.test(g.getAttribute('class'))) continue; let b; try { b = g.getBBox(); } catch { continue; } if (!(b.width > 0 || b.height > 0)) continue; const v = which === 'top' ? b.y : b.y + b.height; if ((which === 'top' && v < bv) || (which === 'bot' && v > bv)) { bv = v; best = g.getAttribute('class').split(/\s+/)[0]; } } return best; };
const pages = Array.from(document.querySelectorAll('#score .score-page:not(.score-page-pending)'));
const out = { pages: pages.length, unit: null, systems: 0, pairs: [], firsts: [], perPage: [] };
let unitSamples = [];
for (const pageEl of pages) {
  const pno = +pageEl.dataset.page;
  const margin = pageEl.querySelector('svg g.page-margin'); if (!margin) continue;
  const mT = tf(margin);
  const titles = new Map(); for (const t of Array.from(pageEl.querySelectorAll('text.hkl-section-header'))) titles.set(t.getAttribute('data-for'), { reserve: +(t.getAttribute('data-reserve') || 0), y: +(t.getAttribute('y') || 0) });
  const systems = Array.from(margin.querySelectorAll(':scope > g.system'));
  /* Page header (Verovio g.pgHead): the first system's content starts 2 units below its bottom. */
  let hdBottom = null; const hd = margin.querySelector(':scope > g.pgHead'); if (hd) { try { const b = hd.getBBox(); hdBottom = b.y + b.height + tf(hd).ty; } catch {} }
  const rows = [];
  for (const sys of systems) {
    const t = tf(sys); const measures = Array.from(sys.querySelectorAll('g.measure')); if (!measures.length) continue;
    const staves = Array.from(measures[0].querySelectorAll(':scope > g.staff')); if (!staves.length) continue;
    const firstLines = staffLines(staves[0]), lastLines = staffLines(staves[staves.length - 1]);
    if (firstLines.length < 2 || !lastLines.length) continue;
    for (let i = 1; i < firstLines.length; i++) unitSamples.push(firstLines[i] - firstLines[i - 1]);
    const sT0 = tf(staves[0]), sT1 = tf(staves[staves.length - 1]);
    const staffTop = firstLines[0] + sT0.ty, staffBot = lastLines[lastLines.length - 1] + sT1.ty;   // system frame, before the system transform
    let bb; try { bb = sys.getBBox(); } catch { continue; }
    let reserve = 0, hdr = null; for (const m of measures) { const h = titles.get(m.id); if (h) { reserve += h.reserve; hdr = m.id; } }
    rows.push({ start: measures[0].id, ty: t.ty, staffTop, staffBot, above: +(staffTop - bb.y).toFixed(1), below: +((bb.y + bb.height) - staffBot).toFixed(1), reserve, hdr,
      absTop: staffTop + t.ty, absBot: staffBot + t.ty, bbTopAbs: bb.y + t.ty, bbBotAbs: bb.y + bb.height + t.ty });
  }
  out.systems += rows.length;
  out.perPage.push({ page: pno, marginTy: mT.ty, n: rows.length, rows: rows.map((x) => ({ start: x.start, ty: x.ty, absTop: +x.absTop.toFixed(1), above: x.above, below: x.below, reserve: x.reserve })) });
  /* accumulate raw pairs; the model is evaluated after the unit is known */
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (i === 0) out.firsts.push({ page: pno, start: a.start, observed: +(a.absTop - a.reserve).toFixed(1), above: a.above, reserve: a.reserve, hdBottom, sys: systems[i] });
    else { const p = rows[i - 1]; out.pairs.push({ page: pno, i, start: a.start, observed: +((a.absTop - a.reserve) - p.absBot).toFixed(1), belowPrev: p.below, above: a.above, reserve: a.reserve, sysPrev: systems[i - 1], sys: systems[i] }); }
  }
}
unitSamples.sort((a, b) => a - b); const lineSp = unitSamples[Math.floor(unitSamples.length / 2)]; const u = lineSp / 2;
out.unit = { lineSpacing: lineSp, unit: u, F: 6 * u, G: 4 * u };
const F = 6 * u, G = 4 * u;
const hist = (ds) => { const h = { le1u: 0, le3u: 0, le10u: 0, gt10u: 0 }; for (const d of ds) { const a = Math.abs(d) / u; if (a <= 1) h.le1u++; else if (a <= 3) h.le3u++; else if (a <= 10) h.le10u++; else h.gt10u++; } return h; };
const pairDeltas = [], firstDeltas = [];
out.pairOutliers = []; out.firstOutliers = [];
for (const p of out.pairs) { const model = Math.max(p.belowPrev, F) + G + Math.max(p.above, F); p.model = +model.toFixed(1); p.delta = +(p.observed - model).toFixed(1); pairDeltas.push(p.delta); if (Math.abs(p.delta) > 3 * u) out.pairOutliers.push({ page: p.page, i: p.i, start: p.start, observed: p.observed, model: p.model, delta: p.delta, deltaU: +(p.delta / u).toFixed(2), belowPrev: p.belowPrev, above: p.above, prevBotClass: extremeClass(p.sysPrev, 'bot'), topClass: extremeClass(p.sys, 'top') }); }
const C0 = 5.25 * u;   /* page-first content offset, calibrated 2026-09-02 (render/pagefit.ts) */
out.unit.C0 = C0;
for (const f of out.firsts) { const y0 = f.hdBottom != null ? f.hdBottom + 2 * u : C0; f.y0 = +y0.toFixed(1); const model = y0 + Math.max(f.above, F); f.model = +model.toFixed(1); f.delta = +(f.observed - model).toFixed(1); firstDeltas.push(f.delta); if (Math.abs(f.delta) > 3 * u) out.firstOutliers.push({ page: f.page, start: f.start, observed: f.observed, model: f.model, delta: f.delta, deltaU: +(f.delta / u).toFixed(2), above: f.above, topClass: extremeClass(f.sys, 'top') }); }
out.pairHist = hist(pairDeltas); out.firstHist = hist(firstDeltas);
out.pairDeltaU = { min: +(Math.min(...pairDeltas) / u).toFixed(2), max: +(Math.max(...pairDeltas) / u).toFixed(2), n: pairDeltas.length };
out.firstDeltaU = { min: +(Math.min(...firstDeltas) / u).toFixed(2), max: +(Math.max(...firstDeltas) / u).toFixed(2), n: firstDeltas.length };
for (const p of out.pairs) { delete p.sys; delete p.sysPrev; } for (const f of out.firsts) delete f.sys;
return out;
