// Does breaks:'line' honor <pb>? The C-A notes assert it ignores them (which
// is why pagination ownership switched the display to 'encoded', costing a
// global respacing and the first-edit transition). If 'line' DOES honor <pb>,
// we get owned pagination with zero respacing and zero transition.
//
// Renders the same pinned document with 'line' both WITHOUT and WITH <pb> at
// our page starts, and reports whether pagination follows the pins.
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

function survey(data, opts) {
  const tk = new V.toolkit();
  tk.setOptions(opts);
  const t0 = performance.now();
  if (!tk.loadData(data)) return null;
  const loadMs = Math.round(performance.now() - t0);
  const pageFirsts = [];
  const geom = new Map();
  for (let p = 1; p <= tk.getPageCount(); p++) {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0';
    host.innerHTML = tk.renderToSVG(p, {});
    document.body.appendChild(host);
    try {
      const first = host.querySelector('g.system g.measure');
      pageFirsts.push(first ? first.id : null);
      for (const sys of host.querySelectorAll('g.system')) {
        const ms = [...sys.querySelectorAll('g.measure')];
        if (!ms.length) continue;
        const x0 = ms[0].getBBox().x;
        for (const el of ms) { const b = el.getBBox(); geom.set(el.id, [b.x - x0, b.width]); }
      }
    } finally { host.remove(); }
  }
  return { pages: tk.getPageCount(), pageFirsts, geom, loadMs };
}

const lineNoPb = survey(pinnedSb, { ...base, breaks: 'line' });
const lineWithPb = survey(pinnedPb, { ...base, breaks: 'line' });
if (!lineNoPb || !lineWithPb) return { error: 'render failed' };

out.line_without_pb = { pages: lineNoPb.pages, loadMs: lineNoPb.loadMs };
out.line_with_pb = { pages: lineWithPb.pages, loadMs: lineWithPb.loadMs };
out.ourPageStarts = pageStarts.length;

/* Does 'line' + <pb> paginate exactly at our pins? */
out.paginationMatchesPins = lineWithPb.pages === pageStarts.length
  && lineWithPb.pageFirsts.every((id, i) => id === pageStarts[i]);
out.firstMismatch = (() => {
  for (let i = 0; i < Math.max(lineWithPb.pageFirsts.length, pageStarts.length); i++) {
    if (lineWithPb.pageFirsts[i] !== pageStarts[i]) {
      return { page: i + 1, rendered: lineWithPb.pageFirsts[i] ?? null, pinned: pageStarts[i] ?? null };
    }
  }
  return null;
})();

/* And does adding <pb> disturb the spacing 'line' already produced? */
let maxD = 0, differing = 0, compared = 0;
for (const [id, a] of lineNoPb.geom) {
  const b = lineWithPb.geom.get(id);
  if (!b) continue;
  compared++;
  const d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  if (d > 1) differing++;
  maxD = Math.max(maxD, d);
}
out.spacingUnchangedByPb = { compared, differing, maxD: +maxD.toFixed(1) };
return out;
