// Splice COVERAGE sweep under realistic lazy mounting, plus viewport stability.
//
// Why this exists (Max, 2026-08-31): "many entire systems refuse any steady-state
// splice, and any deletion moves the screen down a few px". cb-splice-battery.js
// could observe NEITHER symptom:
//   1. it calls mountAll() before every edit, so it has never exercised an
//      unmounted page — the B5 refusals (`changed line not mounted`, `context
//      line above not mounted`) are structurally invisible to it, and its
//      latency numbers are measured with all 30 pages mounted;
//   2. it is 8 hand-picked edits, so it reports "7/8" where the real question is
//      a per-line hit RATE and a ranked list of refusal causes;
//   3. its reference compare is entirely page-INTERNAL (per-measure x/width,
//      spacing, staff tops, all page-margin relative), so a page whose box grows
//      a few px leaves every delta at 0.0 and still shoves the viewport.
//
// This probe walks the document line by line, scrolls each line into view the
// way a user does (container.scrollTop + the real IntersectionObserver — it
// NEVER calls mountPage), edits, and records the outcome, the skip reason, the
// wall time, how many pages were mounted at the time, and whether anything the
// reader was looking at moved.
//
// Each line is measured against the SAME baseline document: the edit is undone
// before moving on, so one line's reflow cannot pollute the next line's verdict.
//
// Args (--arg "stride=4,limit=20,undo=0"): stride skips lines, limit caps the
// number measured, undo=0 lets deletions accumulate instead.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const ps = r['pageSplicer'];
const container = document.getElementById('score');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
const waitFor = async (fn, ms = 60000, step = 50) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.join(' ').slice(0, 160)); ow(...a); };
/* `--arg check=1` turns the reference GATE on for the sweep. Without it the
   sweep verifies coverage and viewport stability but never compares a spliced
   page against a full re-engrave — 115 positions going unchecked, which is a
   coverage gap that hid behind "errs: 0" (2026-09-04). With it, every render
   is gated and a divergence lands in `errs` as a render error. */
if (String(window.__probeArg || '').includes('check=1')) globalThis.__HKL_INDEX_CHECK = true;
const errs = []; const oe = console.error; console.error = (...a) => { errs.push(a.join(' ').slice(0, 160)); oe(...a); };

const args = {};
for (const kv of String(window.__probeArg ?? '').split(',')) {
  const [k, v] = kv.split('=');
  if (k) args[k.trim()] = v === undefined ? '1' : v.trim();
}
const STRIDE = Math.max(1, Number(args.stride ?? 1));
const LIMIT = Number(args.limit ?? 0) || Infinity;
/* `from=` + `limit=` chunk a run under the runner's 300 s eval cap — the same
   convention cb-courtesystub.js uses. Needed for `check=1`, where the
   reference gate makes a full 115-position pass far too slow for one eval. */
const FROM = Math.max(1, Number(args.from ?? 1));
const UNDO = args.undo !== '0';

const out = { warns, errs, stride: STRIDE, from: FROM, undo: UNDO, rows: [] };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.warn = ow; console.error = oe; return out; }
await waitFor(badgeHidden, 60000, 40);

const mountedCount = () =>
  container.querySelectorAll('.score-page:not(.score-page-pending)').length;
const pageCount = () => container.querySelectorAll('.score-page').length;

/* Which page a line index lives on, from the owner's own page starts. */
const startIds = () => pb['startIds'];
const pageStartLineIdxs = () => {
  const ids = startIds();
  const pos = new Map(ids.map((id, i) => [id, i]));
  return pb.pageStarts().map((id) => pos.get(id)).filter((i) => i != null);
};

/* Document-space top of an element (render.ts uses this same formula), so a
   shift is unambiguous whether it came from scrollTop or from layout. */
const docTop = (el) => {
  if (!el) return null;
  const cr = container.getBoundingClientRect();
  return +(el.getBoundingClientRect().top - cr.top + container.scrollTop).toFixed(2);
};
const viewTop = (el) => (el ? +el.getBoundingClientRect().top.toFixed(2) : null);

/* Everything that decides where the reader's eye lands. */
const viewportState = (anchorIds) => {
  const pages = [];
  for (const pageEl of container.querySelectorAll('.score-page:not(.score-page-pending)')) {
    const svg = pageEl.querySelector('svg');
    pages.push({
      page: +pageEl.dataset.page,
      offsetTop: pageEl.offsetTop,
      offsetHeight: pageEl.offsetHeight,
      svgHeight: svg ? svg.getAttribute('height') : null,
      viewBox: svg ? svg.getAttribute('viewBox') : null,
    });
  }
  const anchors = {};
  for (const [k, id] of Object.entries(anchorIds)) {
    const el = id ? document.getElementById(id) : null;
    anchors[k] = el ? { docTop: docTop(el), viewTop: viewTop(el) } : null;
  }
  return {
    scrollTop: +container.scrollTop.toFixed(2),
    scrollHeight: container.scrollHeight,
    mounted: mountedCount(),
    pages, anchors,
  };
};

/* Scroll a page into view and let the REAL IntersectionObserver mount it. */
const scrollToPage = async (p) => {
  const div = container.querySelector('.score-page[data-page="' + p + '"]');
  if (!div) return false;
  container.scrollTop = Math.max(0, div.offsetTop - 40);
  await raf();
  await waitFor(() => !div.classList.contains('score-page-pending'), 8000, 40);
  await raf();
  return !div.classList.contains('score-page-pending');
};

const ids0 = () => model.allMeasures().map((x) => x.getAttribute('xml:id'));
const nLines = startIds().length;
out.lines = nLines;
out.pages = pageCount();

let measured = 0;
for (let li = FROM; li < nLines && measured < LIMIT; li += STRIDE) {
  const sids = startIds();
  if (li >= sids.length) break;
  const pageStarts = pageStartLineIdxs();
  let page = 1;
  for (let i = 0; i < pageStarts.length; i++) if (pageStarts[i] <= li) page = i + 1;
  const row = { line: li, page };

  const okScroll = await scrollToPage(page);
  row.pageMounted = okScroll;
  if (!okScroll) { out.rows.push(row); measured++; continue; }

  const ids = ids0();
  const mi0 = ids.indexOf(sids[li]);
  if (mi0 < 0) { row.why = 'line start not in model'; out.rows.push(row); measured++; continue; }
  const lineEnd = li + 1 < sids.length ? ids.indexOf(sids[li + 1]) : ids.length;
  /* Target the first real NOTE/CHORD on the line, in whichever voice has one.
     Cursoring to a measure start (the old rule) can land on a measure or tuplet
     placeholder, where a delete is a cursor move BY DESIGN (Max, 2026-09-01):
     it performs the requested action and changes nothing, so that line measured
     nothing and still counted against the hit rate. On the sonata this hit 8 of
     115 lines — 5 because voice 1 there holds only a placeholder mRest, the
     music being in other staves, and the rest because the cursor landed on a
     rest or a tuplet boundary.
     Measures after the line's first are preferred, mirroring the battery's
     `delete-mid-line`; the first measure is the fallback for short lines. */
  const findTarget = () => {
    const measures = model.allMeasures();
    const order = [];
    for (let k = mi0 + 1; k < lineEnd; k++) order.push(k);
    order.push(mi0);
    const rank = new Map(order.map((k, i) => [measures[k], i]));
    let best = null;
    for (const voice of [1, 2, 3, 4]) {
      let flat;
      try { flat = model['flatChildren'](voice); } catch { continue; }
      for (let i = 0; i < flat.length; i++) {
        const el = flat[i];
        if (el.localName !== 'note' && el.localName !== 'chord') continue;
        const meas = el.closest('measure');
        const r0 = rank.get(meas);
        if (r0 === undefined) continue;
        if (!best || r0 < best.rank) best = { rank: r0, voice, cursor: i, measureIdx: measures.indexOf(meas) };
        /* Do NOT stop at the first in-line hit. It is the earliest in DOCUMENT
           order, which is the WORST rank when it lands in the line's first
           measure — and that is the common case, so breaking here silently
           retargeted every line onto its first measure and made the mid-line
           preference dead code. Keep scanning; rank 0 is as good as it gets. */
        if (best.rank === 0) break;
      }
    }
    return best;
  };
  const target = findTarget();
  if (!target) { row.why = 'no note or chord anywhere on this line'; out.rows.push(row); measured++; continue; }
  const mi = target.measureIdx;
  row.measureIdx = mi;
  row.voice = target.voice;

  /* Anchors: the page's first line (above the edit), the edited line itself,
     and the first line of the next mounted page. */
  const pageFirstLine = pageStarts[page - 1] ?? 0;
  const nextPageLine = pageStarts[page] ?? null;
  const anchorIds = {
    pageTop: sids[pageFirstLine],
    target: sids[li],
    nextPage: nextPageLine != null ? sids[nextPageLine] : null,
  };
  /* Park the cursor and let the mount window settle BEFORE timing — a user
     positions the cursor, then types. The app schedules this on every cursor
     update (main.ts); the probe drives the model directly, so it must ask.
     Everything the next edit needs should already be mounted by the time the
     stopwatch starts. */
  model.setCursor(target.cursor, target.voice);
  r.scheduleMountWindow(mi);
  await waitFor(() => r['mountWindowHandle'] === null, 3000, 20);
  await raf();

  const before = viewportState(anchorIds);
  row.mountedAtEdit = before.mounted;
  row.mountedPages = [...container.querySelectorAll('.score-page:not(.score-page-pending)')].map((e) => +e.dataset.page);
  const ver0 = model.docVersion();

  /* Same restore path undo uses (history.ts drives restoreSnapshot); the
     probe edits the model directly, which bypasses the history stack. */
  const snap = UNDO ? model.snapshotState() : null;
  const t0 = performance.now();
  const edited = model.deleteAtCursor();
  /* Under `check=1` the reference gate THROWS on a divergence. Catch it per
     position and keep going: a survey that stops at the first failure reports
     one page and hides the distribution (2026-09-04). */
  try { reRender(); } catch (e) { row.gate = String(e && e.message || e).slice(0, 300); }
  await waitFor(badgeHidden, 60000, 30);
  row.wallMs = Math.round(performance.now() - t0);
  /* "Returned truthy" is not proof an edit landed — that exact hole let two
     battery edits silently no-op for months. Assert the document changed. */
  row.editOk = model.docVersion() !== ver0;
  row.editReturn = edited !== false && edited !== null;
  row.outcome = ps.lastOutcome;
  /* Phase 2: how the overflow cascade landed (transplant / arithmetic / park / created). */
  row.cascade = r.lastCascade ? { ...r.lastCascade } : null;
  row.skipReason = ps.lastSkipReason;
  row.refillLines = pb.lastRefillLines;
  row.spliceLines = ps.lastStats.lines;
  row.windowLines = ps.lastStats.windowLines;
  row.plan = ps.lastVertical ? { static: ps.lastVertical.static, dy: +ps.lastVertical.dyFollow.toFixed(1) } : null;
  /* Which lines the splice wanted, and whether their pages were mounted —
     the evidence that separates a B5 mount miss from a genuine divergence. */
  if (ps.lastRun) {
    const psl = pageStartLineIdxs();
    const pageOfLine = (x) => { let p = 1; for (let i = 0; i < psl.length; i++) if (psl[i] <= x) p = i + 1; return p; };
    const want = [];
    for (let k = Math.max(0, ps.lastRun.a - 1); k <= Math.min(nLines - 1, ps.lastRun.b + 1); k++) want.push(k);
    row.run = { a: ps.lastRun.a, b: ps.lastRun.b };
    row.runPages = [...new Set(want.map(pageOfLine))];
    row.runPagesMounted = row.runPages.every((p) => row.mountedPages.includes(p));
  }

  const after = viewportState(anchorIds);
  row.scrollTopDelta = +(after.scrollTop - before.scrollTop).toFixed(2);
  row.scrollHeightDelta = after.scrollHeight - before.scrollHeight;
  row.mountedDelta = after.mounted - before.mounted;
  row.drift = {};
  for (const k of Object.keys(anchorIds)) {
    const b = before.anchors[k], a = after.anchors[k];
    row.drift[k] = (b && a) ? { doc: +(a.docTop - b.docTop).toFixed(2), view: +(a.viewTop - b.viewTop).toFixed(2) } : null;
  }
  /* Did the page BOX change? That is invisible to every page-internal check. */
  row.pageBox = (() => {
    const bp = new Map(before.pages.map((p) => [p.page, p]));
    const changed = [];
    for (const p of after.pages) {
      const q = bp.get(p.page);
      if (!q) continue;
      if (q.offsetHeight !== p.offsetHeight || q.svgHeight !== p.svgHeight || q.viewBox !== p.viewBox) {
        changed.push({ page: p.page, h: [q.offsetHeight, p.offsetHeight], svgH: [q.svgHeight, p.svgHeight],
                       vb: q.viewBox === p.viewBox ? 'same' : [q.viewBox, p.viewBox] });
      }
    }
    return changed;
  })();

  if (snap && row.editOk) {
    model.restoreSnapshot(snap);
    try { reRender(); } catch (e) { row.gateRestore = String(e && e.message || e).slice(0, 200); }
    await waitFor(badgeHidden, 60000, 30);
  }
  out.rows.push(row);
  measured++;
}

/* ── summary: the two numbers that were missing ── */
const rows = out.rows.filter((x) => x.outcome);
const hist = {};
for (const x of rows) {
  const key = x.outcome === 'spliced' ? 'spliced' : (x.skipReason || x.outcome || 'unknown');
  hist[key] = (hist[key] ?? 0) + 1;
}
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const spliceMs = rows.filter((x) => x.outcome === 'spliced').map((x) => x.wallMs);
const fullMs = rows.filter((x) => x.outcome !== 'spliced').map((x) => x.wallMs);
const drifted = rows.filter((x) => x.drift.pageTop && Math.abs(x.drift.pageTop.doc) > 0.5);
out.summary = {
  measured: rows.length,
  spliced: rows.filter((x) => x.outcome === 'spliced').length,
  hitRate: rows.length ? +(rows.filter((x) => x.outcome === 'spliced').length / rows.length).toFixed(3) : null,
  skipReasons: Object.fromEntries(Object.entries(hist).sort((a, b) => b[1] - a[1])),
  editsNotApplied: rows.filter((x) => !x.editOk).length,
  editsNotAppliedLines: rows.filter((x) => !x.editOk).map((x) => x.line),
  noTarget: out.rows.filter((x) => x.why).length,
  voicesUsed: [...new Set(rows.map((x) => x.voice))].sort(),
  /* Refusals whose needed lines all sat on MOUNTED pages — i.e. not B5. */
  refusalsWithPagesMounted: rows.filter((x) => x.outcome === 'skipped' && x.runPagesMounted === true).length,
  refusalsMissingPages: rows.filter((x) => x.outcome === 'skipped' && x.runPagesMounted === false).length,
  mountedAtEdit: { min: Math.min(...rows.map((x) => x.mountedAtEdit)), max: Math.max(...rows.map((x) => x.mountedAtEdit)), median: med(rows.map((x) => x.mountedAtEdit)) },
  spliceMs: { n: spliceMs.length, median: med(spliceMs), min: Math.min(...spliceMs), max: Math.max(...spliceMs) },
  fullMs: { n: fullMs.length, median: med(fullMs), min: fullMs.length ? Math.min(...fullMs) : null, max: fullMs.length ? Math.max(...fullMs) : null },
  /* Viewport stability — a steady-state edit must move nothing. */
  driftedRows: drifted.length,
  driftPageTopDoc: rows.map((x) => x.drift.pageTop ? x.drift.pageTop.doc : null).filter((v) => v != null && Math.abs(v) > 0.5).slice(0, 20),
  scrollTopChanged: rows.filter((x) => Math.abs(x.scrollTopDelta) > 0.5).length,
  scrollHeightChanged: rows.filter((x) => x.scrollHeightDelta !== 0).length,
  pageBoxChanged: rows.filter((x) => x.pageBox.length).length,
  /* Phase 2 cascade counters — parked steps must reach 0 once the extents job has run. */
  cascadeSteps: rows.reduce((n, x) => n + (x.cascade?.steps ?? 0), 0),
  cascadeTransplanted: rows.reduce((n, x) => n + (x.cascade?.transplanted ?? 0), 0),
  cascadeArithmetic: rows.reduce((n, x) => n + (x.cascade?.arithmetic ?? 0), 0),
  cascadeCreated: rows.reduce((n, x) => n + (x.cascade?.created ?? 0), 0),
  parkedSteps: rows.reduce((n, x) => n + (x.cascade?.parked ?? 0), 0),
};
console.warn = ow; console.error = oe;
return out;
