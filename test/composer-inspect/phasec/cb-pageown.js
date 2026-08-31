// Phase C-B2 acceptance: pagination ownership live on the sonata.
// Checks, in order:
//  1. adoption records page starts, and the live render is 'encoded' with our
//     <pb> pins honored VERBATIM (every mounted page begins at its pinned line)
//  2. an edit still splices, and pagination is unchanged by it
//  3. the pinned pages FIT (no page draws past its own paper)
//  4. self-consistency: the live DOM equals a fresh full render of the same
//     pinned MEI (system sequence, per-measure geometry, page assignment)
//  5. the pre-existing user-<pb> giant-page quirk: a Ctrl+B page break on a
//     large doc used to paginate ONLY at encoded breaks (2 giant clipped
//     pages). With pagination owned it should stay ~37 normal pages.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const ps = r['pageSplicer'];
const V = window.verovio;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 50) => {
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
const lb = await import('/composer/src/render/linebreaks.ts');

const mountAll = async () => {
  for (const page of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) {
    r['mountPage'](+page.dataset.page);
  }
  await sleep(40);
};
const pageFirstIds = () => {
  const rows = [];
  for (const pageEl of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
    const m = pageEl.querySelector('g.system g.measure');
    rows.push({ page: +pageEl.dataset.page, firstId: m ? m.id : null });
  }
  return rows;
};
const overflowing = () => {
  const bad = [];
  for (const pageEl of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
    const svg = pageEl.querySelector('svg');
    const sys = [...pageEl.querySelectorAll('g.system')];
    if (!svg || !sys.length) continue;
    const box = svg.getBoundingClientRect();
    const last = sys[sys.length - 1].getBoundingClientRect();
    if (last.bottom > box.bottom + 2) bad.push({ page: +pageEl.dataset.page, over: +(last.bottom - box.bottom).toFixed(1) });
  }
  return bad;
};

/* 1. ownership state */
out.paginationOwned = pb.paginationOwned();
out.pages = document.querySelectorAll('#score .score-page').length;
out.pageStarts = pb.pageStarts().length;
out.lines = pb['startIds'].length;

/* Force the owned ('encoded') path once so the live DOM is a pinned render. */
model.setCursor(model.getFirstVisualCursorInMeasure(1, 100, 'overwrite'), 1);
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
await waitFor(badgeHidden);
out.firstEdit = { outcome: ps.lastOutcome, skip: ps.lastSkipReason, movedLines: pb.lastRefillLines };
await mountAll();

/* 2/3. pins honored + pages fit */
const starts = pb.pageStarts();
const rows = pageFirstIds();
out.pageStartsHonored = rows.every((row) => row.firstId === starts[row.page - 1]);
out.pageStartMismatch = rows.filter((row) => row.firstId !== starts[row.page - 1]).slice(0, 3);
out.overflowingPages = overflowing();

/* 4. self-consistency vs a fresh full render of the same pinned MEI */
{
  const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
  const pinned = lb.injectPins(mei, pb['startIds'], new Set(starts));
  const tk = new V.toolkit();
  tk.setOptions({ ...r['buildOptions']('auto'), breaks: 'encoded' });
  if (!tk.loadData(pinned)) { out.selfConsistent = { why: 'reference loadData failed' }; }
  else {
    let cmp = 0, maxD = 0, seqBad = 0, sample = null;
    out.refPages = tk.getPageCount();
    for (const pageEl of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
      const p = +pageEl.dataset.page;
      if (p > tk.getPageCount()) { seqBad++; continue; }
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-99999px;top:0';
      host.innerHTML = tk.renderToSVG(p, {});
      document.body.appendChild(host);
      try {
        const refSys = [...host.querySelectorAll('g.system')];
        const liveSys = [...pageEl.querySelectorAll('g.system')];
        if (refSys.length !== liveSys.length) { seqBad++; continue; }
        for (let i = 0; i < refSys.length; i++) {
          const rm = [...refSys[i].querySelectorAll('g.measure')];
          const lm = [...liveSys[i].querySelectorAll('g.measure')];
          if (rm.length !== lm.length || rm.some((m, j) => m.id !== lm[j].id)) { seqBad++; break; }
          const r0 = rm[0].getBBox(), l0 = lm[0].getBBox();
          for (let j = 0; j < rm.length; j++) {
            const a = rm[j].getBBox(), b = lm[j].getBBox();
            const d = Math.max(Math.abs((a.x - r0.x) - (b.x - l0.x)), Math.abs(a.width - b.width));
            cmp++;
            if (d > maxD) { maxD = d; sample = rm[j].id + ' d=' + d.toFixed(1); }
          }
        }
      } finally { host.remove(); }
    }
    out.selfConsistent = { compared: cmp, systemSeqMismatches: seqBad, maxGeomDelta: +maxD.toFixed(1), sample };
  }
}

/* 5. the user-<pb> giant-page quirk */
{
  const before = document.querySelectorAll('#score .score-page').length;
  const ok = model.togglePageBreakAt(60);
  reRender();
  await waitFor(badgeHidden);
  await sleep(200);
  const after = document.querySelectorAll('#score .score-page').length;
  /* undo the toggle so the doc is left as found */
  model.togglePageBreakAt(60);
  reRender();
  await waitFor(badgeHidden);
  out.userPageBreak = { toggled: ok, pagesBefore: before, pagesAfter: after, restored: document.querySelectorAll('#score .score-page').length };
}

console.warn = ow;
return out;
