// A4 gate: a zoom round-trip on an unchanged document must reuse the cached
// partition for that zoom instead of re-running Verovio's castoff pass.
//
// Instruments the DECISION POINTS directly — PageLineBreaks.restorePartition
// (cache hit) and adoptFromCastoff (real castoff) — rather than inferring from
// loadData counts, and hashes the whole partition so "same number of lines"
// can't be mistaken for "same partition".
//
// Sequence: 50 → 100 → 50 → 100, so EVERY step is a real zoom change (setZoom
// to the current zoom is a no-op and renders nothing). Then an edit, then
// another round-trip, to prove the document-version guard forces a castoff.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 60) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };

const out = { errs: [] };
const oe = console.error; console.error = (...a) => { out.errs.push(a.join(' ').slice(0, 200)); oe(...a); };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.error = oe; return out; }

let restores = 0, castoffs = 0;
const origRestore = pb.restorePartition.bind(pb);
pb.restorePartition = (...a) => { restores++; return origRestore(...a); };
const origAdopt = pb.adoptFromCastoff.bind(pb);
pb.adoptFromCastoff = (...a) => { castoffs++; return origAdopt(...a); };

const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; };

const step = async (label, zoom) => {
  restores = 0; castoffs = 0;
  const t0 = performance.now();
  r.setZoom(zoom);
  reRender();
  await waitFor(badgeHidden, 120000, 40);
  const lines = pb.lineStarts();
  return {
    label, zoom,
    wallMs: Math.round(performance.now() - t0),
    cacheHit: restores > 0,
    castoffRan: castoffs > 0,
    lines: lines.length,
    pages: pb.pageStarts().length,
    partitionHash: hash(lines.join('|')),
  };
};

out.a_50 = await step('50 (first visit)', 50);
out.b_100 = await step('100 (first visit)', 100);
out.c_50 = await step('50 (return — cache expected)', 50);
out.d_100 = await step('100 (return — cache expected)', 100);

out.roundTrip = {
  zoom50_partitionIdentical: out.a_50.partitionHash === out.c_50.partitionHash,
  zoom100_partitionIdentical: out.b_100.partitionHash === out.d_100.partitionHash,
  zoom50_secondVisitHitCache: out.c_50.cacheHit && !out.c_50.castoffRan,
  zoom100_secondVisitHitCache: out.d_100.cacheHit && !out.d_100.castoffRan,
  firstVisitsRanCastoff: out.a_50.castoffRan && out.b_100.castoffRan,
  zoom50_speedup: out.c_50.wallMs ? +(out.a_50.wallMs / out.c_50.wallMs).toFixed(2) : null,
  zoom100_speedup: out.d_100.wallMs ? +(out.b_100.wallMs / out.d_100.wallMs).toFixed(2) : null,
  /* Sanity: the two zooms must NOT produce the same partition — if they do, the
     cache key or the layout budget isn't actually zoom-dependent. */
  zoomsDiffer: out.a_50.partitionHash !== out.b_100.partitionHash,
  lines50: out.a_50.lines, lines100: out.b_100.lines,
};

/* Change the document, then round-trip again: the version guard must refuse the
   now-stale entries. */
model.setCursor(model.getMeasureStartCursor(1, 60), 1);
out.edited = model.deleteAtCursor();
reRender();
await waitFor(badgeHidden, 120000, 40);
out.e_50_afterEdit = await step('50 (after edit — stale, castoff expected)', 50);
out.f_100_afterEdit = await step('100 (after edit — stale, castoff expected)', 100);
out.staleEntriesReDerived =
  out.e_50_afterEdit.castoffRan && out.f_100_afterEdit.castoffRan;

pb.restorePartition = origRestore;
pb.adoptFromCastoff = origAdopt;
console.error = oe;
return out;
