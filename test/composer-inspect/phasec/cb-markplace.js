// Mark-placement inventory (2026-09-09) — the gate for "dynamics are mis-placed
// between the staves after the instrGap pass" (Max: sonata p. 9 m. 131's `pp`
// collides with the staff below and is nowhere near centred; p. 17 m. 37's
// `dim.` collides with a tuplet bracket, both with room unused above).
//
// cb-instrgap.js only measures marks at an INSTRUMENT BOUNDARY, so a mark
// mis-placed inside its own grand staff is invisible to it. This walks EVERY
// mark in the document and reports, in the page-margin group's user space:
//   • mode        — 'center' (inside a grand staff: the pass centres it in the
//                   gap) or 'mingap' (under any other staff)
//   • cErr        — center mode only: actual box centre − the gap's centre.
//                   POSITIVE = the mark sits too LOW. This is the number the
//                   double-counted instrument shift showed up in.
//   • above/below — clearance from the box to the nearest staff line or ink in
//                   its x-range on each side. NEGATIVE = a collision.
//   • ish/vsh     — the tags: instrgap's granted shift, textlayout's own dy.
//
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/cb-markplace.js
//   --arg "from=0,limit=40"    chunk the deviation rows
//   --arg "rows=0"             summary only
//   --arg "page=9"             every mark on one page, deviating or not
const H = window.__hkl_composer; const r = H.renderer; const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 40) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const arg = String(window.__probeArg || '');
const numArg = (k, d) => { const m = arg.match(new RegExp(k + '=(-?\\d+)')); return m ? parseInt(m[1], 10) : d; };
const FROM = numArg('from', 0), LIMIT = numArg('limit', 10000), WANT_ROWS = numArg('rows', 1), ONLY_PAGE = numArg('page', 0);

/* Settle the partition properly: the whole document is balanced before the
   paint, so waiting on the render badge is enough (the idle job is gone).
   Historical note: balanceJobActive() was false BEFORE the job was
   armed, so waiting on !active hands back a pre-settle layout. Wait for the
   partition signature itself to stop moving. (cb-instrgap.js, lessons.md.) */
const partitionSig = () => (pb['pageStartIds'] || []).join(',') + '|' + pb.lineStarts().length;
const idle = () => { const b = document.getElementById('renderBusy'); return (!b || b.hidden) && r.extentsJobState() === null; };
const settleFully = async (stableMs = 4000, budget = 150000) => {
  const t0 = performance.now(); let last = null, since = 0;
  while (performance.now() - t0 < budget) {
    const s = partitionSig();
    if (s !== last) { last = s; since = performance.now(); }
    else if (idle() && performance.now() - since > stableMs) return true;
    await sleep(200);
  }
  return false;
};
await waitFor(() => pb['startIds'] !== null, 60000);
await settleFully();
r.setMountWindowEnabled(false); r.mountAllPages(); await settleFully(2500); await sleep(400);

const PAD = 40, SPACE = 160;
const MARK_SEL = 'g.dynam, g.dir, g.hairpin, g.tempo';
const OBSTACLE_SEL = 'g.note, g.rest, g.mRest, g.accid, g.beam, g.stem, g.clef, g.keySig, g.meterSig, g.tupletBracket, g.tupletNum, g.artic, g.dots, g.ledgerLines, g.flag';

const instrs = H.model.instruments().map((i) => i.staffNs.slice());
const grandUpperOf = new Map(), grandLowerOf = new Map();
for (const ns of instrs) if (ns.length === 2) { grandLowerOf.set(ns[0], ns[1]); grandUpperOf.set(ns[1], ns[0]); }

const boxIn = (el, inv) => {
  let b; try { b = el.getBBox(); } catch { return null; }
  if (!b) return null;
  const ctm = el.getCTM && el.getCTM(); if (!ctm) return null;
  const m = inv.multiply(ctm);
  const p = (x, y) => new DOMPoint(x, y).matrixTransform(m);
  const a = p(b.x, b.y), c = p(b.x + b.width, b.y + b.height);
  return { left: Math.min(a.x, c.x), right: Math.max(a.x, c.x), top: Math.min(a.y, c.y), bottom: Math.max(a.y, c.y) };
};
const isInk = (b) => !!b && b.right > b.left && b.bottom > b.top;
/* Staff rows of ONE measure, from its staves' own line paths — the rows
   textlayout.ts measures against (rowsOf). */
const rowsOfMeasure = (measure, inv) => {
  const rows = [];
  for (const st of measure.children) {
    if (!st.classList || !st.classList.contains('staff')) continue;
    const n = parseInt(st.getAttribute('data-n') || '', 10); if (!Number.isFinite(n)) continue;
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    for (const p of st.children) {
      if (p.tagName !== 'path') continue;
      const b = boxIn(p, inv); if (!b || b.bottom - b.top > PAD) continue;
      top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom);
      left = Math.min(left, b.left); right = Math.max(right, b.right);
    }
    if (Number.isFinite(top)) rows.push({ n, top, bottom, left, right });
  }
  rows.sort((a, b) => a.top - b.top);
  return rows;
};

const pages = [...document.querySelectorAll('#score .score-page')];
const all = [];
let systemsSeen = 0;

for (let pi = 0; pi < pages.length; pi++) {
  if (ONLY_PAGE && pi + 1 !== ONLY_PAGE) continue;
  for (const sys of pages[pi].querySelectorAll('g.system')) {
    const frame = sys.parentElement;
    const fctm = frame && frame.getCTM && frame.getCTM(); if (!fctm) continue;
    const inv = fctm.inverse();
    systemsSeen++;
    /* Every ink box of the system, once, with its staff number. */
    const ink = [];
    for (const st of sys.querySelectorAll('g.staff')) {
      const n = parseInt(st.getAttribute('data-n') || '', 10);
      for (const o of st.querySelectorAll(OBSTACLE_SEL)) {
        const b = boxIn(o, inv); if (isInk(b)) ink.push({ ...b, n, cls: [...o.classList][0] });
      }
    }
    /* Staff line bands, per staff, across the system (for the clearance term). */
    const bands = [];
    for (const st of sys.querySelectorAll('g.staff')) {
      const n = parseInt(st.getAttribute('data-n') || '', 10);
      let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
      for (const p of st.children) {
        if (p.tagName !== 'path') continue;
        const b = boxIn(p, inv); if (!b || b.bottom - b.top > PAD) continue;
        top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom);
        left = Math.min(left, b.left); right = Math.max(right, b.right);
      }
      if (Number.isFinite(top)) bands.push({ n, top, bottom, left, right, cls: 'staffLines' });
    }

    let mIdx = 0;
    const mNumOf = new Map();
    for (const measure of sys.querySelectorAll('g.measure')) {
      mIdx++;
      const t = measure.querySelector('g.mNum');
      mNumOf.set(measure, { idx: mIdx, num: t ? (t.textContent || '').trim() : '' });
    }

    for (const mk of sys.querySelectorAll(MARK_SEL)) {
      const measure = mk.closest('g.measure'); if (!measure) continue;
      const sN = parseInt(mk.getAttribute('data-staff') || '', 10);
      const box = boxIn(mk, inv); if (!isInk(box)) continue;
      const rows = rowsOfMeasure(measure, inv);
      const own = rows.find((x) => x.n === sN); if (!own) continue;
      const idx = rows.indexOf(own);
      const place = mk.getAttribute('data-place') || (mk.classList.contains('tempo') ? 'above'
        : ((box.top + box.bottom) / 2 > (own.top + own.bottom) / 2 ? 'below' : 'above'));
      let mode = 'mingap', gapUp = null, gapLo = null;
      if (place === 'below') {
        const lower = idx + 1 < rows.length ? rows[idx + 1] : null;
        if (lower && grandLowerOf.get(sN) === lower.n) { mode = 'center'; gapUp = own; gapLo = lower; }
      } else {
        const upper = idx > 0 ? rows[idx - 1] : null;
        if (upper && grandUpperOf.get(sN) === upper.n) { mode = 'center'; gapUp = upper; gapLo = own; }
      }
      /* Clearance to the nearest line band or ink on each side, in x-range,
         excluding the mark's own group. Marks are not obstacles here — a
         stacked cluster legitimately touches. */
      let above = Infinity, below = Infinity, belowCls = '', aboveCls = '';
      for (const b of ink.concat(bands)) {
        if (b.right < box.left - PAD || b.left > box.right + PAD) continue;
        if (b.top >= box.bottom) { const d = b.top - box.bottom; if (d < below) { below = d; belowCls = b.cls + '@' + b.n; } }
        else if (b.bottom <= box.top) { const d = box.top - b.bottom; if (d < above) { above = d; aboveCls = b.cls + '@' + b.n; } }
        else {
          /* vertical overlap: a real collision — signed penetration */
          const pen = -Math.min(box.bottom - b.top, b.bottom - box.top);
          if (b.top + b.bottom > box.top + box.bottom) { if (pen < below) { below = pen; belowCls = b.cls + '@' + b.n; } }
          else if (pen < above) { above = pen; aboveCls = b.cls + '@' + b.n; }
        }
      }
      const mi = mNumOf.get(measure) || { idx: 0, num: '' };
      all.push({
        page: pi + 1, sys: systemsSeen, mIdx: mi.idx, mNum: mi.num,
        cls: [...mk.classList][0], text: (mk.textContent || '').trim().slice(0, 10),
        staff: sN, place, mode,
        cErr: mode === 'center' ? Math.round((box.top + box.bottom) / 2 - (gapUp.bottom + gapLo.top) / 2) : null,
        above: Number.isFinite(above) ? Math.round(above) : null,
        below: Number.isFinite(below) ? Math.round(below) : null,
        aboveCls, belowCls,
        ish: Math.round(parseFloat(mk.getAttribute('data-hkl-ishift') || '0') || 0),
        vsh: Math.round(parseFloat(mk.getAttribute('data-hkl-vshift') || '0') || 0),
      });
    }
  }
}

/* A deviation: badly off-centre in a grand staff, or overlapping ink/lines. */
const OFF = 20;                                   // a quarter unit
const bad = (x) => (x.cErr !== null && Math.abs(x.cErr) >= OFF)
  || (x.below !== null && x.below < 0) || (x.above !== null && x.above < 0);
const devs = all.filter(bad);
const centered = all.filter((x) => x.cErr !== null);
const collide = all.filter((x) => (x.below !== null && x.below < 0) || (x.above !== null && x.above < 0));
const shifted = all.filter((x) => x.ish !== 0);
const q = (a) => { const v = a.slice().sort((x, y) => x - y); return v.length ? { min: v[0], p50: v[Math.floor(v.length / 2)], max: v[v.length - 1] } : null; };

return {
  pages: pages.length, systems: systemsSeen, marks: all.length,
  summary: {
    centerMode: centered.length,
    centerOffBy20: centered.filter((x) => Math.abs(x.cErr) >= OFF).length,
    centerErr: q(centered.map((x) => Math.abs(x.cErr))),
    collisions: collide.length,
    onShiftedInstrument: shifted.length,
    shiftedAndCenterOff: shifted.filter((x) => x.cErr !== null && Math.abs(x.cErr) >= OFF).length,
    shiftedAndColliding: shifted.filter((x) => (x.below !== null && x.below < 0) || (x.above !== null && x.above < 0)).length,
    ishValues: [...new Set(shifted.map((x) => x.ish))].sort((a, b) => a - b),
    deviations: devs.length,
  },
  worstCenter: centered.slice().sort((a, b) => Math.abs(b.cErr) - Math.abs(a.cErr)).slice(0, 8),
  rows: WANT_ROWS ? (ONLY_PAGE ? all : devs).slice(FROM, FROM + LIMIT) : [],
  rowsTotal: ONLY_PAGE ? all.length : devs.length,
};
