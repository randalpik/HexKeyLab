// Composer test fixtures — notation-commands.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

export const FIXTURES = {

  /* ── Barlines, hide rest, paren caut, articulations, etc. ── */
  /* ── Trills + tremolos ────────────────────────────────────── */

  /* Voice mode: Ctrl+T toggles a <trill> on the current note (cursor parked
     past the note → INS anchor resolves to it). */
  trill_voice: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'r', ctrl: true }],
    visualBaseline: 'trill_voice',
  },
  /* Selection of two notes a third apart (non-diatonic) → two-note tremolo
     (<fTrem beams=3>). */
  tremolo_select: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'c', accid: '', oct: 5, midi: 72, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 1, r: 0, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'r', ctrl: true },
    ],
    visualBaseline: 'tremolo',
  },
  /* Selection of two notes a diatonic step apart → collapse to one
     combined-duration note + <trill>. */
  trill_select_step: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'c', accid: '', oct: 5, midi: 72, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 3, r: -1, pname: 'd', accid: '', oct: 5, midi: 74, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'r', ctrl: true },
    ],
    visualBaseline: 'trill_select',
  },
  /* `]` toggles @right="dbl" on the cursor's current measure. */
  dblbar_toggle_on_m1_of_2: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);  /* mid-M_1 */
      m.appendMeasure();
    `,
    setupKeys: [{ key: ']' }],
  },
  /* Pressing `]` twice clears the marker (toggle semantics). */
  dblbar_toggle_off: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);
      m.appendMeasure();
    `,
    setupKeys: [{ key: ']' }, { key: ']' }],
  },
  /* `]` is a no-op on the last measure (final bar always wins). */
  dblbar_lastMeasure_noop: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);
    `,
    setupKeys: [{ key: ']' }],
  },
  /* `H` on a rest sets @visible="false". Cursor parked PAST the rest so
     flat[c] resolves to the rest (cursor-anchor rule). */
  hideRest_toggle_on: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'h' }],
  },
  /* Pressing H twice clears @visible. */
  hideRest_toggle_off: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'h' }, { key: 'h' }],
  },
  /* H on a non-rest element (note) is a no-op. */
  hideRest_onNote_noop: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'h' }],
  },
  /* P on a bare note sets @hkl-paren-caut. Visible @accid="n" in render. */
  parenCaut_bareNote_on: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'p' }],
  },
  /* P on a HEJI-decorated note (C#↓ in mode D) must keep the comma-arrow
     glyph (U+E2C3) AND add parens around it. Regression: I originally
     bypassed HEJI by writing <accid> child form. */
  parenCaut_preserves_heji: {
    setup: `
      m.setLayoutReq({ tuningMode: 'D' });
      m.setHejiEnabled(true);
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 1, r: 0, pname: 'c', accid: 's', oct: 4, midi: 61, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      r();
    `,
    setupKeys: [{ key: 'p' }],
  },
  /* P twice toggles off. */
  parenCaut_toggle_off: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'p' }, { key: 'p' }],
  },
  /* P on a chord (no alt-sel) sets flag on every chord note. */
  parenCaut_chord_all: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [
        { q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 },
        { q: -1, r: 1, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888', velocity: 80 },
        { q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 },
      ], duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'p' }],
  },
  /* P with chord-internal selection (Alt+↑ first) sets flag on only the bass note. */
  parenCaut_chord_singleViaAltSel: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [
        { q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 },
        { q: -1, r: 1, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888', velocity: 80 },
        { q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 },
      ], duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'ArrowUp', alt: true }, { key: 'p' }],
  },
  /* P on a rest is a no-op. */
  parenCaut_onRest_noop: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'p' }],
  },
  /* Ctrl+M at start of M_1 inserts a new measure at the front. */
  insertMeasure_atStart: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '1', dots: 0 });  /* fill M_1 */
      m.setCursor(0, 1);  /* park at boundary of M_1 */
    `,
    setupKeys: [{ key: 'm' }],
  },
  /* Ctrl+M mid-measure inserts after current measure. */
  insertMeasure_midMeasure: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);  /* mid-M_1 */
    `,
    setupKeys: [{ key: 'm' }],
  },
  /* REGRESSION: cursor at the first note (cursor=1, past flat[1]=note) is
     NOT a boundary — Ctrl+M must insert AFTER M_1, not before. */
  insertMeasure_atFirstNote_insertsAfter: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);  /* past the first note */
    `,
    setupKeys: [{ key: 'm' }],
  },
  /* Ctrl+M severs slurs that straddle the new measure. M_1 ends with a
     slurred note → M_2 starts with the slur destination; after Ctrl+M
     inserted BETWEEN them, the slur should be removed. */
  insertMeasure_breaksSlur: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      const flat = m.flatChildren(1);
      const notes = flat.filter(e => e.localName === 'note');
      const sid = notes[0].getAttribute('xml:id');
      const eid = notes[1].getAttribute('xml:id');
      const measure = notes[0].closest('measure');
      const slur = m.getDoc().createElementNS('http://www.music-encoding.org/ns/mei', 'slur');
      slur.setAttribute('startid', '#' + sid);
      slur.setAttribute('endid', '#' + eid);
      slur.setAttribute('data-voice', '1');
      slur.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:id', 's-fixture');
      measure.appendChild(slur);
      /* Park cursor at the M_1/M_2 boundary. measureBoundaryCursors is the
         authoritative set (tstamp-aligned); use it directly. */
      const boundary = m.measureBoundaryCursors(1).find(b =>
        m.getTickPositionAt(1, b) === m.measureTicks());
      m.setCursor(boundary, 1);
      r();
    `,
    setupKeys: [{ key: 'm' }],
  },
  /* Ctrl+M severs ties that span the new measure. Pre-insert: M_1 ends
     with an A4 tied to M_2's starting A4. Post-insert (M_2 = empty,
     A4 now lives in M_3), the tie can no longer realize. */
  insertMeasure_breaksTie: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      /* Mark the first A as wanting forward tie; normalize so the tie realizes. */
      const firstNote = m.getDoc().querySelector('note[pname="a"]');
      firstNote.setAttribute('data-pending-tie', 'true');
      window.__test.normalizeTies?.();  /* if a hook exists; else rely on next mutation */
      /* Force a normalize by touching the cursor. */
      m.setCursor(0, 1);
      r();
      const boundary = m.measureBoundaryCursors(1).find(b =>
        m.getTickPositionAt(1, b) === m.measureTicks());
      m.setCursor(boundary, 1);
    `,
    setupKeys: [{ key: 'm' }],
  },
  /* L on a bare note sets @stem.dir to opposite of rendered direction.
     flat[0] is the measure wrapper, flat[1] is the just-inserted note —
     park cursor there. */
  stemFlip_bareNote_freezes: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      r();
    `,
    setupKeys: [{ key: 'l' }],
  },
  /* L twice clears the @stem.dir (back to natural). */
  stemFlip_secondPress_unfreezes: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      r();
    `,
    setupKeys: [{ key: 'l' }, { key: 'l' }],
  },
  /* L on a note in a beam flips every member of the beam. Construct 4
     eighth notes in V1 (auto-beamed in 4/4). flat[1..4] are the notes. */
  stemFlip_beamGroup_allFlip: {
    setup: `
      m.setCursor(0, 1);
      for (const oct of [4, 4, 4, 4]) {
        m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct, midi: 69, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
      }
      m.setCursor(1, 1);  /* park on the first eighth */
      r();
    `,
    setupKeys: [{ key: 'l' }],
  },
  /* REGRESSION: when `/` has split the beam, L on a member of the FIRST
     sub-beam must only flip THAT sub-beam, not the whole pre-split run.
     Setup: 4 eighths, beam-break marker on the 3rd → 2+2 split. L on
     the 1st eighth should flip notes 1+2; notes 3+4 unaffected. */
  stemFlip_respectsBeamBreak: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) {
        m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
      }
      /* Manually set @hkl-beam-break on the 3rd note. */
      const notes = [...m.getDoc().querySelectorAll('layer > note')];
      notes[2].setAttribute('hkl-beam-break', 'true');
      m.setCursor(1, 1);  /* park on the 1st eighth */
      r();
    `,
    setupKeys: [{ key: 'l' }],
  },
  /* `/` at cursor=2 (between e2 and e3 of an 8-eighth measure) sets
     @hkl-beam-break on e3. After serialize, beams should be 2+2+4. */
  beamSplit_marksThird: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 8; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
      m.setCursor(2, 1);  /* between e2 and e3 */
      r();
    `,
    setupKeys: [{ key: '/' }],
  },
  /* Second `/` clears the marker. */
  beamSplit_toggleOff: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 8; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
      m.setCursor(2, 1);
      r();
    `,
    setupKeys: [{ key: '/' }, { key: '/' }],
  },
  /* REGRESSION: `/` placed AT a natural beat boundary should connect
     across the boundary (cross-beat beaming), not break (which is the
     default). Setup: 8 eighths in 4/4 → naturally 4+4. Placing the
     marker on note 5 (= start of beat 3) should merge the two beams
     into ONE beam of 8. */
  beamSplit_overridesBeatBoundary: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 8; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
      m.setCursor(4, 1);  /* between notes 4 and 5 (= start of M_1 beat 3 = the half-measure boundary) */
      r();
    `,
    setupKeys: [{ key: '/' }],
  },
  /* `/` is no-op when the upcoming element is a rest. */
  beamSplit_onRest_noop: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
      m.insertRestAtCursor({ duration: '8', dots: 0 });
      m.setCursor(1, 1);  /* between note and rest */
      r();
    `,
    setupKeys: [{ key: '/' }],
  },
  /* Articulations S/A/T/F/B add <artic> child to the current note. */
  artic_staccato_on_note: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);  /* park on the note */
    `,
    setupKeys: [{ key: 's' }],
  },
  artic_accent_on_note: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'a' }],
  },
  artic_tenuto_on_note: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 't' }],
  },
  artic_fermata_on_note: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'f' }],
  },
  artic_breath_on_note: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'b' }],
  },
  /* Breath-mark placement regressions (2026-10-17). The end-of-note tstamp
     was computed with the HEAD scoreDef's meter unit (sonata.hkc opens in cut
     time → every breath in the 4/4 finale landed at ~beat 3 instead of 4.95)
     and a tick walk that never descended into <tuplet>/<beam>, so an anchor
     inside a tuplet summed the whole layer. Head meter 2/2, measure 1 in 4/4,
     breath on its last quarter (keystroke path). */
  breath_endOfBarUsesEffectiveMeter: {
    setup: `
      m.setTimeSig(2, 2);
      m.appendMeasure();
      m.setMeterAt(1, 4, 4);
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      r();
    `,
    setupKeys: [{ key: 'b' }],
  },
  /* Breath on the LAST member of a triplet (quarter + 3 triplet eighths in
     4/4): the anchor is nested in <tuplet>, so the walk must descend and the
     tstamp is the tuplet's end (beat 3) minus 5% of one triplet eighth. */
  breath_onTupletMemberCountsNestedTicks: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'c', accid: '', oct: 5, midi: 72, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
      const last = m.getDoc().querySelector('tuplet > note:last-of-type');
      window.__breathProbe = { lastId: last?.getAttribute('xml:id') ?? null, toggle: m.toggleArticulationAtCursor('insert', 'breath') };
      r();
    `,
  },
  /* MusicXML import: <breath-mark> was silently dropped (the notations pass
     read only staccato/accent/tenuto/fermata — the sonata's four marks, IV
     mm. 75 + 100, never arrived). m1 in 2/2, m2 switches to 4/4 with the mark
     on its last quarter — the imported <breath> must carry the effective
     meter's tstamp and the anchor id the exporter round-trips on. */
  breath_musicxmlImportBreathMark: {
    setup: `
      const N = (step, oct, extra) => '<note><pitch><step>' + step + '</step><octave>' + oct + '</octave></pitch><duration>24</duration><voice>1</voice><type>quarter</type>' + (extra ?? '') + '</note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>Test</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">'
        + '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>2</beats><beat-type>2</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + N('C', 5) + N('D', 5) + N('E', 5) + N('F', 5)
        + '</measure><measure number="2">'
        + '<attributes><time><beats>4</beats><beat-type>4</beat-type></time></attributes>'
        + N('G', 5) + N('A', 5) + N('B', 5) + N('C', 6, '<notations><articulations><breath-mark/></articulations></notations>')
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* Fermata is the only articulation valid on a rest. */
  artic_fermata_on_rest: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'f' }],
  },
  /* Staccato on a rest is a no-op. */
  artic_staccato_on_rest_noop: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 's' }],
  },
  /* Pressing S twice toggles staccato off. */
  artic_staccato_toggle_off: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 's' }, { key: 's' }],
  },
  /* S + A on same note stacks both articulations. */
  artic_multiple_stack: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 's' }, { key: 'a' }],
  },
  /* Accent boosts playback velocity by ACCENT_VELOCITY_DELTA. */
  artic_accent_playback_velocity: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'a' }],
  },
  /* Staccato halves playback durationMs. */
  artic_staccato_playback_duration: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 's' }],
  },
  /* fillIncompleteMeasures fills M_1 (a single quarter rest, then quiet) when
     M_2 has content. */
  fillIncomplete_basic: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });  /* M_1 V_1 has 1 quarter rest */
      m.appendMeasure();
      m.setCursor(m.getVoiceLength(1), 1);
      m.insertRestAtCursor({ duration: '1', dots: 0 });  /* M_2 V_1 has whole rest */
      m.setCursor(0, 1);
      m.fillIncompleteMeasures();
    `,
  },
};

export const ASSERTIONS = {
  /* ── Trills + tremolos ────────────────────────────────────── */
  trill_voice: [
    { name: 'one <trill> anchored to the note; renders',
      expr: `(() => {
        const ts = [...window.__hkl_composer.model.getDoc().querySelectorAll('trill')];
        if (ts.length !== 1) return { ok: false, detail: 'trills=' + ts.length };
        if (!ts[0].getAttribute('startid')) return { ok: false, detail: 'no startid' };
        const g = document.querySelector('#score g.trill');
        return g ? { ok: true } : { ok: false, detail: 'no g.trill rendered' };
      })()` },
  ],
  tremolo_select: [
    { name: 'two notes wrapped in <fTrem beams=3>; renders',
      expr: `(() => {
        const ft = window.__hkl_composer.model.getDoc().querySelector('fTrem');
        if (!ft) return { ok: false, detail: 'no <fTrem>' };
        const notes = ft.querySelectorAll('note').length;
        if (notes !== 2 || ft.getAttribute('beams') !== '3') return { ok: false, detail: 'notes=' + notes + ' beams=' + ft.getAttribute('beams') };
        const g = document.querySelector('#score g.fTrem');
        return (g && g.getBBox().width > 1) ? { ok: true } : { ok: false, detail: 'fTrem not rendered' };
      })()` },
    { name: 'playback alternates between the two cells, slurred, over the full (half-note) span',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const evs = window.__hkl_composer.buildPlayback(m).filter(e => e.notes.length > 0);
        if (evs.length < 4) return { ok: false, detail: 'events=' + evs.length };
        const qs = evs.map(e => e.notes[0].q);
        const alternates = qs[0] !== qs[1] && qs[0] === qs[2] && qs[1] === qs[3];
        const slurred = evs.slice(0, -1).every(e => e.slurredToNext);
        const span = evs[evs.length - 1].atMs + evs[evs.length - 1].durationMs;
        if (!alternates) return { ok: false, detail: 'qs=' + qs.join(',') };
        if (!slurred) return { ok: false, detail: 'not all slurred' };
        return Math.abs(span - 1000) < 30 ? { ok: true } : { ok: false, detail: 'span=' + Math.round(span) };
      })()` },
  ],
  trill_select_step: [
    { name: 'collapsed to one half-note + <trill>; second cell preserved for playback',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const notes = [...doc.querySelectorAll('layer[n="1"] note')];
        const trills = doc.querySelectorAll('trill').length;
        const noFtrem = doc.querySelector('fTrem') === null;
        if (notes.length !== 1) return { ok: false, detail: 'notes=' + notes.length };
        if (notes[0].getAttribute('dur') !== '2') return { ok: false, detail: 'dur=' + notes[0].getAttribute('dur') };
        if (notes[0].getAttribute('data-hkl-trill-q') === null) return { ok: false, detail: 'alt cell not preserved' };
        return (trills === 1 && noFtrem) ? { ok: true } : { ok: false, detail: 'trills=' + trills + ' noFtrem=' + noFtrem };
      })()` },
    { name: 'playback alternates between the two preserved cells, slurred',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const evs = window.__hkl_composer.buildPlayback(m).filter(e => e.notes.length > 0);
        if (evs.length < 4) return { ok: false, detail: 'events=' + evs.length };
        const cells = evs.map(e => e.notes[0].q + '/' + e.notes[0].r);
        const alternates = cells[0] !== cells[1] && cells[0] === cells[2] && cells[1] === cells[3];
        const slurred = evs.slice(0, -1).every(e => e.slurredToNext);
        return (alternates && slurred) ? { ok: true } : { ok: false, detail: 'cells=' + cells.slice(0, 4).join(',') + ' slurred=' + slurred };
      })()` },
  ],
  /* ── Double bar `]` ─────────────────────────────────────────── */
  dblbar_toggle_on_m1_of_2: [
    { name: 'M_1 has @right="dbl"; M_2 (last) has @right="end"',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        const m1r = ms[0].getAttribute('right');
        const m2r = ms[1].getAttribute('right');
        return (m1r === 'dbl' && m2r === 'end')
          ? { ok: true }
          : { ok: false, detail: 'm1=' + m1r + ' m2=' + m2r };
      })()` },
    { name: 'final-bar @right="end" preserved on last measure (setBarlines respects user dbl)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        m.appendMeasure(); /* triggers setBarlines */
        const ms = m.allMeasures();
        return (ms[0].getAttribute('right') === 'dbl'
                && ms[1].getAttribute('right') === null
                && ms[2].getAttribute('right') === 'end')
          ? { ok: true }
          : { ok: false, detail: 'attrs=' + ms.map((x, i) => 'm' + (i + 1) + '=' + x.getAttribute('right')).join(' ') };
      })()` },
  ],
  dblbar_toggle_off: [
    { name: 'two `]` presses clear @right; M_2 still @right="end"',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        return (ms[0].getAttribute('right') === null && ms[1].getAttribute('right') === 'end')
          ? { ok: true }
          : { ok: false, detail: 'm1=' + ms[0].getAttribute('right') + ' m2=' + ms[1].getAttribute('right') };
      })()` },
  ],
  dblbar_lastMeasure_noop: [
    { name: '`]` on last (only) measure is rejected; @right="end" preserved',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        return (ms.length === 1 && ms[0].getAttribute('right') === 'end')
          ? { ok: true }
          : { ok: false, detail: 'len=' + ms.length + ' right=' + ms[0].getAttribute('right') };
      })()` },
  ],
  /* ── Hide rest `H` ─────────────────────────────────────────── */
  hideRest_toggle_on: [
    { name: 'rest has @visible="false"',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rest = m.getDoc().querySelector('rest');
        if (!rest) return { ok: false, detail: 'no rest' };
        const vis = rest.getAttribute('visible');
        return vis === 'false' ? { ok: true } : { ok: false, detail: '@visible=' + vis };
      })()` },
    { name: 'rendered g.rest is visually hidden (CSS visibility:hidden via data-visible)',
      expr: `(() => {
        const r = document.querySelector('#score g.rest');
        if (!r) return { ok: false, detail: 'no g.rest' };
        const dv = r.getAttribute('data-visible');
        const cv = getComputedStyle(r).visibility;
        return (dv === 'false' && cv === 'hidden')
          ? { ok: true } : { ok: false, detail: 'data-visible=' + dv + ' computed=' + cv };
      })()` },
  ],
  hideRest_toggle_off: [
    { name: '@visible removed after second toggle',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rest = m.getDoc().querySelector('rest');
        if (!rest) return { ok: false, detail: 'no rest' };
        return rest.hasAttribute('visible')
          ? { ok: false, detail: '@visible=' + rest.getAttribute('visible') }
          : { ok: true };
      })()` },
  ],
  hideRest_onNote_noop: [
    { name: 'note has no @visible (H no-op on non-rest)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const note = m.getDoc().querySelector('note');
        if (!note) return { ok: false, detail: 'no note' };
        return note.hasAttribute('visible')
          ? { ok: false, detail: '@visible=' + note.getAttribute('visible') }
          : { ok: true };
      })()` },
  ],
  /* ── Parenthetical cautionary accidental `P` ────────────────── */
  parenCaut_bareNote_on: [
    { name: 'note has @hkl-paren-caut="true"',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const note = m.getDoc().querySelector('note');
        return note?.getAttribute('hkl-paren-caut') === 'true'
          ? { ok: true } : { ok: false, detail: 'attr=' + note?.getAttribute('hkl-paren-caut') };
      })()` },
    { name: 'rendered g.accid contains BravuraText paren-left (E26A) AND paren-right (E26B)',
      expr: `(() => {
        const accidG = document.querySelector('#score g.note g.accid');
        if (!accidG) return { ok: false, detail: 'no g.accid' };
        const cps = [...accidG.querySelectorAll('text')].map(t => t.textContent.codePointAt(0).toString(16));
        const has = cps.includes('e26a') && cps.includes('e26b');
        return has ? { ok: true } : { ok: false, detail: 'cps=' + JSON.stringify(cps) };
      })()` },
  ],
  parenCaut_preserves_heji: [
    { name: 'HEJI comma-arrow glyph (U+E2C3) still rendered',
      expr: `(() => {
        const cps = [...document.querySelectorAll('#score g.note g.accid text')].map(t => t.textContent.codePointAt(0).toString(16));
        return cps.includes('e2c3')
          ? { ok: true } : { ok: false, detail: 'accid cps=' + JSON.stringify(cps) };
      })()` },
    { name: 'paren glyphs (E26A + E26B) flank the HEJI combined glyph in g.accid',
      expr: `(() => {
        const accidG = document.querySelector('#score g.note g.accid');
        if (!accidG) return { ok: false, detail: 'no g.accid' };
        const cps = [...accidG.querySelectorAll('text')].map(t => t.textContent.codePointAt(0).toString(16));
        return (cps.includes('e26a') && cps.includes('e26b') && cps.includes('e2c3'))
          ? { ok: true } : { ok: false, detail: 'cps=' + JSON.stringify(cps) };
      })()` },
  ],
  parenCaut_toggle_off: [
    { name: '@hkl-paren-caut removed after second P',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const note = m.getDoc().querySelector('note');
        return note && !note.hasAttribute('hkl-paren-caut')
          ? { ok: true } : { ok: false, detail: 'attr=' + note?.getAttribute('hkl-paren-caut') };
      })()` },
  ],
  parenCaut_chord_all: [
    { name: 'every chord note has @hkl-paren-caut="true"',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = [...m.getDoc().querySelectorAll('chord note')];
        if (notes.length !== 3) return { ok: false, detail: 'noteCount=' + notes.length };
        const allOn = notes.every(n => n.getAttribute('hkl-paren-caut') === 'true');
        return allOn ? { ok: true } : { ok: false, detail: 'flags=' + notes.map(n => n.getAttribute('hkl-paren-caut')).join(',') };
      })()` },
  ],
  parenCaut_chord_singleViaAltSel: [
    { name: 'only the bass (lowest midi) note has @hkl-paren-caut',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = [...m.getDoc().querySelectorAll('chord note')];
        const flagged = notes.filter(n => n.getAttribute('hkl-paren-caut') === 'true');
        if (flagged.length !== 1) return { ok: false, detail: 'flaggedCount=' + flagged.length };
        const pname = flagged[0].getAttribute('pname');
        const oct = flagged[0].getAttribute('oct');
        /* Bass = A3. */
        return (pname === 'a' && oct === '3') ? { ok: true } : { ok: false, detail: 'flagged=' + pname + oct };
      })()` },
  ],
  parenCaut_onRest_noop: [
    { name: 'rest has no @hkl-paren-caut',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rest = m.getDoc().querySelector('rest');
        return rest && !rest.hasAttribute('hkl-paren-caut')
          ? { ok: true } : { ok: false, detail: 'attr=' + rest?.getAttribute('hkl-paren-caut') };
      })()` },
  ],
  /* ── Insert measure `Ctrl+M` ───────────────────────────────── */
  insertMeasure_atStart: [
    { name: 'measure count = 2; new measure is M_1 (empty), original is M_2',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        if (ms.length !== 2) return { ok: false, detail: 'count=' + ms.length };
        /* M_1 (new) has no notes; M_2 (original) has the whole rest. */
        const m1Notes = ms[0].querySelectorAll('note, rest:not([data-placeholder])').length;
        const m2Rests = [...ms[1].querySelectorAll('rest')].filter(r => r.getAttribute('data-placeholder') !== 'true').length;
        return (m1Notes === 0 && m2Rests > 0)
          ? { ok: true }
          : { ok: false, detail: 'm1Notes=' + m1Notes + ' m2Rests=' + m2Rests };
      })()` },
    { name: 'cursor at start of new M_1 (= flat-index 0)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const cur = m.getCursor(1);
        return cur === 0 ? { ok: true } : { ok: false, detail: 'cur=' + cur };
      })()` },
  ],
  insertMeasure_midMeasure: [
    { name: 'measure count = 2; M_1 still has 4 quarters; M_2 is the new empty one',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        if (ms.length !== 2) return { ok: false, detail: 'count=' + ms.length };
        const m1Rests = [...ms[0].querySelectorAll('rest')].filter(r => r.getAttribute('data-placeholder') !== 'true').length;
        const m2RealContent = [...ms[1].querySelectorAll('note, rest')].filter(r => r.getAttribute('data-placeholder') !== 'true').length;
        return (m1Rests === 4 && m2RealContent === 0)
          ? { ok: true }
          : { ok: false, detail: 'm1Rests=' + m1Rests + ' m2RealContent=' + m2RealContent };
      })()` },
    { name: 'cursor at start of new M_2 (= first cursor stop in M_2)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const cur = m.getCursor(1);
        const m2Start = m.getMeasureStartCursor(1, 1);
        return cur === m2Start ? { ok: true } : { ok: false, detail: 'cur=' + cur + ' m2Start=' + m2Start };
      })()` },
  ],
  insertMeasure_atFirstNote_insertsAfter: [
    { name: 'M_1 still has the note; M_2 is the new empty measure',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        if (ms.length !== 2) return { ok: false, detail: 'count=' + ms.length };
        const m1HasA = ms[0].querySelector('note[pname="a"]') !== null;
        const m2Notes = ms[1].querySelectorAll('note').length;
        return (m1HasA && m2Notes === 0)
          ? { ok: true } : { ok: false, detail: 'm1HasA=' + m1HasA + ' m2Notes=' + m2Notes };
      })()` },
  ],
  insertMeasure_breaksSlur: [
    { name: 'slur covering M_1 → M_2 was pruned after Ctrl+M between them',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const slurs = m.getDoc().querySelectorAll('slur');
        return slurs.length === 0
          ? { ok: true } : { ok: false, detail: 'slurCount=' + slurs.length };
      })()` },
  ],
  insertMeasure_breaksTie: [
    { name: 'realized tie chain (@tie attrs) is gone after insertion',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const tied = m.getDoc().querySelectorAll('note[tie]');
        return tied.length === 0
          ? { ok: true } : { ok: false, detail: 'tiedCount=' + tied.length };
      })()` },
  ],
  /* ── Stem dir `L` + slur dir `Shift+L` ──────────────────────── */
  stemFlip_bareNote_freezes: [
    { name: 'note has @stem.dir set to "up" or "down" (opposite of natural)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const note = m.getDoc().querySelector('note');
        const d = note?.getAttribute('stem.dir');
        return (d === 'up' || d === 'down') ? { ok: true } : { ok: false, detail: 'stem.dir=' + d };
      })()` },
  ],
  stemFlip_secondPress_unfreezes: [
    { name: 'second L clears @stem.dir',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const note = m.getDoc().querySelector('note');
        return note && !note.hasAttribute('stem.dir')
          ? { ok: true } : { ok: false, detail: 'stem.dir=' + note?.getAttribute('stem.dir') };
      })()` },
  ],
  stemFlip_beamGroup_allFlip: [
    { name: 'all four eighths share the same @stem.dir',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = [...m.getDoc().querySelectorAll('layer > note')];
        if (notes.length !== 4) return { ok: false, detail: 'noteCount=' + notes.length };
        const dirs = notes.map(c => c.getAttribute('stem.dir'));
        const uniq = [...new Set(dirs)];
        return (uniq.length === 1 && (uniq[0] === 'up' || uniq[0] === 'down'))
          ? { ok: true } : { ok: false, detail: 'dirs=' + dirs.join(',') };
      })()` },
  ],
  stemFlip_respectsBeamBreak: [
    { name: 'only notes 1+2 have @stem.dir set; notes 3+4 have none',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = [...m.getDoc().querySelectorAll('layer > note')];
        if (notes.length !== 4) return { ok: false, detail: 'noteCount=' + notes.length };
        const dirs = notes.map(c => c.getAttribute('stem.dir'));
        const okFlipped = dirs[0] && dirs[1] && dirs[0] === dirs[1]
                       && dirs[2] === null && dirs[3] === null;
        return okFlipped
          ? { ok: true } : { ok: false, detail: 'dirs=' + JSON.stringify(dirs) };
      })()` },
  ],
  /* ── Beam split `/` ────────────────────────────────────────── */
  beamSplit_marksThird: [
    { name: '3rd eighth has @hkl-beam-break="true"',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = [...m.getDoc().querySelectorAll('layer > note')];
        if (notes.length < 4) return { ok: false, detail: 'noteCount=' + notes.length };
        return notes[2].getAttribute('hkl-beam-break') === 'true'
          ? { ok: true } : { ok: false, detail: 'attr=' + notes[2].getAttribute('hkl-beam-break') };
      })()` },
    { name: 'rendered SVG shows 3 beams (2+2+4) for the 8-eighth measure',
      expr: `(() => {
        /* Verovio wraps beamed runs in g.beam. Count after the re-render
           that fired on the keystroke. */
        const beams = document.querySelectorAll('#score g.beam');
        return beams.length === 3 ? { ok: true } : { ok: false, detail: 'beamCount=' + beams.length };
      })()` },
  ],
  beamSplit_toggleOff: [
    { name: '@hkl-beam-break absent after second `/`',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = [...m.getDoc().querySelectorAll('layer > note')];
        return notes[2] && !notes[2].hasAttribute('hkl-beam-break')
          ? { ok: true } : { ok: false, detail: 'attr=' + notes[2]?.getAttribute('hkl-beam-break') };
      })()` },
  ],
  beamSplit_onRest_noop: [
    { name: 'no element has @hkl-beam-break',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const flagged = m.getDoc().querySelectorAll('[hkl-beam-break="true"]');
        return flagged.length === 0
          ? { ok: true } : { ok: false, detail: 'flaggedCount=' + flagged.length };
      })()` },
  ],
  beamSplit_overridesBeatBoundary: [
    { name: '5th eighth carries @hkl-beam-break="true"',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = [...m.getDoc().querySelectorAll('layer > note')];
        return notes[4]?.getAttribute('hkl-beam-break') === 'true'
          ? { ok: true } : { ok: false, detail: 'attr=' + notes[4]?.getAttribute('hkl-beam-break') };
      })()` },
    { name: 'rendered SVG shows ONE beam of 8 (cross-beat connect)',
      expr: `(() => {
        const beams = document.querySelectorAll('#score g.beam');
        return beams.length === 1 ? { ok: true } : { ok: false, detail: 'beamCount=' + beams.length };
      })()` },
  ],
  /* ── Articulations S/A/T/F/B ─────────────────────────────── */
  artic_staccato_on_note: [
    { name: 'note has child <artic @artic="stacc">',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const articEls = m.getDoc().querySelectorAll('note > artic[artic="stacc"]');
        return articEls.length === 1 ? { ok: true } : { ok: false, detail: 'count=' + articEls.length };
      })()` },
    { name: 'rendered g.artic computed fill is black (not the notehead color)',
      expr: `(() => {
        const articG = document.querySelector('#score g.artic');
        if (!articG) return { ok: false, detail: 'no g.artic' };
        const fill = getComputedStyle(articG).fill;
        return fill === 'rgb(0, 0, 0)'
          ? { ok: true } : { ok: false, detail: 'fill=' + fill };
      })()` },
  ],
  artic_accent_on_note: [
    { name: 'note has child <artic @artic="acc"> (MEI accent value)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const articEls = m.getDoc().querySelectorAll('note > artic[artic="acc"]');
        return articEls.length === 1 ? { ok: true } : { ok: false, detail: 'count=' + articEls.length };
      })()` },
  ],
  artic_tenuto_on_note: [
    { name: 'note has child <artic @artic="ten">',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const articEls = m.getDoc().querySelectorAll('note > artic[artic="ten"]');
        return articEls.length === 1 ? { ok: true } : { ok: false, detail: 'count=' + articEls.length };
      })()` },
  ],
  artic_fermata_on_note: [
    { name: 'measure has <fermata @startid=#noteId> sibling',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const note = m.getDoc().querySelector('note');
        const id = note?.getAttribute('xml:id');
        const ferm = [...m.getDoc().querySelectorAll('measure > fermata')];
        const matching = ferm.filter(f => f.getAttribute('startid') === '#' + id);
        return matching.length === 1 ? { ok: true } : { ok: false, detail: 'ferm=' + ferm.length + ' matching=' + matching.length };
      })()` },
  ],
  artic_breath_on_note: [
    { name: 'measure has <breath @tstamp> sibling anchored to noteId via data-hkl-anchor',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const note = m.getDoc().querySelector('note');
        const id = note?.getAttribute('xml:id');
        const br = [...m.getDoc().querySelectorAll('measure > breath')];
        const matching = br.filter(f => f.getAttribute('data-hkl-anchor') === id && f.hasAttribute('tstamp'));
        return matching.length === 1 ? { ok: true } : { ok: false, detail: 'breath=' + br.length + ' matching=' + matching.length };
      })()` },
    { name: 'breath tstamp at end-of-note minus 5% (= 1.950 for a quarter starting at beat 1)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const breath = m.getDoc().querySelector('breath');
        const ts = parseFloat(breath?.getAttribute('tstamp') ?? '0');
        return (Math.abs(ts - 1.95) < 0.01)
          ? { ok: true } : { ok: false, detail: 'tstamp=' + ts };
      })()` },
  ],
  breath_endOfBarUsesEffectiveMeter: [
    { name: 'breath tstamp = 4.95 in the 4/4 measure (effective meter, not the 2/2 head)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const measures = [...m.getDoc().querySelectorAll('measure')];
        const breaths = [...m.getDoc().querySelectorAll('measure > breath')];
        if (breaths.length !== 1) return { ok: false, detail: 'breath count=' + breaths.length };
        const b = breaths[0];
        if (b.closest('measure') !== measures[1]) return { ok: false, detail: 'breath not in measure 1' };
        const lastNote = [...measures[1].querySelectorAll('layer[n="1"] > note')].pop();
        if (b.getAttribute('data-hkl-anchor') !== lastNote?.getAttribute('xml:id')) return { ok: false, detail: 'anchor=' + b.getAttribute('data-hkl-anchor') };
        const ts = parseFloat(b.getAttribute('tstamp') ?? '0');
        return Math.abs(ts - 4.95) < 0.01 ? { ok: true } : { ok: false, detail: 'tstamp=' + ts };
      })()` },
    { name: 'rendered comma sits after the last notehead and before the barline',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const measures = [...m.getDoc().querySelectorAll('measure')];
        const mid = measures[1].getAttribute('xml:id');
        const lastNote = [...measures[1].querySelectorAll('layer[n="1"] > note')].pop();
        const nid = lastNote?.getAttribute('xml:id');
        const g = document.querySelector('#score svg g.measure[id="' + mid + '"]');
        const br = g?.querySelector('g.breath use');
        const nh = g?.querySelector('g.note[id="' + nid + '"] g.notehead');
        const bars = [...(g?.querySelectorAll('g.barLine path') ?? [])].map((e) => e.getBoundingClientRect().x);
        if (!br || !nh || !bars.length) return { ok: false, detail: 'missing: breath=' + !!br + ' notehead=' + !!nh + ' bars=' + bars.length };
        const bx = br.getBoundingClientRect().x, nx = nh.getBoundingClientRect().right, barX = Math.max(...bars);
        return (bx > nx && bx < barX) ? { ok: true } : { ok: false, detail: 'breath.x=' + bx.toFixed(1) + ' lastNote.right=' + nx.toFixed(1) + ' barline.x=' + barX.toFixed(1) };
      })()` },
  ],
  breath_onTupletMemberCountsNestedTicks: [
    { name: 'breath anchored to the last triplet eighth with tstamp = 3 - 5% of a triplet eighth (2.983)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const probe = window.__breathProbe ?? {};
        const breaths = [...m.getDoc().querySelectorAll('measure > breath')];
        if (breaths.length !== 1) return { ok: false, detail: 'breath count=' + breaths.length + ' toggle=' + JSON.stringify(probe.toggle) };
        const b = breaths[0];
        if (!probe.lastId || b.getAttribute('data-hkl-anchor') !== probe.lastId) return { ok: false, detail: 'anchor=' + b.getAttribute('data-hkl-anchor') + ' lastTupletNote=' + probe.lastId };
        const ts = parseFloat(b.getAttribute('tstamp') ?? '0');
        const want = (32 - (16 / 3) * 0.05) / 16 + 1;
        return Math.abs(ts - want) < 0.01 ? { ok: true } : { ok: false, detail: 'tstamp=' + ts + ' want=' + want.toFixed(3) };
      })()` },
  ],
  breath_musicxmlImportBreathMark: [
    { name: 'imported <breath-mark> → one <breath> in measure 2, anchored to its last note, tstamp 4.95',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const measures = [...m.getDoc().querySelectorAll('measure')];
        const breaths = [...m.getDoc().querySelectorAll('measure > breath')];
        if (breaths.length !== 1) return { ok: false, detail: 'breath count=' + breaths.length };
        const b = breaths[0];
        if (measures.length < 2 || b.closest('measure') !== measures[1]) return { ok: false, detail: 'measures=' + measures.length + ' breath in m' + measures.indexOf(b.closest('measure')) };
        const lastNote = [...measures[1].querySelectorAll('layer[n="1"] > note')].pop();
        if (b.getAttribute('data-hkl-anchor') !== lastNote?.getAttribute('xml:id')) return { ok: false, detail: 'anchor=' + b.getAttribute('data-hkl-anchor') + ' last=' + lastNote?.getAttribute('xml:id') };
        if (b.getAttribute('staff') !== '1') return { ok: false, detail: 'staff=' + b.getAttribute('staff') };
        const ts = parseFloat(b.getAttribute('tstamp') ?? '0');
        return Math.abs(ts - 4.95) < 0.01 ? { ok: true } : { ok: false, detail: 'tstamp=' + ts };
      })()` },
    { name: 'rendered comma sits after the last notehead and before the barline',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const measures = [...m.getDoc().querySelectorAll('measure')];
        const mid = measures[1]?.getAttribute('xml:id');
        const lastNote = [...(measures[1]?.querySelectorAll('layer[n="1"] > note') ?? [])].pop();
        const nid = lastNote?.getAttribute('xml:id');
        const g = document.querySelector('#score svg g.measure[id="' + mid + '"]');
        const br = g?.querySelector('g.breath use');
        const nh = g?.querySelector('g.note[id="' + nid + '"] g.notehead');
        const bars = [...(g?.querySelectorAll('g.barLine path') ?? [])].map((e) => e.getBoundingClientRect().x);
        if (!br || !nh || !bars.length) return { ok: false, detail: 'missing: breath=' + !!br + ' notehead=' + !!nh + ' bars=' + bars.length };
        const bx = br.getBoundingClientRect().x, nx = nh.getBoundingClientRect().right, barX = Math.max(...bars);
        return (bx > nx && bx < barX) ? { ok: true } : { ok: false, detail: 'breath.x=' + bx.toFixed(1) + ' lastNote.right=' + nx.toFixed(1) + ' barline.x=' + barX.toFixed(1) };
      })()` },
  ],
  artic_fermata_on_rest: [
    { name: 'measure has <fermata @startid=#restId> sibling',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rest = m.getDoc().querySelector('rest');
        const id = rest?.getAttribute('xml:id');
        const ferm = [...m.getDoc().querySelectorAll('measure > fermata')];
        const matching = ferm.filter(f => f.getAttribute('startid') === '#' + id);
        return matching.length === 1 ? { ok: true } : { ok: false, detail: 'ferm=' + ferm.length + ' matching=' + matching.length };
      })()` },
  ],
  artic_staccato_on_rest_noop: [
    { name: 'rest has no <artic> child + no fermata/breath sibling',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const articEls = m.getDoc().querySelectorAll('rest > artic');
        const ctrl = m.getDoc().querySelectorAll('measure > fermata, measure > breath');
        return (articEls.length === 0 && ctrl.length === 0)
          ? { ok: true } : { ok: false, detail: 'articChildren=' + articEls.length + ' siblings=' + ctrl.length };
      })()` },
  ],
  artic_staccato_toggle_off: [
    { name: 'no <artic> on the note after second S',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const articEls = m.getDoc().querySelectorAll('note > artic[artic="stacc"]');
        return articEls.length === 0 ? { ok: true } : { ok: false, detail: 'count=' + articEls.length };
      })()` },
  ],
  artic_multiple_stack: [
    { name: 'note carries both stacc and acc (= accent)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const note = m.getDoc().querySelector('note');
        const arts = [...(note?.children ?? [])].filter(c => c.localName === 'artic').map(c => c.getAttribute('artic')).sort();
        return JSON.stringify(arts) === JSON.stringify(['acc', 'stacc'])
          ? { ok: true } : { ok: false, detail: 'arts=' + JSON.stringify(arts) };
      })()` },
  ],
  artic_accent_playback_velocity: [
    { name: 'playback event velocity = default-mf + ACCENT_VELOCITY_DELTA',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const events = window.__hkl_composer.buildPlayback(m);
        const ev = events.find(e => e.notes.length > 0);
        if (!ev) return { ok: false, detail: 'no playback events' };
        /* DEFAULT_DYNAMIC_MAP.mf = 55; accent adds 20 → 75. */
        return ev.velocity === 75
          ? { ok: true } : { ok: false, detail: 'velocity=' + ev.velocity };
      })()` },
  ],
  artic_staccato_playback_duration: [
    { name: 'playback event durationMs is half of the unshaped quarter-note value',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const events = window.__hkl_composer.buildPlayback(m);
        const ev = events.find(e => e.notes.length > 0);
        if (!ev) return { ok: false, detail: 'no playback events' };
        /* Quarter at 120bpm = 500ms unshaped; staccato → 250ms. Allow some slack. */
        return ev.durationMs > 240 && ev.durationMs < 260
          ? { ok: true } : { ok: false, detail: 'durMs=' + ev.durationMs };
      })()` },
  ],
  /* ── Fill incomplete measures ───────────────────────────────── */
  fillIncomplete_basic: [
    { name: 'M_1 V_1 now has rests summing to measureTicks (= 64 ticks @ 4/4)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        const layer = ms[0].querySelector('staff[n="1"] layer[n="1"]');
        let t = 0;
        for (const c of layer.children) {
          if (c.localName === 'rest' || c.localName === 'note' || c.localName === 'chord') {
            const dur = c.getAttribute('dur');
            const dots = parseInt(c.getAttribute('dots') || '0', 10);
            if (!dur) continue;
            let ticks = 64 / parseInt(dur, 10);
            if (dots === 1) ticks *= 1.5;
            if (dots === 2) ticks *= 1.75;
            t += ticks;
          }
        }
        return t === 64 ? { ok: true } : { ok: false, detail: 'realContentTicks=' + t };
      })()` },
  ],
};
