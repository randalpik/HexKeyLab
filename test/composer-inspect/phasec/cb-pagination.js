// Phase C-B2 gating probe: can Composer own PAGINATION as well as line breaks?
//
// Owning pages means pinning <pb> at each page start and displaying with
// breaks:'encoded' — the only mode that honors <pb> ('line' ignores it and
// paginates by height itself). So the question is whether 'encoded' over a
// fully pinned document reproduces today's 'line' render EXACTLY:
//   - same page count and same systems-per-page split
//   - same per-measure geometry inside each system (spike 5 saw encoded vs
//     smartSb0 redistribute intra-line justification by up to ~516 units; if
//     that also happens vs 'line', enabling pagination ownership causes a
//     one-time visible respacing and needs Max's eyes)
//   - load cost (encoded was measured ~2x faster than smartSb0 in spike 5)
// Also measures the vertical facts a page-fit model would need: per-page
// content height vs the page box, and system heights + inter-system gaps.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const V = window.verovio;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 100) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;
const lb = await import('/composer/src/render/linebreaks.ts');
const startIds = pb['startIds'].slice();
const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);

const offscreen = (html) => {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0';
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
};

/* ── render A: today's display — sb pins only, breaks:'line' ── */
const pinnedSb = lb.injectPins(mei, startIds, null);
if (!pinnedSb) return { error: 'sb pin injection failed' };
const optsLine = { ...r['buildOptions']('auto'), breaks: 'line' };
const tkA = new V.toolkit();
tkA.setOptions(optsLine);
let t0 = performance.now();
if (!tkA.loadData(pinnedSb)) return { error: 'line loadData failed' };
out.lineLoadMs = Math.round(performance.now() - t0);
out.linePages = tkA.getPageCount();

/* Page start ids from render A — the pagination we would be adopting. */
const pageStarts = [];
const pageSystems = [];
for (let p = 1; p <= tkA.getPageCount(); p++) {
  const host = offscreen(tkA.renderToSVG(p, {}));
  const starts = [];
  for (const sys of host.querySelectorAll('g.system')) {
    const m = sys.querySelector('g.measure');
    if (m && m.id) starts.push(m.id);
  }
  host.remove();
  pageSystems.push(starts);
  if (starts.length) pageStarts.push(starts[0]);
}
out.pageStartsFound = pageStarts.length;

/* ── render B: pagination owned — sb pins + pb at page starts, 'encoded' ── */
const pinnedPb = lb.injectPins(mei, startIds, new Set(pageStarts));
if (!pinnedPb) return { error: 'pb pin injection failed' };
const optsEnc = { ...r['buildOptions']('auto'), breaks: 'encoded' };
const tkB = new V.toolkit();
tkB.setOptions(optsEnc);
t0 = performance.now();
if (!tkB.loadData(pinnedPb)) return { error: 'encoded loadData failed' };
out.encodedLoadMs = Math.round(performance.now() - t0);
out.encodedPages = tkB.getPageCount();

/* ── compare pagination + geometry ── */
const profilePage = (tk, p) => {
  const host = offscreen(tk.renderToSVG(p, {}));
  const systems = [];
  for (const sys of host.querySelectorAll('g.system')) {
    const measures = [...sys.querySelectorAll('g.measure')];
    if (!measures.length) continue;
    const bb = sys.getBBox();
    const m0 = measures[0].getBBox();
    systems.push({
      firstId: measures[0].id,
      ids: measures.map((m) => m.id),
      geom: measures.map((m) => { const b = m.getBBox(); return [+(b.x - m0.x).toFixed(1), +b.width.toFixed(1)]; }),
      absX: +m0.x.toFixed(1),
      top: +bb.y.toFixed(1), bot: +(bb.y + bb.height).toFixed(1), h: +bb.height.toFixed(1),
    });
  }
  const svg = host.querySelector('svg');
  const vb = svg ? (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number) : null;
  host.remove();
  return { systems, viewBox: vb };
};

let pagesEqual = out.linePages === out.encodedPages;
let splitEqual = true, maxDx = 0, maxDw = 0, maxDtop = 0, compared = 0, sample = null;
const pageRows = [];
const N = Math.min(out.linePages, out.encodedPages);
for (let p = 1; p <= N; p++) {
  const A = profilePage(tkA, p), B = profilePage(tkB, p);
  if (A.systems.length !== B.systems.length
      || A.systems.some((s, i) => s.firstId !== B.systems[i].firstId)) splitEqual = false;
  for (let i = 0; i < Math.min(A.systems.length, B.systems.length); i++) {
    const a = A.systems[i], b = B.systems[i];
    maxDtop = Math.max(maxDtop, Math.abs(a.top - b.top));
    for (let j = 0; j < Math.min(a.geom.length, b.geom.length); j++) {
      compared++;
      const dx = Math.abs(a.geom[j][0] - b.geom[j][0]);
      const dw = Math.abs(a.geom[j][1] - b.geom[j][1]);
      if (dx > maxDx || dw > maxDw) sample = a.ids[j] + ' line' + JSON.stringify(a.geom[j]) + ' enc' + JSON.stringify(b.geom[j]);
      maxDx = Math.max(maxDx, dx); maxDw = Math.max(maxDw, dw);
    }
  }
  if (p <= 6 || p === N) {
    const gaps = [];
    for (let i = 0; i + 1 < A.systems.length; i++) gaps.push(+(A.systems[i + 1].top - A.systems[i].bot).toFixed(1));
    pageRows.push({
      page: p, systems: A.systems.length,
      viewBoxH: A.viewBox ? A.viewBox[3] : null,
      contentTop: A.systems.length ? A.systems[0].top : null,
      contentBot: A.systems.length ? A.systems[A.systems.length - 1].bot : null,
      slack: A.systems.length && A.viewBox ? +(A.viewBox[3] - A.systems[A.systems.length - 1].bot).toFixed(1) : null,
      sysHeights: A.systems.map((s) => s.h),
      interSystemGaps: gaps,
    });
  }
}
out.pagesEqual = pagesEqual;
out.splitEqual = splitEqual;
out.geom = { compared, maxDx: +maxDx.toFixed(1), maxDw: +maxDw.toFixed(1), maxSystemTopDelta: +maxDtop.toFixed(1), sample };
out.pageRows = pageRows;
out.systemsPerPage = pageSystems.map((s) => s.length);
return out;
