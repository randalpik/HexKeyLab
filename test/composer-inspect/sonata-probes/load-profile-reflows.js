// Which callers force reflows via getScreenCTM and which sample curves via getPointAtLength, during a full re-assembly.
//   node test/composer-inspect/sonata-probes/run-probe.mjs test/composer-inspect/sonata-probes/load-profile-reflows.js
// See docs/composer-render-perf.md → Tier 4 (2026-10-09).
const H = window.__hkl_composer; const r = H.renderer, model = H.model, pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 60) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
await waitFor(() => pb['startIds'] !== null, 120000, 100); await waitFor(() => !H.renderPending(), 120000, 100);
const stackOf = (depth) => (new Error().stack || '').split('\n').slice(2, 2 + depth).map((l) => l.trim().replace(/^at /, '').replace(/\s*\(.*$/, '').replace(/^async /, '')).filter((x) => x).join(' < ');
let dirty = false; const GEOM = new Set(['transform', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'width', 'height']);
const oSet = Element.prototype.setAttribute; Element.prototype.setAttribute = function (n, v) { if (GEOM.has(n)) dirty = true; return oSet.call(this, n, v); };
const oApp = Node.prototype.appendChild; Node.prototype.appendChild = function (c) { dirty = true; return oApp.call(this, c); };
const oRem = Node.prototype.removeChild; Node.prototype.removeChild = function (c) { dirty = true; return oRem.call(this, c); };
const oB = SVGGraphicsElement.prototype.getBBox; SVGGraphicsElement.prototype.getBBox = function (...a) { dirty = false; return oB.apply(this, a); };
const sc = {}; let scFlips = 0; let scMs = 0; let scN = 0;
const oS = SVGGraphicsElement.prototype.getScreenCTM; SVGGraphicsElement.prototype.getScreenCTM = function (...a) { const k = stackOf(4); const t = performance.now(); const res = oS.apply(this, a); const dt = performance.now() - t; scMs += dt; scN++; if (dirty) { scFlips++; dirty = false; } const e = sc[k] || (sc[k] = { n: 0, ms: 0 }); e.n++; e.ms += dt; return res; };
const pl = {}; let pn = 0; const oP = SVGGeometryElement.prototype.getPointAtLength; SVGGeometryElement.prototype.getPointAtLength = function (...a) { if ((pn++ % 50) === 0) { const k = stackOf(4); pl[k] = (pl[k] || 0) + 50; } return oP.apply(this, a); };
r.forceFullRerender('profile'); H.reRender();
await waitFor(() => !H.renderPending(), 180000, 50);
Element.prototype.setAttribute = oSet; Node.prototype.appendChild = oApp; Node.prototype.removeChild = oRem; SVGGraphicsElement.prototype.getBBox = oB; SVGGraphicsElement.prototype.getScreenCTM = oS; SVGGeometryElement.prototype.getPointAtLength = oP;
return { screenCTM: { n: scN, ms: Math.round(scMs), afterWrite: scFlips, by: Object.entries(sc).sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(([k, v]) => Math.round(v.ms) + ' ms / ' + v.n + '  ' + k) }, pointAtLength: Object.entries(pl).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => v + '  ' + k) };
