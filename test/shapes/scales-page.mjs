// Scales page gate (docs/architecture/hkl.md → Lattice shapes → Key profiles → The page).
//
// Needs `pnpm dev` (the shared origin; SCALES_URL overrides the address). Muted headless Chromium
// (test/composer-test/lib/chromium.mjs passes --mute-audio), stopped at the end. The page,
// /scales.html, has no audio, MIDI or overlay code. What a layout can play is the Node report's
// to compute (test/shapes/footprint.mjs); here the page is held to a few of its rows.
//   S1  Randal in Ptolemaic: the page finishes with the first key on offer (Ptolemaic major); the
//       keys on offer are in <body data-scales>; the footprint starts from the scale, by name,
//       and its pictures share rows; the chords come in four sections whose headings count what
//       the layout plays, each with a picture for every chord it plays and one line naming the
//       others; no picture leaves its entry; no note is named in text
//   S2  ?scale= shows that key; one not on offer, or unknown, falls back to the first on offer
//   S3  Randal in Septimal offers the septimal keys and not Ptolemaic minor; no other tuning
//       lists a Septimal key, and Pythagorean tuning lists the Pythagorean keys only
//   S4  a layout that plays no key's scale from the reference key (Randal in Syntonic) says so
//       and offers none
//   S5  another starting note names the key after it and plays the same chords
//   S6  the dark theme: the page's ground, and the legend's seam "white"
//   S7  a minor key: its three scales named under the first footprint where one is of another
//       flavor than the key (Semiditonal minor), and not otherwise; a root with two triads
//   S8  footprint steps that draw the same keys share a picture and a name; a note the octave
//       above the reference key has no key for is counted, not drawn
//   S9  the diminished ii of a minor key, taken from its vii°7: where it is no catalog chord it
//       is named as HKL names its keys (apps/hkl/src/tuning/chords.ts), with its own ratio
//
//   node test/shapes/scales-page.mjs [--shot <png>] [--key <id>] [--query <mapping=…&mode=…>]
//     --shot: a screenshot of a page, by default S2's; --key and --query choose another

import { writeFileSync } from 'node:fs';
import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const URL = process.env.SCALES_URL ?? 'http://localhost:5170/scales.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0, fails = 0;
function check(label, got, want) {
  checks++;
  if (got !== want) { fails++; if (fails <= 40) console.log(`FAIL ${label}: got ${got}, want ${want}`); }
}
const READ = `(() => {
  const arts = [...document.querySelectorAll('article.entry')], chords = arts.filter((a) => a.id.startsWith('c')), feet = arts.filter((a) => a.id.startsWith('f'));
  const loaded = (a) => { const i = a.querySelector('img.diagram'); return !!i && i.complete && i.naturalWidth > 0; };
  const out = (a) => { const i = a.querySelector('img.diagram'); return !!i && i.getBoundingClientRect().right > a.getBoundingClientRect().right + 0.5; };
  const sections = [...document.querySelectorAll('.section[data-tier]')], text = (e) => e?.textContent ?? '';
  return { title: document.title, heading: text(document.querySelector('h1')), legend: text(document.querySelector('.legend')),
    scales: document.body.dataset.scales, scale: document.body.dataset.scale, played: document.body.dataset.played ?? '',
    feet: feet.map((a) => text(a.querySelector('.name')) + ' [' + text(a.querySelector('.facts')) + ']').join(' | '), feetLoaded: feet.filter(loaded).length + '/' + feet.length,
    feetRows: [...document.querySelectorAll('[data-part="footprint"] .row')].map((r) => r.children.length + ' of ' + r.dataset.columns).join(', '),
    feetNo: feet.map((a) => text(a.querySelector('.unplayed'))).filter(Boolean).join(' | '), feetScales: feet.map((a) => text(a.querySelector('.intervals'))).filter(Boolean).join(' | '),
    chords: chords.length, labels: chords.map((a) => a.dataset.label).join(' '),
    sections: sections.map((s) => s.querySelector('h2').textContent).join(' | '),
    bySection: sections.map((s) => { const a = [...s.querySelectorAll('article.entry')]; return a.filter(loaded).length + '/' + a.length; }).join(' '),
    no: sections.map((s) => text(s.querySelector(':scope > .unplayed'))).join(' | '),
    entry: Object.fromEntries(chords.map((a) => [a.dataset.label, text(a.querySelector('.name')) + ' | ' + text(a.querySelector('.facts'))])),
    out: arts.filter(out).length, first: chords[0] ? text(chords[0].querySelector('.name')) + ' | ' + text(chords[0].querySelector('.facts')) : null,
    /* a note name in text: a letter with an accidental, an arrow or a hook, or letters in a row ("C E G") */
    named: arts.filter((a) => /[↑↓⁷₇]|\\b[A-G](b|#|♭|♯)?( [A-G](b|#|♭|♯)?\\b)+/.test([...a.querySelectorAll('.facts, .intervals, .unplayed')].map(text).join(' '))).length,
    ground: getComputedStyle(document.documentElement).backgroundColor };
})()`;

const chrome = await launchChromium();
try {
  const cdp = new CDP(await newTabWsUrl(chrome.port));
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const errors = [];
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? 'exception'));
  const load = async (query) => {
    const done = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
    await cdp.send('Page.navigate', { url: URL + '?' + query });
    await done;
    let n = null;
    for (let i = 0; i < 100 && !n && !errors.length; i++) { n = await cdp.evalJSON('document.body.dataset.ready ?? null'); if (!n) await sleep(150); }
    return { ready: n, ...(n ? await cdp.evalJSON(READ) : {}) };
  };
  const SIX = 'ptolemaic-major,semiditonal-major,pythagorean-major,ptolemaic-minor,semiditonal-minor,pythagorean-minor';
  const shoot = async () => {
    const m = await cdp.send('Page.getLayoutMetrics');
    const { width, height } = m.cssContentSize;
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
    writeFileSync(arg('--shot'), Buffer.from(shot.data, 'base64'));
    console.log(`screenshot ${width}×${height} → ${arg('--shot')}`);
  };
  if (arg('--shot') && (arg('--key') || arg('--query'))) {
    const p = await load(`${arg('--query') ?? 'mapping=randal&mode=5'}&scale=${arg('--key') ?? ''}`);
    console.log(`${p.heading}: ${p.feet}`);
    await shoot();
    await chrome.stop();
    process.exit(0);
  }

  /* S1 */
  let p = await load('mapping=randal&mode=5');
  check('S1 the page finishes with the chords it plays', `${p.ready} ${p.chords}`, '27 27');
  check('S1 the keys on offer, and the one shown', `${p.scales} | ${p.scale}`, `${SIX} | ptolemaic-major`);
  check('S1 title', `${p.title} | ${p.heading}`, 'C Ptolemaic major: Randal mapping, Ptolemaic tuning | C Ptolemaic major: Randal mapping, Ptolemaic tuning');
  check('S1 the legend', /^What it takes to play in C Ptolemaic major on the Lumatone in this layout, with the reference note set to the unaltered C\. .* named under their section\. .* A heavy black line is a band seam\.$/.test(p.legend), true);
  check('S1 the footprint, from the scale', p.feet, 'Ptolemaic major scale [7 notes] | Diatonic triads [9 notes] | With the diatonic sevenths [11 notes] | With the secondary dominants [15 of 17 notes] | With the borrowed chords [18 of 20 notes]');
  check('S1 its pictures, in rows', `${p.feetLoaded} | ${p.feetRows}`, '5/5 | 2 of 2, 2 of 2, 1 of 2');
  check('S1 what a footprint step cannot play', p.feetNo, 'Unplayable: V/iii, V7/iii, V/vi, V7/vi');
  check('S1 the sections count what the layout plays', p.sections, 'Diatonic triads (7 of 7 on this layout) | Diatonic sevenths (7 of 7 on this layout) | Secondary dominants (6 of 10 on this layout) | Borrowed chords (7 of 7 on this layout)');
  check('S1 a picture for every chord the layout plays, and for no other', `${p.played} | ${p.bySection}`, '7/7 7/7 6/10 7/7 | 7/7 7/7 6/6 7/7');
  check('S1 the others are named under their section', p.no, ' |  | Unplayable on this layout: V/iii, V7/iii, V/vi, V7/vi | ');
  check('S1 no picture leaves its entry', p.out, 0);
  check('S1 the first chord, and the sevenths', `${p.first} | ${p.labels.split(' ').slice(7, 14).join(' ')}`, 'I Major triad | 4:5:6 | IM7 ii7 iii7 IVM7 V7 vi7 viiø7');
  check('S1 no note is named in text', p.named, 0);

  /* S2 */
  p = await load('mapping=randal&mode=5&scale=semiditonal-major');
  check('S2 the key asked for', `${p.scale} | ${p.heading} | ${p.played}`, 'semiditonal-major | C Semiditonal major: Randal mapping, Ptolemaic tuning | 7/7 7/7 6/10 7/7');
  if (arg('--shot')) await shoot();
  for (const bad of ['septimal-minor', 'nothing']) {
    p = await load(`mapping=randal&mode=5&scale=${bad}`);
    check(`S2 ?scale=${bad}, not on offer here, falls back to the first that is`, p.scale, 'ptolemaic-major');
  }

  /* S3 */
  p = await load('mapping=randal&mode=7&scale=septimal-minor');
  check('S3 Randal in Septimal: the keys on offer', p.scales, 'ptolemaic-major,semiditonal-major,pythagorean-major,septimal-major,semiditonal-minor,pythagorean-minor,septimal-minor');
  check('S3 Septimal minor', `${p.heading} | ${p.played} | ${p.out} | ${p.named}`, 'C Septimal minor: Randal mapping, Septimal tuning | 12/13 13/13 8/12 2/5 | 0 | 0');
  check('S3 what it cannot play', p.no, 'Unplayable on this layout: ♭III+ |  | Unplayable on this layout: V/♭III, V7/♭III, V/♭VI, V7/♭VI | Unplayable on this layout: It+6, Fr+6, Ger+6');
  check('S7 a minor key whose scales are all of its flavor does not list them', `${p.feet.split(' | ')[0]} | ${p.feetScales}`, 'Septimal minor scales [9 notes] | ');
  /* S9 */
  check('S9 Septimal minor: ii° and iiø7 are the upper notes of vii°7', `${p.entry['ii°']} / ${p.entry['iiø7']} / ${p.entry['vii°7']}`,
    'ii° Diminished triad | 162:189:224 / iiø7 Half-diminished seventh | 162:189:224:288 / vii°7 Septimal diminished seventh | 135:162:189:224');
  p = await load('mapping=randal&mode=7&scale=septimal-major');
  check('S3 Septimal major plays its septimal ii', `${p.played} | ${p.labels.split(' ').slice(0, 7).join(' ')}`, '7/7 7/7 6/10 4/7 | I ii iii IV V vi vii°');
  /* a tuning lists some keys and not others, whatever it could play of them */
  p = await load('mapping=randal&mode=P&scale=semiditonal-minor');
  check('S3 Randal in Pythagorean: only the Pythagorean keys, though it plays the Semiditonal minor scale', `${p.scales} | ${p.scale}`, 'pythagorean-major,pythagorean-minor | pythagorean-major');
  p = await load('mapping=randal&mode=5&scale=septimal-major');
  check('S3 a Septimal key is listed in Septimal tuning only', p.scale, 'ptolemaic-major');

  /* S4 */
  p = await load('mapping=randal&mode=S');
  check('S4 Randal in Syntonic plays no key', `${p.ready} | ${p.scales} | ${p.heading} | ${p.chords}`, 'none |  | No key on C: Randal mapping, Syntonic tuning | 0');

  /* S5 */
  p = await load('mapping=randal&mode=5&scale=semiditonal-major&root=Eb');
  check('S5 from E♭', `${p.heading} | ${p.played} | ${p.first} | ${p.named}`, 'E♭ Semiditonal major: Randal mapping, Ptolemaic tuning | 7/7 7/7 6/10 7/7 | I Major triad | 4:5:6 | 0');

  /* S6 */
  p = await load('mapping=randal&mode=5&theme=dark');
  check('S6 the dark page', `${p.ground} | ${/A heavy white line is a band seam\.$/.test(p.legend)} | ${p.chords}`, 'rgb(22, 22, 22) | true | 27');

  /* S7 */
  p = await load('mapping=randal&mode=5&scale=semiditonal-minor');
  check('S7 a minor key plays', `${p.heading} | ${p.played}`, 'C Semiditonal minor: Randal mapping, Ptolemaic tuning | 13/13 13/13 11/12 5/5');
  check('S9 Semiditonal minor: ii° from the 5-limit vii°7, its seventh a catalog chord', `${p.entry['ii°']} / ${p.entry['iiø7']}`, 'ii° Diminished triad | 135:160:192 / iiø7 Half-diminished seventh | 135:160:192:240');
  check('S7 its three scales', `${p.feet.split(' | ')[0]} | ${p.feetScales}`, 'Semiditonal minor scales [9 notes] | Pythagorean natural minor, Semiditonal harmonic minor, Semiditonal melodic minor');
  check('S7 its triads: two on a root', p.labels.split(' ').slice(0, 13).join(' '), 'i ii° ii ♭III ♭III+ iv IV V v ♭VI vi° ♭VII vii°');

  /* S8 */
  p = await load('mapping=randal&mode=5&scale=pythagorean-major');
  check('S8 steps that add no key share a picture', p.feet, 'Pythagorean major scale, diatonic triads and diatonic sevenths [7 notes] | With the secondary dominants [9 of 12 notes] | With the borrowed chords [11 of 14 notes]');
  check('S8 a chord may reach above the octave for a note the footprint lacks', `${p.played} | ${p.no}`, '7/7 7/7 6/10 4/4 |  |  | Unplayable on this layout: V/iii, V7/iii, V/vi, V7/vi | ');
  check('no page errors', errors.join(' | '), '');
} finally {
  await chrome.stop();
}
console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
