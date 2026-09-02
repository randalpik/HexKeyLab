// Large governed ranges on the sonata (2026-09-01, after the size caps were
// dropped): a key change far from any later key change, a staff-1 clef change
// far from the next clef, and a width-neutral meter change — each followed by
// its UNDO (restoreSnapshot), which is a large-range edit too. Reports per case:
// outcome, replaced run, window size, wall, edit/refill split, refill stats
// (naturals window ms + measures), and the same for the restore.
//   --arg "check=1"  runs under HKL_INDEX_CHECK (the reference gate verifies
//                    the spliced pages; ~2–3 s over production per case since
//                    2026-09-01 — it was ~40 s while the caches re-verified
//                    on every hit and locateCursor re-enumerated the document
//                    per stop; cb-checkcost.js attributes test-mode cost)
// Pre-caps every case refused on `too many changed lines`; now 17 / 7 / 25
// lines splice in 1.18 / 0.44 / 1.32 s, reference-clean. The A-thread targets
// it exposes: the naturals window (~5.5 ms/measure) and the window loadData
// (~5 ms/measure).
// Large governed ranges on the sonata, with the line caps dropped: a key change
// far from any later key change, and a staff-1 clef change far from the next
// clef. Reports outcome, run, window size, wall, reference-gate errors.
const H = window.__hkl_composer; const m = H.model, r = H.renderer, reRender = H.reRender;
const pb = r['pageBreaks'], ps = r['pageSplicer'];
const container = document.getElementById('score');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
const waitFor = async (fn, ms = 120000, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const errs = []; const oe = console.error; console.error = (...a) => { errs.push(a.join(' ').slice(0, 300)); oe(...a); };
const out = { errs, cases: [] };
await waitFor(() => pb['startIds'] !== null); await waitFor(badgeHidden, 90000, 40);
const sids = () => pb['startIds'];
const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
const lineOfMi = (mi) => { const s = sids(), i = ids(); let li = 0; for (let k = 0; k < s.length; k++) if (i.indexOf(s[k]) <= mi) li = k; return li; };
const pageStarts = () => pb.pageStarts().map((id) => sids().indexOf(id));
const pageOfLine = (li) => { const p = pageStarts(); let n = 1; for (let i = 0; i < p.length; i++) if (p[i] <= li) n = i + 1; return n; };
const scrollToPage = async (p) => { const div = container.querySelector('.score-page[data-page="' + p + '"]'); if (!div) return false; container.scrollTop = Math.max(0, div.offsetTop - 40); await raf(); await waitFor(() => !div.classList.contains('score-page-pending'), 15000, 40); return true; };
const CHECK = (window.__probeArg || '').includes('check=1');
const runCase = async (name, edit, line) => {
  await scrollToPage(pageOfLine(line));
  const snap = m.snapshotState();
  ps.lastOutcome = ''; ps.lastRun = null; ps.lastSkipReason = ''; ps.lastWindow = null;
  const ver = m.docVersion();
  globalThis.__HKL_INDEX_CHECK = CHECK;
  const t0 = performance.now();
  let tEdit = 0, tRefill = 0;
  const origRefill = pb.tryRefill.bind(pb); pb.tryRefill = (...a) => { const t = performance.now(); const r0 = origRefill(...a); tRefill += performance.now() - t; return r0; };
  try { edit(); tEdit = performance.now() - t0; reRender(); await waitFor(badgeHidden, 120000, 30); } catch (e) { out.cases.push({ name, threw: String(e).slice(0, 300) }); }
  pb.tryRefill = origRefill;
  globalThis.__HKL_INDEX_CHECK = false;
  const c = { name, line, check: CHECK, changed: m.docVersion() !== ver, wallMs: Math.round(performance.now() - t0), editMs: Math.round(tEdit), refillMs: Math.round(tRefill), refillStats: pb.lastRefillStats, lastFullMs: r['lastFullMs'], outcome: ps.lastOutcome, skip: ps.lastSkipReason, derive: pb.lastDeriveReason, refillLines: pb.lastRefillLines, run: ps.lastRun, window: ps.lastWindow && { lines: ps.lastWindow.wHi - ps.lastWindow.wLo + 1, measures: ps.lastWindow.mHi - ps.lastWindow.mLo + 1 }, stats: ps.lastStats, errsNow: errs.length };
  out.cases.push(c);
  /* the UNDO of the change is a large-range edit too — report its path */
  ps.lastOutcome = ''; ps.lastRun = null; ps.lastSkipReason = ''; pb.lastDeriveReason = '';
  const t1 = performance.now();
  m.restoreSnapshot(snap); reRender(); await waitFor(badgeHidden, 120000, 30);
  c.restore = { wallMs: Math.round(performance.now() - t1), outcome: ps.lastOutcome, skip: ps.lastSkipReason, derive: pb.lastDeriveReason, run: ps.lastRun, refillStats: pb.lastRefillStats };
};
/* key change at line 20 — the next key change on the sonata is movement II (line ~44) or III (57) */
{ const mi = ids().indexOf(sids()[20]); await runCase('key 3s at line 20', () => m.setKeySigAt(mi, '3s', 'major'), 20); }
/* staff-1 clef change at line 8 mid-measure — next staff-1 clef is far */
{ const mi = ids().indexOf(sids()[8]); const flat = m['flatChildren'](1); const f = flat.findIndex((e) => (e.localName === 'note' || e.localName === 'chord') && e.closest('measure') === m.allMeasures()[mi]);
  await runCase('clef F4 at line 8 (staff 1)', () => { m.setClefAtCursor(1, f, 'F', '4', null, null); }, 8); }
/* meter change 2/2 -> 3/2? keep width-neutral: 2/2 -> 4/4 at line 12 (same duration) */
{ const mi = ids().indexOf(sids()[12]); await runCase('meter 4/4 at line 12', () => m.setMeterAt(mi, 4, 4), 12); }
console.error = oe;
return out;
