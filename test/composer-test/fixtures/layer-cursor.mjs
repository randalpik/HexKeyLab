// Composer test fixtures — layer-cursor.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

import {
  LC_LIB,
  lcAssert,
} from './_helpers.mjs';

/* ── Layer cursors (expr / pedal / tempo), 2026-09-30 ─────────────────────────
   The three virtual-layer cursors step through STOPS — one per mark (a hairpin
   contributes its start and its end) plus a placeholder at each note onset that
   carries no mark — and draw one bar: flush right of the selected mark at its
   rendered height (a hairpin start sits flush LEFT of the wedge, its end flush
   right of the last piece), or a fixed-height bar at the onset's notehead,
   vertically aligned with the previous mark (else a per-layer default). Marks
   sharing a moment are visited one at a time, top to bottom as rendered.
   decisions.md "Layer cursors step through marks". Marks are injected straight
   into the MEI (as kbd_p1_ctrlRight_* do) so placement is explicit. */
const LC_SETUP = `
  const lcN = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
  const lcNotes = (v, n, dur, p, o) => { m.setVoice(v); m.setCursor(0, v); for (let i = 0; i < n; i++) m.insertChordAtCursor({ notes: [lcN(p, o)], duration: dur, dots: 0 }); };
  const lcMark = (mi, name, attrs, text) => {
    const doc = m.getDoc();
    const meas = doc.querySelectorAll('measure')[mi];
    const el = doc.createElementNS('http://www.music-encoding.org/ns/mei', name);
    for (const [a, v] of Object.entries(attrs)) el.setAttribute(a, String(v));
    if (text) el.textContent = text;
    meas.appendChild(el);
    return el;
  };
`;

/* Piano, four quarters in V1; the cursor parked in V1 so ↓↓ enters expr. */
const LC_PIANO = `${LC_SETUP} lcNotes(1, 4, '4', 'a', 4);`;

/* Piano + violin (staff 3, voices 5/6); violin quarters; parked in V6 so ↓ enters the violin's expr layer. */
const LC_VIOLIN = `${LC_SETUP}
  m.addInstrument({ name: 'Violin', staffCount: 1 });
  lcNotes(5, 4, '4', 'a', 4);`;

/* One mark of each kind at beat 2 of the piano's top staff, the hairpin running to beat 4. */
const LC_MULTI = `${LC_PIANO}
  lcMark(0, 'dynam', { 'xml:id': 'lc-d', tstamp: 2, place: 'between', staff: 1 }, 'p');
  lcMark(0, 'dir', { 'xml:id': 'lc-x', tstamp: 2, place: 'between', staff: 1 }, 'dolce');
  lcMark(0, 'hairpin', { 'xml:id': 'lc-h', tstamp: 2, tstamp2: '0m+4', form: 'cres', place: 'between', staff: 1 });
  m.setVoice(1); m.setCursor(1, 1);`;

const LC_PAGE = `window.__hkl_composer.renderer.setViewMode('page');`;

/* Select mark `id` in `layer` (Home, then → until highlighted), then the bar
   must sit flush right of it at its rendered height. */
const lcRightOfMark = (layer, id, page) => lcAssert(`
  if (${!!page} && !document.getElementById('score').classList.contains('view-page')) return { ok: false, detail: 'not in page view: #score class=' + document.getElementById('score').className };
  if (!(await goto('${layer}', '${id}'))) return { ok: false, detail: 'never selected ${id} (cursorMode=' + H.inputState().cursorMode + '); selected=' + JSON.stringify(selected('${layer}')) };
  const b = bar('${layer}'), r = markRect('${id}');
  return rightOf(b, r) ? { ok: true } : { ok: false, detail: 'bar ' + fmt(b) + ' vs mark ' + fmt(r) };
`);

export const FIXTURES = {
  /* Max's report: on a single staff the bar sat ABOVE the staff even with the
     dynamic below it. */
  lc_dynamBelowSingleStaff: {
    setup: `${LC_VIOLIN}
      lcMark(0, 'dynam', { 'xml:id': 'lc-d', tstamp: 2, place: 'below', staff: 3 }, 'p');
      m.setVoice(6); m.setCursor(0, 6);`,
    setupKeys: ['ArrowDown'],
    skipCursorTrace: true,
  },
  lc_dynamBelowSingleStaff_page: {
    setup: `${LC_PAGE} ${LC_VIOLIN}
      lcMark(0, 'dynam', { 'xml:id': 'lc-d', tstamp: 2, place: 'below', staff: 3 }, 'p');
      m.setVoice(6); m.setCursor(0, 6);`,
    setupKeys: ['ArrowDown'],
    skipCursorTrace: true,
  },
  /* Max's report: on a grand staff the bar's height was the inter-staff gap,
     not the dynamic's. */
  lc_dynamBetweenGrandStaff: {
    setup: `${LC_PIANO}
      lcMark(0, 'dynam', { 'xml:id': 'lc-d', tstamp: 2, place: 'between', staff: 1 }, 'mf');
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  lc_dynamBetweenGrandStaff_page: {
    setup: `${LC_PAGE} ${LC_PIANO}
      lcMark(0, 'dynam', { 'xml:id': 'lc-d', tstamp: 2, place: 'between', staff: 1 }, 'mf');
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  lc_dynamAboveGrandStaff: {
    setup: `${LC_PIANO}
      lcMark(0, 'dynam', { 'xml:id': 'lc-d', tstamp: 2, place: 'above', staff: 1 }, 'f');
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  lc_dirBelow: {
    setup: `${LC_PIANO}
      lcMark(0, 'dir', { 'xml:id': 'lc-x', tstamp: 3, place: 'between', staff: 1 }, 'dolce');
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  /* A hairpin's start stop sits at the wedge's left edge, its end stop at the
     right edge. */
  lc_hairpinStartEdge: {
    setup: `${LC_PIANO}
      lcMark(0, 'hairpin', { 'xml:id': 'lc-h', tstamp: 1, tstamp2: '0m+4', form: 'cres', place: 'between', staff: 1 });
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  lc_hairpinEndEdge: {
    setup: `${LC_PIANO}
      lcMark(0, 'hairpin', { 'xml:id': 'lc-h', tstamp: 1, tstamp2: '0m+4', form: 'cres', place: 'between', staff: 1 });
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  /* A hairpin crossing a system break renders as the id'd piece plus
     continuation pieces (`class="hairpin id-<xml:id> spanning"`, no id): the
     end stop follows the LAST piece, on the next system. Every measure from m3
     carries a beat-3 → next-beat-2 hairpin, so whichever measure ends system 1
     supplies the crossing one without the fixture predicting the line breaks.
     (Not m1–m2: the line-break owner's signature-width window renders m1–m2
     alone, and a wedge leaving it logs Verovio's "time spanning element(s)
     … could not be matched" — harmless there, but a CONSOLE failure.) */
  lc_hairpinEndAcrossSystems: {
    setup: `${LC_PAGE} ${LC_SETUP}
      lcNotes(1, 48, '4', 'a', 4);
      for (let mi = 2; mi < 11; mi++) lcMark(mi, 'hairpin', { 'xml:id': 'lc-h' + mi, tstamp: 3, tstamp2: '1m+2', form: mi % 2 ? 'dim' : 'cres', place: 'between', staff: 1 });
      m.setVoice(2); m.setCursor(m.getMeasureStartCursor(2, 2), 2);`,
    setupKeys: ['ArrowDown'],
    skipCursorTrace: true,
  },
  lc_pedalMark: {
    setup: `${LC_PIANO}
      lcNotes(3, 4, '4', 'a', 2);
      lcMark(0, 'pedal', { 'xml:id': 'lc-p', tstamp: 2, dir: 'down', staff: 2 });
      m.setVoice(4); m.setCursor(0, 4);`,
    setupKeys: ['ArrowDown'],
    skipCursorTrace: true,
  },
  /* The render clone restates the tempo above every part; the bar follows the
     original. */
  lc_tempoTwoInstruments: {
    setup: `${LC_VIOLIN}
      lcNotes(1, 4, '4', 'a', 4);
      lcMark(0, 'tempo', { 'xml:id': 'lc-t', tstamp: 1, place: 'above', staff: 1 }, 'Allegro');
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowUp'],
    skipCursorTrace: true,
  },
  /* A placeholder (onset without a mark) draws the fixed-height bar at the
     onset's notehead, vertically centred on the previous mark. */
  lc_placeholderAlignsPrevMark: {
    setup: `${LC_PIANO}
      lcMark(0, 'dynam', { 'xml:id': 'lc-d', tstamp: 1, place: 'between', staff: 1 }, 'p');
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  /* …also across a system break: the previous mark's offset from its staff
     lines is reapplied to the same staff where the placeholder is. A beat-4
     dynamic in every measure; the assertion picks the one ending system 1. */
  lc_placeholderAcrossSystems: {
    setup: `${LC_PAGE} ${LC_SETUP}
      lcNotes(1, 48, '4', 'a', 4);
      for (let mi = 0; mi < 12; mi++) lcMark(mi, 'dynam', { 'xml:id': 'lc-d' + mi, tstamp: 4, place: 'between', staff: 1 }, mi % 2 ? 'p' : 'f');
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  /* No previous mark: centred between a grand staff's staves… */
  lc_placeholderNoPrevMarkGrand: {
    setup: `${LC_PIANO}
      lcNotes(3, 4, '4', 'a', 2);
      lcMark(0, 'dynam', { 'xml:id': 'lc-d', tstamp: 4, place: 'between', staff: 1 }, 'p');
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  /* …below a single staff. */
  lc_placeholderNoPrevMarkSingle: {
    setup: `${LC_VIOLIN}
      lcMark(0, 'dynam', { 'xml:id': 'lc-d', tstamp: 4, place: 'below', staff: 3 }, 'p');
      m.setVoice(6); m.setCursor(0, 6);`,
    setupKeys: ['ArrowDown'],
    skipCursorTrace: true,
  },
  /* Max's report: stepping onto a tuplet onset made the bar disappear (the
     moment list descended into <tuplet>, the renderer's note lookup did not). */
  lc_tupletOnsetVisible: {
    setup: `${LC_SETUP}
      m.setVoice(1); m.setCursor(0, 1);
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [lcN('a', 4)], duration: '8', dots: 0 });
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [lcN('a', 4)], duration: '4', dots: 0 });
      lcMark(0, 'dynam', { 'xml:id': 'lc-d', tstamp: 1, place: 'between', staff: 1 }, 'p');
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  /* Onset moments use each measure's own beat unit (they used the head meter's,
     so a 6/8 measure in a 4/4 piece got tstamps 1, 1.5, 2… against marks at
     1, 2, 3…). */
  lc_meterUnitChange: {
    setup: `${LC_PIANO}
      m.appendMeasure();
      m.setMeterAt(1, 6, 8);
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      for (let i = 0; i < 6; i++) m.insertChordAtCursor({ notes: [lcN('a', 4)], duration: '8', dots: 0 });
      lcMark(1, 'dynam', { 'xml:id': 'lc-d', tstamp: 2, place: 'between', staff: 1 }, 'p');
      m.setVoice(1); m.setCursor(m.getMeasureStartCursor(1, 1) + 1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  /* Marks sharing a moment are separate stops, top to bottom as rendered; the
     placeholder inside the hairpin's span selects nothing. */
  lc_multiMarkVisitsEach: {
    setup: LC_MULTI,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  lc_deleteRemovesOnlySelected: {
    setup: LC_MULTI,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  lc_placeKeepsCursorOnMark: {
    setup: LC_MULTI,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  lc_midHairpinSelectsNothing: {
    setup: `${LC_PIANO}
      lcMark(0, 'hairpin', { 'xml:id': 'lc-h', tstamp: 1, tstamp2: '0m+4', form: 'cres', place: 'between', staff: 1 });
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
  /* The bar is never hidden while a stop is current: walk every stop of a
     document mixing a tuplet, a 6/8 measure of beamed eighths, a cross-measure
     hairpin and both point marks. */
  lc_neverHiddenSweep: {
    setup: `${LC_SETUP}
      m.setVoice(1); m.setCursor(0, 1);
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [lcN('a', 4)], duration: '8', dots: 0 });
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [lcN('a', 4)], duration: '4', dots: 0 });
      m.appendMeasure();
      m.setMeterAt(1, 6, 8);
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      for (let i = 0; i < 6; i++) m.insertChordAtCursor({ notes: [lcN('a', 4)], duration: '8', dots: 0 });
      lcNotes(3, 4, '4', 'a', 2);
      lcMark(0, 'dynam', { 'xml:id': 'lc-d', tstamp: 1, place: 'between', staff: 1 }, 'p');
      lcMark(0, 'hairpin', { 'xml:id': 'lc-h', tstamp: 2, tstamp2: '1m+3', form: 'cres', place: 'between', staff: 1 });
      lcMark(1, 'dir', { 'xml:id': 'lc-x', tstamp: 4, place: 'between', staff: 1 }, 'dolce');
      m.setVoice(1); m.setCursor(1, 1);`,
    setupKeys: ['ArrowDown', 'ArrowDown'],
    skipCursorTrace: true,
  },
};

export const ASSERTIONS = {

  lc_dynamBelowSingleStaff: [{ name: 'bar flush right of the below-staff dynamic, at its height', expr: lcRightOfMark('expr', 'lc-d') }],
  lc_dynamBelowSingleStaff_page: [{ name: 'page view: bar flush right of the below-staff dynamic', expr: lcRightOfMark('expr', 'lc-d', true) }],
  lc_dynamBetweenGrandStaff: [{ name: 'bar height is the dynamic\'s, not the inter-staff gap', expr: lcRightOfMark('expr', 'lc-d') }],
  lc_dynamBetweenGrandStaff_page: [{ name: 'page view: bar height is the dynamic\'s', expr: lcRightOfMark('expr', 'lc-d', true) }],
  lc_dynamAboveGrandStaff: [{ name: 'bar follows a dynamic placed above the staff', expr: lcRightOfMark('expr', 'lc-d') }],
  lc_dirBelow: [{ name: 'bar flush right of expressive text', expr: lcRightOfMark('expr', 'lc-x') }],
  lc_pedalMark: [{ name: 'pedal bar flush right of the pedal glyph', expr: lcRightOfMark('pedal', 'lc-p') }],
  lc_hairpinStartEdge: [{ name: 'hairpin start: bar flush left of the wedge, at its height', expr: lcAssert(`
    await key('Home');
    if (!selected('expr').includes('lc-h')) return { ok: false, detail: 'Home did not select the hairpin start; selected=' + JSON.stringify(selected('expr')) };
    const b = bar('expr'), r = markRect('lc-h', 'start');
    return leftOf(b, r) ? { ok: true } : { ok: false, detail: 'bar ' + fmt(b) + ' vs wedge ' + fmt(r) };
  `) }],
  lc_hairpinEndEdge: [{ name: 'hairpin end: bar flush right of the wedge, at its height', expr: lcAssert(`
    await key('End');
    const b = bar('expr'), r = markRect('lc-h', 'end');
    return rightOf(b, r) ? { ok: true } : { ok: false, detail: 'bar ' + fmt(b) + ' vs wedge ' + fmt(r) + ' moment=' + JSON.stringify(curMoment('expr')) };
  `) }],
  lc_hairpinEndAcrossSystems: [{ name: 'split hairpin: Ctrl+→ from the start lands on the end, flush right of the LAST piece', expr: lcAssert(`
    if (!document.getElementById('score').classList.contains('view-page')) return { ok: false, detail: 'not in page view: #score class=' + document.getElementById('score').className };
    const cont = document.querySelector('g.hairpin.spanning');
    const id = cont && ([...cont.classList].find((c) => c.indexOf('id-') === 0) || '').slice(3);
    if (!id) return { ok: false, detail: 'no hairpin crosses a system break (' + document.querySelectorAll('g.system').length + ' systems)' };
    if (!(await goto('expr', id))) return { ok: false, detail: 'never selected ' + id + ' (cursorMode=' + H.inputState().cursorMode + ')' };
    await key('ArrowRight', { ctrl: true });
    const b = bar('expr'), r = markRect(id, 'end');
    return rightOf(b, r) ? { ok: true } : { ok: false, detail: id + ': bar ' + fmt(b) + ' vs last piece ' + fmt(r) + ' moment=' + JSON.stringify(curMoment('expr')) };
  `) }],
  lc_tempoTwoInstruments: [{ name: 'tempo bar flush right of the ORIGINAL tempo, not a per-part copy', expr: lcAssert(`
    if (document.querySelectorAll('g.tempo').length < 2) return { ok: false, detail: 'expected the render clone to restate the tempo above the violin' };
    if (!(await goto('tempo', 'lc-t'))) return { ok: false, detail: 'never selected lc-t (cursorMode=' + H.inputState().cursorMode + '); selected=' + JSON.stringify(selected('tempo')) };
    const b = bar('tempo'), r = markRect('lc-t');
    return rightOf(b, r) ? { ok: true } : { ok: false, detail: 'bar ' + fmt(b) + ' vs tempo ' + fmt(r) };
  `) }],
  lc_placeholderAlignsPrevMark: [{ name: 'placeholder: fixed height, at the onset notehead, centred on the previous mark', expr: lcAssert(`
    if (!(await goto('expr', 'lc-d'))) return { ok: false, detail: 'never selected lc-d' };
    await key('ArrowRight');
    if (selected('expr').length) return { ok: false, detail: 'placeholder selected ' + JSON.stringify(selected('expr')) };
    const b = bar('expr'), d = markRect('lc-d'), nh = head(onsets(0, 1)[1]);
    const okH = near(barH('expr'), 28, 0.5);
    const okX = !!(b && nh && near(cx(b), cx(nh), 1.5));
    const okY = !!(b && d && near(cy(b), cy(d), 1.5));
    return okH && okX && okY ? { ok: true } : { ok: false, detail: 'h=' + barH('expr') + ' bar ' + fmt(b) + ' notehead ' + fmt(nh) + ' dynam ' + fmt(d) };
  `) }],
  lc_placeholderAcrossSystems: [{ name: "placeholder after a system break keeps the previous mark's offset from the staff lines", expr: lcAssert(`
    if (!document.getElementById('score').classList.contains('view-page')) return { ok: false, detail: 'not in page view: #score class=' + document.getElementById('score').className };
    let k = -1;
    for (let mi = 0; mi < 11; mi++) {
      const a = staffG(mi, 1), b2 = staffG(mi + 1, 1);
      if (a && b2 && a.closest('g.system') !== b2.closest('g.system')) { k = mi; break; }
    }
    if (k < 0) return { ok: false, detail: 'no system break among the first 12 measures' };
    const id = 'lc-d' + k;
    if (!(await goto('expr', id))) return { ok: false, detail: 'never selected ' + id + ' (cursorMode=' + H.inputState().cursorMode + ')' };
    await key('ArrowRight');
    const b = bar('expr'), d = markRect(id), l1 = lines(staffG(k, 1)), l2 = lines(staffG(k + 1, 1));
    if (!b || !d || !l1 || !l2) return { ok: false, detail: 'missing geometry: bar ' + fmt(b) + ' dynam ' + fmt(d) };
    const offD = cy(d) - l1.top, offB = cy(b) - l2.top;
    return near(offB, offD, 1.5) && near(barH('expr'), 28, 0.5)
      ? { ok: true }
      : { ok: false, detail: 'break after m' + (k + 1) + ': mark offset ' + offD.toFixed(1) + ' vs bar offset ' + offB.toFixed(1) + ', h=' + barH('expr') };
  `) }],
  lc_placeholderNoPrevMarkGrand: [{ name: 'no previous mark, grand staff: centred between the staves', expr: lcAssert(`
    await key('Home');
    const b = bar('expr'), l1 = lines(staffG(0, 1)), l2 = lines(staffG(0, 2));
    if (!b || !l1 || !l2) return { ok: false, detail: 'missing geometry: bar ' + fmt(b) };
    const mid = (l1.bottom + l2.top) / 2;
    return near(cy(b), mid, 1.5) && near(barH('expr'), 28, 0.5)
      ? { ok: true }
      : { ok: false, detail: 'bar centre ' + cy(b).toFixed(1) + ' vs gap centre ' + mid.toFixed(1) + ', h=' + barH('expr') };
  `) }],
  lc_placeholderNoPrevMarkSingle: [{ name: 'no previous mark, single staff: below the staff', expr: lcAssert(`
    await key('Home');
    const b = bar('expr'), l3 = lines(staffG(0, 3));
    if (!b || !l3) return { ok: false, detail: 'missing geometry: bar ' + fmt(b) };
    return b.top >= l3.bottom - 0.5 && b.top - l3.bottom <= 12 && near(barH('expr'), 28, 0.5)
      ? { ok: true }
      : { ok: false, detail: 'bar ' + fmt(b) + ' vs staff lines ' + l3.top.toFixed(1) + '–' + l3.bottom.toFixed(1) };
  `) }],
  lc_tupletOnsetVisible: [{ name: 'the bar stays visible on a tuplet onset, at its notehead', expr: lcAssert(`
    if (!(await goto('expr', 'lc-d'))) return { ok: false, detail: 'never selected lc-d' };
    await key('ArrowRight');
    const b = bar('expr'), nh = head(onsets(0, 1)[1]);
    return b && nh && near(cx(b), cx(nh), 1.5)
      ? { ok: true }
      : { ok: false, detail: 'bar ' + fmt(b) + ' vs 2nd triplet notehead ' + fmt(nh) + ' moment=' + JSON.stringify(curMoment('expr')) };
  `) }],
  lc_meterUnitChange: [
    { name: "6/8 measure: onset stops at tstamps 1..6 (the measure's own beat unit)", expr: lcAssert(`
      const ts = stopMoments('expr').filter((x) => x.measureIdx === 1).map((x) => x.tstamp);
      const want = [1, 2, 3, 4, 5, 6];
      return ts.length === want.length && ts.every((t, i) => near(t, want[i], 1e-6))
        ? { ok: true }
        : { ok: false, detail: 'm2 stop tstamps ' + JSON.stringify(ts) };
    `) },
    { name: '6/8 measure: bar right of the beat-2 dynamic, then on the 3rd eighth', expr: lcAssert(`
      if (!(await goto('expr', 'lc-d'))) return { ok: false, detail: 'never selected lc-d' };
      const b = bar('expr'), r = markRect('lc-d');
      if (!rightOf(b, r)) return { ok: false, detail: 'bar ' + fmt(b) + ' vs dynam ' + fmt(r) };
      await key('ArrowRight');
      const b2 = bar('expr'), nh = head(onsets(1, 1)[2]);
      return b2 && nh && near(cx(b2), cx(nh), 1.5) ? { ok: true } : { ok: false, detail: 'bar ' + fmt(b2) + ' vs 3rd eighth ' + fmt(nh) };
    `) },
  ],
  lc_multiMarkVisitsEach: [{ name: 'three marks at one moment: three stops, one mark each, top to bottom; the next onset selects nothing', expr: lcAssert(`
    await key('Home');
    const seen = [];
    for (let i = 0; i < 3; i++) {
      await key('ArrowRight');
      const s = selected('expr');
      if (s.length !== 1) return { ok: false, detail: 'stop ' + (i + 1) + ' selects ' + JSON.stringify(s) + ' (want exactly one)' };
      const id = s[0], r = markRect(id, 'start'), b = bar('expr');
      const placed = id === 'lc-h' ? leftOf(b, r) : rightOf(b, r);
      if (!placed) return { ok: false, detail: 'stop ' + (i + 1) + ' (' + id + '): bar ' + fmt(b) + ' vs mark ' + fmt(r) };
      seen.push({ id, top: r.top, left: r.left });
    }
    if (!sameSet(seen.map((x) => x.id), ['lc-d', 'lc-x', 'lc-h'])) return { ok: false, detail: 'visited ' + JSON.stringify(seen.map((x) => x.id)) };
    for (let i = 1; i < seen.length; i++) {
      const a = seen[i - 1], c = seen[i];
      const inOrder = c.top > a.top + 2 || (Math.abs(c.top - a.top) <= 2 && c.left >= a.left - 0.5);
      if (!inOrder) return { ok: false, detail: 'not top-to-bottom: ' + JSON.stringify(seen) };
    }
    await key('ArrowRight');
    const after = selected('expr');
    return after.length === 0 ? { ok: true } : { ok: false, detail: 'beat-3 placeholder inside the hairpin selects ' + JSON.stringify(after) };
  `) }],
  lc_deleteRemovesOnlySelected: [{ name: 'Delete removes only the selected mark; the cursor stays on the moment', expr: lcAssert(`
    if (!(await goto('expr', 'lc-x', true))) return { ok: false, detail: 'could not select the expressive text alone; selected=' + JSON.stringify(selected('expr')) };
    await key('Delete');
    const ids = markIds();
    if (ids.includes('lc-x') || !ids.includes('lc-d') || !ids.includes('lc-h')) return { ok: false, detail: 'marks after Delete: ' + JSON.stringify(ids) };
    const s = selected('expr');
    return s.length === 1 && (s[0] === 'lc-d' || s[0] === 'lc-h')
      ? { ok: true }
      : { ok: false, detail: 'after Delete the cursor selects ' + JSON.stringify(s) + ' (want a remaining beat-2 mark)' };
  `) }],
  lc_placeKeepsCursorOnMark: [{ name: 'Ctrl+↑ moves only the selected mark and the cursor stays on it', expr: lcAssert(`
    if (!(await goto('expr', 'lc-x', true))) return { ok: false, detail: 'could not select the expressive text alone; selected=' + JSON.stringify(selected('expr')) };
    await key('ArrowUp', { ctrl: true });
    const doc = m.getDoc();
    const placeOf = (id) => [...doc.querySelectorAll('dynam, dir, hairpin')].find((e) => e.getAttribute('xml:id') === id)?.getAttribute('place');
    if (placeOf('lc-x') !== 'above') return { ok: false, detail: 'dir place=' + placeOf('lc-x') };
    if (placeOf('lc-d') !== 'between' || placeOf('lc-h') !== 'between') return { ok: false, detail: 'other marks moved too: dynam=' + placeOf('lc-d') + ' hairpin=' + placeOf('lc-h') };
    const s = selected('expr'), b = bar('expr'), r = markRect('lc-x');
    if (!sameSet(s, ['lc-x'])) return { ok: false, detail: 'after Ctrl+↑ the cursor selects ' + JSON.stringify(s) };
    return rightOf(b, r) ? { ok: true } : { ok: false, detail: 'bar ' + fmt(b) + ' vs moved text ' + fmt(r) };
  `) }],
  lc_midHairpinSelectsNothing: [{ name: 'a placeholder inside a hairpin selects nothing, so Delete there keeps the hairpin', expr: lcAssert(`
    await key('Home');
    await key('ArrowRight');
    const s = selected('expr');
    if (s.length) return { ok: false, detail: 'beat-2 placeholder selects ' + JSON.stringify(s) };
    await key('Delete');
    return markIds().includes('lc-h') ? { ok: true } : { ok: false, detail: 'Delete at a placeholder removed the hairpin' };
  `) }],
  lc_neverHiddenSweep: [{ name: 'the bar is visible at every stop (tuplet, 6/8 beams, hairpin span, marks)', expr: lcAssert(`
    await key('Home');
    const hidden = [];
    let last = -1, n = 0;
    for (let i = 0; i < 80; i++) {
      const idx = cursorOf('expr').index;
      if (idx === last) break;
      last = idx; n++;
      if (!bar('expr')) hidden.push(JSON.stringify(stopMoments('expr')[idx]));
      await key('ArrowRight');
    }
    return hidden.length === 0
      ? { ok: true, detail: n + ' stops' }
      : { ok: false, detail: 'bar hidden at ' + hidden.length + '/' + n + ' stops: ' + hidden.join(' ') };
  `) }],
};
