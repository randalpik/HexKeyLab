// Phase 4 measurement (vertical-ownership plan): how much SLACK does each page
// carry today, and what would a max-gap distribution rule do to it?
//
// Mounts every sonata page and reads, per page: the paper frame (inner viewBox
// + margin translate), every system's content top/bottom in the page-margin
// frame, the header band reserve, the whitespace gap between consecutive
// components, and the trailing gap from the last system's content bottom to
// (a) the bottom-margin line — "the footer" — and (b) the paper edge, which is
// what `foldIndex` actually uses as the limit today.
//
// Then simulates rule v2 for a range of MAX_GAP caps: distribute the trailing
// slack evenly across the page's inter-system gaps (a header band travels with
// its system, so the slack goes ABOVE the band), waterfalling past any gap that
// hits the cap, and reports the residual trailing gap per page.
const H = window.__hkl_composer; const r = H.renderer;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null, 120000, 100); await waitFor(badgeHidden, 90000, 40);
r.setMountWindowEnabled(false);
for (const page of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) r['mountPage'](+page.dataset.page);
await sleep(300);

const tf = (el) => { const t = el.getAttribute('transform') || ''; const mm = /translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?/.exec(t); return mm ? { tx: +mm[1], ty: +(mm[2] ?? 0) } : { tx: 0, ty: 0 }; };
const parseD = (d) => { const mm = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d || ''); if (!mm) return null; if (Math.abs(+mm[2] - +mm[4]) > 1e-6) return null; return { y: +mm[2] }; };
const staffLines = (staff) => { const ys = []; for (const p of Array.from(staff.children)) { if (p.localName !== 'path') continue; const d = parseD(p.getAttribute('d')); if (d) ys.push(d.y); } return ys.sort((a, b) => a - b); };

const pageEls = Array.from(document.querySelectorAll('#score .score-page:not(.score-page-pending)'));
const pageScale = r.getPageScale();
const unitSamples = [];
const raw = [];
for (const pageEl of pageEls) {
  const pno = +pageEl.dataset.page;
  const svg = pageEl.querySelector('svg');
  const margin = svg && (svg.querySelector(':scope > g.page-margin') || svg.querySelector('g.page-margin'));
  if (!margin) continue;
  const frame = margin.closest('svg') || svg;
  const vb = (frame.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const paperH = vb.length === 4 && isFinite(vb[3]) ? vb[3] : 0;
  const marginTy = tf(margin).ty;
  const systems = Array.from(margin.children).filter((c) => c.classList.contains('system'));
  let hdBottom = null; const hd = margin.querySelector(':scope > g.pgHead');
  if (hd) { try { const b = hd.getBBox(); hdBottom = b.y + b.height + tf(hd).ty; } catch {} }
  const rows = [];
  for (const sys of systems) {
    const t = tf(sys);
    const measures = Array.from(sys.querySelectorAll('g.measure')); if (!measures.length) continue;
    const staves = Array.from(measures[0].querySelectorAll(':scope > g.staff')); if (!staves.length) continue;
    const fl = staffLines(staves[0]), ll = staffLines(staves[staves.length - 1]);
    if (fl.length < 2 || !ll.length) continue;
    for (let i = 1; i < fl.length; i++) unitSamples.push(fl[i] - fl[i - 1]);
    const staffTop = fl[0] + tf(staves[0]).ty, staffBot = ll[ll.length - 1] + tf(staves[staves.length - 1]).ty;
    let bb; try { bb = sys.getBBox(); } catch { continue; }
    const bandAttr = sys.getAttribute('data-hkl-band-top');
    const contentTop = bb.y + t.ty, contentBottom = bb.y + bb.height + t.ty;
    const bandTop = bandAttr !== null ? +bandAttr : null;
    rows.push({
      start: measures[0].id, nMeas: measures.length, ty: t.ty,
      staffTop: staffTop + t.ty, staffBot: staffBot + t.ty,
      above: staffTop - bb.y, below: (bb.y + bb.height) - staffBot,
      contentTop, contentBottom,
      reserve: bandTop !== null ? contentTop - bandTop : 0,
      /** Top of this component INCLUDING its header band — the thing the gap above it ends at. */
      compTop: bandTop !== null ? bandTop : contentTop,
    });
  }
  raw.push({ page: pno, paperH, marginTy, hdBottom, rows });
}
unitSamples.sort((a, b) => a - b);
const u = unitSamples[Math.floor(unitSamples.length / 2)] / 2;
const bottomMargin = 1400 * pageScale;   /* PAGE_GEOM.pageMarginBottom (140) × 10 user units × pageScale */
const U = (x) => +(x / u).toFixed(2);

const CAPS_U = [4, 6, 8, 10, 12, 14, 16, 20, 24, 30, 1e9];
/** Waterfall: spread `slack` over `gaps`, no gap exceeding `cap`. Returns the
 *  per-gap extra and the residual that could not be placed. */
function distribute(gaps, slack, cap) {
  const extra = gaps.map(() => 0);
  let left = slack;
  if (left <= 0 || !gaps.length) return { extra, residual: left };
  const room = gaps.map((g) => Math.max(0, cap - g));
  for (let iter = 0; iter < 40 && left > 1e-6; iter++) {
    const open = [];
    for (let i = 0; i < gaps.length; i++) if (room[i] - extra[i] > 1e-6) open.push(i);
    if (!open.length) break;
    const share = left / open.length;
    let used = 0;
    for (const i of open) { const take = Math.min(share, room[i] - extra[i]); extra[i] += take; used += take; }
    left -= used;
    if (used <= 1e-9) break;
  }
  return { extra, residual: left };
}

const pages = [];
for (const p of raw) {
  const n = p.rows.length;
  if (!n) continue;
  const paperBottom = p.paperH - p.marginTy;        // paper edge, page-margin frame
  const footerLine = paperBottom - bottomMargin;     // bottom-margin line ("the footer")
  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push(p.rows[i].compTop - p.rows[i - 1].contentBottom);
  const last = p.rows[n - 1];
  const toFooter = footerLine - last.contentBottom;
  const toPaper = paperBottom - last.contentBottom;
  const sims = {};
  for (const c of CAPS_U) {
    const d = distribute(gaps, Math.max(0, toFooter), c * u);
    sims[c >= 1e9 ? 'inf' : String(c)] = {
      perGap: d.extra.map((x) => U(x)),
      newGaps: gaps.map((g, i) => U(g + d.extra[i])),
      residual: U(d.residual),
      lastDown: U(Math.max(0, toFooter) - d.residual),
    };
  }
  pages.push({
    page: p.page, n, headers: p.rows.filter((x) => x.reserve > 0).length,
    sysH: p.rows.map((x) => U(x.contentBottom - x.contentTop)),
    aboveU: p.rows.map((x) => U(x.above)), belowU: p.rows.map((x) => U(x.below)),
    reserveU: p.rows.map((x) => U(x.reserve)),
    firstContentTop: U(p.rows[0].contentTop), hdBottom: p.hdBottom === null ? null : U(p.hdBottom),
    gapsU: gaps.map(U),
    gapMin: gaps.length ? U(Math.min(...gaps)) : null,
    gapMax: gaps.length ? U(Math.max(...gaps)) : null,
    toFooterU: U(toFooter), toPaperU: U(toPaper),
    belowLast: U(p.rows[n - 1].below),
    sims,
  });
}
const totals = {};
for (const c of CAPS_U) {
  const key = c >= 1e9 ? 'inf' : String(c);
  const res = pages.map((x) => x.sims[key].residual);
  const moved = pages.map((x) => x.sims[key].lastDown);
  totals[key] = {
    residualMax: +Math.max(...res).toFixed(2),
    residualMean: +(res.reduce((a, b) => a + b, 0) / res.length).toFixed(2),
    pagesFullyClosed: res.filter((x) => x <= 0.05).length,
    pagesResidualOver6u: res.filter((x) => x > 6).length,
    lastSystemMovedMax: +Math.max(...moved).toFixed(2),
  };
}
/* Would the NEXT page's first system have fitted here? The clearance a system
   needs below its predecessor is max(below_prev, F) + G + max(above_next, F)
   from the predecessor's staff bottom, plus the next system's own span+below. */
const F = 6 * u, G = 4 * u;
for (let i = 0; i < pages.length - 1; i++) {
  const cur = raw.find((x) => x.page === pages[i].page), nxt = raw.find((x) => x.page === pages[i + 1].page);
  if (!cur || !nxt || !cur.rows.length || !nxt.rows.length) continue;
  const prev = cur.rows[cur.rows.length - 1], cand = nxt.rows[0];
  const need = Math.max(prev.below, F) + G + Math.max(cand.above, F) + (cand.staffBot - cand.staffTop) + cand.below + cand.reserve;
  const availFooter = (cur.paperH - cur.marginTy - bottomMargin) - prev.staffBot;
  const availPaper = (cur.paperH - cur.marginTy) - prev.staffBot;
  pages[i].nextFit = { needU: U(need), availFooterU: U(availFooter), availPaperU: U(availPaper),
    fitsFooter: need <= availFooter, fitsPaper: need <= availPaper, shortByU: U(need - availFooter) };
}
return {
  unit: u, pageScale, bottomMarginU: U(bottomMargin), paperHU: U(raw[0]?.paperH ?? 0), marginTyU: U(raw[0]?.marginTy ?? 0),
  pageCount: pages.length, systemCount: pages.reduce((a, b) => a + b.n, 0),
  totals, pages,
};
