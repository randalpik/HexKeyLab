// Does pagination ownership CONVERGE on a document with a user <pb>, or does it
// sit in a permanent "diverged from pins → re-adopt" loop?
//
// With the C1 castoff fix, the adopted (height-derived) pagination has 37 pages
// while the painted 'encoded' render has 38 (it honors the user <pb> directly).
// verifyRenderedPartition then warns and re-adopts from the rendered layout.
// This measures whether repeated renders settle (ownedPages === domPages, no
// further warnings) or keep warning forever — which decides whether the partial
// fix is shippable as-is.
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

const out = { rounds: [] };
let warns = [];
const ow = console.warn;
console.warn = (...a) => { const s = a.join(' '); if (s.includes('page-break')) warns.push(s.slice(0, 120)); ow(...a); };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.warn = ow; return out; }

const mountAll = async () => {
  for (const p of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) {
    r['mountPage'](+p.dataset.page);
  }
  await sleep(40);
};

model.togglePageBreakAt(60);
reRender();
await waitFor(badgeHidden, 120000, 40);

/* Five successive renders with no document change: a converging system stops
   warning and matches the DOM; a looping one keeps warning. */
for (let i = 0; i < 5; i++) {
  warns = [];
  reRender();
  await waitFor(badgeHidden, 120000, 40);
  await waitFor(() => pb['startIds'] !== null, 60000, 200);
  await mountAll();
  const domPages = document.querySelectorAll('#score .score-page').length;
  out.rounds.push({
    round: i,
    domPages,
    ownedPages: pb.pageStarts().length,
    lines: pb.lineStarts().length,
    matches: pb.pageStarts().length === domPages,
    pageBreakWarns: warns.length,
    warnSample: warns[0] ?? '',
    spliceOutcome: r['pageSplicer']?.lastOutcome ?? '',
    deriveReason: pb.lastDeriveReason ?? '',
  });
}

/* Does an EDIT near the break still work correctly (whatever path it takes)? */
warns = [];
model.setCursor(model.getMeasureStartCursor(1, 62), 1);
out.editApplied = model.deleteAtCursor();
reRender();
await waitFor(badgeHidden, 120000, 40);
await mountAll();
out.afterEdit = {
  domPages: document.querySelectorAll('#score .score-page').length,
  ownedPages: pb.pageStarts().length,
  outcome: r['pageSplicer']?.lastOutcome ?? '',
  skip: r['pageSplicer']?.lastSkipReason ?? '',
  pageBreakWarns: warns.length,
};

model.togglePageBreakAt(60);
reRender();
await waitFor(badgeHidden, 120000, 40);
out.converged = out.rounds.length > 1 && out.rounds[out.rounds.length - 1].pageBreakWarns === 0;
out.everMatched = out.rounds.some((x) => x.matches);
console.warn = ow;
return out;
