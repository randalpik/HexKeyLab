// Composer test fixtures — tuplets.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

/** Fixture-specific assertions. Map fixture name → list of {name, expr}.
 *  `expr` is evaluated in the page context post-setup; it must return
 *  { ok: boolean, detail?: string }. Use window.__test.* helpers.
 *
 *  Universal invariants (cursor-trace, no-tie-orphans, placeholder
 *  invariant, no console errors) are applied to EVERY fixture by the
 *  runner — don't repeat them here. */
/** Assertion expr: exactly one <tuplet num numbase> of `num` placeholder rests
 *  of `atomic`, `data-tuplet-atomic-dur` recorded, the dialog closed, and the
 *  cursor where Ctrl+N leaves it: at the wrapper's flat index, which the model
 *  reads as inside the tuplet (isCursorInTuplet). */
function tupletShapeExpr(num, numbase, atomic) {
  return `(() => {
    const m = window.__hkl_composer.model;
    const doc = m.getDoc();
    const ts = doc.querySelectorAll('tuplet');
    if (ts.length !== 1) return { ok: false, detail: 'tuplets=' + ts.length + ' (expected 1)' };
    const t = ts[0];
    const got = t.getAttribute('num') + ':' + t.getAttribute('numbase');
    if (got !== '${num}:${numbase}') return { ok: false, detail: 'ratio ' + got + ' (expected ${num}:${numbase})' };
    if (t.getAttribute('data-tuplet-atomic-dur') !== '${atomic}') return { ok: false, detail: 'atomic=' + t.getAttribute('data-tuplet-atomic-dur') + ' (expected ${atomic})' };
    const kids = [...t.children];
    if (kids.length !== ${num}) return { ok: false, detail: 'children=' + kids.length + ' (expected ${num})' };
    const bad = kids.find((k) => k.tagName !== 'rest' || k.getAttribute('dur') !== '${atomic}' || k.getAttribute('data-tuplet-placeholder') !== 'true');
    if (bad) return { ok: false, detail: 'unexpected child ' + bad.outerHTML.slice(0, 80) };
    if (document.getElementById('textEntryDialog').open) return { ok: false, detail: 'dialog still open' };
    const v = m.getCurrentVoice();
    const flat = m.flatChildren(v);
    const wi = flat.indexOf(t);
    if (wi < 0) return { ok: false, detail: 'tuplet wrapper not a cursor stop' };
    if (m.getCursor(v) !== wi) return { ok: false, detail: 'cursor=' + m.getCursor(v) + ' (expected the wrapper stop ' + wi + ', as after Ctrl+N)' };
    if (!m.isCursorInTuplet()) return { ok: false, detail: 'cursor not inside the new tuplet' };
    return { ok: true };
  })()`;
}

export const FIXTURES = {

  /* ── Tuplets ─────────────────────────────────────────────────────── */
  /* Triplet of 8ths at cursor 0 in 4/4 (8 ticks: 3 atomic 8th rests = 12
   * ticks → fits). */
  m1Triplet8Empty: { setup: `
    m.setCursor(0, 1);
    m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
  ` },
  /* Triplet of 8ths with one note entered. */
  m1Triplet8Partial: { setup: `
    m.setCursor(0, 1);
    m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
    /* Cursor now inside tuplet at fill-anchor; enter one rest. */
    m.insertRestAtCursor({ duration: "8", dots: 0 });
  ` },
  /* Triplet of 8ths fully filled (3 atomic rests). */
  m1Triplet8Full: { setup: `
    m.setCursor(0, 1);
    m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
    for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: "8", dots: 0 });
  ` },
  /* Triplet of 8ths filled with NOTES: the auto-beamer beams all three, and a
     tuplet wholly under one beam shows its number only — no bracket (Max,
     2026-09-05; Verovio's default once Composer stopped forcing
     bracket.visible="true"). The empty / rest-filled triplets keep theirs. */
  m1Triplet8BeamedNumberOnly: { setup: `
    m.setCursor(0, 1);
    m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
    for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
  ` },
  /* Triplet of QUARTERS filled with notes: nothing to beam, so Verovio draws
     the bracket (Composer forces neither way). */
  m1TripletQuarterBracket: { setup: `
    m.setCursor(0, 1);
    m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '4', spanDur: '2', spanDots: 0 });
    for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
  ` },
  /* Fill triplet then delete last → atomic regen produces an 8th placeholder. */
  m1Triplet8FilledThenDelete: { setup: `
    m.setCursor(0, 1);
    m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
    for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: "8", dots: 0 });
    m.deleteAtCursor();
  ` },
  /* Attempt to create a tuplet while cursor is inside an existing tuplet
   * → must be rejected. */
  m1TripletInsideTriplet: { setup: `
    m.setCursor(0, 1);
    m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
    /* Cursor now inside the tuplet at fill-anchor. Attempt nesting. */
    window.__tupletNestResult = m.createTupletAtCursor({
      num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0,
    });
  ` },
  /* ── Atomic tuplet placement at the bar line (2026-09-18) ──────────────
     The stop "past the last element of M" is ambiguous exactly when M is
     FULL (shouldEmitWrapper suppresses M+1's wrapper stop there), so it also
     means "head of M+1". A tuplet is atomic and can never straddle a bar, so
     it is placed at whichever reading has room — which for a full M is only
     ever the M+1 one. A PARTIAL measure keeps its own M+1 wrapper stop, so
     its end is unambiguous and an oversized tuplet is simply rejected. */

  /* M1 full, M2 does not exist yet → tuplet opens M2. */
  tupletAtBarlineOpensNextMeasure: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    window.__tupletBarlineResult = m.createTupletAtCursor({
      num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0,
    });
  ` },
  /* M1 full, M2 already holds a quarter, cursor seated on the end-of-M1 stop
     → tuplet lands at the HEAD of M2 and pushes the quarter right. */
  tupletAtBarlineBeforeExistingContent: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    /* Seat the cursor back on the end-of-M1 stop (past M1's last rest). */
    const l1 = m.layerInMeasure(m.allMeasures()[0], 1);
    const lastM1 = m.contentChildren(l1)[3];
    m.setCursor(m.flatChildren(1).indexOf(lastM1), 1);
    window.__tupletBarlineResult = m.createTupletAtCursor({
      num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0,
    });
  ` },
  /* Cursor MID-measure in a full bar: the span fits between cursor and bar
     line but not past the post-cursor content → reject, never overfill. */
  tupletMidFullMeasureRejected: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    const lm = m.layerInMeasure(m.allMeasures()[0], 1);
    m.setCursor(m.flatChildren(1).indexOf(m.contentChildren(lm)[0]), 1);
    window.__tupletBarlineResult = m.createTupletAtCursor({
      num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0,
    });
  ` },
  /* End of a PARTIAL measure (3 quarters in 4/4) with a half-note-span
     triplet → rejected for lack of space; must NOT spill into M2. */
  tupletPartialMeasureNoSpill: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    window.__tupletBarlineResult = m.createTupletAtCursor({
      num: 3, numbase: 2, atomicDur: '4', spanDur: '2', spanDots: 0,
    });
  ` },
  /* M1 full AND M2 full → the re-read target has no room either → reject,
     leaving no stray appended measure. */
  tupletBarlineBothMeasuresFull: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 8; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    const lf = m.layerInMeasure(m.allMeasures()[0], 1);
    m.setCursor(m.flatChildren(1).indexOf(m.contentChildren(lf)[3]), 1);
    window.__tupletBarlineResult = m.createTupletAtCursor({
      num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0,
    });
  ` },
  /* The workflow this enables: five filled quarter-triplets entered back to
     back. Four fill M1; the fifth opens M2 with no cursor intervention. */
  tupletSequentialAcrossBarline: { setup: `
    m.setCursor(0, 1);
    window.__tupletSeqLog = [];
    for (let i = 0; i < 5; i++) {
      const r = m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
      window.__tupletSeqLog.push(r.ok ? 'ok' : 'REJECT:' + r.reason);
      if (!r.ok) break;
      for (let k = 0; k < 3; k++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
    }
  ` },
  /* Triplet of wholes (= 3 wholes scaled by 2/3 = 2 wholes span = 128
   * ticks) doesn't fit in 4/4 (16 ticks) → must be rejected. */
  m1TupletExceedsMeasure: { setup: `
    m.setCursor(0, 1);
    window.__tupletOverflowResult = m.createTupletAtCursor({
      num: 3, numbase: 2, atomicDur: '1', spanDur: '1', spanDots: 0,
    });
  ` },
  /* ── Tuplet modal (Ctrl+Shift+3, 2026-10-05) ──────────────────────────────
     A tuplet of ANY count: the modal takes the count, the span in EIGHTH
     NOTES and a written value (every ratio the span admits, the conventional
     one pre-selected). Driven through the dialog like the pickup fixtures so
     the key match (Shift+3 = '#'), the field names, the ratio derivation and
     the model call are all in the path. The Ctrl+N table stops at 7. */

  /* Count 9 over a quarter (2 eighths) → 9:8 in 32nds: nine 32nd placeholders,
     cursor on the fill anchor. The span field is seeded from the entry
     duration (quarter → 2). */
  tupletModal_nonuplet: {
    setup: `
      m.setCursor(0, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      window.__tupletModalSeed = dlg.querySelector('[data-field="eighths"]').value;
      const set = (n, v) => { const el = dlg.querySelector('[data-field="' + n + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('count', '9'); set('eighths', '2');
      window.__tupletModalOptions = [...dlg.querySelectorAll('[data-field="written"] option')].map((o) => o.value + '|' + o.textContent);
      window.__tupletModalPicked = dlg.querySelector('[data-field="written"]').value;
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
    visualBaseline: 'tuplet_modal_nonuplet',
  },
  /* Count 5 over a dotted quarter (3 eighths): the ladder is 3, 6, 12, 24 and
     the nearest rung to 5 is 6 → 5:6 in 16ths (the compound-time quintuplet). */
  tupletModal_dottedSpanDefault: {
    setup: `
      m.setCursor(0, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      const set = (n, v) => { const el = dlg.querySelector('[data-field="' + n + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('count', '5'); set('eighths', '3');
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
  },
  /* Count 3 over 2 eighths through the modal = Ctrl+3 then 5: 3:2 in eighths. */
  tupletModal_matchesCtrlDigit: {
    setup: `
      m.setCursor(0, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      const set = (n, v) => { const el = dlg.querySelector('[data-field="' + n + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('count', '3'); set('eighths', '2');
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
  },
  /* The written-value select overrides the default: count 7 over a quarter
     defaults to 7:8 (32nds, the Ctrl+7 ratio); picking 16ths gives 7:4. */
  tupletModal_writtenOverride: {
    setup: `
      m.setCursor(0, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      const set = (n, v) => { const el = dlg.querySelector('[data-field="' + n + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('count', '7'); set('eighths', '2');
      window.__tupletModalDefault = dlg.querySelector('[data-field="written"]').value;
      set('written', '16');
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
  },
  /* 4 notes over 2 eighths are four 16ths — not a tuplet. The select says so
     and OK is refused; the document is untouched. */
  tupletModal_fitsExactlyRefused: {
    setup: `
      m.setCursor(0, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      const set = (n, v) => { const el = dlg.querySelector('[data-field="' + n + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('count', '4'); set('eighths', '2');
      window.__tupletModalOptions = [...dlg.querySelectorAll('[data-field="written"] option')].map((o) => o.value + '|' + o.textContent);
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
  },
  /* Mid-bar in a FULL 4/4 bar there is no room for any tuplet: the modal does
     not open at all (status error instead) and nothing changes. */
  tupletModal_noRoomRefused: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      m.setCursor(2, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true, bubbles: true }));
      window.__tupletModalOpened = document.getElementById('textEntryDialog').open;
      r();
    `,
  },
  /* A modal-created tuplet is one history entry: Ctrl+Z removes it whole. */
  undo_tupletModal: {
    setup: `
      m.setCursor(0, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      const set = (n, v) => { const el = dlg.querySelector('[data-field="' + n + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('count', '9'); set('eighths', '2');
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
    setupKeys: [{ key: 'z', ctrl: true }],
  },
};

export const ASSERTIONS = {
  /* ── Tuplet modal (Ctrl+Shift+3) ─────────────────────────────────────── */
  tupletModal_nonuplet: [
    { name: 'the span field is seeded from the entry duration (quarter → 2 eighths)',
      expr: `(() => {
        const seed = window.__tupletModalSeed;
        return seed === '2' ? { ok: true } : { ok: false, detail: 'seed=' + JSON.stringify(seed) + ' (expected "2")' };
      })()` },
    { name: 'the written-value list is the quarter ladder with 9:8 pre-selected',
      expr: `(() => {
        const opts = window.__tupletModalOptions || [];
        /* Longest written value first: a 16-tick quarter admits quarter (1), eighth (2),
           16th (4), 32nd (8) and 64th (16). */
        const want = ['4|9:1 — quarter notes', '8|9:2 — eighth notes', '16|9:4 — 16th notes', '32|9:8 — 32nd notes', '64|9:16 — 64th notes'];
        if (JSON.stringify(opts) !== JSON.stringify(want)) return { ok: false, detail: 'options=' + JSON.stringify(opts) };
        if (window.__tupletModalPicked !== '32') return { ok: false, detail: 'picked=' + window.__tupletModalPicked + ' (expected 32 → 9:8 in 32nds)' };
        return { ok: true };
      })()` },
    { name: 'a 9:8 tuplet of nine 32nd placeholders is created and the cursor sits on its fill anchor',
      expr: tupletShapeExpr(9, 8, '32') },
  ],
  tupletModal_dottedSpanDefault: [
    { name: 'count 5 over 3 eighths defaults to 5:6 in 16ths',
      expr: tupletShapeExpr(5, 6, '16') },
  ],
  tupletModal_matchesCtrlDigit: [
    { name: 'count 3 over 2 eighths is the Ctrl+3,5 triplet: 3:2 in eighths',
      expr: tupletShapeExpr(3, 2, '8') },
  ],
  tupletModal_writtenOverride: [
    { name: 'count 7 over a quarter defaults to 32nds (7:8), and picking 16ths yields 7:4',
      expr: `(() => {
        if (window.__tupletModalDefault !== '32') return { ok: false, detail: 'default=' + window.__tupletModalDefault + ' (expected 32)' };
        return (${tupletShapeExpr(7, 4, '16')});
      })()` },
  ],
  tupletModal_fitsExactlyRefused: [
    { name: '4 over 2 eighths is refused: the list says so and no tuplet is created',
      expr: `(() => {
        const opts = window.__tupletModalOptions || [];
        if (opts.length !== 1 || !/no tuplet needed/.test(opts[0])) return { ok: false, detail: 'options=' + JSON.stringify(opts) };
        const doc = window.__hkl_composer.model.getDoc();
        const n = doc.querySelectorAll('tuplet').length;
        if (n !== 0) return { ok: false, detail: 'tuplets=' + n + ' (expected 0)' };
        if (document.getElementById('textEntryDialog').open) return { ok: false, detail: 'dialog still open' };
        return { ok: true };
      })()` },
  ],
  tupletModal_noRoomRefused: [
    { name: 'no free ticks at the cursor → the modal never opens and the bar is untouched',
      expr: `(() => {
        if (window.__tupletModalOpened !== false) return { ok: false, detail: 'dialog open=' + window.__tupletModalOpened };
        const m = window.__hkl_composer.model;
        const doc = m.getDoc();
        if (doc.querySelectorAll('tuplet').length !== 0) return { ok: false, detail: 'a tuplet was created' };
        if (doc.querySelectorAll('note').length !== 4) return { ok: false, detail: 'notes=' + doc.querySelectorAll('note').length };
        return { ok: true };
      })()` },
  ],
  undo_tupletModal: [
    { name: 'Ctrl+Z after the modal removes the tuplet in one step',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const n = doc.querySelectorAll('tuplet').length;
        return n === 0 ? { ok: true } : { ok: false, detail: 'tuplets=' + n + ' after undo (expected 0)' };
      })()` },
  ],
  /* Tuplets. */
  m1Triplet8Empty: [
    { name: 'tuplet exists with num=3 numbase=2',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getDoc().querySelector('tuplet');
        if (!t) return { ok: false, detail: 'no tuplet found' };
        const num = t.getAttribute('num');
        const numbase = t.getAttribute('numbase');
        return num === '3' && numbase === '2'
          ? { ok: true }
          : { ok: false, detail: 'num=' + num + ' numbase=' + numbase };
      })()` },
    { name: 'tuplet bracket rendered',
      expr: `(() => {
        const t = window.__hkl_composer.model.getDoc().querySelector('tuplet');
        return window.__test.assertBracketRendered(t.getAttribute('xml:id'));
      })()` },
    { name: 'tuplet placeholders are CSS-hidden',
      expr: `window.__test.assertTupletPlaceholdersHidden()` },
  ],
  m1Triplet8FilledThenDelete: [
    { name: 'regen yields atomic 8th-rest placeholder',
      expr: `(() => {
        const t = window.__hkl_composer.model.getDoc().querySelector('tuplet');
        if (!t) return { ok: false, detail: 'no tuplet' };
        const phs = t.querySelectorAll('rest[data-tuplet-placeholder="true"]');
        const fails = [];
        for (const ph of phs) {
          if (ph.getAttribute('dur') !== '8') {
            fails.push('placeholder dur=' + ph.getAttribute('dur') + ' (expected 8)');
          }
        }
        return fails.length ? { ok: false, detail: fails.join('; ') } : { ok: true };
      })()` },
  ],
  /* Tuplet rejection cases. */
  m1TripletInsideTriplet: [
    { name: 'nested-tuplet creation rejected',
      expr: `(() => {
        const r = window.__tupletNestResult;
        return r && r.ok === false
          ? { ok: true }
          : { ok: false, detail: 'expected rejected, got ' + JSON.stringify(r) };
      })()` },
    { name: 'only one tuplet exists in doc',
      expr: `(() => {
        const ts = window.__hkl_composer.model.getDoc().querySelectorAll('tuplet');
        return ts.length === 1
          ? { ok: true }
          : { ok: false, detail: ts.length + ' tuplets (expected 1)' };
      })()` },
  ],
  /* Atomic tuplet placement at the bar line. Shared shape helper: report the
     per-measure layer contents so a failure names the actual layout. */
  tupletAtBarlineOpensNextMeasure: [
    { name: 'tuplet accepted at the end-of-full-measure stop',
      expr: `(() => {
        const r = window.__tupletBarlineResult;
        return r && r.ok === true
          ? { ok: true }
          : { ok: false, detail: 'expected accepted, got ' + JSON.stringify(r) };
      })()` },
    { name: 'M2 created and holds the tuplet; M1 untouched',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const shape = m.allMeasures().map(mm => {
          const L = m.layerInMeasure(mm, 1);
          return L ? m.contentChildren(L).map(c => c.localName).join(',') : 'nolayer';
        });
        const want = ['rest,rest,rest,rest', 'tuplet'];
        return JSON.stringify(shape) === JSON.stringify(want)
          ? { ok: true }
          : { ok: false, detail: 'shape=' + JSON.stringify(shape) + ' want=' + JSON.stringify(want) };
      })()` },
    { name: 'cursor seated on the entered-tuplet stop',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getDoc().querySelector('tuplet');
        const flat = m.flatChildren(1);
        const want = flat.findIndex(e => e === t);
        const got = m.getCursor(1);
        return got === want
          ? { ok: true }
          : { ok: false, detail: 'cursor=' + got + ' expected ' + want + ' (tuplet wrapper stop)' };
      })()` },
  ],
  tupletAtBarlineBeforeExistingContent: [
    { name: 'tuplet accepted at the merged bar-line stop',
      expr: `(() => {
        const r = window.__tupletBarlineResult;
        return r && r.ok === true
          ? { ok: true }
          : { ok: false, detail: 'expected accepted, got ' + JSON.stringify(r) };
      })()` },
    { name: 'tuplet is FIRST in M2, existing note pushed right',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const shape = m.allMeasures().map(mm => {
          const L = m.layerInMeasure(mm, 1);
          return L ? m.contentChildren(L).map(c => c.localName).join(',') : 'nolayer';
        });
        const want = ['rest,rest,rest,rest', 'tuplet,note'];
        return JSON.stringify(shape) === JSON.stringify(want)
          ? { ok: true }
          : { ok: false, detail: 'shape=' + JSON.stringify(shape) + ' want=' + JSON.stringify(want) };
      })()` },
  ],
  tupletMidFullMeasureRejected: [
    { name: 'mid-measure tuplet in a full bar is rejected',
      expr: `(() => {
        const r = window.__tupletBarlineResult;
        return r && r.ok === false
          ? { ok: true }
          : { ok: false, detail: 'expected rejected, got ' + JSON.stringify(r) };
      })()` },
    { name: 'bar not overfilled (still 4 rests, no tuplet anywhere)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const L = m.layerInMeasure(m.allMeasures()[0], 1);
        const kids = m.contentChildren(L).map(c => c.localName).join(',');
        const tups = m.getDoc().querySelectorAll('tuplet').length;
        return kids === 'rest,rest,rest,rest' && tups === 0
          ? { ok: true }
          : { ok: false, detail: 'M1=' + kids + ' tuplets=' + tups };
      })()` },
  ],
  tupletPartialMeasureNoSpill: [
    { name: 'oversized tuplet at end of a PARTIAL measure is rejected',
      expr: `(() => {
        const r = window.__tupletBarlineResult;
        return r && r.ok === false
          ? { ok: true }
          : { ok: false, detail: 'expected rejected, got ' + JSON.stringify(r) };
      })()` },
    { name: 'no spill: still one measure, no tuplet',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const n = m.allMeasures().length;
        const tups = m.getDoc().querySelectorAll('tuplet').length;
        return n === 1 && tups === 0
          ? { ok: true }
          : { ok: false, detail: 'measures=' + n + ' tuplets=' + tups + ' (expected 1 / 0)' };
      })()` },
  ],
  tupletBarlineBothMeasuresFull: [
    { name: 'rejected when the next measure is also full',
      expr: `(() => {
        const r = window.__tupletBarlineResult;
        return r && r.ok === false
          ? { ok: true }
          : { ok: false, detail: 'expected rejected, got ' + JSON.stringify(r) };
      })()` },
    { name: 'no stray measure appended by the rejected spill',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const n = m.allMeasures().length;
        const tups = m.getDoc().querySelectorAll('tuplet').length;
        return n === 2 && tups === 0
          ? { ok: true }
          : { ok: false, detail: 'measures=' + n + ' tuplets=' + tups + ' (expected 2 / 0)' };
      })()` },
  ],
  tupletSequentialAcrossBarline: [
    { name: 'all five tuplets accepted in sequence',
      expr: `(() => {
        const log = window.__tupletSeqLog || [];
        return log.length === 5 && log.every(x => x === 'ok')
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(log) };
      })()` },
    { name: 'four filled triplets in M1, the fifth in M2',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const shape = m.allMeasures().map(mm => {
          const L = m.layerInMeasure(mm, 1);
          return L ? m.contentChildren(L).map(c => c.localName).join(',') : 'nolayer';
        });
        const want = ['tuplet,tuplet,tuplet,tuplet', 'tuplet'];
        if (JSON.stringify(shape) !== JSON.stringify(want))
          return { ok: false, detail: 'shape=' + JSON.stringify(shape) + ' want=' + JSON.stringify(want) };
        const tups = [...m.getDoc().querySelectorAll('tuplet')];
        const bad = tups.filter(t => t.querySelectorAll('note').length !== 3);
        return bad.length === 0
          ? { ok: true }
          : { ok: false, detail: bad.length + ' tuplet(s) not filled with 3 notes' };
      })()` },
  ],
  m1TupletExceedsMeasure: [
    { name: 'oversized tuplet creation rejected',
      expr: `(() => {
        const r = window.__tupletOverflowResult;
        return r && r.ok === false
          ? { ok: true }
          : { ok: false, detail: 'expected rejected, got ' + JSON.stringify(r) };
      })()` },
    { name: 'no tuplet exists in doc',
      expr: `(() => {
        const ts = window.__hkl_composer.model.getDoc().querySelectorAll('tuplet');
        return ts.length === 0
          ? { ok: true }
          : { ok: false, detail: ts.length + ' tuplets (expected 0)' };
      })()` },
  ],
  m1Triplet8BeamedNumberOnly: [
    { name: 'a beamed triplet renders its number and no bracket; the model forces neither',
      expr: `(() => {
        const t = document.querySelector('#score g.tuplet');
        if (!t) return { ok: false, detail: 'no g.tuplet rendered' };
        const b = t.querySelectorAll('g.tupletBracket').length, n = t.querySelectorAll('g.tupletNum').length, beams = t.querySelectorAll('g.beam').length;
        const mt = window.__hkl_composer.model.getDoc().querySelector('tuplet');
        if (mt.hasAttribute('bracket.visible')) return { ok: false, detail: 'model tuplet carries bracket.visible=' + mt.getAttribute('bracket.visible') };
        return b === 0 && n === 1 && beams === 1 ? { ok: true } : { ok: false, detail: 'bracket=' + b + ' num=' + n + ' beams=' + beams };
      })()` },
  ],
  m1TripletQuarterBracket: [
    { name: 'an unbeamed triplet keeps its bracket and number',
      expr: `(() => {
        const t = document.querySelector('#score g.tuplet');
        if (!t) return { ok: false, detail: 'no g.tuplet rendered' };
        const b = t.querySelectorAll('g.tupletBracket').length, n = t.querySelectorAll('g.tupletNum').length;
        return b === 1 && n === 1 ? { ok: true } : { ok: false, detail: 'bracket=' + b + ' num=' + n };
      })()` },
  ],
};
