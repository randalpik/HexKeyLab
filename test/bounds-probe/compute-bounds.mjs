// Canvas-bounds probe for HKL.
//
// Computes the bounding box the canvas needs for every (rotation × outline)
// pair, and emits the kbMinW × CH metrics used by src/render/canvas.ts'
// recomputeCanvasBounds(). Run when:
//   • a new rotation is added,
//   • a new outline mode is added,
//   • the lattice geometry (hexR, dxH, dyH, tilt angles) is changed,
//   • the piano-footprint picker (apps/hkl/src/tuning/picker.ts) or the
//     per-mode tuning (coordExps) changes.
//
// Run:
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/bounds-probe/compute-bounds.mjs
//
// Every piano bound is computed per note-name mapping (every MAPPINGS value,
// docs/architecture.md → Note-name mapping): the mapping changes the picker's
// candidate cells and the verticalFreq tilt.
//
// The picker is the real module (imported through the TS loader). The script
// inlines the lattice math from src/layout/geometry.ts and the canvas-metrics
// formula from src/render/canvas.ts. baseKeys is parsed
// directly from src/layout/baseKeys.ts so additions/removals there don't
// require updating this script. The other inlined constants (qwertyKeys
// row spec, hex/dx/dy, tilt angles) MUST stay in sync manually — review
// the imports list when src/ changes.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { TUNING_MODES, anchorOf } from '../../packages/shared/src/freq.ts';
import { MAPPINGS, COLUMN_STEP, bandWidth } from '../../packages/shared/src/mapping.ts';
import { pianoFootprint } from '../../apps/hkl/src/tuning/picker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

// ── geometry (mirrors src/layout/geometry.ts) ──────────────────────────────
const hexR = 16;
const dxH = hexR * 1.78;
const dyH = hexR * 1.54;

/* qStep = average log-frequency per q step: log(2)·COLUMN_STEP/12 (log(2)/3 Euler,
   /6 Wicki-Hayden, /12 chromatic) */
function verticalFreqTilt(qStep) {
  const avgR = Math.log(3 / 2) - Math.log(81 / 80) / 12;
  const gx = qStep / dxH;
  const gy = (avgR - qStep / 2) / dyH;
  return Math.PI / 2 - Math.atan2(gy, gx);
}
const TILT_LUMATONE = Math.atan(dyH / (3 * dxH));
const TILT_PIANO = 0;

const ROTATIONS = Object.fromEntries(MAPPINGS.map((m) => [m,
  { verticalFreq: verticalFreqTilt(Math.log(2) * COLUMN_STEP[m] / 12), lumatone: TILT_LUMATONE, piano: TILT_PIANO }]));

/* Mirrors the actual rendering transform (src/render/draw.ts main draw
   loop). */
function hexToScreen(q, r, tilt) {
  const ux = q * dxH + r * dxH * 0.5;
  const uy = -r * dyH;
  const c = Math.cos(tilt), s = Math.sin(tilt);
  return { sx: ux * c + uy * s, sy: -ux * s + uy * c };
}

// ── cell sets ──────────────────────────────────────────────────────────────
const baseKeysRaw = readFileSync(join(REPO, 'apps/hkl/src/layout/baseKeys.ts'), 'utf8');
const baseKeysMatch = baseKeysRaw.match(/export const baseKeys[^=]+=\s*(\[\[.*?\]\]);/s);
if (!baseKeysMatch) throw new Error('Could not parse baseKeys from src/layout/baseKeys.ts — file format changed?');
const baseKeys = JSON.parse(baseKeysMatch[1]);

// QWERTY keys — manually mirrors src/input/qwerty.ts row spec
const qwertyRows = [
  { qStart: -7, r: 2, len: 12 },
  { qStart: -6, r: 1, len: 12 },
  { qStart: -5, r: 0, len: 11 },
  { qStart: -4, r: -1, len: 10 },
];
const qwertyKeys = [];
for (const row of qwertyRows) {
  for (let i = 0; i < row.len; i++) qwertyKeys.push([row.qStart + i, row.r]);
}

// ── picker: the real module ────────────────────────────────────────────────

/* Each probed ref is ranked as its own home band (Syntonic / Polysyntonic; every
   mode unbanded). One band of refs covers every case in both layouts: a ref one
   band over sees the same relative layout. */
function pianoCells(refQ, refR, mode = '5', mapping = 'euler', banded = true) {
  return pianoFootprint(refQ, refR, {
    mode, mapping, anchor: anchorOf(refQ, mapping), banded,
    equalEnabled: mode === 'E', septimalEnabled: mode === '7', septimalW: 3,
  });
}

// ── per-outline cell sets ──────────────────────────────────────────────────
// Lumatone and QWERTY outlines are statically positioned (the lattice slides
// underneath via refSpine); their bounds come straight from baseKeys /
// qwertyKeys. Piano outline cells are picked per-ref via the picker; we
// union across a small refQ × refR neighborhood so the canvas fits any
// reachable ref.

function lumatonePoints(tilt) {
  return baseKeys.map(([q, r]) => hexToScreen(q, r, tilt));
}

function qwertyPoints(tilt) {
  return qwertyKeys.map(([q, r]) => hexToScreen(q, r, tilt));
}

function pianoViewCenter(refQ, refR, m64Q, m64R, tilt) {
  // Solve for (viewQ, viewR) such that hexToScreen places refNote at
  // sx=0 (horizontal center) and MIDI 64's cell at sy=0 (vertical
  // center). 2×2 linear system in lattice coords; determinant
  // A·D − B·C = −dxH·dyH is tilt-independent.
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const A = dxH * c;
  const B = dxH * 0.5 * c - dyH * s;
  const C = -dxH * s;
  const D = -dxH * 0.5 * s - dyH * c;
  const rhsX = A * refQ + B * refR;
  const rhsY = C * m64Q + D * m64R;
  const det = A * D - B * C;
  return [
    (D * rhsX - B * rhsY) / det,
    (-C * rhsX + A * rhsY) / det,
  ];
}

function pianoPoints(tilt, mode, mapping, banded) {
  const pts = [];
  const REFR_MIN = -3, REFR_MAX = 3;
  function accum(cells, refQ, refR) {
    const m = cells[64 - 21];  // MIDI 64 = E4 = cell index 43
    const [vQ, vR] = pianoViewCenter(refQ, refR, m[0], m[1], tilt);
    for (const [q, r] of cells) pts.push(hexToScreen(q - vQ, r - vR, tilt));
  }
  /* every column position of an octave band: 3 Euler, 6 Wicki-Hayden, 12 chromatic */
  for (let refQ = 0; refQ < bandWidth(mapping); refQ++) {
    for (let refR = REFR_MIN; refR <= REFR_MAX; refR++) {
      accum(pianoCells(refQ, refR, mode, mapping, banded), refQ, refR);
    }
  }
  return pts;
}

function nonePoints(tilt, mode, mapping, banded) {
  return [...lumatonePoints(tilt), ...qwertyPoints(tilt), ...pianoPoints(tilt, mode, mapping, banded)];
}

const OUTLINE_GENERATORS = {
  lumatone: (tilt) => lumatonePoints(tilt),
  qwerty: (tilt) => qwertyPoints(tilt),
  piano: (tilt, mode, mapping, banded) => pianoPoints(tilt, mode, mapping, banded),
  none: (tilt, mode, mapping, banded) => nonePoints(tilt, mode, mapping, banded),
};

// ── canvas metrics (mirrors src/render/canvas.ts) ──────────────────────────
function bbox(pts) {
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (const p of pts) {
    if (p.sx < mnx) mnx = p.sx;
    if (p.sx > mxx) mxx = p.sx;
    if (p.sy < mny) mny = p.sy;
    if (p.sy > mxy) mxy = p.sy;
  }
  return { minX: mnx, maxX: mxx, minY: mny, maxY: mxy };
}

function canvasMetrics(b) {
  const padY = hexR + dxH * 0.5;
  const padX = dxH * 1.5 + hexR;
  return {
    kbMinW: Math.ceil((Math.max(-b.minX, b.maxX) + padX) * 2),
    CH: Math.ceil(2 * Math.max(Math.abs(b.minY), Math.abs(b.maxY)) + 2 * padY),
    kbOffY: 0,
  };
}

// ── output ─────────────────────────────────────────────────────────────────
const outlines = ['lumatone', 'qwerty', 'piano', 'none'];
const rotationNames = ['verticalFreq', 'lumatone', 'piano'];

const MODE_LABEL = {
  'E': 'Equal',
  '5': 'Ptolemaic',
  'P': 'Pythagorean',
  'D': 'Semiditonal',
  '7': 'Septimal',
  'V': 'Schismatic',
  'S': 'Syntonic',
  'Y': 'Polysyntonic',
};

function printMatrix(mode, mapping, banded, label) {
  console.log(`\n${label} — kbMinW × CH (kbOffY=0):\n`);
  const colW = 15;
  console.log('              ' + outlines.map((o) => o.padEnd(colW)).join(''));
  console.log('              ' + outlines.map(() => '─'.repeat(colW)).join(''));
  for (const rotName of rotationNames) {
    const tilt = ROTATIONS[mapping][rotName];
    let row = rotName.padEnd(14);
    for (const outline of outlines) {
      const m = canvasMetrics(bbox(OUTLINE_GENERATORS[outline](tilt, mode, mapping, banded)));
      row += `${m.kbMinW}×${m.CH}`.padEnd(colW);
    }
    console.log(row);
  }
}

/* Collect piano metrics so we can emit the PIANO_BOUNDS_TABLE block ready
   to paste into src/render/canvas.ts. Lumatone/QWERTY are mode-independent
   for canvas extent (the only tuning-sensitive outline is piano). */
const BANDINGS = [['banded', true], ['unbanded', false]];
const pianoMetrics = {};
for (const [b, banded] of BANDINGS) {
  pianoMetrics[b] = {};
  for (const mapping of MAPPINGS) {
    pianoMetrics[b][mapping] = {};
    for (const mode of TUNING_MODES) {
      pianoMetrics[b][mapping][mode] = {};
      for (const rotName of rotationNames) {
        const tilt = ROTATIONS[mapping][rotName];
        pianoMetrics[b][mapping][mode][rotName] = canvasMetrics(bbox(OUTLINE_GENERATORS.piano(tilt, mode, mapping, banded)));
      }
    }
  }
}

for (const [b, banded] of BANDINGS) {
  for (const mapping of MAPPINGS) {
    for (const mode of TUNING_MODES) {
      printMatrix(mode, mapping, banded, `${b} ${mapping} ${mode} — ${MODE_LABEL[mode]}`);
    }
  }
}

console.log('\nPIANO_BOUNDS_TABLE block for apps/hkl/src/render/canvas.ts:\n');
console.log('const PIANO_BOUNDS_TABLE: Record<Banding, Record<Mapping, Record<RotationMode, Record<TuningMode, CanvasMetrics>>>> = {');
for (const [b] of BANDINGS) {
  console.log(`  ${b}: {`);
  for (const mapping of MAPPINGS) {
    console.log(`    ${mapping}: {`);
    for (const rotName of rotationNames) {
      const entries = TUNING_MODES.map((m) => {
        const x = pianoMetrics[b][mapping][m][rotName];
        return `        '${m}': { kbMinW: ${x.kbMinW}, CH: ${x.CH} }`;
      }).join(',\n');
      console.log(`      ${rotName}: {\n${entries},\n      },`);
    }
    console.log('    },');
  }
  console.log('  },');
}
console.log('};');

console.log('\nPiano cell span relative to refNote (sanity check, refR=0, Euler):');
for (const mode of TUNING_MODES) {
  console.log(`  ${MODE_LABEL[mode]} (per refQ ∈ {0,1,2}):`);
  for (let refQ = 0; refQ <= 2; refQ++) {
    const pc = pianoCells(refQ, 0, mode);
    const rel = pc.map(([q, r]) => [q - refQ, r]);
    const qs = rel.map((c) => c[0]), rs = rel.map((c) => c[1]);
    console.log(`    refQ=${refQ}  q ∈ [${Math.min(...qs)}, ${Math.max(...qs)}]  r ∈ [${Math.min(...rs)}, ${Math.max(...rs)}]`);
  }
}
console.log('');
