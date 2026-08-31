// getMEI returns 2.24 MB in ~35 ms but has no <section> — almost certainly
// PAGE-BASED MEI (<page>/<system> wrappers), which encodes the cast-off layout
// structurally. Dump the shape, then read the partition out of it and check it
// against the SVG walk we do today.
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
const tk = new V.toolkit();
tk.setOptions({ ...base, breaks: 'smart', breaksSmartSb: 0 });
if (!tk.loadData(mei)) return { error: 'castoff loadData failed' };

/* ground truth */
const walkStarts = [], walkPageStarts = [];
const tWalk = performance.now();
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
out.svgWalkMs = Math.round(performance.now() - tWalk);

const t0 = performance.now();
const xml = tk.getMEI();
out.getMeiMs = Math.round(performance.now() - t0);
out.chars = xml.length;
out.head = xml.slice(0, 700);

/* Verovio echoes our hkl: metadata elements but drops the xmlns:hkl
 * declaration, so its output is not well-formed XML as-is. Re-declare the
 * prefix on the root before parsing (a real implementation would do the same,
 * or strip those elements before handing the doc to Verovio). */
const t1 = performance.now();
const fixed = /xmlns:hkl=/.test(xml)
  ? xml
  : xml.replace(/<mei\s/, '<mei xmlns:hkl="http://www.hexkeylab.org/ns" ');
out.namespacePatched = fixed !== xml;
const doc = new DOMParser().parseFromString(fixed, 'application/xml');
out.parseMs = Math.round(performance.now() - t1);
const err = doc.querySelector('parsererror');
out.parseError = err ? err.textContent.slice(0, 200) : null;
if (err) return out;

const root = doc.documentElement;
out.rootName = root.localName;
const counts = {};
for (const name of ['section', 'page', 'system', 'measure', 'sb', 'pb', 'scoreDef', 'staff']) {
  counts[name] = doc.getElementsByTagNameNS('*', name).length;
}
out.elementCounts = counts;

/* Read the partition from page-based structure. */
const t2 = performance.now();
const pages = Array.from(doc.getElementsByTagNameNS('*', 'page'));
const lineStarts = [], pageStarts = [];
for (const page of pages) {
  const systems = Array.from(page.getElementsByTagNameNS('*', 'system'));
  let firstOfPage = null;
  for (const sys of systems) {
    const m = sys.getElementsByTagNameNS('*', 'measure')[0];
    const id = m ? m.getAttribute('xml:id') : null;
    if (!id) continue;
    lineStarts.push(id);
    if (!firstOfPage) firstOfPage = id;
  }
  if (firstOfPage) pageStarts.push(firstOfPage);
}
out.readPartitionMs = Math.round(performance.now() - t2);
out.fromGetMei = { lines: lineStarts.length, pages: pageStarts.length };
out.fromSvgWalk = { lines: walkStarts.length, pages: walkPageStarts.length };
out.linesMatch = lineStarts.join() === walkStarts.join();
out.pagesMatch = pageStarts.join() === walkPageStarts.join();
if (!out.linesMatch) {
  for (let i = 0; i < Math.max(lineStarts.length, walkStarts.length); i++) {
    if (lineStarts[i] !== walkStarts[i]) { out.firstLineDiff = { i, getMEI: lineStarts[i] ?? null, walk: walkStarts[i] ?? null }; break; }
  }
}
out.totalGetMeiPathMs = out.getMeiMs + out.parseMs + out.readPartitionMs;
return out;
