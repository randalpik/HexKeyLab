// Smoke test: enumerate representative (q,r)→(q',r') intervals per mode and print the
// new spelling-driven names. Run: `npx tsx test/interval-names/smoke.ts`.
//
// Used during the intervals.ts refactor (spelling-driven naming) to verify:
//   - V mode A3→A4 across a band → "perfect octave + schisma"
//   - V mode F#3→D4 across a band → "Pythagorean minor 6th + schisma"
//   - All existing JI names preserved or improved
//   - Complement symmetry holds

import { intervalNameFromCoords, classifyDiatonic } from '../../apps/hkl/src/tuning/intervals.ts';
import { jiRatioWithState } from '../../apps/hkl/src/tuning/ratios.ts';
import type { TuningStateLike } from '../../apps/hkl/src/tuning/regions.ts';
import { noteName, keyOctave } from '@hkl/shared/notes.js';

function st(mode: 'E' | '5' | 'P' | 'D' | '7' | 'V'): TuningStateLike {
  return { mode, equalEnabled: mode === 'E', septimalEnabled: mode === '7', septimalW: 1 };
}

interface Case { label: string; q1: number; r1: number; q2: number; r2: number; }

/* Reach-test cases. (q, r) origin A3 = (0, 0). */
const cases: Case[] = [
  /* Within-band 5-limit intervals from A3 */
  { label: 'A3→E4 (P5)',      q1: 0, r1: 0, q2: 0, r2: 1 },
  { label: 'A3→D4 (P4)',      q1: 0, r1: 0, q2: 0, r2: -1 },
  { label: 'A3→B3 (M2)',      q1: 0, r1: 0, q2: 0, r2: 2 },
  { label: 'A3→C#4 (M3)',     q1: 0, r1: 0, q2: 1, r2: 0 },
  { label: 'A3→C4 (m3)',      q1: 0, r1: 0, q2: -1, r2: 1 },
  { label: 'A3→F4 (m6 ascending — uses descending coords)', q1: -1, r1: 0, q2: 0, r2: 0 },
  { label: 'A3→F#4 (M6)',     q1: 0, r1: 0, q2: 1, r2: 1 },
  /* Band-crossing octaves (V mode schisma stack) */
  { label: 'A3→A4 (P8 across 1 band)',     q1: 0, r1: 0, q2: 3, r2: 0 },
  { label: 'A3→A5 (P15 across 2 bands)',   q1: 0, r1: 0, q2: 6, r2: 0 },
  /* F# → D minor 6th, ascending, across one band (F#3 = q=-6,r=3; D4 = q=3,r=-1) */
  { label: 'F#3→D4 (m6 across 2 bands)',   q1: -6, r1: 3, q2: 3, r2: -1 },
  /* F#3 → D4 across one band: F#3 = q=-3 in a different placement */
  /* Simpler: E4 → C5 across 1 band */
  { label: 'E4→C5 (m6 across 1 band)',     q1: 0, r1: 1, q2: 2, r2: 1 },
];

const modes: Array<'E' | '5' | 'P' | 'D' | '7' | 'V'> = ['E', '5', 'P', 'D', '7', 'V'];

console.log('mode | label | spelling | exp | name | ratio');
console.log('---|---|---|---|---|---');
for (const m of modes) {
  for (const c of cases) {
    const cls = classifyDiatonic(c.q1, c.r1, c.q2, c.r2);
    const nn1 = noteName(c.q1, c.r1), o1 = keyOctave(c.q1, c.r1);
    const nn2 = noteName(c.q2, c.r2), o2 = keyOctave(c.q2, c.r2);
    const { num, den, e } = jiRatioWithState(c.q1, c.r1, c.q2, c.r2, st(m));
    const name = intervalNameFromCoords(c.q1, c.r1, c.q2, c.r2, st(m));
    const sigBand = `[${nn1}${o1} ${nn2}${o2}]`;
    console.log(`${m} | ${c.label} ${sigBand} | (${cls.ord},${cls.qual},+${cls.extraOct}) | exp=[${e.join(',')}] | ${name} | ${num}:${den}`);
  }
  console.log('');
}
