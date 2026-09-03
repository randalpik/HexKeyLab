// Phase 3 precondition 2 (2026-09-03): does a measure's rendering depend on the
// NEXT measure's @left repeat barline, and does that dependence cross a system
// break? Verovio merges an adjacent rptend/rptstart pair into one barline, so
// within a line an edit to measure i+1's @left redraws measure i's right edge.
// Within a line that is free (measure i is already in the replaced line); the
// question the window rule turns on is the CROSS-LINE case, where measure i+1
// begins a system.
//
// Renders a 4-measure sub-document in four repeat variants x two break shapes
// (no <sb>, <sb> before measure 3) on spliceTk and reports each measure's
// staff-line span plus its barline glyph census. Run with --no-sonata.
const H = window.__hkl_composer; const r = H.renderer;
const tk = r['spliceTk']; const opts = r['pageSpliceCtx']().windowOptions;
const MEI_NS = 'http://www.music-encoding.org/ns/mei';

const meas = (n, attrs) => `<measure n="${n}" xml:id="m${n}"${attrs}>`
  + `<staff n="1"><layer n="1"><note xml:id="n${n}" pname="c" oct="4" dur="1"/></layer></staff>`
  + `</measure>`;

const build = (rpt, sb) => {
  /* rpt: which of m2/m3 carry repeats. sb: insert <sb/> before m3. */
  const a2 = rpt.m2Right ? ' right="rptend"' : '';
  const a3 = rpt.m3Left ? ' left="rptstart"' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="${MEI_NS}" meiversion="5.0"><music><body><mdiv><score>
<scoreDef key.sig="0" meter.count="4" meter.unit="4">
<staffGrp><staffDef n="1" lines="5" clef.shape="G" clef.line="2"/></staffGrp>
</scoreDef>
<section>
${meas(1, '')}
${meas(2, a2)}
${sb ? '<sb/>' : ''}
${meas(3, a3)}
${meas(4, '')}
</section>
</score></mdiv></body></music></mei>`;
};

const parseD = (d) => { const mm = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d || ''); if (!mm) return null; if (Math.abs(+mm[2] - +mm[4]) > 1e-6) return null; return { x1: +mm[1], x2: +mm[3] }; };
const staffSpan = (mEl) => { const st = mEl.querySelector(':scope > g.staff'); if (!st) return null; for (const p of Array.from(st.children)) { if (p.localName !== 'path') { continue; } const d = parseD(p.getAttribute('d')); if (d) return { x1: +d.x1.toFixed(2), w: +(d.x2 - d.x1).toFixed(2) }; } return null; };
/* Barline glyphs: every <use> and stroked <path> inside the measure's barLine
   groups, named by SMuFL codepoint (use) or 'path'. A repeat dot is a use. */
const barGlyphs = (mEl) => Array.from(mEl.querySelectorAll('g.barLine, g.barLineAttr')).map((g) => {
  const cls = (g.getAttribute('class') || '').split(/\s+/)[0];
  const uses = Array.from(g.querySelectorAll('use')).map((u) => (u.getAttribute('xlink:href') || u.getAttribute('href') || '').replace(/^#/, '').split('-')[0]);
  const paths = g.querySelectorAll('path').length;
  return `${cls}[${uses.join('+')}|${paths}p]`;
}).join(' ');

const render = (rpt, sb) => {
  tk.setOptions(opts);
  const mei = build(rpt, sb);
  if (!tk.loadData(mei)) return { error: 'loadData failed' };
  const pages = tk.getPageCount();
  const sys = [];
  for (let p = 1; p <= pages; p++) {
    const doc = new DOMParser().parseFromString(tk.renderToSVG(p, {}), 'image/svg+xml');
    for (const s of Array.from(doc.querySelectorAll('g.system'))) {
      sys.push(Array.from(s.querySelectorAll('g.measure')).map((mEl) => ({
        id: mEl.id, span: staffSpan(mEl), bars: barGlyphs(mEl),
      })));
    }
  }
  return { pages, systems: sys };
};

const VARIANTS = [
  { name: 'none',     rpt: { m2Right: false, m3Left: false } },
  { name: 'm3Left',   rpt: { m2Right: false, m3Left: true  } },
  { name: 'm2Right',  rpt: { m2Right: true,  m3Left: false } },
  { name: 'both',     rpt: { m2Right: true,  m3Left: true  } },
];
const out = { sameLine: {}, brokenLine: {} };
for (const v of VARIANTS) {
  out.sameLine[v.name] = render(v.rpt, false);
  out.brokenLine[v.name] = render(v.rpt, true);
}
/* The question, answered: compare each variant's measure-2 row against 'none'. */
const mOf = (res, id) => { for (const s of res.systems || []) for (const m of s) if (m.id === id) return m; return null; };
const sysOfM = (res, id) => { const ss = res.systems || []; for (let i = 0; i < ss.length; i++) for (const m of ss[i]) if (m.id === id) return i; return -1; };
out.verdict = {};
for (const shape of ['sameLine', 'brokenLine']) {
  out.verdict[shape] = {};
  for (const v of VARIANTS) {
    const row = {};
    for (const id of ['m1', 'm2', 'm3', 'm4']) {
      const base = mOf(out[shape].none, id), m = mOf(out[shape][v.name], id);
      row[id] = base && m
        ? { dW: +(m.span.w - base.span.w).toFixed(2), dX: +(m.span.x1 - base.span.x1).toFixed(2), bars: m.bars, changed: m.bars !== base.bars || Math.abs(m.span.w - base.span.w) > 0.5 }
        : 'unreadable';
    }
    row.sysOfM3 = sysOfM(out[shape][v.name], 'm3');
    out.verdict[shape][v.name] = row;
  }
}
return { verdict: out.verdict };
