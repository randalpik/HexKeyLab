// B1 safety net: a dy-cascade that pushes its page past the paper must hand
// PAGINATION back, not draw a clipped page.
//
// Verovio does not re-paginate under pinned <pb> (it will happily draw a page
// past its own rectangle), so the pinned full-render path already checks
// Renderer.overflowingPage() and re-derives on a spill. The B1 cascade can now
// move systems down too, so it needs the same check. This probe builds a page
// deliberately close to full, then grows an EARLY system by a large amount and
// asserts that whatever path runs, no mounted page ends up overflowing.
// Run with --no-sonata.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 60000, step = 60) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const warns = [];
const ow = console.warn; console.warn = (...a) => { warns.push(a.join(' ').slice(0, 200)); ow(...a); };
const errs = [];
const oe = console.error; console.error = (...a) => { errs.push(a.join(' ').slice(0, 200)); oe(...a); };
const out = { warns, errs };

/* Fill page 1 with alternating high/low quarters — many systems, each already
   carrying ledger content, so the page has little vertical slack left. */
const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
model.setCursor(0, 1);
for (let i = 0; i < 400; i++) {
  const high = (Math.floor(i / 4) % 2) === 0;
  model.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
}
reRender();
await waitFor(badgeHidden, 60000, 40);
for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { reRender(); await waitFor(badgeHidden, 60000, 40); }
out.ownership = pb.ownershipActive();
if (!out.ownership) { console.warn = ow; console.error = oe; return out; }

const pageOverflow = () => {
  const bad = [];
  for (const pageEl of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
    const svg = pageEl.querySelector('svg');
    const systems = [...pageEl.querySelectorAll('g.system')];
    if (!svg || !systems.length) continue;
    const box = svg.getBoundingClientRect();
    const last = systems[systems.length - 1].getBoundingClientRect();
    if (last.bottom > box.bottom + 2) bad.push({ page: +pageEl.dataset.page, over: +(last.bottom - box.bottom).toFixed(1) });
  }
  return bad;
};
out.startIds = pb['startIds'].length;
out.pagesBefore = document.querySelectorAll('#score .score-page').length;
out.overflowBefore = pageOverflow();
/* Bottom slack on each mounted page (px) — how much room a cascade has. */
const slack = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')].map((pageEl) => {
  const svg = pageEl.querySelector('svg');
  const systems = [...pageEl.querySelectorAll('g.system')];
  if (!svg || !systems.length) return null;
  return { page: +pageEl.dataset.page, nSys: systems.length,
    slackPx: +(svg.getBoundingClientRect().bottom - systems[systems.length - 1].getBoundingClientRect().bottom).toFixed(1) };
}).filter(Boolean);
out.slackBefore = slack();

/* Grow successive EARLY systems, each by a c0..g7 span (deep ledger lines in
   both directions ≈ 244 px of extra height). Page 1 starts with ~410 px of
   slack, so the SECOND growth must exhaust it — and that is the case the
   safety net exists for. */
out.steps = [];
for (let line = 1; line <= 4; line++) {
  const ids = model.allMeasures().map((x) => x.getAttribute('xml:id'));
  const startId = pb['startIds'][line];
  const target = model.allMeasures()[ids.indexOf(startId)];
  if (!target) break;
  const flat = model['flatChildren'](1);
  let cur = -1;
  for (let i = 0; i < flat.length; i++) {
    const el = flat[i];
    if ((el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === target) { cur = i; break; }
  }
  if (cur < 0) break;
  model.setCursor(cur, 1);
  const before = warns.length;
  const t0 = performance.now();
  const okRep = model.replaceChordAtCursor({ notes: [mk('c', 0), mk('g', 7)], duration: '4', dots: 0 }) !== null;
  reRender();
  await waitFor(badgeHidden, 60000, 40);
  const step = {
    line, replaced: okRep, wallMs: Math.round(performance.now() - t0),
    outcome: ps.lastOutcome, skipReason: ps.lastSkipReason,
    dyFollow: ps.lastVertical ? +ps.lastVertical.dyFollow.toFixed(1) : null,
    handedBack: warns.slice(before).some((w) => w.includes('cascade overflows page')),
    slack: slack(), overflow: pageOverflow(),
    pages: document.querySelectorAll('#score .score-page').length,
  };
  out.steps.push(step);
  if (step.handedBack) break;
}
/* THE assertion: whichever path ran, nothing may be drawn past the paper, and
   no step may raise a console error. */
out.ok = out.steps.every((s) => s.overflow.length === 0) && errs.length === 0;
out.handedBackAt = out.steps.findIndex((s) => s.handedBack);
console.warn = ow; console.error = oe;
return out;
