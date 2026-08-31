// Focused C-B probe: two consecutive edits in one region. The first edit in a
// region re-breaks it by our fill rules (count may change → full render); the
// second edit should land as a system splice. Prints full skip diagnostics.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 60000, step = 60) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;
const mountAll = async () => {
  for (const page of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) {
    r['mountPage'](+page.dataset.page);
  }
  await sleep(30);
};
const runs = [];
for (let i = 0; i < 3; i++) {
  await mountAll();
  model.setCursor(model.getMeasureStartCursor(1, 100), 1);
  const okEdit = model.deleteAtCursor();
  const t0 = performance.now();
  reRender();
  await waitFor(badgeHidden, 60000, 40);
  runs.push({
    edit: i + 1,
    editOk: okEdit !== false && okEdit !== null,
    wallMs: Math.round(performance.now() - t0),
    outcome: ps.lastOutcome,
    skipReason: ps.lastSkipReason,
    stats: { ...ps.lastStats },
    refillLines: pb.lastRefillLines,
    derive: pb['adoption'] !== null,
  });
}
out.runs = runs;
return out;
