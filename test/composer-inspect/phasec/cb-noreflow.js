// Conservative-repartition gate (Max's ruling, 2026-08-30): an edit must not
// move a line boundary unless it made a line ILLEGAL, and undo must restore
// the original layout exactly.
//
// For a spread of edit sites: record the partition + every mounted measure's
// geometry, delete a note, re-render, then undo and re-render. Asserts at each
// step that the partition is unchanged and — after the undo — that the
// geometry is bit-identical to the pre-edit render.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const ps = r['pageSplicer'];
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
/* Drive edits + undo through the REAL input path. A direct
 * model.deleteAtCursor() skips withHistory, so nothing reaches the undo stack
 * and the Ctrl+Z below silently no-ops — the probe then "proves" undo doesn't
 * restore anything while actually eating a chord per cycle (artifact hit
 * 2026-08-30; see lessons.md). */
const del = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
const undo = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
const noteCount = () => model.getDoc().querySelectorAll('note').length;

const cases = [];
const runCase = async (name, mi) => {
  const entry = { name, mi };
  await mountAll();
  const before = pb['startIds'].slice();
  const geomBefore = geom();
  const notesBefore = noteCount();
  /* ── the edit (real keystroke → withHistory) ── */
  const cur = model.getFirstVisualCursorInMeasure(1, mi, 'overwrite');
  model.setCursor(cur >= 0 ? cur : model.getMeasureStartCursor(1, mi), 1);
  const t0 = performance.now();
  del();
  await waitFor(badgeHidden);
  entry.editOk = noteCount() < notesBefore;
  entry.editMs = Math.round(performance.now() - t0);
  entry.editOutcome = ps.lastOutcome;
  entry.editSkip = ps.lastSkipReason;
  entry.movedLines = pb.lastRefillLines;
  const mid = pb['startIds'].slice();
  entry.partitionHeldOnEdit = mid.join() === before.join();
  /* ── the undo ── */
  undo();
  await waitFor(badgeHidden);
  await sleep(60);
  await mountAll();
  entry.undoRestoredContent = noteCount() === notesBefore;
  const after = pb['startIds'].slice();
  entry.partitionHeldOnUndo = after.join() === before.join();
  entry.undoOutcome = ps.lastOutcome;
  entry.geomAfterUndo = diffGeom(geomBefore, geom());
  cases.push(entry);
};

const startIds0 = pb['startIds'].slice();
const ids0 = model.allMeasures().map((m) => m.getAttribute('xml:id'));
const idIdx0 = new Map(ids0.map((id, i) => [id, i]));
await runCase('mid-line-100', 100);
await runCase('line-start-30', idIdx0.get(startIds0[30]));
await runCase('mid-doc-250', 250);
await runCase('near-end', model.allMeasures().length - 3);

out.cases = cases;
out.summary = {
  cases: cases.length,
  undoRestoredContent: cases.filter((c) => c.undoRestoredContent).length,
  partitionHeldOnEdit: cases.filter((c) => c.partitionHeldOnEdit).length,
  partitionHeldOnUndo: cases.filter((c) => c.partitionHeldOnUndo).length,
  undoGeometryExact: cases.filter((c) => c.geomAfterUndo.changed === 0).length,
  spliced: cases.filter((c) => c.editOutcome === 'spliced').length,
  editMs: cases.map((c) => c.editMs),
};
console.error = oe;
return out;
