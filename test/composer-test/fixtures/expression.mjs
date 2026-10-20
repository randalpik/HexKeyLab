// Composer test fixtures — expression.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

export const FIXTURES = {
  /* ── Sustain pedal (Shift+P down / Shift+O up) ─────────────── */

  /* Two quarter notes in M_1 V_1; Shift+P at note1 (beat 1) drops a pedal
     down, ArrowRight advances the cursor, Shift+O at note2 (beat 2) drops a
     pedal up. Both are tstamp-anchored <pedal> siblings on staff 2. */
  pedal_down_and_up: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);  /* park on note1 (anchor = flat[0]) */
    `,
    setupKeys: [
      { key: 'P', shift: true },   /* pedal down @ beat 1 */
      'ArrowRight',                /* cursor → past note2 */
      { key: 'O', shift: true },   /* pedal up @ beat 2 */
    ],
    visualBaseline: 'pedal_down_and_up',
  },
  /* Shift+P twice at the same moment toggles the pedal-down mark back off. */
  pedal_toggle_off: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'P', shift: true }, { key: 'P', shift: true }],
  },
  /* Pedal is tstamp-anchored, so it survives deletion of a nearby note (unlike
     the note-attached fermata/breath). Pedal down at beat 1 on note1; then
     delete note2; the pedal-down mark remains. */
  pedal_survives_note_delete: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [
      { key: 'P', shift: true },   /* pedal down @ beat 1 */
      'ArrowRight', 'ArrowRight',  /* cursor → end (past note2) */
      'Backspace',                 /* delete note2 */
    ],
  },
  /* Pedal LAYER (after V4, like expressions): two quarters + pedal down@beat1
     / up@beat2, then ArrowDown ×4 cycles V1→V2→V3→V4→pedal (expr layer is
     skipped — no dynamics). */
  pedal_layer_enter: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [
      { key: 'P', shift: true },   /* pedal down @ beat 1 */
      'ArrowRight',
      { key: 'O', shift: true },   /* pedal up @ beat 2 */
      'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown',  /* → pedal layer */
    ],
  },
  /* In the pedal layer, the cursor lands on the first moment (beat 1 = pedal
     down). Backspace deletes that mark; the up@beat2 remains and we stay in
     the pedal layer. */
  pedal_layer_delete: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [
      { key: 'P', shift: true },
      'ArrowRight',
      { key: 'O', shift: true },
      'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown',  /* → pedal layer (at beat 1) */
      'Backspace',                                          /* delete pedal-down */
    ],
  },
  /* ── Expressive text modal (Ctrl+Shift+E → <dir>) ──────────── */

  /* Full flow driven in setup JS (the modal is a native <dialog>; we open it
     via the real Ctrl+Shift+E keydown, fill the field, and requestSubmit the OK
     button so the form's method="dialog" closes it and onOk writes the <dir>).
     By the time invariants run, the modal is closed and the <dir> exists. */
  exprtext_create: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="text"]').value = 'dolce';
      dlg.querySelector('[data-field="italic"]').checked = true;
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
  },
  /* Italic UNCHECKED must render non-italic. <dir> is italic by default in
     Verovio, so "off" must explicitly store fontstyle=normal (plain text would
     still render italic). */
  exprtext_italicOff: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="text"]').value = 'marcato';
      dlg.querySelector('[data-field="italic"]').checked = false;
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
  },
  /* Re-open on the existing <dir> and change the text → still ONE <dir>, new text. */
  exprtext_edit: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      const open = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, bubbles: true }));
      const submit = (text) => {
        const dlg = document.getElementById('textEntryDialog');
        dlg.querySelector('[data-field="text"]').value = text;
        dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      };
      open(); submit('pizz.');
      open(); submit('arco');
    `,
  },
  /* Re-open on the existing <dir> and submit empty → the <dir> is removed. */
  exprtext_delete: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      const open = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, bubbles: true }));
      const submit = (text) => {
        const dlg = document.getElementById('textEntryDialog');
        dlg.querySelector('[data-field="text"]').value = text;
        dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      };
      open(); submit('dolce');
      open(); submit('');
    `,
  },
  /* Expressive text lives in the EXPRESSION layer: place a <dir>, cycle into
     expr mode (V1 → V2 → expr, reachable because the measure now has the dir),
     and Backspace deletes it. */
  exprtext_layer_delete: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="text"]').value = 'dolce';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      m.setCursor(1, 1);
    `,
    setupKeys: [
      'ArrowDown',   /* V1 → V2 */
      'ArrowDown',   /* V2 → expr (measure has the dir) */
      'Backspace',   /* delete the <dir> at the cursor moment */
    ],
  },
  /* Hairpin placement: a hairpin starting on a measure's DOWNBEAT (tstamp=1)
     aligns to the first note's glyph, NOT the bar line — Verovio anchors
     @tstamp to the note. Guards against re-introducing a tstamp "inset" hack.
     M1 = 4 quarters (full), M2 = 2 quarters; hairpin over M2 beats 1→2. */
  hairpin_startAlignsToNote: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      m.appendMeasure();
      m.setCursor(m.getVoiceLength(1), 1);
      for (let i = 0; i < 2; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      const doc = m.getDoc(); const MEI = 'http://www.music-encoding.org/ns/mei';
      const ms = doc.querySelectorAll('measure'); const m2 = ms[ms.length - 1];
      const hp = doc.createElementNS(MEI, 'hairpin');
      hp.setAttribute('xml:id', 'h-align'); hp.setAttribute('tstamp', '1'); hp.setAttribute('tstamp2', '0m+2');
      hp.setAttribute('form', 'cres'); hp.setAttribute('place', 'between'); hp.setAttribute('staff', '1');
      m2.appendChild(hp);
    `,
  },
  /* Real voice-mode flow: marking a hairpin with the cursor on the FIRST note
     of a measure must anchor to THAT measure's downbeat ({measure 1, tstamp 1}),
     not the previous measure's end ({measure 0, tstamp count+1} — which Verovio
     would draw on the bar line). 6 quarters → M1 full + M2 two notes; cursor on
     M2's first note (flat 5), "<" … →  … "<". */
  hairpin_firstNoteOfMeasure_anchorsToMeasure: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      for (let i = 0; i < 6; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      m.setCursor(5, 1);  /* M2's first note */
    `,
    setupKeys: [
      { key: '<', shift: true },   /* crescendo start at M2 beat 1 */
      { key: 'ArrowRight' },       /* → M2's second note */
      { key: '<', shift: true },   /* close */
    ],
  },
  /* ── Tempo modal (Ctrl+Shift+T → <tempo>) + retiming ───────── */

  /* Instant tempo marking 240 ♩= at m1 beat 1, written via the real modal.
     Retiming: the 2nd quarter's onset moves from 500ms (120bpm) to 250ms. */
  tempo_instant_retimes: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);  /* anchor beat 1 */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="kind"]').value = 'instant';
      dlg.querySelector('[data-field="text"]').value = 'Allegro';
      dlg.querySelector('[data-field="bpm"]').value = '240';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
  },
  /* Open-ended molto ritardando at beat 2 (no numeric target, no following
     tempo) → ramps 120bpm toward 120×(1−0.6) over the rest of the piece, so
     the 3rd quarter's onset lands LATER than the constant-tempo 1000ms. */
  tempo_gradual_rit: {
    setup: `
      m.setCursor(0, 1);
      for (const r of [0, 1, 2]) m.insertChordAtCursor({ notes: [{ q: 0, r, pname: 'a', accid: '', oct: 4, midi: 69 + r, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(2, 1);  /* anchor beat 2 (flat[1]) */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="kind"]').value = 'rit';
      dlg.querySelector('[data-field="text"]').value = 'molto rit.';  /* intensity derived from text */
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
  },
  /* Tempo has its OWN layer above V1 (↑ from V1). Place a beat-2 tempo, cycle
     up into the tempo layer, navigate to it, Backspace deletes it. */
  tempo_layer_delete: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(2, 1);  /* anchor beat 2 (flat[1]) */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="kind"]').value = 'instant';
      dlg.querySelector('[data-field="bpm"]').value = '90';
      dlg.querySelector('[data-field="text"]').value = 'Andante';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      m.setCursor(1, 1);
    `,
    setupKeys: [
      'ArrowUp',      /* V1 → tempo layer */
      'ArrowRight',   /* beat 1 → beat 2 (the tempo's moment) */
      'Backspace',    /* delete the beat-2 <tempo> */
    ],
  },
  /* Tempo modal ergonomics: opens focused on Kind (not Text); the ♩= / beat-note
     / show-mm rows are visible for an instant marking but HIDDEN for a gradual
     kind. Captures state to a window global, then closes the modal so it doesn't
     disturb later invariants. */
  tempo_modal_kindShapesForm: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      const vis = (f) => { const r = dlg.querySelector('[data-field="' + f + '"]')?.closest('.row'); return r ? (r.style.display === 'none' ? 'hidden' : 'shown') : 'missing'; };
      const snap = () => ({ bpm: vis('bpm'), unit: vis('unit'), showMm: vis('showMm'), text: vis('text'), kind: vis('kind') });
      window.__tempoProbe = { focused: document.activeElement?.getAttribute('data-field'), instant: snap() };
      const sel = dlg.querySelector('[data-field="kind"]'); sel.value = 'rit'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      window.__tempoProbe.rit = snap();
      dlg.close();
    `,
  },
  /* Metronome shown: instant marking with "Show ♩ = N" checked → the glyph +
     value is composed into the rendered text. */
  tempo_mm_shown: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="kind"]').value = 'instant';
      dlg.querySelector('[data-field="text"]').value = 'Allegro';
      dlg.querySelector('[data-field="bpm"]').value = '120';
      dlg.querySelector('[data-field="showMm"]').checked = true;
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
  },
  /* Metronome hidden: same but "Show ♩ = N" unchecked → text is bare; @mm still
     stored for playback. */
  tempo_mm_hidden: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="kind"]').value = 'instant';
      dlg.querySelector('[data-field="text"]').value = 'Allegro';
      dlg.querySelector('[data-field="bpm"]').value = '120';
      dlg.querySelector('[data-field="showMm"]').checked = false;
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
  },
  /* Dotted-quarter beat unit: mm.unit=4 + mm.dots=1. */
  tempo_dotted_beat: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="kind"]').value = 'instant';
      dlg.querySelector('[data-field="bpm"]').value = '80';
      dlg.querySelector('[data-field="unit"]').value = '4|1';
      dlg.querySelector('[data-field="showMm"]').checked = true;
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
  },
  /* Above/below placement. Place an "mf" dynamic, enter the
     expression layer, Ctrl+↓ moves it below, then Ctrl+↑ moves it above. */
  expr_place_toggle: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [
      { key: '%', shift: true },   /* Shift+5 → mf dynamic at beat 1 */
      'ArrowDown',                 /* V1 → V2 */
      'ArrowDown',                 /* V2 → expr (measure has the dynamic) */
      { key: 'ArrowDown', ctrl: true },  /* place below */
      { key: 'ArrowUp', ctrl: true },    /* place above */
    ],
  },
  /* Above/below placement also works in VOICE mode (no need to enter the
     expression layer): the dynamic at the current note gets @place. */
  expr_place_voicemode: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [
      { key: '%', shift: true },          /* mp dynamic at beat 1 */
      { key: 'ArrowDown', ctrl: true },   /* place below — still in voice mode */
    ],
  },
  /* Mark placement policy (2026-10-07): a dynamic / hairpin / expressive text
     under the UPPER staff of a grand staff is @place="between" — Verovio's own
     between pass centres it in the gap — and under a one-staff instrument it
     is @place="below" (dynamDist under its staff). The live insert path picks
     the value from the instrument's shape; a load normalizes older files. */
  expr_dynamicInsertBetweenOnGrandStaff: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(3); m.setCursor(0, 3); m.insertChordAtCursor({ notes: [N(2, 45)], duration: '1', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N(5, 81)], duration: '1', dots: 0 });
      m.setCursor(1, 1);  /* park on the note */
      /* Shift+6 in voice mode = p (SHIFT_DIGIT_TO_DYNAMIC) — the real insert path. */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '^', shiftKey: true, bubbles: true }));
      m.setCursor(0, 1);
      r();
    `,
  },
  expr_dynamicInsertBelowOnSingleStaff: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Viola', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(5, 81)], duration: '1', dots: 0 });
      m.setCursor(1, 5);  /* park on the viola note */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '^', shiftKey: true, bubbles: true }));
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* A load rewrites @place by instrument shape: below on the grand-staff upper
     staff → between; between on a one-staff instrument → below; above on the
     grand-staff LOWER staff is the same gap, so it becomes between on the upper
     staff. Idempotent (the ROUNDTRIP invariant reloads this document). */
  expr_loadNormalizesMarkPlaces: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Viola', staffCount: 1 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N(5, 81)], duration: '1', dots: 0 });
      m.setVoice(3); m.setCursor(0, 3); m.insertChordAtCursor({ notes: [N(2, 45)], duration: '1', dots: 0 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(5, 81)], duration: '1', dots: 0 });
      const doc = m.getDoc(); const meas = doc.querySelector('measure'); const MEI = 'http://www.music-encoding.org/ns/mei';
      const mk = (tag, id, attrs, text) => { const e = doc.createElementNS(MEI, tag); e.setAttribute('xml:id', id); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; meas.appendChild(e); };
      mk('dynam', 'd-norm-rh', { tstamp: '1', place: 'below', staff: '1' }, 'p');
      mk('dynam', 'd-norm-vla', { tstamp: '1', place: 'between', staff: '3' }, 'f');
      mk('dynam', 'd-norm-lh', { tstamp: '2', place: 'above', staff: '2' }, 'mf');
      mk('hairpin', 'h-norm-rh', { tstamp: '2', tstamp2: '0m+4', form: 'cres', place: 'below', staff: '1' });
      mk('dir', 'dir-norm-vla', { tstamp: '3', place: 'above', staff: '3' }, 'dolce');
      m.replaceDocument(m.serialize());
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
};

export const ASSERTIONS = {
  tempo_modal_kindShapesForm: [
    { name: 'modal focuses Kind; ♩=/beat-note/show-mm visible for instant, hidden for gradual',
      expr: `(() => {
        const p = window.__tempoProbe;
        if (!p) return { ok: false, detail: 'no probe' };
        if (p.focused !== 'kind') return { ok: false, detail: 'focused=' + p.focused + ' (expected kind)' };
        const i = p.instant, r = p.rit;
        const instantOk = i.bpm === 'shown' && i.unit === 'shown' && i.showMm === 'shown' && i.kind === 'shown' && i.text === 'shown';
        const ritOk = r.bpm === 'hidden' && r.unit === 'hidden' && r.showMm === 'hidden' && r.kind === 'shown' && r.text === 'shown';
        return instantOk && ritOk
          ? { ok: true }
          : { ok: false, detail: 'instant=' + JSON.stringify(i) + ' rit=' + JSON.stringify(r) };
      })()` },
  ],
  hairpin_firstNoteOfMeasure_anchorsToMeasure: [
    { name: 'hairpin on M2 first note stores in measure 1 at tstamp 1 (not measure 0, count+1)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const doc = m.getDoc();
        const hp = doc.querySelector('hairpin');
        if (!hp) return { ok: false, detail: 'no hairpin created' };
        const mi = [...doc.querySelectorAll('measure')].indexOf(hp.closest('measure'));
        const ts = hp.getAttribute('tstamp');
        return mi === 1 && ts === '1'
          ? { ok: true }
          : { ok: false, detail: 'measureIdx=' + mi + ' tstamp=' + ts + ' (expected measure 1, tstamp 1)' };
      })()` },
  ],
  hairpin_startAlignsToNote: [
    { name: 'hairpin start aligns to the M2 downbeat note glyph, not the bar line; @tstamp left at 1',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const doc = m.getDoc();
        const ms = doc.querySelectorAll('measure'); const m2 = ms[ms.length - 1];
        const note0Id = m2.querySelector('note').getAttribute('xml:id');
        const gById = (id) => [...document.querySelectorAll('#score svg g')].find((g) => g.getAttribute('id') === id);
        const noteG = gById(note0Id);
        const hpG = document.querySelector('#score svg g.hairpin');
        const m2g = [...document.querySelectorAll('#score svg g.measure')].pop();
        if (!noteG || !hpG || !m2g) return { ok: false, detail: 'missing rendered note/hairpin/measure' };
        const noteLeft = noteG.getBoundingClientRect().left;
        const hpLeft = hpG.getBoundingClientRect().left;
        const barLeft = m2g.getBoundingClientRect().left;
        const ts = m.serialize({ hejiEnabled: false }).match(/<hairpin[^>]*\\btstamp="([^"]*)"/);
        const alignedToNote = Math.abs(hpLeft - noteLeft) < 12;
        const offBarline = hpLeft > barLeft + 5;
        const tstampKept = ts && ts[1] === '1';
        return alignedToNote && offBarline && tstampKept
          ? { ok: true }
          : { ok: false, detail: 'hpLeft=' + Math.round(hpLeft) + ' noteLeft=' + Math.round(noteLeft) + ' barLeft=' + Math.round(barLeft) + ' tstamp=' + (ts ? ts[1] : 'none') };
      })()` },
  ],
  /* ── Sustain pedal ─────────────────────────────────────────── */
  pedal_down_and_up: [
    { name: 'M_1 has <pedal dir="down" tstamp≈1 staff="2"> and <pedal dir="up" tstamp≈2 staff="2"> siblings',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const peds = [...m.getDoc().querySelectorAll('measure > pedal')];
        const down = peds.filter(p => p.getAttribute('dir') === 'down');
        const up = peds.filter(p => p.getAttribute('dir') === 'up');
        if (peds.length !== 2 || down.length !== 1 || up.length !== 1)
          return { ok: false, detail: 'pedals=' + peds.length + ' down=' + down.length + ' up=' + up.length };
        const dts = parseFloat(down[0].getAttribute('tstamp') ?? '0');
        const uts = parseFloat(up[0].getAttribute('tstamp') ?? '0');
        const staffOk = down[0].getAttribute('staff') === '2' && up[0].getAttribute('staff') === '2';
        return (Math.abs(dts - 1) < 0.01 && Math.abs(uts - 2) < 0.01 && staffOk)
          ? { ok: true } : { ok: false, detail: 'downTs=' + dts + ' upTs=' + uts + ' staffOk=' + staffOk };
      })()` },
    { name: 'rendered SVG shows a Verovio pedal element (g.pedal)',
      expr: `(() => {
        const peds = document.querySelectorAll('g.pedal');
        return peds.length >= 1 ? { ok: true } : { ok: false, detail: 'g.pedal count=' + peds.length };
      })()` },
    { name: 'buildPedalEvents emits down@0ms and up@500ms (quarter @120bpm)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const pe = window.__hkl_composer.buildPedalEvents(m);
        if (pe.length !== 2) return { ok: false, detail: 'count=' + pe.length };
        const down = pe.find(e => e.dir === 'down');
        const up = pe.find(e => e.dir === 'up');
        if (!down || !up) return { ok: false, detail: 'dirs=' + JSON.stringify(pe.map(e => e.dir)) };
        return (Math.abs(down.atMs - 0) < 1 && Math.abs(up.atMs - 500) < 1)
          ? { ok: true } : { ok: false, detail: 'down=' + down.atMs + ' up=' + up.atMs };
      })()` },
    { name: 'starting playback between down(0ms) and up(500ms) seeds a synthetic down@0',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        /* startMs=250 lands between the pedal-down (beat 1 = 0ms) and pedal-up
           (beat 2 = 500ms): the down is windowed out, so a synthetic down@0
           must be seeded and the up shifted to 250ms. */
        const pe = window.__hkl_composer.buildPedalEvents(m, 250);
        if (pe.length !== 2) return { ok: false, detail: 'count=' + pe.length + ' ' + JSON.stringify(pe) };
        const downFirst = pe[0].dir === 'down' && Math.abs(pe[0].atMs - 0) < 1;
        const upShifted = pe[1].dir === 'up' && Math.abs(pe[1].atMs - 250) < 1;
        return (downFirst && upShifted)
          ? { ok: true } : { ok: false, detail: JSON.stringify(pe) };
      })()` },
  ],
  pedal_toggle_off: [
    { name: 'no <pedal> remains after pressing Shift+P twice at the same moment',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const peds = m.getDoc().querySelectorAll('measure > pedal');
        return peds.length === 0 ? { ok: true } : { ok: false, detail: 'count=' + peds.length };
      })()` },
  ],
  pedal_survives_note_delete: [
    { name: 'pedal-down at beat 1 survives deletion of note2',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const peds = [...m.getDoc().querySelectorAll('measure > pedal')];
        const down = peds.filter(p => p.getAttribute('dir') === 'down');
        if (down.length !== 1) return { ok: false, detail: 'down=' + down.length + ' total=' + peds.length };
        const ts = parseFloat(down[0].getAttribute('tstamp') ?? '0');
        return Math.abs(ts - 1) < 0.01 ? { ok: true } : { ok: false, detail: 'tstamp=' + ts };
      })()` },
  ],
  pedal_layer_enter: [
    { name: 'cursorMode is "pedal" after cycling past V4',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'pedal'
          ? { ok: true } : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
    { name: 'pedal cursor stops: one per pedal mark, no placeholder where an onset carries a mark (2 stops)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        const n = s.pedalCursor?.stops?.length ?? 0;
        /* beat1 (note1 onset carries pedal-down) + beat2 (note2 onset carries pedal-up) → 2. */
        return n === 2 ? { ok: true } : { ok: false, detail: 'stops=' + n };
      })()` },
    { name: 'voice indicator shows P',
      expr: `(() => {
        const v = document.getElementById('voiceIndicator');
        return v && v.textContent === 'P' ? { ok: true } : { ok: false, detail: 'indicator=' + (v?.textContent) };
      })()` },
  ],
  pedal_layer_delete: [
    { name: 'pedal-down at beat 1 deleted; only the up@beat2 remains',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const peds = [...m.getDoc().querySelectorAll('measure > pedal')];
        if (peds.length !== 1) return { ok: false, detail: 'count=' + peds.length };
        return peds[0].getAttribute('dir') === 'up'
          ? { ok: true } : { ok: false, detail: 'dir=' + peds[0].getAttribute('dir') };
      })()` },
    { name: 'still in pedal layer (a mark remains)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'pedal'
          ? { ok: true } : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
  ],
  /* ── Expressive text ───────────────────────────────────────── */
  exprtext_create: [
    { name: 'M_1 has a <dir tstamp≈1 place="between"> (the gap of the grand staff) with italic "dolce"',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const dirs = [...m.getDoc().querySelectorAll('measure > dir')];
        if (dirs.length !== 1) return { ok: false, detail: 'dir count=' + dirs.length };
        const d = dirs[0];
        const ts = parseFloat(d.getAttribute('tstamp') ?? '0');
        const text = (d.textContent ?? '').trim();
        const rend = d.querySelector('rend[fontstyle="italic"]');
        const placeOk = d.getAttribute('place') === 'between';   /* policy: the piano's upper staff → the gap */
        return (Math.abs(ts - 1) < 0.01 && text === 'dolce' && !!rend && placeOk)
          ? { ok: true } : { ok: false, detail: 'ts=' + ts + ' text=' + text + ' italic=' + !!rend + ' place=' + d.getAttribute('place') };
      })()` },
    { name: 'modal closed after submit',
      expr: `(() => {
        const dlg = document.getElementById('textEntryDialog');
        return dlg && !dlg.open ? { ok: true } : { ok: false, detail: 'open=' + dlg?.open };
      })()` },
    { name: 'rendered SVG shows a Verovio dir element (g.dir)',
      expr: `(() => {
        const n = document.querySelectorAll('g.dir');
        return n.length >= 1 ? { ok: true } : { ok: false, detail: 'g.dir count=' + n.length };
      })()` },
  ],
  exprtext_italicOff: [
    { name: 'italic-off <dir> stores fontstyle=normal (renders non-italic, not Verovio default italic)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const dir = m.getDoc().querySelector('measure > dir');
        if (!dir) return { ok: false, detail: 'no dir' };
        const rend = dir.querySelector('rend');
        if (!rend) return { ok: false, detail: 'no rend (plain text would render italic)' };
        return rend.getAttribute('fontstyle') === 'normal' && !dir.querySelector('rend[fontstyle="italic"]')
          ? { ok: true }
          : { ok: false, detail: 'fontstyle=' + rend.getAttribute('fontstyle') };
      })()` },
  ],
  exprtext_edit: [
    { name: 'still ONE <dir>, text updated to "arco" (not italic this time)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const dirs = [...m.getDoc().querySelectorAll('measure > dir')];
        if (dirs.length !== 1) return { ok: false, detail: 'count=' + dirs.length };
        const text = (dirs[0].textContent ?? '').trim();
        return text === 'arco' ? { ok: true } : { ok: false, detail: 'text=' + text };
      })()` },
  ],
  exprtext_delete: [
    { name: 'no <dir> remains after empty submit',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const dirs = m.getDoc().querySelectorAll('measure > dir');
        return dirs.length === 0 ? { ok: true } : { ok: false, detail: 'count=' + dirs.length };
      })()` },
  ],
  exprtext_layer_delete: [
    { name: 'entered expression mode (measure has the dir)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'expr' ? { ok: true } : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
    { name: '<dir> deleted from the expression layer via Backspace',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const dirs = m.getDoc().querySelectorAll('measure > dir');
        return dirs.length === 0 ? { ok: true } : { ok: false, detail: 'count=' + dirs.length };
      })()` },
  ],
  /* ── Tempo ──────────────────────────────────────────────────── */
  tempo_instant_retimes: [
    /* PDF print normalization (save.ts normalizePageForPrint): Verovio makes a
     * tempo bold only through its embedded stylesheet, which svg-to-pdfkit
     * ignores — the export printed every tempo regular until 2026-09-05. The
     * computed weight must land on the text run as font-weight="bold"; a plain
     * run (page header) must come out "normal", not inherit bold. */
    { name: 'print normalization inlines the tempo stylesheet bold as font-weight=bold',
      expr: `(async () => {
        const h = window.__hkl_composer;
        const mod = await import('/composer/src/save.ts');
        const pages = h.renderer.mountAllPages();
        const live = pages.find(p => p.querySelector('g.tempo'));
        if (!live) return { ok: false, detail: 'no g.tempo on any page' };
        const leaf = (root, sel) => [...root.querySelectorAll(sel)].find(t => t.childElementCount === 0) || null;
        const liveRun = leaf(live, 'g.tempo tspan');
        if (!liveRun) return { ok: false, detail: 'no tempo text run' };
        if (liveRun.getAttribute('font-weight')) return { ok: false, detail: 'live run already carries font-weight (premise changed)' };
        if (getComputedStyle(liveRun).fontWeight !== '700') return { ok: false, detail: 'live tempo not bold: ' + getComputedStyle(liveRun).fontWeight };
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute; left:-100000px; top:0; visibility:hidden';
        document.body.appendChild(host);
        try {
          const clone = live.cloneNode(true);
          host.appendChild(clone);
          mod.normalizePageForPrint(host, clone);
          const run = leaf(clone, 'g.tempo tspan');
          const w = run && run.getAttribute('font-weight');
          if (w !== 'bold') return { ok: false, detail: 'tempo run font-weight=' + w };
          const plain = leaf(clone, 'g.pgHead tspan');
          if (plain && plain.getAttribute('font-weight') !== 'normal') return { ok: false, detail: 'pgHead run font-weight=' + plain.getAttribute('font-weight') };
          return { ok: true, detail: 'tempo bold; pgHead ' + (plain ? plain.getAttribute('font-weight') : 'absent') };
        } finally { host.remove(); }
      })()` },
    { name: 'M_1 has <tempo mm="240" tstamp≈1>',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ts = [...m.getDoc().querySelectorAll('measure > tempo')];
        if (ts.length !== 1) return { ok: false, detail: 'count=' + ts.length };
        const mm = ts[0].getAttribute('mm');
        const t = parseFloat(ts[0].getAttribute('tstamp') ?? '0');
        return (mm === '240' && Math.abs(t - 1) < 0.01)
          ? { ok: true } : { ok: false, detail: 'mm=' + mm + ' tstamp=' + t };
      })()` },
    { name: '2nd quarter onset retimed to ~250ms (240bpm) not 500ms (120bpm)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const evs = window.__hkl_composer.buildPlayback(m).filter(e => e.notes.length > 0);
        if (evs.length < 2) return { ok: false, detail: 'events=' + evs.length };
        return Math.abs(evs[1].atMs - 250) < 5
          ? { ok: true } : { ok: false, detail: 'atMs=' + evs[1].atMs };
      })()` },
  ],
  tempo_gradual_rit: [
    { name: 'M_1 has <tempo data-hkl-gradual="rit"> "molto rit." at beat 2 (intensity from text)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ts = [...m.getDoc().querySelectorAll('measure > tempo')].filter(t => t.getAttribute('data-hkl-gradual') === 'rit');
        if (ts.length !== 1) return { ok: false, detail: 'rit count=' + ts.length };
        const txt = (ts[0].textContent ?? '').trim();
        const t = parseFloat(ts[0].getAttribute('tstamp') ?? '0');
        return (txt.includes('molto') && Math.abs(t - 2) < 0.01)
          ? { ok: true } : { ok: false, detail: 'text=' + txt + ' tstamp=' + t };
      })()` },
    { name: 'gradual tempo text is italic AND non-bold (rend fontstyle=italic + fontweight=normal)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rend = m.getDoc().querySelector('tempo[data-hkl-gradual="rit"] rend');
        if (!rend) return { ok: false, detail: 'no <rend> in gradual tempo' };
        return rend.getAttribute('fontstyle') === 'italic' && rend.getAttribute('fontweight') === 'normal'
          ? { ok: true }
          : { ok: false, detail: 'fontstyle=' + rend.getAttribute('fontstyle') + ' fontweight=' + rend.getAttribute('fontweight') };
      })()` },
    { name: '3rd quarter onset slowed past the constant-tempo 1000ms by the rit',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const evs = window.__hkl_composer.buildPlayback(m).filter(e => e.notes.length > 0);
        if (evs.length < 3) return { ok: false, detail: 'events=' + evs.length };
        /* beats 1/2 are before the rit (≈0 / 500ms); beat 3 is inside it → > 1000. */
        return evs[2].atMs > 1010
          ? { ok: true } : { ok: false, detail: 'beat3 atMs=' + evs[2].atMs };
      })()` },
  ],
  tempo_layer_delete: [
    { name: 'entered the tempo layer (↑ from V1)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'tempo' ? { ok: true } : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
    { name: 'beat-2 <tempo> deleted via Backspace (initial m1 tempo remains)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ts = [...m.getDoc().querySelectorAll('measure > tempo')];
        const atBeat2 = ts.filter(t => Math.abs(parseFloat(t.getAttribute('tstamp') ?? '0') - 2) < 0.01);
        return atBeat2.length === 0 ? { ok: true } : { ok: false, detail: 'beat2 tempo count=' + atBeat2.length };
      })()` },
  ],
  tempo_mm_shown: [
    { name: 'metronome is a SMuFL <rend glyph.auth="smufl"> + " = 120"; @mm=120; flag set',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getDoc().querySelector('measure > tempo');
        if (!t) return { ok: false, detail: 'no tempo' };
        const rend = [...t.children].find(c => c.localName === 'rend' && c.getAttribute('glyph.auth') === 'smufl');
        const txt = (t.textContent ?? '');
        const ok = !!rend && (rend.textContent ?? '').length > 0 && txt.includes('( ') === false
          && txt.includes('= 120)') && txt.includes('(')
          && t.getAttribute('mm') === '120' && t.getAttribute('data-hkl-mm-shown') === 'true';
        return ok ? { ok: true } : { ok: false, detail: 'rend=' + !!rend + ' txt="' + txt + '" mm=' + t.getAttribute('mm') + ' flag=' + t.getAttribute('data-hkl-mm-shown') };
      })()` },
  ],
  tempo_mm_hidden: [
    { name: 'text is bare "Allegro" (no metronome); @mm=120 still stored; no flag',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getDoc().querySelector('measure > tempo');
        if (!t) return { ok: false, detail: 'no tempo' };
        const txt = (t.textContent ?? '').trim();
        return (txt === 'Allegro' && t.getAttribute('mm') === '120' && t.getAttribute('data-hkl-mm-shown') === null)
          ? { ok: true } : { ok: false, detail: 'text="' + txt + '" mm=' + t.getAttribute('mm') + ' flag=' + t.getAttribute('data-hkl-mm-shown') };
      })()` },
  ],
  tempo_dotted_beat: [
    { name: '<tempo mm.unit="4" mm.dots="1"> (dotted quarter); SMuFL rend has the augmentation dot',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getDoc().querySelector('measure > tempo');
        if (!t) return { ok: false, detail: 'no tempo' };
        const rend = [...t.children].find(c => c.localName === 'rend' && c.getAttribute('glyph.auth') === 'smufl');
        const hasDot = !!rend && (rend.textContent ?? '').includes(String.fromCodePoint(0xECB7));
        return (t.getAttribute('mm.unit') === '4' && t.getAttribute('mm.dots') === '1' && hasDot)
          ? { ok: true } : { ok: false, detail: 'unit=' + t.getAttribute('mm.unit') + ' dots=' + t.getAttribute('mm.dots') + ' hasDot=' + hasDot };
      })()` },
  ],
  expr_place_toggle: [
    { name: 'dynamic @place ends "above" after Ctrl+↓ then Ctrl+↑',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const d = m.getDoc().querySelector('measure > dynam');
        if (!d) return { ok: false, detail: 'no dynam' };
        return d.getAttribute('place') === 'above'
          ? { ok: true } : { ok: false, detail: 'place=' + d.getAttribute('place') };
      })()` },
  ],
  expr_place_voicemode: [
    { name: 'Ctrl+↓ from voice mode writes @place="between" on the grand staff (the gap); still in voice mode',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const d = m.getDoc().querySelector('measure > dynam');
        if (!d) return { ok: false, detail: 'no dynam' };
        const mode = window.__hkl_composer.inputState().cursorMode;
        return (d.getAttribute('place') === 'between' && mode === 'voice')
          ? { ok: true } : { ok: false, detail: 'place=' + d.getAttribute('place') + ' mode=' + mode };
      })()` },
  ],
  expr_dynamicInsertBetweenOnGrandStaff: [
    { name: 'a live-inserted dynamic on the grand-staff upper staff is @place="between" and centred in the gap',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const el = [...doc.querySelectorAll('dynam')].find((e) => e.textContent.trim() === 'p');
        if (!el) return { ok: false, detail: 'no <dynam> p in the model' };
        if (el.getAttribute('place') !== 'between' || el.getAttribute('staff') !== '1') return { ok: false, detail: 'place=' + el.getAttribute('place') + ' staff=' + el.getAttribute('staff') };
        const meas = document.querySelector('#score g.measure');
        const rows = {};
        for (const st of meas.querySelectorAll(':scope > g.staff')) {
          const ys = [...st.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect().top);
          rows[st.getAttribute('data-n')] = { top: Math.min(...ys), bot: Math.max(...ys) };
        }
        const d = document.querySelector('#score g.dynam');
        if (!d || !rows[1] || !rows[2]) return { ok: false, detail: 'dynam=' + !!d + ' rows=' + JSON.stringify(rows) };
        const b = d.getBoundingClientRect(); const cy = b.top + b.height / 2;
        const mid = (rows[1].bot + rows[2].top) / 2, space = (rows[1].bot - rows[1].top) / 4;
        return Math.abs(cy - mid) <= 0.5 * space ? { ok: true, detail: 'cy-mid=' + (cy - mid).toFixed(1) + 'px' } : { ok: false, detail: 'cy=' + cy + ' mid=' + mid + ' space=' + space };
      })()` },
  ],
  expr_dynamicInsertBelowOnSingleStaff: [
    { name: 'a live-inserted dynamic on a one-staff instrument is @place="below" at dynamDist under its staff',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const el = [...doc.querySelectorAll('dynam')].find((e) => e.textContent.trim() === 'p');
        if (!el) return { ok: false, detail: 'no <dynam> p in the model' };
        if (el.getAttribute('place') !== 'below' || el.getAttribute('staff') !== '3') return { ok: false, detail: 'place=' + el.getAttribute('place') + ' staff=' + el.getAttribute('staff') };
        const meas = document.querySelector('#score g.measure');
        const st = meas.querySelector(':scope > g.staff[data-n="3"]');
        const d = document.querySelector('#score g.dynam[data-staff="3"]');
        if (!st || !d) return { ok: false, detail: 'staff3=' + !!st + ' dynam=' + !!d };
        const ys = [...st.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect().top);
        const bot = Math.max(...ys), space = (bot - Math.min(...ys)) / 4;
        const gap = (d.getBoundingClientRect().top - bot) / space;
        /* dynamDist 4.5 → the glyph top 1.2 spaces under the staff (architecture doc); a quarter space of slack. */
        return gap >= 0.95 && gap <= 1.45 ? { ok: true, detail: 'gap=' + gap.toFixed(2) + ' spaces' } : { ok: false, detail: 'gap=' + gap.toFixed(2) + ' spaces' };
      })()` },
  ],
  expr_loadNormalizesMarkPlaces: [
    { name: 'a load rewrites @place by instrument shape',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const byId = (id) => [...doc.querySelectorAll('dynam, hairpin, dir')].find((e) => e.getAttribute('xml:id') === id);
        const want = { 'd-norm-rh': ['between', '1'], 'd-norm-vla': ['below', '3'], 'd-norm-lh': ['between', '1'], 'h-norm-rh': ['between', '1'], 'dir-norm-vla': ['above', '3'] };
        const bad = [];
        for (const [id, [place, staff]] of Object.entries(want)) {
          const e = byId(id);
          if (!e) { bad.push(id + ': missing'); continue; }
          if (e.getAttribute('place') !== place || e.getAttribute('staff') !== staff) bad.push(id + ': place=' + e.getAttribute('place') + ' staff=' + e.getAttribute('staff') + ' want ' + place + '/' + staff);
        }
        return bad.length ? { ok: false, detail: bad.join('; ') } : { ok: true };
      })()` },
  ],
};
