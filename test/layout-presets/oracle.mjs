// Layout-presets oracle (docs/architecture.md → Note-name mapping → The layout matrix).
//
// Pure Node gate — no dev server, no browser. Imports the REAL @hkl/shared modules through the
// repo's TS loader and checks the matrix model on EVERY layout the bound allows — all 48: the
// eight presets (MAPPINGS) and every other valid (division, shear, invert), which only the layout
// builder reaches (docs/local/layout-presets.md §6):
//   T  the ids and the bound: the presets' values; the 48 layouts, each with exactly one id that
//      round-trips; the shear ranges and row steps per division and orientation; malformed,
//      out-of-bound and preset-aliasing ids rejected; shear clamping
//   A  semitone map: coordToMidi = 57 + c·q + (row step)·r = the sampled chromatic cell's MIDI
//      + 12·oct
//   B  Euler, Wicki-Hayden and Chromatic are unchanged: every primitive against the closed forms
//      it had before the matrix model (bands, position in band, Euler-equivalent, MIDI, octave
//      vector, Euler vectors, frame conversion, anchor)
//   C  the pure line (−s/c, 1): exact 3/2 (plain) or 4/3 (inverted) in all seven JI modes,
//      banded and unbanded, anchors 0 and 1
//   D  the band step (W, 0): exact 2/1 in 5/P/D/7
//   E  seams: the pure line never crosses one; position in band stays in 0…W−1
//   F  Euler-equivalents: same nominal MIDI and spelled octave, same pitch in 5/P/D/7;
//      fromEuler round-trips every Euler cell
//   G  invert vs mirror: an inverted (W, k) layout has the pitches of plain (W, W−1−k) mirrored,
//      cell for cell, in 5/P/D/7; its fifth (W−k, −1) is exact there
//   H  frame conversion between every pair keeps the pitch in 5/P/D/7
//   I  octave vectors: the band step and the unbanded spelled octave keep the name and raise the
//      spelled octave by one; which layouts have an unbanded one
//   J  Euler vectors: vecFromEuler moves every cell's Euler-equivalent by exactly that vector, or
//      is null — only on a 4-wide band (c = 3), for an M3 count that is not a multiple of 3
//   K  the reference spine: every row holds a cell on its band's qm0 column (chromatic Q ≡ 0
//      mod 12)
//   L  color: the spine rule in every JI mode, banded and unbanded — the spine of fifths (of
//      fourths, mirrored, in an inverted layout) holds one color per octave and a 5:4 chain takes
//      the spine's color at its octave; a pitch keeps its color across layouts of one
//      orientation (Euler's plain, Randal's inverted, copy columns included); 3-wide bands read
//      ±(MIDI octave − band), and unbanded Ptolemaic there is one stripe per octave; a band step
//      keeps the hue; Equal stays its octave cycle
//   S  the score frame: every layout converts into the finest preset of its orientation
//      (Chromatic plain, Park inverted) with the nominal MIDI kept, and with the exact pitch kept
//      in every JI mode, banded and unbanded, from every plain layout and every inverted layout
//      of division 3 or 6; from an inverted division 4 or 12, banded in the band-uniform modes
// Run: node --import ./test/orchestrator-smoke/register-ts.mjs test/layout-presets/oracle.mjs

import {
  layoutOf, MAPPINGS, MAPPING_LABELS, toChromatic, eulerOf, fromEuler, bandOfCell, posInBandOf,
  pitchBandOf, bandWidth, octaveVector, vecFromEuler, convertCell,
  allMappings, specOf, mappingOf, isMapping, isPresetMapping, isValidSpec, shearRange, clampShear,
  mappingLabel, DIVISIONS,
} from '../../packages/shared/src/mapping.ts';
import { coordExps, coordToMidi, anchorOf, TUNING_MODES } from '../../packages/shared/src/freq.ts';
import { noteName, keyOctave } from '../../packages/shared/src/notes.ts';
import { keyColor } from '../../packages/shared/src/keycolor.ts';
import { hueIdx, equalHueCycle } from '../../packages/shared/src/colors.ts';

let checks = 0, fails = 0;
function check(label, got, want) {
  checks++;
  if (got !== want) { fails++; if (fails <= 40) console.log(`FAIL ${label}: got ${got}, want ${want}`); }
}
const JI = TUNING_MODES.filter((m) => m !== 'E');
const UNIFORM = ['5', 'P', 'D', '7'];
const k = (e) => e.join(',');
const sub = (a, b) => a.map((x, i) => x - b[i]);
const P5 = '-1,1,0,0', P4 = '2,-1,0,0', OCT = '1,0,0,0';
const CELLS = []; for (let q = -18; q <= 18; q++) for (let r = -9; r <= 9; r++) CELLS.push([q, r]);
const rowStep = (L) => layoutOf(L).s + (layoutOf(L).invert ? 5 : 7);
const pureLine = (L) => [-layoutOf(L).s / layoutOf(L).c, 1];

/* The table itself */
check('MAPPINGS (dropdown order)', MAPPINGS.join(), 'euler,wickiHayden,chromatic,gerhard,janko,accordion,randal,park');
const SPEC = {
  euler: [4, 0, false], wickiHayden: [2, 0, false], chromatic: [1, 0, false], janko: [2, -6, false],
  accordion: [2, -2, true], gerhard: [4, -4, false], randal: [4, 0, true], park: [2, 0, true],
};
for (const L of MAPPINGS) {
  check(`table ${L}`, [layoutOf(L).c, layoutOf(L).s, layoutOf(L).invert].join(), SPEC[L].join());
  check(`label ${L}`, typeof MAPPING_LABELS[L], 'string');
  check(`label ${L} via mappingLabel`, mappingLabel(L), MAPPING_LABELS[L]);
}

/* T — the ids and the bound (docs/local/layout-presets.md §6: the presets in (W, k, invert), the
   shear ranges and their row steps) */
const ALL = allMappings();
const PRESET_VALUES = {
  euler: [3, 0, false], randal: [3, 0, true], gerhard: [3, 1, false], wickiHayden: [6, 0, false],
  park: [6, 0, true], janko: [6, 3, false], accordion: [6, 1, true], chromatic: [12, 0, false],
};
const RANGES = {            /* [lowest shear, highest shear, row steps from lowest to highest] */
  '3,false': [-1, 1, [11, 7, 3]], '3,true': [-1, 1, [9, 5, 1]],
  '4,false': [-1, 2, [10, 7, 4, 1]], '4,true': [-2, 1, [11, 8, 5, 2]],
  '6,false': [-2, 3, [11, 9, 7, 5, 3, 1]], '6,true': [-3, 2, [11, 9, 7, 5, 3, 1]],
  '12,false': [-5, 5, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]], '12,true': [-7, 3, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]],
};
check('T 48 layouts', ALL.length, 48);
check('T ids are unique', new Set(ALL).size, ALL.length);
check('T the presets come first, in dropdown order', ALL.slice(0, MAPPINGS.length).join(), MAPPINGS.join());
check('T divisions', DIVISIONS.join(), '3,4,6,12');
for (const L of MAPPINGS) {
  const p = specOf(L);
  check(`T ${L} values`, [p.division, p.shear, p.invert].join(), PRESET_VALUES[L].join());
}
for (const L of ALL) {
  const p = specOf(L), M = layoutOf(L);
  check(`T ${L} is a mapping`, isMapping(L), true);
  check(`T ${L} id round trip`, mappingOf(p), L);
  check(`T ${L} is a preset iff named`, isPresetMapping(L), MAPPINGS.includes(L));
  check(`T ${L} label`, mappingLabel(L), MAPPINGS.includes(L) ? MAPPING_LABELS[L] : 'Custom');
  check(`T ${L} matrix`, [M.c, M.s, M.invert].join(), [12 / p.division, -p.shear * (12 / p.division) + 0, p.invert].join());
  check(`T ${L} c | s`, M.s % M.c, 0);
  check(`T ${L} row step ascends within an octave`, rowStep(L) >= 1 && rowStep(L) <= 12, true);
  check(`T ${L} row step differs from the column step`, rowStep(L) !== M.c, true);
}
for (const division of DIVISIONS) for (const invert of [false, true]) {
  const [lo, hi, steps] = RANGES[`${division},${invert}`];
  check(`T (${division}, ${invert}) shear range`, shearRange(division, invert).join(), `${lo},${hi}`);
  const got = [];
  for (let shear = lo; shear <= hi; shear++) got.push(coordToMidi(0, 1, mappingOf({ division, shear, invert })) - 57);
  check(`T (${division}, ${invert}) row steps`, got.join(), steps.join());
  for (let shear = -20; shear <= 20; shear++) {
    check(`T (${division}, ${shear}, ${invert}) valid iff in range`, isValidSpec({ division, shear, invert }), shear >= lo && shear <= hi);
    check(`T (${division}, ${shear}, ${invert}) clamps into range`, clampShear(division, shear, invert), Math.min(hi, Math.max(lo, shear)));
  }
}
check('T Bass is inverted (12, 0)', mappingOf({ division: 12, shear: 0, invert: true }), '12:0:i');
check('T Janko inverted clamps to shear 2', clampShear(6, 3, true), 2);
const NOT_IDS = [
  '3:0', '6:0', '12:0', '3:1', '6:3', '6:1:i', '3:0:i', '6:0:i',     /* a preset's values: only its name is its id */
  '6:+1', '6:01', '6:-0', '6:1.0', ' 6:2', '6:2 ', '6:2:I', '6:2:', '6', ':2', '6:2:i:i',   /* not the canonical form */
  '5:0', '2:0', '1:0', '24:0',                                         /* not an octave division */
  '12:6', '12:4:i',                                                    /* row step = column step */
  '12:-6', '6:3:i', '4:2:i', '3:2', '6:-3',                            /* row step outside 1…12 */
  'bass', '', 6, null, undefined,
];
for (const x of NOT_IDS) check(`T ${JSON.stringify(x)} is not a layout id`, isMapping(x), false);

/* A — semitone map */
for (const L of ALL) for (const [q, r] of CELLS) {
  const [Q, R, oct] = toChromatic(q, r, L);
  check(`A ${L} (${q},${r}) closed form`, coordToMidi(q, r, L), 57 + layoutOf(L).c * q + rowStep(L) * r);
  check(`A ${L} (${q},${r}) = sampled chromatic cell + octaves`, coordToMidi(q, r, L), coordToMidi(Q, R, 'chromatic') + 12 * oct);
}

/* B — the existing three against their pre-matrix closed forms */
const C0 = { euler: 4, wickiHayden: 2, chromatic: 1 };
const W0 = (m) => 12 / C0[m];
const oldBand = (q, m) => Math.floor((q + W0(m) / 3) / W0(m));
const oldPos = (q, m) => (((q + W0(m) / 3) % W0(m)) + W0(m)) % W0(m);
const oldPitchBand = (q, m) => oldBand(m === 'chromatic' && q % 2 !== 0 ? q - 5 : q, m);
function oldEuler(q, r, m) {
  if (m === 'euler') return [q, r];
  if (m === 'wickiHayden') { const h = Math.floor(q / 2); return q === 2 * h ? [h, r] : [h - 3, r + 2]; }
  const h = Math.floor(q / 4);
  return [[h, r], [h + 2, r - 1], [h - 3, r + 2], [h - 1, r + 1]][q - 4 * h];
}
const oldFromEuler = (q, r, m) => [(4 / C0[m]) * q, r];
function oldConvert(q, r, from, to) {
  if (from === to) return [q, r];
  const nested = (q * C0[from]) / C0[to];
  if (Number.isInteger(nested)) return [nested, r];
  const [a, b] = oldEuler(q, r, from);
  return oldFromEuler(a, b, to);
}
const OLD_UNBANDED_OCTAVE = { euler: null, wickiHayden: [-1, 2], chromatic: [-2, 2] };
/* the three pre-matrix mappings */
const OLD = ['euler', 'wickiHayden', 'chromatic'];
for (const m of OLD) {
  check(`B ${m} bandWidth`, bandWidth(m), W0(m));
  check(`B ${m} octaveVector banded`, String(octaveVector(m, true)), String([W0(m), 0]));
  check(`B ${m} octaveVector unbanded`, String(octaveVector(m, false)), String(OLD_UNBANDED_OCTAVE[m]));
  for (const [q, r] of CELLS) {
    check(`B ${m} (${q},${r}) bandOfCell`, bandOfCell(q, r, m), oldBand(q, m));
    check(`B ${m} (${q},${r}) posInBandOf`, posInBandOf(q, r, m), oldPos(q, m));
    check(`B ${m} (${q},${r}) pitchBandOf`, pitchBandOf(q, r, m), oldPitchBand(q, m));
    check(`B ${m} (${q},${r}) anchorOf`, anchorOf(q, r, m), oldBand(q, m));
    const e = eulerOf(q, r, m);
    check(`B ${m} (${q},${r}) eulerOf`, `${e.q},${e.r}`, oldEuler(q, r, m).join());
    check(`B ${m} (${q},${r}) coordToMidi`, coordToMidi(q, r, m), 57 + C0[m] * q + 7 * r);
    check(`B ${m} (${q},${r}) fromEuler`, fromEuler(q, r, m).join(), oldFromEuler(q, r, m).join());
    check(`B ${m} (${q},${r}) vecFromEuler`, String(vecFromEuler(q, r, m)), oldFromEuler(q, r, m).join());
    for (const to of OLD) check(`B ${m}→${to} (${q},${r}) convertCell`, convertCell(q, r, m, to).join(), oldConvert(q, r, m, to).join());
  }
}

/* C — the pure line, every JI mode, banded and unbanded */
for (const L of ALL) {
  const [a, b] = pureLine(L), want = layoutOf(L).invert ? P4 : P5;
  for (const banded of [true, false]) for (const anchor of [0, 1]) for (const m of JI) for (const [q, r] of CELLS) {
    const d = sub(coordExps(q + a, r + b, m, L, anchor, banded), coordExps(q, r, m, L, anchor, banded));
    check(`C ${L} ${m} ${banded ? 'banded' : 'unbanded'} a${anchor} (${q},${r}) pure line (${a},${b})`, k(d), want);
  }
}

/* D — the band step */
for (const L of ALL) for (const m of UNIFORM) for (const [q, r] of CELLS) {
  const W = bandWidth(L);
  check(`D ${L} ${m} (${q},${r}) band step (${W},0)`, k(sub(coordExps(q + W, r, m, L, 0, true), coordExps(q, r, m, L, 0, true))), OCT);
}

/* E — seams run along the pure line; position in band stays in range */
for (const L of ALL) {
  const [a, b] = pureLine(L), W = bandWidth(L);
  for (const [q, r] of CELLS) {
    check(`E ${L} (${q},${r}) pure line stays in its band`, bandOfCell(q + a, r + b, L), bandOfCell(q, r, L));
    const p = posInBandOf(q, r, L);
    check(`E ${L} (${q},${r}) position in 0…W−1`, Number.isInteger(p) && p >= 0 && p < W, true);
    check(`E ${L} (${q},${r}) band step changes the band by one`, bandOfCell(q + W, r, L) - bandOfCell(q, r, L), 1);
  }
}

/* F — Euler-equivalents and the fromEuler round trip */
for (const L of ALL) {
  for (const [q, r] of CELLS) {
    const e = eulerOf(q, r, L);
    check(`F ${L} (${q},${r}) MIDI = Euler-equivalent's`, coordToMidi(q, r, L), coordToMidi(e.q, e.r, 'euler'));
    check(`F ${L} (${q},${r}) spelled octave = Euler-equivalent's`, keyOctave(q, r, L, 0, true), keyOctave(e.q, e.r, 'euler', 0, true));
    check(`F ${L} (${q},${r}) name = Euler-equivalent's`, noteName(q, r, L, 0, true), noteName(e.q, e.r, 'euler', 0, true));
    for (const m of UNIFORM) check(`F ${L} ${m} (${q},${r}) pitch = Euler-equivalent's`, k(coordExps(q, r, m, L, 0, true)), k(coordExps(e.q, e.r, m, 'euler', 0, true)));
  }
  for (let a = -8; a <= 8; a++) for (let b = -8; b <= 8; b++) {
    const [q, r] = fromEuler(a, b, L), e = eulerOf(q, r, L);
    check(`F ${L} fromEuler(${a},${b}) round trip`, `${e.q},${e.r}`, `${a},${b}`);
  }
}

/* G — invert vs mirror: inverted (W, k) = plain (W, W−1−k) mirrored, (q, r) ↔ (q + r, −r) */
for (const L of ALL.filter((x) => layoutOf(x).invert)) {
  const { c, s } = layoutOf(L), W = bandWidth(L), kk = -s / c, s2 = -(W - 1 - kk) * c;
  for (const m of UNIFORM) for (const [q, r] of CELLS) {
    const partner = coordExps(c * (q + r) + s2 * -r, -r, m, 'chromatic', 0, true);
    check(`G ${L} ${m} (${q},${r}) = mirrored plain (${W},${W - 1 - kk})`, k(coordExps(q, r, m, L, 0, true)), k(partner));
    check(`G ${L} ${m} (${q},${r}) fifth (${W - kk},−1)`, k(sub(coordExps(q + W - kk, r - 1, m, L, 0, true), coordExps(q, r, m, L, 0, true))), P5);
  }
}

/* H — frame conversion keeps the pitch */
for (const from of ALL) for (const to of ALL) for (let q = -9; q <= 9; q++) for (let r = -5; r <= 5; r++) {
  const [q2, r2] = convertCell(q, r, from, to);
  for (const m of UNIFORM) check(`H ${from}→${to} ${m} (${q},${r})`, k(coordExps(q2, r2, m, to, 0, true)), k(coordExps(q, r, m, from, 0, true)));
}

/* I — octave vectors */
const HAS_UNBANDED_OCTAVE = ['wickiHayden', 'chromatic', 'janko', 'accordion', 'park'];
for (const L of ALL) {
  if (isPresetMapping(L)) check(`I ${L} has an unbanded spelled octave`, octaveVector(L, false) !== null, HAS_UNBANDED_OCTAVE.includes(L));
  for (const banded of [true, false]) {
    const v = octaveVector(L, banded);
    if (!v) continue;
    for (const [q, r] of CELLS) {
      const tag = `I ${L} ${banded ? 'banded' : 'unbanded'} (${q},${r}) octave (${v})`;
      check(`${tag} name`, noteName(q + v[0], r + v[1], L, 0, banded), noteName(q, r, L, 0, banded));
      check(`${tag} spelled octave`, keyOctave(q + v[0], r + v[1], L, 0, banded) - keyOctave(q, r, L, 0, banded), 1);
      check(`${tag} MIDI`, coordToMidi(q + v[0], r + v[1], L) - coordToMidi(q, r, L), 12);
    }
  }
}

/* J — Euler vectors */
const EULER_VECTORS = [[1, 0], [0, 1], [-1, 1], [3, 0], [1, -4], [-1, 4], [2, -1], [0, 2], [-2, 3]];
for (const L of ALL) for (const [dq, dr] of EULER_VECTORS) {
  const v = vecFromEuler(dq, dr, L);
  check(`J ${L} (${dq},${dr}) expressible`, v !== null, bandWidth(L) !== 4 || dq % 3 === 0);
  if (!v) continue;
  for (const [q, r] of CELLS) {
    const e0 = eulerOf(q, r, L), e1 = eulerOf(q + v[0], r + v[1], L);
    check(`J ${L} (${dq},${dr}) via (${v}) from (${q},${r})`, `${e1.q - e0.q},${e1.r - e0.r}`, `${dq},${dr}`);
  }
}

/* K — the reference spine's column exists in every row */
for (const L of ALL) for (let r = -9; r <= 9; r++) {
  let found = false;
  for (let q = -24; q <= 24 && !found; q++) found = ((toChromatic(q, r, L)[0] % 12) + 12) % 12 === 0;
  check(`K ${L} row ${r} holds a qm0 cell`, found, true);
}

/* L — color: the spine rule (Max, 2026-11-09). The Pythagorean spine — the chain of fifths from
   A3, or of fourths in an inverted layout — holds one color per nominal octave, purple in
   octave 3, the cycle running the other way inverted. A pitch 2^a·3^b·5^c stands c major thirds
   (4 semitones each) off spine note b (−b on the fourths spine) and takes the spine's color at
   that octave; 2:1 carries no color. A septimal factor is first replaced by the 5-limit note it
   stands for (×36/35), then turns the hue half a step. Every mode, banded and unbanded, is this
   one rule: no comma terms. Recomputed here from coordExps, not keyColor. */
{
  const mod7 = (x) => ((x % 7) + 7) % 7;
  const spineIdx = (e, inv) => {
    const b = e[1] + 2 * e[3], c = e[2] - e[3];                     /* ×(36/35)^e7 */
    const place = 57 + (inv ? 5 * -b : 7 * b) + 4 * c;              /* nominal MIDI along the spine */
    const oct = Math.floor(place / 12) - 4;
    return (inv ? -oct : oct) - Math.floor(e[3] / 2);
  };
  const idxOf = (q, r, mode, L, a, banded) => hueIdx[keyColor(q, r, mode, L, a, banded).hue];
  for (const L of ALL) {
    const inv = layoutOf(L).invert, W = bandWidth(L), home = inv ? 'randal' : 'euler';
    for (const [q, r] of CELLS) {
      for (const banded of [true, false]) for (const mode of JI) for (const a of [0, 1]) {
        const want = mod7(spineIdx(coordExps(q, r, mode, L, a, banded), inv));
        check(`L ${L} ${mode} ${banded ? 'b' : 'u'} a${a} (${q},${r}) hue`, idxOf(q, r, mode, L, a, banded), want);
      }
      /* unbanded Ptolemaic on a 3-wide layout is (5/4)^q along every row: one stripe per
         nominal MIDI octave, mirrored when inverted */
      if (W === 3) {
        const o = Math.floor(coordToMidi(q, r, L) / 12) - 4;
        check(`L ${L} (${q},${r}) unbanded Ptolemaic octave stripe`, idxOf(q, r, '5', L, 0, false), mod7(inv ? -o : o));
      }
      /* a pitch keeps its color across one orientation: every cell takes Euler's (plain) or
         Randal's (inverted) color at its Euler-equivalent — a copy column its source's */
      const e = eulerOf(q, r, L), [hq, hr] = fromEuler(e.q, e.r, home);
      for (const mode of UNIFORM) check(`L ${L} ${mode} (${q},${r}) colored as ${home} (${hq},${hr})`, idxOf(q, r, mode, L, 0, true), idxOf(hq, hr, mode, home, 0, true));
      /* the octave blocks: Euler-family bands read ±(MIDI octave − band), mirrored when inverted */
      if (W === 3) {
        const ob = Math.floor(coordToMidi(q, r, L) / 12) - bandOfCell(q, r, L) - 4;
        check(`L ${L} (${q},${r}) Ptolemaic block`, idxOf(q, r, '5', L, 0, true), mod7(inv ? -ob : ob));
      }
      /* a band step keeps the hue (banded, uniform modes) */
      for (const mode of UNIFORM) check(`L ${L} ${mode} (${q},${r}) band step keeps the hue`, idxOf(q + W, r, mode, L, 0, true), idxOf(q, r, mode, L, 0, true));
      /* Equal stays its octave cycle */
      check(`L ${L} E (${q},${r})`, keyColor(q, r, 'E', L, 0, true).hue, equalHueCycle[((Math.floor(coordToMidi(q, r, L) / 12) % 3) + 3) % 3]);
    }
  }
}

/* S — the score frame (docs/architecture/hkl.md → `.hkr` → `.hkc` transcription): a score's mapping
   is a preset, so HKL's Export to Composer re-expresses a recording in the finest preset of its
   layout's orientation, Chromatic (plain) or Park (inverted), with the home band carried over as
   the band its first row-0 cell converts into (transcription/index.ts, anchorIn). The pitch is
   kept exactly, in every JI mode, banded and unbanded, from every plain layout and from an
   inverted one of division 3 or 6; from an inverted division 4 or 12 only banded, in the
   band-uniform modes (their exact frame would be an inverted Chromatic, which is no preset). */
for (const L of ALL) {
  const { division, invert } = specOf(L);
  const to = invert ? 'park' : 'chromatic';
  const everywhere = !invert || division === 3 || division === 6;
  let midiKept = true;
  for (const [q, r] of CELLS) {
    const [q2, r2] = convertCell(q, r, L, to);
    if (coordToMidi(q, r, L) !== coordToMidi(q2, r2, to)) midiKept = false;
  }
  check(`S ${L} → ${to} keeps the nominal MIDI`, midiKept, true);
  for (const banded of [true, false]) {
    for (const mode of (everywhere ? JI : banded ? UNIFORM : [])) {
      for (const anchor of [0, 1, -2]) {
        let q0 = (anchor - 1) * bandWidth(L);
        while (bandOfCell(q0, 0, L) < anchor) q0++;
        const anchor2 = bandOfCell(...convertCell(q0, 0, L, to), to);
        for (const [q, r] of CELLS) {
          const [q2, r2] = convertCell(q, r, L, to);
          check(`S ${L} → ${to} ${mode} ${banded ? 'banded' : 'unbanded'} anchor ${anchor} (${q},${r})`,
            k(coordExps(q2, r2, mode, to, anchor2, banded)), k(coordExps(q, r, mode, L, anchor, banded)));
        }
      }
    }
  }
}

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
