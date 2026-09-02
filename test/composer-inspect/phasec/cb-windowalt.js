// Is the synthetic LEADER load-bearing for the replaced system's geometry, or
// only for the context gate's first-measure width? (2026-09-01, A thread.)
// Performs the cb-splicecost edit (Backspace mid-document), captures the
// splice window MEI, then re-renders it (a) as-is, (b) without the leader,
// (c) without leader and trailer, and compares, for the replaced system(s):
// per-measure x/width, staffTop relative to the context-above system, and the
// system bbox extents. Zero deltas mean the leader only serves the gate.
const H = window.__hkl_composer; const r = H.renderer, model = H.model;
const pb = r['pageBreaks'], ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 10) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null); await waitFor(badgeHidden, 90000, 40);
const miArg = String(window.__probeArg || '').match(/mi=(\d+)/)?.[1];
const measures = model.allMeasures().length; const MI = miArg ? Number(miArg) : Math.floor(measures / 2);
if (r['ensureTkHoldsPageLayout']()) { const ids = model.allMeasures().map((m) => m.getAttribute('xml:id')); const page = r['tk'].getPageWithElement(ids[MI]); for (const p of [page - 1, page, page + 1]) if (p >= 1) r['mountPage'](p); await sleep(80); }
let winOpts = null; const tkProto = Object.getPrototypeOf(r['tk']); const so = tkProto.setOptions; tkProto.setOptions = function (o) { if (this === r['spliceTk']) winOpts = o; return so.call(this, o); };
const cur = model.getFirstVisualCursorInMeasure(1, MI, 'overwrite'); model.setCursor(cur, 1);
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })); await waitFor(badgeHidden, 60000, 2);
/* winOpts now holds the LAST setOptions on spliceTk — after the splice that is the window options (the naturals render precedes it) */
tkProto.setOptions = so;
const out = { outcome: ps.lastOutcome, skip: ps.lastSkipReason, window: ps.lastWindow, run: ps.lastRun };
const mei = ps.lastWindowMei; if (!mei || !winOpts || ps.lastOutcome !== 'spliced') { out.error = 'no spliced window to test'; return out; }
const starts = pb['startIds']; const R = ps.lastRun; const W = ps.lastWindow;
const strip = (src, dropIds) => { const d = new DOMParser().parseFromString(src, 'application/xml'); const sec = d.querySelector('section'); for (const m of Array.from(d.querySelectorAll('measure'))) if (dropIds.has(m.getAttribute('xml:id'))) m.remove(); let ch = true; while (ch) { ch = false; for (const b of Array.from(d.querySelectorAll('sb, pb'))) { const nx = b.nextElementSibling; if (!nx || nx.localName === 'sb' || nx.localName === 'pb') { b.remove(); ch = true; } } } if (sec.firstElementChild && (sec.firstElementChild.localName === 'sb')) sec.firstElementChild.remove(); return new XMLSerializer().serializeToString(d); };
const variants = { full: mei, noLeader: strip(mei, new Set(['hkl-splice-lead'])), noLeadTrail: strip(mei, new Set(['hkl-splice-lead', 'hkl-splice-trail'])) };
const tk = r['spliceTk'];
const consolidate = (el) => { const b = el.transform?.baseVal?.consolidate?.(); return b ? { tx: b.matrix.e, ty: b.matrix.f } : { tx: 0, ty: 0 }; };
const profile = (sys) => { const t = consolidate(sys); const ms = Array.from(sys.querySelectorAll('g.measure')); const m0 = ms[0].getBBox(); const staff = ms[0].querySelector(':scope > g.staff'); const st = consolidate(staff); let top = Infinity; for (const p of Array.from(staff.querySelectorAll(':scope > path'))) { const b = p.getBBox(); if (b.y < top) top = b.y; } const sb = sys.getBBox(); return { start: ms[0].id, x0: m0.x + t.tx, staffTop: top + st.ty + t.ty, bboxTop: sb.y + t.ty, bboxBot: sb.y + sb.height + t.ty, measures: ms.map((m) => { const b = m.getBBox(); return { id: m.id, relX: +(b.x - m0.x).toFixed(1), w: +b.width.toFixed(1) }; }) }; };
const P = {};
for (const [name, v] of Object.entries(variants)) {
  tk.setOptions(winOpts); const t0 = performance.now(); const ok = tk.loadData(v); const loadMs = performance.now() - t0; const pages = tk.getPageCount();
  const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:-99999px;top:0'; const t1 = performance.now(); let svg = ''; for (let p = 1; p <= pages; p++) svg += tk.renderToSVG(p, {}); const renderMs = performance.now() - t1; host.innerHTML = svg; document.body.appendChild(host);
  const systems = Array.from(host.querySelectorAll('g.system')).map(profile); host.remove();
  P[name] = { ok, pages, loadMs: +loadMs.toFixed(1), renderMs: +renderMs.toFixed(1), systems: systems.map((s) => s.start), byStart: Object.fromEntries(systems.map((s) => [s.start, s])) };
}
out.timing = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, { ok: v.ok, pages: v.pages, loadMs: v.loadMs, renderMs: v.renderMs, systems: v.systems }]));
/* compare replaced systems (lines a..b) + the context-above system, relative to full */
const cmp = {};
for (const name of ['noLeader', 'noLeadTrail']) {
  const res = {};
  for (let k = Math.max(0, R.a - 1); k <= Math.min(starts.length - 1, R.b + 1); k++) {
    const id = starts[k]; const f = P.full.byStart[id], g = P[name].byStart[id]; if (!f || !g) { res[id] = 'missing'; continue; }
    const dx = g.measures.map((m, i) => +(m.relX - (f.measures[i]?.relX ?? NaN)).toFixed(1)); const dw = g.measures.map((m, i) => +(m.w - (f.measures[i]?.w ?? NaN)).toFixed(1));
    const above = k > 0 ? [P.full.byStart[starts[k - 1]], P[name].byStart[starts[k - 1]]] : null;
    res[id] = { role: k < R.a ? 'ctxAbove' : k > R.b ? 'ctxBelow' : 'REPLACED', dRelX_max: Math.max(...dx.map(Math.abs)), dW_max: Math.max(...dw.map(Math.abs)), dW: dw, dStaffTop_abs: +(g.staffTop - f.staffTop).toFixed(1), dSpacingFromAbove: above && above[0] && above[1] ? +((g.staffTop - above[1].staffTop) - (f.staffTop - above[0].staffTop)).toFixed(1) : null, dHeight: +((g.bboxBot - g.bboxTop) - (f.bboxBot - f.bboxTop)).toFixed(1) };
  }
  cmp[name] = res;
}
out.compare = cmp;
return out;
