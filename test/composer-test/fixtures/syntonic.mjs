// Composer test fixtures — Syntonic / Polysyntonic anchor + pitch-derived colour.
// docs/architecture/composer.md (Syntonic / Polysyntonic anchor). Fixture spec: { setup?: string, setupKeys?: string[], ...flags };
// ASSERTIONS maps fixture name → [{ name, expr }]. See ../README.md.
//
// A note's anchor (home band) is derived from the key signature at its measure:
// model.anchorAt = the band of the key-tonic cell set-score-ref carries. Under
// Wicki-Hayden the C tonic (C4, (12,−3)) sits in band 2 and the G tonic (G3,
// (6,−2)) in band 1, so in Syntonic the C4 cell is home in C and one comma up in
// G. Colour is one function of the pitch (@hkl/shared/keycolor.js): the C4 ink is
// blue in C and pink (+2 hue steps) in G. Expected hexes were computed from the
// shared functions.

const C4_HOME = { ink: '#055ad1', light: '#4C96FF' };   /* Syntonic, anchor 2: Pythagorean C */
const C4_UP1 = { ink: '#f90673', light: '#FF4C79' };    /* Syntonic, anchor 1: C·81/80 */
const C4 = (col) => `{ q: 12, r: -3, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '${col.ink}', lightColorHex: '${col.light}', velocity: 80 }`;

const HELPERS = `
  window.__synCol = () => { const n = m.getDoc().querySelector('note'); return n ? [n.getAttribute('color'), n.getAttribute('data-light-color')] : null; };
  window.__synAsked = [];
`;

export const FIXTURES = {
  /* A key-signature edit re-anchors the measures it governs: the C4 note keeps
     its cell and spelling but re-pitches, so its baked colours follow (C → G →
     C: home → one comma up → home). */
  syn_keysig_reanchors: {
    setup: `
      ${HELPERS}
      m.setLayoutReq({ tuningMode: 'S', mapping: 'wickiHayden' });
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [${C4(C4_HOME)}], duration: '4', dots: 0 });
      window.__synC = [m.anchorAt(0), ...window.__synCol()];
      m.setKeySigAt(0, '1s', 'major');
      window.__synG = [m.anchorAt(0), ...window.__synCol()];
      m.setKeySigAt(0, '0', 'major');
      window.__synBack = [m.anchorAt(0), ...window.__synCol()];
      r();
    `,
  },
  /* The render clone stamps each note with its measure's anchor, so the HEJI
     pass sees the comma: C4 in G (one comma up) is a diatonic natural that must
     still show — as the natural-with-one-up-arrow glyph U+E2C7. */
  syn_heji_arrow_render: {
    setup: `
      m.setLayoutReq({ tuningMode: 'S', mapping: 'wickiHayden' });
      m.setHejiEnabled(true);
      m.setKeySigAt(0, '1s', 'major');
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [${C4(C4_UP1)}], duration: '4', dots: 0 });
    `,
  },
  /* The same note in C is home: no comma, no accidental drawn. */
  syn_heji_home_plain: {
    setup: `
      m.setLayoutReq({ tuningMode: 'S', mapping: 'wickiHayden' });
      m.setHejiEnabled(true);
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [${C4(C4_HOME)}], duration: '4', dots: 0 });
    `,
  },
  /* Entry gate: HKL is Syntonic · Wicki-Hayden like the score, but its anchor
     (home band 1 — e.g. a Ctrl+click) differs from the score's at the cursor
     (key C → band 2) → committing held keys asks first, naming both home bands;
     declining inserts nothing. */
  syn_entry_gate_anchor: {
    setup: `
      ${HELPERS}
      m.setLayoutReq({ tuningMode: 'S', mapping: 'wickiHayden' });
      window.__bridgeMock.sendTuningChanged('S', 'wickiHayden');
      window.__bridgeMock.sendLayoutState('S', 'wickiHayden', 6, -2, 1);
      window.__bridgeMock.sendHeldKeys([${C4(C4_UP1)}], 'wickiHayden');
      window.__synOrigConfirm = window.confirm;
      /* self-restoring: declines once, then puts the real confirm back */
      window.confirm = (msg) => { window.__synAsked.push(msg); window.confirm = window.__synOrigConfirm; return false; };
      m.setCursor(0, 1);
    `,
    setupKeys: ['5'],
  },
  /* Matching anchors: entry goes straight through. */
  syn_entry_anchor_match: {
    setup: `
      ${HELPERS}
      m.setLayoutReq({ tuningMode: 'S', mapping: 'wickiHayden' });
      window.__bridgeMock.sendTuningChanged('S', 'wickiHayden');
      window.__bridgeMock.sendLayoutState('S', 'wickiHayden', 12, -3, 2);
      window.__bridgeMock.sendHeldKeys([${C4(C4_HOME)}], 'wickiHayden');
      window.__synOrigConfirm = window.confirm;
      window.confirm = (msg) => { window.__synAsked.push(msg); window.confirm = window.__synOrigConfirm; return false; };
      m.setCursor(0, 1);
    `,
    setupKeys: ['5'],
  },
  /* Retune recolours (every mode, not only S/Y): Ptolemaic → Equal keeps A4 at
     (3,0) exactly, but Equal colours by sounding octave, so the baked colour
     must change (purple → pink). Before colour moved to a shared pitch function
     the old colour stayed: no recolour pass existed. */
  syn_retune_recolors: {
    setup: `
      ${HELPERS}
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 3, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#9405d1', lightColorHex: '#C94CFF', velocity: 80 }], duration: '4', dots: 0 });
      window.__synBefore = window.__synCol();
      const orig = window.confirm;
      window.confirm = (msg) => { window.__synAsked.push(msg); return true; };
      document.getElementById('btnSetup').click();
      document.getElementById('setupTuningMode').value = 'E';
      document.getElementById('setupForm').requestSubmit(document.getElementById('setupOk'));
      window.confirm = orig;
      window.__synAfter = window.__synCol();
      r();
    `,
  },
};

const expect = (got, want) => (JSON.stringify(got) === JSON.stringify(want)
  ? { ok: true } : { ok: false, detail: 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want) });

const accidGlyphs = `[...document.querySelectorAll('g.note g.accid text')].map((t) => t.textContent.codePointAt(0).toString(16))`;

export const ASSERTIONS = {
  syn_keysig_reanchors: [
    { name: 'key C: anchor 2, C4 home colours',
      expr: `(${expect.toString()})(window.__synC, [2, '${C4_HOME.ink}', '${C4_HOME.light}'])` },
    { name: 'key G: anchor 1, C4 recoloured one comma up',
      expr: `(${expect.toString()})(window.__synG, [1, '${C4_UP1.ink}', '${C4_UP1.light}'])` },
    { name: 'back to C: home colours restored',
      expr: `(${expect.toString()})(window.__synBack, [2, '${C4_HOME.ink}', '${C4_HOME.light}'])` },
    { name: 'the cell and spelling never moved',
      expr: `(() => { const n = window.__hkl_composer.model.getDoc().querySelector('note');
        return (${expect.toString()})([n.getAttribute('data-q'), n.getAttribute('data-r'), n.getAttribute('pname'), n.getAttribute('oct')], ['12', '-3', 'c', '4']); })()` },
    { name: 'data-anchor never reaches the stored document',
      expr: `(${expect.toString()})(window.__hkl_composer.model.getDoc().querySelectorAll('[data-anchor]').length, 0)` },
  ],
  syn_heji_arrow_render: [
    { name: 'C4 one comma up in G → natural + one up-arrow U+E2C7',
      expr: `(${expect.toString()})(${accidGlyphs}, ['e2c7'])` },
  ],
  syn_heji_home_plain: [
    { name: 'C4 home in C → no accidental drawn',
      expr: `(${expect.toString()})(${accidGlyphs}, [])` },
  ],
  syn_entry_gate_anchor: [
    { name: 'prompt names both home bands',
      expr: `(() => {
        const a = window.__synAsked ?? [];
        window.confirm = window.__synOrigConfirm ?? window.confirm;
        const ok = a.length === 1 && a[0].includes('Syntonic · Wicki-Hayden · home band 1') && a[0].includes('Syntonic · Wicki-Hayden · home band 2');
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(a) };
      })()` },
    { name: 'declined → nothing inserted',
      expr: `(${expect.toString()})(window.__hkl_composer.model.getDoc().querySelectorAll('note').length, 0)` },
  ],
  syn_entry_anchor_match: [
    { name: 'no prompt',
      expr: `(() => { const a = window.__synAsked ?? []; window.confirm = window.__synOrigConfirm ?? window.confirm;
        return (${expect.toString()})(a.length, 0); })()` },
    { name: 'the held C4 inserted at its cell',
      expr: `(() => { const ns = [...window.__hkl_composer.model.getDoc().querySelectorAll('note')];
        return (${expect.toString()})(ns.map((n) => n.getAttribute('data-q') + ',' + n.getAttribute('data-r')), ['12,-3']); })()` },
  ],
  syn_retune_recolors: [
    { name: 'retune confirmed: one exact match',
      expr: `(() => { const a = window.__synAsked ?? [];
        return a.length === 1 && a[0].includes('1 exact match') ? { ok: true } : { ok: false, detail: JSON.stringify(a) }; })()` },
    { name: 'A4 recoloured from Ptolemaic purple to Equal pink',
      expr: `(${expect.toString()})([window.__synBefore, window.__synAfter], [['#9405d1', '#C94CFF'], ['#f90673', '#FF4C79']])` },
  ],
};
