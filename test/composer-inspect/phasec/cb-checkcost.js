// Attribute HKL_INDEX_CHECK (test-mode) overhead on a large governed-range
// edit (2026-09-01). Runs the cb-bigrange key case (3 sharps at line 20, a
// 17-line range) once with the flag OFF and once ON, wrapping every flag-gated
// verifier plus the hot cached accessors and the Verovio toolkit with timers.
// Reports per wrapper: call count and INCLUSIVE wall (nested wrappers double
// count — allMeasures inside assertFlatCacheConsistent counts in both).
// This is how the once-per-version cache fix was sized and how the remaining
// test-mode cost is attributed; `--arg "case=meter"` runs the meter case.
const H = window.__hkl_composer; const m = H.model, r = H.renderer, reRender = H.reRender;
const pb = r['pageBreaks'], ps = r['pageSplicer'];
const container = document.getElementById('score');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
const waitFor = async (fn, ms = 120000, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const errs = []; const oe = console.error; console.error = (...a) => { errs.push(a.join(' ').slice(0, 300)); oe(...a); };
await waitFor(() => pb['startIds'] !== null); await waitFor(badgeHidden, 90000, 40);
const sids = () => pb['startIds'];
const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
const pageStarts = () => pb.pageStarts().map((id) => sids().indexOf(id));
const pageOfLine = (li) => { const p = pageStarts(); let n = 1; for (let i = 0; i < p.length; i++) if (p[i] <= li) n = i + 1; return n; };
const scrollToPage = async (p) => { const div = container.querySelector('.score-page[data-page="' + p + '"]'); if (!div) return false; container.scrollTop = Math.max(0, div.offsetTop - 40); await raf(); await waitFor(() => !div.classList.contains('score-page-pending'), 15000, 40); return true; };
const ARG = window.__probeArg || '';
/* find the Verovio toolkit wherever the renderer keeps it */
let tk = null; for (const k of Object.keys(r)) { const v = r[k]; if (v && typeof v === 'object' && typeof v.loadData === 'function' && typeof v.renderToSVG === 'function') { tk = v; break; } }
const stats = {};
const wrapped = [];
const wrap = (obj, name, label) => {
  if (!obj) return; const o = obj[name]; if (typeof o !== 'function') return;
  const key = label || name;
  obj[name] = function (...a) { const t = performance.now(); try { return o.apply(this, a); } finally { const s = stats[key] ?? (stats[key] = { n: 0, ms: 0 }); s.n++; s.ms += performance.now() - t; } };
  wrapped.push([obj, name, o]);
};
const install = () => {
  for (const n of ['assertVoiceIndexConsistent', 'assertFlatCacheConsistent', 'normalizePlaceholdersAll', 'snapshotStateReusing', 'allMeasures', 'flatChildren', 'voiceIndex', 'documentVersion', 'getTickPositionAtUncached', 'getFlatStopInfoUncached', 'measureBoundaryCursorsUncached', 'getMeasureStartCursorUncached']) wrap(m, n, 'model.' + n);
  for (const n of ['verifyAgainstReference', 'splice', 'trySplice', 'run']) wrap(ps, n, 'splicer.' + n);
  for (const n of ['verifyRenderedPartition', 'tryRefill', 'repartition', 'drainSigDirty']) wrap(pb, n, 'breaks.' + n);
  if (tk) for (const n of ['loadData', 'renderToSVG', 'getMEI', 'setOptions', 'getPageCount', 'redoLayout']) wrap(tk, n, 'tk.' + n);
};
const uninstall = () => { while (wrapped.length) { const [obj, name, o] = wrapped.pop(); obj[name] = o; } };
const runCase = async (check) => {
  const line = ARG.includes('case=meter') ? 12 : 20;
  await scrollToPage(pageOfLine(line));
  const snap = m.snapshotState();
  ps.lastOutcome = ''; ps.lastSkipReason = '';
  for (const k of Object.keys(stats)) delete stats[k];
  install();
  globalThis.__HKL_INDEX_CHECK = check;
  const t0 = performance.now();
  const mi = ids().indexOf(sids()[line]);
  try { if (ARG.includes('case=meter')) m.setMeterAt(mi, 4, 4); else m.setKeySigAt(mi, '3s', 'major'); reRender(); await waitFor(badgeHidden, 180000, 30); } catch (e) { errs.push('threw: ' + String(e).slice(0, 300)); }
  const wallMs = Math.round(performance.now() - t0);
  globalThis.__HKL_INDEX_CHECK = false;
  uninstall();
  const table = Object.entries(stats).map(([k, v]) => ({ name: k, n: v.n, ms: Math.round(v.ms) })).sort((a, b) => b.ms - a.ms);
  const res = { check, wallMs, outcome: ps.lastOutcome, skip: ps.lastSkipReason, errsNow: errs.length, tkFound: !!tk, table };
  m.restoreSnapshot(snap); reRender(); await waitFor(badgeHidden, 180000, 30);
  return res;
};
const out = { errs, off: await runCase(false), on: await runCase(true) };
console.error = oe;
return out;
