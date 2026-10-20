// Composer test fixtures — playback.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

export const FIXTURES = {

  /* ── Bridge mock (HKL side simulation) ──────────────────────────── */
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
  /* Composer → HKL: the "Composer view in HKL" streams. On connect (hkl-hello)
   * Composer broadcasts composer-score (the cursor instrument's MEI) and
   * composer-cursor (the editing cursor's measure). Asserted via
   * FIXTURE_ASSERTIONS.composerViewBroadcasts. */
  composerViewBroadcasts: {
    setup: `
      window.__bridgeMock.reset();
      window.__bridgeMock.sendHklHello();
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', lightColorHex: '#ffcc66', velocity: 80 }],
        duration: '4', dots: 0,
      });
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
  /* Multi-instrument playback tags each event with the instrument's NAME (its
     <label>), not an opaque sample-set key. Regression guard for the Viola+Piano
     "no audio" bug: the importer/model used to emit instrumentKey="piano" (a key
     HKL can't resolve → silent). A 2-instrument score (implicit "Piano" + an
     added "Viola") must send play-score events whose instrumentName set is
     exactly {Piano, Viola} — HKL resolves those against its dropdown. */
  multiInstrument_playScoreUsesNames: {
    setup: `
      window.__bridgeMock.sendHklHello();
      m.addInstrument({ name: 'Viola', staffCount: 1 });
      m.setVoice(1); m.setCursor(0);
      m.insertChordAtCursor({
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }],
        duration: '4', dots: 0,
      });
      m.setVoice(5); m.setCursor(0);
      m.insertChordAtCursor({
        notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 }],
        duration: '4', dots: 0,
      });
      m.setVoice(1); m.setCursor(0);
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
  /* Transport mutual-exclusion. A reusable single-note single-instrument
     setup (so both clock playback and Performance mode can start), then the
     transport keys/buttons drive the state transitions asserted below. */

  /* Shift+Space then Space: Performance starts, then Space STOPS it (not
     start playback). Asserts start-performance then stop-performance, and no
     play-score (Space did not fall through to playback). */
  space_stops_performance: {
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
    setupKeys: [{ key: ' ', shift: true }, ' '],
  },
  /* Space (start playback) then Shift+Space: Shift+Space is a no-op while a
     transport runs. Asserts play-score present, NO start-performance. */
  shift_space_noop_during_playback: {
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
    setupKeys: [' ', { key: ' ', shift: true }],
  },
  /* Shift+Space twice: the second is a no-op (Performance already running).
     Asserts exactly one start-performance and zero stop-performance. */
  shift_space_noop_during_performance: {
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
    setupKeys: [{ key: ' ', shift: true }, { key: ' ', shift: true }],
  },
  /* Shift+Space from idle starts Performance. Asserts start-performance. */
  shift_space_starts_performance_idle: {
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
    setupKeys: [{ key: ' ', shift: true }],
  },
  /* Play BUTTON during Performance switches transports: stop performance AND
     start playback (the buttons differ from the keys). hkl-hello is async, so
     poll until the connection indicator flips before clicking (the transports
     bail if not connected). Asserts stop-performance then play-score. */
  play_button_switches_from_performance: {
    setup: `
      window.__bridgeMock.sendHklHello();
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }],
        duration: '4', dots: 0,
      });
      m.setCursor(0, 1);
      window.__bridgeMock.reset();
      (function whenConnected(tries) {
        const conn = document.getElementById('connStatus');
        if (conn && conn.classList.contains('connected')) {
          document.getElementById('btnPerform').click();
          document.getElementById('btnPlay').click();
        } else if (tries > 0) {
          setTimeout(() => whenConnected(tries - 1), 5);
        }
      })(60);
    `,
  },
  /* Perform BUTTON during playback switches transports: stop playback AND
     start performance. Asserts stop-playback then start-performance. */
  perform_button_switches_from_playback: {
    setup: `
      window.__bridgeMock.sendHklHello();
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }],
        duration: '4', dots: 0,
      });
      m.setCursor(0, 1);
      window.__bridgeMock.reset();
      (function whenConnected(tries) {
        const conn = document.getElementById('connStatus');
        if (conn && conn.classList.contains('connected')) {
          document.getElementById('btnPlay').click();
          document.getElementById('btnPerform').click();
        } else if (tries > 0) {
          setTimeout(() => whenConnected(tries - 1), 5);
        }
      })(60);
    `,
  },
  /* The key-signature tonic drives HKL's score-ref tier. 2 sharps + minor =
     B minor → the B on the Pythagorean spine nearest C4 = B3 = (-3, 2).
     This is the worked example the whole feature is specified against. */
  score_ref_broadcast_carries_key_tonic: {
    setup: `
      m.setKeySig('2s');
      m.setKeyMode('minor');
      window.__bridgeMock.reset();
      window.__bridgeMock.sendHklHello();
    `,
  },
  /* F major is the ONE tonic whose placement changed when the rule moved from
     "lowest octave >= F3" to "nearest C4": F3 (53) is 7 semitones from C4,
     F4 (65) only 5. Pins that intentional delta. */
  score_ref_tonic_f_is_f4: {
    setup: `
      m.setKeySig('1f');
      m.setKeyMode('major');
      window.__bridgeMock.reset();
      window.__bridgeMock.sendHklHello();
    `,
  },
  /* The ref tracks the key at the CURSOR, not at measure 1. M_1 is C major,
     M_2 onward is A major; a Ctrl+Right into M_2 must re-broadcast the A
     tonic. Driven by a real keystroke so the cursor-move fan-out runs. */
  score_ref_follows_midscore_key_change: {
    setup: `
      m.setKeySig('0');
      m.setKeyMode('major');
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.appendMeasure();
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setKeySigAt(1, '3s', 'major');
      m.setCursor(0, 1);
      window.__hkl_composer.reRender();
      window.__bridgeMock.sendHklHello();
      window.__bridgeMock.reset();
    `,
    /* Ctrl+Right lands AT the barline (still visually M_1); one more step puts
       the cursor unambiguously inside M_2. */
    setupKeys: [{ key: 'ArrowRight', ctrl: true }, 'ArrowRight'],
  },
  /* Same rendered signature (2 sharps), different mode: D major -> B minor at
     M_2. Before the setKeySigAt fix this wrote nothing at all (the diff-elide
     keyed on sig alone), so the tonic never moved. Exercises the mode-only
     <scoreDef> override end to end. */
  score_ref_updates_on_keymode_flip: {
    setup: `
      m.setKeySig('2s');
      m.setKeyMode('major');
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.appendMeasure();
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.setKeySigAt(1, '2s', 'minor');
      m.setCursor(0, 1);
      window.__hkl_composer.reRender();
      window.__bridgeMock.sendHklHello();
      window.__bridgeMock.reset();
    `,
    setupKeys: [{ key: 'ArrowRight', ctrl: true }, 'ArrowRight'],
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
  /* Item 3: the per-voice playback bar must HIDE on a user-hidden rest
     (visible="false" → CSS visibility:hidden but still laid out) rather than
     park on its invisible coordinates, while still showing on visible notes.
     Score: note A4, hidden quarter rest, note A4. Asserted in
     FIXTURE_ASSERTIONS.playback_bar_hidden_on_hidden_rest by driving the
     playback cursor onto the hidden rest then a visible note. */
  /* Same contract as perfScoreRefFollowsPosition, for CLOCK playback: a
     playback-position landing in the A-major bar re-broadcasts the A tonic
     while the editing cursor stays parked in the C-major bar. */
  playback_score_ref_follows_position: {
    setup: `
      window.__bridgeMock.sendHklHello();
      m.setKeySig('0');
      m.setKeyMode('major');
      m.setCursor(0, 1);
      const A3 = { q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 };
      m.insertChordAtCursor({ notes: [A3], duration: '1', dots: 0 });
      m.appendMeasure();
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      window.__m2NoteId = m.insertChordAtCursor({ notes: [A3], duration: '1', dots: 0 });
      m.setKeySigAt(1, '3s', 'major');
      m.setCursor(0, 1);
      window.__hkl_composer.reRender();
      window.__bridgeMock.reset();
    `,
    /* Space → startPlayback so isPlaying is true and refSourceMeasure follows
       the sounding head rather than the editing cursor. */
    setupKeys: [' '],
  },
  playback_bar_hidden_on_hidden_rest: {
    setup: `
      window.__bridgeMock.sendHklHello();
      m.setCursor(0, 1);
      const note = [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888888', velocity: 80 }];
      const noteId = m.insertChordAtCursor({ notes: note, duration: '4', dots: 0 });
      const restId = m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.toggleHideRestAtCursor('overwrite');   /* hides the just-inserted rest */
      m.insertChordAtCursor({ notes: note, duration: '4', dots: 0 });
      m.setCursor(0, 1);
      window.__hkl_composer.reRender();
      window.__hiddenRestId = restId;
      window.__visibleNoteId = noteId;
      window.__bridgeMock.reset();
    `,
    /* Space → startPlayback → cursor.setPlaybackMode(true) so the per-voice
       playback bars (not the editing cursor) are what render. */
    setupKeys: [' '],
  },
  /* Item 4: when playback ends, Composer must broadcast a composer-cursor so
     HKL's read-only frame resyncs its editing anchor (finalizePlaybackEnd
     bypasses the usual onStateChange broadcast path). Start playback (Space),
     then simulate HKL's playback-finished; assert composer-cursor is emitted.
     Asserted in FIXTURE_ASSERTIONS.playback_end_resyncs_hkl_cursor. */
  playback_end_resyncs_hkl_cursor: {
    setup: `
      window.__bridgeMock.sendHklHello();
      m.setCursor(0, 1);
      const note = [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888888', velocity: 80 }];
      m.insertChordAtCursor({ notes: note, duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: note, duration: '4', dots: 0 });
      m.setCursor(0, 1);
      window.__bridgeMock.reset();
    `,
    setupKeys: [' '],
  },
  /* A voice whose content ends before the score does must have its per-voice
     playback bar cleared (playback-position with meiId=null + that voice),
     not leave it orphaned. Two-voice score; the assertion shows both bars,
     then clears voice 2 and checks only voice 1 remains. Asserted in
     FIXTURE_ASSERTIONS.playback_clears_orphaned_voice. */
  playback_clears_orphaned_voice: {
    setup: `
      window.__bridgeMock.sendHklHello();
      m.setVoice(1); m.setCursor(0, 1);
      const v1id = m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888888', velocity: 80 }], duration: '4', dots: 0 });
      m.setVoice(2); m.setCursor(0, 2);
      const v2id = m.insertChordAtCursor({ notes: [{ q: -4, r: -2, pname: 'c', accid: '', oct: 4, midi: 60, colorHex: '#888888', velocity: 80 }], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      window.__hkl_composer.reRender();
      window.__v1id = v1id; window.__v2id = v2id;
      window.__bridgeMock.reset();
    `,
    setupKeys: [' '],
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
      /* 7 sharps major = C# major. The hello re-broadcasts the key tonic as
         set-score-ref, and also exercises the empty-voice selection-tier
         silence + composer-hello echo contract below. */
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
  /* Plain → during playback stops at the most-recent playback head.
     Simulate playback active and pointing at the SECOND rest's meiId. */
  playback_plainArrow_stopsAtHead: {
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
  playback_ctrlArrow_seeks: {
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
  playback_ctrlLeft_atBoundary_jumpsPrev: {
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
  playback_ctrlLeft_midMeasure_jumpsCurrent: {
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
  playback_ctrlArrow_seeks_repeatable: {
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
  playback_staleFinishAck_ignored: {
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
};

export const ASSERTIONS = {
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
  composerViewBroadcasts: [
    { name: 'composer-score (single-instrument MEI) + composer-cursor emitted on connect',
      expr: `(async () => {
        for (let i = 0; i < 4; i++) { await new Promise((r) => requestAnimationFrame(() => r(true))); await Promise.resolve(); }
        const cap = window.__bridgeMock.captured();
        const score = cap.find((m) => m.type === 'composer-score');
        const cursor = cap.find((m) => m.type === 'composer-cursor');
        if (!score) return { ok: false, detail: 'no composer-score; captured=' + JSON.stringify(cap.map((c) => c.type)) };
        if (typeof score.mei !== 'string' || !score.mei.includes('<note')) return { ok: false, detail: 'composer-score mei missing notes' };
        if (!cursor) return { ok: false, detail: 'no composer-cursor; captured=' + JSON.stringify(cap.map((c) => c.type)) };
        if (typeof cursor.measureIdx !== 'number') return { ok: false, detail: 'composer-cursor.measureIdx not a number' };
        if (typeof cursor.voice !== 'number') return { ok: false, detail: 'composer-cursor.voice not a number' };
        const a = cursor.anchor;
        if (!a || typeof a.xMode !== 'string' || typeof a.vMode !== 'string') {
          return { ok: false, detail: 'composer-cursor.anchor shape: ' + JSON.stringify(a) };
        }
        return { ok: true };
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
  multiInstrument_playScoreUsesNames: [
    { name: 'play-score events carry instrument NAMES {Piano, Viola}, not keys',
      expr: `(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(true)));
        await Promise.resolve();
        const captured = window.__bridgeMock.captured();
        const ps = captured.find((m) => m.type === 'play-score');
        if (!ps) return { ok: false, detail: 'no play-score; captured=' + JSON.stringify(captured.map((c) => c.type)) };
        const evs = ps.events || [];
        const names = [...new Set(evs.map((e) => e.instrumentName))].sort();
        const badKey = evs.some((e) => e.instrumentName === 'piano' || e.instrumentName == null);
        const ok = !badKey && names.length === 2 && names[0] === 'Piano' && names[1] === 'Viola';
        return ok
          ? { ok: true }
          : { ok: false, detail: 'names=' + JSON.stringify(names) + ' badKey=' + badKey };
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
  space_stops_performance: [
    { name: 'Shift+Space starts performance, Space stops it (no play-score)',
      expr: `(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(true)));
        await Promise.resolve();
        const types = window.__bridgeMock.captured().map((c) => c.type);
        const startIdx = types.indexOf('start-performance');
        const stopIdx = types.indexOf('stop-performance');
        const ok = startIdx >= 0 && stopIdx > startIdx && !types.includes('play-score');
        return ok
          ? { ok: true }
          : { ok: false, detail: 'captured=' + JSON.stringify(types) };
      })()` },
  ],
  shift_space_noop_during_playback: [
    { name: 'Shift+Space during playback is a no-op (no start-performance)',
      expr: `(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(true)));
        await Promise.resolve();
        const types = window.__bridgeMock.captured().map((c) => c.type);
        const ok = types.includes('play-score') && !types.includes('start-performance');
        return ok
          ? { ok: true }
          : { ok: false, detail: 'captured=' + JSON.stringify(types) };
      })()` },
  ],
  shift_space_noop_during_performance: [
    { name: 'second Shift+Space is a no-op (one start-performance, no stop)',
      expr: `(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(true)));
        await Promise.resolve();
        const types = window.__bridgeMock.captured().map((c) => c.type);
        const starts = types.filter((t) => t === 'start-performance').length;
        const stops = types.filter((t) => t === 'stop-performance').length;
        const ok = starts === 1 && stops === 0;
        return ok
          ? { ok: true }
          : { ok: false, detail: 'starts=' + starts + ' stops=' + stops + ' captured=' + JSON.stringify(types) };
      })()` },
  ],
  shift_space_starts_performance_idle: [
    { name: 'Shift+Space from idle sends start-performance',
      expr: `(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(true)));
        await Promise.resolve();
        const types = window.__bridgeMock.captured().map((c) => c.type);
        return types.includes('start-performance')
          ? { ok: true }
          : { ok: false, detail: 'captured=' + JSON.stringify(types) };
      })()` },
  ],
  play_button_switches_from_performance: [
    { name: 'Play button during performance: stop-performance then play-score',
      expr: `(async () => {
        for (let i = 0; i < 80; i++) {
          const types = window.__bridgeMock.captured().map((c) => c.type);
          const stopIdx = types.indexOf('stop-performance');
          const playIdx = types.indexOf('play-score');
          if (stopIdx >= 0 && playIdx > stopIdx) return { ok: true };
          await new Promise((r) => setTimeout(r, 10));
        }
        return { ok: false, detail: 'captured=' + JSON.stringify(window.__bridgeMock.captured().map((c) => c.type)) };
      })()` },
  ],
  perform_button_switches_from_playback: [
    { name: 'Perform button during playback: stop-playback then start-performance',
      expr: `(async () => {
        for (let i = 0; i < 80; i++) {
          const types = window.__bridgeMock.captured().map((c) => c.type);
          const stopIdx = types.indexOf('stop-playback');
          const perfIdx = types.indexOf('start-performance');
          if (stopIdx >= 0 && perfIdx > stopIdx) return { ok: true };
          await new Promise((r) => setTimeout(r, 10));
        }
        return { ok: false, detail: 'captured=' + JSON.stringify(window.__bridgeMock.captured().map((c) => c.type)) };
      })()` },
  ],
  score_ref_tonic_f_is_f4: [
    { name: 'F major tonic is F4 = (9, -4), not F3',
      expr: `(() => {
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref captured' };
        const last = sr[sr.length - 1];
        return last.q === 9 && last.r === -4
          ? { ok: true, detail: 'q=' + last.q + ' r=' + last.r }
          : { ok: false, detail: 'q=' + last.q + ' r=' + last.r + ' (expected 9, -4 = F4)' };
      })()` },
    { name: 'F4 is nearer C4 than F3 (the rule being pinned)',
      expr: `(() => {
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref captured' };
        const last = sr[sr.length - 1];
        const midi = 57 + 4 * last.q + 7 * last.r;
        return midi === 65
          ? { ok: true, detail: 'midi=' + midi }
          : { ok: false, detail: 'midi=' + midi + ' (expected 65 = F4)' };
      })()` },
  ],
  score_ref_follows_midscore_key_change: [
    { name: 'Ctrl+Right into the A-major bar re-broadcasts the A tonic (0, 0)',
      expr: `(() => {
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref captured' };
        const last = sr[sr.length - 1];
        return last.q === 0 && last.r === 0
          ? { ok: true, detail: 'q=' + last.q + ' r=' + last.r }
          : { ok: false, detail: 'q=' + last.q + ' r=' + last.r + ' (expected 0, 0 = A3)' };
      })()` },
  ],
  score_ref_updates_on_keymode_flip: [
    { name: 'D major -> B minor at M_2 moves the tonic to B3 = (-3, 2)',
      expr: `(() => {
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref captured' };
        const last = sr[sr.length - 1];
        return last.q === -3 && last.r === 2
          ? { ok: true, detail: 'q=' + last.q + ' r=' + last.r }
          : { ok: false, detail: 'q=' + last.q + ' r=' + last.r + ' (expected -3, 2 = B3)' };
      })()` },
    { name: 'the mode-only override is written without a redundant key.sig',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        if (m.keyModeAt(1) !== 'minor') return { ok: false, detail: 'keyModeAt(1)=' + m.keyModeAt(1) };
        if (m.keySigAt(1) !== '2s') return { ok: false, detail: 'keySigAt(1)=' + m.keySigAt(1) };
        const xml = m.serialize();
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const section = doc.querySelector('section');
        const interior = [...section.children].filter((e) => e.localName === 'scoreDef');
        if (interior.length !== 1) return { ok: false, detail: 'interior scoreDefs=' + interior.length };
        const sd = interior[0];
        if (sd.getAttribute('mode') !== 'minor') return { ok: false, detail: 'override mode=' + sd.getAttribute('mode') };
        if (sd.hasAttribute('key.sig')) return { ok: false, detail: 'override carries a redundant key.sig' };
        return { ok: true };
      })()` },
  ],
  score_ref_broadcast_carries_key_tonic: [
    { name: 'B minor → set-score-ref carries B3 = (-3, 2)',
      expr: `(() => {
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref captured' };
        const last = sr[sr.length - 1];
        return last.q === -3 && last.r === 2
          ? { ok: true, detail: 'q=' + last.q + ' r=' + last.r }
          : { ok: false, detail: 'q=' + last.q + ' r=' + last.r + ' (expected -3, 2)' };
      })()` },
    { name: 'the tonic sits on the Pythagorean spine, 2nd column of its band',
      expr: `(() => {
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref captured' };
        const last = sr[sr.length - 1];
        const pos = ((last.q + 1) % 3 + 3) % 3;
        const midi = 57 + 4 * last.q + 7 * last.r;
        if (pos !== 1) return { ok: false, detail: 'posInBand=' + pos + ' (expected 1)' };
        if (midi !== 59) return { ok: false, detail: 'midi=' + midi + ' (expected 59 = B3)' };
        return { ok: true };
      })()` },
  ],
  playback_score_ref_follows_position: [
    { name: 'playback into the A-major bar re-broadcasts the A tonic (0, 0)',
      expr: `(async () => {
        const frames = async () => { for (let i = 0; i < 3; i++) { await new Promise((r) => requestAnimationFrame(() => r(true))); await Promise.resolve(); } };
        await frames();
        window.__bridgeMock.reset();
        window.__bridgeMock.sendPlaybackPosition(window.__m2NoteId, 0);
        await frames();
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref after playback-position' };
        const last = sr[sr.length - 1];
        return last.q === 0 && last.r === 0
          ? { ok: true, detail: 'q=' + last.q + ' r=' + last.r }
          : { ok: false, detail: 'q=' + last.q + ' r=' + last.r + ' (expected 0, 0 = A3)' };
      })()` },
    { name: 'the editing cursor stayed parked in the C-major bar',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const mi = m.cursorMeasureIdx(1, 'insert');
        return mi === 0 ? { ok: true } : { ok: false, detail: 'cursor measure=' + mi + ' (expected 0)' };
      })()` },
  ],
  playback_bar_hidden_on_hidden_rest: [
    { name: 'playback bar hides on a hidden rest, shows on a visible note',
      expr: `(async () => {
        const frames = async () => { for (let i = 0; i < 3; i++) { await new Promise((r) => requestAnimationFrame(() => r(true))); await Promise.resolve(); } };
        await frames();
        const restId = window.__hiddenRestId;
        const restEl = document.getElementById(restId);
        if (!restEl) return { ok: false, detail: 'hidden rest not in DOM: ' + restId };
        if (restEl.getAttribute('data-visible') !== 'false') return { ok: false, detail: 'rest not data-visible=false' };
        const barOpacities = () => [...document.querySelectorAll('#cursorOverlay rect[data-cursor-role="playback"]')]
          .map((b) => parseFloat(b.getAttribute('opacity') || '1'));
        /* Drive the per-voice playback cursor onto the hidden rest. */
        window.__bridgeMock.sendPlaybackPosition(restId, 500);
        await frames();
        const onRest = barOpacities();
        if (onRest.some((o) => o > 0)) return { ok: false, detail: 'playback bar visible on hidden rest: ' + JSON.stringify(onRest) };
        /* Drive onto a visible note → the bar must reappear (proves the hide is
           specific to the hidden rest, not a blanket suppression). */
        const noteEl = document.querySelector('#score svg g.note');
        if (!noteEl || !noteEl.id) return { ok: false, detail: 'no visible note in DOM' };
        window.__bridgeMock.sendPlaybackPosition(noteEl.id, 0);
        await frames();
        const onNote = barOpacities();
        if (!onNote.some((o) => o > 0)) return { ok: false, detail: 'playback bar not visible on a visible note: ' + JSON.stringify(onNote) };
        return { ok: true };
      })()` },
  ],
  playback_end_resyncs_hkl_cursor: [
    { name: 'playback end broadcasts composer-cursor to resync HKL frame',
      expr: `(async () => {
        const frames = async () => { for (let i = 0; i < 4; i++) { await new Promise((r) => requestAnimationFrame(() => r(true))); await Promise.resolve(); } };
        await frames();
        /* Space already started playback (play-score captured). Clear capture,
           then simulate HKL finishing playback → finalizePlaybackEnd. */
        window.__bridgeMock.reset();
        window.__bridgeMock.sendPlaybackFinished();
        await frames();
        const cap = window.__bridgeMock.captured();
        const cur = cap.find((m) => m.type === 'composer-cursor');
        if (!cur) return { ok: false, detail: 'no composer-cursor after playback-finished; captured=' + JSON.stringify(cap.map((c) => c.type)) };
        return { ok: true };
      })()` },
  ],
  playback_clears_orphaned_voice: [
    { name: 'voice clear (meiId:null + voice) removes only that voice bar',
      expr: `(async () => {
        const frames = async () => { for (let i = 0; i < 3; i++) { await new Promise((r) => requestAnimationFrame(() => r(true))); await Promise.resolve(); } };
        await frames();
        const c = window.__hkl_composer.cursor;
        /* Both voices sounding → both bars present. */
        window.__bridgeMock.sendPlaybackPosition(window.__v1id, 0);
        window.__bridgeMock.sendPlaybackPosition(window.__v2id, 0);
        await frames();
        let pos = c.getPlaybackPositions();
        if (!pos.has(1) || !pos.has(2)) return { ok: false, detail: 'both voices not active before clear: ' + JSON.stringify([...pos.keys()]) };
        /* Voice 2 stops → clear ONLY voice 2. */
        window.__bridgeMock.sendPlaybackPosition(null, 0, 2);
        await frames();
        pos = c.getPlaybackPositions();
        if (pos.has(2)) return { ok: false, detail: 'voice 2 bar not cleared: ' + JSON.stringify([...pos.keys()]) };
        if (!pos.has(1)) return { ok: false, detail: 'voice 1 bar wrongly cleared: ' + JSON.stringify([...pos.keys()]) };
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
    { name: 'score-ref broadcast gives 12-TET pitch class C# (=1)',
      expr: `(() => {
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref captured' };
        const last = sr[sr.length - 1];
        /* coordToMidi = 57 + 4q + 7r; pitch class = midi % 12. C# == 1. */
        const midi = 57 + 4 * last.q + 7 * last.r;
        const pc = ((midi % 12) + 12) % 12;
        return pc === 1
          ? { ok: true }
          : { ok: false, detail: '(q,r)=(' + last.q + ',' + last.r + ') → pc=' + pc + ' (expected 1 = C#)' };
      })()` },
    { name: 'broadcast (q,r) sits on the qm=0 spine in a central octave',
      expr: `(() => {
        const sr = window.__bridgeMock.captured().filter((m) => m.type === 'set-score-ref');
        if (sr.length === 0) return { ok: false, detail: 'no set-score-ref captured' };
        const last = sr[sr.length - 1];
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
  /* ── Playback navigation (Ctrl/plain arrows during playback) ── */
  playback_plainArrow_stopsAtHead: [
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
  playback_ctrlArrow_seeks: [
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
  playback_ctrlLeft_atBoundary_jumpsPrev: [
    { name: 'cursor lands at the start of M_1 (= boundary 0), not M_2',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const boundaries = m.measureBoundaryCursors(1);
        const cur = m.getCursor(1);
        return cur === boundaries[0]
          ? { ok: true } : { ok: false, detail: 'cur=' + cur + ' boundaries=' + boundaries.join(',') };
      })()` },
  ],
  playback_ctrlLeft_midMeasure_jumpsCurrent: [
    { name: 'cursor lands at the start of M_2 (= boundary[1]), not M_1',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const boundaries = m.measureBoundaryCursors(1);
        const cur = m.getCursor(1);
        return cur === boundaries[1]
          ? { ok: true } : { ok: false, detail: 'cur=' + cur + ' boundaries=' + boundaries.join(',') };
      })()` },
  ],
  playback_ctrlArrow_seeks_repeatable: [
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
  playback_staleFinishAck_ignored: [
    { name: 'isPlaying = true after stale playback-finished ack (suppressed by pendingStopAcks)',
      expr: `(() => {
        const btn = document.getElementById('btnPlay');
        const stillPlaying = btn?.classList.contains('playing') ?? null;
        return stillPlaying === true ? { ok: true } : { ok: false, detail: 'btn.playing=' + stillPlaying };
      })()` },
  ],
};
