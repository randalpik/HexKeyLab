// Phase C-B probe 1: page-view structural survey (sonata).
// Questions this answers (design doc "Remaining for Phase C-B" items 4/5):
//  A. Are volta brackets (g.ending) CHILDREN of g.system in page mode (so a
//     whole-system splice carries them for free), or page-margin siblings
//     (scroll-splicer-style reconcile needed)?
//  B. Vertical stacking model: is inter-system spacing constant staff-frame
//     pitch, or content-driven (hanging content pushes the next system)?
//  C. Page bottom slack distribution (how much room the pager leaves) and
//     where the page budget line sits.
//  D. What transforms mounted systems already carry (snap / injections).
const R = window.__hkl_composer.renderer;
const M = window.__hkl_composer.model;

// Wait out lazy partition adoption.
for (let i = 0; i < 200; i++) {
  if (R['pageBreaks']['startIds']) break;
  await new Promise((r) => setTimeout(r, 250));
}
const startIds = R['pageBreaks']['startIds'];
if (!startIds) return { error: 'partition adoption never finished' };

const st = R['pageVirt'];
const pageCount = st ? st.pageCount : 1;
const tk = R['tk'];

// Pages to mount: spread + every page containing a volta + the last two.
const doc = M.getDoc();
const voltaPages = [];
for (const e of Array.from(doc.querySelectorAll('ending')).slice(0, 4)) {
  const m = e.querySelector('measure');
  if (m) voltaPages.push(tk.getPageWithElement(m.getAttribute('xml:id')));
}
const wanted = [...new Set([1, 2, 3, Math.floor(pageCount / 2), pageCount - 1, pageCount, ...voltaPages]
  .filter((p) => p >= 1 && p <= pageCount))].sort((a, b) => a - b);
for (const p of wanted) R['mountPage'](p);

// ── A. ending parentage ────────────────────────────────────────────────────
const endingInfo = [];
for (const eg of Array.from(document.querySelectorAll('.score-page g.ending')).slice(0, 6)) {
  endingInfo.push({
    id: eg.getAttribute('id'),
    parentClass: eg.parentElement?.getAttribute('class'),
    grandparentClass: eg.parentElement?.parentElement?.getAttribute('class'),
    insideSystem: !!eg.closest('g.system'),
  });
}

// ── B/C/D. per-page vertical survey (client px; CSS may scale uniformly, so
// gaps/ratios are comparable within a page) ─────────────────────────────────
function staffLineYs(sys) {
  // first measure's staves; each staff's direct path children are the 5 lines
  const firstM = sys.querySelector(':scope g.measure');
  if (!firstM) return null;
  const staves = Array.from(firstM.querySelectorAll(':scope > g.staff'));
  if (!staves.length) return null;
  const tops = [], bots = [];
  for (const s of staves) {
    let t = Infinity, b = -Infinity;
    for (const p of Array.from(s.querySelectorAll(':scope > path'))) {
      const r = p.getBoundingClientRect();
      if (r.top < t) t = r.top;
      if (r.bottom > b) b = r.bottom;
    }
    if (isFinite(t)) { tops.push(t); bots.push(b); }
  }
  if (!tops.length) return null;
  return { top: Math.min(...tops), bot: Math.max(...bots), nStaves: tops.length };
}

const pages = [];
for (const pageEl of Array.from(document.querySelectorAll('.score-page:not(.score-page-pending)'))) {
  const pno = Number(pageEl.dataset.page);
  const svg = pageEl.querySelector('svg');
  if (!svg) continue;
  const svgR = svg.getBoundingClientRect();
  const systems = Array.from(pageEl.querySelectorAll('g.system'));
  const rows = systems.map((sys) => {
    const bb = sys.getBoundingClientRect();
    const sl = staffLineYs(sys);
    const firstMeasure = sys.querySelector('g.measure');
    return {
      firstMeasureId: firstMeasure ? firstMeasure.id : null,
      transform: sys.getAttribute('transform'),
      bboxTop: +(bb.top - svgR.top).toFixed(1),
      bboxBot: +(bb.bottom - svgR.top).toFixed(1),
      staffTop: sl ? +(sl.top - svgR.top).toFixed(1) : null,
      staffBot: sl ? +(sl.bot - svgR.top).toFixed(1) : null,
      nStaves: sl ? sl.nStaves : 0,
    };
  });
  const gaps = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    gaps.push({
      staffGap: rows[i + 1].staffTop != null && rows[i].staffBot != null
        ? +(rows[i + 1].staffTop - rows[i].staffBot).toFixed(1) : null,
      bboxGap: +(rows[i + 1].bboxTop - rows[i].bboxBot).toFixed(1),
      hangBelow: rows[i].staffBot != null ? +(rows[i].bboxBot - rows[i].staffBot).toFixed(1) : null,
      hangAboveNext: rows[i + 1].staffTop != null ? +(rows[i + 1].staffTop - rows[i + 1].bboxTop).toFixed(1) : null,
    });
  }
  pages.push({
    page: pno,
    svgH: +svgR.height.toFixed(1),
    nSystems: rows.length,
    lastBboxBot: rows.length ? rows[rows.length - 1].bboxBot : null,
    lastStaffBot: rows.length ? rows[rows.length - 1].staffBot : null,
    slackBbox: rows.length ? +(svgR.height - rows[rows.length - 1].bboxBot).toFixed(1) : null,
    systems: rows,
    gaps,
  });
}

// Distill the stacking answer: variance of staffGap vs correlation with hang.
const allGaps = pages.flatMap((p) => p.gaps).filter((g) => g.staffGap != null);
const staffGaps = allGaps.map((g) => g.staffGap);
const bboxGaps = allGaps.map((g) => g.bboxGap).filter((x) => x != null);
const stats = (a) => a.length ? {
  n: a.length,
  min: Math.min(...a), max: Math.max(...a),
  mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1),
} : null;

return {
  pageCount,
  mountedPages: wanted,
  partitionLines: startIds.length,
  endingInfo,
  staffGapStats: stats(staffGaps),
  bboxGapStats: stats(bboxGaps),
  slackStats: stats(pages.filter((p) => p.page !== pageCount).map((p) => p.slackBbox)),
  pages,
};
