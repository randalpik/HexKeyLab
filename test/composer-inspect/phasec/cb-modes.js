// Do the display strategies actually justify differently? (Max, 2026-08-30:
// "I have not seen any evidence that smartSb0 and encoded justification
// actually differ. And if they do, they shouldn't. Show me.")
//
// Renders the SAME document four ways and compares them measure by measure in
// the page-margin frame:
//   auto      — no pins (what a derive render of a pin-less doc actually uses)
//   smartSb0  — no pins ('smart' + breaksSmartSb:0)
//   line      — <sb> pins at our partition
//   encoded   — <sb> pins + <pb> at our page starts (pagination ownership)
// Reports, per pair: page count, per-page system split agreement, and the max
// per-measure delta in ABSOLUTE x and width — plus the worst offenders with
// enough context to see the pattern (which page, which system on the page,
// whether it is that page's LAST system, which measure in the line).
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const V = window.verovio;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 150) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;
const lb = await import('/composer/src/render/linebreaks.ts');

const startIds = pb['startIds'].slice();
const pageStarts = pb.pageStarts().slice();
const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
const pinnedSb = lb.injectPins(mei, startIds, null);
const pinnedPb = lb.injectPins(mei, startIds, new Set(pageStarts));
if (!pinnedSb || !pinnedPb) return { error: 'pin injection failed' };

const base = r['buildOptions']('auto');
const MODES = {
  auto:     { data: mei,       opts: { ...base } },
  smartSb0: { data: mei,       opts: { ...base, breaks: 'smart', breaksSmartSb: 0 } },
  line:     { data: pinnedSb,  opts: { ...base, breaks: 'line' } },
  encoded:  { data: pinnedPb,  opts: { ...base, breaks: 'encoded' } },
};

/* Measure geometry per page, in the page-margin frame (absolute), plus which
 * system it belongs to and whether that system is the page's last. */
function readMode(name) {
  const m = MODES[name];
  const tk = new V.toolkit();
  tk.setOptions(m.opts);
  const t0 = performance.now();
  if (!tk.loadData(m.data)) return null;
  const loadMs = Math.round(performance.now() - t0);
  const pages = tk.getPageCount();
  const byId = new Map();
  const pageSplit = [];
  for (let p = 1; p <= pages; p++) {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0';
    host.innerHTML = tk.renderToSVG(p, {});
    document.body.appendChild(host);
    try {
      const systems = [...host.querySelectorAll('g.system')];
      pageSplit.push(systems.map((s) => (s.querySelector('g.measure') || {}).id));
      systems.forEach((sys, si) => {
        const measures = [...sys.querySelectorAll('g.measure')];
        measures.forEach((el, mi) => {
          const b = el.getBBox();
          byId.set(el.id, {
            page: p, sysIdx: si, lastSysOnPage: si === systems.length - 1,
            idxInLine: mi, lineLen: measures.length,
            lastInLine: mi === measures.length - 1,
            x: +b.x.toFixed(1), w: +b.width.toFixed(1),
          });
        });
      });
    } finally { host.remove(); }
  }
  return { pages, byId, pageSplit, loadMs };
}

const read = {};
for (const name of Object.keys(MODES)) {
  read[name] = readMode(name);
  if (!read[name]) return { error: name + ' loadData failed' };
}
out.loadMs = Object.fromEntries(Object.keys(MODES).map((n) => [n, read[n].loadMs]));
out.pages = Object.fromEntries(Object.keys(MODES).map((n) => [n, read[n].pages]));

function compare(a, b) {
  const A = read[a], B = read[b];
  const res = {
    pagesEqual: A.pages === B.pages,
    splitEqual: JSON.stringify(A.pageSplit) === JSON.stringify(B.pageSplit),
    compared: 0, maxDx: 0, maxDw: 0, differing: 0, worst: [],
  };
  const rows = [];
  for (const [id, ga] of A.byId) {
    const gb = B.byId.get(id);
    if (!gb) continue;
    res.compared++;
    const dx = Math.abs(ga.x - gb.x), dw = Math.abs(ga.w - gb.w);
    res.maxDx = Math.max(res.maxDx, dx);
    res.maxDw = Math.max(res.maxDw, dw);
    if (dx > 1 || dw > 1) {
      res.differing++;
      rows.push({ id, dx: +dx.toFixed(1), dw: +dw.toFixed(1),
        page: ga.page, sysIdx: ga.sysIdx, lastSysOnPage: ga.lastSysOnPage,
        idxInLine: ga.idxInLine, lineLen: ga.lineLen, lastInLine: ga.lastInLine,
        [a]: [ga.x, ga.w], [b]: [gb.x, gb.w] });
    }
  }
  rows.sort((p, q) => Math.max(q.dx, q.dw) - Math.max(p.dx, p.dw));
  res.worst = rows.slice(0, 6);
  /* Distribution over ALL compared measures (not just the differing ones):
     "how big is the typical difference" is the question a max can't answer. */
  const all = [];
  for (const [id, ga] of A.byId) {
    const gb = B.byId.get(id);
    if (gb) all.push(Math.max(Math.abs(ga.x - gb.x), Math.abs(ga.w - gb.w)));
  }
  all.sort((p, q) => p - q);
  const pct = (f) => (all.length ? +all[Math.min(all.length - 1, Math.floor(all.length * f))].toFixed(1) : null);
  res.deltaPercentiles = { p50: pct(0.5), p75: pct(0.75), p90: pct(0.9), p99: pct(0.99), max: pct(1) };
  res.overPx = {
    over_1px: all.filter((v) => v > 10).length,
    over_3px: all.filter((v) => v > 30).length,
    over_10px: all.filter((v) => v > 100).length,
  };
  res.maxDx = +res.maxDx.toFixed(1);
  res.maxDw = +res.maxDw.toFixed(1);
  /* Which pages hold the differences, and are they concentrated on the last
     system of a page (the classic "last line isn't justified" behaviour)? */
  const pagesHit = {};
  let lastSysHits = 0;
  for (const row of rows) {
    pagesHit[row.page] = (pagesHit[row.page] || 0) + 1;
    if (row.lastSysOnPage) lastSysHits++;
  }
  res.pagesWithDiffs = Object.keys(pagesHit).length;
  res.diffsOnLastSystemOfPage = lastSysHits;
  res.pageHistogram = pagesHit;
  return res;
}

out.autoVsSmartSb0 = compare('auto', 'smartSb0');
out.autoVsLine = compare('auto', 'line');
out.autoVsEncoded = compare('auto', 'encoded');
out.lineVsEncoded = compare('line', 'encoded');
out.smartSb0VsEncoded = compare('smartSb0', 'encoded');
return out;
