// Composer test fixtures — clefs.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

export const FIXTURES = {
  /* Regression: a mid-measure clef change in M1 must NOT drag the
     start-of-measure cursor anchor (cursor 0) past it. The leading-signature
     region is only what's left of the first notehead. */
  clef_cursor_start: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      m.setCursor(2, 1);
      m.setClefAt('F', '4', null, null); /* bass clef after the 2nd note */
      m.setCursor(0, 1);
      r();
    `,
  },
  /* Setting a clef back to the INHERITED clef removes the override rather than
     stacking a redundant clef (diff-aware, like setMeterAt/setKeySigAt). Empty
     V1 grand staff: Bass → one clef; Treble (= staffDef default) → no clefs;
     Alto (≠ default) → one clef again. */
  clef_setBackToInherited_removes: {
    setup: `
      m.setVoice(1); m.setCursor(0, 1);
      m.setClefAt('F', '4', null, null);   /* bass */
      m.setClefAt('G', '2', null, null);   /* back to inherited treble → remove */
      r();
    `,
  },
  /* Clef inheritance carries forward across measures: a Bass clef in M1 makes
     M2 inherit Bass, so setting Bass again in M2 is redundant (no new clef) and
     setting Treble in M2 is a real change. Guards the "staff 1 always treated as
     treble after an earlier clef change" bug. M1 4 quarters + M2 4 quarters. */
  clef_inheritsAcrossMeasures: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 8; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      m.setCursor(0, 1);
      m.setClefAt('F', '4', null, null);          /* bass at M1 start */
      m.setCursor(m.getMeasureStartCursor(1, 1), 1); /* → M2 start */
      m.setClefAt('F', '4', null, null);          /* Bass again = redundant (inherited) */
      r();
    `,
  },
  /* A mid-measure clef change. Fill M1 with 4 quarters, park the
     cursor in the middle, open Ctrl+Shift+C, choose Bass. Asserts an inline
     <clef> sits BETWEEN notes in the layer (mid-measure). */
  clef_midmeasure: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(2, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="clef"]').value = 'F|4||';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
  },
  /* Beat-mode selection + Ctrl+Shift+C applies a clef over the selected beats,
     confined: a bass clef at the span start and a restore (treble) clef after. */
  clef_sel_span: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 }); /* 4 quarters in 4/4 */
      m.setCursor(1, 1); /* on the 2nd beat boundary */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })); /* enter beat sel */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })); /* extend one beat */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="clef"]').value = 'F|4||';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
  },

  /* ── Clef slot model (2026-09-27) ────────────────────────────────────────────
   * A clef has no cursor stop, so "the clef at this cursor" is resolved by
   * model/clef-slot.ts. The barline between a FULL measure M and M+1 is ONE slot
   * reachable from two cursors ("past last of M" and "M+1 wrapper") and stored
   * in two spellings (M's tail, M+1's head); every read/write/remove sees both.
   * Clefs change only through the clef dialog (Max's rule: no indirect removal);
   * the selection clef change is the bounded exception and clears its span. */
  /* Max's repro, verbatim (2026-09-27): empty doc → add M2 → bass at M2's
     wrapper → back to M1's wrapper → whole rest → alto. Unfixed: the alto is
     appended to M1's tail while the bass stays at M2's head; the render
     relocates the bass next to it → two adjacent clef glyphs, overlapping. */
  clef_repro_barlineOverlap: {
    setup: `
      const openClef = (v) => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true }));
        const dlg = document.getElementById('textEntryDialog');
        dlg.querySelector('[data-field="clef"]').value = v;
        dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      };
      m.setVoice(1);
      m.appendMeasure();                                  /* 1. M2 */
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);      /*    M2's wrapper stop */
      openClef('F|4||');                                  /* 2. bass */
      m.setCursor(0, 1);                                  /* 3. ← to M1's wrapper */
      m.insertRestAtCursor({ duration: '1', dots: 0 });   /* 4. whole rest: M1 full, cursor past it */
      openClef('C|3||');                                  /* 5. alto at the barline */
      r();
    `,
  },
  /* Same barline from the other cursor: after bass at M2's head and a full
     M1, the dialog opened at "past last of M1" must pre-select Bass (the clef
     in force from there) and choosing the inherited Treble must REMOVE it. */
  clef_barline_twoCursorsOneSlot: {
    setup: `
      m.setVoice(1);
      m.appendMeasure();
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.setClefAt('F', '4', null, null);
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '1', dots: 0 });   /* cursor = past rest = barline */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      window.__clefPreselect = dlg.querySelector('[data-field="clef"]').value;
      dlg.querySelector('[data-field="clef"]').value = 'G|2||';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
  },
  /* Direct removal: the dialog's Remove button clears the clef at the slot
     (from the "past last of full M1" cursor); at a slot with no clef the
     button is disabled. */
  clef_dialog_remove: {
    setup: `
      m.setVoice(1);
      m.appendMeasure();
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.setClefAt('F', '4', null, null);
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '1', dots: 0 });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      const btn = dlg.querySelector('[data-action="clef-remove"]');
      window.__clefRemoveEnabled = !!btn && !btn.disabled;
      if (btn) btn.click();
      r();
    `,
  },
  /* Tail spelling: a clef built at the END of full M1's layer (what a reload
     or the old boundary write produced) is the same barline clef — the dialog
     at M2's wrapper pre-selects it and Remove clears it. */
  clef_dialog_remove_tailForm: {
    setup: `
      m.setVoice(1);
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '1', dots: 0 });
      m.appendMeasure();
      const d = m.getDoc();
      const layer = m.layerInMeasure(m.allMeasures()[0], 1);
      const clefEl = d.createElementNS('http://www.music-encoding.org/ns/mei', 'clef');
      clefEl.setAttribute('shape', 'F'); clefEl.setAttribute('line', '4');
      clefEl.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:id', 'clf-tail');
      layer.appendChild(clefEl);
      m.setCursor(2, 1);                                  /* M2's wrapper */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      window.__clefPreselect = dlg.querySelector('[data-field="clef"]').value;
      const btn = dlg.querySelector('[data-action="clef-remove"]');
      window.__clefRemoveEnabled = !!btn && !btn.disabled;
      if (btn) btn.click();
      r();
    `,
  },
  /* Guard for the direct-only rule: deleting a beat selection that spans a
     clef removes the notes, never the clef. */
  clef_selectionDelete_keepsClefs: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      m.setCursor(2, 1);
      m.setClefAt('F', '4', null, null);                  /* bass before the 3rd note */
      m.setCursor(2, 1);
      r();
    `,
    setupKeys: [{ key: 'ArrowRight', shift: true }, { key: 'ArrowRight', shift: true }, 'Delete'],
  },
  /* The bounded exception: a clef change over a beat selection sets the WHOLE
     span — clefs strictly inside it are removed, the new clef goes at the
     start, and the clef in force at the end is restored there. Keystroke-
     driven: Shift+→ from cursor 2 selects the beat to its right (note 3) and
     seven more extend to note 10, so start = before note 3, end = before
     note 11 (M3 b3); the bass at M2's head (before note 5) is interior. */
  clef_range_clearsInterior: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 12; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      const d = m.getDoc();
      const l2 = m.layerInMeasure(m.allMeasures()[1], 1);
      const clefEl = d.createElementNS('http://www.music-encoding.org/ns/mei', 'clef');
      clefEl.setAttribute('shape', 'F'); clefEl.setAttribute('line', '4');
      clefEl.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:id', 'clf-m2');
      l2.insertBefore(clefEl, l2.firstElementChild);
      m.setCursor(2, 1);
      for (let i = 0; i < 8; i++)
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="clef"]').value = 'C|3||';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
  },
  /* A clef sitting exactly at the selection END is not interior: it stays
     untouched (same element, same attrs) and no second restore is added. */
  clef_range_endSlotClef: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 12; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      const d = m.getDoc();
      const l3 = m.layerInMeasure(m.allMeasures()[2], 1);
      const n10 = m.contentChildren(l3)[1];
      const clefEl = d.createElementNS('http://www.music-encoding.org/ns/mei', 'clef');
      clefEl.setAttribute('shape', 'F'); clefEl.setAttribute('line', '4');
      clefEl.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:id', 'clf-end');
      l3.insertBefore(clefEl, n10);
      m.setClefRange(1, 1, 9, 'C', '3', null, null);
      m.setCursor(0, 1);
      r();
    `,
  },
  /* …and when that end clef equals the new clef it is now redundant (the
     change begins at the selection start) and is removed. */
  clef_range_endSlotClefRedundant: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 12; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      const d = m.getDoc();
      const l3 = m.layerInMeasure(m.allMeasures()[2], 1);
      const n10 = m.contentChildren(l3)[1];
      const clefEl = d.createElementNS('http://www.music-encoding.org/ns/mei', 'clef');
      clefEl.setAttribute('shape', 'C'); clefEl.setAttribute('line', '3');
      clefEl.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:id', 'clf-end');
      l3.insertBefore(clefEl, n10);
      m.setClefRange(1, 1, 9, 'C', '3', null, null);
      m.setCursor(0, 1);
      r();
    `,
  },
  /* Selection ending at the barline of a full M1 whose M2 begins with a clef:
     the restore lands ON that head clef (one clef at the barline, nothing
     appended to M1's tail). Unfixed: a treble restore is appended to M1 and
     the render draws it against M2's bass. */
  clef_range_barlineEnd: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 8; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      const d = m.getDoc();
      const l2 = m.layerInMeasure(m.allMeasures()[1], 1);
      const clefEl = d.createElementNS('http://www.music-encoding.org/ns/mei', 'clef');
      clefEl.setAttribute('shape', 'F'); clefEl.setAttribute('line', '4');
      clefEl.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:id', 'clf-m2');
      l2.insertBefore(clefEl, l2.firstElementChild);
      m.setClefRange(1, 1, 4, 'C', '3', null, null);
      m.setCursor(0, 1);
      r();
    `,
  },
  /* Backspace at the wrapper of a measure that holds a clef change must not
     delete the measure (that would silently drop the clef — a cascade):
     skip-left instead, like a non-empty wrapper. */
  clef_backspace_clefMeasure_skipsLeft: {
    setup: `
      m.setVoice(1);
      m.appendMeasure();
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.setClefAt('F', '4', null, null);
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '1', dots: 0 });
      m.setCursor(2, 1);                                  /* M2's wrapper (clef-only measure) */
      r();
    `,
    setupKeys: ['Backspace'],
  },
  /* A clef in an EMPTY bar survives save→load→save in place. The save
     relocates M2's head clef to M1's tail as [space, clef]; the load's
     placeholder rebuild used to append the fresh space AFTER the clef, making
     it M1's head clef, which the next save relocated a bar earlier again —
     one bar of drift per cycle (lessons "clef on an empty layer does not
     roundtrip"). Two cycles here; the clef must stay M1's LAST child. */
  clef_emptyBar_tailForm_roundtrip: {
    setup: `
      m.setVoice(1);
      m.appendMeasure();
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.setClefAt('F', '4', null, null);
      m.setCursor(0, 1);
      r();
    `,
  },
  /* An empty bar followed by a head-clef measure renders [mRest, courtesy
     clef]; the empty bar's wrapper cursor must draw at the bar's start, LEFT
     of that courtesy clef (findSigEndXForStaff must treat g.mRest as content). */
  clef_emptyBar_cursorLeftOfCourtesyClef: {
    setup: `
      m.setVoice(1);
      m.appendMeasure();
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.setClefAt('F', '4', null, null);
      m.setCursor(0, 1);
      r();
    `,
  },
};

export const ASSERTIONS = {
  clef_cursor_start: [
    { name: 'cursor at start anchors LEFT of the mid-measure clef change',
      expr: `(() => {
        const bar = document.querySelector('[data-cursor-role="voice"]');
        if (!bar) return { ok: false, detail: 'no voice cursor bar' };
        const barLeft = bar.getBoundingClientRect().left;
        const clefs = [...document.querySelectorAll('#score g.clef')];
        if (clefs.length < 3) return { ok: false, detail: 'g.clef=' + clefs.length + ' (expected ≥3: 2 opening + 1 change)' };
        /* The mid-measure change is the rightmost clef glyph. */
        const midClefLeft = Math.max(...clefs.map(c => c.getBoundingClientRect().left));
        if (!(barLeft < midClefLeft)) return { ok: false, detail: 'cursor left=' + Math.round(barLeft) + ' not < mid-clef left=' + Math.round(midClefLeft) };
        return { ok: true };
      })()` },
  ],
  clef_setBackToInherited_removes: [
    { name: 'clef set back to inherited treble removes the override (zero <clef>)',
      expr: `(() => {
        const n = window.__hkl_composer.model.getDoc().querySelectorAll('clef').length;
        return n === 0 ? { ok: true } : { ok: false, detail: 'clef count=' + n + ' (expected 0 after set-back)' };
      })()` },
  ],
  clef_inheritsAcrossMeasures: [
    { name: 'M2 inherits M1 Bass: clefAtCursor=F/4 and re-setting Bass in M2 is redundant (one clef total)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const n = m.getDoc().querySelectorAll('clef').length;
        const c = m.clefAtCursor();   /* cursor is at M2 start */
        return n === 1 && c.shape === 'F' && c.line === '4'
          ? { ok: true }
          : { ok: false, detail: 'clefCount=' + n + ' clefAtCursor=' + c.shape + '/' + c.line + ' (expected 1, F/4)' };
      })()` },
  ],
  clef_midmeasure: [
    { name: 'one inline bass <clef> placed BETWEEN notes in the layer',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const clefs = [...m.getDoc().querySelectorAll('layer > clef')];
        if (clefs.length !== 1) return { ok: false, detail: 'layer clefs=' + clefs.length + ' (expected 1)' };
        const cl = clefs[0];
        if (cl.getAttribute('shape') !== 'F' || cl.getAttribute('line') !== '4')
          return { ok: false, detail: 'clef shape/line=' + cl.getAttribute('shape') + '/' + cl.getAttribute('line') };
        const sibs = [...cl.parentElement.children];
        const idx = sibs.indexOf(cl);
        const isContent = (e) => e && ['note', 'chord', 'rest', 'tuplet'].includes(e.localName);
        const before = sibs.slice(0, idx).some(isContent);
        const after = sibs.slice(idx + 1).some(isContent);
        if (!before || !after) return { ok: false, detail: 'clef not mid-measure (before=' + before + ' after=' + after + ')' };
        /* Verovio rendered a mid-measure clef change (a g.clef beyond the staff's opening clef). */
        const rendered = document.querySelectorAll('#score g.clef').length;
        if (rendered < 3) return { ok: false, detail: 'rendered g.clef=' + rendered + ' (expected ≥3: 2 opening + 1 change)' };
        return { ok: true };
      })()` },
  ],
  /* ── Clef slot model (2026-09-27) ──────────────────────────────────────── */
  clef_repro_barlineOverlap: [
    { name: 'live doc holds ONE clef: alto, layer-initial in M2 (canonical barline form)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const clefs = [...m.getDoc().querySelectorAll('clef')];
        if (clefs.length !== 1) return { ok: false, detail: 'clef count=' + clefs.length + ' (expected 1): ' + clefs.map(c => c.getAttribute('shape') + c.getAttribute('line') + '@m' + m.allMeasures().indexOf(c.closest('measure'))).join(',') };
        const c = clefs[0];
        if (c.getAttribute('shape') !== 'C' || c.getAttribute('line') !== '3') return { ok: false, detail: 'clef=' + c.getAttribute('shape') + '/' + c.getAttribute('line') + ' (expected C/3)' };
        const mi = m.allMeasures().indexOf(c.closest('measure'));
        if (mi !== 1) return { ok: false, detail: 'clef in measure idx ' + mi + ' (expected 1)' };
        if (c.previousElementSibling !== null) return { ok: false, detail: 'clef not layer-initial (prev=' + c.previousElementSibling.localName + ')' };
        return { ok: true };
      })()` },
    { name: 'render: exactly one clef-change glyph and no two clef glyphs overlap',
      expr: `(() => {
        const clefs = [...document.querySelectorAll('#score g.clef')];
        if (clefs.length !== 3) return { ok: false, detail: 'g.clef=' + clefs.length + ' (expected 3: 2 opening + 1 change)' };
        const rs = clefs.map(c => c.getBoundingClientRect());
        for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
          const a = rs[i], b = rs[j];
          if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
            return { ok: false, detail: 'clef glyphs ' + i + ' and ' + j + ' overlap (x ' + Math.round(a.left) + '-' + Math.round(a.right) + ' vs ' + Math.round(b.left) + '-' + Math.round(b.right) + ')' };
        }
        return { ok: true };
      })()` },
    { name: 'clefAtCursor reports alto from BOTH barline cursors (past rest in M1, M2 wrapper)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const keep = m.getCursor(1);
        m.setCursor(1, 1); const a = m.clefAtCursor();
        m.setCursor(2, 1); const b = m.clefAtCursor();
        m.setCursor(keep, 1);
        const s = (c) => c.shape + '/' + c.line;
        return s(a) === 'C/3' && s(b) === 'C/3' ? { ok: true } : { ok: false, detail: 'past-rest=' + s(a) + ' m2wrapper=' + s(b) + ' (expected C/3 both)' };
      })()` },
  ],
  clef_barline_twoCursorsOneSlot: [
    { name: 'dialog at "past last of full M1" pre-selects the Bass at M2’s head; choosing Treble removes it',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const n = m.getDoc().querySelectorAll('clef').length;
        if (window.__clefPreselect !== 'F|4||') return { ok: false, detail: 'preselect=' + window.__clefPreselect + ' (expected F|4||)' };
        return n === 0 ? { ok: true } : { ok: false, detail: 'clef count=' + n + ' (expected 0 after set-to-inherited)' };
      })()` },
  ],
  clef_dialog_remove: [
    { name: 'Remove button enabled at the barline slot and removes the clef',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        if (!window.__clefRemoveEnabled) return { ok: false, detail: 'remove button missing or disabled' };
        const n = m.getDoc().querySelectorAll('clef').length;
        return n === 0 ? { ok: true } : { ok: false, detail: 'clef count=' + n + ' (expected 0 after Remove)' };
      })()` },
    { name: 'Remove button disabled at a slot with no clef',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        m.setCursor(0, 1);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true }));
        const dlg = document.getElementById('textEntryDialog');
        const btn = dlg.querySelector('[data-action="clef-remove"]');
        const disabled = !!btn && btn.disabled;
        dlg.close();
        return disabled ? { ok: true } : { ok: false, detail: btn ? 'remove button enabled with no clef at slot' : 'remove button missing' };
      })()` },
  ],
  clef_dialog_remove_tailForm: [
    { name: 'tail-spelled clef at M1’s end is seen from M2’s wrapper (pre-select Bass) and removed',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        if (window.__clefPreselect !== 'F|4||') return { ok: false, detail: 'preselect=' + window.__clefPreselect + ' (expected F|4||)' };
        if (!window.__clefRemoveEnabled) return { ok: false, detail: 'remove button missing or disabled' };
        const n = m.getDoc().querySelectorAll('clef').length;
        return n === 0 ? { ok: true } : { ok: false, detail: 'clef count=' + n + ' (expected 0 after Remove)' };
      })()` },
  ],
  clef_selectionDelete_keepsClefs: [
    { name: 'Delete over a beat selection removes notes but never the clef',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const clefs = m.getDoc().querySelectorAll('clef').length;
        const layer = m.layerInMeasure(m.allMeasures()[0], 1);
        const chords = m.contentChildren(layer).filter((e) => e.localName === 'chord' || e.localName === 'note').length;
        if (clefs !== 1) return { ok: false, detail: 'clef count=' + clefs + ' (expected 1 — selection delete must not remove clefs)' };
        if (chords !== 2) return { ok: false, detail: 'chords=' + chords + ' (expected 2 after deleting two beats; a partial clear refills with rests)' };
        return { ok: true };
      })()` },
  ],
  clef_range_clearsInterior: [
    { name: 'range clef: alto before note 3, interior M2-head bass removed, bass restored before note 11',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = [...m.getDoc().querySelectorAll('layer > chord, layer > note')];
        const clefs = [...m.getDoc().querySelectorAll('clef')];
        const desc = () => clefs.map(c => c.getAttribute('shape') + c.getAttribute('line') + '>' + (c.nextElementSibling ? c.nextElementSibling.localName + '#' + notes.indexOf(c.nextElementSibling) : 'end')).join(',');
        if (clefs.length !== 2) return { ok: false, detail: 'clef count=' + clefs.length + ' (expected 2): ' + desc() };
        const [a, b] = clefs;
        if (a.getAttribute('shape') !== 'C' || a.nextElementSibling !== notes[2]) return { ok: false, detail: 'first clef wrong: ' + desc() };
        if (b.getAttribute('shape') !== 'F' || b.nextElementSibling !== notes[10]) return { ok: false, detail: 'restore clef wrong: ' + desc() };
        if (m.getDoc().querySelector('#clf-m2, [*|id="clf-m2"]')) return { ok: false, detail: 'interior clef clf-m2 survived' };
        return { ok: true };
      })()` },
  ],
  clef_range_endSlotClef: [
    { name: 'clef at the selection end is untouched: same element, F/4, before note 10; alto before note 2',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = [...m.getDoc().querySelectorAll('layer > chord, layer > note')];
        const clefs = [...m.getDoc().querySelectorAll('clef')];
        const desc = () => clefs.map(c => (c.getAttribute('xml:id') || '?') + ':' + c.getAttribute('shape') + c.getAttribute('line') + '>' + (c.nextElementSibling ? notes.indexOf(c.nextElementSibling) : 'end')).join(',');
        if (clefs.length !== 2) return { ok: false, detail: 'clef count=' + clefs.length + ' (expected 2): ' + desc() };
        const end = clefs.find(c => c.getAttribute('xml:id') === 'clf-end');
        if (!end || end.getAttribute('shape') !== 'F' || end.getAttribute('line') !== '4' || end.nextElementSibling !== notes[9]) return { ok: false, detail: 'end clef changed: ' + desc() };
        const start = clefs.find(c => c !== end);
        if (start.getAttribute('shape') !== 'C' || start.nextElementSibling !== notes[1]) return { ok: false, detail: 'start clef wrong: ' + desc() };
        return { ok: true };
      })()` },
  ],
  clef_range_endSlotClefRedundant: [
    { name: 'end clef equal to the new clef becomes redundant and is removed; one alto before note 2',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = [...m.getDoc().querySelectorAll('layer > chord, layer > note')];
        const clefs = [...m.getDoc().querySelectorAll('clef')];
        if (clefs.length !== 1) return { ok: false, detail: 'clef count=' + clefs.length + ' (expected 1)' };
        const c = clefs[0];
        if (c.getAttribute('shape') !== 'C' || c.nextElementSibling !== notes[1]) return { ok: false, detail: 'clef ' + c.getAttribute('shape') + ' before note ' + notes.indexOf(c.nextElementSibling) };
        return { ok: true };
      })()` },
  ],
  clef_range_barlineEnd: [
    { name: 'restore at a full-measure barline lands on M2’s head clef: two clefs total, nothing on M1’s tail',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const measures = m.allMeasures();
        const notes = [...m.getDoc().querySelectorAll('layer > chord, layer > note')];
        const clefs = [...m.getDoc().querySelectorAll('clef')];
        const desc = () => clefs.map(c => c.getAttribute('shape') + c.getAttribute('line') + '@m' + measures.indexOf(c.closest('measure')) + '>' + (c.nextElementSibling ? notes.indexOf(c.nextElementSibling) : 'end')).join(',');
        if (clefs.length !== 2) return { ok: false, detail: 'clef count=' + clefs.length + ' (expected 2): ' + desc() };
        const l1 = m.layerInMeasure(measures[0], 1);
        if (l1.lastElementChild && l1.lastElementChild.localName === 'clef') return { ok: false, detail: 'clef appended to M1 tail: ' + desc() };
        const head = m.layerInMeasure(measures[1], 1).firstElementChild;
        if (!head || head.localName !== 'clef' || head.getAttribute('shape') !== 'F') return { ok: false, detail: 'M2 head is not the bass clef: ' + desc() };
        const rendered = document.querySelectorAll('#score g.clef').length;
        if (rendered !== 4) return { ok: false, detail: 'rendered g.clef=' + rendered + ' (expected 4: 2 opening + alto + bass)' };
        return { ok: true };
      })()` },
  ],
  clef_backspace_clefMeasure_skipsLeft: [
    { name: 'Backspace at a clef-holding measure wrapper keeps the measure and clef, moves left',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const measures = m.allMeasures().length;
        const clefs = m.getDoc().querySelectorAll('clef').length;
        const c = m.getCursor(1);
        if (measures !== 2) return { ok: false, detail: 'measures=' + measures + ' (expected 2 — measure deleted)' };
        if (clefs !== 1) return { ok: false, detail: 'clef count=' + clefs + ' (expected 1)' };
        if (c !== 1) return { ok: false, detail: 'cursor=' + c + ' (expected 1: skipped left)' };
        return { ok: true };
      })()` },
  ],
  clef_emptyBar_tailForm_roundtrip: [
    { name: 'clef in an empty bar stays at M1’s tail (after the placeholder) across two save/load cycles',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const Model = m.constructor;
        const where = (doc) => {
          const measures = [...doc.querySelectorAll('measure')];
          const clefs = [...doc.querySelectorAll('clef')];
          return clefs.map(c => 'm' + measures.indexOf(c.closest('measure')) + (c.nextElementSibling ? '>' + c.nextElementSibling.localName : '>end')).join(',');
        };
        const one = new Model(m.serialize());
        const two = new Model(one.serialize());
        const w1 = where(one.getDoc()), w2 = where(two.getDoc());
        if (w1 !== 'm0>end') return { ok: false, detail: 'after 1 cycle: ' + w1 + ' (expected m0>end — clef last in M1)' };
        if (w2 !== 'm0>end') return { ok: false, detail: 'after 2 cycles: ' + w2 + ' (expected m0>end)' };
        return { ok: true };
      })()` },
  ],
  clef_emptyBar_cursorLeftOfCourtesyClef: [
    { name: 'empty M1 wrapper cursor draws LEFT of the courtesy clef at M1’s end',
      expr: `(() => {
        const bar = document.querySelector('rect[data-cursor-role="voice"]');
        if (!bar) return { ok: false, detail: 'no voice cursor bar' };
        const barLeft = bar.getBoundingClientRect().left;
        const clefs = [...document.querySelectorAll('#score g.clef')];
        if (clefs.length < 3) return { ok: false, detail: 'g.clef=' + clefs.length + ' (expected ≥3)' };
        const courtesyLeft = Math.max(...clefs.map(c => c.getBoundingClientRect().left));
        return barLeft < courtesyLeft ? { ok: true } : { ok: false, detail: 'cursor left=' + Math.round(barLeft) + ' not < courtesy clef left=' + Math.round(courtesyLeft) };
      })()` },
  ],
  /* Clef over a beat span — bass at the start, restore clef after. */
  clef_sel_span: [
    { name: 'two inline clefs: bass at span start, treble restore after (left→right)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const clefs = [...m.getDoc().querySelectorAll('layer[n="1"] > clef')];
        if (clefs.length !== 2) return { ok: false, detail: 'inline clefs=' + clefs.length + ' (expected 2)' };
        if (clefs[0].getAttribute('shape') !== 'F') return { ok: false, detail: 'first clef shape=' + clefs[0].getAttribute('shape') + ' (expected F/bass)' };
        if (clefs[1].getAttribute('shape') !== 'G') return { ok: false, detail: 'second clef shape=' + clefs[1].getAttribute('shape') + ' (expected G/treble restore)' };
        return { ok: true };
      })()` },
  ],
};
