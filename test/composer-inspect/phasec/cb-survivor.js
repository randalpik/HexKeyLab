// CONTRACT PROBE (2026-09-03): "a splice only affects the replaced set of systems."
//
// Measures the live DOM BEFORE a splice against the live DOM AFTER, in PAGE-LOCAL
// coordinates — same document, same snapping, no reference render and no
// cross-coordinate comparison, so none of the measurement asymmetries that
// derailed the first investigation apply. Systems are matched across the edit by
// their FIRST MEASURE id, not by index.
//
// Survivors are classified by position relative to the replaced set:
//   BEFORE / other page -> must NEVER move; any movement is a contract violation
//   AFTER               -> may move, since the rule accumulates the replaced
//                          system's own extents downward
//
// Self-validation: a no-op reRender must report ZERO movement. If that fails the
// harness is wrong and nothing else it prints means anything (lessons.md).
// Args: --arg "from=1,stride=7,limit=12"
const H = window.__hkl_composer; const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'], ps = r['pageSplicer'];
const container = document.getElementById('score');
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const args = {}; for (const kv of String(window.__probeArg ?? '').split(',')) { const [k, v] = kv.split('='); if (k) args[k.trim()] = v === undefined ? '1' : v.trim(); }
const FROM = Math.max(1, Number(args.from ?? 1));
const STRIDE = Math.max(1, Number(args.stride ?? 1));
const LIMIT = Number(args.limit ?? 8);

const parseD = (d) => { const m = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d || ''); if (!m) return null; if (Math.abs(+m[2] - +m[4]) > 1e-6) return null; return { y: +m[2] }; };
const tfyLocal = (el, pageEl) => { let y = 0, n = el; while (n && n !== pageEl && n.nodeType === 1) { const t = (n.getAttribute && n.getAttribute('transform')) || ''; const m = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(t); if (m) y += +m[2]; n = n.parentElement; } return y; };
const snapshot = () => {
  const out = new Map();
  for (const pageEl of Array.from(container.querySelectorAll('.score-page:not(.score-page-pending)'))) {
    const pn = +pageEl.dataset.page;
    Array.from(pageEl.querySelectorAll('g.system')).forEach((sy, idx) => {
      const id = (sy.querySelector('g.measure') || {}).id || null;
      if (!id) return;
      let top = Infinity, bot = -Infinity;
      for (const st of Array.from(sy.querySelectorAll('g.staff'))) {
        const off = tfyLocal(st, pageEl);
        for (const p of Array.from(st.children)) {
          if (p.localName !== 'path') continue;
          const d = parseD(p.getAttribute('d')); if (!d) continue;
          const y = d.y + off;
          if (y < top) top = y; if (y > bot) bot = y;
        }
      }
      if (isFinite(top)) out.set(id, { page: pn, idx, top: +top.toFixed(2), span: +(bot - top).toFixed(2) });
    });
  }
  return out;
};
const diff = (A, B) => {
  const moved = [];
  for (const [id, a] of A) {
    const b = B.get(id);
    if (!b) continue;                                   // left the mounted set
    const dTop = +(b.top - a.top).toFixed(2), dSpan = +(b.span - a.span).toFixed(2);
    if (Math.abs(dTop) > 0.005 || Math.abs(dSpan) > 0.005 || a.page !== b.page) {
      moved.push({ id: id.slice(-8), page: a.page, toPage: b.page, idx: a.idx, dTop, dSpan });
    }
  }
  return moved;
};

await waitFor(() => pb['startIds'] !== null, 120000, 100);
await waitFor(badgeHidden, 90000, 40);
for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { reRender(); await waitFor(badgeHidden, 60000, 30); }
const out = { ownership: pb.ownershipActive(), lines: (pb['startIds'] || []).length, edits: [] };

/* self-validation */
const s0 = snapshot();
reRender(); await waitFor(badgeHidden, 60000, 30);
out.selfCheck = diff(s0, snapshot());
out.selfCheckClean = out.selfCheck.length === 0;

for (let LINE = FROM, done = 0; LINE < (pb['startIds'] || []).length && done < LIMIT; LINE += STRIDE) {
  const ids = model.allMeasures().map((x) => x.getAttribute('xml:id'));
  const startIds = pb['startIds'];
  const mi = ids.indexOf(startIds[LINE]);
  if (mi < 0) continue;
  const psl = []; for (const id of pb.pageStarts()) { const k = startIds.indexOf(id); if (k >= 0) psl.push(k); }
  psl.sort((a, b) => a - b);
  let pg = 1; for (let i = 0; i < psl.length; i++) if (psl[i] <= LINE) pg = i + 1;
  for (const p of [pg - 1, pg, pg + 1]) if (p >= 1) r['mountPage'](p);
  await sleep(120);
  const cur = model.getFirstVisualCursorInMeasure(1, mi + 1, 'overwrite');
  if (cur < 0) continue;
  const before = snapshot();
  const snap = model.snapshotState();
  model.setCursor(cur, 1);
  const ver = model.docVersion();
  const okEdit = model.deleteAtCursor();
  if (!okEdit || model.docVersion() === ver) { model.restoreSnapshot(snap); continue; }
  reRender(); await waitFor(badgeHidden, 60000, 30);
  const after = snapshot();
  const hunk = ps.lastHunk ? { a: ps.lastHunk.a, bOld: ps.lastHunk.bOld, bNew: ps.lastHunk.bNew } : null;
  const newStarts = pb['startIds'];
  const replaced = new Set();
  if (hunk) for (let k = hunk.a; k <= hunk.bNew && k < newStarts.length; k++) replaced.add(newStarts[k]);
  let rPage = Infinity, rIdx = Infinity;
  for (const [id, v] of after) if (replaced.has(id)) { if (v.page < rPage || (v.page === rPage && v.idx < rIdx)) { rPage = v.page; rIdx = v.idx; } }
  const cls = { before: [], after: [], otherPage: [], replaced: [] };
  for (const m of diff(before, after)) {
    const full = [...replaced].some((x) => x.slice(-8) === m.id);
    if (full) { cls.replaced.push(m); continue; }
    const pos = after.get([...after.keys()].find((k) => k.slice(-8) === m.id));
    const page = pos ? pos.page : m.page, idx = pos ? pos.idx : m.idx;
    if (page < rPage || (page === rPage && idx < rIdx)) cls.before.push(m);
    else if (page > rPage) cls.otherPage.push(m);
    else cls.after.push(m);
  }
  out.edits.push({ line: LINE, outcome: ps.lastOutcome, skip: ps.lastSkipReason, hunk,
    replacedAt: { page: rPage === Infinity ? null : rPage, idx: rIdx === Infinity ? null : rIdx },
    systems: before.size,
    nBefore: cls.before.length, nAfter: cls.after.length, nOther: cls.otherPage.length, nReplaced: cls.replaced.length,
    before: cls.before.slice(0, 6), otherPage: cls.otherPage.slice(0, 6), after: cls.after.slice(0, 4) });
  model.restoreSnapshot(snap);
  reRender(); await waitFor(badgeHidden, 60000, 30);
  done++;
}
return out;
