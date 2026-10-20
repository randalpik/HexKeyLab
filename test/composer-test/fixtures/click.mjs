// Composer test fixtures — click.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

import {
  A4,
} from './_helpers.mjs';

export const FIXTURES = {
  /* Click on a rendered note moves the editing cursor to that note's
     flat-index and switches voice. Simulate the click by dispatching a
     `click` event on Verovio's <g class="note" id="<meiId>"> element. */
  click_movesCursorToNote: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 1, r: 0, pname: 'c', accid: 's', oct: 4, midi: 61, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(0, 1);  /* park cursor at start */
      r();
      /* Target the SECOND rendered g.note (= second note element in document
         order = the C# at flat[1] of voice 1). */
      const notes = [...document.querySelectorAll('#score g.note')];
      const target = notes[1];
      const rect = target.getBoundingClientRect();
      const ev = new MouseEvent('click', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      });
      target.dispatchEvent(ev);
    `,
  },
  /* REGRESSION: clicking an inner <note> of a chord in a different voice
     must resolve to the chord wrapper (which IS in flatChildren of that
     voice) — not the inner note's own xml:id (which isn't). */
  click_chordInternal_switchesVoice: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [
        { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 },
        { q: -1, r: 1, pname: 'c', accid: '', oct: 5, midi: 72, colorHex: '#888', velocity: 80 },
      ], duration: '4', dots: 0 });
      m.setVoice(3); m.setCursor(0, 3);
      m.insertChordAtCursor({ notes: [
        { q: 0, r: -2, pname: 'e', accid: '', oct: 2, midi: 40, colorHex: '#888', velocity: 80 },
        { q: -1, r: -1, pname: 'g', accid: '', oct: 2, midi: 43, colorHex: '#888', velocity: 80 },
      ], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
      /* Dispatch click on a V_3 chord-internal note. */
      const v3Notes = [...document.querySelectorAll('#score g.note')].filter(n => {
        let p = n; while (p && p.tagName !== 'svg' && (p.getAttribute && p.getAttribute('class') !== 'staff')) p = p.parentElement;
        return p?.getAttribute('class') === 'staff' && [...p.parentElement?.querySelectorAll('g.staff') ?? []].indexOf(p) === 1;
      });
      const target = v3Notes[0];
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2, button: 0 }));
    `,
  },
  /* Click on a different voice's note switches the active voice. */
  click_switchesVoice: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setVoice(3);
      m.setCursor(0, 3);
      m.insertChordAtCursor({ notes: [{ q: 0, r: -2, pname: 'e', accid: '', oct: 2, midi: 40, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setVoice(1);
      m.setCursor(0, 1);
      r();
      /* Find the voice-3 note element (bass clef, lower staff) by data-q/r. */
      const notes = [...document.querySelectorAll('#score g.note')];
      const target = notes.find(n => {
        const cls = n.parentElement; /* g.staff ancestor */
        let p = n;
        while (p && !(p.getAttribute && p.getAttribute('class')?.startsWith('staff'))) p = p.parentElement;
        return p?.getAttribute('class') === 'staff' && p.getAttribute('data-n') === '2';
      }) || notes[notes.length - 1];
      const rect = target.getBoundingClientRect();
      const ev = new MouseEvent('click', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      });
      target.dispatchEvent(ev);
    `,
  },

  /* ── Mouse (click-to-position) ──────────────────────────────────── */
  //
  // Click fixtures drive a real MouseEvent at computed on-screen coordinates in
  // the setup snippet (no setupKeys mouse support). The click handler lives on
  // #score and uses document.elementFromPoint, so coordinates must be derived
  // from rendered glyph rects after r().
  /* Click-to-select must behave like arrow nav: clear any active selection +
     return to voice mode, AND broadcast composer-cursor to HKL. Earlier the
     click path used a minimal onChange that did neither. Connect (sendHklHello)
     so broadcasts fire; make a beat selection via Shift+Right; reset the mock;
     then click note 0. Asserted via FIXTURE_ASSERTIONS.clickClearsSelAndBroadcasts. */
  clickClearsSelAndBroadcasts: {
    setup: `
      window.__bridgeMock.sendHklHello();
      m.setCursor(0, 1);
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      m.setCursor(1, 1); r();
      /* Make a range selection (Shift+Right) so there's something to clear. */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
      window.__bridgeMock.reset();
      const N = [...document.querySelectorAll('#score svg g.note')].map((g) => g.getBoundingClientRect());
      document.getElementById('score').dispatchEvent(new MouseEvent('click',
        { clientX: N[0].left + N[0].width / 2, clientY: N[0].top + N[0].height / 2, button: 0, bubbles: true }));
    `,
  },
  /* Clicking the empty right portion of a staff (past the last note) snaps the
     cursor to the "after last note" stop — flat[0] is the measure wrapper, so
     two notes sit at indices 1,2 and "after note 2" is cursor 3. */
  click_emptyStaff_snapsAfterLastNote: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 2; i++) m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      m.setCursor(0, 1);
      r();
      const notes = document.querySelectorAll('#score svg g.note');
      const last = notes[notes.length - 1].getBoundingClientRect();
      document.getElementById('score').dispatchEvent(new MouseEvent('click',
        { clientX: last.right + 14, clientY: last.top + last.height / 2, button: 0, bubbles: true }));
    `,
  },
  /* Clicking left of the first note (in the clef/sig region) snaps to the
     "before first note" stop — cursor 1. */
  click_emptyStaff_snapsBeforeFirstNote: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 2; i++) m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      m.setCursor(2, 1);
      r();
      const notes = document.querySelectorAll('#score svg g.note');
      const first = notes[0].getBoundingClientRect();
      document.getElementById('score').dispatchEvent(new MouseEvent('click',
        { clientX: first.left - 20, clientY: first.top + first.height / 2, button: 0, bubbles: true }));
    `,
  },
  /* Clicking a fully-empty measure's staff places the cursor at that measure's
     start stop (was a no-op). Empty single-measure doc; park on voice 3, then
     click M1's (on-screen, leftmost) treble staff → cursor jumps to voice 1 at
     the M1 start stop (cursor 0). */
  click_emptyMeasure_snapsToMeasureStart: {
    setup: `
      m.setVoice(3); m.setCursor(0, 3);
      r();
      const m1t = document.querySelector('#score svg g.staff');  /* M1 treble */
      const rect = m1t.getBoundingClientRect();
      document.getElementById('score').dispatchEvent(new MouseEvent('click',
        { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, bubbles: true }));
    `,
  },
  /* Clicking in the gap BETWEEN two notes snaps to the LEFT note (cursor to its
     right, where the INS cursor renders) — even in the half nearer the right
     note. 4 quarters; click 3/4 of the way through the n1→n2 gap (nearer n2);
     cursor lands at 2 = right of n1, not 3. */
  click_betweenNotes_snapsToLeftNote: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      r();
      const N = [...document.querySelectorAll('#score svg g.note')].map((g) => g.getBoundingClientRect());
      const x = N[0].right + (N[1].left - N[0].right) * 0.75;  /* gap, nearer n2 */
      document.getElementById('score').dispatchEvent(new MouseEvent('click',
        { clientX: x, clientY: N[0].top + N[0].height / 2, button: 0, bubbles: true }));
    `,
  },
  /* A click in WHITESPACE far from any note still resolves (no no-op) — the
     global nearest-target search picks the closest stop. Parked on V1; click
     just below the (empty) bass staff → cursor jumps to a bass voice's
     measure-start stop. */
  click_whitespace_resolvesToNearest: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(1, 1);
      r();
      const staves = [...document.querySelectorAll('#score svg g.staff')];
      const bass = staves[1].getBoundingClientRect();  /* M1 bass (empty) */
      document.getElementById('score').dispatchEvent(new MouseEvent('click',
        { clientX: bass.left + bass.width / 2, clientY: bass.bottom + 15, button: 0, bubbles: true }));
    `,
  },
  /* Clicking a rendered <dynam> selects it in the expression layer (switches
     cursorMode to expr, snaps to its moment); a follow-up Backspace deletes it
     — the "easy delete" path the backlog asks for. */
  click_dynam_selectsExpr_thenDeletes: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '%', shiftKey: true, bubbles: true }));
      r();
      const dyn = document.querySelector('#score svg g.dynam');
      const rect = dyn.getBoundingClientRect();
      document.getElementById('score').dispatchEvent(new MouseEvent('click',
        { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, bubbles: true }));
    `,
    setupKeys: ['Backspace'],
  },
  /* Clicking a rendered <tempo> selects it in the tempo layer. */
  click_tempo_selectsTempoLayer: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="kind"]').value = 'instant';
      dlg.querySelector('[data-field="bpm"]').value = '100';
      dlg.querySelector('[data-field="text"]').value = 'Allegro';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
      const tg = document.querySelector('#score svg g.tempo');
      const rect = tg.getBoundingClientRect();
      document.getElementById('score').dispatchEvent(new MouseEvent('click',
        { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, bubbles: true }));
    `,
  },
};

export const ASSERTIONS = {
  click_emptyStaff_snapsAfterLastNote: [
    { name: 'click past last note → cursor 2 (selects note 2; INS cursor at its right)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const v = m.getCurrentVoice(), c = m.getCursor(1);
        return v === 1 && c === 2
          ? { ok: true }
          : { ok: false, detail: 'voice=' + v + ' cursor=' + c + ' (expected voice 1, cursor 2)' };
      })()` },
  ],
  click_emptyStaff_snapsBeforeFirstNote: [
    { name: 'click left of first note → cursor 0 (before note 1 = measure start), voice 1',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const v = m.getCurrentVoice(), c = m.getCursor(1);
        return v === 1 && c === 0
          ? { ok: true }
          : { ok: false, detail: 'voice=' + v + ' cursor=' + c + ' (expected voice 1, cursor 0)' };
      })()` },
  ],
  click_emptyMeasure_snapsToMeasureStart: [
    { name: 'click empty M1 treble (parked on V3) → cursor jumps to V1 M1 start',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const v = m.getCurrentVoice(), c = m.getCursor(v);
        return v === 1 && c === 0
          ? { ok: true }
          : { ok: false, detail: 'voice=' + v + ' cursor=' + c + ' (expected voice 1, cursor 0)' };
      })()` },
  ],
  click_betweenNotes_snapsToLeftNote: [
    { name: 'click in n1→n2 gap (nearer n2) lands cursor 1 = selects n1 (INS cursor at its right)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const v = m.getCurrentVoice(), c = m.getCursor(1);
        return v === 1 && c === 1
          ? { ok: true }
          : { ok: false, detail: 'voice=' + v + ' cursor=' + c + ' (expected voice 1, cursor 1)' };
      })()` },
  ],
  click_whitespace_resolvesToNearest: [
    { name: 'whitespace click below bass staff resolves to a bass voice (no no-op)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const s = window.__hkl_composer.inputState();
        const v = m.getCurrentVoice();
        return s.cursorMode === 'voice' && (v === 3 || v === 4)
          ? { ok: true }
          : { ok: false, detail: 'voice=' + v + ' mode=' + s.cursorMode + ' (expected a bass voice 3/4)' };
      })()` },
  ],
  click_dynam_selectsExpr_thenDeletes: [
    { name: 'clicking the dynam entered expr mode; Backspace deleted it',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const s = window.__hkl_composer.inputState();
        const n = m.getDoc().querySelectorAll('dynam').length;
        return s.cursorMode === 'expr' && n === 0
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode + ' dynamCount=' + n };
      })()` },
  ],
  click_tempo_selectsTempoLayer: [
    { name: 'clicking the tempo mark entered tempo mode at its moment',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (s.cursorMode !== 'tempo') return { ok: false, detail: 'cursorMode=' + s.cursorMode };
        const cur = s.tempoCursor.stops[s.tempoCursor.index]?.moment;
        return cur && cur.measureIdx === 0 && Math.abs(cur.tstamp - 1) < 1e-6
          ? { ok: true }
          : { ok: false, detail: 'moment=' + JSON.stringify(cur) };
      })()` },
  ],
  clickClearsSelAndBroadcasts: [
    { name: 'click clears selection + returns to voice mode + broadcasts composer-cursor',
      expr: `(async () => {
        for (let i = 0; i < 3; i++) { await new Promise((r) => requestAnimationFrame(() => r(true))); await Promise.resolve(); }
        const s = window.__hkl_composer.inputState();
        if (s.selection != null) return { ok: false, detail: 'selection not cleared: ' + JSON.stringify(s.selection) };
        if (s.cursorMode !== 'voice') return { ok: false, detail: 'cursorMode=' + s.cursorMode };
        const cap = window.__bridgeMock.captured();
        if (!cap.some((m) => m.type === 'composer-cursor')) {
          return { ok: false, detail: 'no composer-cursor after click; captured=' + JSON.stringify(cap.map((c) => c.type)) };
        }
        return { ok: true };
      })()` },
  ],
  /* ── Click-to-position ──────────────────────────────────────── */
  click_movesCursorToNote: [
    { name: 'cursor lands at the clicked C# note (cursor = its flat index; INS draws at its right)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const flat = m.flatChildren(1);
        /* flat[0] is the measure wrapper; notes occupy flat[1..3]. The 2nd
           rendered note = C# = flat[2]. Clicking it selects it: cursor = its
           flat index (the INS cursor draws at the note's right edge). */
        const csharp = flat.find(e => e.localName === 'note' && e.getAttribute('pname') === 'c');
        const wantIdx = flat.indexOf(csharp);
        const cur = m.getCursor(1);
        return cur === wantIdx ? { ok: true } : { ok: false, detail: 'cur=' + cur + ' want=' + wantIdx };
      })()` },
  ],
  click_switchesVoice: [
    { name: 'current voice = 3 after clicking the bass-staff note',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const v = m.getCurrentVoice();
        return v === 3 ? { ok: true } : { ok: false, detail: 'voice=' + v };
      })()` },
  ],
  click_chordInternal_switchesVoice: [
    { name: 'current voice = 3 after clicking a chord-internal note in V_3',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const v = m.getCurrentVoice();
        return v === 3 ? { ok: true } : { ok: false, detail: 'voice=' + v };
      })()` },
    { name: 'cursor at the V_3 chord (cursor = its flat index; INS draws at its right)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const flat = m.flatChildren(3);
        const chord = flat.find(e => e.localName === 'chord');
        const wantIdx = flat.indexOf(chord);
        return m.getCursor(3) === wantIdx ? { ok: true } : { ok: false, detail: 'cur=' + m.getCursor(3) + ' want=' + wantIdx };
      })()` },
  ],
};
