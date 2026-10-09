// Phases of a full re-assembly of the loaded document, by function (Verovio, parse, post passes, import, close).
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/cb-loadprofile.js
// See docs/composer-render-perf.md → Tier 4 (2026-10-09).
const H = window.__hkl_composer; const r = H.renderer, model = H.model, pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 60) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
await waitFor(() => pb['startIds'] !== null, 120000, 100); await waitFor(() => !H.renderPending(), 120000, 100);
const buckets = {};
const wrap = (obj, name, label) => { const o = obj[name]; if (typeof o !== 'function') return () => {}; obj[name] = function (...a) { const t = performance.now(); try { return o.apply(this, a); } finally { const b = buckets[label] || (buckets[label] = { ms: 0, n: 0 }); b.ms += performance.now() - t; b.n++; } }; return () => { obj[name] = o; }; };
const restores = [];
const tk = r['spliceTk'];
restores.push(wrap(tk, 'loadData', 'verovio.loadData'), wrap(tk, 'renderToSVG', 'verovio.renderToSVG'), wrap(tk, 'setOptions', 'verovio.setOptions'));
restores.push(wrap(DOMParser.prototype, 'parseFromString', 'DOMParser.parse'));
restores.push(wrap(SVGGraphicsElement.prototype, 'getBBox', 'getBBox'));
restores.push(wrap(Element.prototype, 'getBoundingClientRect', 'getBoundingClientRect'));
restores.push(wrap(XMLSerializer.prototype, 'serializeToString', 'XMLSerializer'));
restores.push(wrap(model, 'serializeRangeForRender', 'model.serializeRange'));
// assembler host hooks (after the re-assembly starts, the assembler is new — wrap the prototype instead)
const AP = Object.getPrototypeOf(r.pageVirt);
for (const [n, l] of [['step', 'asm.step'], ['importSystem', 'asm.importSystem'], ['closeOpenPage', 'asm.closeOpenPage'], ['openPage', 'asm.openPage'], ['fitsOnOpen', 'asm.fitsOnOpen'], ['moveSystems', 'asm.moveSystems']]) restores.push(wrap(AP, n, l));
const RP = Object.getPrototypeOf(r);
for (const [n, l] of [['postProcessRendered', 'r.postProcessRendered'], ['substituteHiddenStaffSystems', 'r.substituteHidden'], ['placePage', 'r.placePage'], ['measureAndPlace', 'r.measureAndPlace'], ['alignPageStaves', 'r.alignPageStaves']]) restores.push(wrap(RP, n, l));
const pf = await import('/composer/src/render/pagefit.ts');
// pagefit's exports are bindings; wrap via the assembler's imported references is not possible — time measureExtents/alignStaffRows by re-export? skip.
const t0 = performance.now();
r.forceFullRerender('profile'); H.reRender();
await waitFor(() => !H.renderPending(), 180000, 50);
const total = performance.now() - t0;
for (const f of restores) f();
const as = r.pageVirt;
const rows = Object.entries(buckets).sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => k + ': ' + Math.round(v.ms) + ' ms / ' + v.n + ' calls (' + (v.ms / v.n).toFixed(1) + ' ms each)');
return { totalMs: Math.round(total), stats: as.lastStats, rows, ua: navigator.userAgent.slice(0, 60) };
