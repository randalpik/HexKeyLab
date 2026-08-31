// Which per-edit costs SCALE with document length, and which are flat?
// (Max: "if we can truly get O(edit), what's the remaining difference between
// a single page and 37?")
//
// Runs the SAME instrumented edit — Backspace on a note mid-document, through
// the real input path, measuring the second (steady-state) one — on three
// document sizes:
//   --arg empty   one measure of quarters (the floor)
//   --arg page    ~one page of content
//   --arg sonata  the imported 446-bar score (run WITHOUT --no-sonata)
// Buckets are identical across runs, so the comparison is bucket-by-bucket.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 20) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const spec = String(window.__probeArg || 'page');
const [which, miArg] = spec.split(':');
const out = { doc: which };

/* ── build the requested document ── */
const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
if (which !== 'sonata') {
  const n = which === 'empty' ? 4 : 64;   // 1 measure vs ~16 measures (~1 page)
  model.setCursor(0, 1);
  for (let i = 0; i < n; i++) {
    const high = (Math.floor(i / 4) % 2) === 0;
    model.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
  }
  H.reRender();
  await waitFor(badgeHidden);
  await sleep(300);
}

const measures = model.allMeasures().length;
out.measures = measures;
out.pagesInDom = document.querySelectorAll('#score .score-page').length;
out.mountedPages = document.querySelectorAll('#score .score-page:not(.score-page-pending)').length;
out.svgElements = document.querySelectorAll('#score svg *').length;
out.lines = pb['startIds'] ? pb['startIds'].length : 0;
out.ownershipActive = pb.ownershipActive();

/* ── instrumentation (same wrappers as cb-profile) ── */
const B = {};
const bucket = (k) => (B[k] = B[k] || { ms: 0, n: 0 });
const wrap = (obj, name, key) => {
  const orig = obj[name];
  if (!orig || orig.__wrapped) return () => {};
  const w = function (...args) {
    const b = bucket(key);
    const t = performance.now();
    try { return orig.apply(this, args); } finally { b.ms += performance.now() - t; b.n++; }
  };
  w.__wrapped = true;
  obj[name] = w;
  return () => { obj[name] = orig; };
};
const tkProto = Object.getPrototypeOf(r['tk']);
const restores = [
  wrap(tkProto, 'loadData', 'verovio.loadData'),
  wrap(tkProto, 'renderToSVG', 'verovio.renderToSVG'),
  wrap(XMLSerializer.prototype, 'serializeToString', 'XMLSerializer.serializeToString'),
  wrap(model, 'serialize', 'model.serialize'),
  wrap(model, 'allMeasures', 'model.allMeasures'),
  wrap(model, 'deleteAtCursor', 'model.deleteAtCursor'),
  wrap(model, 'normalizePlaceholdersAll', 'model.normalizePlaceholdersAll'),
  wrap(r, 'renderComposer', 'renderer.renderComposer'),
  wrap(H.cursor, 'update', 'cursor.update'),
  wrap(pb, 'tryRefill', 'PageLineBreaks.tryRefill'),
  wrap(ps, 'trySplice', 'PageSystemSplicer.trySplice'),
  wrap(SVGGraphicsElement.prototype, 'getBBox', 'dom.getBBox'),
  wrap(Element.prototype, 'getBoundingClientRect', 'dom.getBoundingClientRect'),
  wrap(Element.prototype, 'querySelectorAll', 'dom.querySelectorAll'),
];

/* Edit target: a note around the middle of the document. */
const MI = miArg ? Number(miArg) : Math.max(0, Math.floor(measures / 2));
out.editMeasure = MI;
const mountAround = async () => {
  if (!r['ensureTkHoldsPageLayout']()) return;
  const ids = model.allMeasures().map((m) => m.getAttribute('xml:id'));
  const page = r['tk'].getPageWithElement(ids[MI]);
  for (const p of [page - 1, page, page + 1]) if (p >= 1) r['mountPage'](p);
  await sleep(60);
};

const runEdit = async (label) => {
  for (const k of Object.keys(B)) delete B[k];
  const cur = model.getFirstVisualCursorInMeasure(1, MI, 'overwrite');
  if (cur < 0) return { label, error: 'no cursor in measure ' + MI };
  model.setCursor(cur, 1);
  const before = model.getDoc().querySelectorAll('note').length;
  const t0 = performance.now();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
  await waitFor(badgeHidden, 60000, 5);
  const wall = performance.now() - t0;
  const buckets = {};
  for (const [k, v] of Object.entries(B)) buckets[k] = { ms: +v.ms.toFixed(1), n: v.n };
  return {
    label, wallMs: Math.round(wall),
    deleted: before - model.getDoc().querySelectorAll('note').length,
    outcome: ps.lastOutcome, skip: ps.lastSkipReason,
    buckets,
  };
};

await mountAround();
out.warmup = await runEdit('warm-up');
await mountAround();
out.steady = await runEdit('steady-state');
for (const undo of restores) undo();
return out;
