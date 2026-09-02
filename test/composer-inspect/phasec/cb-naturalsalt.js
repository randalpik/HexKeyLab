// Naturals-window alternatives (2026-09-01, A thread). The refill measures
// natural widths with ONE giant breaks:'none' system (~5.5 ms/measure on
// large ranges — 4× a full render's per-measure loadData). Is that Verovio
// going superlinear on one huge system? Same 100-measure range rendered:
//   A  breaks:'none'                       (today's naturals render)
//   B  breaks:'encoded' pinned at the live line starts, noJustification
//   C  breaks:'encoded' pinned, justified   (the splice window's recipe)
// Reports load/render wall per variant and how B's per-measure widths compare
// with A's (interior measures; system-first measures minus the leading
// clef+key; system-last measures separately). `--arg "lo=<mi>,n=<count>"`.
const H = window.__hkl_composer; const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null); await waitFor(badgeHidden, 90000, 40);
const arg = String(window.__probeArg || '');
const lo = Number(arg.match(/lo=(\d+)/)?.[1] ?? 100), n = Number(arg.match(/n=(\d+)/)?.[1] ?? 100);
const hi = Math.min(model.allMeasures().length - 1, lo + n - 1);
const ids = model.allMeasures().map((m) => m.getAttribute('xml:id'));
const starts = new Set(pb['startIds']);
const tk = r['spliceTk'];
const opts = tk.getOptions ? tk.getOptions() : null;
const hasNoJust = !!(tk.getAvailableOptions && JSON.stringify(tk.getAvailableOptions()).includes('noJustification'));
const sub = model.serializeRangeForRender(lo, hi, { hejiEnabled: model.getHejiEnabled() }, null);
const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const pinned = (() => { const d = new DOMParser().parseFromString(sub, 'application/xml'); const sec = d.querySelector('section'); for (const m of Array.from(d.querySelectorAll('measure'))) { const id = m.getAttribute('xml:id'); if (!starts.has(id)) continue; let node = m; while (node.parentNode && node.parentNode !== sec) node = node.parentNode; if (node === sec.firstElementChild) continue; if (node.previousElementSibling?.localName === 'sb') continue; sec.insertBefore(d.createElementNS(MEI_NS, 'sb'), node); } return new XMLSerializer().serializeToString(d); })();
const base = r['buildOptions']('none', 'scroll');
const variants = {
  A_none: { mei: sub, opts: base },
  B_pinned_nojust: { mei: pinned, opts: { ...r['buildOptions']('encoded', 'scroll'), noJustification: true } },
  C_pinned_just: { mei: pinned, opts: { ...r['buildOptions']('encoded', 'scroll'), noJustification: false } },
};
const out = { lo, hi, measures: hi - lo + 1, hasNoJust, lines: pb['startIds'].filter((id) => { const i = ids.indexOf(id); return i >= lo && i <= hi; }).length, results: {} };
const geom = (host) => {
  /* per measure: bbox x/width, plus system membership */
  const res = new Map();
  for (const sys of Array.from(host.querySelectorAll('g.system'))) {
    const ms = Array.from(sys.querySelectorAll('g.measure'));
    const boxes = ms.map((m) => m.getBBox());
    for (let k = 0; k < ms.length; k++) {
      const w = k + 1 < ms.length ? boxes[k + 1].x - boxes[k].x : boxes[k].width;
      res.set(ms[k].id, { w, first: k === 0, last: k === ms.length - 1 });
    }
  }
  return res;
};
const sigWOf = (host) => {
  /* clef+key extent left of the first content in the FIRST system, like measureWindow */
  const sys = host.querySelector('g.system'); if (!sys) return 0;
  let firstContent = Infinity; for (const el of Array.from(sys.querySelectorAll('g.note, g.rest, g.chord, g.mRest'))) { const b = el.getBBox(); if (b.x < firstContent) firstContent = b.x; }
  let sigRight = -Infinity, sigLeft = Infinity; for (const el of Array.from(sys.querySelectorAll('g.clef, g.keySig'))) { const b = el.getBBox(); if (b.x < firstContent) { if (b.x + b.width > sigRight) sigRight = b.x + b.width; if (b.x < sigLeft) sigLeft = b.x; } }
  const m0 = sys.querySelector('g.measure').getBBox();
  return isFinite(sigRight) ? sigRight - m0.x : 0;
};
const G = {};
for (const [name, v] of Object.entries(variants)) {
  const loads = [], renders = []; let pages = 0, ok = true, bboxMs = 0, svgs = [];
  for (let i = 0; i < 3; i++) {
    tk.setOptions(v.opts);
    const t0 = performance.now(); ok = tk.loadData(v.mei) && ok; loads.push(performance.now() - t0);
    pages = tk.getPageCount(); svgs = [];
    const t1 = performance.now(); for (let p = 1; p <= pages; p++) svgs.push(tk.renderToSVG(p, {})); renders.push(performance.now() - t1);
  }
  const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:-99999px;top:0'; host.innerHTML = svgs.join(''); document.body.appendChild(host);
  const t2 = performance.now(); G[name] = { geom: geom(host), sigW: sigWOf(host) }; bboxMs = performance.now() - t2;
  const systems = host.querySelectorAll('g.system').length;
  host.remove();
  const med = (a) => +a.slice().sort((x, y) => x - y)[1].toFixed(1);
  out.results[name] = { ok, pages, systems, loadMs: med(loads), renderMs: med(renders), loads: loads.map((x) => +x.toFixed(1)), renders: renders.map((x) => +x.toFixed(1)), bboxMs: +bboxMs.toFixed(1), sigW: +G[name].sigW.toFixed(1), perMeasureMs: +((med(loads) + med(renders)) / (hi - lo + 1)).toFixed(2) };
}
/* width agreement: B vs A */
const cmp = (name) => {
  const a = G.A_none.geom, b = G[name].geom, sig = G[name].sigW;
  const interior = [], firsts = [], lasts = [];
  for (let i = lo; i <= hi; i++) { const id = ids[i]; const ga = a.get(id), gb = b.get(id); if (!ga || !gb) continue; const d = gb.w - ga.w; if (gb.first) firsts.push(+(d - sig).toFixed(1)); else if (gb.last) lasts.push(+d.toFixed(1)); else interior.push(+d.toFixed(1)); }
  const stat = (arr) => { if (!arr.length) return null; const abs = arr.map(Math.abs); return { n: arr.length, maxAbs: Math.max(...abs), meanAbs: +(abs.reduce((s, x) => s + x, 0) / arr.length).toFixed(2), sample: arr.slice(0, 8) }; };
  return { interior: stat(interior), firstMinusSigW: stat(firsts), last: stat(lasts) };
};
out.widthsBvsA = cmp('B_pinned_nojust'); out.widthsCvsA = cmp('C_pinned_just');
if (opts) tk.setOptions(opts);
return out;
