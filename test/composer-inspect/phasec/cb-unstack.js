// Same-moment un-stack: horizontal separation + the vertical space the stack
// reserved (2026-09-09). Max, on the sonata's p. 21 second system (mm. 94-99):
// the `p` and `dim.` sharing m. 99's anchor are laid out side by side with too
// little space between them, and the system's grand-staff gap is still sized
// for the VERTICAL stack Verovio engraved — nothing shrinks it once the marks
// are separated.
//
// For every system holding an un-stacked group (data-hkl-hshift) — and for any
// system named by --arg page=/sys= — reports:
//   • gaps      — each adjacent staff pair's line-band gap, and the tallest
//                 thing actually occupying it (marks + ink), so the SLACK is
//                 visible: gap minus what the gap has to hold.
//   • groups    — each same-tstamp cluster: its members' boxes, the horizontal
//                 clearance between consecutive members, and their shifts.
//
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/cb-unstack.js
//   --arg "page=21"   also report every system on that page, un-stacked or not
const H = window.__hkl_composer; const r = H.renderer; const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 40) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const arg = String(window.__probeArg || '');
const numArg = (k, d) => { const m = arg.match(new RegExp(k + '=(-?\\d+)')); return m ? parseInt(m[1], 10) : d; };
const WANT_PAGE = numArg('page', 0);

const partitionSig = () => (pb['pageStartIds'] || []).join(',') + '|' + pb.lineStarts().length;
const idle = () => { const b = document.getElementById('renderBusy'); return (!b || b.hidden) && !pb.balanceJobActive() && r.extentsJobState() === null; };
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
const R = (n) => Math.round(n);

const out = [];
const pages = [...document.querySelectorAll('#score .score-page')];
let sysNo = 0;
for (let pi = 0; pi < pages.length; pi++) {
  for (const sys of pages[pi].querySelectorAll('g.system')) {
    sysNo++;
    const frame = sys.parentElement;
    const fctm = frame && frame.getCTM && frame.getCTM(); if (!fctm) continue;
    const inv = fctm.inverse();
    const unstacked = [...sys.querySelectorAll('[data-hkl-hshift]')];
    if (!unstacked.length && pi + 1 !== WANT_PAGE) continue;

    /* staff line bands, in vertical order. NOTE: `g.measure:first-of-type`
       does NOT work — g.measure is one `g` among other `g` siblings, so
       :first-of-type matches whatever `g` comes first (label / grpSym) and the
       band list comes back empty. Take the first g.measure explicitly. */
    const firstMeasure = sys.querySelector('g.measure');
    if (!firstMeasure) continue;
    const bands = [];
    for (const st of Array.from(firstMeasure.children)) {
      if (!st.classList || !st.classList.contains('staff')) continue;
      const n = parseInt(st.getAttribute('data-n') || '', 10);
      let top = Infinity, bottom = -Infinity;
      for (const p of Array.from(st.children)) {
        if (p.tagName !== 'path') continue;
        const b = boxIn(p, inv); if (!b || b.bottom - b.top > PAD) continue;
        top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom);
      }
      if (Number.isFinite(top)) bands.push({ n, top, bottom });
    }
    bands.sort((a, b) => a.top - b.top);

    /* Everything that could occupy a gap. For a MARK, also report where
       VEROVIO put it — box minus our own shifts — because Verovio sized the
       gap against ITS placement, not against where our passes moved it. */
    const occupants = [];
    for (const st of sys.querySelectorAll('g.staff')) {
      const n = parseInt(st.getAttribute('data-n') || '', 10);
      for (const o of st.querySelectorAll(OBSTACLE_SEL)) {
        const b = boxIn(o, inv);
        if (isInk(b)) occupants.push({ ...b, what: [...o.classList][0] + '@' + n, vTop: b.top, vBottom: b.bottom, mark: false });
      }
    }
    for (const mk of sys.querySelectorAll(MARK_SEL)) {
      const b = boxIn(mk, inv); if (!isInk(b)) continue;
      const own = (parseFloat(mk.getAttribute('data-hkl-vshift') || '0') || 0);
      const ish = (parseFloat(mk.getAttribute('data-hkl-ishift') || '0') || 0);
      occupants.push({
        ...b, mark: true,
        what: 'mark:' + [...mk.classList][0] + '@' + (mk.getAttribute('data-staff') || '?') + ':' + (mk.getAttribute('data-place') || '?')
          + ((mk.textContent || '').trim() ? '(' + (mk.textContent || '').trim().slice(0, 8) + ')' : ''),
        vTop: b.top - own, vBottom: b.bottom - own,      // undo OUR vertical move; ish is Verovio-invisible too but shared with the staff
        vsh: own, ish,
      });
    }

    const gaps = [];
    for (let k = 0; k + 1 < bands.length; k++) {
      const a = bands[k], b = bands[k + 1];
      const span = b.top - a.bottom;
      /* Occupants intersecting the open gap, at OUR position and at VEROVIO's. */
      const inside = occupants.filter((o) => o.bottom > a.bottom + 1 && o.top < b.top - 1);
      const vInside = occupants.filter((o) => o.vBottom > a.bottom + 1 && o.vTop < b.top - 1);
      /* The stack Verovio had to fit: greatest number of mutually
         x-overlapping marks in the gap at Verovio's own placement, and the
         total height they occupy. */
      const vMarks = vInside.filter((o) => o.mark).sort((x, y) => x.vTop - y.vTop);
      let stackMax = 0, stackSpanMax = 0, stackAt = '';
      for (const m of vMarks) {
        const col = vMarks.filter((o) => !(o.right < m.left - PAD || o.left > m.right + PAD));
        if (col.length > stackMax || (col.length === stackMax && col.length)) {
          const top = Math.min(...col.map((o) => o.vTop)), bot = Math.max(...col.map((o) => o.vBottom));
          if (col.length > stackMax || bot - top > stackSpanMax) {
            stackMax = col.length; stackSpanMax = bot - top; stackAt = col.map((o) => o.what).join(' + ');
          }
        }
      }
      let need = 0, needWhat = '';
      for (const o of inside) { const h = Math.min(o.bottom, b.top) - Math.max(o.top, a.bottom); if (h > need) { need = h; needWhat = o.what; } }
      gaps.push({
        pair: a.n + '/' + b.n, gap: R(span), spaces: +((span / SPACE).toFixed(2)),
        occupants: inside.length, tallestInGap: R(need), tallestWhat: needWhat, slack: R(span - need),
        verovioStack: stackMax, verovioStackSpan: R(stackSpanMax), verovioStackOf: stackAt,
        contents: inside.sort((x, y) => x.top - y.top).map((o) => o.what + ' y[' + R(o.top) + '..' + R(o.bottom) + ']'
          + (o.mark ? ' vero[' + R(o.vTop) + '..' + R(o.vBottom) + '] vsh=' + R(o.vsh) : '')),
      });
    }

    /* same-tstamp groups among the marks */
    const byStamp = new Map();
    for (const mk of sys.querySelectorAll('g.dynam, g.dir')) {
      const t = mk.getAttribute('data-tstamp');
      const measure = mk.closest('g.measure');
      if (t === null || !measure) continue;
      const key = (measure.id || '') + '@' + t;
      (byStamp.get(key) || byStamp.set(key, []).get(key)).push(mk);
    }
    const groups = [];
    for (const [key, mks] of byStamp) {
      if (mks.length < 2) continue;
      const rows = mks.map((mk) => {
        const b = boxIn(mk, inv);
        return {
          cls: [...mk.classList][0], text: (mk.textContent || '').trim().slice(0, 10),
          staff: mk.getAttribute('data-staff'), place: mk.getAttribute('data-place'),
          left: R(b.left), right: R(b.right), top: R(b.top), bottom: R(b.bottom),
          hsh: R(parseFloat(mk.getAttribute('data-hkl-hshift') || '0') || 0),
          vsh: R(parseFloat(mk.getAttribute('data-hkl-vshift') || '0') || 0),
          ish: R(parseFloat(mk.getAttribute('data-hkl-ishift') || '0') || 0),
        };
      }).sort((a, b) => a.left - b.left);
      const clearances = [];
      for (let i = 1; i < rows.length; i++) clearances.push(R(rows[i].left - rows[i - 1].right));
      groups.push({ key: key.slice(-14), tstamp: key.split('@').pop(), members: rows, clearances, spaces: clearances.map((c) => +(c / SPACE).toFixed(2)) });
    }

    /* Pairs separated PRE-ENGRAVE by notation/unstack.ts: the mover names its
       anchor, since the nudge means they no longer share a tstamp. */
    const pairs = [];
    for (const mv of sys.querySelectorAll('[data-hkl-unstack]')) {
      const anchor = sys.querySelector('[id="' + mv.getAttribute('data-hkl-unstack') + '"]');
      const mb = boxIn(mv, inv), ab = anchor ? boxIn(anchor, inv) : null;
      if (!mb) continue;
      pairs.push({
        mover: (mv.textContent || '').trim().slice(0, 10), moverTstamp: mv.getAttribute('data-tstamp'),
        anchorFound: !!anchor, anchorTstamp: anchor ? anchor.getAttribute('data-tstamp') : null,
        clearance: ab ? R(mb.left - ab.right) : null,
        spaces: ab ? +((mb.left - ab.right) / SPACE).toFixed(2) : null,
        anchorY: ab ? R((ab.top + ab.bottom) / 2) : null, moverY: R((mb.top + mb.bottom) / 2),
        dyCentres: ab ? R((mb.top + mb.bottom) / 2 - (ab.top + ab.bottom) / 2) : null,
        hsh: R(parseFloat(mv.getAttribute('data-hkl-hshift') || '0') || 0),
      });
    }

    const sb = boxIn(sys, inv);
    out.push({
      unstackPairs: pairs,
      page: pi + 1, sys: sysNo,
      measures: [...sys.querySelectorAll('g.measure')].map((mm) => (mm.querySelector('g.mNum')?.textContent || '').trim()).filter(Boolean),
      nMeasures: sys.querySelectorAll('g.measure').length,
      systemHeight: sb ? R(sb.bottom - sb.top) : null,
      gaps, groups, unstackedMarks: unstacked.length,
    });
  }
}
return { PAD, SPACE, note: 'user units; 1 staff space = 160', systems: out };
