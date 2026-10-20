// Composer test fixtures — structure.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

export const FIXTURES = {
  /* ── Repeats + endings ────────────────────────────────────── */

  /* `}` sets @right="rptend" (backward repeat) on the current measure. */
  repeat_end_toggle: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);
      m.appendMeasure();
    `,
    setupKeys: [{ key: '}' }],
    visualBaseline: 'repeat_end',
  },
  /* `{` sets @left="rptstart" (forward repeat) on the current measure. */
  repeat_start_toggle: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);
      m.appendMeasure();
    `,
    setupKeys: [{ key: '{' }],
    visualBaseline: 'repeat_start',
  },
  /* A 2-measure span wrapped in rptstart…rptend replays once: every note
     sounds twice, the repeat pass offset by one full cycle (2 bars). */
  repeat_replays_span: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertMeasureAt(1);
      const c2 = m.getMeasureStartCursor(1, 1);
      m.setCursor(c2, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.toggleRepeatStartAt(0);
      m.toggleRepeatEndAt(1);
    `,
    visualBaseline: 'repeat_span',
  },
  /* 1st/2nd endings: m1 rptstart, m2 is the 1st ending carrying the backward
     repeat, m3 is the 2nd ending. Play order = m1, m2, m1, m3. */
  volta_1st_2nd: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertMeasureAt(1);
      let cc = m.getMeasureStartCursor(1, 1); m.setCursor(cc, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertMeasureAt(2);
      cc = m.getMeasureStartCursor(1, 2); m.setCursor(cc, 1);
      m.insertChordAtCursor({ notes: [{ q: 1, r: 0, pname: 'c', accid: 's', oct: 5, midi: 73, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.toggleRepeatStartAt(0);
      m.toggleRepeatEndAt(1);
      m.toggleEndingAt(1);  /* m2 → 1st ending (it carries rptend) */
      m.toggleEndingAt(2);  /* m3 → 2nd ending (after the rptend measure) */
    `,
    visualBaseline: 'volta',
  },
  /* Ctrl+E on a measure that carries a backward repeat creates a 1st ending. */
  ending_first_via_ctrlE: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.appendMeasure();
      m.toggleRepeatEndAt(0);
      m.setCursor(0, 1);
    `,
    setupKeys: [{ key: 'e', ctrl: true }],
  },
  /* ── 8va ──────────────────────────────────────────────────── */

  /* Beat-select two notes, Ctrl+8 → an <octave dis=8 place=above> anchored to
     them; playback shifts both notes up an octave (q + 3). */
  ottava_shifts_pitch: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: '8', ctrl: true },
    ],
    visualBaseline: 'ottava',
  },
  /* ── Section headers ──────────────────────────────────────── */

  /* Ctrl+Shift+H on m2 → centered movement title that starts a new system
     (forced <sb>), final barline on m1, measure-number reset. Modal flow is
     driven inline so it's closed before invariants run. */
  section_header: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.appendMeasure();
      const cc = m.getMeasureStartCursor(1, 1); m.setCursor(cc, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="title"]').value = 'II. Andante';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
    visualBaseline: 'section_header',
  },
  /* ── Page break ──────────────────────────────────────────── */

  /* Ctrl+B before m2 inserts a <pb>; page view splits onto a second page. */
  pagebreak: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.appendMeasure();
      const cc = m.getMeasureStartCursor(1, 1); m.setCursor(cc, 1);
    `,
    setupKeys: [{ key: 'b', ctrl: true }],
  },
  /* The cursor overlay must span EVERY page, not just the first — else a
     cursor on page 2 (after a page break) draws outside the overlay and
     vanishes. Assert the overlay extends past page 1's bottom. */
  cursor_across_pagebreak: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.appendMeasure();
      const cc = m.getMeasureStartCursor(1, 1); m.setCursor(cc, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
    `,
    setupKeys: [{ key: 'b', ctrl: true }],
  },
  /* A section header forces a new system AND the section must still auto-wrap
     across many measures (not cram onto one line). 16 measures after the
     header → several systems. */
  section_overflow_wraps: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      for (let i = 0; i < 16; i++) m.appendMeasure();
      for (let mi = 1; mi <= 16; mi++) { const cc = m.getMeasureStartCursor(1, mi); m.setCursor(cc, 1); for (let k = 0; k < 4; k++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 }); }
      m.setSectionHeaderAt(1, 'II');
    `,
  },
  /* Same overflow guarantee for page breaks: the second page must wrap its
     measures into multiple systems, not one. */
  pagebreak_overflow_wraps: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      for (let i = 0; i < 16; i++) m.appendMeasure();
      for (let mi = 1; mi <= 16; mi++) { const cc = m.getMeasureStartCursor(1, mi); m.setCursor(cc, 1); for (let k = 0; k < 4; k++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 }); }
      m.togglePageBreakAt(1);
    `,
  },
  /* Inserting a measure adjacent to a section break must NOT lose the section's
     final barline (it's derived from position). */
  ctrlM_keeps_section_bar: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.appendMeasure();
      const cc = m.getMeasureStartCursor(1, 1); m.setCursor(cc, 1);
      m.insertChordAtCursor({ notes: [{ q: 1, r: 0, pname: 'c', accid: 's', oct: 5, midi: 73, colorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.setSectionHeaderAt(1, 'II');
      m.setCursor(m.getMeasureStartCursor(1, 0), 1);
    `,
    setupKeys: [{ key: 'm' }],
  },
};

export const ASSERTIONS = {
  /* ── Repeats + endings ────────────────────────────────────── */
  repeat_end_toggle: [
    { name: 'M_1 has @right="rptend"',
      expr: `(() => {
        const ms = window.__hkl_composer.model.allMeasures();
        const r = ms[0].getAttribute('right');
        return r === 'rptend' ? { ok: true } : { ok: false, detail: 'm1.right=' + r };
      })()` },
  ],
  repeat_start_toggle: [
    { name: 'M_1 has @left="rptstart"',
      expr: `(() => {
        const ms = window.__hkl_composer.model.allMeasures();
        const l = ms[0].getAttribute('left');
        return l === 'rptstart' ? { ok: true } : { ok: false, detail: 'm1.left=' + l };
      })()` },
  ],
  repeat_replays_span: [
    { name: 'each note sounds twice; repeat pass offset by one 2-bar cycle (4000ms)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const evs = window.__hkl_composer.buildPlayback(m).filter(e => e.notes.length > 0);
        if (evs.length !== 4) return { ok: false, detail: 'noteEvents=' + evs.length };
        const at = evs.map(e => Math.round(e.atMs));
        const ok = at[0] === 0 && at[1] === 2000 && at[2] === 4000 && at[3] === 6000
          && evs[0].meiId === evs[2].meiId && evs[1].meiId === evs[3].meiId;
        return ok ? { ok: true } : { ok: false, detail: 'atMs=' + at.join(',') + ' ids=' + evs.map(e=>e.meiId).join(',') };
      })()` },
  ],
  volta_1st_2nd: [
    { name: 'm2 in <ending n=1>, m3 in <ending n=2>',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        const e2 = ms[1].closest('ending')?.getAttribute('n');
        const e3 = ms[2].closest('ending')?.getAttribute('n');
        return (e2 === '1' && e3 === '2') ? { ok: true } : { ok: false, detail: 'e2=' + e2 + ' e3=' + e3 };
      })()` },
    { name: 'play order m1,m2,m1,m3 (1st ending skipped on repeat pass)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const evs = window.__hkl_composer.buildPlayback(m).filter(e => e.notes.length > 0);
        const qs = evs.map(e => e.notes[0].q + '/' + e.notes[0].r);
        // m1=0/0, m2=0/1, m3=1/0  → expect 0/0, 0/1, 0/0, 1/0
        const want = ['0/0', '0/1', '0/0', '1/0'].join(',');
        return qs.join(',') === want ? { ok: true } : { ok: false, detail: 'order=' + qs.join(',') };
      })()` },
  ],
  ending_first_via_ctrlE: [
    { name: 'Ctrl+E on the rptend measure wraps it in <ending n=1>',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        const n = ms[0].closest('ending')?.getAttribute('n');
        return n === '1' ? { ok: true } : { ok: false, detail: 'ending.n=' + n };
      })()` },
  ],
  /* ── 8va ──────────────────────────────────────────────────── */
  ottava_shifts_pitch: [
    { name: '<octave dis=8 dis.place=above staff=1> with note anchors',
      expr: `(() => {
        const oct = window.__hkl_composer.model.getDoc().querySelector('octave');
        if (!oct) return { ok: false, detail: 'no <octave>' };
        const ok = oct.getAttribute('dis') === '8'
          && oct.getAttribute('dis.place') === 'above'
          && oct.getAttribute('staff') === '1'
          && !!oct.getAttribute('startid') && !!oct.getAttribute('endid');
        return ok ? { ok: true } : { ok: false, detail: oct.outerHTML };
      })()` },
    { name: 'both spanned notes sound an octave up (q + 3)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const evs = window.__hkl_composer.buildPlayback(m).filter(e => e.notes.length > 0);
        const qs = evs.map(e => e.notes[0].q);
        return (qs.length === 2 && qs[0] === 3 && qs[1] === 3)
          ? { ok: true } : { ok: false, detail: 'q=' + qs.join(',') };
      })()` },
    { name: 'ottava bracket actually renders (non-empty g.octave)',
      expr: `(() => {
        const g = document.querySelector('#score g.octave');
        if (!g) return { ok: false, detail: 'no g.octave' };
        const bb = g.getBBox();
        return bb.width > 1 ? { ok: true } : { ok: false, detail: 'empty bracket w=' + bb.width };
      })()` },
  ],
  /* ── Section headers ──────────────────────────────────────── */
  section_header: [
    { name: 'm2 tagged + forced <sb>, m1 final bar, m2 renumbered to 1',
      expr: `(() => {
        const ms = window.__hkl_composer.model.allMeasures();
        const title = ms[1].getAttribute('data-hkl-section-title');
        const sb = window.__hkl_composer.model.getDoc().querySelector('sb[data-hkl-section]');
        const m1bar = ms[0].getAttribute('right');
        const m2n = ms[1].getAttribute('n');
        if (title !== 'II. Andante') return { ok: false, detail: 'title=' + title };
        if (!sb) return { ok: false, detail: 'no <sb>' };
        if (m1bar !== 'end') return { ok: false, detail: 'm1 bar=' + m1bar };
        return m2n === '1' ? { ok: true } : { ok: false, detail: 'm2 n=' + m2n };
      })()` },
    { name: 'centered title text injected into the rendered SVG',
      expr: `(() => {
        const t = document.querySelector('#score text.hkl-section-header');
        return (t && t.textContent === 'II. Andante' && t.getAttribute('text-anchor') === 'middle')
          ? { ok: true } : { ok: false, detail: t ? t.outerHTML.slice(0,80) : 'no header text' };
      })()` },
  ],
  /* ── Page break ──────────────────────────────────────────── */
  pagebreak: [
    { name: '<pb> inserted before m2 and page view splits to 2 pages',
      expr: `(() => {
        const h = window.__hkl_composer;
        const pb = h.model.getDoc().querySelector('pb');
        if (!pb) return { ok: false, detail: 'no <pb>' };
        const pages = document.querySelectorAll('#score .score-page').length;
        return pages === 2 ? { ok: true } : { ok: false, detail: 'pageCount=' + pages };
      })()` },
  ],
  section_overflow_wraps: [
    { name: 'section wraps to multiple systems; header still starts its system',
      expr: `(() => {
        const h = window.__hkl_composer;
        const systems = document.querySelectorAll('#score g.system').length;
        if (systems < 3) return { ok: false, detail: 'systems=' + systems };
        const id = h.model.allMeasures()[1].getAttribute('xml:id');
        const el = document.getElementById(id);
        const starts = el?.closest('g.system')?.querySelector('g.measure')?.id === id;
        return starts ? { ok: true } : { ok: false, detail: 'section measure not at system start' };
      })()` },
  ],
  pagebreak_overflow_wraps: [
    { name: 'two pages, and content wraps to multiple systems (not one line)',
      expr: `(() => {
        const h = window.__hkl_composer;
        const pages = document.querySelectorAll('#score .score-page').length;
        const systems = document.querySelectorAll('#score g.system').length;
        if (pages !== 2) return { ok: false, detail: 'pages=' + pages };
        return systems >= 3 ? { ok: true } : { ok: false, detail: 'systems=' + systems };
      })()` },
  ],
  ctrlM_keeps_section_bar: [
    { name: 'after Ctrl+M the measure before the section still has @right="end"',
      expr: `(() => {
        const ms = window.__hkl_composer.model.allMeasures();
        const secIdx = ms.findIndex(x => x.getAttribute('data-hkl-section-title'));
        if (secIdx <= 0) return { ok: false, detail: 'no section / at index ' + secIdx };
        const before = ms[secIdx - 1].getAttribute('right');
        return before === 'end' ? { ok: true } : { ok: false, detail: 'bar before section=' + before };
      })()` },
  ],
  cursor_across_pagebreak: [
    { name: 'cursor overlay spans past page 1 (covers page 2)',
      expr: `(() => {
        const score = document.getElementById('score');
        const ov = document.getElementById('cursorOverlay');
        const pages = score.querySelectorAll('.score-page');
        if (pages.length !== 2) return { ok: false, detail: 'pages=' + pages.length };
        if (!ov) return { ok: false, detail: 'no overlay' };
        const sr = score.getBoundingClientRect();
        const p1 = pages[0].querySelector('svg').getBoundingClientRect();
        const p1bottom = p1.bottom - sr.top + score.scrollTop;
        const ovH = parseFloat(ov.getAttribute('height'));
        return ovH > p1bottom + 1 ? { ok: true } : { ok: false, detail: 'ovH=' + ovH + ' p1bottom=' + p1bottom };
      })()` },
  ],
};
