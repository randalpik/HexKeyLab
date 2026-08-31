// Why do two cb-splice-battery entries report editOk:false? Reproduces the
// exact battery edit sequences for `reinsert-mid-line` (bar 100) and
// `insert-rest-ripple` (bar 150), one phase per run so the runner can
// screenshot it, and reports the model-level facts around each step.
//
//   --arg reinsert:before | reinsert:after | ripple:before | ripple:after
//   --screenshot <path>
//
// The `after` phases run the WHOLE sequence (delete, then insert) and record
// each call's return value plus the cursor's layer state before and after, so
// a `false` return can be attributed rather than guessed at.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 60000, step = 60) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };

const out = { arg: window.__probeArg };
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;

const [which, phase] = String(window.__probeArg || 'reinsert:before').split(':');
const MI = which === 'ripple' ? 150 : 100;
out.measureIdx = MI;
out.phase = phase;

const mkNote = { q: 0, r: 0, pname: 'b', accid: '', oct: 4, midi: 59, colorHex: '#888', lightColorHex: '#fff', velocity: 80 };
const curAt = (mi) => { model.setCursor(model.getMeasureStartCursor(1, mi), 1); };

const mountAll = async () => {
  for (const page of Array.from(document.querySelectorAll('#score .score-page.score-page-pending'))) {
    r['mountPage'](+page.dataset.page);
  }
  await sleep(40);
};

/* Everything about the cursor's target layer that could make an insert refuse:
   what the cursor points at, the layer's content, and its tick budget. */
const layerState = (label, at = MI) => {
  const measures = model.allMeasures();
  const m = measures[at] ?? null;
  const layer = m ? model.layerInMeasure(m, 1) : null;
  const cc = layer ? model.contentChildren(layer) : [];
  /* realTicks-equivalent: dur is a power-of-two denominator, 64 ticks = whole. */
  const ticksOf = (c) => {
    const dur = c.getAttribute('dur');
    if (!dur) return 0;
    const base = 64 / Number(dur);
    const dots = parseInt(c.getAttribute('dots') ?? '0', 10) || 0;
    let t = base, add = base;
    for (let i = 0; i < dots; i++) { add /= 2; t += add; }
    return t;
  };
  const used = cc.reduce((a, c) => a + ticksOf(c), 0);
  const budget = layer ? model.measureTicksForLayer(layer) : null;
  const st = {
    label,
    at,
    cursor: model.getCursor(1),
    measureId: m ? m.getAttribute('xml:id') : null,
    contentChildren: cc.map((c) => c.localName + (c.getAttribute('dur') ? '@' + c.getAttribute('dur') : '')),
    usedTicks: used,
    budgetTicks: budget,
    freeTicks: budget == null ? null : budget - used,
  };
  return st;
};

/* The documented rule: an insert that doesn't fit overflows across ONE measure
   boundary if there is room there. So the decisive fact for a refused insert is
   the free space in the NEXT measure, not in the target. */
const roomReport = (label, wantTicks) => {
  const here = layerState(label + '/target', MI);
  const next = layerState(label + '/next', MI + 1);
  return {
    wantTicks,
    target: here,
    next,
    overflowNeeded: Math.max(0, wantTicks - (here.freeTicks ?? 0)),
    roomInNext: next.freeTicks,
    ruleSaysShouldFit: (here.freeTicks ?? 0) + (next.freeTicks ?? 0) >= wantTicks,
  };
};

/* Bring the target measure into the viewport so the screenshot shows it. */
const focusMeasure = async () => {
  const measures = model.allMeasures();
  const id = measures[MI]?.getAttribute('xml:id');
  const el = id ? document.getElementById(id) : null;
  if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
  await sleep(120);
  out.measureVisible = !!el;
  if (el) {
    const b = el.getBoundingClientRect();
    out.measureRect = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  }
};

await mountAll();
curAt(MI);
out.before = layerState('before');

if (phase === 'after') {
  const steps = [];
  if (which === 'ripple') {
    curAt(MI);
    steps.push(['deleteAtCursor', model.deleteAtCursor()]);
    curAt(MI);
    steps.push(['insertRestAtCursor(8)', model.insertRestAtCursor({ duration: '8', dots: 0 })]);
    /* 8th = 8 ticks. Snapshot the room BEFORE the refused call. */
    out.roomBeforeRefused = roomReport('beforeChord', 8);
    steps.push(['insertChordAtCursor(8)', model.insertChordAtCursor({ notes: [mkNote], duration: '8', dots: 0 })]);
  } else {
    curAt(MI);
    steps.push(['deleteAtCursor', model.deleteAtCursor()]);
    curAt(MI);
    /* quarter = 16 ticks. */
    out.roomBeforeRefused = roomReport('beforeChord', 16);
    steps.push(['insertChordAtCursor(4)', model.insertChordAtCursor({ notes: [mkNote], duration: '4', dots: 0 })]);
  }
  out.steps = steps.map(([k, v]) => [k, (v && typeof v === 'object') ? v : String(v)]);
  reRender();
  await waitFor(badgeHidden, 60000, 40);
  await mountAll();
  out.after = layerState('after');
  out.spliceOutcome = r['pageSplicer']?.lastOutcome ?? '';
}

await focusMeasure();
return out;
