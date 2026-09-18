// Pagination-vs-growth diagnostic (2026-09-08). Written for the instrgap
// defect: with render/instrgap.ts ENABLED the sonata renders 112 systems and
// 442 of 446 measures — one system silently never drawn. This reports every
// quantity that disagrees, in one shot, so the disagreement can be located
// rather than inferred from Verovio's "Page N does not exist" warning.
//
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/cb-pagegrowth.js
//   --arg "rerender=1"   render twice more, to separate a bootstrap problem
//                        from a stable one (it is stable)
//
// What to compare:
//   verovioPageCount vs virtPageCount vs pageDivs   — who thinks there are how
//     many pages. `virtPageCount` is frozen at loadData from getPageCount().
//   lineStarts vs renderedSystems                   — the model's partition
//     against what is actually in the DOM.
//   docMeasures vs renderedMeasures + missing[]     — the content loss itself.
//   lastCascade                                     — all zeros with msFold 0
//     means foldOf was never called, i.e. the overflow cascade never ran.
const H = window.__hkl_composer; const r = H.renderer; const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 40) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const msgs = [];
for (const lvl of ['warn', 'error']) { const o = console[lvl].bind(console); console[lvl] = (...a) => { msgs.push(lvl + ': ' + a.join(' ')); o(...a); }; }
const settle = async () => {
  await waitFor(() => { const b = document.getElementById('renderBusy'); return !b || b.hidden; });
};
await waitFor(() => pb['startIds'] !== null); await settle();

const snap = (label) => {
  const rendered = new Set([...document.querySelectorAll('#score g.measure')].map((m) => m.id));
  const docIds = [...H.model.getDoc().querySelectorAll('measure')].map((m) => m.getAttribute('xml:id')).filter(Boolean);
  const missing = docIds.filter((i) => !rendered.has(i));
  /* the system each missing measure SHOULD be in, by the model's partition */
  const starts = pb.lineStarts ? pb.lineStarts() : [];
  const lineOfMissing = missing.map((id) => {
    const k = starts.indexOf(id);
    return k >= 0 ? `${id} (starts line ${k + 1} of ${starts.length})` : id;
  });
  let vpc = null;
  try { vpc = r['tk'].getPageCount(); } catch (e) { vpc = 'threw: ' + e.message; }
  return {
    label,
    verovioPageCount: vpc,
    virtPageCount: r['pageVirt'] ? r['pageVirt'].pageCount : null,
    pageDivs: document.querySelectorAll('#score .score-page').length,
    lineStarts: starts.length,
    renderedSystems: document.querySelectorAll('#score g.system').length,
    docMeasures: docIds.length,
    renderedMeasures: rendered.size,
    missingCount: missing.length,
    missing: lineOfMissing.slice(0, 8),
    emptyPages: [...document.querySelectorAll('#score .score-page')]
      .map((p, i) => ({ page: i + 1, systems: p.querySelectorAll('g.system').length }))
      .filter((x) => x.systems === 0),
    lastSystemsPerPage: [...document.querySelectorAll('#score .score-page')]
      .slice(-4).map((p, i) => p.querySelectorAll('g.system').length),
  };
};

r.setMountWindowEnabled(false); r.mountAllPages(); await sleep(800);
const out = [snap('after mountAllPages')];
if (/rerender=1/.test(String(window.__probeArg || ''))) {
  for (const n of [1, 2]) {
    await H.reRender(); await settle();
    r.setMountWindowEnabled(false); r.mountAllPages(); await sleep(800);
    out.push(snap('after reRender #' + n));
  }
}
return {
  snapshots: out,
  paginationOwned: pb.paginationOwned(),
  instrgapEnabled: document.querySelectorAll('#score g.staff[data-hkl-ishift]').length > 0,
  systemsShifted: new Set([...document.querySelectorAll('#score g.staff[data-hkl-ishift]')].map((s) => s.closest('g.system'))).size,
  grownPaths: document.querySelectorAll('#score [data-hkl-igrow]').length,
  lastCascade: r['lastCascade'],
  pageBreakWarns: msgs.filter((m) => /page-breaks/.test(m)).slice(0, 6),
  instrgapWarns: msgs.filter((m) => /instrgap/.test(m)).slice(0, 6),
  verovioPageWarns: msgs.filter((m) => /does not exist/.test(m)).slice(0, 4),
};
