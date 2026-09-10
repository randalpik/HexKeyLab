// Duration + linkage gate for the MusicXML export. Element counts do not prove
// the export is playable; these do:
//   • every measure, in every part, sums to that measure's budget in each voice
//   • no measure exceeds its budget
//   • slur/ottava endpoints all resolve
const H = window.__hkl_composer; const m = H.model;
const { exportMusicXml } = await import('/composer/src/save.ts');
const xml = exportMusicXml(m);
const out = new DOMParser().parseFromString(xml, 'application/xml');
const ser = new DOMParser().parseFromString(m.serialize(), 'application/xml');
const div = Number((xml.match(/<divisions>(\d+)<\/divisions>/) || [])[1]);

const bad = [];
const parts = [...out.querySelectorAll('part')];
parts.forEach((part, pi) => {
  [...part.querySelectorAll('measure')].forEach((meas, mi) => {
    const want = Math.round(m.measureTicksAt(mi) * div / 16);
    /* Walk the music-data stream the way a reader does: notes advance the
       clock (chord members do not), <backup>/<forward> move it. */
    const perVoice = new Map();
    let cur = 0, maxReach = 0;
    for (const c of [...meas.children]) {
      const ln = c.localName;
      const durEl = c.querySelector(':scope > duration');
      const d = durEl ? Number(durEl.textContent) : 0;
      if (ln === 'note') {
        if (c.querySelector(':scope > chord')) continue;
        const v = (c.querySelector(':scope > voice') || {}).textContent || '?';
        cur += d; perVoice.set(v, Math.max(perVoice.get(v) || 0, cur));
      } else if (ln === 'forward') {
        const v = (c.querySelector(':scope > voice') || {}).textContent || '?';
        cur += d; perVoice.set(v, Math.max(perVoice.get(v) || 0, cur));
      } else if (ln === 'backup') { cur -= d; }
      if (cur > maxReach) maxReach = cur;
      if (cur < 0) bad.push({ part: pi, measure: mi + 1, issue: 'clock went negative' });
    }
    for (const [v, reach] of perVoice) {
      if (reach !== want) bad.push({ part: pi, measure: mi + 1, voice: v, got: reach, want });
    }
  });
});

/* Spanner endpoints that never resolved to a note. */
const ids = new Set();
for (const n of [...ser.querySelectorAll('note, chord')]) { const i = n.getAttribute('xml:id'); if (i) ids.add(i); }
const dangling = { slur: [], octave: [] };
for (const el of [...ser.querySelectorAll('slur, octave')]) {
  for (const a of ['startid', 'endid']) {
    const v = (el.getAttribute(a) || '').replace(/^#/, '');
    if (v && !ids.has(v)) dangling[el.localName].push(el.getAttribute('xml:id') + '/' + a);
  }
}
const slurTags = out.querySelectorAll('slur').length;

/* Pickups: which measures carry a reduced budget, and did each export as
   implicit with the right duration? */
const HKL = 'https://hexkeylab.com/ns/mei';
const liveMeasures = [...m.getDoc().querySelectorAll('measure')];
const pickups = [];
liveMeasures.forEach((meas, mi) => {
  const raw = meas.getAttributeNS(HKL, 'pickup-ticks');
  if (!raw) return;
  const meter = m.meterAt(mi);
  const budget = Math.round(m.measureTicksAt(mi) * div / 16);
  const full = Math.round(meter.count * div * 4 / meter.unit);
  const xmlMeas = [...parts[0].querySelectorAll('measure')][mi];
  pickups.push({
    measure: mi + 1, pickupTicksAttr: Number(raw), meter: meter.count + '/' + meter.unit,
    budget, full, reduced: budget < full,
    implicit: xmlMeas ? xmlMeas.getAttribute('implicit') : null,
  });
});

/* Section boundaries: the model marks the measure BEFORE one with @right=end,
   which the importer reads back as a movement start. */
const sectionTitles = liveMeasures.filter((x) => x.hasAttribute('data-hkl-section-title')).length;
const midPieceFinalBars = [...parts[0].querySelectorAll('measure')].filter((meas, i, all) =>
  i < all.length - 1 && [...meas.querySelectorAll('barline[location="right"] bar-style')]
    .some((b) => (b.textContent || '').trim() === 'light-heavy')
    && !meas.querySelector('repeat[direction="backward"]')).length;

return JSON.stringify({
  pickups,
  sectionTitles,
  midPieceFinalBars,
  divisions: div,
  measuresPerPart: parts.map((p) => p.querySelectorAll('measure').length),
  durationMismatches: bad.length,
  firstMismatches: bad.slice(0, 10),
  slursInModel: ser.querySelectorAll('slur').length,
  slurTagsExported: slurTags,
  slursFullyExported: slurTags / 2,
  danglingSlurEndpoints: dangling.slur.length,
  danglingOctaveEndpoints: dangling.octave.length,
  spacesInSerialized: ser.querySelectorAll('space').length,
  tupletPlaceholderSpaces: [...ser.querySelectorAll('space')].filter((x) => x.getAttribute('data-tuplet-placeholder') === 'true').length,
  placeholderRests: [...ser.querySelectorAll('rest')].filter((x) => x.getAttribute('data-tuplet-placeholder') === 'true').length,
  pickupMeasures: [...ser.querySelectorAll('measure')].filter((x) => x.getAttribute('metcon') === 'false').length,
  implicitExported: out.querySelectorAll('measure[implicit="yes"]').length,
}, null, 1);
