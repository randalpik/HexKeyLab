// Composer test fixtures — slurs.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

/* Three quarter notes in V1 M1. In insert mode the per-measure flat stream
 * is [wrapper, note0, note1, note2], so note0 sits at cursor index 1. */
const SLUR_3Q_V1 = `
  m.setCursor(0, 1);
  m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
  m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
  m.insertChordAtCursor({ notes: [{ q: 1, r: 0, pname: 'c', accid: 's', oct: 4, midi: 61, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
  m.setCursor(1, 1);
`;

export const FIXTURES = {

  /* ── Slurs (Ctrl+L pending-state entry; §7.20) ───────────────────────── */
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
  /* Dark theme + a slur. Guards that slurs/ties (filled Verovio <path>s, NOT
   * stroked) recolor to --notation-ink in dark — an early version put them in
   * the stroke-only rule, so they stayed black/invisible on the dark staff. */
  visualDarkSlur: {
    setup: `${SLUR_3Q_V1} window.__hkl_composer.renderer.setTheme('dark');`,
    setupKeys: [
      { key: 'l', ctrl: true },
      { key: 'ArrowRight' },
      { key: 'l', ctrl: true },
    ],
    visualBaseline: 'dark_slur',
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
  /* Start a slur, switch voices (ArrowDown, voice→voice) → pending
     slur is PRESERVED (so the user can close a slur whose endpoints span two
     staves). Was previously cleared; the "voice reset" is lifted. */
  slur_voiceSwitch_preservesPending: {
    setup: SLUR_3Q_V1,
    setupKeys: [
      { key: 'l', ctrl: true },
      { key: 'ArrowDown' },
    ],
  },
  /* A pending slur SURVIVES traversing into a non-voice layer
     (ArrowUp → tempo layer), so the user can pass through the expr/pedal/tempo
     layers to reach the other staff before closing a cross-staff slur. Only
     Escape / select-mode / undo drop it. */
  slur_layerStop_preservesPending: {
    setup: SLUR_3Q_V1,
    setupKeys: [
      { key: 'l', ctrl: true },
      { key: 'ArrowUp' },   /* V1 → tempo layer (mode changes, slur survives) */
    ],
  },
  /* A cross-staff slur — start on a V1 (treble) beat-1 note, arrow
     down to V3 (bass), step onto its beat-2 note, close. One <slur> binds slots
     on staff 1 and staff 2; it renders an arc. Endpoints are at DIFFERENT times
     (Verovio rejects a startid/endid pair sharing a timestamp). */
  slur_cross_staff: {
    setup: `
      m.setVoice(1); m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setVoice(3); m.setCursor(0, 3);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 2, midi: 45, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(1, 1);
    `,
    setupKeys: [
      { key: 'l', ctrl: true },     /* start on V1 beat-1 note */
      { key: 'ArrowDown' },         /* V1 → V2 */
      { key: 'ArrowDown' },         /* V2 → V3 (expr empty, skipped) */
      { key: 'ArrowRight' },        /* wrapper → V3 beat-1 rest */
      { key: 'ArrowRight' },        /* → onto V3 beat-2 note */
      { key: 'l', ctrl: true },     /* close: cross-staff slur */
    ],
  },
  /* Regression: the same cross-staff slur, but traversing a
     NON-EMPTY expression layer en route (a dynam in M1 makes ↓ stop in expr
     mode). The pending slur must survive that stop — the user's reported bug
     was that traversing the expr layer dropped the slur. */
  slur_cross_staff_through_expr: {
    setup: `
      m.setVoice(1); m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setVoice(3); m.setCursor(0, 3);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 2, midi: 45, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      const doc = m.getDoc(); const MEI = 'http://www.music-encoding.org/ns/mei';
      const d = doc.createElementNS(MEI, 'dynam');
      d.setAttribute('xml:id', 'd-expr-stop'); d.setAttribute('tstamp', '1');
      d.setAttribute('place', 'between'); d.setAttribute('staff', '1'); d.textContent = 'mf';
      doc.querySelectorAll('measure')[0].appendChild(d);
      m.setVoice(1); m.setCursor(1, 1);
    `,
    setupKeys: [
      { key: 'l', ctrl: true },     /* start on V1 beat-1 note */
      { key: 'ArrowDown' },         /* V1 → V2 */
      { key: 'ArrowDown' },         /* V2 → expr (NON-empty: stops here) */
      { key: 'ArrowDown' },         /* expr → V3 (slur must survive the expr stop) */
      { key: 'ArrowRight' },        /* wrapper → V3 beat-1 rest */
      { key: 'ArrowRight' },        /* → onto V3 beat-2 note */
      { key: 'l', ctrl: true },     /* close: cross-staff slur */
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
  /* Shift+L on a slurred note sets @curvedir on the slur. Single-note
     "chord" inputs serialize as bare <note> elements, so the IDs live on
     notes, not chords. */
  slur_flip_setsAttr: {
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
};

export const ASSERTIONS = {
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
  slur_voiceSwitch_preservesPending: [
    { name: 'voice→voice switch PRESERVES the pending slur (cross-staff enabled)',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        const v = window.__hkl_composer.model.getCurrentVoice();
        return (s.cursorMode === 'voice' && v === 2 && s.pendingSlur !== null)
          ? { ok: true }
          : { ok: false, detail: 'voice=' + v + ' mode=' + s.cursorMode + ' pending=' + JSON.stringify(s.pendingSlur) };
      })()` },
  ],
  slur_layerStop_preservesPending: [
    { name: 'pending slur survives entering the tempo layer',
      expr: `(() => {
        const s = window.__hkl_composer.inputState();
        return (s.cursorMode === 'tempo' && s.pendingSlur !== null)
          ? { ok: true }
          : { ok: false, detail: 'mode=' + s.cursorMode + ' pending=' + JSON.stringify(s.pendingSlur) };
      })()` },
  ],
  slur_cross_staff: [
    { name: 'one slur binds a staff-1 slot to a staff-2 slot and renders',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const doc = m.getDoc();
        const slurs = doc.querySelectorAll('slur');
        if (slurs.length !== 1) return { ok: false, detail: 'slur count=' + slurs.length };
        const slur = slurs[0];
        const strip = (v) => v && v.charAt(0) === '#' ? v.slice(1) : v;
        const find = (id) => [...doc.querySelectorAll('note,chord')].find((n) => n.getAttribute('xml:id') === id);
        const se = find(strip(slur.getAttribute('startid')));
        const ee = find(strip(slur.getAttribute('endid')));
        const ss = se && se.closest('staff') && se.closest('staff').getAttribute('n');
        const es = ee && ee.closest('staff') && ee.closest('staff').getAttribute('n');
        if (ss === es) return { ok: false, detail: 'endpoints on same staff ' + ss + ' (expected cross-staff)' };
        const rendered = !!document.querySelector('#score svg g.slur');
        return rendered ? { ok: true } : { ok: false, detail: 'slur not rendered (staffs ' + ss + '/' + es + ')' };
      })()` },
  ],
  slur_cross_staff_through_expr: [
    { name: 'cross-staff slur closes after traversing a non-empty expr layer',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const doc = m.getDoc();
        const slurs = doc.querySelectorAll('slur');
        if (slurs.length !== 1) return { ok: false, detail: 'slur count=' + slurs.length };
        const strip = (v) => v && v.charAt(0) === '#' ? v.slice(1) : v;
        const find = (id) => [...doc.querySelectorAll('note,chord')].find((n) => n.getAttribute('xml:id') === id);
        const se = find(strip(slurs[0].getAttribute('startid')));
        const ee = find(strip(slurs[0].getAttribute('endid')));
        const ss = se && se.closest('staff') && se.closest('staff').getAttribute('n');
        const es = ee && ee.closest('staff') && ee.closest('staff').getAttribute('n');
        return ss !== es ? { ok: true } : { ok: false, detail: 'endpoints same staff ' + ss };
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
  slur_flip_setsAttr: [
    { name: 'slur has @curvedir set to "above" or "below"',
      expr: `(() => {
        const m = window.__hkl_composer.model;
        const slur = m.getDoc().querySelector('slur');
        const d = slur?.getAttribute('curvedir');
        return (d === 'above' || d === 'below') ? { ok: true } : { ok: false, detail: 'curvedir=' + d };
      })()` },
  ],
};
