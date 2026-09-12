// Page-view lazy-mount scheduling probe (2026-09-11) — the regression check for
// the visible-first mount pump (render.ts pumpMounts / updateMountWindow /
// viewportMoving) and for the balance-complete toolkit warm
// (markPartitionBalanced → armExtentsJob).
//
// Drives the REAL IntersectionObserver by setting #score.scrollTop (never
// mountPage): a one-frame jump, a slow drag, a fast drag, each from a settled
// state. Per run: which pages mounted, in what order, each mount's cost with
// its toolkit-reload share, any loadData during the run, and when the page
// the user landed on was drawn.
//
// Expect (sonata, Chromium): `staleAtStart` empty and `tkCurrentAtStart` true
// (the balance job's stale pages were warmed in idle); a jump mounts the
// VISIBLE page first (~150 ms) and its neighbour later from idle; a drag mounts
// the landing page ~120 ms after it stops, with at most one page mounted
// mid-drag; no loadData during any run. `ok` summarizes. Before the pump a
// jump drew the off-screen neighbour first (~300 ms to the visible page), a
// drag mounted every page it swept through the band (15 mounts / 2.75 s for
// 20→3), and the first mount past page 14 paid a 784 ms reload.
//
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/mount-drag.js
const H = window.__hkl_composer; const r = H.renderer; const pb = r['pageBreaks'];
const score = document.getElementById('score');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const raf = () => new Promise((res) => requestAnimationFrame(() => res()));
const waitFor = async (fn, ms = 60000, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
await waitFor(() => pb['startIds'] !== null, 60000, 200);
await waitFor(() => { const b = document.getElementById('renderBusy'); return (!b || b.hidden) && !pb.balanceJobActive() && r.extentsJobState() === null; }, 60000, 200);
await sleep(500);
const st = r['pageVirt'];
const out = { pageCount: st.pageCount, pageH: st.pageH, viewH: score.clientHeight, tkCurrentAtStart: st.tkCurrent, staleAtStart: [...st.stalePages].sort((a, b) => a - b), mountedAtStart: [...st.mounted].sort((a, b) => a - b) };
const log = [];
const wrap = (obj, name, label, argFn) => { const orig = obj[name]; obj[name] = function (...a) { const t = performance.now(); try { return orig.apply(this, a); } finally { log.push({ label, arg: argFn ? argFn(a) : undefined, ms: +(performance.now() - t).toFixed(1), t: +t.toFixed(0) }); } }; };
const pg = (a) => typeof a[0] === 'number' ? a[0] : (a[0]?.dataset?.page ?? '');
wrap(r, 'mountPage', 'mount', pg); wrap(r, 'unmountPage', 'unmount', pg); wrap(r, 'ensureTkHoldsPageLayout', 'ensureTk', pg);
const tk = r['tk']; wrap(tk, 'renderToSVG', 'svg', (a) => a[0]); wrap(tk, 'loadData', 'loadData');
const pageDiv = (p) => score.querySelector('.score-page[data-page="' + p + '"]');
const isMounted = (p) => { const d = pageDiv(p); return !!d && !d.classList.contains('score-page-pending'); };
const visiblePages = () => { const v = score.getBoundingClientRect(); return [...score.querySelectorAll('.score-page')].filter((d) => { const b = d.getBoundingClientRect(); return b.bottom > v.top && b.top < v.bottom; }).map((d) => +d.dataset.page); };
const forPage = (label, p) => log.filter((e) => e.label === label && String(e.arg) === String(p)).map((e) => e.ms);
async function drag(from, to, frames, label) {
  score.scrollTop = pageDiv(from).offsetTop;
  await sleep(1500);   // settle: pump + mount window done at the start page
  log.length = 0;
  const a = score.scrollTop, b = pageDiv(to).offsetTop - 20;
  const t0 = performance.now();
  for (let i = 1; i <= frames; i++) { score.scrollTop = a + (b - a) * i / frames; await raf(); }
  const tEnd = performance.now();
  const vis = visiblePages();
  await waitFor(() => vis.every(isMounted), 30000, 16);
  const tVis = performance.now();
  let n = -1, quiet = 0; while (quiet < 600) { await sleep(50); if (log.length === n) quiet += 50; else { quiet = 0; n = log.length; } }
  const mounts = log.filter((e) => e.label === 'mount' && e.ms > 0.5);
  const seq = mounts.map((e) => +e.arg);
  return { label, from, to, frames, dragWallMs: Math.round(tEnd - t0), visible: vis,
    visibleMountedAfterMs: Math.round(tVis - t0), visibleFirst: seq.length > 0 && vis.includes(seq[0]),
    mountsCount: mounts.length, mountMsTotal: Math.round(mounts.reduce((s, e) => s + e.ms, 0)),
    mounts: mounts.map((m) => ({ p: +m.arg, ms: m.ms, ensureTk: forPage('ensureTk', m.arg), svg: forPage('svg', m.arg) })),
    loadData: log.filter((e) => e.label === 'loadData').map((e) => e.ms),
    unmounts: log.filter((e) => e.label === 'unmount').length, mountedNow: [...st.mounted].sort((x, y) => x - y) };
}
out.runs = [];
out.runs.push(await drag(1, 15, 1, 'jump 1→15 (1 frame)'));
out.runs.push(await drag(15, 3, 10, 'drag 15→3 in 10 frames'));
out.runs.push(await drag(3, 28, 5, 'fast drag 3→28 in 5 frames'));
out.runs.push(await drag(28, 8, 20, 'drag 28→8 in 20 frames'));
out.runs.push(await drag(8, 20, 1, 'jump 8→20 (1 frame)'));
out.ok = out.staleAtStart.length === 0 && out.tkCurrentAtStart
  && out.runs.every((x) => x.frames > 1 || x.visibleFirst)
  && out.runs.every((x) => x.mountsCount <= 3 && x.loadData.length === 0);
return out;
