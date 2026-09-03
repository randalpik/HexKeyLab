// Clean matrix: breaks x minLastJustification, with mlj set EXPLICITLY in every
// variant (Verovio's setOptions persists unspecified options — the same trap the
// adjustPageHeight comment in buildOptions warns about) and every variant run
// twice in opposite orders to prove no option bleed. Run with --no-sonata.
const H = window.__hkl_composer; const m = H.model, R = H.renderer;
const pb = R['pageBreaks'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 60000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const parseD = (d) => { const mm = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d || ''); if (!mm) return null; if (Math.abs(+mm[2] - +mm[4]) > 1e-6) return null; return { x1: +mm[1], x2: +mm[3] }; };
const span = (mEl) => { const st = mEl.querySelector(':scope > g.staff'); if (!st) return null; for (const p of Array.from(st.children)) { if (p.localName !== 'path') continue; const d = parseD(p.getAttribute('d')); if (d) return +d.x2.toFixed(0); } return null; };
const tk = R['spliceTk'];
const rights = (mei, opts) => {
  tk.setOptions(opts);
  if (!tk.loadData(mei)) return 'loadData failed';
  const sys = [];
  for (let p = 1; p <= tk.getPageCount(); p++) {
    const doc = new DOMParser().parseFromString(tk.renderToSVG(p, {}), 'image/svg+xml');
    Array.from(doc.querySelectorAll('g.system')).forEach((sy) => {
      const ms = Array.from(sy.querySelectorAll('g.measure'));
      if (ms.length) sys.push([ms.length, span(ms[ms.length - 1])]);
    });
  }
  return sys;
};

const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', lightColorHex: '#fff', velocity: 80 };
m.setCursor(0, 1);
for (let i = 0; i < 24; i++) m.insertChordAtCursor({ notes: [A], duration: '1', dots: 0 });
m.setSectionHeaderAt(12, 'II');
H.reRender(); await waitFor(badgeHidden, 40000, 20);
for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { H.reRender(); await waitFor(badgeHidden, 40000, 20); }
const base = R['pageSpliceCtx']().liveOptions();
const pinned = R['pinnedMeiForCurrentModel']();
const VARIANTS = [
  ['encoded/0.8', { ...base, breaks: 'encoded', minLastJustification: 0.8 }],
  ['encoded/0',   { ...base, breaks: 'encoded', minLastJustification: 0 }],
  ['line/0.8',    { ...base, breaks: 'line',    minLastJustification: 0.8 }],
  ['line/0',      { ...base, breaks: 'line',    minLastJustification: 0 }],
];
const out = { pageWidth: base.pageWidth, forward: {}, reversed: {} };
for (const [n, o] of VARIANTS) out.forward[n] = rights(pinned, o);
for (const [n, o] of VARIANTS.slice().reverse()) out.reversed[n] = rights(pinned, o);
/* scroll geometry, same discipline */
const so = R['buildOptions']('none', 'scroll');
out.scroll = {
  '0.8': rights(pinned, { ...so, minLastJustification: 0.8 }),
  '0':   rights(pinned, { ...so, minLastJustification: 0 }),
};
return out;
