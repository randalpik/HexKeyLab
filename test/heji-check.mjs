// HEJI spelling cross-check fixture.
//
// Walks a small set of canonical (q, r, mode) triples and verifies that the
// derived HEJI commas (e5 / e7 from the prime exponent vector) match the
// values transcribed from the Helmholtz-Ellis JI Pitch Notation PDF
// (~/Downloads/HEJI.pdf, "23-LIMIT TUNEABLE INTERVALS above A3" page).
//
// Reference convention:
//   - syn5 > 0 → display |syn5| syntonic-comma DOWN arrows
//     (e.g. 5/4 = e=[-2, 0, +1, 0]; +e5=1 → one down-arrow to lower 81/64
//     by 21.5¢ to 5/4)
//   - syn5 < 0 → up arrows
//   - sept7 > 0 → down hooks
//   - sept7 < 0 → up hooks
//
// Run:
//   node tools/heji-check.mjs
// Exits non-zero on any mismatch.
//
// All math here mirrors src/tuning/{ratios,regions}.ts (and the lazy load
// is intentional — no TS imports). Re-run after touching either module.

// ── tuning math (mirrors src/tuning/{ratios,regions}.ts) ───────────────────
const bandOf = (q) => Math.floor((q + 1) / 3);
const posInBand = (q) => (((q + 1) % 3) + 3) % 3;

const A_D0 = { type: 'A', aDepth: 0, aUpper: false };
const A_D1_UPPER = { type: 'A', aDepth: 1, aUpper: true };
const A_D1_LOWER = { type: 'A', aDepth: 1, aUpper: false };
const B_D1_UPPER = { type: 'B', aDepth: 1, aUpper: true };

function regionInfo(q, _r, mode) {
  const qm = ((q % 3) + 3) % 3;
  switch (mode) {
    case 'E':
    case '5':
      return A_D0;
    case 'P':
    case 'V':
      return qm === 2 ? A_D1_UPPER : qm === 1 ? A_D1_LOWER : A_D0;
    case 'D':
      return qm === 2 ? A_D1_UPPER : A_D0;
    case '7':
      return qm === 2 ? B_D1_UPPER : A_D0;
    default:
      return A_D0;
  }
}

const MODES_WITH_SHIFTS = new Set(['P', 'V', 'D', '7']);

function jiRatioE(q1, r1, q2, r2, mode) {
  const db = bandOf(q2) - bandOf(q1);
  const dp = posInBand(q2) - posInBand(q1);
  const dr = r2 - r1;
  let e2 = db - 2 * dp - dr, e3 = dr, e5 = dp, e7 = 0;
  if (MODES_WITH_SHIFTS.has(mode)) {
    const ri1 = regionInfo(q1, r1, mode), ri2 = regionInfo(q2, r2, mode);
    const apply = (ri, sign) => {
      if (ri.aDepth > 0) {
        const d = ri.aDepth;
        if (ri.aUpper) { e2 += sign * 4 * d; e5 += sign * d; e3 += sign * (-4) * d; }
        else { e3 += sign * 4 * d; e2 += sign * (-4) * d; e5 += sign * (-d); }
      }
      if (ri.type === 'B') { e7 += sign; e3 += sign * 2; e2 += sign * (-6); }
    };
    apply(ri2, +1);
    apply(ri1, -1);
  }
  if (mode === 'V' && db !== 0) {
    e2 += db * -15;
    e3 += db * 8;
    e5 += db * 1;
  }
  /* HEJI uses absolute (signed) exponents — do NOT swap to ascending here.
     The descending swap in src/tuning/ratios.ts:jiRatioWithState is for
     interval-name analysis (ratios displayed as ascending). For HEJI a cell
     below A3 with +1 e5 still represents "+SC above its Pythagorean nominal"
     and should display the corresponding glyph with its natural sign. */
  return [e2, e3, e5, e7];
}

// ── note name (mirrors src/tuning/notes.ts) ─────────────────────────────────
const letterSemi = { A: 0, B: 2, C: 3, D: 5, E: 7, F: 8, G: 10 };
const accToVal = (a) => { let v = 0; for (const c of a) { if (c === '#') v++; else if (c === 'b') v--; } return v; };
const valToAcc = (v) => v === 0 ? '' : (v > 0 ? '#'.repeat(v) : 'b'.repeat(-v));
const parseNote = (n) => ({ letter: n[0], acc: n.slice(1) });

function m3up(n) {
  const p = parseNote(n); const L = 'ABCDEFG'; const i = L.indexOf(p.letter);
  const nl = L[(i + 2) % 7];
  const nat = (letterSemi[nl] - letterSemi[p.letter] + 12) % 12;
  return nl + valToAcc(4 - nat + accToVal(p.acc));
}
function m3dn(n) {
  const p = parseNote(n); const L = 'ABCDEFG'; const i = L.indexOf(p.letter);
  const nl = L[((i - 2) % 7 + 7) % 7];
  const nat = (letterSemi[p.letter] - letterSemi[nl] + 12) % 12;
  return nl + valToAcc(-(4 - nat) + accToVal(p.acc));
}
function fifthName(r) {
  if (r >= 0) {
    const letter = 'AEBFCGD'[r % 7];
    const acc = Math.floor(r / 7) + ((r % 7 >= 3) ? 1 : 0);
    return letter + valToAcc(acc);
  }
  const rr = -r;
  const letter = 'ADGCFBE'[rr % 7];
  const acc = Math.floor(rr / 7) + ((rr % 7 >= 5) ? 1 : 0);
  return letter + valToAcc(-acc);
}
function noteName(q, r) {
  const fn = fifthName(r);
  const pos = ((q + 1) % 3 + 3) % 3;
  if (pos === 1) return fn;
  if (pos === 2) return m3up(fn);
  return m3dn(fn);
}

// ── HEJI label assembly ────────────────────────────────────────────────────
function arrows(n, downChar, upChar) {
  if (n === 0) return '';
  return (n > 0 ? downChar : upChar).repeat(Math.abs(n));
}
function hejiLabel(q, r, mode) {
  const name = noteName(q, r);
  const [_e2, _e3, e5, e7] = jiRatioE(0, 0, q, r, mode);
  return name + arrows(e5, '↓', '↑') + arrows(e7, '⇊', '⇈');
}

// ── Fixtures: cells whose HEJI spelling is known from the PDF ──────────────
// `label` uses ASCII-ish stand-ins for HEJI glyphs (down-arrow ↓, up ↑,
// septimal down ⇊, up ⇈) so we can assert string equality. Real renderer
// uses SMuFL codepoints.
const FIXTURES = [
  // Origin: A itself, all modes — no commas
  { q:  0, r:  0, mode: '5', label: 'A',         note: 'A above A (unison)' },
  { q:  0, r:  0, mode: 'P', label: 'A',         note: 'A above A (unison) Pythagorean' },
  { q:  0, r:  0, mode: '7', label: 'A',         note: 'A above A (unison) Septimal' },
  { q:  0, r:  0, mode: 'V', label: 'A',         note: 'A above A (unison) Schismatic' },

  // Ptolemaic mode: 5-limit intervals
  // (q=1, r=0): MIDI 61 (C#4), pitch class C# spelled as such. JI ratio
  // 5/4 above A → +1 syntonic comma down arrow on the C#.
  { q:  1, r:  0, mode: '5', label: 'C#↓', note: '5/4 above A in Ptolemaic — C# − SC' },
  // (q=0, r=-1): MIDI 50 (D3), pitch class D. JI ratio 2/3 (= D below A by P5);
  // octave-extended this is 4/3 down or 3/4 ratio. e3=-1, no commas.
  { q:  0, r: -1, mode: '5', label: 'D',         note: 'P5 below A in Ptolemaic — pure D' },
  // (q=-1, r=0): MIDI 53 (F3), pitch class F spelled as such (m3dn from A).
  // Ptolemaic cell at qm=2 with no region shift → e5=-1, so the cell is
  // ONE SYNTONIC COMMA UP from its Pythagorean nominal (F is 4/3 below A in
  // Pythagorean = 165 Hz; this cell sounds at 220 × 4/5 = 176 Hz = 81/80 above
  // Pythagorean F). Display: F + 1 syntonic UP arrow.
  { q: -1, r:  0, mode: '5', label: 'F↑',  note: 'qm=2 cell in Ptolemaic — F + SC up' },

  // Pythagorean mode: every interval is 3-limit, no commas anywhere
  // q=1 in Pythagorean is Pythagorean major third (81/64) — same C#
  // spelling as Ptolemaic, but the qm=1 column's +SC shift cancels the
  // base e5 = +1, leaving e5 = 0 → no comma annotation.
  { q:  1, r:  0, mode: 'P', label: 'C#',        note: 'Pythagorean major third 81/64' },
  // q=-1 in Pythagorean: qm=2 → A-d1-upper applies (-SC), cancelling base
  // e5=-1 → e5=0. Spelling is F (the m3dn fall-through). The cell is now
  // a true Pythagorean F (minor 6th below A = 165 Hz). No comma annotation.
  { q: -1, r:  0, mode: 'P', label: 'F',         note: 'Pythagorean F (no commas)' },

  // Septimal mode: 7-limit cells at qm=2
  // 7/4 above A is approximately G − septimal comma (= harmonic 7th, 969¢)
  // Cell (-1, 2): qm=2 in Septimal → B-region, e7=+1
  { q: -1, r:  2, mode: '7', label: 'G⇊',  note: '7/4 (harmonic 7th) in Septimal' },

  // Schismatic V mode: each band step adds db*[-15,+8,+1,0] = one syntonic
  // comma down on top of the qm-column shifts. Same-band cells spell like
  // Pythagorean (which is itself like 5 + qm shifts that cancel commas).
  // Cell at (q=3, r=0) is one band above A in V mode — should accumulate
  // one syntonic-down arrow on top of whatever the conventional spelling is.
  // noteName(3, 0) = m3dn(fifthName(0)) since posInBand(3)=1? Let me
  // double check.
  // posInBand(3) = ((4%3)+3)%3 = 1, so noteName(3,0) = fifthName(0) = A.
  // (Same letter as origin — band step preserves letter via posInBand.)
  // V mode adds db=1 schisma → e3+=8, e5+=1, e2+=-15 → 1 syntonic-down arrow.
  { q:  3, r:  0, mode: 'V', label: 'A↓', note: 'V-mode q=3 (one schisma above origin)' },
];

let failed = 0;
console.log('HEJI fixture check');
console.log('==================');
for (const f of FIXTURES) {
  const got = hejiLabel(f.q, f.r, f.mode);
  const ok = got === f.label;
  const status = ok ? 'OK ' : 'FAIL';
  console.log(`[${status}] mode=${f.mode} (q=${f.q}, r=${f.r})  expected=${JSON.stringify(f.label)}  got=${JSON.stringify(got)}  — ${f.note}`);
  if (!ok) failed++;
}
console.log('==================');
if (failed === 0) {
  console.log('All fixtures pass.');
  process.exit(0);
} else {
  console.log(`${failed} fixture(s) failed.`);
  process.exit(1);
}
