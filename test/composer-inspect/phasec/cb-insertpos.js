// Is insert-measure POSITION-DEPENDENT? (2026-09-02, Max: "adding a measure
// somewhere on the first page still takes over 3 seconds", while the
// mid-document probe measured 288 ms.) Inserts a blank measure at a spread of
// positions from the same baseline and reports wall, outcome, the replaced
// LINE run, the window size and the refill's own breakdown — the numbers that
// separate "wide changed run" from "expensive mutation".
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'], ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 10) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null, 120000, 100);
await waitFor(badgeHidden, 90000, 40);
const key = (k, mods = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods }));

const N = model.allMeasures().length;
const spec = String(window.__probeArg || '');
const POS = (spec.match(/pos=([\d,]+)/)?.[1] ?? '2,8,20,60,120,223,340,440').split(',').map(Number);
const out = { measures: N, lines: pb['startIds'].length, sections: model.getDoc().querySelectorAll('sb[data-hkl-section="true"]').length, rows: [] };

/* @n is part of the per-measure signature (linebreaks captureSigs serialises
   the whole measure), and renumberMeasures is section-aware, so how far an
   insert's @n rewrite reaches is the hypothesis under test. Record it. */
const nOf = () => model.allMeasures().map((m) => m.getAttribute('n') ?? '');

const mountAround = async (mi) => {
  if (!r['ensureTkHoldsPageLayout']()) return;
  const ids = model.allMeasures().map((m) => m.getAttribute('xml:id'));
  const page = r['tk'].getPageWithElement(ids[Math.min(mi, ids.length - 1)]);
  for (const p of [page - 1, page, page + 1]) if (p >= 1) r['mountPage'](p);
  await sleep(60);
};

const CASES = [];
for (const mi of POS) if (mi >= 0 && mi < N) CASES.push({ name: 'insert @m' + mi, mi, kind: 'insert' });
CASES.push({ name: 'delete-measure-content @m8', mi: 8, kind: 'delsel' });
CASES.push({ name: 'note-delete @m8 (control)', mi: 8, kind: 'note' });

const ow = console.warn; const warns = [];
console.warn = (...a) => { const t = a.join(' '); if (!/^\[Warning\]/.test(t)) warns.push(t); };

for (const c of CASES) {
  await mountAround(c.mi);
  const cur = model.getFirstVisualCursorInMeasure(1, c.mi, 'overwrite');
  if (cur < 0) { out.rows.push({ name: c.name, error: 'no cursor' }); continue; }
  model.setCursor(cur, 1);
  const snap = model.snapshotState();
  const nBefore = nOf();
  warns.length = 0;
  ps.lastOutcome = ''; ps.lastSkipReason = ''; pb.lastDeriveReason = '';
  r.clearRenderLedger?.();
  const t0 = performance.now();
  if (c.kind === 'insert') key('m');
  else if (c.kind === 'delsel') { key('ArrowDown', { shiftKey: true }); key('Backspace'); }
  else key('Backspace');
  await waitFor(badgeHidden, 60000, 5);
  const wall = Math.round(performance.now() - t0);
  /* How many measures had their printed number rewritten: the reach of the
     renumber, i.e. how many measures the signature diff must see as changed. */
  const nAfter = nOf();
  let renumbered = 0;
  const shift = c.kind === 'insert' ? 1 : 0;
  for (let i = 0; i + shift < nAfter.length && i < nBefore.length; i++) {
    if (nBefore[i] !== nAfter[i + shift]) renumbered++;
  }
  out.rows.push({
    name: c.name, mi: c.mi, wallMs: wall,
    outcome: ps.lastOutcome || '(none)', derive: pb.lastDeriveReason || '', skip: ps.lastSkipReason || '',
    run: ps.lastRun, hunk: ps.lastHunk,
    spliceLines: ps.lastStats.lines, windowLines: ps.lastStats.windowLines, windowMeasures: ps.lastStats.windowMeasures,
    loadMs: ps.lastStats.loadMs, spliceMs: ps.lastStats.totalMs,
    refill: { ...pb.lastRefillStats }, refillLines: pb.lastRefillLines,
    renumberedTail: renumbered,
    ledger: r.renderLedger ? r.renderLedger().map((x) => (x.full ? 'FULL:' + (x.deriveReason || x.skipReason || '?') : x.outcome)) : null,
    warns: warns.slice(0, 2),
  });
  model.restoreSnapshot(snap);
  reRender();
  await waitFor(badgeHidden, 60000, 20);
  await waitFor(() => pb['startIds'] !== null, 60000, 50);
}
console.warn = ow;
return out;
