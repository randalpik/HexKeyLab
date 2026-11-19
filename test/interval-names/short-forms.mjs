// Interval short forms gate (docs/architecture/hkl.md → Interval naming, "Short intervals" mode).
//
// Pure Node, no dev server. Asks HKL's interval namer (apps/hkl/src/tuning/intervals.ts) for the
// name of every pair of keys it can meet: all eight mappings, the seven JI modes, banded and
// unbanded, the lower key in a 7×7 window around A3 and the upper within 9 columns and 9 rows of
// it. Checks:
//   S1  no two names share a short form (shortenInterval)
//   S2  subminor is "sm" and supermajor "SM", and no other short form holds either pair of letters
//   S3  the septimal augmented 4ths and diminished 5ths: 10:7 and 7:5 are plain "septimal"; the
//       pair a syntonic comma outside them, 81:56 and 112:81, are "greater septimal augmented 4th"
//       and "lesser septimal diminished 5th" (>7A4, <7d5), octave complements of each other; no
//       name of that family is spelled out with "+ syntonic comma"
//
// Run: node --import ./test/orchestrator-smoke/register-ts.mjs test/interval-names/short-forms.mjs

import { intervalNameFromCoords, shortenInterval } from '../../apps/hkl/src/tuning/intervals.ts';
import { anchorOf, coordExps } from '../../packages/shared/src/freq.ts';
import { MAPPINGS } from '../../packages/shared/src/mapping.ts';

let checks = 0, fails = 0;
function check(label, got, want) {
  checks++;
  if (got !== want) { fails++; if (fails <= 40) console.log(`FAIL ${label}: got ${got}, want ${want}`); }
}
const text = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/* every name, with one ratio it was given to (as prime exponents, upper over lower) */
const names = new Map();
for (const mapping of MAPPINGS) for (const mode of ['5', 'P', 'D', '7', 'V', 'S', 'Y']) for (const banded of [true, false]) {
  const anchor = anchorOf(0, 0, mapping);
  const st = { mode, mapping, anchor, banded, equalEnabled: false, septimalEnabled: mode === '7', septimalW: 1 };
  for (let q1 = -3; q1 <= 3; q1++) for (let r1 = -3; r1 <= 3; r1++) for (let dq = -9; dq <= 9; dq++) for (let dr = -9; dr <= 9; dr++) {
    if (!dq && !dr) continue;
    let name;
    try { name = intervalNameFromCoords(q1, r1, q1 + dq, r1 + dr, st); } catch { continue; }
    if (!names.has(name) && mode !== 'V') {
      const a = coordExps(q1, r1, mode, mapping, anchor, banded), b = coordExps(q1 + dq, r1 + dr, mode, mapping, anchor, banded);
      const up = b.map((x, i) => x - a[i]), cents = 1200 * Math.log2(2 ** up[0] * 3 ** up[1] * 5 ** up[2] * 7 ** up[3]);
      names.set(name, (cents < 0 ? up.map((x) => -x) : up).join());
    } else if (!names.has(name)) names.set(name, null);
  }
}

/* S1 */
const byShort = new Map();
for (const n of names.keys()) { const s = shortenInterval(n, true); (byShort.get(s) ?? byShort.set(s, []).get(s)).push(n); }
const shared = [...byShort].filter(([, v]) => v.length > 1);
check('S1 short forms shared by two names', shared.map(([s, v]) => `${text(s)}: ${v.join(' / ')}`).slice(0, 5).join('; '), '');

/* S2 */
for (const [name, short] of [['septimal subminor 2nd', '7sm2'], ['septimal supermajor 7th', '7SM7'], ['septimal subminor 9th', '7sm9'], ['septimal supermajor 14th', '7SM14']]) {
  check(`S2 the namer gives "${name}"`, names.has(name), true);
  check(`S2 short form of "${name}"`, text(shortenInterval(name, true)), short);
}
const lettered = [...names.keys()].filter((n) => /sm|SM/.test(shortenInterval(n, true)));
check('S2 only subminor and supermajor shorten to sm and SM', lettered.every((n) => /\b(subminor|supermajor)\b/.test(n)), true);
check('S2 every subminor and supermajor does', [...names.keys()].filter((n) => /subminor|supermajor/.test(n)).every((n) => !/subminor|supermajor/.test(shortenInterval(n, true))), true);

/* S3 */
const ratio = (n, d) => { const e = [0, 0, 0, 0]; [2, 3, 5, 7].forEach((p, i) => { while (n % p === 0) { n /= p; e[i]++; } while (d % p === 0) { d /= p; e[i]--; } }); return e.join(); };
for (const [name, n, d, short] of [['septimal augmented 4th', 10, 7, '7A4'], ['septimal diminished 5th', 7, 5, '7d5'],
  ['greater septimal augmented 4th', 81, 56, '>7A4'], ['lesser septimal diminished 5th', 112, 81, '<7d5']]) {
  check(`S3 ${n}:${d} is the "${name}"`, names.get(name) ?? 'not named', ratio(n, d));
  check(`S3 short form of "${name}"`, text(shortenInterval(name, true)), short);
}
check('S3 81:56 and 112:81 are octave complements', ratio(81 * 112, 56 * 81), ratio(2, 1));
check('S3 no septimal augmented 4th or diminished 5th is spelled with a comma added',
  [...names.keys()].filter((n) => /^septimal (augmented 4th|diminished 5th) [+−] syntonic comma$/.test(n)).join('; '), '');

console.log(`${names.size} interval names, ${byShort.size} short forms`);
console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
