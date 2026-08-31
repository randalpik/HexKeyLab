// The two reported page-break cases, measured:
//   A. break at a MID-SYSTEM measure (must split the line, then reflow)
//   B. break before the LAST LINE OF A PAGE (must NOT leave a one-line page)
// For each: does our page list match the DOM, does the break start a page, is
// there any single-system page, and does removing the break restore exactly.
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
const out = { errs: [], warns: [] };
const oe = console.error, ow = console.warn;
console.error = (...a) => { out.errs.push(a.join(' ').slice(0,160)); oe(...a); };
console.warn = (...a) => { const s=a.join(' '); if (s.includes('page-break')) out.warns.push(s.slice(0,120)); ow(...a); };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.error=oe; console.warn=ow; return out; }

const mountAll = async () => {
  for (const p of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) r['mountPage'](+p.dataset.page);
  await sleep(40);
};
const snap = async () => {
  await mountAll();
  const pages = Array.from(document.querySelectorAll('#score .score-page'));
  const per = pages.map((p) => Array.from(p.querySelectorAll('g.system')).length);
  return {
    domPages: pages.length, ownedPages: pb.pageStarts().length, lines: pb.lineStarts().length,
    systemsPerPage: per, singleSystemPages: per.reduce((a,n,i)=>n===1?a.concat(i+1):a,[]),
    minSystems: Math.min(...per),
  };
};

await mountAll();
out.baseline = await snap();
const lines0 = pb.lineStarts();
const pages0 = pb.pageStarts();
const ids = model.allMeasures().map((m) => m.getAttribute('xml:id') ?? '');
const idxOf = new Map(); ids.forEach((id,i)=>{ if(id) idxOf.set(id,i); });

/* Case A: a measure that is NOT a line start (mid-system). */
const lineSet = new Set(lines0);
let midSystemIdx = -1;
for (let i = 40; i < 120; i++) { if (!lineSet.has(ids[i])) { midSystemIdx = i; break; } }

/* Case B: the first measure of the LAST line of page 3 — breaking there moves
   that line to a new page, which is where the one-line page used to appear. */
let lastLineOfPageIdx = -1;
{
  const pageStartPos = pages0.map((id) => lines0.indexOf(id));
  const p3 = 2;                       // 0-based page 3
  if (pageStartPos.length > p3 + 1) {
    const lastLineOfP3 = pageStartPos[p3 + 1] - 1;   // line index
    const id = lines0[lastLineOfP3];
    if (id !== undefined) lastLineOfPageIdx = idxOf.get(id) ?? -1;
  }
}
out.picked = { midSystemIdx, lastLineOfPageIdx };

const runCase = async (label, mi) => {
  if (mi < 0) return { label, skipped: 'no suitable measure' };
  out.warns = [];
  const wasLineStart = pb.lineStarts().includes(ids[mi]);
  model.togglePageBreakAt(mi);
  reRender();
  await waitFor(badgeHidden, 120000, 40);
  await waitFor(() => pb['startIds'] !== null && pb['adoption'] === null, 60000, 100);
  const withBreak = await snap();
  const rec = {
    label, measureIdx: mi, breakWasMidSystem: !wasLineStart,
    withBreak,
    pagesMatchDom: withBreak.ownedPages === withBreak.domPages,
    breakStartsALine: pb.lineStarts().includes(ids[mi]),
    breakStartsAPage: pb.pageStarts().includes(ids[mi]),
    noSingleSystemPage: withBreak.singleSystemPages.length === 0,
    verify: pb.verifyRenderedPartition(r['container'], model, r['pageVirt']?.pageCount ?? 1, r['pageBreaksCtx']()),
    warns: out.warns.slice(0, 3),
  };
  model.togglePageBreakAt(mi);
  reRender();
  await waitFor(badgeHidden, 120000, 40);
  await waitFor(() => pb['startIds'] !== null && pb['adoption'] === null, 60000, 100);
  const after = await snap();
  rec.restored = after.domPages === out.baseline.domPages && after.lines === out.baseline.lines;
  rec.afterRemove = after;
  return rec;
};

out.caseA_midSystem = await runCase('A: mid-system break', midSystemIdx);
out.caseB_lastLineOfPage = await runCase('B: break before a page’s last line', lastLineOfPageIdx);
console.error = oe; console.warn = ow;
return out;
