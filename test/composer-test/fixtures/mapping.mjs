// Composer test fixtures — note-name mapping (Euler / Wicki-Hayden / chromatic).
// docs/architecture.md → Note-name mapping. Fixture spec: { setup?: string, setupKeys?: string[], ...flags };
// ASSERTIONS maps fixture name → [{ name, expr }]. See ../README.md.
//
// A score's <hkl:layoutReq mapping> is the frame of every note's data-q/data-r.
// Euler (q, r) ↔ Wicki-Hayden (2q, r) ↔ chromatic (4q, r) is exact; a copy
// column → Euler lands on its Euler-equivalent (Wicki-Hayden odd Q:
// ((Q−1)/2 − 3, R+2); chromatic: mapping.ts eulerOf), exactly in every
// band-uniform mode — a Wicki-Hayden copy in Schismatic is one schisma
// (≈1.954¢) low.

/* In-page helpers: a ResolvedNote literal, the note list as "q,r:pname/accid/oct"
   strings, and Setup driven through its real form (confirm stubbed to accept,
   capturing the retune summary). */
const HELPERS = `
  const RN = (q, r, pname, accid, oct, midi) => ({ q, r, pname, accid, oct, midi, colorHex: '#888', velocity: 80 });
  window.__mapNotes = () => [...m.getDoc().querySelectorAll('note')].map((n) =>
    n.getAttribute('data-q') + ',' + n.getAttribute('data-r') + ':' + n.getAttribute('pname')
    + '/' + (n.getAttribute('accid') ?? '') + '/' + n.getAttribute('oct'));
  window.__mapAsked = []; /* window globals outlive a fixture: start clean */
  window.__mapSetupTo = (mapping) => {
    const orig = window.confirm;
    window.confirm = (msg) => { window.__mapAsked.push(msg); return true; };
    document.getElementById('btnSetup').click();
    document.getElementById('setupMapping').value = mapping;
    document.getElementById('setupForm').requestSubmit(document.getElementById('setupOk'));
    window.confirm = orig;
  };
`;

/* Each sheared / inverted preset: Setup Euler → preset → Euler on the Ptolemaic chord A3 C4 C#4 E4.
   Every note moves to its preset cell (convertCell) with its spelling unchanged and comes back
   exactly. Cells precomputed with the real convertCell. */
const PRESET_CELLS = {
  janko: [[0, 0], [1, 1], [2, 0], [3, 1]],
  accordion: [[0, 0], [3, -1], [2, 0], [5, -1]],
  gerhard: [[0, 0], [0, 1], [1, 0], [1, 1]],
  randal: [[0, 0], [2, -1], [1, 0], [3, -1]],
  park: [[0, 0], [4, -1], [2, 0], [6, -1]],
};
const CHORD_NAMES = ['a//3', 'c//4', 'c/s/4', 'e//4'];
const CHORD_EULER = ['0,0:a//3', '-1,1:c//4', '1,0:c/s/4', '0,1:e//4'];
const PRESET_FIXTURES = Object.fromEntries(Object.keys(PRESET_CELLS).map((m) => [`map_retune_${m}_roundtrip`, {
  setup: `
    ${HELPERS}
    m.setCursor(0, 1);
    m.insertChordAtCursor({ notes: [RN(0, 0, 'a', '', 3, 57), RN(-1, 1, 'c', '', 4, 60), RN(1, 0, 'c', 's', 4, 61), RN(0, 1, 'e', '', 4, 64)], duration: '4', dots: 0 });
    window.__mapSetupTo('${m}');
    window.__mapPreset = window.__mapNotes();
    window.__mapPresetReq = m.getLayoutReq().mapping;
    window.__mapSetupTo('euler');
    window.__mapBack = window.__mapNotes();
    r();
  `,
}]));

export const FIXTURES = {
  ...PRESET_FIXTURES,
  /* SC transpose in a sheared layout: Janko's SC-down vector is (−2, 4) (vecFromEuler(−7, 4)). */
  map_sc_janko: {
    setup: `
      ${HELPERS}
      m.setLayoutReq({ tuningMode: '5', mapping: 'janko' });
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [RN(0, 0, 'a', '', 3, 57)], duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'ArrowLeft', alt: true }],
  },
  /* SC transpose in an inverted, sheared layout: the Accordion (Park's cells, sheared) has the
     Euler SC vector (−7, 4) at (6, −4). Until 2026-11-01 its 4-wide band had none, and the
     transpose refused. */
  map_sc_accordion: {
    setup: `
      ${HELPERS}
      m.setLayoutReq({ tuningMode: '5', mapping: 'accordion' });
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [RN(0, 0, 'a', '', 3, 57)], duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'ArrowLeft', alt: true }],
  },
  /* An 8va sounds one band up, (W, 0) in the score's mapping: (6, 0) for Wicki-Hayden's A3.
     It used to add Euler's 3 columns in every mapping (a tritone in Wicki-Hayden). */
  map_ottava_band_width: {
    setup: `
      ${HELPERS}
      window.__bridgeMock.sendHklHello();
      m.setLayoutReq({ tuningMode: '5', mapping: 'wickiHayden' });
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [RN(0, 0, 'a', '', 3, 57)], duration: '4', dots: 0 });
      const doc = m.getDoc(), meas = doc.querySelector('measure');
      const oct = doc.createElementNS(meas.namespaceURI, 'octave');
      for (const [k, v] of [['dis', '8'], ['dis.place', 'above'], ['staff', '1'], ['data-hkl-t0', '0'], ['data-hkl-t1', '100000']]) oct.setAttribute(k, v);
      meas.appendChild(oct);
      m.setCursor(0, 1);
      window.__bridgeMock.reset();
    `,
    setupKeys: [' '],
  },
  /* Setup Euler → Wicki-Hayden → Euler on a Ptolemaic chord: every note moves
     to its original column (2q, r) with pitch and spelling unchanged, and comes
     back exactly. */
  map_setup_retune_roundtrip: {
    setup: `
      ${HELPERS}
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [RN(0, 0, 'a', '', 3, 57), RN(-1, 1, 'c', '', 4, 60), RN(1, 0, 'c', 's', 4, 61), RN(0, 1, 'e', '', 4, 64)], duration: '4', dots: 0 });
      window.__mapBefore = window.__mapNotes();
      window.__mapSetupTo('wickiHayden');
      window.__mapWh = window.__mapNotes();
      window.__mapWhReq = m.getLayoutReq().mapping;
      window.__mapSetupTo('euler');
      window.__mapBack = window.__mapNotes();
      r();
    `,
  },
  /* Schismatic, Wicki-Hayden → Euler: a copy-column note (B3 at (1,0)) has no
     exact Euler cell and relocates to (−3, 2), still B3, ≈1.954¢ low; the
     original-column C#4 at (2,0) lands exactly on (1,0). */
  map_setup_retune_schismatic_copy: {
    setup: `
      ${HELPERS}
      m.setLayoutReq({ tuningMode: 'V', mapping: 'wickiHayden' });
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [RN(1, 0, 'b', '', 3, 59), RN(2, 0, 'c', 's', 4, 61)], duration: '4', dots: 0 });
      window.__mapSetupTo('euler');
      r();
    `,
  },
  /* Entry gate: HKL announces Ptolemaic + Wicki-Hayden while the score is
     Ptolemaic + Euler → committing held keys is blocked with a prompt naming
     the mapping; declining inserts nothing. */
  map_entry_gate_mismatch: {
    setup: `
      ${HELPERS}
      window.__bridgeMock.sendTuningChanged('5', 'wickiHayden');
      window.__bridgeMock.sendHeldKeys([RN(2, 0, 'c', 's', 4, 61)], 'wickiHayden');
      window.__mapAsked = [];
      window.__mapOrigConfirm = window.confirm;
      /* self-restoring: declines once, then puts the real confirm back */
      window.confirm = (msg) => { window.__mapAsked.push(msg); window.confirm = window.__mapOrigConfirm; return false; };
      m.setCursor(0, 1);
    `,
    setupKeys: ['5'],
  },
  /* Entry under Wicki-Hayden: HKL and the score agree; held keys (a copy
     column and an original column) are stored at their own Wicki-Hayden cells
     with HKL's spelling, and the score carries mapping="wickiHayden". */
  map_wh_entry: {
    setup: `
      ${HELPERS}
      m.setLayoutReq({ tuningMode: '5', mapping: 'wickiHayden' });
      window.__bridgeMock.sendTuningChanged('5', 'wickiHayden');
      window.__bridgeMock.sendHeldKeys([RN(1, 0, 'b', '', 3, 59), RN(2, 0, 'c', 's', 4, 61)], 'wickiHayden');
      m.setCursor(0, 1);
    `,
    setupKeys: ['5'],
  },
  /* Setup Euler → chromatic → Euler on the same Ptolemaic chord: every note
     moves to its original column (4q, r) and comes back exactly. */
  map_chromatic_setup_roundtrip: {
    setup: `
      ${HELPERS}
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [RN(0, 0, 'a', '', 3, 57), RN(-1, 1, 'c', '', 4, 60), RN(1, 0, 'c', 's', 4, 61), RN(0, 1, 'e', '', 4, 64)], duration: '4', dots: 0 });
      window.__mapBefore = window.__mapNotes();
      window.__mapSetupTo('chromatic');
      window.__mapCh = window.__mapNotes();
      window.__mapChReq = m.getLayoutReq().mapping;
      window.__mapSetupTo('euler');
      window.__mapBack = window.__mapNotes();
      r();
    `,
  },
  /* Ptolemaic chromatic → Euler: notes on the NEW columns (G#3, Bb3, C4 at
     Q = −1, 1, 3) land on their Euler-equivalents (−2,1), (2,−1), (−1,1),
     pitch-exact, spelling unchanged. */
  map_chromatic_new_columns_to_euler: {
    setup: `
      ${HELPERS}
      m.setLayoutReq({ tuningMode: '5', mapping: 'chromatic' });
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [RN(-1, 0, 'g', 's', 3, 56), RN(1, 0, 'b', 'f', 3, 58), RN(3, 0, 'c', '', 4, 60)], duration: '4', dots: 0 });
      window.__mapSetupTo('euler');
      r();
    `,
  },
  /* Entry under chromatic: HKL and the score agree; held keys (a new column
     and an original column) are stored at their own chromatic cells with HKL's
     spelling, and the score carries mapping="chromatic". */
  map_chromatic_entry: {
    setup: `
      ${HELPERS}
      m.setLayoutReq({ tuningMode: '5', mapping: 'chromatic' });
      window.__bridgeMock.sendTuningChanged('5', 'chromatic');
      window.__bridgeMock.sendHeldKeys([RN(-1, 0, 'g', 's', 3, 56), RN(4, 0, 'c', 's', 4, 61)], 'chromatic');
      m.setCursor(0, 1);
    `,
    setupKeys: ['5'],
  },
  /* HKL in Euler, score in Wicki-Hayden but the SAME tuning mode: the held
     keys' Euler coordinates are converted into the score's frame on use
     (HKL's (1,0) C#4 → the score's (2,0)). With the gate comparing mapping
     too, the user is asked first; accepting the prompt is not what inserts
     (it asks HKL to switch), so this checks the conversion via getHeldKeys. */
  map_held_keys_converted: {
    setup: `
      ${HELPERS}
      m.setLayoutReq({ tuningMode: '5', mapping: 'wickiHayden' });
      window.__bridgeMock.sendHeldKeys([RN(1, 0, 'c', 's', 4, 61)], 'euler');
    `,
  },
  /* HKL plays in a sheared layout a score can't use (Janko, decisions.md
     2026-10-30 "Layout presets in HKL"): its held E4 at Janko (3, 1) reaches a
     Euler score as Euler (0, 1). Before the mapping widened, Composer read the
     unknown id as Euler and took (3, 1) itself — G#5. */
  map_held_keys_from_janko: {
    setup: `
      ${HELPERS}
      m.setLayoutReq({ tuningMode: '5', mapping: 'euler' });
      window.__bridgeMock.sendHeldKeys([RN(3, 1, 'e', '', 4, 64)], 'janko');
    `,
  },
  /* Setup offers every mapping, in the dropdown order. */
  map_setup_lists_all_mappings: {
    setup: `
      ${HELPERS}
      document.getElementById('btnSetup').click();
      window.__mapOptions = [...document.getElementById('setupMapping').options].map((o) => o.value);
    `,
  },
  /* Notehead color in an inverted layout is the fourths spine's (docs/architecture.md → Color
     scheme): Randal, the chord A3 C#4 A4 C#5, the upper pair one band up. Ptolemaic's band step
     is 2:1, so each pair shares a color. Schismatic's is 2:1 × a schisma (3⁸·5/2¹⁵): 8 fourths
     down the spine and a major third up, 3 octaves, so the upper pair turns 3 hues (purple →
     yellow, blue → orange). Until 2026-11-09 the inverted branch added the schisma's fifths-spine
     step instead and gave teal and green. Hexes computed from the shared functions. */
  map_randal_schismatic_recolors: {
    setup: `
      ${HELPERS}
      const N = (q, r, pname, accid, oct, midi, ink, light) => ({ q, r, pname, accid, oct, midi, colorHex: ink, lightColorHex: light, velocity: 80 });
      window.__mapCols = () => {
        const by = {};
        for (const n of m.getDoc().querySelectorAll('note')) by[n.getAttribute('data-q') + ',' + n.getAttribute('data-r')] = [n.getAttribute('color'), n.getAttribute('data-light-color')];
        return ['0,0', '1,0', '3,0', '4,0'].map((k) => by[k] ?? null);
      };
      m.setLayoutReq({ tuningMode: '5', mapping: 'randal' });
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [
        N(0, 0, 'a', '', 3, 57, '#9405d1', '#C94CFF'), N(1, 0, 'c', 's', 4, 61, '#9405d1', '#C94CFF'),
        N(3, 0, 'a', '', 4, 69, '#9405d1', '#C94CFF'), N(4, 0, 'c', 's', 5, 73, '#9405d1', '#C94CFF'),
      ], duration: '4', dots: 0 });
      m.recolorNotes();
      window.__mapColPtolemaic = window.__mapCols();
      m.setLayoutReq({ tuningMode: 'V', mapping: 'randal' });
      m.recolorNotes();
      window.__mapColSchismatic = window.__mapCols();
      r();
    `,
  },
};

const expect = (got, want) => (JSON.stringify(got) === JSON.stringify(want)
  ? { ok: true } : { ok: false, detail: 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want) });

const PRESET_ASSERTIONS = Object.fromEntries(Object.entries(PRESET_CELLS).map(([m, cells]) => [`map_retune_${m}_roundtrip`, [
  { name: `Euler → ${m}: each note on its ${m} cell, spelling unchanged`,
    expr: `(${expect.toString()})(window.__mapPreset, ${JSON.stringify(cells.map(([q, r], i) => q + ',' + r + ':' + CHORD_NAMES[i]))})` },
  { name: `score records mapping="${m}"`, expr: `(${expect.toString()})(window.__mapPresetReq, '${m}')` },
  { name: 'and back to Euler: the original cells', expr: `(${expect.toString()})(window.__mapBack, ${JSON.stringify(CHORD_EULER)})` },
]]));

export const ASSERTIONS = {
  ...PRESET_ASSERTIONS,
  map_sc_janko: [
    { name: 'A3 lowers a syntonic comma to Janko (−2, 4)', expr: `(${expect.toString()})(window.__mapNotes ? window.__mapNotes().map((x) => x.split(':')[0]) : null, ['-2,4'])` },
  ],
  map_sc_accordion: [
    { name: 'A3 moves by the Euler SC vector to Accordion (6, −4)', expr: `(${expect.toString()})(window.__mapNotes ? window.__mapNotes().map((x) => x.split(':')[0]) : null, ['6,-4'])` },
  ],
  map_ottava_band_width: [
    { name: 'the 8va plays Wicki-Hayden A3 at (6, 0), one band up',
      expr: `(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(true)));
        await Promise.resolve();
        const ps = window.__bridgeMock.captured().find((c) => c.type === 'play-score');
        if (!ps) return { ok: false, detail: 'no play-score: ' + JSON.stringify(window.__bridgeMock.captured().map((c) => c.type)) };
        const ev = ps.events.find((e) => e.notes.length);
        return (${expect.toString()})(ev ? ev.notes[0].q + ',' + ev.notes[0].r + ' ' + ps.mapping : null, '6,0 wickiHayden');
      })()` },
  ],
  map_setup_retune_roundtrip: [
    { name: 'Euler → Wicki-Hayden: each note on (2q, r), spelling unchanged',
      expr: `(${expect.toString()})(window.__mapWh, ['0,0:a//3', '-2,1:c//4', '2,0:c/s/4', '0,1:e//4'])` },
    { name: 'score records mapping="wickiHayden"',
      expr: `(${expect.toString()})(window.__mapWhReq, 'wickiHayden')` },
    { name: 'retune prompt names the layout change, all exact',
      expr: `(() => {
        const a = window.__mapAsked ?? [];
        const ok = a.length === 2 && a.every((s) => s.includes('Changing layout from') && s.includes('4 exact matches') && !s.includes('relocated'));
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(a) };
      })()` },
    { name: 'and back to Euler: the original cells',
      expr: `(${expect.toString()})(window.__mapBack, window.__mapBefore)` },
    { name: 'Euler score carries no mapping attribute',
      expr: `(() => {
        const lr = [...window.__hkl_composer.model.getDoc().getElementsByTagName('*')].find((e) => e.localName === 'layoutReq');
        return lr && !lr.hasAttribute('mapping') ? { ok: true } : { ok: false, detail: lr ? lr.outerHTML : 'no layoutReq' };
      })()` },
  ],
  map_setup_retune_schismatic_copy: [
    { name: 'copy B3 → (−3,2) B3; original C#4 → (1,0)',
      expr: `(${expect.toString()})(window.__mapNotes(), ['-3,2:b//3', '1,0:c/s/4'])` },
    { name: 'prompt reports one relocation at ≈2.0¢',
      expr: `(() => {
        const a = window.__mapAsked ?? [];
        const ok = a.length === 1 && a[0].includes('1 relocated') && a[0].includes('2.0¢') && a[0].includes('1 exact match');
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(a) };
      })()` },
  ],
  map_entry_gate_mismatch: [
    { name: 'prompt names both layouts',
      expr: `(() => {
        const a = window.__mapAsked ?? [];
        window.confirm = window.__mapOrigConfirm ?? window.confirm;
        const ok = a.length === 1 && a[0].includes('Ptolemaic · Wicki-Hayden') && a[0].includes('"Ptolemaic"');
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(a) };
      })()` },
    { name: 'declined → nothing inserted',
      expr: `(${expect.toString()})(window.__hkl_composer.model.getDoc().querySelectorAll('note').length, 0)` },
  ],
  map_wh_entry: [
    { name: 'notes stored at their own Wicki-Hayden cells',
      expr: `(${expect.toString()})(window.__mapNotes(), ['1,0:b//3', '2,0:c/s/4'])` },
    { name: 'score carries mapping="wickiHayden"',
      expr: `(() => {
        const lr = [...window.__hkl_composer.model.getDoc().getElementsByTagName('*')].find((e) => e.localName === 'layoutReq');
        return lr && lr.getAttribute('mapping') === 'wickiHayden' ? { ok: true } : { ok: false, detail: lr ? lr.outerHTML : 'no layoutReq' };
      })()` },
  ],
  map_chromatic_setup_roundtrip: [
    { name: 'Euler → chromatic: each note on (4q, r), spelling unchanged',
      expr: `(${expect.toString()})(window.__mapCh, ['0,0:a//3', '-4,1:c//4', '4,0:c/s/4', '0,1:e//4'])` },
    { name: 'score records mapping="chromatic"',
      expr: `(${expect.toString()})(window.__mapChReq, 'chromatic')` },
    { name: 'retune prompt: all exact both ways',
      expr: `(() => {
        const a = window.__mapAsked ?? [];
        const ok = a.length === 2 && a.every((s) => s.includes('Changing layout from') && s.includes('4 exact matches') && !s.includes('relocated'));
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(a) };
      })()` },
    { name: 'and back to Euler: the original cells',
      expr: `(${expect.toString()})(window.__mapBack, window.__mapBefore)` },
  ],
  map_chromatic_new_columns_to_euler: [
    { name: 'G#3 → (−2,1), Bb3 → (2,−1), C4 → (−1,1), spelling unchanged',
      expr: `(${expect.toString()})(window.__mapNotes(), ['-2,1:g/s/3', '2,-1:b/f/3', '-1,1:c//4'])` },
    { name: 'prompt: 3 exact matches, nothing relocated',
      expr: `(() => {
        const a = window.__mapAsked ?? [];
        const ok = a.length === 1 && a[0].includes('3 exact matches') && !a[0].includes('relocated');
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(a) };
      })()` },
  ],
  map_chromatic_entry: [
    { name: 'notes stored at their own chromatic cells',
      expr: `(${expect.toString()})(window.__mapNotes(), ['-1,0:g/s/3', '4,0:c/s/4'])` },
    { name: 'score carries mapping="chromatic"',
      expr: `(() => {
        const lr = [...window.__hkl_composer.model.getDoc().getElementsByTagName('*')].find((e) => e.localName === 'layoutReq');
        return lr && lr.getAttribute('mapping') === 'chromatic' ? { ok: true } : { ok: false, detail: lr ? lr.outerHTML : 'no layoutReq' };
      })()` },
  ],
  map_held_keys_converted: [
    { name: 'getHeldKeys returns the score-frame cell',
      expr: `(() => {
        const held = window.__hkl_composer.getHeldKeys ? window.__hkl_composer.getHeldKeys() : null;
        if (!held) return { ok: false, detail: 'no getHeldKeys hook' };
        return (${expect.toString()})(held.map((k) => k.q + ',' + k.r + ':' + k.pname + '/' + k.accid + '/' + k.oct), ['2,0:c/s/4']);
      })()` },
  ],
  map_held_keys_from_janko: [
    { name: 'getHeldKeys returns the Euler cell of the Janko key',
      expr: `(() => {
        const held = window.__hkl_composer.getHeldKeys ? window.__hkl_composer.getHeldKeys() : null;
        if (!held) return { ok: false, detail: 'no getHeldKeys hook' };
        return (${expect.toString()})(held.map((k) => k.q + ',' + k.r + ':' + k.pname + '/' + k.accid + '/' + k.oct), ['0,1:e//4']);
      })()` },
  ],
  map_setup_lists_all_mappings: [
    { name: 'the Setup mapping list is all eight, in dropdown order',
      expr: `(${expect.toString()})(window.__mapOptions, ['euler', 'wickiHayden', 'chromatic', 'gerhard', 'janko', 'accordion', 'randal', 'park'])` },
  ],
  map_randal_schismatic_recolors: [
    { name: 'Ptolemaic: A3 and A4 purple, C#4 and C#5 blue (a band step keeps the color)',
      expr: `(${expect.toString()})(window.__mapColPtolemaic, [['#9405d1', '#C94CFF'], ['#055ad1', '#4C96FF'], ['#9405d1', '#C94CFF'], ['#055ad1', '#4C96FF']])` },
    { name: 'Schismatic: the band above turns 3 hues on the fourths spine (A4 yellow, C#5 orange)',
      expr: `(${expect.toString()})(window.__mapColSchismatic, [['#9405d1', '#C94CFF'], ['#055ad1', '#4C96FF'], ['#bd890f', '#FFF94C'], ['#eb6200', '#FF884C']])` },
  ],
};
