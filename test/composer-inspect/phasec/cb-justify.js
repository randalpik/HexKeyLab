// End-of-document vs end-of-section justification parity, and which Verovio
// option governs it. Builds a two-section document, renders it under the
// PAINTED strategy ('encoded', what pageVirt uses) and the gate's ('line'),
// and reports every system's width plus which section it ends.
// Run with --no-sonata.
const H = window.__hkl_composer; const m = H.model, R = H.renderer;
const pb = R['pageBreaks'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 60000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const parseD = (d) => { const mm = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d || ''); if (!mm) return null; if (Math.abs(+mm[2] - +mm[4]) > 1e-6) return null; return { x1: +mm[1], x2: +mm[3] }; };
const span = (mEl) => { const st = mEl.querySelector(':scope > g.staff'); if (!st) return null; for (const p of Array.from(st.children)) { if (p.localName !== 'path') continue; const d = parseD(p.getAttribute('d')); if (d) return { x1: +d.x1.toFixed(0), x2: +d.x2.toFixed(0) }; } return null; };

const out = {};
/* 1 — Verovio's own option surface, filtered. */
try {
  const raw = R['spliceTk'].getAvailableOptions();
  const all = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const hits = {};
  const walk = (o, path) => {
    for (const k of Object.keys(o || {})) {
      const v = o[k];
      if (/justif|last|stretch|fill/i.test(k)) hits[path + k] = (v && typeof v === 'object' && 'default' in v) ? { default: v.default, min: v.min, max: v.max, description: String(v.description || '').slice(0, 120) } : v;
      if (v && typeof v === 'object' && !('default' in v)) walk(v, path + k + '.');
    }
  };
  walk(all, '');
  out.options = hits;
} catch (e) { out.options = 'unavailable: ' + e; }

/* 2 — a two-section document. */
m.setCursor(0, 1);
const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', lightColorHex: '#fff', velocity: 80 };
for (let i = 0; i < 24; i++) m.insertChordAtCursor({ notes: [A], duration: '1', dots: 0 });
m.setSectionHeaderAt(12, 'II');
H.reRender(); await waitFor(badgeHidden, 40000, 20);
for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { H.reRender(); await waitFor(badgeHidden, 40000, 20); }
out.owned = pb.ownershipActive();
out.paginationOwned = pb.paginationOwned();
out.lines = (pb['startIds'] || []).length;
out.pages = pb.pageStarts().length;

const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
const sectionStart = ids[12];
const lastId = ids[ids.length - 1];
const pinned = R['pinnedMeiForCurrentModel']();
const tk = R['spliceTk'];
const measureRows = (opts, label) => {
  tk.setOptions(opts);
  if (!tk.loadData(pinned)) return { label, error: 'loadData failed' };
  const sys = [];
  for (let p = 1; p <= tk.getPageCount(); p++) {
    const doc = new DOMParser().parseFromString(tk.renderToSVG(p, {}), 'image/svg+xml');
    Array.from(doc.querySelectorAll('g.system')).forEach((sy) => {
      const ms = Array.from(sy.querySelectorAll('g.measure'));
      if (!ms.length) return;
      const first = span(ms[0]), last = span(ms[ms.length - 1]);
      sys.push({
        page: p, n: ms.length,
        firstId: ms[0].id.slice(-6), lastId: ms[ms.length - 1].id.slice(-6),
        right: last ? last.x2 : null,
        endsSection: ms.some((x) => x.id === ids[11]),
        endsDoc: ms.some((x) => x.id === lastId),
        startsSection: ms[0].id === sectionStart,
      });
    });
  }
  return { label, pages: tk.getPageCount(), sys };
};
const base = R['pageSpliceCtx']().liveOptions();
out.encoded = measureRows({ ...base, breaks: 'encoded' }, 'encoded (painted)');
out.line = measureRows({ ...base, breaks: 'line' }, 'line (gate)');
out.domNow = Array.from(document.querySelectorAll('#score .score-page g.system')).map((sy) => { const ms = Array.from(sy.querySelectorAll('g.measure')); const last = ms.length ? span(ms[ms.length - 1]) : null; return { n: ms.length, lastId: ms.length ? ms[ms.length - 1].id.slice(-6) : null, right: last ? last.x2 : null }; });
return out;
