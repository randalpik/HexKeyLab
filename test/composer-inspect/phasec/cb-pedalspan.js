// Phase 3 precondition 1 (2026-09-03): Composer emits <pedal> as TWO point
// events (dir="down" / dir="up", @tstamp only — no @tstamp2, no @endid, see
// addPedal in pedal.ts), so `spannerExtents` resolves each to a single measure
// and window expansion can never grow to cover the pair. If Verovio draws a
// LINE between them, a window holding only the "up" measure renders it without
// the segment the live page has — the hairpin defect with no MEI range to
// resolve. The sonata has zero pedals, so this is unreachable from a corpus and
// must be probed directly.
//
// Renders a 6-measure document three ways and compares the "up" measure's
// rendered glyph classes: full (down in m2, up in m5), a sub-document that
// starts at m4 (the window that missed the "down"), and full with no pedal at
// all. Run with --no-sonata.
const H = window.__hkl_composer; const r = H.renderer;
const tk = r['spliceTk']; const opts = r['pageSpliceCtx']().windowOptions;
const MEI_NS = 'http://www.music-encoding.org/ns/mei';

const meas = (n, extra) => `<measure n="${n}" xml:id="m${n}">`
  + `<staff n="1"><layer n="1"><note xml:id="a${n}" pname="c" oct="4" dur="1"/></layer></staff>`
  + `<staff n="2"><layer n="1"><note xml:id="b${n}" pname="c" oct="3" dur="1"/></layer></staff>`
  + (extra || '') + `</measure>`;
const PED = (dir, ts) => `<pedal xml:id="ped-${dir}" dir="${dir}" tstamp="${ts}" staff="2"/>`;

const build = (from, to, pedals) => {
  const rows = [];
  for (let n = from; n <= to; n++) {
    let extra = '';
    if (pedals && n === 2) extra += PED('down', '1');
    if (pedals && n === 5) extra += PED('up', '4');
    rows.push(meas(n, extra));
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="${MEI_NS}" meiversion="5.0"><music><body><mdiv><score>
<scoreDef key.sig="0" meter.count="4" meter.unit="4">
<staffGrp symbol="brace"><staffDef n="1" lines="5" clef.shape="G" clef.line="2"/><staffDef n="2" lines="5" clef.shape="F" clef.line="4"/></staffGrp>
</scoreDef>
<section>${rows.join('')}</section>
</score></mdiv></body></music></mei>`;
};

const census = (el) => { const t = {}; for (const g of Array.from(el.querySelectorAll('g'))) { const c = (g.getAttribute('class') || '').split(/\s+/)[0]; if (c) t[c] = (t[c] || 0) + 1; } return t; };
const render = (mei) => {
  tk.setOptions(opts);
  if (!tk.loadData(mei)) return { error: 'loadData failed' };
  const out = { pages: tk.getPageCount(), measures: {}, residue: {} };
  for (let p = 1; p <= out.pages; p++) {
    const doc = new DOMParser().parseFromString(tk.renderToSVG(p, {}), 'image/svg+xml');
    for (const s of Array.from(doc.querySelectorAll('g.system'))) {
      const res = {};
      for (const g of Array.from(s.querySelectorAll('g'))) {
        if (g.closest('g.measure')) continue;
        const c = (g.getAttribute('class') || '').split(/\s+/)[0];
        if (c && c !== 'pb' && c !== 'sb') res[c] = (res[c] || 0) + 1;
      }
      for (const mEl of Array.from(s.querySelectorAll('g.measure'))) out.measures[mEl.id] = census(mEl);
      for (const k in res) out.residue[k] = (out.residue[k] || 0) + res[k];
    }
  }
  return out;
};

const full = render(build(1, 6, true));
const noPed = render(build(1, 6, false));
const windowFrom4 = render(build(4, 6, true));   // the "down" at m2 is absent
const diff = (a, b) => { const o = {}; for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) { const x = (a || {})[k] || 0, y = (b || {})[k] || 0; if (x !== y) o[k] = [x, y]; } return o; };
return {
  pedalDrawnAtAll: diff(noPed.measures.m5, full.measures.m5),
  m5_full_vs_windowFrom4: diff(full.measures.m5, windowFrom4.measures.m5),
  m5_full: full.measures.m5, m5_window: windowFrom4.measures.m5,
  residue_full: full.residue, residue_window: windowFrom4.residue,
};
