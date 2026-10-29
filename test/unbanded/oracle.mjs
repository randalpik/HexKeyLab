// Unbanded layout oracle (docs/architecture.md → Tuning system → Unbanded layout).
//
// Pure Node gate — no dev server, no browser. Imports the REAL modules
// (@hkl/shared primitives, HKL's hejiLabel) through the repo's TS loader and
// checks every rule of the unbanded layout (Banded layout off) against them,
// over all three mappings and anchors −2…2:
//   A  Euler column steps per mode, from a band's first column: P 81:64 ×3,
//      V 81:64 5:4 81:64, 7 9:7 5:4 5:4, D 81:64 5:4 5:4, 5 5:4 ×3; S = Y = P;
//      the 3-column step in cents
//   B  Syntonic and Polysyntonic unbanded = Pythagorean unbanded, every cell;
//      Equal's JI reading is Ptolemaic's, banded and unbanded
//   C  the anchor's pitch band is the banded layout (spelling and pitch);
//      Schismatic is its banded tuning × schisma^−anchor, whole board
//   D  re-anchoring by +1: the whole board drops one per-band comma and
//      respells 12 fifths flat; Equal's pitch never moves
//   E  spelling: a band step is +12 fifths in every mapping; the spelled
//      letter, octave and accidental reproduce the nominal MIDI; Euler and
//      Wicki-Hayden spell every (note, octave) once
//   F  Wicki-Hayden Pythagorean: isomorphic and unimodular (each 3-limit pitch
//      on one key); (−1, 2) is a spelled, exact octave
//   G  chromatic Pythagorean (carry): even-Δq vectors single-valued, odd-Δq
//      two values a Pythagorean comma apart; (−2, 2) a spelled, exact octave;
//      (5, 1) exact from even columns, + PC from odd ones
//   H  Pythagorean unbanded = Polysyntonic × schisma^(pitch band − anchor)
//   I  Septimal: a closed 4:5:6:7 from every root right of a 9:7 step, one
//      shape per column class (Euler; chromatic q mod 4)
//   J  HEJI per band, against Pythagorean unbanded: (arrows, hooks)
//      5 (3, 0) · D (2, 0) · 7 (2, −1) · V (1, 0) · P S Y (0, 0)
//   K  color: Pythagorean hues unchanged; every septimal factor is a further
//      half-step warm (odd e7 → half-step variant); both signs exercised
//   L  hook glyphs: hejiChain stacks single + two-hook glyphs; hejiLabel
//      collapses to one hook + exponent above 2
//   M  no Euler vector is a spelled octave from every cell
//   N  octaveVector: the band step banded; F, G and M's vectors unbanded
//
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/unbanded/oracle.mjs
//
// Exits non-zero on any failure.

import { coordExps, coordToMidi, freqAt, TUNING_MODES } from '../../packages/shared/src/freq.ts';
import { noteName, keyOctave, fifthName, parseNote, accToVal } from '../../packages/shared/src/notes.ts';
import { bandOfCell, pitchBandOf, bandWidth, octaveVector, MAPPINGS } from '../../packages/shared/src/mapping.ts';
import { keyColor } from '../../packages/shared/src/keycolor.ts';
import { hueCycleOrder } from '../../packages/shared/src/colors.ts';
import { hejiCommasFor, hejiChain, SEPT_DOWN_1, SEPT_UP_1, SEPT_DOWN_2, SEPT_UP_2 } from '../../packages/shared/src/heji.ts';
import { hejiLabel } from '../../apps/hkl/src/tuning/heji.ts';

const JI = ['5', 'P', 'D', '7', 'V', 'S', 'Y'];
const ANCHORS = [-2, -1, 0, 1, 2];
const PR = [2, 3, 5, 7];
const OCT = [1, 0, 0, 0], PC = [-19, 12, 0, 0], SCHISMA = [-15, 8, 1, 0], SC = [-4, 4, -1, 0];
const COMMA = {
  P: PC, S: PC, Y: PC, 5: [-7, 0, 3, 0], D: [-11, 4, 2, 0], 7: [-5, 2, 2, -1], V: SCHISMA,
};
const md = (a, b) => ((a % b) + b) % b;

let pass = 0, fail = 0;
const failures = [];
function check(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  if (failures.length < 25) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const sub = (a, b) => a.map((x, i) => x - b[i]);
const add = (a, b, k = 1) => a.map((x, i) => x + k * b[i]);
const same = (a, b) => a.every((x, i) => x === b[i]);
function ratio(e) {
  let n = 1n, d = 1n;
  e.forEach((x, i) => { const p = BigInt(PR[i]); if (x > 0) n *= p ** BigInt(x); else if (x < 0) d *= p ** BigInt(-x); });
  return `${n}/${d}`;
}
const cents = (e) => 1200 * (e[0] + e[1] * Math.log2(3) + e[2] * Math.log2(5) + e[3] * Math.log2(7));
const fifthIndex = (name) => { const p = parseNote(name); return 'FCGDAEB'.indexOf(p.letter) - 4 + 7 * accToVal(p.acc); };
const NAT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function* cells(mapping) {
  const W = bandWidth(mapping);
  for (let q = -3 * W; q < 3 * W; q++) for (let r = -6; r <= 6; r++) yield [q, r];
}
const U = (q, r, m, map, a) => coordExps(q, r, m, map, a, false);
const B = (q, r, m, map, a) => coordExps(q, r, m, map, a, true);

/* ── A: Euler column steps ───────────────────────────────────────────────── */
const STEPS = {
  P: ['81/64', '81/64', '81/64'], V: ['81/64', '5/4', '81/64'], 7: ['9/7', '5/4', '5/4'],
  D: ['81/64', '5/4', '5/4'], 5: ['5/4', '5/4', '5/4'], S: ['81/64', '81/64', '81/64'], Y: ['81/64', '81/64', '81/64'],
};
const BAND_CENTS = { P: '1223.46', V: '1201.95', 7: '1207.71', D: '1180.45', 5: '1158.94', S: '1223.46', Y: '1223.46' };
for (const m of JI) for (const a of ANCHORS) for (let k = -3; k <= 3; k++) for (let r = -4; r <= 4; r++) {
  const q0 = 3 * k - 1; /* a band's first column (position 0) */
  for (let i = 0; i < 3; i++) {
    check(`A ${m} a${a} (${q0 + i},${r}) step ${i}`, ratio(sub(U(q0 + i + 1, r, m, 'euler', a), U(q0 + i, r, m, 'euler', a))), STEPS[m][i]);
  }
  check(`A ${m} a${a} (${q0},${r}) band step`, cents(sub(U(q0 + 3, r, m, 'euler', a), U(q0, r, m, 'euler', a))).toFixed(2), BAND_CENTS[m]);
}

/* ── B: S = Y = P ─────────────────────────────────────────────────────────── */
for (const map of MAPPINGS) for (const a of ANCHORS) for (const [q, r] of cells(map)) {
  const p = U(q, r, 'P', map, a).join();
  check(`B S ${map} a${a} (${q},${r})`, U(q, r, 'S', map, a).join(), p);
  check(`B Y ${map} a${a} (${q},${r})`, U(q, r, 'Y', map, a).join(), p);
  /* Equal's JI reading (ratios, the piano picker) is Ptolemaic's in both layouts */
  check(`B E reads as 5 ${map} a${a} (${q},${r})`, U(q, r, 'E', map, a).join(), U(q, r, '5', map, a).join());
  check(`B E reads as 5 banded ${map} (${q},${r})`, B(q, r, 'E', map, a).join(), B(q, r, '5', map, a).join());
}

/* ── C: the anchor's band is banded; V is banded × schisma^−anchor ──────── */
for (const map of MAPPINGS) for (const a of ANCHORS) for (const [q, r] of cells(map)) {
  if (pitchBandOf(q, map) === a) {
    check(`C name ${map} a${a} (${q},${r})`, noteName(q, r, map, a, false), noteName(q, r, map, a, true));
    check(`C octave ${map} a${a} (${q},${r})`, keyOctave(q, r, map, a, false), keyOctave(q, r, map, a, true));
    for (const m of ['5', 'P', 'D', '7', 'S', 'Y']) {
      check(`C ${m} ${map} a${a} (${q},${r})`, U(q, r, m, map, a).join(), B(q, r, m, map, a).join());
    }
  }
  check(`C V ${map} a${a} (${q},${r})`, U(q, r, 'V', map, a).join(), add(B(q, r, 'V', map, a), SCHISMA, -a).join());
}

/* ── D: re-anchoring ─────────────────────────────────────────────────────── */
for (const map of MAPPINGS) for (const a of ANCHORS) for (const [q, r] of cells(map)) {
  check(`D respell ${map} a${a} (${q},${r})`,
    fifthIndex(noteName(q, r, map, a + 1, false)) - fifthIndex(noteName(q, r, map, a, false)), -12);
  for (const m of JI) {
    check(`D ${m} ${map} a${a} (${q},${r})`, U(q, r, m, map, a + 1).join(), sub(U(q, r, m, map, a), COMMA[m]).join());
  }
  check(`D E ${map} a${a} (${q},${r})`, freqAt(q, r, 'E', map, a, false), freqAt(q, r, 'E', map, a, true));
}

/* ── E: spelling ─────────────────────────────────────────────────────────── */
for (const map of MAPPINGS) {
  const W = bandWidth(map);
  for (const a of ANCHORS) {
    const seen = new Map();
    for (const [q, r] of cells(map)) {
      check(`E band step ${map} a${a} (${q},${r})`,
        fifthIndex(noteName(q + W, r, map, a, false)) - fifthIndex(noteName(q, r, map, a, false)), 12);
      for (const banded of [true, false]) {
        const n = parseNote(noteName(q, r, map, a, banded));
        const midi = 12 * (keyOctave(q, r, map, a, banded) + 1) + NAT[n.letter] + accToVal(n.acc);
        check(`E nominal ${map} a${a} ${banded ? 'b' : 'u'} (${q},${r})`, midi, coordToMidi(q, r, map));
      }
      const id = noteName(q, r, map, a, false) + keyOctave(q, r, map, a, false);
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    const dups = [...seen.values()].filter((n) => n > 1).length;
    if (map === 'chromatic') check(`E chromatic a${a} has spelled twins`, dups > 0, true);
    else check(`E ${map} a${a} each spelled note once`, dups, 0);
  }
}

/* ── F: Wicki-Hayden Pythagorean ─────────────────────────────────────────── */
{
  const WH = 'wickiHayden';
  for (const a of ANCHORS) {
    const vecs = new Map();
    for (const [q, r] of cells(WH)) {
      for (const [dq, dr] of [[1, 0], [0, 1], [-1, 2]]) {
        const k = `${dq},${dr}`;
        if (!vecs.has(k)) vecs.set(k, new Set());
        vecs.get(k).add(sub(U(q + dq, r + dr, 'P', WH, a), U(q, r, 'P', WH, a)).join());
      }
      check(`F (−1,2) spelled P8 a${a} (${q},${r})`,
        noteName(q - 1, r + 2, WH, a, false) + (keyOctave(q - 1, r + 2, WH, a, false) - 1), noteName(q, r, WH, a, false) + keyOctave(q, r, WH, a, false));
    }
    for (const [k, s] of vecs) check(`F (${k}) single-valued a${a}`, s.size, 1);
    check(`F (−1,2) = 2/1 a${a}`, [...vecs.get('-1,2')][0], OCT.join());
    const u = [...vecs.get('1,0')][0].split(',').map(Number), v = [...vecs.get('0,1')][0].split(',').map(Number);
    check(`F unimodular a${a}`, Math.abs(u[0] * v[1] - u[1] * v[0]), 1);
  }
}

/* ── G: chromatic Pythagorean (carry) ────────────────────────────────────── */
{
  const CH = 'chromatic';
  for (const a of [-1, 0, 1]) {
    for (let dq = -12; dq <= 12; dq++) for (let dr = -3; dr <= 3; dr++) {
      const s = new Set();
      for (let q = -48; q < 48; q++) for (let r = -4; r <= 4; r++) s.add(sub(U(q + dq, r + dr, 'P', CH, a), U(q, r, 'P', CH, a)).join());
      if (md(dq, 2) === 0) { check(`G (${dq},${dr}) single-valued a${a}`, s.size, 1); continue; }
      const [x, y] = [...s].map((t) => t.split(',').map(Number));
      check(`G (${dq},${dr}) two values a${a}`, s.size, 2);
      if (y) check(`G (${dq},${dr}) differ by PC a${a}`, same(sub(x, y), PC) || same(sub(y, x), PC), true);
    }
    for (let q = -48; q < 48; q++) for (let r = -4; r <= 4; r++) {
      check(`G (−2,2) = 2/1 a${a} (${q},${r})`, sub(U(q - 2, r + 2, 'P', CH, a), U(q, r, 'P', CH, a)).join(), OCT.join());
      check(`G (−2,2) spelled P8 a${a} (${q},${r})`,
        noteName(q - 2, r + 2, CH, a, false) + (keyOctave(q - 2, r + 2, CH, a, false) - 1), noteName(q, r, CH, a, false) + keyOctave(q, r, CH, a, false));
      check(`G (5,1) a${a} (${q},${r})`, sub(U(q + 5, r + 1, 'P', CH, a), U(q, r, 'P', CH, a)).join(),
        (md(q, 2) === 0 ? OCT : add(OCT, PC)).join());
    }
  }
}

/* ── H: P unbanded = Y banded × schisma^(pitch band − anchor) ────────────── */
for (const map of MAPPINGS) for (const a of ANCHORS) for (const [q, r] of cells(map)) {
  check(`H ${map} a${a} (${q},${r})`, U(q, r, 'P', map, a).join(), add(B(q, r, 'Y', map, a), SCHISMA, pitchBandOf(q, map) - a).join());
}

/* ── I: Septimal 4:5:6:7 ─────────────────────────────────────────────────── */
/* One shape per column class (Euler: every column; chromatic: q mod 4, whose
   odd-Δq vectors differ by class), taken from the class's first root. */
for (const map of ['euler', 'chromatic']) {
  const col = map === 'euler' ? 1 : 4; /* the Euler (1, 0) step */
  for (const a of [-1, 0, 1]) {
    const pitch = (q, r) => U(q, r, '7', map, a);
    const shapeAt = (q0, r0) => {
      const shape = {};
      for (const [name, iv] of [['5/4', [-2, 0, 1, 0]], ['3/2', [-1, 1, 0, 0]], ['7/4', [-2, 0, 0, 1]]]) {
        let best = null;
        for (let dq = -3 * col; dq <= 3 * col; dq++) for (let dr = -4; dr <= 4; dr++) {
          if (!same(sub(pitch(q0 + dq, r0 + dr), pitch(q0, r0)), iv)) continue;
          const taxi = Math.abs(dq) + Math.abs(dr);
          if (!best || taxi < best.taxi) best = { dq, dr, taxi };
        }
        shape[name] = best;
      }
      return shape;
    };
    check(`I ${map} a${a} A3 right of a 9:7`, ratio(sub(pitch(0, 0), pitch(-col, 0))), '9/7');
    const shapes = new Map();
    let roots = 0, closed = 0;
    for (const [q, r] of cells(map)) {
      if (ratio(sub(pitch(q, r), pitch(q - col, r))) !== '9/7') continue;
      roots++;
      const cls = md(q, col);
      if (!shapes.has(cls)) shapes.set(cls, shapeAt(q, r));
      const ok = Object.entries(shapes.get(cls)).every(([name, s]) => s && ratio(sub(pitch(q + s.dq, r + s.dr), pitch(q, r))) === name);
      if (ok) closed++;
    }
    check(`I ${map} a${a} roots found`, roots > 0, true);
    check(`I ${map} a${a} column classes with roots`, shapes.size, col);
    check(`I ${map} a${a} 4:5:6:7 from every root`, closed, roots);
  }
}

/* ── J: HEJI per band ────────────────────────────────────────────────────── */
const PER_BAND = { 5: '3,0', D: '2,0', 7: '2,-1', V: '1,0', P: '0,0', S: '0,0', Y: '0,0' };
for (const map of MAPPINGS) {
  const W = bandWidth(map);
  for (const a of ANCHORS) for (const m of JI) {
    const d = new Set();
    for (const [q, r] of cells(map)) {
      const h0 = hejiCommasFor(m, q, r, map, a, false), h1 = hejiCommasFor(m, q + W, r, map, a, false);
      d.add(`${h1.syn5 - h0.syn5},${h1.sept7 - h0.sept7}`);
    }
    check(`J ${m} ${map} a${a}`, [...d].join(' '), PER_BAND[m]);
  }
  for (const a of ANCHORS) for (const [q, r] of cells(map)) {
    if (pitchBandOf(q, map) !== a) continue;
    for (const m of ['5', 'P', 'D', '7', 'S', 'Y']) {
      check(`J home ${m} ${map} a${a} (${q},${r})`, JSON.stringify(hejiCommasFor(m, q, r, map, a, false)), JSON.stringify(hejiCommasFor(m, q, r, map, a, true)));
    }
  }
}

/* ── K: color ────────────────────────────────────────────────────────────── */
{
  let neg = 0, multi = 0;
  for (const map of MAPPINGS) for (const a of ANCHORS) for (const [q, r] of cells(map)) {
    check(`K P hue ${map} a${a} (${q},${r})`, keyColor(q, r, 'P', map, a, false).hue, keyColor(q, r, 'P', map, a, true).hue);
    for (const banded of [true, false]) {
      const e = coordExps(q, r, '7', map, a, banded);
      /* position in half-steps along hueCycleOrder (which walks warm → −1):
         the comma formula's hue, then e7 half-steps warm */
      const pos = 2 * (Math.floor((57 + 7 * e[1] + 4 * e[2] + 10 * e[3]) / 12) - 4) - e[3];
      const c = keyColor(q, r, '7', map, a, banded);
      check(`K 7 ${map} a${a} ${banded ? 'b' : 'u'} (${q},${r})`,
        `${c.hue} ${c.half} ${c.isSept}`, `${hueCycleOrder[md(Math.ceil(pos / 2), 7)]} ${md(pos, 2) === 1} ${e[3] !== 0}`);
      if (banded) check(`K banded e7 ∈ {0,1} ${map} (${q},${r})`, e[3] === 0 || e[3] === 1, true);
      else { if (e[3] < 0) neg++; if (Math.abs(e[3]) >= 2) multi++; }
    }
  }
  check('K unbanded reaches e7 < 0', neg > 0, true);
  check('K unbanded reaches |e7| ≥ 2', multi > 0, true);
}

/* ── L: hook glyphs ──────────────────────────────────────────────────────── */
{
  const codes = (sept7) => hejiChain(0, 0, sept7).map((g) => g.ch.codePointAt(0));
  check('L chain +1', codes(1).join(), [SEPT_DOWN_1].join());
  check('L chain +2', codes(2).join(), [SEPT_DOWN_2].join());
  check('L chain +3', codes(3).join(), [SEPT_DOWN_1, SEPT_DOWN_2].join());
  check('L chain −4', codes(-4).join(), [SEPT_UP_2, SEPT_UP_2].join());
  check('L chain −5', codes(-5).join(), [SEPT_UP_1, SEPT_UP_2, SEPT_UP_2].join());
  const lab = (sept7) => hejiLabel('C', { syn5: 0, sept7 });
  check('L label 2: two-hook glyph, no exponent', `${lab(2).glyphs.map((g) => g.ch.codePointAt(0)).join()} ${lab(2).hookCount}`, `${SEPT_DOWN_2} undefined`);
  check('L label −3: one hook + exponent', `${lab(-3).glyphs.map((g) => g.ch.codePointAt(0)).join()} ${lab(-3).hookCount}`, `${SEPT_UP_1} 3`);
  check('L label 7: one hook + exponent', `${lab(7).glyphs.map((g) => g.ch.codePointAt(0)).join()} ${lab(7).hookCount}`, `${SEPT_DOWN_1} 7`);
}

/* ── M: Euler has no spelled octave vector ───────────────────────────────── */
for (const a of [-1, 0, 1]) {
  let found = [];
  for (let dq = -9; dq <= 9; dq++) for (let dr = -12; dr <= 12; dr++) {
    let all = true;
    for (const [q, r] of cells('euler')) {
      const n0 = noteName(q, r, 'euler', a, false), o0 = keyOctave(q, r, 'euler', a, false);
      if (noteName(q + dq, r + dr, 'euler', a, false) !== n0 || keyOctave(q + dq, r + dr, 'euler', a, false) !== o0 + 1) { all = false; break; }
    }
    if (all) found.push(`${dq},${dr}`);
  }
  check(`M euler a${a} spelled-octave vectors`, found.join(' '), '');
}

/* ── N: octaveVector is the spelled-octave vector F, G and M found ─────── */
for (const map of MAPPINGS) for (const banded of [true, false]) for (const a of [-1, 0, 1]) {
  const v = octaveVector(map, banded);
  check(`N ${map} ${banded ? 'b' : 'u'} octaveVector`, v === null ? 'none' : v.join(), banded ? `${bandWidth(map)},0` : { euler: 'none', wickiHayden: '-1,2', chromatic: '-2,2' }[map]);
  if (v === null) continue;
  for (const [q, r] of cells(map)) {
    check(`N ${map} ${banded ? 'b' : 'u'} a${a} (${q},${r}) spelled P8`,
      noteName(q + v[0], r + v[1], map, a, banded) + (keyOctave(q + v[0], r + v[1], map, a, banded) - 1), noteName(q, r, map, a, banded) + keyOctave(q, r, map, a, banded));
  }
}

check('modes covered', JI.length + 1, TUNING_MODES.length);
console.log(`${pass}/${pass + fail} checks passed`);
if (failures.length) {
  console.log('\nFailures (first 25):');
  for (const f of failures) console.log('  ' + f);
}
process.exit(fail ? 1 : 0);
