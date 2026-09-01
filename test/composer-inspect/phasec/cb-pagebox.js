// Where the few-px scroll drift comes from: PLACEHOLDER height vs REAL page
// height.
//
// renderPage's virtualized path renders page 1, measures its SVG box, and gives
// every other page a placeholder of exactly those dimensions. A page that later
// mounts drops the explicit dims and sizes to its own SVG. If the real height
// differs from page 1's box — even fractionally — then every page that flips
// between placeholder and mounted changes the document height above whatever
// the reader is looking at, and the content shifts. A full render re-creates
// the whole grid (only page 1 real), so it re-runs that swap on every edit that
// falls back — which is why the drift tracks full renders, not splices.
const H = window.__hkl_composer;
const r = H.renderer;
const pb = r['pageBreaks'];
const container = document.getElementById('score');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
const waitFor = async (fn, ms = 60000, step = 50) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
await waitFor(() => { const b = document.getElementById('renderBusy'); return !b || b.hidden; }, 60000, 40);

const pageEl = (p) => container.querySelector('.score-page[data-page="' + p + '"]');
const n = container.querySelectorAll('.score-page').length;
out.pageCount = n;

const p1 = pageEl(1);
const svg1 = p1.querySelector('svg');
out.page1 = {
  offsetHeight: p1.offsetHeight,
  rectHeight: +svg1.getBoundingClientRect().height.toFixed(3),
  svgHeightAttr: svg1.getAttribute('height'),
  viewBox: svg1.getAttribute('viewBox'),
};
/* What every placeholder was given. */
const ph = container.querySelector('.score-page-pending');
out.placeholderStyle = ph ? { width: ph.style.width, height: ph.style.height, offsetHeight: ph.offsetHeight } : null;

/* Mount each page the real way (scroll + IntersectionObserver) and compare its
   REAL height against the placeholder height it had. */
const rows = [];
for (let p = 2; p <= n; p++) {
  const div = pageEl(p);
  if (!div) continue;
  const wasPending = div.classList.contains('score-page-pending');
  const phHeight = div.offsetHeight;
  container.scrollTop = Math.max(0, div.offsetTop - 40);
  await raf();
  await waitFor(() => !pageEl(p).classList.contains('score-page-pending'), 8000, 40);
  await raf();
  const now = pageEl(p);
  const svg = now.querySelector('svg');
  rows.push({
    page: p, wasPending,
    placeholderH: +phHeight.toFixed(3),
    realH: +now.offsetHeight.toFixed(3),
    delta: +(now.offsetHeight - phHeight).toFixed(3),
    svgHeightAttr: svg ? svg.getAttribute('height') : null,
    header: now.querySelector('text.hkl-section-header') !== null,
  });
}
out.rows = rows;
const deltas = rows.map((x) => x.delta);
out.summary = {
  pagesDiffering: rows.filter((x) => Math.abs(x.delta) > 0.001).length,
  distinctDeltas: [...new Set(deltas.map((d) => +d.toFixed(3)))].sort((a, b) => a - b),
  totalHeightError: +deltas.reduce((a, b) => a + b, 0).toFixed(3),
  distinctRealHeights: [...new Set(rows.map((x) => x.realH))].sort((a, b) => a - b),
  headerPages: rows.filter((x) => x.header).map((x) => x.page),
};
return out;
