// Section balancer probe (2026-09-05; idle job removed 2026-09-18). After the
// sonata loads: the SYNC balance the derive ran before the first paint
// (lastInitialBalance) — which now covers the WHOLE document, so there is no
// job to wait for and nothing may move after the paint — then per-section line
// counts and fills (naturals are measured for anything still uncached, so the
// table is complete), the final line of every section, whether page 1's measure
// set changed after the paint (it must not), and every
// [page-balance]/[page-breaks] console notice. Run with the sonata (default).
const H = window.__hkl_composer; const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const notices = []; window.addEventListener('error', (e) => notices.push('UNCAUGHT: ' + e.message + ' @ ' + String(e.filename).split('/').pop() + ':' + e.lineno + ':' + e.colno + ' ' + String(e.error && e.error.stack).split('\n').slice(0, 4).join(' | '))); window.addEventListener('unhandledrejection', (e) => notices.push('REJECTION: ' + String(e.reason)));
for (const lvl of ['warn', 'info', 'error']) { const orig = console[lvl].bind(console); console[lvl] = (...a) => { const s = a.map(String).join(' '); if (/page-balance|page-breaks|page-splice|page-fit/.test(s)) notices.push(lvl + ': ' + s.slice(0, 160)); orig(...a); }; }
await waitFor(() => pb['startIds'] !== null); await waitFor(badgeHidden, 90000, 40);
const p1 = () => [...document.querySelectorAll('.score-page[data-page="1"] g.measure')].map((m) => m.id).join(',');
const p1AfterPaint = p1();
const initial = pb.lastInitialBalance ? JSON.parse(JSON.stringify(pb.lastInitialBalance)) : null;
const linesAfterPaint = pb['startIds'].length, pagesAfterPaint = pb['pageStartIds'].length;
/* Nothing runs after the paint any more; re-read page 1 to PROVE it. */
await waitFor(badgeHidden, 30000, 40);
const p1AfterJob = p1();
/* Section table from cached naturals; measure whatever is still missing. */
const meiMeasures = model.allMeasures(); const ids = meiMeasures.map((m) => m.getAttribute('xml:id'));
const idIdx = new Map(ids.map((id, i) => [id, i]));
const starts = pb['startIds'].map((id) => idIdx.get(id));
const hard = new Set(); { const section = model.getDoc().querySelector('section'); let pending = false;
  const walk = (el) => { for (const c of Array.from(el.children)) { if (c.localName === 'measure') { if (pending) hard.add(c.getAttribute('xml:id')); pending = false; } else if (c.localName === 'sb' || c.localName === 'pb') pending = true; else if (c.localName !== 'scoreDef' && c.querySelector('measure')) walk(c); } }; walk(section); }
const ctx = r['pageBreaksCtx'](); const budget = pb['budgetW'] > 0 ? pb['budgetW'] : ctx.budgetW();
const nat = pb['naturals']; let measuredForProbe = 0;
for (let lo = 0; lo < ids.length; lo += 120) { const hi = Math.min(ids.length - 1, lo + 119); let need = false; for (let i = lo; i <= hi; i++) if (!nat.has(ids[i])) { need = true; break; } if (!need) continue; const w = pb['measureWindow'](model, meiMeasures, ids, lo, hi, ctx); measuredForProbe += hi - lo + 1; if (!w) return { error: 'probe window failed at ' + lo }; }
const sigW = pb['sigW'];
const fillOf = (k) => { const from = starts[k], to = k + 1 < starts.length ? starts[k + 1] : ids.length; let acc = sigW; for (let i = from; i < to; i++) acc += nat.get(ids[i]) ?? 0; return acc / budget; };
const sections = []; let cur = null;
for (let k = 0; k < starts.length; k++) { if (k === 0 || hard.has(ids[starts[k]])) { cur = { firstLine: k, lines: 0, measures: 0, fills: [] }; sections.push(cur); } cur.lines++; cur.measures += (k + 1 < starts.length ? starts[k + 1] : ids.length) - starts[k]; cur.fills.push(+fillOf(k).toFixed(3)); }
for (const s of sections) { const f = s.fills; const mu = f.reduce((a, b) => a + b, 0) / f.length; s.min = Math.min(...f); s.max = Math.max(...f); s.mean = +mu.toFixed(3); s.sd = +Math.sqrt(f.reduce((a, b) => a + (b - mu) ** 2, 0) / f.length).toFixed(3); s.last = f[f.length - 1]; s.fillsRounded = f.map((x) => Math.round(x * 100)); delete s.fills; }
return {
  budget: Math.round(budget), sigFill: +(sigW / budget).toFixed(3),
  afterPaint: { lines: linesAfterPaint, pages: pagesAfterPaint, initialBalance: initial },
  settled: { lines: pb['startIds'].length, pages: pb['pageStartIds'].length, page1Changed: p1AfterPaint !== p1AfterJob, lastBalance: pb.lastBalance },
  sections, measuredForProbe, notices,
};
