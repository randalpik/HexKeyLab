// What does this Verovio build actually expose, and can ANY of it hand us the
// cast-off layout without rendering 37 pages to SVG?
// 1. enumerate toolkit methods + the option set
// 2. try getMEI in page-based / per-page shapes and report what comes back
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

const tk = new V.toolkit();
const proto = Object.getPrototypeOf(tk);
out.methods = Object.getOwnPropertyNames(proto).filter((n) => typeof tk[n] === 'function').sort();
out.version = tk.getVersion();

const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
tk.setOptions({ ...r['buildOptions']('auto'), breaks: 'smart', breaksSmartSb: 0 });
if (!tk.loadData(mei)) return { ...out, error: 'loadData failed' };
out.pages = tk.getPageCount();

const patch = (xml) => (/xmlns:hkl=/.test(xml) ? xml : xml.replace(/<mei\s/, '<mei xmlns:hkl="http://www.hexkeylab.org/ns" '));
const describe = (label, fn) => {
  const row = { label };
  try {
    const t = performance.now();
    const xml = fn();
    row.ms = Math.round(performance.now() - t);
    if (typeof xml !== 'string') { row.error = 'non-string: ' + typeof xml; return row; }
    row.chars = xml.length;
    const doc = new DOMParser().parseFromString(patch(xml), 'application/xml');
    const err = doc.querySelector('parsererror');
    if (err) { row.error = 'parse: ' + err.textContent.slice(0, 90); return row; }
    for (const n of ['page', 'system', 'sb', 'pb', 'measure', 'section']) {
      row[n] = doc.getElementsByTagNameNS('*', n).length;
    }
  } catch (e) {
    row.error = String(e && e.message || e).slice(0, 140);
  }
  return row;
};

out.variants = [
  describe('getMEI({scoreBased:false})', () => tk.getMEI({ scoreBased: false })),
  describe('getMEI({pageNo:1})', () => tk.getMEI({ pageNo: 1 })),
  describe('getMEI({pageNo:1,scoreBased:false})', () => tk.getMEI({ pageNo: 1, scoreBased: false })),
  describe('getMEI({pageNo:2,scoreBased:false})', () => tk.getMEI({ pageNo: 2, scoreBased: false })),
];

/* If a page-based variant works, time reading the whole partition from it. */
const pageBased = out.variants.find((v) => !v.error && v.system > 0);
out.pageBasedFound = pageBased ? pageBased.label : null;
if (pageBased) {
  const t = performance.now();
  const starts = [];
  const pageStarts = [];
  for (let p = 1; p <= tk.getPageCount(); p++) {
    const xml = tk.getMEI({ pageNo: p, scoreBased: false });
    const doc = new DOMParser().parseFromString(patch(xml), 'application/xml');
    let firstOfPage = null;
    for (const sys of Array.from(doc.getElementsByTagNameNS('*', 'system'))) {
      const m = sys.getElementsByTagNameNS('*', 'measure')[0];
      const id = m ? m.getAttribute('xml:id') : null;
      if (!id) continue;
      starts.push(id);
      if (!firstOfPage) firstOfPage = id;
    }
    if (firstOfPage) pageStarts.push(firstOfPage);
  }
  out.pageBasedWalk = { ms: Math.round(performance.now() - t), lines: starts.length, pages: pageStarts.length };
  out.sampleStarts = starts.slice(0, 5);
}
return out;
