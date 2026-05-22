// Canvas-bounds probe for HKL.
//
// Computes the bounding box the canvas needs for every (rotation × outline)
// pair, and emits the kbMinW × CH metrics used by src/render/canvas.ts'
// recomputeCanvasBounds(). Run when:
//   • a new rotation is added,
//   • a new outline mode is added,
//   • the lattice geometry (hexR, dxH, dyH, tilt angles) is changed,
//   • the Tenney-Height-ranking logic in src/tuning/ratios.ts changes,
//   • the uniform-septimal region rule in src/tuning/regions.ts changes.
//
// Run:
//   node tools/bounds-probe/compute-bounds.mjs
//
// The script inlines the lattice math from src/layout/geometry.ts, the
// jiRatio/regionInfo logic from src/tuning/{ratios,regions}.ts, and the
// canvas-metrics formula from src/render/canvas.ts. baseKeys is parsed
// directly from src/layout/baseKeys.ts so additions/removals there don't
// require updating this script. The other inlined constants (qwertyKeys
// row spec, hex/dx/dy, tilt angles) MUST stay in sync manually — review
// the imports list when src/ changes.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

// ── geometry (mirrors src/layout/geometry.ts) ──────────────────────────────
const hexR = 16;
const dxH = hexR * 1.78;
const dyH = hexR * 1.54;

const TILT_VERTICAL_FREQ = (function () {
  const avgR = Math.log(3 / 2) - Math.log(81 / 80) / 12;
  const gx = Math.log(2) / (3 * dxH);
  const gy = (avgR - Math.log(2) / 6) / dyH;
  return Math.PI / 2 - Math.atan2(gy, gx);
})();
const TILT_LUMATONE = Math.atan(dyH / (3 * dxH));
const TILT_PIANO = 0;

const ROTATIONS = {
  verticalFreq: TILT_VERTICAL_FREQ,
  lumatone: TILT_LUMATONE,
  piano: TILT_PIANO,
};

/* Mirrors the actual rendering transform (src/render/draw.ts main draw
   loop). */
function hexToScreen(q, r, tilt) {
  const ux = q * dxH + r * dxH * 0.5;
  const uy = -r * dyH;
  const c = Math.cos(tilt), s = Math.sin(tilt);
  return { sx: ux * c + uy * s, sy: -ux * s + uy * c };
}

// ── cell sets ──────────────────────────────────────────────────────────────
const baseKeysRaw = readFileSync(join(REPO, 'src/layout/baseKeys.ts'), 'utf8');
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

// ── tuning math (mirrors src/tuning/{ratios,regions}.ts) ───────────────────
const bandOf = (q) => Math.floor((q + 1) / 3);
const posInBand = (q) => (((q + 1) % 3) + 3) % 3;

/* Uniform septimal: qm=2 cells are B-d1-upper, all others A-d0. */
function regionInfo(q, _r, septimalEnabled) {
  if (!septimalEnabled) return { type: 'A', aDepth: 0, aUpper: false };
  const qm = ((q % 3) + 3) % 3;
  if (qm === 2) return { type: 'B', aDepth: 1, aUpper: true };
  return { type: 'A', aDepth: 0, aUpper: false };
}

function jiExps(q1, r1, q2, r2, septimalEnabled) {
  const db = bandOf(q2) - bandOf(q1), dp = posInBand(q2) - posInBand(q1), dr = r2 - r1;
  let e2 = db - 2 * dp - dr, e3 = dr, e5 = dp, e7 = 0;
  if (septimalEnabled) {
    const ri1 = regionInfo(q1, r1, true);
    const ri2 = regionInfo(q2, r2, true);
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

/** Octave + complement-reduced Tenney height. Mirrors tenneyHeightFromExps
 *  in src/tuning/ratios.ts (which uses the same exp-space reduction). */
function tenney(e) {
  const log2r = e[0] + e[1] * Math.log2(3) + e[2] * Math.log2(5) + e[3] * Math.log2(7);
  const oct = Math.floor(log2r);
  let r0 = e[0] - oct, r1 = e[1], r2 = e[2], r3 = e[3];
  if (log2r - oct > 0.5) { r0 = 1 - r0; r1 = -r1; r2 = -r2; r3 = -r3; }
  return Math.abs(r0) + Math.abs(r1) * Math.log2(3) + Math.abs(r2) * Math.log2(5) + Math.abs(r3) * Math.log2(7);
}

/** Mirrors compute88PianoCoords in src/render/draw.ts. */
function pianoCells(refQ, refR, septimalEnabled = false) {
  const PROJ_PER_OCT = 7 * 3 - 4 * 0;
  const refMidi = 57 + 4 * refQ + 7 * refR;
  const cells = [];
  for (let midi = 21; midi <= 108; midi++) {
    const N = midi - 57;
    const q0 = (((2 * N) % 7) + 7) % 7;
    let bestQ = q0, bestR = (N - 4 * q0) / 7;
    let bestTh = Infinity, bestAbsNProj = Infinity, found = false;
    const projTarget = PROJ_PER_OCT * Math.round((midi - refMidi) / 12);
    for (let k = -20; k <= 20; k++) {
      const q = q0 + 7 * k;
      const r = (N - 4 * q) / 7;
      const th = tenney(jiExps(refQ, refR, q, r, septimalEnabled));
      const absNProj = Math.abs(7 * (q - refQ) - 4 * (r - refR) - projTarget);
      if (!found || th < bestTh || (th === bestTh && absNProj < bestAbsNProj)) {
        bestTh = th; bestAbsNProj = absNProj; bestQ = q; bestR = r; found = true;
      }
    }
    cells.push([bestQ, bestR]);
  }
  return cells;
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

function pianoPoints(tilt, septimalEnabled) {
  const pts = [];
  const REFR_MIN = -3, REFR_MAX = 3;
  function accum(cells, refQ, refR) {
    const m = cells[64 - 21];  // MIDI 64 = E4 = cell index 43
    const [vQ, vR] = pianoViewCenter(refQ, refR, m[0], m[1], tilt);
    for (const [q, r] of cells) pts.push(hexToScreen(q - vQ, r - vR, tilt));
  }
  for (let refQ = 0; refQ <= 2; refQ++) {
    for (let refR = REFR_MIN; refR <= REFR_MAX; refR++) {
      accum(pianoCells(refQ, refR, septimalEnabled), refQ, refR);
    }
  }
  return pts;
}

function nonePoints(tilt, septimalEnabled) {
  return [...lumatonePoints(tilt), ...qwertyPoints(tilt), ...pianoPoints(tilt, septimalEnabled)];
}

const OUTLINE_GENERATORS = {
  lumatone: (tilt) => lumatonePoints(tilt),
  qwerty: (tilt) => qwertyPoints(tilt),
  piano: (tilt, septEnabled) => pianoPoints(tilt, septEnabled),
  none: (tilt, septEnabled) => nonePoints(tilt, septEnabled),
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

function printMatrix(septEnabled, label) {
  console.log(`\n${label} — kbMinW × CH (kbOffY=0):\n`);
  const colW = 15;
  console.log('              ' + outlines.map((o) => o.padEnd(colW)).join(''));
  console.log('              ' + outlines.map(() => '─'.repeat(colW)).join(''));
  for (const rotName of rotationNames) {
    const tilt = ROTATIONS[rotName];
    let row = rotName.padEnd(14);
    for (const outline of outlines) {
      const m = canvasMetrics(bbox(OUTLINE_GENERATORS[outline](tilt, septEnabled)));
      row += `${m.kbMinW}×${m.CH}`.padEnd(colW);
    }
    console.log(row);
  }
}
printMatrix(false, '5-limit / 12-TET');
printMatrix(true, '7-limit (uniform septimal)');

console.log('\nPiano cell span relative to refNote (sanity check, refR=0):');
console.log('  5-limit (per refQ ∈ {0,1,2}):');
for (let refQ = 0; refQ <= 2; refQ++) {
  const pc = pianoCells(refQ, 0, false);
  const rel = pc.map(([q, r]) => [q - refQ, r]);
  const qs = rel.map((c) => c[0]), rs = rel.map((c) => c[1]);
  console.log(`    refQ=${refQ}  q ∈ [${Math.min(...qs)}, ${Math.max(...qs)}]  r ∈ [${Math.min(...rs)}, ${Math.max(...rs)}]`);
}
console.log('  7-limit (per refQ ∈ {0,1,2}):');
for (let refQ = 0; refQ <= 2; refQ++) {
  const pc = pianoCells(refQ, 0, true);
  const rel = pc.map(([q, r]) => [q - refQ, r]);
  const qs = rel.map((c) => c[0]), rs = rel.map((c) => c[1]);
  console.log(`    refQ=${refQ}  q ∈ [${Math.min(...qs)}, ${Math.max(...qs)}]  r ∈ [${Math.min(...rs)}, ${Math.max(...rs)}]`);
}
console.log('');
