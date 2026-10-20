// Composer test fixtures — undo.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

import {
  FILL_M1_4Q_V1,
} from './_helpers.mjs';

export const FIXTURES = {

  /* ── Undo / redo ───────────────────────────────────────────────────────── */
  //
  // Each fixture drives the model through 1+ user actions, then issues Ctrl+Z
  // (or Ctrl+Y) and asserts that the resulting state matches expectations.
  // Setup keys dispatch through input.ts via CDP — so we exercise the exact
  // path a user takes.
  /* Insert a quarter rest, then Ctrl+Z. Doc should be empty (zero notes,
   * zero rests beyond placeholder fill). */
  undo_basic_insert: {
    setupKeys: ['5', { key: 'z', ctrl: true }],
  },
  /* Insert, undo, redo. Should match the post-insert state. */
  undo_redo_roundtrip: {
    setupKeys: [
      '5',
      { key: 'z', ctrl: true },
      { key: 'y', ctrl: true },
    ],
  },
  /* A10 — lazy AFTER snapshot: a keystroke edit's AFTER MEI is serialised on
   * idle or when history next needs it. Two inserts, two undos, one redo: the
   * second undo must materialise the first entry's AFTER (redo needs it) while
   * the document still IS that state; the redo must reproduce it exactly. */
  undo_lazy_snapshot: {
    setupKeys: [
      '5', '5',
      { key: 'z', ctrl: true },
      { key: 'z', ctrl: true },
      { key: 'y', ctrl: true },
    ],
  },
  /* Insert, undo, then a NEW insert. The redo stack must be cleared by the
   * new mutation — pressing Ctrl+Y should be a no-op. */
  undo_redo_invalidates: {
    setupKeys: [
      '5',                            /* quarter rest */
      { key: 'z', ctrl: true },       /* undo */
      '6',                            /* half rest — invalidates redo */
      { key: 'y', ctrl: true },       /* no-op */
    ],
  },
  /* Tuplet creation: Ctrl+3 then duration digit; one undo entry covers both. */
  undo_tuplet: {
    setupKeys: [
      { key: '3', ctrl: true },       /* begin triplet */
      '5',                            /* span = quarter → triplet created */
      { key: 'z', ctrl: true },       /* undo */
    ],
  },
  /* Dot cycle: insert rest, press '.', undo. The dot is reverted; the rest
   * stays. */
  undo_dot_cycle: {
    setupKeys: ['5', '.', { key: 'z', ctrl: true }],
  },
  /* Backspace deletion: insert two rests, backspace one, undo. After undo,
   * both rests are back. */
  undo_delete: {
    setupKeys: [
      '5', '5',
      'Backspace',
      { key: 'z', ctrl: true },
    ],
  },
  /* Cursor-position-match: insert, cursor stays at action-end. Undo should
   * restore cursor to BEFORE position. */
  undo_cursor_match: {
    setupKeys: ['5', { key: 'z', ctrl: true }],
  },
  /* Cursor-position-NOT-match: insert, navigate away, then undo. Cursor
   * should stay where the user moved it (and be clamped to valid range). */
  undo_cursor_moved_away: {
    setupKeys: [
      '5',                            /* insert quarter rest, cursor → 1 */
      '5',                            /* insert second quarter, cursor → 2 */
      'ArrowLeft',                    /* nav away — cursor now 1 */
      { key: 'z', ctrl: true },       /* undo the second insert */
    ],
  },
  /* Stack stress: insert 20 rests, undo 20 times, redo 20 times. */
  undo_stack_stress: {
    setup: `
      /* Pre-fill via the model API to keep setupKeys tractable. Skip undo
       * tracking for setup — it only kicks in for actual keypresses. */
      m.setVoice(1);
      m.setCursor(0, 1);
    `,
    setupKeys: [
      ...Array(20).fill('5'),
      ...Array(20).fill({ key: 'z', ctrl: true }),
      ...Array(20).fill({ key: 'y', ctrl: true }),
    ],
  },
  /* Ctrl+Shift+Z as redo alias (alongside Ctrl+Y). */
  undo_redo_shiftZ_alias: {
    setupKeys: [
      '5',
      { key: 'z', ctrl: true },
      { key: 'Z', ctrl: true, shift: true },
    ],
  },
  /* Multi-voice: insert in V2, switch to V1, undo. V2 content reverts; V1
   * stays at cursor 0. */
  undo_multi_voice: {
    setup: `
      m.setVoice(2);
      m.setCursor(0, 2);
    `,
    setupKeys: [
      '5',                            /* V2 quarter rest */
      'ArrowUp',                      /* V2 → V1 */
      { key: 'z', ctrl: true },       /* undo: V2 reverts */
    ],
  },
  /* Cut with source-selection re-entry on undo. After Ctrl+X the selection
   * is exited; after Ctrl+Z the source selection should be re-entered. */
  undo_cut_restores_source_sel: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },  /* enter beat-mode selection */
      { key: 'ArrowRight', shift: true },  /* grow to beats 0–1 */
      { key: 'x', ctrl: true },            /* cut */
      { key: 'z', ctrl: true },            /* undo cut */
    ],
  },
  /* Backspace-on-selection with source-selection re-entry on undo. Mirrors
   * undo_cut_restores_source_sel — confirms withHistory('delete-selection')
   * wires the sourceSelection through correctly. */
  undo_backspace_selection_restores: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      'Backspace',
      { key: 'z', ctrl: true },
    ],
  },
};

export const ASSERTIONS = {
  /* ── Undo / redo ──────────────────────────────────────────────────────── */
  undo_basic_insert: [
    { name: 'history popped to empty after undo',
      expr: `(() => {
        const h = window.__hkl_composer.history;
        return { ok: !h.canUndo(), detail: 'canUndo=' + h.canUndo() };
      })()` },
    { name: 'model has no real content after undo',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const real = m.getDoc().querySelectorAll('rest:not([data-placeholder=true]):not([data-tuplet-placeholder=true]), note, chord').length;
        return { ok: real === 0, detail: 'realContent=' + real };
      })()` },
  ],
  undo_redo_roundtrip: [
    { name: 'one entry on undo stack after redo',
      expr: `(() => {
        const h = window.__hkl_composer.history;
        return { ok: h.canUndo() && !h.canRedo(),
                 detail: 'canUndo=' + h.canUndo() + ' canRedo=' + h.canRedo() };
      })()` },
    { name: 'one rest in voice 1 after redo',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const real = m.getDoc().querySelectorAll('rest:not([data-placeholder=true]):not([data-tuplet-placeholder=true])').length;
        return { ok: real === 1, detail: 'realRests=' + real };
      })()` },
  ],
  undo_lazy_snapshot: [
    { name: 'undo×2 then redo leaves exactly one rest, with undo and redo both available',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const h = window.__hkl_composer.history;
        const real = m.getDoc().querySelectorAll('rest:not([data-placeholder=true]):not([data-tuplet-placeholder=true])').length;
        return { ok: real === 1 && h.canUndo() && h.canRedo(),
                 detail: 'realRests=' + real + ' canUndo=' + h.canUndo() + ' canRedo=' + h.canRedo() };
      })()` },
    { name: 'no lazy snapshot left unserialised after the history operations',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const pending = typeof m.hasPendingSnapshot === 'function' ? m.hasPendingSnapshot() : 'n/a';
        return { ok: pending === false, detail: 'pending=' + pending };
      })()` },
  ],
  undo_redo_invalidates: [
    { name: 'redo stack cleared by new mutation; final state = half rest',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const h = window.__hkl_composer.history;
        const flat = m.flatChildren(1);
        const realContent = flat.filter(e => e.localName === 'rest' || e.localName === 'note' || e.localName === 'chord');
        if (realContent.length !== 1) return { ok: false, detail: 'content=' + realContent.length };
        const dur = realContent[0].getAttribute('dur');
        return { ok: dur === '2' && !h.canRedo(), detail: 'dur=' + dur + ' canRedo=' + h.canRedo() };
      })()` },
  ],
  undo_tuplet: [
    { name: 'no <tuplet> element after undo',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getDoc().querySelectorAll('tuplet');
        return { ok: t.length === 0, detail: 'tupletCount=' + t.length };
      })()` },
  ],
  undo_dot_cycle: [
    { name: 'rest preserved, dots reverted to 0',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const flat = m.flatChildren(1);
        const rests = flat.filter(e => e.localName === 'rest' && e.getAttribute('data-placeholder') !== 'true' && e.getAttribute('data-tuplet-placeholder') !== 'true');
        if (rests.length !== 1) return { ok: false, detail: 'restCount=' + rests.length };
        const dots = rests[0].getAttribute('dots') ?? '0';
        return { ok: dots === '0' || dots === '', detail: 'dots=' + dots };
      })()` },
  ],
  undo_delete: [
    { name: 'two rests back after undo',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const flat = m.flatChildren(1);
        const rests = flat.filter(e => e.localName === 'rest' && e.getAttribute('data-placeholder') !== 'true' && e.getAttribute('data-tuplet-placeholder') !== 'true');
        return { ok: rests.length === 2, detail: 'restCount=' + rests.length };
      })()` },
  ],
  undo_cursor_match: [
    { name: 'cursor restored to before-position (0)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        return { ok: m.getCursor(1) === 0, detail: 'cursor=' + m.getCursor(1) };
      })()` },
  ],
  undo_cursor_moved_away: [
    { name: 'cursor stays where user moved it (clamped)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        /* Before undo: inserted 2 rests (cursor at 2), then ArrowLeft → cursor at 1.
         * Undo removes the second insert; cursor was at 1, MEI is restored, cursor
         * stays at 1 (still valid in restored MEI). */
        return { ok: m.getCursor(1) === 1, detail: 'cursor=' + m.getCursor(1) };
      })()` },
  ],
  undo_stack_stress: [
    { name: 'after 20 redos, voice has 20 rests + (no stack drift)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const h = window.__hkl_composer.history;
        const flat = m.flatChildren(1);
        const rests = flat.filter(e => e.localName === 'rest' && e.getAttribute('data-placeholder') !== 'true' && e.getAttribute('data-tuplet-placeholder') !== 'true');
        return { ok: rests.length === 20 && !h.canRedo(),
                 detail: 'restCount=' + rests.length + ' canRedo=' + h.canRedo() };
      })()` },
  ],
  undo_redo_shiftZ_alias: [
    { name: 'Ctrl+Shift+Z redoes (one rest in voice 1)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const real = m.getDoc().querySelectorAll('rest:not([data-placeholder=true]):not([data-tuplet-placeholder=true])').length;
        return { ok: real === 1, detail: 'realRests=' + real };
      })()` },
  ],
  undo_multi_voice: [
    { name: 'V2 has no real content; focus stays in V1',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        /* Count <rest> elements inside V2 layers (layer @n="2"), excluding placeholders. */
        const doc = m.getDoc();
        let v2Real = 0;
        for (const layer of doc.querySelectorAll('layer[n="2"]')) {
          for (const c of layer.children) {
            if (c.localName === 'rest' && c.getAttribute('data-placeholder') !== 'true' && c.getAttribute('data-tuplet-placeholder') !== 'true') v2Real++;
            else if (c.localName === 'note' || c.localName === 'chord') v2Real++;
          }
        }
        return { ok: v2Real === 0 && m.getCurrentVoice() === 1,
                 detail: 'V2.real=' + v2Real + ' voice=' + m.getCurrentVoice() };
      })()` },
  ],
  undo_cut_restores_source_sel: [
    { name: 'cut content restored and source beat-selection re-entered',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const inp = window.__hkl_composer.inputState();
        /* Four quarter rests should be back in V1. */
        const flat = m.flatChildren(1);
        const realRests = flat.filter(e => e.localName === 'rest' && e.getAttribute('data-placeholder') !== 'true' && e.getAttribute('data-tuplet-placeholder') !== 'true');
        if (realRests.length !== 4) return { ok: false, detail: 'restCount=' + realRests.length };
        if (inp.cursorMode !== 'select') return { ok: false, detail: 'cursorMode=' + inp.cursorMode };
        if (!inp.selection || inp.selection.kind !== 'beat') return { ok: false, detail: 'sel=' + JSON.stringify(inp.selection) };
        return { ok: inp.selection.first === 0 && inp.selection.last === 1,
                 detail: 'sel=' + inp.selection.first + '..' + inp.selection.last };
      })()` },
  ],
  undo_backspace_selection_restores: [
    { name: 'deleted content restored and source beat-selection re-entered',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const inp = window.__hkl_composer.inputState();
        const flat = m.flatChildren(1);
        const realRests = flat.filter(e => e.localName === 'rest' && e.getAttribute('data-placeholder') !== 'true' && e.getAttribute('data-tuplet-placeholder') !== 'true');
        if (realRests.length !== 4) return { ok: false, detail: 'restCount=' + realRests.length };
        if (inp.cursorMode !== 'select') return { ok: false, detail: 'cursorMode=' + inp.cursorMode };
        if (!inp.selection || inp.selection.kind !== 'beat') return { ok: false, detail: 'sel=' + JSON.stringify(inp.selection) };
        return { ok: inp.selection.first === 0 && inp.selection.last === 1,
                 detail: 'sel=' + inp.selection.first + '..' + inp.selection.last };
      })()` },
  ],
};
