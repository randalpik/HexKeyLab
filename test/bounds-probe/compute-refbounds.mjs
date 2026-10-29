// Valid-ref-bounds probe for HKL.
//
// Computes the static set of (q, r) reference-note candidates that pass the
// ±3-accidental check across the full 88-cell picker footprint, one bucket
// per banding × note-name mapping × tuning mode (each mapping's cells in its own frame:
// every MAPPINGS value — docs/architecture.md → Note-name mapping). Tuning modes:
//   • 'E' — Equal (12-TET; jiRatio identical to Ptolemaic when there are
//          no region shifts).
//   • '5' — Ptolemaic (5-limit JI base).
//   • 'P' — Pythagorean (qm=1 +SC, qm=2 −SC).
//   • 'D' — Semiditonal (qm=2 −SC only).
//   • '7' — Septimal (qm=2 B-region: −SC + 63/64).
//   • 'V' — Schismatic (qm=2 −SC, plus one schisma per band along Q).
//   • 'S' / 'Y' — Syntonic / Polysyntonic (Pythagorean bands shifted by whole
//          syntonic commas around the home band; each candidate ref is its
//          own home band).
//
// Emits apps/hkl/src/render/refbounds-table.ts. Re-run when the picker
// (apps/hkl/src/tuning/picker.ts), the tuning (coordExps), spelling (noteName)
// or the ±3-accidental rule in validateRefNoteCandidate changes, or the scan
// range (VALID_REF_SCAN_R_*) changes.
//
// Run:
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/bounds-probe/compute-refbounds.mjs
//
// The picker, tuning and spelling are the real modules (imported through the
// TS loader), not copies; only the validation loop and scan live here.

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { TUNING_MODES, anchorOf } from '../../packages/shared/src/freq.ts';
import { noteName, parseNote, accToVal } from '../../packages/shared/src/notes.ts';
import { MAPPINGS, COLUMN_STEP } from '../../packages/shared/src/mapping.ts';
import { pianoFootprint } from '../../apps/hkl/src/tuning/picker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

// ── picker + spelling: the real modules ───────────────────────────────────
/* column step in semitones: a major third (Euler), a whole tone (Wicki-Hayden),
   a semitone (chromatic) */
const colStep = (mapping) => COLUMN_STEP[mapping];

/* A candidate ref is ranked as its own home band (Syntonic / Polysyntonic),
   as a Ctrl+click would make it — validateRefNoteCandidate does the same. */
function pianoCells(refQ, refR, mode, mapping, banded) {
  return pianoFootprint(refQ, refR, {
    mode, mapping, anchor: anchorOf(refQ, mapping), banded,
    equalEnabled: mode === 'E', septimalEnabled: mode === '7', septimalW: 3,
  });
}

// ── validation (mirrors validRefForState in src/render/draw.ts) ────────────
const VALID_REF_SCAN_R_MIN = -25, VALID_REF_SCAN_R_MAX = 25;

function bandQRange(r, mapping) {
  /* 21 ≤ 57 + c·q + 7r ≤ 108  ↔  q ∈ [(−36 − 7r)/c, (51 − 7r)/c] */
  const c = colStep(mapping);
  return [Math.ceil((-36 - 7 * r) / c), Math.floor((51 - 7 * r) / c)];
}

function validRef(q, r, mode, mapping, banded) {
  const midi = 57 + colStep(mapping) * q + 7 * r;
  if (midi < 21 || midi > 108) return false;
  const cells = pianoCells(q, r, mode, mapping, banded);
  for (const [cq, cr] of cells) {
    if (Math.abs(accToVal(parseNote(noteName(cq, cr, mapping, anchorOf(q, mapping), banded)).acc)) > 3) return false;
  }
  return true;
}

function scanValid(mode, mapping, banded) {
  const cells = [];
  for (let r = VALID_REF_SCAN_R_MIN; r <= VALID_REF_SCAN_R_MAX; r++) {
    const [qLo, qHi] = bandQRange(r, mapping);
    for (let q = qLo; q <= qHi; q++) {
      if (validRef(q, r, mode, mapping, banded)) cells.push([q, r]);
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
  'S': 'Syntonic',
  'Y': 'Polysyntonic',
};

const BANDINGS = [['banded', true], ['unbanded', false]];

console.time('probe');
const cellsByMode = {};
for (const [b, banded] of BANDINGS) {
  cellsByMode[b] = {};
  for (const map of MAPPINGS) {
    cellsByMode[b][map] = {};
    for (const m of TUNING_MODES) {
      cellsByMode[b][map][m] = scanValid(m, map, banded);
      console.log(`${b} ${map} ${m} (${MODE_DESC[m]}): ${cellsByMode[b][map][m].length} valid refs`);
    }
  }
}
console.timeEnd('probe');

const bucketBlocks = BANDINGS.map(([b]) => `  ${b}: {
${MAPPINGS.map((map) => `    ${map}: {
${TUNING_MODES.map((m) => `      '${m}': [
${fmtCellsByRow(cellsByMode[b][map][m]).replace(/^    /gm, '        ')}
      ],`).join('\n')}
    },`).join('\n')}
  },`).join('\n');

const out = `// Precomputed valid-reference-note coordinate sets per banding × mapping × tuning mode.
//
// GENERATED by test/bounds-probe/compute-refbounds.mjs — DO NOT EDIT BY HAND.
//
// One bucket per banding (banded / unbanded: docs/architecture.md → Unbanded
// layout) × note-name mapping (euler / wickiHayden / chromatic, each in its own
// coordinate frame) × TuningMode value (Equal / Ptolemaic / Pythagorean /
// Semiditonal / Septimal / Schismatic / Syntonic / Polysyntonic). Each bucket lists the (q, r) cells
// whose 88-cell piano footprint spells with ≤ ±3 accidentals under that
// mode's region rules. src/render/draw.ts rebuilds the Set<KeyId> and
// outline polygons from this table at module load. Re-run the probe when:
//   • apps/hkl/src/tuning/picker.ts (the piano-footprint ranking) changes,
//   • coordExps (per-mode tuning) or noteName (spelling) changes,
//   • the ±3-accidental rule in validateRefNoteCandidate changes, or
//   • the scan range in test/bounds-probe/compute-refbounds.mjs changes.

import type { Mapping, TuningMode } from '../state/persistence.js';
import type { Banding } from '../state/tuning.js';

export const VALID_REF_TABLE: Record<Banding, Record<Mapping, Record<TuningMode, ReadonlyArray<readonly [number, number]>>>> = {
${bucketBlocks}
};
`;

const outPath = join(REPO, 'apps/hkl/src/render/refbounds-table.ts');
writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length} bytes)`);
