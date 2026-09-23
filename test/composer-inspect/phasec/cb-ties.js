// Tie clearance census (2026-09-22, render/tielayout.ts's gate).
// After the sonata loads and every page is mounted: every rendered tie with its
// tielayout outcome (untouched / redrawn / kept) and whether its DRAWN outline
// (sampled off the DOM path, not the pass's own bezier) still passes through a
// glyph of its system that is not one of its two notes, outside the pass's
// endpoint zones. Glyph boxes are INK boxes from the pass's own `inkBox` (a
// `<text>`'s cell box over-reports — every accidental is BravuraText text), so
// "untouched but hit" means a real disagreement about the curve, not the box.
// Kept ties are listed with page + measure (no clear arch within the width);
// redrawn ones with their height / width. Also reports the pass's own time.
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/cb-ties.js
const H = window.__hkl_composer; const r = H.renderer; const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 40) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null); await waitFor(badgeHidden);
r.setMountWindowEnabled(false); r.mountAllPages(); await sleep(600);
const { inkBox } = await import('/composer/src/render/tielayout.ts');
const post = r.lastPostStats ? { ties: Math.round(r.lastPostStats.ties), total: Math.round(r.lastPostStats.total), targets: r.lastPostStats.targets } : null;
const SEL = 'g.notehead, g.stem, g.flag, g.accid, g.dots, g.beam > polygon, g.tupletNum, g.tupletBracket, g.artic, g.rest, g.slur > path, g.tie > path, g.dynam, g.dir, g.tempo, g.fermata';
const HIDDEN = 'g.rest[data-visible="false"], g.rest[data-data-tuplet-placeholder="true"]';
const rootOf = (el) => el.closest('g.chord') ?? el.closest('g.note') ?? el;
const pageOf = (el) => { const pg = el.closest('.score-page'); return pg ? Number(pg.getAttribute('data-page')) : null; };
const apply = (m, p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
const sample = (path, fInv, n) => { const m = fInv.multiply(path.getCTM()); const L = path.getTotalLength(); const o = []; for (let i = 0; i <= n; i++) o.push(apply(m, path.getPointAtLength(L * i / n))); return o; };
const segD = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0; return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y); };
const out = { post, hitBy: {}, ties: 0, untouched: 0, redrawn: 0, kept: 0, stillHit: { untouched: 0, redrawn: 0 }, keptList: [], redrawnList: [], hitList: [] };
const sysCache = new Map();
for (const g of document.querySelectorAll('#score g.tie')) {
  const path = g.querySelector(':scope > path'); if (!path) continue;
  out.ties++;
  const mark = g.getAttribute('data-hkl-tie') || 'untouched';
  out[mark]++;
  const sys = g.closest('g.system');
  let S = sysCache.get(sys);
  if (!S) {
    const fInv = sys.getCTM().inverse();
    /* Verovio unit: half the staff-line spacing, in the system frame. */
    const ly = [...sys.querySelector('g.staff').children].filter((c) => c.localName === 'path').map((p) => inkBox(p, fInv).top).sort((a, b) => a - b);
    const unit = ly.length > 1 ? (ly[1] - ly[0]) / 2 : 80;
    const obs = [...sys.querySelectorAll(SEL)].filter((el) => !el.matches(HIDDEN)).map((el) => ({ el, b: inkBox(el, fInv), poly: el.localName === 'path' ? sample(el, fInv, 200) : null })).filter((o) => o.b && o.b.right > o.b.left);
    S = { fInv, unit, obs };
    sysCache.set(sys, S);
  }
  const { fInv, unit, obs } = S;
  const pts = sample(path, fInv, 240);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const zone = Math.min(1.5 * unit, 0.2 * (x1 - x0));   // tielayout's END_ZONE / END_ZONE_FRAC
  const sid = (g.getAttribute('data-startid') || '').replace(/^#/, '');
  const sEl = sid ? sys.querySelector('#' + CSS.escape(sid)) : null;
  const sRoot = sEl ? rootOf(sEl) : null;
  const end = pts[120];
  let eRoot = null, best = Infinity;
  for (const h of sys.querySelectorAll('g.note > g.notehead')) { const b = inkBox(h, fInv); if (!b) continue; const d = Math.hypot((b.left + b.right) / 2 - end.x, (b.top + b.bottom) / 2 - end.y); if (d < best) { best = d; eRoot = rootOf(h); } }
  const touches = (p, o) => o.poly ? o.poly.some((a, i) => i > 0 && segD(p, o.poly[i - 1], a) <= 0.2 * unit) : (p.x >= o.b.left && p.x <= o.b.right && p.y >= o.b.top && p.y <= o.b.bottom);
  const hits = obs.filter((o) => o.el !== path && !(sRoot && sRoot.contains(o.el)) && !(eRoot && eRoot.contains(o.el)) && o.b.right > x0 && o.b.left < x1
    && pts.some((p) => p.x - x0 >= zone && x1 - p.x >= zone && touches(p, o)));
  for (const o of hits) { const k = mark + ':' + (o.el.localName === 'path' ? o.el.parentElement.classList[0] + '>path' : (o.el.classList[0] || o.el.localName)); out.hitBy[k] = (out.hitBy[k] || 0) + 1; }
  const m = sEl?.closest('g.measure')?.id ?? g.closest('g.measure')?.id ?? null;
  const row = { page: pageOf(g), measure: m, wUnits: Math.round((x1 - x0) / unit * 10) / 10, hUnits: Math.round((Math.max(...ys) - Math.min(...ys)) / unit * 10) / 10 };
  if (mark === 'redrawn') out.redrawnList.push({ ...row, ratio: Math.round(row.hUnits / row.wUnits * 100) / 100, passHit: g.getAttribute('data-hkl-tie-hit') });
  if (mark === 'kept') out.keptList.push({ ...row, passHit: g.getAttribute('data-hkl-tie-hit') });
  if (hits.length && mark !== 'kept') {
    out.stillHit[mark]++;
    out.hitList.push({ mark, ...row, by: hits.map((o) => { const n = o.el.closest('g.note'); return { cls: o.el.localName === 'path' ? o.el.parentElement.classList[0] + '>path' : o.el.classList[0], note: n?.id ?? null, layer: n?.closest('g.layer')?.getAttribute('data-n') ?? null, fromStartUnits: Math.round((o.b.left - x0) / unit * 10) / 10 }; }) });
  }
}
return out;
