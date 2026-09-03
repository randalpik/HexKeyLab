// Does minLastJustification:0 give end-of-document parity with end-of-section,
// and make the painted ('encoded') and gate ('line') renders agree? And is it
// safe to set globally, or must it be scoped to PAGE geometry (scroll renders
// the whole score as ONE system, which is also "the last system")?
// Run with --no-sonata.
const H = window.__hkl_composer; const m = H.model, R = H.renderer;
const pb = R['pageBreaks'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 60000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const parseD = (d) => { const mm = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d || ''); if (!mm) return null; if (Math.abs(+mm[2] - +mm[4]) > 1e-6) return null; return { x1: +mm[1], x2: +mm[3] }; };
const span = (mEl) => { const st = mEl.querySelector(':scope > g.staff'); if (!st) return null; for (const p of Array.from(st.children)) { if (p.localName !== 'path') continue; const d = parseD(p.getAttribute('d')); if (d) return { x1: +d.x1.toFixed(0), x2: +d.x2.toFixed(0) }; } return null; };
const tk = R['spliceTk'];
const rows = (mei, opts) => {
  tk.setOptions(opts);
  if (!tk.loadData(mei)) return 'loadData failed';
  const sys = [];
  for (let p = 1; p <= tk.getPageCount(); p++) {
    const doc = new DOMParser().parseFromString(tk.renderToSVG(p, {}), 'image/svg+xml');
    Array.from(doc.querySelectorAll('g.system')).forEach((sy) => {
      const ms = Array.from(sy.querySelectorAll('g.measure'));
      if (!ms.length) return;
      const last = span(ms[ms.length - 1]);
      sys.push({ n: ms.length, right: last ? last.x2 : null });
    });
  }
  return { pages: tk.getPageCount(), sys };
};

const out = {};
const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', lightColorHex: '#fff', velocity: 80 };

/* ── case 1: two sections, several lines each ── */
m.setCursor(0, 1);
for (let i = 0; i < 24; i++) m.insertChordAtCursor({ notes: [A], duration: '1', dots: 0 });
m.setSectionHeaderAt(12, 'II');
H.reRender(); await waitFor(badgeHidden, 40000, 20);
for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { H.reRender(); await waitFor(badgeHidden, 40000, 20); }
const base = R['pageSpliceCtx']().liveOptions();
const pinned2 = R['pinnedMeiForCurrentModel']();
out.twoSection = {
  encoded_default: rows(pinned2, { ...base, breaks: 'encoded' }),
  encoded_mlj0: rows(pinned2, { ...base, breaks: 'encoded', minLastJustification: 0 }),
  line_default: rows(pinned2, { ...base, breaks: 'line' }),
  line_mlj0: rows(pinned2, { ...base, breaks: 'line', minLastJustification: 0 }),
};

/* ── case 2: the failing fixture's shape — 2 measures, section on the 2nd ── */
m.replaceDocument ? null : null;
const snap = m.snapshotState();
out.fixtureShape = 'built below';
/* rebuild from scratch by deleting everything is awkward; use a fresh doc via
   the same construction the fixture uses, on top of a cleared model. */
try {
  m.restoreSnapshot(snap);
} catch (e) { /* ignore */ }

/* ── case 3: SCROLL geometry — is justification a hazard there? ── */
const scrollOpts = R['buildOptions']('none', 'scroll');
out.scroll = {
  default: rows(pinned2, scrollOpts),
  mlj0: rows(pinned2, { ...scrollOpts, minLastJustification: 0 }),
};
/* the naturals-window options the line-break owner measures widths with */
out.naturalsGeomIsScroll = { pageWidth: scrollOpts.pageWidth, breaks: scrollOpts.breaks, adjustPageHeight: scrollOpts.adjustPageHeight };
out.pageWidthUsed = base.pageWidth;
return out;
