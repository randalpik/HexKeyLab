// Probe 12: final end-to-end verification of the sig-diff refill on the sonata.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 60) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const settle = async () => { await waitFor(badgeHidden); await sleep(250); await waitFor(badgeHidden); };
const infos = [], warns = [], errs = [];
const oi = console.info, ow = console.warn, oe = console.error;
console.info = (...a) => { infos.push(a.join(' ').slice(0, 120)); oi(...a); };
console.warn = (...a) => { warns.push(a.join(' ').slice(0, 120)); ow(...a); };
console.error = (...a) => { errs.push(a.join(' ').slice(0, 120)); oe(...a); };
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;
out.lines0 = pb['startIds'].length;

const renderedOk = () => {
  const pos = new Map(pb['startIds'].map((id, i) => [id, i]));
  let prevEnd = -1;
  for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
    const starts = [];
    for (const sys of page.querySelectorAll('g.system')) {
      const m = sys.querySelector('g.measure');
      if (m && m.id) starts.push(m.id);
    }
    if (!starts.length) continue;
    const at = pos.get(starts[0]);
    if (at == null || at <= prevEnd) return false;
    for (let i = 1; i < starts.length; i++) if (pos.get(starts[i]) !== at + i) return false;
    prevEnd = at + starts.length - 1;
  }
  return true;
};
const edit = async (name, fn) => {
  const t0 = performance.now();
  const okEdit = fn();
  reRender();
  await settle();
  return { name, okEdit: okEdit !== false && okEdit !== null,
    wallMs: Math.round(performance.now() - t0),
    refillLines: pb.lastRefillLines, stats: { ...pb.lastRefillStats },
    deriveTaken: pb['adoption'] !== null, pinsOk: renderedOk(),
    lines: pb['startIds'] ? pb['startIds'].length : -1 };
};
const curAt = (mi) => { model.setCursor(model.getMeasureStartCursor(1, mi), 1); };
out.e1 = await edit('delete-m50', () => { curAt(50); return model.deleteAtCursor(); });
out.e2 = await edit('delete-m50-again', () => { curAt(50); return model.deleteAtCursor(); });
out.e3 = await edit('delete-near-end', () => { curAt(model.allMeasures().length - 3); return model.deleteAtCursor(); });
// no-op render request
const snap = pb['startIds'].join();
reRender();
await settle();
out.noopStable = pb['startIds'].join() === snap;
out.infos = infos; out.warns = warns; out.errs = errs;
console.info = oi; console.warn = ow; console.error = oe;
return out;
