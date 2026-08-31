// Can getMEI hand us Verovio's cast-off partition directly, replacing the
// ~1.85 s page-by-page SVG walk that adoption uses today?
//
// After loadData with the castoff strategy, Verovio knows where every system
// starts. getMEI is documented to emit the current document; if its score-based
// output materialises <sb>/<pb> at the castoff's choices, we can read the
// partition from XML instead of rendering 37 pages to SVG.
//
// Tests every getMEI call shape this build might accept, and for each:
//   - cost, output size
//   - how many <sb>/<pb> it contains
//   - whether the measure ids following those breaks EQUAL the partition the
//     SVG walk produces (the ground truth we use today)
//   - whether our hkl-specific attributes survive (data-q/data-r), which
//     decides whether the output is merely readable or actually renderable
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

const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
const base = r['buildOptions']('auto');
/* The derive strategy for this document (it contains <sb>, so smartSb0). */
const castoffOpts = { ...base, breaks: 'smart', breaksSmartSb: 0 };

const tk = new V.toolkit();
tk.setOptions(castoffOpts);
let t0 = performance.now();
if (!tk.loadData(mei)) return { error: 'castoff loadData failed' };
out.castoffLoadMs = Math.round(performance.now() - t0);
out.pages = tk.getPageCount();

/* ── ground truth: the SVG walk we do today ── */
t0 = performance.now();
const walkStarts = [];
const walkPageStarts = [];
for (let p = 1; p <= tk.getPageCount(); p++) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0';
  host.innerHTML = tk.renderToSVG(p, {});
  document.body.appendChild(host);
  try {
    const starts = [];
    for (const sys of host.querySelectorAll('g.system')) {
      const m = sys.querySelector('g.measure');
      if (m && m.id) starts.push(m.id);
    }
    if (starts.length) walkPageStarts.push(starts[0]);
    walkStarts.push(...starts);
  } finally { host.remove(); }
}
out.svgWalk = { ms: Math.round(performance.now() - t0), lines: walkStarts.length, pages: walkPageStarts.length };

/* ── candidate getMEI call shapes ── */
const shapes = [
  ['no-args', () => tk.getMEI()],
  ['{}', () => tk.getMEI({})],
  ['{scoreBased:true}', () => tk.getMEI({ scoreBased: true })],
  ['{pageNo:0,scoreBased:true}', () => tk.getMEI({ pageNo: 0, scoreBased: true })],
  ['{basic:true}', () => tk.getMEI({ basic: true })],
  ['legacy(0,true)', () => tk.getMEI(0, true)],
];

/** Extract the partition from score-based MEI: measure ids directly preceded
 *  by an <sb>/<pb> anywhere in the section stream (wrappers included), which
 *  is exactly how our own pins are read back. */
function partitionOf(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const section = doc.querySelector('section');
  if (!section) return null;
  const lineStarts = [];
  const pageStarts = [];
  let pendingSb = false, pendingPb = false;
  let firstMeasureId = null;
  const walk = (el) => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'measure') {
        const id = c.getAttribute('xml:id');
        if (!firstMeasureId) firstMeasureId = id;
        if (pendingSb || pendingPb) { if (id) lineStarts.push(id); }
        if (pendingPb && id) pageStarts.push(id);
        pendingSb = false; pendingPb = false;
      } else if (c.localName === 'sb') pendingSb = true;
      else if (c.localName === 'pb') pendingPb = true;
      else if (c.querySelector && c.querySelector('measure')) walk(c);
    }
  };
  walk(section);
  return {
    firstMeasureId,
    lineStarts: firstMeasureId ? [firstMeasureId, ...lineStarts] : lineStarts,
    pageStarts: firstMeasureId ? [firstMeasureId, ...pageStarts] : pageStarts,
    sbCount: (xml.match(/<sb[ \/>]/g) || []).length,
    pbCount: (xml.match(/<pb[ \/>]/g) || []).length,
    keepsDataQ: /data-q=/.test(xml),
    keepsColor: /data-light-color=/.test(xml),
  };
}

out.shapes = [];
for (const [name, fn] of shapes) {
  const row = { name };
  try {
    const t = performance.now();
    const xml = fn();
    row.ms = Math.round(performance.now() - t);
    if (typeof xml !== 'string' || !xml.length) { row.error = 'empty/non-string output'; out.shapes.push(row); continue; }
    row.chars = xml.length;
    const part = partitionOf(xml);
    if (!part) { row.error = 'unparseable'; out.shapes.push(row); continue; }
    row.sbCount = part.sbCount;
    row.pbCount = part.pbCount;
    row.lines = part.lineStarts.length;
    row.pagesFromPb = part.pageStarts.length;
    row.keepsDataQ = part.keepsDataQ;
    row.keepsLightColor = part.keepsColor;
    row.matchesSvgWalkLines = part.lineStarts.join() === walkStarts.join();
    row.matchesSvgWalkPages = part.pageStarts.join() === walkPageStarts.join();
    if (!row.matchesSvgWalkLines) {
      let firstDiff = null;
      for (let i = 0; i < Math.max(part.lineStarts.length, walkStarts.length); i++) {
        if (part.lineStarts[i] !== walkStarts[i]) { firstDiff = { i, getMEI: part.lineStarts[i] ?? null, walk: walkStarts[i] ?? null }; break; }
      }
      row.firstLineDiff = firstDiff;
    }
  } catch (e) {
    row.error = String(e && e.message || e).slice(0, 160);
  }
  out.shapes.push(row);
}
return out;
