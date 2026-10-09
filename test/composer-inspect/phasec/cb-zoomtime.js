// A zoom round trip 100 → 50 → 100: ms, Verovio loads, outcome, systems kept, page starts held.
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/cb-zoomtime.js
// See docs/composer-render-perf.md → Tier 4 (2026-10-09).
const H = window.__hkl_composer; const r = H.renderer, model = H.model, pb = r['pageBreaks'], ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
await waitFor(() => pb['startIds'] !== null, 120000, 100); await waitFor(() => !H.renderPending(), 120000, 100);
const tk = r['spliceTk']; const o = tk.loadData; let loads = 0; tk.loadData = function (...a) { loads++; return o.apply(this, a); };
const before = [...document.querySelectorAll('#score .score-page g.system')].length;
const startsBefore = JSON.stringify(pb.pageStarts());
const t0 = performance.now();
r.setZoom(50); H.reRender();
const sync = performance.now() - t0;
await waitFor(() => !H.renderPending(), 120000, 20);
const total = performance.now() - t0;
tk.loadData = o;
const out = { syncMs: Math.round(sync), totalMs: Math.round(total), loads, outcome: ps.lastOutcome, systems: before + '->' + document.querySelectorAll('#score .score-page g.system').length, startsSame: JSON.stringify(pb.pageStarts()) === startsBefore, ledger: r.renderLedger().slice(-1).map((e) => (e.full ? 'F:' + e.deriveReason : e.outcome)), width: document.querySelector('#score .score-page[data-page="1"] > svg').getAttribute('width'), mounted: [...r.pageVirt.mounted].length };
const t1 = performance.now(); r.setZoom(100); H.reRender(); await waitFor(() => !H.renderPending(), 120000, 20); out.backMs = Math.round(performance.now() - t1); out.backOutcome = ps.lastOutcome;
return out;
