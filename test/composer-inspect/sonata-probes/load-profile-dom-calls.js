// Every geometry / query DOM call during a full re-assembly: count + time, plus per-pass ms from lastPostStats.
//   node test/composer-inspect/sonata-probes/run-probe.mjs test/composer-inspect/sonata-probes/load-profile-dom-calls.js
// See docs/composer-render-perf.md → Tier 4 (2026-10-09).
const H = window.__hkl_composer; const r = H.renderer, model = H.model, pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 60) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
await waitFor(() => pb['startIds'] !== null, 120000, 100); await waitFor(() => !H.renderPending(), 120000, 100);
const buckets = {}; const restores = [];
const wrap = (obj, name, label) => { const o = obj[name]; if (typeof o !== 'function') return; obj[name] = function (...a) { const t = performance.now(); try { return o.apply(this, a); } finally { const b = buckets[label] || (buckets[label] = { ms: 0, n: 0 }); b.ms += performance.now() - t; b.n++; } }; restores.push(() => { obj[name] = o; }); };
wrap(SVGGraphicsElement.prototype, 'getBBox', 'getBBox'); wrap(SVGGraphicsElement.prototype, 'getCTM', 'getCTM'); wrap(SVGGraphicsElement.prototype, 'getScreenCTM', 'getScreenCTM');
wrap(SVGGeometryElement.prototype, 'getPointAtLength', 'getPointAtLength'); wrap(SVGGeometryElement.prototype, 'getTotalLength', 'getTotalLength');
wrap(SVGTextContentElement.prototype, 'getExtentOfChar', 'getExtentOfChar'); wrap(SVGTextContentElement.prototype, 'getNumberOfChars', 'getNumberOfChars'); wrap(SVGTextContentElement.prototype, 'getComputedTextLength', 'getComputedTextLength');
wrap(window, 'getComputedStyle', 'getComputedStyle');
wrap(Element.prototype, 'querySelectorAll', 'querySelectorAll'); wrap(Element.prototype, 'querySelector', 'querySelector'); wrap(Element.prototype, 'closest', 'closest');
wrap(Element.prototype, 'setAttribute', 'setAttribute');
const RP = Object.getPrototypeOf(r); const agg = {}; const oPP = RP.postProcessRendered; let inPass = false;
RP.postProcessRendered = function (...a) { inPass = true; try { return oPP.apply(this, a); } finally { inPass = false; const st = this.lastPostStats; for (const [k, v] of Object.entries(st)) if (typeof v === 'number') agg[k] = (agg[k] || 0) + v; } };
r.forceFullRerender('profile'); H.reRender();
await waitFor(() => !H.renderPending(), 180000, 50);
for (const f of restores) f(); RP.postProcessRendered = oPP;
const rows = Object.entries(buckets).sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => k + ': ' + Math.round(v.ms) + ' ms / ' + v.n + ' calls');
return { rows, passMs: Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, Math.round(v)])) };
