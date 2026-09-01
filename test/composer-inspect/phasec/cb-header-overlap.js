// B4 repro: an edit on a line ABOVE a section header, on the same page, must
// not leave the header title behind.
//
// injectSectionHeaders (main.ts) runs at page MOUNT: it translates the header's
// system and every later system on that page DOWN by SECTION_HEADER_RESERVE and
// then places the title <text> at an ABSOLUTE y derived from the system's
// pre-shift bbox. The B1 dy-cascade moves systems after an edit — but nothing
// moves that text, so the title stays put and the music slides over it.
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
const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); ow(...a); };
const errs = []; const oe = console.error; console.error = (...a) => { errs.push(a.join(' ')); oe(...a); };
const out = { warns, errs };

const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
model.setCursor(0, 1);
for (let i = 0; i < 200; i++) {
  const high = (Math.floor(i / 4) % 2) === 0;
  model.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
}
reRender();
await waitFor(badgeHidden, 60000, 40);

/* Put a section header partway in, then settle the layout. */
const nMeas = model.allMeasures().length;
out.nMeasures = nMeas;
out.headerSet = model.setSectionHeaderAt(Math.floor(nMeas / 2), 'II');
reRender();
await waitFor(badgeHidden, 60000, 40);
for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { reRender(); await waitFor(badgeHidden, 60000, 40); }
out.ownership = pb.ownershipActive();
if (!out.ownership) { console.warn = ow; console.error = oe; return out; }

/* Locate the header title and the system it labels. */
const probeHeader = () => {
  const t = document.querySelector('#score text.hkl-section-header');
  if (!t) return null;
  const forId = t.getAttribute('data-for');
  const meas = document.getElementById(forId);
  const sys = meas ? meas.closest('g.system') : null;
  const pageEl = t.closest('.score-page');
  const tb = sys && sys.transform && sys.transform.baseVal.consolidate();
  return {
    forId, page: pageEl ? +pageEl.dataset.page : null,
    textY: +t.getAttribute('y'),
    textBottomPx: +t.getBoundingClientRect().bottom.toFixed(1),
    sysTy: tb ? +tb.matrix.f.toFixed(1) : null,
    sysTopPx: sys ? +sys.getBoundingClientRect().top.toFixed(1) : null,
    /* THE user-visible quantity: clearance between the title's baseline box
       and the top of the music it titles. Negative = overlap. */
    gapPx: (sys && t) ? +(sys.getBoundingClientRect().top - t.getBoundingClientRect().bottom).toFixed(1) : null,
    sysIdxOnPage: sys ? [...sys.parentElement.querySelectorAll(':scope > g.system')].indexOf(sys) : null,
    nSysOnPage: sys ? sys.parentElement.querySelectorAll(':scope > g.system').length : null,
  };
};
out.before = probeHeader();
if (!out.before) { console.warn = ow; console.error = oe; return out; }

/* Edit a line ABOVE the header on the SAME page: grow its extent so the
   cascade has to move everything below — including the header's system. */
const startIds = pb['startIds'];
const headerLineIdx = startIds.indexOf(
  (() => {
    const sys = document.getElementById(out.before.forId).closest('g.system');
    return sys.querySelector('g.measure').id;
  })());
out.headerLineIdx = headerLineIdx;
out.targetLineIdx = headerLineIdx - 1 - out.before.sysIdxOnPage + Math.max(0, out.before.sysIdxOnPage - 1);
/* Simply: the line directly above the header, provided it is on the same page
   (sysIdxOnPage > 0 means it is). */
out.samePageAbove = out.before.sysIdxOnPage > 0;
const targetLine = headerLineIdx - 1;
out.targetLine = targetLine;
if (targetLine >= 1 && out.samePageAbove) {
  const ids = model.allMeasures().map((x) => x.getAttribute('xml:id'));
  const target = model.allMeasures()[ids.indexOf(startIds[targetLine])];
  const flat = model['flatChildren'](1);
  let cur = -1;
  for (let i = 0; i < flat.length; i++) {
    const el = flat[i];
    if ((el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === target) { cur = i; break; }
  }
  out.foundTarget = cur >= 0;
  if (cur >= 0) {
    model.setCursor(cur, 1);
    out.replaced = model.replaceChordAtCursor({ notes: [mk('c', 0), mk('g', 7)], duration: '4', dots: 0 }) !== null;
    reRender();
    await waitFor(badgeHidden, 60000, 40);
    out.outcome = ps.lastOutcome;
    out.skipReason = ps.lastSkipReason;
    out.plan = ps.lastVertical ? { static: ps.lastVertical.static, dyFollow: +ps.lastVertical.dyFollow.toFixed(1) } : null;
    out.after = probeHeader();
    if (out.after) {
      out.sysMovedPx = +(out.after.sysTopPx - out.before.sysTopPx).toFixed(1);
      out.textMovedPx = +(out.after.textBottomPx - out.before.textBottomPx).toFixed(1);
      out.gapBeforePx = out.before.gapPx;
      out.gapAfterPx = out.after.gapPx;
      /* The bug: the system moved and the title did not. */
      out.BUG = Math.abs(out.sysMovedPx - out.textMovedPx) > 2;
    }
  }
}
console.warn = ow; console.error = oe;
return out;
