// C1's remaining half: does baking an <sb> at every USER-BREAK measure (as well
// as at the castoff's own system starts) make a user <pb> actually start a page?
//
// Hypothesis: a page can only begin at a LINE start. `layoutBreaks` bakes <sb>
// only where the smartSb0 castoff put system starts, and smartSb0 IGNORES <pb> —
// so the measure after a user page break is usually mid-line, and the <pb> can
// then neither start a page nor split its system. That would explain BOTH
// reported symptoms at once (no cascade; mid-system breaks don't reflow).
//
// Compares, on identical data with breaks:'line':
//   A = bake at castoff system starts only        (today's layoutBreaks)
//   B = bake at castoff starts UNION user-break measures   (proposed)
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const V = window.verovio;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 60) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const pbo = r['pageBreaks'];
const out = { errs: [] };
const oe = console.error; console.error = (...a) => { out.errs.push(a.join(' ').slice(0, 160)); oe(...a); };
out.adopted = await waitFor(() => pbo['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.error = oe; return out; }

const BREAK_AT = Number((window.__probeArg || '60'));
model.togglePageBreakAt(BREAK_AT);
const measures = model.allMeasures();
const breakId = measures[BREAK_AT]?.getAttribute('xml:id') ?? null;
out.breakAt = BREAK_AT;
out.breakMeasureId = breakId;

const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const tk = new V.toolkit();

/* Measures immediately following a section-level user <sb>/<pb> — the ones that
   MUST start a line. (Mirrors linebreaks.ts hardStartIds, inlined.) */
const hardStarts = (xml) => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const section = doc.querySelector('section');
  const out = new Set();
  if (!section) return out;
  let pending = false;
  const walk = (el) => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'measure') {
        if (pending) { const id = c.getAttribute('xml:id'); if (id) out.add(id); }
        pending = false;
      } else if (c.localName === 'sb' || c.localName === 'pb') pending = true;
      else if (c.localName !== 'scoreDef' && c.querySelector('measure')) walk(c);
    }
  };
  walk(section);
  return out;
};

/* Read the castoff's own system starts (smartSb0, which ignores <pb>). */
const castoffStarts = () => {
  tk.setOptions({ ...r['buildOptions']('smartSb0', 'page') });
  if (!tk.loadData(mei)) return null;
  let xml = '';
  try { xml = tk.getMEI({ scoreBased: false }); } catch { return null; }
  const src = /xmlns:hkl=/.test(xml) ? xml
    : xml.replace(/<mei\s/, '<mei xmlns:hkl="http://www.hexkeylab.org/ns" ');
  const doc = new DOMParser().parseFromString(src, 'application/xml');
  const ids = new Set();
  for (const sys of Array.from(doc.getElementsByTagNameNS('*', 'system'))) {
    const m = sys.getElementsByTagNameNS('*', 'measure')[0];
    const id = m ? m.getAttribute('xml:id') : null;
    if (id) ids.add(id);
  }
  return ids;
};

const bake = (starts) => {
  const mdoc = new DOMParser().parseFromString(mei, 'application/xml');
  const section = mdoc.querySelector('section');
  if (!section) return null;
  let added = 0;
  for (const meas of Array.from(mdoc.querySelectorAll('measure'))) {
    const id = meas.getAttribute('xml:id');
    if (!id || !starts.has(id)) continue;
    let node = meas;
    while (node.parentNode && node.parentNode !== section) node = node.parentNode;
    const prev = node.previousElementSibling;
    if (!prev) continue;
    if (prev.localName === 'sb') continue;
    section.insertBefore(mdoc.createElementNS(MEI_NS, 'sb'), node);
    added++;
  }
  return { xml: new XMLSerializer().serializeToString(mdoc), added };
};

const describe = (label, data) => {
  tk.setOptions({ ...r['buildOptions']('line', 'page') });
  if (!tk.loadData(data)) return { label, ok: false, why: 'loadData failed' };
  let xml = '';
  try { xml = tk.getMEI({ scoreBased: false }); } catch (e) { return { label, ok: false, why: String(e) }; }
  const src = /xmlns:hkl=/.test(xml) ? xml
    : xml.replace(/<mei\s/, '<mei xmlns:hkl="http://www.hexkeylab.org/ns" ');
  const doc = new DOMParser().parseFromString(src, 'application/xml');
  const pages = Array.from(doc.getElementsByTagNameNS('*', 'page'));
  const lines = [], pageStarts = [], perPage = [];
  let breakPage = -1, breakLineIdx = -1;
  pages.forEach((p, pi) => {
    const systems = Array.from(p.getElementsByTagNameNS('*', 'system'));
    perPage.push(systems.length);
    let first = null;
    for (const s of systems) {
      const ms = Array.from(s.getElementsByTagNameNS('*', 'measure'));
      const id = ms[0] ? ms[0].getAttribute('xml:id') : null;
      if (!id) continue;
      if (id === breakId) breakLineIdx = lines.length;
      if (ms.some((m) => m.getAttribute('xml:id') === breakId) && breakPage < 0) breakPage = pi;
      lines.push(id);
      if (!first) first = id;
    }
    if (first) pageStarts.push(first);
  });
  return {
    label, ok: true,
    pageCount: pages.length,
    lineCount: lines.length,
    breakIsLineStart: lines.includes(breakId),
    breakIsPageStart: pageStarts.includes(breakId),
    breakOnPage: breakPage,
    /* the symptom: a page holding a single system */
    singleSystemPages: perPage.reduce((a, n, i) => (n === 1 ? a.concat(i) : a), []),
    systemsPerPageAroundBreak: perPage.slice(Math.max(0, breakPage - 2), breakPage + 3),
    minSystemsPerPage: Math.min(...perPage),
  };
};

const co = castoffStarts();
if (!co) { out.errs.push('castoff read failed'); console.error = oe; return out; }
const hs = hardStarts(mei);
out.castoffStartCount = co.size;
out.hardStartIds = Array.from(hs);
out.breakIsCastoffSystemStart = breakId ? co.has(breakId) : null;

const A = bake(co);
const union = new Set(co); for (const id of hs) union.add(id);
const B = bake(union);
out.bakedA = A?.added; out.bakedB = B?.added;
out.A = A ? describe('A: castoff starts only (today)', A.xml) : null;
out.B = B ? describe('B: castoff starts UNION user breaks', B.xml) : null;

model.togglePageBreakAt(BREAK_AT);
console.error = oe;
return out;
