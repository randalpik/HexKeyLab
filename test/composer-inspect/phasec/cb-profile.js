// Where does a page-view SPLICE edit's wall time actually go? (Max: "if we own
// layout and only make Verovio render a few systems, the lag should be like
// editing a song with a few systems — it isn't.")
//
// Instruments ONE steady-state spliced edit on the sonata by wrapping the hot
// primitives, so every bucket is attributed rather than guessed:
//   - Verovio loadData / renderToSVG (count + ms): the engraving we asked for
//   - XMLSerializer.serializeToString (count + ms + chars): whole-doc
//     serializes (history snapshots) vs per-measure sig diffs
//   - model.serialize (whole-doc): history + any render-path serialize
//   - PageLineBreaks.tryRefill, PageSystemSplicer.trySplice,
//     verifyRenderedPartition: our own passes
//   - getBBox / getBoundingClientRect counts: DOM measurement volume
// Anything left over is model mutation + DOM writes + the deferral frames.
//
// Runs a warm-up edit first so the measured one is steady-state (naturals
// cached where they can be), then reports both.
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
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;

/* ── instrumentation ── */
const B = {};
const bucket = (k) => (B[k] = B[k] || { ms: 0, n: 0, chars: 0 });
const wrap = (obj, name, key, charsOf) => {
  const orig = obj[name];
  if (!orig || orig.__wrapped) return () => {};
  const w = function (...args) {
    const b = bucket(key);
    const t = performance.now();
    try { return orig.apply(this, args); }
    finally {
      b.ms += performance.now() - t; b.n++;
      if (charsOf) { try { b.chars += charsOf(args) | 0; } catch {} }
    }
  };
  w.__wrapped = true;
  obj[name] = w;
  return () => { obj[name] = orig; };
};
const countOnly = (obj, name, key) => {
  const orig = obj[name];
  if (!orig || orig.__wrapped) return () => {};
  const w = function (...args) { bucket(key).n++; return orig.apply(this, args); };
  w.__wrapped = true;
  obj[name] = w;
  return () => { obj[name] = orig; };
};

const V = window.verovio;
const tkProto = Object.getPrototypeOf(r['tk']);
const restores = [
  wrap(tkProto, 'loadData', 'verovio.loadData', (a) => (a[0] || '').length),
  wrap(tkProto, 'renderToSVG', 'verovio.renderToSVG'),
  wrap(tkProto, 'setOptions', 'verovio.setOptions'),
  wrap(XMLSerializer.prototype, 'serializeToString', 'XMLSerializer.serializeToString'),
  wrap(model, 'serialize', 'model.serialize'),
  wrap(model, 'serializeRangeForRender', 'model.serializeRangeForRender'),
  wrap(model, 'allMeasures', 'model.allMeasures'),
  /* Phase boundaries: the keystroke's model mutation, the render entry, and
   * the post-render overlay work — so the "unaccounted" remainder stops being
   * a mystery bucket. */
  wrap(model, 'deleteAtCursor', 'model.deleteAtCursor (mutation)'),
  wrap(r, 'renderComposer', 'renderer.renderComposer'),
  wrap(H.cursor, 'update', 'cursor.update'),
  wrap(H.history, 'push', 'history.push (undo snapshot)'),
  wrap(model, 'normalizePlaceholdersAll', 'model.normalizePlaceholdersAll'),
  wrap(pb, 'tryRefill', 'PageLineBreaks.tryRefill'),
  wrap(pb, 'verifyRenderedPartition', 'PageLineBreaks.verifyRenderedPartition'),
  wrap(ps, 'trySplice', 'PageSystemSplicer.trySplice'),
  wrap(SVGGraphicsElement.prototype, 'getBBox', 'dom.getBBox'),
  wrap(Element.prototype, 'getBoundingClientRect', 'dom.getBoundingClientRect'),
  wrap(Element.prototype, 'querySelectorAll', 'dom.querySelectorAll'),
  wrap(Element.prototype, 'querySelector', 'dom.querySelector'),
  countOnly(Document.prototype, 'createElementNS', 'dom.createElementNS'),
];

const MI = 100;
const del = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
const runEdit = async (label) => {
  for (const k of Object.keys(B)) delete B[k];
  const cur = model.getFirstVisualCursorInMeasure(1, MI, 'overwrite');
  model.setCursor(cur, 1);
  const t0 = performance.now();
  del();
  await waitFor(badgeHidden, 60000, 5);
  const wall = performance.now() - t0;
  const buckets = {};
  for (const [k, v] of Object.entries(B)) {
    buckets[k] = v.ms ? { ms: +v.ms.toFixed(1), n: v.n, ...(v.chars ? { chars: v.chars } : {}) } : { n: v.n };
  }
  const accounted = ['PageLineBreaks.tryRefill', 'PageSystemSplicer.trySplice', 'PageLineBreaks.verifyRenderedPartition']
    .reduce((s, k) => s + (B[k] ? B[k].ms : 0), 0);
  return {
    label,
    wallMs: Math.round(wall),
    outcome: ps.lastOutcome,
    skip: ps.lastSkipReason,
    refillStats: { ...pb.lastRefillStats },
    spliceStats: { ...ps.lastStats },
    accountedByOurPassesMs: Math.round(accounted),
    unaccountedMs: Math.round(wall - accounted),
    buckets,
  };
};

/* Mount the pages around the edit — like a real session where the user has
 * scrolled to what they're editing (the IO keeps ±1 page live). Without this
 * the splice refuses ("context line below not mounted"). A FULL render rebuilds
 * the page grid and unmounts everything, so this must run before EVERY edit. */
const mountAroundEdit = async () => {
  if (!r['ensureTkHoldsPageLayout']()) return null;
  const ids0 = model.allMeasures().map((m) => m.getAttribute('xml:id'));
  const page = r['tk'].getPageWithElement(ids0[MI]);
  for (const p of [page - 1, page, page + 1]) if (p >= 1) r['mountPage'](p);
  await sleep(80);
  return page;
};
out.editPage = await mountAroundEdit();
out.totalPages = document.querySelectorAll('#score .score-page').length;

/* Edit 1 after a derive ALWAYS full-renders: the live DOM is the derive
 * render's justification (smartSb0), while windows now render 'encoded' — the
 * context check correctly refuses. From the pinned render on, splices work. */
out.firstAfterDerive = await runEdit('first edit after derive (expect full render)');
out.mountedPages = (await mountAroundEdit(), document.querySelectorAll('#score .score-page:not(.score-page-pending)').length);
out.steady = await runEdit('steady-state splice');
await mountAroundEdit();
out.steady2 = await runEdit('steady-state splice 2');

for (const undo of restores) undo();
return out;
