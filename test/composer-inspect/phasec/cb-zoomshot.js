// Zoom-preset visual comparison: renders the sonata at one zoom level, scrolls
// page 1 into view for the runner's --screenshot, and MEASURES what the preset
// actually produced — rendered staff-space in device px, stroke width, line and
// page counts — so the images come with numbers.
//
//   --arg 50 | 75 | 100     --screenshot <path>
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
const oe = console.error; console.error = (...a) => { out.errs.push(a.join(' ').slice(0, 160)); oe(...a); };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.error = oe; return out; }

const zoom = Number(window.__probeArg || 100);
out.zoom = zoom;
r.setZoom(zoom);
r['forceFullRerender']();
reRender();
await waitFor(badgeHidden, 120000, 40);
await waitFor(() => pb['startIds'] !== null && pb['adoption'] === null, 60000, 100);

/* Mount page 1 and put it at the top of the viewport. */
for (const p of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) {
  if (+p.dataset.page <= 2) r['mountPage'](+p.dataset.page);
}
await sleep(120);
const score = document.getElementById('score');
if (score) { score.scrollTop = 0; score.scrollLeft = 0; }
await sleep(150);

/* Measured staff-space: adjacent staff-line y gaps of the first staff, in
   DEVICE px (getBoundingClientRect, so it includes every transform). */
const firstStaff = document.querySelector('#score .score-page:not(.score-page-pending) g.staff');
let gaps = [];
if (firstStaff) {
  const ys = Array.from(firstStaff.querySelectorAll(':scope > path'))
    .map((p) => p.getBoundingClientRect())
    .map((b) => b.top + b.height / 2)
    .sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) gaps.push(+(ys[i] - ys[i - 1]).toFixed(2));
}
const strokes = firstStaff
  ? Array.from(firstStaff.querySelectorAll(':scope > path'))
      .map((p) => +p.getBoundingClientRect().height.toFixed(2))
  : [];

out.measured = {
  staffLineGapsPx: gaps,
  /* staff-space = one gap; the preset's target is unit × scale/50 */
  staffSpacePx: gaps.length ? gaps[0] : null,
  staffLineStrokePx: strokes,
  lines: pb.lineStarts().length,
  pages: document.querySelectorAll('#score .score-page').length,
  measuresOnPage1: document.querySelectorAll(
    '#score .score-page[data-page="1"] g.measure').length,
};
out.presetInUse = {
  scale: r['currentScale'](),
  /* buildOptions is private; read what it emits for the page geometry path */
  unitFromOptions: (r['buildOptions']('encoded', 'page') || {}).unit,
};
console.error = oe;
return out;
