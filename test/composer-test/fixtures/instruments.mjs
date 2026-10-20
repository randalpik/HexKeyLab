// Composer test fixtures — instruments.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

export const FIXTURES = {
  /* ── Multi-instrument ──────────────────────────────────────────── */

  /* Add a single-staff violin to the default piano. Notes in voice 1 (piano,
     staff 1) and voice 5 (violin, staff 3). Universal invariants check the
     per-instrument placeholder budget, roundtrip stability, and no console
     errors; the custom assertion checks the instrument table shape. */
  instr_add: {
    setup: `
      /* Distinct pitches per instrument (q,r differ) so this exercises
         instrument-NAME tagging, not the same-pitch conflict resolution. */
      const N = (q, r, oct, midi) => ({ q, r, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '4', dots: 0 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
    visualBaseline: 'instr_add',
  },
  /* Add a grand-staff organ then remove it — exercises promote-on-add and
     demote-on-remove. The universal roundtrip invariant (placeholder-id-
     normalized) confirms the doc returns to a clean single-piano shape. */
  instr_add_remove_roundtrip: {
    setup: `
      m.addInstrument({ name: 'Organ', staffCount: 2 });
      m.removeInstrument(1);
      r();
    `,
  },
  /* Reorder: piano + violin, distinct notes, then move violin to the top. The
     violin's note must travel to staff 1 (content travels with the staff). */
  instr_reorder: {
    setup: `
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'c', accid: '', oct: 3, midi: 48, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'c', accid: '', oct: 6, midi: 84, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.reorderInstruments([1, 0]);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* Instruments modal is STAGED: adding in the modal must NOT touch the model
     until Setup's Save. Drives Setup → Manage → Add → close → Save and asserts
     the violin only exists after Save. */
  instr_staged_save: {
    setup: `
      const setVal = (dlg, name, v) => { dlg.querySelector('[data-field="' + name + '"]').value = v; };
      document.getElementById('btnSetup').click();
      document.getElementById('setupInstrumentsBtn').click();
      document.getElementById('instrAddBtn').click();
      const te = document.getElementById('textEntryDialog');
      setVal(te, 'name', 'Violin'); setVal(te, 'staves', '1');
      te.querySelector('form').requestSubmit(te.querySelector('.te-ok'));
      /* Staged: model still has only the piano at this point. */
      window.__staged_count = m.instruments().length;
      document.getElementById('instrCloseBtn').click();
      document.getElementById('setupForm').requestSubmit(document.getElementById('setupOk'));
      r();
    `,
  },
  /* Cross-instrument same-pitch / same-onset OVERLAP: piano + violin both play
     (0,0) at beat 1. HKL keys audio voices by (instrument, q, r), so BOTH notes
     must survive buildPlayback — each instrument gets its own voice. (Formerly
     the topmost instrument won and the other was dropped.) Asserted in
     FIXTURE_ASSERTIONS via buildPlayback. */
  instr_crossInstrument_samePitchOverlap: {
    setup: `
      const N = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* SAME-instrument unison at the same onset still collapses to one note: two
     Violin voices (5 + 6) both play (0,0) at beat 1. They'd share one VoiceId in
     HKL, so buildPlayback drops the duplicate — exactly one of the two voice
     events keeps the note. (Complements the cross-instrument overlap above.) */
  instr_sameInstrument_unisonCollapses: {
    setup: `
      const N = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0); m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
      m.setVoice(6); m.setCursor(0); m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0);
      r();
    `,
  },
  /* Two grand-staff instruments: piano (voices 1-4) + a second piano-ish organ
     (voices 5-8). Confirms the cursor cycle + per-instrument layers don't throw
     and the placeholder budget holds across 8 voices / 4 staves. */
  instr_two_grand_staves: {
    setup: `
      const N = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.addInstrument({ name: 'Organ', staffCount: 2 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
      m.setVoice(7); m.setCursor(0, 7); m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* Ignore-color: a colored note rendered with the flag set draws a plain-black
     notehead (the render clone drops @color; the live doc keeps it). */
  instr_ignore_color: {
    setup: `
      const N = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#cc0000', velocity: 80 };
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
      m.setIgnoreColor(true);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
    visualBaseline: 'instr_ignore_color',
  },
  /* Single-part view: piano + violin, select "view violin only". The render
     clone must show ONLY the violin staff; the live model keeps both. Cursor
     parks in the violin's voice. */
  instr_single_part_view: {
    setup: `
      const N = (q, r, oct, midi) => ({ q, r, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '4', dots: 0 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
      /* Drive the real toolbar selector → view violin (index 1). */
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    `,
    visualBaseline: 'instr_single_part_view',
  },
  /* Pizz/arco (§14.3): piano + violin; a "pizz." <dir> on the violin staff
     switches its notes to a pizzicato timbre until an "arco" cue reverts them.
     The violin has NO own pizz variant, so it falls back to the library's
     viola_pizz (Max: hear viola pizz rather than no pizz). Four violin quarter
     notes: beats 1-2 pizz, beats 3-4 arco. */
  instr_pizz_arco: {
    setup: `
      const N = (q, r, oct, midi) => ({ q, r, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      /* Piano at a low, distinct cell so it never collides with the violin. */
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N(0, -1, 3, 53)], duration: '4', dots: 0 });
      m.setVoice(5); m.setCursor(0, 5);
      /* Four distinct violin pitches (ascending fifths) — no same-pitch dedup. */
      for (let k = 0; k < 4; k++) m.insertChordAtCursor({ notes: [N(0, k + 1, 5, 76 + k)], duration: '4', dots: 0 });
      /* Violin is staff 3. pizz. at beat 1 (tstamp 1), arco at beat 3 (tstamp 3). */
      window.__hkl_composer.__addDir(0, 1, 'pizz.', 3);
      window.__hkl_composer.__addDir(0, 3, 'arco', 3);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* String harmonic (§14.4) — natural: Alt+H on a single note sets a diamond
     notehead + data-hkl-harmonic; playback sounds it +1 octave (q+3). */
  instr_string_harmonic: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);  /* park on the note */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', altKey: true, bubbles: true }));
    `,
    visualBaseline: 'instr_string_harmonic',
  },
  /* String harmonic — artificial M3: a stopped C + touched E (M3 above) marked
     harmonic sounds 2 octaves + a P5 above the stopped note (lower q+6, r+1). */
  instr_string_harmonic_artificial: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [
        { q: 0, r: 0, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888', velocity: 80 },
        { q: 1, r: 0, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 },
      ], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', altKey: true, bubbles: true }));
    `,
  },
  /* PDF/print split: PDF export is WYSIWYG with the view selector — a
     single-part view prints just that part — AND uses PDFKit so the Bravura
     OTF embeds and HEJI accidentals render. piano + violin (HEJI on, viewing
     violin whose major-third pitch carries a syntonic comma arrow). */
  instr_pdf_split_view: {
    setup: `
      const N = (q, r, oct, midi) => ({ q, r, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(1); m.setCursor(0, 1); m.insertChordAtCursor({ notes: [N(0, 0, 4, 69)], duration: '4', dots: 0 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(1, 0, 5, 85)], duration: '4', dots: 0 });
      m.setHejiEnabled(true);
      m.setVoice(1); m.setCursor(0, 1);
      r();
      /* The export reads the live page DOM, so the single-part view is the
         REAL toolbar selector → violin (index 1), exactly as a user does. */
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    `,
  },
  /* String harmonic in a 3-note chord: only the diamond (top) becomes a
     harmonic (computed from the next-lowest note below it); the next-lowest
     reference is dropped (stopped note); every OTHER note plays written. The
     chord must NOT go silent. C + E + G(diamond): plays C written + G harmonic,
     E (reference) dropped. */
  instr_string_harmonic_chord: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [
        { q: 0, r: 0, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888', velocity: 80 },
        { q: 1, r: 0, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 },
        { q: 0, r: 1, pname: 'g', accid: '', oct: 4, midi: 67, colorHex: '#888', velocity: 80 },
      ], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', altKey: true, bubbles: true }));
    `,
  },
  /* Multi-instrument selection-mode (§14.5 generalization): enter measure
     selection from a violin voice (5). The selection's staff must be the
     violin's GLOBAL staff @n (3), not clamped to the old 1|2 grand-staff. */
  instr_multi_selection: {
    setup: `
      const N = (q, r, oct, midi) => ({ q, r, pname: 'a', accid: '', oct, midi, colorHex: '#888', velocity: 80 });
      m.addInstrument({ name: 'Violin', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5); m.insertChordAtCursor({ notes: [N(0, 1, 5, 81)], duration: '4', dots: 0 });
      m.setVoice(5); m.setCursor(0, 5);
      r();
      /* Shift+Up enters measure selection on the current (violin) voice. */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
    `,
  },
};

export const ASSERTIONS = {
  /* Instrument table shape + per-voice instrumentKey on playback. */
  instr_add: [
    { name: 'table: 2 instruments, totalVoices=6, totalStaves=3, violin on staff 3',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        if (m.totalVoices() !== 6) return { ok: false, detail: 'totalVoices=' + m.totalVoices() };
        if (m.totalStaves() !== 3) return { ok: false, detail: 'totalStaves=' + m.totalStaves() };
        const insts = m.instruments();
        if (insts.length !== 2) return { ok: false, detail: 'instruments=' + insts.length };
        if (insts[1].name !== 'Violin') return { ok: false, detail: 'instr1 name=' + insts[1].name };
        if (m.staffForVoice(5) !== 3) return { ok: false, detail: 'staffForVoice(5)=' + m.staffForVoice(5) };
        if (m.instrumentOf(5).index !== 1) return { ok: false, detail: 'instrumentOf(5)=' + m.instrumentOf(5).index };
        return { ok: true };
      })()` },
    { name: 'playback: piano note tagged instrumentName=Piano, violin note=Violin',
      expr: `(() => {
        const h = window.__hkl_composer;
        const evs = h.buildPlayback(h.model).filter(e => e.notes.length > 0);
        const piano = evs.find(e => e.voice === 1);
        const violin = evs.find(e => e.voice === 5);
        if (!piano || piano.instrumentName !== 'Piano') return { ok: false, detail: 'piano name=' + (piano && piano.instrumentName) };
        if (!violin || violin.instrumentName !== 'Violin') return { ok: false, detail: 'violin name=' + (violin && violin.instrumentName) };
        return { ok: true };
      })()` },
  ],
  /* Instruments modal stages; only Setup Save commits. */
  instr_staged_save: [
    { name: 'add was staged (1 instrument before Save), committed after Save (Piano+Violin)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        if (window.__staged_count !== 1) return { ok: false, detail: 'staged count=' + window.__staged_count + ' (expected 1 — not applied until Save)' };
        const names = m.instruments().map(i => i.name);
        if (names.length !== 2 || names[0] !== 'Piano' || names[1] !== 'Violin')
          return { ok: false, detail: 'after save=' + names.join(',') };
        return { ok: true };
      })()` },
  ],
  /* Cross-instrument same-pitch/onset → BOTH kept (per-instrument
     VoiceId in HKL); the notes overlap rather than one being dropped. */
  instr_crossInstrument_samePitchOverlap: [
    { name: 'both piano (voice 1) and violin (voice 5) keep (0,0) — overlap, no drop',
      expr: `(() => {
        const h = window.__hkl_composer;
        const evs = h.buildPlayback(h.model);
        const v1 = evs.find(e => e.voice === 1);
        const v5 = evs.find(e => e.voice === 5);
        const has00 = (e) => e && e.notes.length === 1 && e.notes[0].q === 0 && e.notes[0].r === 0;
        if (!has00(v1)) return { ok: false, detail: 'piano notes=' + JSON.stringify(v1 && v1.notes) };
        if (!has00(v5)) return { ok: false, detail: 'violin notes=' + JSON.stringify(v5 && v5.notes) + ' (expected kept, not dropped)' };
        if (v1.instrumentName === v5.instrumentName)
          return { ok: false, detail: 'both name=' + v1.instrumentName + ' (should differ → distinct VoiceIds)' };
        return { ok: true };
      })()` },
  ],
  instr_sameInstrument_unisonCollapses: [
    { name: 'two same-instrument voices at one pitch/onset collapse to one note',
      expr: `(() => {
        const h = window.__hkl_composer;
        const evs = h.buildPlayback(h.model);
        const v5 = evs.find(e => e.voice === 5), v6 = evs.find(e => e.voice === 6);
        const n5 = v5 ? v5.notes.length : -1, n6 = v6 ? v6.notes.length : -1;
        const kept = (n5 === 1 ? 1 : 0) + (n6 === 1 ? 1 : 0);
        const empty = (n5 === 0 ? 1 : 0) + (n6 === 0 ? 1 : 0);
        if (kept !== 1 || empty !== 1)
          return { ok: false, detail: 'n5=' + n5 + ' n6=' + n6 + ' (expected exactly one kept, one collapsed)' };
        return { ok: true };
      })()` },
  ],
  /* Reorder moves the violin to the top; its note rides staff 1. */
  instr_reorder: [
    { name: 'violin first, its oct-6 note now on staff 1; piano on staves 2-3',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const insts = m.instruments();
        if (insts[0].name !== 'Violin' || insts[1].name !== 'Piano')
          return { ok: false, detail: 'order=' + insts.map(i => i.name).join(',') };
        if (insts[0].staffNs.join(',') !== '1' || insts[1].staffNs.join(',') !== '2,3')
          return { ok: false, detail: 'staffNs=' + insts.map(i => i.staffNs.join('/')).join(' ') };
        const s1 = [...m.getDoc().querySelectorAll('measure staff')].find(s => s.getAttribute('n') === '1');
        const oct = s1 && s1.querySelector('note') && s1.querySelector('note').getAttribute('oct');
        if (oct !== '6') return { ok: false, detail: 'staff1 note oct=' + oct + ' (expected 6=violin)' };
        return { ok: true };
      })()` },
  ],
  /* Add-then-remove returns to one piano (demote). */
  instr_add_remove_roundtrip: [
    { name: 'one piano instrument remains, totalVoices=4',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const insts = m.instruments();
        if (insts.length !== 1) return { ok: false, detail: 'instruments=' + insts.length };
        if (m.totalVoices() !== 4) return { ok: false, detail: 'totalVoices=' + m.totalVoices() };
        if (insts[0].staffNs.length !== 2) return { ok: false, detail: 'staffNs=' + insts[0].staffNs.join(',') };
        return { ok: true };
      })()` },
  ],
  /* Ignore-color flag drops the notehead @color on the render clone
     while the live doc keeps it (so save/export still carry color). */
  instr_ignore_color: [
    { name: 'render clone notes carry no @color; live doc keeps it',
      expr: `(() => {
        const h = window.__hkl_composer;
        const m = h.model;
        if (!m.getIgnoreColor()) return { ok: false, detail: 'flag not set' };
        /* Live doc still has the lattice color. */
        const liveNote = m.getDoc().querySelector('note');
        if (!liveNote || liveNote.getAttribute('color') !== '#cc0000')
          return { ok: false, detail: 'live note color=' + (liveNote && liveNote.getAttribute('color')) };
        /* Render serialization strips it. */
        const rendered = new DOMParser().parseFromString(m.serialize({ hejiEnabled: m.getHejiEnabled() }), 'application/xml');
        const rn = rendered.querySelector('note');
        if (rn && rn.getAttribute('color')) return { ok: false, detail: 'render note still colored=' + rn.getAttribute('color') };
        /* And the on-screen SVG notehead has no color. */
        const svgNote = document.querySelector('#score g.note');
        if (svgNote && svgNote.getAttribute('color')) return { ok: false, detail: 'svg note colored=' + svgNote.getAttribute('color') };
        return { ok: true };
      })()` },
  ],
  /* Single-part view renders only the viewed instrument's staff while
     the live model keeps all staves; the cursor parks in the viewed voice. */
  instr_single_part_view: [
    { name: 'rendered SVG shows 1 staff (violin); live model keeps 3; cursor in violin voice',
      expr: `(() => {
        const h = window.__hkl_composer;
        const m = h.model;
        if (h.inputState().viewInstrIdx !== 1) return { ok: false, detail: 'viewInstrIdx=' + h.inputState().viewInstrIdx };
        /* Live model intact: 3 staves total. */
        if (m.totalStaves() !== 3) return { ok: false, detail: 'live totalStaves=' + m.totalStaves() };
        /* Render clone for the active view shows only staff 3 (the violin). */
        const rendered = new DOMParser().parseFromString(
          m.serialize({ hejiEnabled: m.getHejiEnabled() }, [3]), 'application/xml');
        const staffDefs = [...rendered.querySelectorAll('scoreDef staffDef')].map(s => s.getAttribute('n'));
        if (staffDefs.length !== 1 || staffDefs[0] !== '3')
          return { ok: false, detail: 'render staffDefs=' + staffDefs.join(',') };
        const m0Staves = [...rendered.querySelectorAll('measure')][0].querySelectorAll('staff');
        if (m0Staves.length !== 1 || m0Staves[0].getAttribute('n') !== '3')
          return { ok: false, detail: 'm0 staves=' + [...m0Staves].map(s => s.getAttribute('n')).join(',') };
        /* On-screen SVG: exactly one rendered staff. */
        const svgStaves = document.querySelectorAll('#score g.staff');
        if (svgStaves.length !== 1) return { ok: false, detail: 'svg staves=' + svgStaves.length };
        /* Cursor parked in a violin voice (5 or 6). */
        const v = m.getCurrentVoice();
        if (v !== 5 && v !== 6) return { ok: false, detail: 'cursor voice=' + v };
        return { ok: true };
      })()` },
  ],
  /* Pizz./arco <dir> cues switch the violin voice's instrumentKey to a
     pizz variant for spanned notes, reverting on arco. Violin has no own pizz,
     so the pizz span falls back to the library's viola_pizz. */
  instr_pizz_arco: [
    { name: 'violin beats 1-2 flagged pizz, beats 3-4 arco; all name=Violin; piano unaffected',
      expr: `(() => {
        const h = window.__hkl_composer;
        const evs = h.buildPlayback(h.model).filter(e => e.notes.length > 0);
        const violin = evs.filter(e => e.voice === 5).sort((a, b) => a.atMs - b.atMs);
        if (violin.length !== 4) return { ok: false, detail: 'violin events=' + violin.length };
        if (violin.some(e => e.instrumentName !== 'Violin'))
          return { ok: false, detail: 'violin names=' + violin.map(e => e.instrumentName).join(',') };
        /* Composer emits only the notation-level pizz flag; HKL maps pizz →
           viola_pizz fallback at resolution time (not visible here). */
        const pizz = violin.map(e => !!e.pizz);
        if (!(pizz[0] && pizz[1] && !pizz[2] && !pizz[3]))
          return { ok: false, detail: 'pizz flags=' + pizz.join(',') + ' (expected true,true,false,false)' };
        const piano = evs.find(e => e.voice === 1);
        if (!piano || piano.instrumentName !== 'Piano' || piano.pizz)
          return { ok: false, detail: 'piano name=' + (piano && piano.instrumentName) + ' pizz=' + (piano && piano.pizz) };
        return { ok: true };
      })()` },
  ],
  /* Natural string harmonic → diamond notehead + +octave playback. */
  instr_string_harmonic: [
    { name: 'note has @head.shape=diamond + data-hkl-harmonic; sounds q+3',
      expr: `(() => {
        const h = window.__hkl_composer;
        const m = h.model;
        const note = m.getDoc().querySelector('note');
        if (!note || note.getAttribute('head.shape') !== 'diamond')
          return { ok: false, detail: 'head.shape=' + (note && note.getAttribute('head.shape')) };
        const slot = note.closest('chord') ?? note;
        if (slot.getAttribute('data-hkl-harmonic') !== 'true')
          return { ok: false, detail: 'no data-hkl-harmonic' };
        const ev = h.buildPlayback(m).find(e => e.notes.length > 0);
        if (!ev || ev.notes[0].q !== 3 || ev.notes[0].r !== 0)
          return { ok: false, detail: 'sounded=' + JSON.stringify(ev && ev.notes) + ' (expected q3,r0)' };
        return { ok: true };
      })()` },
  ],
  /* Artificial M3 harmonic → sounds lower + 2 octaves + P5 (q+6,r+1). */
  instr_string_harmonic_artificial: [
    { name: 'diamond on E (upper); sounds C+2oct+P5 = (6,1)',
      expr: `(() => {
        const h = window.__hkl_composer;
        const m = h.model;
        const dia = [...m.getDoc().querySelectorAll('note')].filter(n => n.getAttribute('head.shape') === 'diamond');
        if (dia.length !== 1 || dia[0].getAttribute('pname') !== 'e')
          return { ok: false, detail: 'diamond notes=' + dia.map(n => n.getAttribute('pname')).join(',') };
        const ev = h.buildPlayback(m).find(e => e.notes.length > 0);
        if (!ev || ev.notes.length !== 1 || ev.notes[0].q !== 6 || ev.notes[0].r !== 1)
          return { ok: false, detail: 'sounded=' + JSON.stringify(ev && ev.notes) + ' (expected one note q6,r1)' };
        return { ok: true };
      })()` },
  ],
  /* PDF export honors the view filter (prints one part) and embeds
     the Bravura OTF via PDFKit (FontFile3) so HEJI glyphs render. */
  instr_pdf_split_view: [
    { name: 'downloadPdf of the violin-only page view yields a %PDF- blob with an embedded font',
      expr: `(async () => {
        const h = window.__hkl_composer;
        const blobs = [];
        const origCreate = URL.createObjectURL;
        URL.createObjectURL = (b) => { blobs.push(b); return 'blob:x'; };
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function(){};
        try {
          const mod = await import('/composer/src/save.ts');
          const pages = h.renderer.mountAllPages();
          /* The view filter is what is on screen: one staff per system. */
          const staves = pages.flatMap(p => [...p.querySelectorAll('g.system')].map(sy => sy.querySelectorAll('g.staff').length));
          if (!staves.length || staves.some(n => n !== 1)) return { ok: false, detail: 'staves per system=' + staves.join(',') + ' (expected all 1)' };
          await mod.downloadPdf(pages);
          const blob = blobs.find(b => b && b.size > 0);
          if (!blob) return { ok: false, detail: 'no blob; n=' + blobs.length };
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          if (bin.slice(0, 5) !== '%PDF-') return { ok: false, detail: 'head=' + bin.slice(0, 5) };
          if (!bin.includes('FontFile3')) return { ok: false, detail: 'no embedded font (FontFile3)' };
          return { ok: true };
        } finally {
          URL.createObjectURL = origCreate;
          HTMLAnchorElement.prototype.click = origClick;
        }
      })()` },
  ],
  /* Harmonic in a 3-note chord keeps the other notes (no silence). */
  instr_string_harmonic_chord: [
    { name: 'top=open diamond (head.fill=void); plays C written + G harmonic, E dropped',
      expr: `(() => {
        const h = window.__hkl_composer; const m = h.model;
        const diamonds = [...m.getDoc().querySelectorAll('note')].filter(n => n.getAttribute('head.shape') === 'diamond');
        if (diamonds.length !== 1 || diamonds[0].getAttribute('pname') !== 'g')
          return { ok: false, detail: 'diamonds=' + diamonds.map(n => n.getAttribute('pname')).join(',') };
        if (diamonds[0].getAttribute('head.fill') !== 'void')
          return { ok: false, detail: 'diamond not void: head.fill=' + diamonds[0].getAttribute('head.fill') };
        const ev = h.buildPlayback(m).find(e => e.notes.length > 0);
        if (!ev) return { ok: false, detail: 'no sounding event (chord went silent!)' };
        const set = ev.notes.map(n => n.q + ',' + n.r).sort().join(' | ');
        /* C=(0,0) written + G harmonic G=(0,1)->+oct=(3,1); E=(1,0) reference dropped. */
        if (set !== '0,0 | 3,1') return { ok: false, detail: 'sounded=' + set + ' (expected 0,0 | 3,1)' };
        return { ok: true };
      })()` },
  ],
  /* Measure selection from a violin voice uses the global staff @n. */
  instr_multi_selection: [
    { name: 'measure selection on voice 5 spans staff 3 (violin), not clamped to 1|2',
      expr: `(() => {
        const h = window.__hkl_composer;
        const sel = h.inputState().selection;
        if (!sel || sel.kind !== 'measure') return { ok: false, detail: 'selection=' + JSON.stringify(sel) };
        if (sel.originVoice !== 5) return { ok: false, detail: 'originVoice=' + sel.originVoice };
        if (sel.firstStaff !== 3 || sel.lastStaff !== 3)
          return { ok: false, detail: 'staff range=' + sel.firstStaff + '..' + sel.lastStaff + ' (expected 3..3)' };
        return { ok: true };
      })()` },
  ],
};
