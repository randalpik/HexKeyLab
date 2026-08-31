// B1 sub-spike: WHAT reaches above a page-first system's anchored content top?
// cb-anchor.js shows most pages' first system has bboxTop ~421 while pages 7
// and 25 sit ~78 units higher — i.e. their bbox overflows above whatever
// Verovio actually counts when it anchors the first system. Identify the
// offending descendants so the hang measurement can be made to match.
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

const describe = (el) => {
  const parts = [];
  let n = el;
  for (let i = 0; i < 4 && n && n.tagName !== 'svg'; i++) {
    parts.push(n.tagName + (n.getAttribute('class') ? '.' + n.getAttribute('class').split(' ').join('.') : ''));
    n = n.parentElement;
  }
  return parts.join(' < ');
};

const rows = [];
for (const pageEl of Array.from(document.querySelectorAll('#score .score-page:not(.score-page-pending)'))) {
  const pno = +pageEl.dataset.page;
  const sys = pageEl.querySelector('g.system');
  if (!sys) continue;
  const tb = sys.transform?.baseVal?.consolidate?.();
  const ty = tb ? tb.matrix.f : 0;
  /* Absolute (system-local) top of every leaf-ish descendant. Walk with a
     running transform so the numbers match getBBox on the system. */
  const items = [];
  const walk = (el, off) => {
    for (const c of Array.from(el.children)) {
      const cb = c.transform?.baseVal?.consolidate?.();
      const o = off + (cb ? cb.matrix.f : 0);
      if (c.children.length && c.tagName !== 'text') { walk(c, o); continue; }
      let b;
      try { b = c.getBBox(); } catch { continue; }
      if (!b || (b.width === 0 && b.height === 0)) continue;
      items.push({ top: +(b.y + o).toFixed(1), what: describe(c) });
    }
  };
  walk(sys, 0);
  items.sort((a, b) => a.top - b.top);
  rows.push({ pno, sysTop: +ty.toFixed(1), topmost: items.slice(0, 4) });
}
out.rows = rows;
return out;
