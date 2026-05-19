// Canonical scenarios for the cursor-trace tooling. Each entry is a JS
// snippet that mutates `m` (= window.__hkl_composer.model) into the named
// state. The driver runs the snippet, then runs the cursor-trace function,
// then snapshots a screenshot.

export const SCENARIOS = {
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

  /* M_1 full + M_2 empty + M_3 with one note. The user's "delete in M_3"
     bug starts from this state. */
  m1FullM2EmptyM3Quarter: `
    /* Fill M_1. */
    m.setCursor(0, 1);
    for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: "4", dots: 0 });
    /* Create M_2 with one note, then delete that note so M_2 is empty. */
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    m.deleteAtCursor();
    /* Now cursor sits in M_2's wrapper. Move past to create M_3 with one
       note. M_1 was full so autofill on M_2 skips (empty stays empty);
       M_3 ends up partial. */
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
  `,

  /* M_1 empty + M_2 with one note. Cursor-position-collision suspect:
     the "start of M_2 with content" stop overlaps the "end of empty M_1"
     stop visually if both wrappers are emitted. */
  m1EmptyM2Quarter: `
    /* Type one quarter in M_2 by first creating M_2 via past-end. */
    m.setCursor(m.getVoiceLength(1), 1);
    m.insertRestAtCursor({ duration: "4", dots: 0 });
    /* Cursor in M_2. Navigate back to M_1 + delete its content so M_1
       becomes empty. Currently M_1 was autofilled when M_2 got content,
       so it's full of rests. Move cursor into M_1 (autofill won't fire
       since cursor inside the measure being edited) and delete all
       autofilled rests. */
    m.setCursor(0, 1);
    /* M_1 should now be the cursor's measure. Delete its content. */
    while (m.allMeasures()[0].querySelector('layer rest, layer note, layer chord')) {
      const layer = m.allMeasures()[0].querySelector('layer');
      const firstReal = Array.from(layer.children).find(
        (c) => c.localName === 'rest' || c.localName === 'note' || c.localName === 'chord'
      );
      if (!firstReal) break;
      /* Move cursor PAST this rest and delete it. */
      const flat = m.flatChildren(1);
      const idx = flat.indexOf(firstReal);
      if (idx < 0) break;
      m.setCursor(idx + 1, 1);
      m.deleteAtCursor();
    }
  `,
};
