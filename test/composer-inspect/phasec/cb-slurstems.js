// Slur stem-direction census (2026-09-05, the mixed-stem slur feature's gate).
// After the sonata loads and every page is mounted: for every slur, the stem
// directions of the notes it covers (read off the rendered stems), whether it
// is a single-voice slur (no other-layer content under it), which side of its
// noteheads each segment lies on, and whether that side carries a beam or a
// tuplet bracket of the covered notes — Max's invariant is "never on the
// bracket side, on the beam side only when nothing else is possible". Reports
// counts plus the list of slurs whose stems still point both ways.
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/cb-slurstems.js
//   --arg "all=1" also lists every slur on a beam or bracket side.
// Rows carry page + movement (measure numbers restart per movement) and
// `throughStem`: slur path samples inside a stem / beam box of its own notes.
const H = window.__hkl_composer; const r = H.renderer; const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 40) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null); await waitFor(badgeHidden);
r.setMountWindowEnabled(false); r.mountAllPages(); await sleep(600);
const listAll = /all=1/.test(String(window.__probeArg || ''));
const mei = r['pageVirt'].mei; const doc = new DOMParser().parseFromString(mei, 'application/xml');
const info = new Map();
for (const e of doc.querySelectorAll('note, chord, rest, space')) { const id = e.getAttribute('xml:id'); if (!id) continue; info.set(id, { el: e, layer: e.closest('layer')?.getAttribute('n'), staff: e.closest('staff')?.getAttribute('n'), measure: e.closest('measure')?.getAttribute('n') }); }
const durTicks = (el) => { const d = el.getAttribute('dur'); if (!d || !/^\d+$/.test(d)) return 0; let t = 64 / parseInt(d, 10); const dots = parseInt(el.getAttribute('dots') || '0', 10); let add = t; for (let i = 0; i < dots; i++) { add /= 2; t += add; } return t; };
const flatten = (container, t, scale, out) => { for (const ch of container.children) { const ln = ch.localName; if (ln === 'beam') { t = flatten(ch, t, scale, out); continue; } if (ln === 'tuplet') { const num = parseInt(ch.getAttribute('num'), 10), nb = parseInt(ch.getAttribute('numbase'), 10); t = flatten(ch, t, scale * nb / num, out); continue; } if (ln === 'mRest' || ln === 'mSpace') { out.push({ el: ch, t0: t, t1: Infinity, ln }); continue; } if (ln === 'fTrem' || ln === 'bTrem') { const inner = [...ch.children].find((c) => c.localName === 'note' || c.localName === 'chord'); const d = inner ? durTicks(inner) * scale : 0; for (const c of ch.children) if (c.localName === 'note' || c.localName === 'chord') out.push({ el: c, t0: t, t1: t + d, ln: c.localName }); t += d; continue; } const d = durTicks(ch) * scale; if (d > 0) { out.push({ el: ch, t0: t, t1: t + d, ln }); t += d; } } return t; };
const measures = [...doc.querySelectorAll('measure')];
/* Movement of a measure: 1 + the section headers (movement starts) before it. */
const mvtOf = new Map(); { let mv = 1; for (const me of measures) { if (me.hasAttribute('data-hkl-section-title') && me !== measures[0]) mv++; mvtOf.set(me, mv); } }
/* The slur's own notes (same staff + layer, start → end, across measures) and
   whether any of them meets non-space content in another layer of the staff. */
const ownNotesOf = (sid, eid) => {
  const a = info.get(sid), b = info.get(eid); if (!a || !b) return null;
  if (a.staff !== b.staff || a.layer !== b.layer) return null;
  const m0 = measures.indexOf(a.el.closest('measure')), m1 = measures.indexOf(b.el.closest('measure')); if (m0 < 0 || m1 < m0) return null;
  const notes = []; let started = false, twoVoice = false, done = false;
  for (let mi = m0; mi <= m1 && !done; mi++) {
    const staff = measures[mi].querySelector('staff[n="' + a.staff + '"]'); if (!staff) continue;
    const ly = staff.querySelector(':scope > layer[n="' + a.layer + '"]'); if (!ly) continue;
    const arr = []; flatten(ly, 0, 1, arr);
    const others = []; for (const l2 of staff.children) if (l2.localName === 'layer' && l2 !== ly) flatten(l2, 0, 1, others);
    for (const x of arr) {
      if (x.el === a.el || x.el.contains(a.el)) started = true;
      if (started && (x.ln === 'note' || x.ln === 'chord')) {
        notes.push(x.el);
        if (others.some((o) => o.ln !== 'space' && o.t0 < x.t1 && o.t1 > x.t0)) twoVoice = true;
      }
      if (x.el === b.el || x.el.contains(b.el)) { done = true; break; }
    }
  }
  return { staff: a.staff, layer: a.layer, measure: a.measure, endMeasure: b.measure, notes, twoVoice, mvt: mvtOf.get(a.el.closest('measure')) };
};
/* A slot's rendered stem direction: an up stem reaches above the slot's
   highest notehead, a down stem below its lowest. (A chord's stem centre
   against ONE of its heads is a coin flip for an octave chord.) */
const stemDir = (slotEl) => { const st = slotEl.querySelector(':scope > g.stem'); const heads = [...slotEl.querySelectorAll('g.notehead')].map((h) => h.getBoundingClientRect()); if (!st || !heads.length) return null; const b = st.getBoundingClientRect(); if (b.height < 2) return null; const top = Math.min(...heads.map((h) => h.top)), bot = Math.max(...heads.map((h) => h.bottom)); return b.top < top - 1 ? 'up' : b.bottom > bot + 1 ? 'down' : null; };
const groups = new Map(); for (const g of document.querySelectorAll('#score .score-page g.slur')) { if (!groups.has(g.id)) groups.set(g.id, []); groups.get(g.id).push(g); }
const meiSlurs = new Map(); for (const s of doc.getElementsByTagName('slur')) meiSlurs.set(s.getAttribute('xml:id'), s);
const rows = [];
for (const [id, segs] of groups) {
  const ms = meiSlurs.get(id); if (!ms) continue;
  const sid = ms.getAttribute('startid')?.slice(1), eid = ms.getAttribute('endid')?.slice(1);
  const own = ownNotesOf(sid, eid); if (!own) continue;
  const els = own.notes.map((n) => document.getElementById(n.getAttribute('xml:id'))).filter(Boolean);
  const dirs = els.map(stemDir).filter(Boolean);
  const up = dirs.filter((d) => d === 'up').length, down = dirs.length - up;
  const row = { id, mvt: own.mvt, m: own.measure, mEnd: own.endMeasure, staff: own.staff, layer: own.layer, twoVoice: own.twoVoice, curvedir: ms.getAttribute('curvedir'), notes: own.notes.length, up, down, stems: up && down ? 'mixed' : up ? 'up' : down ? 'down' : 'none', segs: [] };
  for (const g of segs) {
    const sys = g.closest('g.system'); if (!sys) continue;
    const mine = els.filter((e) => e.closest('g.system') === sys);
    const heads = mine.flatMap((e) => [...e.querySelectorAll('g.notehead')]).map((h) => h.getBoundingClientRect());
    if (!heads.length) continue;
    const headsMid = heads.reduce((a, h) => a + (h.top + h.bottom) / 2, 0) / heads.length;
    const sb = g.getBoundingClientRect(); const side = (sb.top + sb.bottom) / 2 < headsMid ? 'above' : 'below';
    const sideOf = (b) => ((b.top + b.bottom) / 2 < headsMid ? 'above' : 'below');
    let beamSide = false, bracketSide = false;
    for (const e of mine) {
      const beam = e.closest('g.beam'); const poly = beam && beam.querySelector(':scope > polygon'); if (poly && sideOf(poly.getBoundingClientRect()) === side) beamSide = true;
      const tup = e.closest('g.tuplet'); const br = tup && tup.querySelector('g.tupletBracket'); if (br && sideOf(br.getBoundingClientRect()) === side) bracketSide = true;
    }
    /* Max's invariant, measured: samples of the slur path inside a stem or
       beam box of the slur's OWN notes in this system. */
    const path = g.querySelector('path'); let throughStem = 0;
    if (path) { const L = path.getTotalLength(), ctm = path.getScreenCTM(); const pts = []; for (let i = 0; i <= 64; i++) { const p = path.getPointAtLength(L * i / 64); pts.push(new DOMPoint(p.x, p.y).matrixTransform(ctm)); }
      const boxes = mine.flatMap((e) => { const own = [...e.querySelectorAll('g.stem')]; if (e.closest('g.chord')) own.push(...e.closest('g.chord').querySelectorAll(':scope > g.stem')); const beam = e.closest('g.beam'); const poly = beam && beam.querySelector(':scope > polygon'); if (poly) own.push(poly); return own; }).map((b) => b.getBoundingClientRect());
      for (const b of boxes) if (pts.some((p) => p.x >= b.left - 0.5 && p.x <= b.right + 0.5 && p.y >= b.top - 0.5 && p.y <= b.bottom + 0.5)) throughStem++; }
    row.segs.push({ side, beamSide, bracketSide, throughStem, page: g.closest('.score-page')?.dataset.page, redrawn: g.getAttribute('data-hkl-slur') || '-' });
  }
  row.onBeamSide = row.segs.some((s) => s.beamSide); row.onBracketSide = row.segs.some((s) => s.bracketSide);
  row.tag = segs.map((g) => g.getAttribute('data-hkl-stems')).find(Boolean) || '-';
  row.page = row.segs.map((s) => s.page).filter(Boolean).join('/'); row.throughStem = row.segs.reduce((a, s) => a + s.throughStem, 0);
  rows.push(row);
}
const count = (f) => rows.filter(f).length;
const mixed = rows.filter((w) => w.stems === 'mixed');
const brief = (w) => ({ page: w.page, mvt: w.mvt, m: w.m + (w.mEnd !== w.m ? '→' + w.mEnd : ''), staff: w.staff, layer: w.layer, throughStem: w.throughStem, up: w.up, down: w.down, twoVoice: w.twoVoice, tag: w.tag, sides: w.segs.map((s) => s.side).join('/'), beamSide: w.onBeamSide, bracketSide: w.onBracketSide });
return {
  totalSlurs: rows.length,
  byStems: { up: count((w) => w.stems === 'up'), down: count((w) => w.stems === 'down'), mixed: mixed.length, none: count((w) => w.stems === 'none') },
  mixed: { all: mixed.length, singleVoice: mixed.filter((w) => !w.twoVoice).length, twoVoice: mixed.filter((w) => w.twoVoice).length, onBeamSide: mixed.filter((w) => w.onBeamSide).length, onBracketSide: mixed.filter((w) => w.onBracketSide).length },
  onBeamSide: count((w) => w.onBeamSide), onBracketSide: count((w) => w.onBracketSide),
  tags: rows.reduce((acc, w) => { acc[w.tag] = (acc[w.tag] || 0) + 1; return acc; }, {}),
  throughStem: count((w) => w.throughStem > 0), throughStemList: rows.filter((w) => w.throughStem > 0).map(brief),
  mixedList: mixed.map(brief),
  ...(listAll ? { beamOrBracketSide: rows.filter((w) => w.onBeamSide || w.onBracketSide).map(brief) } : {}),
};
