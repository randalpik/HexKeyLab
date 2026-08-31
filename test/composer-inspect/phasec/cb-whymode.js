// WHY do smartSb0 and encoded space differently on lines that have no encoded
// break near them? Isolates mode from content by rendering the SAME pinned
// data three ways:
//   line_sb      — sb pins, breaks:'line'      (≡ smartSb0, the baseline)
//   encoded_sb   — sb pins, breaks:'encoded'   (same DATA as line_sb, mode only)
//   encoded_sbpb — sb + pb pins, breaks:'encoded' (what ownership ships)
// If encoded_sb == line_sb, the mode is innocent and the <pb> ELEMENTS cause
// the respacing. If encoded_sb already differs, the MODE does — i.e. Verovio
// spaces the identical document differently depending only on which breaks
// algorithm it runs.
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

/* Per-measure width + x RELATIVE TO ITS OWN SYSTEM, so the comparison survives
 * a variant that paginates differently (encoded with no <pb> = one long page). */
function read(data, opts, label) {
  const tk = new V.toolkit();
  tk.setOptions(opts);
  if (!tk.loadData(data)) return null;
  const byId = new Map();
  const pages = tk.getPageCount();
  for (let p = 1; p <= pages; p++) {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0';
    host.innerHTML = tk.renderToSVG(p, {});
    document.body.appendChild(host);
    try {
      for (const sys of host.querySelectorAll('g.system')) {
        const measures = [...sys.querySelectorAll('g.measure')];
        if (!measures.length) continue;
        const x0 = measures[0].getBBox().x;
        for (const el of measures) {
          const b = el.getBBox();
          byId.set(el.id, { relX: b.x - x0, w: b.width });
        }
      }
    } finally { host.remove(); }
  }
  return { byId, pages, label };
}

const variants = {
  line_sb: read(pinnedSb, { ...base, breaks: 'line' }, 'line_sb'),
  encoded_sb: read(pinnedSb, { ...base, breaks: 'encoded' }, 'encoded_sb'),
  encoded_sbpb: read(pinnedPb, { ...base, breaks: 'encoded' }, 'encoded_sbpb'),
};
for (const [k, v] of Object.entries(variants)) if (!v) return { error: k + ' failed' };
out.pages = Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, v.pages]));

function cmp(a, b) {
  const A = variants[a].byId, B = variants[b].byId;
  let compared = 0, maxD = 0, differing = 0, sample = null;
  const all = [];
  for (const [id, ga] of A) {
    const gb = B.get(id);
    if (!gb) continue;
    compared++;
    const d = Math.max(Math.abs(ga.relX - gb.relX), Math.abs(ga.w - gb.w));
    all.push(d);
    if (d > 1) differing++;
    if (d > maxD) { maxD = d; sample = id + ' ' + a + '=[' + ga.relX.toFixed(0) + ',' + ga.w.toFixed(0) + '] ' + b + '=[' + gb.relX.toFixed(0) + ',' + gb.w.toFixed(0) + ']'; }
  }
  all.sort((p, q) => p - q);
  const pct = (f) => (all.length ? +all[Math.min(all.length - 1, Math.floor(all.length * f))].toFixed(1) : null);
  return { compared, differing, maxD: +maxD.toFixed(1), p50: pct(0.5), p90: pct(0.9), sample };
}

out.line_sb__vs__encoded_sb = cmp('line_sb', 'encoded_sb');       // mode only
out.encoded_sb__vs__encoded_sbpb = cmp('encoded_sb', 'encoded_sbpb'); // pb elements only
out.line_sb__vs__encoded_sbpb = cmp('line_sb', 'encoded_sbpb');   // the shipped delta
return out;
