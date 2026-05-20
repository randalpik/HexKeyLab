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
   * two measures with content first. */
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

  /* Voice cycle: Up arrow 5 times → 1→2→expr→3→4→1. */
  kbd_voiceCycle: {
    setupKeys: ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp'],
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

export const FIXTURES = {
  ...mapTier(EXISTING, 'fast'),
  ...mapTier(CURSOR_CONVENTION, 'fast'),
  ...mapTier(SINGLE_VOICE, 'fast'),
  ...mapTier(MULTI_VOICE, 'fast'),
  ...mapTier(CTRL_NAV, 'fast'),
  ...mapTier(TIES, 'fast'),
  ...mapTier(TUPLETS, 'fast'),
  ...mapTier(SIG_CHANGES, 'fast'),
  ...mapTier(ROUNDTRIP_STRESS, 'full'),
  ...mapKbdTier(KBD, 'full'),
  ...mapKbdTier(BRIDGE, 'full'),
  ...mapKbdTier(SCROLL, 'full'),
  ...mapKbdTier(VISUAL, 'full'),
};

/** Fixture-specific assertions. Map fixture name → list of {name, expr}.
 *  `expr` is evaluated in the page context post-setup; it must return
 *  { ok: boolean, detail?: string }. Use window.__test.* helpers.
 *
 *  Universal invariants (cursor-trace, no-tie-orphans, placeholder
 *  invariant, no console errors) are applied to EVERY fixture by the
 *  runner — don't repeat them here. */
export const FIXTURE_ASSERTIONS = {
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
    { name: 'cursor jumped to start of next measure',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const target = m.getFirstVisualCursorInMeasure(1, 1);
        return m.getCursor(1) === target
          ? { ok: true }
          : { ok: false, detail: 'cursor=' + m.getCursor(1) + ' expected=' + target };
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
