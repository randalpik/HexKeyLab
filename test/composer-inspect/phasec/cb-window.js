// Phase C-B probe 2: window fidelity (sonata).
// For a spread of line indices k, render a windowed sub-MEI — lines
// [k-1..k+1] extended left/right until spanner-clean + whole-<ending>, with a
// synthetic mRest leader (absorbs score-start artifacts) and sb pins at every
// line start, page geometry + tall page, breaks:'line' — and compare line k's
// system against an offscreen pinned full render (breaks:'line'):
//   - partition: sub-render honors the window pins verbatim?
//   - per-measure x (relative to the system's first measure) + width
//   - absolute measure x in the page-margin frame (dx ≈ 0 expectation)
//   - staff-line ys relative to the system's top staff line (inter-staff gaps)
//   - system bbox top/bottom relative to the top staff line (hanging content)
// This is design-doc item 4 (gap fidelity under pinning) + the C-B window
// mechanism validation.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const V = window.verovio;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 60000, step = 100) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;

const lb = await import('/composer/src/render/linebreaks.ts');
const sp = await import('/composer/src/render/splice.ts');
const startIds = pb['startIds'].slice();
const meiMeasures = model.allMeasures();
const ids = meiMeasures.map((m) => m.getAttribute('xml:id'));
const idIdx = new Map(ids.map((id, i) => [id, i]));
const heji = { hejiEnabled: model.getHejiEnabled() };
// line index → measure-index span [a, b)
const spans = startIds.map((id, li) => [
  idIdx.get(id),
  li + 1 < startIds.length ? idIdx.get(startIds[li + 1]) : ids.length,
]);
const lineOfMeasure = (mi) => {
  let lo = 0, hi = spans.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (spans[mid][0] <= mi) lo = mid; else hi = mid - 1; }
  return lo;
};

/* ── reference: offscreen pinned full render, breaks:'line' ── */
const fullMei = model.serialize(heji, null);
const pinnedFull = lb.injectPins(fullMei, startIds, null);
const optsLine = { ...r['buildOptions']('auto'), breaks: 'line' };
const tkRef = new V.toolkit();
tkRef.setOptions(optsLine);
if (!tkRef.loadData(pinnedFull)) return { error: 'reference loadData failed' };
out.refPages = tkRef.getPageCount();

const offscreen = (html) => {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0';
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
};

/* Per-system geometry profile, all in the system's local frame. */
function systemProfile(sysEl) {
  const bb = (el) => el.getBBox();
  const measures = Array.from(sysEl.querySelectorAll(':scope g.measure'));
  if (!measures.length) return null;
  const m0 = bb(measures[0]);
  const firstM = measures[0];
  const staves = Array.from(firstM.querySelectorAll(':scope > g.staff'));
  const staffYs = [];
  for (const s of staves) {
    let t = Infinity, b = -Infinity;
    for (const p of Array.from(s.querySelectorAll(':scope > path'))) {
      const r2 = bb(p);
      if (r2.y < t) t = r2.y;
      if (r2.y + r2.height > b) b = r2.y + r2.height;
    }
    if (isFinite(t)) staffYs.push({ top: t, bot: b });
  }
  const topLine = staffYs.length ? staffYs[0].top : null;
  const sysBox = bb(sysEl);
  return {
    firstId: firstM.id,
    absX0: m0.x,
    absStaffTop: topLine,   // page-margin frame; spacing DELTAS are frame-free
    measures: measures.map((m) => {
      const b = bb(m);
      return { id: m.id, relX: +(b.x - m0.x).toFixed(1), w: +b.width.toFixed(1) };
    }),
    staffRel: topLine != null ? staffYs.map((s) => ({
      top: +(s.top - topLine).toFixed(1), bot: +(s.bot - topLine).toFixed(1),
    })) : [],
    bboxTopRel: topLine != null ? +(sysBox.y - topLine).toFixed(1) : null,
    bboxBotRel: topLine != null ? +(sysBox.y + sysBox.height - topLine).toFixed(1) : null,
  };
}

/* Reference profiles: per page, a map firstMeasureId → systemProfile.
 * absStaffTop values within one page share the page-margin frame, so
 * consecutive-system SPACING (top-to-top deltas) is comparable across
 * renders. */
const refPageCache = new Map();
function refPageProfiles(page) {
  if (refPageCache.has(page)) return refPageCache.get(page);
  const host = offscreen(tkRef.renderToSVG(page, {}));
  const map = new Map();
  for (const sys of Array.from(host.querySelectorAll('g.system'))) {
    const p = systemProfile(sys);
    if (p) map.set(p.firstId, p);
  }
  host.remove();
  refPageCache.set(page, map);
  return map;
}
function refProfile(k) {
  const page = tkRef.getPageWithElement(startIds[k]);
  return { prof: refPageProfiles(page).get(startIds[k]) ?? null, page };
}

/* ── window construction ── */
const MEI_NS = 'http://www.music-encoding.org/ns/mei';
function buildWindowMei(wLo, wHi) {
  const mLo = spans[wLo][0], mHi = spans[wHi][1] - 1;
  let mei = model.serializeRangeForRender(mLo, mHi, heji, null);
  const winStarts = [];
  for (let li = wLo; li <= wHi; li++) winStarts.push(startIds[li]);
  const doc = new DOMParser().parseFromString(mei, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  if (wLo > 0) {
    // synthetic leading measure: mRest on every staff; injectPins (with the
    // leader as line 0) then pins EVERY real line start including the first.
    const section = doc.querySelector('section');
    if (!section) return null;
    const nStaves = doc.querySelectorAll('scoreDef staffDef').length || 1;
    const lead = doc.createElementNS(MEI_NS, 'measure');
    lead.setAttribute('xml:id', 'hkl-cb-lead');
    lead.setAttribute('n', '0');
    for (let s = 1; s <= nStaves; s++) {
      const st = doc.createElementNS(MEI_NS, 'staff');
      st.setAttribute('n', String(s));
      const ly = doc.createElementNS(MEI_NS, 'layer');
      ly.setAttribute('n', '1');
      ly.appendChild(doc.createElementNS(MEI_NS, 'mRest'));
      st.appendChild(ly);
      lead.appendChild(st);
    }
    section.insertBefore(lead, section.firstElementChild);
    mei = new XMLSerializer().serializeToString(doc);
    return { mei: lb.injectPins(mei, ['hkl-cb-lead', ...winStarts], null), winStarts, leader: true };
  }
  return { mei: lb.injectPins(mei, winStarts, null), winStarts, leader: false };
}

/* Extend [k-1..k+1] to spanner-clean + whole-ending LINE boundaries. */
function windowLines(k) {
  let wLo = Math.max(0, k - 1);
  let wHi = Math.min(spans.length - 1, k + 1);
  for (let guard = 0; guard < 8; guard++) {
    let mLo = spans[wLo][0], mHi = spans[wHi][1] - 1;
    let [lo2, hi2] = sp.expandForSpanners(meiMeasures, mLo, mHi);
    [lo2, hi2] = sp.expandForEndings(meiMeasures, lo2, hi2);
    const nLo = lineOfMeasure(lo2), nHi = lineOfMeasure(hi2);
    if (nLo === wLo && nHi === wHi) break;
    wLo = nLo; wHi = nHi;
  }
  return [wLo, wHi];
}

const tkWin = new V.toolkit();
const windowOpts = { ...r['buildOptions']('auto'), breaks: 'line', pageHeight: 60000, adjustPageHeight: true, header: 'none' };

/* ── pick sample lines ── */
const nLines = spans.length;
const picks = new Set([0, 1, 20, 40, Math.floor(nLines / 2), 81, 87, nLines - 2, nLines - 1].filter((k) => k >= 0 && k < nLines));
// a volta line + a mid-piece scoreDef line
const e0 = model.getDoc().querySelector('ending measure');
if (e0) picks.add(lineOfMeasure(idIdx.get(e0.getAttribute('xml:id'))));
{
  const sec = model.getDoc().querySelector('section');
  let seen = 0;
  for (const c of Array.from(sec.children)) {
    if (c.localName === 'measure') seen++;
    else if (c.localName === 'scoreDef' && seen > 0 && seen < ids.length) { picks.add(lineOfMeasure(seen)); break; }
    else if (c.querySelector && c.querySelector('measure')) seen += c.querySelectorAll('measure').length;
  }
}
// a page-start and a page-end line on the reference
{
  const host = offscreen(tkRef.renderToSVG(3, {}));
  const sys = Array.from(host.querySelectorAll('g.system'));
  if (sys.length) {
    const firstId = sys[0].querySelector('g.measure')?.id;
    const lastId = sys[sys.length - 1].querySelector('g.measure')?.id;
    if (firstId && idIdx.has(firstId)) picks.add(lineOfMeasure(idIdx.get(firstId)));
    if (lastId && idIdx.has(lastId)) picks.add(lineOfMeasure(idIdx.get(lastId)));
  }
  host.remove();
}

const results = [];
for (const k of [...picks].sort((a, b) => a - b)) {
  const t0 = performance.now();
  const entry = { k, startId: startIds[k] };
  try {
    const [wLo, wHi] = windowLines(k);
    entry.window = [wLo, wHi];
    entry.windowMeasures = spans[wHi][1] - spans[wLo][0];
    const built = buildWindowMei(wLo, wHi);
    if (!built || !built.mei) { entry.error = 'window build failed'; results.push(entry); continue; }
    tkWin.setOptions(windowOpts);
    if (!tkWin.loadData(built.mei)) { entry.error = 'window loadData failed'; results.push(entry); continue; }
    entry.winPages = tkWin.getPageCount();
    const host = offscreen(tkWin.renderToSVG(1, {}));
    const systems = Array.from(host.querySelectorAll('g.system'));
    const sysStarts = systems.map((s) => s.querySelector('g.measure')?.id ?? null);
    // partition check: (leader +) window line starts, in order
    const expect = built.leader ? ['hkl-cb-lead', ...built.winStarts] : built.winStarts;
    entry.pinsVerbatim = sysStarts.length === expect.length && sysStarts.every((id, i) => id === expect[i]);
    entry.sysStarts = sysStarts;
    const target = systems.find((s) => s.querySelector('g.measure')?.id === startIds[k]);
    const winProf = target ? systemProfile(target) : null;
    const { prof: refProf } = refProfile(k);
    /* Pairwise-locality check: consecutive window systems' top-to-top spacing
     * vs the reference render's, wherever both lines share a reference page.
     * This is what lets the splice MEASURE follower dy instead of emulating
     * Verovio's content-driven stacking. */
    const winProfByLine = new Map();
    for (let li = wLo; li <= wHi; li++) {
      const s = systems.find((x) => x.querySelector('g.measure')?.id === startIds[li]);
      if (s) { const p = systemProfile(s); if (p) winProfByLine.set(li, p); }
    }
    const spacings = [];
    for (let li = wLo; li < wHi; li++) {
      const a = winProfByLine.get(li), b = winProfByLine.get(li + 1);
      if (!a || !b || a.absStaffTop == null || b.absStaffTop == null) continue;
      const ra = refProfile(li), rb = refProfile(li + 1);
      if (!ra.prof || !rb.prof || ra.page !== rb.page) continue;
      const dw = b.absStaffTop - a.absStaffTop;
      const dr = rb.prof.absStaffTop - ra.prof.absStaffTop;
      spacings.push({ pair: [li, li + 1], winSpacing: +dw.toFixed(1), refSpacing: +dr.toFixed(1), d: +(dw - dr).toFixed(1) });
    }
    entry.spacings = spacings;
    entry.maxSpacingD = spacings.length ? Math.max(...spacings.map((s) => Math.abs(s.d))) : null;
    host.remove();
    if (!winProf || !refProf) { entry.error = 'profile missing'; results.push(entry); continue; }
    let maxDx = 0, maxDw = 0, cmp = 0;
    const refByIdx = new Map(refProf.measures.map((m) => [m.id, m]));
    for (const m of winProf.measures) {
      const rm = refByIdx.get(m.id);
      if (!rm) continue;
      cmp++;
      maxDx = Math.max(maxDx, Math.abs(m.relX - rm.relX));
      maxDw = Math.max(maxDw, Math.abs(m.w - rm.w));
    }
    entry.measuresCompared = cmp;
    entry.maxRelDx = +maxDx.toFixed(1);
    entry.maxDw = +maxDw.toFixed(1);
    entry.absDx0 = +(winProf.absX0 - refProf.absX0).toFixed(1);
    let maxStaffD = 0;
    for (let i = 0; i < Math.min(winProf.staffRel.length, refProf.staffRel.length); i++) {
      maxStaffD = Math.max(maxStaffD,
        Math.abs(winProf.staffRel[i].top - refProf.staffRel[i].top),
        Math.abs(winProf.staffRel[i].bot - refProf.staffRel[i].bot));
    }
    entry.stavesEqual = winProf.staffRel.length === refProf.staffRel.length;
    entry.maxStaffDy = +maxStaffD.toFixed(1);
    entry.dBboxTop = +(winProf.bboxTopRel - refProf.bboxTopRel).toFixed(1);
    entry.dBboxBot = +(winProf.bboxBotRel - refProf.bboxBotRel).toFixed(1);
  } catch (e) {
    entry.error = String(e && e.stack || e).slice(0, 300);
  }
  entry.ms = Math.round(performance.now() - t0);
  results.push(entry);
}
out.results = results;
out.summary = {
  windows: results.length,
  clean: results.filter((e) => !e.error && e.pinsVerbatim && e.maxRelDx <= 1 && e.maxDw <= 1 && e.maxStaffDy <= 1).length,
  maxRelDx: Math.max(...results.map((e) => e.maxRelDx ?? 99)),
  maxDw: Math.max(...results.map((e) => e.maxDw ?? 99)),
  maxStaffDy: Math.max(...results.map((e) => e.maxStaffDy ?? 99)),
  maxSpacingD: Math.max(...results.map((e) => e.maxSpacingD ?? 0)),
};
return out;
