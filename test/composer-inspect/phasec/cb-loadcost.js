// What does the never-painted castoff bootstrap actually cost at derive time,
// and is the result still correct? Forces three derive renders (the path taken
// by doc load, zoom, page size and every fallback) and reports wall time plus
// the resulting ownership state.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 30) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const warns = [];
const ow = console.warn; console.warn = (...a) => { warns.push(a.join(' ').slice(0, 160)); ow(...a); };
const out = { warns };
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) { console.warn = ow; return out; }

const runs = [];
for (let i = 0; i < 3; i++) {
  r.forceFullRerender();            // exactly what zoom / page-size / reflow do
  const t0 = performance.now();
  reRender();
  await waitFor(badgeHidden);
  const wall = Math.round(performance.now() - t0);
  await sleep(60);
  runs.push({
    run: i + 1, wallMs: wall,
    ownershipActive: pb.ownershipActive(),
    paginationOwned: pb.paginationOwned(),
    lines: pb['startIds'] ? pb['startIds'].length : 0,
    pageStarts: pb.pageStarts().length,
    pagesInDom: document.querySelectorAll('#score .score-page').length,
    /* adoption via getMEI is synchronous, so no idle walk should be armed */
    idleWalkArmed: pb['adoption'] !== null,
  });
}
out.derives = runs;

/* The pins must actually be what got rendered. */
const starts = pb.pageStarts();
const rows = [];
for (const pageEl of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
  const m = pageEl.querySelector('g.system g.measure');
  rows.push({ page: +pageEl.dataset.page, firstId: m ? m.id : null });
}
out.mountedPagesChecked = rows.length;
out.pageStartsHonored = rows.every((row) => row.firstId === starts[row.page - 1]);

/* And the first edit after this derive must splice (the whole point). */
const ps = r['pageSplicer'];
for (const p of [7, 8, 9]) r['mountPage'](p);
await sleep(60);
model.setCursor(model.getFirstVisualCursorInMeasure(1, 100, 'overwrite'), 1);
const t = performance.now();
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
await waitFor(badgeHidden);
out.firstEditAfterDerive = {
  wallMs: Math.round(performance.now() - t),
  outcome: ps.lastOutcome, skip: ps.lastSkipReason,
};
console.warn = ow;
return out;
