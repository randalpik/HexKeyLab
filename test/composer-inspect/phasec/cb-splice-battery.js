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

/* This battery verifies the WHOLE document against a reference render and
   locates targets through the page DOM, so every page must stay mounted. The
   runtime mount window (cursor page ±1, evicting the rest) would undo mountAll
   on an idle callback — narrowing checkedPages from 30 to 5, and doing it
   non-deterministically. Latency here is therefore worst-case by construction;
   cb-sweep.js is the probe that measures realistic mounting. */
r.setMountWindowEnabled(false);

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
    /* Same post-processing as the live pages (HEJI text, notehead order, snaps):
       the placement rule measures extents on the post-processed system. */
    r['postProcessRendered'](host);
    try {
      const refSys = [...host.querySelectorAll('g.system')];
      const liveSys = [...pageEl.querySelectorAll('g.system')];
      if (refSys.length !== liveSys.length) return { ok: false, why: 'page ' + pno + ': system count ' + liveSys.length + ' vs ref ' + refSys.length };
      // Vertical truth is Composer's placement rule (render/pagefit.ts, Phase 1
      // of the vertical-ownership plan, 2026-09-02), not Verovio's stacking: the
      // reference's systems, measured on the reference render, are placed by the
      // rule and must land where the live page put its systems (maxTopD); and the
      // live page must be self-consistent — placed by the same rule over its own
      // extents (reported as maxSpacingD, keeping the summary's keys).
      const expect = r.placeFor(refSys), self = r.placeFor(liveSys);
      if (!expect || !self) return { ok: false, why: 'page ' + pno + ': placement unreadable' };
      for (let i = 0; i < refSys.length; i++) {
        const rp = profile(refSys[i]), lp = profile(liveSys[i]);
        if (!rp || !lp) return { ok: false, why: 'page ' + pno + ' sys ' + i + ': unreadable' };
        if (rp.ids.join() !== lp.ids.join()) return { ok: false, why: 'page ' + pno + ' sys ' + i + ': measure sequence diverged' };
        for (let j = 0; j < rp.rel.length; j++) {
          const d = Math.max(Math.abs(rp.rel[j][0] - lp.rel[j][0]), Math.abs(rp.rel[j][1] - lp.rel[j][1]));
          if (d > maxD) maxD = d;
          checkedMeasures++;
        }
        const dTop = Math.abs(expect[i].top - lp.staffTop);
        if (dTop > maxTopD) maxTopD = dTop;
        const dSelf = Math.abs(self[i].top - lp.staffTop);
        if (dSelf > maxSpacingD) maxSpacingD = dSelf;
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
// 6: edit in the section-header zone (probe k=59's divergent window). This
// refused until 2026-09-01 — first on the by-name `section-header line` guard,
// which was retired once the injector recorded `data-baseline` and the splicer
// could re-place a title whose own system it re-engraves. It now SPLICES; the
// expectation stays permissive because the zone is also where the context check
// legitimately refuses on a divergent neighbour.
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

// 9 (B2, 2026-09-02): compose at the END — four bars of quarters appended past
// the last measure in one render. The last line overflows and a new final line
// (or two) is born: a partition with MORE lines than the DOM shows, which used
// to refuse with `line count changed` (a full render every fourth bar of
// composition). If the last page is full the tail moves onto a NEW page.
await runEdit('append-at-end', () => {
  let ok = true;
  for (let q = 0; q < 16 && ok; q++) {
    model.setCursor(model['flatChildren'](1).length, 1);
    ok = model.insertChordAtCursor({ notes: [mkNote], duration: '4', dots: 0 });
  }
  return ok;
}, 'spliced');
// 10 (B2): delete EVERY measure of a mid-document line (all voices, then the
// empty wrappers) — the line vanishes by membership carry, a partition with
// FEWER lines than the DOM shows.
await runEdit('delete-whole-line', () => {
  const lines = pb['startIds'];
  const k = 40;
  if (!lines || lines.length <= k + 1) return false;
  const ids = () => model.allMeasures().map((m) => m.getAttribute('xml:id'));
  const a0 = ids();
  const lo = a0.indexOf(lines[k]), hi = a0.indexOf(lines[k + 1]);
  if (lo < 0 || hi <= lo) return false;
  const doomed = a0.slice(lo, hi).reverse();
  const V = model.totalVoices();
  /* Delete by DRIFT (probed 2026-09-02): deleteAtCursor acts on the CURRENT
     voice (setVoice — setCursor(c, v) only moves v's cursor), a deleted note
     is replaced by a `space` placeholder, and a delete whose target is a
     placeholder is a skip-left by design — so an anchored cursor (measure
     start or end) stalls on the first placeholder it meets. Per voice: park
     the cursor past the measure's last stop and backspace WITHOUT re-anchoring
     until the cursor leaves the measure, then the empty wrapper's delete drops
     the measure (case 2). */
  const deleteMeasure = (id) => {
    for (let round = 0; round < 4; round++) {
      let mi = ids().indexOf(id);
      if (mi < 0) return true;
      for (let v = 1; v <= V; v++) {
        mi = ids().indexOf(id);
        if (mi < 0) return true;
        model.setVoice(v);
        const end = (mi + 1 < ids().length ? model.getMeasureStartCursor(v, mi + 1) : model.getVoiceLength(v)) - 1;
        model.setCursor(end, v);
        for (let steps = 0; steps < 200; steps++) {
          if (model.getCursorMeasureIdx(v) < mi) break;
          if (ids().indexOf(id) < 0) return true;
          if (!model.deleteAtCursor()) break;
        }
      }
      mi = ids().indexOf(id);
      if (mi < 0) return true;
      model.setVoice(1);
      model.setCursor(model.getMeasureStartCursor(1, mi), 1);
      model.deleteAtCursor();
      if (ids().indexOf(id) < 0) return true;
    }
    return false;
  };
  let ok = true;
  for (const id of doomed) { if (!deleteMeasure(id)) { ok = false; break; } }
  model.setVoice(1);
  return ok;
}, 'spliced');

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
