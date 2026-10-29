// Composer test fixtures — selection.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

import {
  FILL_M1_4Q_V1,
} from './_helpers.mjs';

/* One A4. Spelled out so the whole-measure-empties fixtures can fill a bar with
   NOTES — cutting RESTS yields rests either way, so a rest-filled bar cannot
   tell "refilled with rests" from "left empty". */
const A4_NOTE = `{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }`;

const FILL_M1_4N_V1 = `
  m.setCursor(0, 1);
  for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [${A4_NOTE}], duration: '4', dots: 0 });
`;

export const FIXTURES = {

  /* ── Selection mode (Shift+arrow entry, Ctrl+C/X/V) ──────────────── */
  //
  // Setup pattern: build content in M_1 (and sometimes M_2) via the model API,
  // then drive Shift+arrow / Ctrl+C/X/V via setupKeys. Each fixture asserts a
  // combination of (model state, input state, clipboard contents).
  //
  // Note: navigator.clipboard.readText() is not available in the headless
  // Chromium context without permissions plumbing — copy/paste fixtures use
  // the in-page sequence (write then read) and rely on the clipboard API
  // being mocked at test setup, OR they verify model-side effects only.
  /* Enter beat selection via Shift+Left from end-of-M1 (= cursor past last
     quarter, current beat = beat 3). Should select that single beat. */
  sel_beat_enter_shiftLeft: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(m.getVoiceLength(1), 1);`,
    setupKeys: [{ key: 'ArrowLeft', shift: true }],
  },
  /* Enter beat selection via Shift+Right from start of M1 (= cursor at the
     wrapper, current beat = beat 0). Should select that single beat — same
     as Shift+Left at this cursor (entry direction no longer matters). */
  sel_beat_enter_shiftRight: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [{ key: 'ArrowRight', shift: true }],
  },
  /* Direction-aware entry when the cursor sits EXACTLY on a mid-score beat
     boundary (past Q1 = end of beat 0 / start of beat 1). Shift+Right should
     select the beat to the RIGHT (beat 1 = note B); Shift+Left the beat to the
     LEFT (beat 0 = note A). Guards the off-by-one fix in enterBeatSelection. */
  sel_beat_onBoundary_shiftRight: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(m.findCursorByTickPosition(1, m.measureTicks() / 4), 1);`,
    setupKeys: [{ key: 'ArrowRight', shift: true }],
    visualBaseline: 'sel_beat_onBoundary_shiftRight',
  },
  sel_beat_onBoundary_shiftLeft: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(m.findCursorByTickPosition(1, m.measureTicks() / 4), 1);`,
    setupKeys: [{ key: 'ArrowLeft', shift: true }],
    visualBaseline: 'sel_beat_onBoundary_shiftLeft',
  },
  /* Grow beat selection rightward by 1 beat (entry selects beat 0, then
     Shift+Right expands last to beat 1). */
  sel_beat_grow_right: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
    ],
  },
  /* Shrink-back-to-origin: Shift+Right enters beat 0; Shift+Right expands to
     beat 0–1; Shift+Left shrinks back to beat 0 only. No convergence-exit. */
  sel_beat_shrink_to_origin: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowLeft', shift: true },
    ],
  },
  /* Ctrl+Shift+Right at start of a 2-measure score. Entry selects beat 0;
     Ctrl+Shift+Right should grow last until the last beat of M_1 (the
     just-moved edge lands at the M_1/M_2 measure boundary). */
  sel_beat_ctrlShift_measureBoundary: {
    setup: `${FILL_M1_4Q_V1}
      m.setCursor(m.getVoiceLength(1), 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true, ctrl: true },
    ],
  },
  /* Promote beat → measure via Shift+Down. */
  sel_promote_beat_to_measure: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowDown', shift: true },
    ],
  },
  /* Enter measure mode directly via Shift+Down from voice mode. */
  sel_measure_enter_shiftDown: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(1, 1);`,
    setupKeys: [{ key: 'ArrowDown', shift: true }],
  },
  /* Measure mode: Shift+Down adds the next staff (origin=staff 1, last=2). */
  sel_measure_expand_staves: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(1, 1);`,
    setupKeys: [
      { key: 'ArrowDown', shift: true },
      { key: 'ArrowDown', shift: true },
    ],
  },
  /* Escape exits selection mode. */
  sel_escape_exits: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      'Escape',
    ],
  },
  /* Pressing a non-selection key (a duration digit) exits selection to movable
     stop and then applies the key. */
  sel_nonsel_key_exits: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      '5', // quarter rest insert after exit
    ],
  },
  /* Ctrl+X on a beat selection should replace content with beat-aligned rests.
     We start with content (notes/chords already are rests in our setup, but the
     model side-effect should still be a re-fill via decomposeBeatAlignedRests). */
  sel_beat_cut_replaces_with_rests: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'x', ctrl: true },
    ],
  },
  /* Alt+V — move the selected whole measures into the other voice on the same
     staff (Max, 2026-09-17; his hotkey choice).
     Correcting notes entered into the wrong voice. Asserted via
     FIXTURE_ASSERTIONS.sel_altV_movesToOtherVoice. */
  sel_altV_movesToOtherVoice: {
    setup: `${FILL_M1_4N_V1}
      /* a second measure, so "the rest of the score is untouched" is testable */
      m.cursorToEnd(1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [${A4_NOTE}], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'v', alt: true },
    ],
  },
  /* Alt+V is its OWN INVERSE: the voice it left is empty afterwards, and the
     selection followed the music, so a second press sends it straight back.
     That is the property that makes it safe to reach for. */
  sel_altV_roundTripsBack: {
    setup: `${FILL_M1_4N_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'v', alt: true },
      { key: 'v', alt: true },
    ],
  },
  /* Undo puts it back in one step (the move is one history entry). */
  sel_altV_undoRestores: {
    setup: `${FILL_M1_4N_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'v', alt: true },
      { key: 'z', ctrl: true },
    ],
  },
  /* Refusal 1: the other voice already has something in that measure. All-or-
     nothing — this exists to undo a mistake, so it must not make a subtler one. */
  sel_altV_refusesOccupiedVoice: {
    setup: `${FILL_M1_4N_V1}
      m.setVoice(2); m.setCursor(0, 2);
      m.insertChordAtCursor({ notes: [${A4_NOTE}], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'v', alt: true },
    ],
  },
  /* Refusal 2: no WHOLE measure in the selection (2 of 4 beats). */
  sel_altV_refusesPartialSelection: {
    setup: `${FILL_M1_4N_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'v', alt: true },
    ],
  },
  /* Refusal 3: measure mode. Measure selection is staff-scoped and already
     spans both voices, so "the other voice" has no meaning there. */
  sel_altV_refusesMeasureMode: {
    setup: `${FILL_M1_4N_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowDown', shift: true },
      { key: 'v', alt: true },
    ],
  },
  /* Emptying a WHOLE measure from BEAT mode leaves the voice's cell empty —
     one whole-measure placeholder — not a bar of rests (Max, 2026-09-17). Measure-mode selection always behaved this
     way (`clearMeasureRange` leaves the layer bare); beat mode refilled the
     cleared span with beat-aligned rests unconditionally, so which MODE you
     had used to point at the bar decided what the document said. Four quarter
     NOTES so the rests would be visible if they came back. Asserted via
     FIXTURE_ASSERTIONS.sel_beat_cut_fullMeasure_empties. */
  sel_beat_cut_fullMeasure_empties: {
    setup: `${FILL_M1_4N_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'x', ctrl: true },
    ],
  },
  /* The same rule via the DELETE path, on a PART-FULL measure: one quarter note
     plus trailing placeholder, whole bar selected. The refill is sized by the
     ticks actually removed, so the old behavior left a stray quarter rest at the
     head of an otherwise empty bar — the tick test covers this case too.
     Asserted via FIXTURE_ASSERTIONS.sel_beat_delete_partFullMeasure_empties. */
  sel_beat_delete_partFullMeasure_empties: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [${A4_NOTE}], duration: '4', dots: 0 });
      m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      'Backspace',
    ],
  },
  /* The other side of the same rule: a PARTIAL span is still refilled with
     beat-aligned rests — a hole inside a bar is rests, and only a bar emptied
     in full becomes an empty cell. Guards against the whole-measure test
     swallowing the ordinary case. Asserted via
     FIXTURE_ASSERTIONS.sel_beat_cut_partialMeasure_keepsRests. */
  sel_beat_cut_partialMeasure_keepsRests: {
    setup: `${FILL_M1_4N_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'x', ctrl: true },
    ],
  },
  /* Backspace on a beat selection should delete the selected content AND exit
     selection mode (same end state as cut, minus the clipboard write). Before
     this fix, Backspace fell through to the normal-mode handler at the post-
     exit cursor and chewed adjacent content. */
  sel_beat_backspace_deletes_and_exits: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      'Backspace',
    ],
  },
  /* Delete (forward-delete) on a beat selection: same end state as Backspace. */
  sel_beat_delete_deletes_and_exits: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      'Delete',
    ],
  },
  /* Backspace on a measure-mode selection: clears measure content, exits to
     voice mode. */
  sel_measure_backspace_deletes_and_exits: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowDown', shift: true },
      'Backspace',
    ],
  },
  /* Visual: 2-beat selection at start of a 4-quarter M_1 (V_1). Captures
     the selection rect's horizontal extent (right edge of q0 to right edge
     of q1, snapping to measure left edge for the start of M_1) and the
     editing cursor being hidden. */
  visualSelBeatTwoBeats: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
    ],
    visualBaseline: 'sel_beat_two_beats',
  },
  /* Visual: measure-mode selection of all of M_1, both staves (Shift+Down
     to enter measure mode, Shift+Down again to add staff 2). */
  visualSelMeasureBothStaves: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowDown', shift: true },
      { key: 'ArrowDown', shift: true },
    ],
    visualBaseline: 'sel_measure_both_staves',
  },
  /* ── Content-free beats (2026-09-11) ─────────────────────────────────────
     <space> placeholders and an imported <mRest> are not cursor stops, so a
     beat over empty space has nothing between its boundary cursors. The
     overlay's content scan returned null → zero rects, while the `Sel:`
     status still printed and the voice cursor was (by design) hidden: Max saw
     "a selection was completed, but no box appears and the cursor is also
     invisible." Every fixture here asserts the RECT, not just state.selection
     — the prior sel_* fixtures all started from a filled beat and never
     checked that a rect existed. */

  /* Default document: one empty measure. Shift+Right must draw one box from
     the sig block's end to the bar line, at staff height. */
  sel_beat_enter_emptyMeasure: {
    setup: `m.setCursor(0, 1);`,
    setupKeys: [{ key: 'ArrowRight', shift: true }],
  },
  /* Same bar, voice 2 (its layer exists but holds only a placeholder). */
  sel_beat_enter_emptyMeasure_voice2: {
    setup: `m.setVoice(2); m.setCursor(0, 2);`,
    setupKeys: [{ key: 'ArrowRight', shift: true }],
  },
  /* A file saved before 2026-09-28 whose layer holds a stored <mRest> and
     nothing else. Load scrubs it to placeholders (the whole rest is drawn
     cosmetically), so the beat is an ordinary empty one. */
  sel_beat_enter_mRest: {
    setup: `
      const d = new DOMParser().parseFromString(m.serialize(), 'application/xml');
      const layer = d.querySelector('measure staff[n="1"] layer[n="1"]');
      while (layer.firstChild) layer.removeChild(layer.firstChild);
      const mr = d.createElementNS('http://www.music-encoding.org/ns/mei', 'mRest');
      mr.setAttribute('xml:id', 'mr_sel_test'); layer.appendChild(mr);
      m.replaceDocument(new XMLSerializer().serializeToString(d));
      m.setCursor(0, 1);
    `,
    setupKeys: [{ key: 'ArrowRight', shift: true }],
  },
  /* The compositional case: M1 entered, cursor moved into the empty M2. */
  sel_beat_enter_emptyM2_afterFullM1: {
    setup: `${FILL_M1_4Q_V1}
      if (m.allMeasures().length < 2) m.appendMeasure();
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
    `,
    setupKeys: [{ key: 'ArrowRight', shift: true }],
  },
  /* The most common case: two quarters entered, cursor past the second,
     Shift+Right selects the empty remainder. The box must start at Q2's
     RIGHT edge (where the voice cursor sat) and end at the bar line. */
  sel_beat_enter_trailingPlaceholder: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 2; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);
    `,
    setupKeys: [{ key: 'ArrowRight', shift: true }],
    visualBaseline: 'sel_beat_trailing_placeholder',
  },
  /* Control + regression guard for the x-anchor change: Shift+Left from the
     same spot selects Q2's beat; its box must HUG Q2 (left edge → right edge)
     rather than stretch over the trailing placeholders to the bar line, so
     the two boxes tile at the cursor's position. */
  sel_beat_lastNote_hugsNote: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 2; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);
    `,
    setupKeys: [{ key: 'ArrowLeft', shift: true }],
  },
};

export const ASSERTIONS = {
  /* ── Selection fixtures ───────────────────────────────────────────────── */
  sel_beat_enter_shiftLeft: [
    { name: 'cursorMode is select',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'select'
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
    { name: 'single-beat selection: first === origin === last (beat 3 of 4)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') {
          return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        }
        const sel = s.selection;
        return sel.first === sel.origin && sel.last === sel.origin && sel.origin === 3
          ? { ok: true }
          : { ok: false, detail: 'expected first=origin=last=3, got ' + JSON.stringify(sel) };
      })()` },
  ],
  sel_beat_enter_shiftRight: [
    { name: 'single-beat selection: first === origin === last (beat 0)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') {
          return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        }
        const sel = s.selection;
        return sel.first === sel.origin && sel.last === sel.origin && sel.origin === 0
          ? { ok: true }
          : { ok: false, detail: 'expected first=origin=last=0, got ' + JSON.stringify(sel) };
      })()` },
  ],
  sel_beat_onBoundary_shiftRight: [
    { name: 'on-boundary Shift+Right selects the beat to the RIGHT (beat 1 = note B)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') {
          return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        }
        const sel = s.selection;
        return sel.first === 1 && sel.last === 1 && sel.origin === 1 && sel.lastMoved === 'last'
          ? { ok: true }
          : { ok: false, detail: 'expected first=origin=last=1, lastMoved=last, got ' + JSON.stringify(sel) };
      })()` },
  ],
  sel_beat_onBoundary_shiftLeft: [
    { name: 'on-boundary Shift+Left selects the beat to the LEFT (beat 0 = note A)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') {
          return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        }
        const sel = s.selection;
        return sel.first === 0 && sel.last === 0 && sel.origin === 0 && sel.lastMoved === 'first'
          ? { ok: true }
          : { ok: false, detail: 'expected first=origin=last=0, lastMoved=first, got ' + JSON.stringify(sel) };
      })()` },
  ],
  sel_beat_grow_right: [
    { name: 'selection spans 2 beats (first=0, last=1)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') {
          return { ok: false, detail: 'no beat selection' };
        }
        const sel = s.selection;
        return sel.first === 0 && sel.last === 1 && sel.origin === 0 && sel.lastMoved === 'last'
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(sel) };
      })()` },
  ],
  sel_beat_shrink_to_origin: [
    { name: 'still in selection mode (no convergence-exit)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'select' && s.selection && s.selection.kind === 'beat'
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode + ' selection=' + JSON.stringify(s.selection) };
      })()` },
    { name: 'shrunk back to single-beat at origin (beat 0)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') {
          return { ok: false, detail: 'no beat selection' };
        }
        const sel = s.selection;
        return sel.first === 0 && sel.last === 0 && sel.origin === 0
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(sel) };
      })()` },
  ],
  sel_beat_ctrlShift_measureBoundary: [
    { name: 'last advanced to the last beat of M_1 (beat 3) — measure boundary at boundaries[4]',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') {
          return { ok: false, detail: 'no beat selection' };
        }
        const sel = s.selection;
        return sel.first === 0 && sel.last === 3 && sel.lastMoved === 'last'
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(sel) };
      })()` },
  ],
  sel_promote_beat_to_measure: [
    { name: 'selection is now measure kind',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.selection && s.selection.kind === 'measure'
          ? { ok: true }
          : { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
      })()` },
  ],
  sel_measure_enter_shiftDown: [
    { name: 'measure selection on M_1, staff 1 only',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'measure') {
          return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        }
        const ok = s.selection.anchorMeasure === 0
          && s.selection.movableMeasure === 0
          && s.selection.firstStaff === 1
          && s.selection.lastStaff === 1
          && s.selection.movableSide === 'unset';
        return ok
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(s.selection) };
      })()` },
  ],
  sel_measure_expand_staves: [
    { name: 'staff range expanded to 1..2',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'measure') {
          return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        }
        return s.selection.firstStaff === 1 && s.selection.lastStaff === 2
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(s.selection) };
      })()` },
  ],
  sel_escape_exits: [
    { name: 'cursorMode is voice after Escape',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'voice' && s.selection === null
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
  ],
  sel_nonsel_key_exits: [
    { name: 'cursorMode is voice after non-selection key',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'voice' && s.selection === null
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
  ],
  /* ── Alt+V: move selected whole measures to the other voice ────────────── */
  sel_altV_movesToOtherVoice: [
    { name: 'M1 moved from V1 to V2: V1 empty, V2 holds the 4 notes, M2 untouched',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const L = (mi, v) => {
          const st = m.allMeasures()[mi].querySelector('staff[n="' + m.staffForVoice(v) + '"]');
          return st.querySelectorAll('layer')[m.layerForVoice(v) - 1];
        };
        const kids = (mi, v) => Array.from(L(mi, v).children).map(c => c.localName);
        const notes = (mi, v) => L(mi, v).querySelectorAll(':scope > note, :scope > chord').length;
        if (notes(0, 1) !== 0) return { ok: false, detail: 'V1 M1 still has ' + notes(0, 1) + ' notes: [' + kids(0, 1) + ']' };
        const ph = Array.from(L(0, 1).children).filter(c => c.localName === 'space' && c.getAttribute('data-placeholder') === 'true');
        if (ph.length !== 1) return { ok: false, detail: 'V1 M1 = [' + kids(0, 1) + '] (expected one placeholder)' };
        if (notes(0, 2) !== 4) return { ok: false, detail: 'V2 M1 has ' + notes(0, 2) + ' notes: [' + kids(0, 2) + ']' };
        /* The rest of the score is untouched. */
        if (notes(1, 1) !== 4) return { ok: false, detail: 'M2 V1 note count=' + notes(1, 1) };
        if (notes(1, 2) !== 0) return { ok: false, detail: 'M2 V2 gained content' };
        return { ok: true };
      })()` },
    { name: 'still in selection mode, and the selection followed the music into V2',
      expr: `(() => {
        const H = window.__hkl_composer;
        const st = H.inputState();
        if (st.cursorMode !== 'select') return { ok: false, detail: 'cursorMode=' + st.cursorMode };
        const sel = st.selection;
        if (!sel || sel.kind !== 'beat') return { ok: false, detail: 'selection=' + JSON.stringify(sel) };
        if (sel.voice !== 2) return { ok: false, detail: 'selection voice=' + sel.voice + ' (expected 2 — it should follow the notes)' };
        if (sel.first !== 0 || sel.last !== 3) return { ok: false, detail: 'beats ' + sel.first + '..' + sel.last + ' (expected 0..3)' };
        if (H.model.getCurrentVoice() !== 2) return { ok: false, detail: 'model voice=' + H.model.getCurrentVoice() };
        return { ok: true };
      })()` },
    { name: 'status reports the move',
      expr: `(() => {
        const el = document.getElementById('composerStatus');
        if (!el) return { ok: false, detail: 'no #composerStatus' };
        return el.textContent.indexOf('Moved 1 measure to voice 2') >= 0
          ? { ok: true } : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],
  sel_altV_roundTripsBack: [
    { name: 'a second Alt+V brings the same bar back to V1',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const L = (mi, v) => {
          const st = m.allMeasures()[mi].querySelector('staff[n="' + m.staffForVoice(v) + '"]');
          return st.querySelectorAll('layer')[m.layerForVoice(v) - 1];
        };
        const notes = (mi, v) => L(mi, v).querySelectorAll(':scope > note, :scope > chord').length;
        if (notes(0, 1) !== 4) return { ok: false, detail: 'V1 note count=' + notes(0, 1) + ' (expected the 4 back)' };
        if (notes(0, 2) !== 0) return { ok: false, detail: 'V2 still holds ' + notes(0, 2) + ' notes' };
        const sel = window.__hkl_composer.inputState().selection;
        if (!sel || sel.voice !== 1) return { ok: false, detail: 'selection voice=' + (sel && sel.voice) + ' (expected 1)' };
        return { ok: true };
      })()` },
  ],
  sel_altV_undoRestores: [
    { name: 'Ctrl+Z undoes the move in one step',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const L = (mi, v) => {
          const st = m.allMeasures()[mi].querySelector('staff[n="' + m.staffForVoice(v) + '"]');
          return st.querySelectorAll('layer')[m.layerForVoice(v) - 1];
        };
        const notes = (mi, v) => L(mi, v).querySelectorAll(':scope > note, :scope > chord').length;
        if (notes(0, 1) !== 4) return { ok: false, detail: 'V1 note count=' + notes(0, 1) + ' after undo' };
        if (notes(0, 2) !== 0) return { ok: false, detail: 'V2 note count=' + notes(0, 2) + ' after undo' };
        return { ok: true };
      })()` },
  ],
  sel_altV_refusesOccupiedVoice: [
    { name: 'refused with an error naming the measure; nothing moved',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const L = (mi, v) => {
          const st = m.allMeasures()[mi].querySelector('staff[n="' + m.staffForVoice(v) + '"]');
          return st.querySelectorAll('layer')[m.layerForVoice(v) - 1];
        };
        const notes = (mi, v) => L(mi, v).querySelectorAll(':scope > note, :scope > chord').length;
        if (notes(0, 1) !== 4) return { ok: false, detail: 'V1 note count=' + notes(0, 1) + ' (the move should have been refused)' };
        if (notes(0, 2) !== 1) return { ok: false, detail: 'V2 note count=' + notes(0, 2) + ' (expected its own 1 note, untouched)' };
        const el = document.getElementById('composerStatus');
        if (!el || !el.classList.contains('status-error')) return { ok: false, detail: 'status class=' + (el && el.className) };
        return el.textContent.indexOf('already has content in measure') >= 0
          ? { ok: true } : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],
  sel_altV_refusesPartialSelection: [
    { name: 'a 2-of-4-beat selection is refused; nothing moved',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const L = (mi, v) => {
          const st = m.allMeasures()[mi].querySelector('staff[n="' + m.staffForVoice(v) + '"]');
          return st.querySelectorAll('layer')[m.layerForVoice(v) - 1];
        };
        const notes = (mi, v) => L(mi, v).querySelectorAll(':scope > note, :scope > chord').length;
        if (notes(0, 1) !== 4 || notes(0, 2) !== 0) {
          return { ok: false, detail: 'V1=' + notes(0, 1) + ' V2=' + notes(0, 2) + ' — a partial selection must not move anything' };
        }
        const el = document.getElementById('composerStatus');
        if (!el || !el.classList.contains('status-error')) return { ok: false, detail: 'status class=' + (el && el.className) };
        return el.textContent.indexOf('at least one whole measure') >= 0
          ? { ok: true } : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],
  sel_altV_refusesMeasureMode: [
    { name: 'measure-mode selection is refused (the other voice has no meaning there)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const L = (mi, v) => {
          const st = m.allMeasures()[mi].querySelector('staff[n="' + m.staffForVoice(v) + '"]');
          return st.querySelectorAll('layer')[m.layerForVoice(v) - 1];
        };
        const notes = (mi, v) => L(mi, v).querySelectorAll(':scope > note, :scope > chord').length;
        if (notes(0, 1) !== 4 || notes(0, 2) !== 0) return { ok: false, detail: 'V1=' + notes(0, 1) + ' V2=' + notes(0, 2) };
        const st = window.__hkl_composer.inputState();
        if (!st.selection || st.selection.kind !== 'measure') return { ok: false, detail: 'selection=' + JSON.stringify(st.selection) };
        const el = document.getElementById('composerStatus');
        if (!el || !el.classList.contains('status-error')) return { ok: false, detail: 'status class=' + (el && el.className) };
        return el.textContent.indexOf('beat selection') >= 0
          ? { ok: true } : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],
  /* A bar emptied IN FULL from beat mode is an EMPTY CELL, not a bar of rests. */
  sel_beat_cut_fullMeasure_empties: [
    { name: 'M1 V_1 holds only the whole-measure placeholder — no rests, no notes',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const layer = m.allMeasures()[0].querySelector('staff[n="1"] layer[n="1"]');
        const kids = Array.from(layer.children).map(c => c.localName);
        const rests = layer.querySelectorAll(':scope > rest').length;
        const notes = layer.querySelectorAll(':scope > note, :scope > chord').length;
        if (rests || notes) return { ok: false, detail: 'layer = [' + kids.join(',') + '] — expected placeholder only' };
        const ph = Array.from(layer.children).filter(c => c.localName === 'space' && c.getAttribute('data-placeholder') === 'true');
        if (ph.length !== 1) return { ok: false, detail: 'placeholders=' + ph.length + ' in [' + kids.join(',') + ']' };
        if (ph[0].getAttribute('dur') !== '1') return { ok: false, detail: 'placeholder dur=' + ph[0].getAttribute('dur') + ' (expected 1 = the whole 4/4 bar)' };
        /* The cell reads as empty to everything downstream (hide-empty, multirest). */
        if (!m.cellIsEmpty(0, 1)) return { ok: false, detail: 'cellIsEmpty(measure 0, staff 1) is false' };
        return { ok: true };
      })()` },
    { name: 'the NEXT measure is untouched (4 notes) and selection mode exited',
      expr: `(() => {
        const H = window.__hkl_composer, m = H.model;
        const st = H.inputState();
        if (st.cursorMode !== 'voice' || st.selection !== null) return { ok: false, detail: 'cursorMode=' + st.cursorMode };
        const ms = m.allMeasures();
        if (ms.length < 2) return { ok: true, detail: 'single-measure doc' };
        const n = ms[1].querySelectorAll('staff[n="1"] layer[n="1"] > note, staff[n="1"] layer[n="1"] > chord').length;
        return n === 4 ? { ok: true } : { ok: false, detail: 'M2 note count=' + n };
      })()` },
  ],
  /* Same rule, DELETE path, on a part-full bar: no stray head rest. */
  sel_beat_delete_partFullMeasure_empties: [
    { name: 'a part-full bar emptied in full leaves the placeholder alone — no leading quarter rest',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const layer = m.allMeasures()[0].querySelector('staff[n="1"] layer[n="1"]');
        const kids = Array.from(layer.children).map(c => c.localName + (c.getAttribute('dur') ? '@' + c.getAttribute('dur') : ''));
        if (layer.querySelectorAll(':scope > rest').length) {
          return { ok: false, detail: 'layer = [' + kids.join(',') + '] — the refill left a rest sized by the content that was there' };
        }
        if (layer.querySelectorAll(':scope > note, :scope > chord').length) return { ok: false, detail: 'layer = [' + kids.join(',') + ']' };
        const ph = Array.from(layer.children).filter(c => c.localName === 'space' && c.getAttribute('data-placeholder') === 'true');
        if (ph.length !== 1 || ph[0].getAttribute('dur') !== '1') {
          return { ok: false, detail: 'expected one whole-bar placeholder, got [' + kids.join(',') + ']' };
        }
        return { ok: true };
      })()` },
  ],
  /* And the ordinary case is unchanged: a partial span is still rests. */
  sel_beat_cut_partialMeasure_keepsRests: [
    { name: 'cutting 2 of 4 beats leaves 2 beat-aligned rests and the 2 untouched notes',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const layer = m.allMeasures()[0].querySelector('staff[n="1"] layer[n="1"]');
        const kids = Array.from(layer.children).map(c => c.localName + (c.getAttribute('dur') ? '@' + c.getAttribute('dur') : ''));
        const rests = layer.querySelectorAll(':scope > rest').length;
        const notes = layer.querySelectorAll(':scope > note, :scope > chord').length;
        if (rests !== 2 || notes !== 2) {
          return { ok: false, detail: 'rests=' + rests + ' notes=' + notes + ' in [' + kids.join(',') +
            '] — a hole inside a bar must stay rests' };
        }
        /* Rests first: the cut span was the bar's opening two beats. */
        if (kids[0].indexOf('rest') !== 0 || kids[1].indexOf('rest') !== 0) {
          return { ok: false, detail: 'order = [' + kids.join(',') + '] (expected the rests at the head)' };
        }
        return { ok: true };
      })()` },
  ],
  sel_beat_cut_replaces_with_rests: [
    { name: 'selection cleared and cursorMode back to voice',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'voice' && s.selection === null
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
    { name: 'V_1 layer still has 4 rests (cut replaced with rests, total preserved)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rests = m.allMeasures()[0].querySelectorAll('staff[n="1"] layer[n="1"] > rest');
        return rests.length === 4
          ? { ok: true }
          : { ok: false, detail: 'rest count = ' + rests.length };
      })()` },
  ],
  sel_beat_backspace_deletes_and_exits: [
    { name: 'selection cleared and cursorMode back to voice',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'voice' && s.selection === null
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
    { name: 'V_1 layer still has 4 rests (Backspace replaced selection with rests, total preserved)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rests = m.allMeasures()[0].querySelectorAll('staff[n="1"] layer[n="1"] > rest');
        return rests.length === 4
          ? { ok: true }
          : { ok: false, detail: 'rest count = ' + rests.length };
      })()` },
  ],
  sel_beat_delete_deletes_and_exits: [
    { name: 'selection cleared and cursorMode back to voice',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'voice' && s.selection === null
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
    { name: 'V_1 layer still has 4 rests (Delete behaves same as Backspace)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rests = m.allMeasures()[0].querySelectorAll('staff[n="1"] layer[n="1"] > rest');
        return rests.length === 4
          ? { ok: true }
          : { ok: false, detail: 'rest count = ' + rests.length };
      })()` },
  ],
  sel_measure_backspace_deletes_and_exits: [
    { name: 'selection cleared and cursorMode back to voice',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'voice' && s.selection === null
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
  ],
  /* Visual selection asserts: cursor hidden in selection mode, and exactly
     one selection rect emitted for a single-measure beat selection. */
  visualSelBeatTwoBeats: [
    { name: 'editing cursor bar is hidden in selection mode',
      expr: `(() => {
        const overlay = document.getElementById('cursorOverlay');
        const bar = overlay?.querySelector('rect[data-cursor-role="voice"]');
        if (!bar) return { ok: false, detail: 'no voice cursor rect' };
        const op = bar.getAttribute('opacity');
        return op === '0'
          ? { ok: true }
          : { ok: false, detail: 'voice cursor opacity=' + op };
      })()` },
    { name: 'no visible text or visible-rect elements anywhere over the score',
      expr: `(() => {
        /* Scan ALL svgs (Verovio's + overlay) for any text with content
         * "V" + digit OR any rect that isn't our selection rect and has
         * non-zero opacity. */
        const score = document.getElementById('score');
        if (!score) return { ok: false, detail: 'no #score' };
        const texts = Array.from(score.querySelectorAll('text'));
        const bad = texts.filter((t) => /^V[1-4]?$/.test((t.textContent ?? '').trim()));
        return bad.length === 0
          ? { ok: true }
          : { ok: false, detail: 'V-labels: ' + bad.map((t) => t.textContent + '@(' + t.getAttribute('x') + ',' + t.getAttribute('y') + ')').join('|') };
      })()` },
    { name: 'exactly one selection rect rendered (single measure / single system)',
      expr: `(() => {
        const rects = document.querySelectorAll('rect[data-selection-rect="true"]');
        return rects.length === 1
          ? { ok: true }
          : { ok: false, detail: 'rect count=' + rects.length };
      })()` },
  ],
  visualSelMeasureBothStaves: [
    { name: 'measure selection spans both staves vertically',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'measure') {
          return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        }
        return s.selection.firstStaff === 1 && s.selection.lastStaff === 2
          ? { ok: true }
          : { ok: false, detail: 'staves: ' + s.selection.firstStaff + '..' + s.selection.lastStaff };
      })()` },
    { name: 'exactly one selection rect (both staves coalesced)',
      expr: `(() => {
        const rects = document.querySelectorAll('rect[data-selection-rect="true"]');
        return rects.length === 1
          ? { ok: true }
          : { ok: false, detail: 'rect count=' + rects.length };
      })()` },
  ],
  /* Content-free beat selections (2026-09-11): assert the RECT, not just state. */
  sel_beat_enter_emptyMeasure: [
    { name: 'beat selection V1 beat 0..0',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        const ok = s.selection.voice === 1 && s.selection.first === 0 && s.selection.last === 0;
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(s.selection) };
      })()` },
    { name: 'exactly one selection rect with positive size',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length + ' ' + fmt() };
        return rects[0].w > 0 && rects[0].h > 0 ? { ok: true } : { ok: false, detail: fmt() };
      })()` },
    { name: 'rect spans M1 content-left → right edge',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length };
        const r = rects[0]; const mr = measRect(0); const cl = contentLeft(0);
        if (!mr) return { ok: false, detail: 'measure not rendered' };
        const ok = near(r.x, cl) && near(r.x + r.w, mr.right);
        return ok ? { ok: true } : { ok: false, detail: 'rect ' + fmt() + ' vs contentLeft=' + Math.round(cl) + ' right=' + Math.round(mr.right) };
      })()` },
    { name: 'rect is staff-height (top staff), not zero-height',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length };
        const st = M.allMeasures()[0].querySelector('staff[n="1"]'); const sr = R.rectForId(st.getAttribute('xml:id'));
        if (!sr) return { ok: false, detail: 'staff not rendered' };
        const r = rects[0];
        const ok = r.y <= sr.top + 2 && r.y + r.h >= sr.bottom - 2 && r.h < sr.height * 1.5;
        return ok ? { ok: true } : { ok: false, detail: 'rect ' + fmt() + ' staff top=' + Math.round(sr.top) + ' bottom=' + Math.round(sr.bottom) };
      })()` },
    { name: 'voice cursor hidden in select mode',
      expr: `(() => {
        const bar = document.querySelector('[data-cursor-role="voice"]');
        if (!bar) return { ok: false, detail: 'no voice cursor rect' };
        const op = bar.getAttribute('opacity');
        return op === '0' ? { ok: true } : { ok: false, detail: 'opacity=' + op };
      })()` },
  ],
  sel_beat_enter_emptyMeasure_voice2: [
    { name: 'beat selection V2 beat 0..0',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        const ok = s.selection.voice === 2 && s.selection.first === 0 && s.selection.last === 0;
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(s.selection) };
      })()` },
    { name: 'exactly one selection rect with positive size',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length + ' ' + fmt() };
        return rects[0].w > 0 && rects[0].h > 0 ? { ok: true } : { ok: false, detail: fmt() };
      })()` },
    { name: 'rect spans M1 content-left → right edge',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length };
        const r = rects[0]; const mr = measRect(0); const cl = contentLeft(0);
        if (!mr) return { ok: false, detail: 'measure not rendered' };
        const ok = near(r.x, cl) && near(r.x + r.w, mr.right);
        return ok ? { ok: true } : { ok: false, detail: 'rect ' + fmt() + ' vs contentLeft=' + Math.round(cl) + ' right=' + Math.round(mr.right) };
      })()` },
    { name: 'voice cursor hidden in select mode',
      expr: `(() => {
        const bar = document.querySelector('[data-cursor-role="voice"]');
        if (!bar) return { ok: false, detail: 'no voice cursor rect' };
        const op = bar.getAttribute('opacity');
        return op === '0' ? { ok: true } : { ok: false, detail: 'opacity=' + op };
      })()` },
  ],
  sel_beat_enter_mRest: [
    { name: 'premise: stored mRest scrubbed on load, V1 flat stream is the wrapper only, cosmetic whole rest drawn',
      expr: `(() => {
        const M = window.__hkl_composer.model;
        if (M.getDoc().querySelectorAll('mRest').length !== 0) return { ok: false, detail: 'stored mRest survived load' };
        const flat = M.flatChildren(1).map(e => e.localName);
        if (flat.length !== 1 || flat[0] !== 'measure') return { ok: false, detail: 'flat=' + JSON.stringify(flat) };
        const drawn = document.querySelector('#score g.measure g.staff g.mRest');
        return drawn ? { ok: true } : { ok: false, detail: 'no whole rest drawn' };
      })()` },
    { name: 'beat selection V1 beat 0..0',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        const ok = s.selection.voice === 1 && s.selection.first === 0 && s.selection.last === 0;
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(s.selection) };
      })()` },
    { name: 'exactly one selection rect with positive size',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length + ' ' + fmt() };
        return rects[0].w > 0 && rects[0].h > 0 ? { ok: true } : { ok: false, detail: fmt() };
      })()` },
    { name: 'rect spans M1 content-left → right edge',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length };
        const r = rects[0]; const mr = measRect(0); const cl = contentLeft(0);
        if (!mr) return { ok: false, detail: 'measure not rendered' };
        const ok = near(r.x, cl) && near(r.x + r.w, mr.right);
        return ok ? { ok: true } : { ok: false, detail: 'rect ' + fmt() + ' vs contentLeft=' + Math.round(cl) + ' right=' + Math.round(mr.right) };
      })()` },
  ],
  sel_beat_enter_emptyM2_afterFullM1: [
    { name: 'beat selection V1 beat 4..4',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        const ok = s.selection.voice === 1 && s.selection.first === 4 && s.selection.last === 4;
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(s.selection) };
      })()` },
    { name: 'exactly one selection rect with positive size',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length + ' ' + fmt() };
        return rects[0].w > 0 && rects[0].h > 0 ? { ok: true } : { ok: false, detail: fmt() };
      })()` },
    { name: 'rect lies within M2 (content-left → right edge)',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length + ' ' + fmt() };
        const r = rects[0]; const mr = measRect(1); const cl = contentLeft(1);
        if (!mr) return { ok: false, detail: 'M2 not rendered' };
        const ok = near(r.x, cl) && near(r.x + r.w, mr.right);
        return ok ? { ok: true } : { ok: false, detail: 'rect ' + fmt() + ' vs M2 contentLeft=' + Math.round(cl) + ' right=' + Math.round(mr.right) };
      })()` },
  ],
  sel_beat_enter_trailingPlaceholder: [
    { name: 'beat selection V1 beat 2..2',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        const ok = s.selection.voice === 1 && s.selection.first === 2 && s.selection.last === 2;
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(s.selection) };
      })()` },
    { name: 'exactly one selection rect with positive size',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length + ' ' + fmt() };
        return rects[0].w > 0 && rects[0].h > 0 ? { ok: true } : { ok: false, detail: fmt() };
      })()` },
    { name: 'rect runs from Q2 right edge to the bar line',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length + ' ' + fmt() };
        const kids = layerKids(0); const q2 = R.rectForId(kids[1].getAttribute('xml:id')); const mr = measRect(0);
        const r = rects[0];
        const ok = near(r.x, q2.right) && near(r.x + r.w, mr.right);
        return ok ? { ok: true } : { ok: false, detail: 'rect ' + fmt() + ' q2.right=' + Math.round(q2.right) + ' m.right=' + Math.round(mr.right) };
      })()` },
    { name: 'voice cursor hidden in select mode',
      expr: `(() => {
        const bar = document.querySelector('[data-cursor-role="voice"]');
        if (!bar) return { ok: false, detail: 'no voice cursor rect' };
        const op = bar.getAttribute('opacity');
        return op === '0' ? { ok: true } : { ok: false, detail: 'opacity=' + op };
      })()` },
  ],
  sel_beat_lastNote_hugsNote: [
    { name: 'beat selection V1 beat 1..1',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        const ok = s.selection.voice === 1 && s.selection.first === 1 && s.selection.last === 1;
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(s.selection) };
      })()` },
    { name: 'exactly one selection rect with positive size',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length + ' ' + fmt() };
        return rects[0].w > 0 && rects[0].h > 0 ? { ok: true } : { ok: false, detail: fmt() };
      })()` },
    { name: 'rect hugs Q2 (left → right edge), not the bar line',
      expr: `(() => {
        const H = window.__hkl_composer; const M = H.model; const R = H.renderer;
        const rects = Array.from(document.querySelectorAll('rect[data-selection-rect="true"]'))
          .map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }));
        const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
        const measRect = (i) => R.rectForId(M.allMeasures()[i].getAttribute('xml:id'));
        const contentLeft = (i) => { const st = M.allMeasures()[i].querySelector('staff[n="1"]'); const se = st ? R.findSigEndXForStaff(st.getAttribute('xml:id')) : null; return se ?? measRect(i).left; };
        const layerKids = (i, staffN = 1, layerN = 1) => M.contentChildren(M.allMeasures()[i].querySelector('staff[n="' + staffN + '"] layer[n="' + layerN + '"]'));
        const fmt = () => JSON.stringify(rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]));

        if (rects.length !== 1) return { ok: false, detail: 'rect count=' + rects.length + ' ' + fmt() };
        const kids = layerKids(0); const q2 = R.rectForId(kids[1].getAttribute('xml:id')); const mr = measRect(0);
        const r = rects[0];
        if (near(r.x + r.w, mr.right) && !near(q2.right, mr.right)) return { ok: false, detail: 'rect stretches to the bar line: ' + fmt() };
        const ok = near(r.x, q2.left) && near(r.x + r.w, q2.right);
        return ok ? { ok: true } : { ok: false, detail: 'rect ' + fmt() + ' q2=[' + Math.round(q2.left) + ',' + Math.round(q2.right) + ']' };
      })()` },
  ],
};
