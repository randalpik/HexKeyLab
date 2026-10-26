// Valid-ref-bounds probe for HKL.
//
// Computes the static set of (q, r) reference-note candidates that pass the
// ±3-accidental check across the full 88-cell picker footprint, one bucket
// per note-name mapping × tuning mode (each mapping's cells in its own frame:
// 'euler', and 'wickiHayden' — docs/wicki-hayden-spec.md). Tuning modes:
//   • 'E' — Equal (12-TET; jiRatio identical to Ptolemaic when there are
//          no region shifts).
//   • '5' — Ptolemaic (5-limit JI base).
//   • 'P' — Pythagorean (qm=1 +SC, qm=2 −SC).
//   • 'D' — Semiditonal (qm=2 −SC only).
//   • '7' — Septimal (qm=2 B-region: −SC + 63/64).
//   • 'V' — Schismatic (qm=2 −SC, plus one schisma per band along Q).
//
// Emits apps/hkl/src/render/refbounds-table.ts. Re-run when:
//   • src/render/draw.ts compute88PianoCoords (picker / tiebreak) changes,
//   • src/tuning/ratios.ts (jiRatio / tenneyHeightFromExps) changes,
//   • src/tuning/regions.ts (region adjustments) changes,
//   • src/tuning/notes.ts (noteName / fifthName / accidental spelling) changes,
//   • the ±3-accidental rule in validateRefNoteCandidate changes, or
//   • the scan range (VALID_REF_SCAN_R_*) changes.
//
// Run:
//   node test/bounds-probe/compute-refbounds.mjs
//
// All math here mirrors src/{tuning,render}/* — the inlined copies MUST stay
// in sync. compute-bounds.mjs has its own copy of the picker; if you change
// compute88PianoCoords, update both probes.

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const TUNING_MODES = ['E', '5', 'P', 'D', '7', 'V'];
const MAPPINGS = ['euler', 'wickiHayden'];

// ── mapping (mirrors packages/shared/src/mapping.ts) ───────────────────────
/* A Wicki-Hayden cell's Euler-equivalent: even column Q is Euler column Q/2;
   odd column Q (a copy of column (Q−1)/2, 2 cells down + an exact octave
   down) is ((Q−1)/2 − 3, R+2) — same name, octave and nominal MIDI, and the
   same pitch except a Schismatic copy, one schisma higher. */
function eulerOf(q, r, mapping) {
  if (mapping === 'euler') return { q, r, copy: false };
  const k = Math.floor(q / 2);
  return q === 2 * k ? { q: k, r, copy: false } : { q: k - 3, r: r + 2, copy: true };
}
/* column step in semitones: a major third (Euler), a whole tone (Wicki-Hayden) */
const colStep = (mapping) => (mapping === 'wickiHayden' ? 2 : 4);

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
    case 'D':
    case 'V':
      return qm === 2 ? A_D1_UPPER : A_D0;
    case 'P':
      return qm === 2 ? A_D1_UPPER : qm === 1 ? A_D1_LOWER : A_D0;
    case '7':
      return qm === 2 ? B_D1_UPPER : A_D0;
    default:
      throw new Error('unknown mode: ' + mode);
  }
}

function modeHasShifts(mode) {
  return mode === 'P' || mode === 'D' || mode === '7' || mode === 'V';
}

function jiExps(q1, r1, q2, r2, mode, mapping) {
  const c1 = eulerOf(q1, r1, mapping), c2 = eulerOf(q2, r2, mapping);
  const e = eulerJiExps(c1.q, c1.r, c2.q, c2.r, mode);
  if (mode === 'V') {
    const ds = (c2.copy ? 1 : 0) - (c1.copy ? 1 : 0);
    e[0] += ds * -15; e[1] += ds * 8; e[2] += ds;
  }
  return e;
}

function eulerJiExps(q1, r1, q2, r2, mode) {
  const db = bandOf(q2) - bandOf(q1), dp = posInBand(q2) - posInBand(q1), dr = r2 - r1;
  let e2 = db - 2 * dp - dr, e3 = dr, e5 = dp, e7 = 0;
  if (modeHasShifts(mode)) {
    const ri1 = regionInfo(q1, r1, mode);
    const ri2 = regionInfo(q2, r2, mode);
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
  /* Schismatic: every Δband adds one schisma (32805:32768 = 3^8·5/2^15)
     on top of the standard Pythagorean stack. Matches the V-mode branch in
     src/tuning/ratios.ts:jiRatioWithState. */
  if (mode === 'V') {
    const db = bandOf(q2) - bandOf(q1);
    if (db !== 0) { e2 += db * -15; e3 += db * 8; e5 += db * 1; }
  }
  return [e2, e3, e5, e7];
}

function tenney(e) {
  const log2r = e[0] + e[1] * Math.log2(3) + e[2] * Math.log2(5) + e[3] * Math.log2(7);
  const oct = Math.floor(log2r);
  let r0 = e[0] - oct, r1 = e[1], r2 = e[2], r3 = e[3];
  if (log2r - oct > 0.5) { r0 = 1 - r0; r1 = -r1; r2 = -r2; r3 = -r3; }
  return Math.abs(r0) + Math.abs(r1) * Math.log2(3) + Math.abs(r2) * Math.log2(5) + Math.abs(r3) * Math.log2(7);
}

/** Mirrors compute88PianoCoords in src/render/draw.ts.
 *  V-mode picker substitution: runs JI math under Semiditonal ('D') rules
 *  so the schisma exponent doesn't inflate (3k, 0) lineage TH. The picker's
 *  job is to assign (q, r) cells to MIDIs by spelling/topology, not by V's
 *  audible schisma stack — freqAt still uses V's SCHISMA^b factor at
 *  playback. See the docstring on compute88PianoCoords for the full
 *  rationale. */
function pianoCells(refQ, refR, mode, mapping) {
  const pickerMode = mode === 'V' ? 'D' : mode;
  const c = colStep(mapping), inv = c === 4 ? 2 : 4, K = mapping === 'wickiHayden' ? 40 : 20;
  const PROJ_PER_OCT = 7 * (12 / c);
  const refMidi = 57 + c * refQ + 7 * refR;
  const cells = [];
  for (let midi = 21; midi <= 108; midi++) {
    const N = midi - 57;
    const q0 = (((inv * N) % 7) + 7) % 7;
    let bestQ = q0, bestR = (N - c * q0) / 7;
    let bestTh = Infinity, bestAbsNProj = Infinity, found = false;
    const projTarget = PROJ_PER_OCT * Math.round((midi - refMidi) / 12);
    for (let k = -K; k <= K; k++) {
      const q = q0 + 7 * k;
      const r = (N - c * q) / 7;
      const th = tenney(jiExps(refQ, refR, q, r, pickerMode, mapping));
      const absNProj = Math.abs(7 * (q - refQ) - c * (r - refR) - projTarget);
      if (!found || th < bestTh || (th === bestTh && absNProj < bestAbsNProj)) {
        bestTh = th; bestAbsNProj = absNProj; bestQ = q; bestR = r; found = true;
      }
    }
    cells.push([bestQ, bestR]);
  }
  return cells;
}

// ── note naming (mirrors src/tuning/notes.ts) ──────────────────────────────
const letterSemi = { A: 0, B: 2, C: 3, D: 5, E: 7, F: 8, G: 10 };

function accToVal(a) {
  let v = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '#') v++;
    else if (a[i] === 'b') v--;
  }
  return v;
}

function valToAcc(v) {
  if (v === 0) return '';
  return (v > 0 ? '#' : 'b').repeat(Math.abs(v));
}

function parseNote(n) { return { letter: n[0], acc: n.slice(1) }; }

function m3up(n) {
  const p = parseNote(n);
  const L = 'ABCDEFG';
  const i = L.indexOf(p.letter);
  const nl = L[(i + 2) % 7];
  const nat = (letterSemi[nl] - letterSemi[p.letter] + 12) % 12;
  const nv = 4 - nat + accToVal(p.acc);
  return nl + valToAcc(nv);
}

function m3dn(n) {
  const p = parseNote(n);
  const L = 'ABCDEFG';
  const i = L.indexOf(p.letter);
  const nl = L[((i - 2) % 7 + 7) % 7];
  const nat = (letterSemi[p.letter] - letterSemi[nl] + 12) % 12;
  const nv = -(4 - nat) + accToVal(p.acc);
  return nl + valToAcc(nv);
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

function noteName(q, r, mapping) {
  ({ q, r } = eulerOf(q, r, mapping));
  const fn = fifthName(r);
  const pos = ((q + 1) % 3 + 3) % 3;
  if (pos === 1) return fn;
  if (pos === 2) return m3up(fn);
  return m3dn(fn);
}

// ── validation (mirrors validRefForState in src/render/draw.ts) ────────────
const VALID_REF_SCAN_R_MIN = -25, VALID_REF_SCAN_R_MAX = 25;

function bandQRange(r, mapping) {
  /* 21 ≤ 57 + c·q + 7r ≤ 108  ↔  q ∈ [(−36 − 7r)/c, (51 − 7r)/c] */
  const c = colStep(mapping);
  return [Math.ceil((-36 - 7 * r) / c), Math.floor((51 - 7 * r) / c)];
}

function validRef(q, r, mode, mapping) {
  const midi = 57 + colStep(mapping) * q + 7 * r;
  if (midi < 21 || midi > 108) return false;
  const cells = pianoCells(q, r, mode, mapping);
  for (const [cq, cr] of cells) {
    if (Math.abs(accToVal(parseNote(noteName(cq, cr, mapping)).acc)) > 3) return false;
  }
  return true;
}

function scanValid(mode, mapping) {
  const cells = [];
  for (let r = VALID_REF_SCAN_R_MIN; r <= VALID_REF_SCAN_R_MAX; r++) {
    const [qLo, qHi] = bandQRange(r, mapping);
    for (let q = qLo; q <= qHi; q++) {
      if (validRef(q, r, mode, mapping)) cells.push([q, r]);
    }
  }
  return cells;
}

// ── output ─────────────────────────────────────────────────────────────────
function fmtCellsByRow(cells) {
  const byR = new Map();
  for (const [q, r] of cells) {
    if (!byR.has(r)) byR.set(r, []);
    byR.get(r).push(q);
  }
  const rs = [...byR.keys()].sort((a, b) => a - b);
  return rs.map((r) => {
    const qs = byR.get(r).sort((a, b) => a - b);
    return '    ' + qs.map((q) => `[${q}, ${r}]`).join(', ') + ',';
  }).join('\n');
}

const MODE_DESC = {
  'E': 'Equal (12-TET)',
  '5': 'Ptolemaic (5-limit base)',
  'P': 'Pythagorean',
  'D': 'Semiditonal',
  '7': 'Septimal (uniform)',
  'V': 'Schismatic',
};

console.time('probe');
const cellsByMode = {};
for (const map of MAPPINGS) {
  cellsByMode[map] = {};
  for (const m of TUNING_MODES) {
    cellsByMode[map][m] = scanValid(m, map);
    console.log(`${map} ${m} (${MODE_DESC[m]}): ${cellsByMode[map][m].length} valid refs`);
  }
}
console.timeEnd('probe');

const bucketBlocks = MAPPINGS.map((map) => `  ${map}: {
${TUNING_MODES.map((m) => `    '${m}': [
${fmtCellsByRow(cellsByMode[map][m]).replace(/^    /gm, '      ')}
    ],`).join('\n')}
  },`).join('\n');

const out = `// Precomputed valid-reference-note coordinate sets per mapping × tuning mode.
//
// GENERATED by test/bounds-probe/compute-refbounds.mjs — DO NOT EDIT BY HAND.
//
// One bucket per note-name mapping (euler / wickiHayden, each in its own
// coordinate frame) × TuningMode value (Equal / Ptolemaic / Pythagorean /
// Semiditonal / Septimal / Schismatic). Each bucket lists the (q, r) cells
// whose 88-cell piano footprint spells with ≤ ±3 accidentals under that
// mode's region rules. src/render/draw.ts rebuilds the Set<KeyId> and
// outline polygons from this table at module load. Re-run the probe when:
//   • src/render/draw.ts compute88PianoCoords changes,
//   • src/tuning/ratios.ts or src/tuning/regions.ts changes,
//   • src/tuning/notes.ts (accidental spelling) changes,
//   • the ±3-accidental rule in validateRefNoteCandidate changes, or
//   • the scan range in test/bounds-probe/compute-refbounds.mjs changes.

import type { Mapping, TuningMode } from '../state/persistence.js';

export const VALID_REF_TABLE: Record<Mapping, Record<TuningMode, ReadonlyArray<readonly [number, number]>>> = {
${bucketBlocks}
};
`;

const outPath = join(REPO, 'apps/hkl/src/render/refbounds-table.ts');
writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length} bytes)`);
