// Wicki-Hayden mapping oracle (docs/architecture.md → Note-name mapping, incl. its interval table).
//
// Pure Node gate — no dev server, no browser. Imports the REAL modules
// (@hkl/shared primitives, HKL's render/colors.ts) through the repo's TS loader
// and checks every rule the spec states against them:
//   A  interval invariants per JI mode, on every cell of a wide window:
//        original → copy (+1, 0) = 9/8 · original → copy (+1, −2) = 1/2 ·
//        copy → next original (+1, 0) = the mode's q-step ÷ 9/8 ·
//        band (+6, 0) = the mode's band octave (2/1; Schismatic 2/1·schisma)
//   B  interval table: the row and the major-scale shape from the reference, per mode
//   C  spelling: a copy spells as its column cell, in its own octave
//   D  color: JI modes give a copy its column's color; Equal colors every
//      cell by its sounding octave; light/dark follows the cell's own pitch class
//   E  frame conversion: Euler → Wicki-Hayden exact; Wicki-Hayden → Euler
//      pitch-exact except Schismatic copies, which land exactly one schisma low
//   F  the 280 Lumatone keys are 280 distinct cells under Wicki-Hayden
//
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/wh-layout/oracle.mjs
//
// Exits non-zero on any failure.

import { readFileSync } from 'node:fs';
import { coordExps, coordToMidi, freqAt, TUNING_MODES } from '../../packages/shared/src/freq.ts';
import { noteName, keyOctave } from '../../packages/shared/src/notes.ts';
import { eulerOf, convertCell } from '../../packages/shared/src/mapping.ts';
import { tuning } from '../../apps/hkl/src/state/tuning.ts';
import { keyColorVariant } from '../../apps/hkl/src/render/colors.ts';
import { refSpine } from '../../apps/hkl/src/tuning/refspine.ts';

const JI = ['5', 'P', 'D', '7', 'V'];
const PR = [2, 3, 5, 7];
const WH = 'wickiHayden';
const fd = (x) => Math.floor(x / 2);

let pass = 0, fail = 0;
const failures = [];
function check(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  if (failures.length < 25) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const sub = (a, b) => a.map((x, i) => x - b[i]);
const add = (a, b) => a.map((x, i) => x + b[i]);
const same = (a, b) => a.every((x, i) => x === b[i]);
function ratio(e) {
  let n = 1n, d = 1n;
  e.forEach((x, i) => { const p = BigInt(PR[i]); if (x > 0) n *= p ** BigInt(x); else if (x < 0) d *= p ** BigInt(-x); });
  return `${n}/${d}`;
}
const iv = (A, B, m) => ratio(sub(coordExps(B[0], B[1], m, WH, 0, true), coordExps(A[0], A[1], m, WH, 0, true)));
const NINE_EIGHTHS = [-3, 2, 0, 0], HALF = [-1, 0, 0, 0], OCT = [1, 0, 0, 0], SCHISMA = [-15, 8, 1, 0];

/* ── A: interval invariants ─────────────────────────────────────────────────────── */
for (const m of JI) {
  for (let k = -20; k <= 20; k++) {
    for (let R = -12; R <= 12; R++) {
      const Q = 2 * k;                                   /* original column */
      const eO = coordExps(Q, R, m, WH, 0, true);
      check(`A ${m} (${Q},${R}) +1,0 = 9/8`, same(sub(coordExps(Q + 1, R, m, WH, 0, true), eO), NINE_EIGHTHS), true);
      check(`A ${m} (${Q},${R}) +1,-2 = 1/2`, same(sub(coordExps(Q + 1, R - 2, m, WH, 0, true), eO), HALF), true);
      const qStep = sub(coordExps(k + 1, R, m, 'euler', 0, true), coordExps(k, R, m, 'euler', 0, true));
      check(`A ${m} (${Q + 1},${R}) copy→next = q-step ÷ 9/8`,
        same(sub(coordExps(Q + 2, R, m, WH, 0, true), coordExps(Q + 1, R, m, WH, 0, true)), sub(qStep, NINE_EIGHTHS)), true);
      for (const Qc of [Q, Q + 1]) {
        const band = sub(coordExps(Qc + 6, R, m, WH, 0, true), coordExps(Qc, R, m, WH, 0, true));
        check(`A ${m} (${Qc},${R}) +6,0 = band octave`, same(band, m === 'V' ? add(OCT, SCHISMA) : OCT), true);
      }
    }
  }
}

/* ── B: interval table ─────────────────────────────────────────────────────────── */
const ROW = {
  '5': '9/8 10/9 9/8 10/9 9/8 256/225',
  P: '9/8 9/8 9/8 9/8 9/8 65536/59049',
  D: '9/8 9/8 9/8 10/9 9/8 4096/3645',
  7: '9/8 8/7 9/8 10/9 9/8 448/405',
  V: '9/8 9/8 9/8 10/9 9/8 9/8',
};
const SHAPE = {
  '5': '9/8 5/4 27/20 3/2 27/16 15/8 81/40',
  P: '9/8 81/64 4/3 3/2 27/16 243/128 2/1',
  D: '9/8 5/4 4/3 3/2 27/16 15/8 2/1',
  7: '9/8 5/4 21/16 3/2 27/16 15/8 63/32',
  V: '9/8 5/4 4/3 3/2 27/16 15/8 2/1',
};
const SHAPE_OFFSETS = [[1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [2, 1], [-1, 2]];
for (const m of JI) {
  const row = [-2, -1, 0, 1, 2, 3].map((Q) => iv([Q, 0], [Q + 1, 0], m)).join(' ');
  check(`B ${m} row`, row, ROW[m]);
  const shape = SHAPE_OFFSETS.map(([a, b]) => iv([0, 0], [a, b], m)).join(' ');
  check(`B ${m} shape from reference`, shape, SHAPE[m]);
}
check('B E row (semitones)', [-2, -1, 0, 1, 2, 3].map((Q) => coordToMidi(Q + 1, 0, WH) - coordToMidi(Q, 0, WH)).join(' '), '2 2 2 2 2 2');
check('B E shape (semitones)', SHAPE_OFFSETS.map(([a, b]) => coordToMidi(a, b, WH) - 57).join(' '), '2 4 5 7 9 11 12');

/* ── C: spelling ───────────────────────────────────────────────────────── */
for (let Q = -41; Q <= 41; Q += 2) {          /* odd columns: copies */
  for (let R = -10; R <= 10; R++) {
    const k = fd(Q);
    check(`C (${Q},${R}) name = column cell's`, noteName(Q, R, WH, 0, true), noteName(k, R + 2, 'euler', 0, true));
    check(`C (${Q},${R}) octave = column cell's − 1`, keyOctave(Q, R, WH, 0, true), keyOctave(k, R + 2, 'euler', 0, true) - 1);
    check(`C (${Q},${R}) nominal MIDI`, coordToMidi(Q, R, WH), 57 + 2 * Q + 7 * R);
  }
}

/* ── D: color ─────────────────────────────────────────────────────────── */
function colorIn(mode, mapping, q, r) {
  tuning.mode = mode;
  tuning.equalEnabled = mode === 'E';
  tuning.septimalEnabled = mode === '7';
  tuning.mapping = mapping;
  return keyColorVariant(q, r);
}
for (const m of TUNING_MODES) {
  for (let Q = -21; Q <= 21; Q++) {
    for (let R = -8; R <= 8; R++) {
      const k = fd(Q), copy = Q !== 2 * k;
      const v = colorIn(m, WH, Q, R);
      /* light / dark by the cell's own pitch class */
      const pc = ((coordToMidi(Q, R, WH) % 12) + 12) % 12;
      check(`D ${m} (${Q},${R}) white/black`, v.isW, [0, 2, 4, 5, 7, 9, 11].includes(pc));
      let want;
      if (m === 'E') {
        const e = eulerOf(Q, R, WH);                     /* same MIDI → sounding octave */
        want = colorIn(m, 'euler', e.q, e.r).hue;
      } else {
        want = colorIn(m, 'euler', k, copy ? R + 2 : R).hue;   /* the column's color */
      }
      check(`D ${m} (${Q},${R}) hue`, v.hue, want);
    }
  }
}

/* ── E: frame conversion ──────────────────────────────────────────────────── */
for (const m of JI) {
  for (let q = -15; q <= 15; q++) {
    for (let r = -10; r <= 10; r++) {
      const [Q, R] = convertCell(q, r, 'euler', WH);
      check(`E ${m} euler(${q},${r}) → WH pitch-exact`, same(coordExps(Q, R, m, WH, 0, true), coordExps(q, r, m, 'euler', 0, true)), true);
      check(`E ${m} euler(${q},${r}) → WH → euler identity`, convertCell(Q, R, WH, 'euler').join(), [q, r].join());
    }
  }
  for (let Q = -30; Q <= 30; Q++) {
    for (let R = -10; R <= 10; R++) {
      const [q, r] = convertCell(Q, R, WH, 'euler');
      const d = sub(coordExps(Q, R, m, WH, 0, true), coordExps(q, r, m, 'euler', 0, true));
      const copy = Q !== 2 * fd(Q);
      check(`E ${m} WH(${Q},${R}) → euler`, d.join(), (m === 'V' && copy ? SCHISMA : [0, 0, 0, 0]).join());
    }
  }
}
check('E Equal frame conversion keeps pitch',
  freqAt(7, -2, 'E', WH, 0, true).toFixed(9), freqAt(...convertCell(7, -2, WH, 'euler'), 'E', 'euler', 0, true).toFixed(9));

/* ── G: reference spine ───────────────────────────────────────────────────
   The qm0 ORIGINAL column of the ref's own 6-band, same row: (Q+2) mod 6 = 2,
   within the band, at most 3 columns away; Euler unchanged. */
for (let Q = -30; Q <= 30; Q++) {
  for (let R = -6; R <= 6; R++) {
    const sp = refSpine(Q, R, WH);
    const pos = (s) => (((s + 2) % 6) + 6) % 6;
    check(`G (${Q},${R}) spine on a qm0 original`, pos(sp.q), 2);
    check(`G (${Q},${R}) spine in the ref's band and row`, Math.floor((sp.q + 2) / 6) + ',' + sp.r, Math.floor((Q + 2) / 6) + ',' + R);
  }
}
for (const [q, want] of [[0, 0], [1, 0], [2, 3], [-1, 0], [3, 3]]) {
  check(`G euler refSpine(${q},0)`, refSpine(q, 0, 'euler').q, want);
}

/* ── F: Lumatone footprint ────────────────────────────────────────────────── */
const src = readFileSync(new URL('../../apps/hkl/src/layout/baseKeys.ts', import.meta.url), 'utf8');
const keys = [...src.matchAll(/\[(-?\d+),(-?\d+)\]/g)].map((x) => x[1] + ',' + x[2]);
check('F footprint has 280 keys', keys.length, 280);
check('F 280 distinct cells', new Set(keys).size, 280);

console.log(`${pass}/${pass + fail} checks passed`);
if (failures.length) {
  console.log('\nFailures (first 25):');
  for (const f of failures) console.log('  ' + f);
}
process.exit(fail ? 1 : 0);
