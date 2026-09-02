// A7 correctness proof (2026-09-01): does a measure's natural width read from
// the SVG TEXT (its staff-line path `M x1 y L x2 y`, no layout) equal the
// natural PageLineBreaks.measureWindow reads today via getBBox (next.x −
// this.x; last measure: bbox.width)? Renders every sonata measure through the
// same breaks:'none' naturals recipe in ~150-measure windows and reports the
// per-measure delta distribution, the left-overhang (bbox.x − x1) that explains
// any difference, the last-measure delta (barline stroke), and the cost of
// each reading path (attach + layout + getBBox vs DOMParser + attribute reads).
const H = window.__hkl_composer; const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null); await waitFor(badgeHidden, 90000, 40);
const ids = model.allMeasures().map((m) => m.getAttribute('xml:id'));
const tk = r['spliceTk']; const saved = tk.getOptions ? tk.getOptions() : null;
const opts = r['buildOptions']('none', 'scroll');
const WIN = Number(String(window.__probeArg || '').match(/win=(\d+)/)?.[1] ?? 150);
const out = { measures: ids.length, windows: [], deltas: { exact: 0, small: 0, big: [] }, lastMeasure: [], overhang: { n: 0, max: 0, samples: [] }, cost: { bboxPathMs: 0, textPathMs: 0 }, staffPathShape: null };
const parseD = (d) => { const m = d.match(/M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/); return m ? { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] } : null; };
const spanOf = (measureEl) => {
  const staff = measureEl.querySelector('g.staff'); if (!staff) return null;
  for (const p of Array.from(staff.children)) { if (p.localName !== 'path') continue; const d = parseD(p.getAttribute('d') || ''); if (d && Math.abs(d.y1 - d.y2) < 1e-6) return d; }
  return null;
};
for (let lo = 0; lo < ids.length; lo += WIN) {
  const hi = Math.min(ids.length - 1, lo + WIN - 1);
  const sub = model.serializeRangeForRender(lo, hi, { hejiEnabled: model.getHejiEnabled() }, null);
  tk.setOptions(opts); if (!tk.loadData(sub)) { out.windows.push({ lo, hi, error: 'loadData failed' }); continue; }
  const svg = tk.renderToSVG(1, {});
  /* path A: today's reading */
  const tA = performance.now();
  const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:-99999px;top:0'; host.innerHTML = svg; document.body.appendChild(host);
  const els = []; for (let i = lo; i <= hi; i++) { const el = host.querySelector('#' + CSS.escape(ids[i])); if (!el) { els.length = 0; break; } els.push(el); }
  const boxes = els.map((el) => el.getBBox());
  const bboxW = new Map(); for (let i = lo; i <= hi && els.length; i++) { const k = i - lo; bboxW.set(ids[i], k + 1 < boxes.length ? boxes[k + 1].x - boxes[k].x : boxes[k].width); }
  const costA = performance.now() - tA;
  /* path B: text reading, never attached */
  const tB = performance.now();
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const spans = new Map(); let shapeNote = null;
  for (let i = lo; i <= hi; i++) { const el = doc.getElementById(ids[i]); if (!el) continue; const s = spanOf(el); if (!s) { shapeNote = 'no horizontal staff path in ' + ids[i]; continue; } spans.set(ids[i], s); }
  const costB = performance.now() - tB;
  out.cost.bboxPathMs += costA; out.cost.textPathMs += costB;
  if (!out.staffPathShape) { const first = doc.getElementById(ids[lo]); const staff = first && first.querySelector('g.staff'); out.staffPathShape = staff ? Array.from(staff.children).slice(0, 2).map((c) => c.outerHTML.slice(0, 160)) : null; }
  let winExact = 0, winSmall = 0, winBig = 0;
  for (let i = lo; i <= hi; i++) {
    const id = ids[i]; const bw = bboxW.get(id); const s = spans.get(id); if (bw == null || !s) continue;
    const span = s.x2 - s.x1; const d = span - bw; const k = i - lo; const overhang = boxes[k].x - s.x1;
    if (Math.abs(overhang) > 1e-3) { out.overhang.n++; out.overhang.max = Math.max(out.overhang.max, Math.abs(overhang)); if (out.overhang.samples.length < 12) out.overhang.samples.push({ mi: i, overhang: +overhang.toFixed(2), delta: +d.toFixed(2) }); }
    if (i === hi) { out.lastMeasure.push({ mi: i, bboxW: +bw.toFixed(2), span: +span.toFixed(2), delta: +d.toFixed(2) }); continue; }
    if (Math.abs(d) < 0.01) { out.deltas.exact++; winExact++; } else if (Math.abs(d) < 0.5) { out.deltas.small++; winSmall++; } else { winBig++; if (out.deltas.big.length < 40) out.deltas.big.push({ mi: i, id, bboxW: +bw.toFixed(2), span: +span.toFixed(2), delta: +d.toFixed(2), overhangThis: +(boxes[k].x - s.x1).toFixed(2), overhangNext: k + 1 < boxes.length && spans.get(ids[i + 1]) ? +(boxes[k + 1].x - spans.get(ids[i + 1]).x1).toFixed(2) : null }); }
  }
  out.windows.push({ lo, hi, n: hi - lo + 1, exact: winExact, small: winSmall, big: winBig, costA: +costA.toFixed(1), costB: +costB.toFixed(1), svgBytes: svg.length });
  host.remove();
}
out.cost.bboxPathMs = +out.cost.bboxPathMs.toFixed(1); out.cost.textPathMs = +out.cost.textPathMs.toFixed(1); out.deltas.bigCount = out.windows.reduce((s, w) => s + (w.big || 0), 0);
if (saved) tk.setOptions(saved);
return out;
