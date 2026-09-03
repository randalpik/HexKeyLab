// Phase 0 proof (2026-09-02): the courtesy-extension line becomes a one-measure
// STUB. Run on both code states and diff the outputs offline: for every sonata
// line (one deletion per line, restored between edits) record the splice
// outcome, the window shape, a hash of the window MEI, the Verovio cost of
// re-rendering the window, and for every window system its per-measure
// relX/width (text-based, like systemProfile), staff top and signature glyph
// codepoints. Expect: identical systems for L-1 / hunk / L+1 on both builds,
// byte-identical MEI where no extension fires, fewer measures where it does.
// Args: --arg "from=0,limit=58".
const H = window.__hkl_composer; const m = H.model, r = H.renderer, reRender = H.reRender;
const pb = r['pageBreaks'], ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 60000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const args = {}; for (const kv of String(window.__probeArg ?? '').split(',')) { const [k, v] = kv.split('='); if (k) args[k.trim()] = v === undefined ? '1' : v.trim(); }
const FROM = Math.max(0, Number(args.from ?? 0)), LIMIT = Number(args.limit ?? 1000);
await waitFor(() => pb['startIds'] !== null, 120000, 100); await waitFor(badgeHidden, 90000, 40);
const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
const tk = r['spliceTk']; const winOpts = r['pageSpliceCtx']().windowOptions;
const tf = (el) => { const t = el.getAttribute('transform') || ''; const mm = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(t); return mm ? { tx: +mm[1], ty: +mm[2] } : { tx: 0, ty: 0 }; };
const parseD = (d) => { const mm = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d || ''); if (!mm) return null; if (Math.abs(+mm[2] - +mm[4]) > 1e-6) return null; return { x1: +mm[1], y1: +mm[2], x2: +mm[3] }; };
const staffLine = (measureEl) => { const staff = measureEl.querySelector(':scope > g.staff'); if (!staff) return null; for (const p of Array.from(staff.children)) { if (p.localName !== 'path') continue; const d = parseD(p.getAttribute('d')); if (d) return { ...d, staff }; } return null; };
const sigGlyphs = (measureEl) => Array.from(measureEl.querySelectorAll('g.clef use, g.keySig use, g.meterSig use, g.clef text, g.keySig text, g.meterSig text')).map((n) => n.localName === 'use' ? (n.getAttribute('xlink:href') || n.getAttribute('href') || '').replace(/^#/, '').split('-')[0] : ((n.textContent || '').codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
const prof = (sys) => { const t = tf(sys); const ms = Array.from(sys.querySelectorAll('g.measure')); if (!ms.length) return null; const l0 = staffLine(ms[0]); if (!l0) return null; const st = tf(l0.staff); let top = Infinity; for (const p of Array.from(l0.staff.children)) { if (p.localName !== 'path') continue; const d = parseD(p.getAttribute('d')); if (d && d.y1 < top) top = d.y1; } return { start: ms[0].id, x0: +(l0.x1 + t.tx).toFixed(2), staffTop: +(top + st.ty + t.ty).toFixed(2), measures: ms.map((mm) => { const l = staffLine(mm); return { id: mm.id, relX: l ? +(l.x1 - l0.x1).toFixed(2) : null, w: l ? +(l.x2 - l.x1).toFixed(2) : null, sig: sigGlyphs(mm) }; }) }; };
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(16) + ':' + s.length; };
const mountAround = async (mi) => { if (!r['ensureTkHoldsPageLayout']()) return; const page = r['tk'].getPageWithElement(ids()[mi]); for (const p of [page - 1, page, page + 1]) if (p >= 1) r['mountPage'](p); await sleep(60); };
const out = { from: FROM, rows: [] };
const starts = pb['startIds'].slice();
let done = 0;
for (let k = FROM; k < starts.length && done < LIMIT; k++) {
  const idList = ids(); const mi = idList.indexOf(starts[k]) + 1; if (mi <= 0 || mi > idList.length) continue;
  const cur = m.getFirstVisualCursorInMeasure(1, mi, 'overwrite'); if (cur < 0) { out.rows.push({ line: k, skipped: 'no cursor' }); continue; }
  await mountAround(mi - 1);
  const snap = m.snapshotState();
  ps.lastOutcome = ''; ps.lastRun = null; ps.lastWindow = null; ps.lastWindowMei = null;
  m.setCursor(cur, 1); if (!m.deleteAtCursor()) { m.restoreSnapshot(snap); out.rows.push({ line: k, skipped: 'delete rejected' }); continue; }
  reRender(); await waitFor(badgeHidden, 60000, 10);
  const row = { line: k, mi, outcome: ps.lastOutcome, skip: ps.lastSkipReason, hunk: ps.lastHunk, window: ps.lastWindow, stats: ps.lastStats };
  if (ps.lastOutcome === 'spliced' && ps.lastWindowMei && ps.lastWindow) {
    row.meiHash = hash(ps.lastWindowMei);
    tk.setOptions(winOpts);
    let best = Infinity, pages = 0, svgs = [];
    for (let rep = 0; rep < 3; rep++) { const t0 = performance.now(); tk.loadData(ps.lastWindowMei); pages = tk.getPageCount(); svgs = []; for (let p = 1; p <= pages; p++) svgs.push(tk.renderToSVG(p, {})); const dt = performance.now() - t0; if (dt < best) best = dt; }
    row.verovioMs = +best.toFixed(1); row.windowPages = pages;
    /* One DOMParser document PER PAGE (two <svg> roots in one string is not XML). */
    row.systems = svgs.flatMap((svg, pi) => Array.from(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('g.system')).map((sys) => ({ ...prof(sys), page: pi + 1 })));
  }
  out.rows.push(row); done++;
  m.restoreSnapshot(snap); reRender(); await waitFor(badgeHidden, 60000, 10);
}
return out;
