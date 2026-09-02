// Scroll-view signature edits (run with --no-sonata). Builds a 12-measure doc,
// switches to scroll, then applies a mid-piece KEY change and a mid-measure
// CLEF change through the model and reports, after each render: whether the
// persistent SVG root survived (splice) or was replaced (full render), and the
// glyphs actually drawn at the changed measure. This is the probe that showed
// (2026-09-01) a mid-piece key change in scroll view rendering NOTHING — the
// splicer's per-measure diff cannot see a section-level scoreDef, and nothing
// else forced a render — and a clef change full-rendering. Both now splice
// their governed range (render/sigranges.ts).
const H = window.__hkl_composer; const m = H.model, r = H.renderer, reRender = H.reRender;
const score = document.getElementById('score');
const out = {};
m.setCursor(0, 1);
const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
for (let i = 0; i < 48; i++) m.insertChordAtCursor({ notes: [mk('g', 5)], duration: '4', dots: 0 });
const sel = document.getElementById('viewModeSelect'); sel.value = 'scroll'; sel.dispatchEvent(new Event('change', { bubbles: true }));
reRender();
await new Promise((res) => setTimeout(res, 400));
const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
const svg0 = score.querySelector('svg:not(#cursorOverlay)');
const keyGlyphs = (mi) => { const g = document.getElementById(ids[mi]); return g ? g.querySelectorAll('g.keySig use, g.keySig text').length : -1; };
out.before = { keyGlyphsAt6: keyGlyphs(6), keyGlyphsAt0: keyGlyphs(0) };
/* mid-piece key change: 3 sharps from measure 6 */
m.setKeySigAt(6, '3s', 'major');
out.docHasScoreDefBefore6 = !!(m.allMeasures()[6].previousElementSibling && m.allMeasures()[6].previousElementSibling.localName === 'scoreDef');
reRender();
await new Promise((res) => setTimeout(res, 400));
const svg1 = score.querySelector('svg:not(#cursorOverlay)');
out.afterKey = { sameRoot: svg1 === svg0, keyGlyphsAt6: keyGlyphs(6), splicerLast: r['splicer'] && r['splicer'].lastOutcome, dirty: String(m.renderDirtyRange ? JSON.stringify(m.renderDirtyRange()) : 'n/a') };
/* and a clef change mid-piece in scroll view */
const flat = m['flatChildren'](1); const ms = m.allMeasures();
const f = flat.findIndex((e) => (e.localName === 'note' || e.localName === 'chord') && e.closest('measure') === ms[3]);
m.setClefAtCursor(1, f, 'F', '4', null, null);
reRender();
await new Promise((res) => setTimeout(res, 400));
const svg2 = score.querySelector('svg:not(#cursorOverlay)');
const clefGlyphs = (mi) => { const g = document.getElementById(ids[mi]); return g ? Array.from(g.querySelectorAll('g.clef use')).map((u) => (u.getAttribute('xlink:href') || '').replace(/^#/, '').split('-')[0]).join(' ') : 'absent'; };
out.afterClef = { sameRoot: svg2 === svg1, clefAt3: clefGlyphs(3), ledgerLinesAt4: (document.getElementById(ids[4]) || document).querySelectorAll('g.ledgerLines').length, ledgerLinesAt10: (document.getElementById(ids[10]) || document).querySelectorAll('g.ledgerLines').length };
return out;
