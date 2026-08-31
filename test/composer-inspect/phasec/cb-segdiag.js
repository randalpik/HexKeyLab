// Where does castoffSegmentedByUserBreaks bail? Calls the private pieces
// directly with a user <pb> in place and reports each step's result.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 60) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const pbo = r['pageBreaks'];
const out = { errs: [] };
const oe = console.error; console.error = (...a) => { out.errs.push(a.join(' ').slice(0,160)); oe(...a); };
out.adopted = await waitFor(() => pbo['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.error = oe; return out; }

model.togglePageBreakAt(60);
const measures = model.allMeasures();
out.breakId = measures[60]?.getAttribute('xml:id') ?? null;

/* Is the <pb> where my walk expects it? */
const section = model.getDoc().querySelector('section');
out.sectionChildKinds = {};
for (const c of Array.from(section.children)) {
  out.sectionChildKinds[c.localName] = (out.sectionChildKinds[c.localName] || 0) + 1;
}
const pbEls = Array.from(model.getDoc().querySelectorAll('pb'));
out.pbCount = pbEls.length;
out.pbParents = pbEls.map((e) => e.parentElement?.localName);
out.pbNextSiblings = pbEls.map((e) => {
  const n = e.nextElementSibling;
  return n ? n.localName + '#' + (n.getAttribute('xml:id') || '') : null;
});

out.userPageBreakIndices = r['userPageBreakIndices'](model);

const heji = { hejiEnabled: model.getHejiEnabled() };
const mei = model.serialize(heji, null);
const baked = r['layoutBreaksWithLines'](mei);
out.bakedLineCount = baked.lines.length;
out.bakedHasBreakId = baked.lines.includes(out.breakId);

/* Replicate the segment loop, reporting per-segment outcomes. */
const ids = measures.map((m) => m.getAttribute('xml:id') ?? '');
const idxOf = new Map(); ids.forEach((id,i)=>{ if(id) idxOf.set(id,i); });
const breaks = out.userPageBreakIndices;
const bounds = []; let from = 0;
for (const b of breaks) { if (b <= from || b >= ids.length) continue; bounds.push([from, b-1]); from = b; }
bounds.push([from, ids.length-1]);
out.bounds = bounds;
const lb = await import('/composer/src/render/linebreaks.ts');
out.segments = [];
for (const [lo,hi] of bounds) {
  const segLines = baked.lines.filter((id) => { const i = idxOf.get(id); return i !== undefined && i>=lo && i<=hi; });
  const rec = { lo, hi, segLineCount: segLines.length };
  if (!segLines.length) { rec.bail = 'no segLines'; out.segments.push(rec); continue; }
  const segMei = model.serializeRangeForRender(lo, hi, heji, null);
  rec.segMeiBytes = segMei.length;
  const pinned = lb.injectPins(segMei, segLines, null);
  if (pinned === null) { rec.bail = 'injectPins null'; out.segments.push(rec); continue; }
  rec.pinnedBytes = pinned.length;
  const tk = r['tk'];
  tk.setOptions(r['buildOptions']('line','page'));
  if (!tk.loadData(pinned)) { rec.bail = 'loadData failed'; out.segments.push(rec); continue; }
  const read = lb.partitionFromLayout(tk);
  if (!read) { rec.bail = 'partitionFromLayout null'; out.segments.push(rec); continue; }
  rec.readLines = read.lines.length;
  rec.readPages = read.pages.length;
  rec.partitionMatches = read.lines.join('|') === segLines.join('|');
  if (!rec.partitionMatches) {
    /* where do they diverge? */
    let i = 0; while (i < Math.min(read.lines.length, segLines.length) && read.lines[i] === segLines[i]) i++;
    rec.firstDivergenceIdx = i;
    rec.readAt = read.lines.slice(Math.max(0,i-1), i+3);
    rec.expectedAt = segLines.slice(Math.max(0,i-1), i+3);
  }
  out.segments.push(rec);
}

out.methodResult = r['castoffSegmentedByUserBreaks'](model, mei, heji);
if (out.methodResult) {
  out.methodResult = { lines: out.methodResult.lines.length, pages: out.methodResult.pages.length };
}
model.togglePageBreakAt(60);
console.error = oe;
return out;
