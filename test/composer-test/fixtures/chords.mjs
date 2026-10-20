// Composer test fixtures — chords.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

/* C-E-G triad as a chord. Pitches: C4 at (-4,-2), E4 at (1,0), G4 at (0,1).
   After insertChordAtCursor the cursor advances PAST the chord (to past-end
   here) — this matches the post-entry position a real user faces. The
   chord-internal selection accepts both "cursor at chord" (flat[cursor])
   AND "cursor just past chord" (flat[cursor-1]), so no manual setCursor
   here. */
const CHORD_CEG_THEN_A = `
  m.setCursor(0, 1);
  m.insertChordAtCursor({
    notes: [
      { q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888888', velocity: 80 },
      { q:  1, r:  0, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888888', velocity: 80 },
      { q:  0, r:  1, pname: 'g', accid: '', oct: 4, midi: 67, colorHex: '#888888', velocity: 80 },
    ],
    duration: '4', dots: 0,
  });
`;

export const FIXTURES = {

  /* ── Chord-internal selection + SC transpose + tie-target + refNote ─ */
  /* Alt+Up with no selection on a chord → bass note selected (noteIndex 0). */
  chord_internal_sel_bottom_via_up: {
    setup: CHORD_CEG_THEN_A,
    setupKeys: [{ key: 'ArrowUp', alt: true }],
  },
  /* Alt+Down with no selection on a chord → top note selected (noteIndex N-1). */
  chord_internal_sel_top_via_down: {
    setup: CHORD_CEG_THEN_A,
    setupKeys: [{ key: 'ArrowDown', alt: true }],
  },
  /* Two Alt+Ups: first enters at bottom (0), second increments to 1. */
  chord_internal_sel_increment: {
    setup: CHORD_CEG_THEN_A,
    setupKeys: [
      { key: 'ArrowUp', alt: true },
      { key: 'ArrowUp', alt: true },
    ],
  },
  /* Two Alt+Downs: first enters at top (N-1=2), second decrements to 1. */
  chord_internal_sel_decrement: {
    setup: CHORD_CEG_THEN_A,
    setupKeys: [
      { key: 'ArrowDown', alt: true },
      { key: 'ArrowDown', alt: true },
    ],
  },
  /* Alt+Up to select bottom (C at q=-4, r=-2), Alt+Right hops +(7,-4). */
  chord_internal_sc_transpose: {
    setup: CHORD_CEG_THEN_A,
    setupKeys: [
      { key: 'ArrowUp', alt: true },
      { key: 'ArrowRight', alt: true },
    ],
  },
  /* Tie on a chord-internal note → only that note carries the forward
     tie intent. We follow the chord with an identical chord so the partner
     resolves: C-E-G then C-E-G, Alt+Up (selects bass C4), '='. */
  chord_internal_tie_single_note: {
    setup: `
      m.setCursor(0, 1);
      const notes = [
        { q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888888', velocity: 80 },
        { q:  1, r:  0, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888888', velocity: 80 },
        { q:  0, r:  1, pname: 'g', accid: '', oct: 4, midi: 67, colorHex: '#888888', velocity: 80 },
      ];
      m.insertChordAtCursor({ notes, duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes, duration: '4', dots: 0 });
      /* Cursor at first chord. flat[0] = M_1 wrapper, flat[1] = chord1,
         flat[2] = chord2. Park at flat[1] (= cursor 1, "past wrapper, at chord1"). */
      m.setCursor(1, 1);
    `,
    setupKeys: [
      { key: 'ArrowUp', alt: true },
      '=',
    ],
  },
  /* ArrowLeft after Alt+Up: cursor moves AND the chord-internal selection
     is cleared. Codifies the "cursor movement clears chordInternalSel"
     invariant documented on ChordInternalSel. */
  arrow_clears_chord_internal_sel: {
    setup: CHORD_CEG_THEN_A,
    setupKeys: [
      { key: 'ArrowUp', alt: true },
      'ArrowLeft',
    ],
  },
  /* btnRewind click after Alt+Up: cursor returns to 0 AND the chord-internal
     selection is cleared. The rewind handler in main.ts calls
     clearChordInternalSel() before model.setCursor(0). The assertion fires
     the click itself (no rewind keybinding exists). */
  rewind_clears_chord_internal_sel: {
    setup: CHORD_CEG_THEN_A,
    setupKeys: [
      { key: 'ArrowUp', alt: true },
    ],
  },
  /* Bare-note Alt+Left: SC-transposes the single note without requiring a
     prior Alt+Up selection step (auto-selects on the only note). The bare
     A3 at (0, 0) hops to (-7, 4). Auto-selection becomes visible (sel set
     to the bare note's id). */
  alt_select_bare_note_left: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888888', velocity: 80 }],
        duration: '4', dots: 0,
      });
    `,
    setupKeys: [{ key: 'ArrowLeft', alt: true }],
  },
  /* Alt+Up on a bare note → activates chord-internal selection on the
     only note (noteIndex 0). Subsequent Backspace deletes the whole bare
     note (it's a top-level <note>, not a chord child) — selection clears. */
  alt_select_bare_note_up_backspace: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888888', velocity: 80 }],
        duration: '4', dots: 0,
      });
    `,
    setupKeys: [
      { key: 'ArrowUp', alt: true },
      'Backspace',
    ],
  },
  /* Chord-extend in INS mode: select bass C of C-E-G via Alt+Up, then
     append a held note above G (at q=4, r=1 → coordToMidi = 80). Cursor
     does NOT advance; chord now has 4 notes in MIDI-ascending order;
     selection migrates to the lowest-MIDI of the just-added notes (the
     single added note in this case). */
  chord_extend_insert: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        notes: [
          { q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888888', velocity: 80 },
          { q:  1, r:  0, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888888', velocity: 80 },
          { q:  0, r:  1, pname: 'g', accid: '', oct: 4, midi: 67, colorHex: '#888888', velocity: 80 },
        ],
        duration: '4', dots: 0,
      });
      window.__bridgeMock.sendHeldKeys([
        { q: 4, r: 1, pname: 'b', accid: '', oct: 4, midi: 80, colorHex: '#aa3344', velocity: 80 },
      ]);
    `,
    setupKeys: [
      { key: 'ArrowUp', alt: true },
      '5',
    ],
  },
  /* Chord-extend promotes a bare note to a chord. Bare A3 at (0, 0); held
     keys at (1, 0) [E-ish, coordMidi 61] and (0, 1) [G-ish, coordMidi 64].
     After append the layer should contain a <chord> wrapper (not the bare
     note) with three <note> children sorted ascending by coordToMidi:
       A3 (57), held1 (61), held2 (64). The bare note's xml:id is preserved
     on its <note> child. Selection migrates to the lowest-MIDI of the
     added notes (the (1, 0) coord at midi 61). */
  chord_extend_bare_to_chord: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888888', velocity: 80 }],
        duration: '4', dots: 0,
      });
      /* Stash the bare note's xml:id so the assertion can verify the
         original element survived under the new chord wrapper. */
      window.__test_bareNoteId = m.getDoc().querySelector('note').getAttribute('xml:id');
      window.__bridgeMock.sendHeldKeys([
        { q: 1, r: 0, pname: 'e', accid: '', oct: 4, midi: 61, colorHex: '#aa3344', velocity: 80 },
        { q: 0, r: 1, pname: 'g', accid: '', oct: 4, midi: 64, colorHex: '#44aa33', velocity: 80 },
      ]);
    `,
    setupKeys: [
      { key: 'ArrowUp', alt: true },
      '5',
    ],
  },
  /* Duplicate (q, r) is silently skipped. Held key matches C's coords in
     the C-E-G chord → no new note added; chord still has 3 notes;
     selection preserved on the original bass C. */
  chord_extend_duplicate_blocked: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        notes: [
          { q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888888', velocity: 80 },
          { q:  1, r:  0, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888888', velocity: 80 },
          { q:  0, r:  1, pname: 'g', accid: '', oct: 4, midi: 67, colorHex: '#888888', velocity: 80 },
        ],
        duration: '4', dots: 0,
      });
      window.__bridgeMock.sendHeldKeys([
        { q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888888', velocity: 80 },
      ]);
    `,
    setupKeys: [
      { key: 'ArrowUp', alt: true },
      '5',
    ],
  },
  /* Backspace on a chord-internal selection collapses a 2-note chord
     down to a bare note. Start with a 2-note C-E chord; Alt+Up selects
     bass C; Backspace removes C; the surviving E is promoted to a bare
     <note> with the chord's @dur/@dots transferred onto it, and selection
     migrates to the survivor's xml:id. */
  backspace_collapse_chord: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        notes: [
          { q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888888', velocity: 80 },
          { q:  1, r:  0, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888888', velocity: 80 },
        ],
        duration: '4', dots: 0,
      });
      /* Stash the E-note's xml:id (the survivor we expect). */
      window.__test_survivorId = (() => {
        const chord = m.getDoc().querySelector('chord');
        const notes = Array.from(chord.children).filter(c => c.localName === 'note');
        /* MIDI-ascending: notes[0] = C bass, notes[1] = E top. The survivor
           after Alt+Up + Backspace is E (top). */
        return notes[1].getAttribute('xml:id');
      })();
    `,
    setupKeys: [
      { key: 'ArrowUp', alt: true },
      'Backspace',
    ],
  },
};

export const ASSERTIONS = {
  /* Chord-internal selection + SC transpose + tie targeting. */
  chord_internal_sel_bottom_via_up: [
    { name: 'chord-internal selection is set, at noteIndex 0 (bass)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        const sel = s.chordInternalSel;
        if (!sel) return { ok: false, detail: 'no chordInternalSel' };
        const allNotes = Array.from(window.__hkl_composer.model.getDoc().querySelectorAll('note'));
        const note = allNotes.find(n => n.getAttribute('xml:id') === sel.noteId);
        if (!note || note.parentElement?.localName !== 'chord')
          return { ok: false, detail: 'note not in chord' };
        const notes = Array.from(note.parentElement.children)
          .filter(c => c.localName === 'note');
        const idx = notes.indexOf(note);
        return idx === 0
          ? { ok: true }
          : { ok: false, detail: 'noteIndex=' + idx };
      })()` },
  ],
  chord_internal_sel_top_via_down: [
    { name: 'chord-internal selection at top note (index 2)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        const sel = s.chordInternalSel;
        if (!sel) return { ok: false, detail: 'no chordInternalSel' };
        const allNotes = Array.from(window.__hkl_composer.model.getDoc().querySelectorAll('note'));
        const note = allNotes.find(n => n.getAttribute('xml:id') === sel.noteId);
        if (!note || note.parentElement?.localName !== 'chord')
          return { ok: false, detail: 'note not in chord' };
        const notes = Array.from(note.parentElement.children)
          .filter(c => c.localName === 'note');
        const idx = notes.indexOf(note);
        return idx === 2
          ? { ok: true }
          : { ok: false, detail: 'noteIndex=' + idx };
      })()` },
  ],
  chord_internal_sel_increment: [
    { name: 'second Alt+Up incremented selection to noteIndex 1',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        const sel = s.chordInternalSel;
        if (!sel) return { ok: false, detail: 'no chordInternalSel' };
        const allNotes = Array.from(window.__hkl_composer.model.getDoc().querySelectorAll('note'));
        const note = allNotes.find(n => n.getAttribute('xml:id') === sel.noteId);
        if (!note || note.parentElement?.localName !== 'chord')
          return { ok: false, detail: 'note not in chord' };
        const notes = Array.from(note.parentElement.children)
          .filter(c => c.localName === 'note');
        const idx = notes.indexOf(note);
        return idx === 1
          ? { ok: true }
          : { ok: false, detail: 'noteIndex=' + idx };
      })()` },
  ],
  chord_internal_sel_decrement: [
    { name: 'second Alt+Down decremented selection to noteIndex 1',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        const sel = s.chordInternalSel;
        if (!sel) return { ok: false, detail: 'no chordInternalSel' };
        const allNotes = Array.from(window.__hkl_composer.model.getDoc().querySelectorAll('note'));
        const note = allNotes.find(n => n.getAttribute('xml:id') === sel.noteId);
        if (!note || note.parentElement?.localName !== 'chord')
          return { ok: false, detail: 'note not in chord' };
        const notes = Array.from(note.parentElement.children)
          .filter(c => c.localName === 'note');
        const idx = notes.indexOf(note);
        return idx === 1
          ? { ok: true }
          : { ok: false, detail: 'noteIndex=' + idx };
      })()` },
  ],
  chord_internal_sc_transpose: [
    { name: 'bass note (was C4 at (-4,-2)) hopped to (+7,-4) → (3,-6)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const chord = m.getDoc().querySelector('chord');
        if (!chord) return { ok: false, detail: 'no chord' };
        const notes = Array.from(chord.children).filter(c => c.localName === 'note');
        /* After SC transpose, the chord re-sorts by MIDI ascending. The
           transposed bass (C4 → ?) keeps the same MIDI (= 60), so it stays
           at noteIndex 0 in the resorted chord (since C is now the lowest
           letter regardless of spelling). */
        const target = notes.find(n =>
          n.getAttribute('data-q') === '3' && n.getAttribute('data-r') === '-6');
        return target
          ? { ok: true }
          : { ok: false, detail: 'transposed note not found; notes=' +
              notes.map(n => '(' + n.getAttribute('data-q') + ',' + n.getAttribute('data-r') + ')').join(',') };
      })()` },
    { name: 'all three notes still in chord post-transpose',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const chord = m.getDoc().querySelector('chord');
        const notes = chord ? Array.from(chord.children).filter(c => c.localName === 'note') : [];
        return notes.length === 3
          ? { ok: true }
          : { ok: false, detail: 'note count=' + notes.length };
      })()` },
  ],
  alt_select_bare_note_left: [
    { name: 'bare A3 at (0,0) SC-hopped to (-7, 4)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = Array.from(m.getDoc().querySelectorAll('note'));
        if (notes.length !== 1) return { ok: false, detail: 'expected 1 note, got ' + notes.length };
        const n = notes[0];
        if (n.parentElement?.localName !== 'layer')
          return { ok: false, detail: 'note not bare; parent=' + n.parentElement?.localName };
        const q = n.getAttribute('data-q'), r = n.getAttribute('data-r');
        return (q === '-7' && r === '4')
          ? { ok: true }
          : { ok: false, detail: '(q,r)=(' + q + ',' + r + ')' };
      })()` },
    { name: 'auto-selection set on bare note (sel.noteId points at it)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        const sel = s.chordInternalSel;
        if (!sel) return { ok: false, detail: 'no chordInternalSel' };
        const allNotes = Array.from(window.__hkl_composer.model.getDoc().querySelectorAll('note'));
        const note = allNotes.find(n => n.getAttribute('xml:id') === sel.noteId);
        return note
          ? { ok: true }
          : { ok: false, detail: 'sel.noteId not found in doc' };
      })()` },
  ],
  alt_select_bare_note_up_backspace: [
    { name: 'bare note deleted (no notes in voice 1)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = m.getDoc().querySelectorAll('note');
        return notes.length === 0
          ? { ok: true }
          : { ok: false, detail: 'expected 0 notes, got ' + notes.length };
      })()` },
    { name: 'selection cleared after bare-note delete',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.chordInternalSel === null
          ? { ok: true }
          : { ok: false, detail: 'chordInternalSel still set' };
      })()` },
  ],
  arrow_clears_chord_internal_sel: [
    { name: 'ArrowLeft clears chordInternalSel set by Alt+Up',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.chordInternalSel === null
          ? { ok: true }
          : { ok: false, detail: 'chordInternalSel still set: ' + JSON.stringify(s.chordInternalSel) };
      })()` },
  ],
  rewind_clears_chord_internal_sel: [
    { name: 'btnRewind click clears chordInternalSel and parks cursor at 0',
      expr: `(() => {
        /* Pre-check: setupKeys (Alt+Up) should have set the sel. */
        const before = window.__hkl_composer.inputState().chordInternalSel;
        if (!before) return { ok: false, detail: 'pre-click: no chordInternalSel (Alt+Up failed)' };
        document.getElementById('btnRewind').click();
        const s = window.__hkl_composer.inputState();
        const cur = window.__hkl_composer.model.getCursor(1);
        if (s.chordInternalSel !== null)
          return { ok: false, detail: 'chordInternalSel still set after rewind: ' + JSON.stringify(s.chordInternalSel) };
        if (cur !== 0)
          return { ok: false, detail: 'cursor not at 0 after rewind: ' + cur };
        return { ok: true };
      })()` },
  ],
  chord_extend_insert: [
    { name: 'chord now has 4 notes',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const chord = m.getDoc().querySelector('chord');
        if (!chord) return { ok: false, detail: 'no chord' };
        const notes = Array.from(chord.children).filter(c => c.localName === 'note');
        return notes.length === 4
          ? { ok: true }
          : { ok: false, detail: 'note count=' + notes.length };
      })()` },
    { name: 'appended note at (4, 1) is present and last in MIDI-ascending order',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const chord = m.getDoc().querySelector('chord');
        const notes = Array.from(chord.children).filter(c => c.localName === 'note');
        const last = notes[notes.length - 1];
        const q = last.getAttribute('data-q'), r = last.getAttribute('data-r');
        return (q === '4' && r === '1')
          ? { ok: true }
          : { ok: false, detail: 'last note (q,r)=(' + q + ',' + r + ')' };
      })()` },
    { name: 'cursor did not advance (still at the chord)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const flat = m.flatChildren(1);
        const c = m.getCursor(1);
        const target = flat[c];
        return (target && target.localName === 'chord')
          ? { ok: true }
          : { ok: false, detail: 'flat[' + c + ']=' + (target ? target.localName : 'null') };
      })()` },
    { name: 'selection migrated to the newly-added note (q=4, r=1)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        const sel = s.chordInternalSel;
        if (!sel) return { ok: false, detail: 'no chordInternalSel' };
        const allNotes = Array.from(window.__hkl_composer.model.getDoc().querySelectorAll('note'));
        const note = allNotes.find(n => n.getAttribute('xml:id') === sel.noteId);
        if (!note) return { ok: false, detail: 'sel.noteId not found' };
        const q = note.getAttribute('data-q'), r = note.getAttribute('data-r');
        return (q === '4' && r === '1')
          ? { ok: true }
          : { ok: false, detail: 'sel note (q,r)=(' + q + ',' + r + ')' };
      })()` },
  ],
  chord_extend_bare_to_chord: [
    { name: 'bare note promoted to chord wrapper with 3 note children',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const chord = m.getDoc().querySelector('chord');
        if (!chord) return { ok: false, detail: 'no chord wrapper present' };
        const notes = Array.from(chord.children).filter(c => c.localName === 'note');
        return notes.length === 3
          ? { ok: true }
          : { ok: false, detail: 'chord note count=' + notes.length };
      })()` },
    { name: 'original bare note xml:id preserved inside the chord wrapper',
      expr: `(() => {
        const stashed = window.__test_bareNoteId;
        if (!stashed) return { ok: false, detail: 'no stashed id' };
        const m = window.__hkl_composer.model;
        const allNotes = Array.from(m.getDoc().querySelectorAll('note'));
        const note = allNotes.find(n => n.getAttribute('xml:id') === stashed);
        if (!note) return { ok: false, detail: 'note not found by stashed id' };
        return note.parentElement?.localName === 'chord'
          ? { ok: true }
          : { ok: false, detail: 'parent=' + note.parentElement?.localName };
      })()` },
    { name: 'chord wrapper carries @dur (transferred from the bare note)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const chord = m.getDoc().querySelector('chord');
        const dur = chord?.getAttribute('dur');
        return dur === '4'
          ? { ok: true }
          : { ok: false, detail: 'chord dur=' + dur };
      })()` },
    { name: 'no <note> element at layer level (all wrapped in chord)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const layer = m.getDoc().querySelector('layer');
        const bareNotes = Array.from(layer.children).filter(c => c.localName === 'note');
        return bareNotes.length === 0
          ? { ok: true }
          : { ok: false, detail: 'layer-level note count=' + bareNotes.length };
      })()` },
    { name: 'selection migrated to lowest-MIDI of added notes (q=1, r=0)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        const sel = s.chordInternalSel;
        if (!sel) return { ok: false, detail: 'no chordInternalSel' };
        const allNotes = Array.from(window.__hkl_composer.model.getDoc().querySelectorAll('note'));
        const note = allNotes.find(n => n.getAttribute('xml:id') === sel.noteId);
        if (!note) return { ok: false, detail: 'sel.noteId not found' };
        const q = note.getAttribute('data-q'), r = note.getAttribute('data-r');
        return (q === '1' && r === '0')
          ? { ok: true }
          : { ok: false, detail: 'sel note (q,r)=(' + q + ',' + r + ')' };
      })()` },
  ],
  chord_extend_duplicate_blocked: [
    { name: 'chord still has exactly 3 notes (duplicate blocked)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const chord = m.getDoc().querySelector('chord');
        const notes = chord ? Array.from(chord.children).filter(c => c.localName === 'note') : [];
        return notes.length === 3
          ? { ok: true }
          : { ok: false, detail: 'note count=' + notes.length };
      })()` },
    { name: 'no duplicate (q, r) cells in chord',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const chord = m.getDoc().querySelector('chord');
        const notes = Array.from(chord.children).filter(c => c.localName === 'note');
        const keys = notes.map(n => n.getAttribute('data-q') + ',' + n.getAttribute('data-r'));
        const dups = keys.filter((k, i) => keys.indexOf(k) !== i);
        return dups.length === 0
          ? { ok: true }
          : { ok: false, detail: 'duplicates=' + dups.join(';') };
      })()` },
  ],
  backspace_collapse_chord: [
    { name: 'chord collapsed to a bare note (no <chord> remains)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const chords = m.getDoc().querySelectorAll('chord');
        return chords.length === 0
          ? { ok: true }
          : { ok: false, detail: 'chord count=' + chords.length };
      })()` },
    { name: 'surviving bare note is the original E (at (1, 0))',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = Array.from(m.getDoc().querySelectorAll('note'));
        if (notes.length !== 1) return { ok: false, detail: 'expected 1 note, got ' + notes.length };
        const n = notes[0];
        const q = n.getAttribute('data-q'), r = n.getAttribute('data-r');
        return (q === '1' && r === '0')
          ? { ok: true }
          : { ok: false, detail: '(q,r)=(' + q + ',' + r + ')' };
      })()` },
    { name: 'survivor carries @dur (transferred from chord wrapper)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const n = m.getDoc().querySelector('note');
        return n?.getAttribute('dur') === '4'
          ? { ok: true }
          : { ok: false, detail: 'note dur=' + n?.getAttribute('dur') };
      })()` },
    { name: 'selection migrated to the surviving bare note (by stashed xml:id)',
      expr: `(() => {
        const stashed = window.__test_survivorId;
        if (!stashed) return { ok: false, detail: 'no stashed survivor id' };
        const s = window.__hkl_composer.inputState();
        const sel = s.chordInternalSel;
        if (!sel) return { ok: false, detail: 'no chordInternalSel' };
        return sel.noteId === stashed
          ? { ok: true }
          : { ok: false, detail: 'sel.noteId=' + sel.noteId + ' stashed=' + stashed };
      })()` },
  ],
  chord_internal_tie_single_note: [
    { name: 'only one note in the first chord carries forward tie state',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const chords = m.getDoc().querySelectorAll('chord');
        if (chords.length < 2) return { ok: false, detail: 'expected 2 chords, got ' + chords.length };
        const first = chords[0];
        const notes = Array.from(first.children).filter(c => c.localName === 'note');
        const withTie = notes.filter(n =>
          n.getAttribute('tie') === 'i' || n.getAttribute('tie') === 'm' ||
          n.hasAttribute('data-pending-tie'));
        return withTie.length === 1
          ? { ok: true }
          : { ok: false, detail: 'expected exactly 1 note tied in chord1, found ' + withTie.length };
      })()` },
  ],
};
