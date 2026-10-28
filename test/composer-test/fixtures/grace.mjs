// Composer test fixtures — grace notes (docs/architecture/composer.md → Grace
// notes, Grace timing; decisions.md 2026-10-27).
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.
//
// Every pitch carries its own color so a mis-keyed identity cannot pass by
// coincidence (the performance fixtures' convention), on its real Euler cell
// (accidental glyphs are spelled from the cell).

const C5 = `{ q: 2, r: 1, pname: 'c', accid: '', oct: 5, midi: 72, colorHex: '#ff0000', lightColorHex: '#ff0000', velocity: 80 }`;
const D5 = `{ q: -1, r: 3, pname: 'd', accid: '', oct: 5, midi: 74, colorHex: '#00ff00', lightColorHex: '#00ff00', velocity: 80 }`;
const E5 = `{ q: 3, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#0000ff', lightColorHex: '#0000ff', velocity: 80 }`;
const F5 = `{ q: 5, r: 0, pname: 'f', accid: '', oct: 5, midi: 77, colorHex: '#ff00ff', lightColorHex: '#ff00ff', velocity: 80 }`;
const FS4 = `{ q: -10, r: 7, pname: 'f', accid: 's', oct: 4, midi: 66, colorHex: '#888', velocity: 80 }`;
const F4 = `{ q: 2, r: 0, pname: 'f', accid: '', oct: 4, midi: 65, colorHex: '#888', velocity: 80 }`;
const G3 = `{ q: -4, r: 2, pname: 'g', accid: '', oct: 3, midi: 55, colorHex: '#ffff00', lightColorHex: '#ffff00', velocity: 80 }`;

/* In-page setup helpers: `ins(note, dur)` enters a one-note chord at the
   cursor; `grace()` makes the element just entered a grace (cursor past it). */
const S = `
  const ins = (n, d) => m.insertChordAtCursor({ notes: [n], duration: d, dots: 0 });
  const grace = () => { const r = m.toggleGraceOnCurrent('insert'); if (!r || !r.ok) throw new Error('toggleGraceOnCurrent: ' + JSON.stringify(r)); };
  m.setVoice(1); m.setCursor(0, 1);
`;

/* MusicXML import setup: `body` is a JS expression over N(step, oct, type,
   { grace, slash, chord, dur, beam, tie }) building one bar of 4/4 at
   divisions 2 (quarter = 2). */
const MX = (body) => `
  const N = (step, oct, type, o) => {
    o = o || {};
    return '<note>' + (o.grace ? (o.slash ? '<grace slash="yes"/>' : '<grace/>') : '') + (o.chord ? '<chord/>' : '')
      + '<pitch><step>' + step + '</step><octave>' + oct + '</octave></pitch>'
      + (o.grace ? '' : '<duration>' + o.dur + '</duration>')
      + (o.tie ? '<tie type="' + o.tie + '"/>' : '')
      + '<voice>1</voice><type>' + type + '</type>'
      + (o.beam ? '<beam number="1">' + o.beam + '</beam>' : '')
      + (o.tie ? '<notations><tied type="' + o.tie + '"/></notations>' : '')
      + '</note>';
  };
  const xml = '<?xml version="1.0"?><score-partwise version="3.0">'
    + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list>'
    + '<part id="P1"><measure number="1">'
    + '<attributes><divisions>2</divisions><key><fifths>0</fifths></key>'
    + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
    + ${body}
    + '</measure></part></score-partwise>';
  window.__composerImportMusicXml(xml);
  m.setVoice(1); m.setCursor(0, 1); r();
`;

/* In-page assertion helpers. `shape(mi)` lists voice 1's slots in measure mi as
   pname:dur(.)(grace) — e.g. "d:8(acc) c:4". */
const G_LIB = `
  const H = window.__hkl_composer, m = H.model, doc = m.getDoc();
  const L1 = (mi) => doc.querySelectorAll('measure')[mi || 0].querySelector('staff[n="1"] layer[n="1"]');
  const slots = (mi) => [...L1(mi).children].filter((c) => c.localName === 'note' || c.localName === 'chord' || c.localName === 'rest');
  const desc = (e) => (e.localName === 'chord' ? 'chord' : (e.getAttribute('pname') || e.localName)) + ':' + e.getAttribute('dur')
    + (e.getAttribute('dots') ? '.' : '') + (e.getAttribute('grace') ? '(' + e.getAttribute('grace') + ')' : '');
  const shape = (mi) => slots(mi).map(desc).join(' ');
  const idOf = (e) => e && e.getAttribute('xml:id');
  const beamOf = (id) => { const g = document.getElementById(id); return g ? g.closest('g.beam') : null; };
  const status = () => { const el = document.getElementById('composerStatus'); return { text: el ? el.textContent : '', error: !!(el && el.classList.contains('status-error')) }; };
  /* Composer injects its own accidental glyphs as <text> (heji-render); count either form. */
  const accGlyphs = (id) => { const g = document.getElementById(id); return g ? g.querySelectorAll('g.accid use, g.accid text').length : -1; };
  const expectShape = (mi, want) => { const got = shape(mi); return got === want ? null : 'm' + mi + ' = "' + got + '", want "' + want + '"'; };
  /* Playback: the default tempo is quarter = 120, so one tick (a 64th) is 31.25 ms. */
  const T = 500 / 16;
  const sounding = (evs) => evs.filter((e) => e.notes.length > 0);
  const evOf = (evs, id) => evs.find((e) => e.meiId === id);
  const fmtEv = (e) => e ? (e.meiId + '@' + (e.atMs / T).toFixed(2) + 'T+' + (e.durationMs / T).toFixed(2) + 'T') : 'none';
  const near = (a, b) => Math.abs(a - b) < 0.5;
  /* Performance: strike an element's own cell + color; bars as meiId@edge. */
  const P = H.__performance;
  const strikeId = (id) => {
    const el = doc.querySelector('[*|id="' + id + '"]');
    const n = el.localName === 'chord' ? el.querySelector('note') : el;
    return P.strike({ q: +n.getAttribute('data-q'), r: +n.getAttribute('data-r'), pname: 'c', accid: '', oct: 4, midi: 60,
      colorHex: n.getAttribute('color'), lightColorHex: '#888', velocity: 80 });
  };
  const bar = (v) => { const b = P.bars()[v]; return b ? b.meiId + '@' + b.edge : 'none'; };
  const L3 = (mi) => doc.querySelectorAll('measure')[mi].querySelector('staff[n="2"] layer[n="1"]');
  const ids3 = (mi) => [...L3(mi).children].filter((c) => c.localName === 'note' || c.localName === 'chord').map(idOf);
`;
const gAssert = (body) => `(async () => {
  ${G_LIB}
  try {
    ${body}
  } catch (e) {
    return { ok: false, detail: String(e && e.stack || e) };
  }
})()`;

export const FIXTURES = {

  /* ── G: toggle grace ─────────────────────────────────────────────────── */
  /* G on an entered 8th makes it a grace: it keeps its written value, the bar
     loses its time (placeholder grows), the cursor stays past it. */
  grace_toggle_on: {
    setup: `${S}
      ins(${D5}, '8'); ins(${C5}, '4'); ins(${C5}, '4'); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: ['g'],
  },
  /* Entry flow: a note placed after a grace is always a normal note. */
  grace_entry_flow: {
    setup: `${S}
      ins(${D5}, '8'); grace(); ins(${C5}, '4');
    `,
  },
  /* G twice: back to the same normal note (same xml:id), time restored. */
  grace_toggle_off_fits: {
    setup: `${S}
      ins(${D5}, '8'); ins(${C5}, '4'); ins(${C5}, '4'); ins(${C5}, '4');
      m.setCursor(1, 1);
      window.__grace_id = m.flatChildren(1)[1].getAttribute('xml:id');
    `,
    setupKeys: ['g', 'g'],
  },
  /* Grace → normal in a full bar is an insertion: the last quarter moves whole
     into a new bar 2. */
  grace_toggle_off_displaces: {
    setup: `${S}
      ins(${D5}, '8'); grace();
      ins(${C5}, '4'); ins(${C5}, '4'); ins(${C5}, '4'); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: ['g'],
  },
  /* Grace → normal refused when the planner can't place it (a whole-note grace
     before a full bar, next bar full too): grace kept, status names the reason. */
  grace_toggle_off_refused: {
    setup: `${S}
      ins(${D5}, '1'); grace();
      for (let i = 0; i < 8; i++) ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: ['g'],
  },
  grace_refused_on_rest: {
    setup: `${S}
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: ['g'],
  },
  grace_refused_in_tuplet: {
    setup: `${S}
      const t = m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8' });
      if (!t.ok) throw new Error('tuplet: ' + t.reason);
      ins(${D5}, '8');
    `,
    setupKeys: ['g'],
  },
  /* A chord becomes a grace chord: @grace on the <chord>, members bare. */
  grace_chord: {
    setup: `${S}
      m.insertChordAtCursor({ notes: [${C5}, ${E5}], duration: '8', dots: 0 });
      ins(${D5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: ['g'],
  },

  /* ── Shift+G: slash ──────────────────────────────────────────────────── */
  grace_slash_on: {
    setup: `${S}
      ins(${D5}, '8'); grace(); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'G', shift: true }],
  },
  grace_slash_off: {
    setup: `${S}
      ins(${D5}, '8'); grace(); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'G', shift: true }, { key: 'G', shift: true }],
  },
  /* On a normal note Shift+G makes a slashed grace in one step (one undo). */
  grace_slash_converts_normal: {
    setup: `${S}
      ins(${D5}, '8'); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'G', shift: true }],
  },
  grace_slash_convert_undo: {
    setup: `${S}
      ins(${D5}, '8'); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'G', shift: true }, { key: 'z', ctrl: true }],
  },
  grace_slash_refused_on_rest: {
    setup: `${S}
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'G', shift: true }],
  },

  /* ── Beaming ─────────────────────────────────────────────────────────── */
  /* Three 16th graces beam together; their main note is not in the beam. */
  grace_beamed_run: {
    setup: `${S}
      ins(${D5}, '16'); grace(); ins(${E5}, '16'); grace(); ins(${F5}, '16'); grace();
      ins(${C5}, '2');
    `,
    visualBaseline: 'grace_beamed_run',
  },
  /* Slashing the middle member leaves no grace beam (1 + 1 + 1). */
  grace_slash_middle_unbeams: {
    setup: `${S}
      ins(${D5}, '16'); grace(); ins(${E5}, '16'); grace(); ins(${F5}, '16'); grace();
      ins(${C5}, '2');
      m.setCursor(2, 1);
    `,
    setupKeys: [{ key: 'G', shift: true }],
  },
  /* Slashing the last member: the first two stay beamed. */
  grace_slash_last_unbeams: {
    setup: `${S}
      ins(${D5}, '16'); grace(); ins(${E5}, '16'); grace(); ins(${F5}, '16'); grace();
      ins(${C5}, '2');
      m.setCursor(3, 1);
    `,
    setupKeys: [{ key: 'G', shift: true }],
  },
  /* A grace between two eighths of one beat: the eighths keep their beam, the
     grace sits inside it in document order. */
  grace_in_regular_beam: {
    setup: `${S}
      ins(${C5}, '8'); ins(${E5}, '16'); grace(); ins(${D5}, '8');
      ins(${C5}, '4'); ins(${C5}, '2');
    `,
    visualBaseline: 'grace_in_regular_beam',
  },
  /* Two graces between the eighths: a nested grace beam inside the regular one. */
  grace_nested_beam: {
    setup: `${S}
      ins(${C5}, '8'); ins(${E5}, '16'); grace(); ins(${F5}, '16'); grace(); ins(${D5}, '8');
      ins(${C5}, '4'); ins(${C5}, '2');
    `,
    visualBaseline: 'grace_nested_beam',
  },
  /* \`/\` before the second grace splits the run: 1 + 2. */
  grace_beam_break: {
    setup: `${S}
      ins(${D5}, '16'); grace(); ins(${E5}, '16'); grace(); ins(${F5}, '16'); grace();
      ins(${C5}, '2');
      m.setCursor(1, 1);
    `,
    setupKeys: ['/'],
  },
  /* L on a beamed grace flips the whole grace beam (and not the main note). */
  grace_stem_flip_group: {
    setup: `${S}
      ins(${D5}, '16'); grace(); ins(${E5}, '16'); grace(); ins(${F5}, '16'); grace();
      ins(${C5}, '2');
      m.setCursor(2, 1);
    `,
    setupKeys: ['l'],
  },

  /* ── Other commands on a grace ───────────────────────────────────────── */
  grace_dots: {
    setup: `${S}
      ins(${D5}, '8'); grace(); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: ['.'],
  },
  grace_tie_refused: {
    setup: `${S}
      ins(${C5}, '8'); grace(); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: ['='],
  },
  /* A grace between two same-pitch notes is a tie barrier: the first note's
     tie intent finds no partner across it. */
  grace_tie_barrier: {
    setup: `${S}
      ins(${C5}, '4');
      m.toggleTieOnCurrent('insert');
      ins(${C5}, '8'); grace();
      ins(${C5}, '4');
    `,
  },
  /* OVR + digit on a grace replaces it with the held pitch and the new value,
     still a grace. */
  grace_overwrite_keeps_grace: {
    setup: `${S}
      ins(${D5}, '8'); grace(); ins(${C5}, '4');
      m.setCursor(1, 1);
      window.__bridgeMock.sendHeldKeys([${E5}]);
    `,
    setupKeys: [{ key: 'Insert' }, '3'],
  },
  grace_undo: {
    setup: `${S}
      ins(${D5}, '8'); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: ['g', { key: 'z', ctrl: true }],
  },

  /* ── Cursor ──────────────────────────────────────────────────────────── */
  /* Graces are ordinary stops: → walks past each one. */
  /* The bar past a grace scales its offset (not its width) by GRACE_SCALE (0.5):
     editing cursor and Performance-mode playback bar alike; the main note
     keeps the full offset. */
  grace_cursor_offset: {
    setup: `${S}
      ins(${D5}, '8'); grace(); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    visualBaseline: 'grace_cursor_offset',
  },
  /* Same with a slashed grace: the slash must not push the bar further. */
  grace_cursor_offset_slashed: {
    setup: `${S}
      ins(${D5}, '8'); grace(); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'G', shift: true }],
    visualBaseline: 'grace_cursor_offset_slashed',
  },
  /* At zoom 50 the offsets scale with the render: 4 × 0.5 (grace) × 0.5 (zoom)
     past the grace, 4 × 0.5 past its main note; the bar widths scale too
     (voice 2 → 1, playback 3 → 1.5), so the bar fits the gap like a staff line. */
  grace_cursor_offset_zoom50: {
    setup: `${S}
      ins(${D5}, '8'); grace(); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: '_', shift: true }, { key: '_', shift: true }],
    visualBaseline: 'grace_cursor_offset_zoom50',
  },
  grace_cursor_stops: {
    setup: `${S}
      ins(${C5}, '4'); ins(${D5}, '8'); grace(); ins(${E5}, '8'); grace(); ins(${C5}, '4');
      m.setCursor(0, 1);
    `,
    setupKeys: [{ key: 'ArrowRight' }, { key: 'ArrowRight' }, { key: 'ArrowRight' }],
  },
  /* Ctrl+→ to the next barline lands BEFORE bar 2's leading graces. */
  grace_bar_jump_before_graces: {
    setup: `${S}
      for (let i = 0; i < 4; i++) ins(${C5}, '4');
      ins(${D5}, '8'); grace(); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'ArrowRight', ctrl: true }],
  },
  /* Switching voice keeps the time position and lands before the graces at it. */
  grace_voice_switch_before_graces: {
    setup: `${S}
      ins(${C5}, '4'); ins(${D5}, '8'); grace(); ins(${C5}, '4');
      m.setVoice(2); m.setCursor(0, 2);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'ArrowUp' }],
  },
  /* A note entered between a grace and its main note is normal and becomes the
     grace's main note. */
  grace_insert_before_main: {
    setup: `${S}
      ins(${D5}, '8'); grace(); ins(${C5}, '4');
      m.setCursor(1, 1);
      ins(${E5}, '4');
    `,
  },

  /* ── Accidentals: a grace is an earlier note of the bar ──────────────── */
  grace_accid_carries: {
    setup: `${S}
      ins(${FS4}, '16'); grace(); ins(${FS4}, '4');
    `,
  },
  grace_accid_natural_after: {
    setup: `${S}
      ins(${FS4}, '16'); grace(); ins(${F4}, '4');
    `,
  },

  /* ── Selection: graces travel with their main note ───────────────────── */
  /* Cutting beat 2 removes its grace with it. */
  grace_cut_beat_with_run: {
    setup: `${S}
      ins(${C5}, '4'); ins(${D5}, '8'); grace(); ins(${C5}, '4'); ins(${C5}, '4'); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'ArrowRight', shift: true }, { key: 'x', ctrl: true }],
  },
  /* Cutting beat 1 leaves beat 2's grace in place. */
  grace_cut_beat_before_run: {
    setup: `${S}
      ins(${C5}, '4'); ins(${D5}, '8'); grace(); ins(${C5}, '4'); ins(${C5}, '4'); ins(${C5}, '4');
      m.setCursor(0, 1);
    `,
    setupKeys: [{ key: 'ArrowRight', shift: true }, { key: 'x', ctrl: true }],
  },
  /* Copying beat 2 and pasting over beat 3 carries the grace. Copy/paste run in
     the assertion (ClipboardEvent, the signatures-fixture pattern). */
  grace_copy_paste: {
    setup: `${S}
      ins(${C5}, '4'); ins(${D5}, '8'); grace(); ins(${E5}, '4'); ins(${C5}, '4'); ins(${C5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'ArrowRight', shift: true }, { key: 'c', ctrl: true }],
  },

  /* ── Engraving ───────────────────────────────────────────────────────── */
  /* Bar 1: slashed 8th → C5; plain 8th → C5; slashed grace chord → D5; 16th
     grace slurred to E5. */
  grace_engrave_basic: {
    setup: `${S}
      ins(${D5}, '8'); grace(); m.toggleGraceSlashOnCurrent('insert'); ins(${C5}, '4');
      ins(${D5}, '8'); grace(); ins(${C5}, '4');
      m.insertChordAtCursor({ notes: [${C5}, ${E5}], duration: '8', dots: 0 }); grace(); m.toggleGraceSlashOnCurrent('insert');
      ins(${D5}, '4');
      ins(${F5}, '16'); grace(); ins(${E5}, '4');
      m.setCursor(7, 1);
    `,
    setupKeys: [{ key: 'l', ctrl: true }, { key: 'ArrowRight' }, { key: 'l', ctrl: true }],
    visualBaseline: 'grace_engrave_basic',
  },
  /* HEJI on: a septimal F♯ grace draws its accidental pair at grace size. */
  grace_heji: {
    setup: `${S}
      m.setLayoutReq({ tuningMode: '7' });
      m.setHejiEnabled(true);
      m.setCursor(0, 1);
      ins(${FS4}, '8'); grace(); ins(${C5}, '4');
    `,
    visualBaseline: 'grace_heji',
  },

  /* ── Playback timing ───────────────────────────────────────── */
  /* acc under its cap: a 16th before a quarter takes its written value and
     delays the quarter by it. */
  grace_play_acc_written: {
    setup: `${S}
      ins(${C5}, '4'); ins(${D5}, '16'); grace(); ins(${E5}, '4'); ins(${C5}, '4'); ins(${C5}, '4');
    `,
  },
  /* acc over its cap: two 8ths before a quarter share half the quarter. */
  grace_play_acc_capped: {
    setup: `${S}
      ins(${C5}, '4'); ins(${D5}, '8'); grace(); ins(${E5}, '8'); grace(); ins(${F5}, '4'); ins(${C5}, '2');
    `,
  },
  /* unacc under its cap: a 16th before the beat; the previous half note is cut
     where it starts. */
  grace_play_unacc_written: {
    setup: `${S}
      ins(${C5}, '2'); ins(${D5}, '16'); grace(); m.toggleGraceSlashOnCurrent('insert'); ins(${E5}, '2');
    `,
  },
  /* unacc over its cap: half the way back to the previous note (an 8th). */
  grace_play_unacc_capped: {
    setup: `${S}
      ins(${C5}, '4'); ins(${C5}, '8'); ins(${D5}, '8'); grace(); m.toggleGraceSlashOnCurrent('insert');
      ins(${E5}, '8'); ins(${C5}, '4'); ins(${C5}, '4');
    `,
  },
  /* Same pitch as the previous note: that note is released before the grace
     strikes (HKL keys voices by pitch, so an overlap would cut the grace). */
  grace_play_same_pitch: {
    setup: `${S}
      ins(${C5}, '2'); ins(${C5}, '16'); grace(); m.toggleGraceSlashOnCurrent('insert'); ins(${E5}, '2');
    `,
  },
  /* A before-the-beat grace on the first note: playback gets a lead-in. */
  grace_play_leadin: {
    setup: `${S}
      ins(${D5}, '8'); grace(); m.toggleGraceSlashOnCurrent('insert'); ins(${C5}, '4');
    `,
  },
  /* Playing from bar 2's main note includes its before-the-beat grace. */
  grace_play_from_main: {
    setup: `${S}
      for (let i = 0; i < 4; i++) ins(${C5}, '4');
      ins(${D5}, '8'); grace(); m.toggleGraceSlashOnCurrent('insert'); ins(${E5}, '4');
    `,
  },
  /* The pedal timeline shifts by the same lead-in. */
  grace_play_pedal_leadin: {
    setup: `${S}
      ins(${D5}, '8'); grace(); m.toggleGraceSlashOnCurrent('insert'); ins(${C5}, '4'); ins(${E5}, '4');
      m.setCursor(2, 1);
    `,
    setupKeys: [{ key: 'P', shift: true }],
  },
  /* Graces nested in a regular beam are played (the beam walk recurses). */
  grace_play_nested_beam: {
    setup: `${S}
      ins(${C5}, '8'); ins(${E5}, '16'); grace(); ins(${F5}, '16'); grace(); ins(${D5}, '8');
      ins(${C5}, '4'); ins(${C5}, '2');
    `,
  },
  /* A slur from a grace to its main note joins them legato. */
  grace_play_slur: {
    setup: `${S}
      ins(${F5}, '16'); grace(); ins(${E5}, '4');
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'l', ctrl: true }, { key: 'ArrowRight' }, { key: 'l', ctrl: true }],
  },

  /* ── Performance mode ──────────────────────────────────────── */
  /* Each grace is its own step, in order, before its main note. */
  grace_perf_steps: {
    setup: `${S}
      window.__bridgeMock.reset();
      ins(${C5}, '4'); ins(${D5}, '8'); grace(); m.toggleGraceSlashOnCurrent('insert'); ins(${E5}, '4');
      ins(${F5}, '8'); grace(); ins(${C5}, '4'); ins(${C5}, '4');
    `,
  },
  /* Gate, case 1: voice 1's before-the-beat grace (bar 2) sounds with voice 3's
     last 8th of bar 1. Struck before that 8th, it must still be accepted. */
  grace_perf_gate_tail: {
    setup: `${S}
      window.__bridgeMock.reset();
      ins(${C5}, '2'); ins(${C5}, '4'); ins(${C5}, '4');
      ins(${D5}, '8'); grace(); m.toggleGraceSlashOnCurrent('insert'); ins(${C5}, '1');
      m.setVoice(3); m.setCursor(0, 3);
      ins(${G3}, '2'); ins(${G3}, '4'); ins(${G3}, '8'); ins(${G3}, '8'); ins(${G3}, '1');
      m.setVoice(1);
    `,
  },
  /* Gate, case 2: voice 3's bar-2 downbeat struck just before voice 1's
     before-the-beat grace must be accepted too. */
  grace_perf_gate_downbeat: {
    setup: `${S}
      window.__bridgeMock.reset();
      ins(${C5}, '1');
      ins(${D5}, '8'); grace(); m.toggleGraceSlashOnCurrent('insert'); ins(${C5}, '1');
      m.setVoice(3); m.setCursor(0, 3);
      ins(${G3}, '1'); ins(${G3}, '1');
      m.setVoice(1);
    `,
  },

  /* ── MusicXML ──────────────────────────────────────────────── */
  /* slash → unacc; no slash → acc; a slashed BEAMED pair → acc (slashed groups
     are out of scope); a grace chord; the bar fills exactly 4/4. */
  grace_mx_import: {
    setup: MX(`N('D', 5, 'eighth', { grace: 1, slash: 1 }) + N('C', 5, 'quarter', { dur: 2 })
      + N('E', 5, '16th', { grace: 1, beam: 'begin' }) + N('F', 5, '16th', { grace: 1, beam: 'end' }) + N('C', 5, 'quarter', { dur: 2 })
      + N('D', 5, '16th', { grace: 1, slash: 1, beam: 'begin' }) + N('E', 5, '16th', { grace: 1, slash: 1, beam: 'end' }) + N('C', 5, 'quarter', { dur: 2 })
      + N('C', 5, 'eighth', { grace: 1 }) + N('E', 5, 'eighth', { grace: 1, chord: 1 }) + N('C', 5, 'quarter', { dur: 2 })`),
  },
  /* Source grace beaming survives (2 + 1), and an 8th beam continues across a
     grace between its notes. */
  grace_mx_import_beams: {
    setup: MX(`N('C', 5, 'eighth', { dur: 1, beam: 'begin' }) + N('E', 5, '16th', { grace: 1 }) + N('D', 5, 'eighth', { dur: 1, beam: 'end' })
      + N('D', 5, '16th', { grace: 1, beam: 'begin' }) + N('E', 5, '16th', { grace: 1, beam: 'end' }) + N('F', 5, '16th', { grace: 1 })
      + N('C', 5, 'quarter', { dur: 2 }) + N('C', 5, 'half', { dur: 4 })`),
  },
  /* A tie from a grace to its main note is dropped (graces carry no ties). */
  grace_mx_import_tie_dropped: {
    setup: MX(`N('C', 5, 'eighth', { grace: 1, tie: 'start' }) + N('C', 5, 'quarter', { dur: 2, tie: 'stop' })
      + N('C', 5, 'half', { dur: 4 }) + N('C', 5, 'quarter', { dur: 2 })`),
  },
  /* Export writes <grace/> / <grace slash="yes"/> without <duration>, grace
     beams on their own, the 8th beam across them; re-import is identical. */
  grace_mx_export_roundtrip: {
    setup: `${S}
      ins(${C5}, '8'); ins(${E5}, '16'); grace(); ins(${F5}, '16'); grace(); ins(${D5}, '8');
      ins(${D5}, '8'); grace(); m.toggleGraceSlashOnCurrent('insert'); ins(${C5}, '4');
      m.insertChordAtCursor({ notes: [${C5}, ${E5}], duration: '8', dots: 0 }); grace();
      ins(${C5}, '2');
    `,
  },
};

export const ASSERTIONS = {
  grace_toggle_on: [
    { name: 'D5 is a grace, keeps dur 8, the bar holds 3 quarters of time; cursor stays past it',
      expr: gAssert(`
        const e = expectShape(0, 'd:8(acc) c:4 c:4 c:4');
        if (e) return { ok: false, detail: e };
        return m.getCursor() === 1 ? { ok: true } : { ok: false, detail: 'cursor=' + m.getCursor() };
      `) },
  ],
  grace_entry_flow: [
    { name: 'note after a grace is normal',
      expr: gAssert(`const e = expectShape(0, 'd:8(acc) c:4'); return e ? { ok: false, detail: e } : { ok: true };`) },
  ],
  grace_toggle_off_fits: [
    { name: 'D5 is normal again with its original id',
      expr: gAssert(`
        const e = expectShape(0, 'd:8 c:4 c:4 c:4');
        if (e) return { ok: false, detail: e };
        return idOf(slots(0)[0]) === window.__grace_id ? { ok: true } : { ok: false, detail: 'id ' + idOf(slots(0)[0]) + ' vs ' + window.__grace_id };
      `) },
  ],
  grace_toggle_off_displaces: [
    { name: 'D5 normal at bar start; the 4th quarter moved whole into bar 2',
      expr: gAssert(`
        const e = expectShape(0, 'd:8 c:4 c:4 c:4') || expectShape(1, 'c:4');
        return e ? { ok: false, detail: e } : { ok: true };
      `) },
  ],
  grace_toggle_off_refused: [
    { name: 'grace kept; error status names the planner reason',
      expr: gAssert(`
        const e = expectShape(0, 'd:1(acc) c:4 c:4 c:4 c:4') || expectShape(1, 'c:4 c:4 c:4 c:4');
        if (e) return { ok: false, detail: e };
        const s = status();
        return s.error && s.text.includes('fit') ? { ok: true } : { ok: false, detail: 'status "' + s.text + '" error=' + s.error };
      `) },
  ],
  grace_refused_on_rest: [
    { name: 'no grace; error status',
      expr: gAssert(`
        if (doc.querySelector('[grace]')) return { ok: false, detail: 'a grace exists' };
        const s = status();
        return s.error ? { ok: true } : { ok: false, detail: 'status "' + s.text + '"' };
      `) },
  ],
  grace_refused_in_tuplet: [
    { name: 'no grace; error status',
      expr: gAssert(`
        if (doc.querySelector('[grace]')) return { ok: false, detail: 'a grace exists' };
        const s = status();
        return s.error ? { ok: true } : { ok: false, detail: 'status "' + s.text + '"' };
      `) },
  ],
  grace_chord: [
    { name: '@grace on the <chord>, members bare',
      expr: gAssert(`
        const ch = doc.querySelector('layer chord');
        if (!ch || ch.getAttribute('grace') !== 'acc') return { ok: false, detail: 'chord grace=' + (ch && ch.getAttribute('grace')) };
        if (ch.querySelector('note[grace]')) return { ok: false, detail: 'member carries @grace' };
        const e = expectShape(0, 'chord:8(acc) d:4');
        return e ? { ok: false, detail: e } : { ok: true };
      `) },
  ],
  grace_slash_on: [
    { name: 'grace is unacc',
      expr: gAssert(`const e = expectShape(0, 'd:8(unacc) c:4'); return e ? { ok: false, detail: e } : { ok: true };`) },
  ],
  grace_slash_off: [
    { name: 'grace back to acc',
      expr: gAssert(`const e = expectShape(0, 'd:8(acc) c:4'); return e ? { ok: false, detail: e } : { ok: true };`) },
  ],
  grace_slash_converts_normal: [
    { name: 'the note is now a slashed grace; no error status',
      expr: gAssert(`
        const e = expectShape(0, 'd:8(unacc) c:4');
        if (e) return { ok: false, detail: e };
        const s = status();
        return s.error ? { ok: false, detail: 'status "' + s.text + '"' } : { ok: true };
      `) },
  ],
  grace_slash_convert_undo: [
    { name: 'one undo restores the normal note',
      expr: gAssert(`const e = expectShape(0, 'd:8 c:4'); return e ? { ok: false, detail: e } : { ok: true };`) },
  ],
  grace_slash_refused_on_rest: [
    { name: 'no grace; error status',
      expr: gAssert(`
        if (doc.querySelector('[grace]')) return { ok: false, detail: 'a grace exists' };
        const s = status();
        return s.error ? { ok: true } : { ok: false, detail: 'status "' + s.text + '"' };
      `) },
  ],
  grace_beamed_run: [
    { name: 'the three graces share one rendered beam; the main note is outside it',
      expr: gAssert(`
        const ids = slots(0).map(idOf);
        const b = ids.slice(0, 3).map(beamOf);
        if (!b[0] || b[1] !== b[0] || b[2] !== b[0]) return { ok: false, detail: 'grace beams differ / missing' };
        return beamOf(ids[3]) ? { ok: false, detail: 'main note beamed' } : { ok: true };
      `) },
  ],
  grace_slash_middle_unbeams: [
    { name: 'middle unacc; no grace beam remains',
      expr: gAssert(`
        const e = expectShape(0, 'd:16(acc) e:16(unacc) f:16(acc) c:2');
        if (e) return { ok: false, detail: e };
        const ids = slots(0).map(idOf);
        return ids.slice(0, 3).some(beamOf) ? { ok: false, detail: 'a grace is still beamed' } : { ok: true };
      `) },
  ],
  grace_slash_last_unbeams: [
    { name: 'first two beamed, slashed last alone',
      expr: gAssert(`
        const e = expectShape(0, 'd:16(acc) e:16(acc) f:16(unacc) c:2');
        if (e) return { ok: false, detail: e };
        const ids = slots(0).map(idOf);
        const b0 = beamOf(ids[0]);
        if (!b0 || beamOf(ids[1]) !== b0) return { ok: false, detail: 'first two not one beam' };
        return beamOf(ids[2]) ? { ok: false, detail: 'slashed grace beamed' } : { ok: true };
      `) },
  ],
  grace_in_regular_beam: [
    { name: 'eighths share a beam across the grace; document order kept',
      expr: gAssert(`
        const e = expectShape(0, 'c:8 e:16(acc) d:8 c:4 c:2');
        if (e) return { ok: false, detail: e };
        const ids = slots(0).map(idOf);
        const b = beamOf(ids[0]);
        return b && beamOf(ids[2]) === b ? { ok: true } : { ok: false, detail: 'eighths not one beam' };
      `) },
  ],
  grace_nested_beam: [
    { name: 'eighths share the outer beam; the graces share an inner beam nested in it',
      expr: gAssert(`
        const e = expectShape(0, 'c:8 e:16(acc) f:16(acc) d:8 c:4 c:2');
        if (e) return { ok: false, detail: e };
        const ids = slots(0).map(idOf);
        const outer = beamOf(ids[0]);
        if (!outer || beamOf(ids[3]) !== outer) return { ok: false, detail: 'eighths not one beam' };
        const inner = beamOf(ids[1]);
        if (!inner || inner === outer || beamOf(ids[2]) !== inner) return { ok: false, detail: 'graces not one inner beam' };
        return outer.contains(inner) ? { ok: true } : { ok: false, detail: 'inner beam not nested' };
      `) },
  ],
  grace_beam_break: [
    { name: 'first grace alone, second and third beamed',
      expr: gAssert(`
        const ids = slots(0).map(idOf);
        if (beamOf(ids[0])) return { ok: false, detail: 'first grace still beamed' };
        const b = beamOf(ids[1]);
        return b && beamOf(ids[2]) === b ? { ok: true } : { ok: false, detail: 'second/third not one beam' };
      `) },
  ],
  grace_stem_flip_group: [
    { name: 'all three graces carry the same stem.dir; the main note none',
      expr: gAssert(`
        const s = slots(0);
        const dirs = s.slice(0, 3).map((e) => e.getAttribute('stem.dir'));
        if (!dirs[0] || dirs[1] !== dirs[0] || dirs[2] !== dirs[0]) return { ok: false, detail: 'dirs=' + dirs.join(',') };
        return s[3].hasAttribute('stem.dir') ? { ok: false, detail: 'main note flipped' } : { ok: true };
      `) },
  ],
  grace_dots: [
    { name: 'dotted grace; bar time unchanged',
      expr: gAssert(`const e = expectShape(0, 'd:8.(acc) c:4'); return e ? { ok: false, detail: e } : { ok: true };`) },
  ],
  grace_tie_refused: [
    { name: 'no tie intent on the grace; error status',
      expr: gAssert(`
        const g = slots(0)[0];
        if (g.hasAttribute('tie') || g.hasAttribute('data-pending-tie')) return { ok: false, detail: 'grace has tie state' };
        const s = status();
        return s.error ? { ok: true } : { ok: false, detail: 'status "' + s.text + '"' };
      `) },
  ],
  grace_tie_barrier: [
    { name: 'no tie realized across the grace',
      expr: gAssert(`
        const s = slots(0);
        if (s.length !== 3) return { ok: false, detail: shape(0) };
        if (s[0].hasAttribute('data-tie-partner')) return { ok: false, detail: 'first C5 partnered with ' + s[0].getAttribute('data-tie-partner') };
        const t = s[2].getAttribute('tie');
        return t === 't' || t === 'm' ? { ok: false, detail: 'last C5 tie=' + t } : { ok: true };
      `) },
  ],
  grace_overwrite_keeps_grace: [
    { name: 'replaced by an E5 16th, still a grace',
      expr: gAssert(`const e = expectShape(0, 'e:16(acc) c:4'); return e ? { ok: false, detail: e } : { ok: true };`) },
  ],
  grace_undo: [
    { name: 'undo restores the normal note',
      expr: gAssert(`const e = expectShape(0, 'd:8 c:4'); return e ? { ok: false, detail: e } : { ok: true };`) },
  ],
  grace_cursor_offset: [
    { name: 'bar past the grace: offset 2, width unchanged (2; playback 3); main note offset 4',
      expr: gAssert(`
        const [g, main] = slots(0);
        const rg = H.renderer.rectForId(idOf(g)), rm = H.renderer.rectForId(idOf(main));
        const bar = document.querySelector('rect[data-cursor-role="voice"]');
        if (!rg || !rm || !bar) return { ok: false, detail: 'missing rect/bar' };
        const near = (a, b) => Math.abs(a - b) < 0.01;
        const off = +bar.getAttribute('x') - rg.right, w = +bar.getAttribute('width');
        if (!near(off, 2) || !near(w, 2)) return { ok: false, detail: 'voice bar offset=' + off + ' w=' + w };
        const pbar = (id, r) => {
          H.cursor.setPlaybackPosition(1, id, 'right');
          const pb = document.querySelector('rect[data-cursor-role="playback"]');
          const res = pb ? [+pb.getAttribute('x') - r.right, +pb.getAttribute('width')] : [NaN, NaN];
          H.cursor.setPlaybackPosition(1, null);
          return res;
        };
        const [po, pw] = pbar(idOf(g), rg);
        if (!near(po, 2) || !near(pw, 3)) return { ok: false, detail: 'grace playback bar offset=' + po + ' w=' + pw };
        const [mo, mw] = pbar(idOf(main), rm);
        if (!near(mo, 4) || !near(mw, 3)) return { ok: false, detail: 'main playback bar offset=' + mo + ' w=' + mw };
        return { ok: true };
      `) },
  ],
  grace_cursor_offset_slashed: [
    { name: 'the slash does not widen the grace: bar 2 past the glyph ink',
      expr: gAssert(`
        const [g] = slots(0);
        const G = document.getElementById(idOf(g));
        const box = H.renderer.rectForId(idOf(g));
        const glyphR = Math.max(...[...G.querySelectorAll('g.flag use, g.notehead use')].map((u) => H.renderer.rectForElement(u).right));
        const bar = document.querySelector('rect[data-cursor-role="voice"]');
        if (Math.abs(box.right - glyphR) > 0.5) return { ok: false, detail: 'grace box right ' + box.right + ' vs glyph ink ' + glyphR };
        const off = +bar.getAttribute('x') - box.right;
        return Math.abs(off - 2) < 0.01 ? { ok: true } : { ok: false, detail: 'bar offset ' + off };
      `) },
  ],
  grace_cursor_offset_zoom50: [
    { name: 'zoom 50: bar 1 past the grace (main note 2), widths halved',
      expr: gAssert(`
        await window.__waitForRender();
        if (H.renderer.getZoom() !== 50) return { ok: false, detail: 'zoom ' + H.renderer.getZoom() };
        const [g, main] = slots(0);
        const rg = H.renderer.rectForId(idOf(g)), rm = H.renderer.rectForId(idOf(main));
        const bar = document.querySelector('rect[data-cursor-role="voice"]');
        const near = (a, b) => Math.abs(a - b) < 0.01;
        const off = +bar.getAttribute('x') - rg.right, w = +bar.getAttribute('width');
        if (!near(off, 1) || !near(w, 1)) return { ok: false, detail: 'voice bar offset=' + off + ' w=' + w };
        H.cursor.setPlaybackPosition(1, idOf(main), 'right');
        const pb = document.querySelector('rect[data-cursor-role="playback"]');
        const mo = pb ? +pb.getAttribute('x') - rm.right : NaN;
        H.cursor.setPlaybackPosition(1, null);
        const pw = pb ? +pb.getAttribute('width') : NaN;
        return near(mo, 2) && near(pw, 1.5) ? { ok: true } : { ok: false, detail: 'main playback bar offset=' + mo + ' w=' + pw };
      `) },
  ],
  grace_cursor_stops: [
    { name: 'flat stream lists both graces; three → land past the second grace',
      expr: gAssert(`
        const flat = m.flatChildren(1);
        const graces = flat.filter((e) => e.hasAttribute && e.hasAttribute('grace')).length;
        if (graces !== 2) return { ok: false, detail: 'grace stops=' + graces };
        const cur = flat[m.getCursor()];
        return cur && cur.getAttribute('pname') === 'e' && cur.hasAttribute('grace') ? { ok: true } : { ok: false, detail: 'cursor on ' + (cur && desc(cur)) };
      `) },
  ],
  grace_bar_jump_before_graces: [
    { name: "cursor lands past bar 1's last quarter, not past the grace",
      expr: gAssert(`
        const cur = m.flatChildren(1)[m.getCursor()];
        return cur && !cur.hasAttribute('grace') && cur.closest('measure') === doc.querySelectorAll('measure')[0]
          ? { ok: true } : { ok: false, detail: 'cursor on ' + (cur && cur.localName + ' ' + desc(cur)) };
      `) },
  ],
  grace_voice_switch_before_graces: [
    { name: 'voice 1 cursor lands past the first C5, before the grace',
      expr: gAssert(`
        if (m.getCurrentVoice() !== 1) return { ok: false, detail: 'voice ' + m.getCurrentVoice() };
        const cur = m.flatChildren(1)[m.getCursor(1)];
        return cur && !cur.hasAttribute('grace') && cur.getAttribute('pname') === 'c' && cur === slots(0)[0]
          ? { ok: true } : { ok: false, detail: 'cursor on ' + (cur && desc(cur)) };
      `) },
  ],
  grace_insert_before_main: [
    { name: 'grace, then the new normal E5, then C5',
      expr: gAssert(`const e = expectShape(0, 'd:8(acc) e:4 c:4'); return e ? { ok: false, detail: e } : { ok: true };`) },
  ],
  grace_accid_carries: [
    { name: 'the grace shows its sharp; the same-pitch main note does not repeat it',
      expr: gAssert(`
        const ids = slots(0).map(idOf);
        const g = accGlyphs(ids[0]), p = accGlyphs(ids[1]);
        return g > 0 && p === 0 ? { ok: true } : { ok: false, detail: 'grace glyphs=' + g + ' main glyphs=' + p };
      `) },
  ],
  grace_accid_natural_after: [
    { name: 'F♮ after a F♯ grace shows its natural',
      expr: gAssert(`
        const ids = slots(0).map(idOf);
        const g = accGlyphs(ids[0]), p = accGlyphs(ids[1]);
        return g > 0 && p > 0 ? { ok: true } : { ok: false, detail: 'grace glyphs=' + g + ' main glyphs=' + p };
      `) },
  ],
  grace_cut_beat_with_run: [
    { name: 'beat 2 cut: no grace left, beat 1 kept',
      expr: gAssert(`
        if (doc.querySelector('[grace]')) return { ok: false, detail: 'grace survived: ' + shape(0) };
        const s = slots(0);
        return s[0] && s[0].getAttribute('pname') === 'c' && s[1] && s[1].localName === 'rest' ? { ok: true } : { ok: false, detail: shape(0) };
      `) },
  ],
  grace_cut_beat_before_run: [
    { name: 'beat 1 cut: beat 2 keeps its grace',
      expr: gAssert(`const e = expectShape(0, 'rest:4 d:8(acc) c:4 c:4 c:4'); return e ? { ok: false, detail: e } : { ok: true };`) },
  ],
  grace_copy_paste: [
    { name: 'beat 2 pasted over beat 3 brings its grace',
      expr: gAssert(`
        const dt = new DataTransfer();
        document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
        const text = dt.getData('text/plain');
        if (!text) return { ok: false, detail: 'empty copy' };
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        m.setCursor(3, 1);
        const dt2 = new DataTransfer();
        dt2.setData('text/plain', text);
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt2, bubbles: true, cancelable: true }));
        await new Promise((res) => setTimeout(res, 50));
        const e = expectShape(0, 'c:4 d:8(acc) e:4 d:8(acc) e:4 c:4');
        return e ? { ok: false, detail: e + ' | ' + text.slice(0, 200) } : { ok: true };
      `) },
  ],

  grace_play_acc_written: [
    { name: 'D5 grace on beat 2 for a 16th; E5 starts a 16th late and ends on beat 3',
      expr: gAssert(`
        const evs = sounding(H.buildPlayback(m)), ids = slots(0).map(idOf);
        const g = evOf(evs, ids[1]), p = evOf(evs, ids[2]);
        const ok = g && p && near(g.atMs, 16 * T) && near(g.durationMs, 4 * T) && near(p.atMs, 20 * T) && p.atMs + p.durationMs <= 32 * T + 0.5;
        return ok ? { ok: true } : { ok: false, detail: fmtEv(g) + ' ' + fmtEv(p) };
      `) },
  ],
  grace_play_acc_capped: [
    { name: 'two 8th graces share half the quarter (2 × 4T); F5 starts at 24T',
      expr: gAssert(`
        const evs = sounding(H.buildPlayback(m)), ids = slots(0).map(idOf);
        const a = evOf(evs, ids[1]), b = evOf(evs, ids[2]), p = evOf(evs, ids[3]);
        const ok = a && b && p && near(a.atMs, 16 * T) && near(a.durationMs, 4 * T) && near(b.atMs, 20 * T) && near(b.durationMs, 4 * T) && near(p.atMs, 24 * T);
        return ok ? { ok: true } : { ok: false, detail: [a, b, p].map(fmtEv).join(' ') };
      `) },
  ],
  grace_play_unacc_written: [
    { name: 'D5 grace a 16th before beat 3; E5 on beat 3; the C5 half ends at the grace',
      expr: gAssert(`
        const evs = sounding(H.buildPlayback(m)), ids = slots(0).map(idOf);
        const c = evOf(evs, ids[0]), g = evOf(evs, ids[1]), p = evOf(evs, ids[2]);
        const ok = c && g && p && near(g.atMs, 28 * T) && near(g.durationMs, 4 * T) && near(p.atMs, 32 * T) && c.atMs + c.durationMs <= 28 * T + 0.5;
        return ok ? { ok: true } : { ok: false, detail: [c, g, p].map(fmtEv).join(' ') };
      `) },
  ],
  grace_play_unacc_capped: [
    { name: 'the 8th grace takes half the previous 8th (4T), before the beat',
      expr: gAssert(`
        const evs = sounding(H.buildPlayback(m)), ids = slots(0).map(idOf);
        const g = evOf(evs, ids[2]), p = evOf(evs, ids[3]);
        const ok = g && p && near(g.atMs, 20 * T) && near(g.durationMs, 4 * T) && near(p.atMs, 24 * T);
        return ok ? { ok: true } : { ok: false, detail: fmtEv(g) + ' ' + fmtEv(p) };
      `) },
  ],
  grace_play_same_pitch: [
    { name: 'the previous C5 is released before the C5 grace strikes',
      expr: gAssert(`
        const evs = sounding(H.buildPlayback(m)), ids = slots(0).map(idOf);
        const c = evOf(evs, ids[0]), g = evOf(evs, ids[1]);
        const ok = c && g && c.atMs + c.durationMs <= g.atMs + 0.5 && near(g.atMs, 28 * T);
        return ok ? { ok: true } : { ok: false, detail: fmtEv(c) + ' ' + fmtEv(g) };
      `) },
  ],
  grace_play_leadin: [
    { name: 'grace at 0, main note an 8th later',
      expr: gAssert(`
        const evs = sounding(H.buildPlayback(m)), ids = slots(0).map(idOf);
        const g = evOf(evs, ids[0]), p = evOf(evs, ids[1]);
        const ok = g && p && near(g.atMs, 0) && near(g.durationMs, 8 * T) && near(p.atMs, 8 * T);
        return ok ? { ok: true } : { ok: false, detail: fmtEv(g) + ' ' + fmtEv(p) };
      `) },
  ],
  grace_play_from_main: [
    { name: 'starting at bar 2 plays its grace first (lead-in), then the main note',
      expr: gAssert(`
        const ids = slots(1).map(idOf);
        const evs = sounding(H.buildPlayback(m, 64 * T));
        const g = evOf(evs, ids[0]), p = evOf(evs, ids[1]);
        const ok = evs.length === 2 && g && p && near(g.atMs, 0) && near(p.atMs, 8 * T);
        return ok ? { ok: true } : { ok: false, detail: evs.length + ' events: ' + evs.map(fmtEv).join(' ') };
      `) },
  ],
  grace_play_pedal_leadin: [
    { name: 'pedal down lands with the main note, after the lead-in',
      expr: gAssert(`
        const run = H.playbackRun(m, 0);
        const ids = slots(0).map(idOf);
        const p = evOf(run.events, ids[1]);
        const down = run.pedalEvents.find((e) => e.dir === 'down');
        return p && down && near(down.atMs, p.atMs) && near(p.atMs, 8 * T)
          ? { ok: true } : { ok: false, detail: 'main ' + fmtEv(p) + ' pedal ' + (down && (down.atMs / T).toFixed(2)) };
      `) },
  ],
  grace_play_nested_beam: [
    { name: 'both graces play between the eighths (2T each), D5 delayed by 4T',
      expr: gAssert(`
        const evs = sounding(H.buildPlayback(m)), ids = slots(0).map(idOf);
        const a = evOf(evs, ids[1]), b = evOf(evs, ids[2]), p = evOf(evs, ids[3]);
        const ok = a && b && p && near(a.atMs, 8 * T) && near(b.atMs, 10 * T) && near(p.atMs, 12 * T);
        return ok ? { ok: true } : { ok: false, detail: [a, b, p].map(fmtEv).join(' ') };
      `) },
  ],
  grace_play_slur: [
    { name: 'the grace event is slurred to its main note',
      expr: gAssert(`
        if (!doc.querySelector('slur')) return { ok: false, detail: 'no slur' };
        const evs = sounding(H.buildPlayback(m)), ids = slots(0).map(idOf);
        const g = evOf(evs, ids[0]);
        return g && g.slurredToNext ? { ok: true } : { ok: false, detail: fmtEv(g) + ' slurred=' + (g && g.slurredToNext) };
      `) },
  ],
  grace_perf_steps: [
    { name: 'graces are individual steps in order; a main note struck before its grace waits',
      expr: gAssert(`
        const ids = slots(0).map(idOf);
        P.start();
        const log = [];
        const step = (id) => { strikeId(id); log.push(bar(1)); };
        step(ids[0]); step(ids[2]); step(ids[1]); step(ids[2]); step(ids[3]); step(ids[4]);
        const want = [ids[0], ids[0], ids[1], ids[2], ids[3], ids[4]].map((id) => id + '@right');
        return log.join(' ') === want.join(' ') ? { ok: true } : { ok: false, detail: 'got ' + log.join(' ') + ' want ' + want.join(' ') };
      `) },
  ],
  grace_perf_gate_tail: [
    { name: "bar 2's grace struck before voice 3's last 8th of bar 1 is accepted",
      expr: gAssert(`
        const v1a = slots(0).map(idOf), v1b = slots(1).map(idOf), v3a = ids3(0), v3b = ids3(1);
        P.start();
        strikeId(v1a[0]); strikeId(v3a[0]);   /* beat 1 */
        strikeId(v1a[1]); strikeId(v3a[1]);   /* beat 3 */
        strikeId(v1a[2]); strikeId(v3a[2]);   /* beat 4 */
        strikeId(v1b[0]);                      /* the grace, before v3's last 8th */
        if (bar(1) !== v1b[0] + '@right') return { ok: false, detail: 'grace not accepted: v1 bar ' + bar(1) };
        strikeId(v3a[3]);
        strikeId(v1b[1]); strikeId(v3b[0]);
        return bar(1) === v1b[1] + '@right' && bar(3) === v3b[0] + '@right'
          ? { ok: true } : { ok: false, detail: 'end bars v1 ' + bar(1) + ' v3 ' + bar(3) };
      `) },
  ],
  grace_perf_gate_downbeat: [
    { name: "voice 3's bar-2 downbeat struck before voice 1's grace is accepted",
      expr: gAssert(`
        const v1a = slots(0).map(idOf), v1b = slots(1).map(idOf), v3a = ids3(0), v3b = ids3(1);
        P.start();
        strikeId(v1a[0]); strikeId(v3a[0]);
        strikeId(v3b[0]);                      /* v3's downbeat, before the grace */
        if (bar(3) !== v3b[0] + '@right') return { ok: false, detail: 'v3 downbeat not accepted: ' + bar(3) };
        strikeId(v1b[0]);
        if (bar(1) !== v1b[0] + '@right') return { ok: false, detail: 'grace not accepted: ' + bar(1) };
        strikeId(v1b[1]);
        return bar(1) === v1b[1] + '@right' ? { ok: true } : { ok: false, detail: 'v1 bar ' + bar(1) };
      `) },
  ],
  grace_mx_import: [
    { name: 'graces imported with their kind; the bar holds exactly four quarters',
      expr: gAssert(`
        const e = expectShape(0, 'd:8(unacc) c:4 e:16(acc) f:16(acc) c:4 d:16(acc) e:16(acc) c:4 chord:8(acc) c:4');
        return e ? { ok: false, detail: e } : { ok: true };
      `) },
  ],
  grace_mx_import_beams: [
    { name: 'eighths beamed across the grace; graces beamed 2 + 1',
      expr: gAssert(`
        const e = expectShape(0, 'c:8 e:16(acc) d:8 d:16(acc) e:16(acc) f:16(acc) c:4 c:2');
        if (e) return { ok: false, detail: e };
        const ids = slots(0).map(idOf);
        const b = beamOf(ids[0]);
        if (!b || beamOf(ids[2]) !== b) return { ok: false, detail: 'eighths not one beam' };
        const g = beamOf(ids[3]);
        if (!g || beamOf(ids[4]) !== g) return { ok: false, detail: 'first two graces not one beam' };
        return beamOf(ids[5]) ? { ok: false, detail: 'third grace beamed' } : { ok: true };
      `) },
  ],
  grace_mx_import_tie_dropped: [
    { name: 'no tie on the grace or into the main note',
      expr: gAssert(`
        const e = expectShape(0, 'c:8(acc) c:4 c:2 c:4');
        if (e) return { ok: false, detail: e };
        const s = slots(0);
        const tied = s.filter((x) => x.hasAttribute('tie') || x.hasAttribute('data-tie-partner')).map(desc);
        return tied.length ? { ok: false, detail: 'tied: ' + tied.join(' ') } : { ok: true };
      `) },
  ],
  grace_mx_export_roundtrip: [
    { name: 'export encodes graces; re-import gives the same bar',
      expr: gAssert(`
        const xml = H.exportMusicXml(m);
        const x = new DOMParser().parseFromString(xml, 'application/xml');
        const notes = [...x.querySelectorAll('note')];
        const graces = notes.filter((n) => n.querySelector('grace'));
        if (graces.length !== 5) return { ok: false, detail: 'grace notes ' + graces.length };
        if (graces.some((n) => n.querySelector('duration'))) return { ok: false, detail: 'a grace has <duration>' };
        const slashed = graces.filter((n) => n.querySelector('grace').getAttribute('slash') === 'yes').length;
        if (slashed !== 1) return { ok: false, detail: 'slashed ' + slashed };
        const beamOfX = (n) => { const b = n.querySelector('beam'); return b ? b.textContent : '-'; };
        const roles = notes.filter((n) => !n.querySelector('chord')).map((n) => (n.querySelector('grace') ? 'g' : '') + beamOfX(n)).join(' ');
        if (roles !== 'begin gbegin gend end g- - g- -') return { ok: false, detail: 'beam roles ' + roles };
        const before = shape(0);
        window.__composerImportMusicXml(xml);
        await new Promise((res) => setTimeout(res, 50));
        const after = [...window.__hkl_composer.model.getDoc().querySelectorAll('measure')][0]
          .querySelector('staff[n="1"] layer[n="1"]');
        const got = [...after.children].filter((c) => c.localName === 'note' || c.localName === 'chord' || c.localName === 'rest').map(desc).join(' ');
        return got === before ? { ok: true } : { ok: false, detail: 'before "' + before + '" after "' + got + '"' };
      `) },
  ],
};
