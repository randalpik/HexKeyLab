// Page-by-page fold check of the assembled document (bottom, limit, slack, would-the-next-fit) plus the assembly's load stats.
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/cb-pagefill.js
// See docs/composer-render-perf.md → Tier 4 (2026-10-09).
// Sonata pagination on the assembled pipeline (2026-10-08): every page mounted,
// systems per page, first-fit invariant per page (no overflow, no room for the
// next page's first system unless a <pb> starts it), load timing from the
// assembler's stats.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 60) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
await waitFor(() => pb['startIds'] !== null, 120000, 100);
await waitFor(() => !H.renderPending(), 120000, 100);
const as = r.pageVirt;
const out = { lines: pb['startIds'] ? pb['startIds'].length : null, pagesCommitted: pb.pageStarts().length, stats: as ? as.lastStats : null };
r.setMountWindowEnabled(false);
r.mountAllPages();
await sleep(200);
const pages = Array.from(document.querySelectorAll('#score .score-page:not(.score-page-pending)'));
const marginOf = (p) => p.querySelector('svg.definition-scale > g.page-margin');
const sysOf = (p) => { const mg = marginOf(p); return mg ? Array.from(mg.children).filter((c) => c.classList.contains('system')) : []; };
const limitOf = (p) => { const mg = marginOf(p); const fr = mg.closest('svg'); const vb = (fr.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number); const tr = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(mg.getAttribute('transform') || ''); return vb[3] - 2 * (tr ? Number(tr[2]) : 1400); };
const doc = model.getDoc();
const hardStart = (id) => { const me = doc.querySelector('[*|id="' + id + '"]'); return !!me && !!me.previousElementSibling && me.previousElementSibling.localName === 'pb'; };
out.pages = [];
out.violations = [];
for (let i = 0; i < pages.length; i++) {
  const page = pages[i], p = Number(page.dataset.page);
  const systems = sysOf(page);
  const limit = limitOf(page);
  const placed = r.placeFor(systems, { pageNo: p });
  const bottom = placed ? placed[placed.length - 1].contentBottom : null;
  const row = { p, systems: systems.length, bottom: bottom === null ? null : Math.round(bottom), limit: Math.round(limit), slack: bottom === null ? null : Math.round(limit - bottom), firstMeasure: (systems[0] && systems[0].querySelector('g.measure') || {}).id || '' };
  if (bottom !== null && bottom > limit + 20) out.violations.push('p' + p + ' overflows by ' + Math.round(bottom - limit));
  const next = pages[i + 1];
  if (next && Number(next.dataset.page) === p + 1) {
    const ns = sysOf(next)[0];
    const nid = ns && (ns.querySelector('g.measure') || {}).id;
    if (ns && nid && !hardStart(nid)) {
      const withNext = r.placeFor(systems.concat([ns]), { pageNo: p });
      const b2 = withNext ? withNext[withNext.length - 1].contentBottom : null;
      row.nextWouldEndAt = b2 === null ? null : Math.round(b2);
      if (b2 !== null && b2 <= limit - 20) out.violations.push('p' + p + ' under-full: next system fits (' + Math.round(b2) + ' <= ' + Math.round(limit) + ')');
    } else row.nextIsPb = !!(ns && nid && hardStart(nid));
  }
  out.pages.push(row);
}
out.pageCount = pages.length;
return out;
