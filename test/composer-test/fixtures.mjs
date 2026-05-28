// Composer test fixtures. Each fixture is a named state of the Composer
// model, produced by running its `setup` snippet against the page (after
// composer.html has loaded and Verovio has rendered).
//
// Setup snippets have access to:
//   m = window.__hkl_composer.model
//   c = window.__hkl_composer.cursor
//   r = window.__hkl_composer.reRender
//   bridge = window.__hkl_composer.bridge
//
// Each fixture also declares its `tier` and the list of `invariants` that
// apply. The runner dispatches each (fixture × invariant) pair to its
// implementation.
//
// Invariant codes:
//   MODEL     — direct query against the model
//   CURSOR    — cursor-trace (consecutive position pixel-distance check)
//   RENDER    — DOM/SVG shape assertions
//   ROUNDTRIP — serialize → replaceDocument → serialize byte-equality
//   VISUAL    — pixelmatch against baseline PNG
//   CONSOLE   — always-on (captured globally; not per-fixture)
//
// Fixtures are organized into named groups to make the inventory readable
// at a glance.

/** A small helper: insert a rest of (duration, dots) at the current cursor. */
const REST = (d, dots = 0) => `m.insertRestAtCursor({ duration: "${d}", dots: ${dots} });`;
/** Move the cursor to a flat index in the current voice. */
const CUR = (c) => `m.setCursor(${c});`;
/** Fill M_1 with N quarter rests (the dominant scenario building block). */
const FILL_M1_4Q = `
  m.setCursor(0);
  for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
`;

/* ── Existing scenarios from tools/composer-inspect/scenarios.mjs ──────── */

const EXISTING = {
  emptyDoc: `/* no setup — default 1-measure empty doc */`,

  m1Quarter: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
  `,

  m1Full: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
  `,

  m1FullM2Quarter: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
  `,

  m1FullM2Empty: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.deleteAtCursor();
  `,

  m1PartialM3Full: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
  `,

  m1FullM2EmptyM3Quarter: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.deleteAtCursor();
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
  `,

  m1EmptyM2Quarter: `
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
  `,
};

/* ── New: cursor-convention probes (lock in post-refactor invariants) ─── */

const CURSOR_CONVENTION = {
  /* Whole-measure rest in M_1: last layer is full → past-end excluded. */
  pastEnd_fullLast: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "1", dots: 0 });
  `,

  /* One quarter in M_1: layer partial → past-end exists. */
  pastEnd_partialLast: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
  `,

  /* Empty M_1 (default doc): layer empty → past-end exists. */
  pastEnd_emptyLast: `/* no setup */`,

  /* Content in M_1, M_2 created and filled — wrapper of M_1 collapsed. */
  m1WrapperCollapse: `${FILL_M1_4Q}
    m.setCursor(m.getVoiceLength(1), 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
  `,

  /* Empty M_1: wrapper present, cursor=0 anchors at wrapper. */
  m1EmptyWrapperPresent: `/* no setup */`,
};

/* ── New: single-voice content (MODEL+CURSOR+RENDER+ROUNDTRIP) ────────── */

const SINGLE_VOICE = {
  m1NoteA4Quarter: `
    m.setCursor(0, 1);
    m.insertChordAtCursor({
      notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888888', velocity: 80 }],
      duration: '4', dots: 0,
    });
  `,

  /* C-E-G triad as a single chord. Pitches: C4 at (-4, -2), E4 at (1, 0),
   * G4 at (0, 1). Lattice arithmetic per CLAUDE.md A3=(0,0). */
  m1ChordCEG: `
    m.setCursor(0, 1);
    m.insertChordAtCursor({
      notes: [
        { q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888888', velocity: 80 },
        { q:  1, r:  0, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888888', velocity: 80 },
        { q:  0, r:  1, pname: 'g', accid: '', oct: 4, midi: 67, colorHex: '#888888', velocity: 80 },
      ],
      duration: '4', dots: 0,
    });
  `,

  /* One rest of every duration 1..7 (Finale order: 64=1, 32=2, ..., whole=7). */
  m1AllDurations: `
    m.setCursor(0, 1);
    for (const d of ['64', '32', '16', '8', '4', '2', '1']) {
      m.insertRestAtCursor({ duration: d, dots: 0 });
    }
  `,

  /* Dotted half (= 24 ticks) at the END of M_1 (cursor past 3 quarters) →
   * 4 ticks fit in M_1 (one quarter), 20 ticks overflow → split into bar 2. */
  m1DottedHalfTied: `
    m.setCursor(0, 1);
    for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.insertChordAtCursor({
      notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888888', velocity: 80 }],
      duration: '2', dots: 1,
    });
  `,
};

/* ── New: multi-voice (autofill-disabled assertions) ──────────────────── */

const MULTI_VOICE = {
  voiceSwitch_noAutofill: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setVoice(2);
    /* No autofill should have fired in V_1 — only the entered quarter
     * remains, with 3 quarters of placeholder space. */
  `,

  moveCursorAcrossBar_noAutofill: `
    /* M_1 with one quarter; create M_2 by going past-end. */
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    /* Cursor now in M_2 wrapper. M_1 must still have only 1 real rest +
     * placeholder space (autofill disabled). */
  `,

  /* Voice switch preserves the visual measure even when the source
   * measure is empty in the source voice but full in the target voice
   * (the wrapper-stop aliasing case that broke the legacy
   * time-based translation). V_1: empty M_1, content in M_2.
   * V_2: full M_1, empty M_2. Cursor at V_1 M_2 wrapper → switch to V_2.
   * Expectation: V_2 cursor lands in M_2 (idx 1), not M_1 (idx 0). */
  voiceSwitch_measurePreserved_emptyToFull: `
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
  `,

  /* Symmetric: V_1 full M_1 + empty M_2; V_2 empty M_1 + content M_2.
   * Cursor at V_1 M_2 wrapper. Switch to V_2 → must remain in M_2. */
  voiceSwitch_measurePreserved_fullToEmpty: `
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
  `,

  /* Mid-measure within-tick offset preserved. V_2 M_2 has Q1+Q2, cursor past
   * Q2 (within = half-measure). V_1 M_2 has 4 quarter rests. Switch V_2 → V_1.
   * Expectation: V_1 cursor lands in M_2 between R2 and R3 (still M_2). */
  voiceSwitch_measurePreserved_partialMidMeasure: `
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
  `,

  /* Expression-layer exit (V_2 → expr → V_3) preserves measure. We can't drive
   * expr-mode toggling from the model alone (it's input.ts state), so simulate
   * the same translation path by going directly through the public model
   * helper that the expr-exit code calls. */
  voiceSwitch_measurePreserved_exprExitPath: `
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
  `,
};

/* ── New: Ctrl-nav (bar-jump) scenarios ───────────────────────────────── */

const CTRL_NAV = {
  /* M_1+M_2 both filled. Used by ctrlRight_skipsToNextMeasure and
   * ctrlLeft_movesToMeasureStart. */
  ctrlNav_twoFull: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setCursor(m.getVoiceLength(1), 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
  `,

  /* M_1 full, M_2 empty (V_1), M_3 full — empty measures must NOT be
   * skipped by Ctrl-nav. */
  ctrlNav_fullEmptyFull: `
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
  `,
};

/* ── New: ties ────────────────────────────────────────────────────────── */

const A_NOTE = `{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }`;
const B_NOTE = `{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 }`;

const TIES = {
  /* Two same-pitch notes, then tie the first → real-tie pair created. */
  m1TieRealPair: `
    m.setCursor(0, 1);
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    /* flat = [wrapper, A1, A2]; cursor=3 (past A2). Set cursor=2 to put
     * A1 (=flat[2]) as the toggle target... wait, flat[1]=A1 with the
     * wrapper at flat[0]. Cursor=1 puts A1 as flat[cursor]. */
    m.setCursor(2, 1);  /* cursor past A2 → A2 is the toggle target;
                            tie A2 to NEXT (which is past-end / nothing) →
                            this would create a stub. Instead set cursor=1
                            so A1 is the target with A2 as the next. */
    m.setCursor(1, 1);
    /* Wait: cursor=1, flat[1]=A1, but is that the element to the cursor's
     * left? Under cursor convention, yes — flat[cursor]=A1.
     * Toggle: ref=A1, next=flat[2]=A2 → matching pitch → real-tie pair. */
    m.toggleTieOnCurrent('insert');
  `,

  /* Note, tie (creates stub), then different-pitch note → stub remains
   * unresolved (pitch doesn't match). */
  m1TiePendingStub: `
    m.setCursor(0, 1);
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.toggleTieOnCurrent('insert');  /* No next → pending stub on A. */
  `,

  /* Real pair, then delete the second → first should be demoted to
   * pending stub (per orphanTiePartners). */
  m1TieOrphanForward: `
    m.setCursor(0, 1);
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.setCursor(1, 1);
    m.toggleTieOnCurrent('insert');
    /* flat = [wrapper, A1, A2]. To delete A2 set cursor=2 (past A2 in
     * the new convention) — deleteAtCursor removes flat[cursor] = A2. */
    m.setCursor(2, 1);
    m.deleteAtCursor();
  `,

  /* Cross-bar split: half note inserted at end of M_1 with 16 ticks free
   * → splits into quarter (in M_1, @tie=i) + quarter (in M_2, @tie=t).
   * Verifies normalizeTies built the chain correctly under the
   * forward-only data-tie-partner convention. */
  m1TieCrossBarSplit: `
    m.setCursor(0, 1);
    for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
    /* 16 ticks remain. Insert half (32 ticks): 16 + 16 across bar. */
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '2', dots: 0 });
  `,

  /* Whole note inserted with only 4 ticks free in M_1 → 3-piece chain
   * (i in M_1 = 4 ticks 16th; m in M_2 = 32 + 16 + 8 ticks decomposed
   * via dotted notation; ...). Exercises the i→m→t multi-piece chain. */
  m1TieThreePieceChain: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: '16', dots: 0 });  /* 4 ticks */
    /* 60 ticks remain. Insert whole (64 ticks) → splits into 60 + 4 */
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '1', dots: 0 });
  `,

  /* Delete the INITIATOR (i-note) of a 2-piece cross-bar chain →
   * survivor (originally t) should demote cleanly: no @tie, no
   * data-tie-partner, no dangling refs, no Verovio console warning.
   * This was the asymmetry-bug repro before normalizeTies. */
  m1TieDeleteInitiatorFromSplit: `
    m.setCursor(0, 1);
    for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '2', dots: 0 });
    /* Delete the i-note. Find it via flat scan and set cursor past it. */
    const flat = m.flatChildren(1);
    const iIdx = flat.findIndex((e) => e.localName === 'note' && e.getAttribute('tie') === 'i');
    m.setCursor(iIdx + 1, 1);
    m.deleteAtCursor();
  `,

  /* Delete a MIDDLE piece of a 3-piece chain. Before normalizeTies this
   * left a dangling data-tie-partner and triggered Verovio's
   * "Expected @tie median or terminal" warning. After normalize the
   * chain compacts cleanly to length 2 (i + t). */
  m1TieDeleteMiddleFromSplit: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: '16', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '1', dots: 0 });
    /* Find the first @tie='m' note. */
    const flat = m.flatChildren(1);
    const mIdx = flat.findIndex((e) => e.localName === 'note' && e.getAttribute('tie') === 'm');
    if (mIdx < 0) throw new Error('no @tie=m note found in chain');
    m.setCursor(mIdx + 1, 1);
    m.deleteAtCursor();
  `,

  /* Extend a tie chain by toggling tie on a note that already has an
   * incoming tie (@tie="t"). When the next note matches in pitch, the
   * t note should promote to @tie="m" with a forward partner; the chain
   * becomes length 3 (i, m, t). Previously the toggle had no effect
   * because the alreadyTied check treated @tie="t" as untied AND because
   * normalizeTies dropped the wants-forward intent when wasFromPrev. */
  m1TieToggleOnTerminal: `
    /* A4 - A4 - A4 quarter rests. */
    m.setCursor(0, 1);
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    /* Tie A1→A2 first (cursor past A1 = flat index 1 since wrapper at 0). */
    m.setCursor(1, 1);
    m.toggleTieOnCurrent('insert');
    /* A2 now has @tie="t" (incoming). Toggle tie on A2 to extend chain. */
    m.setCursor(2, 1);
    m.toggleTieOnCurrent('insert');
  `,

  /* Toggle tie on a terminal note when NO next-pitch-match exists →
   * note should carry both incoming terminal (@tie="t") AND outgoing
   * pending stub (data-pending-tie + <lv>). Visually: incoming arc
   * plus hanging arc. The forward intent survives, ready to auto-
   * resolve when a same-pitch note is later inserted after it. */
  m1TieToggleOnTerminalNoPartner: `
    /* A4 - A4 - B4. */
    m.setCursor(0, 1);
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${B_NOTE}], duration: '4', dots: 0 });
    /* Tie A1→A2. */
    m.setCursor(1, 1);
    m.toggleTieOnCurrent('insert');
    /* Toggle on A2 — next is B4 (no pitch match) → pending stub kept. */
    m.setCursor(2, 1);
    m.toggleTieOnCurrent('insert');
  `,
};

/* ── New: tuplets ─────────────────────────────────────────────────────── */

const TUPLETS = {
  /* Triplet of 8ths at cursor 0 in 4/4 (8 ticks: 3 atomic 8th rests = 12
   * ticks → fits). */
  m1Triplet8Empty: `
    m.setCursor(0, 1);
    m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
  `,

  /* Triplet of 8ths with one note entered. */
  m1Triplet8Partial: `
    m.setCursor(0, 1);
    m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
    /* Cursor now inside tuplet at fill-anchor; enter one rest. */
    m.insertRestAtCursor({ duration: "8", dots: 0 });
  `,

  /* Triplet of 8ths fully filled (3 atomic rests). */
  m1Triplet8Full: `
    m.setCursor(0, 1);
    m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
    for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: "8", dots: 0 });
  `,

  /* Fill triplet then delete last → atomic regen produces an 8th placeholder. */
  m1Triplet8FilledThenDelete: `
    m.setCursor(0, 1);
    m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
    for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: "8", dots: 0 });
    m.deleteAtCursor();
  `,

  /* Attempt to create a tuplet while cursor is inside an existing tuplet
   * → must be rejected. */
  m1TripletInsideTriplet: `
    m.setCursor(0, 1);
    m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
    /* Cursor now inside the tuplet at fill-anchor. Attempt nesting. */
    window.__tupletNestResult = m.createTupletAtCursor({
      num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0,
    });
  `,

  /* Triplet of wholes (= 3 wholes scaled by 2/3 = 2 wholes span = 128
   * ticks) doesn't fit in 4/4 (16 ticks) → must be rejected. */
  m1TupletExceedsMeasure: `
    m.setCursor(0, 1);
    window.__tupletOverflowResult = m.createTupletAtCursor({
      num: 3, numbase: 2, atomicDur: '1', spanDur: '1', spanDots: 0,
    });
  `,
};

/* ── New: time-sig / key-sig changes ──────────────────────────────────── */

const SIG_CHANGES = {
  /* Fill 4/4 with 4 quarter notes, change to 3/4 → last beat dropped. */
  timeSig4to3Truncate: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setTimeSig(3, 4);
  `,

  /* Fill 4/4, change to 6/8 → meter wider; existing content fits. */
  timeSig4to6_8: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setTimeSig(6, 8);
  `,

  /* Switch to 3 sharps. */
  keySig3Sharps: `
    m.setKeySig('3s');
  `,

  /* Minor flag + 0 flats: tonic becomes A (r=0) instead of C (r=-3). The
   * broadcast is triggered by sendHklHello() which makes Composer
   * re-broadcast the current song-key tier. */
  keyModeMinor_0_BroadcastsA: `
    m.setKeySig('0');
    m.setKeyMode('minor');
    window.__hkl_composer.__testReset();
    window.__bridgeMock.reset();
    window.__bridgeMock.sendHklHello();
  `,

  /* Minor + 7 sharps: tonic is a♯ at r=7 (sharp-extreme, exercises the
   * extended TONIC_R range that pre-keyMode only needed to reach r=4). */
  keyModeMinor_7s_BroadcastsAsharp: `
    m.setKeySig('7s');
    m.setKeyMode('minor');
    window.__hkl_composer.__testReset();
    window.__bridgeMock.reset();
    window.__bridgeMock.sendHklHello();
  `,

  /* Major flag (default) + 3 sharps: tonic is A at r=0. Sanity-check that
   * the major path still resolves correctly with the new mode parameter. */
  keyModeMajor_3s_BroadcastsA: `
    m.setKeySig('3s');
    m.setKeyMode('major');
    window.__hkl_composer.__testReset();
    window.__bridgeMock.reset();
    window.__bridgeMock.sendHklHello();
  `,

  /* Round-trip: set minor, serialize, reload via replaceDocument, confirm
   * getKeyMode() still returns 'minor' (i.e. @mode survives MEI roundtrip). */
  keyModeRoundtrip: `
    m.setKeySig('1f');
    m.setKeyMode('minor');
    const xml = m.serialize();
    m.replaceDocument(xml);
  `,
};

/* ── 4/4 beaming rules (beat-group + cross-beat super-group) ──────────── */

const BEAMS = {
  /* 4/4 with 8 eighth notes: each half-measure (32 ticks) is exactly 4
   * eighths, so cross-beat super-beaming fires for both halves → two
   * beams of 4 in the layer. */
  beam4_4_eightEighths: `
    m.setCursor(0, 1);
    for (let i = 0; i < 8; i++) {
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
    }
  `,

  /* 4/4 with [E E 16 16 E] × 2 (32 ticks per half). Each half has 5
   * mixed-duration members, NOT four eighth notes, so the half falls
   * back to per-beat groups: beat 1 = [E E] (beam of 2), beat 2 =
   * [16 16 E] (beam of 3). Same shape repeats for beats 3-4. */
  beam4_4_mixedSplitsPerBeat: `
    m.setCursor(0, 1);
    for (let half = 0; half < 2; half++) {
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '16', dots: 0 });
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '16', dots: 0 });
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
    }
  `,

  /* 4/4 with first half = 4 eighths (super-beam) and second half =
   * [E E 16 16 E] (per-beat split). Confirms each half is evaluated
   * independently: one super-beam of 4, then two per-beat beams (2 + 3). */
  beam4_4_mixedHalves: `
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) {
      m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
    }
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '16', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '16', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '8', dots: 0 });
  `,
};

/* ── New: visual baselines (small, high-signal) ───────────────────────── */

const VISUAL = {
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
};

/* ── HEJI accidentals + arbitrary stacks (render-time injection) ───────── */

const HEJI = {
  /* Mode D, HEJI on: C#↓ at (1,0) → single combined glyph U+E2C3
     (sharp + one down arrow). */
  heji_sharp_arrow: {
    setup: `
      m.setLayoutReq({ tuningMode: 'D', refQ: 0, refR: 0 });
      m.setHejiEnabled(true);
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 1, r: 0, pname: 'c', accid: 's', oct: 4, midi: 61, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    visualBaseline: 'heji_sharp_arrow',
  },

  /* Mode 7, HEJI on: F natural at (2,0) carries a septimal comma but no
     conventional accidental → must still show the standalone hook U+E2DE
     (the natural-comma visibility case). */
  heji_septimal_hook: {
    setup: `
      m.setLayoutReq({ tuningMode: '7', refQ: 0, refR: 0 });
      m.setHejiEnabled(true);
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 2, r: 0, pname: 'f', accid: '', oct: 4, midi: 65, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    visualBaseline: 'heji_septimal_hook',
  },

  /* Mode 7, HEJI on: F# at (-10,7) → two glyphs, sharp (E262) + septimal
     hook (E2DE). Verifies ordering: sharp left, hook nearest the notehead. */
  heji_acc_plus_hook: {
    setup: `
      m.setLayoutReq({ tuningMode: '7', refQ: 0, refR: 0 });
      m.setHejiEnabled(true);
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: -10, r: 7, pname: 'f', accid: 's', oct: 4, midi: 66, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    visualBaseline: 'heji_acc_plus_hook',
  },

  /* HEJI OFF: the same C#↓ cell renders as a plain sharp (BravuraText, since
     all accidentals are Bravura) with NO comma arrow — guards that the comma
     decoration is gated on the HEJI flag. */
  heji_off_native: {
    setup: `
      m.setLayoutReq({ tuningMode: 'D', refQ: 0, refR: 0 });
      m.setHejiEnabled(false);
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 1, r: 0, pname: 'c', accid: 's', oct: 4, midi: 61, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
  },

  /* Carry-state: two A#3 in one measure — (-12,7) has no comma, (-5,3) is a
     syntonic comma lower. Same pname/oct/alter, different pitch → BOTH must
     show. The second's accidental must NOT be hidden as redundant. */
  heji_carry_diff_comma: {
    setup: `
      m.setLayoutReq({ tuningMode: 'D', refQ: 0, refR: 0 });
      m.setHejiEnabled(true);
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: -12, r: 7, pname: 'a', accid: 's', oct: 3, midi: 58, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(m.getVoiceLength(1), 1);
      m.insertChordAtCursor({ notes: [{ q: -5, r: 3, pname: 'a', accid: 's', oct: 3, midi: 58, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
  },
};

/* ── New: scroll-into-view ────────────────────────────────────────────── */

const SCROLL = {
  /* Idempotent: cursor in the visible first measure; trigger a re-render
   * via setCursor (no-op move) and assert scroll didn't change. */
  scrollIntoView_idempotent: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      /* Capture pre-state. */
      const score = document.getElementById('score');
      window.__preScroll = { l: score.scrollLeft, t: score.scrollTop };
      /* No-op state changes: setCursor to current pos, reRender. */
      m.setCursor(1, 1);
      r();
    `,
  },

  /* Build 16 measures via direct API (fast), then type ONE quarter at
   * past-end via a keystroke — main.ts's onChange hook fires and the
   * scroll-into-view machinery runs. We expect the cursor to be in the
   * viewport after the smooth scroll settles. */
  scrollIntoView_typingDeep: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 16; i++) {
        m.setCursor(m.getVoiceLength(1), 1);
        for (let j = 0; j < 4; j++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      }
      r();
      /* Park cursor at past-end so the next keystroke creates new measure
       * and triggers reflow + auto-scroll. */
      m.setCursor(m.getVoiceLength(1), 1);
    `,
    setupKeys: ['5'],
  },
};

/* ── New: bridge mock (HKL side simulation) ──────────────────────────── */

const BRIDGE = {
  /* HKL → Composer: held-keys broadcast. Composer's bridge.on handler
   * should store these in lastHeldKeys so subsequent keystrokes consume
   * them. We verify reception by checking getHeldKeys(). */
  bridgeHeldKeysReceived: {
    setup: `
      const notes = [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }];
      window.__bridgeMock.sendHeldKeys(notes);
    `,
  },

  /* Composer → HKL: capture a manually-emitted bridge event. (The
   * page's startup handshake fires before the test mock is attached,
   * so we explicitly emit from inside the page to verify the mock's
   * capture path works.) */
  bridgeComposerToHklCapture: {
    setup: `
      window.__bridgeMock.reset();
      window.__hkl_composer.bridge.send({ type: 'request-state' });
    `,
  },

  /* Bare Space → startPlayback → play-score event captured on bridge.
   * sendHklHello flips hklConnected=true so playback isn't gated by the
   * "Open HKL in another tab" check. Insert one note so buildPlayback has
   * an event to emit (empty score → no play-score sent). */
  space_starts_playback: {
    setup: `
      window.__bridgeMock.sendHklHello();
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }],
        duration: '4', dots: 0,
      });
      m.setCursor(0, 1);
      window.__bridgeMock.reset();
    `,
    setupKeys: [' '],
  },

  /* Space twice → first start, second stop. Both bridge events captured. */
  space_stops_playback: {
    setup: `
      window.__bridgeMock.sendHklHello();
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }],
        duration: '4', dots: 0,
      });
      m.setCursor(0, 1);
      window.__bridgeMock.reset();
    `,
    setupKeys: [' ', ' '],
  },
};

/* ── Export fixtures ──────────────────────────────────────────────────── */

const EXPORT = {
  /* Smoke-test: downloadPdf() should produce a Blob with the `%PDF-` magic
   * header. Captures the blob via the URL.createObjectURL hook that
   * downloadBlob() uses, stubbing the anchor click so no actual file
   * download fires. The export path lazy-imports jspdf + svg2pdf.js; a
   * regression in that chain (missing dep, API drift, Verovio SVG quirks)
   * surfaces here. */
  export_pdf_smoke: {
    setup: `
      /* Insert a colored quarter note so the PDF exercises both the export
       * pipeline AND the non-notehead color-coercion (stems/flags/accids
       * must render black even when the note has an inherited color). */
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        duration: '4', dots: 0,
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69,
                  colorHex: '#FF4C79', velocity: 80 }],
      });
    `,
  },
};

/* ── New: real-keystroke (INPUT-layer) fixtures ───────────────────────── */

const KBD = {
  /* Type '5' four times (= 4 quarter rests, fills 4/4). Verifies the
   * digit→duration mapping end-to-end without auto-overflow splitting.
   * '5' → dur='4' per DIGIT_TO_DUR (Finale order). */
  kbd_durationDigits: {
    setupKeys: ['5', '5', '5', '5'],
  },

  /* Type '5' (quarter rest, per DIGIT_TO_DUR), then '.' to add a dot. */
  kbd_dotCycle: {
    setupKeys: ['5', '.'],
  },

  /* Type Ctrl+Right, Ctrl+Left to exercise bar-jump nav. Need at least
   * two measures with content first. Lands AT the barline (= the cursor
   * with tstamp exactly equal to a multiple of measureTicks), matching
   * how Ctrl+Shift+Arrow extends selection. */
  kbd_ctrlNavBarJump: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(m.getVoiceLength(1), 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);  /* Park cursor in middle of M_1. */
    `,
    setupKeys: [{ key: 'ArrowRight', ctrl: true }],
  },

  /* Ctrl+Right from mid-M_1 lands AT the barline between M_1 and M_2,
   * NOT one slot past it (the old "first stop after the boundary" bug). */
  kbd_ctrlRight_landsAtBarline_notPastFirstNote: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(m.getVoiceLength(1), 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);  /* Mid-M_1. */
    `,
    setupKeys: [{ key: 'ArrowRight', ctrl: true }],
  },

  /* Two Ctrl+Lefts from mid-M_2: first press → start of M_2; second
   * press → start of M_1. Staircase behavior matches selection-mode. */
  kbd_ctrlLeft_staircase_currentThenPrev: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(6, 1);  /* Mid-M_2. */
    `,
    setupKeys: [
      { key: 'ArrowLeft', ctrl: true },
      { key: 'ArrowLeft', ctrl: true },
    ],
  },

  /* Empty-measure pass-through: M_1 has a whole rest, M_2 is empty, M_3
   * has a whole rest. Two Ctrl+Rights from start should land on M_2's
   * barline cursor (start of empty M_2), then M_3's barline cursor. */
  kbd_ctrlRight_emptyNextMeasure: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '1', dots: 0 });
      m.appendMeasure();  /* M_2 stays empty. */
      m.appendMeasure();  /* M_3 will receive content. */
      m.setCursor(m.getVoiceLength(1), 1);
      m.insertRestAtCursor({ duration: '1', dots: 0 });
      m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowRight', ctrl: true },
      { key: 'ArrowRight', ctrl: true },
    ],
  },

  /* Voice cycle: Up arrow 5 times → 1→2→expr→3→4→1. */
  kbd_voiceCycle: {
    setupKeys: ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp'],
  },

  /* Empty document has no expressions anywhere → ArrowDown ×2 from V_1
   * should skip the expression layer and land at V_3 in voice mode. */
  kbd_voiceCycle_skipsExprWhenMeasureEmpty: {
    setupKeys: ['ArrowDown', 'ArrowDown'],
  },

  /* Insert a quarter rest in V_1 M_1 (gives the cursor a moment anchor),
   * then Shift+5 commits an "mf" dynamic at that moment. ArrowDown ×2
   * from V_1 should now enter expression mode since M_1 has an expression. */
  kbd_voiceCycle_entersExprWhenMeasureHasDynamic: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [
      { key: '%', shift: true },   /* Shift+5 → "mf" */
      'ArrowDown',                 /* V_1 → V_2 */
      'ArrowDown',                 /* V_2 → expr (not skipped) */
    ],
  },

  /* Insert key toggles mode. After one toggle, mode='overwrite'. */
  kbd_modeToggle: {
    setupKeys: ['Insert'],
  },

  /* Escape clears any pending hairpin/tuplet. Press '<' (start cres),
   * then Escape — model should have no pending hairpin. */
  kbd_escClearsPending: {
    setupKeys: [{ key: '<', shift: true }, 'Escape'],
  },

  /* Pending hairpin cancels on any non-nav input and falls through to its
   * normal handling. Press '<' (sets pendingHairpin), then '5' (quarter
   * rest digit) — pending should be cleared AND the quarter rest inserted. */
  kbd_pendingHairpin_cancelOnDigit: {
    setupKeys: [{ key: '<', shift: true }, '5'],
  },

  /* Plain cursor navigation (ArrowLeft/Right/Home/End, no modifiers)
   * preserves the pending so the user can navigate to the endpoint. */
  kbd_pendingHairpin_preservedOnArrowRight: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(0, 1);
    `,
    setupKeys: [{ key: '<', shift: true }, 'ArrowRight'],
  },

  /* Voice cycling (ArrowDown/Up) cancels the pending — same shape as
   * slurs dropping on voice change. */
  kbd_pendingHairpin_cancelOnVoiceCycle: {
    setupKeys: [{ key: '<', shift: true }, 'ArrowDown'],
  },

  /* Statusline kinds + clear-on-next-action. Press '=' (tie toggle) on
     an empty measure where there's no note → error message in red. The
     follow-up assertion (kbd_statusError_clearsOnNextKey) types ArrowRight
     after the error and checks the red went away. */
  kbd_statusError_onTieNoNote: {
    setupKeys: [{ key: '=' }],
  },
  kbd_statusError_clearsOnNextKey: {
    setupKeys: [{ key: '=' }, { key: 'ArrowRight' }],
  },

  /* Purple post-action message also clears on next keystroke. Press '<'
     (start cres → state/blue), then Escape (cancel → action/purple
     "Pending hairpin cancelled."), then ArrowRight — should be Ready. */
  kbd_statusAction_pendingHairpinCancel: {
    setupKeys: [{ key: '<', shift: true }, 'Escape'],
  },
  kbd_statusAction_clearsOnNextKey: {
    setupKeys: [{ key: '<', shift: true }, 'Escape', 'ArrowRight'],
  },
};

/* ── New: selection mode (Shift+arrow entry, Ctrl+C/X/V) ──────────────── */
//
// Setup pattern: build content in M_1 (and sometimes M_2) via the model API,
// then drive Shift+arrow / Ctrl+C/X/V via setupKeys. Each fixture asserts a
// combination of (model state, input state, clipboard contents).
//
// Note: navigator.clipboard.readText() is not available in the headless
// Chromium context without permissions plumbing — copy/paste fixtures use
// the in-page sequence (write then read) and rely on the clipboard API
// being mocked at test setup, OR they verify model-side effects only.

const FILL_M1_4Q_V1 = `
  m.setCursor(0, 1);
  for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
`;

const SELECTION = {
  /* Enter beat selection via Shift+Left from end-of-M1 (= cursor past last
     quarter, current beat = beat 3). Should select that single beat. */
  sel_beat_enter_shiftLeft: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(m.getVoiceLength(1), 1);`,
    setupKeys: [{ key: 'ArrowLeft', shift: true }],
  },

  /* Enter beat selection via Shift+Right from start of M1 (= cursor at the
     wrapper, current beat = beat 0). Should select that single beat — same
     as Shift+Left at this cursor (entry direction no longer matters). */
  sel_beat_enter_shiftRight: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [{ key: 'ArrowRight', shift: true }],
  },

  /* Grow beat selection rightward by 1 beat (entry selects beat 0, then
     Shift+Right expands last to beat 1). */
  sel_beat_grow_right: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
    ],
  },

  /* Shrink-back-to-origin: Shift+Right enters beat 0; Shift+Right expands to
     beat 0–1; Shift+Left shrinks back to beat 0 only. No convergence-exit. */
  sel_beat_shrink_to_origin: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowLeft', shift: true },
    ],
  },

  /* Ctrl+Shift+Right at start of a 2-measure score. Entry selects beat 0;
     Ctrl+Shift+Right should grow last until the last beat of M_1 (the
     just-moved edge lands at the M_1/M_2 measure boundary). */
  sel_beat_ctrlShift_measureBoundary: {
    setup: `${FILL_M1_4Q_V1}
      m.setCursor(m.getVoiceLength(1), 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(0, 1);
    `,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true, ctrl: true },
    ],
  },

  /* Promote beat → measure via Shift+Down. */
  sel_promote_beat_to_measure: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowDown', shift: true },
    ],
  },

  /* Enter measure mode directly via Shift+Down from voice mode. */
  sel_measure_enter_shiftDown: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(1, 1);`,
    setupKeys: [{ key: 'ArrowDown', shift: true }],
  },

  /* Measure mode: Shift+Down adds the next staff (origin=staff 1, last=2). */
  sel_measure_expand_staves: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(1, 1);`,
    setupKeys: [
      { key: 'ArrowDown', shift: true },
      { key: 'ArrowDown', shift: true },
    ],
  },

  /* Escape exits selection mode. */
  sel_escape_exits: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      'Escape',
    ],
  },

  /* Pressing a non-selection key (a duration digit) exits selection to movable
     stop and then applies the key. */
  sel_nonsel_key_exits: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      '5', // quarter rest insert after exit
    ],
  },

  /* Ctrl+X on a beat selection should replace content with beat-aligned rests.
     We start with content (notes/chords already are rests in our setup, but the
     model side-effect should still be a re-fill via decomposeBeatAlignedRests). */
  sel_beat_cut_replaces_with_rests: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      { key: 'x', ctrl: true },
    ],
  },

  /* Backspace on a beat selection should delete the selected content AND exit
     selection mode (same end state as cut, minus the clipboard write). Before
     this fix, Backspace fell through to the normal-mode handler at the post-
     exit cursor and chewed adjacent content. */
  sel_beat_backspace_deletes_and_exits: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      'Backspace',
    ],
  },

  /* Delete (forward-delete) on a beat selection: same end state as Backspace. */
  sel_beat_delete_deletes_and_exits: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      'Delete',
    ],
  },

  /* Backspace on a measure-mode selection: clears measure content, exits to
     voice mode. */
  sel_measure_backspace_deletes_and_exits: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowDown', shift: true },
      'Backspace',
    ],
  },

  /* Visual: 2-beat selection at start of a 4-quarter M_1 (V_1). Captures
     the selection rect's horizontal extent (right edge of q0 to right edge
     of q1, snapping to measure left edge for the start of M_1) and the
     editing cursor being hidden. */
  visualSelBeatTwoBeats: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
    ],
    visualBaseline: 'sel_beat_two_beats',
  },

  /* Visual: measure-mode selection of all of M_1, both staves (Shift+Down
     to enter measure mode, Shift+Down again to add staff 2). */
  visualSelMeasureBothStaves: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowDown', shift: true },
      { key: 'ArrowDown', shift: true },
    ],
    visualBaseline: 'sel_measure_both_staves',
  },
};

/* ── New: chord-internal selection + SC transpose + tie-target + refNote ─ */

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

const CHORD_INTERNAL = {
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

  /* Playback: every note in a chord tied to the next identical chord →
     ONE coalesced event at t=0 with all three notes and double the slot
     duration. Regression guard against the previous chord-level
     coalescing semantics. */
  playback_chord_fully_tied: {
    setup: `
      m.setCursor(0, 1);
      const notes = [
        { q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888888', velocity: 80 },
        { q:  1, r:  0, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888888', velocity: 80 },
        { q:  0, r:  1, pname: 'g', accid: '', oct: 4, midi: 67, colorHex: '#888888', velocity: 80 },
      ];
      m.insertChordAtCursor({ notes, duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes, duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [
      /* No chord-internal selection → '=' ties the entire first chord. */
      '=',
    ],
  },

  /* Playback: partial tie — bass C of first chord is tied forward; E and
     G are independent attacks. Covers both bugs at once:
       - Leading-tie suppression: E and G must re-attack at slot 2.
       - Trailing-tie no-cutoff: E and G must release at slot 1's own
         duration, not the coalesced chain duration. */
  playback_chord_partial_tie: {
    setup: `
      m.setCursor(0, 1);
      const notes = [
        { q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888888', velocity: 80 },
        { q:  1, r:  0, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888888', velocity: 80 },
        { q:  0, r:  1, pname: 'g', accid: '', oct: 4, midi: 67, colorHex: '#888888', velocity: 80 },
      ];
      m.insertChordAtCursor({ notes, duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes, duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [
      { key: 'ArrowUp', alt: true },
      '=',
    ],
  },

  /* Playback: a visible rest between two notes emits a silent PlaybackEvent
     (notes:[]) so HKL's scheduler echoes a `playback-position` for the rest
     and Composer's per-voice playback cursor steps THROUGH the rest. M_1
     = quarter-note A4, quarter rest, quarter-note A4 (one beat each at
     120 bpm → atMs 0, 500, 1000). */
  playback_advances_over_rest: {
    setup: `
      m.setCursor(0, 1);
      const note = [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888888', velocity: 80 }];
      m.insertChordAtCursor({ notes: note, duration: '4', dots: 0 });
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: note, duration: '4', dots: 0 });
    `,
  },

  /* Empty voice with key.sig = 7 sharps → song-key broadcast carries C#
     (the key's tonic), AND no set-reference-note is sent (the selection
     tier deliberately stays silent on empty voices so a manual HKL
     Ctrl+click isn't clobbered — see refNote.ts module header).
     Composer hasn't received hkl-hello yet at this point in setup; we
     fire __bridgeMock.sendHklHello() so hklConnected flips true and the
     initial broadcast cycle runs. */
  song_key_csharp_from_empty_voice: {
    setup: `
      m.setKeySig('7s');
      window.__hkl_composer.reRender();
      window.__bridgeMock.reset();
      window.__bridgeMock.sendHklHello();
    `,
  },

  /* Insert a note; the broadcast captured should reflect that note's
     coordinates as the reference (most-recent-prior-to-cursor). */
  ref_note_broadcast_on_note_insert: {
    setup: `
      m.setCursor(0, 1);
      window.__bridgeMock.reset();
      window.__bridgeMock.sendHklHello();
      /* Insert A4 at (0, 0) — note insertion fires onChange which calls
         maybeBroadcastReference(). */
      m.insertChordAtCursor({
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }],
        duration: '4', dots: 0,
      });
      /* Drive an onChange path through the renderer so the input hook
         actually fires. The bridge mock captured set-reference-note
         from the hkl-hello path (initial broadcast); after the insert,
         the input dispatch fires onChange + onStateChange via setupKeys. */
    `,
    setupKeys: [
      /* No-op keystroke that goes through the input handler and triggers
         onStateChange + onChange via the model. ArrowRight moves cursor
         (the model.moveCursor path calls onStateChange/onChange). */
      'ArrowLeft',
      'ArrowRight',
    ],
  },
};

/* ── Undo / redo ───────────────────────────────────────────────────────── */
//
// Each fixture drives the model through 1+ user actions, then issues Ctrl+Z
// (or Ctrl+Y) and asserts that the resulting state matches expectations.
// Setup keys dispatch through input.ts via CDP — so we exercise the exact
// path a user takes.

const UNDO_REDO = {
  /* Insert a quarter rest, then Ctrl+Z. Doc should be empty (zero notes,
   * zero rests beyond placeholder fill). */
  undo_basic_insert: {
    setupKeys: ['5', { key: 'z', ctrl: true }],
  },

  /* Insert, undo, redo. Should match the post-insert state. */
  undo_redo_roundtrip: {
    setupKeys: [
      '5',
      { key: 'z', ctrl: true },
      { key: 'y', ctrl: true },
    ],
  },

  /* Insert, undo, then a NEW insert. The redo stack must be cleared by the
   * new mutation — pressing Ctrl+Y should be a no-op. */
  undo_redo_invalidates: {
    setupKeys: [
      '5',                            /* quarter rest */
      { key: 'z', ctrl: true },       /* undo */
      '6',                            /* half rest — invalidates redo */
      { key: 'y', ctrl: true },       /* no-op */
    ],
  },

  /* Tuplet creation: Ctrl+3 then duration digit; one undo entry covers both. */
  undo_tuplet: {
    setupKeys: [
      { key: '3', ctrl: true },       /* begin triplet */
      '5',                            /* span = quarter → triplet created */
      { key: 'z', ctrl: true },       /* undo */
    ],
  },

  /* Dot cycle: insert rest, press '.', undo. The dot is reverted; the rest
   * stays. */
  undo_dot_cycle: {
    setupKeys: ['5', '.', { key: 'z', ctrl: true }],
  },

  /* Backspace deletion: insert two rests, backspace one, undo. After undo,
   * both rests are back. */
  undo_delete: {
    setupKeys: [
      '5', '5',
      'Backspace',
      { key: 'z', ctrl: true },
    ],
  },

  /* Cursor-position-match: insert, cursor stays at action-end. Undo should
   * restore cursor to BEFORE position. */
  undo_cursor_match: {
    setupKeys: ['5', { key: 'z', ctrl: true }],
  },

  /* Cursor-position-NOT-match: insert, navigate away, then undo. Cursor
   * should stay where the user moved it (and be clamped to valid range). */
  undo_cursor_moved_away: {
    setupKeys: [
      '5',                            /* insert quarter rest, cursor → 1 */
      '5',                            /* insert second quarter, cursor → 2 */
      'ArrowLeft',                    /* nav away — cursor now 1 */
      { key: 'z', ctrl: true },       /* undo the second insert */
    ],
  },

  /* Stack stress: insert 20 rests, undo 20 times, redo 20 times. */
  undo_stack_stress: {
    setup: `
      /* Pre-fill via the model API to keep setupKeys tractable. Skip undo
       * tracking for setup — it only kicks in for actual keypresses. */
      m.setVoice(1);
      m.setCursor(0, 1);
    `,
    setupKeys: [
      ...Array(20).fill('5'),
      ...Array(20).fill({ key: 'z', ctrl: true }),
      ...Array(20).fill({ key: 'y', ctrl: true }),
    ],
  },

  /* Ctrl+Shift+Z as redo alias (alongside Ctrl+Y). */
  undo_redo_shiftZ_alias: {
    setupKeys: [
      '5',
      { key: 'z', ctrl: true },
      { key: 'Z', ctrl: true, shift: true },
    ],
  },

  /* Multi-voice: insert in V2, switch to V1, undo. V2 content reverts; V1
   * stays at cursor 0. */
  undo_multi_voice: {
    setup: `
      m.setVoice(2);
      m.setCursor(0, 2);
    `,
    setupKeys: [
      '5',                            /* V2 quarter rest */
      'ArrowUp',                      /* V2 → V1 */
      { key: 'z', ctrl: true },       /* undo: V2 reverts */
    ],
  },

  /* Cut with source-selection re-entry on undo. After Ctrl+X the selection
   * is exited; after Ctrl+Z the source selection should be re-entered. */
  undo_cut_restores_source_sel: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },  /* enter beat-mode selection */
      { key: 'ArrowRight', shift: true },  /* grow to beats 0–1 */
      { key: 'x', ctrl: true },            /* cut */
      { key: 'z', ctrl: true },            /* undo cut */
    ],
  },

  /* Backspace-on-selection with source-selection re-entry on undo. Mirrors
   * undo_cut_restores_source_sel — confirms withHistory('delete-selection')
   * wires the sourceSelection through correctly. */
  undo_backspace_selection_restores: {
    setup: `${FILL_M1_4Q_V1} m.setCursor(0, 1);`,
    setupKeys: [
      { key: 'ArrowRight', shift: true },
      { key: 'ArrowRight', shift: true },
      'Backspace',
      { key: 'z', ctrl: true },
    ],
  },
};

/* ── New: empty doc + boundary scenarios for full-tier roundtrip ──────── */

const ROUNDTRIP_STRESS = {
  /* M_1 fully filled with one whole note. */
  m1WholeNote: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "1", dots: 0 });
  `,

  /* Multi-voice content. */
  multiVoiceMixed: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: "2", dots: 0 });
    m.setVoice(2);
    m.setCursor(0, 2);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.setVoice(3);
    m.setCursor(0, 3);
    m.insertRestAtCursor({ duration: "2", dots: 1 });
    m.setVoice(1);
  `,
};

/* ── Help modal (keybinding reference) ───────────────────────────────── */

const HELP_MODAL = {
  /* Clicking Help opens the modal; body contains rendered binding rows. */
  help_button_opens_modal: {
    setup: `document.getElementById('btnHelp').click();`,
  },

  /* Escape closes the open modal (native <dialog> behavior). */
  help_modal_esc_closes: {
    setup: `document.getElementById('btnHelp').click();`,
    setupKeys: ['Escape'],
  },

  /* (no visual baseline: visualCheck's bbox is scoped to #score content,
   * which doesn't cover the <dialog> overlay; a visual regression for the
   * help modal would need a separate viewport-clip path in visual.mjs.) */
};

/* ── Slurs (Ctrl+L pending-state entry; §7.20) ───────────────────────── */

/* Three quarter notes in V1 M1. In insert mode the per-measure flat stream
 * is [wrapper, note0, note1, note2], so note0 sits at cursor index 1. */
const SLUR_3Q_V1 = `
  m.setCursor(0, 1);
  m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
  m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
  m.insertChordAtCursor({ notes: [{ q: 1, r: 0, pname: 'c', accid: 's', oct: 4, midi: 61, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
  m.setCursor(1, 1);
`;

const SLURS = {
  /* Ctrl+L on note0, →, Ctrl+L on note1 → one <slur> binding the two slots. */
  slur_create: {
    setup: `${SLUR_3Q_V1}
      window.__slur_ids = [...m.getDoc().querySelectorAll('note')].map(n => n.getAttribute('xml:id'));
    `,
    setupKeys: [
      { key: 'l', ctrl: true },
      { key: 'ArrowRight' },
      { key: 'l', ctrl: true },
    ],
    visualBaseline: 'slur_create',
  },

  /* Slur over notes 0..2, then Ctrl+L on the interior note1 deletes it. */
  slur_delete_interior: {
    setup: SLUR_3Q_V1,
    setupKeys: [
      { key: 'l', ctrl: true },
      { key: 'ArrowRight' },
      { key: 'ArrowRight' },
      { key: 'l', ctrl: true },
      { key: 'ArrowLeft' },
      { key: 'l', ctrl: true },
    ],
  },

  /* Two Ctrl+L on the same slot → no-op + error; zero slurs. */
  slur_sameNote_noop: {
    setup: SLUR_3Q_V1,
    setupKeys: [
      { key: 'l', ctrl: true },
      { key: 'l', ctrl: true },
    ],
  },

  /* Start a slur, switch voices (ArrowDown) → pending slur cleared. */
  slur_voiceSwitch_exits: {
    setup: SLUR_3Q_V1,
    setupKeys: [
      { key: 'l', ctrl: true },
      { key: 'ArrowDown' },
    ],
  },

  /* Start a slur, Escape → pending cleared, no slur created. */
  slur_esc_cancels: {
    setup: SLUR_3Q_V1,
    setupKeys: [
      { key: 'l', ctrl: true },
      { key: 'Escape' },
    ],
  },

  /* Create slur note0→note1, then delete an endpoint → slur pruned. */
  slur_prune_onEndpointDelete: {
    setup: SLUR_3Q_V1,
    setupKeys: [
      { key: 'l', ctrl: true },
      { key: 'ArrowRight' },
      { key: 'l', ctrl: true },
      { key: 'Backspace' },
    ],
  },

  /* Slur note0→note1; buildPlayback should flag note0 slurredToNext and stamp
   * voice=1 on every event. (Playback-metadata path; audio realization itself
   * is verified by ear.) */
  slur_playback_flags: {
    setup: SLUR_3Q_V1,
    setupKeys: [
      { key: 'l', ctrl: true },
      { key: 'ArrowRight' },
      { key: 'l', ctrl: true },
    ],
  },
};

/* ── Phase 1 items: barlines, hide rest, paren caut, articulations, etc. ── */

const PHASE1 = {
  /* `]` toggles @right="dbl" on the cursor's current measure. */
  phase1_dblbar_toggle_on_m1_of_2: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);  /* mid-M_1 */
      m.appendMeasure();
    `,
    setupKeys: [{ key: ']' }],
  },

  /* Pressing `]` twice clears the marker (toggle semantics). */
  phase1_dblbar_toggle_off: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);
      m.appendMeasure();
    `,
    setupKeys: [{ key: ']' }, { key: ']' }],
  },

  /* `]` is a no-op on the last measure (final bar always wins). */
  phase1_dblbar_lastMeasure_noop: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);
    `,
    setupKeys: [{ key: ']' }],
  },

  /* `H` on a rest sets @visible="false". Cursor parked PAST the rest so
     flat[c] resolves to the rest (cursor-anchor rule). */
  phase1_hideRest_toggle_on: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'h' }],
  },

  /* Pressing H twice clears @visible. */
  phase1_hideRest_toggle_off: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'h' }, { key: 'h' }],
  },

  /* H on a non-rest element (note) is a no-op. */
  phase1_hideRest_onNote_noop: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'h' }],
  },

  /* P on a bare note sets @hkl-paren-caut. Visible @accid="n" in render. */
  phase1_parenCaut_bareNote_on: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'p' }],
  },

  /* P on a HEJI-decorated note (C#↓ in mode D) must keep the comma-arrow
     glyph (U+E2C3) AND add parens around it. Regression: I originally
     bypassed HEJI by writing <accid> child form. */
  phase1_parenCaut_preserves_heji: {
    setup: `
      m.setLayoutReq({ tuningMode: 'D', refQ: 0, refR: 0 });
      m.setHejiEnabled(true);
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 1, r: 0, pname: 'c', accid: 's', oct: 4, midi: 61, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      r();
    `,
    setupKeys: [{ key: 'p' }],
  },

  /* P twice toggles off. */
  phase1_parenCaut_toggle_off: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'p' }, { key: 'p' }],
  },

  /* P on a chord (no alt-sel) sets flag on every chord note. */
  phase1_parenCaut_chord_all: {
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
  phase1_parenCaut_chord_singleViaAltSel: {
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
  phase1_parenCaut_onRest_noop: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'p' }],
  },

  /* Plain → during playback stops at the most-recent playback head.
     Simulate playback active and pointing at the SECOND rest's meiId. */
  phase1_playback_plainArrow_stopsAtHead: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(0, 1);
      const rests = [...m.getDoc().querySelectorAll('rest')];
      const secondId = rests[1].getAttribute('xml:id');
      window.__hkl_composer.__simulatePlaybackAt(secondId);
    `,
    setupKeys: [{ key: 'ArrowRight' }],
  },

  /* Ctrl+→ during playback SEEKS the audible head to the next measure
     boundary: stop-playback then play-score are both sent, cursor lands
     at the boundary, isPlaying stays true. */
  phase1_playback_ctrlArrow_seeks: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);  /* mid-M_1 */
      const firstId = m.getDoc().querySelector('rest').getAttribute('xml:id');
      window.__bridgeMock.sendHklHello();
      window.__hkl_composer.__simulatePlaybackAt(firstId);
      window.__bridgeMock.reset();
    `,
    setupKeys: [{ key: 'ArrowRight', ctrl: true }],
  },

  /* REGRESSION: Ctrl+← when the playhead just entered a measure should
     jump back TWO measure boundaries (= start of previous measure),
     not just one (= start of current measure). */
  phase1_playback_ctrlLeft_atBoundary_jumpsPrev: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(0, 1);
      /* Playback head simulated on the FIRST rest of M_2 — voice "just
         entered M_2," so Ctrl+← should jump to start of M_1. */
      const m2FirstId = m.flatChildren(1).filter(e => e.localName === 'rest')[4].getAttribute('xml:id');
      window.__bridgeMock.sendHklHello();
      window.__hkl_composer.__simulatePlaybackAt(m2FirstId);
      window.__bridgeMock.reset();
    `,
    setupKeys: [{ key: 'ArrowLeft', ctrl: true }],
  },

  /* REGRESSION: Ctrl+← mid-measure should jump to start of CURRENT
     measure (standard behavior — single step back). */
  phase1_playback_ctrlLeft_midMeasure_jumpsCurrent: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(0, 1);
      /* Playhead on the 3rd rest of M_2 (mid-measure). Ctrl+← should
         jump to start of M_2 (not M_1). */
      const m2ThirdId = m.flatChildren(1).filter(e => e.localName === 'rest')[6].getAttribute('xml:id');
      window.__bridgeMock.sendHklHello();
      window.__hkl_composer.__simulatePlaybackAt(m2ThirdId);
      window.__bridgeMock.reset();
    `,
    setupKeys: [{ key: 'ArrowLeft', ctrl: true }],
  },

  /* REGRESSION: multiple Ctrl+→ in a row must remain in playback. A naive
     impl gets a stale `playback-finished` from HKL after the first stop;
     that ack must NOT finalize Composer's UI mid-second-session. */
  phase1_playback_ctrlArrow_seeks_repeatable: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(0, 1);
      const firstId = m.getDoc().querySelector('rest').getAttribute('xml:id');
      window.__bridgeMock.sendHklHello();
      window.__hkl_composer.__simulatePlaybackAt(firstId);
      window.__bridgeMock.reset();
    `,
    setupKeys: [
      { key: 'ArrowRight', ctrl: true },
      { key: 'ArrowRight', ctrl: true },
    ],
  },

  /* REGRESSION: a stale playback-finished from a Composer-initiated stop
     must NOT finalize a fresh session that started after the stop. The
     full sequence (seek → simulate stale ack) runs in setup since
     setupKeys can't inject bridge messages between keystrokes. */
  phase1_playback_staleFinishAck_ignored: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(0, 1);
      const firstId = m.getDoc().querySelector('rest').getAttribute('xml:id');
      window.__bridgeMock.sendHklHello();
      window.__hkl_composer.__simulatePlaybackAt(firstId);
      window.__bridgeMock.reset();
      /* Dispatch Ctrl+→ to trigger seek (sends stop-playback + starts
         new session via startPlayback). */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true }));
      /* Now simulate HKL acking the stop with playback-finished, AFTER
         the new session is live. Must NOT terminate Composer's UI. */
      window.__bridgeMock.sendPlaybackFinished();
    `,
  },

  /* Click on a rendered note moves the editing cursor to that note's
     flat-index and switches voice. Simulate the click by dispatching a
     `click` event on Verovio's <g class="note" id="<meiId>"> element. */
  phase1_click_movesCursorToNote: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 1, r: 0, pname: 'c', accid: 's', oct: 4, midi: 61, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(0, 1);  /* park cursor at start */
      r();
      /* Target the SECOND rendered g.note (= second note element in document
         order = the C# at flat[1] of voice 1). */
      const notes = [...document.querySelectorAll('#score g.note')];
      const target = notes[1];
      const rect = target.getBoundingClientRect();
      const ev = new MouseEvent('click', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      });
      target.dispatchEvent(ev);
    `,
  },

  /* Ctrl+M at start of M_1 inserts a new measure at the front. */
  phase1_insertMeasure_atStart: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '1', dots: 0 });  /* fill M_1 */
      m.setCursor(0, 1);  /* park at boundary of M_1 */
    `,
    setupKeys: [{ key: 'm', ctrl: true }],
  },

  /* Ctrl+M mid-measure inserts after current measure. */
  phase1_insertMeasure_midMeasure: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setCursor(2, 1);  /* mid-M_1 */
    `,
    setupKeys: [{ key: 'm', ctrl: true }],
  },

  /* REGRESSION: cursor at the first note (cursor=1, past flat[1]=note) is
     NOT a boundary — Ctrl+M must insert AFTER M_1, not before. */
  phase1_insertMeasure_atFirstNote_insertsAfter: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);  /* past the first note */
    `,
    setupKeys: [{ key: 'm', ctrl: true }],
  },

  /* Ctrl+M severs slurs that straddle the new measure. M_1 ends with a
     slurred note → M_2 starts with the slur destination; after Ctrl+M
     inserted BETWEEN them, the slur should be removed. */
  phase1_insertMeasure_breaksSlur: {
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
    setupKeys: [{ key: 'm', ctrl: true }],
  },

  /* Ctrl+M severs ties that span the new measure. Pre-insert: M_1 ends
     with an A4 tied to M_2's starting A4. Post-insert (M_2 = empty,
     A4 now lives in M_3), the tie can no longer realize. */
  phase1_insertMeasure_breaksTie: {
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
    setupKeys: [{ key: 'm', ctrl: true }],
  },

  /* L on a bare note sets @stem.dir to opposite of rendered direction.
     flat[0] is the measure wrapper, flat[1] is the just-inserted note —
     park cursor there. */
  phase1_stemFlip_bareNote_freezes: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
      r();
    `,
    setupKeys: [{ key: 'l' }],
  },

  /* L twice clears the @stem.dir (back to natural). */
  phase1_stemFlip_secondPress_unfreezes: {
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
  phase1_stemFlip_beamGroup_allFlip: {
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
  phase1_stemFlip_respectsBeamBreak: {
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

  /* Shift+L on a slurred note sets @curvedir on the slur. Single-note
     "chord" inputs serialize as bare <note> elements, so the IDs live on
     notes, not chords. */
  phase1_slurFlip_setsAttr: {
    setup: `
      m.setCursor(0, 1);
      for (const _ of [0, 0]) {
        m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      }
      const flat = m.flatChildren(1);
      const notes = flat.filter(e => e.localName === 'note' || e.localName === 'chord');
      const startId = notes[0].getAttribute('xml:id');
      const endId = notes[1].getAttribute('xml:id');
      const measure = notes[0].closest('measure');
      const slur = m.getDoc().createElementNS('http://www.music-encoding.org/ns/mei', 'slur');
      slur.setAttribute('startid', '#' + startId);
      slur.setAttribute('endid', '#' + endId);
      slur.setAttribute('data-voice', '1');
      slur.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:id', 's-fixture');
      measure.appendChild(slur);
      m.setCursor(1, 1);  /* park on the first slurred note (flat[1]) */
      r();
    `,
    setupKeys: [{ key: 'L', shift: true }],
  },

  /* `/` at cursor=2 (between e2 and e3 of an 8-eighth measure) sets
     @hkl-beam-break on e3. After serialize, beams should be 2+2+4. */
  phase1_beamSplit_marksThird: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 8; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
      m.setCursor(2, 1);  /* between e2 and e3 */
      r();
    `,
    setupKeys: [{ key: '/' }],
  },

  /* Second `/` clears the marker. */
  phase1_beamSplit_toggleOff: {
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
  phase1_beamSplit_overridesBeatBoundary: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 8; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
      m.setCursor(4, 1);  /* between notes 4 and 5 (= start of M_1 beat 3 = the half-measure boundary) */
      r();
    `,
    setupKeys: [{ key: '/' }],
  },

  /* `/` is no-op when the upcoming element is a rest. */
  phase1_beamSplit_onRest_noop: {
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
  phase1_artic_staccato_on_note: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);  /* park on the note */
    `,
    setupKeys: [{ key: 's' }],
  },

  phase1_artic_accent_on_note: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'a' }],
  },

  phase1_artic_tenuto_on_note: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 't' }],
  },

  phase1_artic_fermata_on_note: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'f' }],
  },

  phase1_artic_breath_on_note: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'b' }],
  },

  /* Fermata is the only articulation valid on a rest. */
  phase1_artic_fermata_on_rest: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 'f' }],
  },

  /* Staccato on a rest is a no-op. */
  phase1_artic_staccato_on_rest_noop: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
    `,
    setupKeys: [{ key: 's' }],
  },

  /* Pressing S twice toggles staccato off. */
  phase1_artic_staccato_toggle_off: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 's' }, { key: 's' }],
  },

  /* S + A on same note stacks both articulations. */
  phase1_artic_multiple_stack: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 's' }, { key: 'a' }],
  },

  /* Accent boosts playback velocity by ACCENT_VELOCITY_DELTA. */
  phase1_artic_accent_playback_velocity: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 'a' }],
  },

  /* Staccato halves playback durationMs. */
  phase1_artic_staccato_playback_duration: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(1, 1);
    `,
    setupKeys: [{ key: 's' }],
  },

  /* fillIncompleteMeasures fills M_1 (a single quarter rest, then quiet) when
     M_2 has content. */
  phase1_fillIncomplete_basic: {
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

  /* Title + subtitle + composer + footer all populate the MEI + render
     into the page SVG. */
  phase1_titleBlock_all_fields: {
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
  phase1_titleBlock_emptyFooter: {
    setup: `
      m.setTitle('Untitled');
      m.setFooter('');
      r();
    `,
  },

  /* REGRESSION: clicking an inner <note> of a chord in a different voice
     must resolve to the chord wrapper (which IS in flatChildren of that
     voice) — not the inner note's own xml:id (which isn't). */
  phase1_click_chordInternal_switchesVoice: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [
        { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 },
        { q: -1, r: 1, pname: 'c', accid: '', oct: 5, midi: 72, colorHex: '#888', velocity: 80 },
      ], duration: '4', dots: 0 });
      m.setVoice(3); m.setCursor(0, 3);
      m.insertChordAtCursor({ notes: [
        { q: 0, r: -2, pname: 'e', accid: '', oct: 2, midi: 40, colorHex: '#888', velocity: 80 },
        { q: -1, r: -1, pname: 'g', accid: '', oct: 2, midi: 43, colorHex: '#888', velocity: 80 },
      ], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
      /* Dispatch click on a V_3 chord-internal note. */
      const v3Notes = [...document.querySelectorAll('#score g.note')].filter(n => {
        let p = n; while (p && p.tagName !== 'svg' && (p.getAttribute && p.getAttribute('class') !== 'staff')) p = p.parentElement;
        return p?.getAttribute('class') === 'staff' && [...p.parentElement?.querySelectorAll('g.staff') ?? []].indexOf(p) === 1;
      });
      const target = v3Notes[0];
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2, button: 0 }));
    `,
  },

  /* Click on a different voice's note switches the active voice. */
  phase1_click_switchesVoice: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setVoice(3);
      m.setCursor(0, 3);
      m.insertChordAtCursor({ notes: [{ q: 0, r: -2, pname: 'e', accid: '', oct: 2, midi: 40, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setVoice(1);
      m.setCursor(0, 1);
      r();
      /* Find the voice-3 note element (bass clef, lower staff) by data-q/r. */
      const notes = [...document.querySelectorAll('#score g.note')];
      const target = notes.find(n => {
        const cls = n.parentElement; /* g.staff ancestor */
        let p = n;
        while (p && !(p.getAttribute && p.getAttribute('class')?.startsWith('staff'))) p = p.parentElement;
        return p?.getAttribute('class') === 'staff' && p.getAttribute('data-n') === '2';
      }) || notes[notes.length - 1];
      const rect = target.getBoundingClientRect();
      const ev = new MouseEvent('click', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      });
      target.dispatchEvent(ev);
    `,
  },
};

export const FIXTURES = {
  ...mapTier(EXISTING, 'fast'),
  ...mapTier(CURSOR_CONVENTION, 'fast'),
  ...mapTier(SINGLE_VOICE, 'fast'),
  ...mapTier(MULTI_VOICE, 'fast'),
  ...mapTier(CTRL_NAV, 'fast'),
  ...mapTier(TIES, 'fast'),
  ...mapTier(TUPLETS, 'fast'),
  ...mapTier(SIG_CHANGES, 'fast'),
  ...mapTier(BEAMS, 'fast'),
  ...mapTier(ROUNDTRIP_STRESS, 'full'),
  ...mapKbdTier(KBD, 'full'),
  ...mapKbdTier(BRIDGE, 'full'),
  ...mapKbdTier(SCROLL, 'full'),
  ...mapKbdTier(VISUAL, 'full'),
  ...mapKbdTier(HEJI, 'full'),
  ...mapKbdTier(SELECTION, 'full'),
  ...mapKbdTier(CHORD_INTERNAL, 'full'),
  ...mapKbdTier(EXPORT, 'full'),
  ...mapKbdTier(UNDO_REDO, 'full'),
  ...mapKbdTier(HELP_MODAL, 'full'),
  ...mapKbdTier(SLURS, 'full'),
  ...mapKbdTier(PHASE1, 'full'),
};

/** Fixture-specific assertions. Map fixture name → list of {name, expr}.
 *  `expr` is evaluated in the page context post-setup; it must return
 *  { ok: boolean, detail?: string }. Use window.__test.* helpers.
 *
 *  Universal invariants (cursor-trace, no-tie-orphans, placeholder
 *  invariant, no console errors) are applied to EVERY fixture by the
 *  runner — don't repeat them here. */
export const FIXTURE_ASSERTIONS = {
  /* Slurs. */
  slur_create: [
    { name: 'one <slur> bound to note0→note1, data-voice=1',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const slurs = [...m.getDoc().querySelectorAll('slur')];
        if (slurs.length !== 1) return { ok: false, detail: 'slurs=' + slurs.length };
        const ids = window.__slur_ids || [];
        const s = slurs[0];
        const want = { start: '#' + ids[0], end: '#' + ids[1] };
        const got = { start: s.getAttribute('startid'), end: s.getAttribute('endid'), v: s.getAttribute('data-voice') };
        return (got.start === want.start && got.end === want.end && got.v === '1')
          ? { ok: true } : { ok: false, detail: JSON.stringify({ got, want }) };
      })()` },
    { name: 'slur renders as one g.slur arc',
      expr: `(() => {
        const n = document.querySelectorAll('g.slur').length;
        return n === 1 ? { ok: true } : { ok: false, detail: 'g.slur=' + n };
      })()` },
  ],
  slur_delete_interior: [
    { name: 'Ctrl+L on interior note removes the whole slur',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const n = m.getDoc().querySelectorAll('slur').length;
        return n === 0 ? { ok: true } : { ok: false, detail: 'slurs=' + n };
      })()` },
  ],
  slur_sameNote_noop: [
    { name: 'same-slot close is a no-op (no slur, pending cleared)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const n = m.getDoc().querySelectorAll('slur').length;
        const p = window.__hkl_composer.inputState().pendingSlur;
        return (n === 0 && p === null) ? { ok: true } : { ok: false, detail: 'slurs=' + n + ' pending=' + JSON.stringify(p) };
      })()` },
  ],
  slur_voiceSwitch_exits: [
    { name: 'voice switch clears pending slur; none created',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const n = m.getDoc().querySelectorAll('slur').length;
        const p = window.__hkl_composer.inputState().pendingSlur;
        return (n === 0 && p === null) ? { ok: true } : { ok: false, detail: 'slurs=' + n + ' pending=' + JSON.stringify(p) };
      })()` },
  ],
  slur_esc_cancels: [
    { name: 'Escape clears pending slur; none created',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const n = m.getDoc().querySelectorAll('slur').length;
        const p = window.__hkl_composer.inputState().pendingSlur;
        return (n === 0 && p === null) ? { ok: true } : { ok: false, detail: 'slurs=' + n + ' pending=' + JSON.stringify(p) };
      })()` },
  ],
  slur_prune_onEndpointDelete: [
    { name: 'deleting an endpoint note prunes the dangling slur',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const n = m.getDoc().querySelectorAll('slur').length;
        return n === 0 ? { ok: true } : { ok: false, detail: 'slurs=' + n };
      })()` },
  ],
  slur_playback_flags: [
    { name: 'note0 slurredToNext; note1/note2 not; voice=1 on all events',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const events = window.__hkl_composer.buildPlayback(m);
        if (!events.every(e => e.voice === 1)) {
          return { ok: false, detail: 'voices=' + events.map(e => e.voice).join(',') };
        }
        const at = (ms) => events.find(e => Math.abs(e.atMs - ms) < 1e-6);
        const e0 = at(0), e1 = at(500), e2 = at(1000);
        if (!e0 || !e1 || !e2) {
          return { ok: false, detail: 'atMs=' + events.map(e => e.atMs).join(',') };
        }
        return (e0.slurredToNext === true && !e1.slurredToNext && !e2.slurredToNext)
          ? { ok: true }
          : { ok: false, detail: 'flags=' + JSON.stringify([e0.slurredToNext, e1.slurredToNext, e2.slurredToNext]) };
      })()` },
  ],

  /* HEJI injection. */
  heji_sharp_arrow: [
    { name: 'C#↓ injected as one U+E2C3 glyph',
      expr: `(() => {
        const cps = [...document.querySelectorAll('g.note g.accid text')].map(t => t.textContent.codePointAt(0).toString(16));
        return cps.length === 1 && cps[0] === 'e2c3'
          ? { ok: true } : { ok: false, detail: 'glyphs=' + JSON.stringify(cps) };
      })()` },
  ],
  heji_septimal_hook: [
    { name: 'F natural shows standalone septimal hook U+E2DE',
      expr: `(() => {
        const cps = [...document.querySelectorAll('g.note g.accid text')].map(t => t.textContent.codePointAt(0).toString(16));
        return cps.length === 1 && cps[0] === 'e2de'
          ? { ok: true } : { ok: false, detail: 'glyphs=' + JSON.stringify(cps) };
      })()` },
  ],
  heji_acc_plus_hook: [
    { name: 'F#+hook: sharp then hook, hook nearest notehead',
      expr: `(() => {
        const texts = [...document.querySelectorAll('g.note g.accid text')]
          .map(t => ({ cp: t.textContent.codePointAt(0).toString(16), x: t.getBoundingClientRect().left }))
          .sort((a, b) => a.x - b.x);
        const cps = texts.map(t => t.cp);
        return cps.length === 2 && cps[0] === 'e262' && cps[1] === 'e2de'
          ? { ok: true } : { ok: false, detail: 'L→R glyphs=' + JSON.stringify(cps) };
      })()` },
  ],
  heji_off_native: [
    { name: 'HEJI off → plain sharp (E262), no comma arrow',
      expr: `(() => {
        const cps = [...document.querySelectorAll('g.note g.accid text')].map(t => t.textContent.codePointAt(0).toString(16));
        return cps.length === 1 && cps[0] === 'e262'
          ? { ok: true } : { ok: false, detail: 'glyphs=' + JSON.stringify(cps) };
      })()` },
  ],
  heji_carry_diff_comma: [
    { name: 'second A# (comma sibling) still shows its arrow glyph',
      expr: `(() => {
        const notes = [...document.querySelectorAll('g.note')];
        if (notes.length !== 2) return { ok: false, detail: 'notes=' + notes.length };
        const g2 = [...notes[1].querySelectorAll('g.accid text')].map(t => t.textContent.codePointAt(0).toString(16));
        return g2.length === 1 && g2[0] === 'e2c3'
          ? { ok: true } : { ok: false, detail: 'second-note glyphs=' + JSON.stringify(g2) };
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

  /* Tuplets. */
  m1Triplet8Empty: [
    { name: 'tuplet exists with num=3 numbase=2',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getDoc().querySelector('tuplet');
        if (!t) return { ok: false, detail: 'no tuplet found' };
        const num = t.getAttribute('num');
        const numbase = t.getAttribute('numbase');
        return num === '3' && numbase === '2'
          ? { ok: true }
          : { ok: false, detail: 'num=' + num + ' numbase=' + numbase };
      })()` },
    { name: 'tuplet bracket rendered',
      expr: `(() => {
        const t = window.__hkl_composer.model.getDoc().querySelector('tuplet');
        return window.__test.assertBracketRendered(t.getAttribute('xml:id'));
      })()` },
    { name: 'tuplet placeholders are CSS-hidden',
      expr: `window.__test.assertTupletPlaceholdersHidden()` },
  ],
  m1Triplet8FilledThenDelete: [
    { name: 'regen yields atomic 8th-rest placeholder',
      expr: `(() => {
        const t = window.__hkl_composer.model.getDoc().querySelector('tuplet');
        if (!t) return { ok: false, detail: 'no tuplet' };
        const phs = t.querySelectorAll('rest[data-tuplet-placeholder="true"]');
        const fails = [];
        for (const ph of phs) {
          if (ph.getAttribute('dur') !== '8') {
            fails.push('placeholder dur=' + ph.getAttribute('dur') + ' (expected 8)');
          }
        }
        return fails.length ? { ok: false, detail: fails.join('; ') } : { ok: true };
      })()` },
  ],

  /* Ties. */
  m1TieRealPair: [
    { name: 'real-tie pair created (i + t)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const i = doc.querySelectorAll('note[tie="i"]');
        const t = doc.querySelectorAll('note[tie="t"]');
        return i.length === 1 && t.length === 1
          ? { ok: true }
          : { ok: false, detail: 'i=' + i.length + ', t=' + t.length };
      })()` },
    { name: 'i has forward data-tie-partner; t has none (forward-only model)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const i = doc.querySelector('note[tie="i"]');
        const t = doc.querySelector('note[tie="t"]');
        if (!i || !t) return { ok: false, detail: 'missing i or t' };
        const iP = i.getAttribute('data-tie-partner');
        const tP = t.getAttribute('data-tie-partner');
        return iP === t.getAttribute('xml:id') && tP === null
          ? { ok: true }
          : { ok: false, detail: 'iP=' + iP + ' (expected t.id), tP=' + tP + ' (expected null)' };
      })()` },
  ],
  m1TiePendingStub: [
    { name: 'data-pending-tie present on note',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const stub = doc.querySelector('note[data-pending-tie="true"]');
        return stub
          ? { ok: true }
          : { ok: false, detail: 'no pending-tie stub note' };
      })()` },
    { name: 'no @tie on stub (only data-pending-tie)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tied = doc.querySelectorAll('note[tie]');
        return tied.length === 0
          ? { ok: true }
          : { ok: false, detail: tied.length + ' notes have @tie (expected 0)' };
      })()` },
  ],
  m1TieOrphanForward: [
    { name: 'first note demoted to pending stub after partner deleted',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tied = doc.querySelectorAll('note[tie]');
        const stubs = doc.querySelectorAll('note[data-pending-tie="true"]');
        return tied.length === 0 && stubs.length === 1
          ? { ok: true }
          : { ok: false, detail: 'tied=' + tied.length + ' stubs=' + stubs.length };
      })()` },
  ],
  m1TieCrossBarSplit: [
    { name: '2-piece chain: i + t with forward partner',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const i = doc.querySelector('note[tie="i"]');
        const t = doc.querySelector('note[tie="t"]');
        if (!i || !t) return { ok: false, detail: 'missing i or t' };
        const iP = i.getAttribute('data-tie-partner');
        return iP === t.getAttribute('xml:id')
          ? { ok: true }
          : { ok: false, detail: 'i.partner=' + iP + ' expected t.id' };
      })()` },
  ],
  m1TieThreePieceChain: [
    { name: '3-piece chain forms i → m → t with valid forward links',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tied = Array.from(doc.querySelectorAll('note[tie]'));
        if (tied.length < 3) return { ok: false, detail: 'expected 3+ tied notes, got ' + tied.length };
        const i = tied.find((n) => n.getAttribute('tie') === 'i');
        const t = tied.find((n) => n.getAttribute('tie') === 't');
        const ms = tied.filter((n) => n.getAttribute('tie') === 'm');
        if (!i || !t || ms.length < 1) {
          return { ok: false, detail: 'tags: ' + tied.map((n) => n.getAttribute('tie')).join(',') };
        }
        /* Verify the chain links forward end-to-end. */
        let cur = i;
        const seen = new Set();
        while (cur) {
          if (seen.has(cur)) return { ok: false, detail: 'cycle in chain' };
          seen.add(cur);
          const pid = cur.getAttribute('data-tie-partner');
          if (!pid) {
            if (cur === t) break;
            return { ok: false, detail: 'mid-chain note ' + cur.getAttribute('xml:id') + ' missing partner' };
          }
          cur = doc.querySelector('[*|id="' + pid + '"]');
        }
        return { ok: true };
      })()` },
  ],
  m1TieDeleteInitiatorFromSplit: [
    { name: 'after deleting i-note, survivor is clean stub (no @tie, no partner)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tied = doc.querySelectorAll('note[tie]');
        const stubs = doc.querySelectorAll('note[data-pending-tie="true"]');
        return tied.length === 0 && stubs.length === 1
          ? { ok: true }
          : { ok: false, detail: 'tied=' + tied.length + ' stubs=' + stubs.length };
      })()` },
  ],
  m1TieDeleteMiddleFromSplit: [
    { name: 'after deleting middle m, chain compacts (no dangling partner)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tied = Array.from(doc.querySelectorAll('note[tie]'));
        /* Verify every i/m has a partner that exists. */
        for (const n of tied) {
          const tie = n.getAttribute('tie');
          if (tie === 'i' || tie === 'm') {
            const pid = n.getAttribute('data-tie-partner');
            if (!pid) return { ok: false, detail: n.getAttribute('xml:id') + ' @tie=' + tie + ' no partner' };
            const p = doc.querySelector('[*|id="' + pid + '"]');
            if (!p) return { ok: false, detail: n.getAttribute('xml:id') + ' dangling partner ' + pid };
          }
        }
        return { ok: true };
      })()` },
  ],
  m1TieToggleOnTerminal: [
    { name: 'chain extends to length 3 (i, m, t)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tags = Array.from(doc.querySelectorAll('note[tie]')).map((n) => n.getAttribute('tie'));
        return tags.length === 3 && tags[0] === 'i' && tags[1] === 'm' && tags[2] === 't'
          ? { ok: true }
          : { ok: false, detail: 'tags=' + JSON.stringify(tags) };
      })()` },
    { name: 'm note has forward partner pointing at t',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const mNote = doc.querySelector('note[tie="m"]');
        const tNote = doc.querySelector('note[tie="t"]');
        if (!mNote || !tNote) return { ok: false, detail: 'missing m or t' };
        return mNote.getAttribute('data-tie-partner') === tNote.getAttribute('xml:id')
          ? { ok: true }
          : { ok: false, detail: 'm.partner=' + mNote.getAttribute('data-tie-partner') };
      })()` },
  ],
  m1TieToggleOnTerminalNoPartner: [
    { name: 'terminal note carries both @tie="t" AND pending stub',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const ts = Array.from(doc.querySelectorAll('note[tie="t"]'));
        if (ts.length !== 1) return { ok: false, detail: 'expected 1 t-note, got ' + ts.length };
        const t = ts[0];
        const pending = t.hasAttribute('data-pending-tie');
        return pending
          ? { ok: true }
          : { ok: false, detail: 't-note has no data-pending-tie' };
      })()` },
    { name: 'pending stub has corresponding <lv> element in its measure',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const t = doc.querySelector('note[tie="t"][data-pending-tie="true"]');
        if (!t) return { ok: false, detail: 'no t+pending note' };
        const measure = t.closest('measure');
        const id = t.getAttribute('xml:id');
        const lv = measure?.querySelector('lv[startid="#' + id + '"]');
        return lv ? { ok: true } : { ok: false, detail: 'no <lv> for ' + id };
      })()` },
  ],

  /* Tuplet rejection cases. */
  m1TripletInsideTriplet: [
    { name: 'nested-tuplet creation rejected',
      expr: `(() => {
        const r = window.__tupletNestResult;
        return r && r.ok === false
          ? { ok: true }
          : { ok: false, detail: 'expected rejected, got ' + JSON.stringify(r) };
      })()` },
    { name: 'only one tuplet exists in doc',
      expr: `(() => {
        const ts = window.__hkl_composer.model.getDoc().querySelectorAll('tuplet');
        return ts.length === 1
          ? { ok: true }
          : { ok: false, detail: ts.length + ' tuplets (expected 1)' };
      })()` },
  ],
  m1TupletExceedsMeasure: [
    { name: 'oversized tuplet creation rejected',
      expr: `(() => {
        const r = window.__tupletOverflowResult;
        return r && r.ok === false
          ? { ok: true }
          : { ok: false, detail: 'expected rejected, got ' + JSON.stringify(r) };
      })()` },
    { name: 'no tuplet exists in doc',
      expr: `(() => {
        const ts = window.__hkl_composer.model.getDoc().querySelectorAll('tuplet');
        return ts.length === 0
          ? { ok: true }
          : { ok: false, detail: ts.length + ' tuplets (expected 0)' };
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
    { name: 'set-song-key broadcast carries A spine coords (r=0)',
      expr: `(() => {
        const msgs = window.__bridgeMock.captured().filter((m) => m.type === 'set-song-key');
        if (msgs.length === 0) return { ok: false, detail: 'no set-song-key captured' };
        const last = msgs[msgs.length - 1];
        return last.r === 0
          ? { ok: true, detail: 'q=' + last.q + ' r=' + last.r }
          : { ok: false, detail: 'q=' + last.q + ' r=' + last.r + ' (expected r=0)' };
      })()` },
  ],
  keyModeMinor_7s_BroadcastsAsharp: [
    { name: 'set-song-key broadcast carries a♯ spine coords (r=7)',
      expr: `(() => {
        const msgs = window.__bridgeMock.captured().filter((m) => m.type === 'set-song-key');
        if (msgs.length === 0) return { ok: false, detail: 'no set-song-key captured' };
        const last = msgs[msgs.length - 1];
        return last.r === 7
          ? { ok: true, detail: 'q=' + last.q + ' r=' + last.r }
          : { ok: false, detail: 'q=' + last.q + ' r=' + last.r + ' (expected r=7)' };
      })()` },
  ],
  keyModeMajor_3s_BroadcastsA: [
    { name: 'set-song-key broadcast carries A spine coords (r=0) for A major',
      expr: `(() => {
        const msgs = window.__bridgeMock.captured().filter((m) => m.type === 'set-song-key');
        if (msgs.length === 0) return { ok: false, detail: 'no set-song-key captured' };
        const last = msgs[msgs.length - 1];
        return last.r === 0
          ? { ok: true, detail: 'q=' + last.q + ' r=' + last.r }
          : { ok: false, detail: 'q=' + last.q + ' r=' + last.r + ' (expected r=0)' };
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

  /* Keystroke-driven (INPUT-layer) assertions. */
  kbd_durationDigits: [
    { name: '4 quarter rests after typing 5 5 5 5',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rests = Array.from(m.getDoc().querySelectorAll('rest'));
        const durs = rests.map((r) => r.getAttribute('dur'));
        const expected = ['4', '4', '4', '4'];
        return rests.length === 4 && expected.every((d, i) => durs[i] === d)
          ? { ok: true }
          : { ok: false, detail: 'durs=' + JSON.stringify(durs) };
      })()` },
  ],
  kbd_dotCycle: [
    { name: 'quarter rest with one dot exists',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const r = m.getDoc().querySelector('rest[dur="4"][dots="1"]');
        return r ? { ok: true } : { ok: false, detail: 'no quarter rest with dots=1' };
      })()` },
  ],
  kbd_ctrlNavBarJump: [
    { name: 'cursor landed at the M_1/M_2 barline (smallest boundary > 2)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const boundaries = m.measureBoundaryCursors(1);
        const target = boundaries.find(b => b > 2);
        return m.getCursor(1) === target
          ? { ok: true }
          : { ok: false, detail: 'cursor=' + m.getCursor(1) + ' expected=' + target + ' boundaries=' + JSON.stringify(boundaries) };
      })()` },
  ],
  kbd_ctrlRight_landsAtBarline_notPastFirstNote: [
    { name: 'cursor tstamp equals one full measure (= M_2 barline)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getTickPositionAt(1, m.getCursor(1));
        const measureT = m.measureTicks();
        return Math.abs(t - measureT) < 1e-6
          ? { ok: true }
          : { ok: false, detail: 'tstamp=' + t + ' measureTicks=' + measureT };
      })()` },
  ],
  kbd_ctrlLeft_staircase_currentThenPrev: [
    { name: 'cursor landed at start of M_1 after two Ctrl+Lefts',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getTickPositionAt(1, m.getCursor(1));
        return Math.abs(t - 0) < 1e-6
          ? { ok: true }
          : { ok: false, detail: 'tstamp=' + t + ' (expected 0 for start of M_1)' };
      })()` },
  ],
  kbd_ctrlRight_emptyNextMeasure: [
    { name: 'cursor advanced past empty M_2 to M_3 barline',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getTickPositionAt(1, m.getCursor(1));
        const measureT = m.measureTicks();
        return Math.abs(t - 2 * measureT) < 1e-6
          ? { ok: true }
          : { ok: false, detail: 'tstamp=' + t + ' expected=' + (2 * measureT) };
      })()` },
  ],
  kbd_voiceCycle: [
    { name: 'voice cycled back to 1 after 5 ArrowUps',
      expr: `(() => {
        /* 5 cycles through 1→2→expr→3→4→1; expr cycle may be a separate
         * cursorMode transition. Accept: ended at voice 1 OR cursorMode
         * changed to expr at one of the intermediate steps. */
        const m = window.__hkl_composer.model;
        const v = m.getCurrentVoice();
        const s = window.__hkl_composer.inputState();
        return v === 1
          ? { ok: true }
          : { ok: false, detail: 'voice=' + v + ' cursorMode=' + s.cursorMode };
      })()` },
  ],
  kbd_voiceCycle_skipsExprWhenMeasureEmpty: [
    { name: 'ArrowDown ×2 from V_1 lands on V_3 in voice mode (expr skipped)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const v = m.getCurrentVoice();
        const s = window.__hkl_composer.inputState();
        return v === 3 && s.cursorMode === 'voice'
          ? { ok: true }
          : { ok: false, detail: 'voice=' + v + ' cursorMode=' + s.cursorMode + ' (expected 3, voice)' };
      })()` },
  ],
  kbd_voiceCycle_entersExprWhenMeasureHasDynamic: [
    { name: 'M_1 contains a <dynam> after Shift+5',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const dyn = m.getDoc().querySelectorAll('dynam');
        return dyn.length === 1
          ? { ok: true }
          : { ok: false, detail: 'expected 1 dynam, got ' + dyn.length };
      })()` },
    { name: 'ArrowDown ×2 from V_1 enters expression mode (not skipped)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'expr'
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode + ' (expected expr)' };
      })()` },
  ],
  kbd_modeToggle: [
    { name: 'mode toggled to overwrite',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.mode === 'overwrite'
          ? { ok: true }
          : { ok: false, detail: 'mode=' + s.mode };
      })()` },
  ],
  kbd_escClearsPending: [
    { name: 'no hairpin exists in doc',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const hp = m.getDoc().querySelectorAll('hairpin');
        return hp.length === 0
          ? { ok: true }
          : { ok: false, detail: hp.length + ' hairpins exist' };
      })()` },
  ],
  kbd_pendingHairpin_cancelOnDigit: [
    { name: 'pendingHairpin cleared by digit',
      expr: `(() => {
        const p = window.__hkl_composer.inputState().pendingHairpin;
        return p === null
          ? { ok: true }
          : { ok: false, detail: 'pending=' + JSON.stringify(p) };
      })()` },
    { name: 'digit fell through and inserted a rest',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rests = [...m.getDoc().querySelectorAll('rest')];
        return rests.length >= 1
          ? { ok: true }
          : { ok: false, detail: 'rests=' + rests.length };
      })()` },
    { name: 'no hairpin committed',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const hp = m.getDoc().querySelectorAll('hairpin');
        return hp.length === 0
          ? { ok: true }
          : { ok: false, detail: hp.length + ' hairpins exist' };
      })()` },
  ],
  kbd_pendingHairpin_preservedOnArrowRight: [
    { name: 'pendingHairpin still set after ArrowRight',
      expr: `(() => {
        const p = window.__hkl_composer.inputState().pendingHairpin;
        return (p && p.form === 'cres')
          ? { ok: true }
          : { ok: false, detail: 'pending=' + JSON.stringify(p) };
      })()` },
    { name: 'cursor advanced one slot',
      expr: `(() => {
        const c = window.__hkl_composer.model.getCursor();
        return c === 1
          ? { ok: true }
          : { ok: false, detail: 'cursor=' + c };
      })()` },
  ],
  kbd_pendingHairpin_cancelOnVoiceCycle: [
    { name: 'pendingHairpin cleared by voice cycle',
      expr: `(() => {
        const p = window.__hkl_composer.inputState().pendingHairpin;
        return p === null
          ? { ok: true }
          : { ok: false, detail: 'pending=' + JSON.stringify(p) };
      })()` },
    { name: 'voice cycled to V_2',
      expr: `(() => {
        const v = window.__hkl_composer.model.getCurrentVoice();
        return v === 2
          ? { ok: true }
          : { ok: false, detail: 'voice=' + v };
      })()` },
  ],
  kbd_statusError_onTieNoNote: [
    { name: 'statusline shows error in red',
      expr: `(() => {
        const el = document.getElementById('composerStatus');
        if (!el) return { ok: false, detail: 'no #composerStatus element' };
        if (!el.classList.contains('status-error')) {
          return { ok: false, detail: 'classList=' + el.className + ' text=' + el.textContent };
        }
        return el.textContent.includes('No tieable note')
          ? { ok: true }
          : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],
  kbd_statusError_clearsOnNextKey: [
    { name: 'statusline cleared to Ready. with no kind class',
      expr: `(() => {
        const el = document.getElementById('composerStatus');
        if (!el) return { ok: false, detail: 'no #composerStatus element' };
        const hasKindClass = el.classList.contains('status-error')
          || el.classList.contains('status-state')
          || el.classList.contains('status-action');
        if (hasKindClass) {
          return { ok: false, detail: 'still has kind class: ' + el.className };
        }
        return el.textContent === 'Ready.'
          ? { ok: true }
          : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],
  kbd_statusAction_pendingHairpinCancel: [
    { name: 'statusline shows post-action in purple',
      expr: `(() => {
        const el = document.getElementById('composerStatus');
        if (!el) return { ok: false, detail: 'no #composerStatus element' };
        if (!el.classList.contains('status-action')) {
          return { ok: false, detail: 'classList=' + el.className + ' text=' + el.textContent };
        }
        return el.textContent.includes('cancelled')
          ? { ok: true }
          : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],
  kbd_statusAction_clearsOnNextKey: [
    { name: 'purple post-action also clears on next keystroke',
      expr: `(() => {
        const el = document.getElementById('composerStatus');
        if (!el) return { ok: false, detail: 'no #composerStatus element' };
        const hasKindClass = el.classList.contains('status-error')
          || el.classList.contains('status-state')
          || el.classList.contains('status-action');
        if (hasKindClass) {
          return { ok: false, detail: 'still has kind class: ' + el.className };
        }
        return el.textContent === 'Ready.'
          ? { ok: true }
          : { ok: false, detail: 'text=' + el.textContent };
      })()` },
  ],

  /* Bridge mock. */
  bridgeHeldKeysReceived: [
    { name: 'Composer received held-keys via bridge',
      expr: `(async () => {
        /* Bridge messages are dispatched on the BroadcastChannel async
         * tick — wait one RAF + microtask for Composer to update. */
        await new Promise((r) => requestAnimationFrame(() => r(true)));
        await Promise.resolve();
        const keys = window.__hkl_composer.getHeldKeys();
        return keys.length === 1 && keys[0].pname === 'a'
          ? { ok: true }
          : { ok: false, detail: 'getHeldKeys()=' + JSON.stringify(keys) };
      })()` },
  ],
  bridgeComposerToHklCapture: [
    { name: 'Composer-emitted request-state captured by mock',
      expr: `(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(true)));
        await Promise.resolve();
        const captured = window.__bridgeMock.captured();
        return captured.some((m) => m.type === 'request-state')
          ? { ok: true }
          : { ok: false, detail: 'captured=' + JSON.stringify(captured.map((c) => c.type)) };
      })()` },
  ],
  space_starts_playback: [
    { name: 'bare Space sends play-score to bridge',
      expr: `(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(true)));
        await Promise.resolve();
        const captured = window.__bridgeMock.captured();
        return captured.some((m) => m.type === 'play-score')
          ? { ok: true }
          : { ok: false, detail: 'captured=' + JSON.stringify(captured.map((c) => c.type)) };
      })()` },
  ],
  space_stops_playback: [
    { name: 'two Spaces send play-score then stop-playback',
      expr: `(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(true)));
        await Promise.resolve();
        const captured = window.__bridgeMock.captured();
        const types = captured.map((c) => c.type);
        const playIdx = types.indexOf('play-score');
        const stopIdx = types.indexOf('stop-playback');
        const ok = playIdx >= 0 && stopIdx > playIdx;
        return ok
          ? { ok: true }
          : { ok: false, detail: 'captured=' + JSON.stringify(types) };
      })()` },
  ],

  /* Scroll-into-view. */
  scrollIntoView_idempotent: [
    { name: 'scroll position unchanged on no-op',
      expr: `(async () => {
        const settled = await window.__waitForScrollSettle(400);
        const pre = window.__preScroll;
        return settled.scrollLeft === pre.l && settled.scrollTop === pre.t
          ? { ok: true }
          : { ok: false, detail: 'pre=' + JSON.stringify(pre) + ' post={l:' + settled.scrollLeft + ',t:' + settled.scrollTop + '}' };
      })()` },
  ],
  scrollIntoView_typingDeep: [
    { name: 'cursor is in viewport after deep edit',
      expr: `(async () => {
        await window.__waitForScrollSettle(1200);
        return window.__test.assertCursorInViewport(0);
      })()` },
  ],

  /* ── Selection fixtures ───────────────────────────────────────────────── */
  sel_beat_enter_shiftLeft: [
    { name: 'cursorMode is select',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'select'
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
    { name: 'single-beat selection: first === origin === last (beat 3 of 4)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') {
          return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        }
        const sel = s.selection;
        return sel.first === sel.origin && sel.last === sel.origin && sel.origin === 3
          ? { ok: true }
          : { ok: false, detail: 'expected first=origin=last=3, got ' + JSON.stringify(sel) };
      })()` },
  ],
  sel_beat_enter_shiftRight: [
    { name: 'single-beat selection: first === origin === last (beat 0)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') {
          return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        }
        const sel = s.selection;
        return sel.first === sel.origin && sel.last === sel.origin && sel.origin === 0
          ? { ok: true }
          : { ok: false, detail: 'expected first=origin=last=0, got ' + JSON.stringify(sel) };
      })()` },
  ],
  sel_beat_grow_right: [
    { name: 'selection spans 2 beats (first=0, last=1)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') {
          return { ok: false, detail: 'no beat selection' };
        }
        const sel = s.selection;
        return sel.first === 0 && sel.last === 1 && sel.origin === 0 && sel.lastMoved === 'last'
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(sel) };
      })()` },
  ],
  sel_beat_shrink_to_origin: [
    { name: 'still in selection mode (no convergence-exit)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'select' && s.selection && s.selection.kind === 'beat'
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode + ' selection=' + JSON.stringify(s.selection) };
      })()` },
    { name: 'shrunk back to single-beat at origin (beat 0)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') {
          return { ok: false, detail: 'no beat selection' };
        }
        const sel = s.selection;
        return sel.first === 0 && sel.last === 0 && sel.origin === 0
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(sel) };
      })()` },
  ],
  sel_beat_ctrlShift_measureBoundary: [
    { name: 'last advanced to the last beat of M_1 (beat 3) — measure boundary at boundaries[4]',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'beat') {
          return { ok: false, detail: 'no beat selection' };
        }
        const sel = s.selection;
        return sel.first === 0 && sel.last === 3 && sel.lastMoved === 'last'
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(sel) };
      })()` },
  ],
  sel_promote_beat_to_measure: [
    { name: 'selection is now measure kind',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.selection && s.selection.kind === 'measure'
          ? { ok: true }
          : { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
      })()` },
  ],
  sel_measure_enter_shiftDown: [
    { name: 'measure selection on M_1, staff 1 only',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'measure') {
          return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        }
        const ok = s.selection.anchorMeasure === 0
          && s.selection.movableMeasure === 0
          && s.selection.firstStaff === 1
          && s.selection.lastStaff === 1
          && s.selection.movableSide === 'unset';
        return ok
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(s.selection) };
      })()` },
  ],
  sel_measure_expand_staves: [
    { name: 'staff range expanded to 1..2',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'measure') {
          return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        }
        return s.selection.firstStaff === 1 && s.selection.lastStaff === 2
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(s.selection) };
      })()` },
  ],
  sel_escape_exits: [
    { name: 'cursorMode is voice after Escape',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'voice' && s.selection === null
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
  ],
  sel_nonsel_key_exits: [
    { name: 'cursorMode is voice after non-selection key',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'voice' && s.selection === null
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
  ],
  sel_beat_cut_replaces_with_rests: [
    { name: 'selection cleared and cursorMode back to voice',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'voice' && s.selection === null
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
    { name: 'V_1 layer still has 4 rests (cut replaced with rests, total preserved)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rests = m.allMeasures()[0].querySelectorAll('staff[n="1"] layer[n="1"] > rest');
        return rests.length === 4
          ? { ok: true }
          : { ok: false, detail: 'rest count = ' + rests.length };
      })()` },
  ],
  sel_beat_backspace_deletes_and_exits: [
    { name: 'selection cleared and cursorMode back to voice',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'voice' && s.selection === null
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
    { name: 'V_1 layer still has 4 rests (Backspace replaced selection with rests, total preserved)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rests = m.allMeasures()[0].querySelectorAll('staff[n="1"] layer[n="1"] > rest');
        return rests.length === 4
          ? { ok: true }
          : { ok: false, detail: 'rest count = ' + rests.length };
      })()` },
  ],
  sel_beat_delete_deletes_and_exits: [
    { name: 'selection cleared and cursorMode back to voice',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'voice' && s.selection === null
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
    { name: 'V_1 layer still has 4 rests (Delete behaves same as Backspace)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rests = m.allMeasures()[0].querySelectorAll('staff[n="1"] layer[n="1"] > rest');
        return rests.length === 4
          ? { ok: true }
          : { ok: false, detail: 'rest count = ' + rests.length };
      })()` },
  ],
  sel_measure_backspace_deletes_and_exits: [
    { name: 'selection cleared and cursorMode back to voice',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return s.cursorMode === 'voice' && s.selection === null
          ? { ok: true }
          : { ok: false, detail: 'cursorMode=' + s.cursorMode };
      })()` },
  ],

  /* Visual selection asserts: cursor hidden in selection mode, and exactly
     one selection rect emitted for a single-measure beat selection. */
  visualSelBeatTwoBeats: [
    { name: 'editing cursor bar is hidden in selection mode',
      expr: `(() => {
        const overlay = document.getElementById('cursorOverlay');
        const bar = overlay?.querySelector('rect[data-cursor-role="voice"]');
        if (!bar) return { ok: false, detail: 'no voice cursor rect' };
        const op = bar.getAttribute('opacity');
        return op === '0'
          ? { ok: true }
          : { ok: false, detail: 'voice cursor opacity=' + op };
      })()` },
    { name: 'no visible text or visible-rect elements anywhere over the score',
      expr: `(() => {
        /* Scan ALL svgs (Verovio's + overlay) for any text with content
         * "V" + digit OR any rect that isn't our selection rect and has
         * non-zero opacity. */
        const score = document.getElementById('score');
        if (!score) return { ok: false, detail: 'no #score' };
        const texts = Array.from(score.querySelectorAll('text'));
        const bad = texts.filter((t) => /^V[1-4]?$/.test((t.textContent ?? '').trim()));
        return bad.length === 0
          ? { ok: true }
          : { ok: false, detail: 'V-labels: ' + bad.map((t) => t.textContent + '@(' + t.getAttribute('x') + ',' + t.getAttribute('y') + ')').join('|') };
      })()` },
    { name: 'exactly one selection rect rendered (single measure / single system)',
      expr: `(() => {
        const rects = document.querySelectorAll('rect[data-selection-rect="true"]');
        return rects.length === 1
          ? { ok: true }
          : { ok: false, detail: 'rect count=' + rects.length };
      })()` },
  ],
  visualSelMeasureBothStaves: [
    { name: 'measure selection spans both staves vertically',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const s = window.__hkl_composer.inputState();
        if (!s.selection || s.selection.kind !== 'measure') {
          return { ok: false, detail: 'selection=' + JSON.stringify(s.selection) };
        }
        return s.selection.firstStaff === 1 && s.selection.lastStaff === 2
          ? { ok: true }
          : { ok: false, detail: 'staves: ' + s.selection.firstStaff + '..' + s.selection.lastStaff };
      })()` },
    { name: 'exactly one selection rect (both staves coalesced)',
      expr: `(() => {
        const rects = document.querySelectorAll('rect[data-selection-rect="true"]');
        return rects.length === 1
          ? { ok: true }
          : { ok: false, detail: 'rect count=' + rects.length };
      })()` },
  ],

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
  playback_advances_over_rest: [
    { name: 'visible rest emits a silent PlaybackEvent (notes:[]) keyed to its xml:id',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const events = window.__hkl_composer.buildPlayback(m);
        /* Three children → three events, in order: note attack, silent rest,
           note attack. Each is a quarter at 120 bpm → 500 ms. */
        if (events.length !== 3) {
          return { ok: false, detail: 'expected 3 events, got ' + events.length +
            ' (' + events.map(e => 'atMs=' + e.atMs + ' dur=' + e.durationMs + ' n=' + e.notes.length).join('; ') + ')' };
        }
        const rest = events[1];
        if (rest.notes.length !== 0)
          return { ok: false, detail: 'event[1] has ' + rest.notes.length + ' notes (expected 0 = silent rest)' };
        if (Math.abs(rest.atMs - 500) > 1e-6)
          return { ok: false, detail: 'event[1] atMs=' + rest.atMs + ' (expected 500)' };
        if (Math.abs(rest.durationMs - 500) > 1e-6)
          return { ok: false, detail: 'event[1] durationMs=' + rest.durationMs + ' (expected 500)' };
        /* meiId must match the actual <rest> element in the doc so HKL's
           ack lands on it and Composer's setPlaybackPosition can find it. */
        const restEl = m.getDoc().querySelector('rest');
        if (!restEl) return { ok: false, detail: 'no <rest> in doc' };
        const restId = restEl.getAttribute('xml:id');
        if (rest.meiId !== restId)
          return { ok: false, detail: 'meiId=' + rest.meiId + ' (expected ' + restId + ')' };
        /* Sandwich notes must still be there at the expected times. */
        if (events[0].notes.length !== 1 || Math.abs(events[0].atMs) > 1e-6)
          return { ok: false, detail: 'event[0] not a note attack at t=0: ' + JSON.stringify(events[0]) };
        if (events[2].notes.length !== 1 || Math.abs(events[2].atMs - 1000) > 1e-6)
          return { ok: false, detail: 'event[2] not a note attack at t=1000: ' + JSON.stringify(events[2]) };
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
  playback_chord_fully_tied: [
    { name: 'every note tied → one coalesced event at t=0 spanning the whole chain',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const events = window.__hkl_composer.buildPlayback(m);
        if (events.length !== 1) {
          return { ok: false, detail: 'expected 1 event, got ' + events.length +
            ' (' + events.map(e => 'atMs=' + e.atMs + ' dur=' + e.durationMs + ' n=' + e.notes.length).join('; ') + ')' };
        }
        const e = events[0];
        if (e.atMs !== 0) return { ok: false, detail: 'event atMs=' + e.atMs + ' (expected 0)' };
        if (e.notes.length !== 3) return { ok: false, detail: 'event has ' + e.notes.length + ' notes (expected 3)' };
        /* Default tempo 120 bpm + quarter beat → 500 ms per quarter; two
           quarters tied = 1000 ms. */
        if (Math.abs(e.durationMs - 1000) > 1e-6) {
          return { ok: false, detail: 'durationMs=' + e.durationMs + ' (expected 1000)' };
        }
        return { ok: true };
      })()` },
  ],
  playback_chord_partial_tie: [
    { name: 'slot 1 splits into two events: tied bass (long) + untied E,G (short)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const events = window.__hkl_composer.buildPlayback(m);
        const atZero = events.filter(e => e.atMs === 0);
        if (atZero.length !== 2) {
          return { ok: false, detail: 'expected 2 events at atMs=0, got ' + atZero.length };
        }
        const long = atZero.find(e => Math.abs(e.durationMs - 1000) < 1e-6);
        const short = atZero.find(e => Math.abs(e.durationMs - 500) < 1e-6);
        if (!long || !short) {
          return { ok: false, detail: 'expected one 1000ms + one 500ms event; got ' +
            atZero.map(e => e.durationMs).join(',') };
        }
        /* Long event = the tied bass C at (-4,-2), alone. */
        if (long.notes.length !== 1 || long.notes[0].q !== -4 || long.notes[0].r !== -2) {
          return { ok: false, detail: 'long event notes=' +
            JSON.stringify(long.notes) + ' (expected [{q:-4,r:-2}])' };
        }
        /* Short event = the un-tied E (1,0) and G (0,1) attacking with their
           own quarter duration. */
        if (short.notes.length !== 2) {
          return { ok: false, detail: 'short event has ' + short.notes.length + ' notes (expected 2)' };
        }
        const coords = short.notes.map(n => n.q + ',' + n.r).sort();
        if (coords[0] !== '0,1' || coords[1] !== '1,0') {
          return { ok: false, detail: 'short event notes=' + coords.join(' | ') + ' (expected 0,1 | 1,0)' };
        }
        return { ok: true };
      })()` },
    { name: 'slot 2 re-attacks E and G; tied bass C does NOT re-attack',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const events = window.__hkl_composer.buildPlayback(m);
        const atOneBeat = events.filter(e => Math.abs(e.atMs - 500) < 1e-6);
        if (atOneBeat.length !== 1) {
          return { ok: false, detail: 'expected 1 event at atMs=500, got ' + atOneBeat.length };
        }
        const ev = atOneBeat[0];
        if (Math.abs(ev.durationMs - 500) > 1e-6) {
          return { ok: false, detail: 'slot-2 event durationMs=' + ev.durationMs + ' (expected 500)' };
        }
        if (ev.notes.length !== 2) {
          return { ok: false, detail: 'slot-2 event has ' + ev.notes.length + ' notes (expected 2: E and G)' };
        }
        const hasBass = ev.notes.some(n => n.q === -4 && n.r === -2);
        if (hasBass) return { ok: false, detail: 'slot-2 event includes tied bass C (should not re-attack)' };
        const coords = ev.notes.map(n => n.q + ',' + n.r).sort();
        if (coords[0] !== '0,1' || coords[1] !== '1,0') {
          return { ok: false, detail: 'slot-2 notes=' + coords.join(' | ') + ' (expected 0,1 | 1,0)' };
        }
        return { ok: true };
      })()` },
  ],
  song_key_csharp_from_empty_voice: [
    { name: 'set-song-key captured; (q,r) gives 12-TET pitch class C# (=1)',
      expr: `(() => {
        const cap = window.__bridgeMock.captured();
        const sk = cap.filter(m => m.type === 'set-song-key');
        if (sk.length === 0) {
          return { ok: false, detail: 'no set-song-key captured; types=' + cap.map(m => m.type).join(',') };
        }
        const last = sk[sk.length - 1];
        /* coordToMidi = 57 + 4q + 7r; pitch class = midi % 12. C# == 1. */
        const midi = 57 + 4 * last.q + 7 * last.r;
        const pc = ((midi % 12) + 12) % 12;
        return pc === 1
          ? { ok: true }
          : { ok: false, detail: '(q,r)=(' + last.q + ',' + last.r + ') → pc=' + pc + ' (expected 1 = C#)' };
      })()` },
    { name: 'chosen (q,r) sits on the qm=0 spine in a central octave',
      expr: `(() => {
        const cap = window.__bridgeMock.captured();
        const sk = cap.filter(m => m.type === 'set-song-key');
        const last = sk[sk.length - 1];
        const qm = ((last.q % 3) + 3) % 3;
        /* keyOctave uses the natural-letter MIDI (strips the accidental). For
         * C# the alter is +1, so natMidi = 57 + 4q + 7r - 1. The picker is
         * required to land in octave 3 or 4 (centrally placed within a band). */
        const natMidi = 57 + 4 * last.q + 7 * last.r - 1;
        const oct = Math.floor(natMidi / 12) - 1;
        if (qm !== 0) return { ok: false, detail: 'qm=' + qm + ' from (' + last.q + ',' + last.r + ') — expected qm=0 spine' };
        if (oct !== 3 && oct !== 4) return { ok: false, detail: 'oct=' + oct + ' from (' + last.q + ',' + last.r + ') — expected 3 or 4' };
        return { ok: true };
      })()` },
    /* Locks in the post-split contract: an empty voice must NOT trigger
     * a set-reference-note broadcast, even when hkl-hello fires the
     * initial broadcast cycle. Catches a regression where the song-key
     * fallback creeps back into the selection-tier channel. */
    { name: 'no set-reference-note captured (empty voice → selection tier silent)',
      expr: `(() => {
        const cap = window.__bridgeMock.captured();
        const ref = cap.filter(m => m.type === 'set-reference-note');
        return ref.length === 0
          ? { ok: true }
          : { ok: false, detail: 'unexpected set-reference-note: ' + JSON.stringify(ref) };
      })()` },
    /* HKL-second-boot symmetry: Composer must rebroadcast composer-hello in
     * response to hkl-hello so HKL flips composerConnected → true (otherwise
     * its toolbar group stays hidden when HKL loads after Composer). */
    { name: 'composer-hello rebroadcast in response to hkl-hello',
      expr: `(() => {
        const cap = window.__bridgeMock.captured();
        const hello = cap.filter(m => m.type === 'composer-hello');
        return hello.length >= 1
          ? { ok: true }
          : { ok: false, detail: 'no composer-hello captured; types=' + cap.map(m => m.type).join(',') };
      })()` },
  ],
  ref_note_broadcast_on_note_insert: [
    { name: 'reference broadcast reflects the just-inserted A note at (0,0)',
      expr: `(() => {
        const cap = window.__bridgeMock.captured();
        const ref = cap.filter(m => m.type === 'set-reference-note');
        if (ref.length === 0) {
          return { ok: false, detail: 'no set-reference-note captured; types=' + cap.map(m => m.type).join(',') };
        }
        const last = ref[ref.length - 1];
        return (last.q === 0 && last.r === 0)
          ? { ok: true }
          : { ok: false, detail: 'expected (0,0), got (' + last.q + ',' + last.r + ')' };
      })()` },
  ],

  /* Export → PDF smoke test. Captures the produced Blob via URL.createObjectURL
   * (the path downloadBlob uses), stubs HTMLAnchorElement.click so no actual
   * file save fires, and verifies the blob's first bytes are the PDF magic
   * header. Exercises the full jspdf + svg2pdf pipeline against a real
   * Verovio-rendered SVG with a colored note. */
  export_pdf_smoke: [
    { name: 'downloadPdf produces a %PDF- blob',
      expr: `(async () => {
        /* Three nested stubs are required to prevent jsPDF from actually
         * writing a file to the user's Downloads folder:
         *   - URL.createObjectURL: capture the Blob but return a fake URL so
         *     no real blob: URL escapes (a real one with anchor.href would
         *     still trigger save on dispatchEvent below).
         *   - HTMLAnchorElement.prototype.click: defense in depth; some
         *     code paths call .click() directly.
         *   - EventTarget.prototype.dispatchEvent: jsPDF's saveAs (jspdf.es.min)
         *     uses anchor.dispatchEvent(new MouseEvent('click')), which is
         *     NOT routed through .click() — without this stub the file lands
         *     in Downloads even with the other two stubs in place.
         * Verified against jspdf 3.0 source in node_modules. */
        const blobs = [];
        const origCreate = URL.createObjectURL;
        URL.createObjectURL = function(b) { blobs.push(b); return 'blob:test-suppressed'; };
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function() { /* no-op */ };
        const origDispatch = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function(ev) {
          /* Suppress click events on anchors (the jsPDF save path) to avoid
           * triggering a real download. Other dispatchEvent calls pass through. */
          if (ev && ev.type === 'click' && this instanceof HTMLAnchorElement) return true;
          return origDispatch.call(this, ev);
        };
        try {
          const handle = window.__hkl_composer;
          const mod = await import('/composer/src/save.ts');
          await mod.downloadPdf(handle.model, handle.renderer.toolkit(), () => handle.reRender());
          const blob = blobs.find(b => b && b.size > 0);
          if (!blob) return { ok: false, detail: 'no blob captured; count=' + blobs.length };
          const head = String.fromCharCode.apply(null, new Uint8Array(await blob.arrayBuffer()).slice(0, 5));
          return head === '%PDF-'
            ? { ok: true, detail: 'size=' + blob.size }
            : { ok: false, detail: 'head=' + head + ' size=' + blob.size };
        } finally {
          URL.createObjectURL = origCreate;
          HTMLAnchorElement.prototype.click = origClick;
          EventTarget.prototype.dispatchEvent = origDispatch;
        }
      })()` },
    /* The on-screen render keeps non-notehead glyphs black via composer.html
     * CSS, but svg2pdf processes a detached SVG so that CSS doesn't reach it.
     * forceNonNoteheadBlack must pin color="#000" on every .stem/.flag/.accid
     * /.ledgerLines/.dots container so currentColor resolves to black on the
     * Verovio-embedded `path {stroke: currentColor}` rule. Test against the
     * setup's #FF4C79 note: render a page via the toolkit, apply the helper,
     * and verify no matching container retains the note's color. */
    { name: 'forceNonNoteheadBlack zeros out non-notehead colors',
      expr: `(async () => {
        const handle = window.__hkl_composer;
        const mod = await import('/composer/src/save.ts');
        const tk = handle.renderer.toolkit();
        const host = document.createElement('div');
        host.innerHTML = tk.renderToSVG(1, {});
        const svg = host.firstElementChild;
        if (!svg) return { ok: false, detail: 'no SVG' };
        mod.forceNonNoteheadBlack(svg);
        const sel = '.stem, .flag, .accid, .ledgerLines, .dots';
        const stale = [];
        for (const el of svg.querySelectorAll(sel)) {
          const c = el.getAttribute('color');
          const f = el.getAttribute('fill');
          if (c !== '#000' || f !== '#000') {
            stale.push(el.getAttribute('class') + ' color=' + c + ' fill=' + f);
          }
        }
        /* Also confirm at least one stem exists (proves the fixture's note
         * inserted correctly — otherwise the test would pass vacuously). */
        const stemCount = svg.querySelectorAll('.stem').length;
        if (stemCount === 0) return { ok: false, detail: 'no .stem in SVG (setup did not produce a note)' };
        return stale.length === 0
          ? { ok: true, detail: 'stems=' + stemCount }
          : { ok: false, detail: 'stale: ' + stale.join(' | ') };
      })()` },
    /* Verovio emits per-note g as [notehead, ..., stem]; SVG z-order is
     * document order so the stem otherwise paints over a colored notehead.
     * liftNoteheadsAbove moves each notehead to be the LAST direct child
     * of its g.note. Assert that order on every single-note g.note in a
     * freshly-rendered page. */
    { name: 'liftNoteheadsAbove puts notehead last in each g.note',
      expr: `(async () => {
        const handle = window.__hkl_composer;
        const mod = await import('/composer/src/save.ts');
        const tk = handle.renderer.toolkit();
        const host = document.createElement('div');
        host.innerHTML = tk.renderToSVG(1, {});
        const svg = host.firstElementChild;
        if (!svg) return { ok: false, detail: 'no SVG' };
        mod.liftNoteheadsAbove(svg);
        const offenders = [];
        const notes = svg.querySelectorAll('g.note');
        for (const note of notes) {
          const head = note.querySelector(':scope > g.notehead');
          if (!head) continue;  /* chord-internal notes may not have stems */
          const last = note.lastElementChild;
          if (last !== head) {
            offenders.push(note.getAttribute('id') + ' last=' + (last && last.getAttribute('class')));
          }
        }
        return notes.length > 0 && offenders.length === 0
          ? { ok: true, detail: 'notes=' + notes.length }
          : { ok: false, detail: 'noteCount=' + notes.length + ' offenders=' + offenders.join(' | ') };
      })()` },
  ],

  /* ── Undo / redo ──────────────────────────────────────────────────────── */
  undo_basic_insert: [
    { name: 'history popped to empty after undo',
      expr: `(() => {
        const h = window.__hkl_composer.history;
        return { ok: !h.canUndo(), detail: 'canUndo=' + h.canUndo() };
      })()` },
    { name: 'model has no real content after undo',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const real = m.getDoc().querySelectorAll('rest:not([data-placeholder=true]):not([data-tuplet-placeholder=true]), note, chord').length;
        return { ok: real === 0, detail: 'realContent=' + real };
      })()` },
  ],

  undo_redo_roundtrip: [
    { name: 'one entry on undo stack after redo',
      expr: `(() => {
        const h = window.__hkl_composer.history;
        return { ok: h.canUndo() && !h.canRedo(),
                 detail: 'canUndo=' + h.canUndo() + ' canRedo=' + h.canRedo() };
      })()` },
    { name: 'one rest in voice 1 after redo',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const real = m.getDoc().querySelectorAll('rest:not([data-placeholder=true]):not([data-tuplet-placeholder=true])').length;
        return { ok: real === 1, detail: 'realRests=' + real };
      })()` },
  ],

  undo_redo_invalidates: [
    { name: 'redo stack cleared by new mutation; final state = half rest',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const h = window.__hkl_composer.history;
        const flat = m.flatChildren(1);
        const realContent = flat.filter(e => e.localName === 'rest' || e.localName === 'note' || e.localName === 'chord');
        if (realContent.length !== 1) return { ok: false, detail: 'content=' + realContent.length };
        const dur = realContent[0].getAttribute('dur');
        return { ok: dur === '2' && !h.canRedo(), detail: 'dur=' + dur + ' canRedo=' + h.canRedo() };
      })()` },
  ],

  undo_tuplet: [
    { name: 'no <tuplet> element after undo',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const t = m.getDoc().querySelectorAll('tuplet');
        return { ok: t.length === 0, detail: 'tupletCount=' + t.length };
      })()` },
  ],

  undo_dot_cycle: [
    { name: 'rest preserved, dots reverted to 0',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const flat = m.flatChildren(1);
        const rests = flat.filter(e => e.localName === 'rest' && e.getAttribute('data-placeholder') !== 'true' && e.getAttribute('data-tuplet-placeholder') !== 'true');
        if (rests.length !== 1) return { ok: false, detail: 'restCount=' + rests.length };
        const dots = rests[0].getAttribute('dots') ?? '0';
        return { ok: dots === '0' || dots === '', detail: 'dots=' + dots };
      })()` },
  ],

  undo_delete: [
    { name: 'two rests back after undo',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const flat = m.flatChildren(1);
        const rests = flat.filter(e => e.localName === 'rest' && e.getAttribute('data-placeholder') !== 'true' && e.getAttribute('data-tuplet-placeholder') !== 'true');
        return { ok: rests.length === 2, detail: 'restCount=' + rests.length };
      })()` },
  ],

  undo_cursor_match: [
    { name: 'cursor restored to before-position (0)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        return { ok: m.getCursor(1) === 0, detail: 'cursor=' + m.getCursor(1) };
      })()` },
  ],

  undo_cursor_moved_away: [
    { name: 'cursor stays where user moved it (clamped)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        /* Before undo: inserted 2 rests (cursor at 2), then ArrowLeft → cursor at 1.
         * Undo removes the second insert; cursor was at 1, MEI is restored, cursor
         * stays at 1 (still valid in restored MEI). */
        return { ok: m.getCursor(1) === 1, detail: 'cursor=' + m.getCursor(1) };
      })()` },
  ],

  undo_stack_stress: [
    { name: 'after 20 redos, voice has 20 rests + (no stack drift)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const h = window.__hkl_composer.history;
        const flat = m.flatChildren(1);
        const rests = flat.filter(e => e.localName === 'rest' && e.getAttribute('data-placeholder') !== 'true' && e.getAttribute('data-tuplet-placeholder') !== 'true');
        return { ok: rests.length === 20 && !h.canRedo(),
                 detail: 'restCount=' + rests.length + ' canRedo=' + h.canRedo() };
      })()` },
  ],

  undo_redo_shiftZ_alias: [
    { name: 'Ctrl+Shift+Z redoes (one rest in voice 1)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const real = m.getDoc().querySelectorAll('rest:not([data-placeholder=true]):not([data-tuplet-placeholder=true])').length;
        return { ok: real === 1, detail: 'realRests=' + real };
      })()` },
  ],

  undo_multi_voice: [
    { name: 'V2 has no real content; focus stays in V1',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        /* Count <rest> elements inside V2 layers (layer @n="2"), excluding placeholders. */
        const doc = m.getDoc();
        let v2Real = 0;
        for (const layer of doc.querySelectorAll('layer[n="2"]')) {
          for (const c of layer.children) {
            if (c.localName === 'rest' && c.getAttribute('data-placeholder') !== 'true' && c.getAttribute('data-tuplet-placeholder') !== 'true') v2Real++;
            else if (c.localName === 'note' || c.localName === 'chord') v2Real++;
          }
        }
        return { ok: v2Real === 0 && m.getCurrentVoice() === 1,
                 detail: 'V2.real=' + v2Real + ' voice=' + m.getCurrentVoice() };
      })()` },
  ],

  undo_cut_restores_source_sel: [
    { name: 'cut content restored and source beat-selection re-entered',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const inp = window.__hkl_composer.inputState();
        /* Four quarter rests should be back in V1. */
        const flat = m.flatChildren(1);
        const realRests = flat.filter(e => e.localName === 'rest' && e.getAttribute('data-placeholder') !== 'true' && e.getAttribute('data-tuplet-placeholder') !== 'true');
        if (realRests.length !== 4) return { ok: false, detail: 'restCount=' + realRests.length };
        if (inp.cursorMode !== 'select') return { ok: false, detail: 'cursorMode=' + inp.cursorMode };
        if (!inp.selection || inp.selection.kind !== 'beat') return { ok: false, detail: 'sel=' + JSON.stringify(inp.selection) };
        return { ok: inp.selection.first === 0 && inp.selection.last === 1,
                 detail: 'sel=' + inp.selection.first + '..' + inp.selection.last };
      })()` },
  ],
  undo_backspace_selection_restores: [
    { name: 'deleted content restored and source beat-selection re-entered',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const inp = window.__hkl_composer.inputState();
        const flat = m.flatChildren(1);
        const realRests = flat.filter(e => e.localName === 'rest' && e.getAttribute('data-placeholder') !== 'true' && e.getAttribute('data-tuplet-placeholder') !== 'true');
        if (realRests.length !== 4) return { ok: false, detail: 'restCount=' + realRests.length };
        if (inp.cursorMode !== 'select') return { ok: false, detail: 'cursorMode=' + inp.cursorMode };
        if (!inp.selection || inp.selection.kind !== 'beat') return { ok: false, detail: 'sel=' + JSON.stringify(inp.selection) };
        return { ok: inp.selection.first === 0 && inp.selection.last === 1,
                 detail: 'sel=' + inp.selection.first + '..' + inp.selection.last };
      })()` },
  ],

  /* Help modal. */
  help_button_opens_modal: [
    { name: 'helpDialog.open === true',
      expr: `(() => {
        const dlg = document.getElementById('helpDialog');
        return { ok: !!(dlg && dlg.open), detail: 'open=' + (dlg && dlg.open) };
      })()` },
    { name: 'rendered body contains a known binding key',
      expr: `(() => {
        const dlg = document.getElementById('helpDialog');
        const txt = dlg ? dlg.textContent || '' : '';
        const hasCtrl = txt.includes('Ctrl+2 .. Ctrl+7');
        const hasShiftDigit = txt.includes('Shift+1 .. Shift+8');
        return { ok: hasCtrl && hasShiftDigit,
                 detail: 'hasCtrl=' + hasCtrl + ' hasShiftDigit=' + hasShiftDigit };
      })()` },
    { name: 'all KEYBINDINGS sections rendered as <section>',
      expr: `(() => {
        const dlg = document.getElementById('helpDialog');
        const sections = dlg ? dlg.querySelectorAll('section.help-section').length : 0;
        return { ok: sections >= 5, detail: 'sectionCount=' + sections };
      })()` },
  ],
  help_modal_esc_closes: [
    { name: 'helpDialog.open === false after Escape',
      expr: `(() => {
        const dlg = document.getElementById('helpDialog');
        return { ok: !!dlg && !dlg.open, detail: 'open=' + (dlg && dlg.open) };
      })()` },
  ],

  /* ── Phase 1: double bar `]` ─────────────────────────────────────────── */
  phase1_dblbar_toggle_on_m1_of_2: [
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
  phase1_dblbar_toggle_off: [
    { name: 'two `]` presses clear @right; M_2 still @right="end"',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        return (ms[0].getAttribute('right') === null && ms[1].getAttribute('right') === 'end')
          ? { ok: true }
          : { ok: false, detail: 'm1=' + ms[0].getAttribute('right') + ' m2=' + ms[1].getAttribute('right') };
      })()` },
  ],
  phase1_dblbar_lastMeasure_noop: [
    { name: '`]` on last (only) measure is rejected; @right="end" preserved',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const ms = m.allMeasures();
        return (ms.length === 1 && ms[0].getAttribute('right') === 'end')
          ? { ok: true }
          : { ok: false, detail: 'len=' + ms.length + ' right=' + ms[0].getAttribute('right') };
      })()` },
  ],

  /* ── Phase 1: hide rest `H` ─────────────────────────────────────────── */
  phase1_hideRest_toggle_on: [
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
  phase1_hideRest_toggle_off: [
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
  phase1_hideRest_onNote_noop: [
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

  /* ── Phase 1: parenthetical cautionary accidental `P` ────────────────── */
  phase1_parenCaut_bareNote_on: [
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
  phase1_parenCaut_preserves_heji: [
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
  phase1_parenCaut_toggle_off: [
    { name: '@hkl-paren-caut removed after second P',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const note = m.getDoc().querySelector('note');
        return note && !note.hasAttribute('hkl-paren-caut')
          ? { ok: true } : { ok: false, detail: 'attr=' + note?.getAttribute('hkl-paren-caut') };
      })()` },
  ],
  phase1_parenCaut_chord_all: [
    { name: 'every chord note has @hkl-paren-caut="true"',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = [...m.getDoc().querySelectorAll('chord note')];
        if (notes.length !== 3) return { ok: false, detail: 'noteCount=' + notes.length };
        const allOn = notes.every(n => n.getAttribute('hkl-paren-caut') === 'true');
        return allOn ? { ok: true } : { ok: false, detail: 'flags=' + notes.map(n => n.getAttribute('hkl-paren-caut')).join(',') };
      })()` },
  ],
  phase1_parenCaut_chord_singleViaAltSel: [
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
  phase1_parenCaut_onRest_noop: [
    { name: 'rest has no @hkl-paren-caut',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rest = m.getDoc().querySelector('rest');
        return rest && !rest.hasAttribute('hkl-paren-caut')
          ? { ok: true } : { ok: false, detail: 'attr=' + rest?.getAttribute('hkl-paren-caut') };
      })()` },
  ],

  /* ── Phase 1: playback navigation (Ctrl/plain arrows during playback) ── */
  phase1_playback_plainArrow_stopsAtHead: [
    { name: 'isPlaying = false after plain ArrowRight',
      expr: `(() => {
        const playing = window.__hkl_composer.inputState; /* indirect — check via button class */
        const btn = document.getElementById('btnPlay');
        const stillPlaying = btn?.classList.contains('playing') ?? null;
        return stillPlaying === false ? { ok: true } : { ok: false, detail: 'btn.playing=' + stillPlaying };
      })()` },
    { name: 'cursor parked at second rest (the simulated playback head)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const rests = [...m.getDoc().querySelectorAll('rest')];
        const secondId = rests[1].getAttribute('xml:id');
        const flat = m.flatChildren(1);
        const idx = flat.findIndex(e => e.getAttribute('xml:id') === secondId);
        const cur = m.getCursor(1);
        return cur === idx ? { ok: true } : { ok: false, detail: 'cur=' + cur + ' want=' + idx };
      })()` },
  ],
  phase1_playback_ctrlArrow_seeks: [
    { name: 'isPlaying = true after Ctrl+ArrowRight (playback continues, just at new offset)',
      expr: `(() => {
        const btn = document.getElementById('btnPlay');
        const stillPlaying = btn?.classList.contains('playing') ?? null;
        return stillPlaying === true ? { ok: true } : { ok: false, detail: 'btn.playing=' + stillPlaying };
      })()` },
    { name: 'cursor advanced to the M_1→M_2 boundary',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const boundaries = m.measureBoundaryCursors(1);
        const cur = m.getCursor(1);
        return boundaries.includes(cur) && cur > 2
          ? { ok: true } : { ok: false, detail: 'cur=' + cur + ' boundaries=' + boundaries.join(',') };
      })()` },
    { name: 'bridge captured both stop-playback and play-score (audio actually seeks)',
      expr: `(() => {
        const captured = window.__bridgeMock.captured();
        const hasStop = captured.some(e => e.type === 'stop-playback');
        const hasPlay = captured.some(e => e.type === 'play-score');
        return (hasStop && hasPlay)
          ? { ok: true }
          : { ok: false, detail: 'types=' + captured.map(e => e.type).join(',') };
      })()` },
  ],
  phase1_playback_ctrlLeft_atBoundary_jumpsPrev: [
    { name: 'cursor lands at the start of M_1 (= boundary 0), not M_2',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const boundaries = m.measureBoundaryCursors(1);
        const cur = m.getCursor(1);
        return cur === boundaries[0]
          ? { ok: true } : { ok: false, detail: 'cur=' + cur + ' boundaries=' + boundaries.join(',') };
      })()` },
  ],
  phase1_playback_ctrlLeft_midMeasure_jumpsCurrent: [
    { name: 'cursor lands at the start of M_2 (= boundary[1]), not M_1',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const boundaries = m.measureBoundaryCursors(1);
        const cur = m.getCursor(1);
        return cur === boundaries[1]
          ? { ok: true } : { ok: false, detail: 'cur=' + cur + ' boundaries=' + boundaries.join(',') };
      })()` },
  ],
  phase1_playback_ctrlArrow_seeks_repeatable: [
    { name: 'after TWO Ctrl+→ in playback, isPlaying still true',
      expr: `(() => {
        const btn = document.getElementById('btnPlay');
        const stillPlaying = btn?.classList.contains('playing') ?? null;
        return stillPlaying === true ? { ok: true } : { ok: false, detail: 'btn.playing=' + stillPlaying };
      })()` },
    { name: 'cursor advanced by TWO measures from start',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const boundaries = m.measureBoundaryCursors(1);
        const cur = m.getCursor(1);
        /* Started at cursor=0 (= boundary 0); two seeks → boundaries[2]. */
        return cur === boundaries[2]
          ? { ok: true } : { ok: false, detail: 'cur=' + cur + ' boundaries=' + boundaries.join(',') };
      })()` },
    { name: 'bridge captured 2× stop-playback + 2× play-score (each seek is stop+start)',
      expr: `(() => {
        const captured = window.__bridgeMock.captured();
        const stops = captured.filter(e => e.type === 'stop-playback').length;
        const plays = captured.filter(e => e.type === 'play-score').length;
        return (stops === 2 && plays === 2)
          ? { ok: true }
          : { ok: false, detail: 'stops=' + stops + ' plays=' + plays };
      })()` },
  ],
  phase1_playback_staleFinishAck_ignored: [
    { name: 'isPlaying = true after stale playback-finished ack (suppressed by pendingStopAcks)',
      expr: `(() => {
        const btn = document.getElementById('btnPlay');
        const stillPlaying = btn?.classList.contains('playing') ?? null;
        return stillPlaying === true ? { ok: true } : { ok: false, detail: 'btn.playing=' + stillPlaying };
      })()` },
  ],

  /* ── Phase 1: insert measure `Ctrl+M` ───────────────────────────────── */
  phase1_insertMeasure_atStart: [
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
  phase1_insertMeasure_midMeasure: [
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
  phase1_insertMeasure_atFirstNote_insertsAfter: [
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
  phase1_insertMeasure_breaksSlur: [
    { name: 'slur covering M_1 → M_2 was pruned after Ctrl+M between them',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const slurs = m.getDoc().querySelectorAll('slur');
        return slurs.length === 0
          ? { ok: true } : { ok: false, detail: 'slurCount=' + slurs.length };
      })()` },
  ],
  phase1_insertMeasure_breaksTie: [
    { name: 'realized tie chain (@tie attrs) is gone after insertion',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const tied = m.getDoc().querySelectorAll('note[tie]');
        return tied.length === 0
          ? { ok: true } : { ok: false, detail: 'tiedCount=' + tied.length };
      })()` },
  ],

  /* ── Phase 1: stem dir `L` + slur dir `Shift+L` ──────────────────────── */
  phase1_stemFlip_bareNote_freezes: [
    { name: 'note has @stem.dir set to "up" or "down" (opposite of natural)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const note = m.getDoc().querySelector('note');
        const d = note?.getAttribute('stem.dir');
        return (d === 'up' || d === 'down') ? { ok: true } : { ok: false, detail: 'stem.dir=' + d };
      })()` },
  ],
  phase1_stemFlip_secondPress_unfreezes: [
    { name: 'second L clears @stem.dir',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const note = m.getDoc().querySelector('note');
        return note && !note.hasAttribute('stem.dir')
          ? { ok: true } : { ok: false, detail: 'stem.dir=' + note?.getAttribute('stem.dir') };
      })()` },
  ],
  phase1_stemFlip_beamGroup_allFlip: [
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
  phase1_stemFlip_respectsBeamBreak: [
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
  phase1_slurFlip_setsAttr: [
    { name: 'slur has @curvedir set to "above" or "below"',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const slur = m.getDoc().querySelector('slur');
        const d = slur?.getAttribute('curvedir');
        return (d === 'above' || d === 'below') ? { ok: true } : { ok: false, detail: 'curvedir=' + d };
      })()` },
  ],

  /* ── Phase 1: beam split `/` ────────────────────────────────────────── */
  phase1_beamSplit_marksThird: [
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
  phase1_beamSplit_toggleOff: [
    { name: '@hkl-beam-break absent after second `/`',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const notes = [...m.getDoc().querySelectorAll('layer > note')];
        return notes[2] && !notes[2].hasAttribute('hkl-beam-break')
          ? { ok: true } : { ok: false, detail: 'attr=' + notes[2]?.getAttribute('hkl-beam-break') };
      })()` },
  ],
  phase1_beamSplit_onRest_noop: [
    { name: 'no element has @hkl-beam-break',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const flagged = m.getDoc().querySelectorAll('[hkl-beam-break="true"]');
        return flagged.length === 0
          ? { ok: true } : { ok: false, detail: 'flaggedCount=' + flagged.length };
      })()` },
  ],
  phase1_beamSplit_overridesBeatBoundary: [
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

  /* ── Phase 1: articulations S/A/T/F/B ─────────────────────────────── */
  phase1_artic_staccato_on_note: [
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
  phase1_artic_accent_on_note: [
    { name: 'note has child <artic @artic="acc"> (MEI accent value)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const articEls = m.getDoc().querySelectorAll('note > artic[artic="acc"]');
        return articEls.length === 1 ? { ok: true } : { ok: false, detail: 'count=' + articEls.length };
      })()` },
  ],
  phase1_artic_tenuto_on_note: [
    { name: 'note has child <artic @artic="ten">',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const articEls = m.getDoc().querySelectorAll('note > artic[artic="ten"]');
        return articEls.length === 1 ? { ok: true } : { ok: false, detail: 'count=' + articEls.length };
      })()` },
  ],
  phase1_artic_fermata_on_note: [
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
  phase1_artic_breath_on_note: [
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
  phase1_artic_fermata_on_rest: [
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
  phase1_artic_staccato_on_rest_noop: [
    { name: 'rest has no <artic> child + no fermata/breath sibling',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const articEls = m.getDoc().querySelectorAll('rest > artic');
        const ctrl = m.getDoc().querySelectorAll('measure > fermata, measure > breath');
        return (articEls.length === 0 && ctrl.length === 0)
          ? { ok: true } : { ok: false, detail: 'articChildren=' + articEls.length + ' siblings=' + ctrl.length };
      })()` },
  ],
  phase1_artic_staccato_toggle_off: [
    { name: 'no <artic> on the note after second S',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const articEls = m.getDoc().querySelectorAll('note > artic[artic="stacc"]');
        return articEls.length === 0 ? { ok: true } : { ok: false, detail: 'count=' + articEls.length };
      })()` },
  ],
  phase1_artic_multiple_stack: [
    { name: 'note carries both stacc and acc (= accent)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const note = m.getDoc().querySelector('note');
        const arts = [...(note?.children ?? [])].filter(c => c.localName === 'artic').map(c => c.getAttribute('artic')).sort();
        return JSON.stringify(arts) === JSON.stringify(['acc', 'stacc'])
          ? { ok: true } : { ok: false, detail: 'arts=' + JSON.stringify(arts) };
      })()` },
  ],
  phase1_artic_accent_playback_velocity: [
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
  phase1_artic_staccato_playback_duration: [
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

  /* ── Phase 1: title block (subtitle + composer + footer) ─────────────── */
  phase1_titleBlock_all_fields: [
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
        const title = document.querySelector('.score-page g.pgHead .text')?.getBoundingClientRect();
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
  phase1_titleBlock_emptyFooter: [
    { name: 'no <text.hkl-injected-footer> when footer is empty',
      expr: `(() => {
        const footer = document.querySelectorAll('.hkl-injected-footer');
        return footer.length === 0 ? { ok: true } : { ok: false, detail: 'count=' + footer.length };
      })()` },
  ],

  /* ── Phase 1: fill incomplete measures ───────────────────────────────── */
  phase1_fillIncomplete_basic: [
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

  /* ── Phase 1: click-to-position ──────────────────────────────────────── */
  phase1_click_movesCursorToNote: [
    { name: 'cursor lands at flat-index of the C# note (the second rendered note)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const flat = m.flatChildren(1);
        /* flat[0] is the measure wrapper; notes occupy flat[1..3]. The 2nd
           rendered note = C# = flat[2]. */
        const csharp = flat.find(e => e.localName === 'note' && e.getAttribute('pname') === 'c');
        const wantIdx = flat.indexOf(csharp);
        const cur = m.getCursor(1);
        return cur === wantIdx ? { ok: true } : { ok: false, detail: 'cur=' + cur + ' want=' + wantIdx };
      })()` },
  ],
  phase1_click_switchesVoice: [
    { name: 'current voice = 3 after clicking the bass-staff note',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const v = m.getCurrentVoice();
        return v === 3 ? { ok: true } : { ok: false, detail: 'voice=' + v };
      })()` },
  ],
  phase1_click_chordInternal_switchesVoice: [
    { name: 'current voice = 3 after clicking a chord-internal note in V_3',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const v = m.getCurrentVoice();
        return v === 3 ? { ok: true } : { ok: false, detail: 'voice=' + v };
      })()` },
    { name: 'cursor at flat-index of the V_3 chord (= 1, past the wrapper at flat[0])',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const flat = m.flatChildren(3);
        const chord = flat.find(e => e.localName === 'chord');
        const wantIdx = flat.indexOf(chord);
        return m.getCursor(3) === wantIdx ? { ok: true } : { ok: false, detail: 'cur=' + m.getCursor(3) + ' want=' + wantIdx };
      })()` },
  ],
};

/** Helper to expand a {name: setup} object into the {name: {setup, tier}} form. */
function mapTier(obj, tier) {
  const out = {};
  for (const [name, setup] of Object.entries(obj)) {
    out[name] = { setup, tier };
  }
  return out;
}

/** Helper for the keystroke-driven KBD object: entries are already
 *  full fixture-spec objects ({setup?, setupKeys}). */
function mapKbdTier(obj, tier) {
  const out = {};
  for (const [name, spec] of Object.entries(obj)) {
    out[name] = { ...spec, tier };
  }
  return out;
}
