// Partition inputs dump (2026-10-19, partition F's Phase 0).
// Everything the partition function F reads, from the live document, as JSON:
// per-measure naturals, the leading-block width a line starting at each measure
// pays (`sigWForLine`), hard starts (a measure after an sb/pb — mirrors
// linebreaks.ts `hardStartIds`), render units (multirest runs), the justified
// budget, and the committed line and page starts. Consumed by
// test/balance/run.mjs (its sonata-inputs.json is this dump) and
// curve-batch.mjs. Read-only: no edit, no render.
const H = window.__hkl_composer; const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
/* A document that never takes ownership (one line) keeps startIds null; stop
   waiting once the render has settled anyway (test/corpus/batch-import.mjs runs hundreds). */
await waitFor(() => pb['startIds'] !== null || (!r.assemblyPending() && badgeHidden()));
/* Pages are committed by the assembler after the partition (setPageStarts). */
await waitFor(() => !r.assemblyPending(), 120000, 50); await waitFor(badgeHidden, 90000, 40);
const meas = model.allMeasures();
const ids = meas.map((m) => m.getAttribute('xml:id'));
const idx = new Map(ids.map((id, i) => [id, i]));
const nat = pb['naturals'];
const naturals = ids.map((id) => nat.get(id) ?? null);
const sig = ids.map((_, i) => pb['sigWForLine'](i));
const hard = [];
{
  const section = model.getDoc().querySelector('section');
  let pending = false;
  const walk = (el) => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'measure') { if (pending) hard.push(idx.get(c.getAttribute('xml:id'))); pending = false; }
      else if (c.localName === 'sb' || c.localName === 'pb') pending = true;
      else if (c.localName !== 'scoreDef' && c.querySelector('measure')) walk(c);
    }
  };
  if (section) walk(section);
}
const units = model.renderUnits(pb['viewStaves']);
const unitLo = ids.map((_, i) => units.unitOf(i)[0]);
const starts = (pb['startIds'] ?? []).map((id) => idx.get(id));
const pageStarts = (pb['pageStartIds'] ?? []).map((id) => idx.get(id));
return {
  measures: ids.length, budget: pb['budgetW'], naturals, sig, hard, unitLo, starts, pageStarts,
  missingNaturals: naturals.filter((x) => x == null).length,
  missingSig: sig.filter((x) => x == null).length,
  title: model.getDoc().querySelector('titleStmt title')?.textContent ?? null,
  /* For imported scores: what the import produced around the partition. */
  staves: model.getDoc().querySelector('scoreDef staffGrp') ? model.getDoc().querySelectorAll('scoreDef staffDef').length : null,
  sb: model.getDoc().querySelectorAll('section sb').length, pb: model.getDoc().querySelectorAll('section pb').length,
  viewMode: r['viewMode'] ?? null,
};
