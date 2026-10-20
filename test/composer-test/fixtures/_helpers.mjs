// Shared fixture helpers: snippet builders and assertion-expression factories
// used by more than one category module.

export const A_NOTE = `{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }`;

/* Music-text font faces (2026-10-19). Verovio writes the @font-face for SMuFL
 * text (a metronome mark's note glyph) into the SVG of the window that draws
 * it; Composer carries it into <head> as style[data-hkl-font-face]
 * (splice.ts adoptFontFaces). The suite does not reload between fixtures, so a
 * face adopted by an earlier fixture would satisfy a later one — clear them
 * right before the path under test. The check asks the browser itself:
 * document.fonts.load resolves to no faces when nothing declares the family. */
export const CLEAR_ADOPTED_FONT_FACES = `
  for (const st of document.querySelectorAll('style[data-hkl-font-face]')) st.remove();
`;

export const METRONOME_FONT_CHECK = `
  const mmSpans = [...document.querySelectorAll('#score g.tempo tspan[font-family]')];
  if (!mmSpans.length) return { ok: false, detail: 'no SMuFL tspan in any tempo mark' };
  for (const t of mmSpans) {
    const fam = t.getAttribute('font-family');
    const faces = await document.fonts.load('20px "' + fam + '"', t.textContent);
    if (!faces.length) return { ok: false, detail: 'no font face for "' + fam + '" (U+' + t.textContent.codePointAt(0).toString(16).toUpperCase() + ')' };
  }
`;

export const FILL_M1_4Q_V1 = `
  m.setCursor(0, 1);
  for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
`;

export const A4 = `{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }`;

/* ── Layer-cursor assertions (LAYER_CURSOR group) ──────────────────────────────
   Shape-agnostic on purpose (`stops` or the legacy `moments`), so the same
   fixtures ran red against the moment-based cursor before the change. */
export const LC_LIB = `
  const H = window.__hkl_composer, m = H.model;
  const key = async (k, mods) => {
    const o = mods || {};
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: !!o.ctrl, shiftKey: !!o.shift, altKey: !!o.alt, bubbles: true, cancelable: true }));
    await window.__waitForRender();
  };
  const SEL = { expr: 'expr-selected', pedal: 'pedal-selected', tempo: 'tempo-selected' };
  const barEl = (layer) => document.querySelector('#cursorOverlay rect[data-cursor-role="' + layer + '"]');
  const bar = (layer) => { const b = barEl(layer); return b && b.getAttribute('opacity') !== '0' ? b.getBoundingClientRect() : null; };
  const barH = (layer) => { const b = barEl(layer); return b ? parseFloat(b.getAttribute('height')) : NaN; };
  const byId = (id) => document.getElementById(id);
  const rectOf = (el) => (el ? el.getBoundingClientRect() : null);
  const markRect = (id, edge) => {
    if (edge === 'end') {
      const segs = document.querySelectorAll('g.hairpin.id-' + CSS.escape(id));
      if (segs.length) return segs[segs.length - 1].getBoundingClientRect();
    }
    return rectOf(byId(id));
  };
  const idOfSel = (e) => e.id || ([...e.classList].find((c) => c.indexOf('id-') === 0) || 'id-?').slice(3);
  const selected = (layer) => [...new Set([...document.querySelectorAll('.' + SEL[layer])].map(idOfSel))];
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const goto = async (layer, id, exactly) => {
    await key('Home');
    for (let i = 0; i < 40; i++) {
      const s = selected(layer);
      if (exactly ? sameSet(s, [id]) : s.includes(id)) return true;
      await key('ArrowRight');
    }
    return false;
  };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const fmt = (r) => (r ? '[' + [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10).join(',') + ']' : 'null');
  const cy = (r) => r.top + r.height / 2;
  const cx = (r) => r.left + r.width / 2;
  const rightOf = (b, r) => !!(b && r && b.left >= r.right - 0.5 && b.left - r.right <= 3 && near(b.top, r.top, 1) && near(b.height, r.height, 1));
  const leftOf = (b, r) => !!(b && r && b.right <= r.left + 0.5 && r.left - b.right <= 3 && near(b.top, r.top, 1) && near(b.height, r.height, 1));
  const staffG = (mi, n) => {
    const s = m.getDoc().querySelectorAll('measure')[mi]?.querySelector('staff[n="' + n + '"]');
    const id = s && s.getAttribute('xml:id');
    return id ? byId(id) : null;
  };
  const lines = (g) => {
    if (!g) return null;
    let t = Infinity, b = -Infinity;
    for (const p of g.querySelectorAll(':scope > path')) { const r = p.getBoundingClientRect(); t = Math.min(t, r.top); b = Math.max(b, r.bottom); }
    return isFinite(t) ? { top: t, bottom: b } : null;
  };
  const onsets = (mi, staffN) => [...(m.getDoc().querySelectorAll('measure')[mi]?.querySelectorAll('staff[n="' + staffN + '"] note, staff[n="' + staffN + '"] chord') || [])]
    .filter((e) => !(e.localName === 'note' && e.parentElement && e.parentElement.localName === 'chord'))
    .map((e) => e.getAttribute('xml:id'));
  const head = (id) => { const g = byId(id); return rectOf(g ? (g.querySelector('.notehead') || g) : null); };
  const cursorOf = (layer) => H.inputState()[layer + 'Cursor'];
  const stopMoments = (layer) => { const c = cursorOf(layer); return c.stops ? c.stops.map((s) => s.moment) : c.moments; };
  const curMoment = (layer) => stopMoments(layer)[cursorOf(layer).index];
  const markIds = () => [...m.getDoc().querySelectorAll('dynam, dir, hairpin, pedal, tempo')].map((e) => e.getAttribute('xml:id'));
`;

export const lcAssert = (body) => `(async () => {
  ${LC_LIB}
  try {
    ${body}
  } catch (e) {
    return { ok: false, detail: String(e && e.stack || e) };
  }
})()`;
