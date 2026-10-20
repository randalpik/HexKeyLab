// Composer test fixtures — performance.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

/* Trill scenarios (2026-09-20). C5/D5 are the ornament's two cells — the
   selection-mode trill requires a diatonic step — and every pitch carries its
   own color so a mis-keyed identity cannot pass by coincidence. */
const T_C5 = `{ q: 0, r: 0, pname: 'c', accid: '', oct: 5, midi: 72, colorHex: '#ff0000', lightColorHex: '#ff0000', velocity: 80 }`;

const T_D5 = `{ q: 3, r: -1, pname: 'd', accid: '', oct: 5, midi: 74, colorHex: '#00ff00', lightColorHex: '#00ff00', velocity: 80 }`;

const T_E5 = `{ q: 1, r: 0, pname: 'e', accid: '', oct: 5, midi: 76, colorHex: '#0000ff', lightColorHex: '#0000ff', velocity: 80 }`;

const T_F5 = `{ q: 2, r: -1, pname: 'f', accid: '', oct: 5, midi: 77, colorHex: '#ff00ff', lightColorHex: '#ff00ff', velocity: 80 }`;

const T_G3 = `{ q: 0, r: -1, pname: 'g', accid: '', oct: 3, midi: 55, colorHex: '#ffff00', lightColorHex: '#ffff00', velocity: 80 }`;

/* Two quarters collapsed by the selection ornament into a HALF-note trill on
   C5 (upper cell D5) over beats 1–2 of m1, cursor left just past it. */
const TRILL_HEAD = `
  window.__bridgeMock.reset();
  m.setVoice(1); m.setCursor(0, 1);
  m.insertChordAtCursor({ notes: [${T_C5}], duration: '4', dots: 0 });
  m.insertChordAtCursor({ notes: [${T_D5}], duration: '4', dots: 0 });
  m.toggleTrillOrTremoloOnSelection(1, 0, m.getTickPositionAt(1, m.getCursor()));
  m.setCursor(1, 1);
`;

export const FIXTURES = {

  /* ── Performance mode (input-driven playback) ─────────────────────────── */
  /* Two voices: V1 = quarter A3 + quarter E4; V3 = half C4. The matcher's
   * per-voice frontiers are asserted by FIXTURE_ASSERTIONS.perfTwoVoiceFrontier,
   * which drives __performance (start + strikes) and checks independent advance,
   * a no-op on a non-matching strike, per-voice bar clearing, and finish. */
  perfTwoVoiceFrontier: {
    setup: `
      window.__bridgeMock.reset();
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setVoice(3);
      m.setCursor(0, 3);
      m.insertChordAtCursor({ notes: [{ q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '2', dots: 0 });
    `,
  },
  /* Transport-follow: the score-ref tracks the SOUNDING position, not the
     parked editing cursor. M_1 is C major, M_2 is A major; advancing the
     performance bar into M_2 must re-broadcast the A tonic. Driven through
     the __performance hook (synchronous start + strikes). */
  perfScoreRefFollowsPosition: {
    setup: `
      m.setKeySig('0');
      m.setKeyMode('major');
      m.setCursor(0, 1);
      const A3 = { q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', lightColorHex: '#888', velocity: 80 };
      m.insertChordAtCursor({ notes: [A3], duration: '1', dots: 0 });
      m.appendMeasure();
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.insertChordAtCursor({ notes: [A3], duration: '1', dots: 0 });
      m.setKeySigAt(1, '3s', 'major');
      m.setCursor(0, 1);
      window.__hkl_composer.reRender();
      window.__bridgeMock.reset();
    `,
  },
  /* One voice, two quarters (A3, E4): pins the RENDERED bar geometry — the bar
   * starts before the first note and thereafter sits just past the note last
   * played (never on the next one), so its x only ever increases while the
   * score is played in order. Asserted by FIXTURE_ASSERTIONS.perfBarTrailsPlayed. */
  perfBarTrailsPlayed: {
    setup: `
      window.__bridgeMock.reset();
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
  },
  /* One voice, one triad chord [A3, C4, E4]: striking a single member must NOT
   * advance (wait for ALL notes); striking all three advances/finishes.
   * Asserted by FIXTURE_ASSERTIONS.perfChordWaitsForAll. */
  perfChordWaitsForAll: {
    setup: `
      window.__bridgeMock.reset();
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [
        { q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', lightColorHex: '#888', velocity: 80 },
        { q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888', lightColorHex: '#888', velocity: 80 },
        { q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', lightColorHex: '#888', velocity: 80 },
      ], duration: '4', dots: 0 });
    `,
  },
  /* MEASURE GATE — the headline case. V1 has whole notes in m1 and m2 and
   * NOTHING in m3; V3's only note is a whole in m3, deliberately the SAME
   * pitch+color as V1's m1 note. Before the measure gate, striking V1's m1 A3
   * also advanced V3 (its frontier was open from the downbeat) and V3 drew a
   * bar over the whole intro. Asserted by FIXTURE_ASSERTIONS.perfLateVoiceDormant,
   * which also pins the ended-voice bar clearing mid-piece and the end-of-score
   * freeze. */
  perfLateVoiceDormant: {
    setup: `
      window.__bridgeMock.reset();
      m.appendMeasure();
      m.appendMeasure();
      m.setVoice(1);
      m.setCursor(m.getMeasureStartCursor(1, 0), 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 2, pname: 'b', accid: '', oct: 3, midi: 59, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.setVoice(3);
      m.setCursor(m.getMeasureStartCursor(3, 2), 3);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
    `,
  },
  /* MEASURE GATE — mid-piece gap. V1 plays m1/m2/m3; V3 plays m1, is EMPTY in
   * m2 (invisible placeholders), and resumes in m3 with the same pitch as V1's
   * m2 note. V3's bar must disappear for m2, V1's m2 strike must not advance
   * V3, and V3's bar must return only when V3 itself strikes in m3 (no entry
   * cue). Asserted by FIXTURE_ASSERTIONS.perfVoiceRestGapHidesBar. */
  perfVoiceRestGapHidesBar: {
    setup: `
      window.__bridgeMock.reset();
      m.appendMeasure();
      m.appendMeasure();
      m.setVoice(1);
      m.setCursor(m.getMeasureStartCursor(1, 0), 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.setCursor(m.getMeasureStartCursor(1, 2), 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 2, pname: 'b', accid: '', oct: 3, midi: 59, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.setVoice(3);
      m.setCursor(m.getMeasureStartCursor(3, 0), 3);
      m.insertChordAtCursor({ notes: [{ q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.setCursor(m.getMeasureStartCursor(3, 2), 3);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
    `,
  },
  /* MEASURE GATE — a WRITTEN rest is content, so it keeps the voice on stage.
   * V1 plays m1 and m2; V3 plays m1 and has a visible whole REST in m2. When
   * the current measure becomes m2, V3's bar must STAY parked past its m1 note
   * (unlike perfVoiceRestGapHidesBar's empty layer, which hides it) — the
   * isMeasureEmptyInVoice distinction. Asserted by
   * FIXTURE_ASSERTIONS.perfWrittenRestKeepsBar. */
  perfWrittenRestKeepsBar: {
    setup: `
      window.__bridgeMock.reset();
      m.appendMeasure();
      m.setVoice(1);
      m.setCursor(m.getMeasureStartCursor(1, 0), 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 2, pname: 'b', accid: '', oct: 3, midi: 59, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.setVoice(3);
      m.setCursor(m.getMeasureStartCursor(3, 0), 3);
      m.insertChordAtCursor({ notes: [{ q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888', lightColorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
      m.setCursor(m.getMeasureStartCursor(3, 1), 3);
      m.insertRestAtCursor({ duration: '1', dots: 0 });
    `,
  },
  /* PARTIAL TIE — a chord whose members are not ALL tied in. V1: quarter
   * [F3, C4] then quarter [C4, E4], with only the C4 tied across. The tied C4
   * emits no attack, so chord 2 must be satisfied by striking E4 ALONE; chord 1
   * meanwhile splits into two same-onset playback events (F3 at a quarter, C4
   * coalesced to a half through the tie). Every note gets a DISTINCT color
   * on purpose: color is part of the match identity, and the pre-2026-09-20
   * positional color zip handed a note its neighbour's @color as soon as a tie
   * or a duration split desynced event.notes from the element's <note>
   * children — no strike could then satisfy either chord and the voice wedged.
   * Asserted by FIXTURE_ASSERTIONS.perfPartialTieChord. */
  perfPartialTieChord: {
    setup: `
      window.__bridgeMock.reset();
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [
        { q: -1, r: 0, pname: 'f', accid: '', oct: 3, midi: 53, colorHex: '#ff0000', lightColorHex: '#ff0000', velocity: 80 },
        { q: -1, r: 1, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#00ff00', lightColorHex: '#00ff00', velocity: 80 },
      ], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [
        { q: -1, r: 1, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#00ff00', lightColorHex: '#00ff00', velocity: 80 },
        { q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#0000ff', lightColorHex: '#0000ff', velocity: 80 },
      ], duration: '4', dots: 0 });
      /* flat = [wrapper, chord1, chord2]; cursor=1 makes chord1 the toggle
         target, whose DOM order is [F3, C4] — so member index 1 ties the C4
         and only the C4. */
      m.setCursor(1, 1);
      m.toggleTieOnCurrent('insert', 1);
    `,
  },
  /* ORNAMENT AMBIGUITY (2026-09-20). The first six share the half-note trill
   * on C5 (cells C5/D5 = the absorbing set P) over beats 1-2 of m1 and differ
   * only in what follows. See FIXTURE_ASSERTIONS for what each pins.
   *
   * SOLO - resolution D5 (in P) on beat 3, E5 (outside P) on beat 4. Nothing
   * distinguishes the resolution strike from a trill continuation, so the bar
   * must HOLD on the trill through beat 3 and catch up on beat 4. Lagging is
   * the benign direction; running ahead is the failure. */
  perfTrillSoloLags: {
    setup: TRILL_HEAD + `
      m.insertChordAtCursor({ notes: [${T_D5}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_E5}], duration: '4', dots: 0 });
    `,
  },
  /* MULTI-VOICE - the headline case. Same V1, plus V3 on four G3 quarters
   * (outside P). V3's BEAT-2 G3 must NOT lift the shadow (it is before the
   * owed step's onset); V3's BEAT-3 G3 must, landing V1's bar on the
   * resolution exactly when the player resolves. */
  perfTrillLiftsAtResolution: {
    setup: TRILL_HEAD + `
      m.insertChordAtCursor({ notes: [${T_D5}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_E5}], duration: '4', dots: 0 });
      m.setVoice(3);
      m.setCursor(m.getMeasureStartCursor(3, 0), 3);
      m.insertChordAtCursor({ notes: [${T_G3}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_G3}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_G3}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_G3}], duration: '4', dots: 0 });
    `,
  },
  /* CAP + ARRIVAL ORDER - resolution D5 on beat 3, then a chord [D5, F5] on
   * beat 4 mixing a P member with a non-P one. The strikes are simultaneous
   * but ARRIVE in some order; both orders must land identically, which is why
   * the cap suppresses advancing rather than matching - dropping the D would
   * leave the chord permanently one note short. Two fixtures, one setup,
   * because a fixture drives one strike sequence. */
  perfTrillChordCapDFirst: {
    setup: TRILL_HEAD + `
      m.insertChordAtCursor({ notes: [${T_D5}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_D5}, ${T_F5}], duration: '4', dots: 0 });
    `,
  },
  perfTrillChordCapFFirst: {
    setup: TRILL_HEAD + `
      m.insertChordAtCursor({ notes: [${T_D5}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_D5}, ${T_F5}], duration: '4', dots: 0 });
    `,
  },
  /* INERT - the resolution is a chord [D5, F5] with a member OUTSIDE P, so it
   * can never be satisfied by trill strikes alone and no shadow opens: the
   * advance lands exactly on the F5 strike, with no deferral at all. */
  perfTrillResolutionNonP: {
    setup: TRILL_HEAD + `
      m.insertChordAtCursor({ notes: [${T_D5}, ${T_F5}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_E5}], duration: '4', dots: 0 });
    `,
  },
  /* FLUSH ON FINISH - the resolution is the LAST element, so no later strike
   * can ever lift the shadow. Once every voice is done the owed advance must
   * flush, or the bar parks a note short forever. */
  perfTrillFinalResolution: {
    setup: TRILL_HEAD + `
      m.insertChordAtCursor({ notes: [${T_D5}], duration: '4', dots: 0 });
    `,
  },
  /* CROSS-BARLINE - the measure gate and the shadow hand off to each other.
   * A whole-note trill fills m1 and its resolution D5 (in P) opens m2; V3 has
   * TWO halves in m1 and a quarter on the m2 downbeat. While V3 still has an
   * unconsumed m1 half the gate keeps V1 deaf, so the early alternation
   * reaches nothing. Once V3 clears m1 the gate opens and a continuation
   * strike does satisfy the m2 resolution - so the shadow takes over from
   * there, and V3's m2 downbeat lifts it. Pins that the gate alone is NOT a
   * cross-barline guarantee: it holds only while some voice still owes the
   * trill's measure. */
  perfTrillCrossBarHandoff: {
    setup: `
      window.__bridgeMock.reset();
      m.appendMeasure();
      m.setVoice(1); m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [${T_C5}], duration: '2', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_D5}], duration: '2', dots: 0 });
      m.toggleTrillOrTremoloOnSelection(1, 0, m.getTickPositionAt(1, m.getCursor()));
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.insertChordAtCursor({ notes: [${T_D5}], duration: '4', dots: 0 });
      m.setVoice(3);
      m.setCursor(m.getMeasureStartCursor(3, 0), 3);
      m.insertChordAtCursor({ notes: [${T_G3}], duration: '2', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_G3}], duration: '2', dots: 0 });
      m.setCursor(m.getMeasureStartCursor(3, 1), 3);
      m.insertChordAtCursor({ notes: [${T_G3}], duration: '4', dots: 0 });
    `,
  },
  /* EARLIEST ONSET WINS (2026-09-20). V1 plays four distinct quarters; V3's
   * ONLY note is on beat 4 and is deliberately the same pitch+color as V1's
   * BEAT 1. Striking V1's downbeat must not also consume V3's beat-4 entry —
   * the within-measure residue of the bug the measure gate fixed at measure
   * resolution (cf. perfLateVoiceDormant). Asserted by
   * FIXTURE_ASSERTIONS.perfEarliestOnsetWins. */
  perfEarliestOnsetWins: {
    setup: `
      window.__bridgeMock.reset();
      m.setVoice(1); m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [${T_C5}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_D5}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_E5}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_F5}], duration: '4', dots: 0 });
      m.setVoice(3);
      m.setCursor(m.getMeasureStartCursor(3, 0), 3);
      m.insertRestAtCursor({ duration: '2', dots: 0 });
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_C5}], duration: '4', dots: 0 });
    `,
  },
  /* The other half of the same rule: two voices expecting the SAME pitch at
   * the SAME onset converge on one real key press, so one strike must still
   * advance BOTH. V1 and V3 share a C5 downbeat and diverge afterwards.
   * Asserted by FIXTURE_ASSERTIONS.perfSameOnsetUnisonBoth. */
  perfSameOnsetUnisonBoth: {
    setup: `
      window.__bridgeMock.reset();
      m.setVoice(1); m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [${T_C5}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_D5}], duration: '4', dots: 0 });
      m.setVoice(3);
      m.setCursor(m.getMeasureStartCursor(3, 0), 3);
      m.insertChordAtCursor({ notes: [${T_C5}], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [${T_E5}], duration: '4', dots: 0 });
    `,
  },
};

export const ASSERTIONS = {
  /* Performance mode: per-voice frontier matching. Drives the real
   * startPerformance + strike handler synchronously via __performance (the
   * bridge transport is async and wouldn't settle in a sync fixture). Verifies
   * independent per-voice advance, no-op on a non-matching strike, per-voice
   * bar clearing on completion, and overall finish + start/stop-performance
   * bridge sends. */
  perfTwoVoiceFrontier: [
    { name: 'frontier advances per voice; non-match is a no-op; finishes cleanly',
      expr: `(() => {
        const M = window.__hkl_composer;
        const m = M.model;
        const evs = M.buildPlayback(m).filter(e => e.notes.length && e.meiId);
        const v1 = evs.filter(e => e.voice === 1), v3 = evs.filter(e => e.voice === 3);
        if (v1.length !== 2 || v3.length !== 1)
          return { ok: false, detail: 'events v1=' + v1.length + ' v3=' + v3.length + ' (expected 2,1)' };
        const a3 = v1[0].meiId, e4 = v1[1].meiId, c4 = v3[0].meiId;
        /* Use each note's stored @color so the strike identity matches exactly,
           regardless of any hex normalization on insert. pname/accid/oct in the
           strike object are ignored — the matcher recomputes name/oct from q,r. */
        const colorOf = (meiId) => {
          const loc = m.findElement(meiId);
          const el = m.flatChildren(loc.voice)[loc.index];
          const n = el.localName === 'chord' ? el.querySelector('note') : el;
          return n.getAttribute('color');
        };
        const strike = (q, r) => M.__performance.strike(
          { q, r, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: colorOf(a3), lightColorHex: '#888', velocity: 80 });
        const strikeAt = (q, r, color) => M.__performance.strike(
          { q, r, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: color, lightColorHex: '#888', velocity: 80 });
        const at = (v) => { const b = M.__performance.bars()[v]; return b ? b.meiId + '@' + b.edge : 'none'; };
        M.__performance.start();
        if (!M.__performance.isActive()) return { ok: false, detail: 'not active after start' };
        /* Nothing played yet → each voice's bar sits BEFORE its first note. */
        if (at(1) !== a3 + '@left' || at(3) !== c4 + '@left')
          return { ok: false, detail: 'initial bars ' + at(1) + ' / ' + at(3) };
        /* Non-matching strike (B3 = q0,r2): nothing advances. */
        strikeAt(0, 2, colorOf(a3));
        if (at(1) !== a3 + '@left' || at(3) !== c4 + '@left')
          return { ok: false, detail: 'non-match advanced ' + at(1) + ' / ' + at(3) };
        /* Strike A3 → V1's bar trails PAST the A3 it just played (not onto the
           E4 that's next); V3 (expects C4) unaffected. */
        strikeAt(0, 0, colorOf(a3));
        if (at(1) !== a3 + '@right') return { ok: false, detail: 'V1 bar after A3 strike: ' + at(1) };
        if (at(3) !== c4 + '@left') return { ok: false, detail: 'V3 moved on an A3 strike: ' + at(3) };
        /* Strike C4 → V3 done; its bar STAYS past its last note (not cleared). */
        strikeAt(-4, -2, colorOf(c4));
        if (at(3) !== c4 + '@right') return { ok: false, detail: 'V3 bar on finish: ' + at(3) };
        if (at(1) !== a3 + '@right') return { ok: false, detail: 'V1 bar moved on a C4 strike: ' + at(1) };
        if (!M.__performance.isActive()) return { ok: false, detail: 'ended before V1 finished' };
        /* Strike E4 → V1 done → every voice consumed, but the MODE stays on. */
        strikeAt(0, 1, colorOf(e4));
        if (at(1) !== e4 + '@right') return { ok: false, detail: 'V1 bar on finish: ' + at(1) };
        if (!M.__performance.isFinished()) return { ok: false, detail: 'matcher not finished after all steps' };
        if (!M.__performance.isActive()) return { ok: false, detail: 'auto-exited on reaching the end' };
        /* Manual exit is the only exit: the Perform button stops it. */
        document.getElementById('btnPerform').click();
        if (M.__performance.isActive()) return { ok: false, detail: 'Perform button did not stop the mode' };
        return { ok: true, detail: 'trailing per-voice advance + no-op + stays active at end + manual exit' };
      })()` },
  ],
  /* Rendered geometry of the trailing bar: before the first note at the start,
   * then at each played note's RIGHT edge (+CURSOR_HPAD, the same offset the
   * voice cursor uses after entering a note), with x strictly increasing. */
  perfScoreRefFollowsPosition: [
    { name: 'advancing the performance bar into the A-major bar re-broadcasts (0, 0)',
      expr: `(async () => {
        /* BroadcastChannel delivery is asynchronous: the mock only sees a send
           after a turn of the event loop, so captured() must be read behind a
           frame wait, never straight after the strike. */
        const frames = async () => { for (let i = 0; i < 3; i++) { await new Promise((r) => requestAnimationFrame(() => r(true))); await Promise.resolve(); } };
        const M = window.__hkl_composer;
        const m = M.model;
        const evs = M.buildPlayback(m).filter(e => e.notes.length && e.meiId);
        if (evs.length !== 2) return { ok: false, detail: 'playback events=' + evs.length + ' (expected 2)' };
        /* The matcher compares the strike's stored @color, so read it off the
           note rather than passing a literal (see perfTwoVoiceFrontier). */
        const colorOf = (meiId) => {
          const loc = m.findElement(meiId);
          const el = m.flatChildren(loc.voice)[loc.index];
          const n = el.localName === 'chord' ? el.querySelector('note') : el;
          return n.getAttribute('color');
        };
        const strike = (meiId) => M.__performance.strike(
          { q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57,
            colorHex: colorOf(meiId), lightColorHex: '#888', velocity: 80 });
        M.__performance.start();
        window.__bridgeMock.reset();
        strike(evs[0].meiId);   /* completes M_1's whole note */
        strike(evs[1].meiId);   /* advances into M_2 (A major) */
        await frames();
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref captured during performance' };
        const last = sr[sr.length - 1];
        return last.q === 0 && last.r === 0
          ? { ok: true, detail: 'q=' + last.q + ' r=' + last.r }
          : { ok: false, detail: 'q=' + last.q + ' r=' + last.r + ' (expected 0, 0 = A3)' };
      })()` },
  ],
  perfBarTrailsPlayed: [
    { name: 'the bar renders past the note just played, never moving backward',
      expr: `(() => {
        const M = window.__hkl_composer;
        const m = M.model;
        const HPAD = 4;
        const evs = M.buildPlayback(m).filter(e => e.notes.length && e.meiId && e.voice === 1);
        if (evs.length !== 2) return { ok: false, detail: 'expected 2 events, got ' + evs.length };
        const a3 = evs[0].meiId, e4 = evs[1].meiId;
        const colorOf = (meiId) => {
          const loc = m.findElement(meiId);
          const el = m.flatChildren(loc.voice)[loc.index];
          const n = el.localName === 'chord' ? el.querySelector('note') : el;
          return n.getAttribute('color');
        };
        const strike = (q, r, meiId) => M.__performance.strike(
          { q, r, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: colorOf(meiId), lightColorHex: '#888', velocity: 80 });
        const barX = () => {
          const b = document.querySelector('[data-cursor-role="playback"]');
          if (!b || b.getAttribute('opacity') === '0') return null;
          return parseFloat(b.getAttribute('x'));
        };
        M.__performance.start();
        const rA = M.renderer.rectForId(a3), rE = M.renderer.rectForId(e4);
        if (!rA || !rE) return { ok: false, detail: 'notes not rendered' };
        const x0 = barX();
        if (x0 == null) return { ok: false, detail: 'no visible bar after start' };
        if (x0 >= rA.left) return { ok: false, detail: 'initial bar x=' + x0 + ' not before A3 left=' + rA.left };
        strike(0, 0, a3);
        const x1 = barX();
        if (Math.abs(x1 - (rA.right + HPAD)) > 0.5)
          return { ok: false, detail: 'after A3: bar x=' + x1 + ', expected A3.right+HPAD=' + (rA.right + HPAD) + ' (A3.left-4=' + (rA.left - 4) + ', E4.left-4=' + (rE.left - 4) + ')' };
        if (!(x1 > x0)) return { ok: false, detail: 'bar moved backward: ' + x0 + ' -> ' + x1 };
        strike(0, 1, e4);
        const x2 = barX();
        if (Math.abs(x2 - (rE.right + HPAD)) > 0.5)
          return { ok: false, detail: 'after E4: bar x=' + x2 + ', expected E4.right+HPAD=' + (rE.right + HPAD) };
        if (!(x2 > x1)) return { ok: false, detail: 'bar moved backward: ' + x1 + ' -> ' + x2 };
        /* End of score: mode stays on and the bar stays where it is. */
        if (!M.__performance.isActive()) return { ok: false, detail: 'auto-exited at end of score' };
        if (barX() !== x2) return { ok: false, detail: 'bar moved after the last note' };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'bar x ' + x0.toFixed(1) + ' -> ' + x1.toFixed(1) + ' -> ' + x2.toFixed(1) + ' (trailing, monotonic)' };
      })()` },
  ],
  perfChordWaitsForAll: [
    { name: 'a chord advances only when every member is struck',
      expr: `(() => {
        const M = window.__hkl_composer;
        const m = M.model;
        const evs = M.buildPlayback(m).filter(e => e.notes.length && e.meiId);
        const v1 = evs.filter(e => e.voice === 1);
        if (v1.length !== 1) return { ok: false, detail: 'expected 1 chord event, got ' + v1.length };
        const chordId = v1[0].meiId;
        const loc = m.findElement(chordId);
        const el = m.flatChildren(loc.voice)[loc.index];
        const color = el.querySelector('note').getAttribute('color');
        const strike = (q, r) => M.__performance.strike(
          { q, r, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: color, lightColorHex: '#888', velocity: 80 });
        const at = () => { const b = M.__performance.bars()[1]; return b ? b.meiId + '@' + b.edge : 'none'; };
        M.__performance.start();
        if (at() !== chordId + '@left') return { ok: false, detail: 'initial bar ' + at() };
        /* One member (A3): chord incomplete → bar stays BEFORE the chord. */
        strike(0, 0);
        if (M.__performance.isFinished()) return { ok: false, detail: 'finished on a single member' };
        if (at() !== chordId + '@left') return { ok: false, detail: 'advanced on a single member: ' + at() };
        /* Second member (C4): still incomplete. */
        strike(-4, -2);
        if (M.__performance.isFinished()) return { ok: false, detail: 'finished on two of three members' };
        if (at() !== chordId + '@left') return { ok: false, detail: 'advanced on two members: ' + at() };
        /* Third member (E4): chord complete → bar trails past it, mode stays on. */
        strike(0, 1);
        if (!M.__performance.isFinished()) return { ok: false, detail: 'did not finish after all three members' };
        if (at() !== chordId + '@right') return { ok: false, detail: 'bar did not trail the completed chord: ' + at() };
        if (!M.__performance.isActive()) return { ok: false, detail: 'auto-exited on reaching the end' };
        return { ok: true, detail: 'chord waits for all members, then the bar trails it' };
      })()` },
  ],
  /* The headline case: a voice that doesn't enter until m3 must not be expected
   * — or draw a bar — while the player is in m1/m2, even when its entry note is
   * identical to one being played there. Also pins the two consequences of the
   * measure gate: an ended voice's bar clears once the current measure has no
   * content for it, and at the end of the score every bar freezes. */
  perfLateVoiceDormant: [
    { name: 'a late-entering voice is neither expected nor shown until its measure',
      expr: `(() => {
        const M = window.__hkl_composer;
        const m = M.model;
        const colorOf = (meiId) => {
          const loc = m.findElement(meiId);
          const el = m.flatChildren(loc.voice)[loc.index];
          const n = el.localName === 'chord' ? el.querySelector('note') : el;
          return n.getAttribute('color');
        };
        const strikeAt = (q, r, color) => M.__performance.strike(
          { q, r, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: color, lightColorHex: '#888', velocity: 80 });
        const at = (v) => { const b = M.__performance.bars()[v]; return b ? b.meiId + '@' + b.edge : 'none'; };
        const exp = () => M.__performance.expected().slice().sort((a, b) => a - b).join(',');
        const evs = M.buildPlayback(m).filter(e => e.notes.length && e.meiId);
        const v1 = evs.filter(e => e.voice === 1), v3 = evs.filter(e => e.voice === 3);
        if (v1.length !== 2 || v3.length !== 1)
          return { ok: false, detail: 'events v1=' + v1.length + ' v3=' + v3.length + ' (expected 2,1)' };
        const a3 = v1[0].meiId, b3 = v1[1].meiId, a3late = v3[0].meiId;
        M.__performance.start();
        if (!M.__performance.isActive()) return { ok: false, detail: 'not active after start' };
        /* m1: only V1 is in play. V3 (enters m3) has NO bar and is not expected. */
        if (at(1) !== a3 + '@left') return { ok: false, detail: 'V1 initial bar ' + at(1) };
        if (at(3) !== 'none') return { ok: false, detail: 'V3 drew a bar before entering: ' + at(3) };
        if (exp() !== '1') return { ok: false, detail: 'expected voices in m1: ' + exp() };
        /* THE BUG: V3's m3 note is the same pitch+color as V1's m1 A3. This
           strike must advance V1 and ONLY V1. */
        strikeAt(0, 0, colorOf(a3));
        if (at(1) !== a3 + '@right') return { ok: false, detail: 'V1 bar after A3: ' + at(1) };
        if (at(3) !== 'none') return { ok: false, detail: 'V3 claimed an m1 strike: ' + at(3) };
        /* m2 is V1's alone too; a stray A3 reaches nobody. */
        if (exp() !== '1') return { ok: false, detail: 'expected voices in m2: ' + exp() };
        strikeAt(0, 0, colorOf(a3));
        if (at(3) !== 'none') return { ok: false, detail: 'V3 advanced on a stray A3: ' + at(3) };
        /* V1's last note. The current measure becomes m3, which has no V1
           content → V1's bar disappears. V3 is now expected but still shows
           nothing: no entry cue, the bar comes with the strike. */
        strikeAt(0, 2, colorOf(b3));
        if (exp() !== '3') return { ok: false, detail: 'expected voices in m3: ' + exp() };
        if (at(1) !== 'none') return { ok: false, detail: 'ended V1 kept its bar in m3: ' + at(1) };
        if (at(3) !== 'none') return { ok: false, detail: 'V3 was cued before striking: ' + at(3) };
        /* V3 enters: its bar appears trailing the note it just played. */
        strikeAt(0, 0, colorOf(a3late));
        if (at(3) !== a3late + '@right') return { ok: false, detail: 'V3 bar on entry: ' + at(3) };
        if (!M.__performance.isFinished()) return { ok: false, detail: 'not finished after every step' };
        if (!M.__performance.isActive()) return { ok: false, detail: 'auto-exited at end of score' };
        /* End of score: no current measure, so every bar stays put. */
        if (at(3) !== a3late + '@right') return { ok: false, detail: 'V3 bar moved at end: ' + at(3) };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'dormant late voice + no cue + ended-voice bar clears + end freeze' };
      })()` },
  ],
  /* A mid-piece gap is the same problem as a late entry: V3 is empty in m2, so
   * its bar disappears there and V1's m2 note cannot advance it — even though
   * that note is exactly V3's m3 entry pitch. */
  perfVoiceRestGapHidesBar: [
    { name: 'a voice empty in this measure loses its bar and stops listening',
      expr: `(() => {
        const M = window.__hkl_composer;
        const m = M.model;
        const colorOf = (meiId) => {
          const loc = m.findElement(meiId);
          const el = m.flatChildren(loc.voice)[loc.index];
          const n = el.localName === 'chord' ? el.querySelector('note') : el;
          return n.getAttribute('color');
        };
        const strikeAt = (q, r, color) => M.__performance.strike(
          { q, r, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: color, lightColorHex: '#888', velocity: 80 });
        const at = (v) => { const b = M.__performance.bars()[v]; return b ? b.meiId + '@' + b.edge : 'none'; };
        const exp = () => M.__performance.expected().slice().sort((a, b) => a - b).join(',');
        const evs = M.buildPlayback(m).filter(e => e.notes.length && e.meiId);
        const v1 = evs.filter(e => e.voice === 1), v3 = evs.filter(e => e.voice === 3);
        if (v1.length !== 3 || v3.length !== 2)
          return { ok: false, detail: 'events v1=' + v1.length + ' v3=' + v3.length + ' (expected 3,2)' };
        const a3 = v1[0].meiId, e4a = v1[1].meiId, b3 = v1[2].meiId;
        const c4 = v3[0].meiId, e4b = v3[1].meiId;
        M.__performance.start();
        if (at(1) !== a3 + '@left' || at(3) !== c4 + '@left')
          return { ok: false, detail: 'initial bars ' + at(1) + ' / ' + at(3) };
        if (exp() !== '1,3') return { ok: false, detail: 'expected voices in m1: ' + exp() };
        strikeAt(0, 0, colorOf(a3));
        if (at(1) !== a3 + '@right') return { ok: false, detail: 'V1 bar after A3: ' + at(1) };
        if (at(3) !== c4 + '@left') return { ok: false, detail: 'V3 moved on V1 m1: ' + at(3) };
        /* V3 finishes m1 → the current measure becomes m2, where V3 is empty. */
        strikeAt(-4, -2, colorOf(c4));
        if (at(3) !== 'none') return { ok: false, detail: 'V3 kept a bar through its empty m2: ' + at(3) };
        if (exp() !== '1') return { ok: false, detail: 'expected voices in m2: ' + exp() };
        /* V1's m2 note is the SAME pitch as V3's m3 entry — it must not reach V3. */
        strikeAt(0, 1, colorOf(e4a));
        if (at(1) !== e4a + '@right') return { ok: false, detail: 'V1 bar after m2: ' + at(1) };
        if (at(3) !== 'none') return { ok: false, detail: 'V3 claimed V1 m2 strike: ' + at(3) };
        /* m3: V3 is expected again, but still no bar until it plays. */
        if (exp() !== '1,3') return { ok: false, detail: 'expected voices in m3: ' + exp() };
        if (at(3) !== 'none') return { ok: false, detail: 'V3 was cued on re-entry: ' + at(3) };
        strikeAt(0, 1, colorOf(e4b));
        if (at(3) !== e4b + '@right') return { ok: false, detail: 'V3 bar on re-entry: ' + at(3) };
        strikeAt(0, 2, colorOf(b3));
        if (!M.__performance.isFinished()) return { ok: false, detail: 'not finished after every step' };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'bar hides over the gap; the gap note is unclaimable until its measure' };
      })()` },
  ],
  /* The isMeasureEmptyInVoice distinction: a WRITTEN rest is content, so a voice
   * notated tacet for a bar is still on stage and keeps its bar — unlike
   * perfVoiceRestGapHidesBar's empty (invisible-placeholder) layer. */
  perfWrittenRestKeepsBar: [
    { name: 'a written rest keeps the voice on stage, bar and all',
      expr: `(() => {
        const M = window.__hkl_composer;
        const m = M.model;
        const colorOf = (meiId) => {
          const loc = m.findElement(meiId);
          const el = m.flatChildren(loc.voice)[loc.index];
          const n = el.localName === 'chord' ? el.querySelector('note') : el;
          return n.getAttribute('color');
        };
        const strikeAt = (q, r, color) => M.__performance.strike(
          { q, r, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: color, lightColorHex: '#888', velocity: 80 });
        const at = (v) => { const b = M.__performance.bars()[v]; return b ? b.meiId + '@' + b.edge : 'none'; };
        const exp = () => M.__performance.expected().slice().sort((a, b) => a - b).join(',');
        const evs = M.buildPlayback(m).filter(e => e.notes.length && e.meiId);
        const v1 = evs.filter(e => e.voice === 1), v3 = evs.filter(e => e.voice === 3);
        if (v1.length !== 2 || v3.length !== 1)
          return { ok: false, detail: 'events v1=' + v1.length + ' v3=' + v3.length + ' (expected 2,1)' };
        const a3 = v1[0].meiId, b3 = v1[1].meiId, c4 = v3[0].meiId;
        M.__performance.start();
        if (at(1) !== a3 + '@left' || at(3) !== c4 + '@left')
          return { ok: false, detail: 'initial bars ' + at(1) + ' / ' + at(3) };
        strikeAt(0, 0, colorOf(a3));
        strikeAt(-4, -2, colorOf(c4));
        /* V3 has consumed everything it has, and m2 holds only its whole rest —
           it is tacet, not absent, so the bar stays past its last note. */
        if (exp() !== '1') return { ok: false, detail: 'expected voices in m2: ' + exp() };
        if (at(3) !== c4 + '@right')
          return { ok: false, detail: 'V3 bar cleared over a written rest: ' + at(3) };
        strikeAt(0, 2, colorOf(b3));
        if (!M.__performance.isFinished()) return { ok: false, detail: 'not finished after every step' };
        if (at(3) !== c4 + '@right') return { ok: false, detail: 'V3 bar moved at end: ' + at(3) };
        if (at(1) !== b3 + '@right') return { ok: false, detail: 'V1 bar at end: ' + at(1) };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'written rest keeps the bar; empty layer does not' };
      })()` },
  ],
  /* Partial-tie chord: the matcher must expect only the notes that ATTACK.
   * Walks the real strike path over the fixture's two chords. */
  perfPartialTieChord: [
    { name: 'a chord with a tied-in member advances on its NEW notes alone',
      expr: `(() => {
        const M = window.__hkl_composer;
        const m = M.model;
        const flat = m.flatChildren(1);
        const id1 = flat[1].getAttribute('xml:id'), id2 = flat[2].getAttribute('xml:id');
        const noteAt = (fi, ni) => flat[fi].querySelectorAll('note')[ni];
        const colorAt = (fi, ni) => noteAt(fi, ni).getAttribute('color');
        const tieAt = (fi, ni) => noteAt(fi, ni).getAttribute('tie');
        if (tieAt(1, 1) !== 'i' || tieAt(2, 0) !== 't')
          return { ok: false, detail: 'partial tie not formed: ' + tieAt(1, 1) + ' / ' + tieAt(2, 0) };
        if (tieAt(1, 0) !== null || tieAt(2, 1) !== null)
          return { ok: false, detail: 'tie leaked to the untied members' };
        /* Distinct colors are the whole point — a shared color would mask a
           misassignment. */
        const cols = [colorAt(1, 0), colorAt(1, 1), colorAt(2, 1)];
        if (new Set(cols).size !== 3) return { ok: false, detail: 'colors not distinct: ' + cols.join(',') };
        /* Chord 1 splits in two (F3 quarter, C4 half); chord 2 attacks E4 only. */
        const evs = M.buildPlayback(m).filter(e => e.notes.length && e.meiId);
        const shape = evs.map(e => e.notes.map(c => c.q + ',' + c.r).join('+')).join(' | ');
        if (shape !== '-1,0 | -1,1 | 0,1') return { ok: false, detail: 'playback shape: ' + shape };
        const strikeAt = (q, r, color) => M.__performance.strike(
          { q, r, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: color, lightColorHex: '#888', velocity: 80 });
        const at = () => { const b = M.__performance.bars()[1]; return b ? b.meiId + '@' + b.edge : 'none'; };
        M.__performance.start();
        if (at() !== id1 + '@left') return { ok: false, detail: 'initial bar ' + at() };
        /* F3 alone must NOT advance — chord 1 still owes its C4. */
        strikeAt(-1, 0, colorAt(1, 0));
        if (at() !== id1 + '@left') return { ok: false, detail: 'advanced on a partial chord: ' + at() };
        /* C4 completes chord 1. Before the fix its expected color was F3's, so
           nothing could satisfy it and the voice stuck here. */
        strikeAt(-1, 1, colorAt(1, 1));
        if (at() !== id1 + '@right') return { ok: false, detail: 'chord 1 not completed by its two notes: ' + at() };
        /* Re-striking the held/tied C4 at chord 2 is a harmless no-op: it is
           not in chord 2's expected set. */
        strikeAt(-1, 1, colorAt(1, 1));
        if (at() !== id1 + '@right') return { ok: false, detail: 'restruck tied note advanced the voice: ' + at() };
        /* E4 ALONE advances past chord 2 — the tied C4 is never re-expected. */
        strikeAt(0, 1, colorAt(2, 1));
        if (at() !== id2 + '@right')
          return { ok: false, detail: 'tied-in chord did not advance on its new note alone: ' + at() };
        if (!M.__performance.isFinished()) return { ok: false, detail: 'matcher not finished after every step' };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'chord 1 waits for both; chord 2 advances on E4 alone' };
      })()` },
  ],
  /* ORNAMENT AMBIGUITY (2026-09-20). `slotN` below is an index into the
   * voice-1 elements: slot0 = the trill, slot1 = the beat-3 element, slot2 =
   * the beat-4 element. */
  perfTrillSoloLags: [
    { name: 'one strike clears the trill; the bar holds through an in-P resolution, never ahead',
      expr: `(() => {
        const M = window.__hkl_composer, m = M.model;
        const P = M.__performance;
        const N = (q, r, c) => ({ q, r, pname: 'a', accid: '', oct: 4, midi: 60, colorHex: c, lightColorHex: c, velocity: 80 });
        const C5 = N(0, 0, '#ff0000'), D5 = N(3, -1, '#00ff00');
        const E5 = N(1, 0, '#0000ff'), F5 = N(2, -1, '#ff00ff'), G3 = N(0, -1, '#ffff00');
        const ids = m.flatChildren(1).filter(e => e.localName !== 'measure').map(e => e.getAttribute('xml:id'));
        const at = (v) => { const b = P.bars()[v || 1]; return b ? b.meiId + '@' + b.edge : 'none'; };
        const nameOf = (id) => { const i = ids.indexOf(id); return i < 0 ? id : 'slot' + i; };
        const where = (v) => { const b = P.bars()[v || 1]; return b ? nameOf(b.meiId) + '@' + b.edge : 'none'; };

        if (ids.length !== 3) return { ok: false, detail: 'v1 slots=' + ids.length };
        /* The N alternation attacks collapse to ONE step: 3 elements, 3 steps. */
        const evs = M.buildPlayback(m).filter(e => e.notes.length && e.meiId);
        if (evs.filter(e => e.meiId === ids[0]).length < 2)
          return { ok: false, detail: 'trill did not expand; nothing to collapse' };
        P.start();
        if (where() !== 'slot0@left') return { ok: false, detail: 'initial ' + where() };
        P.strike(C5);
        if (where() !== 'slot0@right') return { ok: false, detail: 'one strike did not clear the trill: ' + where() };
        /* Alternation continues; the bar must not budge. */
        P.strike(D5); P.strike(C5); P.strike(D5); P.strike(C5);
        if (where() !== 'slot0@right') return { ok: false, detail: 'trill continuation moved the bar: ' + where() };
        /* Beat 3: the resolution is IN P, so this strike is indistinguishable
           from a continuation. Hold — lagging is benign, ahead is not. */
        P.strike(D5);
        if (where() !== 'slot0@right') return { ok: false, detail: 'ran ahead on an ambiguous resolution: ' + where() };
        /* Beat 4: E5 is outside P and at/after the owed onset → lift, then the
           voice drains, so the bar lands past the note just played. */
        P.strike(E5);
        if (where() !== 'slot2@right') return { ok: false, detail: 'did not catch up on the non-P note: ' + where() };
        if (!P.isFinished()) return { ok: false, detail: 'not finished' };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'held through the resolution, caught up on beat 4' };
      })()` },
  ],
  perfTrillLiftsAtResolution: [
    { name: "another voice's note lifts the shadow at the resolution, but not before it",
      expr: `(() => {
        const M = window.__hkl_composer, m = M.model;
        const P = M.__performance;
        const N = (q, r, c) => ({ q, r, pname: 'a', accid: '', oct: 4, midi: 60, colorHex: c, lightColorHex: c, velocity: 80 });
        const C5 = N(0, 0, '#ff0000'), D5 = N(3, -1, '#00ff00');
        const E5 = N(1, 0, '#0000ff'), F5 = N(2, -1, '#ff00ff'), G3 = N(0, -1, '#ffff00');
        const ids = m.flatChildren(1).filter(e => e.localName !== 'measure').map(e => e.getAttribute('xml:id'));
        const at = (v) => { const b = P.bars()[v || 1]; return b ? b.meiId + '@' + b.edge : 'none'; };
        const nameOf = (id) => { const i = ids.indexOf(id); return i < 0 ? id : 'slot' + i; };
        const where = (v) => { const b = P.bars()[v || 1]; return b ? nameOf(b.meiId) + '@' + b.edge : 'none'; };

        P.start();
        P.strike(C5); P.strike(G3);                    /* beat 1 */
        if (where() !== 'slot0@right') return { ok: false, detail: 'beat1 v1 ' + where() };
        P.strike(D5); P.strike(C5);                    /* trilling */
        /* V3's BEAT-2 note is outside P but BEFORE the owed onset: no lift. */
        P.strike(G3);
        if (where() !== 'slot0@right')
          return { ok: false, detail: 'an earlier non-P note lifted the shadow: ' + where() };
        P.strike(D5);                                  /* still trilling */
        if (where() !== 'slot0@right') return { ok: false, detail: 'bar moved mid-trill: ' + where() };
        /* Beat 3: V1's resolution (absorbed) + V3's G3 AT the owed onset → lift. */
        P.strike(D5); P.strike(G3);
        if (where() !== 'slot1@right')
          return { ok: false, detail: 'no lift at the resolution: ' + where() };
        P.strike(E5); P.strike(G3);                    /* beat 4 */
        if (where() !== 'slot2@right') return { ok: false, detail: 'beat4 ' + where() };
        if (!P.isFinished()) return { ok: false, detail: 'not finished' };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'held past beat 2, lifted exactly at the resolution' };
      })()` },
  ],
  perfTrillChordCapDFirst: [
    { name: 'a P+non-P chord after the shadow completes when its P member arrives FIRST',
      expr: `(() => {
        const M = window.__hkl_composer, m = M.model;
        const P = M.__performance;
        const N = (q, r, c) => ({ q, r, pname: 'a', accid: '', oct: 4, midi: 60, colorHex: c, lightColorHex: c, velocity: 80 });
        const C5 = N(0, 0, '#ff0000'), D5 = N(3, -1, '#00ff00');
        const E5 = N(1, 0, '#0000ff'), F5 = N(2, -1, '#ff00ff'), G3 = N(0, -1, '#ffff00');
        const ids = m.flatChildren(1).filter(e => e.localName !== 'measure').map(e => e.getAttribute('xml:id'));
        const at = (v) => { const b = P.bars()[v || 1]; return b ? b.meiId + '@' + b.edge : 'none'; };
        const nameOf = (id) => { const i = ids.indexOf(id); return i < 0 ? id : 'slot' + i; };
        const where = (v) => { const b = P.bars()[v || 1]; return b ? nameOf(b.meiId) + '@' + b.edge : 'none'; };

        P.start();
        P.strike(C5); P.strike(D5); P.strike(C5);      /* trill; shadow opens */
        if (where() !== 'slot0@right') return { ok: false, detail: 'bar moved mid-trill: ' + where() };
        P.strike(D5);                                  /* beat 3 resolution, absorbed */
        P.strike(D5); P.strike(F5);                    /* beat 4 chord, D first */
        if (where() !== 'slot2@right')
          return { ok: false, detail: 'chord short a note (D dropped while capped): ' + where() };
        if (!P.isFinished()) return { ok: false, detail: 'not finished' };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'D-first completes the chord' };
      })()` },
  ],
  perfTrillChordCapFFirst: [
    { name: 'the same chord completes identically when its non-P member arrives FIRST',
      expr: `(() => {
        const M = window.__hkl_composer, m = M.model;
        const P = M.__performance;
        const N = (q, r, c) => ({ q, r, pname: 'a', accid: '', oct: 4, midi: 60, colorHex: c, lightColorHex: c, velocity: 80 });
        const C5 = N(0, 0, '#ff0000'), D5 = N(3, -1, '#00ff00');
        const E5 = N(1, 0, '#0000ff'), F5 = N(2, -1, '#ff00ff'), G3 = N(0, -1, '#ffff00');
        const ids = m.flatChildren(1).filter(e => e.localName !== 'measure').map(e => e.getAttribute('xml:id'));
        const at = (v) => { const b = P.bars()[v || 1]; return b ? b.meiId + '@' + b.edge : 'none'; };
        const nameOf = (id) => { const i = ids.indexOf(id); return i < 0 ? id : 'slot' + i; };
        const where = (v) => { const b = P.bars()[v || 1]; return b ? nameOf(b.meiId) + '@' + b.edge : 'none'; };

        P.start();
        P.strike(C5); P.strike(D5); P.strike(C5);
        P.strike(D5);
        P.strike(F5); P.strike(D5);                    /* beat 4 chord, F first */
        if (where() !== 'slot2@right')
          return { ok: false, detail: 'F-first landed elsewhere: ' + where() };
        if (!P.isFinished()) return { ok: false, detail: 'not finished' };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'F-first matches D-first' };
      })()` },
  ],
  perfTrillResolutionNonP: [
    { name: 'a resolution with a non-P member never defers: it advances on that strike',
      expr: `(() => {
        const M = window.__hkl_composer, m = M.model;
        const P = M.__performance;
        const N = (q, r, c) => ({ q, r, pname: 'a', accid: '', oct: 4, midi: 60, colorHex: c, lightColorHex: c, velocity: 80 });
        const C5 = N(0, 0, '#ff0000'), D5 = N(3, -1, '#00ff00');
        const E5 = N(1, 0, '#0000ff'), F5 = N(2, -1, '#ff00ff'), G3 = N(0, -1, '#ffff00');
        const ids = m.flatChildren(1).filter(e => e.localName !== 'measure').map(e => e.getAttribute('xml:id'));
        const at = (v) => { const b = P.bars()[v || 1]; return b ? b.meiId + '@' + b.edge : 'none'; };
        const nameOf = (id) => { const i = ids.indexOf(id); return i < 0 ? id : 'slot' + i; };
        const where = (v) => { const b = P.bars()[v || 1]; return b ? nameOf(b.meiId) + '@' + b.edge : 'none'; };

        P.start();
        P.strike(C5); P.strike(D5); P.strike(C5); P.strike(D5);
        /* The chord's D5 is satisfiable from P, but its F5 is not, so the step
           cannot complete on trill strikes and no shadow ever opens. */
        if (where() !== 'slot0@right') return { ok: false, detail: 'moved during the trill: ' + where() };
        P.strike(F5);
        if (where() !== 'slot1@right')
          return { ok: false, detail: 'did not advance on the non-P member: ' + where() };
        P.strike(E5);
        if (where() !== 'slot2@right') return { ok: false, detail: 'beat4 ' + where() };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'inert when the resolution is not wholly inside P' };
      })()` },
  ],
  perfTrillFinalResolution: [
    { name: 'an owed advance flushes once every voice is finished',
      expr: `(() => {
        const M = window.__hkl_composer, m = M.model;
        const P = M.__performance;
        const N = (q, r, c) => ({ q, r, pname: 'a', accid: '', oct: 4, midi: 60, colorHex: c, lightColorHex: c, velocity: 80 });
        const C5 = N(0, 0, '#ff0000'), D5 = N(3, -1, '#00ff00');
        const E5 = N(1, 0, '#0000ff'), F5 = N(2, -1, '#ff00ff'), G3 = N(0, -1, '#ffff00');
        const ids = m.flatChildren(1).filter(e => e.localName !== 'measure').map(e => e.getAttribute('xml:id'));
        const at = (v) => { const b = P.bars()[v || 1]; return b ? b.meiId + '@' + b.edge : 'none'; };
        const nameOf = (id) => { const i = ids.indexOf(id); return i < 0 ? id : 'slot' + i; };
        const where = (v) => { const b = P.bars()[v || 1]; return b ? nameOf(b.meiId) + '@' + b.edge : 'none'; };

        if (ids.length !== 2) return { ok: false, detail: 'v1 slots=' + ids.length };
        P.start();
        P.strike(C5);
        if (where() !== 'slot0@right') return { ok: false, detail: 'trill ' + where() };
        /* This satisfies the final resolution from P. Nothing can ever lift the
           shadow, so the finish-flush must land the bar on it rather than
           leaving it parked a note short for good. */
        P.strike(D5);
        if (!P.isFinished()) return { ok: false, detail: 'matcher not finished' };
        if (where() !== 'slot1@right')
          return { ok: false, detail: 'owed advance never flushed at the end: ' + where() };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'flushed on finish' };
      })()` },
  ],
  perfTrillCrossBarHandoff: [
    { name: 'the measure gate holds only while a voice still owes the trill bar; the shadow covers the rest',
      expr: `(() => {
        const M = window.__hkl_composer, m = M.model;
        const P = M.__performance;
        const N = (q, r, c) => ({ q, r, pname: 'a', accid: '', oct: 4, midi: 60, colorHex: c, lightColorHex: c, velocity: 80 });
        const C5 = N(0, 0, '#ff0000'), D5 = N(3, -1, '#00ff00');
        const E5 = N(1, 0, '#0000ff'), F5 = N(2, -1, '#ff00ff'), G3 = N(0, -1, '#ffff00');
        const ids = m.flatChildren(1).filter(e => e.localName !== 'measure').map(e => e.getAttribute('xml:id'));
        const at = (v) => { const b = P.bars()[v || 1]; return b ? b.meiId + '@' + b.edge : 'none'; };
        const nameOf = (id) => { const i = ids.indexOf(id); return i < 0 ? id : 'slot' + i; };
        const where = (v) => { const b = P.bars()[v || 1]; return b ? nameOf(b.meiId) + '@' + b.edge : 'none'; };

        P.start();
        P.strike(C5); P.strike(G3);        /* m1 beat 1: trill onset + V3's first half */
        if (where() !== 'slot0@right') return { ok: false, detail: 'm1 v1 ' + where() };
        /* V3 still owes its second m1 half, so the gate keeps V1 deaf and
           these continuations reach nothing at all. */
        if (P.expected().indexOf(1) !== -1)
          return { ok: false, detail: 'V1 listening while V3 still owes m1' };
        P.strike(D5); P.strike(C5);
        if (where() !== 'slot0@right') return { ok: false, detail: 'bar moved while gated: ' + where() };
        /* V3 clears m1 → the gate opens and V1 is listening again. */
        P.strike(G3);
        if (P.expected().indexOf(1) === -1)
          return { ok: false, detail: 'V1 still deaf after V3 cleared m1' };
        /* Now a continuation DOES satisfy the m2 resolution — so the shadow
           takes over and the bar must still not move. */
        P.strike(D5); P.strike(C5);
        if (where() !== 'slot0@right')
          return { ok: false, detail: 'ran ahead once the gate opened: ' + where() };
        /* m2 downbeat: V3's quarter is outside P and at the owed onset → lift. */
        P.strike(D5); P.strike(G3);
        if (where() !== 'slot1@right')
          return { ok: false, detail: 'no lift at the m2 downbeat: ' + where() };
        if (!P.isFinished()) return { ok: false, detail: 'not finished' };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'gate holds, then the shadow takes over and lifts at the barline' };
      })()` },
  ],
  perfEarliestOnsetWins: [
    { name: "a beat-1 strike does not consume a later voice's same-pitch beat-4 entry",
      expr: `(() => {
        const M = window.__hkl_composer, m = M.model;
        const P = M.__performance;
        const N = (q, r, c) => ({ q, r, pname: 'a', accid: '', oct: 4, midi: 60, colorHex: c, lightColorHex: c, velocity: 80 });
        const C5 = N(0, 0, '#ff0000'), D5 = N(3, -1, '#00ff00');
        const E5 = N(1, 0, '#0000ff'), F5 = N(2, -1, '#ff00ff');
        const at = (v) => { const b = P.bars()[v]; return b ? b.meiId + '@' + b.edge : 'none'; };

        const v3 = m.flatChildren(3).filter(e => e.localName === 'chord' || e.localName === 'note');
        if (v3.length !== 1) return { ok: false, detail: 'v3 sounding slots=' + v3.length };
        const v3id = v3[0].getAttribute('xml:id');
        P.start();
        if (at(3) !== v3id + '@left') return { ok: false, detail: 'v3 initial ' + at(3) };
        /* V1's beat-1 C5 is the same pitch+color as V3's beat-4 entry. V1 is
           the earlier onset, so it alone takes the strike. */
        P.strike(C5);
        if (at(3) !== v3id + '@left')
          return { ok: false, detail: 'beat-1 strike captured the beat-4 voice: ' + at(3) };
        P.strike(D5); P.strike(E5);
        if (at(3) !== v3id + '@left') return { ok: false, detail: 'v3 advanced mid-bar: ' + at(3) };
        /* Beat 4: V1 wants F5, V3 wants C5 — now V3 is the only matcher for C5
           and must take it whatever its onset (tiebreak, not a gate). */
        P.strike(F5);
        if (at(3) !== v3id + '@left') return { ok: false, detail: 'v3 took V1 beat 4: ' + at(3) };
        P.strike(C5);
        if (at(3) !== v3id + '@right')
          return { ok: false, detail: 'v3 never advanced on its own note: ' + at(3) };
        if (!P.isFinished()) return { ok: false, detail: 'not finished' };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'earliest onset took the downbeat; the late voice kept its entry' };
      })()` },
  ],
  perfSameOnsetUnisonBoth: [
    { name: 'one strike still advances both voices when they share an onset',
      expr: `(() => {
        const M = window.__hkl_composer, m = M.model;
        const P = M.__performance;
        const N = (q, r, c) => ({ q, r, pname: 'a', accid: '', oct: 4, midi: 60, colorHex: c, lightColorHex: c, velocity: 80 });
        const C5 = N(0, 0, '#ff0000'), D5 = N(3, -1, '#00ff00');
        const E5 = N(1, 0, '#0000ff'), F5 = N(2, -1, '#ff00ff');
        const at = (v) => { const b = P.bars()[v]; return b ? b.meiId + '@' + b.edge : 'none'; };

        const id1 = m.flatChildren(1).filter(e => e.localName !== 'measure').map(e => e.getAttribute('xml:id'));
        const id3 = m.flatChildren(3).filter(e => e.localName !== 'measure').map(e => e.getAttribute('xml:id'));
        P.start();
        /* Same pitch, same onset, two voices: one real key press is both
           notes, so BOTH must advance — the converging case the tiebreak must
           not break. */
        P.strike(C5);
        if (at(1) !== id1[0] + '@right' || at(3) !== id3[0] + '@right')
          return { ok: false, detail: 'unison did not advance both: ' + at(1) + ' / ' + at(3) };
        /* They diverge on beat 2; each takes only its own note. */
        P.strike(D5);
        if (at(1) !== id1[1] + '@right') return { ok: false, detail: 'v1 beat2 ' + at(1) };
        if (at(3) !== id3[0] + '@right') return { ok: false, detail: 'v3 moved on V1 beat2: ' + at(3) };
        P.strike(E5);
        if (at(3) !== id3[1] + '@right') return { ok: false, detail: 'v3 beat2 ' + at(3) };
        if (!P.isFinished()) return { ok: false, detail: 'not finished' };
        document.getElementById('btnPerform').click();
        return { ok: true, detail: 'same-onset unison advances both; divergent notes stay separate' };
      })()` },
  ],
};
