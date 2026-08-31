// Phase C-B gate battery (sonata): drive real edits through the live app and
// for each one assert (1) the expected path — system splice vs full render —
// and (2) CORRECTNESS: every mounted page that hosts a changed line must
// match an offscreen full render of the same pinned MEI (system sequence,
// per-measure x/width, consecutive-system spacing). This is the design doc's
// acceptance-gate harness ("spliced result must equal what a full re-engrave
// would produce") run at sonata scale; the composer-test fixtures cover the
// same invariants on small docs under HKL_INDEX_CHECK.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const ps = r['pageSplicer'];
const V = window.verovio;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 60000, step = 60) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const errs = [];
const oe = console.error; console.error = (...a) => { errs.push(a.join(' ').slice(0, 200)); oe(...a); };

const out = { errs };
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;

const lb = await import('/composer/src/render/linebreaks.ts');
const TOL = 30;

const mountAll = async () => {
  for (const page of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) {
    r['mountPage'](+page.dataset.page);
  }
  await sleep(30);
};

/* Offscreen reference render of the current pinned doc; compare the pages
 * hosting `lineIdxs` (and their neighbours) against the live DOM. */
const tkRef = new V.toolkit();
function referenceCompare() {
  const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
  /* Reference must use the SAME display strategy as the live render: with
     pagination owned that is 'encoded' + <pb> pins. Comparing an encoded live
     DOM against a 'line' reference just re-measures the (accepted) ~516-unit
     justification difference between the two modes. */
  const owned = pb.paginationOwned();
  const pinned = lb.injectPins(mei, pb['startIds'], owned ? new Set(pb.pageStarts()) : null);
  if (!pinned) return { ok: false, why: 'pin injection failed' };
  tkRef.setOptions({ ...r['buildOptions']('auto'), breaks: owned ? 'encoded' : 'line' });
  if (!tkRef.loadData(pinned)) return { ok: false, why: 'reference loadData failed' };
  const profile = (sys) => {
    const measures = [...sys.querySelectorAll('g.measure')];
    if (!measures.length) return null;
    const m0 = measures[0].getBBox();
    const tb = sys.transform?.baseVal?.consolidate?.();
    const ty = tb ? tb.matrix.f : 0;
    const staff = measures[0].querySelector(':scope > g.staff');
    let top = Infinity;
    if (staff) {
      const stb = staff.transform?.baseVal?.consolidate?.();
      const sty = stb ? stb.matrix.f : 0;
      for (const p of staff.querySelectorAll(':scope > path')) {
        const b = p.getBBox();
        if (b.y + sty < top) top = b.y + sty;
      }
    }
    return {
      ids: measures.map((m) => m.id),
      rel: measures.map((m) => { const b = m.getBBox(); return [+(b.x - m0.x).toFixed(1), +b.width.toFixed(1)]; }),
      staffTop: top + ty,
    };
  };
  const livePages = [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')];
  let checkedPages = 0, checkedMeasures = 0;
  let maxD = 0, maxSpacingD = 0, maxTopD = 0;
  for (const pageEl of livePages) {
    const pno = +pageEl.dataset.page;
    if (pno > tkRef.getPageCount()) return { ok: false, why: 'live page ' + pno + ' beyond reference page count ' + tkRef.getPageCount() };
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0';
    host.innerHTML = tkRef.renderToSVG(pno, {});
    document.body.appendChild(host);
    try {
      const refSys = [...host.querySelectorAll('g.system')];
      const liveSys = [...pageEl.querySelectorAll('g.system')];
      if (refSys.length !== liveSys.length) return { ok: false, why: 'page ' + pno + ': system count ' + liveSys.length + ' vs ref ' + refSys.length };
      // Section-header pages carry a main.ts-injected system translate (the
      // reserve) that the raw reference lacks — spacing is not comparable
      // there; sequence + x/width still are.
      const headerPage = pageEl.querySelector('text.hkl-section-header') !== null;
      let prevRef = null, prevLive = null;
      for (let i = 0; i < refSys.length; i++) {
        const rp = profile(refSys[i]), lp = profile(liveSys[i]);
        if (!rp || !lp) return { ok: false, why: 'page ' + pno + ' sys ' + i + ': unreadable' };
        if (rp.ids.join() !== lp.ids.join()) return { ok: false, why: 'page ' + pno + ' sys ' + i + ': measure sequence diverged' };
        for (let j = 0; j < rp.rel.length; j++) {
          const d = Math.max(Math.abs(rp.rel[j][0] - lp.rel[j][0]), Math.abs(rp.rel[j][1] - lp.rel[j][1]));
          if (d > maxD) maxD = d;
          checkedMeasures++;
        }
        if (prevRef && !headerPage) {
          const d = Math.abs((rp.staffTop - prevRef.staffTop) - (lp.staffTop - prevLive.staffTop));
          if (d > maxSpacingD) maxSpacingD = d;
        }
        /* ABSOLUTE staff top, not just consecutive spacing. B1 places spliced
           systems at measured absolute positions and shifts the systems below
           by a common dy — a page shifted wholesale by a constant satisfies
           every spacing check and is still wrong. Both sides are page-margin
           relative, so they compare directly. */
        if (!headerPage) {
          const d = Math.abs(rp.staffTop - lp.staffTop);
          if (d > maxTopD) maxTopD = d;
        }
        prevRef = rp; prevLive = lp;
      }
      checkedPages++;
    } finally { host.remove(); }
  }
  return {
    ok: maxD <= TOL && maxSpacingD <= TOL && maxTopD <= TOL,
    checkedPages, checkedMeasures,
    maxD: +maxD.toFixed(1), maxSpacingD: +maxSpacingD.toFixed(1), maxTopD: +maxTopD.toFixed(1),
  };
}

const battery = [];
const curAt = (mi) => { model.setCursor(model.getMeasureStartCursor(1, mi), 1); };
const runEdit = async (name, editFn, expect) => {
  const entry = { name, expect };
  await mountAll();
  const t0 = performance.now();
  const okEdit = editFn();
  reRender();
  await waitFor(badgeHidden, 60000, 40);
  entry.wallMs = Math.round(performance.now() - t0);
  entry.editOk = okEdit !== false && okEdit !== null;
  entry.outcome = ps.lastOutcome;
  entry.skipReason = ps.lastSkipReason;
  entry.spliceStats = { ...ps.lastStats };
  entry.refillLines = pb.lastRefillLines;
  entry.derive = pb['adoption'] !== null;
  if (entry.derive) await waitFor(() => pb['startIds'] !== null, 60000, 200);
  await mountAll();
  entry.reference = referenceCompare();
  battery.push(entry);
};

const ids0 = model.allMeasures().map((m) => m.getAttribute('xml:id'));
const startIds0 = pb['startIds'];
const idIdx0 = new Map(ids0.map((id, i) => [id, i]));
const lineStartMi = (li) => idIdx0.get(startIds0[li]);
const mkNote = { q: 0, r: 0, pname: 'b', accid: '', oct: 4, midi: 59, colorHex: '#888', lightColorHex: '#fff', velocity: 80 };

// 1: mid-line content delete (the modal edit)
await runEdit('delete-mid-line', () => { curAt(100); return model.deleteAtCursor(); }, 'spliced');
// 2: second edit in the same region (round-trip-ish: delete leaves room, insert fills it)
// Bar 100 is dense 16ths and bar 101 is FULL, so the inserted duration must fit
// the space the delete freed: "content landing past the cursor's measure
// requires that target layer empty, else reject" (architecture/composer.md).
// A quarter here asked for 12 ticks of overflow into a full measure and was
// correctly refused, leaving editOk false for months.
await runEdit('reinsert-mid-line', () => {
  curAt(100);
  if (!model.deleteAtCursor()) return false;   // frees one 16th = 4 ticks
  curAt(100);
  return model.insertChordAtCursor({ notes: [mkNote], duration: '16', dots: 0 });
}, 'spliced');
// 3: edit at a line-start measure (boundary may move within the block)
await runEdit('delete-line-start', () => { curAt(lineStartMi(30)); return model.deleteAtCursor(); }, 'spliced');
// 4: widening edit (delete one eighth, refill it as rest + note → width ripple)
// Bar 151 is FULL, so the two inserted pieces must together fit the 8 ticks the
// delete freed — an 8th rest ALONE already refilled the measure, so the 8th
// chord that followed asked for 8 ticks of overflow into a full measure and was
// correctly refused (see the note on edit 2).
await runEdit('insert-rest-ripple', () => {
  curAt(150);
  if (!model.deleteAtCursor()) return false;   // frees one 8th = 8 ticks
  curAt(150);
  if (!model.insertRestAtCursor({ duration: '16', dots: 0 })) return false;
  return model.insertChordAtCursor({ notes: [mkNote], duration: '16', dots: 0 });
}, 'any');
// 5: edit inside the volta zone (ending closure)
await runEdit('edit-near-volta', () => {
  const e = model.getDoc().querySelector('ending measure');
  const mi = e ? idIdx0.get(e.getAttribute('xml:id')) : 200;
  curAt(Math.max(1, mi - 1));
  return model.deleteAtCursor();
}, 'any');
// 6: edit in the section-header zone (probe k=59's divergent window) — the
// context sanity / section-header gates must refuse; full render must land.
await runEdit('edit-section-header-zone', () => {
  const hm = model.getDoc().querySelector('measure[data-hkl-section-title]');
  const mi = hm ? idIdx0.get(hm.getAttribute('xml:id')) : null;
  if (mi == null) return false;
  curAt(mi + 1);
  return model.deleteAtCursor();
}, 'skipped-or-spliced-correct');
// 7: edit on the doc-final line (page-last bottom rule)
await runEdit('edit-doc-end', () => { curAt(model.allMeasures().length - 2); return model.deleteAtCursor(); }, 'any');
// 8: edit a page-first line (margin/hang rule) — line starting page 3
await runEdit('edit-page-first', () => {
  const p3 = document.querySelector('#score .score-page[data-page="3"]');
  const first = p3 && p3.querySelector('g.system g.measure');
  if (!first) return false;
  const mi = model.allMeasures().findIndex((m) => m.getAttribute('xml:id') === first.id);
  if (mi < 0) return false;
  curAt(mi);
  return model.deleteAtCursor();
}, 'any');

out.battery = battery;
out.summary = {
  edits: battery.length,
  spliced: battery.filter((e) => e.outcome === 'spliced').length,
  allReferenceOk: battery.every((e) => e.reference && e.reference.ok),
  /* Every edit must actually APPLY. This was recorded but unasserted, so two
     entries whose insert the planner correctly refused (over-long duration
     against a full next measure) read as passing for months. */
  allEditsApplied: battery.every((e) => e.editOk),
  editsNotApplied: battery.filter((e) => !e.editOk).map((e) => e.name),
  spliceWallMs: battery.filter((e) => e.outcome === 'spliced').map((e) => e.wallMs),
  fullWallMs: battery.filter((e) => e.outcome !== 'spliced').map((e) => e.wallMs),
};
console.error = oe;
return out;
