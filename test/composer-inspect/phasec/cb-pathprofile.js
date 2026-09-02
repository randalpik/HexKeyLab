// A11 proof (2026-09-02): can the page splicer read its window geometry from
// the SVG TEXT (staff-line paths + transforms) instead of laying the host out?
// Drives real deletions on the sonata (one per line, stride/limit args), and
// for every splice re-renders the captured window MEI and computes, for each
// window system AND its pre-edit live counterpart, two profiles:
//   B  bbox-based  — exactly what systemProfile() reads today (getBBox)
//   P  path-based  — first staff's horizontal line path: x1..x2 per measure,
//                    its y for the staff top, plus staff/system transforms
// Reports per edit: the context-gate deltas (window vs pre-edit live, per
// measure relX/w) under B and under P; the internal B-vs-P disagreement on each
// side; the placement dx/dy the surgery would compute under B and under P; and
// aggregates. Args: --arg "stride=3,limit=36,from=1,edit=delete|key".
const H = window.__hkl_composer; const m = H.model, r = H.renderer, reRender = H.reRender;
const pb = r['pageBreaks'], ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 60000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const args = {}; for (const kv of String(window.__probeArg ?? '').split(',')) { const [k, v] = kv.split('='); if (k) args[k.trim()] = v === undefined ? '1' : v.trim(); }
const STRIDE = Math.max(1, Number(args.stride ?? 3)), LIMIT = Number(args.limit ?? 36), FROM = Math.max(1, Number(args.from ?? 1));
const EDIT = args.edit ?? 'delete';   // 'delete' (one note) | 'key' (key change at the line start: a governed multi-line range)
await waitFor(() => pb['startIds'] !== null, 120000, 100); await waitFor(badgeHidden, 90000, 40);
const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
const tk = r['spliceTk']; const winOpts = r['pageSpliceCtx']().windowOptions;
const tf = (el) => { const b = el.transform && el.transform.baseVal && el.transform.baseVal.consolidate(); return b ? { tx: b.matrix.e, ty: b.matrix.f } : { tx: 0, ty: 0 }; };
const parseD = (d) => { const mm = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d || ''); return mm ? { x1: +mm[1], y1: +mm[2], x2: +mm[3], y2: +mm[4] } : null; };
const staffLine = (measureEl) => { const staff = measureEl.querySelector('g.staff'); if (!staff) return null; for (const p of Array.from(staff.children)) { if (p.localName !== 'path') continue; const d = parseD(p.getAttribute('d')); if (d && Math.abs(d.y1 - d.y2) < 1e-6) return { ...d, staff }; } return null; };
/* B: today's systemProfile (needs layout) */
const profB = (sys) => {
  const t = tf(sys); const ms = Array.from(sys.querySelectorAll('g.measure')); if (!ms.length) return null;
  const m0 = ms[0].getBBox(); const staff = ms[0].querySelector(':scope > g.staff'); if (!staff) return null; const st = tf(staff);
  let top = Infinity; for (const p of Array.from(staff.querySelectorAll(':scope > path'))) { try { const b = p.getBBox(); if (b.y < top) top = b.y; } catch {} }
  if (!isFinite(top)) return null;
  return { start: ms[0].id, x0: m0.x + t.tx, staffTop: top + st.ty + t.ty, measures: ms.map((mm) => { const b = mm.getBBox(); return { id: mm.id, relX: b.x - m0.x, w: b.width }; }) };
};
/* P: text-only */
const profP = (sys) => {
  const t = tf(sys); const ms = Array.from(sys.querySelectorAll('g.measure')); if (!ms.length) return null;
  const l0 = staffLine(ms[0]); if (!l0) return null; const st = tf(l0.staff);
  let top = Infinity; for (const p of Array.from(l0.staff.children)) { if (p.localName !== 'path') continue; const d = parseD(p.getAttribute('d')); if (d && Math.abs(d.y1 - d.y2) < 1e-6 && d.y1 < top) top = d.y1; }
  const out = []; for (const mm of ms) { const l = staffLine(mm); if (!l) return null; out.push({ id: mm.id, relX: l.x1 - l0.x1, w: l.x2 - l.x1 }); }
  return { start: ms[0].id, x0: l0.x1 + t.tx, staffTop: top + st.ty + t.ty, measures: out };
};
const cmpMeasures = (a, b) => { if (!a || !b) return null; if (a.measures.length !== b.measures.length) return { count: `${a.measures.length}/${b.measures.length}` }; let mx = 0, mw = 0, worst = null; for (let i = 0; i < a.measures.length; i++) { const dx = Math.abs(a.measures[i].relX - b.measures[i].relX), dw = Math.abs(a.measures[i].w - b.measures[i].w); if (dx > mx) mx = dx; if (dw > mw) { mw = dw; worst = a.measures[i].id; } } return { maxRelX: +mx.toFixed(2), maxW: +mw.toFixed(2), worst }; };
const liveSys = (startId) => { const el = document.getElementById(startId); const sys = el && el.closest('g.system'); return sys && sys.querySelector('g.measure') && sys.querySelector('g.measure').id === startId ? sys : null; };
const mountAround = async (mi) => { if (!r['ensureTkHoldsPageLayout']()) return; const page = r['tk'].getPageWithElement(ids()[mi]); for (const p of [page - 1, page, page + 1]) if (p >= 1) r['mountPage'](p); await sleep(60); };
const out = { stride: STRIDE, rows: [], agg: null };
const starts = pb['startIds'].slice();
let done = 0;
for (let k = FROM; k < starts.length - 1 && done < LIMIT; k += STRIDE) {
  const idList = ids(); const mi = EDIT === 'key' ? idList.indexOf(starts[k]) : idList.indexOf(starts[k]) + 1; if (mi <= 0 || mi >= idList.length) continue;
  const cur = EDIT === 'key' ? 0 : m.getFirstVisualCursorInMeasure(1, mi, 'overwrite'); if (cur < 0) continue;
  await mountAround(mi);
  /* pre-edit live profiles for every mounted system, both bases */
  const liveB = new Map(), liveP = new Map();
  for (const sys of Array.from(document.querySelectorAll('#score .score-page:not(.score-page-pending) g.system'))) { const first = sys.querySelector('g.measure'); if (!first) continue; liveB.set(first.id, profB(sys)); liveP.set(first.id, profP(sys)); }
  const snap = m.snapshotState();
  ps.lastOutcome = ''; ps.lastRun = null; ps.lastWindow = null; ps.lastWindowMei = null;
  if (EDIT === 'key') { m.setKeySigAt(mi, '3s', 'major'); } else { m.setCursor(cur, 1); if (!m.deleteAtCursor()) { m.restoreSnapshot(snap); continue; } }
  reRender(); await waitFor(badgeHidden, 60000, 10);
  const row = { line: k, mi, outcome: ps.lastOutcome, skip: ps.lastSkipReason };
  if (ps.lastOutcome === 'spliced' && ps.lastWindowMei && ps.lastWindow) {
    const W = ps.lastWindow, R = ps.lastRun, newStarts = pb['startIds'];
    tk.setOptions(winOpts); tk.loadData(ps.lastWindowMei); const pages = tk.getPageCount();
    let svg = ''; for (let p = 1; p <= pages; p++) svg += tk.renderToSVG(p, {});
    const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:-99999px;top:0'; host.innerHTML = svg; document.body.appendChild(host);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const winSysB = Array.from(host.querySelectorAll('g.system')), winSysP = Array.from(doc.querySelectorAll('g.system'));
    const lines = [];
    for (let li = W.wLo; li <= W.wHi; li++) {
      const idx = (W.leader ? 1 : 0) + (li - W.wLo); const sB = winSysB[idx], sP = winSysP[idx]; if (!sB || !sP) { lines.push({ li, missing: true }); continue; }
      const wB = profB(sB), wP = profP(sP); const startId = newStarts[li]; const lB = liveB.get(startId), lP = liveP.get(startId);
      const role = li < R.a ? 'ctxAbove' : li > R.b ? 'ctxBelow' : 'REPLACED';
      lines.push({ li, role, start: startId,
        winInternal: cmpMeasures(wB, wP), liveInternal: cmpMeasures(lB, lP),
        gateB: cmpMeasures(wB, lB), gateP: cmpMeasures(wP, lP),
        staffTop: { winB: wB && +wB.staffTop.toFixed(2), winP: wP && +wP.staffTop.toFixed(2), liveB: lB && +lB.staffTop.toFixed(2), liveP: lP && +lP.staffTop.toFixed(2) },
        dx: lB && wB && lP && wP ? { B: +(lB.x0 - wB.x0).toFixed(2), P: +(lP.x0 - wP.x0).toFixed(2) } : null,
        dy: lB && wB && lP && wP ? { B: +(lB.staffTop - wB.staffTop).toFixed(2), P: +(lP.staffTop - wP.staffTop).toFixed(2) } : null });
    }
    host.remove();
    row.window = { lines: W.wHi - W.wLo + 1, measures: W.mHi - W.mLo + 1, run: R }; row.lines = lines;
  }
  out.rows.push(row); done++;
  m.restoreSnapshot(snap); reRender(); await waitFor(badgeHidden, 60000, 10);
}
/* aggregates over all lines of all spliced edits */
const agg = { edits: out.rows.length, spliced: out.rows.filter((x) => x.outcome === 'spliced').length, ctxLines: 0, gateB: { maxRelX: 0, maxW: 0 }, gateP: { maxRelX: 0, maxW: 0 }, winInternal: { maxRelX: 0, maxW: 0, n: 0 }, liveInternal: { maxRelX: 0, maxW: 0, n: 0 }, staffTopBvsP: { win: 0, live: 0 }, dxBvsP: 0, dyBvsP: 0, outliers: [] };
for (const row of out.rows) for (const l of row.lines || []) {
  if (l.missing) continue;
  const up = (acc, c) => { if (!c || c.count) return; acc.maxRelX = Math.max(acc.maxRelX, c.maxRelX); acc.maxW = Math.max(acc.maxW, c.maxW); if ('n' in acc) acc.n++; };
  up(agg.winInternal, l.winInternal); up(agg.liveInternal, l.liveInternal);
  if (l.role !== 'REPLACED') { agg.ctxLines++; up(agg.gateB, l.gateB); up(agg.gateP, l.gateP); }
  if (l.staffTop.winB != null && l.staffTop.winP != null) agg.staffTopBvsP.win = Math.max(agg.staffTopBvsP.win, Math.abs(l.staffTop.winB - l.staffTop.winP));
  if (l.staffTop.liveB != null && l.staffTop.liveP != null) agg.staffTopBvsP.live = Math.max(agg.staffTopBvsP.live, Math.abs(l.staffTop.liveB - l.staffTop.liveP));
  if (l.dx) { const d = Math.abs(l.dx.B - l.dx.P); agg.dxBvsP = Math.max(agg.dxBvsP, d); if (d > 0.5) agg.outliers.push({ line: row.line, li: l.li, role: l.role, kind: 'dx', B: l.dx.B, P: l.dx.P }); }
  if (l.dy) { const d = Math.abs(l.dy.B - l.dy.P); agg.dyBvsP = Math.max(agg.dyBvsP, d); if (d > 0.5) agg.outliers.push({ line: row.line, li: l.li, role: l.role, kind: 'dy', B: l.dy.B, P: l.dy.P }); }
  if (l.role !== 'REPLACED' && l.gateP && !l.gateP.count && (l.gateP.maxRelX > 0.5 || l.gateP.maxW > 0.5)) agg.outliers.push({ line: row.line, li: l.li, role: l.role, kind: 'gateP', gateP: l.gateP, gateB: l.gateB });
}
out.agg = agg;
return out;
