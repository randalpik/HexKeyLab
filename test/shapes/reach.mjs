// The reach model (docs/architecture/hkl.md → Lattice shapes → Reach).
//
// Pure Node report, no dev server. For each of the 48 layouts the guide is made for and each key
// its tuning lists (apps/hkl/src/shapes/profile.ts, `listsKey`): every chord of the key in every
// voicing, each inversion closed and open, free on the keyboard (apps/hkl/src/shapes/reach.ts):
// on its own bass note in any octave, on the keys with the smallest diameter. Each voicing is
// measured for one hand and for two (the larger hand of the best split), in key widths.
//   - per key and layout, by tier and by kind of voicing (closed or open, one hand or two): how
//     many voicings are within a hand's reach (MAX_REACH), and the mean diameter of those the
//     keyboard holds;
//   - with a profile id, that key in full: every voicing of every chord on every layout, as
//     "one hand × octaves within reach / two hands × octaves within reach";
//   - how many chords the Scales page draws on other keys now that it takes the smallest
//     diameter where a pitch repeats.
// This is not the Scales page's rule (root position, closed, from the root's key). The measure's
// identities and the model's invariants are checked; nothing about the layouts is pinned.
//
// Run: node --import ./test/orchestrator-smoke/register-ts.mjs test/shapes/reach.mjs [profile id]

import { PROFILES, TIERS, TIER_NAMES, chordReach, chordShape, keyPlace, listsKey } from '../../apps/hkl/src/shapes/profile.ts';
import { MAX_REACH, forgetReach, span, twoHands, voicings } from '../../apps/hkl/src/shapes/reach.ts';
import { forgetShapes, keyDistance, solve } from '../../apps/hkl/src/shapes/solve.ts';
import { rootedLayout } from '../../apps/hkl/src/shapes/guide.ts';
import { expsOf, ratioOf } from '../../apps/hkl/src/shapes/catalog.ts';
import { SHAPE_GUIDE_MODES, TUNING_LABELS } from '../../packages/shared/src/freq.ts';
import { MAPPINGS, MAPPING_LABELS } from '../../packages/shared/src/mapping.ts';

let checks = 0, fails = 0;
const check = (label, got, want) => { checks++; if (got !== want) { fails++; if (fails <= 30) console.log(`FAIL ${label}: got ${got}, want ${want}`); } };
const f = (x) => x.toFixed(2);
const only = process.argv[2];

/* the measure */
{
  check('one key', span([[0, 0]]), 0);
  check('two keys that touch', f(span([[0, 0], [1, 0]])), '1.00');
  check('two keys: their distance, on every axis', [[3, 0], [0, 3], [-3, 3], [2, 5]].map((c) => f(span([[0, 0], c])) === f(keyDistance([0, 0], c))).join(), 'true,true,true,true');
  check('three keys that touch each other: 2/√3', f(span([[0, 0], [1, 0], [0, 1]])), f(2 / Math.sqrt(3)));
  check('three keys in a line: the outer two', f(span([[0, 0], [1, 0], [2, 0]])), '2.00');
  check('a key and the six around it', f(span([[0, 0], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]])), '2.00');
  check('a blunt triangle stands on its longest side', f(span([[0, 0], [4, 0], [2, 1]])), '4.00');
  check('the order of the keys does not matter', f(span([[2, 1], [0, 0], [4, 0]])), '4.00');
  const two = twoHands([[0, 0], [1, 0], [10, 0], [10, 1], [0, 1]]);
  check('two hands: each takes its cluster', `${f(two.span)} | ${two.hands.map((h) => h.join(' ')).join(' | ')}`, `${f(2 / Math.sqrt(3))} | 0,0 1,0 0,1 | 10,0 10,1`);
  check('two hands: two keys, one each', f(twoHands([[0, 0], [9, 0]]).span), '0.00');
  check('two hands: nothing to share', twoHands([[0, 0]]), null);
}

/* the voicings */
{
  const show = (ms) => voicings(ms.map(([n, d]) => expsOf(n, d))).map((v) => `${v.inversion}${v.open ? 'o' : 'c'} ${v.members.map((m) => ratioOf(m).join('/')).join(' ')}`).join(' | ');
  check('a triad: each inversion, closed and open (the second note up an octave)', show([[1, 1], [5, 4], [3, 2]]),
    '0c 1/1 5/4 3/2 | 0o 1/1 5/2 3/2 | 1c 1/1 6/5 8/5 | 1o 1/1 12/5 8/5 | 2c 1/1 4/3 5/3 | 2o 1/1 8/3 5/3');
  check('a seventh chord: open raises the second and the fourth', show([[1, 1], [5, 4], [3, 2], [15, 8]]).split(' | ').filter((x) => /o /.test(x)).join(' | '),
    '0o 1/1 5/2 3/2 15/4 | 1o 1/1 12/5 3/2 16/5 | 2o 1/1 5/2 4/3 10/3 | 3o 1/1 32/15 4/3 16/5');
}

/* every listed key on every layout */
const KINDS = [['closed, one hand', false, 0], ['closed, two hands', false, 1], ['open, one hand', true, 0], ['open, two hands', true, 1]];
const rows = new Map(PROFILES.map((p) => [p.id, []]));
let voiced = 0, held = 0, redrawn = 0, drawn = 0, tighter = 0;
for (const mode of SHAPE_GUIDE_MODES) for (const mapping of MAPPINGS) {
  const { layout, ref } = rootedLayout({ mode, mapping, banded: true });
  const name = `${MAPPING_LABELS[mapping]} ${TUNING_LABELS[mode]}`;
  for (const p of PROFILES) {
    if (!listsKey(p, mode)) continue;
    const place = keyPlace(p, layout, ref);
    const chords = p.chords.map((c) => {
      const vs = chordReach(c, layout, ref);
      for (const v of vs) {
        voiced++;
        if (!v.reach) continue;
        held++;
        const r = v.reach;
        check(`${name}, ${p.name} ${c.label} ${v.inversion}${v.open ? 'o' : 'c'}: two hands are never wider than one, nor reach fewer octaves`, r.two[0].span <= r.one.span + 1e-9 && r.two[1].span <= r.two[0].span + 1e-9 && r.within[1] >= r.within[0] && r.octaves >= r.within[1], true);
        check(`${name}, ${p.name} ${c.label} ${v.inversion}${v.open ? 'o' : 'c'}: the diameter is its keys'`, f(span(r.one.cells)) === f(r.one.span) && r.one.cells.length === c.members.length && r.two[0].cells.length + r.two[1].cells.length === c.members.length, true);
      }
      /* the Scales page's chord: never tighter than the free one, and where it changed keys, tighter than before */
      const shape = place && chordShape(c, layout, ref, place);
      if (shape) {
        drawn++;
        const free = vs[0].reach, before = solve(c.members, layout, 'C', ref, place.keyOf(c.root));
        check(`${name}, ${p.name} ${c.label}: free on the keyboard it is no wider than on the page`, free !== null && free.one.span <= span(shape.cells) + 1e-9, true);
        if (String(before.cells) !== String(shape.cells)) { redrawn++; if (span(shape.cells) < span(before.cells) - 1e-9) tighter++; }
        check(`${name}, ${p.name} ${c.label}: the page's keys are no wider than the nearest-to-the-bass ones`, span(shape.cells) <= span(before.cells) + 1e-9, true);
      }
      return { c, vs };
    });
    rows.get(p.id).push({ name, chords, offered: !!place });
  }
  forgetShapes();
  forgetReach();
}

const spanOf = (v, hands) => (v.reach ? (hands ? v.reach.two[0].span : v.reach.one.span) : null);
for (const p of PROFILES) {
  const of = TIERS.map((t) => p.chords.filter((c) => c.tier === t).reduce((n, c) => n + c.members.length, 0));
  console.log(`\n${p.name}: voicings within ${MAX_REACH} key widths, by tier (${TIERS.map((t, i) => `${TIER_NAMES[t]} ${of[i]}`).join(', ')} of each kind), then the mean diameter of those the keyboard holds`);
  console.log(`  kinds: ${KINDS.map((k) => k[0]).join(' | ')};  * the Scales tab does not offer the key on this layout`);
  for (const row of rows.get(p.id)) {
    const per = TIERS.map((t) => KINDS.map(([, open, hands]) => row.chords.filter((x) => x.c.tier === t).flatMap((x) => x.vs.filter((v) => v.open === open).map((v) => spanOf(v, hands))).filter((s) => s !== null)));
    const within = per.map((kinds) => kinds.map((got) => String(got.filter((s) => s <= MAX_REACH + 1e-9).length).padStart(2)).join(' ')).join('  |  ');
    const means = per.map((kinds) => kinds.map((got) => (got.length ? f(got.reduce((a, b) => a + b, 0) / got.length) : '  — ').padStart(5)).join(' ')).join('  | ');
    console.log(`  ${(row.name + (row.offered ? '' : ' *')).padEnd(27)} ${within}   ‖ ${means}`);
    if (only !== p.id) continue;
    for (const { c, vs } of row.chords) {
      const cell = (v) => (v.reach ? `${f(v.reach.one.span)}×${v.reach.within[0]}/${f(v.reach.two[0].span)}×${v.reach.within[1]}` : '—').padEnd(16);
      console.log(`      ${c.label.padEnd(8)} closed ${vs.filter((v) => !v.open).map(cell).join('')} open ${vs.filter((v) => v.open).map(cell).join('')}`);
    }
  }
}

console.log(`\nvoicings measured: ${voiced}, of which the keyboard holds ${held}`);
console.log(`Scales page: of ${drawn} chords drawn, ${redrawn} are on other keys than the ones nearest the bass, ${tighter} of them with a smaller diameter (the rest would be a tie, which keeps the nearest keys)`);
console.log(`\n${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
