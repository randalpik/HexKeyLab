// Which of the sweep's per-line edits do NOT change the document, and why?
//
// cb-sweep.js reports 8 rows where `deleteAtCursor()` returned truthy but
// `docVersion()` was unchanged — they sit in the hit-rate denominator as
// failures without being edits at all. This probe replays the sweep's TARGET
// SELECTION for every line, tries the delete against the model only (no
// renders, so it is fast), restores, and dumps the contents of every measure
// whose delete was a no-op — plus what sits at and around the cursor, since
// "the measure is empty" and "the cursor lands somewhere delete declines" are
// different diagnoses. Read-only overall: every edit is undone.
const H = window.__hkl_composer;
const model = H.model, r = H.renderer;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 100) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null);
if (!out.adopted) return out;
await waitFor(() => { const b = document.getElementById('renderBusy'); return !b || b.hidden; }, 60000, 40);

const sids = pb['startIds'];
const nLines = sids.length;

/* Compact description of a measure's musical content. */
const describeMeasure = (meas) => {
  if (!meas) return null;
  const staves = [];
  for (const st of Array.from(meas.querySelectorAll(':scope > staff'))) {
    const layers = [];
    for (const ly of Array.from(st.querySelectorAll(':scope > layer'))) {
      const items = [];
      const walk = (parent) => {
        for (const c of Array.from(parent.children)) {
          const ln = c.localName;
          if (ln === 'beam' || ln === 'tuplet') { walk(c); continue; }
          const bits = [ln];
          if (c.getAttribute('dur')) bits.push('dur=' + c.getAttribute('dur'));
          if (c.getAttribute('dots')) bits.push('dots=' + c.getAttribute('dots'));
          if (c.getAttribute('grace')) bits.push('GRACE');
          if (c.getAttribute('tie')) bits.push('tie=' + c.getAttribute('tie'));
          if (ln === 'note' && c.getAttribute('pname')) bits.push(c.getAttribute('pname') + (c.getAttribute('oct') ?? ''));
          items.push(bits.join(' '));
        }
      };
      walk(ly);
      layers.push({ n: ly.getAttribute('n'), items });
    }
    staves.push({ n: st.getAttribute('n'), layers });
  }
  return {
    id: meas.getAttribute('xml:id'), n: meas.getAttribute('n'),
    right: meas.getAttribute('right'), left: meas.getAttribute('left'),
    sectionTitle: meas.getAttribute('data-hkl-section-title'),
    notes: meas.querySelectorAll('note').length,
    chords: meas.querySelectorAll('chord').length,
    rests: meas.querySelectorAll('rest').length,
    mRests: meas.querySelectorAll('mRest').length,
    staves,
  };
};

const rows = [];
for (let li = 1; li < nLines; li++) {
  const ids = model.allMeasures().map((x) => x.getAttribute('xml:id'));
  const mi0 = ids.indexOf(sids[li]);
  if (mi0 < 0) continue;
  const lineEnd = li + 1 < nLines ? ids.indexOf(sids[li + 1]) : ids.length;
  const mi = (mi0 + 1 < lineEnd) ? mi0 + 1 : mi0;      /* the sweep's target */
  const meas = model.allMeasures()[mi];

  const snap = model.snapshotState();
  const cur = model.getMeasureStartCursor(1, mi);
  model.setCursor(cur, 1);
  const flat = model['flatChildren'](1);
  const around = [-1, 0, 1].map((d) => {
    const el = flat[cur + d];
    return el ? (el.localName + (el.getAttribute && el.getAttribute('dur') ? '/' + el.getAttribute('dur') : '')
      + (el.closest && el.closest('measure') === meas ? '' : ' [other measure]')) : null;
  });
  const ver0 = model.docVersion();
  let ret, threw = null;
  try { ret = model.deleteAtCursor(); } catch (e) { threw = String(e && e.message || e); }
  const changed = model.docVersion() !== ver0;
  const row = { line: li, measureIdx: mi, cursor: cur, around, ret: ret === undefined ? 'undefined' : String(ret), threw, changed };
  if (!changed) row.measure = describeMeasure(meas);
  model.restoreSnapshot(snap);
  rows.push(row);
}
out.total = rows.length;
out.noop = rows.filter((x) => !x.changed);
out.summary = {
  lines: rows.length,
  changed: rows.filter((x) => x.changed).length,
  noop: out.noop.length,
  noopLines: out.noop.map((x) => x.line),
  /* Did the API claim success on a no-op? That is the contract question. */
  noopReturningTruthy: out.noop.filter((x) => x.ret !== 'false' && x.ret !== 'null' && !x.threw).length,
  noopThrew: out.noop.filter((x) => x.threw).length,
  noopReturns: [...new Set(out.noop.map((x) => x.ret))],
  emptyTargets: out.noop.filter((x) => x.measure && x.measure.notes === 0 && x.measure.chords === 0).length,
  restOnlyTargets: out.noop.filter((x) => x.measure && x.measure.notes === 0 && x.measure.chords === 0 && (x.measure.rests || x.measure.mRests)).length,
};
return out;
