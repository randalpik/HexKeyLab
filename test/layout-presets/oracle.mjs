// Layout-presets oracle (docs/architecture.md → Note-name mapping → The layout matrix).
//
// Pure Node gate — no dev server, no browser. Imports the REAL @hkl/shared modules through the
// repo's TS loader and checks the matrix model on every layout in MAPPINGS:
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
//      exists in every preset (null only for a 4-wide band, c = 3: an M3 count not a multiple of 3)
//   K  the reference spine: every row holds a cell on its band's qm0 column (chromatic Q ≡ 0
//      mod 12)
//   L  color: one function of the pitch in plain layouts; an inverted layout mirrors the
//      banded-Ptolemaic base (−(base − b3)) and keeps every other term; a pitch keeps its color
//      across layouts of one orientation (Euler's plain, Randal's inverted, copy columns
//      included); 3-wide bands read ±(MIDI octave − band); a band step keeps the hue; Equal
//      stays its octave cycle
// Run: node --import ./test/orchestrator-smoke/register-ts.mjs test/layout-presets/oracle.mjs

import {
  LAYOUT, MAPPINGS, MAPPING_LABELS, toChromatic, eulerOf, fromEuler, bandOfCell, posInBandOf,
  pitchBandOf, bandWidth, octaveVector, vecFromEuler, convertCell,
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
const rowStep = (L) => LAYOUT[L].s + (LAYOUT[L].invert ? 5 : 7);
const pureLine = (L) => [-LAYOUT[L].s / LAYOUT[L].c, 1];

/* The table itself */
check('MAPPINGS (dropdown order)', MAPPINGS.join(), 'euler,wickiHayden,chromatic,gerhard,janko,accordion,randal,park');
const SPEC = {
  euler: [4, 0, false], wickiHayden: [2, 0, false], chromatic: [1, 0, false], janko: [2, -6, false],
  accordion: [2, -2, true], gerhard: [4, -4, false], randal: [4, 0, true], park: [2, 0, true],
};
for (const L of MAPPINGS) {
  check(`table ${L}`, [LAYOUT[L].c, LAYOUT[L].s, LAYOUT[L].invert].join(), SPEC[L].join());
  check(`label ${L}`, typeof MAPPING_LABELS[L], 'string');
  check(`${L} c | s`, LAYOUT[L].s % LAYOUT[L].c, 0);
  check(`${L} row step ascends within an octave`, rowStep(L) >= 1 && rowStep(L) <= 12, true);
}

/* A — semitone map */
for (const L of MAPPINGS) for (const [q, r] of CELLS) {
  const [Q, R, oct] = toChromatic(q, r, L);
  check(`A ${L} (${q},${r}) closed form`, coordToMidi(q, r, L), 57 + LAYOUT[L].c * q + rowStep(L) * r);
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
for (const L of MAPPINGS) {
  const [a, b] = pureLine(L), want = LAYOUT[L].invert ? P4 : P5;
  for (const banded of [true, false]) for (const anchor of [0, 1]) for (const m of JI) for (const [q, r] of CELLS) {
    const d = sub(coordExps(q + a, r + b, m, L, anchor, banded), coordExps(q, r, m, L, anchor, banded));
    check(`C ${L} ${m} ${banded ? 'banded' : 'unbanded'} a${anchor} (${q},${r}) pure line (${a},${b})`, k(d), want);
  }
}

/* D — the band step */
for (const L of MAPPINGS) for (const m of UNIFORM) for (const [q, r] of CELLS) {
  const W = bandWidth(L);
  check(`D ${L} ${m} (${q},${r}) band step (${W},0)`, k(sub(coordExps(q + W, r, m, L, 0, true), coordExps(q, r, m, L, 0, true))), OCT);
}

/* E — seams run along the pure line; position in band stays in range */
for (const L of MAPPINGS) {
  const [a, b] = pureLine(L), W = bandWidth(L);
  for (const [q, r] of CELLS) {
    check(`E ${L} (${q},${r}) pure line stays in its band`, bandOfCell(q + a, r + b, L), bandOfCell(q, r, L));
    const p = posInBandOf(q, r, L);
    check(`E ${L} (${q},${r}) position in 0…W−1`, Number.isInteger(p) && p >= 0 && p < W, true);
    check(`E ${L} (${q},${r}) band step changes the band by one`, bandOfCell(q + W, r, L) - bandOfCell(q, r, L), 1);
  }
}

/* F — Euler-equivalents and the fromEuler round trip */
for (const L of MAPPINGS) {
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
for (const L of MAPPINGS.filter((x) => LAYOUT[x].invert)) {
  const { c, s } = LAYOUT[L], W = bandWidth(L), kk = -s / c, s2 = -(W - 1 - kk) * c;
  for (const m of UNIFORM) for (const [q, r] of CELLS) {
    const partner = coordExps(c * (q + r) + s2 * -r, -r, m, 'chromatic', 0, true);
    check(`G ${L} ${m} (${q},${r}) = mirrored plain (${W},${W - 1 - kk})`, k(coordExps(q, r, m, L, 0, true)), k(partner));
    check(`G ${L} ${m} (${q},${r}) fifth (${W - kk},−1)`, k(sub(coordExps(q + W - kk, r - 1, m, L, 0, true), coordExps(q, r, m, L, 0, true))), P5);
  }
}

/* H — frame conversion keeps the pitch */
for (const from of MAPPINGS) for (const to of MAPPINGS) for (let q = -9; q <= 9; q++) for (let r = -5; r <= 5; r++) {
  const [q2, r2] = convertCell(q, r, from, to);
  for (const m of UNIFORM) check(`H ${from}→${to} ${m} (${q},${r})`, k(coordExps(q2, r2, m, to, 0, true)), k(coordExps(q, r, m, from, 0, true)));
}

/* I — octave vectors */
const HAS_UNBANDED_OCTAVE = ['wickiHayden', 'chromatic', 'janko', 'accordion', 'park'];
for (const L of MAPPINGS) {
  check(`I ${L} has an unbanded spelled octave`, octaveVector(L, false) !== null, HAS_UNBANDED_OCTAVE.includes(L));
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
for (const L of MAPPINGS) for (const [dq, dr] of EULER_VECTORS) {
  const v = vecFromEuler(dq, dr, L);
  check(`J ${L} (${dq},${dr}) expressible`, v !== null, true);
  if (!v) continue;
  for (const [q, r] of CELLS) {
    const e0 = eulerOf(q, r, L), e1 = eulerOf(q + v[0], r + v[1], L);
    check(`J ${L} (${dq},${dr}) via (${v}) from (${q},${r})`, `${e1.q - e0.q},${e1.r - e0.r}`, `${dq},${dr}`);
  }
}

/* K — the reference spine's column exists in every row */
for (const L of MAPPINGS) for (let r = -9; r <= 9; r++) {
  let found = false;
  for (let q = -24; q <= 24 && !found; q++) found = ((toChromatic(q, r, L)[0] % 12) + 12) % 12 === 0;
  check(`K ${L} row ${r} holds a qm0 cell`, found, true);
}

/* L — color. The hue index from a cell's exponents (keycolor.ts) is one function of the pitch
   in a plain layout; an inverted layout replaces its banded-Ptolemaic base with −(base − b3),
   b3 the base's fifths (−r on an original column), and keeps every other term (Max,
   2026-10-30; 2026-11-01). Recomputed here from coordExps, not keyColor. */
{
  const mod7 = (x) => ((x % 7) + 7) % 7;
  const pitchIdx = (e) => Math.floor((57 + 7 * e[1] + 4 * e[2] + 10 * e[3]) / 12) - 4 - Math.floor(e[3] / 2);
  const idxOf = (q, r, mode, L, a, banded) => hueIdx[keyColor(q, r, mode, L, a, banded).hue];
  for (const L of MAPPINGS) {
    const inv = LAYOUT[L].invert, W = bandWidth(L), home = inv ? 'randal' : 'euler';
    for (const [q, r] of CELLS) {
      const be = coordExps(q, r, '5', L, 0, true), base = pitchIdx(be);
      for (const banded of [true, false]) for (const mode of JI) for (const a of [0, 1]) {
        const p = pitchIdx(coordExps(q, r, mode, L, a, banded));
        const want = inv ? mod7(p - base - (base - be[1])) : mod7(p);
        check(`L ${L} ${mode} ${banded ? 'b' : 'u'} a${a} (${q},${r}) hue`, idxOf(q, r, mode, L, a, banded), want);
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

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
