// The two refusals the design doc calls "not by design": the SCORE-START line
// (line 0) and SECTION-HEADER lines. 15 of the sonata's 34 exhaustive-pass
// refusals, and 2 root-causings rather than 5.
//
// It edits one seed line, reports the splicer's verdict, and then compares the
// resulting live page against a full re-engrave of the same model — the same
// comparison `verifyAgainstReference` makes, but REPORTING deltas instead of
// throwing on the first one, so a refusal or a divergence is legible in one
// run. Optionally it leaves either the live page or the reference page alone in
// #score so `--screenshot` yields two flippable images of the same page.
//
//   --arg "case=line0"                  seed = line 0
//   --arg "case=header,seed=0"          seed = the nth section-header line
//   --arg "case=line,line=57"           seed = an explicit line index
//   ...,check=1                         run the HKL_INDEX_CHECK reference gate
//                                       inline (its throw is caught + reported)
//   ...,shot=live | shot=ref            what to leave in #score for the shot
//   ...,edit=0                          measure the zone without editing
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const ps = r['pageSplicer'];
const V = window.verovio;
const container = document.getElementById('score');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
const waitFor = async (fn, ms = 90000, step = 50) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.join(' ').slice(0, 200)); ow(...a); };
const errs = []; const oe = console.error; console.error = (...a) => { errs.push(a.join(' ').slice(0, 200)); oe(...a); };

const args = {};
for (const kv of String(window.__probeArg ?? '').split(',')) {
  const [k, v] = kv.split('=');
  if (k) args[k.trim()] = v === undefined ? '1' : v.trim();
}
const CASE = args.case ?? 'line0';
const SEED = Number(args.seed ?? 0);
const CHECK = args.check === '1';
const SHOT = args.shot ?? 'none';
const DO_EDIT = args.edit !== '0';

const out = { case: CASE, warns, errs };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.warn = ow; console.error = oe; return out; }
await waitFor(badgeHidden, 90000, 40);

const lb = await import('/composer/src/render/linebreaks.ts');
const heji = { hejiEnabled: model.getHejiEnabled() };
const startIds = () => pb['startIds'];
const ids0 = () => model.allMeasures().map((x) => x.getAttribute('xml:id'));
const spansNow = () => {
  const sids = startIds(), ids = ids0();
  const idIdx = new Map(ids.map((id, i) => [id, i]));
  return sids.map((id, li) => [
    idIdx.get(id), li + 1 < sids.length ? idIdx.get(sids[li + 1]) : ids.length,
  ]);
};
const lineOfMeasure = (spans, mi) => {
  let lo = 0, hi = spans.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (spans[mid][0] <= mi) lo = mid; else hi = mid - 1; }
  return lo;
};
const pageStartLineIdxs = () => {
  const sids = startIds();
  const pos = new Map(sids.map((id, i) => [id, i]));
  return pb.pageStarts().map((id) => pos.get(id)).filter((i) => i != null);
};

/* ── seed selection ── */
const spans = spansNow();
const measures = model.allMeasures();
const headerLines = [];
for (let i = 0; i < measures.length; i++) {
  if (measures[i].hasAttribute('data-hkl-section-title')) {
    headerLines.push({ line: lineOfMeasure(spans, i), measureIdx: i, title: measures[i].getAttribute('data-hkl-section-title') });
  }
}
out.headerLines = headerLines;
out.lines = spans.length;
let LINE;
if (CASE === 'line0') LINE = 0;
else if (CASE === 'header') LINE = headerLines[SEED]?.line;
else LINE = Number(args.line);
if (LINE == null || !(LINE >= 0) || LINE >= spans.length) {
  console.warn = ow; console.error = oe;
  return { ...out, error: 'no seed line for case=' + CASE + ' seed=' + SEED };
}
out.line = LINE;

const psl = pageStartLineIdxs();
const pageOfLine = (x) => { let p = 1; for (let i = 0; i < psl.length; i++) if (psl[i] <= x) p = i + 1; return p; };
const PAGE = pageOfLine(LINE);
out.page = PAGE;

/* Mount the way a reader would: scroll, let the real IntersectionObserver work. */
const scrollToPage = async (p) => {
  const div = container.querySelector('.score-page[data-page="' + p + '"]');
  if (!div) return false;
  container.scrollTop = Math.max(0, div.offsetTop - 40);
  await raf();
  await waitFor(() => !div.classList.contains('score-page-pending'), 15000, 40);
  await raf();
  return !div.classList.contains('score-page-pending');
};
out.pageMounted = await scrollToPage(PAGE);

/* ── target note on the seed line (same rule as cb-sweep.js) ── */
const sids = startIds(), ids = ids0();
const mi0 = ids.indexOf(sids[LINE]);
const lineEnd = LINE + 1 < sids.length ? ids.indexOf(sids[LINE + 1]) : ids.length;
out.lineMeasures = [mi0, lineEnd - 1];
const findTarget = () => {
  const ms = model.allMeasures();
  const order = [];
  for (let k = mi0 + 1; k < lineEnd; k++) order.push(k);
  order.push(mi0);
  const rank = new Map(order.map((k, i) => [ms[k], i]));
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
      if (!best || r0 < best.rank) best = { rank: r0, voice, cursor: i, measureIdx: ms.indexOf(meas) };
      if (best.rank === 0) break;
    }
  }
  return best;
};

/* ── the edit ── */
if (DO_EDIT) {
  const target = findTarget();
  if (!target) { console.warn = ow; console.error = oe; return { ...out, error: 'no note or chord on line ' + LINE }; }
  out.target = { measureIdx: target.measureIdx, voice: target.voice };
  model.setCursor(target.cursor, target.voice);
  r.scheduleMountWindow(target.measureIdx);
  await waitFor(() => r['mountWindowHandle'] === null, 5000, 20);
  await raf();
  out.mountedAtEdit = [...container.querySelectorAll('.score-page:not(.score-page-pending)')].map((e) => +e.dataset.page);

  const ver0 = model.docVersion();
  if (CHECK) globalThis.__HKL_INDEX_CHECK = true;
  const t0 = performance.now();
  try {
    model.deleteAtCursor();
    reRender();
    await waitFor(badgeHidden, 90000, 30);
  } catch (e) {
    out.threw = String((e && e.message) || e).slice(0, 400);
  }
  globalThis.__HKL_INDEX_CHECK = false;
  out.wallMs = Math.round(performance.now() - t0);
  out.editOk = model.docVersion() !== ver0;
  out.outcome = ps.lastOutcome;
  out.skipReason = ps.lastSkipReason;
  out.run = ps.lastRun;
  out.stats = { ...ps.lastStats };
  out.plan = ps.lastVertical ? {
    static: ps.lastVertical.static,
    dyFollow: +ps.lastVertical.dyFollow.toFixed(1),
    liveTop: ps.lastVertical.liveTop.map((v) => +v.toFixed(1)),
    newTop: ps.lastVertical.newTop.map((v) => +v.toFixed(1)),
  } : null;
  out.splicedPages = ps.lastPages.slice();
  await raf();
}

/* ── reference: full re-engrave of the CURRENT model, same pins ── */
const consolidate = (el) => {
  const b = el.transform && el.transform.baseVal && el.transform.baseVal.consolidate
    ? el.transform.baseVal.consolidate() : null;
  return b ? { tx: b.matrix.e, ty: b.matrix.f } : { tx: 0, ty: 0 };
};
function systemProfile(sysEl) {
  const t = consolidate(sysEl);
  const ms = Array.from(sysEl.querySelectorAll('g.measure'));
  if (!ms.length) return null;
  const m0 = ms[0].getBBox();
  const staff = ms[0].querySelector(':scope > g.staff');
  if (!staff) return null;
  const st = consolidate(staff);
  let top = Infinity;
  for (const p of Array.from(staff.querySelectorAll(':scope > path'))) {
    const b = p.getBBox();
    if (b.y < top) top = b.y;
  }
  const box = sysEl.getBBox();
  return {
    firstId: ms[0].id,
    x0: m0.x + t.tx,
    staffTop: top + st.ty + t.ty,
    bboxTop: box.y + t.ty,
    measures: ms.map((m) => { const b = m.getBBox(); return { id: m.id, relX: b.x - m0.x, w: b.width }; }),
  };
}
/* What main.ts's mount-time injector added to this page, read back the way
   pagesplice.ts reads it. */
function pageHeaderState(pageEl) {
  const margin = pageEl.querySelector('svg g.page-margin');
  const systems = margin ? Array.from(margin.children).filter((c) => c.classList.contains('system')) : [];
  const reserve = new Array(systems.length).fill(0);
  const titles = [];
  for (const t of Array.from(pageEl.querySelectorAll('text.hkl-section-header'))) {
    const id = t.getAttribute('data-for');
    const meas = id ? pageEl.querySelector('#' + CSS.escape(id)) : null;
    const sys = meas ? meas.closest('g.system') : null;
    const idx = sys ? systems.indexOf(sys) : -1;
    const res = Number(t.getAttribute('data-reserve'));
    if (idx < 0 || !isFinite(res)) continue;
    titles.push({ idx, y: Number(t.getAttribute('y') ?? 0), text: t.textContent, reserve: res });
    for (let i = idx; i < reserve.length; i++) reserve[i] += res;
  }
  return { systems, reserve, titles };
}

const refMei = lb.injectPins(model.serialize(heji, null), startIds(), new Set(pb.pageStarts()));
const tkRef = new V.toolkit();
tkRef.setOptions(r['buildOptions'](pb.paginationOwned() ? 'encoded' : 'line', 'page'));
if (!tkRef.loadData(refMei)) { console.warn = ow; console.error = oe; return { ...out, error: 'reference loadData failed' }; }
out.refPages = tkRef.getPageCount();
const refSvg = tkRef.renderToSVG(PAGE, {});

const livePage = container.querySelector('.score-page[data-page="' + PAGE + '"]');
const refHost = document.createElement('div');
refHost.style.cssText = 'position:absolute;left:-99999px;top:0';
refHost.innerHTML = refSvg;
document.body.appendChild(refHost);

if (livePage && !livePage.classList.contains('score-page-pending')) {
  const hdr = pageHeaderState(livePage);
  out.header = {
    reserve: hdr.reserve,
    titles: hdr.titles.map((t) => ({ idx: t.idx, y: +t.y.toFixed(1), reserve: t.reserve, text: t.text })),
  };
  const refSys = Array.from(refHost.querySelectorAll('g.system'));
  const liveSys = Array.from(livePage.querySelectorAll('g.system'));
  out.systems = { ref: refSys.length, live: liveSys.length };
  const rows = [];
  for (let i = 0; i < Math.min(refSys.length, liveSys.length); i++) {
    const rp = systemProfile(refSys[i]), lp = systemProfile(liveSys[i]);
    if (!rp || !lp) { rows.push({ i, error: 'unreadable' }); continue; }
    const row = { i, refFirst: rp.firstId, liveFirst: lp.firstId };
    if (rp.firstId !== lp.firstId) { rows.push(row); continue; }
    let dx = 0, dw = 0, worst = null;
    const byId = new Map(rp.measures.map((m) => [m.id, m]));
    for (const m of lp.measures) {
      const rm = byId.get(m.id);
      if (!rm) continue;
      const a = Math.abs(m.relX - rm.relX), b = Math.abs(m.w - rm.w);
      if (a > dx || b > dw) worst = m.id;
      dx = Math.max(dx, a); dw = Math.max(dw, b);
    }
    row.dRelX = +dx.toFixed(1); row.dW = +dw.toFixed(1); row.worst = worst;
    /* Live staff tops carry the injector's reserve; Verovio's do not. */
    const res = hdr.reserve[i] ?? 0;
    row.reserve = res;
    row.dStaffTop = +((lp.staffTop - res) - rp.staffTop).toFixed(1);
    /* And where the title sits relative to its own system's content top —
       the invariant the injector establishes and a splice must preserve. */
    const t = hdr.titles.find((x) => x.idx === i);
    if (t) row.titleGap = +((lp.bboxTop) - t.y).toFixed(1);
    rows.push(row);
  }
  out.compare = rows;
  out.maxDRelX = Math.max(0, ...rows.map((x) => x.dRelX ?? 0));
  out.maxDW = Math.max(0, ...rows.map((x) => x.dW ?? 0));
  out.maxDStaffTop = Math.max(0, ...rows.map((x) => Math.abs(x.dStaffTop ?? 0)));
}

/* ── leave one page in #score for the screenshot ── */
if (SHOT === 'live' && livePage) {
  for (const p of Array.from(container.querySelectorAll('.score-page'))) {
    if (p !== livePage) p.remove();
  }
  container.scrollTop = 0; container.scrollLeft = 0;
  await sleep(200);
} else if (SHOT === 'ref') {
  container.innerHTML = '<div class="score-page" data-page="' + PAGE + '">' + refSvg + '</div>';
  const div = container.querySelector('.score-page');
  r['postProcessRendered'](div);
  const cb = r['onPageMountedCb'];
  if (cb) cb(div); else r['snapSystems'](div);
  container.scrollTop = 0; container.scrollLeft = 0;
  await sleep(200);
}
refHost.remove();
console.warn = ow; console.error = oe;
return out;
