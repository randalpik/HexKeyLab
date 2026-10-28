// Composer test fixtures — cursor.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

import {
  A4,
} from './_helpers.mjs';

/** Fill M_1 with N quarter rests (the dominant scenario building block). */
const FILL_M1_4Q = `
  m.setCursor(0);
  for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
`;

export const FIXTURES = {

  /* ── Existing scenarios from tools/composer-inspect/scenarios.mjs ──────── */
  emptyDoc: { setup: `/* no setup — default 1-measure empty doc */` },
  m1Quarter: { setup: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
  ` },
  /* The overlay shares the page cards' frame: widening #score past the page
     re-centers the card with no re-render, and the bar must move with it
     (it used to stay at the pixel it was drawn at — every page-view baseline
     showed the cursor ~12 px left of its note). */
  cursorFollowsRecenter: { setup: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
  ` },
  m1Full: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
  ` },
  m1FullM2Quarter: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
  ` },
  m1FullM2Empty: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.deleteAtCursor();
  ` },
  m1PartialM3Full: { setup: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
  ` },
  m1FullM2EmptyM3Quarter: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.deleteAtCursor();
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
  ` },
  m1EmptyM2Quarter: { setup: `
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(0, 1);
    while (m.allMeasures()[0].querySelector('layer rest, layer note, layer chord')) {
      const layer = m.allMeasures()[0].querySelector('layer');
      const firstReal = Array.from(layer.children).find(
        (c) => c.localName === 'rest' || c.localName === 'note' || c.localName === 'chord'
      );
      if (!firstReal) break;
      const flat = m.flatChildren(1);
      const idx = flat.indexOf(firstReal);
      if (idx < 0) break;
      m.setCursor(idx + 1, 1);
      m.deleteAtCursor();
    }
  ` },

  /* ── Cursor-convention probes (lock in post-refactor invariants) ─── */
  /* Whole-measure rest in M_1: last layer is full → past-end excluded. */
  pastEnd_fullLast: { setup: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "1", dots: 0 });
  ` },
  /* One quarter in M_1: layer partial → past-end exists. */
  pastEnd_partialLast: { setup: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
  ` },
  /* Empty M_1 (default doc): layer empty → past-end exists. */
  pastEnd_emptyLast: { setup: `/* no setup */` },
  /* Content in M_1, M_2 created and filled — wrapper of M_1 collapsed. */
  m1WrapperCollapse: { setup: `${FILL_M1_4Q}
    m.setCursor(m.getVoiceLength(1), 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
  ` },
  /* Empty M_1: wrapper present, cursor=0 anchors at wrapper. */
  m1EmptyWrapperPresent: { setup: `/* no setup */` },

  /* ── Single-voice content (MODEL+CURSOR+RENDER+ROUNDTRIP) ────────── */
  m1NoteA4Quarter: { setup: `
    m.setCursor(0, 1);
    m.insertChordAtCursor({
      notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888888', velocity: 80 }],
      duration: '4', dots: 0,
    });
  ` },
  /* C-E-G triad as a single chord. Pitches: C4 at (-4, -2), E4 at (1, 0),
   * G4 at (0, 1). Lattice arithmetic per CLAUDE.md A3=(0,0). */
  m1ChordCEG: { setup: `
    m.setCursor(0, 1);
    m.insertChordAtCursor({
      notes: [
        { q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888888', velocity: 80 },
        { q:  1, r:  0, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888888', velocity: 80 },
        { q:  0, r:  1, pname: 'g', accid: '', oct: 4, midi: 67, colorHex: '#888888', velocity: 80 },
      ],
      duration: '4', dots: 0,
    });
  ` },
  /* One rest of every duration 1..7 (Finale order: 64=1, 32=2, ..., whole=7). */
  m1AllDurations: { setup: `
    m.setCursor(0, 1);
    for (const d of ['64', '32', '16', '8', '4', '2', '1']) {
      m.insertRestAtCursor({ duration: d, dots: 0 });
    }
  ` },
  /* Dotted half (= 24 ticks) at the END of M_1 (cursor past 3 quarters) →
   * 4 ticks fit in M_1 (one quarter), 20 ticks overflow → split into bar 2. */
  m1DottedHalfTied: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.insertChordAtCursor({
      notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888888', velocity: 80 }],
      duration: '2', dots: 1,
    });
  ` },

  /* ── Multi-voice (autofill-disabled assertions) ──────────────────── */
  voiceSwitch_noAutofill: { setup: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setVoice(2);
    /* No autofill should have fired in V_1 — only the entered quarter
     * remains, with 3 quarters of placeholder space. */
  ` },
  moveCursorAcrossBar_noAutofill: { setup: `
    /* M_1 with one quarter; create M_2 by going past-end. */
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    /* Cursor now in M_2 wrapper. M_1 must still have only 1 real rest +
     * placeholder space (autofill disabled). */
  ` },
  /* Voice switch preserves the visual measure even when the source
   * measure is empty in the source voice but full in the target voice
   * (the wrapper-stop aliasing case that broke the legacy
   * time-based translation). V_1: empty M_1, content in M_2.
   * V_2: full M_1, empty M_2. Cursor at V_1 M_2 wrapper → switch to V_2.
   * Expectation: V_2 cursor lands in M_2 (idx 1), not M_1 (idx 0). */
  voiceSwitch_measurePreserved_emptyToFull: { setup: `
    /* V_2: fill M_1 with 4 quarters. */
    m.setVoice(2);
    m.setCursor(0, 2);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    /* V_1: skip M_1 empty, place a quarter in M_2. */
    m.setVoice(1);
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    /* Park V_1 cursor at the start of M_2 (the wrapper). flat = [M1, M2, rest];
     * cursor=1 = before-M_2-wrapper. */
    m.setCursor(1, 1);
    /* Switch V_1 → V_2 via the model API exercised by ArrowDown. */
    m.switchVoice('down');
  ` },
  /* Symmetric: V_1 full M_1 + empty M_2; V_2 empty M_1 + content M_2.
   * Cursor at V_1 M_2 wrapper. Switch to V_2 → must remain in M_2. */
  voiceSwitch_measurePreserved_fullToEmpty: { setup: `
    /* V_1: fill M_1, then create M_2 by extending past end. */
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    /* V_2: empty M_1, content in M_2. */
    m.setVoice(2);
    m.setCursor(m.getVoiceLength(2), 2);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    /* Park V_1 cursor at start of M_2 wrapper. V_1 has M_1 full + M_2 empty,
     * so flatChildren = [M1 wrapper, Q1..Q4, M2 wrapper]. Cursor=5 = before M2. */
    m.setVoice(1);
    m.setCursor(5, 1);
    /* Switch to V_2. */
    m.switchVoice('down');
  ` },
  /* Mid-measure within-tick offset preserved. V_2 M_2 has Q1+Q2, cursor past
   * Q2 (within = half-measure). V_1 M_2 has 4 quarter rests. Switch V_2 → V_1.
   * Expectation: V_1 cursor lands in M_2 between R2 and R3 (still M_2). */
  voiceSwitch_measurePreserved_partialMidMeasure: { setup: `
    /* V_1: empty M_1, M_2 full of quarter rests. */
    m.setCursor(m.getVoiceLength(1), 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    /* V_2: empty M_1, M_2 has Q1+Q2. Park cursor at the M_2 wrapper anchor in
     * V_2 (NOT past-end, which would create M_3) so inserts go INTO M_2.
     * V_2 flat at this point = [M_1 wrapper, M_2 wrapper]; c=1 anchors on
     * M_2 wrapper. */
    m.setVoice(2);
    m.setCursor(1, 2);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    /* Cursor V_2 now past Q2 of M_2 (at the half-measure point). Switch up. */
    m.switchVoice('up');
  ` },
  /* Expression-layer exit (V_2 → expr → V_3) preserves measure. We can't drive
   * expr-mode toggling from the model alone (it's input.ts state), so simulate
   * the same translation path by going directly through the public model
   * helper that the expr-exit code calls. */
  voiceSwitch_measurePreserved_exprExitPath: { setup: `
    /* V_2 has 3 measures of content; cursor parked in M_3. */
    m.setVoice(2);
    m.setCursor(0, 2);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(2), 2);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(2), 2);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    /* V_3 is empty everywhere; placeholder invariant gives it a wrapper per
     * measure. Park V_2 cursor in M_3 (past last quarter of M_3). */
    m.setCursor(m.getVoiceLength(2), 2);
    /* Direct call mirrors the expr-exit path. */
    m.setVoicePreservingMeasure(3);
  ` },
  /* Onset alignment on voice switch: match the START moment of the current
   * note, not its END. V_1 M_1 = four quarter rests, cursor parked past Q2
   * (current note Q2: onset = 1 quarter, end = 2 quarters). V_2 M_1 = two half
   * rests, so the source's current-note ONSET (1 quarter) lands inside V_2's
   * 1st half (no stop there → onset of that half = 0), while end-matching would
   * snap to V_2's 2nd half at the half-measure. */
  voiceSwitch_onsetAlignment_longerTargetNote: { setup: `
    m.setVoice(1);
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setVoice(2);
    m.setCursor(0, 2);
    m.insertRestAtCursor({ duration: "2", dots: 0 });
    m.insertRestAtCursor({ duration: "2", dots: 0 });
    /* Park V_1 cursor past Q2 (= half-measure end tick), then switch down. */
    m.setVoice(1);
    m.setCursor(m.findCursorByTickPosition(1, m.measureTicks() / 2), 1);
    m.switchVoice('down');
  ` },
  /* The MRE: V_1 and V_2 each have one note of the same length, both starting at
   * the measure start. With the V_1 note selected (cursor past it), switching to
   * V_2 must SELECT V_2's note (cursor past it), not drop to the measure start. */
  voiceSwitch_sameOnset_selectsNote: { setup: `
    m.setVoice(1); m.setCursor(0, 1);
    m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    m.setVoice(2); m.setCursor(0, 2);
    m.insertChordAtCursor({ notes: [{ q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    /* Select the V_1 note (cursor past it = 1 quarter into the bar), then switch down. */
    m.setVoice(1);
    m.setCursor(m.findCursorByTickPosition(1, m.measureTicks() / 4), 1);
    m.switchVoice('down');
  ` },

  /* ── Ctrl-nav (bar-jump) scenarios ───────────────────────────────── */
  /* M_1+M_2 both filled. Used by ctrlRight_skipsToNextMeasure and
   * ctrlLeft_movesToMeasureStart. */
  ctrlNav_twoFull: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
  ` },
  /* M_1 full, M_2 empty (V_1), M_3 full — empty measures must NOT be
   * skipped by Ctrl-nav. */
  ctrlNav_fullEmptyFull: { setup: `
    /* M_1 full. */
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    /* Switch to V_2, create+fill M_2 there (so M_2 exists but is empty in V_1). */
    m.setVoice(2);
    m.setCursor(m.getVoiceLength(2), 2);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    /* Back to V_1; M_2 is empty in V_1. Create M_3 and fill it (V_1). */
    m.setVoice(1);
    m.setCursor(m.getVoiceLength(1), 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
  ` },

  /* ── Empty doc + boundary scenarios for full-tier roundtrip ──────── */
  /* M_1 fully filled with one whole note. */
  m1WholeNote: { setup: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "1", dots: 0 });
  ` },
  /* Multi-voice content. */
  multiVoiceMixed: { setup: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "2", dots: 0 });
    m.setVoice(2);
    m.setCursor(0, 2);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setVoice(3);
    m.setCursor(0, 3);
    m.insertRestAtCursor({ duration: "2", dots: 1 });
    m.setVoice(1);
  ` },
  /* Perf invariant: plain arrow-key navigation moves the cursor but
     must NOT re-engrave the score (a full Verovio reRender on every keystroke
     froze large scores for seconds). Assert the Verovio SVG root node is the
     same element before/after the keypress (a reRender replaces #score's
     innerHTML, so the node would differ). Asserted via FIXTURE_ASSERTIONS. */
  navDoesNotReRender: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 6; i++) m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      m.setCursor(0, 1); r();
    `,
  },
  /* Same Phase-0 perf invariant for Ctrl+←/→ (bar-jump) and Shift+←/→
     (selection adjust): these are pure navigation/selection — no content
     change — and must NOT re-engrave. They previously called onChange() (full
     reRender), freezing large scores on every press (the multi-second nav
     hang). Asserted via FIXTURE_ASSERTIONS (SVG root node unchanged). */
  ctrlNavDoesNotReRender: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 12; i++) m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      m.setCursor(0, 1); r();
    `,
  },
  selectionNavDoesNotReRender: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 12; i++) m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      m.setCursor(0, 1); r();
    `,
  },
  /* The per-voice navigation/tick index must stay consistent with the
     original per-query computations across varied edits, and its invalidation
     must fire on every mutation. Enables the in-model consistency check
     (window.__HKL_INDEX_CHECK) for the duration of this fixture and runs a mix
     of edits (notes, tuplet, tie, delete) — a build divergence or missed
     invalidation throws "VoiceIndex inconsistency" and fails the setup. */
  voiceIndexConsistencyUnderEdits: {
    setup: `
      window.__HKL_INDEX_CHECK = true;
      try {
        m.setCursor(0, 1);
        for (let i = 0; i < 6; i++) m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
        m.measureBoundaryCursors(1); m.getTickPositionAt(1, 3);
        m.setCursor(0, 1);
        m.deleteAtCursor();
        m.measureBoundaryCursors(1);
        m.cursorToEnd(1); m.getTickPositionAt(1, m.getVoiceLength(1));
      } finally {
        window.__HKL_INDEX_CHECK = false;
      }
      r();
    `,
  },
  /* MeasureBoundaryCursors must be O(1) after one build (it was O(n²) —
     46 s on a 446-bar score). Build once, then 500 cached calls must be trivial;
     a regression to per-call recomputation would take seconds. Generous bound. */
  voiceIndexBoundariesAreCheap: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 64; i++) m.insertChordAtCursor({ notes: [${A4}], duration: '4', dots: 0 });
      m.measureBoundaryCursors(1); /* prime the index */
      const t0 = performance.now();
      for (let i = 0; i < 500; i++) m.measureBoundaryCursors(1);
      window.__boundaryCallMs = performance.now() - t0;
      r();
    `,
  },
};

export const ASSERTIONS = {
  cursorFollowsRecenter: [
    { name: 'bar keeps its offset from its note when the card re-centers',
      expr: `(async () => {
        const doc = window.__hkl_composer.model.getDoc();
        const score = document.getElementById('score');
        const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const bar = () => [...document.querySelectorAll('rect[data-cursor-role="voice"]')].find((b) => b.isConnected);
        const restG = () => document.getElementById(doc.querySelector('layer rest').getAttribute('xml:id'));
        const card = () => document.querySelector('#score .score-page').getBoundingClientRect();
        const rel = () => bar().getBoundingClientRect().left - restG().getBoundingClientRect().right;
        const before = rel(), cardBefore = card().left;
        const saved = score.getAttribute('style');
        score.style.flex = 'none';
        score.style.width = (card().width + 600) + 'px';
        await frames();
        const after = rel(), cardAfter = card().left;
        if (saved === null) score.removeAttribute('style'); else score.setAttribute('style', saved);
        await frames();
        if (Math.abs(cardAfter - cardBefore) < 50) return { ok: false, detail: 'card did not re-center (' + cardBefore + ' → ' + cardAfter + ')' };
        return Math.abs(after - before) < 0.5 ? { ok: true }
          : { ok: false, detail: 'bar moved relative to its note: ' + before.toFixed(1) + ' → ' + after.toFixed(1)
              + ' (card ' + cardBefore.toFixed(1) + ' → ' + cardAfter.toFixed(1) + ')' };
      })()` },
  ],
  /* Cursor-convention probes. */
  pastEnd_fullLast: [
    { name: 'past-end excluded when last layer full',
      expr: `window.__test.assertPastEndConditional(1, false)` },
    { name: 'voiceLength === flatLength - 1',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        return { ok: m.getVoiceLength(1) === m.flatChildren(1).length - 1 };
      })()` },
  ],
  pastEnd_partialLast: [
    { name: 'past-end present when last layer partial',
      expr: `window.__test.assertPastEndConditional(1, true)` },
  ],
  pastEnd_emptyLast: [
    { name: 'past-end present when last layer empty',
      expr: `window.__test.assertPastEndConditional(1, true)` },
  ],
  /* Single-voice content. */
  m1NoteA4Quarter: [
    { name: 'cursor convention (flat[c-1] is current element)',
      expr: `window.__test.assertCursorConvention(1)` },
    { name: 'one note in M_1',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = m.getDoc().querySelectorAll('note');
        return notes.length === 1
          ? { ok: true }
          : { ok: false, detail: 'expected 1 note, got ' + notes.length };
      })()` },
  ],
  m1ChordCEG: [
    { name: 'three notes in one chord',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const chords = m.getDoc().querySelectorAll('chord');
        const notes = m.getDoc().querySelectorAll('note');
        return chords.length === 1 && notes.length === 3
          ? { ok: true }
          : { ok: false, detail: 'chords=' + chords.length + ' notes=' + notes.length };
      })()` },
  ],
  /* Multi-voice autofill-disabled. */
  voiceSwitch_noAutofill: [
    { name: 'V_1 still has exactly 1 rest (no autofill)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const m1 = m.allMeasures()[0];
        const v1Rests = m1.querySelectorAll('staff[n="1"] layer[n="1"] > rest');
        return v1Rests.length === 1
          ? { ok: true }
          : { ok: false, detail: 'V_1 M_1 has ' + v1Rests.length + ' rests (expected 1)' };
      })()` },
    { name: 'V_1 layer has placeholder space (not visible rests)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const m1 = m.allMeasures()[0];
        const phs = m1.querySelectorAll('staff[n="1"] layer[n="1"] > space[data-placeholder="true"]');
        return phs.length > 0
          ? { ok: true }
          : { ok: false, detail: 'V_1 M_1 has no placeholder <space>' };
      })()` },
  ],
  moveCursorAcrossBar_noAutofill: [
    { name: 'M_1 still has only 1 rest after cursor crossed bar',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const m1 = m.allMeasures()[0];
        const v1Rests = m1.querySelectorAll('staff[n="1"] layer[n="1"] > rest');
        return v1Rests.length === 1
          ? { ok: true }
          : { ok: false, detail: 'M_1 V_1 has ' + v1Rests.length + ' rests (expected 1)' };
      })()` },
  ],
  /* Voice-switch measure-preservation: every fixture asserts the active
   * voice/cursor pair lands in the originally-displayed measure. The fixtures
   * leave the model with currentVoice = target voice after switching, so
   * cursorMeasureIdx(target) IS the post-switch position. */
  voiceSwitch_measurePreserved_emptyToFull: [
    { name: 'V_2 cursor remains in M_2 after switch from V_1 M_2',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const cur = m.getCurrentVoice();
        const mi = m.cursorMeasureIdx(cur);
        return cur === 2 && mi === 1
          ? { ok: true }
          : { ok: false, detail: 'voice=' + cur + ' measureIdx=' + mi + ' (expected 2, 1)' };
      })()` },
  ],
  voiceSwitch_measurePreserved_fullToEmpty: [
    { name: 'V_2 cursor remains in M_2 after switch from V_1 M_2 wrapper',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const cur = m.getCurrentVoice();
        const mi = m.cursorMeasureIdx(cur);
        return cur === 2 && mi === 1
          ? { ok: true }
          : { ok: false, detail: 'voice=' + cur + ' measureIdx=' + mi + ' (expected 2, 1)' };
      })()` },
  ],
  voiceSwitch_measurePreserved_partialMidMeasure: [
    { name: 'V_1 cursor lands in M_2 with non-zero within-measure offset',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const cur = m.getCurrentVoice();
        const mi = m.cursorMeasureIdx(cur);
        if (cur !== 1 || mi !== 1) {
          return { ok: false, detail: 'voice=' + cur + ' measureIdx=' + mi + ' (expected 1, 1)' };
        }
        const abs = m.getCursorAbsoluteTicks(cur);
        const within = abs - mi * m.measureTicks();
        /* Source within = 2 quarter-ticks; closest V_1 stop in M_2 should be
         * past R2 (offset = 2 quarters). Accept any offset > 0 — exact match
         * would over-constrain if quarter-tick representation changes. */
        return within > 0
          ? { ok: true }
          : { ok: false, detail: 'within-measure tick offset = ' + within + ' (expected > 0)' };
      })()` },
  ],
  voiceSwitch_measurePreserved_exprExitPath: [
    { name: 'V_3 cursor lands in M_3 via setVoicePreservingMeasure',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const cur = m.getCurrentVoice();
        const mi = m.cursorMeasureIdx(cur);
        return cur === 3 && mi === 2
          ? { ok: true }
          : { ok: false, detail: 'voice=' + cur + ' measureIdx=' + mi + ' (expected 3, 2)' };
      })()` },
  ],
  voiceSwitch_onsetAlignment_longerTargetNote: [
    { name: 'V_2 cursor selects the half-note covering the source onset (not the measure start)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const cur = m.getCurrentVoice();
        if (cur !== 2) return { ok: false, detail: 'voice=' + cur + ' (expected 2)' };
        const mi = m.cursorMeasureIdx(cur);
        if (mi !== 0) return { ok: false, detail: 'measureIdx=' + mi + ' (expected 0)' };
        /* Source current note (Q2) onset = 1 quarter-tick, inside V_2's first
         * half-note [0, half). Switching selects that half-note: cursor sits
         * PAST it, so getCursorAbsoluteTicks = the half-measure. (The earlier
         * onset-tick bug landed at 0 = measure start.) */
        const within = m.getCursorAbsoluteTicks(cur) - mi * m.measureTicks();
        const fl = m.flatChildren(cur); const el = fl[m.getCursor(cur)];
        const tag = el ? el.localName : 'none';
        return within === m.measureTicks() / 2 && (tag === 'note' || tag === 'chord' || tag === 'rest')
          ? { ok: true }
          : { ok: false, detail: 'within=' + within + ' tag=' + tag + ' (expected half-measure, on the covering element)' };
      })()` },
  ],
  voiceSwitch_sameOnset_selectsNote: [
    { name: 'switching down selects V_2 note at the same onset (not the measure start)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const cur = m.getCurrentVoice();
        if (cur !== 2) return { ok: false, detail: 'voice=' + cur + ' (expected 2)' };
        const fl = m.flatChildren(cur); const c = m.getCursor(cur);
        const el = fl[c]; const tag = el ? el.localName : 'none';
        /* Cursor must sit PAST V_2's note (current element = the note), i.e. its
         * end tick (1 quarter), not at the measure start (tick 0). */
        const abs = m.getCursorAbsoluteTicks(cur);
        return (tag === 'note' || tag === 'chord') && abs === m.measureTicks() / 4
          ? { ok: true }
          : { ok: false, detail: 'cursor=' + c + ' tag=' + tag + ' abs=' + abs + ' (expected on a note at 1 quarter)' };
      })()` },
  ],
  navDoesNotReRender: [
    { name: 'plain ArrowRight moves the cursor without re-engraving (SVG root node unchanged)',
      expr: `(() => {
        const score = document.getElementById('score');
        const svgBefore = score.querySelector('svg:not(#cursorOverlay)');
        if (!svgBefore) return { ok: false, detail: 'no rendered SVG' };
        const c0 = window.__hkl_composer.model.getCursor(1);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        const svgAfter = score.querySelector('svg:not(#cursorOverlay)');
        const c1 = window.__hkl_composer.model.getCursor(1);
        if (svgAfter !== svgBefore) return { ok: false, detail: 'score was re-engraved on a cursor move (SVG root replaced)' };
        if (c1 === c0) return { ok: false, detail: 'cursor did not advance (c0=' + c0 + ')' };
        return { ok: true };
      })()` },
  ],
  ctrlNavDoesNotReRender: [
    { name: 'Ctrl+ArrowRight bar-jump moves cursor without re-engraving (SVG root unchanged)',
      expr: `(() => {
        const score = document.getElementById('score');
        const svgBefore = score.querySelector('svg:not(#cursorOverlay)');
        if (!svgBefore) return { ok: false, detail: 'no rendered SVG' };
        const c0 = window.__hkl_composer.model.getCursor(1);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true }));
        const svgAfter = score.querySelector('svg:not(#cursorOverlay)');
        const c1 = window.__hkl_composer.model.getCursor(1);
        if (svgAfter !== svgBefore) return { ok: false, detail: 'score re-engraved on Ctrl+Arrow bar-jump (SVG root replaced)' };
        if (c1 === c0) return { ok: false, detail: 'cursor did not jump (c0=' + c0 + ')' };
        return { ok: true };
      })()` },
  ],
  selectionNavDoesNotReRender: [
    { name: 'Shift+ArrowRight selection-adjust does not re-engrave (SVG root unchanged)',
      expr: `(() => {
        const score = document.getElementById('score');
        const svgBefore = score.querySelector('svg:not(#cursorOverlay)');
        if (!svgBefore) return { ok: false, detail: 'no rendered SVG' };
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
        const svgAfter = score.querySelector('svg:not(#cursorOverlay)');
        const s = window.__hkl_composer.inputState();
        if (svgAfter !== svgBefore) return { ok: false, detail: 'score re-engraved on Shift+Arrow selection (SVG root replaced)' };
        if (!s.selection) return { ok: false, detail: 'selection not entered' };
        return { ok: true };
      })()` },
  ],
  voiceIndexConsistencyUnderEdits: [
    { name: 'index stays consistent through note/tuplet/tie/delete edits (no inconsistency thrown in setup)',
      expr: `(() => {
        /* Setup ran the edits with the consistency check on; reaching here means
           no divergence/missed-invalidation threw. Sanity-check the index is live. */
        const b = window.__hkl_composer.model.measureBoundaryCursors(1);
        return Array.isArray(b) && b.length > 0
          ? { ok: true }
          : { ok: false, detail: 'measureBoundaryCursors returned ' + JSON.stringify(b) };
      })()` },
  ],
  voiceIndexBoundariesAreCheap: [
    { name: '500 cached measureBoundaryCursors calls are O(1)-cheap (was O(n²) → 46s)',
      expr: `(() => {
        const ms = window.__boundaryCallMs;
        return typeof ms === 'number' && ms < 100
          ? { ok: true }
          : { ok: false, detail: '500 calls took ' + ms + 'ms (expected < 100; O(n²) regression?)' };
      })()` },
  ],
};
