// Composer test fixtures — keyboard.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

import {
  LC_LIB,
  lcAssert,
} from './_helpers.mjs';

export const FIXTURES = {

  /* ── Real-keystroke (INPUT-layer) fixtures ───────────────────────── */
  /* Type '5' four times (= 4 quarter rests, fills 4/4). Verifies the
   * digit→duration mapping end-to-end without auto-overflow splitting.
   * '5' → dur='4' per DIGIT_TO_DUR (Finale order). */
  kbd_durationDigits: {
    setupKeys: ['5', '5', '5', '5'],
  },
  /* Type '5' (quarter rest, per DIGIT_TO_DUR), then '.' to add a dot. */
  kbd_dotCycle: {
    setupKeys: ['5', '.'],
  },
  /* Type Ctrl+Right, Ctrl+Left to exercise bar-jump nav. Need at least
   * two measures with content first. Lands AT the barline (= the cursor
   * with tstamp exactly equal to a multiple of measureTicks), matching
   * how Ctrl+Shift+Arrow extends selection. */
  kbd_ctrlNavBarJump: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(m.getVoiceLength(1), 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);  /* Park cursor in middle of M_1. */
    `,
    setupKeys: [{ key: 'ArrowRight', ctrl: true }],
  },
  /* Ctrl+Right from mid-M_1 lands AT the barline between M_1 and M_2,
   * NOT one slot past it (the old "first stop after the boundary" bug). */
  kbd_ctrlRight_landsAtBarline_notPastFirstNote: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(m.getVoiceLength(1), 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);  /* Mid-M_1. */
    `,
    setupKeys: [{ key: 'ArrowRight', ctrl: true }],
  },
  /* Two Ctrl+Lefts from mid-M_2: first press → start of M_2; second
   * press → start of M_1. Staircase behavior matches selection-mode. */
  kbd_ctrlLeft_staircase_currentThenPrev: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(6, 1);  /* Mid-M_2. */
    `,
    setupKeys: [
      { key: 'ArrowLeft', ctrl: true },
      { key: 'ArrowLeft', ctrl: true },
    ],
  },
  /* Empty-measure pass-through: M_1 has a whole rest, M_2 is empty, M_3
   * has a whole rest. Two Ctrl+Rights from start should land on M_2's
   * barline cursor (start of empty M_2), then M_3's barline cursor. */
  kbd_ctrlRight_emptyNextMeasure: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '1', dots: 0 });
      m.appendMeasure();  /* M_2 stays empty. */
      m.appendMeasure();  /* M_3 will receive content. */
      m.setCursor(m.getVoiceLength(1), 1);
      m.insertRestAtCursor({ duration: '1', dots: 0 });
      m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowRight', ctrl: true },
      { key: 'ArrowRight', ctrl: true },
    ],
  },
  /* Voice cycle: Up arrow 5 times → 1→2→expr→3→4→1. */
  kbd_voiceCycle: {
    setupKeys: ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp'],
  },
  /* Empty document has no expressions anywhere → ArrowDown ×2 from V_1
   * should skip the expression layer and land at V_3 in voice mode. */
  kbd_voiceCycle_skipsExprWhenMeasureEmpty: {
    setupKeys: ['ArrowDown', 'ArrowDown'],
  },
  /* Insert a quarter rest in V_1 M_1 (gives the cursor a moment anchor),
   * then Shift+5 commits an "mf" dynamic at that moment. ArrowDown ×2
   * from V_1 should now enter expression mode since M_1 has an expression. */
  kbd_voiceCycle_entersExprWhenMeasureHasDynamic: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [
      { key: '%', shift: true },   /* Shift+5 → "mf" */
      'ArrowDown',                 /* V_1 → V_2 */
      'ArrowDown',                 /* V_2 → expr (not skipped) */
    ],
  },
  /* Insert key toggles mode. After one toggle, mode='overwrite'. */
  kbd_modeToggle: {
    setupKeys: ['Insert'],
  },
  /* Escape clears any pending hairpin/tuplet. Press '<' (start cres),
   * then Escape — model should have no pending hairpin. */
  kbd_escClearsPending: {
    setupKeys: [{ key: '<', shift: true }, 'Escape'],
  },
  /* Pending hairpin cancels on any non-nav input and falls through to its
   * normal handling. Press '<' (sets pendingHairpin), then '5' (quarter
   * rest digit) — pending should be cleared AND the quarter rest inserted. */
  kbd_pendingHairpin_cancelOnDigit: {
    setupKeys: [{ key: '<', shift: true }, '5'],
  },
  /* Plain cursor navigation (ArrowLeft/Right/Home/End, no modifiers)
   * preserves the pending so the user can navigate to the endpoint. */
  kbd_pendingHairpin_preservedOnArrowRight: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(0, 1);
    `,
    setupKeys: [{ key: '<', shift: true }, 'ArrowRight'],
  },
  /* Voice cycling (ArrowDown/Up) cancels the pending — same shape as
   * slurs dropping on voice change. */
  kbd_pendingHairpin_cancelOnVoiceCycle: {
    setupKeys: [{ key: '<', shift: true }, 'ArrowDown'],
  },
  /* Statusline kinds + clear-on-next-action. Press '=' (tie toggle) on
     an empty measure where there's no note → error message in red. The
     follow-up assertion (kbd_statusError_clearsOnNextKey) types ArrowRight
     after the error and checks the red went away. */
  kbd_statusError_onTieNoNote: {
    setupKeys: [{ key: '=' }],
  },
  kbd_statusError_clearsOnNextKey: {
    setupKeys: [{ key: '=' }, { key: 'ArrowRight' }],
  },
  /* Cancelling a pending gesture does NOT change the model, so it is an info
     cue (gray), not a purple action. Press '<' (start cres → state/blue), then
     Escape (cancel → info "Pending hairpin cancelled."). */
  kbd_statusInfo_pendingHairpinCancel: {
    setupKeys: [{ key: '<', shift: true }, 'Escape'],
  },
  /* Purple ('action') is reserved for real undoable edits. Ctrl+M inserts a
     measure (pushed onto undo history) → purple "Inserted measure m…". */
  kbd_statusAction_insertMeasure: {
    setupKeys: [{ key: 'm' }],
  },
  /* …and that purple post-action clears on the next keystroke. */
  kbd_statusAction_clearsOnNextKey: {
    setupKeys: [{ key: 'm' }, 'ArrowRight'],
  },
  /* Switching voice emits NO status message — the top-bar voice indicator
     already shows the voice. ArrowDown cycles V1→V2; status stays Ready. */
  kbd_statusVoiceSwitch_noMessage: {
    setup: `
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setVoice(2); m.setCursor(0, 2);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
    `,
    setupKeys: ['ArrowDown'],
  },
  /* ── Expr-layer nav + modal ergonomics ────────────────────────── */

  /* 1a: arrowing INTO the expression layer snaps to the nearest existing mark,
     not moment 0. Four quarter notes (onsets at beats 1-4); a single dynam at
     beat 4 (committed via Shift+5 with the cursor anchored there). ArrowDown ×2
     (V1→V2→expr) must land the expr cursor ON the beat-4 dynam, not beat 1. */
  kbd_enterExpr_snapsToNearestMark: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(4, 1);  /* anchor flat[3] = beat 4 */
    `,
    setupKeys: [
      { key: '%', shift: true },   /* Shift+5 → "mf" dynam at beat 4 */
      'ArrowDown',                 /* V1 → V2 */
      'ArrowDown',                 /* V2 → expr (snaps to nearest mark) */
    ],
  },
  /* 1b: Ctrl+→ in the expression layer jumps mark-to-mark, skipping bare note
     onsets. Two dynams at beats 2 and 4; enter expr, Home to beat-1 onset,
     Ctrl+→ should skip the beat-1/beat-3 onsets and land on the beat-2 dynam. */
  kbd_ctrlRight_jumpsToNextMark: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(4, 1);  /* anchor flat[3] = beat 4 */
    `,
    setupKeys: [
      { key: '%', shift: true },   /* dynam at beat 4 */
      'ArrowLeft', 'ArrowLeft',    /* cursor 4 → 2 (anchor flat[1] = beat 2) */
      { key: '%', shift: true },   /* dynam at beat 2 */
      'ArrowDown', 'ArrowDown',    /* V1 → V2 → expr */
      'Home',                      /* → beat-1 onset moment */
      { key: 'ArrowRight', ctrl: true },  /* skip beat-1 onset → beat-2 dynam */
    ],
  },
  /* 1b (cont.): two Ctrl+→ from the beat-1 onset reach the LAST mark (beat 4);
     a third Ctrl+→ is a no-op (no later mark). */
  kbd_ctrlRight_stopsAtLastMark: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(4, 1);
    `,
    setupKeys: [
      { key: '%', shift: true },
      'ArrowLeft', 'ArrowLeft',
      { key: '%', shift: true },
      'ArrowDown', 'ArrowDown',
      'Home',
      { key: 'ArrowRight', ctrl: true },  /* → beat 2 */
      { key: 'ArrowRight', ctrl: true },  /* → beat 4 */
      { key: 'ArrowRight', ctrl: true },  /* no-op (stays beat 4) */
    ],
  },
  /* 1b (cont.): Ctrl+→ visits a hairpin's END — it is its own stop, selecting
     the hairpin with the bar at the wedge's right edge (2026-09-30; it used to
     be skipped when a stop was a moment and the end selected nothing the start
     didn't). A hairpin beat1→beat3 + a dynam at beat4: from the hairpin start,
     Ctrl+→ lands on the beat-3 hairpin end. */
  kbd_ctrlRight_visitsHairpinEnd: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      const doc = m.getDoc(); const MEI = 'http://www.music-encoding.org/ns/mei'; const meas = doc.querySelectorAll('measure')[0];
      const hp = doc.createElementNS(MEI, 'hairpin'); hp.setAttribute('xml:id', 'h-skip'); hp.setAttribute('tstamp', '1'); hp.setAttribute('tstamp2', '0m+3'); hp.setAttribute('form', 'cres'); hp.setAttribute('place', 'between'); hp.setAttribute('staff', '1'); meas.appendChild(hp);
      const d = doc.createElementNS(MEI, 'dynam'); d.setAttribute('xml:id', 'd-skip'); d.setAttribute('tstamp', '4'); d.setAttribute('place', 'between'); d.setAttribute('staff', '1'); d.textContent = 'f'; meas.appendChild(d);
      m.setVoice(1); m.setCursor(1, 1);
    `,
    setupKeys: [
      'ArrowDown', 'ArrowDown',           /* V1 → expr (snaps to beat-1 hairpin start) */
      { key: 'ArrowRight', ctrl: true },  /* skip beat-3 hairpin END → beat-4 dynam */
    ],
  },
  /* Enter while the CANCEL button is focused must NOT commit (it should dismiss
     in a real browser). Open the clef modal, set the select to Alto, focus
     Cancel, press Enter — no clef may be written. (Synthetic keydown doesn't
     fire the native button click, so we just assert "no commit" and close.) */
  kbd_modalEnterOnCancelDoesNotCommit: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="clef"]').value = 'C|3||';
      const cancel = dlg.querySelector('.te-cancel');
      cancel.focus();
      cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      dlg.close();  /* clean up (native click that would close doesn't fire under synthetic dispatch) */
    `,
  },
  /* 1c: pressing Enter while a <select> inside a modal has focus finalizes the
     form (the browser would otherwise just close the dropdown). Open the clef
     modal, focus its select set to Alto (C/3), dispatch Enter on the select —
     the modal must close AND the C/3 clef must be written. */
  kbd_modalEnterOnSelectSubmits: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      const sel = dlg.querySelector('[data-field="clef"]');
      sel.value = 'C|3||';
      sel.focus();
      sel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    `,
  },

  /* ── Help modal (keybinding reference) ───────────────────────────────── */
  /* Clicking Help opens the modal; body contains rendered binding rows. */
  help_button_opens_modal: {
    setup: `document.getElementById('btnHelp').click();`,
  },
  /* Escape closes the open modal (native <dialog> behavior). */
  help_modal_esc_closes: {
    setup: `document.getElementById('btnHelp').click();`,
    setupKeys: ['Escape'],
  },
  /* The catalog (keybindings.ts) is documentation, not dispatch, and it drifted:
     Ctrl+L, Alt+H and Shift+Space were dispatched but unlisted, and the layer
     Delete entries described a moment-wide delete the code no longer does
     (2026-10-19 audit of the catalog against input.ts). */
  help_catalog_matches_dispatcher: {
    setup: `document.getElementById('btnHelp').click();`,
  },

  /* (no visual baseline: visualCheck's bbox is scoped to #score content,
   * which doesn't cover the <dialog> overlay; a visual regression for the
   * help modal would need a separate viewport-clip path in visual.mjs.) */
};

export const ASSERTIONS = {
  /* Keystroke-driven (INPUT-layer) assertions. */
  kbd_durationDigits: [
    { name: '4 quarter rests after typing 5 5 5 5',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rests = Array.from(m.getDoc().querySelectorAll('rest'));
        const durs = rests.map((r) => r.getAttribute('dur'));
        const expected = ['4', '4', '4', '4'];
        return rests.length === 4 && expected.every((d, i) => durs[i] === d)
          ? { ok: true }
          : { ok: false, detail: 'durs=' + JSON.stringify(durs) };
      })()` },
  ],
  kbd_dotCycle: [
    { name: 'quarter rest with one dot exists',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const r = m.getDoc().querySelector('rest[dur="4"][dots="1"]');
        return r ? { ok: true } : { ok: false, detail: 'no quarter rest with dots=1' };
      })()` },
  ],
  kbd_ctrlNavBarJump: [
    { name: 'cursor landed at the M_1/M_2 barline (smallest boundary > 2)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const boundaries = m.measureBoundaryCursors(1);
        const target = boundaries.find(b => b > 2);
        return m.getCursor(1) === target
          ? { ok: true }
          : { ok: false, detail: 'cursor=' + m.getCursor(1) + ' expected=' + target + ' boundaries=' + JSON.stringify(boundaries) };
      })()` },
  ],
  kbd_ctrlRight_landsAtBarline_notPastFirstNote: [
    { name: 'cursor tstamp equals one full measure (= M_2 barline)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getTickPositionAt(1, m.getCursor(1));
        const measureT = m.measureTicks();
        return Math.abs(t - measureT) < 1e-6
          ? { ok: true }
          : { ok: false, detail: 'tstamp=' + t + ' measureTicks=' + measureT };
      })()` },
  ],
  kbd_ctrlLeft_staircase_currentThenPrev: [
    { name: 'cursor landed at start of M_1 after two Ctrl+Lefts',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getTickPositionAt(1, m.getCursor(1));
        return Math.abs(t - 0) < 1e-6
          ? { ok: true }
          : { ok: false, detail: 'tstamp=' + t + ' (expected 0 for start of M_1)' };
      })()` },
  ],
  kbd_ctrlRight_emptyNextMeasure: [
    { name: 'cursor advanced past empty M_2 to M_3 barline',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getTickPositionAt(1, m.getCursor(1));
        const measureT = m.measureTicks();
        return Math.abs(t - 2 * measureT) < 1e-6
          ? { ok: true }
          : { ok: false, detail: 'tstamp=' + t + ' expected=' + (2 * measureT) };
      })()` },
  ],
  kbd_voiceCycle: [
    { name: 'voice cycled back to 1 after 5 ArrowUps',
      expr: `(() => {
        /* 5 cycles through 1→2→expr→3→4→1; expr cycle may be a separate
         * cursorMode transition. Accept: ended at voice 1 OR cursorMode
         * changed to expr at one of the intermediate steps. */
        const m = window.__hkl_composer.model;
        const v = m.getCurrentVoice();
        const s = window.__hkl_composer.inputState();
        return v === 1
          ? { ok: true }
          : { ok: false, detail: 'voice=' + v + ' cursorMode=' + s.cursorMode };
      })()` },
  ],
  kbd_voiceCycle_skipsExprWhenMeasureEmpty: [
    { name: 'ArrowDown ×2 from V_1 lands on V_3 in voice mode (expr skipped)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const v = m.getCurrentVoice();
        const s = window.__hkl_composer.inputState();
        return v === 3 && s.cursorMode === 'voice'
          ? { ok: true }
          : { ok: false, detail: 'voice=' + v + ' cursorMode=' + s.cursorMode + ' (expected 3, voice)' };
      })()` },
  ],
  kbd_voiceCycle_entersExprWhenMeasureHasDynamic: [
    { name: 'M_1 contains a <dynam> after Shift+5',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const dyn = m.getDoc().querySelectorAll('dynam');
        return dyn.length === 1
          ? { ok: true }
          : { ok: false, detail: 'expected 1 dynam, got ' + dyn.length };
      })()` },
    { name: 'ArrowDown ×2 from V_1 enters expression mode (not skipped)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'expr'
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode + ' (expected expr)' };
      })()` },
  ],
  kbd_enterExpr_snapsToNearestMark: [
    { name: 'entering expr layer lands on the beat-4 dynam, not moment 0',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (s.cursorMode !== 'expr') return { ok: false, detail: 'cursorMode=' + s.cursorMode };
        const cur = s.exprCursor.stops[s.exprCursor.index]?.moment;
        return cur && cur.measureIdx === 0 && Math.abs(cur.tstamp - 4) < 1e-6
          ? { ok: true }
          : { ok: false, detail: 'moment=' + JSON.stringify(cur) };
      })()` },
  ],
  kbd_ctrlRight_jumpsToNextMark: [
    { name: 'Ctrl+Right from beat-1 onset jumps to the beat-2 dynam',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (s.cursorMode !== 'expr') return { ok: false, detail: 'cursorMode=' + s.cursorMode };
        const cur = s.exprCursor.stops[s.exprCursor.index]?.moment;
        return cur && cur.measureIdx === 0 && Math.abs(cur.tstamp - 2) < 1e-6
          ? { ok: true }
          : { ok: false, detail: 'moment=' + JSON.stringify(cur) };
      })()` },
  ],
  kbd_ctrlRight_stopsAtLastMark: [
    { name: 'Ctrl+Right ×3 stops at the last (beat-4) dynam',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (s.cursorMode !== 'expr') return { ok: false, detail: 'cursorMode=' + s.cursorMode };
        const cur = s.exprCursor.stops[s.exprCursor.index]?.moment;
        return cur && cur.measureIdx === 0 && Math.abs(cur.tstamp - 4) < 1e-6
          ? { ok: true }
          : { ok: false, detail: 'moment=' + JSON.stringify(cur) };
      })()` },
  ],
  kbd_ctrlRight_visitsHairpinEnd: [
    { name: 'Ctrl+Right from the hairpin start lands on its END (beat 3), bar flush right of the wedge',
      expr: lcAssert(`
        const s = H.inputState();
        if (s.cursorMode !== 'expr') return { ok: false, detail: 'cursorMode=' + s.cursorMode };
        const cur = curMoment('expr');
        if (!cur || cur.measureIdx !== 0 || Math.abs(cur.tstamp - 3) > 1e-6) return { ok: false, detail: 'moment=' + JSON.stringify(cur) + ' (expected beat 3)' };
        const b = bar('expr'), r = markRect('h-skip', 'end');
        return rightOf(b, r) ? { ok: true } : { ok: false, detail: 'bar ' + fmt(b) + ' vs wedge ' + fmt(r) };
      `) },
  ],
  kbd_modalEnterOnCancelDoesNotCommit: [
    { name: 'Enter while Cancel is focused commits nothing (no clef written)',
      expr: `(() => {
        const n = window.__hkl_composer.model.getDoc().querySelectorAll('clef').length;
        return n === 0 ? { ok: true } : { ok: false, detail: 'clef count=' + n + ' (Enter on Cancel should not commit)' };
      })()` },
  ],
  kbd_modalEnterOnSelectSubmits: [
    { name: 'Enter on focused <select> submitted the clef modal (C/3 written, modal closed)',
      expr: `(() => {
        const dlg = document.getElementById('textEntryDialog');
        if (dlg && dlg.open) return { ok: false, detail: 'modal still open (Enter did not submit)' };
        const clef = window.__hkl_composer.model.getDoc().querySelector('clef[shape="C"]');
        return clef && clef.getAttribute('line') === '3'
          ? { ok: true }
          : { ok: false, detail: 'no C/3 clef: ' + (clef ? clef.outerHTML : 'none') };
      })()` },
  ],
  kbd_modeToggle: [
    { name: 'mode toggled to overwrite',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.mode === 'overwrite'
          ? { ok: true }
          : { ok: false, detail: 'mode=' + s.mode };
      })()` },
  ],
  kbd_escClearsPending: [
    { name: 'no hairpin exists in doc',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const hp = m.getDoc().querySelectorAll('hairpin');
        return hp.length === 0
          ? { ok: true }
          : { ok: false, detail: hp.length + ' hairpins exist' };
      })()` },
  ],
  kbd_pendingHairpin_cancelOnDigit: [
    { name: 'pendingHairpin cleared by digit',
      expr: `(() => {
        const p = window.__hkl_composer.inputState().pendingHairpin;
        return p === null
          ? { ok: true }
          : { ok: false, detail: 'pending=' + JSON.stringify(p) };
      })()` },
    { name: 'digit fell through and inserted a rest',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rests = [...m.getDoc().querySelectorAll('rest')];
        return rests.length >= 1
          ? { ok: true }
          : { ok: false, detail: 'rests=' + rests.length };
      })()` },
    { name: 'no hairpin committed',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const hp = m.getDoc().querySelectorAll('hairpin');
        return hp.length === 0
          ? { ok: true }
          : { ok: false, detail: hp.length + ' hairpins exist' };
      })()` },
  ],
  kbd_pendingHairpin_preservedOnArrowRight: [
    { name: 'pendingHairpin still set after ArrowRight',
      expr: `(() => {
        const p = window.__hkl_composer.inputState().pendingHairpin;
        return (p && p.form === 'cres')
          ? { ok: true }
          : { ok: false, detail: 'pending=' + JSON.stringify(p) };
      })()` },
    { name: 'cursor advanced one slot',
      expr: `(() => {
        const c = window.__hkl_composer.model.getCursor();
        return c === 1
          ? { ok: true }
          : { ok: false, detail: 'cursor=' + c };
      })()` },
  ],
  kbd_pendingHairpin_cancelOnVoiceCycle: [
    { name: 'pendingHairpin cleared by voice cycle',
      expr: `(() => {
        const p = window.__hkl_composer.inputState().pendingHairpin;
        return p === null
          ? { ok: true }
          : { ok: false, detail: 'pending=' + JSON.stringify(p) };
      })()` },
    { name: 'voice cycled to V_2',
      expr: `(() => {
        const v = window.__hkl_composer.model.getCurrentVoice();
        return v === 2
          ? { ok: true }
          : { ok: false, detail: 'voice=' + v };
      })()` },
  ],
  kbd_statusError_onTieNoNote: [
    { name: 'statusline shows error in red',
      expr: `(() => {
        const el = document.getElementById('composerStatus');
        if (!el) return { ok: false, detail: 'no #composerStatus element' };
        if (!el.classList.contains('status-error')) {
          return { ok: false, detail: 'classList=' + el.className + ' text=' + el.textContent };
        }
        return el.textContent.includes('No tieable note')
          ? { ok: true }
          : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],
  kbd_statusError_clearsOnNextKey: [
    { name: 'statusline cleared to Ready. with no kind class',
      expr: `(() => {
        const el = document.getElementById('composerStatus');
        if (!el) return { ok: false, detail: 'no #composerStatus element' };
        const hasKindClass = el.classList.contains('status-error')
          || el.classList.contains('status-state')
          || el.classList.contains('status-action');
        if (hasKindClass) {
          return { ok: false, detail: 'still has kind class: ' + el.className };
        }
        return el.textContent === 'Ready.'
          ? { ok: true }
          : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],
  kbd_statusInfo_pendingHairpinCancel: [
    { name: 'cancel is an info cue (gray, no kind class), not purple',
      expr: `(() => {
        const el = document.getElementById('composerStatus');
        if (!el) return { ok: false, detail: 'no #composerStatus element' };
        const hasKindClass = el.classList.contains('status-error')
          || el.classList.contains('status-state')
          || el.classList.contains('status-action');
        if (hasKindClass) {
          return { ok: false, detail: 'should be info (no kind class), got ' + el.className + ' text=' + el.textContent };
        }
        return el.textContent.includes('cancelled')
          ? { ok: true }
          : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],
  kbd_statusAction_insertMeasure: [
    { name: 'real undoable edit shows post-action in purple',
      expr: `(() => {
        const el = document.getElementById('composerStatus');
        if (!el) return { ok: false, detail: 'no #composerStatus element' };
        if (!el.classList.contains('status-action')) {
          return { ok: false, detail: 'classList=' + el.className + ' text=' + el.textContent };
        }
        return el.textContent.includes('Inserted measure')
          ? { ok: true }
          : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],
  kbd_statusAction_clearsOnNextKey: [
    { name: 'purple post-action also clears on next keystroke',
      expr: `(() => {
        const el = document.getElementById('composerStatus');
        if (!el) return { ok: false, detail: 'no #composerStatus element' };
        const hasKindClass = el.classList.contains('status-error')
          || el.classList.contains('status-state')
          || el.classList.contains('status-action');
        if (hasKindClass) {
          return { ok: false, detail: 'still has kind class: ' + el.className };
        }
        return el.textContent === 'Ready.'
          ? { ok: true }
          : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],
  kbd_statusVoiceSwitch_noMessage: [
    { name: 'voice switch emits no status message (indicator shows the voice)',
      expr: `(() => {
        const el = document.getElementById('composerStatus');
        if (!el) return { ok: false, detail: 'no #composerStatus element' };
        const v = window.__hkl_composer.model.getCurrentVoice();
        if (v !== 2) return { ok: false, detail: 'expected voice 2 after ArrowDown, got ' + v };
        const hasKindClass = el.classList.contains('status-error')
          || el.classList.contains('status-state')
          || el.classList.contains('status-action');
        if (hasKindClass || /Voice/.test(el.textContent)) {
          return { ok: false, detail: 'unexpected status: class=' + el.className + ' text=' + el.textContent };
        }
        return { ok: true };
      })()` },
  ],
  /* Help modal. */
  help_button_opens_modal: [
    { name: 'helpDialog.open === true',
      expr: `(() => {
        const dlg = document.getElementById('helpDialog');
        return { ok: !!(dlg && dlg.open), detail: 'open=' + (dlg && dlg.open) };
      })()` },
    { name: 'rendered body contains a known binding key',
      expr: `(() => {
        const dlg = document.getElementById('helpDialog');
        const txt = dlg ? dlg.textContent || '' : '';
        const hasCtrl = txt.includes('Ctrl+2 .. Ctrl+7');
        const hasShiftDigit = txt.includes('Shift+1 .. Shift+8');
        return { ok: hasCtrl && hasShiftDigit,
                 detail: 'hasCtrl=' + hasCtrl + ' hasShiftDigit=' + hasShiftDigit };
      })()` },
    { name: 'all KEYBINDINGS sections rendered as <section>',
      expr: `(() => {
        const dlg = document.getElementById('helpDialog');
        const sections = dlg ? dlg.querySelectorAll('section.help-section').length : 0;
        return { ok: sections >= 5, detail: 'sectionCount=' + sections };
      })()` },
  ],
  help_catalog_matches_dispatcher: [
    { name: 'catalog lists the dispatched bindings and describes the layer deletes as the code does',
      expr: `(() => {
        const dlg = document.getElementById('helpDialog');
        const txt = dlg ? dlg.textContent || '' : '';
        const want = ['Ctrl+L', 'Alt+H', 'Shift+Space', 'Delete the selected expression mark', 'Delete the selected pedal mark', 'Delete the selected tempo mark'];
        const banned = ['Play / pause', 'common-cue'];
        const missing = want.filter((w) => !txt.includes(w));
        const present = banned.filter((b) => txt.includes(b));
        return { ok: !missing.length && !present.length, detail: 'missing=' + JSON.stringify(missing) + ' stale=' + JSON.stringify(present) };
      })()` },
  ],
  help_modal_esc_closes: [
    { name: 'helpDialog.open === false after Escape',
      expr: `(() => {
        const dlg = document.getElementById('helpDialog');
        return { ok: !!dlg && !dlg.open, detail: 'open=' + (dlg && dlg.open) };
      })()` },
  ],
};
