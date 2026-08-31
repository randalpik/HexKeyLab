// B1 spike: does the window-measured VERTICAL PLAN predict what a full
// re-engrave actually does?
//
// The Phase C-B v1 gate refuses whenever a replaced system (or anything below
// it) would move. B1 wants to APPLY that movement instead. The plan is only
// safe to apply if `PageSystemSplicer.lastVertical` — computed purely from the
// window's own spacing chain — matches the positions a real full render
// produces. This probe runs page-first deletes (the `edit-page-first` battery
// case, the one refusal the plan is meant to convert) on several pages and
// compares, per system:
//   predicted newTop  vs  the staff-top the ensuing FULL render produced
//   predicted dyFollow vs  the shift the followers on that page actually took
// Deltas ≲ EPS (25 units ≈ 2.5 px) mean the cascade can be applied verbatim.
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
const errs = [];
const oe = console.error; console.error = (...a) => { errs.push(a.join(' ').slice(0, 200)); oe(...a); };
const out = { errs, cases: [] };
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;

const mountAll = async () => {
  for (const page of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) {
    r['mountPage'](+page.dataset.page);
  }
  await sleep(30);
};

/* Same measurement the splicer's systemProfile uses, so the numbers are
   directly comparable to VerticalPlan (page-margin coordinates). */
const profile = (sys) => {
  const measures = [...sys.querySelectorAll('g.measure')];
  if (!measures.length) return null;
  const tb = sys.transform?.baseVal?.consolidate?.();
  const ty = tb ? tb.matrix.f : 0;
  const staff = measures[0].querySelector(':scope > g.staff');
  if (!staff) return null;
  const stb = staff.transform?.baseVal?.consolidate?.();
  const sty = stb ? stb.matrix.f : 0;
  let top = Infinity;
  for (const p of staff.querySelectorAll(':scope > path')) {
    const b = p.getBBox();
    if (b.y + sty < top) top = b.y + sty;
  }
  const bb = sys.getBBox();
  return { id: measures[0].id, staffTop: top + ty, bboxTop: bb.y + ty, bboxBot: bb.y + bb.height + ty };
};
const pageSystems = (pno) => {
  const pageEl = document.querySelector('#score .score-page[data-page="' + pno + '"]');
  if (!pageEl || pageEl.classList.contains('score-page-pending')) return null;
  const svg = pageEl.querySelector('svg');
  const box = svg ? svg.getBoundingClientRect() : null;
  const sys = [...pageEl.querySelectorAll('g.system')].map(profile).filter(Boolean);
  return { sys, pageBottomPx: box ? box.bottom : null };
};

const curAt = (mi) => { model.setCursor(model.getMeasureStartCursor(1, mi), 1); };

for (const pno of [3, 4, 5, 6, 7]) {
  await mountAll();
  const before = pageSystems(pno);
  if (!before || !before.sys.length) { out.cases.push({ pno, why: 'page not mounted' }); continue; }
  const sid = before.sys[0].id;
  const mi = model.allMeasures().findIndex((m) => m.getAttribute('xml:id') === sid);
  if (mi < 0) { out.cases.push({ pno, why: 'start measure not in model' }); continue; }
  curAt(mi);
  const t0 = performance.now();
  const editOk = model.deleteAtCursor();
  reRender();
  await waitFor(badgeHidden, 60000, 40);
  const wallMs = Math.round(performance.now() - t0);
  const plan = ps.lastVertical ? JSON.parse(JSON.stringify(ps.lastVertical)) : null;
  const entry = {
    pno, editOk: editOk !== false && editOk !== null, wallMs,
    outcome: ps.lastOutcome, skipReason: ps.lastSkipReason,
    refillLines: pb.lastRefillLines, plan,
  };
  await mountAll();
  const after = pageSystems(pno);
  if (plan && after) {
    const post = new Map(after.sys.map((s) => [s.id, s]));
    /* Predicted vs actual for every replaced system. */
    entry.replaced = plan.startIds.map((id, i) => {
      const a = post.get(id);
      return a ? {
        id, predicted: +plan.newTop[i].toFixed(1), actual: +a.staffTop.toFixed(1),
        delta: +(plan.newTop[i] - a.staffTop).toFixed(1),
        liveWas: +plan.liveTop[i].toFixed(1),
        movedBy: +(a.staffTop - plan.liveTop[i]).toFixed(1),
      } : { id, missing: true };
    });
    /* Predicted vs actual for the followers on the same page: every system
       after the last replaced one. dyFollow must describe ALL of them. */
    const lastId = plan.startIds[plan.startIds.length - 1];
    const preIdx = before.sys.findIndex((s) => s.id === lastId);
    const pre = new Map(before.sys.map((s) => [s.id, s]));
    entry.followers = preIdx < 0 ? 'last replaced system not on this page' :
      before.sys.slice(preIdx + 1).map((s) => {
        const a = post.get(s.id);
        return a ? {
          id: s.id, actualDy: +(a.staffTop - pre.get(s.id).staffTop).toFixed(1),
          predictedDy: +plan.dyFollow.toFixed(1),
          delta: +(plan.dyFollow - (a.staffTop - pre.get(s.id).staffTop)).toFixed(1),
        } : { id: s.id, missing: true };
      });
    /* Page fit: how much room was left below the last system, before/after. */
    const lastBefore = before.sys[before.sys.length - 1];
    const lastAfter = after.sys[after.sys.length - 1];
    entry.pageBottomSlack = {
      systemsBefore: before.sys.length, systemsAfter: after.sys.length,
      lastBotBefore: +lastBefore.bboxBot.toFixed(1),
      lastBotAfter: +lastAfter.bboxBot.toFixed(1),
    };
  }
  out.cases.push(entry);
}

/* Worst prediction error over every case — the number that decides B1. */
const ds = [];
for (const c of out.cases) {
  for (const x of (c.replaced || [])) if (typeof x.delta === 'number') ds.push(Math.abs(x.delta));
  if (Array.isArray(c.followers)) for (const x of c.followers) if (typeof x.delta === 'number') ds.push(Math.abs(x.delta));
}
out.maxPredictionError = ds.length ? +Math.max(...ds).toFixed(1) : null;
out.samples = ds.length;
console.error = oe;
return out;
