// Chromatic mapping oracle (docs/architecture.md → Note-name mapping).
//
// Pure Node gate — no dev server, no browser. Imports the REAL modules
// (@hkl/shared primitives, HKL's refSpine) through the repo's TS loader and
// checks every rule of the chromatic mapping against them:
//   A  construction, every JI mode (S/Y at anchors −2…2):
//        closed-form eulerOf = the recursive definition (odd Q = (Q−5, R−1) up
//        an octave) · a new column = (Q−5, R−1) × 2 exactly, except V at
//        positions 1/3 (× schisma: its schisma follows the visual band) · an
//        even column = its Wicki-Hayden cell (Q/2, R) exactly · (+4, 0) = the
//        Euler (1, 0) step (band-uniform modes) · band (+12, 0) = the mode's
//        band octave (S: the transition of the cell's pitch band)
//   B  interval tables: the ref's row and chromatic scale per mode (from the
//      design prototype, which used the recursive definition, not this code)
//   C  spelling and nominal MIDI along the ref's row
//   E  frame conversion: Euler / Wicki-Hayden → chromatic exact in every
//      mode; chromatic → Euler pitch-exact in 5/P/D/7; round trips
//   G  reference spine: the qm0 of the ref's own band, same row
//   H  pitchBandOf: one band lower at positions 1 and 3, own band elsewhere;
//      identity under Euler / Wicki-Hayden
//   I  anchor on a borrowed key: its spatial band becomes home and it stays
//      one syntonic comma below Pythagorean (S and Y)
//   J  Schismatic = Semiditonal × schisma^(spatial band), every mapping
//   K  tritone-axis octaves (Q,R)/(Q+2,R−2): pure except at band positions 3
//      and 10 (the spelling-window wraps, enharmonic augmented 7ths); there
//      Pythagorean 2/1·PC, Polysyntonic always 2/1·schisma, Syntonic by
//      transition — carry puts both wraps on a pitch-band boundary
//   F  the 280 Lumatone keys: distinct cells, MIDI 12–102, 88 distinct notes
//
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/chromatic-layout/oracle.mjs
//
// Exits non-zero on any failure.

import { readFileSync } from 'node:fs';
import { coordExps, coordToMidi, anchorOf, bandOffset } from '../../packages/shared/src/freq.ts';
import { noteName, keyOctave } from '../../packages/shared/src/notes.ts';
import { eulerOf, convertCell, bandOfCell, pitchBandOf, posInBandOf, MAPPINGS } from '../../packages/shared/src/mapping.ts';
import { refSpine } from '../../apps/hkl/src/tuning/refspine.ts';

const CH = 'chromatic';
const JI = ['5', 'P', 'D', '7', 'V', 'S', 'Y'];
const UNIFORM = ['5', 'P', 'D', '7'];
const PR = [2, 3, 5, 7];
const OCT = [1, 0, 0, 0], SCHISMA = [-15, 8, 1, 0], SC = [-4, 4, -1, 0], ZERO = [0, 0, 0, 0];
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
const ex = (Q, R, m, a = 0) => coordExps(Q, R, m, CH, a, true);
const anchorsFor = (m) => (m === 'S' || m === 'Y' ? [-2, -1, 0, 1, 2] : [0]);

/* ── A: construction ─────────────────────────────────────────────────────── */
for (let Q = -41; Q <= 41; Q++) {
  for (let R = -12; R <= 12; R++) {
    if (md(Q, 2)) {
      const e = eulerOf(Q, R, CH), s = eulerOf(Q - 5, R - 1, CH);
      check(`A (${Q},${R}) closed form = (Q−5,R−1) + (3,0)`, `${e.q},${e.r}`, `${s.q + 3},${s.r}`);
    }
    for (const m of JI) {
      for (const a of anchorsFor(m)) {
        const e0 = ex(Q, R, m, a);
        if (md(Q, 2)) {
          const borrowed = m === 'V' && [1, 3].includes(posInBandOf(Q, CH));
          check(`A ${m} a${a} (${Q},${R}) new column = (Q−5,R−1) × 2${borrowed ? ' × schisma' : ''}`,
            sub(e0, ex(Q - 5, R - 1, m, a)).join(), (borrowed ? add(OCT, SCHISMA) : OCT).join());
        } else {
          check(`A ${m} a${a} (${Q},${R}) = Wicki-Hayden (Q/2, R)`, e0.join(), coordExps(Q / 2, R, m, 'wickiHayden', a, true).join());
        }
        /* band (+12, 0) */
        let want;
        if (m === 'V') want = add(OCT, SCHISMA);
        else if (m === 'S' || m === 'Y') {
          const pb = pitchBandOf(Q, CH) - a;
          want = add(OCT, SC, bandOffset(m, pb + 1) - bandOffset(m, pb));
        } else want = OCT;
        check(`A ${m} a${a} (${Q},${R}) +12,0 = band octave`, sub(ex(Q + 12, R, m, a), e0).join(), want.join());
      }
    }
    for (const m of UNIFORM) {
      const c = eulerOf(Q, R, CH);
      const step = sub(coordExps(c.q + 1, c.r, m, 'euler', 0, true), coordExps(c.q, c.r, m, 'euler', 0, true));
      check(`A ${m} (${Q},${R}) +4,0 = Euler (1,0) step`, sub(ex(Q + 4, R, m), ex(Q, R, m)).join(), step.join());
    }
  }
}

/* ── B: interval tables (ref A3, anchor 0) ───────────────────────────────── */
const STEPS = {      /* row F3 → F4: (Q, 0) → (Q+1, 0), Q = −4 … 7 */
  '5': '25/24 27/25 25/24 16/15 16/15 135/128 16/15 25/24 16/15 135/128 16/15 16/15',
  P: '2187/2048 256/243 2187/2048 256/243 256/243 2187/2048 256/243 2187/2048 256/243 2187/2048 256/243 256/243',
  D: '135/128 16/15 135/128 16/15 256/243 2187/2048 256/243 135/128 16/15 135/128 16/15 256/243',
  7: '15/14 21/20 15/14 16/15 28/27 243/224 28/27 15/14 16/15 135/128 16/15 28/27',
  V: '135/128 16/15 135/128 16/15 256/243 2187/2048 256/243 135/128 16/15 135/128 16/15 135/128',
};
const SCALE = {      /* (Q, 0) / (0, 0), Q = 1 … 12 */
  '5': '16/15 9/8 6/5 5/4 4/3 45/32 3/2 8/5 5/3 9/5 15/8 2/1',
  P: '256/243 9/8 32/27 81/64 4/3 729/512 3/2 128/81 27/16 16/9 243/128 2/1',
  D: '256/243 9/8 32/27 5/4 4/3 45/32 3/2 128/81 5/3 16/9 15/8 2/1',
  7: '28/27 9/8 7/6 5/4 4/3 45/32 3/2 14/9 5/3 7/4 15/8 2/1',
};
const HOME = {       /* (Q, 0) / (0, 0), Q = −4 … 7: the home band F3 … E4 */
  V: '64/81 5/6 8/9 15/16 1/1 256/243 9/8 32/27 5/4 4/3 45/32 3/2',
  S: '64/81 5/6 8/9 15/16 1/1 256/243 9/8 32/27 81/64 4/3 729/512 3/2',
  Y: '64/81 5/6 8/9 15/16 1/1 256/243 9/8 32/27 81/64 4/3 729/512 3/2',
};
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
for (const m of Object.keys(STEPS)) check(`B ${m} row steps`, range(-4, 7).map((Q) => ratio(sub(ex(Q + 1, 0, m), ex(Q, 0, m)))).join(' '), STEPS[m]);
for (const m of Object.keys(SCALE)) check(`B ${m} chromatic scale from the ref`, range(1, 12).map((Q) => ratio(sub(ex(Q, 0, m), ex(0, 0, m)))).join(' '), SCALE[m]);
for (const m of Object.keys(HOME)) check(`B ${m} home band from the ref`, range(-4, 7).map((Q) => ratio(sub(ex(Q, 0, m), ex(0, 0, m)))).join(' '), HOME[m]);
check('B E row (semitones)', range(-4, 7).map((Q) => coordToMidi(Q + 1, 0, CH) - coordToMidi(Q, 0, CH)).join(' '), '1 1 1 1 1 1 1 1 1 1 1 1');

/* ── C: spelling ─────────────────────────────────────────────────────────── */
check('C ref row names', range(-4, 7).map((Q) => noteName(Q, 0, CH, 0, true)).join(' '), 'F F# G G# A Bb B C C# D D# E');
check('C ref row octaves', range(-4, 7).map((Q) => keyOctave(Q, 0, CH, 0, true)).join(' '), '3 3 3 3 3 3 3 4 4 4 4 4');
for (let Q = -41; Q <= 41; Q++) {
  for (let R = -10; R <= 10; R++) {
    check(`C (${Q},${R}) nominal MIDI`, coordToMidi(Q, R, CH), 57 + Q + 7 * R);
    const e = eulerOf(Q, R, CH);
    check(`C (${Q},${R}) MIDI = Euler-equivalent's`, coordToMidi(Q, R, CH), coordToMidi(e.q, e.r, 'euler'));
  }
}

/* ── E: frame conversion ─────────────────────────────────────────────────── */
for (const m of JI) {
  for (let q = -12; q <= 12; q++) {
    for (let r = -10; r <= 10; r++) {
      const [Q, R] = convertCell(q, r, 'euler', CH);
      check(`E ${m} euler(${q},${r}) → chromatic pitch-exact`, ex(Q, R, m).join(), coordExps(q, r, m, 'euler', 0, true).join());
      check(`E euler(${q},${r}) → chromatic → euler`, convertCell(Q, R, CH, 'euler').join(), [q, r].join());
      const [Qw, Rw] = convertCell(q, r, 'wickiHayden', CH);
      check(`E ${m} WH(${q},${r}) → chromatic pitch-exact`, ex(Qw, Rw, m).join(), coordExps(q, r, m, 'wickiHayden', 0, true).join());
    }
  }
}
/* the frames nest: a chromatic cell that exists in Wicki-Hayden maps to itself and back */
for (let Q = -40; Q <= 40; Q += 2) {
  for (let R = -8; R <= 8; R++) {
    check(`E chromatic(${Q},${R}) → WH nested cell`, convertCell(Q, R, CH, 'wickiHayden').join(), [Q / 2, R].join());
    check(`E WH(${Q / 2},${R}) → chromatic nested cell`, convertCell(Q / 2, R, 'wickiHayden', CH).join(), [Q, R].join());
  }
}
for (const m of UNIFORM) {
  for (let Q = -41; Q <= 41; Q += 2) {
    for (let R = -12; R <= 12; R++) {
      const [q, r] = convertCell(Q, R, CH, 'euler');
      check(`E ${m} chromatic(${Q},${R}) → euler pitch-exact`, ex(Q, R, m).join(), coordExps(q, r, m, 'euler', 0, true).join());
    }
  }
}

/* ── G: reference spine ──────────────────────────────────────────────────── */
for (let Q = -30; Q <= 30; Q++) {
  for (let R = -6; R <= 6; R++) {
    const sp = refSpine(Q, R, CH);
    check(`G (${Q},${R}) spine on qm0`, posInBandOf(sp.q, CH), 4);
    check(`G (${Q},${R}) spine in the ref's band and row`, `${bandOfCell(sp.q, CH)},${sp.r}`, `${bandOfCell(Q, CH)},${R}`);
    check(`G (${Q},${R}) ref ≤4 left / ≤7 right of the spine`, Q - sp.q >= -4 && Q - sp.q <= 7, true);
  }
}
for (const [q, want] of [[0, 0], [1, 0], [2, 3], [-1, 0], [3, 3]]) check(`G euler refSpine(${q},0)`, refSpine(q, 0, 'euler').q, want);
for (const [q, want] of [[0, 0], [1, 0], [3, 0], [-2, 0], [4, 6], [-3, -6]]) check(`G WH refSpine(${q},0)`, refSpine(q, 0, 'wickiHayden').q, want);

/* ── H: pitch band ───────────────────────────────────────────────────────── */
for (let Q = -41; Q <= 41; Q++) {
  const lower = [1, 3].includes(posInBandOf(Q, CH));
  check(`H (${Q}) pitchBandOf`, pitchBandOf(Q, CH), bandOfCell(Q, CH) - (lower ? 1 : 0));
  for (const m of ['euler', 'wickiHayden']) check(`H ${m} (${Q}) pitchBandOf = bandOfCell`, pitchBandOf(Q, m), bandOfCell(Q, m));
}

/* ── I: anchor on a borrowed key ─────────────────────────────────────────── */
for (const m of ['S', 'Y']) {
  for (let b = -2; b <= 2; b++) {
    for (const pos of [1, 3]) {
      for (let R = -3; R <= 3; R++) {
        const Q = 12 * b - 4 + pos, a = anchorOf(Q, CH);
        check(`I ${m} (${Q},${R}) anchor = clicked band`, a, b);
        check(`I ${m} (${Q},${R}) stays one comma below Pythagorean`, sub(ex(Q, R, m, a), ex(Q, R, 'P')).join(), sub(ZERO, SC).join());
      }
    }
  }
}

/* ── J: Schismatic = Semiditonal × schisma^(spatial band) ────────────────── */
for (const map of MAPPINGS) {
  for (let q = -40; q <= 40; q++) {
    for (let r = -15; r <= 15; r++) {
      check(`J ${map} (${q},${r})`, coordExps(q, r, 'V', map, 0, true).join(), add(coordExps(q, r, 'D', map, 0, true), SCHISMA, bandOfCell(q, map)).join());
    }
  }
}

/* ── K: tritone-axis octaves (emergent; docs/architecture.md → Chromatic) ──────
   (Q,R) above (Q+2,R−2), two tritone steps = an octave. Pure everywhere except
   where the upper cell sits at band position 3 or 10 — the two places two
   tritones run past the row's 12-fifth spelling window, so the pair is an
   enharmonic augmented 7th (lower note flat-side, upper sharp-side; every pitch
   class occurs as rows vary). Pythagorean: 2/1·PC there. Carry puts both
   positions on a pitch-band boundary (pitch band of the lower cell = upper + 1),
   so the band offset step dk = k(lower) − k(upper) applies: 2/1·PC/SC^dk —
   Polysyntonic always dk = 1 → 2/1·schisma; Syntonic ±1 by transition. */
const PC = [-19, 12, 0, 0];
for (const m of ['P', 'S', 'Y']) {
  for (const a of anchorsFor(m)) {
    for (let Q = -40; Q <= 40; Q++) {
      for (let R = -12; R <= 12; R++) {
        const iv = sub(ex(Q, R, m, a), ex(Q + 2, R - 2, m, a));
        const wrap = [3, 10].includes(posInBandOf(Q, CH));
        let want = OCT;
        if (wrap) {
          check(`K (${Q},${R}) wrap crosses one pitch band`, pitchBandOf(Q + 2, CH) - pitchBandOf(Q, CH), 1);
          const dk = m === 'P' ? 0 : bandOffset(m, pitchBandOf(Q + 2, CH) - a) - bandOffset(m, pitchBandOf(Q, CH) - a);
          want = add(add(OCT, PC), SC, -dk);
          if (m === 'Y') check(`K Y a${a} (${Q},${R}) = 2/1·schisma`, iv.join(), add(OCT, SCHISMA).join());
          check(`K (${Q},${R}) spelled as an enharmonic pair`, noteName(Q, R, CH, 0, true)[0] !== noteName(Q + 2, R - 2, CH, 0, true)[0], true);
        }
        check(`K ${m} a${a} (${Q},${R}) tritone-axis octave`, iv.join(), want.join());
      }
    }
  }
}

/* ── F: Lumatone footprint ───────────────────────────────────────────────── */
const src = readFileSync(new URL('../../apps/hkl/src/layout/baseKeys.ts', import.meta.url), 'utf8');
const keys = [...src.matchAll(/\[(-?\d+),(-?\d+)\]/g)].map((x) => [+x[1], +x[2]]);
check('F footprint has 280 keys', keys.length, 280);
check('F 280 distinct cells', new Set(keys.map((k) => k.join())).size, 280);
const midis = keys.map(([q, r]) => coordToMidi(q, r, CH));
check('F MIDI span', `${Math.min(...midis)}–${Math.max(...midis)}`, '12–102');
check('F distinct MIDI notes', new Set(midis).size, 88);

console.log(`${pass}/${pass + fail} checks passed`);
if (failures.length) {
  console.log('\nFailures (first 25):');
  for (const f of failures) console.log('  ' + f);
}
process.exit(fail ? 1 : 0);
