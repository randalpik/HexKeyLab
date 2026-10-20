// Composer test fixtures — accidentals.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

/* MusicXML builders for the accidental-display fixtures: N(step, oct, alter,
   divisions, type, { chord, voice, acc, tieStart, tieStop }) → one <note>;
   SCORE(fifths, [measureBody, …]) → a one-part 4/4 treble score at 24
   divisions/quarter. Interpolated into setups (runs in-page). */
const ACCID_XML = `
  const N = (s, oct, alter, dur, type, o = {}) => '<note>' + (o.chord ? '<chord/>' : '')
    + '<pitch><step>' + s + '</step>' + (alter ? '<alter>' + alter + '</alter>' : '') + '<octave>' + oct + '</octave></pitch>'
    + '<duration>' + dur + '</duration>'
    + (o.tieStop ? '<tie type="stop"/>' : '') + (o.tieStart ? '<tie type="start"/>' : '')
    + '<voice>' + (o.voice ?? 1) + '</voice><type>' + type + '</type>'
    + (o.acc ? '<accidental>' + o.acc + '</accidental>' : '')
    + ((o.tieStop || o.tieStart) ? '<notations>' + (o.tieStop ? '<tied type="stop"/>' : '') + (o.tieStart ? '<tied type="start"/>' : '') + '</notations>' : '')
    + '</note>';
  const SCORE = (fifths, measures) => '<?xml version="1.0"?><score-partwise version="3.0">'
    + '<part-list><score-part id="P1"><part-name>T</part-name></score-part></part-list><part id="P1">'
    + measures.map((body, i) => '<measure number="' + (i + 1) + '">'
      + (i === 0 ? '<attributes><divisions>24</divisions><key><fifths>' + fifths + '</fifths></key>'
        + '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : '')
      + body + '</measure>').join('')
    + '</part></score-partwise>';
`;

/** Two voices sounding one written pitch at one tick: Verovio must merge the
 *  noteheads (one x) and BOTH notes must carry the same accidental glyph row,
 *  superimposed (same x per glyph). `glyphs` = expected BravuraText
 *  codepoints (hex), visual left → right. */
function unisonMergeExpr(glyphs) {
  return `(() => {
    const notes = [...document.querySelectorAll('#score svg g.note')];
    if (notes.length !== 2) return { ok: false, detail: 'notes=' + notes.length };
    const info = notes.map((g) => {
      const nh = g.querySelector('g.notehead');
      const x = Math.round(nh.getBoundingClientRect().x);
      const gl = [...g.querySelectorAll('g.accid text')]
        .map((t) => ({ cp: t.textContent.codePointAt(0).toString(16), x: Math.round(t.getBoundingClientRect().x) }))
        .sort((a, b) => a.x - b.x);
      return { x, gl };
    });
    const want = ${JSON.stringify(glyphs)};
    if (info[0].x !== info[1].x) return { ok: false, detail: 'noteheads not merged: x=' + info[0].x + '/' + info[1].x + ' glyphs=' + JSON.stringify(info.map((n) => n.gl)) };
    for (const n of info) {
      if (n.gl.map((g) => g.cp).join(',') !== want.join(',')) return { ok: false, detail: 'glyphs=' + JSON.stringify(info.map((k) => k.gl)) + ' want=' + want.join(',') };
    }
    for (let i = 0; i < want.length; i++) {
      if (Math.abs(info[0].gl[i].x - info[1].gl[i].x) > 1) return { ok: false, detail: 'glyph ' + want[i] + ' not superimposed: x=' + info[0].gl[i].x + '/' + info[1].gl[i].x };
    }
    return { ok: true };
  })()`;
}

/** Rendered accidental glyphs per note, model-doc order: measures joined by
 *  '|', notes by ','; each token is s/f/n (SMuFL sharp/flat/natural), '-' for
 *  none, '+'-joined when a note draws several. */
function accidGlyphsExpr(want) {
  return `(() => {
    const MAP = { e262: 's', e260: 'f', e261: 'n' };
    const out = [], desc = [];
    for (const meas of window.__hkl_composer.model.getDoc().querySelectorAll('measure')) {
      const g = [], d = [];
      for (const n of meas.querySelectorAll('note')) {
        const cps = [...document.querySelectorAll('#score svg g.note[id="' + n.getAttribute('xml:id') + '"] g.accid text')]
          .map((t) => t.textContent.codePointAt(0).toString(16));
        const tok = cps.length ? cps.map((c) => MAP[c] ?? c).join('+') : '-';
        g.push(tok); d.push(n.getAttribute('pname') + n.getAttribute('oct') + ':' + tok);
      }
      out.push(g.join(',')); desc.push(d.join(','));
    }
    const want = ${JSON.stringify(want)};
    return out.join('|') === want ? { ok: true } : { ok: false, detail: 'got ' + desc.join(' | ') + '; want ' + want };
  })()`;
}

export const FIXTURES = {
  /* ── A hidden double sharp's gestural token is `ss` (2026-10-20, Max) ──
     The display pass hides a carried accidental by moving its token into
     @accid.ges, and wrote the WRITTEN token there: `x` for a double sharp,
     which MEI's data.ACCIDENTAL.GESTURAL does not allow (Verovio: "Unsupported
     value 'x' for data.ACCIDENTAL.GESTURAL" — 765 times in 10 of 450 MuseScore
     files). The visible double sharp stays `x` (×, not ##). */
  accidental_double_sharp_gestural_ss: {
    setup: `${ACCID_XML}
      window.__composerImportMusicXml(SCORE(0, [N('F', 5, 2, 24, 'quarter', { acc: 'double-sharp' }) + N('F', 5, 2, 24, 'quarter') + N('G', 5, 0, 48, 'half')]));
    `,
  },
  /* Files the bug wrote carry accid.ges="x"; loading one migrates it to `ss`
     (the load migration used to turn a correct "ss" INTO "x"). */
  accidental_legacy_ges_x_migrated: {
    setup: `${ACCID_XML}
      window.__composerImportMusicXml(SCORE(0, [N('F', 5, 2, 24, 'quarter', { acc: 'double-sharp' }) + N('F', 5, 2, 24, 'quarter') + N('G', 5, 0, 48, 'half')]));
      window.__composerLoadHkc(m.serialize().replace(/accid\.ges="ss"/g, 'accid.ges="x"'));
    `,
  },

  /* ── HEJI accidentals + arbitrary stacks (render-time injection) ───────── */
  /* Mode D, HEJI on: C#↓ at (1,0) → single combined glyph U+E2C3
     (sharp + one down arrow). */
  heji_sharp_arrow: {
    setup: `
      m.setLayoutReq({ tuningMode: 'D' });
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
      m.setLayoutReq({ tuningMode: '7' });
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
      m.setLayoutReq({ tuningMode: '7' });
      m.setHejiEnabled(true);
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: -10, r: 7, pname: 'f', accid: 's', oct: 4, midi: 66, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    visualBaseline: 'heji_acc_plus_hook',
  },
  /* Accidental vertical placement: a sharp whose notehead sits ON a staff line
     (G#4, mode P) must read centered on that line. Pins the empirically-tuned
     ACCID_BASELINE_CORRECTION_SPACES (1.6) + FAMILY_Y_OFFSET in heji-render.ts;
     Verovio's own default left accidentals reading slightly high. The trailing
     note adds a flat + septimal hook (mode 7) so the per-family septimal nudge
     is covered by the same baseline. */
  accidental_centered_on_line: {
    setup: `
      m.setLayoutReq({ tuningMode: 'P' });
      m.setHejiEnabled(false);
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 0, r: 4, pname: 'g', accid: 's', oct: 4, midi: 68, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    visualBaseline: 'accidental_centered_on_line',
  },
  /* HEJI OFF: the same C#↓ cell renders as a plain sharp (BravuraText, since
     all accidentals are Bravura) with NO comma arrow — guards that the comma
     decoration is gated on the HEJI flag. */
  heji_off_native: {
    setup: `
      m.setLayoutReq({ tuningMode: 'D' });
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
      m.setLayoutReq({ tuningMode: 'D' });
      m.setHejiEnabled(true);
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: -12, r: 7, pname: 'a', accid: 's', oct: 3, midi: 58, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.setCursor(m.getVoiceLength(1), 1);
      m.insertChordAtCursor({ notes: [{ q: -5, r: 3, pname: 'a', accid: 's', oct: 3, midi: 58, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
  },
  /* Key-signature accidentals are redrawn in BravuraText (matching
     note accidentals), not left on Verovio's Leipzig <use> glyphs. E major =
     4 sharps; every g.keyAccid must end up as a BravuraText <text> at the SMuFL
     sharp codepoint (U+E262), with no surviving <use>. */
  heji_keysig_bravura: {
    setup: `
      m.setKeySigAt(0, '4s', 'major');
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [{ q: 1, r: 0, pname: 'c', accid: 's', oct: 4, midi: 61, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
    `,
    visualBaseline: 'heji_keysig_bravura',
  },
  /* Two voices sounding the SAME written pitch at one tick, each needing a
     HEJI placeholder row (mode 7, F# at (-10,7) = sharp + septimal hook).
     The carry-state pass used to hide the second voice's accidental as
     redundant (@accid.ges), leaving voice 1 with placeholder <accid>
     children and voice 2 with a gestural sharp. Verovio derives each note's
     MIDI pitch from its FIRST <accid> child, so the 'su' placeholder on one
     side and 's' on the other read as two different pitches and the unison
     was drawn as a false relation — two offset noteheads, one accidental.
     Both notes must now carry the row; Verovio superimposes identical
     accidentals at one Y across layers, so the noteheads merge and the
     chain draws once. (Max, 2026-10-05.) */
  heji_unison_two_voices_hook: {
    setup: `
      m.setLayoutReq({ tuningMode: '7' });
      m.setHejiEnabled(true);
      const N = { q: -10, r: 7, pname: 'f', accid: 's', oct: 4, midi: 66, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
      m.setVoice(2);
      m.setCursor(0, 2);
      m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
    `,
    visualBaseline: 'heji_unison_two_voices_hook',
  },
  /* Same, with a single combined glyph whose placeholder token flips the
     sign: a flat with an arrow (mode 5, Bb3 at (-1,-1) = Bb↑) is reserved
     with the 's' token (first pool entry wide enough), so the one-sided
     encoding read as sharp vs flat. */
  heji_unison_two_voices_flat_arrow: {
    setup: `
      m.setLayoutReq({ tuningMode: '5' });
      m.setHejiEnabled(true);
      const N = { q: -1, r: -1, pname: 'b', accid: 'f', oct: 3, midi: 58, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
      m.setVoice(2);
      m.setCursor(0, 2);
      m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
    `,
  },
  /* HEJI off: the same unison rule applies to a plain accidental — both
     voices carry @accid="s" and Verovio draws one superimposed sharp on a
     merged notehead (it already merged by pitch here since the gestural and
     written tokens agreed; this pins the symmetric encoding). */
  accid_unison_two_voices_plain: {
    setup: `
      m.setLayoutReq({ tuningMode: 'D' });
      m.setHejiEnabled(false);
      const N = { q: 1, r: 0, pname: 'c', accid: 's', oct: 4, midi: 61, colorHex: '#888', velocity: 80 };
      m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
      m.setVoice(2);
      m.setCursor(0, 2);
      m.insertChordAtCursor({ notes: [N], duration: '4', dots: 0 });
    `,
  },
  /* Accidental restated after a tie across the barline (2026-10-19; sonata
     mvt II m45, III m32, III m70, IV m82). A tie destination hides its
     accidental but does not establish it for the new bar, so the next struck
     note at that position redraws it (m2 beat 2) — only when the pitch
     differs from the key signature (m3–m4: a tied-in diatonic G5 adds
     nothing), and only for a tie crossing INTO the bar (m5: a chain drawn
     inside the bar elides as before). m2 beat 4's F♮ is the unchanged
     baseline case. Asserted in FIXTURE_ASSERTIONS.accid_restate_after_tie. */
  accid_restate_after_tie: {
    setup: `${ACCID_XML}
      window.__composerImportMusicXml(SCORE(0, [
        N('G', 4, 0, 48, 'half') + N('F', 5, 1, 48, 'half', { acc: 'sharp', tieStart: true }),
        N('F', 5, 1, 24, 'quarter', { tieStop: true }) + N('F', 5, 1, 24, 'quarter', { acc: 'sharp' })
          + N('F', 5, 1, 24, 'quarter') + N('F', 5, 0, 24, 'quarter', { acc: 'natural' }),
        N('G', 4, 0, 48, 'half') + N('G', 5, 0, 48, 'half', { tieStart: true }),
        N('G', 5, 0, 24, 'quarter', { tieStop: true }) + N('G', 5, 0, 24, 'quarter') + N('A', 5, 0, 48, 'half'),
        N('F', 5, 1, 24, 'quarter', { acc: 'sharp', tieStart: true }) + N('F', 5, 1, 24, 'quarter', { tieStop: true })
          + N('F', 5, 1, 24, 'quarter') + N('G', 5, 0, 24, 'quarter'),
      ]));
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
    visualBaseline: 'accid_restate_after_tie',
  },
  /* Chromatic pair at one pitch position in one chord (2026-10-19; sonata
     mvt I m122 RH, B♭5 + B♮5 in B♭ major). Both draw — the B♭ matched the
     key signature and was hidden, engraving a bare B5 beside ♮B5. The carry
     after the pair is ambiguous, so the next B redraws its natural even
     though it repeats the last accidental drawn.
     Asserted in FIXTURE_ASSERTIONS.accid_chromatic_cluster_chord. */
  accid_chromatic_cluster_chord: {
    setup: `${ACCID_XML}
      window.__composerImportMusicXml(SCORE(-2, [
        N('G', 5, 0, 24, 'quarter') + N('B', 5, -1, 24, 'quarter', { chord: true })
          + N('B', 5, 0, 24, 'quarter', { chord: true, acc: 'natural' })
          + N('B', 5, 0, 24, 'quarter', { acc: 'natural' }) + N('B', 5, 0, 24, 'quarter')
          + N('B', 5, -1, 24, 'quarter', { acc: 'flat' }),
      ]));
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
    visualBaseline: 'accid_chromatic_cluster_chord',
  },
  /* Same clash across voices: voice 1 B♭5 (key) against voice 2 B♮5 on one
     beat. Both draw; voice 1's next B♭ restates (unchanged), the third elides.
     Asserted in FIXTURE_ASSERTIONS.accid_chromatic_cluster_two_voices. */
  accid_chromatic_cluster_two_voices: {
    setup: `${ACCID_XML}
      window.__composerImportMusicXml(SCORE(-2, [
        N('B', 5, -1, 24, 'quarter') + N('B', 5, -1, 24, 'quarter', { acc: 'flat' })
          + N('B', 5, -1, 24, 'quarter') + N('G', 5, 0, 24, 'quarter')
          + '<backup><duration>96</duration></backup>'
          + N('B', 5, 0, 24, 'quarter', { voice: 2, acc: 'natural' }) + N('D', 5, 0, 24, 'quarter', { voice: 2 })
          + N('D', 5, 0, 48, 'half', { voice: 2 }),
      ]));
      m.setVoice(1); m.setCursor(0, 1); r();
    `,
    visualBaseline: 'accid_chromatic_cluster_two_voices',
  },
  /* HEJI accidentals are ON by default in a fresh document (a missing
     <hkl:config @heji> reads as on; only an explicit "false" turns it off).
     The suite's reset pins HEJI off on the shared document so the older
     baselines keep their meaning, so this probes a fresh model instance. */
  heji_default_on: {
    setup: `
      /* fresh document: the assertion constructs its own model instance */
    `,
  },
};

export const ASSERTIONS = {
  accidental_double_sharp_gestural_ss: [
    { name: 'the visible F𝄪 keeps @accid="x"; the carried one is @accid.ges="ss" in the serialized MEI',
      expr: `(() => { const d = new DOMParser().parseFromString(window.__hkl_composer.model.serialize(), 'application/xml');
        const fs = [...d.querySelectorAll('layer note')].filter((n) => n.getAttribute('pname') === 'f');
        const got = fs.map((n) => (n.getAttribute('accid') ?? '-') + '/' + (n.getAttribute('accid.ges') ?? '-'));
        return got.join() === 'x/-,-/ss' ? { ok: true } : { ok: false, detail: JSON.stringify(got) }; })()` },
  ],
  accidental_legacy_ges_x_migrated: [
    { name: 'a loaded accid.ges="x" becomes "ss" in the live document',
      expr: `(() => { const ges = [...window.__hkl_composer.model.getDoc().querySelectorAll('note')].filter((n) => n.hasAttribute('accid.ges')).map((n) => n.getAttribute('accid.ges'));
        return ges.length > 0 && ges.every((g) => g === 'ss') ? { ok: true } : { ok: false, detail: JSON.stringify(ges) }; })()` },
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
  heji_unison_two_voices_hook: [
    { name: 'noteheads merged; both notes carry sharp + septimal hook, superimposed',
      expr: unisonMergeExpr(['e262', 'e2de']) },
  ],
  heji_unison_two_voices_flat_arrow: [
    { name: 'noteheads merged; both notes carry the flat-arrow glyph, superimposed',
      expr: unisonMergeExpr(['e2c6']) },
  ],
  accid_unison_two_voices_plain: [
    { name: 'noteheads merged; both notes carry the sharp, superimposed',
      expr: unisonMergeExpr(['e262']) },
  ],
  accid_restate_after_tie: [
    { name: 'struck note after a tied-in chromatic note redraws; diatonic and in-bar chains do not',
      expr: accidGlyphsExpr('-,s|-,s,-,n|-,-|-,-,-|s,-,-,-') },
  ],
  accid_chromatic_cluster_chord: [
    { name: 'B♭5 and B♮5 in one chord both draw; the next B restates its natural',
      expr: accidGlyphsExpr('-,f,n,n,-,f') },
  ],
  accid_chromatic_cluster_two_voices: [
    { name: 'voice-1 B♭5 and voice-2 B♮5 on one beat both draw',
      expr: accidGlyphsExpr('f,f,-,-,n,-,-') },
  ],
  heji_default_on: [
    { name: 'a fresh document has HEJI on; an explicit off survives a reload',
      expr: `(() => {
        const cls = window.__hkl_composer.model.constructor;
        const fresh = new cls();
        if (fresh.getHejiEnabled() !== true) return { ok: false, detail: 'fresh getHejiEnabled=' + fresh.getHejiEnabled() };
        fresh.setHejiEnabled(false);
        if (fresh.getHejiEnabled() !== false) return { ok: false, detail: 'explicit off not honored' };
        const again = new cls(fresh.serialize());
        if (again.getHejiEnabled() !== false) return { ok: false, detail: 'explicit off lost on reload' };
        again.setHejiEnabled(true);
        return new cls(again.serialize()).getHejiEnabled() === true ? { ok: true } : { ok: false, detail: 'explicit on lost on reload' };
      })()` },
  ],
  heji_keysig_bravura: [
    { name: 'key-sig accidentals are BravuraText <text> at U+E262, no <use> left',
      expr: `(() => {
        const accs = [...document.querySelectorAll('#score svg g.keyAccid')];
        if (accs.length < 4) return { ok: false, detail: 'keyAccid count=' + accs.length + ' (expected ≥4 for E major)' };
        for (const a of accs) {
          if (a.querySelector('use')) return { ok: false, detail: 'a keyAccid still has a <use>' };
          const t = a.querySelector('text');
          if (!t || t.getAttribute('font-family') !== 'BravuraText') return { ok: false, detail: 'keyAccid not BravuraText text' };
          if (t.textContent.codePointAt(0) !== 0xE262) return { ok: false, detail: 'codepoint=' + t.textContent.codePointAt(0).toString(16) };
        }
        return { ok: true };
      })()` },
  ],
};
