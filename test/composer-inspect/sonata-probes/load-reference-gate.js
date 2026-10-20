// Fresh-load reference gate (2026-10-08): every mounted page of the loaded
// document against a full engrave of the pinned MEI (the splicer's
// verifyAgainstReference, page ELEMENTS — page numbers check nothing). The
// assembly renders one line per window; this is the proof that each system
// equals the one a pinned page render would draw (courtesy stubs, spanner
// closure, staff subsets). Expect ok == pages, diverging == [].
//   node test/composer-inspect/sonata-probes/run-probe.mjs test/composer-inspect/sonata-probes/load-reference-gate.js
const H = window.__hkl_composer; const r = H.renderer, model = H.model, pb = r['pageBreaks'], ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 60) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
await waitFor(() => pb['startIds'] !== null, 120000, 100); await waitFor(() => !H.renderPending(), 120000, 100);
r.setMountWindowEnabled(false); r.mountAllPages(); await sleep(300);
globalThis.__HKL_INDEX_CHECK = true;
const pinned = r['pinnedMeiForCurrentModel']();
const ctx = r['pageSpliceCtx']();
const pages = Array.from(document.querySelectorAll('#score .score-page:not(.score-page-pending)'));
const out = { pages: pages.length, diverging: [], ok: 0 };
const oe = console.error; console.error = () => {};
for (const el of pages) {
  try { ps.verifyAgainstReference(pinned, [el], ctx); out.ok++; }
  catch (e) { out.diverging.push({ p: Number(el.dataset.page), msg: String(e && e.message || e).replace('[page-splice] ', '').slice(0, 200) }); }
}
console.error = oe;
return out;
