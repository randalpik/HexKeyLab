// Phase 3 precondition 1 (2026-09-03): proof that the two coverage gaps found
// by enumerating Composer's emitters are real RENDER defects, not harmless
// omissions from a list.
//
//  A. A gradual <tempo> (accel./rit.) carries @tstamp2 (addTempo, expressions.ts)
//     but `tempo` was absent from the window-expansion vocabulary, so a window
//     could stop before its @tstamp2 measure.
//  B. @tie="m" — the interior note of a 3+-note chain (realizeSlot,
//     model/ties.ts) — set neither tie edge, so a range ending at a medial
//     measure pulled in neither neighbour.
//
// For each, render the full 6-measure document and then the sub-range that a
// too-small window would have rendered, and compare what the shared measures
// DREW (glyph classes). A non-empty diff is the transplanted loss.
// Run with --no-sonata.
const H = window.__hkl_composer; const r = H.renderer;
const tk = r['spliceTk']; const opts = r['pageSpliceCtx']().windowOptions;
const MEI_NS = 'http://www.music-encoding.org/ns/mei';

const noteOf = (n, tie) => `<note xml:id="a${n}" pname="c" oct="4" dur="1"${tie ? ` tie="${tie}"` : ''}/>`;
const build = (from, to, opts2) => {
  const rows = [];
  for (let n = from; n <= to; n++) {
    let extra = '';
    if (opts2.tempoAt === n) extra += `<tempo xml:id="tp1" staff="1" tstamp="1" place="above" data-hkl-gradual="accel" tstamp2="${opts2.tempoSpan}m+1">accel.</tempo>`;
    rows.push(`<measure n="${n}" xml:id="m${n}">`
      + `<staff n="1"><layer n="1">${noteOf(n, (opts2.ties || {})[n])}</layer></staff>`
      + extra + `</measure>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="${MEI_NS}" meiversion="5.0"><music><body><mdiv><score>
<scoreDef key.sig="0" meter.count="4" meter.unit="4">
<staffGrp><staffDef n="1" lines="5" clef.shape="G" clef.line="2"/></staffGrp>
</scoreDef>
<section>${rows.join('')}</section>
</score></mdiv></body></music></mei>`;
};

const render = (mei) => {
  tk.setOptions(opts);
  if (!tk.loadData(mei)) return { error: 'loadData failed' };
  const out = { measures: {}, residue: {} };
  for (let p = 1; p <= tk.getPageCount(); p++) {
    const doc = new DOMParser().parseFromString(tk.renderToSVG(p, {}), 'image/svg+xml');
    for (const s of Array.from(doc.querySelectorAll('g.system'))) {
      for (const mEl of Array.from(s.querySelectorAll('g.measure'))) {
        const t = {};
        for (const g of Array.from(mEl.querySelectorAll('g'))) { const c = (g.getAttribute('class') || '').split(/\s+/)[0]; if (c) t[c] = (t[c] || 0) + 1; }
        out.measures[mEl.id] = t;
      }
      for (const g of Array.from(s.querySelectorAll('g'))) {
        if (g.closest('g.measure')) continue;
        const c = (g.getAttribute('class') || '').split(/\s+/)[0];
        if (c && c !== 'pb' && c !== 'sb') out.residue[c] = (out.residue[c] || 0) + 1;
      }
    }
  }
  return out;
};
const diff = (a, b) => { const o = {}; for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) { const x = (a || {})[k] || 0, y = (b || {})[k] || 0; if (x !== y) o[k] = { full: x, tooSmall: y }; } return o; };

/* A — gradual tempo in m2 spanning to m5. A window covering only m1..m3 stops
   two measures short of the @tstamp2 target. */
const tFull = render(build(1, 6, { tempoAt: 2, tempoSpan: 3 }));
const tSmall = render(build(1, 3, { tempoAt: 2, tempoSpan: 3 }));
/* B — tie chain m2(i) → m3(m) → m4(t). A range seeded at the MEDIAL measure m3
   that pulled in neither neighbour renders m3 alone. */
const TIES = { 2: 'i', 3: 'm', 4: 't' };
const yFull = render(build(1, 6, { ties: TIES }));
const ySmall = render(build(3, 3, { ties: TIES }));

return {
  A_gradualTempo: {
    hostMeasure_m2: diff(tFull.measures.m2, tSmall.measures.m2),
    residue: diff(tFull.residue, tSmall.residue),
    m2_full: tFull.measures.m2, m2_tooSmall: tSmall.measures.m2,
  },
  B_medialTie: {
    medialMeasure_m3: diff(yFull.measures.m3, ySmall.measures.m3),
    residue_full: yFull.residue, residue_tooSmall: ySmall.residue,
    m3_full: yFull.measures.m3, m3_tooSmall: ySmall.measures.m3,
  },
};
