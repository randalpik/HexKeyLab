// Where does the smartSb0-vs-encoded spacing difference actually live?
// (Max, 2026-08-30: "That Page 11 system ends in a section break. Are all the
// worst offenders in systems adjacent to section breaks, or are there others?
// I'm struggling to understand how this difference can happen somewhere that
// didn't have an sb in the first place.")
//
// Classifies every LINE of the adopted partition by its relationship to the
// document's own structural landmarks, then reports the max smartSb0-vs-encoded
// measure delta per class:
//   startsAtHard      — its first measure is directly preceded by a doc sb/pb
//   endsBeforeHard    — the NEXT line starts at a doc sb/pb (i.e. this line is
//                       the last one of a section)
//   abutsScoreDef     — a section-level <scoreDef> sits inside it or directly
//                       before/after it (mid-piece key/meter change)
//   plain             — none of the above: a line whose breaks are purely
//                       castoff's choice, with no encoded break anywhere near
// If `plain` lines show zero delta, the difference is entirely a
// section-break/scoreDef phenomenon. If they don't, it is systemic.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const V = window.verovio;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 150) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;
const lb = await import('/composer/src/render/linebreaks.ts');

const startIds = pb['startIds'].slice();
const pageStarts = pb.pageStarts().slice();
const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
const ids = model.allMeasures().map((m) => m.getAttribute('xml:id'));
const idIdx = new Map(ids.map((id, i) => [id, i]));

/* ── document landmarks, in document order ── */
const doc = model.getDoc();
const section = doc.querySelector('section');
const hardStarts = new Set();      // measure ids directly preceded by a doc sb/pb
const scoreDefAt = new Set();      // measure index directly after a section scoreDef
const scoreDefBefore = new Set();  // measure index directly before a section scoreDef
{
  let count = 0;
  let pendingBreak = false, pendingDef = false;
  const walk = (el) => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'measure') {
        const id = c.getAttribute('xml:id');
        if (pendingBreak && id) hardStarts.add(id);
        if (pendingDef) scoreDefAt.add(count);
        pendingBreak = false; pendingDef = false;
        count++;
      } else if (c.localName === 'sb' || c.localName === 'pb') {
        pendingBreak = true;
        if (count > 0) scoreDefBefore.add(count - 1);   // reuse: measure before a break
      } else if (c.localName === 'scoreDef') {
        pendingDef = true;
      } else if (c.querySelector && c.querySelector('measure')) {
        walk(c);
      }
    }
  };
  walk(section);
}
out.docLandmarks = {
  hardStarts: hardStarts.size,
  midPieceScoreDefs: scoreDefAt.size,
  lines: startIds.length,
};

/* ── line spans ── */
const spans = startIds.map((id, li) => [
  idIdx.get(id),
  li + 1 < startIds.length ? idIdx.get(startIds[li + 1]) : ids.length,
]);

/* ── geometry in both modes ── */
const base = r['buildOptions']('auto');
const pinnedPb = lb.injectPins(mei, startIds, new Set(pageStarts));
if (!pinnedPb) return { error: 'pin injection failed' };
function read(data, opts) {
  const tk = new V.toolkit();
  tk.setOptions(opts);
  if (!tk.loadData(data)) return null;
  const byId = new Map();
  for (let p = 1; p <= tk.getPageCount(); p++) {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0';
    host.innerHTML = tk.renderToSVG(p, {});
    document.body.appendChild(host);
    try {
      for (const el of host.querySelectorAll('g.measure')) {
        const b = el.getBBox();
        byId.set(el.id, { x: b.x, w: b.width, page: p });
      }
    } finally { host.remove(); }
  }
  return byId;
}
const A = read(mei, { ...base, breaks: 'smart', breaksSmartSb: 0 });
const B = read(pinnedPb, { ...base, breaks: 'encoded' });
if (!A || !B) return { error: 'render failed' };

/* ── per line: max delta + classification ── */
const lines = [];
for (let li = 0; li < startIds.length; li++) {
  const [lo, hi] = spans[li];
  let maxD = 0, worstId = null;
  for (let i = lo; i < hi; i++) {
    const a = A.get(ids[i]), b = B.get(ids[i]);
    if (!a || !b) continue;
    const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.w - b.w));
    if (d > maxD) { maxD = d; worstId = ids[i]; }
  }
  const nextStart = li + 1 < startIds.length ? startIds[li + 1] : null;
  let abutsScoreDef = false;
  for (let i = lo; i <= hi; i++) if (scoreDefAt.has(i)) abutsScoreDef = true;
  lines.push({
    li, page: A.get(ids[lo]) ? A.get(ids[lo]).page : null,
    measures: hi - lo,
    startsAtHard: hardStarts.has(startIds[li]),
    endsBeforeHard: nextStart ? hardStarts.has(nextStart) : false,
    abutsScoreDef,
    maxD: +maxD.toFixed(1), worstId,
  });
}

const classOf = (l) => {
  if (l.startsAtHard || l.endsBeforeHard) return 'adjacentToHardBreak';
  if (l.abutsScoreDef) return 'abutsScoreDef';
  return 'plain';
};
const stats = {};
for (const l of lines) {
  const c = classOf(l);
  const s = stats[c] = stats[c] || { lines: 0, maxD: 0, sum: 0, over1px: 0, over10px: 0 };
  s.lines++; s.sum += l.maxD;
  s.maxD = Math.max(s.maxD, l.maxD);
  if (l.maxD > 10) s.over1px++;
  if (l.maxD > 100) s.over10px++;
}
for (const s of Object.values(stats)) s.meanMaxD = +(s.sum / s.lines).toFixed(1);
out.byClass = stats;
out.worstLines = lines.slice().sort((p, q) => q.maxD - p.maxD).slice(0, 12);
out.cleanLines = lines.filter((l) => l.maxD <= 1).length;
/* The decisive number: the worst 'plain' line — a system with no encoded break
 * and no scoreDef anywhere near it. */
const plain = lines.filter((l) => classOf(l) === 'plain').sort((p, q) => q.maxD - p.maxD);
out.worstPlainLines = plain.slice(0, 8);
return out;
