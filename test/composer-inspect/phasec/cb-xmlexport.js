// MusicXML export coverage audit (2026-09-09). Imports the sonata, exports it
// back out, and counts every feature the model holds against what reaches the
// MusicXML — so "what does export lose" is a table, not a code reading.
//
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/cb-xmlexport.js
const H = window.__hkl_composer; const m = H.model;
const { exportMusicXml } = await import('/composer/src/save.ts');

const doc = m.getDoc();
const xml = exportMusicXml(m);
const out = new DOMParser().parseFromString(xml, 'application/xml');
const perr = out.querySelector('parsererror');

const HKL = 'https://hexkeylab.com/ns/mei';
const nIn = (sel) => doc.querySelectorAll(sel).length;
const nOut = (sel) => out.querySelectorAll(sel).length;
const partCount = out.querySelectorAll('part').length;

/* Model-side counts that need a predicate rather than a selector. */
const measures = [...doc.querySelectorAll('measure')];
const attrCount = (attr, val) => measures.filter((x) => (val ? x.getAttribute(attr) === val : x.hasAttribute(attr))).length;
const hiddenRests = [...doc.querySelectorAll('rest')].filter((r) => r.getAttribute('visible') === 'false').length;
const stemDirs = [...doc.querySelectorAll('note[stem\\.dir], chord[stem\\.dir]')].length;

const rows = [
  ['notes',            nIn('note'),                                  nOut('note pitch')],
  ['ties (@tie)',      nIn('note[tie]'),                             nOut('tied')],
  ['tuplets',          nIn('tuplet'),                                nOut('tuplet')],
  ['slurs',            nIn('slur'),                                  nOut('slur')],
  ['articulations',    nIn('artic'),                                 nOut('articulations')],
  ['fermatas',         nIn('fermata'),                               nOut('fermata')],
  ['trills',           nIn('trill'),                                 nOut('ornaments')],
  ['breath marks',     nIn('breath'),                                nOut('breath-mark')],
  ['dynamics',         nIn('dynam'),                                 nOut('dynamics')],
  ['hairpins',         nIn('hairpin'),                               nOut('wedge')],
  ['expressive text',  nIn('dir'),                                   [...out.querySelectorAll('direction')].filter((d) => d.querySelector('words') && !d.querySelector('metronome') && !d.querySelector('sound[tempo]')).length],
  ['tempo marks',      nIn('tempo'),                                 Math.round(nOut('direction sound[tempo], measure > sound[tempo]') / Math.max(1, partCount))],
  ['pedal',            nIn('pedal'),                                 nOut('pedal')],
  ['ottava',           nIn('octave'),                                nOut('octave-shift')],
  ['tremolo',          nIn('bTrem, fTrem'),                          nOut('tremolo')],
  ['diamond heads',    nIn('note[head\\.shape]'),                    [...out.querySelectorAll('notehead')].filter((h) => (h.textContent || '').trim() !== 'normal').length],
  ['grace notes',      nIn('grace, note[grace]'),                    nOut('grace')],
  ['whole-bar rests',  nIn('mRest'),                                 nOut('rest[measure="yes"]')],
  ['hidden rests',     hiddenRests,                                  nOut('note[print-object="no"], forward')],
  ['stem directions',  stemDirs,                                     nOut('stem')],
  ['beams',            nIn('beam'),                                  nOut('beam')],
  ['repeat starts',    attrCount('left', 'rptstart'),                Math.round(nOut('repeat[direction="forward"]') / Math.max(1, partCount))],
  ['repeat ends',      attrCount('right', 'rptend'),                 Math.round(nOut('repeat[direction="backward"]') / Math.max(1, partCount))],
  ['double bars',      attrCount('right', 'dbl'),                    Math.round([...out.querySelectorAll('bar-style')].filter((b) => (b.textContent || '').trim() === 'light-light').length / Math.max(1, partCount))],
  ['voltas/endings',   nIn('ending'),                                Math.round(nOut('ending') / (2 * Math.max(1, partCount)))],
  /* Only a REDUCED budget is a pickup: the sonata has three measures whose
     hkl:pickup-ticks equals a full 2/2 bar, which are not anacruses. */
  ['pickup measures',  measures.filter((x, i) => x.getAttributeNS(HKL, 'pickup-ticks') && m.measureTicksAt(i) < m.meterAt(i).count * 64 / m.meterAt(i).unit).length, Math.round(nOut('measure[implicit="yes"]') / Math.max(1, partCount))],
  /* No MusicXML element carries a movement TITLE mid-score; the structural
     signal is the mid-piece final barline, which the importer reads back as a
     section start. Count those instead. */
  ['section boundaries', nIn('[data-hkl-section-title]'),
    [...out.querySelectorAll('part')][0]
      ? [...out.querySelectorAll('part')][0].querySelectorAll('measure').length &&
        [...[...out.querySelectorAll('part')][0].querySelectorAll('measure')].filter((meas, i, all) =>
          i < all.length - 1
          && [...meas.querySelectorAll('barline[location="right"] bar-style')].some((b) => (b.textContent || '').trim() === 'light-heavy')
          && !meas.querySelector('repeat[direction="backward"]')).length
      : 0],
  ['mid-piece clefs',  nIn('layer > clef'),                          Math.round(nOut('measure:not(:first-child) clef') / Math.max(1, partCount))],
  ['meter symbol',     m.meterAt(0).sym ? 1 : 0,                     nOut('time[symbol]') ? 1 : 0],
  ['manual breaks',    (doc.querySelector('section')
                          ? [...doc.querySelector('section').children].filter((c) => c.localName === 'pb' || c.localName === 'sb').length : 0),
                       Math.round(nOut('print[new-page="yes"], print[new-system="yes"]') / Math.max(1, partCount))],
  ['part abbreviations', nIn('scoreDef staffGrp > labelAbbr'),       nOut('part-abbreviation')],
];

return JSON.stringify({
  parseError: perr ? perr.textContent.slice(0, 200) : null,
  parts: partCount,
  bytes: xml.length,
  /* [feature, in model, in exported MusicXML] — a 0 in the third column with a
     non-zero second column is a dropped feature. */
  coverage: rows.map(([k, a, b]) => ({ feature: k, model: a, musicxml: b, lost: a > 0 && b === 0 })),
}, null, 1);
