// Apply an arbitrary line partition to the live page view (2026-10-20,
// partition spec Phase 0 — screenshots of candidate partitions). `--arg` is a
// comma list of line-start measure INDICES (0-based, document order). The
// owner adopts the lines (`replacePartition`, no pages) and the document is
// re-assembled without reseeding, so the PageAssembler paginates the given
// lines first-fit. Reports
// the committed lines (must equal the request) and, for the measures named
// in `window.__probeTargets` (optional), their page and @n.
const H = window.__hkl_composer; const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
await waitFor(() => pb['startIds'] !== null); await waitFor(() => !r.assemblyPending());
const ids = model.allMeasures().map((m) => m.getAttribute('xml:id'));
const want = String(window.__probeArg || '').split(',').filter(Boolean).map(Number);
const out = { requested: want.length };
if (want.length) {
  const lines = want.map((i) => ids[i]);
  out.replaced = pb.replacePartition(model, lines, []);
  if (out.replaced) {
    r['assembleDocument'](model, r['viewStaves'], false);
    await waitFor(() => !r.assemblyPending());
    pb.verifyRenderedPartition(r['container'], model, r['assembler']?.pageCount ?? 1, r['pageBreaksCtx']());
    r['rememberPartition'](model);
  }
}
window.__injectedLines = want.length ? want : null;
const idx = new Map(ids.map((id, i) => [id, i]));
out.lines = pb.lineStarts().map((id) => idx.get(id));
out.linesMatch = !want.length || out.lines.join() === want.join();
out.pages = pb.pageStarts().map((id) => idx.get(id));
return out;
