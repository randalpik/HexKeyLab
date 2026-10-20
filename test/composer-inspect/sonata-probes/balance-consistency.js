// Load ≡ edit partition check (2026-10-19): one delete + undo on a fresh load,
// reporting the line starts and page starts as SETS (by measure index) before
// the edit, after it, and after the undo, plus the balancer's own report and
// whether the undone document is byte-identical to the loaded one.
//
// Written to isolate the bounded-balance defect (decisions.md "Open: the
// bounded section balance…" + addendum): on the sonata, a delete at m. 250
// re-divides movement III from m. 240 on (9 lines → 10) and the undo keeps the
// new partition although the document is restored exactly. A fix is correct
// when `undo.startsDiffVsLoad` and `undo.pagesDiffVsLoad` are empty for every
// edit site — and, stronger, when `edit.startsDiff` only ever contains lines
// on the edit's page or later.
//
//   node test/composer-inspect/sonata-probes/run-probe.mjs \
//     test/composer-inspect/sonata-probes/balance-consistency.js --arg "mi=250"
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null, 60000, 200);
await waitFor(() => !r.assemblyPending(), 120000, 50);
await waitFor(badgeHidden);

const arg = String(window.__probeArg || '');
const MI = Number((arg.match(/mi=(\d+)/) || [])[1] ?? 250);
const ids = () => model.allMeasures().map((m) => m.getAttribute('xml:id'));
const snap = () => ({ starts: pb['startIds'].slice(), pages: [...pb['pageStartIds']] });
const idx = (list) => { const m = new Map(ids().map((id, i) => [id, i])); return list.map((id) => m.get(id)); };
const sectionTitles = () => model.allMeasures().map((m, i) => m.hasAttribute('data-hkl-section-title') ? i : -1).filter((i) => i >= 0);
const diff = (a, b) => {
  const A = new Set(a), B = new Set(b);
  return { removed: idx(a.filter((x) => !B.has(x))), added: idx(b.filter((x) => !A.has(x))) };
};
const lineOf = (startsIdx, mi) => { let k = 0; for (let i = 0; i < startsIdx.length; i++) if (startsIdx[i] <= mi) k = i; return k; };

const out = { mi: MI, sections: sectionTitles() };
const s0 = snap();
const mei0 = model.serialize();
out.load = { lines: s0.starts.length, pages: s0.pages.length, editLine: lineOf(idx(s0.starts), MI) };

const del = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
const undo = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));

const cur = model.getFirstVisualCursorInMeasure(1, MI, 'overwrite');
model.setCursor(cur >= 0 ? cur : model.getMeasureStartCursor(1, MI), 1);
del();
await waitFor(badgeHidden); await sleep(100);
const s1 = snap();
out.edit = {
  outcome: ps.lastOutcome, skip: ps.lastSkipReason, refillLinesIndexwise: pb.lastRefillLines,
  balance: pb.lastBalance, lines: s1.starts.length, pages: s1.pages.length,
  startsDiff: diff(s0.starts, s1.starts), pagesDiff: diff(s0.pages, s1.pages),
};
undo();
await waitFor(badgeHidden); await sleep(200);
const s2 = snap();
const mei2 = model.serialize();
out.undo = {
  outcome: ps.lastOutcome, skip: ps.lastSkipReason, refillLinesIndexwise: pb.lastRefillLines,
  balance: pb.lastBalance, lines: s2.starts.length, pages: s2.pages.length,
  meiIdentical: mei0 === mei2, meiLen: [mei0.length, mei2.length],
  startsDiffVsLoad: diff(s0.starts, s2.starts), pagesDiffVsLoad: diff(s0.pages, s2.pages),
  startsDiffVsEdit: diff(s1.starts, s2.starts),
};
if (!out.undo.meiIdentical) {
  let i = 0; while (i < mei0.length && mei0[i] === mei2[i]) i++;
  out.undo.meiFirstDiff = { at: i, load: mei0.slice(Math.max(0, i - 80), i + 80), undo: mei2.slice(Math.max(0, i - 80), i + 80) };
}
/* Load's starts as measure indices around the edit, for reading the diffs. */
const st0 = idx(s0.starts), st1 = idx(s1.starts), st2 = idx(s2.starts);
const k0 = out.load.editLine;
out.startsAroundEdit = { load: st0.slice(Math.max(0, k0 - 6), k0 + 8), edit: st1.slice(Math.max(0, k0 - 6), k0 + 8), undo: st2.slice(Math.max(0, k0 - 6), k0 + 8) };
out.pageStartLines = { load: idx(s0.pages), edit: idx(s1.pages), undo: idx(s2.pages) };
return out;
