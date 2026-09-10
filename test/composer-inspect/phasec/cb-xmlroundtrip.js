// MusicXML round-trip gate: sonata → export → re-import → compare the model
// against itself. Element counts prove the export CONTAINS the music; this
// proves a reader can rebuild it.
const H = window.__hkl_composer; const m = H.model;
const { exportMusicXml } = await import('/composer/src/save.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const census = () => {
  const d = m.getDoc();
  const n = (sel) => d.querySelectorAll(sel).length;
  const measures = [...d.querySelectorAll('measure')];
  const attr = (a, v) => measures.filter((x) => x.getAttribute(a) === v).length;
  let totalTicks = 0;
  for (let i = 0; i < measures.length; i++) totalTicks += m.measureTicksAt(i);
  return {
    measures: measures.length,
    instruments: m.instruments().length,
    notes: n('note'), chords: n('chord'), rests: n('rest'),
    tiedNotes: n('note[tie]'), tuplets: n('tuplet'), slurs: n('slur'),
    artics: n('artic'), fermatas: n('fermata'), trills: n('trill'),
    dynamics: n('dynam'), hairpins: n('hairpin'), dirs: n('dir'),
    tempi: n('tempo'), octaves: n('octave'), pedals: n('pedal'),
    tremolos: n('bTrem, fTrem'), mRests: n('mRest'),
    hiddenRests: [...d.querySelectorAll('rest')].filter((r) => r.getAttribute('visible') === 'false').length,
    rptStart: attr('left', 'rptstart'), rptEnd: attr('right', 'rptend'),
    dbl: attr('right', 'dbl'), endings: n('ending'),
    sectionTitles: n('[data-hkl-section-title]'),
    totalTicks,
  };
};

const before = census();
const xml = exportMusicXml(m);
window.__composerImportMusicXml(xml);
for (let i = 0; i < 400; i++) {
  const b = document.getElementById('renderBusy');
  if (document.querySelector('.score-page svg') && (!b || b.hidden)) break;
  await sleep(250);
}
await sleep(1500);
const after = census();

const delta = {};
for (const k of Object.keys(before)) if (before[k] !== after[k]) delta[k] = { before: before[k], after: after[k] };
return JSON.stringify({ before, after, delta, identical: Object.keys(delta).length === 0 }, null, 1);
