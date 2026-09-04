// Is the MOUNT exact? No edits, no splices — mount pages and compare each
// against a full re-engrave of the same pinned MEI, by the same placement rule.
// If the deviation the exactness census found is already present here, it is a
// property of the mount path, not of the splice. Args: --arg "pages=1,2,3,..."
const H = window.__hkl_composer; const r = H.renderer;
const pb = r['pageBreaks'];
const container = document.getElementById('score');
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const args = {}; for (const kv of String(window.__probeArg ?? '').split(';')) { const [k, v] = kv.split('='); if (k) args[k.trim()] = v === undefined ? '1' : v.trim(); }
await waitFor(() => pb['startIds'] !== null, 120000, 100);
await waitFor(badgeHidden, 90000, 40);
for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { H.reRender(); await waitFor(badgeHidden, 60000, 30); }

const ctx = r['pageSpliceCtx']();
const mei = r['pinnedMeiForCurrentModel']();
const out = { ownership: pb.ownershipActive(), pages: [] };
ctx.toolkit.setOptions(ctx.liveOptions());
out.loaded = !!(mei && ctx.toolkit.loadData(mei));
if (out.loaded) {
  const want = String(args.pages || '2,5,9,14,19,23,28').split(',').map(Number).filter((n) => n >= 1);
  for (const pn of want) {
    r['mountPage'](pn);
    await sleep(200);
    const pgEl = container.querySelector('.score-page[data-page="' + pn + '"]:not(.score-page-pending)');
    if (!pgEl) { out.pages.push({ page: pn, error: 'not mounted' }); continue; }
    const h = document.createElement('div');
    h.style.cssText = 'position:absolute;left:-99999px;top:0';
    h.innerHTML = ctx.toolkit.renderToSVG(pn, {});
    document.body.appendChild(h);
    r['postProcessRendered'](h);
    r['alignStavesIn'](h);        /* same phase alignment live pages get */
    const refSys = Array.from(h.querySelectorAll('g.system'));
    const liveSys = Array.from(pgEl.querySelectorAll('g.system'));
    const row = { page: pn, liveSystems: liveSys.length, refSystems: refSys.length };
    if (refSys.length === liveSys.length && refSys.length) {
      const er = ctx.placeFor(refSys), el = ctx.placeFor(liveSys);
      if (er && el) {
        row.deltas = er.map((x, i) => +(x.top - el[i].top).toFixed(2));
        row.maxAbs = +Math.max.apply(null, row.deltas.map(Math.abs)).toFixed(2);
        row.nonZero = row.deltas.filter((x) => Math.abs(x) > 0.005).length;
      }
      /* also snapped, to remove the known live-snapped / ref-raw asymmetry */
      r['snapSystems'](h);
      const er2 = ctx.placeFor(Array.from(h.querySelectorAll('g.system')));
      if (er2 && el) {
        row.deltasSnapped = er2.map((x, i) => +(x.top - el[i].top).toFixed(2));
        row.maxAbsSnapped = +Math.max.apply(null, row.deltasSnapped.map(Math.abs)).toFixed(2);
      }
    }
    /* SELF-CONSISTENCY: where the systems ACTUALLY sit vs where the placement
       rule says they should, on each side. The live page is placed and THEN
       snapped, so any non-zero here is the snap perturbing the placement. */
    const parseD = (dd) => { const m = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(dd || ''); if (!m) return null; if (Math.abs(+m[2] - +m[4]) > 1e-6) return null; return +m[2]; };
    const tfy = (el, stop) => { let y = 0, n = el; while (n && n !== stop && n.nodeType === 1) { const t = (n.getAttribute && n.getAttribute('transform')) || ''; const m = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(t); if (m) y += +m[2]; n = n.parentElement; } return y; };
    const actualTops = (root, stop) => Array.from(root.querySelectorAll('g.system')).map((sy) => {
      let top = Infinity;
      for (const st of Array.from(sy.querySelectorAll('g.staff'))) {
        const off = tfy(st, stop);
        for (const pth of Array.from(st.children)) { if (pth.localName !== 'path') continue; const y = parseD(pth.getAttribute('d')); if (y != null && y + off < top) top = y + off; }
      }
      return isFinite(top) ? +top.toFixed(2) : null;
    });
    const selfErr = (tops, placed) => { if (!placed) return null; const ds = tops.map((t, i) => (t == null || !placed[i]) ? 0 : t - placed[i].top); const base = ds.length ? ds[0] : 0; return ds.map((x) => +(x - base).toFixed(2)); };
    const elNow = ctx.placeFor(Array.from(pgEl.querySelectorAll('g.system')));
    const erNow = ctx.placeFor(Array.from(h.querySelectorAll('g.system')));
    row.liveSelf = selfErr(actualTops(pgEl, pgEl), elNow);
    row.refSelf = selfErr(actualTops(h, h), erNow);
    h.remove();
    out.pages.push(row);
  }
}
return out;
