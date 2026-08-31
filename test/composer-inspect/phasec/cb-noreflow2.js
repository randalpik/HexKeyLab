// Follow-up to cb-noreflow: is the delete+undo geometry residual a ONE-TIME
// transition (the adoption render is Verovio's own castoff/justification; every
// later render is our pinned breaks:'line' one) or does it recur per cycle?
//
// Runs TWO identical delete+undo cycles at one site and reports, for each:
//   - partition held?
//   - geometry diff vs the state before THAT cycle
//   - after the cycle, the live DOM vs a fresh full pinned render (reference)
// Cycle 2 exact ⇒ steady state is bit-stable and the residual is the one-time
// adoption→pinned justification shift.
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
const errs = [];
const oe = console.error; console.error = (...a) => { errs.push(a.join(' ').slice(0, 200)); oe(...a); };
const out = { errs };
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;
const lb = await import('/composer/src/render/linebreaks.ts');

const mountAll = async () => {
  for (const page of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) {
    r['mountPage'](+page.dataset.page);
  }
  await sleep(30);
};
const geom = () => {
  const m = new Map();
  for (const el of document.querySelectorAll('#score .score-page:not(.score-page-pending) g.measure')) {
    const b = el.getBBox();
    m.set(el.id, [+b.x.toFixed(2), +b.width.toFixed(2)]);
  }
  return m;
};
const diffGeom = (a, b) => {
  let n = 0, maxD = 0, sample = null;
  for (const [id, va] of a) {
    const vb = b.get(id);
    if (!vb) { n++; if (!sample) sample = id + ' vanished'; continue; }
    const d = Math.max(Math.abs(va[0] - vb[0]), Math.abs(va[1] - vb[1]));
    if (d > 0.01) { n++; maxD = Math.max(maxD, d); if (!sample) sample = id + ' ' + JSON.stringify(va) + '→' + JSON.stringify(vb); }
  }
  return { changed: n, maxD: +maxD.toFixed(2), sample };
};
/* Live DOM vs a fresh full render of the same pinned MEI (per-measure, within
 * each system's local frame — absolute x differs by page/system placement). */
const tkRef = new V.toolkit();
const referenceDiff = () => {
  const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
  const pinned = lb.injectPins(mei, pb['startIds'], null);
  if (!pinned) return { why: 'pin injection failed' };
  tkRef.setOptions({ ...r['buildOptions']('auto'), breaks: 'line' });
  if (!tkRef.loadData(pinned)) return { why: 'reference loadData failed' };
  let changed = 0, maxD = 0, compared = 0, sample = null;
  for (const pageEl of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
    const pno = +pageEl.dataset.page;
    if (pno > tkRef.getPageCount()) return { why: 'page ' + pno + ' beyond reference' };
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0';
    host.innerHTML = tkRef.renderToSVG(pno, {});
    document.body.appendChild(host);
    try {
      for (const el of host.querySelectorAll('g.measure')) {
        const live = pageEl.querySelector('#' + CSS.escape(el.id));
        if (!live) continue;
        const a = el.getBBox(), b = live.getBBox();
        compared++;
        const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.width - b.width));
        if (d > 0.5) { changed++; maxD = Math.max(maxD, d); if (!sample) sample = el.id + ' ref' + JSON.stringify([+a.x.toFixed(1), +a.width.toFixed(1)]) + ' live' + JSON.stringify([+b.x.toFixed(1), +b.width.toFixed(1)]); }
      }
    } finally { host.remove(); }
  }
  return { compared, changed, maxD: +maxD.toFixed(2), sample };
};
const undo = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));

const MI = 100;
const cycles = [];
for (let c = 1; c <= 2; c++) {
  await mountAll();
  const before = pb['startIds'].slice();
  const geomBefore = geom();
  model.setCursor(model.getMeasureStartCursor(1, MI), 1);
  const okEdit = model.deleteAtCursor() !== false;
  reRender();
  await waitFor(badgeHidden);
  const midOutcome = ps.lastOutcome;
  const geomMid = geom();
  undo();
  await waitFor(badgeHidden);
  await sleep(60);
  await mountAll();
  cycles.push({
    cycle: c, okEdit,
    editOutcome: midOutcome, undoOutcome: ps.lastOutcome,
    movedLines: pb.lastRefillLines,
    partitionHeld: pb['startIds'].join() === before.join(),
    geomDuringEdit: diffGeom(geomBefore, geomMid),
    geomAfterUndo: diffGeom(geomBefore, geom()),
    referenceAfterUndo: referenceDiff(),
  });
}
out.cycles = cycles;
console.error = oe;
return out;
