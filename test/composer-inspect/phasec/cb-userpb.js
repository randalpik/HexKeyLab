// C1 repro: a user page break (Ctrl+B / togglePageBreakAt) on a LARGE document
// collapses pagination — the sonata renders as 2 giant clipped pages instead of
// 37, because such documents route through the derive path's `layoutBreaks` +
// breaks:'encoded', which paginates ONLY at encoded <pb> and never by height.
//
// Reports the page count and per-page system counts before the break, after it,
// and after undo, plus whether any mounted page overflows its paper box — so
// the defect and the fix are measured the same way.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 60) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };

const out = { errs: [], warns: [] };
const oe = console.error, ow = console.warn;
console.error = (...a) => { out.errs.push(a.join(' ').slice(0, 200)); oe(...a); };
console.warn = (...a) => { out.warns.push(a.join(' ').slice(0, 200)); ow(...a); };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.error = oe; console.warn = ow; return out; }

const mountAll = async () => {
  for (const page of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) {
    r['mountPage'](+page.dataset.page);
  }
  await sleep(40);
};

/* Does any mounted page's last system hang past the paper? That is what makes
   the giant pages VISIBLY broken (clipped content), not just unusual. */
const overflowReport = () => {
  const bad = [];
  for (const pageEl of Array.from(document.querySelectorAll('#score .score-page:not(.score-page-pending)'))) {
    const svg = pageEl.querySelector('svg');
    const systems = Array.from(pageEl.querySelectorAll('g.system'));
    if (!svg || !systems.length) continue;
    const box = svg.getBoundingClientRect();
    const last = systems[systems.length - 1].getBoundingClientRect();
    if (last.bottom > box.bottom + 2) {
      bad.push({ page: +pageEl.dataset.page, overhangPx: Math.round(last.bottom - box.bottom) });
    }
  }
  return bad;
};

const snapshot = async (label) => {
  await mountAll();
  const pages = Array.from(document.querySelectorAll('#score .score-page'));
  const perPage = pages.map((p) => Array.from(p.querySelectorAll('g.system')).length);
  return {
    label,
    domPages: pages.length,
    ownedPages: pb.pageStarts().length,
    lines: pb.lineStarts().length,
    systemsPerPage: perPage.slice(0, 6),
    systemsTotal: perPage.reduce((a, b) => a + b, 0),
    overflowing: overflowReport(),
    strategyHint: r['pageVirt'] ? String(r['pageVirt'].options?.breaks ?? '?') : 'n/a',
  };
};

out.before = await snapshot('before break');

/* Put a user page break partway in, through the model op Ctrl+B uses. */
out.toggled = model.togglePageBreakAt(60);
reRender();
await waitFor(badgeHidden, 120000, 40);
out.afterBreak = await snapshot('after user <pb> at measure 60');

/* Remove it again the same way (the toggle is its own inverse). */
out.toggledBack = model.togglePageBreakAt(60);
reRender();
await waitFor(badgeHidden, 120000, 40);
out.afterRemove = await snapshot('after removing the break');

/* Ownership self-consistency with the break in place: the owner's page list
   must describe the DOM it rendered, and the user's <pb> measure must BE one of
   our page starts (it is a hard page boundary, not a suggestion). Re-checked
   after letting any in-flight adoption settle, since the owner adopts lazily
   when it falls back. */
out.ownership = await (async () => {
  model.togglePageBreakAt(60);
  reRender();
  await waitFor(badgeHidden, 120000, 40);
  await waitFor(() => pb['startIds'] !== null, 60000, 200);
  await mountAll();
  const snap = await snapshot('with break, settled');
  const measures = model.allMeasures();
  const breakMeasureId = measures[60]?.getAttribute('xml:id') ?? null;
  const pageStarts = pb.pageStarts();
  /* Which line does the break measure start? Page starts are LINE ids. */
  const lineStarts = pb.lineStarts();
  const res = {
    domPages: snap.domPages,
    ownedPages: snap.ownedPages,
    pagesMatchDom: snap.ownedPages === snap.domPages,
    breakMeasureId,
    breakMeasureStartsALine: breakMeasureId ? lineStarts.includes(breakMeasureId) : null,
    breakMeasureStartsAPage: breakMeasureId ? pageStarts.includes(breakMeasureId) : null,
    overflowing: snap.overflowing,
    verifyRenderedPartition: pb.verifyRenderedPartition(
      r['container'], model, r['pageVirt']?.pageCount ?? 1, r['pageBreaksCtx']()),
  };
  model.togglePageBreakAt(60);
  reRender();
  await waitFor(badgeHidden, 120000, 40);
  return res;
})();

out.verdict = {
  brokeIntoGiantPages: out.afterBreak.domPages < out.before.domPages / 2,
  pagesBefore: out.before.domPages,
  pagesWithBreak: out.afterBreak.domPages,
  pagesAfterRemove: out.afterRemove.domPages,
  clippedPagesWithBreak: out.afterBreak.overflowing.length,
  recovered: out.afterRemove.domPages === out.before.domPages,
};
console.error = oe; console.warn = ow;
return out;
