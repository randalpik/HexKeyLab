// Octave-consistency check for Tenney-Height-based enharmonic spelling.
//
// For each MIDI N, the piano resolver picks the lattice cell (q, r) with
// lowest Tenney height to refNote. That choice MUST be octave-consistent:
// if MIDI N picks (q, r), then MIDI N+12 must pick (q+3, r). Otherwise the
// "canonical" spelling for a given pitch class drifts as the octave changes
// — which is musically wrong and visually disruptive in the piano outline.
//
// This script verifies that the TH calculation in src/tuning/ratios.ts
// produces octave-consistent picks across the full 88-key MIDI range.
//
// Run:
//   node tools/bounds-probe/octave-consistency.mjs
//
// History: an earlier version of tenneyHeightFromExps did NOT apply octave +
// complement reduction, so |e₂| asymmetry across octaves caused 5/76 pairs
// to flip in 5-limit (more in 7-limit). The fix was to apply
//   ratio → ratio / 2^floor(log₂ ratio)       (octave-reduce to [1, 2))
//   if log₂(reduced) > 0.5: ratio → 2/ratio   (complement-reduce to [1, √2])
// before measuring TH. This script is the regression test for that fix.

const bandOf = (q) => Math.floor((q + 1) / 3);
const posInBand = (q) => (((q + 1) % 3) + 3) % 3;
const septimalW = 3;

function regionInfo(q, r, septimalShift, septimalEnabled) {
  if (!septimalEnabled) return { aDepth: 0, aUpper: false, type: 'A' };
  const bi = Math.floor((r - septimalShift) / septimalW);
  const isB = (bi & 1) !== 0;
  const aBI = isB ? bi + 1 : bi;
  return { type: isB ? 'B' : 'A', aDepth: Math.abs(aBI) / 2, aUpper: aBI > 0 };
}

function jiExps(q1, r1, q2, r2, septimalShift, septimalEnabled) {
  const db = bandOf(q2) - bandOf(q1), dp = posInBand(q2) - posInBand(q1), dr = r2 - r1;
  let e2 = db - 2 * dp - dr, e3 = dr, e5 = dp, e7 = 0;
  if (septimalEnabled) {
    const ri1 = regionInfo(q1, r1, septimalShift, true);
    const ri2 = regionInfo(q2, r2, septimalShift, true);
    const applyAdj = (ri, sign) => {
      if (ri.aDepth > 0) {
        const d = ri.aDepth;
        if (ri.aUpper) { e2 += sign * 4 * d; e5 += sign * d; e3 += sign * (-4) * d; }
        else { e3 += sign * 4 * d; e2 += sign * (-4) * d; e5 += sign * (-d); }
      }
      if (ri.type === 'B') { e7 += sign; e3 += sign * 2; e2 += sign * (-6); }
    };
    applyAdj(ri2, +1);
    applyAdj(ri1, -1);
  }
  return [e2, e3, e5, e7];
}

/** TH without reduction — the BUG variant. Kept for comparison. */
function tenneyUnreduced(e) {
  return Math.abs(e[0]) + Math.abs(e[1]) * Math.log2(3) + Math.abs(e[2]) * Math.log2(5) + Math.abs(e[3]) * Math.log2(7);
}

/** TH with octave + complement reduction — matches tenneyHeightFromExps in
 *  src/tuning/ratios.ts. */
function tenneyReduced(e) {
  const log2r = e[0] + e[1] * Math.log2(3) + e[2] * Math.log2(5) + e[3] * Math.log2(7);
  const oct = Math.floor(log2r);
  let r0 = e[0] - oct, r1 = e[1], r2 = e[2], r3 = e[3];
  if (log2r - oct > 0.5) { r0 = 1 - r0; r1 = -r1; r2 = -r2; r3 = -r3; }
  return Math.abs(r0) + Math.abs(r1) * Math.log2(3) + Math.abs(r2) * Math.log2(5) + Math.abs(r3) * Math.log2(7);
}

/** Tiebreak strategies for equal-TH candidates.
 *  'syntonic' (default, matches production) — pick candidate with larger
 *    7·(q−refQ) − 4·(r−refR). Octave-invariant: octave shift (+3q, 0r) adds
 *    21 to projection while syntonic-comma shift (±7q, ∓4r) adds ±65, so the
 *    larger-projection candidate is preserved across octaves.
 *  'taxicab' (--taxicab) — historical rule. NOT octave-invariant. Kept for
 *    regression diagnosis. */
const TIEBREAK = process.argv.includes('--taxicab') ? 'taxicab' : 'syntonic';

function pickCell(midi, refQ, refR, septimalShift, septimalEnabled, thFn) {
  const N = midi - 57;
  const q0 = (((2 * N) % 7) + 7) % 7;
  let bestQ = 0, bestR = 0, bestTh = Infinity, bestTie = Infinity, found = false;
  for (let k = -20; k <= 20; k++) {
    const q = q0 + 7 * k;
    const r = (N - 4 * q) / 7;
    const th = thFn(jiExps(refQ, refR, q, r, septimalShift, septimalEnabled));
    const tie = TIEBREAK === 'syntonic'
      ? -(7 * (q - refQ) - 4 * (r - refR))  // larger projection wins → negate so smaller comparator wins
      : Math.abs(q - refQ) + Math.abs(r - refR);
    if (!found || th < bestTh || (th === bestTh && tie < bestTie)) {
      bestTh = th; bestTie = tie; bestQ = q; bestR = r; found = true;
    }
  }
  return [bestQ, bestR];
}

const pcNames = ['A','Bb','B','C','C#','D','Eb','E','F','F#','G','Ab'];

function check(label, thFn, septimalEnabled) {
  let bad = 0, total = 0;
  const breaks = [];
  for (let refQ of [0, 1, 2]) {
    const sShifts = septimalEnabled ? [-21, -10, 0, 10, 20] : [0];
    for (const s of sShifts) {
      for (let midi = 21; midi <= 96; midi++) {
        const a = pickCell(midi, refQ, 0, s, septimalEnabled, thFn);
        const b = pickCell(midi + 12, refQ, 0, s, septimalEnabled, thFn);
        total++;
        if (b[0] !== a[0] + 3 || b[1] !== a[1]) {
          bad++;
          if (breaks.length < 6) {
            const pc = ((midi - 57) % 12 + 12) % 12;
            breaks.push(`MIDI ${midi}→${midi+12} (${pcNames[pc]}) refQ=${refQ}${septimalEnabled?` s=${s}`:''}: (${a[0]},${a[1]}) vs (${b[0]},${b[1]})`);
          }
        }
      }
    }
  }
  console.log(`${label}: ${bad}/${total} octave-pairs inconsistent`);
  for (const b of breaks) console.log(`  ${b}`);
  if (breaks.length < bad) console.log(`  ... ${bad - breaks.length} more`);
  return bad;
}

console.log('Octave-consistency: does MIDI N+12 pick (q+3, r) when MIDI N picks (q, r)?\n');
console.log('--- 5-limit (septimalEnabled=false) ---');
const bad5old = check('OLD (unreduced TH)', tenneyUnreduced, false);
const bad5new = check('REDUCED TH       ', tenneyReduced, false);
console.log('\n--- 7-limit (septimalEnabled=true), sweeping septimalShift ∈ {-21, -10, 0, 10, 20} ---');
const bad7old = check('OLD (unreduced TH)', tenneyUnreduced, true);
const bad7new = check('REDUCED TH       ', tenneyReduced, true);

console.log('\n--- result ---');
if (bad5new === 0 && bad7new === 0) {
  console.log('✓ Reduced TH is octave-consistent (regression test PASSES).');
  process.exit(0);
} else {
  console.log(`✗ Reduced TH has ${bad5new + bad7new} inconsistencies — regression!`);
  process.exit(1);
}
