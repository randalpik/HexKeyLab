// Phase 4 visual mock-up: render ONE page with the water-level distribution
// applied, so the caps can be judged by eye. Changes no source — it rewrites
// the mounted page's system transforms in place, the way rule v2 would.
//
//   --arg "page=3,cap=12,top=10,minfoot=4"
//
// The page's vertical components, top to bottom (2026-09-03, after the first
// mock-up put the music through the footer):
//   • g.pgHead            — Verovio's page header (page number / title block).
//   • text.hkl-injected-composer — Composer's credit line. NOT a fixed page
//     component: main.ts anchors it 120 units above the FIRST SYSTEM, so it
//     rides with the block and is shifted here too.
//   • the systems.
//   • text.hkl-injected-footer   — Composer's footer, fixed at
//     PAGE_INNER_H − 200 (ink band 308.13–312.63u). This, not the bottom-margin
//     line, is what bounds the music: justifying to the margin line drives the
//     last system 6.1u into the footer text.
// Distributable gaps: pgHead→first system (cap `top`) and each inter-system gap
// (cap `cap`). The gap above the footer is the residual, floored at `minfoot`.
const H = window.__hkl_composer; const r = H.renderer;
const pb = r['pageBreaks'];
const A = Object.fromEntries(String(window.__probeArg || '').split(',').filter(Boolean).map((s) => s.split('=')));
const PAGE = +(A.page || 3), CAP = +(A.cap || 0), TOPCAP = +(A.top || 10), MINF = +(A.minfoot ?? 4);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null, 120000, 100); await waitFor(badgeHidden, 90000, 40);
r.setMountWindowEnabled(false); r['mountPage'](PAGE); await sleep(400);

const tf = (el) => { const t = el.getAttribute('transform') || ''; const m = /translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?/.exec(t); return m ? { tx: +m[1], ty: +(m[2] ?? 0) } : { tx: 0, ty: 0 }; };
const pageEl = document.querySelector(`#score .score-page[data-page="${PAGE}"]`);
const margin = pageEl && pageEl.querySelector('svg g.page-margin');
if (!margin) return { error: 'page not mounted', page: PAGE };
const u = 80, rd = (x) => +(x / u).toFixed(2);
const inkOf = (el) => { if (!el) return null; const b = el.getBBox(), t = tf(el); return { top: b.y + t.ty, bot: b.y + b.height + t.ty }; };
const systems = Array.from(margin.children).filter((c) => c.classList.contains('system'));
const head = inkOf(margin.querySelector(':scope > g.pgHead'));
const credit = margin.querySelector(':scope > text.hkl-injected-composer');
const footer = inkOf(margin.querySelector(':scope > text.hkl-injected-footer'));
const rows = systems.map((s) => { const b = s.getBBox(), t = tf(s), band = s.getAttribute('data-hkl-band-top');
  return { sys: s, tx: t.tx, ty: t.ty, inkTop: b.y + t.ty, inkBot: b.y + b.height + t.ty, compTop: band !== null ? +band : b.y + t.ty }; });

const topGap = head ? rows[0].compTop - head.bot : null;
const inter = []; for (let i = 1; i < rows.length; i++) inter.push(rows[i].compTop - rows[i - 1].inkBot);
const limit = (footer ? footer.top : Infinity) - MINF * u;
const slack = limit - rows[rows.length - 1].inkBot;
const out = { page: PAGE, capU: CAP, topCapU: TOPCAP, minFootU: MINF, n: rows.length,
  headInkBotU: head && rd(head.bot), footerInkTopU: footer && rd(footer.top),
  topGapU: topGap === null ? null : rd(topGap), gapsU: inter.map(rd), slackU: rd(slack) };

if (CAP > 0 && slack > 0) {
  const gaps = topGap === null ? inter : [topGap, ...inter];
  const caps = (topGap === null ? [] : [TOPCAP * u]).concat(inter.map(() => CAP * u));
  const used = (L) => gaps.reduce((a, g, i) => a + Math.max(0, Math.min(L, caps[i]) - g), 0);
  const CMAX = Math.max(...caps);
  let extra;
  if (used(CMAX) <= slack) extra = gaps.map((g, i) => Math.max(0, caps[i] - g));
  else { let lo = Math.min(...gaps), hi = CMAX; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (used(m) < slack) lo = m; else hi = m; } const L = (lo + hi) / 2; extra = gaps.map((g, i) => Math.max(0, Math.min(L, caps[i]) - g)); }
  const grid = 1000 / r['currentScale']();
  const firstMoved = topGap === null ? 1 : 0;
  let cum = 0; const applied = [];
  for (let i = 0; i < extra.length; i++) {
    cum += Math.round(extra[i] / grid) * grid;
    applied.push(cum);
    const row = rows[i + firstMoved];
    row.sys.setAttribute('transform', `translate(${row.tx}, ${row.ty + cum})`);
    const fm = row.sys.querySelector('g.measure');
    const title = fm && pageEl.querySelector(`text.hkl-section-header[data-for="${fm.id}"]`);
    if (title) title.setAttribute('y', String(+title.getAttribute('y') + cum));
    /* The credit rides the FIRST system (main.ts anchors it to that bbox). */
    if (i === 0 && firstMoved === 0 && credit) credit.setAttribute('y', String(+credit.getAttribute('y') + cum));
  }
  out.extraU = extra.map(rd); out.gapsAfterU = gaps.map((g, i) => rd(g + extra[i])); out.cumShiftU = applied.map(rd);
  await sleep(50);
  const lr = rows[rows.length - 1], lb = lr.sys.getBBox();
  out.footerGapAfterU = footer ? rd(footer.top - (lb.y + lb.height + lr.ty + cum)) : null;
}
/* Frame the shot on this page alone. The cursor overlay is drawn once in
   #score container coords, so deleting the sibling pages leaves its markers
   at stale positions — drop it rather than ship a misleading picture. */
for (const el of Array.from(document.querySelectorAll('#score .score-page'))) if (el !== pageEl) el.remove();
for (const el of Array.from(document.querySelectorAll('#cursorOverlay'))) el.remove();
const sc = document.getElementById('score'); if (sc) sc.scrollTop = 0;
await sleep(200);
return out;
