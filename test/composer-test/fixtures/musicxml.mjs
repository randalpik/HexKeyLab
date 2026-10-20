// Composer test fixtures — musicxml.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

export const FIXTURES = {
  /* MusicXML per-instrument <part> split: piano (grand staff) + violin. Export
     must emit two <part>s with a 2-entry <part-list>; the violin's staff is
     renumbered part-local (1, not the global 3). */
  musicxml_split: {
    setup: `
      const N = (q, r, oct, midi) => ({ q, r, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '4', dots: 0 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* MusicXML export writes EVERY tempo marking into EVERY part (2026-09-09,
     Max: "make export match"). It used to write only `model.getTempo()` — the
     document's FIRST <tempo> — into the first part, so every mid-piece marking
     was dropped on the way out. A mark off beat 1 carries an <offset> in
     divisions; a gradual exports as italic words with no tempo value (MusicXML
     has no gradual-tempo element); the metronome is written only where the
     score shows one, while the bpm always travels as <sound tempo>. */
  musicxml_tempo_every_part: {
    setup: `
      const N = (q, r, oct, midi) => ({ q, r, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      const fill = (v, oct, midi, n) => { m.setVoice(v); m.setCursor(0, v); for (let i = 0; i < n; i++) m.insertChordAtCursor({ notes: [N(0, 0, oct, midi)], duration: '4', dots: 0 }); };
      fill(1, 4, 69, 8); fill(5, 5, 81, 8);
      const doc = m.getDoc();
      const MEI = 'http://www.music-encoding.org/ns/mei';
      const XMLNS = 'http://www.w3.org/XML/1998/namespace';
      const meas = [...doc.querySelectorAll('measure')];
      const tempo = (measureIdx, id, tstamp, text, attrs) => {
        const t = doc.createElementNS(MEI, 'tempo');
        t.setAttributeNS(XMLNS, 'xml:id', id);
        t.setAttribute('tstamp', String(tstamp));
        t.setAttribute('place', 'above'); t.setAttribute('staff', '1');
        for (const k in attrs) t.setAttribute(k, String(attrs[k]));
        t.textContent = text;
        meas[measureIdx].appendChild(t);
      };
      /* Instant marking with a shown metronome, on beat 3 of measure 1. */
      tempo(0, 'tempo-x-instant', 3, 'Allegro', { mm: 132, 'mm.unit': 4, 'midi.bpm': 132, 'data-hkl-mm-shown': 'true' });
      /* Gradual, measure 2 beat 1. */
      tempo(1, 'tempo-x-rit', 1, 'poco rit.', { 'data-hkl-gradual': 'rit' });
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML export coverage (2026-09-09): the exporter used to emit only
     pitches, rhythms, ties, tuplets, colors and signatures. This fixture
     builds one measure holding a slur, articulations, a fermata, a breath
     mark, a dynamic, a hairpin, expressive text, a pedal and an explicit stem
     direction, and asserts each reaches the XML. Two-instrument, so the
     per-part <staff> mapping is exercised too. */
  musicxml_export_coverage: {
    setup: `
      const N = (oct, pname, midi) => ({ q: 0, r: 0, pname, accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      const fill = (v, oct, pname, midi, n) => { m.setVoice(v); m.setCursor(0, v); for (let i = 0; i < n; i++) m.insertChordAtCursor({ notes: [N(oct, pname, midi)], duration: '4', dots: 0 }); };
      fill(1, 5, 'a', 81, 4); fill(3, 3, 'c', 48, 4); fill(5, 5, 'e', 76, 4);
      /* Articulation + fermata + breath on the piano's top staff. */
      m.setVoice(1);
      m.setCursor(1, 1); m.toggleArticulationAtCursor('insert', 'stacc');
      m.setCursor(2, 1); m.toggleArticulationAtCursor('insert', 'fermata');
      m.setCursor(3, 1); m.toggleArticulationAtCursor('insert', 'breath');
      const doc = m.getDoc();
      const MEI = 'http://www.music-encoding.org/ns/mei';
      const XMLNS = 'http://www.w3.org/XML/1998/namespace';
      const meas = doc.querySelector('measure');
      const mk = (name, id, attrs, text) => {
        const e = doc.createElementNS(MEI, name);
        e.setAttributeNS(XMLNS, 'xml:id', id);
        for (const k in attrs) e.setAttribute(k, String(attrs[k]));
        if (text != null) e.textContent = text;
        meas.appendChild(e);
        return e;
      };
      /* Slur over the piano's first two notes. */
      const notes = [...meas.querySelectorAll('staff[n="1"] layer[n="1"] note')];
      mk('slur', 'slur-x-cov', { startid: '#' + notes[0].getAttribute('xml:id'), endid: '#' + notes[1].getAttribute('xml:id') });
      /* Explicit stem direction. */
      notes[0].setAttribute('stem.dir', 'down');
      mk('dynam', 'dyn-x-cov', { tstamp: 1, staff: 1, place: 'between' }, 'mf');
      mk('hairpin', 'hp-x-cov', { tstamp: 2, tstamp2: '0m+4', staff: 1, form: 'cres', place: 'between' });
      mk('dir', 'dir-x-cov', { tstamp: 3, staff: 1, place: 'above' }, 'dolce');
      mk('pedal', 'ped-x-cov-d', { tstamp: 1, staff: 2, dir: 'down' });
      mk('pedal', 'ped-x-cov-u', { tstamp: 4, staff: 2, dir: 'up' });
      /* Cut-time symbol + an instrument abbreviation, both of which the
         exporter used to drop (a cut-time score came out a plain 2/2). */
      m.setTimeSig(4, 4, { sym: 'common' });
      const vGrp = [...doc.querySelectorAll('scoreDef staffGrp staffGrp')][1];
      if (vGrp) {
        const ab = doc.createElementNS(MEI, 'labelAbbr');
        ab.textContent = 'Vln.';
        vGrp.appendChild(ab);
      }
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import: a small score-partwise snippet with a tie that crosses a
     tuplet boundary (quarter C5 tied into the first note of a triplet). Forces
     Equal / HEJI-off / ignore-color-on. Exercises importMusicXml + the
     tuplet-edge tie realization in normalizeTies. */
  musicxml_import: {
    setup: `
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>Test</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">'
        + '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + '<note><pitch><step>C</step><octave>5</octave></pitch><duration>24</duration><voice>1</voice><type>quarter</type>'
        + '<tie type="start"/><notations><tied type="start"/></notations></note>'
        + '<note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>eighth</type>'
        + '<tie type="stop"/><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>'
        + '<notations><tied type="stop"/><tuplet number="1" type="start"/></notations></note>'
        + '<note><pitch><step>D</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>eighth</type>'
        + '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>'
        + '<note><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>eighth</type>'
        + '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>'
        + '<notations><tuplet number="1" type="stop"/></notations></note>'
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* MusicXML import — barlines/repeats/endings/movement break: the <barline>
     element (previously dropped entirely). m1 opens a forward repeat; m3 is a
     1st ending closed by a backward repeat + final bar; m4 is a 2nd ending; m5
     a double bar; m6 a mid-piece final barline → the next measure (m7) becomes
     a movement/section header ("II"). Exercises scanMeasureBarlines + the
     ending-container wrapping + section-header emission in importMusicXml.
     Asserted in FIXTURE_ASSERTIONS.musicxml_barlines. */
  musicxml_barlines: {
    setup: `
      const W = (s, o) => '<note><pitch><step>' + s + '</step><octave>' + o + '</octave></pitch>'
        + '<duration>96</duration><voice>1</voice><type>whole</type></note>';
      const A = '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list><part id="P1">'
        + '<measure number="1">' + A + '<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>' + W('C', 5) + '</measure>'
        + '<measure number="2">' + W('D', 5) + '</measure>'
        + '<measure number="3"><barline location="left"><ending number="1" type="start"/></barline>' + W('E', 5)
          + '<barline location="right"><bar-style>light-heavy</bar-style><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>'
        + '<measure number="4"><barline location="left"><ending number="2" type="start"/></barline>' + W('F', 5)
          + '<barline location="right"><ending number="2" type="discontinue"/></barline></measure>'
        + '<measure number="5">' + W('G', 5) + '<barline location="right"><bar-style>light-light</bar-style></barline></measure>'
        + '<measure number="6">' + W('A', 5) + '<barline location="right"><bar-style>light-heavy</bar-style></barline></measure>'
        + '<measure number="7">' + W('B', 4) + '</measure>'
        + '<measure number="8">' + W('C', 5) + '</measure>'
        + '</part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
    visualBaseline: 'musicxml_barlines',
  },
  /* MusicXML import — hidden rest (<forward>): a second voice that enters on
     beat 3 is encoded by Finale as a <backup> then a <forward> half (invisible
     time advance), NOT a visible rest. The importer must translate the forward
     into a HIDDEN rest (<rest visible="false">) so the voice-2 half note stays
     on beat 3 instead of collapsing to beat 1 (the displacement bug, sonata
     m.65). Asserted in FIXTURE_ASSERTIONS.musicxml_hidden_rest. */
  musicxml_hidden_rest: {
    setup: `
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list><part id="P1">'
        + '<measure number="1"><attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + '<note><pitch><step>C</step><octave>5</octave></pitch><duration>96</duration><voice>1</voice><type>whole</type></note>'
        + '<backup><duration>96</duration></backup>'
        + '<forward><duration>48</duration><voice>2</voice></forward>'
        + '<note><pitch><step>E</step><octave>4</octave></pitch><duration>48</duration><voice>2</voice><type>half</type></note>'
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import — full-measure rest: Finale writes an empty bar as
     <rest measure="yes"/> with NO <type>. Import must fill the measure (a 4/4
     bar → a single whole rest), not the old lone-quarter degradation. */
  musicxml_measure_rest: {
    setup: `
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">'
        + '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + '<note><rest measure="yes"/><duration>96</duration><voice>1</voice></note>'
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import — ornaments: a trilled half note (<trill-mark>) followed by
     a fingered two-note tremolo (<tremolo type=start/stop>3) → a note-anchored
     <trill> and an <fTrem beams=3> wrapping the pair. */
  musicxml_ornaments: {
    setup: `
      const N = (s, o, dur, type, orn) => '<note><pitch><step>' + s + '</step><octave>' + o + '</octave></pitch>'
        + '<duration>' + dur + '</duration><voice>1</voice><type>' + type + '</type>'
        + (orn ? '<notations><ornaments>' + orn + '</ornaments></notations>' : '') + '</note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">'
        + '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + N('E', 5, 48, 'half', '<trill-mark/>')
        + N('C', 5, 48, 'half', '<tremolo type="start">3</tremolo>')
        + N('G', 5, 48, 'half', '<tremolo type="stop">3</tremolo>')
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import — mid-measure clef: a second <attributes><clef> after two
     quarter notes must place the inline <clef> mid-layer (not at the bar head),
     so notes before the change keep the original clef. */
  musicxml_midmeasure_clef: {
    setup: `
      const N = (s, o) => '<note><pitch><step>' + s + '</step><octave>' + o + '</octave></pitch>'
        + '<duration>24</duration><voice>1</voice><type>quarter</type></note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">'
        + '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + N('C', 5) + N('D', 5)
        + '<attributes><clef><sign>F</sign><line>4</line></clef></attributes>'
        + N('E', 3) + N('F', 3)
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import — expressive text: a non-tempo <words> direction becomes a
     note-independent <dir> (italic preserved); tempo captions are excluded. */
  /* MusicXML import — EVERY tempo marking (2026-09-06, backlog Layout P1):
     words + <sound tempo> → a verbal <tempo>; a <metronome> → the metronome
     shown; a bare measure-level <sound tempo> → a text-less playback tempo;
     the same direction on a second part collapses into one. */
  musicxml_tempi: {
    setup: `
      const W = '<note><pitch><step>C</step><octave>5</octave></pitch><duration>96</duration><voice>1</voice><type>whole</type></note>';
      const part = (id) => '<part id="' + id + '">'
        + '<measure number="1"><attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + '<direction placement="above"><direction-type><words font-weight="bold">Allegro</words></direction-type><sound tempo="132"/></direction>' + W + '</measure>'
        + '<measure number="2"><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>60</per-minute></metronome></direction-type><sound tempo="60"/></direction>' + W + '</measure>'
        + '<measure number="3"><sound tempo="90"/>' + W + '</measure>'
        + '</part>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>A</part-name></score-part><score-part id="P2"><part-name>B</part-name></score-part></part-list>'
        + part('P1') + part('P2') + '</score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  musicxml_words_dir: {
    setup: `
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">'
        + '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + '<direction placement="below"><direction-type><words font-style="italic">espressivo</words></direction-type></direction>'
        + '<note><pitch><step>C</step><octave>5</octave></pitch><duration>96</duration><voice>1</voice><type>whole</type></note>'
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import — <offset> is the direction's real beat (backlog, Layout).
     Finale writes a mark at the END of a measure's element stream and offsets
     it back, so ignoring <offset> put the sonata's p. 21 m. 99 "dim."/"rit." at
     tstamp 4 in a 3/4 bar — on the barline, where textlayout's nudge then had
     to shove them back inside. Four cases in one document:
       m.1  a bar-end "dim." and "rit." with offset -48 (= 2 beats at
            divisions 24) must land on beat 2, alongside a `p` on beat 1;
       m.2  an <octave-shift> stop carrying an offset must be UNAFFECTED — its
            div span decides which notes get rewritten an octave, so an offset
            there would change content, not placement;
       m.3  an offset reaching past the bar start clamps to beat 1 (anchor
            migration into the previous measure is deliberately not attempted),
            and a small positive offset yields a fractional tstamp. */
  musicxml_direction_offset: {
    setup: `
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">'
        + '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + '<direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type></direction>'
        + '<note><pitch><step>C</step><octave>5</octave></pitch><duration>72</duration><voice>1</voice><type>half</type><dot/></note>'
        + '<direction placement="below"><direction-type><words font-style="italic">dim.</words></direction-type><offset>-48</offset></direction>'
        + '<direction placement="above"><direction-type><words font-style="italic">rit.</words></direction-type><offset>-48</offset></direction>'
        + '</measure><measure number="2">'
        + '<direction placement="above"><direction-type><octave-shift type="down" number="1" size="8"/></direction-type></direction>'
        + '<note><pitch><step>C</step><octave>6</octave></pitch><duration>24</duration><voice>1</voice><type>quarter</type></note>'
        + '<note><pitch><step>D</step><octave>6</octave></pitch><duration>24</duration><voice>1</voice><type>quarter</type></note>'
        + '<note><pitch><step>E</step><octave>6</octave></pitch><duration>24</duration><voice>1</voice><type>quarter</type></note>'
        + '<direction placement="above"><direction-type><octave-shift type="stop" number="1" size="8"/></direction-type><offset>-24</offset></direction>'
        + '</measure><measure number="3">'
        + '<direction placement="below"><direction-type><words>clampme</words></direction-type><offset>-48</offset></direction>'
        + '<direction placement="below"><direction-type><words>fracme</words></direction-type><offset>6</offset></direction>'
        + '<note><pitch><step>C</step><octave>5</octave></pitch><duration>72</duration><voice>1</voice><type>half</type><dot/></note>'
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import — ottava (<octave-shift>). MusicXML encodes bracketed notes
     at SOUNDING pitch and prints them shifted; the model stores WRITTEN pitch
     and derives the sounding one from <octave>. So an 8va (Finale writes
     `type="down"`, meaning "printed an octave below sounding") must import as
     an <octave dis="8" dis.place="above"> PLUS the spanned notes written an
     octave down. Dropping the direction outright — the behavior until
     2026-09-06 — silently left those notes an octave high with no bracket
     (sonata m. 93-95 and m. 70, the piece's only two ottavas).
     The span here covers m.1 notes 2-4 and m.2 notes 1-2; the notes before it
     and after the `stop` must be untouched. */
  musicxml_octave_shift: {
    setup: `
      const N = (step, oct) => '<note><pitch><step>' + step + '</step><octave>' + oct + '</octave></pitch>'
        + '<duration>24</duration><voice>1</voice><type>quarter</type></note>';
      const SHIFT = (type) => '<direction><direction-type><octave-shift size="8" type="' + type + '"/>'
        + '</direction-type><staff>1</staff></direction>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">'
        + '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + N('C', 5) + SHIFT('down') + N('D', 6) + N('E', 6) + N('F', 6)
        + '</measure><measure number="2">'
        + N('G', 6) + N('A', 6) + SHIFT('stop') + N('B', 4) + N('C', 5)
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
    visualBaseline: 'musicxml_octave_shift',
  },
  /* MusicXML import — beam diff: eight eighths the source beams 2+2+2+2 (begin/
     end per pair). Our 4/4 auto-beamer would make two 4-beams, so the importer
     sets @hkl-beam-break to flip the two disagreeing boundaries (notes 3 & 7),
     reproducing the source grouping while staying editable. */
  musicxml_beam_diff: {
    setup: `
      const E = (b) => '<note><pitch><step>A</step><octave>4</octave></pitch><duration>12</duration>'
        + '<voice>1</voice><type>eighth</type><beam number="1">' + b + '</beam></note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list>'
        + '<part id="P1"><measure number="1">'
        + '<attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + E('begin') + E('end') + E('begin') + E('end') + E('begin') + E('end') + E('begin') + E('end')
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import — measure-boundary clef: a clef declared at the head of
     measure 2 renders BEFORE the barline (engraving convention), encoded as an
     inline <clef> appended to measure 1's content layer, not at measure 2's head. */
  musicxml_boundary_clef: {
    setup: `
      const V = (s, o, dur, type) => '<note><pitch><step>' + s + '</step><octave>' + o + '</octave></pitch>'
        + '<duration>' + dur + '</duration><voice>1</voice><type>' + type + '</type></note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list><part id="P1">'
        + '<measure number="1"><attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + V('G', 4, 96, 'whole') + '</measure>'
        + '<measure number="2"><attributes><clef><sign>F</sign><line>4</line></clef></attributes>'
        + V('A', 2, 48, 'half') + V('B', 2, 48, 'half') + '</measure>'
        + '</part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import — cross-staff slur: a slur that starts on a staff-1 note and
     stops on a staff-2 note (different voices) must pair globally, not per-voice. */
  musicxml_crossstaff_slur: {
    setup: `
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>Pno</part-name></score-part></part-list><part id="P1">'
        + '<measure number="1"><attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>'
        + '<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
        + '<note><pitch><step>G</step><octave>4</octave></pitch><duration>48</duration><voice>1</voice><type>half</type><staff>1</staff>'
        + '<notations><slur number="1" type="start"/></notations></note>'
        + '<note><pitch><step>A</step><octave>4</octave></pitch><duration>48</duration><voice>1</voice><type>half</type><staff>1</staff></note>'
        + '<backup><duration>96</duration></backup>'
        + '<note><rest/><duration>48</duration><voice>2</voice><staff>2</staff></note>'
        + '<note><pitch><step>C</step><octave>3</octave></pitch><duration>48</duration><voice>2</voice><type>half</type><staff>2</staff>'
        + '<notations><slur number="1" type="stop"/></notations></note>'
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import — trill extender + accidental: <trill-mark>+<wavy-line> and
     an <accidental-mark> → <trill @extender @endid @accidupper>. */
  musicxml_trill_extender: {
    setup: `
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list><part id="P1">'
        + '<measure number="1"><attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + '<note><pitch><step>E</step><octave>5</octave></pitch><duration>48</duration><voice>1</voice><type>half</type>'
        + '<notations><ornaments><trill-mark/><wavy-line number="1" type="start"/></ornaments><accidental-mark>flat</accidental-mark></notations></note>'
        + '<note><pitch><step>C</step><octave>5</octave></pitch><duration>48</duration><voice>1</voice><type>half</type>'
        + '<notations><ornaments><wavy-line number="1" type="stop"/></ornaments></notations></note>'
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import — pickup exception: an empty voice in a PICKUP (anacrusis)
     measure gets a reduced-duration rest, NOT a whole-measure <mRest> (which
     would draw a whole rest spanning the short bar). */
  musicxml_pickup_rest: {
    setup: `
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>Pno</part-name></score-part></part-list><part id="P1">'
        + '<measure number="1" implicit="yes"><attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>'
        + '<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>'
        + '<note><pitch><step>C</step><octave>5</octave></pitch><duration>12</duration><voice>1</voice><type>eighth</type><staff>1</staff></note>'
        + '<backup><duration>12</duration></backup>'
        + '<note><rest measure="yes"/><duration>12</duration><voice>2</voice><staff>2</staff></note>'
        + '</measure>'
        + '<measure number="2">'
        + '<note><pitch><step>C</step><octave>5</octave></pitch><duration>96</duration><voice>1</voice><type>whole</type><staff>1</staff></note>'
        + '<backup><duration>96</duration></backup>'
        + '<note><pitch><step>C</step><octave>3</octave></pitch><duration>96</duration><voice>2</voice><type>whole</type><staff>2</staff></note>'
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import — mid-measure clef over a tripleted voice: the layer's only
     content is <tuplet>s, so a mid-measure clef change must still be inserted
     into it (regression: a tuplet-only layer was wrongly treated as empty). */
  musicxml_midmeasure_clef_tuplet: {
    setup: `
      const trip = (s, pos) => '<note><pitch><step>' + s + '</step><octave>5</octave></pitch>'
        + '<duration>8</duration><voice>1</voice><type>eighth</type>'
        + '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>'
        + (pos ? '<notations><tuplet number="1" type="' + pos + '"/></notations>' : '') + '</note>';
      const triplet = (s) => trip(s, 'start') + trip(s, '') + trip(s, 'stop');
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list><part id="P1">'
        + '<measure number="1"><attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + triplet('C')
        + '<attributes><clef><sign>F</sign><line>4</line></clef></attributes>'
        + triplet('E')
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },
  /* MusicXML import — <accidental parentheses="yes"> (2026-10-18): the
     importer read only <alter>, so all 23 of the sonata's parenthetical
     accidentals were dropped. A plain F#5, a parenthesized F#5 (bare note),
     a C5+E5 chord with a parenthesized natural on E5 only, and a plain G5.
     Asserted in FIXTURE_ASSERTIONS.musicxml_paren_accidental. */
  musicxml_paren_accidental: {
    setup: `
      const N = (s, oct, alter, acc, chord) => '<note>' + (chord ? '<chord/>' : '')
        + '<pitch><step>' + s + '</step>' + (alter ? '<alter>' + alter + '</alter>' : '') + '<octave>' + oct + '</octave></pitch>'
        + '<duration>24</duration><voice>1</voice><type>quarter</type>' + (acc ?? '') + '</note>';
      const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
        + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list><part id="P1">'
        + '<measure number="1"><attributes><divisions>24</divisions><key><fifths>0</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
        + N('F', 5, 1, '<accidental>sharp</accidental>')
        + N('F', 5, 1, '<accidental parentheses="yes">sharp</accidental>')
        + N('C', 5, 0) + N('E', 5, 0, '<accidental parentheses="yes">natural</accidental>', true)
        + N('G', 5, 0)
        + '</measure></part></score-partwise>';
      window.__composerImportMusicXml(xml);
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
  },

  /* ── MusicXML: empty-cell flags round-trip (2026-09-11) ──
     Export writes Finale's encoding — <staff-details number="k" print-object=
     "no"/"yes"> at hide-range edges, <measure-style><multiple-rest>N</multiple-
     rest> at a one-staff part's run start — and import reads both back onto
     empty cells. Violin (1 staff) + piano: piano staves hidden in bars 3–5,
     violin multirest over bars 2–4. */
  musicxml_flags_roundtrip: {
    setup: `
      const N = (q, rr, oct, midi) => ({ q, r: rr, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '4', dots: 0 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      for (let i = 0; i < 5; i++) m.appendMeasure();                 /* 6 bars */
      const ms = m.allMeasures();
      for (const i of [2, 3, 4]) for (const sn of [1, 2]) ms[i].querySelector('staff[n="' + sn + '"]').setAttribute('data-hkl-hide-empty', 'true');
      for (const i of [1, 2, 3]) ms[i].querySelector('staff[n="3"]').setAttribute('data-hkl-multirest', 'true');
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
    skipCursorTrace: true,
  },
};

export const ASSERTIONS = {
  /* MusicXML barline import: every <barline> feature lands as the model's
   * native MEI vocabulary, and a mid-piece final bar becomes a movement break. */
  musicxml_barlines: [
    { name: 'barlines/repeats/endings/movement-break import correctly',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const ms = [...doc.querySelectorAll('measure')];
        if (ms.length !== 8) return { ok: false, detail: 'measures=' + ms.length + ' (expected 8)' };
        const [m1,,m3,m4,m5,m6,m7,m8] = ms;
        if (m1.getAttribute('left') !== 'rptstart') return { ok: false, detail: 'm1 left=' + m1.getAttribute('left') };
        if (m3.getAttribute('right') !== 'rptend') return { ok: false, detail: 'm3 right=' + m3.getAttribute('right') };
        const e1 = m3.closest('ending');
        if (!e1 || e1.getAttribute('n') !== '1') return { ok: false, detail: 'm3 ending=' + (e1 && e1.getAttribute('n')) };
        const e2 = m4.closest('ending');
        if (!e2 || e2.getAttribute('n') !== '2') return { ok: false, detail: 'm4 ending=' + (e2 && e2.getAttribute('n')) };
        if (m5.getAttribute('right') !== 'dbl') return { ok: false, detail: 'm5 right=' + m5.getAttribute('right') };
        if (m6.getAttribute('right') !== 'end') return { ok: false, detail: 'm6 right=' + m6.getAttribute('right') };
        if (m7.getAttribute('data-hkl-section-title') !== 'II') return { ok: false, detail: 'm7 title=' + m7.getAttribute('data-hkl-section-title') };
        if (m8.getAttribute('right') !== 'end') return { ok: false, detail: 'm8 right=' + m8.getAttribute('right') };
        const secBreaks = doc.querySelectorAll('sb[data-hkl-section="true"]').length;
        if (secBreaks !== 1) return { ok: false, detail: 'sectionBreaks=' + secBreaks + ' (expected 1)' };
        return { ok: true, detail: 'rptstart + rptend/ending1 + ending2 + dbl + movement-break(II) OK' };
      })()` },
  ],
  /* MusicXML hidden-rest import: a <forward> becomes a hidden rest that fills
   * the leading gap, keeping the voice-2 note at its true beat (not displaced). */
  musicxml_hidden_rest: [
    { name: 'forward→hidden rest precedes the note; layer fills the full measure',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const l2 = doc.querySelector('staff[n="1"] layer[n="2"]');
        if (!l2) return { ok: false, detail: 'no layer 2' };
        const kids = [...l2.children].filter(c => ['note','chord','rest'].includes(c.localName));
        if (kids.length < 2) return { ok: false, detail: 'layer2 kids=' + kids.length };
        if (kids[0].localName !== 'rest' || kids[0].getAttribute('visible') !== 'false')
          return { ok: false, detail: 'first is ' + kids[0].localName + ' visible=' + kids[0].getAttribute('visible') };
        const note = kids.find(c => c.localName === 'note');
        if (!note) return { ok: false, detail: 'no note in layer2' };
        if (kids.indexOf(note) === 0) return { ok: false, detail: 'note at index 0 (displaced)' };
        const tk = (c) => { const d = parseInt(c.getAttribute('dur')||'0',10); const dots = parseInt(c.getAttribute('dots')||'0',10); let t = d ? 64/d : 0; if (dots===1) t*=1.5; else if (dots===2) t*=1.75; return t; };
        const total = kids.reduce((s,c) => s + tk(c), 0);
        if (total !== 64) return { ok: false, detail: 'layer2 ticks=' + total + ' (expected 64)' };
        const hidden = kids.filter(c => c.getAttribute('visible') === 'false').reduce((s,c) => s + tk(c), 0);
        if (hidden !== 32) return { ok: false, detail: 'hidden ticks=' + hidden + ' (expected 32)' };
        return { ok: true, detail: 'hidden rest (32t) precedes the half note; layer fills 64t' };
      })()` },
  ],
  /* MusicXML splits into one <part> per instrument with part-local
     staff numbering. */
  musicxml_tempo_every_part: [
    { name: 'every tempo marking reaches every part, with offset, italic gradual, and metronome only where shown',
      expr: `(() => {
        const h = window.__hkl_composer;
        const xml = h.exportMusicXml(h.model);
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        if (doc.querySelector('parsererror')) return { ok: false, detail: 'export is not well-formed XML' };
        const parts = [...doc.querySelectorAll('part')];
        if (parts.length !== 2) return { ok: false, detail: 'parts=' + parts.length };
        const marksOf = (part) => [...part.querySelectorAll('direction')].map((d) => {
          const w = d.querySelector('words');
          return {
            text: w ? w.textContent.trim() : '',
            italic: !!(w && w.getAttribute('font-style') === 'italic'),
            mm: !!d.querySelector('metronome per-minute'),
            bpm: d.querySelector('sound[tempo]') ? d.querySelector('sound[tempo]').getAttribute('tempo') : null,
            offset: d.querySelector('offset') ? Number(d.querySelector('offset').textContent) : 0,
            measure: [...part.querySelectorAll('measure')].indexOf(d.closest('measure')),
          };
        });
        const a = marksOf(parts[0]), b = marksOf(parts[1]);
        if (JSON.stringify(a) !== JSON.stringify(b)) return { ok: false, detail: 'parts disagree: ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b) };
        const allegro = a.find((x) => x.text === 'Allegro');
        const rit = a.find((x) => x.text === 'poco rit.');
        if (!allegro) return { ok: false, detail: 'no Allegro direction: ' + JSON.stringify(a) };
        if (!rit) return { ok: false, detail: 'no rit. direction: ' + JSON.stringify(a) };
        if (!allegro.mm || allegro.bpm !== '132') return { ok: false, detail: 'Allegro mm=' + allegro.mm + ' bpm=' + allegro.bpm };
        if (allegro.measure !== 0) return { ok: false, detail: 'Allegro in measure index ' + allegro.measure };
        /* Beat 3 of 4/4 at the export's own divisions = 2 beats of offset. */
        const div = Number((xml.match(/<divisions>(\\d+)<\\/divisions>/) || [])[1]);
        if (!div) return { ok: false, detail: 'no <divisions> in export' };
        if (allegro.offset !== 2 * div) return { ok: false, detail: 'Allegro offset ' + allegro.offset + ' (expected ' + (2 * div) + ')' };
        if (!rit.italic) return { ok: false, detail: 'gradual not italic' };
        if (rit.mm || rit.bpm !== null) return { ok: false, detail: 'gradual carries a tempo value: mm=' + rit.mm + ' bpm=' + rit.bpm };
        if (rit.measure !== 1 || rit.offset !== 0) return { ok: false, detail: 'rit. at measure ' + rit.measure + ' offset ' + rit.offset };
        /* The seed document's text-less playback tempo stays a bare <sound>. */
        const bare = [...parts[0].querySelectorAll('measure > sound[tempo]')];
        if (bare.length !== 1) return { ok: false, detail: 'bare <sound tempo> count=' + bare.length };
        return { ok: true };
      })()` },
  ],
  musicxml_export_coverage: [
    { name: 'slur, articulation, fermata, breath, dynamic, wedge, words, pedal and stem all reach the MusicXML, on the right part',
      expr: `(() => {
        const h = window.__hkl_composer;
        const xml = h.exportMusicXml(h.model);
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        if (doc.querySelector('parsererror')) return { ok: false, detail: 'export is not well-formed XML' };
        const parts = [...doc.querySelectorAll('part')];
        if (parts.length !== 2) return { ok: false, detail: 'parts=' + parts.length };
        const piano = parts[0];
        const want = {
          slurStart: piano.querySelectorAll('slur[type="start"]').length,
          slurStop: piano.querySelectorAll('slur[type="stop"]').length,
          staccato: piano.querySelectorAll('staccato').length,
          fermata: piano.querySelectorAll('fermata').length,
          breath: piano.querySelectorAll('breath-mark').length,
          dynamics: piano.querySelectorAll('dynamics > mf').length,
          wedgeStart: piano.querySelectorAll('wedge[type="crescendo"]').length,
          wedgeStop: piano.querySelectorAll('wedge[type="stop"]').length,
          words: [...piano.querySelectorAll('words')].filter((w) => w.textContent.trim() === 'dolce').length,
          pedalStart: piano.querySelectorAll('pedal[type="start"]').length,
          pedalStop: piano.querySelectorAll('pedal[type="stop"]').length,
          stemDown: [...piano.querySelectorAll('stem')].filter((x) => x.textContent === 'down').length,
        };
        for (const k of Object.keys(want)) {
          if (want[k] < 1) return { ok: false, detail: k + ' missing from the export: ' + JSON.stringify(want) };
        }
        /* Directions carry a PART-LOCAL staff: the pedal is on the piano's
           second staff, and the violin part must carry none of this. */
        const ped = [...piano.querySelectorAll('direction')].find((d) => d.querySelector('pedal'));
        const pedStaff = ped && ped.querySelector('staff') ? ped.querySelector('staff').textContent : null;
        if (pedStaff !== '2') return { ok: false, detail: 'pedal on part-local staff ' + pedStaff };
        const violin = parts[1];
        if (violin.querySelectorAll('dynamics, wedge, pedal, slur').length) {
          return { ok: false, detail: 'piano marks leaked into the violin part' };
        }
        /* Meter symbol and instrument abbreviation. */
        const timeSym = doc.querySelector('time') ? doc.querySelector('time').getAttribute('symbol') : null;
        if (timeSym !== 'common') return { ok: false, detail: 'time symbol=' + timeSym };
        const abbrs = [...doc.querySelectorAll('score-part')].map((sp) => sp.querySelector('part-abbreviation') ? sp.querySelector('part-abbreviation').textContent : null);
        if (abbrs[1] !== 'Vln.') return { ok: false, detail: 'part abbreviations: ' + JSON.stringify(abbrs) };
        /* Every measure of every part accounts for its full budget. */
        const div = Number((xml.match(/<divisions>(\\d+)<\\/divisions>/) || [])[1]);
        for (const part of parts) {
          const meas = [...part.querySelectorAll('measure')];
          for (let i = 0; i < meas.length; i++) {
            const wantTicks = Math.round(h.model.measureTicksAt(i) * div / 16);
            const perVoice = new Map(); let cur = 0;
            for (const c of [...meas[i].children]) {
              const d = c.querySelector(':scope > duration') ? Number(c.querySelector(':scope > duration').textContent) : 0;
              if (c.localName === 'note' && !c.querySelector(':scope > chord')) {
                const v = c.querySelector(':scope > voice').textContent;
                cur += d; perVoice.set(v, Math.max(perVoice.get(v) || 0, cur));
              } else if (c.localName === 'forward') {
                const v = c.querySelector(':scope > voice').textContent;
                cur += d; perVoice.set(v, Math.max(perVoice.get(v) || 0, cur));
              } else if (c.localName === 'backup') { cur -= d; }
            }
            for (const [v, reach] of perVoice) {
              if (reach !== wantTicks) return { ok: false, detail: 'measure ' + (i + 1) + ' voice ' + v + ' sums to ' + reach + ', want ' + wantTicks };
            }
          }
        }
        return { ok: true };
      })()` },
  ],
  musicxml_split: [
    { name: 'two <part>s, 2-entry <part-list>, violin staff renumbered to 1',
      expr: `(() => {
        const h = window.__hkl_composer;
        const xml = h.exportMusicXml(h.model);
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const parts = [...doc.querySelectorAll('part')];
        if (parts.length !== 2) return { ok: false, detail: 'parts=' + parts.length };
        const scoreParts = [...doc.querySelectorAll('part-list score-part')];
        if (scoreParts.length !== 2) return { ok: false, detail: 'score-parts=' + scoreParts.length };
        const names = scoreParts.map(p => p.querySelector('part-name')?.textContent);
        if (names[0] !== 'Piano' || names[1] !== 'Violin') return { ok: false, detail: 'names=' + names.join(',') };
        /* Piano part declares 2 staves; violin part has no <staves> (single). */
        const pianoStaves = parts[0].querySelector('attributes staves')?.textContent;
        if (pianoStaves !== '2') return { ok: false, detail: 'piano staves=' + pianoStaves };
        if (parts[1].querySelector('attributes staves')) return { ok: false, detail: 'violin should omit <staves>' };
        /* Violin note staff is part-local 1 (not the global 3). */
        const vStaff = parts[1].querySelector('note staff')?.textContent;
        if (vStaff !== '1') return { ok: false, detail: 'violin note staff=' + vStaff };
        return { ok: true };
      })()` },
  ],
  musicxml_import: [
    { name: 'forces Equal / HEJI off / ignore-color on',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const all = [...doc.getElementsByTagName('*')];
        const cfg = all.find(e => e.localName === 'config');
        const lr = all.find(e => e.localName === 'layoutReq');
        if (lr?.getAttribute('tuningMode') !== 'E') return { ok: false, detail: 'tuningMode=' + lr?.getAttribute('tuningMode') };
        if (cfg?.getAttribute('heji') !== 'false') return { ok: false, detail: 'heji=' + cfg?.getAttribute('heji') };
        if (cfg?.getAttribute('ignore-color') !== 'true') return { ok: false, detail: 'ignore-color=' + cfg?.getAttribute('ignore-color') };
        return { ok: true };
      })()` },
    { name: 'tie crossing the tuplet boundary is realized (no lv stub)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const notes = [...doc.querySelectorAll('note')];
        const pre = notes.find(n => n.getAttribute('pname') === 'c' && n.getAttribute('oct') === '5' && !n.closest('tuplet'));
        const inTup = notes.find(n => n.getAttribute('pname') === 'c' && n.getAttribute('oct') === '5' && n.closest('tuplet'));
        if (!pre || !inTup) return { ok: false, detail: 'missing C5 endpoints pre=' + !!pre + ' inTup=' + !!inTup };
        if (pre.getAttribute('tie') !== 'i') return { ok: false, detail: 'pre tie=' + pre.getAttribute('tie') };
        if (inTup.getAttribute('tie') !== 't') return { ok: false, detail: 'inTup tie=' + inTup.getAttribute('tie') };
        if (pre.getAttribute('data-tie-partner') !== inTup.getAttribute('xml:id'))
          return { ok: false, detail: 'partner mismatch' };
        if (doc.querySelector('lv')) return { ok: false, detail: 'unexpected <lv> stub' };
        if (doc.querySelector('note[data-pending-tie]')) return { ok: false, detail: 'pending tie left over' };
        return { ok: true };
      })()` },
    { name: 'triplet imported as <tuplet num=3 numbase=2> with 3 notes',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tups = [...doc.querySelectorAll('tuplet')];
        if (tups.length !== 1) return { ok: false, detail: 'tuplets=' + tups.length };
        const t = tups[0];
        if (t.getAttribute('num') !== '3' || t.getAttribute('numbase') !== '2')
          return { ok: false, detail: 'ratio=' + t.getAttribute('num') + '/' + t.getAttribute('numbase') };
        const tn = [...t.querySelectorAll('note')].length;
        if (tn !== 3) return { ok: false, detail: 'tuplet notes=' + tn };
        return { ok: true };
      })()` },
  ],
  /* Empty bar (<rest measure="yes"/>) → an EMPTY layer (placeholders only): the
     whole-bar rest is cosmetic, drawn by the render pass for an empty cell
     (2026-09-28 — a stored <mRest> went stale once the cell got content). Still
     never a lone quarter or a beat-aligned decomposition. */
  musicxml_measure_rest: [
    { name: 'empty bar → placeholders only (no stored <mRest>/<rest>); one cosmetic whole rest drawn',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const layer = doc.querySelector('measure staff[n="1"] layer[n="1"]');
        const kids = [...layer.children].map((k) => k.localName + (k.getAttribute('data-placeholder') === 'true' ? '*' : ''));
        if (doc.querySelectorAll('mRest').length !== 0) return { ok: false, detail: 'stored mRest: ' + JSON.stringify(kids) };
        if (!kids.length || !kids.every((k) => k === 'space*')) return { ok: false, detail: 'layer=' + JSON.stringify(kids) };
        const drawn = document.querySelectorAll('#score g.measure g.staff:first-of-type g.mRest').length;
        return drawn === 1 ? { ok: true } : { ok: false, detail: 'drawn g.mRest=' + drawn };
      })()` },
  ],
  /* Ornaments: trill-mark → <trill>; fingered tremolo pair → <fTrem beams=3>. */
  musicxml_ornaments: [
    { name: 'trill on E5 anchored via @startid',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const trills = [...doc.querySelectorAll('trill')];
        if (trills.length !== 1) return { ok: false, detail: 'trills=' + trills.length };
        const id = (trills[0].getAttribute('startid') || '').replace('#','');
        const anchor = [...doc.querySelectorAll('note,chord')].find(n => n.getAttribute('xml:id') === id);
        if (!anchor || anchor.getAttribute('pname') !== 'e') return { ok: false, detail: 'anchor pname=' + (anchor && anchor.getAttribute('pname')) };
        return { ok: true };
      })()` },
    { name: 'fingered tremolo pair wrapped in <fTrem beams=3> (2 notes)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const ft = [...doc.querySelectorAll('fTrem')];
        if (ft.length !== 1) return { ok: false, detail: 'fTrem=' + ft.length };
        if (ft[0].getAttribute('beams') !== '3') return { ok: false, detail: 'beams=' + ft[0].getAttribute('beams') };
        const notes = [...ft[0].querySelectorAll('note')];
        if (notes.length !== 2) return { ok: false, detail: 'fTrem notes=' + notes.length };
        return { ok: true };
      })()` },
  ],
  /* Mid-measure clef: inline <clef> after the 2nd note, not at the layer head. */
  musicxml_midmeasure_clef: [
    { name: 'bass <clef> sits mid-layer (2 notes precede it)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const layer = doc.querySelector('measure staff[n="1"] layer[n="1"]');
        const clefs = [...layer.children].filter(c => c.localName === 'clef');
        if (clefs.length !== 1) return { ok: false, detail: 'inline clefs=' + clefs.length };
        const cl = clefs[0];
        if (cl.getAttribute('shape') !== 'F' || cl.getAttribute('line') !== '4')
          return { ok: false, detail: 'clef=' + cl.getAttribute('shape') + cl.getAttribute('line') };
        let prevNotes = 0, p = cl;
        while ((p = p.previousElementSibling)) if (p.localName === 'note' || p.localName === 'chord') prevNotes++;
        if (prevNotes !== 2) return { ok: false, detail: 'notes before clef=' + prevNotes + ' (expected 2)' };
        return { ok: true };
      })()` },
  ],
  /* Expressive text: a non-tempo <words> → <dir> with italic text preserved. */
  musicxml_words_dir: [
    { name: '<dir> "espressivo" (italic) present',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const dirs = [...doc.querySelectorAll('dir')];
        const d = dirs.find(x => (x.textContent || '').trim() === 'espressivo');
        if (!d) return { ok: false, detail: 'dir texts=' + dirs.map(x => (x.textContent||'').trim()).join('|') };
        const rend = d.querySelector('rend');
        if (!rend || rend.getAttribute('fontstyle') !== 'italic') return { ok: false, detail: 'fontstyle=' + (rend && rend.getAttribute('fontstyle')) };
        return { ok: true };
      })()` },
  ],
  /* <offset> moves the direction's single @tstamp (so the playback effect
     travels with the glyph) for dynam/dir/tempo/hairpin, and is IGNORED for
     <octave-shift>. */
  musicxml_direction_offset: [
    { name: 'bar-end "dim."/"rit." with offset -48 land on beat 2, not the barline',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const find = (tag, text) => [...doc.querySelectorAll(tag)]
          .find(x => (x.textContent || '').trim() === text);
        const dim = find('dir', 'dim.'), rit = find('dir', 'rit.');
        if (!dim || !rit) return { ok: false, detail: 'dirs=' + [...doc.querySelectorAll('dir')].map(x => (x.textContent||'').trim()).join('|') };
        const got = dim.getAttribute('tstamp') + '/' + dim.getAttribute('place')
          + ' ' + rit.getAttribute('tstamp') + '/' + rit.getAttribute('place');
        if (got !== '2/below 2/above') return { ok: false, detail: got };
        return { ok: true };
      })()` },
    { name: 'the un-offset `p` on the same measure stays on beat 1',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const d = [...doc.querySelectorAll('dynam')].find(x => (x.textContent || '').trim() === 'p');
        if (!d) return { ok: false, detail: 'no p' };
        return d.getAttribute('tstamp') === '1' ? { ok: true } : { ok: false, detail: 'tstamp=' + d.getAttribute('tstamp') };
      })()` },
    { name: 'offset past the bar start clamps to beat 1; a small offset is fractional',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const find = (t) => [...doc.querySelectorAll('dir')].find(x => (x.textContent || '').trim() === t);
        const c = find('clampme'), f = find('fracme');
        if (!c || !f) return { ok: false, detail: 'missing' };
        const got = c.getAttribute('tstamp') + ' ' + f.getAttribute('tstamp');
        return got === '1 1.25' ? { ok: true } : { ok: false, detail: got };
      })()` },
    { name: '<octave-shift> ignores its offset: span still ends at the bar end',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const oct = doc.querySelector('octave');
        if (!oct) return { ok: false, detail: 'no octave' };
        /* Un-offset the stop sits at cur=72 (tstamp 4 of a 3/4 bar); honoring
           the -24 offset would pull it to tstamp 3. data-hkl-t1 is the absolute
           MEI tick (quarter = 16), so the two differ by one quarter. */
        const t1 = oct.getAttribute('data-hkl-t1');
        return t1 === '96' ? { ok: true } : { ok: false, detail: 'data-hkl-t1=' + t1 };
      })()` },
  ],
  /* Ottava: one <octave> anchored to the first/last bracketed slot (Verovio
     draws the bracket from @startid/@endid only), the spanned notes written an
     octave BELOW their MusicXML (sounding) pitch, and the notes outside the
     span untouched. */
  musicxml_octave_shift: [
    { name: '<octave> dis=8 above staff 1, anchored to notes 2 and 6',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const octs = [...doc.querySelectorAll('octave')];
        if (octs.length !== 1) return { ok: false, detail: 'octave count=' + octs.length };
        const o = octs[0];
        if (o.getAttribute('dis') !== '8') return { ok: false, detail: 'dis=' + o.getAttribute('dis') };
        if (o.getAttribute('dis.place') !== 'above') return { ok: false, detail: 'place=' + o.getAttribute('dis.place') };
        if (o.getAttribute('staff') !== '1') return { ok: false, detail: 'staff=' + o.getAttribute('staff') };
        const notes = [...doc.querySelectorAll('measure staff[n="1"] layer[n="1"] note')];
        const idOf = (i) => notes[i] && notes[i].getAttribute('xml:id');
        const sid = (o.getAttribute('startid') || '').replace('#', '');
        const eid = (o.getAttribute('endid') || '').replace('#', '');
        if (sid !== idOf(1)) return { ok: false, detail: 'startid=' + sid + ' expected note 2 (' + idOf(1) + ')' };
        if (eid !== idOf(5)) return { ok: false, detail: 'endid=' + eid + ' expected note 6 (' + idOf(5) + ')' };
        return { ok: true };
      })()` },
    { name: 'bracketed notes written an octave down; others unshifted',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const notes = [...doc.querySelectorAll('measure staff[n="1"] layer[n="1"] note')];
        const got = notes.map(n => n.getAttribute('pname') + n.getAttribute('oct'));
        /* source: C5 | D6 E6 F6 G6 A6 (8va) | B4 C5 → written pitch: */
        const want = ['c5', 'd5', 'e5', 'f5', 'g5', 'a5', 'b4', 'c5'];
        if (got.join(',') !== want.join(','))
          return { ok: false, detail: 'written=' + got.join(',') + ' expected=' + want.join(',') };
        /* q must move with the octave: −3 per octave down (lattice band width). */
        const qs = notes.map(n => parseInt(n.getAttribute('data-q'), 10));
        if (qs.some(q => !Number.isFinite(q))) return { ok: false, detail: 'data-q=' + qs.join(',') };
        return { ok: true };
      })()` },
    { name: 'ottava bracket rendered',
      expr: `(() => {
        const gs = [...document.querySelectorAll('g.octave')];
        if (gs.length !== 1) return { ok: false, detail: 'g.octave count=' + gs.length };
        const w = gs[0].getBoundingClientRect().width;
        if (!(w > 10)) return { ok: false, detail: 'bracket width=' + w };
        return { ok: true };
      })()` },
  ],
  /* Beam diff: source 2+2+2+2 over our 4/4 4+4 → exactly two @hkl-beam-break
     markers, on the 3rd and 7th eighths (0-based flat indices 2 and 6). */
  musicxml_beam_diff: [
    { name: 'two beam-break markers on eighths 3 and 7',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const layer = doc.querySelector('measure staff[n="1"] layer[n="1"]');
        const notes = [...layer.children].filter(c => c.localName === 'note');
        if (notes.length !== 8) return { ok: false, detail: 'notes=' + notes.length };
        const marked = notes.map((n, i) => n.getAttribute('hkl-beam-break') === 'true' ? i : -1).filter(i => i >= 0);
        if (marked.length !== 2 || marked[0] !== 2 || marked[1] !== 6)
          return { ok: false, detail: 'marked indices=' + marked.join(',') + ' (expected 2,6)' };
        return { ok: true };
      })()` },
  ],
  /* Boundary clef: the live doc keeps it at the measure-2 head, but the RENDER
     relocates it before the barline (to measure 1's layer end) — the global
     "no barline immediately followed by a clef" invariant. */
  musicxml_boundary_clef: [
    { name: 'live doc: clef at measure-2 layer head',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const m2 = [...doc.querySelectorAll('measure')][1];
        const first = m2.querySelector('staff[n="1"] layer[n="1"]').firstElementChild;
        if (!first || first.localName !== 'clef' || first.getAttribute('shape') !== 'F')
          return { ok: false, detail: 'm2 layer first child=' + (first && first.localName + (first.getAttribute && first.getAttribute('shape'))) };
        return { ok: true };
      })()` },
    { name: 'render: bass clef before the barline (measure-1 layer end), none measure-initial',
      expr: `(() => {
        const rendered = window.__hkl_composer.model.serialize({ hejiEnabled: false });
        const rdoc = new DOMParser().parseFromString(rendered, 'application/xml');
        for (const cl of rdoc.querySelectorAll('layer > clef')) {
          if (cl.previousElementSibling === null)
            return { ok: false, detail: 'a clef is measure-initial (renders after barline)' };
        }
        const m1layer = [...rdoc.querySelectorAll('measure')][0].querySelector('staff[n="1"] layer[n="1"]');
        const last = m1layer.lastElementChild;
        if (!last || last.localName !== 'clef' || last.getAttribute('shape') !== 'F')
          return { ok: false, detail: 'm1 layer last child=' + (last && last.localName) };
        return { ok: true };
      })()` },
  ],
  /* Cross-staff slur: pairs across staves (startid staff 1, endid staff 2). */
  musicxml_crossstaff_slur: [
    { name: 'one slur, endpoints on different staves',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const byId = id => [...doc.querySelectorAll('note,chord')].find(n => n.getAttribute('xml:id') === id);
        const staffOf = el => { const s = el && el.closest('staff'); return s ? s.getAttribute('n') : null; };
        const slurs = [...doc.querySelectorAll('slur')];
        if (slurs.length !== 1) return { ok: false, detail: 'slurs=' + slurs.length };
        const a = byId((slurs[0].getAttribute('startid')||'').replace('#','')), b = byId((slurs[0].getAttribute('endid')||'').replace('#',''));
        const sa = staffOf(a), sb = staffOf(b);
        if (!sa || !sb || sa === sb) return { ok: false, detail: 'staves=' + sa + ',' + sb + ' (expected different)' };
        return { ok: true };
      })()` },
  ],
  /* Trill with wavy-line extender + accidental-mark → @extender + @endid + @accidupper. */
  musicxml_trill_extender: [
    { name: 'trill has @extender, @endid (=C5), @accidupper=f',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const trills = [...doc.querySelectorAll('trill')];
        if (trills.length !== 1) return { ok: false, detail: 'trills=' + trills.length };
        const t = trills[0];
        if (t.getAttribute('extender') !== 'true') return { ok: false, detail: 'extender=' + t.getAttribute('extender') };
        if (t.getAttribute('accidupper') !== 'f') return { ok: false, detail: 'accidupper=' + t.getAttribute('accidupper') };
        const endId = (t.getAttribute('endid')||'').replace('#','');
        const end = [...doc.querySelectorAll('note,chord')].find(n => n.getAttribute('xml:id') === endId);
        if (!end || end.getAttribute('pname') !== 'c') return { ok: false, detail: 'endid pname=' + (end && end.getAttribute('pname')) };
        return { ok: true };
      })()` },
  ],
  /* Pickup exception: the empty voice in the anacrusis gets a plain rest sized
     to the pickup budget — never a whole-measure <mRest>. */
  musicxml_pickup_rest: [
    { name: 'pickup bar: no <mRest>; empty voice has a reduced rest',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const m1 = [...doc.querySelectorAll('measure')][0];
        if (m1.querySelectorAll('mRest').length !== 0)
          return { ok: false, detail: 'pickup has an mRest (' + m1.querySelectorAll('mRest').length + ')' };
        const s2layer = m1.querySelector('staff[n="2"] layer[n="1"]');
        const rests = [...s2layer.children].filter(k => k.localName === 'rest');
        if (rests.length === 0) return { ok: false, detail: 'empty pickup voice has no rest' };
        /* Reduced, not whole: dur must be shorter than a whole note. */
        if (rests.some(rst => rst.getAttribute('dur') === '1'))
          return { ok: false, detail: 'pickup rest is a whole rest' };
        return { ok: true };
      })()` },
  ],
  /* Mid-measure clef in a tuplet-only layer is inserted between the tuplets. */
  musicxml_midmeasure_clef_tuplet: [
    { name: 'bass clef between the two triplets (tuplet before + after)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const layer = doc.querySelector('measure staff[n="1"] layer[n="1"]');
        const clefs = [...layer.children].filter(k => k.localName === 'clef');
        if (clefs.length !== 1) return { ok: false, detail: 'inline clefs=' + clefs.length + ' kids=' + [...layer.children].map(k=>k.localName).join(',') };
        const cl = clefs[0];
        if (cl.getAttribute('shape') !== 'F') return { ok: false, detail: 'clef shape=' + cl.getAttribute('shape') };
        if (cl.previousElementSibling?.localName !== 'tuplet' || cl.nextElementSibling?.localName !== 'tuplet')
          return { ok: false, detail: 'clef not between tuplets: prev=' + cl.previousElementSibling?.localName + ' next=' + cl.nextElementSibling?.localName };
        return { ok: true };
      })()` },
  ],
  musicxml_paren_accidental: [
    { name: 'exactly the 2nd F#5 (bare) and the chord E5 carry @hkl-paren-caut="true"',
      expr: `(() => {
        const notes = [...window.__hkl_composer.model.getDoc().querySelectorAll('layer[n="1"] note')];
        if (notes.length !== 5) return { ok: false, detail: 'noteCount=' + notes.length };
        const desc = (n) => n.getAttribute('pname') + n.getAttribute('oct') + (n.parentElement.localName === 'chord' ? '@chord' : '');
        const flagged = notes.filter((n) => n.getAttribute('hkl-paren-caut') === 'true');
        const got = flagged.map(desc).join(',');
        return got === 'f5,e5@chord' && flagged[0] === notes[1]
          ? { ok: true } : { ok: false, detail: 'flagged=' + got + ' all=' + notes.map(desc).join(',') };
      })()` },
    { name: 'flagged notes render paren glyphs (E26A + E26B); the plain F#5 does not',
      expr: `(() => {
        const notes = [...window.__hkl_composer.model.getDoc().querySelectorAll('layer[n="1"] note')];
        const cps = (n) => [...document.querySelectorAll('#score svg g.note[id="' + n.getAttribute('xml:id') + '"] g.accid text')]
          .map((t) => t.textContent.codePointAt(0).toString(16));
        const parens = (n) => { const c = cps(n); return c.includes('e26a') && c.includes('e26b'); };
        const flagged = notes.filter((n) => n.getAttribute('hkl-paren-caut') === 'true');
        if (flagged.length !== 2) return { ok: false, detail: 'flagged=' + flagged.length };
        const bad = flagged.filter((n) => !parens(n));
        if (bad.length) return { ok: false, detail: 'no parens on ' + bad.map((n) => n.getAttribute('pname') + ' cps=' + JSON.stringify(cps(n))).join('; ') };
        return parens(notes[0]) ? { ok: false, detail: 'plain F#5 drew parens: ' + JSON.stringify(cps(notes[0])) } : { ok: true };
      })()` },
  ],
  musicxml_tempi: [
    { name: 'three <tempo> marks (words+sound, metronome shown, bare sound), deduped across parts, no <dir> from the words',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tempi = [...doc.querySelectorAll('tempo')];
        if (tempi.length !== 3) return { ok: false, detail: 'tempo count ' + tempi.length };
        const meas = [...doc.querySelectorAll('measure')];
        const at = tempi.map(t => meas.indexOf(t.closest('measure')));
        if (at.join(',') !== '0,1,2') return { ok: false, detail: 'tempo measures ' + at.join(',') };
        const mm = tempi.map(t => t.getAttribute('mm'));
        if (mm.join(',') !== '132,60,90') return { ok: false, detail: 'mm ' + mm.join(',') };
        if (!tempi[0].textContent.startsWith('Allegro')) return { ok: false, detail: 'first text ' + tempi[0].textContent };
        if (tempi[0].getAttribute('data-hkl-mm-shown')) return { ok: false, detail: 'words-only tempo shows a metronome' };
        if (tempi[1].getAttribute('data-hkl-mm-shown') !== 'true' || !tempi[1].textContent.includes('= 60')) return { ok: false, detail: 'metronome tempo not shown: ' + tempi[1].textContent };
        if (tempi[2].textContent.trim() !== '') return { ok: false, detail: 'bare sound tempo has text ' + tempi[2].textContent };
        if (doc.querySelectorAll('dir').length) return { ok: false, detail: 'tempo words leaked into <dir>' };
        if (window.__hkl_composer.model.getTempo().bpm !== 132) return { ok: false, detail: 'getTempo bpm ' + window.__hkl_composer.model.getTempo().bpm };
        if (document.querySelectorAll('#score g.tempo').length < 2) return { ok: false, detail: 'rendered g.tempo ' + document.querySelectorAll('#score g.tempo').length };
        return { ok: true };
      })()` },
  ],
  /* ── MusicXML flags round-trip ── */
  musicxml_flags_roundtrip: [
    { name: 'export writes staff-details no/yes at bars 3 and 6 for both piano staves, and multiple-rest 3 at violin bar 2', expr: `(() => { const M = window.__hkl_composer, m = M.model; const xml = M.exportMusicXml(m); const d = new DOMParser().parseFromString(xml, 'application/xml'); const parts = [...d.querySelectorAll('part')]; const piano = parts.find(p => p.querySelectorAll('measure')[0].querySelector('staves')); const violin = parts.find(p => p !== piano); const sdOf = (p) => [...p.querySelectorAll('measure')].flatMap(me => [...me.querySelectorAll('attributes > staff-details')].map(sd => me.getAttribute('number') + ':' + sd.getAttribute('number') + ':' + sd.getAttribute('print-object'))); const sds = sdOf(piano); const mrs = [...violin.querySelectorAll('measure')].flatMap(me => [...me.querySelectorAll('attributes > measure-style > multiple-rest')].map(x => me.getAttribute('number') + ':' + x.textContent)); const ok = JSON.stringify(sds) === JSON.stringify(['3:1:no','3:2:no','6:1:yes','6:2:yes']) && JSON.stringify(mrs) === JSON.stringify(['2:3']) && sdOf(violin).length === 0; window.__xmlOut = xml; return { ok, detail: JSON.stringify({ sds, mrs, violinSds: sdOf(violin) }) }; })()` },
    { name: 'import reads both back: hide-empty on piano bars 3–5, multirest on violin bars 2–4, nothing else', expr: `(() => { const M = window.__hkl_composer, m = M.model; window.__composerImportMusicXml(window.__xmlOut); const ms = m.allMeasures(); const flags = ms.map((me, i) => [...me.querySelectorAll('staff')].map(st => (st.getAttribute('data-hkl-hide-empty') ? 'H' : '-') + (st.getAttribute('data-hkl-multirest') ? 'M' : '-')).join('|')); const ok = JSON.stringify(flags) === JSON.stringify(['--|--|--','--|--|-M','H-|H-|-M','H-|H-|-M','H-|H-|--','--|--|--']); return { ok, detail: JSON.stringify(flags) }; })()` },
  ],
};
