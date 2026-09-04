// Phase 4 acceptance: does the LIVE distributed layout match the simulation?
// Mounts every sonata page and reports, per page: the gaps that equalize (the
// inter-system gaps and the gap to the bottom of the content column), the top
// gap, and whether the page came out even.
const H = window.__hkl_composer; const r = H.renderer;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null, 120000, 100); await waitFor(badgeHidden, 90000, 40);
r.setMountWindowEnabled(false);
for (const p of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) r['mountPage'](+p.dataset.page);
await sleep(400);
const tf = (el) => { const t = el.getAttribute('transform') || ''; const m = /translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?/.exec(t); return m ? { tx: +m[1], ty: +(m[2] ?? 0) } : { tx: 0, ty: 0 }; };
const u = 80, rd = (x) => +(x / u).toFixed(2);
const ink = (el) => { const b = el.getBBox(), t = tf(el); return { top: b.y + t.ty, bot: b.y + b.height + t.ty }; };
const out = { pages: [], creditPages: [], footerInk: null };
for (const pageEl of Array.from(document.querySelectorAll('#score .score-page:not(.score-page-pending)'))) {
  const pno = +pageEl.dataset.page;
  const margin = pageEl.querySelector('svg g.page-margin'); if (!margin) continue;
  const frame = margin.closest('svg');
  const vb = (frame.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const colBottom = vb[3] - tf(margin).ty - 1400 * r.getPageScale();
  const systems = Array.from(margin.children).filter((c) => c.classList.contains('system'));
  if (!systems.length) continue;
  const head = margin.querySelector(':scope > g.pgHead');
  const foot = margin.querySelector(':scope > text.hkl-injected-footer');
  const cred = margin.querySelector(':scope > text.hkl-injected-composer');
  if (cred) out.creditPages.push(pno);
  if (foot && !out.footerInk) { const f = ink(foot); out.footerInk = { top: rd(f.top), bot: rd(f.bot), colBottomU: rd(colBottom) }; }
  const rows = systems.map((s) => { const i = ink(s); const band = s.getAttribute('data-hkl-band-top');
    return { inkTop: i.top, inkBot: i.bot, compTop: band !== null ? +band : i.top }; });
  const gaps = []; for (let i = 1; i < rows.length; i++) gaps.push(rd(rows[i].compTop - rows[i - 1].inkBot));
  const footGap = rd(colBottom - rows[rows.length - 1].inkBot);
  const topGap = head ? rd(rows[0].compTop - ink(head).bot) : null;
  const all = [...gaps, footGap];
  out.pages.push({ page: pno, n: rows.length, topGap, gaps, footGap,
    even: Math.max(...all) - Math.min(...all) < 0.15,
    maxGap: Math.max(...all), overflow: footGap < -0.01 });
}
out.summary = {
  pages: out.pages.length,
  even: out.pages.filter((p) => p.even).length,
  topOpened: out.pages.filter((p) => p.topGap !== null && p.topGap > 3).map((p) => p.page),
  overflowing: out.pages.filter((p) => p.overflow).map((p) => p.page),
  worstGap: Math.max(...out.pages.map((p) => p.maxGap)),
  creditPages: out.creditPages,
};
return out;
