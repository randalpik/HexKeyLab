// Render ONE sonata page with the requested display mode into #score so the
// runner can screenshot it — the visual half of the pagination-ownership
// question (numbers in cb-pagination.js: 'encoded' reproduces the pagination
// and the per-page system split exactly and loads 2x faster, but redistributes
// intra-line justification by up to ~516 units (~52 px) and moves system tops
// by up to ~491 units (~49 px) vs today's 'line').
//
//   --arg line|encoded   which display mode to render
//   --arg line:7         optional :page (default 3)
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

const spec = String(window.__probeArg || 'line');
const [mode, pageStr] = spec.split(':');
const PAGE = Number(pageStr || 3);
out.mode = mode; out.page = PAGE;

const startIds = pb['startIds'].slice();
const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);

/* Page starts come from the CURRENT ('line') layout — the pagination we would
 * be adopting into <pb> pins. */
const tkA = new V.toolkit();
tkA.setOptions({ ...r['buildOptions']('auto'), breaks: 'line' });
const pinnedSb = lb.injectPins(mei, startIds, null);
if (!tkA.loadData(pinnedSb)) return { error: 'line loadData failed' };
const pageStarts = [];
for (let p = 1; p <= tkA.getPageCount(); p++) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0';
  host.innerHTML = tkA.renderToSVG(p, {});
  document.body.appendChild(host);
  const m = host.querySelector('g.system g.measure');
  if (m && m.id) pageStarts.push(m.id);
  host.remove();
}

let svg;
if (mode === 'encoded') {
  const pinnedPb = lb.injectPins(mei, startIds, new Set(pageStarts));
  const tkB = new V.toolkit();
  tkB.setOptions({ ...r['buildOptions']('auto'), breaks: 'encoded' });
  if (!tkB.loadData(pinnedPb)) return { error: 'encoded loadData failed' };
  out.pages = tkB.getPageCount();
  svg = tkB.renderToSVG(PAGE, {});
} else {
  out.pages = tkA.getPageCount();
  svg = tkA.renderToSVG(PAGE, {});
}

/* Swap the live page DOM for just this page, post-processed exactly like a
 * real render so the screenshot shows what the user would see. */
const score = document.getElementById('score');
score.innerHTML = '<div class="score-page" data-page="' + PAGE + '">' + svg + '</div>';
const div = score.querySelector('.score-page');
r['postProcessRendered'](div);
r['snapSystems'](div);
score.scrollTop = 0; score.scrollLeft = 0;
await sleep(200);
const sys = [...div.querySelectorAll('g.system')];
out.systemsOnPage = sys.length;
out.firstMeasureIds = sys.map((s) => (s.querySelector('g.measure') || {}).id);
return out;
