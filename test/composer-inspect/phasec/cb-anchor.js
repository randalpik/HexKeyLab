// B1 sub-spike: what actually anchors a page's FIRST system?
//
// The v1 vertical gate assumes "a page's first system anchors its CONTENT top
// at the margin" (probe cb-structure.js), so its staff lands at margin + hang.
// cb-dycascade.js showed that predicting a MOVED page-first system that way is
// off by ~85 units on the sonata's page 5 while being exact on page 3 — so the
// anchor is not simply the bbox top. This probe reads every mounted page's
// first system and reports what IS constant across pages.
const H = window.__hkl_composer;
const r = H.renderer;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 60000, step = 60) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;
for (const page of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) {
  r['mountPage'](+page.dataset.page);
}
await sleep(200);

const rows = [];
for (const pageEl of Array.from(document.querySelectorAll('#score .score-page:not(.score-page-pending)'))) {
  const pno = +pageEl.dataset.page;
  const marginG = pageEl.querySelector('svg g.page-margin');
  const mtb = marginG && marginG.transform?.baseVal?.consolidate?.();
  const systems = [...pageEl.querySelectorAll('g.system')];
  if (!systems.length) continue;
  const prof = (sys) => {
    const tb = sys.transform?.baseVal?.consolidate?.();
    const ty = tb ? tb.matrix.f : 0;
    const ms = [...sys.querySelectorAll('g.measure')];
    const staff = ms[0] && ms[0].querySelector(':scope > g.staff');
    let top = Infinity;
    if (staff) {
      const stb = staff.transform?.baseVal?.consolidate?.();
      const sty = stb ? stb.matrix.f : 0;
      for (const p of staff.querySelectorAll(':scope > path')) {
        const b = p.getBBox();
        if (b.y + sty < top) top = b.y + sty;
      }
    }
    const bb = sys.getBBox();
    return {
      ty, staffTop: top + ty, bboxTop: bb.y + ty, bboxBot: bb.y + bb.height + ty,
      /* Verovio's own <g class="system"> y attributes, if present. */
      dataY: sys.getAttribute('data-y'),
    };
  };
  const first = prof(systems[0]);
  rows.push({
    pno, nSys: systems.length,
    marginTy: mtb ? +mtb.matrix.f.toFixed(1) : null,
    sysTy: +first.ty.toFixed(1),
    staffTop: +first.staffTop.toFixed(1),
    bboxTop: +first.bboxTop.toFixed(1),
    hang: +(first.staffTop - first.bboxTop).toFixed(1),
    headerPage: pageEl.querySelector('text.hkl-section-header') !== null,
  });
}
out.rows = rows;
const uniq = (k) => [...new Set(rows.map((r) => r[k]))];
out.constant = {
  marginTy: uniq('marginTy'), sysTy: uniq('sysTy'),
  staffTop: uniq('staffTop').sort((a, b) => a - b),
  bboxTop: uniq('bboxTop').sort((a, b) => a - b),
  hang: uniq('hang').sort((a, b) => a - b),
};
return out;
