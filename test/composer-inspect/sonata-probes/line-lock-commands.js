// Manual line breaks (2026-09-11/12) on the SONATA: Alt+Shift+↓ mid-system on
// page 3, undo, redo; padlock click. Reports
// for each step: derive reason (must be ''), lines moved, refill/splice ms,
// the splice outcome, balance stats, page overflow (must be none), and the
// partition diff against the pre-command one (undo must be byte-identical).
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

const out = { errs: [], warns: [], steps: [] };
const oe = console.error, ow = console.warn;
console.error = (...a) => { out.errs.push(a.join(' ').slice(0, 200)); oe(...a); };
console.warn = (...a) => { out.warns.push(a.join(' ').slice(0, 200)); ow(...a); };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.error = oe; console.warn = ow; return out; }
await waitFor(badgeHidden, 60000, 100);

const ids = () => model.allMeasures().map((m) => m.getAttribute('xml:id'));
const L = () => { const I = ids(); return pb.lineStarts().map((id) => I.indexOf(id)); };
const diffLines = (a, b) => { const A = new Set(a), B = new Set(b); let d = 0; for (const x of A) if (!B.has(x)) d++; for (const x of B) if (!A.has(x)) d++; return d; };
const overflowReport = () => {
  const bad = [];
  for (const pageEl of Array.from(document.querySelectorAll('#score .score-page:not(.score-page-pending)'))) {
    const svg = pageEl.querySelector('svg');
    const systems = Array.from(pageEl.querySelectorAll('g.system'));
    if (!svg || !systems.length) continue;
    const box = svg.getBoundingClientRect();
    const last = systems[systems.length - 1].getBoundingClientRect();
    if (last.bottom > box.bottom + 2) bad.push({ page: +pageEl.dataset.page, overhangPx: Math.round(last.bottom - box.bottom) });
  }
  return bad;
};
const locks = () => Array.from(document.querySelectorAll('g.hkl-lock')).map((g) => g.getAttribute('data-for'));
const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
const key = async (k, o) => {
  const n0 = r.renderLedger().length;
  const t0 = performance.now();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
  await waitFor(() => r.renderLedger().length > n0 && badgeHidden(), 60000, 30);
  await sleep(80);
  return Math.round(performance.now() - t0);
};
const step = async (name, fn) => {
  const before = L();
  const ms = await fn();
  const after = L();
  const led = r.renderLedger().slice(-1)[0] ?? {};
  out.steps.push({ name, ms, status: status(), derive: pb.lastDeriveReason, refillLines: pb.lastRefillLines, ledger: led,
    balance: pb.lastBalance, linesBefore: before.length, linesAfter: after.length, startsChanged: diffLines(before, after),
    overflow: overflowReport(), locks: locks().length, sigCtx: pb.sigCtxStats().misses });
  return after;
};

/* Target: a mid-system measure on page 3. */
const I = ids();
const lines = pb.lineStarts(), pages = pb.pageStarts();
const k3 = lines.indexOf(pages[2] ?? pages[pages.length - 1]);
const target = I.indexOf(lines[k3 + 1]) + 1;
out.target = target;
r.ensureMeasureMounted(target);
model.setCursor(model.getMeasureStartCursor(1, target), 1);
r.ensureMeasureMounted(target);
await sleep(200);
const pre = L();
out.pre = { lines: pre.length, pages: pb.pageStarts().length };

const post = await step('push (Alt+Shift+↓)', () => key('ArrowDown', { altKey: true, shiftKey: true }));
out.pushLockAtTarget = model.hardBreakBefore(target);
out.pushTargetStartsLine = post.includes(target);
const afterUndo = await step('undo', () => key('z', { ctrlKey: true }));
out.undoIdentical = JSON.stringify(afterUndo) === JSON.stringify(pre);
out.undoLockGone = model.hardBreakBefore(target) === null;
const afterRedo = await step('redo', () => key('y', { ctrlKey: true }));
out.redoIdentical = JSON.stringify(afterRedo) === JSON.stringify(post);

/* Unlock by click. */
const lock = document.querySelector('g.hkl-lock');
out.hadLock = !!lock;
if (lock) {
  await step('unlock (click)', async () => {
    const n0 = r.renderLedger().length; const t0 = performance.now();
    lock.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await waitFor(() => r.renderLedger().length > n0 && badgeHidden(), 60000, 30);
    return Math.round(performance.now() - t0);
  });
  out.unlockGone = model.hardBreakBefore(target) === null;
}
console.error = oe; console.warn = ow;
return out;
