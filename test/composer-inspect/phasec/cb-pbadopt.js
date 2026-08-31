// Why does adoption miss the user <pb>'s page? Dumps the page-based MEI the
// 'line' castoff produces for a document containing one user page break, so the
// structure partitionFromLayout walks can be inspected directly:
//   - how many <page> elements,
//   - systems per page,
//   - any page whose FIRST <system> carries no <measure> (which would make that
//     page contribute no page-start id — the suspected cause of ownedPages
//     being one short of domPages),
//   - where the break measure actually lands.
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

/* Insert the user page break in the MODEL, then reproduce exactly what the
   derive path does: layoutBreaks(sb baking) + the castoff strategy, and read
   the page-based MEI. Uses an isolated toolkit so the live one is untouched. */
model.togglePageBreakAt(60);
const measures = model.allMeasures();
const breakId = measures[60]?.getAttribute('xml:id') ?? null;
out.breakMeasureId = breakId;
out.breakMeasureIdx = 60;

const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
out.userPbInSerialized = /<pb\b/.test(mei);

const tk = new V.toolkit();
const readStructure = (label, data, strategy) => {
  tk.setOptions({ ...r['buildOptions'](strategy, 'page') });
  if (!tk.loadData(data)) return { label, strategy, ok: false, why: 'loadData failed' };
  const svgPages = tk.getPageCount();
  let xml = '';
  try { xml = tk.getMEI({ scoreBased: false }); } catch (e) { return { label, strategy, ok: false, why: String(e) }; }
  const src = /xmlns:hkl=/.test(xml) ? xml
    : xml.replace(/<mei\s/, '<mei xmlns:hkl="http://www.hexkeylab.org/ns" ');
  const doc = new DOMParser().parseFromString(src, 'application/xml');
  if (doc.querySelector('parsererror')) return { label, strategy, ok: false, why: 'parse error' };
  const pages = Array.from(doc.getElementsByTagNameNS('*', 'page'));
  const detail = [];
  let pagesWithNoFirstMeasure = 0;
  let breakPageIdx = -1;
  pages.forEach((p, pi) => {
    const systems = Array.from(p.getElementsByTagNameNS('*', 'system'));
    const firstSysMeasures = systems[0]
      ? Array.from(systems[0].getElementsByTagNameNS('*', 'measure')).length : 0;
    if (!firstSysMeasures) pagesWithNoFirstMeasure++;
    /* which page holds the break measure, and is it that page's first? */
    for (const s of systems) {
      const ms = Array.from(s.getElementsByTagNameNS('*', 'measure'));
      if (ms.some((m) => m.getAttribute('xml:id') === breakId)) {
        if (breakPageIdx < 0) breakPageIdx = pi;
      }
    }
    if (pi < 3 || Math.abs(pi - 14) < 4) {
      detail.push({ page: pi, systems: systems.length, firstSystemMeasures: firstSysMeasures });
    }
  });
  /* Replicate partitionFromLayout's own read, exactly. */
  const lines = [], pageStarts = [];
  for (const page of pages) {
    let firstOfPage = null;
    for (const sys of Array.from(page.getElementsByTagNameNS('*', 'system'))) {
      const m = sys.getElementsByTagNameNS('*', 'measure')[0];
      const id = m ? m.getAttribute('xml:id') : null;
      if (!id) continue;
      lines.push(id);
      if (!firstOfPage) firstOfPage = id;
    }
    if (firstOfPage) pageStarts.push(firstOfPage);
  }
  return {
    label, strategy, ok: true,
    svgPageCount: svgPages,
    meiPageCount: pages.length,
    readLines: lines.length,
    readPageStarts: pageStarts.length,
    pagesWithNoFirstMeasure,
    breakOnMeiPage: breakPageIdx,
    breakIsAPageStart: pageStarts.includes(breakId),
    breakIsALineStart: lines.includes(breakId),
    sample: detail,
  };
};

const baked = r['layoutBreaks'](mei);
out.bakedAddedSb = (baked.match(/<sb\b/g) || []).length;
out.line = readStructure('layoutBreaks + line', baked, 'line');
out.encoded = readStructure('layoutBreaks + encoded (old behaviour)', baked, 'encoded');
out.rawLine = readStructure('raw mei + line (no sb baking)', mei, 'line');

model.togglePageBreakAt(60);
console.error = oe;
return out;
