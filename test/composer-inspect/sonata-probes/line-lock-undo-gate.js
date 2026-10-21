// Line-break undo/redo exactness on the SONATA (2026-10-20, partition spec
// Phase 4). Line-break commands carry no layout on their history entry: the
// partition is F of the document, so undo/redo must land exactly on the layout
// the other side of the command had. Per target (mid-system on pages 3, 40 %,
// 65 % and 90 % through, plus a section-final line): lock, undo, redo, undo;
// then lock, padlock click, undo, redo, undo, undo. Every step records line AND
// page starts against the expected side, F-of-document agreement, derive
// reason, pins in order and page overflow. Pass: `allEq: true`. The first run
// of this check (with the then-existing LayoutSnapshot restore disabled) is
// what retired the restore — see decisions.md.
//
// Waits for the layout to QUIESCE (line + page starts stable 1.5 s) before
// each baseline: after load, deferred pages engrave on mount and re-fit, so
// page starts can still move after the render has settled (a baseline taken
// 300 ms after mounting read 25 page starts "moved" by an exact undo).
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 60) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const out = { errs: [], warns: [], targets: [] };
const oe = console.error, ow = console.warn;
console.error = (...a) => { out.errs.push(a.join(' ').slice(0, 200)); oe(...a); };
console.warn = (...a) => { out.warns.push(a.join(' ').slice(0, 200)); ow(...a); };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.error = oe; console.warn = ow; return out; }
await waitFor(badgeHidden, 60000, 100);

const ids = () => model.allMeasures().map((m) => m.getAttribute('xml:id'));
const snap = () => { const I = ids(); return { L: pb.lineStarts().map((id) => I.indexOf(id)), P: pb.pageStarts().map((id) => I.indexOf(id)) }; };
const J = JSON.stringify;
const same = (a, b) => J(a.L) === J(b.L) && J(a.P) === J(b.P);
const diff = (a, b) => { const A = new Set(a), B = new Set(b); let d = 0; for (const x of A) if (!B.has(x)) d++; for (const x of B) if (!A.has(x)) d++; return d; };
const pinsInOrder = () => {
  const starts = pb['startIds'] ?? []; const pos = new Map(starts.map((id, i) => [id, i]));
  let prevEnd = -1;
  for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
    const s = [...page.querySelectorAll('g.system')].map((g) => g.querySelector('g.measure')?.id).filter(Boolean);
    if (!s.length) continue;
    const at = pos.get(s[0]); if (at == null || at <= prevEnd) return false;
    for (let i = 1; i < s.length; i++) if (pos.get(s[i]) !== at + i) return false;
    prevEnd = at + s.length - 1;
  }
  return true;
};
const overflow = () => {
  const bad = [];
  for (const pageEl of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
    const svg = pageEl.querySelector('svg'); const sys = pageEl.querySelectorAll('g.system');
    if (!svg || !sys.length) continue;
    const ov = sys[sys.length - 1].getBoundingClientRect().bottom - svg.getBoundingClientRect().bottom;
    if (ov > 2) bad.push(+pageEl.dataset.page);
  }
  return bad;
};
const settle = async (fire) => {
  const n0 = r.renderLedger().length; const t0 = performance.now();
  fire();
  await waitFor(() => r.renderLedger().length > n0 && badgeHidden(), 60000, 30);
  await sleep(80);
  return Math.round(performance.now() - t0);
};
const key = (k, o) => settle(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o })));

const quiesce = async () => {
  let last = J(snap()), since = performance.now(); const t0 = performance.now();
  while (performance.now() - t0 < 60000) {
    await sleep(150);
    const now = J(snap());
    if (now !== last || !badgeHidden()) { last = now; since = performance.now(); continue; }
    if (performance.now() - since >= 1500) return Math.round(performance.now() - t0);
  }
  return -1;
};
out.initialQuiesceMs = await quiesce();
const I0 = ids();
const lines0 = pb.lineStarts(), pages0 = pb.pageStarts();
const pick = [];
out.pages0 = pages0.length; out.lines0 = lines0.length;
for (const p of [2, 0.4, 0.65, 0.9].map((f) => (f >= 1 ? f : Math.floor(f * pages0.length)))) {
  const pg = pages0[Math.min(p, pages0.length - 1)];
  const k = lines0.indexOf(pg);
  if (k >= 0 && k + 1 < lines0.length) pick.push({ why: `page ${p + 1}, 2nd line, mid-system`, target: I0.indexOf(lines0[k + 1]) + 1 });
}
/* A section-final line: the line before a hard start (first hard start after line 10). */
const hardIdx = I0.map((_, i) => i).filter((i) => i > 0 && model.hardBreakBefore(i));
const hs = hardIdx.find((i) => lines0.map((id) => I0.indexOf(id)).filter((x) => x < i).length > 10);
if (hs != null) { const ls = lines0.map((id) => I0.indexOf(id)).filter((x) => x < hs); pick.push({ why: `section-final line before hard start ${hs}`, target: ls[ls.length - 1] + 1 }); }
out.picks = pick;

for (const { why, target } of pick) {
  const T = { why, target, steps: [] };
  out.targets.push(T);
  r.ensureMeasureMounted(target);
  model.setCursor(model.getMeasureStartCursor(1, target), 1);
  r.ensureMeasureMounted(target);
  T.quiesceMs = await quiesce();
  const pre = snap();
  const rec = (name, ms, want) => {
    const s = snap(); const F = (pb.partitionOfDocument(model) ?? []).map((id) => ids().indexOf(id));
    T.steps.push({ name, ms, eqWant: want ? same(s, want) : null, linesMoved: want ? diff(s.L, want.L) : null, pagesMoved: want ? diff(s.P, want.P) : null,
      isF: J(F) === J(s.L), derive: pb.lastDeriveReason, pins: pinsInOrder(), overflow: overflow(), outcome: (r.renderLedger().slice(-1)[0] ?? {}).outcome,
      lock: model.hardBreakBefore(target) });
    return s;
  };
  const post = rec('lock', await key('ArrowDown', { altKey: true, shiftKey: true }), null);
  T.postDiffersFromPre = !same(post, pre);
  rec('undo lock', await key('z', { ctrlKey: true }), pre);
  rec('redo lock', await key('y', { ctrlKey: true }), post);
  rec('undo lock again', await key('z', { ctrlKey: true }), pre);
  const post2 = rec('lock (2nd)', await key('ArrowDown', { altKey: true, shiftKey: true }), post);
  r.ensureMeasureMounted(target); await sleep(200);
  const glyph = document.querySelector(`g.hkl-lock[data-for="${ids()[target]}"]`);
  if (!glyph) { T.noGlyph = true; await key('z', { ctrlKey: true }); continue; }
  const unl = rec('unlock click', await settle(() => glyph.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))), pre);
  rec('undo unlock', await key('z', { ctrlKey: true }), post2);
  rec('redo unlock', await key('y', { ctrlKey: true }), unl);
  rec('undo unlock again', await key('z', { ctrlKey: true }), post2);
  rec('undo lock (2nd)', await key('z', { ctrlKey: true }), pre);
}
out.allEq = out.targets.every((t) => t.steps.every((s) => s.eqWant !== false && s.isF && s.derive === '' && s.pins && !s.overflow.length));
console.error = oe; console.warn = ow;
return out;
