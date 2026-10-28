// Composer test fixtures — scroll.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

export const FIXTURES = {

  /* ── Scroll-into-view ────────────────────────────────────────────── */
  /* The expression layer's scroll-follow tracks the LAYER's moment, not the
     parked voice cursor (backlog 2026-09-05: selecting an expression while the
     voice cursor sat on an unmounted page jumped the view to the first page —
     the voice cursor's page). 80 bars over several pages, a dynamic in the last
     bar, the voice-2 cursor parked in bar 1; the assertion enters the layer,
     jumps to its last moment and edits the mark there. */
  scrollExprLayerFollowsMoment: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 4 * 80; i++) m.insertChordAtCursor({ notes: [N(4, 69)], duration: '4', dots: 0 });
      const doc = m.getDoc(); const MEI = 'http://www.music-encoding.org/ns/mei';
      const meas = doc.querySelectorAll('measure'); const last = meas[meas.length - 1];
      const dyn = (measure, id) => { const d = doc.createElementNS(MEI, 'dynam'); d.setAttribute('xml:id', id); d.setAttribute('tstamp', '1'); d.setAttribute('place', 'between'); d.setAttribute('staff', '1'); d.textContent = 'p'; measure.appendChild(d); };
      /* The voice cycle offers the expression layer only when the CURRENT
         measure holds an expression (cycleVoice: measureHasExpression), so
         bar 1 gets one too; End then jumps to the far one. */
      dyn(meas[0], 'd-test-near');
      dyn(last, 'd-test-far');
      window.__lastMeasureId = last.getAttribute('xml:id');
      m.setVoice(2); m.setCursor(0, 2);
      r();
    `,
    skipCursorTrace: true,
    fullRender: 'an 80-bar document built from the blank doc derives on its first render; the fixture is about the scroll anchor, not the render path',
  },
  /* The page/scroll selector is a <select id="viewModeSelect"> (replacing the
   * old Page/Scroll button pair). Changing it to 'scroll' must drive the
   * renderer's view mode and #score's view-* class. Asserted via
   * FIXTURE_ASSERTIONS.viewModeDropdownSwitch. */
  viewModeDropdownSwitch: {
    setup: `
      m.setCursor(0, 1);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    `,
  },
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
  /* Piece-right edge: the final/end barline and the synthetic past-end cursor
   * must both be VISIBLE and REACHABLE in scroll mode — i.e. inside #score's
   * scrollable width (not pushed past it). Regression guard for the stray
   * `#score.view-scroll svg { margin-left }` rule, which shifted each chunk's
   * svg +24 px relative to its clip and the index, clipping the end barline and
   * parking the past-end cursor past the scroll extent. The last measure is left
   * partial (a quarter rest) so a genuine past-end stop exists. Asserted via
   * FIXTURE_ASSERTIONS.scrollPieceEndReachable (scroll-position-independent:
   * everything is checked in #score content-frame coords vs scrollWidth). */
  scrollPieceEndReachable: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 11; i++) m.insertRestAtCursor({ duration: '1', dots: 0 });
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      m.cursorToEnd(1);
      r();
      const score = document.getElementById('score');
      score.scrollLeft = score.scrollWidth;
    `,
  },
  /* Max's report (backlog Layout, 2026-09-17): in SCROLL view, backspace at the
   * very beginning of a piece with a pickup deleted the pickup measure and took
   * the staff heading with it — the brace and the system's left line survived,
   * the leading clefs, signatures and the staff lines under them became white
   * space. Page view was correct. Cause: the system-initial furniture lives in
   * whichever measure is FIRST, and the splicer's diff made the run old [0..0] /
   * new EMPTY, so the promoted measure kept its mid-system rendering. The setup
   * builds a pickup score in scroll view; the assertion presses Backspace at
   * cursor 0 and checks the score start survived AND that it came from a splice
   * (a full re-engrave would be correct by accident and prove nothing).
   * Asserted via FIXTURE_ASSERTIONS.scrollPickupDeleteKeepsScoreStart. */
  scrollPickupDeleteKeepsScoreStart: {
    setup: `
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      for (let i = 0; i < 6; i++) m.insertChordAtCursor({ notes: [A], duration: '1', dots: 0 });
      m.setPickupAt(0, 4);
      r();
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      m.setCursor(0, 1);
    `,
  },
  /* A scroll-mode edit must SPLICE (re-engrave only the edited run +
   * splice it into the persistent SVG), NOT full-re-engrave. Build a multi-bar
   * doc, switch to scroll (one full render + gap calibration → the persistent
   * SVG), then edit a mid-score measure. The persistent SVG root node must be
   * the SAME element afterwards (a full re-engrave replaces it via innerHTML),
   * and the edit must have applied. Asserted via
   * FIXTURE_ASSERTIONS.scrollEditSplicesNotFullRender. */
  scrollEditSplicesNotFullRender: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 11; i++) m.insertRestAtCursor({ duration: '1', dots: 0 });
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      m.setCursor(2, 1);
      r();
    `,
  },
  /* Scroll view, same range rule. A mid-piece KEY change lives in a
   * section-level scoreDef the per-measure diff cannot see — before 2026-09-01
   * a key change in scroll view rendered NOTHING (the splicer saw no change).
   * Now the governed range [change, next key change) is spliced into the
   * persistent SVG (root unchanged) and the key signature appears. Asserted via
   * FIXTURE_ASSERTIONS.scrollKeyChangeSplicesGovernedRange. */
  scrollKeyChangeSplicesGovernedRange: {
    skipCursorTrace: true,
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 48; i++) m.insertChordAtCursor({ notes: [mk('g', 5)], duration: '4', dots: 0 });
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      r();
    `,
  },
  /* Scroll view: an inline CLEF change with a later clef splices its governed
   * range (it used to full-render, and before that left later measures in the
   * old clef). Asserted via FIXTURE_ASSERTIONS.scrollClefChangeSplicesGovernedRange. */
  scrollClefChangeSplicesGovernedRange: {
    skipCursorTrace: true,
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 48; i++) m.insertChordAtCursor({ notes: [mk('g', 5)], duration: '4', dots: 0 });
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      r();
    `,
  },
  /* A width-CHANGING scroll edit on a mid-score measure must keep the
   * edited measure joined to its LEFT neighbour and cascade the width delta
   * RIGHTWARD — i.e. the spliced layout must match a full re-engrave of the same
   * model. Regression guard for the anchor bug where the splice pinned the
   * edited run's RIGHT edge (to the right-context measure) and let its LEFT edge
   * float, opening a gap / overlap with the left neighbour on delete / insert.
   * Six quarter-filled bars → scroll; the assertion edits a mid bar and compares
   * splice vs full-render measure x. Asserted via
   * FIXTURE_ASSERTIONS.scrollWidthChangeCascadesRight. */
  scrollWidthChangeCascadesRight: {
    setup: `
      for (let i = 0; i < 5; i++) m.appendMeasure();   // 6 empty (placeholder) bars
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      m.setCursor(0, 1);
      r();
    `,
  },
  /* ── Scroll view: EDITING IN IT (2026-09-13) ──────────────────────────────
   * Every scroll fixture above builds its document in PAGE view and switches to
   * scroll afterwards. The switch full-engraves, so they all assert against a
   * freshly correct SVG and the splice path is never live when they look at it.
   * That blind spot hid two defects at once for months: the splicer never grew
   * the SVG box (typing 13 bars from a blank doc left a 345 px box over 29 477
   * user units of content, with #score carrying no scrollable extent at all, so
   * the notes were unreachable rather than merely hidden), and it aligned the
   * fresh run on the anchor measure's INK bbox — which at lo === 0 is the edited
   * measure itself, so a high note in bar 1 seated that bar 1152 units below
   * bars 2-4 while the brace and the system's left line stayed behind.
   *
   * These fixtures therefore ENTER SCROLL VIEW FIRST and then edit. Each one
   * that means to exercise a splice also pins the SVG root element's identity
   * across the edits — without that a fixture passes trivially the moment
   * something forces a full re-engrave, which is exactly how the blind spot
   * re-opens. */

  /* Type 12 bars IN scroll view. The box must track the content the whole way
   * (assertScrollSystemCoherent) and every edit must splice.
   * FIXTURE_ASSERTIONS.scrollTypingGrowsBounds. */
  scrollTypingGrowsBounds: {
    skipCursorTrace: true,
    visualBaseline: 'scrollTypingGrowsBounds',
    setup: `
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      r();
      const score = document.getElementById('score');
      const root0 = score.querySelector('svg:not(#cursorOverlay)');
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      let stable = true;
      /* Measure the box against the content AFTER EVERY INSERT, not just at the
         end: "the box tracks the content the whole way" is the claim, and an
         end-state-only check passes a splicer that is wrong for eleven edits and
         right on the twelfth. Keep the tightest (worst) step. */
      const probe = () => {
        const sr = score.getBoundingClientRect();
        const toX = (rect) => rect.right - sr.left + score.scrollLeft;
        const svgEl = score.querySelector('svg:not(#cursorOverlay)');
        let contentRight = -Infinity;
        for (const mm of score.querySelectorAll('g.system > g.measure')) {
          const x = toX(mm.getBoundingClientRect());
          if (x > contentRight) contentRight = x;
        }
        return { contentRight, svgRight: toX(svgEl.getBoundingClientRect()), scrollW: score.scrollWidth };
      };
      let worst = null;
      m.setVoice(1);
      for (let i = 0; i < 12; i++) {
        m.setCursor(m.getVoiceLength(1), 1);
        m.insertChordAtCursor({ notes: [mk('a', 4)], duration: '4', dots: 0 });
        r();
        if (score.querySelector('svg:not(#cursorOverlay)') !== root0) stable = false;
        const q = probe();
        const slack = Math.min(q.svgRight - q.contentRight, q.scrollW - q.contentRight);
        if (worst === null || slack < worst.slack) worst = { step: i + 1, slack: Math.round(slack), contentRight: Math.round(q.contentRight), svgRight: Math.round(q.svgRight), scrollW: q.scrollW };
      }
      window.__scrollRootStable = stable;
      window.__scrollWorstStep = worst;
    `,
  },
  /* The exact 2026-09-13 repro: a high note added to BAR 1, in scroll view, so
   * the splice anchor is the edited measure. Every bar must still agree on its
   * staff rows and the brace/left line must sit on them.
   * FIXTURE_ASSERTIONS.scrollHighNoteFirstMeasure. */
  scrollHighNoteFirstMeasure: {
    skipCursorTrace: true,
    setup: `
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      r();
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      m.setVoice(1);
      m.setCursor(0, 1);
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [mk('a', 4)], duration: '4', dots: 0 });
      for (let k = 0; k < 3; k++) {
        m.setCursor(m.getVoiceLength(1), 1);
        for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [mk('a', 4)], duration: '4', dots: 0 });
      }
      r();
      /* Bar 1's free 4th beat, high enough to demand headroom the system does
         not yet have -> the sub-render re-seats the whole system. */
      m.setCursor(3, 1);
      m.insertChordAtCursor({ notes: [mk('a', 7)], duration: '4', dots: 0 });
      r();
    `,
  },
  /* Frame adoption must be GROW-ONLY. After the bar-1 high note re-seats the
   * system, an edit somewhere with nothing tall in it must NOT drag the system
   * back up: the sub-render only sees its own range, and the note that bought
   * the headroom is not in it. Caught in development — the first grow-both-ways
   * implementation adopted correctly and then the very next append reverted all
   * six bars and re-clipped the note.
   * FIXTURE_ASSERTIONS.scrollHighNoteSurvivesLaterEdit. */
  scrollHighNoteSurvivesLaterEdit: {
    skipCursorTrace: true,
    setup: `
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      r();
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      m.setVoice(1);
      m.setCursor(0, 1);
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [mk('a', 4)], duration: '4', dots: 0 });
      for (let k = 0; k < 3; k++) {
        m.setCursor(m.getVoiceLength(1), 1);
        for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [mk('a', 4)], duration: '4', dots: 0 });
      }
      r();
      m.setCursor(3, 1);
      m.insertChordAtCursor({ notes: [mk('a', 7)], duration: '4', dots: 0 });
      r();
      const rowAfterAdopt = (() => {
        const st = document.querySelector('#score g.system g.measure > g.staff');
        const p = Array.from(st.querySelectorAll(':scope > path')).find((q) => { try { return q.getBBox().height < 1; } catch (e) { return false; } });
        return p ? p.getBBox().y : null;
      })();
      /* Now edit a range with nothing tall in it. */
      for (let i = 0; i < 4; i++) {
        m.setCursor(m.getVoiceLength(1), 1);
        m.insertChordAtCursor({ notes: [mk('a', 4)], duration: '4', dots: 0 });
        r();
      }
      window.__scrollRowAfterAdopt = rowAfterAdopt;
    `,
  },
  /* Deleting back down must SHRINK the box, not leave dead scroll extent behind
   * (the width fit is exact in both directions, unlike the grow-only frame).
   * FIXTURE_ASSERTIONS.scrollDeleteShrinksBounds. */
  scrollDeleteShrinksBounds: {
    skipCursorTrace: true,
    setup: `
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      r();
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      m.setVoice(1);
      for (let i = 0; i < 12; i++) {
        m.setCursor(m.getVoiceLength(1), 1);
        m.insertChordAtCursor({ notes: [mk('a', 4)], duration: '4', dots: 0 });
      }
      r();
      const vbOf = () => Number((document.querySelector('#score svg.definition-scale').getAttribute('viewBox') || '').trim().split(' ')[2]);
      window.__scrollWideVb = vbOf();
      for (let i = 0; i < 6; i++) {
        m.setCursor(m.getVoiceLength(1) - 1, 1);
        m.deleteAtCursor();
        r();
      }
      window.__scrollNarrowVb = vbOf();
    `,
  },
  /* A high note in the LOWER staff of the grand staff changes the INTER-STAFF
   * GAP (probed: 1600 -> 2165 with the top staff unmoved). One translate cannot
   * re-seat that, so the splicer refuses and the fall-through full re-engrave
   * draws it. Either way the rendered system must be coherent — this fixture is
   * the guard that it is never spliced WRONG, and it is the one to revisit when
   * per-row displacement lands (render/instrgap.ts).
   * FIXTURE_ASSERTIONS.scrollLowerStaffGapChange. */
  scrollLowerStaffGapChange: {
    skipCursorTrace: true,
    /* This fixture exists to provoke the one refusal the scroll splicer still
       has, so its warning is expected HERE and nowhere else. When per-row
       displacement lands (render/instrgap.ts) the splice will succeed, this
       allowance becomes dead, and removing it is how you find that out. */
    allowConsole: [/\[scroll-splice\] edit could not be spliced \(inter-staff spacing changed/],
    setup: `
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      r();
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      m.setVoice(1); m.setCursor(0, 1);
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [mk('a', 4)], duration: '4', dots: 0 });
      m.setVoice(3); m.setCursor(0, 3);
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [mk('c', 3)], duration: '4', dots: 0 });
      r();
      m.setVoice(3); m.setCursor(3, 3);
      m.insertChordAtCursor({ notes: [mk('c', 6)], duration: '4', dots: 0 });
      r();
    `,
  },
  /* scrollPieceEndReachable's missing sibling: the SAME assertions, but with the
   * document typed IN scroll view rather than built in page view and switched.
   * That ordering is the entire difference between a fixture that watches a
   * splice and one that watches a full engrave. */
  scrollPieceEndReachableAfterTyping: {
    skipCursorTrace: true,
    setup: `
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      r();
      m.setCursor(0, 1);
      for (let i = 0; i < 11; i++) { m.insertRestAtCursor({ duration: '1', dots: 0 }); r(); }
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.cursorToEnd(1);
      r();
      const score = document.getElementById('score');
      score.scrollLeft = score.scrollWidth;
    `,
  },
  /* Measure-coordinate unification (lessons.md "Two measure coordinate
   * systems", 2026-08-30): the model counts measures in DOCUMENT ORDER
   * (voltas included); the splicer must too. TWO ending-wrapped measures
   * before the edit defeat markEditAround's ±1 dirty buffer — with the old
   * direct-children coordinates this edit spliced silently STALE (zero
   * toolkit work, SVG unchanged). Asserted via
   * FIXTURE_ASSERTIONS.scrollSpliceAfterEnding. */
  scrollSpliceAfterEnding: {
    setup: `
      for (let i = 0; i < 7; i++) m.appendMeasure();   // 8 bars
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 };
      const fill = (mi, n) => {
        m.setCursor(m.getMeasureStartCursor(1, mi), 1);
        for (let i = 0; i < n; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      };
      fill(0, 4); fill(1, 4); fill(2, 4); fill(3, 4); fill(5, 2);
      /* toggleEndingAt needs a repeat context (no-op otherwise): bar 1 gets
         rptend, then bars 1+2 become 1st/2nd endings → TWO volta-wrapped
         measures → a doc-order skew of 2 after them (defeats markEditAround's
         ±1 dirty buffer, the probe-confirmed stale mode). */
      m.toggleRepeatEndAt(1);
      m.toggleEndingAt(1);
      m.toggleEndingAt(2);
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      m.setCursor(0, 1);
      r();
    `,
  },
  /* Edit INSIDE a volta measure: the old splicer's sig maps excluded
   * ending-wrapped measures entirely, so this spliced stale no matter the
   * dirty range. The delete also changes the volta's width, exercising the
   * whole-ending run expansion + the cascade ACROSS ending-wrapped bars.
   * Asserted via FIXTURE_ASSERTIONS.scrollSpliceInsideEnding. */
  scrollSpliceInsideEnding: {
    setup: `
      for (let i = 0; i < 5; i++) m.appendMeasure();   // 6 bars
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 };
      const fill = (mi, n) => {
        m.setCursor(m.getMeasureStartCursor(1, mi), 1);
        for (let i = 0; i < n; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      };
      fill(0, 4); fill(1, 2); fill(2, 4); fill(3, 4);
      m.toggleRepeatEndAt(1);   // repeat context — toggleEndingAt no-ops without it
      m.toggleEndingAt(1);      // bar 1 → 1st ending
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      m.setCursor(0, 1);
      r();
    `,
  },
  /* tstamp2-spanning hairpin (expression-layer anchoring): an edit at the
   * wedge's HOST measure must expand the run to the whole span — the old
   * startid/endid-only expansion re-rendered a sub-range the tstamp2 couldn't
   * reach, Verovio only WARNED, and the splice deleted the wedge from the SVG
   * (and collapsed the host's wedge-reserved width). Asserted via
   * FIXTURE_ASSERTIONS.scrollSpliceHairpinHostEdit. */
  scrollSpliceHairpinHostEdit: {
    setup: `
      for (let i = 0; i < 4; i++) m.appendMeasure();   // 5 bars
      const A = { q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 };
      const fill = (mi, n) => {
        m.setCursor(m.getMeasureStartCursor(1, mi), 1);
        for (let i = 0; i < n; i++) m.insertChordAtCursor({ notes: [A], duration: '4', dots: 0 });
      };
      fill(0, 4); fill(1, 4); fill(2, 4); fill(3, 4);
      const MEI = 'http://www.music-encoding.org/ns/mei';
      const XMLNS = 'http://www.w3.org/XML/1998/namespace';
      const doc = m.getDoc();
      const host = doc.querySelectorAll('measure')[0];
      const hp = doc.createElementNS(MEI, 'hairpin');
      hp.setAttribute('staff', '1');
      hp.setAttribute('form', 'cres');
      hp.setAttribute('tstamp', '1');
      hp.setAttribute('tstamp2', '2m+1');   // spans bars 0 → 2
      hp.setAttributeNS(XMLNS, 'xml:id', 'hp-span-fixture');
      host.appendChild(hp);
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      m.setCursor(0, 1);
      window.__hkl_composer.renderer.forceFullRerender();   // baseline includes the wedge
      r();
    `,
  },
};

export const ASSERTIONS = {
  /* The view-mode <select> drives renderer view mode + #score class, and the
   * old toggle buttons are gone. */
  viewModeDropdownSwitch: [
    { name: 'viewModeSelect=scroll drives renderer + #score.view-scroll; old buttons removed',
      expr: `(() => {
        if (document.getElementById('btnViewPage') || document.getElementById('btnViewScroll')) {
          return { ok: false, detail: 'old Page/Scroll buttons still present' };
        }
        const sel = document.getElementById('viewModeSelect');
        if (!sel) return { ok: false, detail: 'missing #viewModeSelect' };
        if (window.__hkl_composer.renderer.getViewMode() !== 'scroll') {
          return { ok: false, detail: 'renderer view mode=' + window.__hkl_composer.renderer.getViewMode() };
        }
        const score = document.getElementById('score');
        if (!score.classList.contains('view-scroll')) return { ok: false, detail: '#score class=' + score.className };
        return { ok: true };
      })()` },
  ],
  scrollPickupDeleteKeepsScoreStart: [
    { name: 'backspace deleting the pickup splices, and the promoted measure carries the score-start clef/meter at the system origin',
      expr: `(async () => {
        const H = window.__hkl_composer, m = H.model;
        await window.__waitForRender();
        const score = document.getElementById('score');
        if (!score.classList.contains('view-scroll')) return { ok: false, detail: '#score class=' + score.className };
        const svgBefore = score.querySelector('svg:not(#cursorOverlay)');
        if (!svgBefore) return { ok: false, detail: 'no rendered SVG' };
        const before = m.allMeasures().length;
        const snap = m.snapshotState();
        /* The reported gesture: backspace at the very beginning. */
        m.setCursor(0, 1);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
        await window.__waitForRender();
        const after = m.allMeasures().length;
        const svgAfter = score.querySelector('svg:not(#cursorOverlay)');
        const spliced = svgAfter === svgBefore;
        const sys = score.querySelector('g.system');
        const first = sys && sys.querySelector('g.measure');
        const clefs = first ? first.querySelectorAll('g.clef').length : 0;
        const meters = first ? first.querySelectorAll('g.meterSig').length : 0;
        const staves = first ? first.querySelectorAll(':scope > g.staff').length : 0;
        /* Run-up from the system's left edge to where the staff lines begin: the
           brace's inset when the score start is drawn, a whole measure width
           when it is not. */
        let runUp = null, firstW = null;
        if (first) {
          const lefts = [];
          for (const st of Array.from(first.querySelectorAll(':scope > g.staff'))) {
            for (const pth of Array.from(st.querySelectorAll(':scope > path'))) {
              let bb; try { bb = pth.getBBox(); } catch (e) { continue; }
              if (bb.height >= 1) continue;
              const rr = pth.getBoundingClientRect();
              if (rr.width > 0) lefts.push(rr.left);
            }
          }
          if (lefts.length) runUp = Math.min.apply(null, lefts) - sys.getBoundingClientRect().left;
          firstW = first.getBoundingClientRect().width;
        }
        m.restoreSnapshot(snap);
        H.renderer.forceFullRerender();
        H.reRender();
        if (after !== before - 1) return { ok: false, detail: 'measures ' + before + ' -> ' + after + ' (expected one fewer: the pickup)' };
        if (!spliced) return { ok: false, detail: 'the delete re-engraved the whole score (SVG root replaced) — this fixture never exercised the splice path' };
        if (clefs !== staves || meters !== staves) {
          return { ok: false, detail: 'promoted first measure has ' + clefs + ' clefs and ' + meters +
            ' meterSigs for ' + staves + ' staves — the score-start furniture was not re-engraved' };
        }
        if (runUp === null || firstW === null) return { ok: false, detail: 'could not read the first measure geometry' };
        if (runUp >= firstW) {
          return { ok: false, detail: 'staff lines begin ' + runUp.toFixed(1) + 'px right of the system edge, ' +
            'wider than the first measure (' + firstW.toFixed(1) + 'px) — the score start is blank paper' };
        }
        return { ok: true };
      })()` },
  ],
  scrollEditSplicesNotFullRender: [
    { name: 'a scroll-mode edit splices into the persistent SVG (root node unchanged) and applies the edit',
      expr: `(() => {
        const score = document.getElementById('score');
        const svgBefore = score.querySelector('svg:not(#cursorOverlay)');
        if (!svgBefore) return { ok: false, detail: 'no rendered SVG' };
        const m = window.__hkl_composer.model;
        const lenBefore = m.getVoiceLength(1);
        /* Snapshot so we can RESTORE the model after the check — this assertion
           mutates the doc, which would otherwise pollute later invariants (the
           cursor-trace). */
        const snap = m.snapshotState();
        /* append a note at past-end (a real edit), then re-render through the
           normal path → must SPLICE (persistent SVG root reused), not full
           re-engrave. */
        m.setCursor(m.getVoiceLength(1), 1);
        const id = m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
        window.__hkl_composer.reRender();
        const svgAfter = score.querySelector('svg:not(#cursorOverlay)');
        const grew = id !== null && m.getVoiceLength(1) > lenBefore;
        const spliced = svgAfter === svgBefore;
        /* restore the clean setup state for subsequent invariants, forcing a
           full re-engrave so they see a pristine baseline (not a delete-splice). */
        m.restoreSnapshot(snap);
        window.__hkl_composer.renderer.forceFullRerender();
        window.__hkl_composer.reRender();
        if (!grew) return { ok: false, detail: 'edit did not change the model (len ' + lenBefore + ')' };
        if (!spliced) return { ok: false, detail: 'scroll edit re-engraved the whole score (SVG root replaced) — splice did not fire' };
        return { ok: true };
      })()` },
  ],
  scrollTypingGrowsBounds: [
    { name: 'every edit spliced (SVG root reused across all 12 inserts)',
      expr: `(() => (window.__scrollRootStable === true
        ? { ok: true }
        : { ok: false, detail: 'the SVG root was replaced while typing — a full re-engrave ran, so this fixture never exercised the splice path and proves nothing' }))()` },
    { name: 'scroll system is coherent (staff rows agree, furniture on them, box covers content)',
      expr: `window.__test.assertScrollSystemCoherent()` },
    { name: 'the box covered the content at EVERY insert, not just the last',
      expr: `(() => {
        const w = window.__scrollWorstStep;
        if (!w) return { ok: false, detail: 'setup recorded no per-step probe' };
        return w.slack >= -1
          ? { ok: true }
          : { ok: false, detail: 'tightest step was insert #' + w.step + ': content right ' + w.contentRight +
              ' px vs svg right ' + w.svgRight + ' px / scrollWidth ' + w.scrollW + ' (slack ' + w.slack + ' px)' };
      })()` },
    { name: 'the box actually had to grow (content is far wider than the blank doc)',
      expr: `(() => {
        const vb = (document.querySelector('#score svg.definition-scale').getAttribute('viewBox') || '').trim().split(' ').map(Number);
        /* A blank 1-bar doc measures ~3450 user units; 12 typed bars are ~5x
           that. If this ever passes at blank width the fixture has stopped
           building a document and the box check above is vacuous. */
        return vb[2] > 12000 ? { ok: true } : { ok: false, detail: 'viewBox width ' + vb[2] + ' — document did not grow as expected' };
      })()` },
  ],
  scrollHighNoteFirstMeasure: [
    { name: 'scroll system is coherent (staff rows agree, furniture on them, box covers content)',
      expr: `window.__test.assertScrollSystemCoherent()` },
    { name: 'the edited bar is seated with the others (the 2026-09-13 defect, stated directly)',
      expr: `(() => {
        const sys = document.querySelector('#score g.system');
        const tyOf = (el) => { const t = /translate\\(\\s*(-?[\\d.eE+]+)[\\s,]+(-?[\\d.eE+]+)\\s*\\)/.exec(el.getAttribute('transform') || ''); return t ? parseFloat(t[2]) : 0; };
        const rowOf = (mm) => {
          const st = mm.querySelector(':scope > g.staff');
          if (!st) return null;
          const p = Array.from(st.querySelectorAll(':scope > path')).find((q) => { try { return q.getBBox().height < 1; } catch (e) { return false; } });
          return p ? p.getBBox().y + tyOf(mm) : null;
        };
        const rows = Array.from(sys.querySelectorAll(':scope > g.measure')).map(rowOf).filter((v) => v !== null);
        if (rows.length < 2) return { ok: false, detail: 'need >= 2 rendered bars, got ' + rows.length };
        const spread = Math.max.apply(null, rows) - Math.min.apply(null, rows);
        return spread <= 1
          ? { ok: true }
          : { ok: false, detail: 'top staff row spans ' + spread.toFixed(1) + ' user units across bars (rows: ' + rows.map((v) => v.toFixed(0)).join(', ') + ') — the edited bar is not seated with the rest' };
      })()` },
  ],
  scrollHighNoteSurvivesLaterEdit: [
    { name: 'scroll system is coherent (staff rows agree, furniture on them, box covers content)',
      expr: `window.__test.assertScrollSystemCoherent()` },
    { name: 'a later edit elsewhere does not revert the adopted frame (grow-only)',
      expr: `(() => {
        const adopted = window.__scrollRowAfterAdopt;
        if (typeof adopted !== 'number') return { ok: false, detail: 'setup did not record the adopted row' };
        const sys = document.querySelector('#score g.system');
        const mm = sys.querySelector(':scope > g.measure');
        const t = /translate\\(\\s*(-?[\\d.eE+]+)[\\s,]+(-?[\\d.eE+]+)\\s*\\)/.exec(mm.getAttribute('transform') || '');
        const ty = t ? parseFloat(t[2]) : 0;
        const st = mm.querySelector(':scope > g.staff');
        const p = Array.from(st.querySelectorAll(':scope > path')).find((q) => { try { return q.getBBox().height < 1; } catch (e) { return false; } });
        if (!p) return { ok: false, detail: 'no staff line in bar 1' };
        const now = p.getBBox().y + ty;
        return now >= adopted - 1
          ? { ok: true }
          : { ok: false, detail: 'top staff row rose from ' + adopted.toFixed(1) + ' to ' + now.toFixed(1) + ' — a later range re-seated the system on its own shallower frame and re-clipped the high note' };
      })()` },
  ],
  scrollDeleteShrinksBounds: [
    { name: 'scroll system is coherent (staff rows agree, furniture on them, box covers content)',
      expr: `window.__test.assertScrollSystemCoherent()` },
    { name: 'deleting content shrinks the box (no dead scroll extent left behind)',
      expr: `(() => {
        const wide = window.__scrollWideVb, narrow = window.__scrollNarrowVb;
        if (!isFinite(wide) || !isFinite(narrow)) return { ok: false, detail: 'setup did not record both widths' };
        return narrow < wide
          ? { ok: true }
          : { ok: false, detail: 'viewBox width stayed at ' + narrow + ' after deleting (was ' + wide + ') — the width fit ratchets instead of shrinking' };
      })()` },
  ],
  scrollLowerStaffGapChange: [
    { name: 'scroll system is coherent (staff rows agree, furniture on them, box covers content)',
      expr: `window.__test.assertScrollSystemCoherent()` },
  ],
  scrollKeyChangeSplicesGovernedRange: [
    { name: 'a mid-piece key change in scroll view splices (root unchanged) and draws the key signature; a later key change bounds the run',
      expr: `(() => {
        const H = window.__hkl_composer;
        const m = H.model;
        const score = document.getElementById('score');
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        if (ids.length < 12) return { ok: false, detail: 'need >= 12 measures' };
        /* later reset first */
        m.setKeySigAt(9, '2f', 'major');
        H.reRender();
        const svg0 = score.querySelector('svg:not(#cursorOverlay)');
        if (!svg0) return { ok: false, detail: 'no rendered SVG' };
        const keyGlyphs = (mi) => { const g = document.getElementById(ids[mi]); return g ? g.querySelectorAll('g.keySig use, g.keySig text').length : -1; };
        if (keyGlyphs(9) < 1) return { ok: false, detail: 'reset key signature not drawn at measure 9 (' + keyGlyphs(9) + ')' };
        const before5 = keyGlyphs(5);
        m.setKeySigAt(5, '3s', 'major');
        H.reRender();
        const svg1 = score.querySelector('svg:not(#cursorOverlay)');
        if (svg1 !== svg0) return { ok: false, detail: 'key change re-engraved the whole score (SVG root replaced) — governed range did not splice' };
        if (keyGlyphs(5) <= before5) return { ok: false, detail: 'key signature not drawn at the changed measure (before ' + before5 + ', after ' + keyGlyphs(5) + ')' };
        if (keyGlyphs(9) < 1) return { ok: false, detail: 'the later key change lost its signature' };
        return { ok: true };
      })()` },
  ],
  scrollClefChangeSplicesGovernedRange: [
    { name: 'an inline clef change in scroll view with a later clef splices (root unchanged) and both change glyphs are drawn',
      expr: `(() => {
        const H = window.__hkl_composer;
        const m = H.model;
        const score = document.getElementById('score');
        const ms = m.allMeasures();
        const ids = ms.map((x) => x.getAttribute('xml:id'));
        if (ids.length < 12) return { ok: false, detail: 'need >= 12 measures' };
        const chordAt = (mi) => { const flat = m['flatChildren'](1); return flat.findIndex((el) => (el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === m.allMeasures()[mi]); };
        if (!m.setClefAtCursor(1, chordAt(9), 'F', '4', null, null)) return { ok: false, detail: 'reset clef refused' };
        H.reRender();
        const svg0 = score.querySelector('svg:not(#cursorOverlay)');
        if (!svg0) return { ok: false, detail: 'no rendered SVG' };
        const clefs = (mi) => { const g = document.getElementById(ids[mi]); return g ? Array.from(g.querySelectorAll('g.clef use')).map((u) => (u.getAttribute('xlink:href') || u.getAttribute('href') || '').replace(/^#/, '').split('-')[0]).join(' ') : 'absent'; };
        if (!/E07C/.test(clefs(9))) return { ok: false, detail: 'reset clef change not drawn at measure 9: "' + clefs(9) + '"' };
        if (!m.setClefAtCursor(1, chordAt(5), 'F', '4', null, null)) return { ok: false, detail: 'edit clef refused' };
        H.reRender();
        const svg1 = score.querySelector('svg:not(#cursorOverlay)');
        if (svg1 !== svg0) return { ok: false, detail: 'clef change re-engraved the whole score (SVG root replaced) — governed range did not splice' };
        if (!/E07C/.test(clefs(5))) return { ok: false, detail: 'clef change not drawn at measure 5: "' + clefs(5) + '"' };
        /* measure 9's clef is now redundant (F→F) but its element still exists; it
           must still be drawn as the range boundary and nothing past it changed */
        if (clefs(9) === 'absent') return { ok: false, detail: 'measure 9 missing after the splice' };
        return { ok: true };
      })()` },
  ],
  scrollWidthChangeCascadesRight: [
    { name: 'a width-changing mid-score scroll edit splices to the SAME measure x as a full re-engrave (left edge joined, width cascades right)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const score = document.getElementById('score');
        /* Map id → {x, y} absolute (local bbox + own transform) for every bar. */
        const posOf = () => {
          const map = {};
          for (const g of score.querySelectorAll('svg:not(#cursorOverlay) g.measure')) {
            const b = g.getBBox();
            const ctm = g.transform.baseVal.consolidate();
            map[g.id] = { x: b.x + (ctm ? ctm.matrix.e : 0), y: b.y + (ctm ? ctm.matrix.f : 0) };
          }
          return map;
        };
        const fill4 = (mi) => {
          m.setCursor(m.getMeasureStartCursor(1, mi), 1);
          let ok = false;
          for (let i = 0; i < 4; i++) {
            ok = m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 }) !== null || ok;
          }
          window.__hkl_composer.reRender();               // SPLICE path
          return ok;
        };
        const snap = m.snapshotState();
        /* Two LARGE width changes on adjacent mid-score bars: fill empty bar 2,
           then empty bar 3. The second edit's left-context ANCHOR is bar 2,
           which the first edit already spliced — so this also covers re-splicing
           against a previously-spliced anchor. (The dy-includes-ty fix only
           changes output when dy≠0, i.e. with varied vertical content; on this
           uniform content dy≈0, so x-cascade is what's primarily guarded here.) */
        const ok = fill4(2) && fill4(3);
        const splicePos = posOf();
        /* Full re-engrave of the SAME edited model — the ground truth. */
        window.__hkl_composer.renderer.forceFullRerender();
        window.__hkl_composer.reRender();
        const fullPos = posOf();
        /* Restore the clean setup state for later invariants. */
        m.restoreSnapshot(snap);
        window.__hkl_composer.renderer.forceFullRerender();
        window.__hkl_composer.reRender();
        if (!ok) return { ok: false, detail: 'inserts did not mutate the model' };
        let maxDx = 0, maxDy = 0, worst = null;
        for (const id in fullPos) {
          if (id in splicePos) {
            const dx = Math.abs(fullPos[id].x - splicePos[id].x);
            const dy = Math.abs(fullPos[id].y - splicePos[id].y);
            if (dx > maxDx) maxDx = dx;
            if (dy > maxDy) { maxDy = dy; }
            if (dx >= 3 || dy >= 3) worst = id;
          }
        }
        return (maxDx < 3 && maxDy < 3)
          ? { ok: true }
          : { ok: false, detail: 'spliced bar pos diverged from full re-engrave: dx=' + maxDx.toFixed(1) + ' dy=' + maxDy.toFixed(1) + 'px at ' + worst + ' (anchor/cascade or dy-ty bug)' };
      })()` },
  ],
  scrollSpliceAfterEnding: [
    { name: 'a converted edit past two volta bars splices fresh content (no stale SVG) and matches a full re-engrave',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const score = document.getElementById('score');
        const posOf = () => {
          const map = {};
          for (const g of score.querySelectorAll('svg:not(#cursorOverlay) g.measure')) {
            const b = g.getBBox();
            const ctm = g.transform.baseVal.consolidate();
            map[g.id] = { x: b.x + (ctm ? ctm.matrix.e : 0), y: b.y + (ctm ? ctm.matrix.f : 0) };
          }
          return map;
        };
        const snap = m.snapshotState();
        /* Converted DELETE in bar 5 (doc idx 5 = direct idx 3 pre-fix: beyond
           markEditAround's ±1 → the old coordinates consumed the dirty range in
           the wrong frame and spliced this STALE — the probe-confirmed mode). */
        const m5 = m.allMeasures()[5];
        const ids5 = Array.from(m5.querySelectorAll('note')).map((n) => n.getAttribute('xml:id'));
        m.setCursor(m.getMeasureStartCursor(1, 5) + 1, 1);
        const ok = m.deleteAtCursor();
        window.__hkl_composer.reRender();   // SPLICE path
        const idsAfter = new Set(Array.from(m5.querySelectorAll('note')).map((n) => n.getAttribute('xml:id')));
        const goneIds = ids5.filter((id) => id && !idsAfter.has(id));
        const missing = goneIds.filter((id) => score.querySelector('svg #' + CSS.escape(id)) != null);
        const splicePos = posOf();
        window.__hkl_composer.renderer.forceFullRerender();
        window.__hkl_composer.reRender();
        const fullPos = posOf();
        m.restoreSnapshot(snap);
        window.__hkl_composer.renderer.forceFullRerender();
        window.__hkl_composer.reRender();
        if (!ok) return { ok: false, detail: 'delete was rejected' };
        if (!goneIds.length) return { ok: false, detail: 'delete removed no notes from the model' };
        if (missing.length) return { ok: false, detail: 'STALE SPLICE — deleted notes still drawn in SVG: ' + missing.join(',') };
        let maxDx = 0, maxDy = 0, worst = null;
        for (const id in fullPos) {
          if (!(id in splicePos)) continue;
          const dx = Math.abs(fullPos[id].x - splicePos[id].x);
          const dy = Math.abs(fullPos[id].y - splicePos[id].y);
          if (dx > maxDx) maxDx = dx;
          if (dy > maxDy) maxDy = dy;
          if (dx >= 3 || dy >= 3) worst = id;
        }
        return (maxDx < 3 && maxDy < 3)
          ? { ok: true }
          : { ok: false, detail: 'post-ending splice diverged from full re-engrave: dx=' + maxDx.toFixed(1) + ' dy=' + maxDy.toFixed(1) + 'px at ' + worst };
      })()` },
  ],
  scrollSpliceInsideEnding: [
    { name: 'an insert INSIDE a volta measure splices fresh (widened) content, cascades, and matches a full re-engrave (volta bracket included)',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const score = document.getElementById('score');
        const posOf = () => {
          const map = {};
          for (const g of score.querySelectorAll('svg:not(#cursorOverlay) g.measure')) {
            const b = g.getBBox();
            const ctm = g.transform.baseVal.consolidate();
            map[g.id] = { x: b.x + (ctm ? ctm.matrix.e : 0), y: b.y + (ctm ? ctm.matrix.f : 0) };
          }
          return map;
        };
        const bracketBox = () => {
          const b = score.querySelector('svg:not(#cursorOverlay) g.voltaBracket');
          if (!b) return null;
          const r = b.getBBox();
          const t = b.transform.baseVal.consolidate();
          return { x: Math.round(r.x + (t ? t.matrix.e : 0)), w: Math.round(r.width) };
        };
        const snap = m.snapshotState();
        /* Converted DELETE inside the 1st-ending bar: the old splicer's sig maps
           excluded ending-wrapped measures entirely, so this spliced STALE no
           matter the dirty range. The width change also exercises the
           whole-ending run expansion + the cascade across ending-wrapped bars. */
        const m1 = m.allMeasures()[1];
        const ids1 = Array.from(m1.querySelectorAll('note')).map((n) => n.getAttribute('xml:id'));
        m.setCursor(m.getMeasureStartCursor(1, 1) + 1, 1);
        const ok = m.deleteAtCursor();
        window.__hkl_composer.reRender();   // SPLICE path
        const idsAfter = new Set(Array.from(m1.querySelectorAll('note')).map((n) => n.getAttribute('xml:id')));
        const goneIds = ids1.filter((id) => id && !idsAfter.has(id));
        const missing = goneIds.filter((id) => score.querySelector('svg #' + CSS.escape(id)) != null);
        const splicePos = posOf();
        const spliceBracket = bracketBox();
        window.__hkl_composer.renderer.forceFullRerender();
        window.__hkl_composer.reRender();
        const fullPos = posOf();
        const fullBracket = bracketBox();
        m.restoreSnapshot(snap);
        window.__hkl_composer.renderer.forceFullRerender();
        window.__hkl_composer.reRender();
        if (!ok) return { ok: false, detail: 'delete was rejected' };
        if (!goneIds.length) return { ok: false, detail: 'delete removed no notes from the model' };
        if (missing.length) return { ok: false, detail: 'STALE SPLICE — deleted volta notes still drawn in SVG: ' + missing.join(',') };
        let maxDx = 0, maxDy = 0, worst = null;
        for (const id in fullPos) {
          if (!(id in splicePos)) continue;
          const dx = Math.abs(fullPos[id].x - splicePos[id].x);
          const dy = Math.abs(fullPos[id].y - splicePos[id].y);
          if (dx > maxDx) maxDx = dx;
          if (dy > maxDy) maxDy = dy;
          if (dx >= 3 || dy >= 3) worst = id;
        }
        if (!(maxDx < 3 && maxDy < 3)) {
          return { ok: false, detail: 'volta splice diverged from full re-engrave: dx=' + maxDx.toFixed(1) + ' dy=' + maxDy.toFixed(1) + 'px at ' + worst };
        }
        if (fullBracket && (!spliceBracket
            || Math.abs(spliceBracket.x - fullBracket.x) >= 3
            || Math.abs(spliceBracket.w - fullBracket.w) >= 3)) {
          return { ok: false, detail: 'volta bracket diverged: splice=' + JSON.stringify(spliceBracket) + ' full=' + JSON.stringify(fullBracket) };
        }
        return { ok: true };
      })()` },
  ],
  scrollSpliceHairpinHostEdit: [
    { name: 'an edit at a multi-measure hairpin host measure keeps the wedge (run expands over the tstamp2 span) and matches a full re-engrave',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const score = document.getElementById('score');
        const wedge = () => {
          const g = score.querySelector('svg:not(#cursorOverlay) #hp-span-fixture');
          if (!g) return null;
          const b = g.getBBox();
          const t = g.transform.baseVal.consolidate();
          return { x: Math.round(b.x + (t ? t.matrix.e : 0)), w: Math.round(b.width) };
        };
        const w0 = wedge();
        if (!w0) return { ok: false, detail: 'baseline wedge missing from SVG' };
        const snap = m.snapshotState();
        m.setCursor(m.getMeasureStartCursor(1, 0) + 1, 1);
        const del = m.deleteAtCursor();   // converted edit at the HOST measure
        window.__hkl_composer.reRender(); // SPLICE path
        const wS = wedge();
        window.__hkl_composer.renderer.forceFullRerender();
        window.__hkl_composer.reRender();
        const wF = wedge();
        m.restoreSnapshot(snap);
        window.__hkl_composer.renderer.forceFullRerender();
        window.__hkl_composer.reRender();
        if (!del) return { ok: false, detail: 'delete at host was rejected' };
        if (!wS) return { ok: false, detail: 'WEDGE DELETED by splice (tstamp2 span not expanded)' };
        if (!wF) return { ok: false, detail: 'wedge missing from full re-engrave (fixture setup issue)' };
        return (Math.abs(wS.x - wF.x) < 3 && Math.abs(wS.w - wF.w) < 3)
          ? { ok: true }
          : { ok: false, detail: 'wedge geometry diverged: splice=' + JSON.stringify(wS) + ' full=' + JSON.stringify(wF) };
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
  scrollPieceEndReachable: [
    { name: 'cursor is at the synthetic past-end stop',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        return m.isCursorAtPastEnd(1)
          ? { ok: true }
          : { ok: false, detail: 'isCursorAtPastEnd(1)=false; cursor=' + m.getCursor(1) + ' len=' + m.getVoiceLength(1) };
      })()` },
    { name: 'past-end cursor lands just past the last measure right edge (pastEndRight)',
      expr: `(() => {
        const R = window.__hkl_composer.renderer;
        const m = window.__hkl_composer.model;
        const measures = [...m.getDoc().querySelectorAll('section > measure')];
        const lastId = measures[measures.length - 1].getAttribute('xml:id');
        const mr = R.rectForId(lastId);
        if (!mr) return { ok: false, detail: 'last measure not rendered' };
        const bar = [...document.querySelectorAll('#cursorOverlay rect')]
          .find(el => el.getAttribute('opacity') === '0.85');
        if (!bar) return { ok: false, detail: 'no active cursor bar' };
        const x = parseFloat(bar.getAttribute('x'));
        /* pastEndRight x = rect(lastMeasure).right + 2*CURSOR_HPAD (=8). */
        return Math.abs(x - (mr.right + 8)) < 2
          ? { ok: true }
          : { ok: false, detail: 'cursorX=' + x.toFixed(1) + ' expected~' + (mr.right + 8).toFixed(1) };
      })()` },
    { name: 'past-end cursor + final barline are inside the scrollable width (reachable, not clipped)',
      expr: `(() => {
        const R = window.__hkl_composer.renderer;
        const m = window.__hkl_composer.model;
        const score = document.getElementById('score');
        const measures = [...m.getDoc().querySelectorAll('section > measure')];
        const lastId = measures[measures.length - 1].getAttribute('xml:id');
        const mr = R.rectForId(lastId);
        if (!mr) return { ok: false, detail: 'last measure not rendered' };
        const bar = [...document.querySelectorAll('#cursorOverlay rect')]
          .find(el => el.getAttribute('opacity') === '0.85');
        const cursorRight = bar ? parseFloat(bar.getAttribute('x')) + parseFloat(bar.getAttribute('width')) : 0;
        const overlayW = document.getElementById('cursorOverlay').getBoundingClientRect().width;
        const sw = score.scrollWidth;
        /* mr.right (= barline region) and the past-end cursor must both fit
           within scrollWidth (reachable) and the overlay width (drawable). */
        if (mr.right > sw + 1) return { ok: false, detail: 'barline right ' + mr.right.toFixed(1) + ' > scrollWidth ' + sw };
        if (cursorRight > sw + 1) return { ok: false, detail: 'cursorRight ' + cursorRight.toFixed(1) + ' > scrollWidth ' + sw };
        if (cursorRight > overlayW + 1) return { ok: false, detail: 'cursorRight ' + cursorRight.toFixed(1) + ' > overlayWidth ' + overlayW };
        return { ok: true };
      })()` },
  ],
  scrollExprLayerFollowsMoment: [
    { name: 'End in the expression layer scrolls to the layer\'s last moment, and editing the mark there does not jump back to the voice cursor\'s page',
      expr: `(async () => {
        const H = window.__hkl_composer; const score = document.getElementById('score');
        const busy = () => { const b = document.getElementById('renderBusy'); return !!b && !b.hidden; };
        for (let i = 0; i < 200 && busy(); i++) await new Promise(r => setTimeout(r, 50));
        score.scrollTop = 0;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        const mode = H.inputState().cursorMode;
        if (mode !== 'expr') return { ok: false, detail: 'ArrowDown from voice 2 did not enter the expression layer (mode ' + mode + ')' };
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        await window.__waitForScrollSettle(2000);
        const inView = () => { const r = H.renderer.rectForId(window.__lastMeasureId); if (!r) return 'unmounted'; return r.top >= score.scrollTop - 1 && r.bottom <= score.scrollTop + score.clientHeight + 1 ? 'yes' : 'no(top ' + r.top.toFixed(0) + ' scroll ' + score.scrollTop + ' h ' + score.clientHeight + ')'; };
        const afterEnd = inView();
        if (afterEnd !== 'yes') return { ok: false, detail: 'after End the last measure is not in view: ' + afterEnd };
        const before = score.scrollTop;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, bubbles: true }));
        for (let i = 0; i < 200 && busy(); i++) await new Promise(r => setTimeout(r, 50));
        await window.__waitForScrollSettle(2000);
        const afterEdit = inView();
        if (afterEdit !== 'yes') return { ok: false, detail: 'after editing the mark the view left the last measure: ' + afterEdit + ' (scrollTop ' + before + ' → ' + score.scrollTop + ')' };
        return { ok: true, detail: 'scrollTop ' + score.scrollTop };
      })()` },
  ],
};

/* The typed-in-scroll sibling asserts EXACTLY what scrollPieceEndReachable
   asserts — spread rather than copied, so the pair cannot drift — plus system
   coherence. The only difference that matters is the fixture's setup ordering:
   one watches a full engrave, the other watches a splice. */
ASSERTIONS.scrollPieceEndReachableAfterTyping = [
  ...ASSERTIONS.scrollPieceEndReachable,
  { name: 'scroll system is coherent (staff rows agree, furniture on them, box covers content)',
    expr: `window.__test.assertScrollSystemCoherent()` },
];
