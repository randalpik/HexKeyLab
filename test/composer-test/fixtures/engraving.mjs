// Composer test fixtures — engraving.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

import {
  CLEAR_ADOPTED_FONT_FACES,
  METRONOME_FONT_CHECK,
} from './_helpers.mjs';

export const FIXTURES = {

  /* ── Visual baselines (small, high-signal) ───────────────────────── */
  /* Tuplet rendering with CSS-hidden placeholders (Verovio bracket-pass
   * workaround). High-signal because subtle CSS changes can re-show the
   * placeholder rests, and Verovio version bumps can change the
   * `data-data-tuplet-placeholder` attribute normalization. */
  visualTupletBracket: {
    setup: `
      m.setCursor(0, 1);
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
    `,
    visualBaseline: 'tuplet_bracket_empty',
  },
  /* Multi-voice doc with mixed durations — exercises grand staff
   * layout, multi-staff cursor, beaming. */
  visualMultiVoice: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '2', dots: 0 });
      m.setVoice(2);
      m.setCursor(0, 2);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setVoice(3);
      m.setCursor(0, 3);
      m.insertRestAtCursor({ duration: '2', dots: 1 });
      m.setVoice(1);
    `,
    visualBaseline: 'multi_voice_dense',
  },
  /* Dark theme: a colored chord rendered with theme='dark'. High-signal for
   * the shared notation theming — staff lines / stems / clefs / accidentals
   * must flip to the light --notation-ink token, and noteheads must repaint
   * from their baked data-light-color (bright lattice variant) rather than the
   * ink @color. Notes carry both colorHex (ink) and lightColorHex. */
  visualDarkTheme: {
    setup: `
      window.__hkl_composer.renderer.setTheme('dark');
      m.setCursor(0, 1);
      /* Sanctioned ink + light-source pairs (BL / YE / GR) — dark mode shows
         the bright light variant; unsanctioned colors would render white. */
      m.insertChordAtCursor({ notes: [
        { q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#055ad1', lightColorHex: '#4C96FF', velocity: 80 },
        { q:  1, r:  0, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#bd890f', lightColorHex: '#FFF94C', velocity: 80 },
        { q:  0, r:  1, pname: 'g', accid: '', oct: 4, midi: 67, colorHex: '#52b80a', lightColorHex: '#55FF4C', velocity: 80 },
      ], duration: '4', dots: 0 });
    `,
    visualBaseline: 'dark_theme_chord',
  },
  /* Title + subtitle + composer + footer all populate the MEI + render
     into the page SVG. */
  titleBlock_all_fields: {
    setup: `
      m.setTitle('Sonata in A');
      m.setSubtitle('for piano');
      m.setComposer('J. S. Bach');
      m.setFooter('Engraved with HKL Composer');
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      r();
    `,
  },
  /* Empty footer suppresses the footer injection. */
  titleBlock_emptyFooter: {
    setup: `
      m.setTitle('Untitled');
      m.setFooter('');
      r();
    `,
  },
  /* Same-moment dynamic + text lay out SIDE BY SIDE, not stacked (backlog,
     Layout: sonata p. 21 m. 99's piano `p` and "dim." both landed at tstamp 1
     because Finale's horizontal nudge is dropped at import, so Verovio drew
     them at one x and stacked them vertically — and the block-cluster rule
     preserved that stack). Imported rather than built through the model, since
     import is how the case arises: two <direction>s at position 0 of a wide
     4/4 measure, same staff, same placement, hence the same @tstamp. */
  engr_sameMomentDynamAndDirSideBySide: {
    setup: `
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">'
        + '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + '<direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type></direction>'
        + '<direction placement="below"><direction-type><words font-style="italic">cresc.</words></direction-type></direction>'
        + '<note><pitch><step>C</step><octave>5</octave></pitch><duration>24</duration><voice>1</voice><type>quarter</type></note>'
        + '<note><pitch><step>D</step><octave>5</octave></pitch><duration>24</duration><voice>1</voice><type>quarter</type></note>'
        + '<note><pitch><step>E</step><octave>5</octave></pitch><duration>24</duration><voice>1</voice><type>quarter</type></note>'
        + '<note><pitch><step>F</step><octave>5</octave></pitch><duration>24</duration><voice>1</voice><type>quarter</type></note>'
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },

  /* ── Engraving conventions (2026-09-04, backlog Correctness + Opinionation) ──
   * Each fixture pins one convention: what the document says AND what Verovio
   * drew, so a Verovio upgrade that changes the mechanism shows up here. Every
   * assertion lives in FIXTURE_ASSERTIONS under the same name. */
  /* Tie stubs (<lv>) render as g.lv, which the dark theme's fill rule missed —
     the arc stayed black on the dark surface. */
  engr_darkTieStubFilled: {
    setup: `
      window.__hkl_composer.renderer.setTheme('dark');
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#055ad1', lightColorHex: '#4C96FF', velocity: 80 }], duration: '4', dots: 0 });
      m.toggleTieOnCurrent('insert');
      r();
    `,
  },
  /* MusicXML import, two parts (1-staff viola + 2-staff piano): the brace and
     the through-barlines belong to the piano group only; nothing joins the
     instruments. Until 2026-09-04 the importer braced the ROOT group. */
  engr_importTwoPartsBraceOnPianoOnly: {
    setup: `
      const A = (staves) => '<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>'
        + (staves === 2 ? '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>' : '<clef><sign>C</sign><line>3</line></clef>')
        + '</attributes>';
      const W = (s, o, staff, voice) => '<note><pitch><step>' + s + '</step><octave>' + o + '</octave></pitch><duration>16</duration><voice>' + voice + '</voice><type>whole</type>'
        + (staff ? '<staff>' + staff + '</staff>' : '') + '</note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>Viola</part-name></score-part><score-part id="P2"><part-name>Piano</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">' + A(1) + W('C', 4, 0, 1) + '</measure></part>'
        + '<part id="P2"><measure number="1">' + A(2) + W('C', 5, 1, 1) + '<backup><duration>16</duration></backup>' + W('C', 3, 2, 5) + '</measure></part>'
        + '</score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* A solo one-staff part gets no brace at all (Verovio braces any group that
     asks, a lone staff included). */
  engr_importSoloStaffNoBrace: {
    setup: `
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>Viola</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1"><attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>C</sign><line>3</line></clef></attributes>'
        + '<note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note></measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* The C-clef family draws in Bravura (2026-10-18): Leipzig's C clef leaves a
     0.84-space gap between its bowls (Bravura 0.42). The custom Verovio font
     "LeipzigHkl" (@hkl/notation music-font.ts) carries only Bravura's E05C /
     E05D / E07B; every other glyph falls back to Leipzig. Viola alto clef with a
     key signature (spacing), an in-measure change to tenor (E07B, cClefChange),
     a metronome mark (SMuFL <rend> text, which Verovio tags with the custom
     font's family), and a piano G/F pair that must stay Leipzig. */
  engr_cClefIsBravura: {
    setup: `
      const N = (s, o, staff, voice) => '<note><pitch><step>' + s + '</step><octave>' + o + '</octave></pitch><duration>4</duration><voice>' + voice + '</voice><type>quarter</type>'
        + (staff ? '<staff>' + staff + '</staff>' : '') + '</note>';
      const W = (s, o, staff, voice) => '<note><pitch><step>' + s + '</step><octave>' + o + '</octave></pitch><duration>16</duration><voice>' + voice + '</voice><type>whole</type>'
        + (staff ? '<staff>' + staff + '</staff>' : '') + '</note>';
      const key = '<key><fifths>-3</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>';
      ${CLEAR_ADOPTED_FONT_FACES}
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>Viola</part-name></score-part><score-part id="P2"><part-name>Piano</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1"><attributes><divisions>4</divisions>' + key + '<clef><sign>C</sign><line>3</line></clef></attributes>'
        + '<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>96</per-minute></metronome></direction-type><sound tempo="96"/></direction>'
        + N('C', 4, 0, 1) + N('D', 4, 0, 1)
        + '<attributes><clef><sign>C</sign><line>4</line></clef></attributes>'
        + N('E', 4, 0, 1) + N('F', 4, 0, 1) + '</measure></part>'
        + '<part id="P2"><measure number="1"><attributes><divisions>4</divisions>' + key + '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
        + W('E', 5, 1, 1) + '<backup><duration>16</duration></backup>' + W('C', 3, 2, 5) + '</measure></part>'
        + '</score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
    visualBaseline: 'engr_cclef_bravura',
  },
  /* A saved file in the OLD shape (root group braced + bar-through, nested
     piano group bare) is normalized on load: brace + bar.thru move to the
     grand staff. */
  engr_legacyRootBraceNormalizedOnLoad: {
    setup: `
      m.addInstrument({ name: 'Viola', staffCount: 1 });
      let legacy = m.serialize();
      legacy = legacy.replace('<staffGrp><staffGrp symbol="brace" bar.thru="true"><label>Piano</label>', '<staffGrp symbol="brace" bar.thru="true"><staffGrp><label>Piano</label>');
      if (!legacy.includes('<staffGrp symbol="brace" bar.thru="true"><staffGrp><label>Piano</label>')) throw new Error('legacy shape not constructed');
      m.replaceDocument(legacy);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* Finale's measured tremolo: two hollow beamed 32nds under a bracket-less,
     number-less 1:8 tuplet. The importer keeps the hollow heads and the hidden
     bracket/number (sonata m. 93 drew a bracket and a "1" until 2026-09-04) and
     ignores the source's <stem> (Max, 2026-09-05: element placement, not
     Finale replication, is the goal). */
  engr_importMeasuredTremoloTuplet: {
    setup: `
      const TM = '<time-modification><actual-notes>1</actual-notes><normal-notes>8</normal-notes><normal-type>16th</normal-type></time-modification>';
      const N = (s, o, beam, tup) => '<note><pitch><step>' + s + '</step><octave>' + o + '</octave></pitch><duration>8</duration><voice>1</voice><type>32nd</type>' + TM
        + '<stem>up</stem><notehead filled="no">normal</notehead><beam number="1">' + beam + '</beam><beam number="2">' + beam + '</beam><beam number="3">' + beam + '</beam>'
        + '<notations>' + tup + '</notations></note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1"><attributes><divisions>16</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes>'
        + N('D', 2, 'begin', '<tuplet bracket="no" number="1" show-number="none" type="start"/>')
        + N('D', 3, 'end', '<tuplet number="1" type="stop"/>')
        + '<note><rest/><duration>32</duration><voice>1</voice><type>half</type></note>'
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* Injected page text follows the page's REAL column at a non-default page
     size: footer centred in the bottom margin, composer credit at the right
     column edge. */
  engr_pageScaleRepositionsInjectedText: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setSubtitle('A Subtitle'); m.setFooter('Footer Text'); m.setComposer('A. Composer');
      m.setPageScale(140);
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      r();
    `,
  },
  /* Pages 2+: page number in the OUTER corner (even left, odd right) and the
     title as a centred running header; page 1 keeps Verovio's title block.
     Whole notes on a 60 % page buy three pages cheaply. */
  engr_runningHeaderCorners: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setTitle('Sonatina');
      m.setPageScale(60);
      m.setCursor(0, 1);
      for (let i = 0; i < 110; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      r();
    `,
    skipCursorTrace: true,
  },
  /* Two identical rests at one moment in the two voices of a staff draw as
     ONE rest, centred — Verovio pushed them above and below the staff. */
  engr_identicalRestsMerge: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(1); m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [N(5, 81)], duration: '4', dots: 0 });
      m.insertRestAtCursor({ duration: '2', dots: 0 });
      m.setVoice(2); m.setCursor(0, 2);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [N(4, 60)], duration: '4', dots: 0 });
      m.insertRestAtCursor({ duration: '2', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* A hidden rest in the other voice must not displace a visible rest — the
     visible one sits where it would alone. */
  engr_hiddenRestNeutral: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(1); m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [N(5, 81)], duration: '4', dots: 0 });
      m.setVoice(2); m.setCursor(0, 2);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.toggleHideRestAtCursor('insert');
      m.insertChordAtCursor({ notes: [N(4, 60)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* A section (movement) break with a key + meter change draws no courtesy
     METER at the end of the previous system; the new section starts with its
     clef, key and (visible) meter. The courtesy KEY still draws — Verovio's
     only switch for it (section restart) also restates the instrument labels,
     which Max ruled out (2026-09-05). Render-clone only. */
  engr_sectionBreakNoCourtesySigs: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setCursor(0, 1);
      for (let i = 0; i < 8; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.setSectionHeaderAt(4, 'II');
      m.setKeySigAt(4, '3s', 'major');
      m.setMeterAt(4, 3, 4);
      m.setCursor(0, 1);
      r();
    `,
  },
  /* A dynamic under the upper staff of a grand staff is centred between the
     two staves (the DOM pass in render/textlayout.ts). */
  engr_dynamicCenteredInGrandStaff: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N(5, 81)], duration: '1', dots: 0 });
      m.setVoice(3); m.setCursor(0, 3); m.insertChordAtCursor({ notes: [N(2, 45)], duration: '1', dots: 0 });
      const doc = m.getDoc(); const meas = doc.querySelector('measure');
      const d = doc.createElementNS('http://www.music-encoding.org/ns/mei', 'dynam');
      d.setAttribute('xml:id', 'd-test-center'); d.setAttribute('tstamp', '1'); d.setAttribute('place', 'between'); d.setAttribute('staff', '1'); d.textContent = 'p';
      meas.appendChild(d);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* Expressive text under a single-line instrument keeps at least the
     dynamics' clearance from the staff. */
  engr_dirClearanceBelowSingleStaff: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Viola', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(5, 81)], duration: '1', dots: 0 });
      const doc = m.getDoc(); const meas = doc.querySelector('measure');
      const MEI = 'http://www.music-encoding.org/ns/mei';
      const d = doc.createElementNS(MEI, 'dir');
      d.setAttribute('xml:id', 'dir-test-gap'); d.setAttribute('tstamp', '1'); d.setAttribute('place', 'below'); d.setAttribute('staff', '3');
      const rend = doc.createElementNS(MEI, 'rend'); rend.setAttribute('fontstyle', 'italic'); rend.textContent = 'dolce'; d.appendChild(rend);
      meas.appendChild(d);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* A movement (section) break in a two-instrument score (2026-09-05): the
     render clone wraps the boundary scoreDef in a Verovio restart carrying
     continuation labels (notation/sectionRestart.ts), so the line before it
     ends WITHOUT a courtesy key or meter, and the new movement's first system
     looks like any other continuation system — same labels (none here: the
     instruments have no <labelAbbr>), same indent — while the score's first
     system keeps its full instrument names. A third, plain section break
     (no signature change → no scoreDef → no restart) provides the
     continuation system to compare against. */
  engr_sectionRestartMatchesContinuationSystems: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Viola', staffCount: 1 });
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 12; i++) m.insertChordAtCursor({ notes: [N(4, 69)], duration: '1', dots: 0 });
      m.setSectionHeaderAt(4, 'II');
      m.setKeySigAt(4, '3s', 'major');
      m.setMeterAt(4, 3, 4);
      m.setSectionHeaderAt(8, 'III');
      m.setCursor(0, 1);
      r();
    `,
  },
  /* Barlines never break, and text marks stay off them (2026-09-05). A
     dynamic at tstamp 5 in 4/4 sits exactly on the m1|m2 barline; Verovio
     erases the grand-staff barline under it (draw-time only) and Composer
     then centres the dynamic in the gap — render/barlines.ts refills the
     barline and render/textlayout.ts moves the mark inside its own measure
     first. A wide dynamic under m3's first note exercises the left barline. */
  engr_barlineUnbrokenUnderDynamic: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [N(5, 81)], duration: '1', dots: 0 });
      m.setVoice(3); m.setCursor(0, 3);
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [N(2, 45)], duration: '1', dots: 0 });
      const doc = m.getDoc(); const MEI = 'http://www.music-encoding.org/ns/mei';
      const meas = doc.querySelectorAll('measure');
      const dyn = (mi, tstamp, text, id) => { const d = doc.createElementNS(MEI, 'dynam'); d.setAttribute('xml:id', id); d.setAttribute('tstamp', String(tstamp)); d.setAttribute('place', 'between'); d.setAttribute('staff', '1'); d.textContent = text; meas[mi].appendChild(d); };
      dyn(0, 5, 'p', 'd-test-barline-end');
      dyn(2, 1, 'sfz', 'd-test-barline-start');
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
    visualBaseline: 'engr_barline_unbroken',
  },
  /* Two-voice slur side (Max's invariant, 2026-09-05): a slur is never on the
     tuplet-bracket side and avoids the beam side. Upper voice: a slurred
     triplet of eighths (stems up → beams + bracket above); lower voice: a
     whole-note chord. Verovio's layer rule put the slur above; the render pass
     sets @curvedir to the notehead side (below). */
  engr_slurNoteheadSideTwoVoice: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(1); m.setCursor(0, 1);
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
      m.setCursor(1, 1);
      m.insertChordAtCursor({ notes: [N(5, 81)], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [N(5, 81)], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [N(5, 81)], duration: '8', dots: 0 });
      m.setVoice(2); m.setCursor(0, 2);
      m.insertChordAtCursor({ notes: [N(4, 60)], duration: '1', dots: 0 });
      m.setVoice(1);
      const doc = m.getDoc();
      const notes = [...doc.querySelectorAll('staff[n="1"] layer[n="1"] tuplet note')];
      const MEI = 'http://www.music-encoding.org/ns/mei';
      const sl = doc.createElementNS(MEI, 'slur');
      sl.setAttribute('xml:id', 's-test-2v'); sl.setAttribute('startid', '#' + notes[0].getAttribute('xml:id')); sl.setAttribute('endid', '#' + notes[2].getAttribute('xml:id')); sl.setAttribute('data-voice', '1');
      doc.querySelector('measure').appendChild(sl);
      m.setCursor(0, 1);
      r();
    `,
  },
  /* The flip yields to the other voice (2026-10-17, sonata III mm. 71–72,
     piano RH — Max: the flipped slur "literally colliding with the notes in
     the other voice"): upper voice a slurred triplet a5 g5 e5 (stems up),
     lower voice a chord g4 b4 e5 on the same beat — its top is a FOURTH under
     the slur's start and level with its end, so no curve fits below. The side
     pass flips only when no other-voice head whose onset lies within the
     slur's span comes within a fourth of the slur's farthest own head on the
     flip side (the lowest head anywhere under a below-slur); here it leaves
     Verovio's layer side — above the beam, where Finale puts it. */
  engr_slurKeepsLayerSideOverOtherVoice: {
    setup: `
      const N = (p, o, midi) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(1); m.setCursor(0, 1);
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
      m.setCursor(1, 1);
      m.insertChordAtCursor({ notes: [N('a', 5, 81)], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [N('g', 5, 79)], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [N('e', 5, 76)], duration: '8', dots: 0 });
      m.setVoice(2); m.setCursor(0, 2);
      m.insertChordAtCursor({ notes: [N('g', 4, 67), N('b', 4, 71), N('e', 5, 76)], duration: '4', dots: 0 });
      m.setVoice(1);
      const doc = m.getDoc();
      const notes = [...doc.querySelectorAll('staff[n="1"] layer[n="1"] tuplet note')];
      const MEI = 'http://www.music-encoding.org/ns/mei';
      const sl = doc.createElementNS(MEI, 'slur');
      sl.setAttribute('xml:id', 's-test-2v-keep'); sl.setAttribute('startid', '#' + notes[0].getAttribute('xml:id')); sl.setAttribute('endid', '#' + notes[2].getAttribute('xml:id')); sl.setAttribute('data-voice', '1');
      doc.querySelector('measure').appendChild(sl);
      m.setCursor(0, 1);
      r();
    `,
  },
  /* The global gate: a unison with the slur's END note blocks the flip even
     though the START has nine steps of room (2026-10-17; sonata I m. 79 —
     "m. 83" in the 2026-09-05 entries, the first movement's numbering has
     since shifted by four): upper voice two beamed triplets descending
     d♭4 → b2 under one slur, lower voice a double-dotted-half chord b1+b2
     sharing the slur's downbeat column. Until 2026-10-17 the side pass
     flipped this slur below and render/slurlayout.ts re-drew Verovio's
     displaced start (fixture engr_slurBelowRedrawnAtNotes); the chord's b2 is
     level with the slur's lowest note, so the flip is now refused and the
     slur keeps Verovio's layer side. (An unstemmed whole-note chord a
     seventh below — sonata I m. 78 — still flips: engr_slurNoteheadSideTwoVoice.) */
  engr_slurKeepsLayerSideUnisonInSpan: {
    setup: `
      const N = (p, a, o, midi) => ({ q: 0, r: 0, pname: p, accid: a, oct: o, midi, colorHex: '#888', velocity: 80 });
      const E = (p, a, o, midi) => m.insertChordAtCursor({ notes: [N(p, a, o, midi)], duration: '8', dots: 0 });
      m.setVoice(3); m.setCursor(0, 3);
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
      m.setCursor(1, 3);
      E('d', 'f', 4, 61); E('b', '', 3, 59); E('g', '', 3, 55);
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
      E('e', '', 3, 52); E('d', 'f', 3, 49); E('b', '', 2, 47);
      m.insertChordAtCursor({ notes: [N('g', '', 2, 43), N('e', '', 3, 52)], duration: '4', dots: 0 });
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setVoice(4); m.setCursor(0, 4);
      m.insertChordAtCursor({ notes: [N('b', '', 1, 35), N('b', '', 2, 47)], duration: '2', dots: 2 });
      m.insertRestAtCursor({ duration: '8', dots: 0 });
      m.setVoice(3);
      const doc = m.getDoc();
      const notes = [...doc.querySelectorAll('staff[n="2"] layer[n="1"] tuplet note')];
      const MEI = 'http://www.music-encoding.org/ns/mei';
      const sl = doc.createElementNS(MEI, 'slur');
      sl.setAttribute('xml:id', 's-test-2v-unison'); sl.setAttribute('startid', '#' + notes[0].getAttribute('xml:id')); sl.setAttribute('endid', '#' + notes[notes.length - 1].getAttribute('xml:id')); sl.setAttribute('data-voice', '3');
      doc.querySelector('measure').appendChild(sl);
      m.setCursor(0, 3);
      r();
    `,
  },
  /* A bracketless tuplet numeral clears its beam (2026-09-05, sonata p. 17):
     a steep beamed triplet in the bass, f3 → b♭3 → d♭4, whose "3" Verovio set
     7.7 px INTO the beam; render/tupletnums.ts moves it clear. Voice 3 is the
     piano's bass staff. */
  engr_tupletNumClearsSteepBeam: {
    setup: `
      const N = (p, a, o, midi) => ({ q: 0, r: 0, pname: p, accid: a, oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(3); m.setCursor(0, 3);
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
      m.setCursor(1, 3);
      m.insertChordAtCursor({ notes: [N('f', '', 3, 53)], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [N('b', 'f', 3, 58)], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [N('d', 'f', 4, 61)], duration: '8', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* A slur over a tuplet numeral the numeral pass lifted (2026-10-18, sonata
     III p. 16 mm. 31–32, piano LH): Verovio's own curve clears the "3" where
     Verovio put it; render/tupletnums.ts then lifts the numeral 1.4 units off
     its steep beam, into the slur, and nothing re-routed an UNFLIPPED slur (the
     re-draw takes flipped slurs only). The lift pass (render/slurlayout.ts,
     `liftSlursOffShiftedNumerals`) raises Verovio's control points along the
     slur's normal until both edges clear the lifted numeral — endpoints and
     thickness kept (Max: variant B). Material: piano LH b2 quarter + a steep
     beamed triplet f3 b♭3 d♭4 under one slur from the b2 to the d♭4; the lower
     voice's g2 halves sit a third under the b2 so the side pass keeps the slur
     above (the beam side); ten plain measures after it fill the line so the
     triplet is spaced naturally — a lone measure is justified wide, the beam
     goes shallow and the numeral needs no lift. The assertion checks that
     precondition. */
  engr_slurLiftedOffShiftedNumeral: {
    setup: `
      const N = (p, o, midi, q, rr, accid = '') => ({ q, r: rr, pname: p, accid, oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(3); m.setCursor(0, 3);
      m.insertChordAtCursor({ notes: [N('b', 2, 47, 0, 2)], duration: '4', dots: 0 });
      m.setCursor(1, 3);
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
      m.setCursor(2, 3);
      m.insertChordAtCursor({ notes: [N('f', 3, 53, -1, 0)], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [N('b', 3, 58, -2, 3, 'f')], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [N('d', 4, 61, -2, 0, 'f')], duration: '8', dots: 0 });
      m.setVoice(4); m.setCursor(0, 4);
      m.insertChordAtCursor({ notes: [N('g', 2, 43, 0, -2)], duration: '2', dots: 0 });
      m.insertChordAtCursor({ notes: [N('g', 2, 43, 0, -2)], duration: '2', dots: 0 });
      for (let i = 0; i < 10; i++) { m.setVoice(3); m.setCursor(m.getVoiceLength(3), 3); for (let k = 0; k < 4; k++) m.insertChordAtCursor({ notes: [N('c', 3, 48, 1, -1)], duration: '4', dots: 0 }); }
      const doc = m.getDoc(); const MEI = 'http://www.music-encoding.org/ns/mei';
      const notes = [...doc.querySelector('staff[n="2"] layer[n="1"]').querySelectorAll('note')];
      const sl = doc.createElementNS(MEI, 'slur');
      sl.setAttribute('xml:id', 's-test-lift'); sl.setAttribute('startid', '#' + notes[0].getAttribute('xml:id')); sl.setAttribute('endid', '#' + notes[3].getAttribute('xml:id')); sl.setAttribute('data-voice', '3');
      doc.querySelector('measure').appendChild(sl);
      /* The steep beam needs bar 1 on a dense line: F lays these 11 bars out
         as 3+4+4 at fill ~0.6 (no line compressed past 1.00), where the old
         balancer's 5+6 packed it. A lock before bar 6 restores the 5-bar
         first line (fill ~0.87) without compressing anything. */
      m.setLineLockAt(5, true);
      m.setVoice(3); m.setCursor(0, 3);
      r();
    `,
  },
  /* A flipped slur broken at a system break is re-drawn segment by segment
     (2026-09-05, sonata m. 43→44): bass staff, upper voice quarters under a
     slur that crosses a page break, lower voice whole-note chords g1+e2 (just
     under the staff, where Verovio parks the open ends).
     Verovio parks a below-slur's open ends just under the staff, so the first
     segment dives away from its notes and the continuation climbs back through
     the staff and the lower voice; both open ends are now anchored to the
     covered noteheads. The upper line a3 f3 d3 f3 (mid-staff, since
     2026-10-17) keeps the slur's lowest note a sixth over the chord's e2, so
     the flip holds under the global fourth gate — the original d3 b2 g2 b2
     put g2 a third over e2, which now refuses the flip — and leaves Verovio's
     parked open ends well away from the covered notes, so both segments are
     displaced and re-drawn. */
  engr_slurBrokenAtBreakRedrawn: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      const N = (p, o, midi) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(3); m.setCursor(0, 3);
      const line = [['a', 3, 57], ['f', 3, 53], ['d', 3, 50], ['f', 3, 53]];
      for (let i = 0; i < 8 * 4; i++) { const [p, o, mi] = line[i % 4]; m.insertChordAtCursor({ notes: [N(p, o, mi)], duration: '4', dots: 0 }); }
      m.setVoice(4); m.setCursor(0, 4);
      for (let i = 0; i < 8; i++) m.insertChordAtCursor({ notes: [N('g', 1, 31), N('e', 2, 40)], duration: '1', dots: 0 });
      const doc = m.getDoc();
      const notes = [...doc.querySelectorAll('staff[n="2"] layer[n="1"] note')];
      const MEI = 'http://www.music-encoding.org/ns/mei';
      const sl = doc.createElementNS(MEI, 'slur');
      sl.setAttribute('xml:id', 's-test-broken'); sl.setAttribute('startid', '#' + notes[13].getAttribute('xml:id')); sl.setAttribute('endid', '#' + notes[18].getAttribute('xml:id')); sl.setAttribute('data-voice', '3');
      notes[13].closest('measure').appendChild(sl);
      m.togglePageBreakAt(4);
      m.setVoice(3); m.setCursor(0, 3);
      r();
    `,
    skipCursorTrace: true,
  },
  /* One stem direction under a slur (2026-09-05, Max: a slurred group should
     make all its stems face one way). m1: a single-voice slur over f4 g4
     [c5 d5] a4 — Verovio stems the beamed pair down and the rest up, then
     puts the slur above, on the beam; notation/slurStems.ts writes the
     majority direction (up) on every note and the slur follows to the
     notehead side (below). m2: the same shape with a5 as the minority note —
     six steps over the middle line, past the cap — keeps Verovio's mixed
     stems. */
  engr_slurUnifiesMixedStems: {
    setup: `
      const N = (p, o, midi) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      const Q = (p, o, midi, dur) => m.insertChordAtCursor({ notes: [N(p, o, midi)], duration: dur, dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      Q('f', 4, 65, '4'); Q('g', 4, 67, '4'); Q('c', 5, 72, '8'); Q('d', 5, 74, '8'); Q('a', 4, 69, '4');
      Q('f', 4, 65, '4'); Q('g', 4, 67, '4'); Q('a', 5, 81, '4'); Q('a', 4, 69, '4');
      const doc = m.getDoc(); const MEI = 'http://www.music-encoding.org/ns/mei';
      const meas = [...doc.querySelectorAll('measure')];
      const slurOver = (mi, id) => { const notes = [...meas[mi].querySelectorAll('staff[n="1"] layer[n="1"] note')]; const sl = doc.createElementNS(MEI, 'slur'); sl.setAttribute('xml:id', id); sl.setAttribute('startid', '#' + notes[0].getAttribute('xml:id')); sl.setAttribute('endid', '#' + notes[notes.length - 1].getAttribute('xml:id')); sl.setAttribute('data-voice', '1'); meas[mi].appendChild(sl); };
      slurOver(0, 's-test-unify'); slurOver(1, 's-test-cap');
      m.setCursor(0, 1);
      r();
    `,
  },
  /* A stem the other voice forces decides the slurred group (2026-09-05, Max:
     sonata III m. 3→4, piano LH — "the slur goes through the stems"). Voice 3:
     a single-voice triplet a3 b3 c4 before the barline (stems naturally down
     in bass clef) slurred to a d4 after it, where voice 4 holds a whole-note
     chord — Verovio stems that d4 UP by layer. The side pass then flips the
     slur below, under the triplet's down stems; with the forced d4 as a
     fixed vote the triplet's stems go up too and the slur lies clear below.
     The cap does not apply to a fixed group. Voice 4's chord is written into
     m2 directly so m1 keeps its <space> (a cursor insert would autofill m1
     with rests, which count as content). */
  engr_slurStemsFollowForcedVoice: {
    setup: `
      const N = (p, o, midi) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      const Q = (p, o, midi, dur) => m.insertChordAtCursor({ notes: [N(p, o, midi)], duration: dur, dots: 0 });
      m.setVoice(3); m.setCursor(0, 3);
      m.insertRestAtCursor({ duration: '2', dots: 0 }); m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
      m.setCursor(3, 3);
      Q('a', 3, 57, '8'); Q('b', 3, 59, '8'); Q('c', 4, 60, '8');
      Q('d', 4, 62, '4');
      const doc = m.getDoc(); const MEI = 'http://www.music-encoding.org/ns/mei'; const XML = 'http://www.w3.org/XML/1998/namespace';
      const meas = [...doc.querySelectorAll('measure')];
      const l2 = meas[1].querySelector('staff[n="2"] > layer[n="2"]');
      while (l2.firstChild) l2.removeChild(l2.firstChild);
      const ch = doc.createElementNS(MEI, 'chord'); ch.setAttributeNS(XML, 'xml:id', 'c-test-forced'); ch.setAttribute('dur', '1');
      for (const [p, o, i] of [['g', 1, 'a'], ['d', 2, 'b']]) { const n = doc.createElementNS(MEI, 'note'); n.setAttributeNS(XML, 'xml:id', 'n-test-forced-' + i); n.setAttribute('pname', p); n.setAttribute('oct', String(o)); ch.appendChild(n); }
      l2.appendChild(ch);
      const trip = [...meas[0].querySelectorAll('staff[n="2"] layer[n="1"] tuplet note')];
      const end = meas[1].querySelector('staff[n="2"] layer[n="1"] note');
      const sl = doc.createElementNS(MEI, 'slur'); sl.setAttributeNS(XML, 'xml:id', 's-test-forced'); sl.setAttribute('startid', '#' + trip[0].getAttribute('xml:id')); sl.setAttribute('endid', '#' + end.getAttribute('xml:id')); sl.setAttribute('data-voice', '3');
      meas[0].appendChild(sl);
      m.setCursor(0, 3);
      r();
    `,
  },
  /* Theme switch in place (backlog 2026-09-05: "switching to light sometimes
     doesn't switch note colors back until another rerender"): a page mounted
     under the dark theme carries its own data-notation-theme tag; the light
     switch must clear it, or the dark ink rules keep matching that page and
     paint its noteheads white once their inline dark paint is removed. */
  engr_themeLightSwitchClearsPageTags: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [N(4, 69)], duration: '4', dots: 0 });
      const R = window.__hkl_composer.renderer;
      R.setTheme('dark'); R.forceFullRerender(); r();
      window.__darkTags = document.querySelectorAll('#score [data-notation-theme]').length;
      R.setTheme('light'); R.applyThemeToRendered();
    `,
  },
  /* A hairpin standing alone under a single-line instrument goes to the
     dynamics' line (2026-09-05, sonata mm. 49–52): Verovio hugs it to the staff
     (0.3 space) while dynamDist puts a dynamic 1.2 spaces down, so a crescendo
     into an `f` read as a step. m1: a lone crescendo; m2: a `p` at the downbeat
     — Verovio's placement, untouched; it defines the line. */
  engr_hairpinAloneOnDynamicsLine: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Viola', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5);
      for (let i = 0; i < 2; i++) m.insertChordAtCursor({ notes: [N(5, 81)], duration: '1', dots: 0 });
      const doc = m.getDoc(); const MEI = 'http://www.music-encoding.org/ns/mei';
      const meas = doc.querySelectorAll('measure');
      const h = doc.createElementNS(MEI, 'hairpin');
      h.setAttribute('xml:id', 'h-test-alone'); h.setAttribute('tstamp', '1'); h.setAttribute('tstamp2', '0m+4'); h.setAttribute('form', 'cres'); h.setAttribute('place', 'below'); h.setAttribute('staff', '3');
      meas[0].appendChild(h);
      const d = doc.createElementNS(MEI, 'dynam');
      d.setAttribute('xml:id', 'd-test-line'); d.setAttribute('tstamp', '1'); d.setAttribute('place', 'below'); d.setAttribute('staff', '3'); d.textContent = 'p';
      meas[1].appendChild(d);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* A clef change at a SECTION start is folded into the boundary scoreDef on
     the render clone (notation/sectionRestart.ts, 2026-09-06): no courtesy
     clef before the movement's final barline, the new movement simply begins
     in its clef, no restated labels; the saved document keeps the
     layer-initial <clef>. */
  engr_sectionBreakNoCourtesyClef: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setCursor(0, 1);
      for (let i = 0; i < 8; i++) m.insertChordAtCursor({ notes: [N(4, 69)], duration: '1', dots: 0 });
      m.setSectionHeaderAt(4, 'II');
      /* A layer-initial clef at the head of the section's first measure — the
         shape the importer and setClefAt (cursor on the measure's first note)
         both produce. */
      const layer = m.allMeasures()[4].querySelector('staff[n="1"] > layer[n="1"]');
      const clef = m.getDoc().createElementNS('http://www.music-encoding.org/ns/mei', 'clef');
      clef.setAttribute('xml:id', 'clf-test-section'); clef.setAttribute('shape', 'F'); clef.setAttribute('line', '4');
      layer.insertBefore(clef, layer.firstChild);
      m.setCursor(0, 1);
      r();
    `,
  },
  /* Expressive text above a staff clears the staff's slur (render/textlayout.ts,
     2026-09-06): Verovio places the <dir> against the notes and lets a slur
     arching over them run through it (sonata p. 21 m. 94). */
  engr_dirAboveClearsSlur: {
    setup: `
      const N = (p, o, midi) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [N('c', 6, 84)], duration: '2', dots: 0 });
      m.insertChordAtCursor({ notes: [N('c', 6, 84)], duration: '2', dots: 0 });
      const doc = m.getDoc(); const meas = doc.querySelector('measure');
      const notes = [...meas.querySelectorAll('staff[n="1"] layer[n="1"] note')];
      const MEI = 'http://www.music-encoding.org/ns/mei';
      const s = doc.createElementNS(MEI, 'slur'); s.setAttribute('xml:id', 's-test-above-dir'); s.setAttribute('startid', '#' + notes[0].getAttribute('xml:id')); s.setAttribute('endid', '#' + notes[1].getAttribute('xml:id')); s.setAttribute('curvedir', 'above'); meas.appendChild(s);
      const d = doc.createElementNS(MEI, 'dir'); d.setAttribute('xml:id', 'dir-test-above-slur'); d.setAttribute('tstamp', '2'); d.setAttribute('place', 'above'); d.setAttribute('staff', '1'); d.textContent = 'rit.'; meas.appendChild(d);
      m.setCursor(0, 1); r();
    `,
  },
  /* A grand-staff <dir> centred in the gap stops short of a CHORD's stem
     (render/textlayout.ts, 2026-09-29; sonata p. 6, the piano's "cresc." over
     the left hand's A♭–C–E♭ in m. 90). A stem is a stroked zero-width path, so its
     getBBox has no width and the obstacle filter dropped it; a single note's
     stem still counted through its g.note box, but a chord's stem hangs off
     g.chord, which is no obstacle — the centring move ran straight through it. */
  engr_dirCenteredClearsChordStem: {
    setup: `
      const P = (step, alter, oct, dur, type, staff, extra) => '<note>' + (extra || '') + '<pitch><step>' + step + '</step>'
        + (alter ? '<alter>' + alter + '</alter>' : '') + '<octave>' + oct + '</octave></pitch>'
        + '<duration>' + dur + '</duration><voice>' + (staff === 2 ? 5 : 1) + '</voice><type>' + type + '</type>'
        + (alter ? '<accidental>flat</accidental>' : '') + '<staff>' + staff + '</staff></note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">'
        + '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>'
        + '<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
        + '<direction placement="below"><direction-type><words font-style="italic">cresc.</words></direction-type><staff>1</staff></direction>'
        + P('D', 0, 5, 96, 'whole', 1)
        + '<backup><duration>96</duration></backup>'
        /* The chords sit INSIDE the bass staff so their noteheads cannot clamp
           the move; only the up-stems, 3.5 spaces tall, reach the gap. The
           importer drops <stem>, so the stems are forced up the way the
           sonata's were: a second layer (voice 6's low C) under the chords. */
        + P('C', 0, 3, 48, 'half', 2, '') + P('E', 0, 3, 48, 'half', 2, '<chord/>') + P('A', 0, 3, 48, 'half', 2, '<chord/>')
        + P('C', 0, 3, 48, 'half', 2, '') + P('E', 0, 3, 48, 'half', 2, '<chord/>') + P('A', 0, 3, 48, 'half', 2, '<chord/>')
        + '<backup><duration>96</duration></backup>'
        + '<note><pitch><step>C</step><octave>2</octave></pitch><duration>96</duration><voice>6</voice><type>whole</type><staff>2</staff></note>'
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* Two voices on one staff: voice 1's rest inside a tuplet stays ON the staff
     (raised to loc 6) when voice 2's low note leaves room, instead of
     Verovio's lift into the tuplet bracket (notation/restlayout.ts,
     2026-09-06; sonata p. 17 m. 35). MusicXML import builds the two voices. */
  engr_tupletRestOnStaffTwoVoice: {
    setup: `
      const TM = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
      const V1 = (body, extra) => '<note>' + body + '<duration>8</duration><voice>1</voice><type>eighth</type>' + TM + (extra || '') + '</note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list><part id="P1">'
        + '<measure number="1"><attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes>'
        + V1('<rest/>', '<notations><tuplet type="start"/></notations>')
        + V1('<pitch><step>G</step><octave>2</octave></pitch>')
        + V1('<pitch><step>E</step><octave>3</octave></pitch>', '<notations><tuplet type="stop"/></notations>')
        + '<note><rest/><duration>24</duration><voice>1</voice><type>quarter</type></note>'
        + '<note><rest/><duration>24</duration><voice>1</voice><type>quarter</type></note>'
        + '<backup><duration>72</duration></backup>'
        + '<note><pitch><step>C</step><octave>2</octave></pitch><duration>24</duration><voice>2</voice><type>quarter</type></note>'
        + '<note><pitch><step>C</step><octave>2</octave></pitch><duration>48</duration><voice>2</voice><type>half</type></note>'
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* Page-1 title block (render/pageheader.ts, 2026-09-06): title at 600 px,
     subtitle clear below it, first system below both; pages 2+ carry the
     running title and page number at the footer's 320 px. */
  engr_titleBlockSizes: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setTitle('Sonata for Viola and Piano'); m.setSubtitle('for Viola and Piano'); m.setComposer('Max Randal, Op. 12');
      m.setCursor(0, 1);
      for (let i = 0; i < 100; i++) m.insertChordAtCursor({ notes: [N(4, 69)], duration: '1', dots: 0 });
      m.setCursor(0, 1);
      r();
    `,
  },
  /* The same title block rendered with NO usable getBBox on a <tspan> — what
     Gecko gives (Max, 2026-09-06: on Firefox "no gap is honored at all",
     while Chromium looked correct). pageheader.ts used to derive every gap
     from tspan getBBox, so on Firefox `styleTitle` hit its catch, returned
     null, and the credit fell to the `blockBottom === null ? 0` branch — onto
     the title's own line, with the title left at Verovio's 540 px. The block
     is now pure em-box arithmetic; this fixture holds it that way by making
     the call Gecko lacks throw, and asserting the SAME geometry as
     engr_titleBlockSizes. The override is undone by RESET_SNIPPET. */
  engr_titleBlockWithoutTspanBBox: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      window.__hklOrigTspanBBox = SVGTSpanElement.prototype.getBBox;
      SVGTSpanElement.prototype.getBBox = function () { throw new Error('NS_ERROR_FAILURE (simulated Gecko)'); };
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setTitle('Sonata for Viola and Piano'); m.setSubtitle('for Viola and Piano'); m.setComposer('Max Randal, Op. 12');
      m.setCursor(0, 1);
      for (let i = 0; i < 24; i++) m.insertChordAtCursor({ notes: [N(4, 69)], duration: '1', dots: 0 });
      m.setCursor(0, 1);
      window.__hkl_composer.renderer.forceFullRerender();
      r();
    `,
    fullRender: 'the poisoned getBBox must be in place for the header restyle itself, so the fixture forces the engrave it is asserting about',
  },
  /* The composer credit is PAGE FURNITURE (Max, backlog Layout: "Scroll view
     shouldn't show composer text at the end"). Scroll renders with Verovio's
     `header: 'none'`, so there is no title block for the credit to sit under —
     `styleTitleBlock` synthesized a credit-only `g.pgHead` and right-aligned
     the text to the page frame's width, which in scroll view IS the single
     continuous system: the composer's name appeared at the far END of the
     piece. Build a titled document in page view (where the credit is drawn,
     asserted by engr_titleBlockSizes), then switch to scroll and assert the
     credit and its synthesized header are both gone. Asserted via
     FIXTURE_ASSERTIONS.engr_scrollNoComposerCredit. */
  engr_scrollNoComposerCredit: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setTitle('Sonata for Viola and Piano'); m.setSubtitle('for Viola and Piano'); m.setComposer('Max Randal, Op. 12');
      m.setCursor(0, 1);
      for (let i = 0; i < 12; i++) m.insertChordAtCursor({ notes: [N(4, 69)], duration: '1', dots: 0 });
      m.setCursor(0, 1);
      r();
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    `,
  },
  /* Max's 2026-09-06 regression: voice 1 rests against a voice-2 chord topping
     at the middle line (b4) and at the third space (c5) touched the top head
     (the head's ink box is 1.1 locations tall above its centre, not 0.5).
     Every voice-1 rest must clear the chord's top head by half a space. */
  engr_twoVoiceRestClearsChordHead: {
    setup: `
      const NOTE = (s, o, dur, type, voice, extra) => '<note><pitch><step>' + s + '</step><octave>' + o + '</octave></pitch><duration>' + dur + '</duration><voice>' + voice + '</voice><type>' + type + '</type>' + (extra || '') + '</note>';
      const REST = (dur, type) => '<note><rest/><duration>' + dur + '</duration><voice>1</voice><type>' + type + '</type></note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list><part id="P1">'
        + '<measure number="1"><attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + REST(12, 'eighth') + NOTE('E', 5, 12, 'eighth', 1) + REST(24, 'quarter') + REST(48, 'half')
        + '<backup><duration>96</duration></backup>'
        + NOTE('G', 4, 48, 'half', 2) + NOTE('B', 4, 48, 'half', 2, '').replace('<note>', '<note><chord/>')
        + NOTE('A', 4, 48, 'half', 2) + NOTE('C', 5, 48, 'half', 2, '').replace('<note>', '<note><chord/>')
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* Tempo markings are restated above EVERY part (notation/parts.ts,
     2026-09-09, backlog Layout): the model keeps one score-global <tempo>, so
     before this a two-part score drew "Allegro" above the top staff only —
     while an imported "rit.", which Finale writes into each part and the
     importer turns into a per-part <dir>, appeared above both. The copies are
     made on the render clone BEFORE the single-part filter, so a view of the
     violin alone keeps the marking too (it used to lose every tempo: the
     filter drops control events anchored to a hidden staff). */
  engr_tempoRestatedAbovePart: {
    setup: `
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N(4, 69)], duration: '4', dots: 0 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(5, 81)], duration: '4', dots: 0 });
      const doc = m.getDoc(); const meas = doc.querySelector('measure');
      const MEI = 'http://www.music-encoding.org/ns/mei';
      const XMLNS = 'http://www.w3.org/XML/1998/namespace';
      const t = doc.createElementNS(MEI, 'tempo');
      t.setAttributeNS(XMLNS, 'xml:id', 'tempo-test-parts');
      t.setAttribute('tstamp', '1'); t.setAttribute('place', 'above'); t.setAttribute('staff', '1');
      t.textContent = 'Allegro';
      meas.appendChild(t);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* On a grand staff a fermata belongs OUTSIDE the braced pair
     (notation/parts.ts, 2026-09-09, backlog Layout). Verovio puts one above
     the note's own staff, which for the lower staff of the pair lands in the
     inter-staff gap; the render clone pins the top staff's above and the
     bottom staff's below, where Verovio draws the inverted glyph itself. */
  engr_fermataOutsideGrandStaff: {
    setup: `
      const N = (o, pname, midi) => ({ q: 0, r: 0, pname, accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N(5, 'a', 81)], duration: '4', dots: 0 });
      m.toggleArticulationAtCursor('insert', 'fermata');
      m.setVoice(3); m.setCursor(0, 3); m.insertChordAtCursor({ notes: [N(3, 'c', 48)], duration: '4', dots: 0 });
      m.toggleArticulationAtCursor('insert', 'fermata');
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* A mark inside a grand staff stays CENTRED when render/instrgap.ts has
     shifted that instrument (2026-09-09). instrgap tags the shift on a mark
     and leaves the transform to textlayout, which owns it — so textlayout has
     to MEASURE the mark in the shifted frame too. It did not: the staff rows
     read post-shift and the mark's own box pre-shift, so the `dy` it derived
     already contained the shift and `translate(dx, dy + ish)` applied it
     twice. Every mark on a shifted instrument landed a whole shift low (sonata
     p. 9 m. 131's `pp` on the staff below it, p. 17 m. 37's `dim.` inside a
     tuplet bracket, both with the room they wanted unused above).
     The shape is the sonata's: a single-staff instrument ABOVE a grand staff,
     since instrgap only ever shifts instruments BELOW a boundary. The viola's
     low C3 puts its `f` some four spaces under its own staff and one space
     over the piano — nearer the piano than its own staff, which is exactly the
     demand instrgap exists to meet — and the piano's own `p` is the centred
     mark under test. The piano's outer notes (A5, C2) keep its grand-staff gap
     clear of ink so the centring is unclamped and the assertion can be exact. */
  engr_instrGapCenteredDynamic: {
    setup: `
      const ATTR = (extra) => '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time>' + extra + '</attributes>';
      const DYN = (which, staff) => '<direction placement="below"><direction-type><dynamics><' + which + '/></dynamics></direction-type><staff>' + staff + '</staff></direction>';
      const WHOLE = (step, oct, voice, staff) => '<note><pitch><step>' + step + '</step><octave>' + oct + '</octave></pitch>'
        + '<duration>96</duration><voice>' + voice + '</voice><type>whole</type>' + (staff ? '<staff>' + staff + '</staff>' : '') + '</note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list>'
        + '<score-part id="P1"><part-name>Viola</part-name></score-part>'
        + '<score-part id="P2"><part-name>Piano</part-name></score-part>'
        + '</part-list>'
        + '<part id="P1"><measure number="1">'
        + ATTR('<clef><sign>C</sign><line>3</line></clef>')
        + DYN('f', 1) + WHOLE('C', 3, 1)
        + '</measure></part>'
        + '<part id="P2"><measure number="1">'
        + ATTR('<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>')
        + DYN('p', 1)
        + WHOLE('A', 5, 1, 1)
        + '<backup><duration>96</duration></backup>'
        + WHOLE('C', 2, 5, 2)
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* A same-moment dynamic + word inside a GRAND STAFF must not inflate the
     inter-staff gap (2026-09-09; Max on the sonata's p. 21 second system:
     "the system as a whole is leaving far too much vertical space within the
     grand staff"). Verovio reserves an inter-staff row per stacked mark and
     sizes the gap to hold the stack, and no DOM move afterwards gives that
     space back — probed on m. 99: @ho and @vgrp changed nothing, deleting the
     <dir> took the gap from 13.25 staff spaces to 7.25. notation/unstack.ts
     nudges the mover's tstamp on the render clone instead, so Verovio engraves
     ONE row: m. 99 came back at 7.75 spaces. This fixture holds the reclaim —
     it fails if the pass stops running and the second row comes back. */
  engr_unstackReclaimsGrandStaffGap: {
    setup: `
      const N = (step, oct, dur, type, staff) => '<note><pitch><step>' + step + '</step><octave>' + oct + '</octave></pitch>'
        + '<duration>' + dur + '</duration><voice>' + (staff === 2 ? 5 : 1) + '</voice><type>' + type + '</type><staff>' + staff + '</staff></note>';
      const WORDS = (t) => '<direction placement="below"><direction-type><words font-style="italic">' + t + '</words></direction-type><staff>1</staff></direction>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">'
        + '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>'
        + '<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
        + '<direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type><staff>1</staff></direction>'
        + WORDS('dim.') + WORDS('poco') + WORDS('rit.')
        /* Why FOUR marks at one moment and not the sonata's two: the stack has
           to be the BINDING constraint on the gap, and Verovio's spacingStaff
           floor already holds two rows. Probed on this document — with a
           dynamic + one word the gap is 8.69 staff spaces with the pass ON or
           OFF, and squeezing the staves with ledger lines only moves both to
           11.81; neither gates anything. A four-row stack exceeds the floor,
           which is the sonata's situation (its gap was content-driven), and it
           exercises the chained nudge (1.25 / 1.5 / 1.75) as well. */
        + N('C', 5, 24, 'quarter', 1) + N('D', 5, 24, 'quarter', 1) + N('E', 5, 24, 'quarter', 1) + N('F', 5, 24, 'quarter', 1)
        + '<backup><duration>96</duration></backup>'
        + N('C', 3, 24, 'quarter', 2) + N('D', 3, 24, 'quarter', 2) + N('E', 3, 24, 'quarter', 2) + N('F', 3, 24, 'quarter', 2)
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
};

export const ASSERTIONS = {
  /* The dynamic anchors the cluster and must not move horizontally; the <dir>
     ends up clear to its RIGHT and vertically overlapping it (not stacked). */
  engr_sameMomentDynamAndDirSideBySide: [
    { name: 'the DOCUMENT keeps both marks on one @tstamp; only the render clone separates them',
      expr: `(() => {
        /* The whole liberty notation/unstack.ts takes is clone-only: the saved
           document, playback and editing must never see the nudge. */
        const doc = window.__hkl_composer.model.getDoc();
        const dynEl = doc.querySelector('dynam'), dirEl = doc.querySelector('dir');
        if (!dynEl || !dirEl) return { ok: false, detail: 'doc dynam=' + !!dynEl + ' dir=' + !!dirEl };
        const k = (e) => e.getAttribute('tstamp') + '/' + e.getAttribute('staff') + '/' + e.getAttribute('place');
        if (k(dynEl) !== k(dirEl)) return { ok: false, detail: 'document drifted: ' + k(dynEl) + ' vs ' + k(dirEl) };
        if (dirEl.hasAttribute('hkl-unstack')) return { ok: false, detail: 'the clone-only tag leaked into the document' };
        return { ok: true };
      })()` },
    { name: 'the RENDERED <dir> is nudged off the shared tstamp and names its anchor',
      expr: `(() => {
        const dyn = document.querySelector('#score g.dynam');
        const dir = document.querySelector('#score g.dir');
        if (!dyn || !dir) return { ok: false, detail: 'dynam=' + !!dyn + ' dir=' + !!dir };
        if (dir.getAttribute('data-hkl-unstack') !== dyn.id) return { ok: false, detail: 'data-hkl-unstack=' + dir.getAttribute('data-hkl-unstack') + ' want ' + dyn.id };
        const ts = (e) => e.getAttribute('data-tstamp');
        /* Equal tstamps mean the pre-engrave pass did not run and the DOM
           fallback separated them — which leaves the inflated gap behind. */
        if (ts(dyn) === ts(dir)) return { ok: false, detail: 'rendered tstamps still equal (' + ts(dyn) + '): the pre-engrave nudge did not run' };
        if (dyn.getAttribute('data-staff') !== dir.getAttribute('data-staff')
          || dyn.getAttribute('data-place') !== dir.getAttribute('data-place')) {
          return { ok: false, detail: 'staff/place drifted' };
        }
        return { ok: true };
      })()` },
    { name: 'the <dir> sits one staff space clear to the RIGHT of the dynamic, on its line',
      expr: `(() => {
        const dyn = document.querySelector('#score g.dynam').getBoundingClientRect();
        const dir = document.querySelector('#score g.dir').getBoundingClientRect();
        if (!(dir.left >= dyn.right - 1)) return { ok: false, detail: 'dir.left=' + dir.left.toFixed(1) + ' dyn.right=' + dyn.right.toFixed(1) + ' (still stacked)' };
        const vOverlap = Math.min(dyn.bottom, dir.bottom) - Math.max(dyn.top, dir.top);
        if (!(vOverlap > 0)) return { ok: false, detail: 'no vertical overlap: ' + vOverlap.toFixed(1) };
        /* One staff space, measured from the staff itself so the check does not
           hard-code a zoom. PAD (a quarter space) is the value Max reported as
           too tight; the clearance is UNSTACK_GAP = one space. */
        const staff = document.querySelector('#score g.measure g.staff[data-n="1"]');
        const ys = [...staff.children].filter((p) => p.tagName === 'path').map((p) => p.getBoundingClientRect()).filter((b) => b.height <= 2.5).map((b) => b.top);
        const space = (Math.max(...ys) - Math.min(...ys)) / 4;
        const gap = dir.left - dyn.right;
        if (!(gap > 0.6 * space && gap < 1.5 * space)) return { ok: false, detail: 'clearance ' + gap.toFixed(1) + 'px = ' + (gap / space).toFixed(2) + ' staff spaces (want ~1)' };
        return { ok: true };
      })()` },
    { name: 'the dynamic itself was not shifted horizontally',
      expr: `(() => {
        const dyn = document.querySelector('#score g.dynam');
        const hs = dyn.getAttribute('data-hkl-hshift');
        return (hs === null || hs === '0') ? { ok: true } : { ok: false, detail: 'dynam data-hkl-hshift=' + hs };
      })()` },
  ],
  /* ── Title block (subtitle + composer + footer) ─────────────── */
  titleBlock_all_fields: [
    { name: 'MEI carries subtitle, composer persName, and footer attr',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const subtitleEl = [...m.getDoc().querySelectorAll('titleStmt > title')].find(t => t.getAttribute('type') === 'subtitle');
        const personName = m.getDoc().querySelector('titleStmt persName[role="composer"]');
        const footerAttr = m.getFooter();
        const fails = [];
        if (subtitleEl?.textContent !== 'for piano') fails.push('subtitle="' + subtitleEl?.textContent + '"');
        if (personName?.textContent !== 'J. S. Bach') fails.push('composer="' + personName?.textContent + '"');
        if (footerAttr !== 'Engraved with HKL Composer') fails.push('footer="' + footerAttr + '"');
        return fails.length === 0 ? { ok: true } : { ok: false, detail: fails.join(' ') };
      })()` },
    { name: 'rendered SVG includes <text class="hkl-injected-composer"> and <text class="hkl-injected-footer">',
      expr: `(() => {
        const composer = document.querySelectorAll('.hkl-injected-composer');
        const footer = document.querySelectorAll('.hkl-injected-footer');
        return (composer.length >= 1 && footer.length >= 1)
          ? { ok: true } : { ok: false, detail: 'composer=' + composer.length + ' footer=' + footer.length };
      })()` },
    { name: 'subtitle "for piano" renders in Verovio header (pgHead has third tspan)',
      expr: `(() => {
        const head = document.querySelector('.score-page g.pgHead');
        const txt = head?.textContent ?? '';
        return txt.includes('for piano')
          ? { ok: true } : { ok: false, detail: 'pgHead text=' + JSON.stringify(txt) };
      })()` },
    { name: 'composer rendered BELOW title baseline (viewport y greater)',
      expr: `(() => {
        /* The title block is Composer's since 2026-10-08 (pageshell.ts): text.hkl-title, not Verovio's g.text. */
        const title = document.querySelector('.score-page g.pgHead text.hkl-title')?.getBoundingClientRect();
        const composer = document.querySelector('text.hkl-injected-composer')?.getBoundingClientRect();
        if (!title || !composer) return { ok: false, detail: 'missing element' };
        return composer.top > title.bottom - 1
          ? { ok: true }
          : { ok: false, detail: 'titleBottom=' + title.bottom + ' composerTop=' + composer.top };
      })()` },
    { name: 'footer is below the rendered score system + not italic',
      expr: `(() => {
        const system = document.querySelector('.score-page g.system')?.getBoundingClientRect();
        const footer = document.querySelector('text.hkl-injected-footer');
        const footerR = footer?.getBoundingClientRect();
        if (!system || !footerR) return { ok: false, detail: 'missing' };
        const style = footer.getAttribute('font-style');
        return (footerR.top > system.bottom && style !== 'italic')
          ? { ok: true }
          : { ok: false, detail: 'systemBottom=' + system.bottom + ' footerTop=' + footerR.top + ' style=' + style };
      })()` },
  ],
  titleBlock_emptyFooter: [
    { name: 'no <text.hkl-injected-footer> when footer is empty',
      expr: `(() => {
        const footer = document.querySelectorAll('.hkl-injected-footer');
        return footer.length === 0 ? { ok: true } : { ok: false, detail: 'count=' + footer.length };
      })()` },
  ],
  /* ── Engraving conventions (2026-09-04) ── */
  engr_darkTieStubFilled: [
    { name: 'the <lv> stub arc is filled with the dark-theme ink',
      expr: `(async () => {
        /* A render after a heavy predecessor is deferred past the runner's RAF
           wait, so settle first, then apply the theme to whatever is rendered
           (idempotent) — the assertion is about the CSS rule, not the timing. */
        for (let i = 0; i < 500; i++) { const b = document.getElementById('renderBusy'); if (!b || b.hidden) break; await new Promise((r) => setTimeout(r, 20)); }
        const R = window.__hkl_composer.renderer;
        R.setTheme('dark'); R.applyThemeToRendered();
        const p = document.querySelector('#score svg g.lv path');
        const fill = p ? getComputedStyle(p).fill : null;
        R.setTheme('light'); R.applyThemeToRendered();
        if (!p) return { ok: false, detail: 'no g.lv rendered' };
        return fill === 'rgb(242, 242, 242)' ? { ok: true } : { ok: false, detail: 'lv fill=' + fill };
      })()` },
  ],
  engr_importTwoPartsBraceOnPianoOnly: [
    { name: 'root group bare; piano group braced + bar.thru; viola group bare',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const root = doc.querySelector('scoreDef > staffGrp');
        const nested = [...root.children].filter(c => c.localName === 'staffGrp');
        if (root.hasAttribute('symbol') || root.hasAttribute('bar.thru')) return { ok: false, detail: 'root symbol=' + root.getAttribute('symbol') + ' bar.thru=' + root.getAttribute('bar.thru') };
        if (nested.length !== 2) return { ok: false, detail: 'nested=' + nested.length };
        const [vla, pno] = nested;
        if (vla.hasAttribute('symbol') || vla.hasAttribute('bar.thru')) return { ok: false, detail: 'viola group symbol=' + vla.getAttribute('symbol') };
        if (pno.getAttribute('symbol') !== 'brace' || pno.getAttribute('bar.thru') !== 'true') return { ok: false, detail: 'piano symbol=' + pno.getAttribute('symbol') + ' bar.thru=' + pno.getAttribute('bar.thru') };
        return { ok: true };
      })()` },
    { name: 'one brace drawn; barlines do not run between viola and piano',
      expr: `(() => {
        const sys = document.querySelector('#score g.system');
        if (!sys) return { ok: false, detail: 'no system' };
        const braces = sys.querySelectorAll('g.grpSym').length;
        if (braces !== 1) return { ok: false, detail: 'grpSym count=' + braces };
        const rows = {};
        for (const st of sys.querySelector('g.measure').querySelectorAll(':scope > g.staff')) {
          const ys = [...st.querySelectorAll(':scope > path')].map(p => +(p.getAttribute('d').match(/M\\S+ (\\S+)/)[1]));
          rows[st.getAttribute('data-n')] = { top: Math.min(...ys), bot: Math.max(...ys) };
        }
        if (!rows[1] || !rows[2] || !rows[3]) return { ok: false, detail: 'rows=' + JSON.stringify(rows) };
        let joinsInstruments = false, joinsPiano = false;
        for (const p of sys.querySelectorAll('g.barLine path, g.barLineAttr path')) {
          const mt = (p.getAttribute('d') || '').match(/M\\S+ (\\S+) L\\S+ (\\S+)/);
          if (!mt) continue;
          const y1 = Math.min(+mt[1], +mt[2]), y2 = Math.max(+mt[1], +mt[2]);
          if (y1 <= rows[1].bot + 1 && y2 >= rows[2].top - 1) joinsInstruments = true;
          if (y1 <= rows[2].bot + 1 && y2 >= rows[3].top - 1) joinsPiano = true;
        }
        if (joinsInstruments) return { ok: false, detail: 'a barline spans viola → piano' };
        if (!joinsPiano) return { ok: false, detail: 'no barline spans the piano grand staff' };
        return { ok: true };
      })()` },
  ],
  engr_importSoloStaffNoBrace: [
    { name: 'no brace on a solo single-staff part',
      expr: `(() => {
        const root = window.__hkl_composer.model.getDoc().querySelector('scoreDef > staffGrp');
        if (root.hasAttribute('symbol')) return { ok: false, detail: 'root symbol=' + root.getAttribute('symbol') };
        const n = document.querySelectorAll('#score g.grpSym').length;
        return n === 0 ? { ok: true } : { ok: false, detail: 'grpSym count=' + n };
      })()` },
  ],
  engr_cClefIsBravura: [
    /* Outline starts copied from Verovio version-6.3.0 data (Bravura/<code>.xml)
       and the Leipzig font (uni<code>): the drawn glyph, not the font name. */
    { name: 'C clefs (opening E05C + in-measure E07B) draw Bravura outlines; G/F clefs stay Leipzig',
      expr: `(() => {
        const WANT = { E05C: 'M230 482', E07B: 'M102 317', E050: 'M441 -245', E062: 'M582 -120' };
        const seen = {};
        for (const u of document.querySelectorAll('#score g.clef use')) {
          const href = u.getAttribute('xlink:href') || u.getAttribute('href') || '';
          const code = href.slice(1, 5);
          const p = document.querySelector(href + ' path');
          const d = p ? p.getAttribute('d') : '(no def)';
          if (WANT[code] && !d.startsWith(WANT[code])) return { ok: false, detail: code + ' outline starts ' + d.slice(0, 14) + ', want ' + WANT[code] };
          seen[code] = (seen[code] || 0) + 1;
        }
        const missing = Object.keys(WANT).filter(c => !seen[c]);
        return missing.length ? { ok: false, detail: 'no rendered ' + missing.join('/') + ' clef; seen ' + JSON.stringify(seen) } : { ok: true };
      })()` },
    { name: 'viola clef → key signature gap ≥ 0.9 staff space (layout reserved the Bravura width)',
      expr: `(() => {
        const st = [...document.querySelectorAll('#score g.staff')].find(s => s.querySelector(':scope > g.clef') && s.querySelector(':scope > g.keySig'));
        if (!st) return { ok: false, detail: 'no staff with an opening clef + key signature' };
        const ys = [...st.querySelectorAll(':scope > path')].map(p => p.getBBox()).filter(b => b.height < 1).map(b => b.y).sort((a, b) => a - b);
        if (ys.length < 5) return { ok: false, detail: 'staff lines found: ' + ys.length };
        const space = (ys[4] - ys[0]) / 4;
        const c = st.querySelector(':scope > g.clef').getBBox(), k = st.querySelector(':scope > g.keySig').getBBox();
        const gap = (k.x - (c.x + c.width)) / space;
        return gap >= 0.9 ? { ok: true } : { ok: false, detail: 'gap=' + gap.toFixed(2) + ' staff spaces' };
      })()` },
    { name: 'metronome mark (page assembly): its SMuFL note glyph draws in a loaded face',
      expr: `(async () => {
        ${METRONOME_FONT_CHECK}
        return { ok: true };
      })()` },
  ],
  engr_legacyRootBraceNormalizedOnLoad: [
    { name: 'brace + bar.thru moved from the root to the piano group on load',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const root = doc.querySelector('scoreDef > staffGrp');
        const nested = [...root.children].filter(c => c.localName === 'staffGrp');
        if (root.hasAttribute('symbol') || root.hasAttribute('bar.thru')) return { ok: false, detail: 'root still symbol=' + root.getAttribute('symbol') };
        const pno = nested.find(g => g.querySelector('label')?.textContent === 'Piano');
        if (!pno || pno.getAttribute('symbol') !== 'brace' || pno.getAttribute('bar.thru') !== 'true') return { ok: false, detail: 'piano group=' + (pno && pno.outerHTML.slice(0, 80)) };
        const vla = nested.find(g => g.querySelector('label')?.textContent === 'Viola');
        if (!vla || vla.hasAttribute('symbol')) return { ok: false, detail: 'viola group braced' };
        return { ok: true };
      })()` },
  ],
  engr_importMeasuredTremoloTuplet: [
    { name: 'tuplet imports bracket/number-less with hollow noteheads (stems are Verovio\'s, not Finale\'s)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const t = doc.querySelector('tuplet');
        if (!t) return { ok: false, detail: 'no tuplet' };
        if (t.getAttribute('bracket.visible') !== 'false' || t.getAttribute('num.visible') !== 'false') return { ok: false, detail: 'bracket.visible=' + t.getAttribute('bracket.visible') + ' num.visible=' + t.getAttribute('num.visible') };
        const notes = [...t.querySelectorAll('note')];
        if (notes.length !== 2) return { ok: false, detail: 'notes=' + notes.length };
        for (const n of notes) {
          if (n.getAttribute('head.fill') !== 'void') return { ok: false, detail: 'head.fill=' + n.getAttribute('head.fill') };
          if (n.hasAttribute('stem.dir')) return { ok: false, detail: 'source stems must not be imported (Max, 2026-09-05)' };
        }
        return { ok: true };
      })()` },
    { name: 'rendered tuplet has no bracket and no number',
      expr: `(() => {
        const t = document.querySelector('#score g.tuplet');
        if (!t) return { ok: false, detail: 'no g.tuplet rendered' };
        const b = t.querySelectorAll('g.tupletBracket').length, n = t.querySelectorAll('g.tupletNum').length;
        return b === 0 && n === 0 ? { ok: true } : { ok: false, detail: 'bracket=' + b + ' num=' + n };
      })()` },
  ],
  engr_pageScaleRepositionsInjectedText: [
    { name: 'footer centred in the bottom margin and composer at the column edge of the 140 % page',
      expr: `(() => {
        const page = document.querySelector('#score .score-page');
        const svg = page && page.querySelector('svg.definition-scale');
        const margin = page && page.querySelector('g.page-margin');
        if (!svg || !margin) return { ok: false, detail: 'no page svg' };
        const vb = svg.getAttribute('viewBox').split(/\\s+/).map(Number);
        const tr = margin.getAttribute('transform').match(/translate\\(\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/);
        const mx = +tr[1], my = +tr[2];
        const innerW = vb[2] - 2 * mx, innerH = vb[3] - 2 * my;
        if (Math.abs(innerW - 18790 * 1.4) > 30) return { ok: false, detail: 'innerW=' + innerW + ' (page not at 140 %?)' };
        const f = page.querySelector('text.hkl-injected-footer');
        if (!f) return { ok: false, detail: 'no footer' };
        const fx = +f.getAttribute('x'), fy = +f.getAttribute('y');
        if (Math.abs(fx - innerW / 2) > 1) return { ok: false, detail: 'footer x=' + fx + ' innerW/2=' + innerW / 2 };
        if (!(fy > innerH && fy < innerH + my)) return { ok: false, detail: 'footer y=' + fy + ' column bottom=' + innerH + ' paper bottom=' + (innerH + my) };
        const c = page.querySelector('text.hkl-injected-composer');
        if (!c) return { ok: false, detail: 'no composer credit' };
        if (Math.abs(+c.getAttribute('x') - innerW) > 1) return { ok: false, detail: 'composer x=' + c.getAttribute('x') + ' innerW=' + innerW };
        return { ok: true, detail: 'innerW=' + innerW + ' footer=(' + fx + ',' + fy + ')' };
      })()` },
  ],
  engr_runningHeaderCorners: [
    { name: 'page 2 number left, page 3 number right, running title on both, none on page 1',
      expr: `(() => {
        const r = window.__hkl_composer.renderer;
        const pages = [...document.querySelectorAll('#score .score-page')];
        if (pages.length < 3) return { ok: false, detail: 'pages=' + pages.length + ' (need 3)' };
        for (const p of pages.slice(0, 3)) if (p.classList.contains('score-page-pending')) r['mountPage'](+p.dataset.page);
        const info = (p) => {
          const margin = p.querySelector('g.page-margin');
          const vb = p.querySelector('svg.definition-scale').getAttribute('viewBox').split(/\\s+/).map(Number);
          const tr = margin.getAttribute('transform').match(/translate\\(\\s*(-?[\\d.]+)/);
          const innerW = vb[2] - 2 * (+tr[1]);
          /* The page number is Composer's since 2026-10-08 (render/pageshell.ts). */
          const rend = margin.querySelector('g.pgHead text.hkl-page-number[data-hkl-pgnum]');
          const title = margin.querySelector(':scope > text.hkl-running-title');
          const numText = rend ? (rend.textContent || '').trim() : null;
          return { innerW, numX: rend ? +rend.getAttribute('x') : null, anchor: rend ? rend.getAttribute('text-anchor') : null, numText, title: title ? title.textContent : null, titleX: title ? +title.getAttribute('x') : null };
        };
        const p1 = info(pages[0]), p2 = info(pages[1]), p3 = info(pages[2]);
        if (p1.numX !== null || p1.title !== null) return { ok: false, detail: 'page 1 has running header: ' + JSON.stringify(p1) };
        if (p2.numX !== 0 || p2.anchor !== 'start' || p2.numText !== '2') return { ok: false, detail: 'page 2: ' + JSON.stringify(p2) };
        if (p3.numX === null || Math.abs(p3.numX - p3.innerW) > 1 || p3.anchor !== 'end' || p3.numText !== '3') return { ok: false, detail: 'page 3: ' + JSON.stringify(p3) };
        if (p2.title !== 'Sonatina' || p3.title !== 'Sonatina') return { ok: false, detail: 'titles: ' + p2.title + ' / ' + p3.title };
        if (Math.abs(p2.titleX - p2.innerW / 2) > 1) return { ok: false, detail: 'title x=' + p2.titleX + ' innerW/2=' + p2.innerW / 2 };
        return { ok: true };
      })()` },
  ],
  engr_identicalRestsMerge: [
    { name: 'the two quarter rests at beat 1 coincide, centred on the staff',
      expr: `(() => {
        const staff = document.querySelector('#score g.measure g.staff[data-n="1"]');
        if (!staff) return { ok: false, detail: 'no staff 1' };
        const lines = [...staff.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect().top);
        const top = Math.min(...lines), bot = Math.max(...lines), space = (bot - top) / 4;
        const rests = [...staff.querySelectorAll('g.rest')].map(g => { const b = g.getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; });
        if (rests.length !== 4) return { ok: false, detail: 'rests=' + rests.length };
        rests.sort((a, b) => a.cx - b.cx);
        const [q1, q2, h1, h2] = rests;
        if (Math.abs(q1.cx - q2.cx) > 1 || Math.abs(q1.cy - q2.cy) > 1) return { ok: false, detail: 'quarter rests apart: ' + JSON.stringify([q1, q2]) };
        if (Math.abs(h1.cx - h2.cx) > 1 || Math.abs(h1.cy - h2.cy) > 1) return { ok: false, detail: 'half rests apart: ' + JSON.stringify([h1, h2]) };
        const mid = (top + bot) / 2;
        if (Math.abs(q1.cy - mid) > 0.5 * space) return { ok: false, detail: 'quarter rest cy=' + q1.cy + ' mid=' + mid + ' space=' + space };
        return { ok: true };
      })()` },
  ],
  engr_hiddenRestNeutral: [
    { name: 'the visible quarter rest sits at its single-layer place despite the hidden rest',
      expr: `(() => {
        const staff = document.querySelector('#score g.measure g.staff[data-n="1"]');
        if (!staff) return { ok: false, detail: 'no staff 1' };
        const lines = [...staff.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect().top);
        const top = Math.min(...lines), bot = Math.max(...lines), space = (bot - top) / 4, mid = (top + bot) / 2;
        const vis = [...staff.querySelectorAll('g.rest')].filter(g => g.getAttribute('data-visible') !== 'false');
        if (vis.length !== 1) return { ok: false, detail: 'visible rests=' + vis.length };
        const b = vis[0].getBoundingClientRect(); const cy = b.top + b.height / 2;
        return Math.abs(cy - mid) <= 0.5 * space ? { ok: true } : { ok: false, detail: 'rest cy=' + cy + ' mid=' + mid + ' space=' + space };
      })()` },
  ],
  engr_sectionBreakNoCourtesySigs: [
    { name: 'no courtesy meter before the section break; the new section shows key and meter',
      expr: `(() => {
        const systems = [...document.querySelectorAll('#score g.system')];
        if (systems.length < 2) return { ok: false, detail: 'systems=' + systems.length };
        const visibleSigs = (meas) => [...meas.querySelectorAll('g.keySig, g.meterSig')].filter(k => k.getBBox().width > 0).map(k => k.getAttribute('class'));
        const m1 = [...systems[0].querySelectorAll('g.measure')]; const last = m1[m1.length - 1];
        const caut = visibleSigs(last);
        if (caut.length) return { ok: false, detail: 'courtesy signatures drawn before the section break: ' + caut.join(',') };
        if (systems[1].querySelectorAll('g.label').length) return { ok: false, detail: 'instrument labels restated at the section start' };
        const first = systems[1].querySelector('g.measure');
        const sigs = visibleSigs(first);
        if (!sigs.includes('keySig') || !sigs.includes('meterSig')) return { ok: false, detail: 'section start sigs: ' + sigs.join(',') };
        const m = window.__hkl_composer.model;
        if (m.serialize().includes('meter.form=')) return { ok: false, detail: 'render-only meter.form leaked into the saved document' };
        return { ok: true };
      })()` },
  ],
  engr_slurKeepsLayerSideUnisonInSpan: [
    { name: 'the slur keeps the layer side (above, no @curvedir, untouched by the re-draw): the lower chord-top is a unison with the slur\'s lowest note',
      expr: `(() => {
        const staff = document.querySelector('#score g.measure g.staff[data-n="2"]');
        const g = document.getElementById('s-test-2v-unison');
        if (!staff || !g) return { ok: false, detail: 'staff=' + !!staff + ' slur=' + !!g };
        if (g.hasAttribute('data-curvedir')) return { ok: false, detail: 'side pass flipped the slur (data-curvedir=' + g.getAttribute('data-curvedir') + ')' };
        if (g.hasAttribute('data-hkl-slur')) return { ok: false, detail: 're-draw touched an unflipped slur (data-hkl-slur=' + g.getAttribute('data-hkl-slur') + ')' };
        const heads = [...staff.querySelectorAll('g.layer[data-n="1"] g.notehead')].map(h => h.getBoundingClientRect());
        const headTop = Math.min(...heads.map(h => h.top));
        const sb = g.getBoundingClientRect();
        if (!((sb.top + sb.bottom) / 2 < headTop)) return { ok: false, detail: 'slur centre ' + ((sb.top + sb.bottom) / 2).toFixed(1) + ' is not above the upper-voice noteheads (top ' + headTop.toFixed(1) + ')' };
        const path = g.querySelector('path'); const L = path.getTotalLength(); const ctm = path.getScreenCTM();
        const pts = []; for (let i = 0; i <= 64; i++) { const p = path.getPointAtLength(L * i / 64); pts.push(new DOMPoint(p.x, p.y).matrixTransform(ctm)); }
        const boxes = [...staff.querySelectorAll('g.layer[data-n="2"] g.notehead, g.layer[data-n="2"] g.stem')].map(e => e.getBoundingClientRect());
        for (const b of boxes) for (const p of pts) if (p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom) return { ok: false, detail: 'slur runs through a lower-voice glyph at (' + p.x.toFixed(0) + ',' + p.y.toFixed(0) + ')' };
        return { ok: true, detail: 'slur above its voice, ' + boxes.length + ' lower-voice boxes clear' };
      })()` },
  ],
  engr_slurKeepsLayerSideOverOtherVoice: [
    { name: 'the slur keeps the layer side (above, no @curvedir) and crosses no lower-voice notehead or stem',
      expr: `(() => {
        const staff = document.querySelector('#score g.measure g.staff[data-n="1"]');
        const g = document.getElementById('s-test-2v-keep');
        if (!staff || !g) return { ok: false, detail: 'staff=' + !!staff + ' slur=' + !!g };
        if (g.hasAttribute('data-curvedir')) return { ok: false, detail: 'side pass flipped the slur (data-curvedir=' + g.getAttribute('data-curvedir') + ')' };
        const heads = [...staff.querySelectorAll('g.layer[data-n="1"] g.notehead')].map(h => h.getBoundingClientRect());
        const headTop = Math.min(...heads.map(h => h.top));
        const sb = g.getBoundingClientRect();
        if (!((sb.top + sb.bottom) / 2 < headTop)) return { ok: false, detail: 'slur centre ' + ((sb.top + sb.bottom) / 2).toFixed(1) + ' is not above the upper-voice noteheads (top ' + headTop.toFixed(1) + ')' };
        const path = g.querySelector('path'); const L = path.getTotalLength(); const ctm = path.getScreenCTM();
        const pts = []; for (let i = 0; i <= 64; i++) { const p = path.getPointAtLength(L * i / 64); pts.push(new DOMPoint(p.x, p.y).matrixTransform(ctm)); }
        const boxes = [...staff.querySelectorAll('g.layer[data-n="2"] g.notehead, g.layer[data-n="2"] g.stem')].map(e => e.getBoundingClientRect());
        for (const b of boxes) for (const p of pts) if (p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom) return { ok: false, detail: 'slur runs through a lower-voice glyph at (' + p.x.toFixed(0) + ',' + p.y.toFixed(0) + ')' };
        return { ok: true, detail: 'slur above its voice, ' + boxes.length + ' lower-voice boxes clear' };
      })()` },
  ],
  engr_tupletNumClearsSteepBeam: [
    { name: 'the numeral clears its beam polygon by at least a third of a unit, measured at the beam edge',
      expr: `(() => {
        const tup = document.querySelector('#score g.tuplet');
        const num = tup && tup.querySelector('g.tupletNum'); const poly = tup && tup.querySelector('g.beam > polygon');
        if (!tup || !num || !poly) return { ok: false, detail: 'tuplet=' + !!tup + ' num=' + !!num + ' beam=' + !!poly };
        if (tup.querySelector('g.tupletBracket')) return { ok: false, detail: 'a wholly beamed triplet drew a bracket' };
        const nb = num.getBoundingClientRect(); const ctm = poly.getScreenCTM();
        const pts = poly.getAttribute('points').trim().split(/\\s+/).map(p => p.split(',').map(Number)).map(([x, y]) => new DOMPoint(x, y).matrixTransform(ctm));
        const yAt = (x) => { const ys = []; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; if ((a.x <= x && x <= b.x) || (b.x <= x && x <= a.x)) ys.push(a.x === b.x ? a.y : a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x)); } return ys.length ? [Math.min(...ys), Math.max(...ys)] : null; };
        const staff = tup.closest('g.staff'); const lines = [...staff.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect().top); const unit = (Math.max(...lines) - Math.min(...lines)) / 8;
        let clear = Infinity, side = null;
        for (let x = nb.left; x <= nb.right; x += 0.5) { const yy = yAt(x); if (!yy) continue; const numAbove = (nb.top + nb.bottom) / 2 < (yy[0] + yy[1]) / 2; side = numAbove ? 'above' : 'below'; clear = Math.min(clear, numAbove ? yy[0] - nb.bottom : nb.top - yy[1]); }
        if (clear === Infinity) return { ok: false, detail: 'the numeral does not overlap the beam in x — not the steep-beam case this fixture is for' };
        return clear >= unit / 3 ? { ok: true, detail: 'clearance ' + clear.toFixed(1) + 'px (' + side + '), shift ' + (num.getAttribute('data-hkl-numshift') || '0') } : { ok: false, detail: 'numeral ' + clear.toFixed(1) + 'px from its beam (' + side + '), want >= ' + (unit / 3).toFixed(1) };
      })()` },
  ],
  engr_slurLiftedOffShiftedNumeral: [
    { name: 'the lifted numeral is clear of the slur, which keeps its side, endpoints and thickness (lifted, not re-drawn)',
      expr: `(() => {
        const g = document.getElementById('s-test-lift'); const path = g && g.querySelector('path');
        const staff = document.querySelector('#score g.staff[data-n="2"]');
        const tup = staff && staff.querySelector('g.tuplet'); const num = tup && tup.querySelector('g.tupletNum');
        if (!path || !num) return { ok: false, detail: 'slur=' + !!path + ' numeral=' + !!num };
        if (tup.querySelector('g.tupletBracket')) return { ok: false, detail: 'the triplet drew a bracket — not the bracketless numeral this fixture is for' };
        const shift = num.getAttribute('data-hkl-numshift');
        if (!shift) return { ok: false, detail: 'the numeral pass did not lift the numeral (no data-hkl-numshift): the beam is not steep enough here, the fixture material has drifted' };
        if (g.hasAttribute('data-curvedir')) return { ok: false, detail: 'the side pass flipped the slur (data-curvedir=' + g.getAttribute('data-curvedir') + '); the fixture needs it on the beam side' };
        const heads = [...staff.querySelectorAll('g.layer[data-n="1"] g.notehead')].map((h) => h.getBoundingClientRect());
        const headTop = Math.min(...heads.map((h) => h.top)); const sb = g.getBoundingClientRect();
        if (!((sb.top + sb.bottom) / 2 < headTop)) return { ok: false, detail: 'slur is not above its noteheads' };
        const L = path.getTotalLength(), ctm = path.getScreenCTM(); const pts = [];
        for (let i = 0; i <= 120; i++) { const p = path.getPointAtLength(L * i / 120); pts.push(new DOMPoint(p.x, p.y).matrixTransform(ctm)); }
        const b = num.getBoundingClientRect();
        const inside = pts.filter((p) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom).length;
        if (inside) return { ok: false, detail: inside + ' slur samples inside the lifted numeral (shift ' + shift + ', mark ' + (g.getAttribute('data-hkl-slur') || 'none') + ')' };
        if (g.getAttribute('data-hkl-slur') !== 'lifted') return { ok: false, detail: 'expected data-hkl-slur="lifted", got ' + (g.getAttribute('data-hkl-slur') || 'none') };
        const nums = (d) => (d.match(/-?\\d+(\\.\\d+)?/g) || []).map(Number);
        const now = nums(path.getAttribute('d')), orig = nums(path.getAttribute('data-hkl-orig-d') || '');
        if (now.length !== 14 || orig.length !== 14) return { ok: false, detail: 'unexpected path shape: ' + now.length + ' / ' + orig.length + ' numbers' };
        const same = (i) => Math.abs(now[i] - orig[i]) <= 1 && Math.abs(now[i + 1] - orig[i + 1]) <= 1;
        if (!same(0) || !same(6) || !same(12)) return { ok: false, detail: 'the lift moved an endpoint: ' + JSON.stringify(now) + ' vs ' + JSON.stringify(orig) };
        const th = (a) => Math.hypot(a[2] - a[10], a[3] - a[11]) + Math.hypot(a[4] - a[8], a[5] - a[9]);
        if (Math.abs(th(now) - th(orig)) > 2) return { ok: false, detail: 'the lift changed the thickness: ' + th(now).toFixed(0) + ' vs ' + th(orig).toFixed(0) };
        return { ok: true, detail: 'numeral shift ' + shift + ', slur lifted clear of it, endpoints and thickness kept' };
      })()` },
  ],
  engr_slurBrokenAtBreakRedrawn: [
    { name: 'both segments are re-drawn, stay clear of the lower voice, and their open ends stay near the covered notes',
      expr: `(() => {
        const H = window.__hkl_composer; H.renderer.mountAllPages();
        const first = document.getElementById('s-test-broken');
        const cont = document.querySelector('#score g.slur.spanning.id-s-test-broken');
        if (!first || !cont) return { ok: false, detail: 'segments: first=' + !!first + ' continuation=' + !!cont + ' (is the slur broken at the page break?)' };
        const out = [];
        for (const [label, g, openIsEnd] of [['first', first, true], ['continuation', cont, false]]) {
          if (g.getAttribute('data-hkl-slur') === 'kept') return { ok: false, detail: label + ' segment could not be re-drawn clear (kept)' };
          if (!/^redrawn/.test(g.getAttribute('data-hkl-slur') || '')) return { ok: false, detail: label + ' segment was not re-drawn (data-hkl-slur=' + g.getAttribute('data-hkl-slur') + ') — the flip or the displacement is gone' };
          const path = g.querySelector('path'); const sys = g.closest('g.system'); const L = path.getTotalLength();
          const toS = (p) => new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM());
          const pts = []; for (let i = 0; i <= 48; i++) pts.push(toS(path.getPointAtLength(L / 2 * i / 48)));
          const staff = sys.querySelector('g.staff[data-n="2"]');
          const lines = [...staff.querySelectorAll(':scope > path')].map((p) => p.getBoundingClientRect().top); const space = (Math.max(...lines) - Math.min(...lines)) / 4;
          for (const nh of sys.querySelectorAll('g.staff[data-n="2"] g.layer[data-n="2"] g.notehead')) { const b = nh.getBoundingClientRect(); for (const p of pts) if (p.x >= b.left - 1 && p.x <= b.right + 1 && p.y >= b.top - 1 && p.y <= b.bottom + 1) return { ok: false, detail: label + ' segment runs through a lower-voice notehead' }; }
          const sb = g.getBoundingClientRect();
          const covered = [...sys.querySelectorAll('g.staff[data-n="2"] g.layer[data-n="1"] g.notehead')].map((h) => h.getBoundingClientRect()).filter((b) => b.right >= sb.left - 2 && b.left <= sb.right + 2);
          if (!covered.length) return { ok: false, detail: label + ': no covered noteheads' };
          const lowest = Math.max(...covered.map((b) => b.bottom));
          const open = openIsEnd ? pts[48] : pts[0];
          if (open.y - lowest > 2.5 * space) return { ok: false, detail: label + ' open end ' + ((open.y - lowest) / space).toFixed(1) + ' spaces below the covered noteheads' };
          out.push(label + ':' + (g.getAttribute('data-hkl-slur') || 'verovio') + ':' + ((open.y - lowest) / space).toFixed(1) + 'sp');
        }
        return { ok: true, detail: out.join(' ') };
      })()` },
  ],
  engr_slurUnifiesMixedStems: [
    { name: 'm1: every stem under the slur points up, the beam above and the slur below the noteheads; m2 (past the cap) keeps its mixed stems; the saved document carries no stem.dir',
      expr: `(() => {
        const meas = [...document.querySelectorAll('#score g.measure')];
        if (meas.length < 2) return { ok: false, detail: 'measures=' + meas.length };
        const stemOf = (n) => { const nh = n.querySelector(':scope > g.notehead'), st = n.querySelector(':scope > g.stem'); if (!nh || !st) return null; const a = nh.getBoundingClientRect(), b = st.getBoundingClientRect(); return (b.top + b.bottom) / 2 < (a.top + a.bottom) / 2 ? 'up' : 'down'; };
        const dirs = (mi) => [...meas[mi].querySelectorAll('g.note')].map(stemOf).filter(Boolean);
        const d1 = dirs(0), d2 = dirs(1);
        if (d1.length !== 5) return { ok: false, detail: 'm1 stems read: ' + d1.length };
        const s1 = document.getElementById('s-test-unify'), s2 = document.getElementById('s-test-cap');
        if (!s1 || !s2) return { ok: false, detail: 'slurs rendered: ' + !!s1 + ' ' + !!s2 };
        if (s1.getAttribute('data-hkl-stems') !== 'unified-up') return { ok: false, detail: 'm1 tag ' + s1.getAttribute('data-hkl-stems') };
        if (d1.some((d) => d !== 'up')) return { ok: false, detail: 'm1 stems not unified: ' + d1.join(',') };
        const heads = [...meas[0].querySelectorAll('g.notehead')].map((h) => h.getBoundingClientRect());
        const headBot = Math.max(...heads.map((h) => h.bottom)), headTop = Math.min(...heads.map((h) => h.top));
        const sb = s1.getBoundingClientRect(); const beam = meas[0].querySelector('g.beam > polygon');
        if (!beam) return { ok: false, detail: 'no beam in m1' };
        if (!((sb.top + sb.bottom) / 2 > headBot)) return { ok: false, detail: 'm1 slur not below its noteheads' };
        if (!(beam.getBoundingClientRect().bottom < headTop)) return { ok: false, detail: 'm1 beam not above its noteheads' };
        if (s2.getAttribute('data-hkl-stems') !== 'capped') return { ok: false, detail: 'm2 tag ' + s2.getAttribute('data-hkl-stems') };
        if (!(d2.includes('up') && d2.includes('down'))) return { ok: false, detail: 'm2 stems should stay mixed: ' + d2.join(',') };
        if (window.__hkl_composer.model.serialize().includes('stem.dir')) return { ok: false, detail: 'render-only stem.dir leaked into the saved document' };
        return { ok: true, detail: 'm1 ' + d1.join(',') + ' | m2 ' + d2.join(',') };
      })()` },
  ],
  engr_slurStemsFollowForcedVoice: [
    { name: 'every voice-3 stem under the slur points up like the forced d4, the slur lies below the noteheads and crosses no stem or beam, the saved document carries no stem.dir',
      expr: `(() => {
        const sys = document.querySelector('#score g.system'); const slur = document.getElementById('s-test-forced');
        if (!sys || !slur) return { ok: false, detail: 'system=' + !!sys + ' slur=' + !!slur };
        const notes = [...sys.querySelectorAll('g.staff[data-n="2"] g.layer[data-n="1"] g.note')];
        const stemOf = (n) => { const st = n.querySelector(':scope > g.stem'); const heads = [...n.querySelectorAll('g.notehead')].map((h) => h.getBoundingClientRect()); if (!st || !heads.length) return null; const b = st.getBoundingClientRect(); const top = Math.min(...heads.map((h) => h.top)), bot = Math.max(...heads.map((h) => h.bottom)); return b.top < top - 1 ? 'up' : b.bottom > bot + 1 ? 'down' : null; };
        const dirs = notes.map(stemOf);
        if (dirs.length !== 4) return { ok: false, detail: 'voice-3 notes read: ' + dirs.length };
        if (slur.getAttribute('data-hkl-stems') !== 'unified-up') return { ok: false, detail: 'tag ' + slur.getAttribute('data-hkl-stems') };
        if (dirs.some((d) => d !== 'up')) return { ok: false, detail: 'stems not all up: ' + dirs.join(',') };
        const heads = notes.flatMap((n) => [...n.querySelectorAll('g.notehead')]).map((h) => h.getBoundingClientRect());
        const headBot = Math.max(...heads.map((h) => h.bottom));
        const sb = slur.getBoundingClientRect();
        if (!((sb.top + sb.bottom) / 2 > headBot)) return { ok: false, detail: 'slur centre ' + ((sb.top + sb.bottom) / 2).toFixed(1) + ' not below the noteheads (' + headBot.toFixed(1) + ')' };
        /* The slur path against every voice-3 stem and beam box. */
        const path = slur.querySelector('path'); const L = path.getTotalLength(); const ctm = path.getScreenCTM();
        const pts = []; for (let i = 0; i <= 64; i++) { const p = path.getPointAtLength(L * i / 64); pts.push(new DOMPoint(p.x, p.y).matrixTransform(ctm)); }
        const boxes = [...sys.querySelectorAll('g.staff[data-n="2"] g.layer[data-n="1"] g.stem, g.staff[data-n="2"] g.layer[data-n="1"] g.beam > polygon')].map((e) => e.getBoundingClientRect());
        for (const b of boxes) for (const p of pts) if (p.x >= b.left - 0.5 && p.x <= b.right + 0.5 && p.y >= b.top - 0.5 && p.y <= b.bottom + 0.5) return { ok: false, detail: 'slur runs through a stem/beam box at (' + p.x.toFixed(0) + ',' + p.y.toFixed(0) + ')' };
        if (window.__hkl_composer.model.serialize().includes('stem.dir')) return { ok: false, detail: 'render-only stem.dir leaked into the saved document' };
        return { ok: true, detail: 'stems ' + dirs.join(',') };
      })()` },
  ],
  engr_themeLightSwitchClearsPageTags: [
    { name: 'the dark render tagged the page; after the switch to light no tag survives and the noteheads are their ink color again',
      expr: `(() => {
        if (!window.__darkTags) return { ok: false, detail: 'the dark render tagged nothing inside #score — the fixture no longer exercises the stale-tag path' };
        const score = document.getElementById('score');
        const tagged = [...score.querySelectorAll('[data-notation-theme]')].map(e => e.className).concat(score.dataset.notationTheme ? ['#score'] : []);
        if (tagged.length) return { ok: false, detail: 'still tagged after the light switch: ' + tagged.join(',') };
        const use = score.querySelector('g.note g.notehead use');
        if (!use) return { ok: false, detail: 'no notehead' };
        const fill = getComputedStyle(use).fill;
        const want = use.closest('g.note').getAttribute('data-color');
        const rgb = (h) => { const x = h.length === 4 ? h.slice(1).split('').map(c => c + c).join('') : h.slice(1); const n = parseInt(x, 16); return 'rgb(' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', ') + ')'; };
        if (want && fill !== rgb(want)) return { ok: false, detail: 'notehead fill ' + fill + ', ink ' + want };
        if (!want && (fill === 'rgb(255, 255, 255)' || fill === 'rgb(242, 242, 242)')) return { ok: false, detail: 'notehead still light-source ' + fill };
        return { ok: true };
      })()` },
  ],
  engr_hairpinAloneOnDynamicsLine: [
    { name: 'the lone hairpin is moved to the dynamics line; the dynamic itself is not moved',
      expr: `(() => {
        const meas = document.querySelectorAll('#score g.measure');
        const st = meas[0] && meas[0].querySelector(':scope > g.staff[data-n="3"]');
        const h = document.getElementById('h-test-alone'); const d = document.getElementById('d-test-line');
        if (!st || !h || !d) return { ok: false, detail: 'staff3=' + !!st + ' hairpin=' + !!h + ' dynam=' + !!d };
        const ys = [...st.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect().top);
        const bot = Math.max(...ys), space = (bot - Math.min(...ys)) / 4;
        if (!h.hasAttribute('data-hkl-vshift')) return { ok: false, detail: 'hairpin not laid out (no data-hkl-vshift)' };
        if (d.hasAttribute('data-hkl-vshift')) return { ok: false, detail: 'the dynamic was moved (vshift ' + d.getAttribute('data-hkl-vshift') + ')' };
        const hb = h.getBoundingClientRect(), db = d.getBoundingClientRect();
        /* (DIR_GAP 192 − HAIRPIN_LIFT 20) user units = 172 = 1.075 staff spaces; two px of slack. */
        const gap = hb.top - bot;
        if (Math.abs(gap - 1.075 * space) > 2) return { ok: false, detail: 'hairpin top gap=' + gap.toFixed(1) + 'px, want ' + (1.075 * space).toFixed(1) + ' (space ' + space.toFixed(1) + ')' };
        const hc = hb.top + hb.height / 2, dc = db.top + db.height / 2;
        return Math.abs(hc - dc) <= 0.6 * space ? { ok: true, detail: 'hairpin centre ' + hc.toFixed(1) + ' dynamic centre ' + dc.toFixed(1) } : { ok: false, detail: 'hairpin centre ' + hc.toFixed(1) + ' vs dynamic centre ' + dc.toFixed(1) };
      })()` },
  ],
  engr_dynamicCenteredInGrandStaff: [
    { name: 'the dynamic centre sits at the midpoint of the gap between the staves',
      expr: `(() => {
        const meas = document.querySelector('#score g.measure');
        const rows = {};
        for (const st of meas.querySelectorAll(':scope > g.staff')) {
          const ys = [...st.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect().top);
          rows[st.getAttribute('data-n')] = { top: Math.min(...ys), bot: Math.max(...ys) };
        }
        const d = document.querySelector('#score g.dynam');
        if (!d || !rows[1] || !rows[2]) return { ok: false, detail: 'dynam=' + !!d + ' rows=' + JSON.stringify(rows) };
        const b = d.getBoundingClientRect(); const cy = b.top + b.height / 2;
        const mid = (rows[1].bot + rows[2].top) / 2;
        /* Verovio's between pass centres the mark's reference point, not its
           glyph box — measured 0.31 space low on an mp (2026-10-07). Half a
           space of tolerance; the DOM centring (±2 px) is gone with it. */
        const space = (rows[1].bot - rows[1].top) / 4;
        if (d.getAttribute('data-place') !== 'between') return { ok: false, detail: 'data-place=' + d.getAttribute('data-place') };
        return Math.abs(cy - mid) <= 0.5 * space ? { ok: true, detail: 'cy-mid=' + (cy - mid).toFixed(1) + 'px' } : { ok: false, detail: 'cy=' + cy + ' mid=' + mid + ' space=' + space };
      })()` },
  ],
  engr_dirClearanceBelowSingleStaff: [
    { name: 'expressive text keeps at least the dynamics clearance below the viola staff',
      expr: `(() => {
        const meas = document.querySelector('#score g.measure');
        const st = meas.querySelector(':scope > g.staff[data-n="3"]');
        const d = document.querySelector('#score g.dir');
        if (!st || !d) return { ok: false, detail: 'staff3=' + !!st + ' dir=' + !!d };
        const ys = [...st.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect().top);
        const bot = Math.max(...ys), space = (bot - Math.min(...ys)) / 4;
        const gap = d.getBoundingClientRect().top - bot;
        /* DIR_GAP_PER_UNIT × unit = 192 user units = 1.2 staff spaces; a pixel of slack. */
        return gap >= 1.1 * space - 1 ? { ok: true, detail: 'gap=' + gap.toFixed(1) + 'px space=' + space.toFixed(1) } : { ok: false, detail: 'gap=' + gap + ' space=' + space };
      })()` },
  ],
  engr_sectionRestartMatchesContinuationSystems: [
    { name: 'no courtesy before the movement break; the restart system matches a continuation system (labels, indent); the first system keeps its names',
      expr: `(() => {
        const systems = [...document.querySelectorAll('#score g.system')];
        if (systems.length < 3) return { ok: false, detail: 'systems=' + systems.length };
        const vis = (meas) => [...meas.querySelectorAll('g.keySig, g.meterSig')].filter(k => k.getBBox().width > 0).map(k => k.getAttribute('class'));
        const m1 = [...systems[0].querySelectorAll('g.measure')]; const last = m1[m1.length - 1];
        const caut = vis(last);
        if (caut.length) return { ok: false, detail: 'courtesy signatures drawn before the section break: ' + caut.join(',') };
        const labels = (sy) => [...sy.querySelectorAll('g.label, g.labelAbbr')].map(g => g.getAttribute('class') + ':' + g.textContent.trim());
        const staffX = (sy) => sy.querySelector('g.measure g.staff path').getBoundingClientRect().left;
        if (labels(systems[0]).length < 2) return { ok: false, detail: 'first-system labels: ' + JSON.stringify(labels(systems[0])) };
        if (JSON.stringify(labels(systems[1])) !== JSON.stringify(labels(systems[2]))) return { ok: false, detail: 'restart labels ' + JSON.stringify(labels(systems[1])) + ' vs continuation ' + JSON.stringify(labels(systems[2])) };
        if (Math.abs(staffX(systems[1]) - staffX(systems[2])) > 1) return { ok: false, detail: 'restart indent ' + staffX(systems[1]) + ' vs continuation ' + staffX(systems[2]) };
        const sigs = vis(systems[1].querySelector('g.measure'));
        if (!sigs.includes('keySig') || !sigs.includes('meterSig')) return { ok: false, detail: 'section start sigs: ' + sigs.join(',') };
        const ser = window.__hkl_composer.model.serialize();
        if (ser.includes('restart=') || ser.includes('meter.form=') || /<staffGrp[^>]*\\sn="hkl/.test(ser)) return { ok: false, detail: 'render-only restart markup leaked into the saved document' };
        return { ok: true };
      })()` },
  ],
  engr_barlineUnbrokenUnderDynamic: [
    { name: 'every grand-staff barline is continuous and no text mark straddles a barline',
      expr: `(() => {
        const parse = (p) => { const mm = /M\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)\\s*L\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(p.getAttribute('d') || ''); return mm ? mm.slice(1).map(Number) : null; };
        const measures = [...document.querySelectorAll('#score g.measure')];
        if (measures.length < 3) return { ok: false, detail: 'measures=' + measures.length };
        const fills = document.querySelectorAll('#score path[data-hkl-barfill]').length;
        if (!fills) return { ok: false, detail: 'no barline fill was needed: the fixture no longer provokes Verovio\\'s erasure' };
        const straddles = [];
        for (const meas of measures) {
          const rows = {};
          for (const st of meas.children) { if (!st.classList.contains('staff')) continue; const ys = [...st.children].filter(c => c.localName === 'path').map(parse).filter(l => l && Math.abs(l[1] - l[3]) <= 1).map(l => l[1]); rows[st.getAttribute('data-n')] = { top: Math.min(...ys), bottom: Math.max(...ys) }; }
          if (!rows[1] || !rows[2]) return { ok: false, detail: 'staff rows missing in ' + meas.id };
          const from = rows[1].bottom, to = rows[2].top;
          const barXs = [];
          for (const bl of meas.children) {
            if (!bl.classList.contains('barLine')) continue;
            const segs = [...bl.children].filter(c => c.localName === 'path').map(parse).filter(l => l && Math.abs(l[0] - l[2]) <= 1).map(l => ({ x: l[0], y1: Math.min(l[1], l[3]), y2: Math.max(l[1], l[3]) })).sort((a, b) => a.y1 - b.y1);
            if (!segs.length) continue;
            barXs.push(segs[0].x);
            let cov = from;
            for (const sg of segs) { if (sg.y2 < from - 1 || sg.y1 > to + 1) continue; if (sg.y1 > cov + 1) return { ok: false, detail: 'barline ' + bl.id + ' broken between ' + cov + ' and ' + sg.y1 }; cov = Math.max(cov, sg.y2); }
            if (cov < to - 1) return { ok: false, detail: 'barline ' + bl.id + ' stops at ' + cov + ', short of ' + to };
          }
          const prev = meas.previousElementSibling;
          if (prev && prev.classList.contains('measure')) for (const bl of prev.children) if (bl.classList.contains('barLine')) { const ls = [...bl.children].map(parse).filter(Boolean); if (ls.length) barXs.push(Math.min(...ls.map(v => v[0]))); }
          for (const mk of meas.querySelectorAll('g.dynam, g.dir')) {
            const b = mk.getBBox(); const t = /translate\\((-?[\\d.]+)/.exec(mk.getAttribute('transform') || ''); const dx = t ? +t[1] : 0;
            for (const x of barXs) if (b.x + dx < x && b.x + b.width + dx > x) straddles.push(mk.id + '@' + x);
          }
        }
        if (straddles.length) return { ok: false, detail: 'marks on a barline: ' + straddles.join(' ') };
        const end = document.getElementById('d-test-barline-end');
        if (!end || !end.hasAttribute('data-hkl-hshift')) return { ok: false, detail: 'the measure-end dynamic was not moved off the barline' };
        return { ok: true, detail: 'fills=' + fills };
      })()` },
  ],
  engr_slurNoteheadSideTwoVoice: [
    { name: 'the upper-voice slur lies below its noteheads, opposite the beams (a beamed triplet draws its number only — no bracket, 2026-09-05)',
      expr: `(() => {
        const staff = document.querySelector('#score g.measure g.staff[data-n="1"]');
        const slur = document.querySelector('#score g.slur');
        const brk = staff && staff.querySelector('g.tupletBracket');
        /* Verovio nests the beamed notes INSIDE g.beam, so measure the beam's own polygon. */
        const beam = staff && staff.querySelector('g.beam > polygon');
        if (!staff || !slur || !beam) return { ok: false, detail: 'staff=' + !!staff + ' slur=' + !!slur + ' beam=' + !!beam };
        if (brk) return { ok: false, detail: 'a wholly beamed triplet must not draw a tuplet bracket' };
        const heads = [...staff.querySelectorAll('g.layer:first-of-type g.notehead, g.tuplet g.notehead')].map(h => h.getBoundingClientRect());
        const headBot = Math.max(...heads.map(h => h.bottom));
        const s = slur.getBoundingClientRect(), be = beam.getBoundingClientRect();
        const sMid = (s.top + s.bottom) / 2;
        if (!(sMid > headBot)) return { ok: false, detail: 'slur centre ' + sMid.toFixed(1) + ' is not below the noteheads (bottom ' + headBot.toFixed(1) + ')' };
        if (!(be.bottom < headBot)) return { ok: false, detail: 'beam not above the heads: beam ' + be.bottom.toFixed(1) };
        return { ok: true };
      })()` },
  ],
  engr_sectionBreakNoCourtesyClef: [
    { name: 'no courtesy clef before the section break; the new section starts in bass clef, no labels; saved doc keeps the layer-initial clef',
      expr: `(() => {
        const systems = [...document.querySelectorAll('#score g.system')];
        if (systems.length < 2) return { ok: false, detail: 'systems=' + systems.length };
        const m1 = [...systems[0].querySelectorAll('g.measure')]; const last = m1[m1.length - 1];
        if (last.querySelectorAll('g.staff[data-n="1"] g.clef').length) return { ok: false, detail: 'courtesy clef drawn before the section break' };
        const first = systems[1].querySelector('g.measure');
        const glyphs = [...first.querySelectorAll('g.staff[data-n="1"] g.clef use')].map(u => u.getAttribute('href') || u.getAttribute('xlink:href') || '');
        if (glyphs.length !== 1 || !glyphs[0].includes('E062')) return { ok: false, detail: 'section-start clef glyphs: ' + glyphs.join(',') };
        if (systems[1].querySelectorAll('g.label').length) return { ok: false, detail: 'instrument labels restated at the section start' };
        const m = window.__hkl_composer.model;
        const meas = [...m.getDoc().querySelectorAll('measure')][4];
        const lead = meas.querySelector('staff[n="1"] > layer[n="1"] > clef');
        if (!lead || lead !== lead.parentElement.firstElementChild) return { ok: false, detail: 'saved document lost its layer-initial clef' };
        const rendered = m.serialize({ hejiEnabled: false });
        if (!rendered.includes('clef.shape="F" clef.line="4"')) return { ok: false, detail: 'render clone carries no boundary clef scoreDef' };
        const rdoc = new DOMParser().parseFromString(rendered, 'application/xml');
        if ([...rdoc.querySelectorAll('measure')][4].querySelector('layer > clef')) return { ok: false, detail: 'render clone left the clef in the layer' };
        return { ok: true };
      })()` },
  ],
  engr_dirAboveClearsSlur: [
    { name: 'the above-staff dir is lifted clear of the slur arching under it',
      expr: `(() => {
        const g = document.getElementById('dir-test-above-slur'); const s = document.getElementById('s-test-above-dir');
        if (!g || !s) return { ok: false, detail: 'dir=' + !!g + ' slur=' + !!s };
        const v = Number(g.getAttribute('data-hkl-vshift'));
        if (!(v < 0)) return { ok: false, detail: 'dir not lifted (data-hkl-vshift=' + g.getAttribute('data-hkl-vshift') + ')' };
        const box = g.getBoundingClientRect(); const path = s.querySelector('path');
        const L = path.getTotalLength(); const ctm = path.getScreenCTM(); let top = Infinity;
        for (let i = 0; i <= 48; i++) { const p = new DOMPoint(path.getPointAtLength(L * i / 48).x, path.getPointAtLength(L * i / 48).y).matrixTransform(ctm); if (p.x >= box.left && p.x <= box.right) top = Math.min(top, p.y); }
        if (!(top > box.bottom - 1)) return { ok: false, detail: 'slur top ' + top.toFixed(1) + ' still inside the dir box (bottom ' + box.bottom.toFixed(1) + ')' };
        return { ok: true };
      })()` },
  ],
  engr_dirCenteredClearsChordStem: [
    { name: 'the centred grand-staff dir stops above the lower staff\'s chord stem instead of running through it',
      expr: `(() => {
        const sys = document.querySelector('#score g.system');
        const st = (n) => sys && sys.querySelector('g.measure g.staff[data-n="' + n + '"]');
        const s1 = st(1), s2 = st(2);
        if (!s1 || !s2) return { ok: false, detail: 'staves 1=' + !!s1 + ' 2=' + !!s2 };
        const band = (s) => {
          const rs = [...s.children].filter((p) => p.tagName === 'path').map((p) => p.getBoundingClientRect()).filter((b) => b.height <= 2.5);
          return rs.length ? { top: Math.min(...rs.map((b) => b.top)), bottom: Math.max(...rs.map((b) => b.bottom)) } : null;
        };
        const b1 = band(s1), b2 = band(s2);
        if (!b1 || !b2) return { ok: false, detail: 'could not measure staff lines' };
        const dirs = [...document.querySelectorAll('#score g.dir')];
        if (dirs.length !== 1) return { ok: false, detail: 'dirs rendered: ' + dirs.length + ' (want 1)' };
        const d = dirs[0].getBoundingClientRect();
        const stems = [...s2.querySelectorAll('g.chord > g.stem')].map((g) => g.getBoundingClientRect())
          .filter((r) => r.left <= d.right && r.right >= d.left);
        if (!stems.length) return { ok: false, detail: 'no chord stem under the dir\u2019s x-range: the fixture tests nothing' };
        const stemTop = Math.min(...stems.map((r) => r.top));
        /* Meaningful only if an UNCLAMPED centring would reach the stem. */
        const centredBottom = (b1.bottom + b2.top) / 2 + d.height / 2;
        if (!(stemTop < centredBottom - 1)) return { ok: false, detail: 'stem top ' + stemTop.toFixed(1)
          + ' is below the centred dir\u2019s bottom ' + centredBottom.toFixed(1) + ': the fixture tests nothing' };
        if (!(d.top > b1.bottom)) return { ok: false, detail: 'dir top ' + d.top.toFixed(1) + ' is on the upper staff (bottom line ' + b1.bottom.toFixed(1) + ') place=' + dirs[0].getAttribute('data-place') + ' transform=' + dirs[0].getAttribute('transform') + ' gap=' + (b2.top - b1.bottom).toFixed(1) + ' stemTop-b1=' + (stemTop - b1.bottom).toFixed(1) + ' dirH=' + d.height.toFixed(1) };
        if (!(d.bottom < stemTop)) return { ok: false, detail: 'dir bottom ' + d.bottom.toFixed(1) + ' overlaps the chord stem (top ' + stemTop.toFixed(1) + ')' };
        return { ok: true };
      })()` },
  ],
  engr_unstackReclaimsGrandStaffGap: [
    { name: 'the same-moment pair occupies ONE inter-staff row, so the grand-staff gap is not inflated',
      expr: `(() => {
        const sys = document.querySelector('#score g.system');
        const st = (n) => sys && sys.querySelector('g.measure g.staff[data-n="' + n + '"]');
        const s1 = st(1), s2 = st(2);
        if (!s1 || !s2) return { ok: false, detail: 'staves 1=' + !!s1 + ' 2=' + !!s2 };
        const band = (s) => {
          const rs = [...s.children].filter((p) => p.tagName === 'path').map((p) => p.getBoundingClientRect()).filter((b) => b.height <= 2.5);
          return rs.length ? { top: Math.min(...rs.map((b) => b.top)), bottom: Math.max(...rs.map((b) => b.bottom)) } : null;
        };
        const b1 = band(s1), b2 = band(s2);
        if (!b1 || !b2) return { ok: false, detail: 'could not measure staff lines' };
        const space = (b1.bottom - b1.top) / 4;
        const gapSpaces = (b2.top - b1.bottom) / space;
        const dyn = document.querySelector('#score g.dynam'), dir = document.querySelector('#score g.dir');
        if (!dyn || !dir) return { ok: false, detail: 'dynam=' + !!dyn + ' dir=' + !!dir };
        const dirs = [...document.querySelectorAll('#score g.dir')];
        if (dirs.length !== 3) return { ok: false, detail: 'dirs rendered: ' + dirs.length + ' (want 3)' };
        for (const d of dirs) {
          if (d.getAttribute('data-hkl-unstack') !== dyn.id) {
            return { ok: false, detail: '"' + (d.textContent || '').trim() + '" was not separated pre-engrave (data-hkl-unstack='
              + d.getAttribute('data-hkl-unstack') + '); gapSpaces=' + gapSpaces.toFixed(2) };
          }
        }
        /* Probed on THIS document: 14.56 staff spaces with the pass off (four
           stacked rows), 8.69 with it on (one row, back at Verovio's
           spacingStaff floor). 11 sits clear of both, so the gate fails the
           moment a second row comes back and never on ordinary drift. */
        if (gapSpaces > 11) return { ok: false, detail: 'grand-staff gap ' + gapSpaces.toFixed(2)
          + ' staff spaces: the stack is being reserved again (probed 14.56 stacked / 8.69 separated)' };
        /* One row: every word shares the dynamic's line and follows it left to
           right, each about a staff space clear of the one before. */
        const boxes = [dyn, ...dirs].map((e) => ({ t: (e.textContent || '').trim() || 'dyn', r: e.getBoundingClientRect() }))
          .sort((a, b) => a.r.left - b.r.left);
        for (let i = 1; i < boxes.length; i++) {
          const gap = boxes[i].r.left - boxes[i - 1].r.right;
          if (!(gap > 0.6 * space && gap < 1.6 * space)) {
            return { ok: false, detail: 'clearance ' + boxes[i - 1].t + '→' + boxes[i].t + ' = ' + (gap / space).toFixed(2) + ' spaces (want ~1)' };
          }
          const ov = Math.min(boxes[i].r.bottom, boxes[0].r.bottom) - Math.max(boxes[i].r.top, boxes[0].r.top);
          if (!(ov > 0)) return { ok: false, detail: boxes[i].t + ' is not on the dynamic\u2019s line (overlap ' + ov.toFixed(1) + ')' };
        }
        return { ok: true };
      })()` },
  ],
  engr_instrGapCenteredDynamic: [
    { name: 'the piano is shifted for the viola\'s low f, and the piano\'s own dynamic stays centred in its grand-staff gap (not a shift lower)',
      expr: `(() => {
        const sys = document.querySelector('#score g.system');
        if (!sys) return { ok: false, detail: 'no system rendered' };
        const staffEl = (n) => sys.querySelector('g.measure g.staff[data-n="' + n + '"]');
        const s1 = staffEl(1), s2 = staffEl(2), s3 = staffEl(3);
        if (!s1 || !s2 || !s3) return { ok: false, detail: 'staves present: 1=' + !!s1 + ' 2=' + !!s2 + ' 3=' + !!s3 + ' (want viola=1, piano=2,3)' };
        /* The fixture is only meaningful if instrgap actually shifted the
           piano — otherwise the double count it guards has nothing to double.
           Assert the premise rather than passing vacuously. */
        const ish = [s2, s3].map((s) => parseFloat(s.getAttribute('data-hkl-ishift') || '0') || 0);
        if (!ish.every((v) => v > 0)) return { ok: false, detail: 'no inter-instrument shift on the piano (data-hkl-ishift=' + ish.join(',') + '): the viola f is not crowding it, so this fixture would pass vacuously' };
        if (ish[0] !== ish[1]) return { ok: false, detail: 'the two piano staves got different shifts: ' + ish.join(',') };
        /* Staff-line bands, from each staff's own thin direct-child paths. */
        const band = (st) => {
          const rs = [...st.children].filter((p) => p.tagName === 'path').map((p) => p.getBoundingClientRect()).filter((b) => b.height <= 2.5);
          if (!rs.length) return null;
          return { top: Math.min(...rs.map((b) => b.top)), bottom: Math.max(...rs.map((b) => b.bottom)) };
        };
        const b2 = band(s2), b3 = band(s3);
        if (!b2 || !b3) return { ok: false, detail: 'could not measure the piano staff lines' };
        const dyn = [...sys.querySelectorAll('g.dynam')].filter((g) => g.getAttribute('data-staff') === '2' && g.getAttribute('data-place') === 'between');
        if (dyn.length !== 1) return { ok: false, detail: 'piano between-dynamics on staff 2: ' + dyn.length + ' (want 1)' };
        const box = dyn[0].getBoundingClientRect();
        const gapMid = (b2.bottom + b3.top) / 2, markMid = (box.top + box.bottom) / 2;
        /* The defect measured a whole shift — 2 staff spaces on the sonata —
           so half a space is far inside the failure. (Was 3 px under the DOM
           centring; Verovio's between pass centres the mark's reference point,
           which leaves the glyph box ~0.3 space low — 2026-10-07.) */
        const err = markMid - gapMid, space = (b2.bottom - b2.top) / 4;
        if (Math.abs(err) > 0.5 * space) return { ok: false, detail: 'piano dynamic sits ' + err.toFixed(1) + 'px off the gap centre (positive = too low; the double-counted shift was ' + (ish[0] / 10).toFixed(1) + 'px)' };
        if (!(box.bottom < b3.top)) return { ok: false, detail: 'piano dynamic bottom ' + box.bottom.toFixed(1) + ' has reached the lower staff (top ' + b3.top.toFixed(1) + ')' };
        if (!(box.top > b2.bottom)) return { ok: false, detail: 'piano dynamic top ' + box.top.toFixed(1) + ' is inside the upper staff (bottom ' + b2.bottom.toFixed(1) + ')' };
        /* And the viola's f, whose crowding paid for the shift, keeps the
           space from the piano that instrgap granted it. */
        const f = [...sys.querySelectorAll('g.dynam')].filter((g) => g.getAttribute('data-staff') === '1');
        if (f.length !== 1) return { ok: false, detail: 'viola dynamics: ' + f.length };
        const fb = f[0].getBoundingClientRect();
        if (!(b2.top - fb.bottom >= 15)) return { ok: false, detail: 'viola f only ' + (b2.top - fb.bottom).toFixed(1) + 'px clear of the piano (want one staff space, ~16px)' };
        return { ok: true };
      })()` },
  ],
  engr_tupletRestOnStaffTwoVoice: [
    { name: 'voice-1 rests against voice-2 low notes are pinned to loc 6 and drawn inside the staff, under the bracket',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rdoc = new DOMParser().parseFromString(m.serialize({ hejiEnabled: false }), 'application/xml');
        const locs = [...rdoc.querySelectorAll('staff[n="1"] layer[n="1"] rest')].map(r => r.getAttribute('loc'));
        if (locs.length !== 3 || locs.some(l => l !== '6')) return { ok: false, detail: 'render-clone rest @loc: ' + locs.join(',') };
        const staff = document.querySelector('#score g.measure g.staff[data-n="1"]');
        const lines = [...staff.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect().top);
        const topLine = Math.min(...lines), botLine = Math.max(...lines), space = (botLine - topLine) / 4;
        const rests = [...staff.querySelectorAll('g.rest')].map(r => r.getBoundingClientRect());
        if (rests.length !== 3) return { ok: false, detail: 'rests drawn: ' + rests.length };
        for (const r of rests) {
          if (r.top < topLine - 0.75 * space || r.bottom > botLine + 0.75 * space) return { ok: false, detail: 'rest ' + r.top.toFixed(1) + '..' + r.bottom.toFixed(1) + ' outside the staff ' + topLine.toFixed(1) + '..' + botLine.toFixed(1) };
        }
        const br = staff.querySelector('g.tupletBracket');
        if (br && !(br.getBoundingClientRect().bottom <= rests[0].top + 1)) return { ok: false, detail: 'tuplet bracket overlaps the rest' };
        return { ok: true };
      })()` },
  ],
  engr_titleBlockSizes: [
    { name: 'title 600px, subtitle 360px on the next line, credit a full line clear below both, first system below all; pages 2+ header at 320px',
      expr: `(() => {
        const H = window.__hkl_composer;
        const head = document.querySelector('#score .score-page[data-page="1"] g.pgHead');
        if (!head) return { ok: false, detail: 'no page-1 header' };
        /* Composer draws the title block (render/pageshell.ts, 2026-10-08). */
        const leaves = [head.querySelector('text.hkl-title'), head.querySelector('text.hkl-subtitle')].filter(Boolean);
        if (leaves.length < 2) return { ok: false, detail: 'header leaves=' + leaves.length };
        if (leaves[0].getAttribute('font-size') !== '600px') return { ok: false, detail: 'title font-size ' + leaves[0].getAttribute('font-size') };
        if (leaves[1].getAttribute('font-size') !== '360px') return { ok: false, detail: 'subtitle font-size ' + leaves[1].getAttribute('font-size') + ' (want 360px, matching the credit)' };
        const t = leaves[0].getBoundingClientRect(), s = leaves[1].getBoundingClientRect();
        /* NO added gap: the subtitle takes the next line, so the two em-boxes
           meet. Never overlapping (Verovio's own <lb/> step does that), never
           a blank line's worth apart (Max, 2026-09-06). */
        if (Math.abs(s.top - t.bottom) > 1.5) return { ok: false, detail: 'title-subtitle box gap ' + (s.top - t.bottom).toFixed(1) + 'px, want the boxes to meet (0 +/- 1.5)' };
        const sys = document.querySelector('#score .score-page[data-page="1"] g.system');
        const sb = sys.getBoundingClientRect();
        if (!(sb.top > s.bottom)) return { ok: false, detail: 'first system top ' + sb.top.toFixed(1) + ' not below the subtitle bottom ' + s.bottom.toFixed(1) };
        /* The composer credit: inside the header band, 360px, a full line of
           its own size below the title block, above the first system. */
        const credit = head.querySelector('text.hkl-injected-composer');
        if (!credit) return { ok: false, detail: 'no composer credit inside g.pgHead' };
        if (credit.getAttribute('font-size') !== '360px') return { ok: false, detail: 'credit font-size ' + credit.getAttribute('font-size') };
        const c = credit.getBoundingClientRect();
        if (!(c.top - s.bottom >= 0.85 * c.height)) return { ok: false, detail: 'subtitle-credit box gap ' + (c.top - s.bottom).toFixed(1) + 'px, want >= ' + (0.85 * c.height).toFixed(1) };
        if (!(sb.top > c.bottom)) return { ok: false, detail: 'first system top ' + sb.top.toFixed(1) + ' not below the credit bottom ' + c.bottom.toFixed(1) };
        /* Stated against the TITLE as well, independently of the subtitle:
           this is the relation Max reported broken, and a title-only document
           has no subtitle to carry it. */
        if (!(c.top >= t.bottom)) return { ok: false, detail: 'credit top ' + c.top.toFixed(1) + ' overlaps the title box bottom ' + t.bottom.toFixed(1) };
        H.renderer['mountPage'](2);
        const p2 = document.querySelector('#score .score-page[data-page="2"]');
        if (!p2) return { ok: false, detail: 'no page 2' };
        const num = p2.querySelector('g.pgHead text.hkl-page-number'); const title = p2.querySelector('text.hkl-running-title');
        if (!num || num.getAttribute('font-size') !== '320px') return { ok: false, detail: 'page-number font-size ' + (num && num.getAttribute('font-size')) };
        if (!title || title.getAttribute('font-size') !== '320px') return { ok: false, detail: 'running-title font-size ' + (title && title.getAttribute('font-size')) };
        return { ok: true };
      })()` },
  ],
  engr_titleBlockWithoutTspanBBox: [
    { name: 'with tspan getBBox throwing (Gecko), the title still grows to 600px and the credit still clears the title and subtitle',
      expr: `(() => {
        const head = document.querySelector('#score .score-page[data-page="1"] g.pgHead');
        if (!head) return { ok: false, detail: 'no page-1 header' };
        /* Composer draws the title block (render/pageshell.ts, 2026-10-08). */
        const leaves = [head.querySelector('text.hkl-title'), head.querySelector('text.hkl-subtitle')].filter(Boolean);
        if (leaves.length < 2) return { ok: false, detail: 'header leaves=' + leaves.length };
        /* 540px here means styleTitle bailed out of the whole restyle. */
        if (leaves[0].getAttribute('font-size') !== '600px') return { ok: false, detail: 'title font-size ' + leaves[0].getAttribute('font-size') + ' (540px = styleTitle bailed)' };
        if (leaves[1].getAttribute('font-size') !== '360px') return { ok: false, detail: 'subtitle font-size ' + leaves[1].getAttribute('font-size') + ' (want 360px, matching the credit)' };
        const t = leaves[0].getBoundingClientRect(), s = leaves[1].getBoundingClientRect();
        if (Math.abs(s.top - t.bottom) > 1.5) return { ok: false, detail: 'title-subtitle box gap ' + (s.top - t.bottom).toFixed(1) + 'px, want the boxes to meet (0 +/- 1.5)' };
        const credit = head.querySelector('text.hkl-injected-composer');
        if (!credit) return { ok: false, detail: 'no composer credit inside g.pgHead' };
        const c = credit.getBoundingClientRect();
        /* The exact defect: y solved from the null-block branch puts the
           credit's box top at the band origin, i.e. on the title's line. */
        if (!(c.top >= t.bottom)) return { ok: false, detail: 'credit top ' + c.top.toFixed(1) + ' overlaps the title box bottom ' + t.bottom.toFixed(1) };
        if (!(c.top - s.bottom >= 0.85 * c.height)) return { ok: false, detail: 'subtitle-credit box gap ' + (c.top - s.bottom).toFixed(1) + 'px, want >= ' + (0.85 * c.height).toFixed(1) };
        const sys = document.querySelector('#score .score-page[data-page="1"] g.system');
        if (!(sys.getBoundingClientRect().top > c.bottom)) return { ok: false, detail: 'first system overlaps the credit' };
        return { ok: true };
      })()` },
  ],
  engr_scrollNoComposerCredit: [
    { name: 'scroll view draws no composer credit and no synthesized pgHead, with the composer still set on the model',
      expr: `(async () => {
        await window.__waitForRender();
        const H = window.__hkl_composer;
        if (H.renderer.getViewMode() !== 'scroll') return { ok: false, detail: 'view mode=' + H.renderer.getViewMode() };
        /* Suppression, not a lost composer: the credit must come back in page
           view (engr_titleBlockSizes owns that direction). */
        if (H.model.getComposer() !== 'Max Randal, Op. 12') return { ok: false, detail: 'model composer=' + JSON.stringify(H.model.getComposer()) };
        const credits = [...document.querySelectorAll('text.hkl-injected-composer')];
        if (credits.length) {
          return { ok: false, detail: credits.length + ' credit text(s) in scroll view; first x=' + credits[0].getAttribute('x') +
            ' text=' + JSON.stringify(credits[0].textContent) };
        }
        /* The synthesized band too: an empty credit-only pgHead would still
           reserve header height at the top of the scroll SVG. */
        const heads = [...document.querySelectorAll('g.pgHead')];
        if (heads.length) return { ok: false, detail: heads.length + ' pgHead group(s) in scroll view: ' + heads.map(h => h.getAttribute('class')).join(' | ') };
        return { ok: true };
      })()` },
  ],
  engr_tempoRestatedAbovePart: [
    { name: 'the tempo marking is copied above the second part, aligned with the original, and survives a single-part render of that part',
      expr: `(() => {
        const orig = document.getElementById('tempo-test-parts');
        const copy = document.getElementById('tempo-test-parts-p3');
        if (!orig || !copy) return { ok: false, detail: 'orig=' + !!orig + ' copy=' + !!copy };
        if (copy.getAttribute('data-staff') !== '3') return { ok: false, detail: 'copy on staff ' + copy.getAttribute('data-staff') };
        if (copy.textContent.trim() !== 'Allegro') return { ok: false, detail: 'copy text "' + copy.textContent.trim() + '"' };
        const s3 = document.querySelector('#score g.measure g.staff[data-n="3"]');
        if (!s3) return { ok: false, detail: 'no staff 3' };
        const cb = copy.getBoundingClientRect(), ob = orig.getBoundingClientRect(), sb = s3.getBoundingClientRect();
        if (!(cb.bottom <= sb.top + 1)) return { ok: false, detail: 'copy bottom ' + cb.bottom.toFixed(1) + ' not above staff 3 top ' + sb.top.toFixed(1) };
        if (Math.abs(cb.left - ob.left) > 2) return { ok: false, detail: 'copy x ' + cb.left.toFixed(1) + ' vs original ' + ob.left.toFixed(1) };
        const m = window.__hkl_composer.model;
        const solo = new DOMParser().parseFromString(m.serialize({ hejiEnabled: false }, [3]), 'application/xml');
        const soloTempi = [...solo.querySelectorAll('tempo')];
        if (soloTempi.length !== 1 || soloTempi[0].getAttribute('staff') !== '3' || soloTempi[0].textContent.trim() !== 'Allegro') {
          return { ok: false, detail: 'violin-only render tempi: ' + soloTempi.map(t => t.getAttribute('staff') + ':' + t.textContent.trim()).join(',') };
        }
        const saved = new DOMParser().parseFromString(m.serialize(), 'application/xml');
        const savedTempi = [...saved.querySelectorAll('tempo')].filter(t => t.textContent.trim() === 'Allegro');
        if (savedTempi.length !== 1) return { ok: false, detail: 'saved doc holds ' + savedTempi.length + ' copies of the marking' };
        return { ok: true };
      })()` },
  ],
  engr_fermataOutsideGrandStaff: [
    { name: 'both fermatas sit outside the braced pair — above staff 1, inverted below staff 2 — and none in the gap',
      expr: `(() => {
        const st = (n) => document.querySelector('#score g.measure g.staff[data-n="' + n + '"]');
        const s1 = st(1), s2 = st(2);
        if (!s1 || !s2) return { ok: false, detail: 'staves 1=' + !!s1 + ' 2=' + !!s2 };
        const ferms = [...document.querySelectorAll('#score g.fermata')];
        if (ferms.length !== 2) return { ok: false, detail: 'fermatas=' + ferms.length };
        const glyph = (g) => ([...g.querySelectorAll('use')].map(u => u.getAttribute('href') || u.getAttribute('xlink:href') || '')[0] || '');
        const b1 = s1.getBoundingClientRect(), b2 = s2.getBoundingClientRect();
        const boxes = ferms.map(f => ({ g: f, r: f.getBoundingClientRect() })).sort((a, b) => a.r.top - b.r.top);
        const up = boxes[0], down = boxes[1];
        if (!(up.r.bottom <= b1.top + 1)) return { ok: false, detail: 'upper fermata bottom ' + up.r.bottom.toFixed(1) + ' not above staff 1 top ' + b1.top.toFixed(1) };
        if (!(down.r.top >= b2.bottom - 1)) return { ok: false, detail: 'lower fermata top ' + down.r.top.toFixed(1) + ' not below staff 2 bottom ' + b2.bottom.toFixed(1) + ' (it is in the inter-staff gap)' };
        if (!glyph(down.g).includes('E4C1')) return { ok: false, detail: 'below-staff fermata is not the inverted glyph: ' + glyph(down.g) };
        if (!glyph(up.g).includes('E4C0')) return { ok: false, detail: 'above-staff fermata is not the upright glyph: ' + glyph(up.g) };
        return { ok: true };
      })()` },
  ],
  engr_twoVoiceRestClearsChordHead: [
    { name: 'every voice-1 rest clears the voice-2 chord heads under it by at least half a space',
      expr: `(() => {
        const staff = document.querySelector('#score g.measure g.staff[data-n="1"]');
        if (!staff) return { ok: false, detail: 'no staff' };
        const lines = [...staff.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect().top);
        const space = (Math.max(...lines) - Math.min(...lines)) / 4;
        const rests = [...staff.querySelectorAll('g.layer[data-n="1"] g.rest')].map(r => r.getBoundingClientRect());
        const heads = [...staff.querySelectorAll('g.layer[data-n="2"] g.notehead')].map(h => h.getBoundingClientRect());
        if (rests.length !== 3 || heads.length !== 4) return { ok: false, detail: 'rests ' + rests.length + ' heads ' + heads.length };
        for (const r of rests) {
          const under = heads.filter(h => h.right > r.left - space && h.left < r.right + space);
          if (!under.length) continue;
          const headTop = Math.min(...under.map(h => h.top));
          const gap = headTop - r.bottom;
          if (!(gap >= 0.5 * space - 1)) return { ok: false, detail: 'rest bottom ' + r.bottom.toFixed(1) + ' vs head top ' + headTop.toFixed(1) + ': gap ' + gap.toFixed(1) + 'px < half a space (' + (0.5 * space).toFixed(1) + ')' };
        }
        return { ok: true };
      })()` },
  ],
};
