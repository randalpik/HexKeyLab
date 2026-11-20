// Key profiles and their footprints (docs/architecture/hkl.md → Lattice shapes → Key profiles).
//
// Pure Node report, no dev server. For the eight key profiles (apps/hkl/src/shapes/profile.ts):
//   - each one's footprint by tier, and the note names that need more than one pitch;
//   - for each of the 48 layouts the guide is made for, with the tonic's unaltered key as the
//     reference: the chords of each tier a Lumatone's 280 keys can play from their own roots
//     in root position, each from its root's key (a key is offered on a layout that plays its
//     scale as a run from the reference key; a minor key, one of its three);
//   - with a profile id, that profile in full: every chord with its pitches (a pitch outside the
//     scale in brackets), the footprint pitch by pitch, and per layout what cannot be played.
// A few identities are checked; nothing about the layouts is pinned while the profiles are
// still being ruled on.
//
// Run: node --import ./test/orchestrator-smoke/register-ts.mjs test/shapes/footprint.mjs [profile id]

import { PROFILES, TIERS, TIER_NAMES, pitchName, pitchClass, chordName, chordShape, keyPlace, footprintSteps } from '../../apps/hkl/src/shapes/profile.ts';
import { forgetShapes } from '../../apps/hkl/src/shapes/solve.ts';
import { rootedLayout } from '../../apps/hkl/src/shapes/guide.ts';
import { ratioOf, centsOf, expsKey, expsOf, combinedRatio } from '../../apps/hkl/src/shapes/catalog.ts';
import { SHAPE_GUIDE_MODES, TUNING_LABELS } from '../../packages/shared/src/freq.ts';
import { MAPPINGS, MAPPING_LABELS } from '../../packages/shared/src/mapping.ts';

let checks = 0, fails = 0;
const check = (label, got, want) => { checks++; if (got !== want) { fails++; console.log(`FAIL ${label}: got ${got}, want ${want}`); } };
const frac = (e) => ratioOf(e).join('/');
const only = process.argv[2];
const shortId = (p) => p.id.split('-').map((w, i) => (i ? w[0].toUpperCase() : w.slice(0, 3))).join('');

console.log('profile: scale notes; chords by tier; footprint, cumulative by tier; note names with more than one pitch');
for (const p of PROFILES) {
  const inScale = new Set(p.scale.map(expsKey));
  const byName = new Map();
  for (const f of p.footprint) { const n = pitchName(f.exps).replace(/[↑↓⁷₇]/g, ''); byName.set(n, [...(byName.get(n) ?? []), f]); }
  const offScale = p.chords.filter((c) => c.tier <= 2 && c.tones.some((t) => !inScale.has(expsKey(t)))).map((c) => c.label);
  console.log(`  ${p.name.padEnd(18)} ${p.scale.length} notes; ${TIERS.map((t) => p.chords.filter((c) => c.tier === t).length).join(' + ')} chords; ${TIERS.map((t) => p.footprint.filter((x) => x.tier <= t).length).join(', ')} pitches; `
    + [...byName].filter(([, fs]) => fs.length > 1).map(([n, fs]) => `${n}×${fs.length}`).join(' '));
  console.log(`  ${''.padEnd(18)} diatonic chords with a note outside the scale: ${offScale.join(' ') || 'none'}`);
  if (only !== p.id) continue;
  for (const tier of TIERS) {
    console.log(`    ${tier}. ${TIER_NAMES[tier]}`);
    for (const c of p.chords.filter((x) => x.tier === tier)) {
      console.log(`       ${c.label.padEnd(8)} ${(c.chord ?? '(not in the catalog)').padEnd(36)} ${c.tones.map((t) => (inScale.has(expsKey(t)) ? pitchName(t) : `[${pitchName(t)}]`)).join(' ').padEnd(26)} ${c.tones.map(frac).join(' ')}`);
    }
  }
  console.log('    footprint');
  for (const f of p.footprint) console.log(`       ${pitchName(f.exps).padEnd(6)} ${frac(f.exps).padEnd(9)} ${centsOf(f.exps).toFixed(1).padStart(7)}¢  tier ${f.tier}${f.inScale ? ' scale' : '      '}  ${f.chords.join(' ')}`);
}

console.log(`\nchords a layout can play from their own roots, by tier; a key is offered when the layout plays its scale as a run from the reference key (a minor key, one of its three), otherwise —`);
console.log('  of: ' + PROFILES.map((p) => `${shortId(p)} ${TIERS.map((t) => p.chords.filter((c) => c.tier === t).length).join(' ')}`).join(', '));
console.log('  ' + ''.padEnd(26) + PROFILES.map((p) => shortId(p).padEnd(13)).join(''));
const offered = {}, noRun = [], pictures = {}, notes = [0, 0], hkl = new Map();
for (const mode of SHAPE_GUIDE_MODES) for (const mapping of MAPPINGS) {
  const { layout, ref } = rootedLayout({ mode, mapping, banded: true });
  const cells = PROFILES.map((p) => {
    const place = keyPlace(p, layout, ref);
    if (!place) return '—'.padEnd(13);
    const shapes = p.chords.map((c) => chordShape(c, layout, ref, place)), can = shapes.map((x) => x !== null);
    /* the chords the catalog lacks, as HKL names the keys they are drawn on */
    p.chords.forEach((c, i) => { if (c.chord === null && shapes[i]) { const k = `${c.label} ${frac(c.tones[1])}: ${chordName(c, shapes[i], layout)}`; hkl.set(k, (hkl.get(k) ?? 0) + 1); } });
    const by = TIERS.map((t) => p.chords.filter((c, i) => c.tier === t && can[i]).length);
    offered[p.id] = (offered[p.id] ?? 0) + 1;
    const lost = p.scales.filter((_, i) => !place.runs[i]).length;
    if (lost) noRun.push(`${MAPPING_LABELS[mapping]} ${TUNING_LABELS[mode]}: ${p.name} ${lost} of ${p.scales.length}`);
    const steps = footprintSteps(p, layout, ref, place), last = steps[steps.length - 1];
    pictures[steps.length] = (pictures[steps.length] ?? 0) + 1;
    notes[0] += last.drawn; notes[1] += last.pitches;
    if (only === p.id) { const no = p.chords.filter((c, i) => !can[i]).map((c) => c.label); console.log(`    ${MAPPING_LABELS[mapping]} ${TUNING_LABELS[mode]}: ${last.drawn} of ${last.pitches} notes${lost ? `, ${lost} scale(s) without a run` : ''}; cannot play: ${no.join(' ') || 'nothing'}`); }
    return by.join(' ').padEnd(13);
  });
  console.log('  ' + (MAPPING_LABELS[mapping] + ' ' + TUNING_LABELS[mode]).padEnd(26) + cells.join(''));
  forgetShapes();
}
console.log(`  offered minor keys with a scale that is no run from the reference key: ${noRun.length}`);
for (const x of noRun) console.log('    ' + x);
console.log(`  offered keys by the number of footprint pictures (of 5 steps, alike ones merged): ${JSON.stringify(pictures)}`);
console.log(`  footprint notes with a key in the octave above the reference key, over the offered keys: ${notes[0]} of ${notes[1]}`);
console.log('  chords the catalog lacks, as HKL names their keys (numeral, its third from the tonic: name, layouts):');
for (const [k, n] of [...hkl].sort()) console.log(`    ${k}, ${n}`);
console.log('  layouts that offer each key, of 48: ' + PROFILES.map((p) => `${p.name} ${offered[p.id] ?? 0}`).join(', '));

/* identities (Max, 2026-11-19) */
{
  const tone = (id, label, i) => frac(PROFILES.find((x) => x.id === id).chords.find((c) => c.label === label).tones[i]);
  const S = 'semiditonal-major';
  check('Semiditonal major: ii is on 9/8 with the F of IV and an A a comma above the A of IV', `${tone(S, 'ii', 0)} ${tone(S, 'ii', 1)} ${tone(S, 'ii', 2)} | ${tone(S, 'IV', 0)} ${tone(S, 'IV', 1)}`, '9/8 4/3 27/16 | 4/3 5/3');
  check('Semiditonal major: that A is the fifth of V/V and the root of V/ii', `${tone(S, 'V/V', 2)} ${tone(S, 'V/ii', 0)}`, '27/16 27/16');
  check('Ptolemaic and Semiditonal major share a scale and differ on ii', `${PROFILES[0].scale.map(frac).join()} | ${PROFILES[1].scale.map(frac).join()} | ${tone('ptolemaic-major', 'ii', 1)} ${tone(S, 'ii', 1)}`,
    '1/1,9/8,5/4,4/3,3/2,5/3,15/8 | 1/1,9/8,5/4,4/3,3/2,5/3,15/8 | 27/20 4/3');
  check('Septimal major: the dominant\'s seventh is the septimal diminished triad\'s fifth', `${tone('septimal-major', 'V7', 3)} ${tone('septimal-major', 'vii°', 2)}`, '21/16 21/16');
  check('Septimal major: ii takes the scale\'s F and a pure fifth, a Pythagorean minor triad', ['ii', 'ii7'].map((l) => PROFILES.find((x) => x.id === 'septimal-major').chords.find((c) => c.label === l)).map((c) => `${c.chord}: ${c.tones.map(frac).join(' ')}`).join(' | '),
    'Pythagorean minor triad: 9/8 4/3 27/16 | Pythagorean minor seventh: 9/8 4/3 27/16 1/1');
  {
    /* The rules a chord is generated by (Max, 2026-11-20; apps/hkl/src/shapes/profile.ts), over every chord of every key */
    /* a chord's notes as semitones above its root: read from the root, where rounding is safe (a note with two septimal
       factors lies 62 cents from its semitone when measured from the tonic) */
    const stepsOf = (c) => c.members.map((m) => Math.round(centsOf(m) / 100)), ratio = (a, b) => frac(pitchClass(a.map((x, i) => x - b[i])));
    let fifths = 0, wolves = [], thirds = [], sevenths = [];
    for (const p of PROFILES) {
      const flavor = p.id.split('-')[0];
      for (const c of p.chords) {
        /* 1: every perfect fifth inside a chord is 3:2 */
        const steps = stepsOf(c), sixth = /\+6$/.test(c.label);
        c.members.forEach((a, i) => c.members.forEach((b, j) => { if (steps[j] - steps[i] === 7) { fifths++; if (ratio(b, a) !== '3/2') wolves.push(`${p.name} ${c.label}`); } }));
        /* 2: a major triad, and a seventh on one, has a 5:4 third; 81:64 on a septimal root or in a Pythagorean key */
        if (!sixth && steps[1] === 4 && steps[2] === 7 && ratio(c.tones[1], c.root) !== (flavor === 'pythagorean' || c.root[3] !== 0 ? '81/64' : '5/4')) thirds.push(`${p.name} ${c.label}`);
        /* 3: a dominant seventh's seventh is 7:4 in a Septimal key, 16:9 elsewhere */
        if (!sixth && steps.join() === '0,4,7,10' && ratio(c.tones[3], c.root) !== (flavor === 'septimal' ? '7/4' : '16/9')) sevenths.push(`${p.name} ${c.label}`);
      }
    }
    check('rule 1: every perfect fifth inside every chord of every key is 3:2', wolves.join('; '), '');
    check('rule 1 looked at this many fifths', fifths, 294);
    check('rule 2: major triads and their sevenths have a 5:4 third, 81:64 on a septimal root or in a Pythagorean key', thirds.join('; '), '');
    check('rule 3: dominant sevenths are 7:4 in Septimal keys and 16:9 elsewhere', sevenths.join('; '), '');
    /* the chords Max named while ruling, as ratios */
    const NAMED = { 'ptolemaic-major': { ii: '10:12:15', 'vii°': '45:54:64', 'viiø7': '25:30:36:45' }, 'semiditonal-major': { ii: '54:64:81', 'viiø7': '45:54:64:81' },
      'septimal-major': { 'vii°': '5:6:7', V7: '4:5:6:7', 'viiø7': '5:6:7:9' },
      'ptolemaic-minor': { 'vi°': '25:30:36', 'viø7': '25:30:36:45', 'viiø7': '25:30:36:45', 'iiø7': '45:54:64:81', 'vii°': '45:54:64', 'vii°7': '225:270:320:384' },
      'semiditonal-minor': { 'viø7': '45:54:64:81', 'viiø7': '45:54:64:81', 'iiø7': '729:864:1024:1296', '♭III+': '256:324:405', '♭III': '4:5:6', '♭VI': '4:5:6', '♭VII': '4:5:6' },
      'septimal-minor': { i: '6:7:9', iv: '6:7:9', v: '54:64:81', ii: '54:64:81', 'ii°': '81:96:112', 'vi°': '5:6:7', 'vii°': '5:6:7', 'vii°7': '135:162:189:224', '♭III+': '28:36:45' } };
    for (const [id, named] of Object.entries(NAMED)) for (const [label, want] of Object.entries(named)) {
      check(`${id} ${label}: the chord Max named`, combinedRatio(PROFILES.find((x) => x.id === id).chords.find((c) => c.label === label).members), want);
    }
    /* a half-diminished seventh's fifth may differ from the diminished triad's on its root (rule 5): Ptolemaic's vii */
    const pm = PROFILES.find((x) => x.id === 'ptolemaic-major'), of = (l) => pm.chords.find((c) => c.label === l);
    check('Ptolemaic major: vii° has the scale\'s F, viiø7 the F a comma above it', `${frac(of('vii°').tones[2])} ${frac(of('viiø7').tones[2])}`, '4/3 27/20');
    /* the borrowed chords: a major key's are its parallel minor's; the Neapolitan's third is scale degree 4; the sixths stand on 8/5 */
    for (const flavor of ['ptolemaic', 'semiditonal', 'pythagorean', 'septimal']) {
      const major = PROFILES.find((x) => x.id === `${flavor}-major`), minor = PROFILES.find((x) => x.id === `${flavor}-minor`);
      const tones = (pr, l) => pr.chords.find((c) => c.label === l).tones.map(frac).join(' ');
      for (const l of ['iv', '♭VI', '♭VII', 'vii°7']) check(`${flavor} major borrows ${l} from its parallel minor`, tones(major, l), tones(minor, l));
      check(`${flavor} minor: the Neapolitan's third is scale degree 4`, frac(minor.chords.find((c) => c.label === '♭II').tones[1]), '4/3');
    }
    check('the Neapolitan\'s root: a pure third below scale degree 4, a Pythagorean third in the Pythagorean key', PROFILES.slice(4).map((p) => frac(p.chords.find((c) => c.label === '♭II').root)).join(' '), '16/15 16/15 256/243 16/15');
    check('Semiditonal major: ♭VI is on the parallel minor\'s root, the augmented sixths on 8/5', ['♭VI', 'It+6', 'Fr+6', 'Ger+6'].map((l) => frac(PROFILES[1].chords.find((c) => c.label === l).root)).join(' '), '128/81 8/5 8/5 8/5');
    /* a tonic a comma off, where a pure third or fifth puts one (accepted by Max) */
    const off = PROFILES.flatMap((p) => p.chords.filter((c) => c.tier <= 2).flatMap((c) => c.tones.filter((t) => (centsOf(t) < 30 || centsOf(t) > 1170) && frac(t) !== '1/1').map((t) => `${p.id} ${c.label} ${frac(t)}`)));
    check('diatonic chords with a tonic a comma off', off.join('; '), 'ptolemaic-major ii7 81/80; ptolemaic-minor iiø7 81/80; ptolemaic-minor ii7 81/80; semiditonal-minor ♭VI 160/81; semiditonal-minor ♭VIM7 160/81; septimal-minor ♭VI 63/32; septimal-minor ♭VIM7 63/32');
    check('the chords the catalog lacks, by key', PROFILES.map((p) => p.chords.filter((c) => c.chord === null).map((c) => c.label).join(' ') || '—').join(' | '),
      'viiø7 | viiø7 vii°7 | — | — | vi° iiø7 viø7 viiø7 | ♭III+ viø7 vii°7 viiø7 | — | ii° ♭III+ iiø7 V7/♭III V7/♭VI');
  }
  {
    const want = { 1: 'i ii° ii ♭III ♭III+ iv IV V v ♭VI vi° ♭VII vii°', 2: 'i7 iiø7 ii7 ♭IIIM7 iv7 IV7 V7 v7 ♭VIM7 viø7 ♭VII7 vii°7 viiø7', 3: 'V/ii V7/ii V/♭III V7/♭III V/iv V7/iv V/V V7/V V/♭VI V7/♭VI V/♭VII V7/♭VII' };
    for (const p of PROFILES.slice(4)) for (const t of [1, 2, 3]) check(`${p.name}: the chords of its three scales, tier ${t}`, p.chords.filter((c) => c.tier === t).map((c) => c.label).join(' '), want[t]);
    check('major keys: sevenths', PROFILES.slice(0, 4).map((p) => p.chords.filter((c) => c.tier === 2).map((c) => c.label).join(' ')).join(' | '), Array(4).fill('IM7 ii7 iii7 IVM7 V7 vi7 viiø7').join(' | '));
    check('the major IV of a minor key is diatonic, not borrowed', PROFILES.slice(4).map((p) => p.chords.filter((c) => c.tier === 4).map((c) => c.label).join(' ')).join(' | '),
      'I ♭II It+6 Fr+6 Ger+6 | I ♭II It+6 Fr+6 Ger+6 | I ♭II | I ♭II It+6 Fr+6 Ger+6');
  }
  check('Septimal minor: Pythagorean major triads on the septimal third and sixth', `${tone('septimal-minor', '♭III', 0)} ${tone('septimal-minor', '♭III', 1)} | ${tone('septimal-minor', '♭VI', 0)} ${tone('septimal-minor', '♭VI', 1)}`, '7/6 189/128 | 14/9 63/32');
  check('a minor key stands on nine notes, a major on seven', PROFILES.map((p) => p.scale.length).join(), '7,7,7,7,9,9,9,9');
  check('every scale note has a triad and a seventh', PROFILES.every((p) => [1, 2].every((t) => p.scale.every((e) => p.chords.some((c) => c.tier === t && expsKey(c.root) === expsKey(e))))), true);
  check('every diatonic chord is on a scale note', PROFILES.every((p) => p.chords.every((c) => c.tier > 2 || p.scale.some((e) => expsKey(e) === expsKey(c.root)))), true);
  check('every chord tone is in its footprint, and every scale note', PROFILES.every((p) => p.chords.every((c) => c.tones.every((t) => p.footprint.some((f) => expsKey(f.exps) === expsKey(t)))) && p.footprint.filter((f) => f.inScale).length === p.scale.length), true);
  check('pitch names', [expsOf(5, 4), expsOf(27, 16), expsOf(8, 5), expsOf(7, 4), expsOf(1, 1)].map((e) => pitchName(e)).join(' '), 'E↓ A Ab↑ Bb⁷ C');
}
console.log(`\n${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
