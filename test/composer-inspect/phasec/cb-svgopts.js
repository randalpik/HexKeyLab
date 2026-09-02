// Verovio SVG output options vs renderToSVG cost (2026-09-01, A thread).
// cb-naturalsalt found renderToSVG is ~87% of the naturals window's Verovio
// time (4.5 ms/measure) with loadData at ~0.6 ms/measure, and the splice
// window's renderToSVG (59 ms) is its largest single cost. Is the SVG STRING
// generation (pretty-printing, xlink) a meaningful share? Same loaded data,
// renderToSVG timed under: default / svgFormatRaw / svgRemoveXlink / both,
// on (1) the naturals shape (100 measures, breaks:'none') and (2) a splice-
// window shape (18 measures, window options). Also the innerHTML parse cost.
const H = window.__hkl_composer; const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null); await waitFor(badgeHidden, 90000, 40);
const tk = r['spliceTk']; const saved = tk.getOptions ? tk.getOptions() : null;
const avail = tk.getAvailableOptions ? JSON.stringify(tk.getAvailableOptions()) : '';
const out = { has: { svgFormatRaw: avail.includes('svgFormatRaw'), svgRemoveXlink: avail.includes('svgRemoveXlink'), svgHtml5: avail.includes('svgHtml5'), svgBoundingBoxes: avail.includes('svgBoundingBoxes'), outputIndent: avail.includes('outputIndent') }, shapes: {} };
const heji = { hejiEnabled: model.getHejiEnabled() };
const shapes = {
  naturals100: { mei: model.serializeRangeForRender(100, 199, heji, null), opts: r['buildOptions']('none', 'scroll') },
  window18: { mei: model.serializeRangeForRender(216, 233, heji, null), opts: r['pageSpliceCtx']().windowOptions },
};
const trials = { default: {}, raw: { svgFormatRaw: true }, noXlink: { svgRemoveXlink: true }, rawNoXlink: { svgFormatRaw: true, svgRemoveXlink: true } };
const med = (a) => +a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(1);
for (const [sname, s] of Object.entries(shapes)) {
  const res = {};
  for (const [tname, extra] of Object.entries(trials)) {
    tk.setOptions({ ...s.opts, svgFormatRaw: false, svgRemoveXlink: false, ...extra });
    const t0 = performance.now(); const ok = tk.loadData(s.mei); const loadMs = performance.now() - t0;
    const pages = tk.getPageCount(); const renders = [], parses = []; let bytes = 0, nodes = 0;
    for (let i = 0; i < 4; i++) {
      const t1 = performance.now(); let svg = ''; for (let p = 1; p <= pages; p++) svg += tk.renderToSVG(p, {}); renders.push(performance.now() - t1);
      const host = document.createElement('div'); const t2 = performance.now(); host.innerHTML = svg; parses.push(performance.now() - t2);
      bytes = svg.length; nodes = host.querySelectorAll('*').length;
    }
    res[tname] = { ok, pages, loadMs: +loadMs.toFixed(1), renderMs: med(renders.slice(1)), renders: renders.map((x) => +x.toFixed(1)), parseMs: med(parses.slice(1)), bytes, nodes };
  }
  out.shapes[sname] = { measures: (s.mei.match(/<measure\b/g) || []).length, results: res };
}
if (saved) tk.setOptions(saved);
return out;
