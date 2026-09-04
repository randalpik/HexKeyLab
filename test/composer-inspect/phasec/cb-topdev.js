// Where does the reference gate's staff-top deviation actually come from?
// For every mounted sonata page: render the same pinned MEI offscreen the way
// the gate does, and report per system the live staff top against the rule
// applied to the reference — plus the two inputs that could explain a gap:
// the page header's ink bottom on each side (the documented Verovio
// non-idempotency) and the distribution level each side computes.
const H = window.__hkl_composer; const r = H.renderer, m = H.model;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null, 150000, 100); await waitFor(badgeHidden, 120000, 40);
r.setMountWindowEnabled(false);
for (const p of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) r['mountPage'](+p.dataset.page);
await sleep(400);

const tf = (el) => { const c = el.transform && el.transform.baseVal.consolidate(); return c ? c.matrix.f : 0; };
const parseD = (d) => { const mm = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d || ''); if (!mm) return null; if (Math.abs(+mm[2] - +mm[4]) > 1e-6) return null; return +mm[2]; };
const staffTopOf = (sys) => { const st = sys.querySelector('g.measure > g.staff'); if (!st) return null; const ys = []; for (const n of Array.from(st.children)) { if (n.localName !== 'path') continue; const y = parseD(n.getAttribute('d')); if (y !== null) ys.push(y); } if (!ys.length) return null; ys.sort((a, b) => a - b); return ys[0] + tf(st) + tf(sys); };
const headBot = (margin) => { const hd = margin.querySelector(':scope > g.pgHead'); if (!hd) return null; const b = hd.getBBox(); return b.y + b.height + tf(hd); };

/* Optionally make ONE edit first: with no edit live and reference agree
   exactly (measured 2026-09-04: 0 on all 30 pages, header delta 0), so any
   deviation the battery reports is edit-induced and has to be measured here. */
if (String(window.__probeArg || '').includes('edit=1')) {
  const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
  const mi = 223;
  m.setCursor(m.getMeasureStartCursor(1, mi) + 1, 1);
  if (!m.deleteAtCursor()) return { error: 'edit rejected' };
  H.reRender();
  await waitFor(badgeHidden, 120000, 40);
  await sleep(300);
  for (const p of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) r['mountPage'](+p.dataset.page);
  await sleep(300);
}
const mei = r['pinnedMeiForCurrentModel']();
const tk = r['spliceTk'];
tk.setOptions(r['pageSpliceCtx']().liveOptions());
if (!tk.loadData(mei)) return { error: 'reference loadData failed' };

const out = { pages: [], unit: 80, grid: 1000 / r['currentScale']() };
for (const pageEl of Array.from(document.querySelectorAll('#score .score-page:not(.score-page-pending)'))) {
  const pno = +pageEl.dataset.page;
  if (pno > tk.getPageCount()) continue;
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0';
  host.innerHTML = tk.renderToSVG(pno, {});
  document.body.appendChild(host);
  r['postProcessRendered'](host);
  r.alignStavesIn(host, r.originPhaseOf(pageEl));
  try {
    const refSys = Array.from(host.querySelectorAll('g.system'));
    const liveSys = Array.from(pageEl.querySelectorAll('svg g.page-margin > g.system'));
    if (refSys.length !== liveSys.length) { out.pages.push({ page: pno, error: 'count ' + liveSys.length + ' vs ' + refSys.length }); continue; }
    const pOpts = { distribute: true, pageNo: pno };
    const expect = r.placeFor(refSys, pOpts), self = r.placeFor(liveSys, pOpts);
    const natRef = r.placeFor(refSys), natLive = r.placeFor(liveSys);
    if (!expect || !self || !natRef || !natLive) { out.pages.push({ page: pno, error: 'placement unreadable' }); continue; }
    const lm = pageEl.querySelector('svg g.page-margin'), rm = host.querySelector('svg g.page-margin');
    const hL = headBot(lm), hR = headBot(rm);
    const rows = [];
    for (let i = 0; i < liveSys.length; i++) {
      const live = staffTopOf(liveSys[i]);
      rows.push({
        i,
        dTop: live === null ? null : +(expect[i].top - live).toFixed(1),
        dSelf: live === null ? null : +(self[i].top - live).toFixed(1),
        dRefLiveDist: +(expect[i].top - self[i].top).toFixed(1),
        dRefLiveNat: +(natRef[i].top - natLive[i].top).toFixed(1),
      });
    }
    out.pages.push({
      page: pno, n: liveSys.length,
      headBotLive: hL === null ? null : +hL.toFixed(1),
      headBotRef: hR === null ? null : +hR.toFixed(1),
      dHead: (hL === null || hR === null) ? null : +(hR - hL).toFixed(1),
      maxDTop: Math.max(...rows.map((x) => Math.abs(x.dTop ?? 0))),
      maxDSelf: Math.max(...rows.map((x) => Math.abs(x.dSelf ?? 0))),
      maxDDist: Math.max(...rows.map((x) => Math.abs(x.dRefLiveDist))),
      maxDNat: Math.max(...rows.map((x) => Math.abs(x.dRefLiveNat))),
      rows,
    });
  } finally { host.remove(); }
}
const all = out.pages.filter((p) => !p.error);
out.summary = {
  pages: all.length,
  maxDTop: Math.max(...all.map((p) => p.maxDTop)),
  maxDSelf: Math.max(...all.map((p) => p.maxDSelf)),
  maxDDistributed: Math.max(...all.map((p) => p.maxDDist)),
  maxDNatural: Math.max(...all.map((p) => p.maxDNat)),
  dHeadValues: [...new Set(all.map((p) => p.dHead))],
  worstPages: all.filter((p) => p.maxDTop >= 20).map((p) => ({ page: p.page, maxDTop: p.maxDTop, dHead: p.dHead, n: p.n })),
};
return out;
