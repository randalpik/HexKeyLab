// Mirror of the composer-test fixture `pageKeyChangeSplicesGovernedRange`
// (2026-09-01), printing every input the refill's legality decisions depend on
// — sigW, budgetW, per-line natural sums and fills — before and after the key
// change, plus the partition before/after and the splicer's run. Exists because
// the fixture failed twice in full-suite order (`editLine=-1`: the pre-edit
// line-2 start no longer starts a line) while passing 6/6 in isolation, and the
// runner prints assertion detail only on failure. Run with --no-sonata.
const H = window.__hkl_composer; const m = H.model, r = H.renderer;
const pb = r['pageBreaks'], ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 60000, step = 10) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
m.setCursor(0, 1);
for (let i = 0; i < 160; i++) { const high = (Math.floor(i / 4) % 2) === 0; m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 }); }
H.reRender(); await waitFor(badgeHidden); await waitFor(() => pb['startIds'] !== null); await sleep(400);
const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
const lineFills = (starts, idList) => {
  const nat = pb['naturals']; const sigW = pb['sigW']; const budget = pb['budgetW'];
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const from = idList.indexOf(starts[k]); const to = k + 1 < starts.length ? idList.indexOf(starts[k + 1]) : idList.length;
    let sum = 0, missing = 0; const per = [];
    for (let i = from; i < to; i++) { const w = nat.get(idList[i]); if (w == null) missing++; else { sum += w; per.push(Math.round(w)); } }
    out.push({ line: k, measures: to - from, from, sumNat: Math.round(sum), missing, fill: budget ? +((sigW + sum) / budget).toFixed(4) : null, per });
  }
  return out;
};
const before = { starts: pb['startIds'].slice(), sigW: pb['sigW'], budgetW: pb['budgetW'], naturalsCached: pb['naturals'].size, mounted: document.querySelectorAll('#score .score-page:not(.score-page-pending)').length, pages: document.querySelectorAll('#score .score-page').length, zoom: r['zoom'] };
const idsB = ids(); const editMi = idsB.indexOf(before.starts[2]); const resetMi = idsB.indexOf(before.starts[5]);
/* the fixture sets a LATER key change first (the "reset") at line 5, then the edit at line 2 */
ps.lastOutcome = ''; ps.lastRun = null; ps.lastSkipReason = '';
m.setKeySigAt(resetMi, '2f', 'major'); H.reRender(); await waitFor(badgeHidden); await sleep(300);
const afterReset = { starts: pb['startIds'].slice(), sigW: pb['sigW'], budgetW: pb['budgetW'], outcome: ps.lastOutcome, run: ps.lastRun, fills: lineFills(pb['startIds'], ids()) };
ps.lastOutcome = ''; ps.lastRun = null; ps.lastSkipReason = ''; pb.lastDeriveReason = '';
const prev = globalThis.__HKL_INDEX_CHECK; globalThis.__HKL_INDEX_CHECK = true;
m.setKeySigAt(editMi, '3s', 'major');
try { H.reRender(); await waitFor(badgeHidden); } finally { globalThis.__HKL_INDEX_CHECK = prev; }
await sleep(300);
const idsA = ids(); const startsA = pb['startIds'].slice();
const after = { starts: startsA, editLine: startsA.indexOf(idsA[editMi]), resetLine: startsA.indexOf(idsA[resetMi]), outcome: ps.lastOutcome, skip: ps.lastSkipReason, derive: pb.lastDeriveReason, refillLines: pb.lastRefillLines, run: ps.lastRun, sigW: pb['sigW'], budgetW: pb['budgetW'], refillStats: pb.lastRefillStats, fills: lineFills(startsA, idsA), mounted: document.querySelectorAll('#score .score-page:not(.score-page-pending)').length };
return { editMi, resetMi, before, afterReset, after, movedBoundaries: before.starts.map((s, i) => s !== startsA[i] ? i : -1).filter((i) => i >= 0) };
