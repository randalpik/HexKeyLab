// Composer test fixtures — empty-cells.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

import {
  A4,
} from './_helpers.mjs';

/* ── Whole-bar rests in empty cells (2026-09-22, notation/measurerests.ts) ──
   Every content-free staff cell renders a cosmetic rest, on the render clone
   only: an <mRest> (whole rest centered between the barlines) for a full bar in
   any meter, beat-aligned rests sized to a pickup. Default doc = piano grand
   staff, two layers per staff. */
const ERC = `new DOMParser().parseFromString(window.__hkl_composer.model.serialize({ hejiEnabled: false }), 'application/xml')`;

/* Imported empty bars (2026-09-28): a MusicXML <rest measure="yes"/> must not
   survive import as a stored <mRest> — the whole-bar rest is a render-time
   function of the cell (fillEmptyMeasureRests), never document state. Single
   part, single staff, 4/4; MR_TWO_VOICE declares voice 2 in m1 so the part maps
   voice 1 → layer 1, voice 2 → layer 2. */
const MR_ATTR = '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
  + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';

const mrWhole = (step, oct, voice = 1) => '<note><pitch><step>' + step + '</step><octave>' + oct + '</octave></pitch>'
  + '<duration>96</duration><voice>' + voice + '</voice><type>whole</type></note>';

const MR_MEASURE_REST = '<note><rest measure="yes"/><duration>96</duration><voice>1</voice></note>';

const mrScore = (...bars) => '<?xml version="1.0"?><score-partwise version="3.0">'
  + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list><part id="P1">'
  + bars.map((b, i) => '<measure number="' + (i + 1) + '">' + (i === 0 ? MR_ATTR : '') + b + '</measure>').join('')
  + '</part></score-partwise>';

const MR_EMPTY_BAR = JSON.stringify(mrScore(mrWhole('C', 5), MR_MEASURE_REST, mrWhole('E', 5)));

const MR_TWO_VOICE = JSON.stringify(mrScore(
  mrWhole('C', 5) + '<backup><duration>96</duration></backup>' + mrWhole('C', 4, 2),
  MR_MEASURE_REST, mrWhole('E', 5)));

export const FIXTURES = {
  /* MusicXML import — empty middle measure (full-measure rest). m1 whole note,
     m2 an empty bar (<rest measure="yes"/> → an empty layer; the whole rest is
     cosmetic since 2026-09-28), m3 whole note. Regression guard: the empty bar
     must advance the voice by a FULL measure so m3's note stays
     measure-aligned. Originally an imported <mRest> was dropped from the
     playback walk → m3's note played a measure early (staves desync). Asserted
     in FIXTURE_ASSERTIONS.mRest_emptyMeasureStaysInSync via buildPlayback. */
  mRest_emptyMeasureStaysInSync: {
    setup: `
      const A = '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';
      const W = (s, o) => '<note><pitch><step>' + s + '</step><octave>' + o + '</octave></pitch>'
        + '<duration>96</duration><voice>1</voice><type>whole</type></note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>Test</part-name></score-part></part-list><part id="P1">'
        + '<measure number="1">' + A + W('C', 5) + '</measure>'
        + '<measure number="2"><note><rest measure="yes"/><duration>96</duration><voice>1</voice></note></measure>'
        + '<measure number="3">' + W('E', 5) + '</measure>'
        + '</part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },

  /* ── Empty-cell flags (2026-09-11): Ctrl+H = hide-empty, Ctrl+M = multirest ──
     Both are per-(measure, staff) attributes on <staff> (model/empty-flags.ts),
     set by one command over the selection's measure × staff rectangle (or the
     cursor's measure/staff), on EMPTY cells only, all taking the state the
     FEWEST had (tie → on). Insert-measure moved to plain M in the same change. */
  /* Fresh doc, cursor in voice 1 (staff 1): Ctrl+H flags m1 staff 1 only. */
  eflag_ctrlH_cursor_on: {
    setup: `m.setCursor(0, 1);`,
    setupKeys: [{ key: 'h', ctrl: true }],
  },
  /* A second press on the same single cell clears it (1 → 0). Through a
     kept measure selection on staff 1: in plain voice mode the first press
     hides the cursor's own staff and the post-render snap moves the cursor to
     the other staff (see eflag_ctrlH_cursor_snaps), so the second press would
     target a different cell. */
  eflag_ctrlH_cursor_off: {
    setup: `m.setCursor(0, 1);`,
    setupKeys: [{ key: 'ArrowUp', shift: true }, { key: 'h', ctrl: true }, { key: 'h', ctrl: true }],
    skipCursorTrace: true,
  },
  /* Ctrl+M is the multirest flag now — it must NOT insert a measure. */
  eflag_ctrlM_no_longer_inserts: {
    setup: `m.setCursor(0, 1);`,
    setupKeys: [{ key: 'm', ctrl: true }],
  },
  /* Max's rule: 5 measures selected on staff 1, flags 1 0 0 0 1 → the fewest
     state is ON (2 < 3) → 1 1 1 1 1. The selection is KEPT afterwards. */
  eflag_sel_fewest_rule: {
    setup: `
      for (let i = 0; i < 4; i++) m.appendMeasure();
      const ms = m.allMeasures();
      ms[0].querySelector('staff[n="1"]').setAttribute('data-hkl-multirest', 'true');
      ms[4].querySelector('staff[n="1"]').setAttribute('data-hkl-multirest', 'true');
      m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowUp', shift: true },
      { key: 'ArrowRight', shift: true }, { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true }, { key: 'ArrowRight', shift: true },
      { key: 'm', ctrl: true },
    ],
    skipCursorTrace: true,   /* selection stays live by design; flags, not geometry, are under test */
  },
  /* …and pressing again over the kept selection: 1 1 1 1 1 → 0 0 0 0 0. */
  eflag_sel_cycle_off: {
    setup: `
      for (let i = 0; i < 4; i++) m.appendMeasure();
      const ms = m.allMeasures();
      ms[0].querySelector('staff[n="1"]').setAttribute('data-hkl-multirest', 'true');
      ms[4].querySelector('staff[n="1"]').setAttribute('data-hkl-multirest', 'true');
      m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowUp', shift: true },
      { key: 'ArrowRight', shift: true }, { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true }, { key: 'ArrowRight', shift: true },
      { key: 'm', ctrl: true }, { key: 'm', ctrl: true },
    ],
    skipCursorTrace: true,
  },
  /* Measure selection grown to both piano staves (Shift+↓) over m1–m3:
     Ctrl+H flags 3 × 2 = 6 cells. */
  eflag_sel_two_staves: {
    setup: `
      m.appendMeasure(); m.appendMeasure();
      m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowUp', shift: true }, { key: 'ArrowDown', shift: true },
      { key: 'ArrowRight', shift: true }, { key: 'ArrowRight', shift: true },
      { key: 'h', ctrl: true },
    ],
    skipCursorTrace: true,
  },
  /* A non-empty cell is never a target: m1 staff 1 holds a note, so the same
     two-staff selection flags only the other 5 cells. */
  eflag_nonempty_excluded: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'c', accid: '', oct: 5, midi: 72, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.appendMeasure(); m.appendMeasure();
      m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowUp', shift: true }, { key: 'ArrowDown', shift: true },
      { key: 'ArrowRight', shift: true }, { key: 'ArrowRight', shift: true },
      { key: 'h', ctrl: true },
    ],
    skipCursorTrace: true,
  },
  /* Content entering a flagged cell drops its flags (placeholders.ts strips
     them in the normalize pass); the other staff's flag is untouched. */
  eflag_content_drops_flag: {
    setup: `
      for (const st of m.allMeasures()[0].querySelectorAll('staff')) {
        st.setAttribute('data-hkl-hide-empty', 'true');
        st.setAttribute('data-hkl-multirest', 'true');
      }
      m.setCursor(0, 1);
    `,
    setupKeys: [{ key: '5' }],
  },
  /* Flags are plain <staff> attributes: they survive serialize → new Model. */
  eflag_roundtrip_keeps_flags: {
    setup: `
      m.appendMeasure();
      const ms = m.allMeasures();
      ms[0].querySelector('staff[n="2"]').setAttribute('data-hkl-hide-empty', 'true');
      ms[1].querySelector('staff[n="1"]').setAttribute('data-hkl-multirest', 'true');
      m.setCursor(0, 1);
      r();
    `,
  },

  /* ── Multimeasure rests (2026-09-11, model/multirest.ts) ──
     A single-staff view collapses a run of ≥2 flagged empty measures into one
     <multiRest num="N"/> measure at render time; the live doc keeps every
     measure. Violin (staff 3, voice 5) part view: m1 has a note, m2–m4 are
     flagged → one multirest of 3; m5, m6 plain empty. */
  /* Render: 4 rendered measures, one g.multiRest, the run's first id kept. */
  mrest_collapse_render: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      for (let i = 0; i < 5; i++) m.appendMeasure();                 /* m1 note, m2..m6 empty */
      const ms = m.allMeasures();
      for (const i of [1, 2, 3]) ms[i].querySelector('staff[n="3"]').setAttribute('data-hkl-multirest', 'true');
      
      m.setVoice(5); m.setCursor(0, 5);
      /* Part view of the violin (index 1) through the real toolbar selector. */
      r();
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    `,
    skipCursorTrace: true,
    visualBaseline: 'mrest_collapse_render',
  },
  /* The same flags in the FULL score (3 staves) collapse nothing. */
  mrest_not_in_full_score: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      for (let i = 0; i < 5; i++) m.appendMeasure();                 /* m1 note, m2..m6 empty */
      const ms = m.allMeasures();
      for (const i of [1, 2, 3]) ms[i].querySelector('staff[n="3"]').setAttribute('data-hkl-multirest', 'true');
      
      m.setVoice(5); m.setCursor(0, 5);
      r();
    `,
    skipCursorTrace: true,
  },
  /* ←/→ treat the run as ONE stop: from m1's note, → lands ON the multirest
     (m2's wrapper), a second → lands past it (m5); ← from there lands back on
     the run (m2), never on an interior measure. */
  mrest_cursor_skip: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      for (let i = 0; i < 5; i++) m.appendMeasure();                 /* m1 note, m2..m6 empty */
      const ms = m.allMeasures();
      for (const i of [1, 2, 3]) ms[i].querySelector('staff[n="3"]').setAttribute('data-hkl-multirest', 'true');
      
      m.setVoice(5); m.setCursor(0, 5);
      /* Part view of the violin (index 1) through the real toolbar selector. */
      r();
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));

      m.setVoice(5); m.setCursor(1, 5);   /* after m1's note */
    `,
    setupKeys: [{ key: 'ArrowRight' }, { key: 'ArrowRight' }],
    skipCursorTrace: true,
  },
  mrest_cursor_skip_back: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      for (let i = 0; i < 5; i++) m.appendMeasure();                 /* m1 note, m2..m6 empty */
      const ms = m.allMeasures();
      for (const i of [1, 2, 3]) ms[i].querySelector('staff[n="3"]').setAttribute('data-hkl-multirest', 'true');
      
      m.setVoice(5); m.setCursor(0, 5);
      /* Part view of the violin (index 1) through the real toolbar selector. */
      r();
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));

      m.setVoice(5); m.setCursor(1, 5);
    `,
    setupKeys: [{ key: 'ArrowRight' }, { key: 'ArrowRight' }, { key: 'ArrowLeft' }],
    skipCursorTrace: true,
  },
  /* Shift+↑ on the run selects the whole run; Shift+→ grows by one measure
     (m5); Ctrl+M over the kept selection (all 4 cells empty; 3 on, 1 off →
     fewest = OFF) clears every flag → no multirest, 6 rendered measures. */
  mrest_select_run_toggle_off: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      for (let i = 0; i < 5; i++) m.appendMeasure();                 /* m1 note, m2..m6 empty */
      const ms = m.allMeasures();
      for (const i of [1, 2, 3]) ms[i].querySelector('staff[n="3"]').setAttribute('data-hkl-multirest', 'true');
      
      m.setVoice(5); m.setCursor(0, 5);
      /* Part view of the violin (index 1) through the real toolbar selector. */
      r();
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));

      m.setVoice(5); m.setCursor(m.getMeasureStartCursor(5, 2), 5);   /* inside the run */
    `,
    setupKeys: [{ key: 'ArrowUp', shift: true }, { key: 'ArrowRight', shift: true }, { key: 'm', ctrl: true }],
    skipCursorTrace: true,
  },
  /* Backspace on the collapsed stop removes all three measures at once (every
     member is empty on every staff): 3 measures remain. */
  mrest_delete_run: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      for (let i = 0; i < 5; i++) m.appendMeasure();                 /* m1 note, m2..m6 empty */
      const ms = m.allMeasures();
      for (const i of [1, 2, 3]) ms[i].querySelector('staff[n="3"]').setAttribute('data-hkl-multirest', 'true');
      
      m.setVoice(5); m.setCursor(0, 5);
      /* Part view of the violin (index 1) through the real toolbar selector. */
      r();
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));

      m.setVoice(5); m.setCursor(m.getMeasureStartCursor(5, 1) + 1, 5);   /* past the run's wrapper stop */
    `,
    setupKeys: [{ key: 'Backspace' }],
    skipCursorTrace: true,
  },
  /* …but refused when another part has content in the run (piano note in m3). */
  mrest_delete_run_refused: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      for (let i = 0; i < 5; i++) m.appendMeasure();                 /* m1 note, m2..m6 empty */
      const ms = m.allMeasures();
      for (const i of [1, 2, 3]) ms[i].querySelector('staff[n="3"]').setAttribute('data-hkl-multirest', 'true');
      m.setVoice(1); m.setCursor(m.getMeasureStartCursor(1, 2), 1); m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '4', dots: 0 });
      m.setVoice(5); m.setCursor(0, 5);
      /* Part view of the violin (index 1) through the real toolbar selector. */
      r();
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));

      m.setVoice(5); m.setCursor(m.getMeasureStartCursor(5, 1) + 1, 5);
    `,
    setupKeys: [{ key: 'Backspace' }],
    skipCursorTrace: true,
  },
  /* A run never crosses a hard boundary: a meter change before m3 splits
     m2–m4 into m2 alone (no run) + m3–m4 (a run of 2). */
  mrest_run_breaks_at_scoreDef: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      for (let i = 0; i < 5; i++) m.appendMeasure();                 /* m1 note, m2..m6 empty */
      const ms = m.allMeasures();
      for (const i of [1, 2, 3]) ms[i].querySelector('staff[n="3"]').setAttribute('data-hkl-multirest', 'true');
      m.setMeterRange(2, 5, 3, 4);
      m.setVoice(5); m.setCursor(0, 5);
      /* Part view of the violin (index 1) through the real toolbar selector. */
      r();
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    `,
    skipCursorTrace: true,
  },
  /* A dynamic on ANOTHER staff (piano, staff 1) inside the violin's run must
     not break it — the part view never shows it (single-part filter). A
     violin dynamic in an interior bar does. */
  mrest_other_staff_dynamic_keeps_run: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      for (let i = 0; i < 5; i++) m.appendMeasure();
      const ms = m.allMeasures();
      for (const i of [1, 2, 3]) ms[i].querySelector('staff[n="3"]').setAttribute('data-hkl-multirest', 'true');
      /* piano dynamic in m3 (interior of the violin run) */
      const dyn = ms[2].ownerDocument.createElementNS('http://www.music-encoding.org/ns/mei', 'dynam');
      dyn.setAttribute('staff', '1'); dyn.setAttribute('tstamp', '1'); dyn.setAttribute('place', 'between'); dyn.textContent = 'p';
      ms[2].appendChild(dyn);
      m.setVoice(5); m.setCursor(0, 5);
    `,
    skipCursorTrace: true,
  },
  /* A piano slur (@startid/@endid, no @staff) running under the violin's run
     must not break it either — its staff is resolved through its notes. */
  mrest_other_staff_slur_keeps_run: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      for (let i = 0; i < 5; i++) m.appendMeasure();
      /* piano whole notes in m2..m4 */
      m.setVoice(1);
      for (const i of [1, 2, 3]) { m.setCursor(m.getMeasureStartCursor(1, i), 1); m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '1', dots: 0 }); }
      const ms = m.allMeasures();
      for (const i of [1, 2, 3]) ms[i].querySelector('staff[n="3"]').setAttribute('data-hkl-multirest', 'true');
      const n2 = ms[1].querySelector('staff[n="1"] note'), n4 = ms[3].querySelector('staff[n="1"] note');
      const slur = ms[2].ownerDocument.createElementNS('http://www.music-encoding.org/ns/mei', 'slur');
      slur.setAttribute('startid', '#' + n2.getAttribute('xml:id')); slur.setAttribute('endid', '#' + n4.getAttribute('xml:id'));
      ms[1].appendChild(slur);   /* hosted in its start note's measure (MEI), spanning the run's interior */
      m.setVoice(5); m.setCursor(0, 5);
    `,
    skipCursorTrace: true,
  },
  /* The run's LAST measure's @right rides on the collapsed measure. */
  mrest_last_measure_barline: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      for (let i = 0; i < 5; i++) m.appendMeasure();                 /* m1 note, m2..m6 empty */
      const ms = m.allMeasures();
      for (const i of [1, 2, 3]) ms[i].querySelector('staff[n="3"]').setAttribute('data-hkl-multirest', 'true');
      ms[3].setAttribute('right', 'dbl');
      m.setVoice(5); m.setCursor(0, 5);
      /* Part view of the violin (index 1) through the real toolbar selector. */
      r();
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    `,
    skipCursorTrace: true,
  },

  /* ── Hide empty staves (2026-09-11, render/hiddenstaves.ts) ──
     Violin + piano; the piano plays only bars 1–8. Flagging BOTH piano staves on
     every bar of the system that holds bar 13 removes them from that system in
     page view (Verovio re-renders the system with the staves filtered out; no
     brace on the lone violin); one unflagged bar keeps them; scroll view shows
     everything. The system range is computed at setup (window.__hideSys). */
  hide_staff_system: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      const KEY = (k, mods) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {})));
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5);
      for (let i = 0; i < 96; i++) m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 32; i++) m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
      /* The system holding bar 13 (piano empty there): its measure range. */
      const sysEl = document.getElementById(window.__hkl_composer.renderer.renderIdForMeasure(12)).closest('g.system');
      const idxs = [...sysEl.querySelectorAll('g.measure')].map(g => m.getMeasureIdxForId(g.id));
      const lo = Math.min(...idxs), hi = Math.max(...idxs);
      window.__hideSys = { lo, hi, firstId: sysEl.querySelector('g.measure').id };
      m.setVoice(1); m.setCursor(m.getMeasureStartCursor(1, lo), 1);
      KEY('ArrowUp', { shiftKey: true }); KEY('ArrowDown', { shiftKey: true });
      for (let i = lo; i < hi; i++) KEY('ArrowRight', { shiftKey: true });
      KEY('h', { ctrlKey: true });
      KEY('Escape');
    `,
    skipCursorTrace: true,
    visualBaseline: 'hide_staff_system',
    visualFullPage: true,
  },
  /* One bar of the system left unflagged → the piano stays on that system. */
  hide_partial_not_hidden: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      const KEY = (k, mods) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {})));
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5);
      for (let i = 0; i < 96; i++) m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 32; i++) m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
      /* The system holding bar 13 (piano empty there): its measure range. */
      const sysEl = document.getElementById(window.__hkl_composer.renderer.renderIdForMeasure(12)).closest('g.system');
      const idxs = [...sysEl.querySelectorAll('g.measure')].map(g => m.getMeasureIdxForId(g.id));
      const lo = Math.min(...idxs), hi = Math.max(...idxs);
      window.__hideSys = { lo, hi, firstId: sysEl.querySelector('g.measure').id };
      m.setVoice(1); m.setCursor(m.getMeasureStartCursor(1, lo), 1);
      KEY('ArrowUp', { shiftKey: true }); KEY('ArrowDown', { shiftKey: true });
      for (let i = lo; i < hi - 1; i++) KEY('ArrowRight', { shiftKey: true });
      KEY('h', { ctrlKey: true });
      KEY('Escape');
    `,
    skipCursorTrace: true,
  },
  /* Scroll view never hides — the rescue path. */
  hide_scroll_shows_all: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      const KEY = (k, mods) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {})));
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5);
      for (let i = 0; i < 96; i++) m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 32; i++) m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
      /* The system holding bar 13 (piano empty there): its measure range. */
      const sysEl = document.getElementById(window.__hkl_composer.renderer.renderIdForMeasure(12)).closest('g.system');
      const idxs = [...sysEl.querySelectorAll('g.measure')].map(g => m.getMeasureIdxForId(g.id));
      const lo = Math.min(...idxs), hi = Math.max(...idxs);
      window.__hideSys = { lo, hi, firstId: sysEl.querySelector('g.measure').id };
      m.setVoice(1); m.setCursor(m.getMeasureStartCursor(1, lo), 1);
      KEY('ArrowUp', { shiftKey: true }); KEY('ArrowDown', { shiftKey: true });
      for (let i = lo; i < hi; i++) KEY('ArrowRight', { shiftKey: true });
      KEY('h', { ctrlKey: true });
      KEY('Escape');

      window.__hkl_composer.renderer.setViewMode('scroll');
      r();
    `,
    skipCursorTrace: true,
  },
  /* → from the start of a hidden system's first bar (piano voice) steps over
     the whole hidden run and lands in the next system. */
  hide_cursor_skips: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      const KEY = (k, mods) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {})));
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5);
      for (let i = 0; i < 96; i++) m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 32; i++) m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
      /* The system holding bar 13 (piano empty there): its measure range. */
      const sysEl = document.getElementById(window.__hkl_composer.renderer.renderIdForMeasure(12)).closest('g.system');
      const idxs = [...sysEl.querySelectorAll('g.measure')].map(g => m.getMeasureIdxForId(g.id));
      const lo = Math.min(...idxs), hi = Math.max(...idxs);
      window.__hideSys = { lo, hi, firstId: sysEl.querySelector('g.measure').id };
      m.setVoice(1); m.setCursor(m.getMeasureStartCursor(1, lo), 1);
      KEY('ArrowUp', { shiftKey: true }); KEY('ArrowDown', { shiftKey: true });
      for (let i = lo; i < hi; i++) KEY('ArrowRight', { shiftKey: true });
      KEY('h', { ctrlKey: true });
      KEY('Escape');

      m.setVoice(1); m.setCursor(m.getMeasureStartCursor(1, lo), 1);
    `,
    setupKeys: [{ key: 'ArrowRight' }],
    skipCursorTrace: true,
  },
  /* Ctrl+H splices (no full engrave) and an edit into a hidden cell drops the
     flag and brings the staff back on that system, again by splice. Both
     actions run inside the (async) assertions so the render ledger sees them. */
  hide_toggle_splices: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      const KEY = (k, mods) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {})));
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5);
      for (let i = 0; i < 96; i++) m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 32; i++) m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
      /* The system holding bar 13 (piano empty there): its measure range. */
      const sysEl = document.getElementById(window.__hkl_composer.renderer.renderIdForMeasure(12)).closest('g.system');
      const idxs = [...sysEl.querySelectorAll('g.measure')].map(g => m.getMeasureIdxForId(g.id));
      const lo = Math.min(...idxs), hi = Math.max(...idxs);
      window.__hideSys = { lo, hi, firstId: sysEl.querySelector('g.measure').id };    `,
    skipCursorTrace: true,
  },
  hide_edit_unhides_and_splices: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      const KEY = (k, mods) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {})));
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5);
      for (let i = 0; i < 96; i++) m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 32; i++) m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
      /* The system holding bar 13 (piano empty there): its measure range. */
      const sysEl = document.getElementById(window.__hkl_composer.renderer.renderIdForMeasure(12)).closest('g.system');
      const idxs = [...sysEl.querySelectorAll('g.measure')].map(g => m.getMeasureIdxForId(g.id));
      const lo = Math.min(...idxs), hi = Math.max(...idxs);
      window.__hideSys = { lo, hi, firstId: sysEl.querySelector('g.measure').id };
      m.setVoice(1); m.setCursor(m.getMeasureStartCursor(1, lo), 1);
      KEY('ArrowUp', { shiftKey: true }); KEY('ArrowDown', { shiftKey: true });
      for (let i = lo; i < hi; i++) KEY('ArrowRight', { shiftKey: true });
      KEY('h', { ctrlKey: true });
      KEY('Escape');
    `,
    skipCursorTrace: true,
  },
  /* Every staff flagged on the system → the top staff is kept (guard). */
  hide_all_staves_guard: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      const KEY = (k, mods) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {})));
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5);
      for (let i = 0; i < 32; i++) m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });   /* 8 bars */
      for (let i = 0; i < 8; i++) m.appendMeasure();                                                              /* 8 empty bars: 9–16 */
      m.setVoice(1); m.setCursor(0, 1);
      r();
      const sysEl = document.getElementById(window.__hkl_composer.renderer.renderIdForMeasure(12)).closest('g.system');
      const idxs = [...sysEl.querySelectorAll('g.measure')].map(g => m.getMeasureIdxForId(g.id));
      const lo = Math.min(...idxs), hi = Math.max(...idxs);
      window.__hideSys = { lo, hi, firstId: sysEl.querySelector('g.measure').id };
      m.setVoice(1); m.setCursor(m.getMeasureStartCursor(1, lo), 1);
      KEY('ArrowUp', { shiftKey: true }); KEY('ArrowDown', { shiftKey: true }); KEY('ArrowDown', { shiftKey: true });
      for (let i = lo; i < hi; i++) KEY('ArrowRight', { shiftKey: true });
      KEY('h', { ctrlKey: true });
      KEY('Escape');
    `,
    skipCursorTrace: true,
  },

  /* ── Splicing with multimeasure rests (day one) ── the toggle and an edit into a
     run in a multi-system part view must splice, never derive. */
  mrest_toggle_splices: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5);
      for (let i = 0; i < 160; i++) m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });   /* 40 bars */
      const ms = m.allMeasures();
      for (const i of [10, 11, 12, 13, 14, 25, 26]) {
        const st = ms[i].querySelector('staff[n="3"]');
        for (const l of st.querySelectorAll('layer')) for (const c of Array.from(l.children)) if (c.localName !== 'space') l.removeChild(c);
      }
      m.normalizePlaceholdersAll();
      m.setVoice(5); m.setCursor(0, 5);
      r();
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    `,
    skipCursorTrace: true,
  },
  /* m1 staff 1 holds a note; m1 staff 2 and both staves of m2, m3 are empty →
     five whole-bar rests. */
  erest_empty_cells_whole_rest: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      m.appendMeasure(); m.appendMeasure();
      m.setCursor(0, 1);
      r();
    `,
    visualBaseline: 'erest_empty_cells_whole_rest',
  },
  /* 4/4, 3/4, 6/8, 5/4 — the same single whole rest in every empty bar. */
  erest_any_meter: {
    setup: `
      m.appendMeasure(); m.appendMeasure(); m.appendMeasure();
      m.setMeterAt(1, 3, 4);
      m.setMeterAt(2, 6, 8);
      m.setMeterAt(3, 5, 4);
      m.setCursor(0, 1);
      r();
    `,
    visualBaseline: 'erest_any_meter',
  },
  /* A 3-eighth pickup: its empty cells show ONE dotted-quarter rest, not a
     whole rest (and not quarter + eighth — Max: one rest wherever a single
     value spells the pickup); the full bar after it keeps its mRest. */
  erest_pickup_sized_rests: {
    setup: `
      m.appendMeasure();
      m.setPickupAt(0, 3);
      m.setCursor(0, 1);
      r();
    `,
    visualBaseline: 'erest_pickup_sized_rests',
  },
  /* A 5-eighth pickup has no single value: the fewest, largest first —
     half + eighth. */
  erest_pickup_split_fewest: {
    setup: `
      m.appendMeasure();
      m.setPickupAt(0, 5);
      m.setCursor(0, 1);
      r();
    `,
  },
  /* A click on a cosmetic pickup rest is a click on the empty staff: the
     cursor lands at that cell's measure-start stop, no error. */
  erest_click_cosmetic_rest: {
    setup: `
      m.appendMeasure();
      m.setPickupAt(0, 3);
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      r();
      const g = document.querySelector('#score g.rest[data-data-hkl-cosmetic="true"]');
      const b = g.getBoundingClientRect();
      document.getElementById('score').dispatchEvent(new MouseEvent('click',
        { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, button: 0, bubbles: true }));
    `,
  },
  /* Imported empty bar: no stored <mRest>, the layer holds placeholders only,
     and the render still draws exactly one (cosmetic) whole-bar rest there. */
  erest_import_mrest_scrubbed: {
    setup: `
      window.__composerImportMusicXml(${MR_EMPTY_BAR});
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* The sonata m75 shape: V1's bar was an imported measure rest, then V2 got
     content. The cell is no longer empty, so no whole rest may be drawn. */
  erest_import_mrest_siblingEdit: {
    setup: `
      window.__composerImportMusicXml(${MR_TWO_VOICE});
      m.setVoice(2); m.setCursor(m.getMeasureStartCursor(2, 1), 2);
      m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      r();
    `,
  },
  /* Max's repro: a quarter rest typed at the measure-start stop of an imported
     measure-rest bar lands at the HEAD of the bar (placeholders fill the
     remaining 3/4), not appended after a stale whole-bar rest. */
  erest_import_mrest_insertAtHead: {
    setup: `
      window.__composerImportMusicXml(${MR_EMPTY_BAR});
      m.setVoice(1); m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      r();
    `,
  },
  /* A saved file from before the scrub: m1 staff 1 holds a lone <mRest>, m2
     staff 1 the broken [mRest, rest(4)] an edit could produce. Load repairs
     both: placeholders in m1 (cosmetic rest drawn), [rest(4), placeholders]
     in m2 (no whole rest drawn). */
  erest_legacy_mrest_scrubbed_on_load: {
    setup: `
      m.appendMeasure();
      const NS = 'http://www.music-encoding.org/ns/mei';
      const d = new DOMParser().parseFromString(m.serialize(), 'application/xml');
      const L = [...d.querySelectorAll('measure')].map((me) => me.querySelector('staff[n="1"] > layer[n="1"]'));
      const put = (layer, specs) => {
        while (layer.firstChild) layer.removeChild(layer.firstChild);
        for (const [name, attrs] of specs) {
          const e = d.createElementNS(NS, name);
          for (const k in attrs) e.setAttribute(k, attrs[k]);
          layer.appendChild(e);
        }
      };
      put(L[0], [['mRest', { 'xml:id': 'mr_legacy_a' }]]);
      put(L[1], [['mRest', { 'xml:id': 'mr_legacy_b' }], ['rest', { 'xml:id': 'r_legacy', dur: '4' }]]);
      const legacy = new XMLSerializer().serializeToString(d);
      if ((legacy.match(/<mRest/g) || []).length !== 2) throw new Error('legacy shape not constructed');
      m.replaceDocument(legacy);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
};

export const ASSERTIONS = {
  mRest_emptyMeasureStaysInSync: [
    { name: 'empty measure advances the voice a full bar; m3 note stays aligned',
      expr: `(() => {
        const h = window.__hkl_composer;
        const evs = h.buildPlayback(h.model);
        const notes = evs.filter(e => e.notes.length > 0).sort((a, b) => a.atMs - b.atMs);
        if (notes.length !== 2) return { ok: false, detail: 'noteEvents=' + notes.length };
        const first = notes[0], last = notes[1];
        /* first = m1 whole note (durationMs === one full measure). last = m3
           note, which must start TWO measures in. Bug: mRest dropped → m3 at
           one measure (== first.durationMs). */
        const expected = 2 * first.durationMs;
        if (Math.abs(last.atMs - expected) > 1)
          return { ok: false, detail: 'm3 atMs=' + last.atMs + ' expected~' + expected + ' (empty m2 skipped?)' };
        return { ok: true };
      })()` },
  ],
  /* ── Empty-cell flags (Ctrl+H / Ctrl+M) ── */
  eflag_ctrlH_cursor_on: [
    { name: 'm1 staff 1 hide-empty ON, staff 2 untouched, no multirest flag', expr: `(() => { const flag = (mi, sn, a) => { const st = window.__hkl_composer.model.allMeasures()[mi]?.querySelector('staff[n="' + sn + '"]'); return !!st && st.getAttribute(a) === 'true'; }; const H = 'data-hkl-hide-empty', MR = 'data-hkl-multirest'; return { ok: flag(0,1,H) && !flag(0,2,H) && !flag(0,1,MR), detail: JSON.stringify([flag(0,1,H), flag(0,2,H), flag(0,1,MR)]) }; })()` },
  ],
  eflag_ctrlH_cursor_off: [
    { name: 'second Ctrl+H clears the single cell', expr: `(() => { const flag = (mi, sn, a) => { const st = window.__hkl_composer.model.allMeasures()[mi]?.querySelector('staff[n="' + sn + '"]'); return !!st && st.getAttribute(a) === 'true'; }; const H = 'data-hkl-hide-empty', MR = 'data-hkl-multirest'; return { ok: !flag(0,1,H) && !flag(0,2,H) }; })()` },
  ],
  eflag_ctrlM_no_longer_inserts: [
    { name: 'measure count unchanged and m1 staff 1 carries the multirest flag', expr: `(() => { const flag = (mi, sn, a) => { const st = window.__hkl_composer.model.allMeasures()[mi]?.querySelector('staff[n="' + sn + '"]'); return !!st && st.getAttribute(a) === 'true'; }; const H = 'data-hkl-hide-empty', MR = 'data-hkl-multirest'; const n = window.__hkl_composer.model.allMeasures().length; return { ok: n === 1 && flag(0,1,MR) && !flag(0,1,H), detail: 'measures ' + n + ' MR ' + flag(0,1,MR) }; })()` },
  ],
  eflag_sel_fewest_rule: [
    { name: '1 0 0 0 1 → 1 1 1 1 1 on staff 1; staff 2 untouched', expr: `(() => { const flag = (mi, sn, a) => { const st = window.__hkl_composer.model.allMeasures()[mi]?.querySelector('staff[n="' + sn + '"]'); return !!st && st.getAttribute(a) === 'true'; }; const H = 'data-hkl-hide-empty', MR = 'data-hkl-multirest'; const s1 = [0,1,2,3,4].map(i => flag(i,1,MR)), s2 = [0,1,2,3,4].map(i => flag(i,2,MR)); return { ok: s1.every(Boolean) && !s2.some(Boolean), detail: JSON.stringify({ s1, s2 }) }; })()` },
    { name: 'selection is kept after the toggle', expr: `(() => { const flag = (mi, sn, a) => { const st = window.__hkl_composer.model.allMeasures()[mi]?.querySelector('staff[n="' + sn + '"]'); return !!st && st.getAttribute(a) === 'true'; }; const H = 'data-hkl-hide-empty', MR = 'data-hkl-multirest'; const sel = window.__hkl_composer.inputState().selection; return { ok: !!sel && sel.kind === 'measure', detail: JSON.stringify(sel) }; })()` },
  ],
  eflag_sel_cycle_off: [
    { name: '1 1 1 1 1 → 0 0 0 0 0', expr: `(() => { const flag = (mi, sn, a) => { const st = window.__hkl_composer.model.allMeasures()[mi]?.querySelector('staff[n="' + sn + '"]'); return !!st && st.getAttribute(a) === 'true'; }; const H = 'data-hkl-hide-empty', MR = 'data-hkl-multirest'; const s1 = [0,1,2,3,4].map(i => flag(i,1,MR)); return { ok: !s1.some(Boolean), detail: JSON.stringify(s1) }; })()` },
  ],
  eflag_sel_two_staves: [
    { name: '3 measures × 2 staves all hide-empty ON', expr: `(() => { const flag = (mi, sn, a) => { const st = window.__hkl_composer.model.allMeasures()[mi]?.querySelector('staff[n="' + sn + '"]'); return !!st && st.getAttribute(a) === 'true'; }; const H = 'data-hkl-hide-empty', MR = 'data-hkl-multirest'; const cells = []; for (let i = 0; i < 3; i++) for (const sn of [1,2]) cells.push(flag(i,sn,H)); return { ok: cells.length === 6 && cells.every(Boolean), detail: JSON.stringify(cells) }; })()` },
  ],
  eflag_nonempty_excluded: [
    { name: 'm1 staff 1 (has a note) stays unflagged; the other 5 cells are ON', expr: `(() => { const flag = (mi, sn, a) => { const st = window.__hkl_composer.model.allMeasures()[mi]?.querySelector('staff[n="' + sn + '"]'); return !!st && st.getAttribute(a) === 'true'; }; const H = 'data-hkl-hide-empty', MR = 'data-hkl-multirest'; const got = {}; for (let i = 0; i < 3; i++) for (const sn of [1,2]) got['m'+(i+1)+'s'+sn] = flag(i,sn,H); const ok = !got.m1s1 && got.m1s2 && got.m2s1 && got.m2s2 && got.m3s1 && got.m3s2; return { ok, detail: JSON.stringify(got) }; })()` },
  ],
  eflag_content_drops_flag: [
    { name: 'a rest entered in staff 1 drops both of its flags; staff 2 keeps both', expr: `(() => { const flag = (mi, sn, a) => { const st = window.__hkl_composer.model.allMeasures()[mi]?.querySelector('staff[n="' + sn + '"]'); return !!st && st.getAttribute(a) === 'true'; }; const H = 'data-hkl-hide-empty', MR = 'data-hkl-multirest'; return { ok: !flag(0,1,H) && !flag(0,1,MR) && flag(0,2,H) && flag(0,2,MR), detail: JSON.stringify([flag(0,1,H), flag(0,1,MR), flag(0,2,H), flag(0,2,MR)]) }; })()` },
  ],
  eflag_roundtrip_keeps_flags: [
    { name: 'serialize → new Model keeps both flags where they were', expr: `(() => { const flag = (mi, sn, a) => { const st = window.__hkl_composer.model.allMeasures()[mi]?.querySelector('staff[n="' + sn + '"]'); return !!st && st.getAttribute(a) === 'true'; }; const H = 'data-hkl-hide-empty', MR = 'data-hkl-multirest'; const m = window.__hkl_composer.model; const fresh = new (m.constructor)(m.serialize()); const doc = fresh.getDoc(); const ms = Array.from(doc.querySelectorAll('measure')); const a = ms[0].querySelector('staff[n="2"]').getAttribute('data-hkl-hide-empty') === 'true'; const b = ms[1].querySelector('staff[n="1"]').getAttribute('data-hkl-multirest') === 'true'; const stray = doc.querAll ? 0 : Array.from(doc.querySelectorAll('staff[data-hkl-hide-empty], staff[data-hkl-multirest]')).length; return { ok: a && b && stray === 2, detail: JSON.stringify({ a, b, stray }) }; })()` },
  ],
  /* ── Multimeasure rests ── */
  mrest_collapse_render: [
    { name: 'part view renders 4 measures, one g.multiRest with num 3, run start id kept', expr: `(() => { const M = window.__hkl_composer, m = M.model; const ids = [...document.querySelectorAll('#score g.measure')].map(g => g.id); const mrs = document.querySelectorAll('#score g.multiRest'); const live = m.allMeasures().map(x => x.getAttribute('xml:id')); const ok = ids.length === 4 && mrs.length === 1 && ids[1] === live[1] && ids[2] === live[4]; return { ok, detail: JSON.stringify({ ids, live, mrs: mrs.length }) }; })()` },
    { name: 'render clone carries multiRest num=3 and the live doc still has 6 measures', expr: `(() => { const M = window.__hkl_composer, m = M.model; const d = new DOMParser().parseFromString(m.serialize({ hejiEnabled: false }, [3]), 'application/xml'); const mr = d.querySelector('multiRest'); return { ok: !!mr && mr.getAttribute('num') === '3' && d.querySelectorAll('measure').length === 4 && m.allMeasures().length === 6, detail: (mr && mr.getAttribute('num')) + ' / ' + d.querySelectorAll('measure').length }; })()` },
  ],
  mrest_not_in_full_score: [
    { name: 'full score keeps 6 rendered measures and no multiRest', expr: `(() => { const M = window.__hkl_composer, m = M.model; const n = document.querySelectorAll('#score g.measure').length; return { ok: n === 6 && document.querySelectorAll('#score g.multiRest').length === 0 && !m.renderUnits(null).active, detail: 'measures ' + n }; })()` },
  ],
  mrest_cursor_skip: [
    { name: 'two right-arrows from m1 land past the run (one stop), in m5', expr: `(() => { const M = window.__hkl_composer, m = M.model; const mi = m.cursorMeasureIdx(5, M.inputState().mode); return { ok: mi === 4, detail: 'cursor measure ' + mi + ' flat ' + m.getCursor(5) }; })()` },
  ],
  mrest_cursor_skip_back: [
    { name: 'left-arrow from m6 lands on the run (m2), never on an interior measure', expr: `(() => { const M = window.__hkl_composer, m = M.model; const mi = m.cursorMeasureIdx(5, M.inputState().mode); return { ok: mi === 1, detail: 'cursor measure ' + mi }; })()` },
  ],
  mrest_select_run_toggle_off: [
    { name: 'selection covered the whole run plus m5, and all four flags are now off', expr: `(() => { const M = window.__hkl_composer, m = M.model; const sel = M.inputState().selection; const flags = [1,2,3,4].map(i => m.allMeasures()[i].querySelector('staff[n="3"]').getAttribute('data-hkl-multirest') === 'true'); const range = sel ? [Math.min(sel.anchorMeasure, sel.movableMeasure), Math.max(sel.anchorMeasure, sel.movableMeasure)] : null; return { ok: !!sel && range[0] === 1 && range[1] === 4 && !flags.some(Boolean), detail: JSON.stringify({ sel, flags }) }; })()` },
    { name: 'the run dissolved: 6 rendered measures, no multiRest', expr: `(() => { const M = window.__hkl_composer, m = M.model; return { ok: document.querySelectorAll('#score g.measure').length === 6 && document.querySelectorAll('#score g.multiRest').length === 0, detail: String(document.querySelectorAll('#score g.measure').length) }; })()` },
  ],
  mrest_delete_run: [
    { name: 'Backspace removed the three run measures: 3 remain, none flagged', expr: `(() => { const M = window.__hkl_composer, m = M.model; const n = m.allMeasures().length; const flagged = m.getDoc().querySelectorAll('staff[data-hkl-multirest]').length; return { ok: n === 3 && flagged === 0, detail: 'measures ' + n + ' flagged ' + flagged }; })()` },
  ],
  mrest_delete_run_refused: [
    { name: 'piano content in the run keeps all 6 measures (skip-left instead)', expr: `(() => { const M = window.__hkl_composer, m = M.model; return { ok: m.allMeasures().length === 6, detail: 'measures ' + m.allMeasures().length }; })()` },
  ],
  mrest_run_breaks_at_scoreDef: [
    { name: 'meter change before m3 splits the run: one multiRest of 2 at m3, m2 stands alone', expr: `(() => { const M = window.__hkl_composer, m = M.model; const d = new DOMParser().parseFromString(m.serialize({ hejiEnabled: false }, [3]), 'application/xml'); const mrs = [...d.querySelectorAll('multiRest')].map(x => x.getAttribute('num')); const ns = [...d.querySelectorAll('measure')].map(x => x.getAttribute('n')); const u = m.renderUnits([3]); return { ok: mrs.length === 1 && mrs[0] === '2' && u.isRunStart(2) && !u.isRunStart(1), detail: JSON.stringify({ mrs, ns, sig: u.sig }) }; })()` },
  ],
  mrest_last_measure_barline: [
    { name: "collapsed measure carries the run's last right=dbl barline", expr: `(() => { const M = window.__hkl_composer, m = M.model; const d = new DOMParser().parseFromString(m.serialize({ hejiEnabled: false }, [3]), 'application/xml'); const rep = [...d.querySelectorAll('measure')].find(x => x.querySelector('multiRest')); return { ok: !!rep && rep.getAttribute('right') === 'dbl', detail: rep ? String(rep.getAttribute('right')) : 'no rep' }; })()` },
  ],
  /* ── Hide empty staves ── */
  hide_staff_system: [
    { name: 'the flagged system draws the violin staff only, without a brace', expr: `(async () => { const M = window.__hkl_composer, m = M.model, R = M.renderer; const poll = (cond, ms) => new Promise((res) => { const t0 = performance.now(); (function tick() { if (cond() || performance.now() - t0 > ms) res(); else setTimeout(tick, 100); })(); }); const sysOf = () => document.getElementById(window.__hideSys.firstId)?.closest('g.system'); const stavesOf = (sys) => sys ? [...sys.querySelector('g.measure').querySelectorAll(':scope > g.staff')].map(g => g.getAttribute('data-n')) : null; await poll(() => stavesOf(sysOf())?.length === 1, 6000); const sys = sysOf(); return { ok: !!sys && JSON.stringify(stavesOf(sys)) === '["3"]' && sys.querySelectorAll('g.grpSym').length === 0, detail: JSON.stringify({ staves: stavesOf(sys), braces: sys?.querySelectorAll('g.grpSym').length }) }; })()` },
    { name: 'the other systems keep all three staves', expr: `(async () => { const M = window.__hkl_composer, m = M.model, R = M.renderer; const poll = (cond, ms) => new Promise((res) => { const t0 = performance.now(); (function tick() { if (cond() || performance.now() - t0 > ms) res(); else setTimeout(tick, 100); })(); }); const sysOf = () => document.getElementById(window.__hideSys.firstId)?.closest('g.system'); const stavesOf = (sys) => sys ? [...sys.querySelector('g.measure').querySelectorAll(':scope > g.staff')].map(g => g.getAttribute('data-n')) : null; const others = [...document.querySelectorAll('#score g.system')].filter(s => s !== sysOf()); return { ok: others.length >= 2 && others.every(s => stavesOf(s).length === 3), detail: JSON.stringify(others.map(stavesOf)) }; })()` },
    { name: 'PDF export source (mountAllPages) is this DOM: the reduced system is in it', expr: `(async () => { const M = window.__hkl_composer, m = M.model, R = M.renderer; const poll = (cond, ms) => new Promise((res) => { const t0 = performance.now(); (function tick() { if (cond() || performance.now() - t0 > ms) res(); else setTimeout(tick, 100); })(); }); const sysOf = () => document.getElementById(window.__hideSys.firstId)?.closest('g.system'); const stavesOf = (sys) => sys ? [...sys.querySelector('g.measure').querySelectorAll(':scope > g.staff')].map(g => g.getAttribute('data-n')) : null; const pages = R.mountAllPages(); const found = pages.some(svg => [...svg.querySelectorAll('g.system')].some(s => s.querySelector('g.measure')?.id === window.__hideSys.firstId && stavesOf(s).length === 1)); return { ok: found, detail: 'pages ' + pages.length }; })()` },
  ],
  hide_partial_not_hidden: [
    { name: 'one unflagged bar keeps the piano on the system (3 staves)', expr: `(async () => { const M = window.__hkl_composer, m = M.model, R = M.renderer; const poll = (cond, ms) => new Promise((res) => { const t0 = performance.now(); (function tick() { if (cond() || performance.now() - t0 > ms) res(); else setTimeout(tick, 100); })(); }); const sysOf = () => document.getElementById(window.__hideSys.firstId)?.closest('g.system'); const stavesOf = (sys) => sys ? [...sys.querySelector('g.measure').querySelectorAll(':scope > g.staff')].map(g => g.getAttribute('data-n')) : null; await poll(() => false, 800); return { ok: stavesOf(sysOf())?.length === 3, detail: JSON.stringify(stavesOf(sysOf())) }; })()` },
  ],
  hide_scroll_shows_all: [
    { name: 'scroll view draws every staff in every measure', expr: `(async () => { const M = window.__hkl_composer, m = M.model, R = M.renderer; const poll = (cond, ms) => new Promise((res) => { const t0 = performance.now(); (function tick() { if (cond() || performance.now() - t0 > ms) res(); else setTimeout(tick, 100); })(); }); const sysOf = () => document.getElementById(window.__hideSys.firstId)?.closest('g.system'); const stavesOf = (sys) => sys ? [...sys.querySelector('g.measure').querySelectorAll(':scope > g.staff')].map(g => g.getAttribute('data-n')) : null; await poll(() => R.getViewMode() === 'scroll' && document.querySelectorAll('#score g.measure').length >= 24, 6000); const bad = [...document.querySelectorAll('#score g.measure')].filter(g => g.querySelectorAll(':scope > g.staff').length !== 3).length; return { ok: bad === 0 && R.getViewMode() === 'scroll', detail: 'measures with != 3 staves: ' + bad }; })()` },
  ],
  hide_cursor_skips: [
    { name: 'right-arrow from the hidden system\\u2019s first bar lands in the next system', expr: `(async () => { const M = window.__hkl_composer, m = M.model, R = M.renderer; const poll = (cond, ms) => new Promise((res) => { const t0 = performance.now(); (function tick() { if (cond() || performance.now() - t0 > ms) res(); else setTimeout(tick, 100); })(); }); const sysOf = () => document.getElementById(window.__hideSys.firstId)?.closest('g.system'); const stavesOf = (sys) => sys ? [...sys.querySelector('g.measure').querySelectorAll(':scope > g.staff')].map(g => g.getAttribute('data-n')) : null; const mi = m.cursorMeasureIdx(1, M.inputState().mode); return { ok: m.getCurrentVoice() === 1 && mi === window.__hideSys.hi + 1, detail: 'cursor measure ' + mi + ' expected ' + (window.__hideSys.hi + 1) }; })()` },
  ],
  hide_toggle_splices: [
    { name: 'Ctrl+H over the system splices (no full engrave) and hides the piano there', expr: `(async () => { const M = window.__hkl_composer, m = M.model, R = M.renderer; const poll = (cond, ms) => new Promise((res) => { const t0 = performance.now(); (function tick() { if (cond() || performance.now() - t0 > ms) res(); else setTimeout(tick, 100); })(); }); const sysOf = () => document.getElementById(window.__hideSys.firstId)?.closest('g.system'); const stavesOf = (sys) => sys ? [...sys.querySelector('g.measure').querySelectorAll(':scope > g.staff')].map(g => g.getAttribute('data-n')) : null; const { lo, hi } = window.__hideSys; const KEY = (k, mods) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {}))); R.clearRenderLedger(); m.setVoice(1); m.setCursor(m.getMeasureStartCursor(1, lo), 1); KEY('ArrowUp', { shiftKey: true }); KEY('ArrowDown', { shiftKey: true }); for (let i = lo; i < hi; i++) KEY('ArrowRight', { shiftKey: true }); KEY('h', { ctrlKey: true }); await poll(() => stavesOf(sysOf())?.length === 1, 8000); KEY('Escape'); const led = R.renderLedger(); return { ok: stavesOf(sysOf())?.length === 1 && led.length >= 1 && led.every(e => e.full === false), detail: JSON.stringify({ staves: stavesOf(sysOf()), ledger: led }) }; })()` },
  ],
  hide_edit_unhides_and_splices: [
    { name: 'a rest entered into a hidden piano bar drops its flag and THAT staff returns (staff 2 stays hidden), by splice', expr: `(async () => { const M = window.__hkl_composer, m = M.model, R = M.renderer; const poll = (cond, ms) => new Promise((res) => { const t0 = performance.now(); (function tick() { if (cond() || performance.now() - t0 > ms) res(); else setTimeout(tick, 100); })(); }); const sysOf = () => document.getElementById(window.__hideSys.firstId)?.closest('g.system'); const stavesOf = (sys) => sys ? [...sys.querySelector('g.measure').querySelectorAll(':scope > g.staff')].map(g => g.getAttribute('data-n')) : null; const { lo } = window.__hideSys; const KEY = (k, mods) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {}))); await poll(() => stavesOf(sysOf())?.length === 1, 6000); R.clearRenderLedger(); m.setVoice(1); m.setCursor(m.getMeasureStartCursor(1, lo), 1); KEY('5'); await poll(() => stavesOf(sysOf())?.length === 2, 8000); const led = R.renderLedger(); const flag = m.allMeasures()[lo].querySelector('staff[n="1"]').getAttribute('data-hkl-hide-empty'); return { ok: JSON.stringify(stavesOf(sysOf())) === '["1","3"]' && flag === null && led.length >= 1 && led.every(e => e.full === false), detail: JSON.stringify({ staves: stavesOf(sysOf()), flag, ledger: led }) }; })()` },
  ],
  hide_all_staves_guard: [
    { name: 'all three staves flagged → only the top staff (1) is kept on the system', expr: `(async () => { const M = window.__hkl_composer, m = M.model, R = M.renderer; const poll = (cond, ms) => new Promise((res) => { const t0 = performance.now(); (function tick() { if (cond() || performance.now() - t0 > ms) res(); else setTimeout(tick, 100); })(); }); const sysOf = () => document.getElementById(window.__hideSys.firstId)?.closest('g.system'); const stavesOf = (sys) => sys ? [...sys.querySelector('g.measure').querySelectorAll(':scope > g.staff')].map(g => g.getAttribute('data-n')) : null; await poll(() => stavesOf(sysOf())?.length === 1, 6000); return { ok: JSON.stringify(stavesOf(sysOf())) === '["1"]', detail: JSON.stringify(stavesOf(sysOf())) }; })()` },
  ],
  /* ── Splicing with multimeasure rests ── */
  mrest_toggle_splices: [
    { name: 'Ctrl+M over bars 11–15 of the part splices and engraves one multirest; an edit into the run splices too', expr: `(async () => { const M = window.__hkl_composer, m = M.model, R = M.renderer; const poll = (cond, ms) => new Promise((res) => { const t0 = performance.now(); (function tick() { if (cond() || performance.now() - t0 > ms) res(); else setTimeout(tick, 100); })(); }); const sysOf = () => document.getElementById(window.__hideSys.firstId)?.closest('g.system'); const stavesOf = (sys) => sys ? [...sys.querySelector('g.measure').querySelectorAll(':scope > g.staff')].map(g => g.getAttribute('data-n')) : null; const KEY = (k, mods) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {}))); await poll(() => (R.viewStaves || []).length === 1 && document.querySelectorAll('#score g.system').length >= 3, 8000); R.clearRenderLedger(); m.setVoice(5); m.setCursor(m.getMeasureStartCursor(5, 10), 5); KEY('ArrowUp', { shiftKey: true }); for (let i = 0; i < 4; i++) KEY('ArrowRight', { shiftKey: true }); KEY('m', { ctrlKey: true }); await poll(() => document.querySelectorAll('#score g.multiRest').length === 1, 8000); const led1 = R.renderLedger().slice(); KEY('Escape'); R.clearRenderLedger(); m.setCursor(m.getMeasureStartCursor(5, 10), 5); KEY('5'); await poll(() => R.renderLedger().length >= 1, 8000); await poll(() => false, 400); const led2 = R.renderLedger().slice(); const flags = [10,11,12,13,14].map(i => m.allMeasures()[i].querySelector('staff[n="3"]').getAttribute('data-hkl-multirest')); const ok = document.querySelectorAll('#score g.multiRest').length === 1 && led1.length >= 1 && led1.every(e => e.full === false) && led2.length >= 1 && led2.every(e => e.full === false) && flags[0] === null && flags.slice(1).every(f => f === 'true'); return { ok, detail: JSON.stringify({ systems: document.querySelectorAll('#score g.system').length, led1, led2, flags }) }; })()` },
  ],
  mrest_other_staff_dynamic_keeps_run: [
    { name: 'violin run m2–m4 survives a piano dynamic in m3; a violin dynamic there splits it (m3–m4 remain a run)', expr: `(() => { const M = window.__hkl_composer, m = M.model; const u1 = m.renderUnits([3]); const before = u1.sig; const dyn = m.allMeasures()[2].querySelector('dynam'); dyn.setAttribute('staff', '3'); const u2 = m.renderUnits([3]); dyn.setAttribute('staff', '1'); return { ok: before === '1-3' && u2.sig === '2-3', detail: JSON.stringify({ before, afterViolinDyn: u2.sig }) }; })()` },
  ],
  mrest_other_staff_slur_keeps_run: [
    { name: 'violin run m2–m4 survives a piano slur hosted in m3', expr: `(() => { const M = window.__hkl_composer, m = M.model; const u = m.renderUnits([3]); return { ok: u.sig === '1-3', detail: u.sig }; })()` },
  ],
  /* ── Whole-bar rests in empty cells ── */
  erest_empty_cells_whole_rest: [
    { name: 'five g.mRest rendered; m1 staff 1 (the note) has none', expr: `(() => { const ms = [...document.querySelectorAll('#score g.measure')]; const per = ms.map(g => [...g.querySelectorAll('g.staff')].map(s => s.querySelectorAll('g.mRest').length)); const ok = JSON.stringify(per) === JSON.stringify([[0,1],[1,1],[1,1]]); return { ok, detail: JSON.stringify(per) }; })()` },
    { name: 'each whole rest is centered between its barlines (m2, m3)', expr: `(() => { const ms = [...document.querySelectorAll('#score g.measure')].slice(1); const off = []; for (const g of ms) for (const s of g.querySelectorAll('g.staff')) { const mr = s.querySelector('g.mRest'); const lines = [...s.children].filter(c => c.localName === 'path'); if (!mr || !lines.length) { off.push('missing'); continue; } /* Verovio centers on [left edge, right barline's LEFT edge]: the staff lines run on through a final barline's thick stroke. */ const L = Math.min(...lines.map(p => p.getBoundingClientRect().left)); const bars = [...g.querySelectorAll('g.barLine')].map(e => e.getBoundingClientRect().left); const R = bars.length ? Math.max(...bars) : Math.max(...lines.map(p => p.getBoundingClientRect().right)); const b = mr.getBoundingClientRect(); off.push(Math.round(((b.left + b.right) / 2 - (L + R) / 2) * 10) / 10); } return { ok: off.length === 4 && off.every(d => typeof d === 'number' && Math.abs(d) < 2), detail: JSON.stringify(off) }; })()` },
    { name: 'render clone: one mRest per empty cell, in layer 1, pinned loc 6; saved doc has none', expr: `(() => { const d = ${ERC}; const mrs = [...d.querySelectorAll('mRest')]; const okClone = mrs.length === 5 && mrs.every(x => x.parentElement.getAttribute('n') === '1' && x.getAttribute('loc') === '6'); const live = window.__hkl_composer.model.getDoc().querySelectorAll('mRest').length; const saved = (window.__hkl_composer.model.serialize().match(/<mRest/g) || []).length; return { ok: okClone && live === 0 && saved === 0, detail: JSON.stringify({ clone: mrs.map(x => [x.parentElement.getAttribute('n'), x.getAttribute('loc')]), live, saved }) }; })()` },
  ],
  erest_any_meter: [
    { name: 'every cell of the 4/4, 3/4, 6/8, 5/4 bars draws exactly one whole rest', expr: `(() => { const per = [...document.querySelectorAll('#score g.measure')].map(g => [...g.querySelectorAll('g.staff')].map(s => s.querySelectorAll('g.mRest').length)); const ok = per.length === 4 && per.every(r => r.length === 2 && r.every(n => n === 1)); return { ok, detail: JSON.stringify(per) }; })()` },
    { name: 'render clone: no placeholder space left in any layer 1', expr: `(() => { const d = ${ERC}; const left = [...d.querySelectorAll('layer[n="1"] > space')].length; return { ok: left === 0, detail: 'spaces ' + left }; })()` },
  ],
  erest_pickup_sized_rests: [
    { name: 'pickup cells: ONE cosmetic dotted quarter in layer 1, no mRest; m2 keeps two mRests', expr: `(() => { const d = ${ERC}; const [p, full] = [...d.querySelectorAll('measure')]; const cells = [...p.querySelectorAll('staff')].map(st => [...st.querySelector('layer[n="1"]').children].map(c => c.localName + ':' + (c.getAttribute('dur') || '') + '.' + (c.getAttribute('dots') || '0') + ':' + (c.getAttribute('data-hkl-cosmetic') || ''))); const ok = JSON.stringify(cells) === JSON.stringify([['rest:4.1:true'],['rest:4.1:true']]) && p.querySelectorAll('mRest').length === 0 && full.querySelectorAll('mRest').length === 2; return { ok, detail: JSON.stringify(cells) }; })()` },
    { name: 'SVG carries the marker on both pickup rests; the live doc has no rest', expr: `(() => { const n = document.querySelectorAll('#score g.rest[data-data-hkl-cosmetic="true"]').length; const live = window.__hkl_composer.model.getDoc().querySelectorAll('rest').length; return { ok: n === 2 && live === 0, detail: JSON.stringify({ n, live }) }; })()` },
  ],
  erest_pickup_split_fewest: [
    { name: '5-eighth pickup cells: cosmetic half + eighth, largest first', expr: `(() => { const d = ${ERC}; const p = d.querySelector('measure'); const cells = [...p.querySelectorAll('staff')].map(st => [...st.querySelector('layer[n="1"]').children].map(c => c.localName + ':' + (c.getAttribute('dur') || '') + '.' + (c.getAttribute('dots') || '0'))); const ok = JSON.stringify(cells) === JSON.stringify([['rest:2.0','rest:8.0'],['rest:2.0','rest:8.0']]); return { ok, detail: JSON.stringify(cells) }; })()` },
  ],
  erest_click_cosmetic_rest: [
    { name: 'the click lands on the pickup cell\'s measure-start stop', expr: `(() => { const M = window.__hkl_composer, m = M.model; const v = m.getCurrentVoice ? m.getCurrentVoice() : 1; const mi = m.cursorMeasureIdx(v, M.inputState().mode); return { ok: mi === 0 && m.getCursor(v) === m.getMeasureStartCursor(v, 0), detail: JSON.stringify({ v, mi, cur: m.getCursor(v), start: m.getMeasureStartCursor(v, 0) }) }; })()` },
  ],
  erest_import_mrest_scrubbed: [
    { name: 'live doc: no <mRest>; m2 layer 1 holds placeholders only',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const live = m.getDoc().querySelectorAll('mRest').length;
        const kids = [...m.allMeasures()[1].querySelector('staff[n="1"] > layer[n="1"]').children]
          .map((c) => c.localName + (c.getAttribute('data-placeholder') === 'true' ? '*' : ''));
        const ok = live === 0 && kids.length > 0 && kids.every((k) => k === 'space*');
        return { ok, detail: JSON.stringify({ live, kids }) };
      })()` },
    { name: 'render: exactly one whole-bar rest, in m2',
      expr: `(() => {
        const per = [...document.querySelectorAll('#score g.measure')].map((g) => g.querySelectorAll('g.mRest').length);
        return { ok: JSON.stringify(per) === '[0,1,0]', detail: JSON.stringify(per) };
      })()` },
  ],
  erest_import_mrest_siblingEdit: [
    { name: 'live doc: no <mRest>; V1 m2 placeholders only, V2 m2 starts with the entered note',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const live = m.getDoc().querySelectorAll('mRest').length;
        const k = (ly) => [...m.allMeasures()[1].querySelector('staff[n="1"] > layer[n="' + ly + '"]').children]
          .map((c) => c.localName + (c.getAttribute('data-placeholder') === 'true' ? '*' : ''));
        const v1 = k(1), v2 = k(2);
        const ok = live === 0 && v1.every((x) => x === 'space*') && (v2[0] === 'note' || v2[0] === 'chord');
        return { ok, detail: JSON.stringify({ live, v1, v2 }) };
      })()` },
    { name: 'render: no whole-bar rest anywhere (m2 is no longer an empty cell)',
      expr: `(() => {
        const per = [...document.querySelectorAll('#score g.measure')].map((g) => g.querySelectorAll('g.mRest').length);
        return { ok: per.length === 3 && per.every((n) => n === 0), detail: JSON.stringify(per) };
      })()` },
  ],
  erest_import_mrest_insertAtHead: [
    { name: 'live doc: m2 layer 1 = [rest(4), placeholders…], no <mRest>',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const live = m.getDoc().querySelectorAll('mRest').length;
        const kids = [...m.allMeasures()[1].querySelector('staff[n="1"] > layer[n="1"]').children]
          .map((c) => c.localName + (c.getAttribute('data-placeholder') === 'true' ? '*' : '') + ':' + (c.getAttribute('dur') || ''));
        const ok = live === 0 && kids[0] === 'rest:4' && kids.length > 1 && kids.slice(1).every((x) => x.startsWith('space*'));
        return { ok, detail: JSON.stringify({ live, kids }) };
      })()` },
    { name: 'render: no whole-bar rest in m2',
      expr: `(() => {
        const per = [...document.querySelectorAll('#score g.measure')].map((g) => g.querySelectorAll('g.mRest').length);
        return { ok: JSON.stringify(per) === '[0,0,0]', detail: JSON.stringify(per) };
      })()` },
  ],
  erest_legacy_mrest_scrubbed_on_load: [
    { name: 'live doc: no <mRest>; m1 placeholders only; m2 = [r_legacy, placeholders…]',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const live = m.getDoc().querySelectorAll('mRest').length;
        const k = (mi) => [...m.allMeasures()[mi].querySelector('staff[n="1"] > layer[n="1"]').children]
          .map((c) => (c.getAttribute('xml:id') === 'r_legacy' ? 'r_legacy' : c.localName + (c.getAttribute('data-placeholder') === 'true' ? '*' : '')));
        const a = k(0), b = k(1);
        const ok = live === 0 && a.length > 0 && a.every((x) => x === 'space*')
          && b[0] === 'r_legacy' && b.length > 1 && b.slice(1).every((x) => x === 'space*');
        return { ok, detail: JSON.stringify({ live, a, b }) };
      })()` },
    { name: 'render: whole-bar rests only in the empty cells (m1 both staves, m2 staff 2)',
      expr: `(() => {
        const per = [...document.querySelectorAll('#score g.measure')].map((g) => [...g.querySelectorAll('g.staff')].map((s) => s.querySelectorAll('g.mRest').length));
        return { ok: JSON.stringify(per) === '[[1,1],[0,1]]', detail: JSON.stringify(per) };
      })()` },
  ],
};
