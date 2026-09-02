// A-thread cost attribution for a steady-state one-note edit (2026-09-01):
// where the ~170 ms goes, at the granularity the three A items need.
//   1. A6 (flush-bound DOM work): every getBBox / getBoundingClientRect is
//      timed and tagged with the phase it ran in; a call over SLOW ms is a
//      forced layout flush and is reported with its call site.
//   2. Naturals window: loadData / renderToSVG / innerHTML parse / bbox reads
//      inside PageLineBreaks.measureWindow, with the window's measure count.
//   3. Window loadData: the captured window MEI is re-timed as three variants —
//      full, without leader/trailer, replaced lines only — to bound what a
//      minimal window would save.
// Buckets are `${phase}|${op}` (inclusive; phases nest: liveSys/spliceDom
// inside splice, naturals inside refill). `--arg "mi=<n>"` picks the measure.
const H = window.__hkl_composer; const r = H.renderer, model = H.model;
const pb = r['pageBreaks'], ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 10) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const spec = String(window.__probeArg || '');
const miArg = spec.match(/mi=(\d+)/)?.[1];
await waitFor(() => pb['startIds'] !== null); await waitFor(badgeHidden, 90000, 40);
const out = { measures: model.allMeasures().length, lines: pb['startIds'].length };

/* ── phase-tagged buckets ── */
let phase = 'other'; const phaseStack = [];
const enter = (p) => { phaseStack.push(phase); phase = p; };
const leave = () => { phase = phaseStack.pop() ?? 'other'; };
let B = {};
const bucket = (k) => (B[k] ??= { ms: 0, n: 0 });
const restores = [];
const wrapPhase = (obj, name, p) => { const o = obj && obj[name]; if (typeof o !== 'function') return; obj[name] = function (...a) { enter(p); const t = performance.now(); try { return o.apply(this, a); } finally { const b = bucket('phase|' + p); b.ms += performance.now() - t; b.n++; leave(); } }; restores.push(() => { obj[name] = o; }); };
const wrapTimed = (obj, name, label) => { const o = obj && obj[name]; if (typeof o !== 'function') return; obj[name] = function (...a) { const t = performance.now(); try { return o.apply(this, a); } finally { const b = bucket(phase + '|' + (typeof label === 'function' ? label.call(this) : label)); b.ms += performance.now() - t; b.n++; } }; restores.push(() => { obj[name] = o; }); };
const SLOW = 0.5; let slowCalls = [];
const site = () => (new Error().stack || '').split('\n').slice(3, 7).map((s) => s.trim().replace(/^at /, '').replace(/\(?https?:\/\/[^)\s]*\)?/g, '').trim()).filter(Boolean).join(' < ');
const wrapGeom = (proto, name) => { const o = proto[name]; proto[name] = function (...a) { const t = performance.now(); try { return o.apply(this, a); } finally { const d = performance.now() - t; const b = bucket(phase + '|' + name); b.ms += d; b.n++; if (d > SLOW) slowCalls.push({ phase, op: name, ms: +d.toFixed(2), site: site() }); } }; restores.push(() => { proto[name] = o; }); };
let winOpts = null;
const install = () => {
  wrapPhase(model, 'deleteAtCursor', 'mutate');
  wrapPhase(r, 'renderComposer', 'render');
  wrapPhase(pb, 'tryRefill', 'refill');
  wrapPhase(pb, 'measureWindow', 'naturals');
  wrapPhase(ps, 'trySplice', 'splice');
  wrapPhase(ps, 'spliceDom', 'spliceDom');
  wrapPhase(ps, 'liveSystem', 'liveSys');
  wrapPhase(r, 'snapSystems', 'snap');
  wrapPhase(r, 'postProcessRendered', 'post');
  wrapPhase(H.cursor, 'update', 'cursor');
  const tkProto = Object.getPrototypeOf(r['tk']);
  const inst = function () { return this === r['spliceTk'] ? 'spliceTk' : 'tk'; };
  wrapTimed(tkProto, 'loadData', function () { return inst.call(this) + '.loadData'; });
  wrapTimed(tkProto, 'renderToSVG', function () { return inst.call(this) + '.renderToSVG'; });
  wrapTimed(tkProto, 'getPageCount', function () { return inst.call(this) + '.getPageCount'; });
  const so = tkProto.setOptions; tkProto.setOptions = function (o) { if (phase === 'splice' && this === r['spliceTk']) winOpts = o; const t = performance.now(); try { return so.call(this, o); } finally { const b = bucket(phase + '|' + inst.call(this) + '.setOptions'); b.ms += performance.now() - t; b.n++; } }; restores.push(() => { tkProto.setOptions = so; });
  wrapTimed(model, 'serializeRangeForRender', 'serializeRangeForRender');
  wrapTimed(XMLSerializer.prototype, 'serializeToString', 'XMLSerializer');
  wrapTimed(DOMParser.prototype, 'parseFromString', 'DOMParser');
  wrapTimed(Element.prototype, 'querySelectorAll', 'querySelectorAll');
  wrapGeom(SVGGraphicsElement.prototype, 'getBBox');
  wrapGeom(SVGGraphicsElement.prototype, 'getScreenCTM');
  wrapGeom(Element.prototype, 'getBoundingClientRect');
  const ih = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(Element.prototype, 'innerHTML', { ...ih, set(v) { const t = performance.now(); ih.set.call(this, v); const b = bucket(phase + '|innerHTML.set'); b.ms += performance.now() - t; b.n++; } });
  restores.push(() => Object.defineProperty(Element.prototype, 'innerHTML', ih));
};
const uninstall = () => { while (restores.length) restores.pop()(); };

/* ── the edit: Backspace on a note mid-document, through the real input path ── */
const measures = model.allMeasures().length;
const MI = miArg ? Number(miArg) : Math.max(0, Math.floor(measures / 2));
out.editMeasure = MI;
const mountAround = async () => {
  if (!r['ensureTkHoldsPageLayout']()) return;
  const ids = model.allMeasures().map((m) => m.getAttribute('xml:id'));
  const page = r['tk'].getPageWithElement(ids[MI]);
  for (const p of [page - 1, page, page + 1]) if (p >= 1) r['mountPage'](p);
  await sleep(80);
};
const runEdit = async (label) => {
  B = {}; slowCalls = [];
  const cur = model.getFirstVisualCursorInMeasure(1, MI, 'overwrite');
  if (cur < 0) return { label, error: 'no cursor in measure ' + MI };
  model.setCursor(cur, 1);
  install();
  const t0 = performance.now();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
  await waitFor(badgeHidden, 60000, 2);
  const wall = performance.now() - t0;
  uninstall();
  const buckets = {};
  for (const [k, v] of Object.entries(B)) buckets[k] = { ms: +v.ms.toFixed(2), n: v.n };
  const phases = {}; for (const [k, v] of Object.entries(buckets)) if (k.startsWith('phase|')) phases[k.slice(6)] = v;
  const geomByPhase = {};
  for (const [k, v] of Object.entries(buckets)) { const [p, op] = k.split('|'); if (op === 'getBBox' || op === 'getBoundingClientRect') { const g = (geomByPhase[p] ??= { n: 0, ms: 0, slow: 0, slowMs: 0 }); g.n += v.n; g.ms = +(g.ms + v.ms).toFixed(2); } }
  for (const s of slowCalls) { const g = (geomByPhase[s.phase] ??= { n: 0, ms: 0, slow: 0, slowMs: 0 }); g.slow++; g.slowMs = +(g.slowMs + s.ms).toFixed(2); }
  return {
    label, wallMs: +wall.toFixed(1), outcome: ps.lastOutcome, skip: ps.lastSkipReason,
    spliceStats: ps.lastStats, refillStats: pb.lastRefillStats, window: ps.lastWindow, run: ps.lastRun, mounted: document.querySelectorAll('#score .score-page:not(.score-page-pending)').length,
    postStats: r['lastPostStats'] ?? null,
    phases, geomByPhase, slowCalls, buckets,
  };
};
await mountAround(); out.warmup = await runEdit('warm-up');
await mountAround(); out.steady1 = await runEdit('steady-1');
await mountAround(); out.steady2 = await runEdit('steady-2');

/* ── window variants: what would a smaller window cost? ── */
const mei = ps.lastWindowMei; const W = ps.lastWindow; const R = ps.lastRun; const starts = pb['startIds'];
out.variants = null;
if (mei && W && R && winOpts) {
  const allIds = model.allMeasures().map((m) => m.getAttribute('xml:id'));
  const s0 = allIds.indexOf(starts[R.a]); const s1 = R.b + 1 < starts.length ? allIds.indexOf(starts[R.b + 1]) - 1 : allIds.length - 1;
  const keep = new Set(allIds.slice(s0, s1 + 1));
  const strip = (src, drop) => {
    const doc = new DOMParser().parseFromString(src, 'application/xml');
    for (const m of Array.from(doc.querySelectorAll('measure'))) if (drop(m.getAttribute('xml:id'))) m.remove();
    for (const e of Array.from(doc.querySelectorAll('ending'))) if (!e.querySelector('measure')) e.remove();
    let changed = true; while (changed) { changed = false; for (const b of Array.from(doc.querySelectorAll('sb, pb'))) { const nx = b.nextElementSibling; if (!nx || nx.localName === 'sb' || nx.localName === 'pb') { b.remove(); changed = true; } } }
    return new XMLSerializer().serializeToString(doc);
  };
  const variants = { full: mei, noLeadTrail: strip(mei, (id) => id === 'hkl-splice-lead' || id === 'hkl-splice-trail'), replacedOnly: strip(mei, (id) => !keep.has(id)) };
  const tk = r['spliceTk']; const res = {};
  for (const [name, v] of Object.entries(variants)) {
    const loads = [], renders = []; let pages = 0, ok = true;
    for (let i = 0; i < 4; i++) {
      tk.setOptions(winOpts);
      const t0 = performance.now(); ok = tk.loadData(v) && ok; loads.push(performance.now() - t0);
      pages = tk.getPageCount();
      const t1 = performance.now(); for (let p = 1; p <= pages; p++) tk.renderToSVG(p, {}); renders.push(performance.now() - t1);
    }
    const med = (a) => { const s = a.slice(1).sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(1); };   // drop the first (cold) run
    res[name] = { ok, measures: (v.match(/<measure\b/g) || []).length, bytes: v.length, pages, loadMs: med(loads), renderMs: med(renders), loads: loads.map((x) => +x.toFixed(1)) };
  }
  out.variants = res; out.replacedMeasures = s1 - s0 + 1;
}
return out;
