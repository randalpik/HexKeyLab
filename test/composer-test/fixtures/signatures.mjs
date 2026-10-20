// Composer test fixtures — signatures.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

import {
  A_NOTE,
} from './_helpers.mjs';

/** A full 4/4 bar of quarters, then an empty 6/8 bar 2 (tick 64, 48 ticks)
 *  with the cursor at its start; `N` in scope for further inserts. */
const METER_68_BAR2 = `
  const N = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
  m.setCursor(0, 1);
  for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
  m.appendMeasure();
  m.setMeterAt(1, 6, 8);
  m.setCursor(m.getMeasureStartCursor(1, 1), 1);
`;
/** Assertion expr: bar 2's voice-1 content as "kind:dur[.]" tokens. */
const meterBar2Expr = (want) => `(() => {
  const layer = window.__hkl_composer.model.allMeasures()[1].querySelector('staff[n="1"] layer[n="1"]');
  const got = [...layer.children].filter((c) => c.localName !== 'space')
    .map((c) => c.localName + ':' + (c.getAttribute('dur') ?? c.getAttribute('num') + '/' + c.getAttribute('numbase')) + '.'.repeat(+(c.getAttribute('dots') ?? 0))).join(',');
  return got === ${JSON.stringify(want)} ? { ok: true } : { ok: false, detail: 'bar 2 = ' + got + '; want ' + ${JSON.stringify(want)} };
})()`;

export const FIXTURES = {

  /* ── Time-sig / key-sig changes ──────────────────────────────────── */
  /* Fill 4/4 with 4 quarter notes, change to 3/4 → last beat dropped. */
  timeSig4to3Truncate: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setTimeSig(3, 4);
  ` },
  /* Fill 4/4, change to 6/8 → meter wider; existing content fits. */
  timeSig4to6_8: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setTimeSig(6, 8);
  ` },
  /* Switch to 3 sharps. */
  keySig3Sharps: { setup: `
    m.setKeySig('3s');
  ` },
  /* Minor flag + 0 flats: tonic becomes A (r=0) instead of C (r=-3). The key
   * tonic IS the score-ref now, so assert on the broadcast itself. */
  keyModeMinor_0_BroadcastsA: { setup: `
    m.setKeySig('0');
    m.setKeyMode('minor');
    window.__bridgeMock.reset();
    window.__bridgeMock.sendHklHello();
  ` },
  /* Minor + 7 sharps: tonic is a♯ at r=7 (sharp-extreme, exercises the
   * extended TONIC_R range that pre-keyMode only needed to reach r=4). */
  keyModeMinor_7s_BroadcastsAsharp: { setup: `
    m.setKeySig('7s');
    m.setKeyMode('minor');
    window.__bridgeMock.reset();
    window.__bridgeMock.sendHklHello();
  ` },
  /* Major flag (default) + 3 sharps: tonic is A at r=0. Sanity-check that
   * the major path still resolves correctly with the new mode parameter. */
  keyModeMajor_3s_BroadcastsA: { setup: `
    m.setKeySig('3s');
    m.setKeyMode('major');
    window.__bridgeMock.reset();
    window.__bridgeMock.sendHklHello();
  ` },
  /* Round-trip: set minor, serialize, reload via replaceDocument, confirm
   * getKeyMode() still returns 'minor' (i.e. @mode survives MEI roundtrip). */
  keyModeRoundtrip: { setup: `
    m.setKeySig('1f');
    m.setKeyMode('minor');
    const xml = m.serialize();
    m.replaceDocument(xml);
  ` },

  /* ── 4/4 beaming rules (beat-group + cross-beat super-group) ──────────── */
  /* 4/4 with 8 eighth notes: each half-measure (32 ticks) is exactly 4
   * eighths, so cross-beat super-beaming fires for both halves → two
   * beams of 4 in the layer. */
  beam4_4_eightEighths: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 8; i++) {
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
    }
  ` },
  /* 4/4 with [E E 16 16 E] × 2 (32 ticks per half). Each half has 5
   * mixed-duration members, NOT four eighth notes, so the half falls
   * back to per-beat groups: beat 1 = [E E] (beam of 2), beat 2 =
   * [16 16 E] (beam of 3). Same shape repeats for beats 3-4. */
  beam4_4_mixedSplitsPerBeat: { setup: `
    m.setCursor(0, 1);
    for (let half = 0; half < 2; half++) {
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '16', dots: 0 });
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '16', dots: 0 });
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
    }
  ` },
  /* 4/4 with first half = 4 eighths (super-beam) and second half =
   * [E E 16 16 E] (per-beat split). Confirms each half is evaluated
   * independently: one super-beam of 4, then two per-beat beams (2 + 3). */
  beam4_4_mixedHalves: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) {
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
    }
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '16', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '16', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
  ` },
  /* Prerequisite: a 2-measure doc with a synthetic in-section
     <scoreDef> meter override (M1 = 4/4 → 64 ticks, M2 = 3/4 → 48 ticks).
     No UI writes overrides yet, so the override is injected directly into the
     live <section> before M2. Validates the per-measure tick table: the
     universal placeholder invariant must accept M2 filled to 48 (not 64), the
     roundtrip invariant must preserve the injected <scoreDef> byte-stably, and
     the MODEL assertion checks measureStartTick / measureTicksAt across the
     boundary + playback atMs accumulation. */
  mixed_meter_prereq: {
    setup: `
      /* M1: a note on beat 1 + 3 quarter rests → full 4/4 (64 ticks). */
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      /* M2: a note on beat 1 (created by inserting past the end of full M1). */
      m.setCursor(m.getVoiceLength(1), 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      /* Inject an in-section <scoreDef meter.count=3 meter.unit=4> before M2,
         in the head scoreDef's namespace so the meter-table walk matches it. */
      const doc = m.getDoc();
      const section = doc.querySelector('section');
      const measures = doc.querySelectorAll('measure');
      const head = doc.querySelector('scoreDef');
      const sd = doc.createElementNS(head.namespaceURI, 'scoreDef');
      sd.setAttribute('meter.count', '3');
      sd.setAttribute('meter.unit', '4');
      section.insertBefore(sd, measures[1]);
      m.invalidateMeterCache();
      m.normalizePlaceholdersAll();
      m.setBarlines();
      r();
    `,
  },
  /* The Ctrl+Shift+S signature modal (UI refactor — still writes the
     global score-head signature). Drive open → set key + meter → submit, on the
     empty default doc (no notes → no truncation confirm). */
  sig_modal: {
    setup: `
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="key"]').value = '2s|major';
      dlg.querySelector('[data-field="count"]').value = '3';
      dlg.querySelector('[data-field="unit"]').value = '4';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
  },
  /* A key-signature change anchored to measure 2 must take effect
     ONLY from measure 2 forward — measure 1 keeps the head key. Builds a
     2-measure doc, parks the cursor in M2, opens Ctrl+Shift+S, sets E♭ major. */
  keysig_midpiece: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(m.getVoiceLength(1), 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      /* Park the cursor at the start of measure 2 (index 1) so Ctrl+Shift+S anchors there. */
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="key"]').value = '3f|major';
      dlg.querySelector('[data-field="count"]').value = '4';
      dlg.querySelector('[data-field="unit"]').value = '4';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
  },
  /* Submitting Ctrl+Shift+S on a later measure WITHOUT changing key
     or meter must NOT write an in-section override (no redundant sig change). */
  sig_unchanged_no_override: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(m.getVoiceLength(1), 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, bubbles: true }));
      /* Submit immediately — fields pre-populated with the inherited values. */
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
  },
  /* Setup relegates time/key to a button (like Tempo) — the inline
     key/time selects are gone; #setupSigBtn opens the signature modal. */
  setup_sig_button: {
    setup: `/* static DOM check — no model mutation */`,
  },
  /* The expression layer's moment→tick mapping is
     per-measure. A tempo placed at measure 3 (after a 4/4→3/4 change) must
     anchor at the true cumulative tick (112), not measureIdx×head (128), so a
     note after it is retimed correctly. M0 whole (4/4), M1 dotted-half (3/4),
     M2 three quarters (3/4); tempo 240 at M2 start. */
  tempo_after_meter: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [A], duration: '1', dots: 0 }); /* M0 whole = 4/4 */
      m.appendMeasure();
      m.appendMeasure();
      m.setMeterAt(1, 3, 4); /* 3/4 from M1 */
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.insertChordAtCursor({ notes: [A], duration: '2', dots: 1 }); /* M1 dotted half = 3/4 */
      m.setCursor(m.getMeasureStartCursor(1, 2), 1);
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 }); /* M2 = 3 quarters */
      m.setCursor(m.getMeasureStartCursor(1, 2), 1); /* anchor tempo at M2 start */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="kind"]').value = 'instant';
      dlg.querySelector('[data-field="bpm"]').value = '240';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
    `,
  },
  /* Per-measure beaming. A mid-piece 6/8 measure
     beams its 6 eighths as 3+3 (dotted-quarter beats), not 2+2+2 (the head
     4/4 grouping). M0 4/4 content, M1 = 6/8 with six eighths. */
  beaming_compound: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 }); /* M0 4/4 */
      m.appendMeasure();
      m.setMeterAt(1, 6, 8); /* 6/8 from M1 */
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      for (let i = 0; i < 6; i++) m.insertChordAtCursor({ notes: [A], duration: '8', dots: 0 }); /* M1 six eighths */
      r();
    `,
  },
  /* MusicXML export is per-measure (best-effort).
     A 4/4→3/4 + key-change doc must export a SECOND <time> and <key> without
     throwing. */
  export_midpiece: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      m.appendMeasure();
      m.setMeterAt(1, 3, 4);
      m.setKeySigAt(1, '3f', 'major');
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      r();
    `,
  },
  /* ── Cut/common-time symbol + additive beat groups ───────────── */

  /* Cut time: the signature modal's Symbol=Cut forces 2/2 and stamps
     meter.sym="cut" on the head scoreDef (Verovio renders ¢). */
  cut_time: {
    setup: `
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      const symSel = dlg.querySelector('[data-field="symbol"]');
      symSel.value = 'cut';
      symSel.dispatchEvent(new Event('change', { bubbles: true }));
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
    visualBaseline: 'cut_time',
  },
  /* Additive 2+2+3 grouping in 7/8: seven eighths beam as 2+2+3 (three beams),
     not a uniform per-eighth grouping; meter.count stays 7 (plain numeral). */
  additive_beaming: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setTimeSig(7, 8, { beatGroups: [2, 2, 3] });
      m.setCursor(0, 1);
      for (let i = 0; i < 7; i++) m.insertChordAtCursor({ notes: [A], duration: '8', dots: 0 });
      r();
    `,
    visualBaseline: 'additive_beaming',
  },
  /* ── Selection-driven signature / clef change ─────────────────── */

  /* Measure-mode selection over M2–M3 (idx 1–2) of a 4-measure doc + Ctrl+Shift+S
     to 3/4 applies the meter to the span with a bounded restore at M4 (idx 3). */
  sig_sel_span: {
    setup: `
      window.confirm = () => true;
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      for (let i = 0; i < 16; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 }); /* 4 measures × 4 quarters */
      m.setCursor(m.getMeasureStartCursor(1, 1), 1); /* M2 start (idx 1) */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));   /* enter measure sel @M2 */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })); /* extend → M3 */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="count"]').value = '3';
      dlg.querySelector('[data-field="unit"]').value = '4';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
  },
  /* ── Pickup / anacrusis ───────────────────────────────────────── */

  /* Ctrl+Shift+A → 4 EIGHTHS inserts a pickup measure 0 (reduced 32-tick
     budget, metcon="false") in 4/4; the following measure stays numbered 1.
     The field counts eighth notes since 2026-09-17 (it counted denominator
     beats before, where the same half-bar pickup was "2"). */
  pickup_add: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      m.setCursor(0, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="eighths"]').value = '4';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
    visualBaseline: 'pickup_add',
  },
  /* The granularity eighths bought (Max, 2026-09-17): a ONE-EIGHTH pickup in
     4/4 — half a beat, so unreachable while the field counted denominator
     beats, and the commonest real anacrusis there is. Driven through the
     dialog, so the field name, the bound and the model conversion are all in
     the path. Asserted via FIXTURE_ASSERTIONS.pickup_eighthGranularity. */
  pickup_eighthGranularity: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      m.setCursor(0, 1);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', ctrlKey: true, shiftKey: true, bubbles: true }));
      const dlg = document.getElementById('textEntryDialog');
      dlg.querySelector('[data-field="eighths"]').value = '1';
      dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
      r();
    `,
  },
  /* Setting the pickup back to 0 removes the pickup measure entirely. */
  pickup_remove: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      m.setPickupAt(0, 4);   /* add a pickup (4 eighths = half a 4/4 bar) */
      m.setPickupAt(0, 0);   /* …then remove it */
      r();
    `,
  },
  /* Adding a pickup displaces the downbeat tempo onto the pickup, and playback
     applies that tempo from the very start (no default-120 lead-in). */
  pickup_tempo: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setTimeSig(4, 4);
      m.setTempo(240, '4', 0, '');
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      m.setPickupAt(0, 4);
      m.setVoice(1); m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 }); /* a pickup note */
      r();
    `,
  },
  /* A mid-piece (non-downbeat) tempo must resolve to the correct absolute tick
     once a pickup's reduced budget is in play — buildPlayback's note clock
     (budget-aware) and the tempo timeline (absoluteTickForMoment) must agree. */
  pickup_midpiece_tempo_align: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setTimeSig(4, 4);
      m.setCursor(0, 1);
      for (let i = 0; i < 8; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 }); /* 2 measures */
      const doc = m.getDoc();
      const meas2 = doc.querySelectorAll('measure')[1]; /* measure 2 (idx 1) downbeat */
      const t = doc.createElementNS('http://www.music-encoding.org/ns/mei', 'tempo');
      t.setAttribute('tstamp', '1'); t.setAttribute('staff', '1');
      t.setAttribute('mm', '240'); t.setAttribute('mm.unit', '4'); t.setAttribute('midi.bpm', '240');
      meas2.insertBefore(t, meas2.firstChild);
      m.setPickupAt(0, 4); /* pickup pushes everything; tempo (mid-piece) stays at its measure */
      r();
    `,
  },

  /* ── A mid-piece meter: everything that aligns to beats uses the measure's own
     meter (2026-10-19). A 4/4 piece whose second bar is 6/8: beat-aligned rests
     there group in dotted quarters, not quarters, and a 4/4 bar does not paste
     into it. Each of these read the head <scoreDef> until 2026-10-19. ── */
  meter_fillIncomplete_usesMeasureMeter: {
    setup: `${METER_68_BAR2} m.insertChordAtCursor({ notes: [N], duration: '8', dots: 0 });
      m.fillIncompleteMeasures(); r();`,
  },
  meter_partialCut_usesMeasureMeter: {
    setup: `${METER_68_BAR2}
      for (let i = 0; i < 6; i++) m.insertChordAtCursor({ notes: [N], duration: '8', dots: 0 });
      m.clearBeatRange(1, 64 + 8, 64 + 40); r();`,
  },
  meter_pasteLeadingGap_usesMeasureMeter: {
    setup: `${METER_68_BAR2} m.insertChordAtCursor({ notes: [N], duration: '8', dots: 0 });
      const t = m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '4' });
      if (!t.ok) throw new Error('tuplet: ' + t.reason);
      const r8 = m.getDoc().createElementNS('http://www.music-encoding.org/ns/mei', 'rest');
      r8.setAttribute('dur', '8');
      const res = m.pasteBeatContent(1, 64 + 32, [r8], 8);
      if (!res.ok) throw new Error('paste: ' + res.reason);
      r();`,
  },
  meter_measurePaste_refusesOtherMeter: {
    setup: `${METER_68_BAR2} m.setCursor(1, 1); r();`,
    setupKeys: [{ key: 'ArrowDown', shift: true }, { key: 'c', ctrl: true }],
  },
  meter_ottavaSpan_usesMeasureMeter: {
    setup: `${METER_68_BAR2}
      for (let i = 0; i < 6; i++) m.insertChordAtCursor({ notes: [N], duration: '8', dots: 0 });
      m.setCursor(m.getVoiceLength(1), 1); r();`,
    setupKeys: [{ key: '8', ctrl: true }],
  },
};

export const ASSERTIONS = {
  /* Signature modal writes the (global) key + meter. */
  sig_modal: [
    { name: 'modal applied D major + 3/4 to the score head',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        if (m.getKeySig() !== '2s') return { ok: false, detail: 'keySig=' + m.getKeySig() + ' (expected 2s)' };
        if (m.getKeyMode() !== 'major') return { ok: false, detail: 'keyMode=' + m.getKeyMode() };
        const ts = m.getTimeSig();
        if (ts.count !== 3 || ts.unit !== 4) return { ok: false, detail: 'meter=' + ts.count + '/' + ts.unit + ' (expected 3/4)' };
        /* The dialog must be closed (submit path ran). */
        const dlg = document.getElementById('textEntryDialog');
        if (dlg && dlg.open) return { ok: false, detail: 'dialog still open' };
        return { ok: true };
      })()` },
  ],
  keysig_midpiece: [
    { name: 'key change at m2 only: m1 keeps head C, m2 onward = E♭, head scoreDef untouched',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        if (m.keySigAt(0) !== '0') return { ok: false, detail: 'keySigAt(0)=' + m.keySigAt(0) + ' (expected 0 / C major)' };
        if (m.keySigAt(1) !== '3f') return { ok: false, detail: 'keySigAt(1)=' + m.keySigAt(1) + ' (expected 3f)' };
        if (m.getKeySig() !== '0') return { ok: false, detail: 'head getKeySig()=' + m.getKeySig() + ' (must stay 0)' };
        /* Exactly one in-section <scoreDef> override, carrying key.sig=3f. */
        const doc = m.getDoc();
        const overrides = [...doc.querySelectorAll('section > scoreDef')];
        if (overrides.length !== 1) return { ok: false, detail: 'in-section scoreDefs=' + overrides.length + ' (expected 1)' };
        if (overrides[0].getAttribute('key.sig') !== '3f') return { ok: false, detail: 'override key.sig=' + overrides[0].getAttribute('key.sig') };
        return { ok: true };
      })()` },
  ],
  sig_unchanged_no_override: [
    { name: 'unchanged submit at m2 writes no in-section scoreDef',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const overrides = [...m.getDoc().querySelectorAll('section > scoreDef')];
        if (overrides.length !== 0) return { ok: false, detail: 'in-section scoreDefs=' + overrides.length + ' (expected 0)' };
        /* And the modal closed cleanly. */
        const dlg = document.getElementById('textEntryDialog');
        if (dlg && dlg.open) return { ok: false, detail: 'dialog still open' };
        return { ok: true };
      })()` },
  ],
  setup_sig_button: [
    { name: 'Setup has #setupSigBtn and no inline key/time selects',
      expr: `(() => {
        if (!document.getElementById('setupSigBtn')) return { ok: false, detail: 'missing #setupSigBtn' };
        for (const id of ['setupKey', 'setupKeyMinor', 'setupTimeNum', 'setupTimeDen']) {
          if (document.getElementById(id)) return { ok: false, detail: id + ' still present in Setup' };
        }
        return { ok: true };
      })()` },
    /* The reference note is derived from the key signature, so Setup must no
       longer offer it as a user-selectable (q, r) pair. */
    { name: 'Setup has no reference-note fields',
      expr: `(() => {
        for (const id of ['setupRefQ', 'setupRefR', 'setupRefLabel']) {
          if (document.getElementById(id)) return { ok: false, detail: id + ' still present in Setup' };
        }
        return { ok: true };
      })()` },
  ],
  tempo_after_meter: [
    { name: 'tempo at m3 (post meter-change) retimes the following note correctly',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const evs = window.__hkl_composer.buildPlayback(m).filter(e => e.notes.length > 0);
        /* Onsets: M0 whole @0, M1 dotted-half @2000, then M2 q1/q2/q3.
           Tempo 240 starts at tick 112 (M2 start). q1@112 = 3500 (tempo affects
           AFTER its tick); q2@128 = 3500 + 16*15.625 = 3750. The bug would put
           the tempo at 128, leaving q2 @ 4000. */
        const at = (ms) => evs.find(e => Math.abs(e.atMs - ms) < 1) ;
        if (!at(0)) return { ok: false, detail: 'no note @0; atMs=' + evs.map(e => Math.round(e.atMs)).join(',') };
        if (!at(2000)) return { ok: false, detail: 'M1 not @2000; atMs=' + evs.map(e => Math.round(e.atMs)).join(',') };
        if (!at(3500)) return { ok: false, detail: 'M2 q1 not @3500; atMs=' + evs.map(e => Math.round(e.atMs)).join(',') };
        if (!at(3750)) return { ok: false, detail: 'M2 q2 not @3750 (tempo mis-anchored); atMs=' + evs.map(e => Math.round(e.atMs)).join(',') };
        return { ok: true };
      })()` },
  ],
  beaming_compound: [
    { name: '6/8 measure beams its six eighths as 3+3, not 2+2+2',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const xml = m.serialize();
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const measures = [...doc.querySelectorAll('measure')];
        const m1 = measures[1];
        /* Voice-1 layer (staff 1, layer 1). */
        const staff = [...m1.querySelectorAll('staff')].find(s => s.getAttribute('n') === '1');
        const layer = [...staff.querySelectorAll('layer')].find(l => l.getAttribute('n') === '1');
        const beams = [...layer.querySelectorAll('beam')];
        if (beams.length !== 2) return { ok: false, detail: 'beams=' + beams.length + ' (expected 2 for 3+3)' };
        const sizes = beams.map(b => [...b.children].filter(c => c.localName === 'note' || c.localName === 'chord').length);
        if (sizes.some(s => s !== 3)) return { ok: false, detail: 'beam sizes=' + sizes.join(',') + ' (expected 3,3)' };
        return { ok: true };
      })()` },
  ],
  export_midpiece: [
    { name: 'MusicXML export emits a 2nd <time> + <key> for the mid-piece change',
      expr: `(() => {
        const h = window.__hkl_composer;
        let xml;
        try { xml = h.exportMusicXml(h.model); }
        catch (e) { return { ok: false, detail: 'export threw: ' + (e && e.message) }; }
        const times = (xml.match(/<time>/g) || []).length;
        const keys = (xml.match(/<key>/g) || []).length;
        if (times < 2) return { ok: false, detail: '<time> count=' + times + ' (expected ≥2)' };
        if (keys < 2) return { ok: false, detail: '<key> count=' + keys + ' (expected ≥2)' };
        if (!xml.includes('<beats>3</beats>')) return { ok: false, detail: 'no 3/4 time in export' };
        if (!xml.includes('<fifths>-3</fifths>')) return { ok: false, detail: 'no E♭ (−3) key in export' };
        return { ok: true };
      })()` },
  ],
  /* Cut time → meter.sym + forced 2/2. */
  cut_time: [
    { name: 'Symbol=Cut forces 2/2 and stamps meter.sym="cut" on the head scoreDef',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const info = m.meterAt(0);
        if (info.sym !== 'cut') return { ok: false, detail: 'meterAt(0).sym=' + info.sym + ' (expected cut)' };
        if (info.count !== 2 || info.unit !== 2) return { ok: false, detail: 'meter=' + info.count + '/' + info.unit + ' (expected 2/2)' };
        const sd = m.getDoc().querySelector('scoreDef');
        if (sd.getAttribute('meter.sym') !== 'cut') return { ok: false, detail: 'head meter.sym=' + sd.getAttribute('meter.sym') };
        return { ok: true };
      })()` },
  ],
  /* Additive 2+2+3 grouping in 7/8 beams as three beams of 2,2,3. */
  additive_beaming: [
    { name: '7/8 “2+2+3” beams seven eighths as 2,2,3 (count stays 7)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const info = m.meterAt(0);
        if (info.count !== 7 || info.unit !== 8) return { ok: false, detail: 'meter=' + info.count + '/' + info.unit };
        if (!info.beatGroups || info.beatGroups.join('+') !== '2+2+3') return { ok: false, detail: 'beatGroups=' + JSON.stringify(info.beatGroups) };
        const doc = new DOMParser().parseFromString(m.serialize(), 'application/xml');
        const layer = [...doc.querySelectorAll('measure')][0]
          .querySelector('staff[n="1"] layer[n="1"]');
        const sizes = [...layer.querySelectorAll('beam')].map(b =>
          [...b.children].filter(c => c.localName === 'note' || c.localName === 'chord').length);
        if (sizes.join(',') !== '2,2,3') return { ok: false, detail: 'beam sizes=' + sizes.join(',') + ' (expected 2,2,3)' };
        return { ok: true };
      })()` },
  ],
  /* Selection sig over M2–M3 with bounded restore at M4. */
  sig_sel_span: [
    { name: 'meter 3/4 over idx 1–2 only; idx 0 + idx 3 stay 4/4 (bounded restore)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        if (ms.length < 4) return { ok: false, detail: 'measures=' + ms.length + ' (expected 4)' };
        const at = (i) => m.meterAt(i);
        if (at(0).count !== 4) return { ok: false, detail: 'M1=' + at(0).count + '/' + at(0).unit + ' (expected 4/4)' };
        if (at(1).count !== 3 || at(1).unit !== 4) return { ok: false, detail: 'M2=' + at(1).count + '/' + at(1).unit + ' (expected 3/4)' };
        if (at(2).count !== 3 || at(2).unit !== 4) return { ok: false, detail: 'M3=' + at(2).count + '/' + at(2).unit + ' (expected 3/4)' };
        if (at(3).count !== 4 || at(3).unit !== 4) return { ok: false, detail: 'M4=' + at(3).count + '/' + at(3).unit + ' (expected 4/4 restored)' };
        return { ok: true };
      })()` },
  ],
  /* Pickup add — measure 0, reduced budget, metcon, numbering. */
  pickup_add: [
    { name: 'pickup measure 0 (32-tick budget, metcon=false); next measure stays n=1',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        if (ms.length !== 2) return { ok: false, detail: 'measures=' + ms.length + ' (expected 2: pickup + body)' };
        const pk = ms[0];
        if (pk.getAttribute('n') !== '0') return { ok: false, detail: 'pickup @n=' + pk.getAttribute('n') + ' (expected 0)' };
        if (pk.getAttribute('metcon') !== 'false') return { ok: false, detail: 'pickup metcon=' + pk.getAttribute('metcon') };
        if (pk.getAttributeNS('https://hexkeylab.com/ns/mei', 'pickup-ticks') !== '32')
          return { ok: false, detail: 'pickup-ticks=' + pk.getAttributeNS('https://hexkeylab.com/ns/mei', 'pickup-ticks') + ' (expected 32)' };
        if (ms[1].getAttribute('n') !== '1') return { ok: false, detail: 'body @n=' + ms[1].getAttribute('n') + ' (expected 1)' };
        if (m.measureTicksAt(0) !== 32) return { ok: false, detail: 'measureTicksAt(0)=' + m.measureTicksAt(0) + ' (expected 32)' };
        if (m.pickupEighthsForSection(0) !== 4) return { ok: false, detail: 'pickupEighths=' + m.pickupEighthsForSection(0) + ' (expected 4)' };
        if (m.maxPickupEighthsAt(0) !== 7) return { ok: false, detail: 'maxPickupEighths=' + m.maxPickupEighthsAt(0) + ' (expected 7 in 4/4)' };
        return { ok: true };
      })()` },
  ],
  /* A half-beat (one-eighth) pickup in 4/4 — the case the beats field
     could not express at all. */
  pickup_eighthGranularity: [
    { name: 'a 1-eighth pickup in 4/4 is an 8-tick measure 0, and reads back as 1 eighth',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        if (ms.length !== 2) return { ok: false, detail: 'measures=' + ms.length + ' (expected 2: pickup + body)' };
        const pk = ms[0];
        if (pk.getAttribute('n') !== '0') return { ok: false, detail: 'pickup @n=' + pk.getAttribute('n') };
        const ticks = pk.getAttributeNS('https://hexkeylab.com/ns/mei', 'pickup-ticks');
        if (ticks !== '8') return { ok: false, detail: 'pickup-ticks=' + ticks + ' (expected 8 = one eighth)' };
        if (m.measureTicksAt(0) !== 8) return { ok: false, detail: 'measureTicksAt(0)=' + m.measureTicksAt(0) + ' (expected 8)' };
        if (m.pickupEighthsForSection(0) !== 1) return { ok: false, detail: 'pickupEighths=' + m.pickupEighthsForSection(0) + ' (expected 1)' };
        /* The body bar is untouched and still full. */
        if (m.measureTicksAt(1) !== 64) return { ok: false, detail: 'body measureTicksAt(1)=' + m.measureTicksAt(1) + ' (expected 64)' };
        return { ok: true };
      })()` },
  ],
  /* Pickup remove — back to a single full measure. */
  pickup_remove: [
    { name: 'removing the pickup leaves one full 64-tick measure, no pickup attrs',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        if (ms.length !== 1) return { ok: false, detail: 'measures=' + ms.length + ' (expected 1)' };
        if (ms[0].getAttributeNS('https://hexkeylab.com/ns/mei', 'pickup-ticks'))
          return { ok: false, detail: 'pickup-ticks still set' };
        if (m.pickupEighthsForSection(0) !== 0) return { ok: false, detail: 'pickupEighths=' + m.pickupEighthsForSection(0) + ' (expected 0)' };
        if (m.measureTicksAt(0) !== 64) return { ok: false, detail: 'measureTicksAt(0)=' + m.measureTicksAt(0) + ' (expected 64)' };
        return { ok: true };
      })()` },
  ],
  /* Pickup displaces the downbeat tempo + playback applies it from t0. */
  pickup_tempo: [
    { name: 'downbeat tempo moved onto the pickup (measure 0, tstamp 1)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        const tempoIdx = ms.findIndex(mm => mm.querySelector('tempo'));
        if (tempoIdx !== 0) return { ok: false, detail: 'tempo in measure idx ' + tempoIdx + ' (expected 0/pickup)' };
        const t = ms[0].querySelector('tempo');
        if (t.getAttribute('tstamp') !== '1') return { ok: false, detail: 'tempo tstamp=' + t.getAttribute('tstamp') };
        return { ok: true };
      })()` },
    { name: 'playback runs at 240bpm from the very start (quarter = 250ms, no 120 lead-in)',
      expr: `(() => {
        const C = window.__hkl_composer;
        const evs = C.buildPlayback(C.model).filter(e => e.notes.length > 0).sort((a, b) => a.atMs - b.atMs);
        if (evs.length === 0) return { ok: false, detail: 'no note events' };
        if (Math.round(evs[0].atMs) !== 0) return { ok: false, detail: 'first onset atMs=' + Math.round(evs[0].atMs) };
        const bad = evs.find(e => Math.abs(e.durationMs - 250) > 1);
        if (bad) return { ok: false, detail: 'a quarter is ' + Math.round(bad.durationMs) + 'ms (expected 250 @240bpm)' };
        return { ok: true };
      })()` },
  ],
  /* A mid-piece tempo resolves to the correct tick despite the pickup. */
  pickup_midpiece_tempo_align: [
    { name: 'tempo change lands exactly at its measure: 4 quarters @120 then 4 @240',
      expr: `(() => {
        const C = window.__hkl_composer;
        const evs = C.buildPlayback(C.model).filter(e => e.notes.length > 0).sort((a, b) => a.atMs - b.atMs);
        const durs = evs.map(e => Math.round(e.durationMs));
        /* Pickup is empty; 8 note events = measure idx1 (120bpm) then idx2 (240bpm). */
        if (durs.length !== 8) return { ok: false, detail: 'note events=' + durs.length + ' (expected 8)' };
        const want = [500, 500, 500, 500, 250, 250, 250, 250];
        for (let i = 0; i < 8; i++) if (Math.abs(durs[i] - want[i]) > 1)
          return { ok: false, detail: 'durs=' + durs.join(',') + ' (expected ' + want.join(',') + ')' };
        return { ok: true };
      })()` },
  ],
  /* Prerequisite: per-measure meter table. */
  mixed_meter_prereq: [
    { name: 'tick table: M1=64 (4/4), M2=48 (3/4), cumulative starts 0/64/112',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t0 = m.measureTicksAt(0), t1 = m.measureTicksAt(1);
        const s1 = m.measureStartTick(1), s2 = m.measureStartTick(2);
        if (t0 !== 64) return { ok: false, detail: 'measureTicksAt(0)=' + t0 + ' (expected 64)' };
        if (t1 !== 48) return { ok: false, detail: 'measureTicksAt(1)=' + t1 + ' (expected 48)' };
        if (s1 !== 64) return { ok: false, detail: 'measureStartTick(1)=' + s1 + ' (expected 64)' };
        if (s2 !== 112) return { ok: false, detail: 'measureStartTick(2)=' + s2 + ' (expected 112)' };
        /* Lynchpin: past-end cursor sits at the score's total ticks = 112,
           NOT the old uniform 2 * 64 = 128. */
        const end = m.getTickPositionAt(1, m.flatChildren(1).length);
        if (end !== 112) return { ok: false, detail: 'getTickPositionAt(end)=' + end + ' (expected 112)' };
        return { ok: true };
      })()` },
    { name: 'playback: M1 note at 0ms, M2 note at 2000ms (after 64 ticks @120bpm)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const evs = window.__hkl_composer.buildPlayback(m).filter(e => e.notes.length > 0);
        if (evs.length !== 2) return { ok: false, detail: 'note events=' + evs.length + ' atMs=' + evs.map(e => e.atMs).join(',') };
        if (Math.abs(evs[0].atMs - 0) > 1e-6) return { ok: false, detail: 'event[0] atMs=' + evs[0].atMs + ' (expected 0)' };
        if (Math.abs(evs[1].atMs - 2000) > 1e-6) return { ok: false, detail: 'event[1] atMs=' + evs[1].atMs + ' (expected 2000)' };
        return { ok: true };
      })()` },
  ],
  /* Time-sig change behavior. */
  timeSig4to3Truncate: [
    { name: 'measureTicks reduced to 48 (3/4 = 3 quarters × 16 ticks)',
      expr: `(() => {
        const t = window.__hkl_composer.model.measureTicks();
        return t === 48 ? { ok: true } : { ok: false, detail: 'measureTicks=' + t };
      })()` },
    { name: 'last beat truncated (3 rests remain, not 4)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const m1 = m.allMeasures()[0];
        const rests = m1.querySelectorAll('staff[n="1"] layer[n="1"] > rest');
        return rests.length === 3
          ? { ok: true }
          : { ok: false, detail: 'M_1 V_1 has ' + rests.length + ' rests (expected 3)' };
      })()` },
  ],
  keySig3Sharps: [
    { name: 'key signature is 3s',
      expr: `(() => {
        const s = window.__hkl_composer.model.getKeySig();
        return s === '3s' ? { ok: true } : { ok: false, detail: 'keySig=' + s };
      })()` },
  ],
  keyModeMinor_0_BroadcastsA: [
    { name: 'getKeyMode returns minor',
      expr: `(() => {
        const k = window.__hkl_composer.model.getKeyMode();
        return k === 'minor' ? { ok: true } : { ok: false, detail: 'mode=' + k };
      })()` },
    { name: 'score-ref is the A-minor tonic A3 = (0, 0)',
      expr: `(() => {
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref captured' };
        const last = sr[sr.length - 1];
        return last.q === 0 && last.r === 0
          ? { ok: true, detail: 'q=' + last.q + ' r=' + last.r }
          : { ok: false, detail: 'q=' + last.q + ' r=' + last.r + ' (expected 0, 0)' };
      })()` },
  ],
  keyModeMinor_7s_BroadcastsAsharp: [
    { name: 'score-ref is the a♯-minor tonic A♯3 = (-12, 7)',
      expr: `(() => {
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref captured' };
        const last = sr[sr.length - 1];
        return last.q === -12 && last.r === 7
          ? { ok: true, detail: 'q=' + last.q + ' r=' + last.r }
          : { ok: false, detail: 'q=' + last.q + ' r=' + last.r + ' (expected -12, 7)' };
      })()` },
  ],
  keyModeMajor_3s_BroadcastsA: [
    { name: 'score-ref is the A-major tonic A3 = (0, 0)',
      expr: `(() => {
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref captured' };
        const last = sr[sr.length - 1];
        return last.q === 0 && last.r === 0
          ? { ok: true, detail: 'q=' + last.q + ' r=' + last.r }
          : { ok: false, detail: 'q=' + last.q + ' r=' + last.r + ' (expected 0, 0)' };
      })()` },
  ],
  keyModeRoundtrip: [
    { name: 'getKeyMode survives serialize→replaceDocument',
      expr: `(() => {
        const k = window.__hkl_composer.model.getKeyMode();
        return k === 'minor' ? { ok: true } : { ok: false, detail: 'mode=' + k };
      })()` },
    { name: 'serialized MEI contains mode="minor" on scoreDef',
      expr: `(() => {
        const xml = window.__hkl_composer.model.serialize();
        const has = /<scoreDef[^>]*\\bmode="minor"/.test(xml);
        return has ? { ok: true } : { ok: false, detail: 'no mode=\"minor\" in <scoreDef>' };
      })()` },
  ],
  /* 4/4 beaming rules. The shared helper parses serialized MEI (which has
   * the regroupBeams pass applied), grabs measure 1's first layer, and
   * returns the size of each top-level <beam> child counting <note>+<chord>
   * descendants. Assert against the expected partition. */
  beam4_4_eightEighths: [
    { name: 'two cross-beat beams of 4',
      expr: `(() => {
        const xml = window.__hkl_composer.model.serialize();
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const layer = doc.querySelector('measure layer');
        if (!layer) return { ok: false, detail: 'no layer' };
        const sizes = [...layer.children].filter(c => c.localName === 'beam')
          .map(b => [...b.children].filter(c => c.localName === 'note' || c.localName === 'chord').length);
        const want = [4, 4];
        return JSON.stringify(sizes) === JSON.stringify(want)
          ? { ok: true }
          : { ok: false, detail: 'beam sizes=' + JSON.stringify(sizes) + ' want=' + JSON.stringify(want) };
      })()` },
  ],
  beam4_4_mixedSplitsPerBeat: [
    { name: 'four per-beat beams (2, 3, 2, 3)',
      expr: `(() => {
        const xml = window.__hkl_composer.model.serialize();
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const layer = doc.querySelector('measure layer');
        if (!layer) return { ok: false, detail: 'no layer' };
        const sizes = [...layer.children].filter(c => c.localName === 'beam')
          .map(b => [...b.children].filter(c => c.localName === 'note' || c.localName === 'chord').length);
        const want = [2, 3, 2, 3];
        return JSON.stringify(sizes) === JSON.stringify(want)
          ? { ok: true }
          : { ok: false, detail: 'beam sizes=' + JSON.stringify(sizes) + ' want=' + JSON.stringify(want) };
      })()` },
  ],
  beam4_4_mixedHalves: [
    { name: 'half 1 super-beam of 4; half 2 per-beat (2, 3)',
      expr: `(() => {
        const xml = window.__hkl_composer.model.serialize();
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const layer = doc.querySelector('measure layer');
        if (!layer) return { ok: false, detail: 'no layer' };
        const sizes = [...layer.children].filter(c => c.localName === 'beam')
          .map(b => [...b.children].filter(c => c.localName === 'note' || c.localName === 'chord').length);
        const want = [4, 2, 3];
        return JSON.stringify(sizes) === JSON.stringify(want)
          ? { ok: true }
          : { ok: false, detail: 'beam sizes=' + JSON.stringify(sizes) + ' want=' + JSON.stringify(want) };
      })()` },
  ],

  meter_fillIncomplete_usesMeasureMeter: [
    { name: 'the 6/8 bar fills as quarter + dotted quarter after an eighth', expr: meterBar2Expr('note:8,rest:4,rest:4.') },
  ],
  meter_partialCut_usesMeasureMeter: [
    { name: 'a cut of ticks 8–40 in a 6/8 bar refills as two quarters', expr: meterBar2Expr('note:8,rest:4,rest:4,note:8') },
  ],
  meter_pasteLeadingGap_usesMeasureMeter: [
    { name: 'the gap before the paste (ticks 8–32 of a 6/8 bar) fills as quarter + eighth', expr: meterBar2Expr('note:8,rest:4,rest:8,rest:8') },
  ],
  meter_measurePaste_refusesOtherMeter: [
    { name: 'a copied 4/4 bar is refused by the 6/8 bar and leaves it empty',
      expr: `(async () => {
        const m = window.__hkl_composer.model;
        const dt = new DataTransfer();
        document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
        const text = dt.getData('text/plain');
        if (!text.includes('kind="measure"')) return { ok: false, detail: 'copy produced: ' + text.slice(0, 120) };
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        m.setCursor(m.getMeasureStartCursor(1, 1), 1);
        const dt2 = new DataTransfer();
        dt2.setData('text/plain', text);
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt2, bubbles: true, cancelable: true }));
        await new Promise((res) => setTimeout(res, 50));
        const bar2 = m.allMeasures()[1].querySelectorAll('note, chord, rest').length;
        const status = document.getElementById('composerStatus').textContent || '';
        return bar2 === 0 && status.includes('Cannot paste')
          ? { ok: true }
          : { ok: false, detail: 'bar 2 holds ' + bar2 + ' elements; status "' + status + '"' };
      })()` },
  ],
  meter_ottavaSpan_usesMeasureMeter: [
    { name: "the ottava's tick span is the beat it was placed on", expr: `(() => {
        const m = window.__hkl_composer.model;
        const oct = m.getDoc().querySelector('octave');
        if (!oct) return { ok: false, detail: 'no <octave> written; status "' + (document.getElementById('composerStatus').textContent || '') + '"' };
        const t0 = parseFloat(oct.getAttribute('data-hkl-t0')), t1 = parseFloat(oct.getAttribute('data-hkl-t1'));
        return t0 === 96 && t1 === 112 ? { ok: true } : { ok: false, detail: 't0=' + t0 + ' t1=' + t1 + ' (want 96, 112: the last head-meter beat of the 6/8 bar)' };
      })()` },
  ],
};
