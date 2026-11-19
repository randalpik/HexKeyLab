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
//   S4  a multiple quality: doubly augmented is AA and doubly diminished dd; from three on the
//       count stands before the letter (3A, 12d), with no ×. Every such name begins with
//       "Pythagorean", so every such form is P, the letters or the count and letter, the number;
//       no other form holds a doubled letter; the × stays on what is counted (6×SC, 2×P8)
//   S5  a bare 7 or W before 4, 5 or 8 gets its P (7P4, WP5) only where it starts the quality:
//       the 7 of a count (P7A8) and of an interval's number (the 74th, 75th, 78th) are left alone
//   S6  acute is >> and grave << (>>M3, <<m3): an acute major interval is two syntonic commas
//       above the plain major one and one above the Pythagorean, a grave minor two below and one
//       below; no interval has both such a name and a lesser or greater one; no doubled sign
//       stands anywhere but at the start; no word is left spelled out. Known and left as it is:
//       a seven-fold quality (P7d5) is a septimal form (7d5) with a P before it
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

/* S4 */
const shorts = [...names.keys()].map((n) => [n, text(shortenInterval(n, true))]);
const multiple = shorts.filter(([n]) => /\bdoubly\b|\d+× (augmented|diminished)/.test(n));
check('S4 names with a multiple quality', multiple.length > 3000, true);
check('S4 each begins with Pythagorean', multiple.every(([n]) => n.startsWith('Pythagorean ')), true);
check('S4 each is P, AA or dd or a count and its letter, and the number', multiple.every(([n, s]) => /^P(?:AA|dd|\d+[Ad])\d+(?: |$)/.test(s)), true);
check('S4 doubly is AA or dd, a count is three or more', multiple.every(([n, s]) => (/\bdoubly augmented\b/.test(n) ? s.startsWith('PAA') : /\bdoubly diminished\b/.test(n) ? s.startsWith('Pdd') : Number(s.match(/^P(\d+)[Ad]/)[1]) >= 3)), true);
check('S4 the count is the name\'s', multiple.filter(([n]) => /\d+× (?:augmented|diminished)/.test(n)).every(([n, s]) => n.match(/(\d+)× (augmented|diminished)/)[1] + (/× augmented/.test(n) ? 'A' : 'd') === s.match(/^P(\d+[Ad])/)[1]), true);
check('S4 no "doubly" and no × before a quality in any short form', shorts.filter(([, s]) => /doubly|×[Ad]/.test(s)).length, 0);
check('S4 no doubled letter but AA and dd', shorts.filter(([, s]) => /([A-Za-z])\1/.test(s.replace(/^P(?:AA|dd)/, ''))).map(([, s]) => s).slice(0, 3).join(' '), '');
for (const [name, short] of [['Pythagorean doubly augmented unison', 'PAA1'], ['Pythagorean doubly diminished octave', 'Pdd8'], ['Pythagorean doubly augmented 4th', 'PAA4'],
  ['Pythagorean 3× augmented 7th', 'P3A7'], ['Pythagorean 5× augmented 4th', 'P5A4'], ['Pythagorean 12× diminished 5th', 'P12d5'],
  ['Pythagorean 9× augmented octave − 6× syntonic comma', 'P9A8 − 6×SC'], ['2 octaves + syntonic comma', '2×P8 + SC']]) check(`S4 short form of "${name}"`, text(shortenInterval(name, true)), short);

/* S5 */
for (const [name, short] of [['septimal 4th', '7P4'], ['septimal 5th', '7P5'], ['wolf 4th', 'WP4'], ['wolf 5th', 'WP5'], ['septimal augmented 4th', '7A4'],
  ['Pythagorean 7× augmented octave', 'P7A8'], ['Pythagorean augmented 74th', 'PA74'], ['Pythagorean doubly augmented 75th − syntonic comma', 'PAA75 − SC'],
  ['Pythagorean 3× augmented 78th', 'P3A78'], ['Pythagorean major 74th + septimal 4th', 'PM74 + 7P4']]) check(`S5 short form of "${name}"`, text(shortenInterval(name, true)), short);

/* S6 */
const SC = [-4, 4, -1, 0];
const apart = (a, b) => { if (!a || !b) return null; const x = a.split(',').map(Number), y = b.split(',').map(Number), d = x.map((v, i) => v - y[i]), k = -d[2]; return d.join() === SC.map((v) => v * k).join() ? k : null; };
for (const [name, short, plainBy, pythBy] of [['acute major 2nd', '>>M2', 2, 1], ['acute major 3rd', '>>M3', 2, 1], ['acute major 6th', '>>M6', 2, 1],
  ['grave minor 3rd', '<<m3', -2, -1], ['grave minor 6th', '<<m6', -2, -1], ['grave minor 7th', '<<m7', -2, -1]]) {
  const base = name.replace(/^(acute|grave) /, '');
  check(`S6 short form of "${name}"`, text(shortenInterval(name, true)), short);
  check(`S6 "${name}" in syntonic commas from the plain and the Pythagorean`, `${apart(names.get(name), names.get(base))} ${apart(names.get(name), names.get('Pythagorean ' + base))}`, `${plainBy} ${pythBy}`);
  check(`S6 there is no lesser or greater ${base}`, names.has('lesser ' + base) || names.has('greater ' + base), false);
}
check('S6 acute is only said of a major interval, grave of a minor', [...names.keys()].filter((n) => /\bacute\b/.test(n) && !/^acute major /.test(n) || /\bgrave\b/.test(n) && !/^grave minor /.test(n)).length, 0);
check('S6 a doubled sign only at the start of a form', shorts.filter(([, s]) => /.(>>|<<)/.test(s) || />>>|<<<|><|<>/.test(s)).length, 0);
check('S6 every acute and grave is shortened', shorts.filter(([n, s]) => /acute|grave/.test(n) && !/^(>>|<<)/.test(s)).length, 0);
/* a short form's words are capitals, a small m, d, sm, s or c after one, digits and signs; a
   run of three small letters would be a word left spelled out */
check('S6 no word is left spelled out', shorts.filter(([, s]) => /[a-z]{3,}/.test(s)).map(([, s]) => s).slice(0, 3).join(' '), '');
const septimal = new Set(shorts.map(([, s]) => s.split(' ')[0]).filter((h) => /^7/.test(h)));
const sevenfold = [...new Set(shorts.map(([, s]) => s.split(' ')[0]).filter((h) => /^P7[Ad]\d/.test(h)))];
check('S6 seven-fold forms, and those that are a septimal form behind a P', `${sevenfold.length} ${sevenfold.filter((h) => septimal.has(h.slice(1))).length}`, '12 11');

console.log(`${names.size} interval names, ${byShort.size} short forms`);
console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
