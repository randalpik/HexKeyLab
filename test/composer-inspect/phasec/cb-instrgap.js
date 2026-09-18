// Inter-instrument clearance census + system-residue inventory (2026-09-08,
// the gate for the "elements too close to the next instrument" Layout item).
//
// After the sonata loads and every page is mounted, for every ADJACENT
// INSTRUMENT PAIR in every system:
//   • dOwn    — a mark's distance from its OWN staff's near line
//   • dOther  — its distance to the nearest ink or line of the other instrument
//               within its x-range
//   • demand  — max(0, min(dOwn, CAP) - dOther), the shift that would make the
//               mark read as belonging to its own staff again
// plus a bare INK FLOOR term (any cross-instrument ink pair closer than one
// staff space) and the residue inventory that decides how a shift pass would
// attribute non-staff elements.
//
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/cb-instrgap.js
//   --arg "from=0,limit=40"   chunk the per-mark rows (they are many)
//   --arg "rows=0"            summary + residue only
//
// Every measurement is in the page-margin group's USER space (getBBox mapped
// through getCTM), the same frame textlayout.ts writes its translates in —
// never screen rectangles, which differ between hosts by sub-pixel phase.
const H = window.__hkl_composer; const r = H.renderer; const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 40) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const arg0 = String(window.__probeArg || '');
/* SETTLE PROPERLY. The idle balance job is gone (the whole document balances
   before the paint). Historically `balanceJobActive()` was false BEFORE the job was armed, so
   waiting for !active returns instantly and hands back a PRE-SETTLE layout —
   on the sonata the partition is still 31 pages / 115 lines at t=0 and only
   reaches its final 30 / 113 at ~5.7 s. Reading early produced a stale extra
   page div and an apparently dropped system. So wait for the PARTITION ITSELF
   to stop changing, with every busy flag clear. See lessons.md. */
const partitionSig = () => (pb['pageStartIds'] || []).join(',') + '|' + pb.lineStarts().length;
const idle = () => {
  const b = document.getElementById('renderBusy');
  return (!b || b.hidden) && r.extentsJobState() === null;
};
const settleFully = async (stableMs = 4000, budget = 150000) => {
  const t0 = performance.now();
  let last = null, since = 0;
  while (performance.now() - t0 < budget) {
    const s = partitionSig();
    if (s !== last) { last = s; since = performance.now(); }
    else if (idle() && performance.now() - since > stableMs) return true;
    await sleep(200);
  }
  return false;
};
await waitFor(() => pb['startIds'] !== null, 60000);
const settled = await settleFully();
r.setMountWindowEnabled(false); r.mountAllPages(); await settleFully(2500); await sleep(400);

const arg = arg0;
const numArg = (k, d) => { const m = arg.match(new RegExp(k + '=(-?\\d+)')); return m ? parseInt(m[1], 10) : d; };
const FROM = numArg('from', 0), LIMIT = numArg('limit', 10000), WANT_ROWS = numArg('rows', 1);

/* Constants mirrored from the design (user units at unit 8: 1 space = 160). */
const PAD = 40, SPACE = 160, CAP = 480;

/* Instrument staff groups, in score order. */
const instrs = H.model.instruments().map((i) => ({ name: i.name, staffNs: i.staffNs.slice() }));
const instrOfStaff = new Map();
instrs.forEach((ins, k) => ins.staffNs.forEach((n) => instrOfStaff.set(n, k)));
const boundaries = [];
for (let k = 0; k + 1 < instrs.length; k++) {
  boundaries.push({ k, upperN: instrs[k].staffNs[instrs[k].staffNs.length - 1], lowerN: instrs[k + 1].staffNs[0] });
}

const OBSTACLE_SEL = 'g.note, g.rest, g.mRest, g.accid, g.beam, g.stem, g.clef, g.keySig, g.meterSig, g.tupletBracket, g.tupletNum, g.artic, g.dots, g.ledgerLines, g.flag';
const MARK_SEL = 'g.dynam, g.dir, g.hairpin, g.tempo';

const boxIn = (el, inv) => {
  let b; try { b = el.getBBox(); } catch { return null; }
  if (!b || !(b.width >= 0)) return null;
  const ctm = el.getCTM && el.getCTM(); if (!ctm) return null;
  const m = inv.multiply(ctm);
  const p = (x, y) => { const q = new DOMPoint(x, y).matrixTransform(m); return q; };
  const a = p(b.x, b.y), c = p(b.x + b.width, b.y + b.height);
  return { left: Math.min(a.x, c.x), right: Math.max(a.x, c.x), top: Math.min(a.y, c.y), bottom: Math.max(a.y, c.y) };
};
/* A staff row's line band, from the staff's own horizontal path children. */
const rowsOfSystem = (sys, inv) => {
  const out = new Map();
  for (const st of sys.querySelectorAll('g.staff')) {
    const n = parseInt(st.getAttribute('data-n') || '', 10); if (!Number.isFinite(n)) continue;
    for (const path of st.children) {
      if (path.tagName !== 'path') continue;
      const b = boxIn(path, inv); if (!b) continue;
      if (b.bottom - b.top > PAD) continue;                 // not a staff line
      const cur = out.get(n) || { n, top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity };
      cur.top = Math.min(cur.top, b.top); cur.bottom = Math.max(cur.bottom, b.bottom);
      cur.left = Math.min(cur.left, b.left); cur.right = Math.max(cur.right, b.right);
      out.set(n, cur);
    }
  }
  return out;
};

const pages = [...document.querySelectorAll('#score .score-page')];
const rows = [], inkRows = [], residue = new Map(), spanPaths = [];
let systemsSeen = 0, marksSeen = 0;

for (let pi = 0; pi < pages.length; pi++) {
  const pageEl = pages[pi];
  for (const sys of pageEl.querySelectorAll('g.system')) {
    const frame = sys.parentElement;
    const fctm = frame && frame.getCTM && frame.getCTM(); if (!fctm) continue;
    const inv = fctm.inverse();
    systemsSeen++;
    const bandRows = rowsOfSystem(sys, inv);
    const firstMeasureN = sys.querySelector('g.measure')?.id || '';

    /* ── residue inventory: every g in the system outside any g.staff ── */
    for (const g of sys.querySelectorAll('g')) {
      if (g.closest('g.staff')) continue;
      const cls = (g.getAttribute('class') || '').split(/\s+/)[0];
      if (!cls || cls === 'measure' || cls === 'pb' || cls === 'sb') continue;
      const key = cls + '|' + (g.hasAttribute('data-staff') ? 'staff' : g.hasAttribute('data-startid') ? 'startid' : 'NEITHER');
      residue.set(key, (residue.get(key) || 0) + 1);
    }
    /* ── a path spanning the whole system vertically (bracket / system start) ── */
    const allTop = Math.min(...[...bandRows.values()].map((x) => x.top));
    const allBot = Math.max(...[...bandRows.values()].map((x) => x.bottom));
    for (const path of sys.querySelectorAll('path')) {
      if (path.closest('g.staff')) continue;
      const b = boxIn(path, inv); if (!b) continue;
      if (b.bottom - b.top > (allBot - allTop) * 0.9 && b.right - b.left < SPACE) {
        spanPaths.push({ page: pi + 1, cls: (path.parentElement.getAttribute('class') || '').split(/\s+/)[0], h: Math.round(b.bottom - b.top), x: Math.round(b.left) });
      }
    }

    /* ── per-boundary marks ── */
    for (const bd of boundaries) {
      const up = bandRows.get(bd.upperN), lo = bandRows.get(bd.lowerN);
      if (!up || !lo) continue;
      const lineGap = Math.round(lo.top - up.bottom);
      /* obstacles of a row, across every measure of the system */
      const obstaclesOf = (n, l, rr) => {
        const out = [];
        for (const st of sys.querySelectorAll('g.staff')) {
          if (parseInt(st.getAttribute('data-n') || '', 10) !== n) continue;
          for (const o of st.querySelectorAll(OBSTACLE_SEL)) {
            const b = boxIn(o, inv); if (!b) continue;
            if (!(b.right > b.left) || !(b.bottom > b.top)) continue;   // degenerate: not ink
            if (b.right < l - PAD || b.left > rr + PAD) continue;
            out.push({ ...b, cls: [...o.classList][0], w: b.right - b.left, h: b.bottom - b.top });
          }
        }
        /* the other instrument's own marks count as ink: after the anchor fix
           an upper below-mark and a lower above-mark can share a moment. */
        for (const mk of sys.querySelectorAll(MARK_SEL)) {
          if (parseInt(mk.getAttribute('data-staff') || '', 10) !== n) continue;
          const b = boxIn(mk, inv); if (!b) continue;
          if (!(b.right > b.left) || !(b.bottom > b.top)) continue;
          if (b.right < l - PAD || b.left > rr + PAD) continue;
          out.push({ ...b, cls: 'mark:' + [...mk.classList][0], w: b.right - b.left, h: b.bottom - b.top });
        }
        return out;
      };
      for (const mk of sys.querySelectorAll(MARK_SEL)) {
        const sN = parseInt(mk.getAttribute('data-staff') || '', 10);
        const place = mk.getAttribute('data-place') || (mk.classList.contains('tempo') ? 'above' : '');
        const box = boxIn(mk, inv); if (!box) continue;
        if (!(box.right > box.left) || !(box.bottom > box.top)) continue;
        let dOwn = null, dOther = null, side = null;
        if (sN === bd.upperN && place === 'below') {
          side = 'upperBelow';
          dOwn = box.top - up.bottom;
          let near = lo.top;
          for (const b of obstaclesOf(bd.lowerN, box.left, box.right)) if (b.top > box.bottom) near = Math.min(near, b.top);
          dOther = near - box.bottom;
        } else if (sN === bd.lowerN && place === 'above') {
          side = 'lowerAbove';
          dOwn = lo.top - box.bottom;
          let near = up.bottom;
          for (const b of obstaclesOf(bd.upperN, box.left, box.right)) if (b.bottom < box.top) near = Math.max(near, b.bottom);
          dOther = box.top - near;
        } else continue;
        marksSeen++;
        const demand = Math.max(0, Math.min(dOwn, CAP) - dOther);
        rows.push({
          page: pi + 1, sys: systemsSeen, m: mk.closest('g.measure')?.id?.slice(0, 12) || '',
          side, cls: [...mk.classList][0], staff: sN,
          text: (mk.textContent || '').trim().slice(0, 12),
          dOwn: Math.round(dOwn), dOther: Math.round(dOther), demand: Math.round(demand),
          nearer: dOther < dOwn, tight: dOther < SPACE, lineGap,
        });
      }
      /* ── bare ink floor: closest cross-instrument ink pair in this system ── */
      let worst = Infinity, wx = null;
      const upInk = obstaclesOf(bd.upperN, -Infinity, Infinity), loInk = obstaclesOf(bd.lowerN, -Infinity, Infinity);
      for (const a of upInk) for (const b of loInk) {
        if (b.left > a.right + PAD || b.right < a.left - PAD) continue;
        const d = b.top - a.bottom;
        if (d >= 0 && d < worst) { worst = d; wx = { up: a.cls, upW: Math.round(a.w), upH: Math.round(a.h), lo: b.cls, loW: Math.round(b.w), loH: Math.round(b.h), x: Math.round(a.left) }; }
      }
      if (worst < SPACE) inkRows.push({ page: pi + 1, sys: systemsSeen, gap: Math.round(worst), x: wx, demand: Math.round(SPACE - worst) });
    }
  }
}

const dem = rows.map((x) => x.demand).filter((d) => d > 0).sort((a, b) => a - b);
const pct = (p) => dem.length ? dem[Math.min(dem.length - 1, Math.floor(dem.length * p))] : 0;
const sysWithDemand = new Set(rows.filter((x) => x.demand > 0).map((x) => x.sys));
for (const x of inkRows) sysWithDemand.add(x.sys);
return {
  settled,
  instruments: instrs, boundaries, pages: pages.length, systems: systemsSeen,
  marksAtBoundaries: marksSeen,
  nearerOther: rows.filter((x) => x.nearer).length,
  withinOneSpace: rows.filter((x) => x.tight).length,
  demand: { marks: dem.length, p50: pct(0.5), p90: pct(0.9), max: dem.length ? dem[dem.length - 1] : 0 },
  systemsThatWouldMove: sysWithDemand.size,
  systemsMovedByMarksOnly: new Set(rows.filter((x) => x.demand > 0).map((x) => x.sys)).size,
  systemsMovedByInkFloorOnly: new Set(inkRows.map((x) => x.sys)).size,
  worstMarks: rows.filter((x) => x.demand > 0).sort((a, b) => b.demand - a.demand).slice(0, 12),
  inkFloorViolations: { count: inkRows.length, rows: WANT_ROWS ? inkRows.slice(FROM, FROM + LIMIT) : [] },
  residue: Object.fromEntries([...residue.entries()].sort()),
  systemSpanningPaths: { count: spanPaths.length, sample: spanPaths.slice(0, 6) },
  rowTotal: rows.length,
  rows: WANT_ROWS ? rows.filter((x) => x.demand > 0 || x.nearer).slice(FROM, FROM + LIMIT) : [],
};
