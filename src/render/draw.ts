// Main canvas + draw pipeline.
//
// Architecture invariant from lessons.md: offscreen hex/text layers are built
// at fixed origin (gridRefQ=gridRefR=0) with padding sufficient for ALL
// possible layout shifts. Layout switches change ONLY the blit OFFSET — they
// do NOT dirty the offscreen layers (zero-cost-blit invariant). Setting
// view.hexDirty/textDirty=true on a layout switch would force a rebuild and
// destroy the optimization.
//
// Selection state is per-frame: selection.drawnKeys is rebuilt every draw()
// call from the current view + layout shift; the click hit-test reads it as
// the screen-space lookup table.

import { baseKeys } from '../layout/baseKeys.js';
import { bandOf } from '../layout/coords.js';
import { hexR, dxH, dyH, tiltAngle, cosT, sinT } from '../layout/geometry.js';
import { qwertyKeys } from '../input/qwerty.js';
import { tuning } from '../state/tuning.js';
import { view } from '../state/view.js';
import { selection, type DrawnKey } from '../state/selection.js';
import { audio } from '../state/audio.js';
import { referenceNote } from '../state/reference.js';
import { whiteSet, hueC, computeHue } from './colors.js';
import { sizeCanvas, getVisibleRange, computePianoViewCenter } from './canvas.js';
import { animation } from './animation.js';
import { updateInfo } from './info.js';
import {
  parseNote, accToVal, noteName,
  SHARP, DBLSHARP, FLAT, DBLFLAT,
} from '../tuning/notes.js';
import { jiRatio, tenneyHeightFromExps } from '../tuning/ratios.js';
import { regionInfo } from '../tuning/regions.js';
import { refSpine } from '../tuning/refspine.js';
import { VALID_REF_TABLE } from './refbounds-table.js';
import type { KeyId } from '../types.js';

// ── canvas setup ───────────────────────────────────────────────────────────
export const cv = document.getElementById('cv') as HTMLCanvasElement;
sizeCanvas();
cv.style.width = view.CW + 'px';
cv.style.height = view.CH + 'px';
(cv.parentElement as HTMLElement).style.minWidth = '424px'; /* 400px canvas + 24px wrap padding */
export let ctx: CanvasRenderingContext2D = cv.getContext('2d')!;

// ── layout-anim raf scheduler ──────────────────────────────────────────────
let layoutAnimId: number | null = null;
function animateLayout(): void {
  const stillRunning = animation.step();
  draw();
  layoutAnimId = stillRunning ? requestAnimationFrame(animateLayout) : null;
}
/** Schedule (or re-schedule) the layout-switch animation raf loop. */
export function startLayoutAnim(): void {
  if (layoutAnimId) cancelAnimationFrame(layoutAnimId);
  layoutAnimId = requestAnimationFrame(animateLayout);
}

// ── outline geometry (precomputed at module load) ──────────────────────────
const outR = hexR + 1;
const olDirs: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const hdx: number[] = [], hdy: number[] = [], epx: number[] = [], epy: number[] = [];
for (let _di = 0; _di < 6; _di++) {
  const _rx = olDirs[_di][0] * dxH + olDirs[_di][1] * dxH * 0.5, _ry = -olDirs[_di][1] * dyH;
  const _rl = Math.sqrt(_rx * _rx + _ry * _ry);
  hdx[_di] = _rx / _rl; hdy[_di] = _ry / _rl;
  epx[_di] = -hdy[_di]; epy[_di] = hdx[_di];
}
function edgeIsect(hx1: number, hy1: number, d1: number, hx2: number, hy2: number, d2: number): [number, number] {
  const px1 = hx1 + outR * hdx[d1], py1 = hy1 + outR * hdy[d1];
  const px2 = hx2 + outR * hdx[d2], py2 = hy2 + outR * hdy[d2];
  const det = epx[d2] * epy[d1] - epx[d1] * epy[d2];
  if (Math.abs(det) < 1e-9) return [px1, py1];
  const ddx = px2 - px1, ddy = py2 - py1;
  const t = (epx[d2] * ddy - epy[d2] * ddx) / det;
  return [px1 + t * epx[d1], py1 + t * epy[d1]];
}

type Point = [number, number];

/* Trace boundary edges around a (q, r) cell set into closed polyline arrays.
   Used for both the Lumatone (baseKeys) and QWERTY (qwertyKeys) outlines. */
function computeOutlinePaths(keys: ReadonlyArray<readonly [number, number]>): Point[][] {
  const keySet = new Set<string>();
  keys.forEach((k) => { keySet.add(k[0] + ',' + k[1]); });
  const eDirs: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  const bPos: Record<string, { ux: number; uy: number }> = {};
  keys.forEach((bk) => {
    bPos[bk[0] + ',' + bk[1]] = { ux: bk[0] * dxH + bk[1] * dxH * 0.5, uy: -bk[1] * dyH };
  });
  const bEdges: Record<string, boolean> = {};
  keys.forEach((bk) => {
    const bq = bk[0], br = bk[1];
    for (let d = 0; d < 6; d++) {
      if (!keySet.has((bq + eDirs[d][0]) + ',' + (br + eDirs[d][1])))
        bEdges[bq + ',' + br + ',' + d] = true;
    }
  });
  function nextBEdge(q: number, r: number, d: number): [number, number, number] | null {
    let nd = (d + 5) % 6;
    for (let s = 0; s < 12; s++) {
      if (bEdges[q + ',' + r + ',' + nd]) return [q, r, nd];
      const nq = q + eDirs[nd][0], nr = r + eDirs[nd][1];
      nd = ((nd + 3) % 6 + 5) % 6; q = nq; r = nr;
    }
    return null;
  }
  const paths: Point[][] = [];
  const bUsed: Record<string, boolean> = {};
  for (const ek in bEdges) {
    if (bUsed[ek]) continue;
    const ep = ek.split(','); let cq = +ep[0], cr = +ep[1], cd = +ep[2];
    const sq = cq, sr = cr, sd = cd;
    const chain: [number, number, number][] = [];
    do {
      chain.push([cq, cr, cd]);
      bUsed[cq + ',' + cr + ',' + cd] = true;
      const nx = nextBEdge(cq, cr, cd);
      if (!nx) break;
      cq = nx[0]; cr = nx[1]; cd = nx[2];
    } while (cq !== sq || cr !== sr || cd !== sd);
    if (chain.length < 3) continue;
    const poly: Point[] = [];
    for (let ci = 0; ci < chain.length; ci++) {
      const cur = chain[ci], nxt = chain[(ci + 1) % chain.length];
      const h1 = bPos[cur[0] + ',' + cur[1]], h2 = bPos[nxt[0] + ',' + nxt[1]];
      if (!h1 || !h2) continue;
      const pt = edgeIsect(h1.ux, h1.uy, cur[2], h2.ux, h2.uy, nxt[2]);
      poly.push(pt);
    }
    if (poly.length >= 3) paths.push(poly);
  }
  return paths;
}

const lumatoneOutlinePaths: Point[][] = computeOutlinePaths(baseKeys);
const qwertyOutlinePaths: Point[][] = computeOutlinePaths(qwertyKeys);

/* Spatial index for seam-snap. snapVtx() is called twice per seam segment
   (~thousands per frame in piano outline with a tall canvas) — a linear
   scan over ~100-200 polygon vertices per call is the dominant per-frame
   cost in the seam loop. A 2D bucket grid turns each query into a few
   neighbor-bucket lookups, dropping ~800k inner-loop iterations to
   ~30-40k. Built once per polygon-paths change; queried with the
   per-frame snap offset (snapOX, snapOY). */
/* Pack a lattice (q, r) into a single Smi-fast integer for use as a
   Set<number> / Map<number, …> key inside hot loops (seam dedup,
   neighbor checks). String concatenation (`q + ',' + r`) allocates one
   short string per iteration; for ~12k iterations per draw that's
   substantial GC pressure. Range comfortably covers any lattice cell we
   touch (refNote validation caps refR at ±3, piano cells span ±30 q in
   7-limit extremes — well inside ±5000). */
function packQR(q: number, r: number): number {
  return (q + 5000) * 100000 + (r + 5000);
}

const SNAP_CELL_SIZE = 16;  /* > seam snap radius (sqrt(36) = 6 px) */
interface SnapIndex { buckets: Map<number, Array<[number, number]>>; }
function snapBucketKey(gx: number, gy: number): number {
  /* gx, gy fit in ±1000 for any canvas we render; encode without
     bit-shifts to avoid 32-bit sign issues on negative coords. */
  return (gx + 1000) * 10000 + (gy + 1000);
}
function buildSnapIndex(paths: Point[][]): SnapIndex {
  const buckets = new Map<number, Array<[number, number]>>();
  for (const poly of paths) {
    for (let i = 0; i < poly.length; i++) {
      const v = poly[i];
      const gx = Math.floor(v[0] / SNAP_CELL_SIZE);
      const gy = Math.floor(v[1] / SNAP_CELL_SIZE);
      const k = snapBucketKey(gx, gy);
      let arr = buckets.get(k);
      if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(v);
    }
  }
  return { buckets };
}
const lumatoneSnapIndex = buildSnapIndex(lumatoneOutlinePaths);
const qwertySnapIndex = buildSnapIndex(qwertyOutlinePaths);
let pianoSnapIndex: SnapIndex = { buckets: new Map() };
const emptySnapIndex: SnapIndex = { buckets: new Map() };

type OutlineMode = 'lumatone' | 'qwerty' | 'piano' | 'none';
function getOutlineMode(): OutlineMode {
  const sel = document.getElementById('selOutline') as HTMLSelectElement | null;
  const v = sel?.value;
  if (v === 'qwerty') return 'qwerty';
  if (v === 'piano') return 'piano';
  if (v === 'none') return 'none';
  return 'lumatone';
}

/* ── piano outline (dynamic, refNote-anchored) ─────────────────────────────
   The 88 cells that an A0..C8 MIDI piano resolves to under the current
   reference note. Unlike Lumatone/QWERTY (static cell sets pre-shifted to
   draw screen-stationary), the piano outline tracks lattice cells: it scrolls
   with the lattice on refSpine shifts, and recomputes on refNote / tuning-mode
   change. Cache keyed by (refQ, refR, tuningMode). */
let pianoOutlinePaths: Point[][] = [];
let pianoFootprintSet: Set<KeyId> = new Set();
let pianoBounds = { qMin: 0, qMax: 0, rMin: 0, rMax: 0 };
let pianoOutlineCacheKey = '';

export function invalidatePianoOutline(): void {
  pianoOutlineCacheKey = '';
  /* The hex layer's gridRange clamps to piano bounds when Extend is off —
     stale bounds mean stale clipping. Force a rebuild on next draw. */
  view.hexDirty = true;
  view.textDirty = true;
}

/* ── valid-ref-region (static gate + outline, per tuning bucket) ────────────
   Two static sets of (q, r) refNote candidates that pass the ±3-accidental
   check across the relevant tuning bucket:
     V5         — used in 5-limit + 12-TET (septimalEnabled=false).
     V7-uniform — used in 7-limit (septimalEnabled=true; qm=2 all B-d1-upper).
   Both are pure functions of the picker logic + accidental rule, so they're
   precomputed offline by tools/bounds-probe/compute-refbounds.mjs and stored
   in VALID_REF_TABLE. The outline polygons are cheap to derive (edge tracing
   over the cell set); built once at module load. */
const validRefSet5: Set<KeyId> = new Set(VALID_REF_TABLE['5'].map(([q, r]) => (q + ',' + r) as KeyId));
const validRefSet7Uniform: Set<KeyId> = new Set(VALID_REF_TABLE['7'].map(([q, r]) => (q + ',' + r) as KeyId));
const validRefPaths5: Point[][] = computeOutlinePaths(VALID_REF_TABLE['5']);
const validRefPaths7Uniform: Point[][] = computeOutlinePaths(VALID_REF_TABLE['7']);

function activeValidRefSet(): Set<KeyId> {
  return tuning.septimalEnabled ? validRefSet7Uniform : validRefSet5;
}

function activeValidRefPaths(): Point[][] {
  return tuning.septimalEnabled ? validRefPaths7Uniform : validRefPaths5;
}

/* For each MIDI 21..108, pick the (q, r) with `4q + 7r = midi − 57` that
   minimizes reduced Tenney Height of the JI ratio to (refQ, refR), tiebroken
   by largest syntonic-axis projection (octave-invariant — see resolve.ts
   header for derivation). Solutions live on a 1-parameter family
   (q0+7k, r0−4k); k ∈ [−20, 20] is comfortably wider than any sensible
   enharmonic excursion. Exported for callers that need to inspect the
   resulting cell set under a hypothetical refNote (e.g. Ctrl+click
   validation in src/ui/init.ts). Tuning state is read from the live `tuning`
   module via jiRatio — for hypothetical-state probing under non-live tuning,
   see tools/bounds-probe/compute-refbounds.mjs. */
export function compute88PianoCoords(
  refQ: number, refR: number,
): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  /* Octave step in (q, r) lattice is (+3, 0): 4·3 + 7·0 = 12 semitones. The
     syntonic projection 7(q−refQ) − 4(r−refR) shifts by 7·3 − 4·0 per octave
     — derive PROJ_PER_OCT from the octave step so it stays in sync if the
     lattice geometry ever changes. */
  const Q_PER_OCT = 3, R_PER_OCT = 0;
  const PROJ_PER_OCT = 7 * Q_PER_OCT - 4 * R_PER_OCT;
  const refMidi = 57 + 4 * refQ + 7 * refR;
  for (let midi = 21; midi <= 108; midi++) {
    const N = midi - 57;
    /* q ≡ 2N (mod 7) since 4·2 ≡ 1 (mod 7); start there. */
    const q0 = (((2 * N) % 7) + 7) % 7;
    let bestQ = q0, bestR = (N - 4 * q0) / 7;
    let bestTh = Infinity, bestAbsNProj = Infinity, found = false;
    /* Each MIDI lives in an "octave block" relative to ref; the natural
       lineage of the ref-pitch-class at this MIDI has proj ≈ PROJ_PER_OCT ×
       octaveDelta. Tiebreak by |proj − that target| so all pitch classes
       collapse toward their own ref-aligned octave lineage. At the ref's
       MIDI this picks (refQ, refR) (target = 0, proj = 0). At ref+12 it
       picks (refQ+3, refR) (target = +21, proj = +21). At Eb3/Eb4 it picks
       the same enharmonic at both octaves (octave-consistent, unlike a
       0-centered |proj|). And in 7-limit, where a B-region cell can tie
       TH=0 with the ref's natural lineage cell (the syntonic adjustment
       cancels the (7,-4) shift's comma), the lineage cell wins — the ref
       never falls outside its own footprint. */
    const octaveDelta = Math.round((midi - refMidi) / 12);
    const projTarget = PROJ_PER_OCT * octaveDelta;
    for (let k = -20; k <= 20; k++) {
      const q = q0 + 7 * k;
      const r = (N - 4 * q) / 7;
      const ratio = jiRatio(refQ, refR, q, r);
      const th = tenneyHeightFromExps(ratio.e);
      const proj = 7 * (q - refQ) - 4 * (r - refR);
      const absNProj = Math.abs(proj - projTarget);
      if (!found || th < bestTh || (th === bestTh && absNProj < bestAbsNProj)) {
        bestTh = th; bestAbsNProj = absNProj; bestQ = q; bestR = r; found = true;
      }
    }
    cells.push([bestQ, bestR]);
  }
  return cells;
}

/* Cached MIDI 64 (E4) cell for the current refNote + tuning. Updated by
   ensurePianoOutline alongside the rest of the piano-outline cache. The
   piano-mode view tracks this cell — see syncViewToOutline in controls.ts
   for why centering on the lattice's midpoint-MIDI cell (not refNote) keeps
   the outline on-screen regardless of where refNote sits in the range. */
let pianoMidi64Cell: [number, number] = [0, 1];

/** MIDI 64's lattice cell under the current refNote + tuning state. Ensures
 *  the piano outline cache is up-to-date before reading. */
export function currentMidi64Cell(): readonly [number, number] {
  ensurePianoOutline();
  return pianoMidi64Cell;
}

/** Snap view.viewQ/viewR to the position dictated by the active outline.
 *  Called after rotation or tuning changes to re-solve the piano viewport
 *  (tilt-dependent linear system; MIDI 64's cell can also shift in
 *  7-limit). For non-piano outlines the view falls back to the current
 *  layout-shift center. Caller handles hexDirty + redraw. Lives here
 *  rather than in controls.ts to keep onTuningChanged free of a circular
 *  import (controls → effects/onTuningChanged → controls). */
export function snapViewForOutline(outline: OutlineMode): void {
  if (outline === 'piano') {
    const [m64Q, m64R] = currentMidi64Cell();
    const [vQ, vR] = computePianoViewCenter(referenceNote.q, referenceNote.r, m64Q, m64R);
    view.viewQ = vQ;
    view.viewR = vR;
  } else {
    /* Lumatone/QWERTY/none modes: lattice slides under a static outline so
       the ref's Pythag-spine cell lands at the outline's center. */
    const sp = refSpine(referenceNote.q, referenceNote.r);
    view.viewQ = sp.q;
    view.viewR = sp.r;
  }
}

/** Decide whether (q, r) is a sensible reference-note. Used by:
 *   • ctrl+click handler (src/ui/init.ts) — blocks user from setting bad ref
 *   • composer bridge handler (src/bridge/hkl-side.ts) — drops invalid
 *     composer-broadcast refNotes before they hit state. Composer also has
 *     an accidental-cap fallback when ENTERING notes, but rejecting at the
 *     ref-note-set stage is smoother now that we have the validator on the
 *     HKL side.
 *
 *  Rules:
 *  1. coordToMidi(q, r) ∈ [21, 108] — refNote must be inside 88-key range.
 *  2. Every cell in the 88-cell set the picker produces under this refNote
 *     must spell with ≤ ±3 accidentals (matching Composer's own clamp). */
export function validateRefNoteCandidate(q: number, r: number): string | null {
  const midi = 57 + 4 * q + 7 * r;
  if (midi < 21 || midi > 108) {
    return 'Reference note out of 88-key piano range (MIDI ' + midi + ')';
  }
  /* Live picker check: only constraints are (1) MIDI range above and
     (2) every 88-cell footprint cell having ≤±3 accidentals. The cached
     gate sets exist only to draw the dotted boundary; they're not the
     authoritative validator. */
  const cells = compute88PianoCoords(q, r);
  for (const [cq, cr] of cells) {
    const name = noteName(cq, cr);
    const acc = Math.abs(accToVal(parseNote(name).acc));
    if (acc > 3) return 'Reference would require ' + acc + '× accidentals (' + name + ')';
  }
  return null;
}

/* ── tween-aware hex-layer rebuild ─────────────────────────────────────────
   When the piano-mode view tweens between two MIDI 64 cells (because refNote
   shifts to a SC-spelled variant, or composer pushes a new chromatic root),
   the offscreen hex layer must cover BOTH endpoints — otherwise the moving
   view crosses the layer edge mid-tween and reveals the cut-off-borders
   artifact. Set the tween range BEFORE calling buildHexLayerForTween; the
   sizeGridCanvases routine picks up the midpoint as gridRef and extends pad
   by half the tween distance so the layer spans start..end inclusive. */
let pendingTweenStart: [number, number] | null = null;
let pendingTweenEnd: [number, number] | null = null;

function ensurePianoOutline(): void {
  const refQ = referenceNote.q, refR = referenceNote.r;
  const tMode = tuning.equalEnabled ? 'E' : tuning.septimalEnabled ? '7' : '5';
  const key = refQ + ',' + refR + ',' + tMode;
  if (key === pianoOutlineCacheKey) return;
  pianoOutlineCacheKey = key;
  const cells = compute88PianoCoords(refQ, refR);
  pianoFootprintSet = new Set<KeyId>();
  let qLo = 1e9, qHi = -1e9, rLo = 1e9, rHi = -1e9;
  for (const [q, r] of cells) {
    pianoFootprintSet.add(q + ',' + r as KeyId);
    if (q < qLo) qLo = q; if (q > qHi) qHi = q;
    if (r < rLo) rLo = r; if (r > rHi) rHi = r;
  }
  pianoOutlinePaths = computeOutlinePaths(cells);
  pianoSnapIndex = buildSnapIndex(pianoOutlinePaths);
  pianoBounds = { qMin: qLo - 2, qMax: qHi + 2, rMin: rLo - 2, rMax: rHi + 2 };
  /* MIDI 64 (E4) is the 44th key of an 88-key piano (MIDI 21..108) →
     cells index 43. Cache for piano-mode view centering. */
  pianoMidi64Cell = cells[64 - 21];
}

/* Set of (q,r) keys covered by the active outline at the current state.
   Returns null when outline is 'none' (no clipping applies). Lumatone/qwerty
   are the refSpine-shifted footprints; piano returns the refNote-anchored
   88-cell set (no lattice shift — those cells are absolute lattice
   positions, recomputed on refNote/tuning change). */
export function activeFootprintSet(): Set<KeyId> | null {
  const outlineMode = getOutlineMode();
  if (outlineMode === 'none') return null;
  if (outlineMode === 'piano') {
    ensurePianoOutline();
    return pianoFootprintSet;
  }
  const sp = refSpine(referenceNote.q, referenceNote.r);
  const sh: readonly [number, number] = [sp.q, sp.r];
  const set = new Set<KeyId>();
  if (outlineMode === 'lumatone') {
    baseKeys.forEach((k) => { set.add((k[0] + sh[0]) + ',' + (k[1] + sh[1])); });
  } else {
    qwertyKeys.forEach((k) => { set.add((k[0] + sh[0]) + ',' + (k[1] + sh[1])); });
  }
  return set;
}

// ── hit-test ───────────────────────────────────────────────────────────────
/* Even-odd point-in-polygon test across a set of closed polygons. Mirrors the
   `ctx.fill('evenodd')` rule used to render the outline overlay. */
function pointInOutline(paths: Point[][], x: number, y: number): boolean {
  let inside = false;
  for (let p = 0; p < paths.length; p++) {
    const poly = paths[p];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
  }
  return inside;
}

/** Map screen coordinates to a "q,r" lattice key, or null if too far from any. */
export function hexAtPoint(mx: number, my: number): KeyId | null {
  /* transform to unrotated coords */
  const dx = mx - view.CW / 2, dy = my - (view.CH / 2 + view.kbOffY);
  const ux = dx * cosT - dy * sinT;
  const uy = dx * sinT + dy * cosT;
  /* When extend pattern is off, the overlay paints outside the outline solid,
     hiding non-footprint keys. Mirror that visibility in the hit-test so clicks
     on covered keys are no-ops. Outline 'none' draws no overlay → no clipping. */
  const showE = (document.getElementById('cbExtend') as HTMLInputElement | null)?.checked ?? true;
  const outlineMode = getOutlineMode();
  if (!showE && outlineMode !== 'none') {
    /* lumatone/qwerty outlines are statically positioned (drawn from raw
       baseKeys / qwertyKeys without translation); piano outline rides with
       the lattice (viewQ/viewR offset). Translate the test point by the
       inverse of the render-side translate to compare against the raw path. */
    let tx = ux, ty = uy;
    let paths: Point[][];
    if (outlineMode === 'piano') {
      ensurePianoOutline();
      tx += view.viewQ * dxH + view.viewR * dxH * 0.5;
      ty -= view.viewR * dyH;
      paths = pianoOutlinePaths;
    } else if (outlineMode === 'qwerty') {
      paths = qwertyOutlinePaths;
    } else {
      paths = lumatoneOutlinePaths;
    }
    if (!pointInOutline(paths, tx, ty)) return null;
  }
  /* find nearest hex by unrotated distance */
  let best: DrawnKey | null = null, bestD = Infinity;
  for (let i = 0; i < selection.drawnKeys.length; i++) {
    const k = selection.drawnKeys[i];
    const ddx = ux - k.ux, ddy = uy - k.uy, d2 = ddx * ddx + ddy * ddy;
    if (d2 < bestD) { bestD = d2; best = k; }
  }
  if (!best || bestD > hexR * hexR * 1.5) return null;
  return best.q + ',' + best.r;
}

// ── drawing helpers ────────────────────────────────────────────────────────
function drawHexPath(cx: number, cy: number, r: number): void { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)); } ctx.closePath(); }
function lightenHex(hex: string, amt: number): string {
  let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  r = Math.min(255, r + amt); g = Math.min(255, g + amt); b = Math.min(255, b + amt);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
function drawNoteName(cx: number, cy: number, name: string, isW: boolean, isExt: boolean): void {
  if (name === '?') return;
  const p = parseNote(name); const v = accToVal(p.acc); const absV = Math.abs(v);
  ctx.fillStyle = isW ? (isExt ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.8)') : (isExt ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.9)');
  const baseFontSize = 14;
  ctx.font = '500 ' + baseFontSize + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (v === 0) { ctx.fillText(p.letter, cx, cy); return; }
  /* decompose accidental into single+double glyphs */
  const single = v > 0 ? SHARP : FLAT, dbl = v > 0 ? DBLSHARP : DBLFLAT;
  const glyphs = [];
  if (absV % 2 === 1) glyphs.push(single);
  for (let i = 0; i < Math.floor(absV / 2); i++) glyphs.push(dbl);
  /* measure total width at base size to determine scale factor */
  const dblFlatScale = 0.90;
  const lw = ctx.measureText(p.letter).width;
  let totalW = lw;
  for (let i = 0; i < glyphs.length; i++) {
    const gScale = (glyphs[i] === DBLFLAT) ? dblFlatScale : 1;
    ctx.font = '500 ' + Math.round(baseFontSize * gScale) + 'px sans-serif';
    totalW += ctx.measureText(glyphs[i]).width + 0.5;
    /* cascading nudge for double flats: count consecutive double flats */
    if (glyphs[i] === DBLFLAT) {
      let dblIdx = 0; for (let j = 0; j < i; j++) if (glyphs[j] === DBLFLAT) dblIdx++;
      if (dblIdx > 0) totalW -= baseFontSize * 0.14 * dblIdx;
    }
  }
  ctx.font = '500 ' + baseFontSize + 'px sans-serif';
  const maxW = hexR * 1.3;
  const scale = Math.min(1, maxW / totalW);
  const fontSize = Math.max(6, Math.round(baseFontSize * scale));
  /* compute nudges and glyph widths at final size */
  ctx.font = '500 ' + fontSize + 'px sans-serif';
  const flw = ctx.measureText(p.letter).width;
  const gws = [], nudges = [];
  let dblCount = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const gScale = (glyphs[i] === DBLFLAT) ? dblFlatScale : 1;
    ctx.font = '500 ' + Math.round(fontSize * gScale) + 'px sans-serif';
    gws.push(ctx.measureText(glyphs[i]).width);
    if (glyphs[i] === DBLFLAT) {
      nudges.push(dblCount > 0 ? -fontSize * 0.14 * dblCount : 0);
      dblCount++;
    } else {
      nudges.push(0);
    }
  }
  ctx.font = '500 ' + fontSize + 'px sans-serif';
  /* compute total rendered width for centering */
  let tw = flw; for (let i = 0; i < gws.length; i++) tw += gws[i] + 0.5 + nudges[i];
  let x = cx - tw / 2 + flw / 2;
  ctx.fillText(p.letter, x, cy);
  x += flw / 2;
  for (let i = 0; i < glyphs.length; i++) {
    x += 0.5 + gws[i] / 2 + nudges[i];
    if (glyphs[i] === DBLFLAT) {
      ctx.font = '500 ' + Math.round(fontSize * dblFlatScale) + 'px sans-serif';
      ctx.fillText(glyphs[i], x, cy - fontSize * 0.04);
      ctx.font = '500 ' + fontSize + 'px sans-serif';
    } else {
      const yOff = glyphs[i] === DBLSHARP ? fontSize * 0.22 : 0;
      ctx.fillText(glyphs[i], x, cy + yOff);
    }
    x += gws[i] / 2;
  }
}

// ── offscreen layers: hexCanvas (fills) + textCanvas (labels) ──────────────
let hexCanvas: HTMLCanvasElement | null = null, textCanvas: HTMLCanvasElement | null = null;
let gridRefQ = 0, gridRefR = 0, gridPadX = 0, gridPadY = 0, gridW = 0, gridH = 0, gridDpr = 1;

interface GridRange { qMin: number; qMax: number; rMin: number; rMax: number; }

/* keyboard extent across all layouts for tight bounds when Extend is off.
   QWERTY bounds also span the full QWERTY-transpose range (-3..+3) so the
   precomputed union covers every reachable QWERTY position. */
/* Baseline extents of the baseKeys / qwertyKeys cell sets, BEFORE applying
   any layout shift or transpose. The runtime shift (refSpine for Lumatone +
   QWERTY-transpose for QWERTY) is added at gridRange-time, so the clamp
   tracks the lattice as it slides underneath the static outline. */
let kbBaseQMin: number, kbBaseQMax: number, kbBaseRMin: number, kbBaseRMax: number;
let qwertyBaseQMin: number, qwertyBaseQMax: number, qwertyBaseRMin: number, qwertyBaseRMax: number;
(function () {
  kbBaseQMin = 1e9; kbBaseQMax = -1e9; kbBaseRMin = 1e9; kbBaseRMax = -1e9;
  qwertyBaseQMin = 1e9; qwertyBaseQMax = -1e9; qwertyBaseRMin = 1e9; qwertyBaseRMax = -1e9;
  baseKeys.forEach((k) => {
    if (k[0] < kbBaseQMin) kbBaseQMin = k[0]; if (k[0] > kbBaseQMax) kbBaseQMax = k[0];
    if (k[1] < kbBaseRMin) kbBaseRMin = k[1]; if (k[1] > kbBaseRMax) kbBaseRMax = k[1];
  });
  qwertyKeys.forEach((k) => {
    if (k[0] < qwertyBaseQMin) qwertyBaseQMin = k[0]; if (k[0] > qwertyBaseQMax) qwertyBaseQMax = k[0];
    if (k[1] < qwertyBaseRMin) qwertyBaseRMin = k[1]; if (k[1] > qwertyBaseRMax) qwertyBaseRMax = k[1];
  });
  kbBaseQMin -= 2; kbBaseQMax += 2; kbBaseRMin -= 2; kbBaseRMax += 2;
  qwertyBaseQMin -= 2; qwertyBaseQMax += 2; qwertyBaseRMin -= 2; qwertyBaseRMax += 2;
})();

function sizeGridCanvases(): void {
  /* The offscreen hex layer is anchored at gridRef and padded to cover the
     visible canvas. View position depends on outline mode:
       piano   — viewport solved so refNote sits at screen-X center and MIDI
                 64's cell at screen-Y center (hybrid 2x2 system).
       else    — lattice slides under a static outline so the ref's qm=0
                 spine cell lands at the outline's center (refSpine).
     During a view tween (set up by buildHexLayerForTween via pendingTween*),
     gridRef sits at the midpoint of start→end and pad is extended by half
     the tween distance so the layer covers the union of both endpoints.
     This used to be piano-only; now it applies to Lumatone/QWERTY too,
     since ref-driven shifts can move the view anywhere on the lattice. */
  const outlineMode = getOutlineMode();
  let vQ: number, vR: number;
  if (outlineMode === 'piano') {
    const [m64Q, m64R] = currentMidi64Cell();
    [vQ, vR] = computePianoViewCenter(referenceNote.q, referenceNote.r, m64Q, m64R);
  } else {
    const sp = refSpine(referenceNote.q, referenceNote.r);
    vQ = sp.q; vR = sp.r;
  }
  if (pendingTweenStart && pendingTweenEnd) {
    gridRefQ = Math.round((pendingTweenStart[0] + pendingTweenEnd[0]) / 2);
    gridRefR = Math.round((pendingTweenStart[1] + pendingTweenEnd[1]) / 2);
  } else {
    gridRefQ = Math.round(vQ); gridRefR = Math.round(vR);
  }
  let mxDx = 0, mxDy = 0;
  if (pendingTweenStart && pendingTweenEnd) {
    /* Pad to half the tween span so the layer covers the union of endpoints. */
    const halfDQ = (pendingTweenEnd[0] - pendingTweenStart[0]) / 2;
    const halfDR = (pendingTweenEnd[1] - pendingTweenStart[1]) / 2;
    const dux = halfDQ * dxH + halfDR * dxH * 0.5, duy = -halfDR * dyH;
    mxDx = Math.max(mxDx, Math.abs(dux * cosT + duy * sinT));
    mxDy = Math.max(mxDy, Math.abs(-dux * sinT + duy * cosT));
  }
  gridPadX = Math.ceil(mxDx) + hexR * 3;
  gridPadY = Math.ceil(mxDy) + hexR * 3;
  gridW = view.CW + gridPadX * 2; gridH = view.CH + gridPadY * 2;
  gridDpr = window.devicePixelRatio || 1;
}

/** Rebuild the hex + text offscreen layers sized to cover both endpoints
 *  of an upcoming view tween. Called by syncViewToOutline (controls.ts)
 *  before animation.tweenTo() so the layer already spans start→end when
 *  the first animation frame paints. The pending-tween state is cleared
 *  immediately after the rebuild — future non-tween rebuilds use the
 *  normal MIDI 64-anchored gridRef. */
export function buildHexLayerForTween(
  startQ: number, startR: number, endQ: number, endR: number,
): void {
  pendingTweenStart = [startQ, startR];
  pendingTweenEnd = [endQ, endR];
  try {
    buildHexLayer();
    buildTextLayer();
  } finally {
    pendingTweenStart = null;
    pendingTweenEnd = null;
  }
}

function gridRange(extended: boolean): GridRange {
  const gCorners: Point[] = [[-gridW / 2, -(gridH / 2 + view.kbOffY)], [gridW / 2, -(gridH / 2 + view.kbOffY)],
    [gridW / 2, gridH / 2 - view.kbOffY], [-gridW / 2, gridH / 2 - view.kbOffY]];
  let qLo = 1e9, qHi = -1e9, rLo = 1e9, rHi = -1e9;
  gCorners.forEach((c) => {
    const ux = c[0] * cosT - c[1] * sinT, uy = c[0] * sinT + c[1] * cosT;
    const rRel = -uy / dyH, qRel = (ux - rRel * dxH * 0.5) / dxH;
    if (qRel + gridRefQ < qLo) qLo = qRel + gridRefQ; if (qRel + gridRefQ > qHi) qHi = qRel + gridRefQ;
    if (rRel + gridRefR < rLo) rLo = rRel + gridRefR; if (rRel + gridRefR > rHi) rHi = rRel + gridRefR;
  });
  qLo = Math.floor(qLo) - 2; qHi = Math.ceil(qHi) + 2; rLo = Math.floor(rLo) - 2; rHi = Math.ceil(rHi) + 2;
  /* Extend off → clamp to the active outline's bounds so we don't render
     hexes that will be masked anyway. None mode never clamps (otherwise
     toggling Extend off would empty the canvas). */
  const mode = getOutlineMode();
  if (!extended && mode !== 'none') {
    /* Add current ref-driven shift to the baseline extents so the clamp
       moves with the lattice underneath the static Lumatone/QWERTY outline. */
    const sp = refSpine(referenceNote.q, referenceNote.r);
    if (mode === 'qwerty') {
      qLo = Math.max(qLo, qwertyBaseQMin + sp.q); qHi = Math.min(qHi, qwertyBaseQMax + sp.q);
      rLo = Math.max(rLo, qwertyBaseRMin + sp.r); rHi = Math.min(rHi, qwertyBaseRMax + sp.r);
    } else if (mode === 'piano') {
      ensurePianoOutline();
      qLo = Math.max(qLo, pianoBounds.qMin); qHi = Math.min(qHi, pianoBounds.qMax);
      rLo = Math.max(rLo, pianoBounds.rMin); rHi = Math.min(rHi, pianoBounds.rMax);
    } else {
      qLo = Math.max(qLo, kbBaseQMin + sp.q); qHi = Math.min(qHi, kbBaseQMax + sp.q);
      rLo = Math.max(rLo, kbBaseRMin + sp.r); rHi = Math.min(rHi, kbBaseRMax + sp.r);
    }
  }
  return { qMin: qLo, qMax: qHi, rMin: rLo, rMax: rHi };
}

function buildGridKeys(range: GridRange): DrawnKey[] {
  const gcx = gridW / 2, gcy = gridH / 2 + view.kbOffY;
  const kbSet = new Set<string>(); baseKeys.forEach((k) => { kbSet.add(k[0] + ',' + k[1]); });
  const gKeys: DrawnKey[] = [];
  for (let r = range.rMax; r >= range.rMin; r--) for (let q = range.qMin; q <= range.qMax; q++) {
    const isKb = kbSet.has(q + ',' + r);
    const ux = (q - gridRefQ) * dxH + (r - gridRefR) * dxH * 0.5, uy = -(r - gridRefR) * dyH;
    const sx = ux * cosT + uy * sinT + gcx, sy = -ux * sinT + uy * cosT + gcy;
    if (sx < -hexR * 3 || sx > gridW + hexR * 3 || sy < -hexR * 3 || sy > gridH + hexR * 3) continue;
    gKeys.push({ q: q, r: r, ux: ux, uy: uy, sx: sx, sy: sy, isKb: isKb });
  }
  return gKeys;
}

function buildHexLayer(): void {
  sizeGridCanvases();
  const extended = (document.getElementById('cbExtend') as HTMLInputElement).checked;
  const range = gridRange(extended);
  const gKeys = buildGridKeys(range);
  if (!hexCanvas) hexCanvas = document.createElement('canvas');
  hexCanvas.width = gridW * gridDpr; hexCanvas.height = gridH * gridDpr;
  const gc = hexCanvas.getContext('2d')!;
  gc.setTransform(gridDpr, 0, 0, gridDpr, 0, 0);
  gc.fillStyle = '#111'; gc.fillRect(0, 0, gridW, gridH);
  const gcx = gridW / 2, gcy = gridH / 2 + view.kbOffY;
  const savedCtx = ctx; ctx = gc;
  ctx.save(); ctx.translate(gcx, gcy); ctx.rotate(-tiltAngle);
  ctx.fillStyle = '#111'; gKeys.forEach((k) => { if (k.isKb) { drawHexPath(k.ux, k.uy, hexR + 0.5); ctx.fill(); } });
  gKeys.forEach((k) => {
    const midi = 57 + 4 * k.q + 7 * k.r; const pc = ((midi % 12) + 12) % 12; const isW = whiteSet.has(pc);
    const mh = computeHue(k.q, k.r);
    const inB = tuning.septimalEnabled && regionInfo(k.q, k.r).type === 'B';
    const col = inB ? (isW ? hueC[mh].sl! : hueC[mh].sd!) : (isW ? hueC[mh].l : hueC[mh].d);
    drawHexPath(k.ux, k.uy, hexR - 0.5); ctx.fillStyle = col; ctx.fill();
  });
  ctx.restore();
  ctx = savedCtx;
  view.hexDirty = false;
}

function buildTextLayer(): void {
  sizeGridCanvases();
  const extended = (document.getElementById('cbExtend') as HTMLInputElement).checked;
  const range = gridRange(extended);
  const gKeys = buildGridKeys(range);
  if (!textCanvas) textCanvas = document.createElement('canvas');
  textCanvas.width = gridW * gridDpr; textCanvas.height = gridH * gridDpr;
  const gc = textCanvas.getContext('2d')!;
  gc.setTransform(gridDpr, 0, 0, gridDpr, 0, 0);
  /* transparent background — composites over hex layer */
  gc.clearRect(0, 0, gridW, gridH);
  if ((document.getElementById('cbNotes') as HTMLInputElement).checked) {
    const savedCtx = ctx; ctx = gc;
    gKeys.forEach((k) => {
      const midi = 57 + 4 * k.q + 7 * k.r; const pc = ((midi % 12) + 12) % 12; const isW = whiteSet.has(pc);
      drawNoteName(k.sx, k.sy, noteName(k.q, k.r), isW, false);
    });
    ctx = savedCtx;
  }
  view.textDirty = false;
}

// ── main draw ──────────────────────────────────────────────────────────────
export function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  cv.width = view.CW * dpr; cv.height = view.CH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, view.CW, view.CH);
  const cyC = view.CH / 2 + view.kbOffY;
  const showN = (document.getElementById('cbNotes') as HTMLInputElement).checked;
  const showB = (document.getElementById('cbBands') as HTMLInputElement).checked;
  const showE = (document.getElementById('cbExtend') as HTMLInputElement).checked;

  /* rebuild layers if needed (not during animation) */
  if (!animation.isAnimating) {
    if (view.hexDirty) buildHexLayer();
    if (view.textDirty) buildTextLayer();
  }

  /* blit hex + text layers at current view offset */
  if (hexCanvas) {
    const dQ = view.viewQ - gridRefQ, dR = view.viewR - gridRefR;
    const dux = dQ * dxH + dR * dxH * 0.5, duy = -dR * dyH;
    const offX = dux * cosT + duy * sinT;
    const offY = -dux * sinT + duy * cosT;
    const srcX = (gridPadX + offX) * gridDpr, srcY = (gridPadY + offY) * gridDpr, srcW = view.CW * gridDpr, srcH = view.CH * gridDpr;
    ctx.drawImage(hexCanvas, srcX, srcY, srcW, srcH, 0, 0, view.CW, view.CH);
    if (textCanvas) ctx.drawImage(textCanvas, srcX, srcY, srcW, srcH, 0, 0, view.CW, view.CH);
  }

  /* build allKeys for seams + click detection (arithmetic only, no rendering) */
  const _sp = refSpine(referenceNote.q, referenceNote.r);
  const kbShQ = animation.isAnimating ? Math.round(view.viewQ) : _sp.q;
  const kbShR = animation.isAnimating ? Math.round(view.viewR) : _sp.r;
  const kbSet = new Set<string>(); baseKeys.forEach((k) => { kbSet.add((k[0] + kbShQ) + ',' + (k[1] + kbShR)); });
  const vis = getVisibleRange(view.viewQ, view.viewR);
  const allKeys: DrawnKey[] = [];
  for (let r = vis.rMax; r >= vis.rMin; r--) for (let q = vis.qMin; q <= vis.qMax; q++) {
    const isKb = kbSet.has(q + ',' + r);
    const ux = (q - view.viewQ) * dxH + (r - view.viewR) * dxH * 0.5;
    const uy = -(r - view.viewR) * dyH;
    const sx = ux * cosT + uy * sinT + view.CW / 2;
    const sy = -ux * sinT + uy * cosT + cyC;
    if (!isKb && (sx < -hexR * 3 || sx > view.CW + hexR * 3 || sy < -hexR * 3 || sy > view.CH + hexR * 3)) continue;
    allKeys.push({ q: q, r: r, ux: ux, uy: uy, sx: sx, sy: sy, isKb: isKb });
  }
  selection.drawnKeys = allKeys;
  const posMap: Record<KeyId, DrawnKey> = {};
  allKeys.forEach((k) => { posMap[k.q + ',' + k.r] = k; });
  kbSet.forEach((key) => {
    if (!posMap[key]) {
      const p = key.split(','), q = +p[0], r = +p[1];
      const ux = (q - view.viewQ) * dxH + (r - view.viewR) * dxH * 0.5, uy = -(r - view.viewR) * dyH;
      const sx = ux * cosT + uy * sinT + view.CW / 2, sy = -ux * sinT + uy * cosT + cyC;
      const k: DrawnKey = { q: q, r: r, ux: ux, uy: uy, sx: sx, sy: sy, isKb: true };
      allKeys.push(k); posMap[key] = k;
    }
  });

  /* === selection highlights + seams (rotated context) === */
  ctx.save();
  ctx.translate(view.CW / 2, cyC);
  ctx.rotate(-tiltAngle);

  /* hover: subtle lightening of the hex under the cursor (drawn under selection
     so a selected+hovered key still reads as selected). */
  if (selection.hoverKey) {
    const hk = posMap[selection.hoverKey];
    if (hk) {
      const hmidi = 57 + 4 * hk.q + 7 * hk.r; const hpc = ((hmidi % 12) + 12) % 12; const hW = whiteSet.has(hpc);
      const hmh = computeHue(hk.q, hk.r);
      const hInB = tuning.septimalEnabled && regionInfo(hk.q, hk.r).type === 'B';
      const hCol = hInB ? (hW ? hueC[hmh].sl! : hueC[hmh].sd!) : (hW ? hueC[hmh].l : hueC[hmh].d);
      drawHexPath(hk.ux, hk.uy, hexR - 0.5); ctx.fillStyle = lightenHex(hCol, 30); ctx.fill();
    }
  }

  /* selection: brightened hex fills */
  const flashNow = performance.now();
  const flashingSet = new Set<KeyId>();
  for (const fk in audio.rearticulateFlashUntil) {
    if (audio.rearticulateFlashUntil[fk] > flashNow) flashingSet.add(fk);
    else delete audio.rearticulateFlashUntil[fk];
  }
  selection.selectedKeys.forEach((key) => {
    if (flashingSet.has(key)) return;
    const k = posMap[key]; if (!k) return;
    const midi = 57 + 4 * k.q + 7 * k.r; const pc = ((midi % 12) + 12) % 12; const isW = whiteSet.has(pc);
    const mh = computeHue(k.q, k.r);
    const inB = tuning.septimalEnabled && regionInfo(k.q, k.r).type === 'B';
    let col = inB ? (isW ? hueC[mh].sl! : hueC[mh].sd!) : (isW ? hueC[mh].l : hueC[mh].d);
    col = lightenHex(col, 90);
    drawHexPath(k.ux, k.uy, hexR - 0.5); ctx.fillStyle = col; ctx.fill();
  });

  /* selection rings */
  selection.selectedKeys.forEach((key) => {
    if (flashingSet.has(key)) return;
    const k = posMap[key]; if (!k) return;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
    drawHexPath(k.ux, k.uy, hexR - 0.5); ctx.stroke();
  });

  /* lattice seams — skip in Equal mode (no seams) */
  if (showB && !tuning.equalEnabled) {
    const eHL = hexR * 0.55; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.lineCap = 'butt';
    /* `allSet` is a number-keyed Set built via packQR to avoid the ~14k
       string allocations the old `Set<string>` + `q + ',' + r`
       per-iteration concatenation incurred each frame. Smi keys hash
       cheaply in V8 and don't churn the heap.
       Half-dirs iteration: by iterating only 3 of the 6 neighbor
       directions per cell, each cell-pair is visited exactly once (the
       opposite dir reaches it from the other cell). Removes the need
       for a `drawnSeams` dedup Set and the ~4k `sk` string allocations
       it used to require. */
    const allSet = new Set<number>();
    for (let i = 0; i < allKeys.length; i++) {
      const ak = allKeys[i];
      allSet.add(packQR(ak.q, ak.r));
    }
    const dirsHalf: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 1]];
    const animT = animation.progress;
    /* seamBlend dips to 0 at mid-tween so seams float to the geometric
       cell-midpoint while cells animate from old to new layout positions
       under a screen-fixed outline (Lumatone/QWERTY layout switches). In
       piano outline the outline polygon translates with view, so the
       outline + cells animate together and seam-snap stays correct
       throughout — keep seamBlend=1 (full snap) to avoid spurious
       unsnap-resnap jitter. */
    const seamBlend = (animT < 0 || getOutlineMode() === 'piano')
      ? 1
      : Math.pow(Math.abs(2 * animT - 1), 6);
    /* snap seams to whichever outline is currently visible — a Lumatone snap
       under a hidden Lumatone outline would tug seams toward an invisible
       reference. Lumatone/QWERTY polygons are drawn statically in baseKeys-
       origin space (no kbSh translate), so their seam-space offset is zero.
       Piano outline's vertices are in absolute lattice space, so its offset
       to seam-space (where cells are at `(q-viewQ, r-viewR)`) is just
       (−viewQ, −viewR). None mode: no snap. */
    const seamMode = getOutlineMode();
    let snapIndex: SnapIndex;
    let snapOX: number, snapOY: number;
    if (seamMode === 'piano') {
      ensurePianoOutline();
      snapIndex = pianoSnapIndex;
      snapOX = -view.viewQ * dxH - view.viewR * dxH * 0.5;
      snapOY = view.viewR * dyH;
    } else if (seamMode === 'qwerty') {
      snapIndex = qwertySnapIndex;
      snapOX = (kbShQ - view.viewQ) * dxH + (kbShR - view.viewR) * dxH * 0.5;
      snapOY = -(kbShR - view.viewR) * dyH;
    } else if (seamMode === 'lumatone') {
      snapIndex = lumatoneSnapIndex;
      snapOX = (kbShQ - view.viewQ) * dxH + (kbShR - view.viewR) * dxH * 0.5;
      snapOY = -(kbShR - view.viewR) * dyH;
    } else {
      snapIndex = emptySnapIndex;
      snapOX = 0; snapOY = 0;
    }
    /* Spatial-indexed snap: build-time grid + 3×3 bucket scan per query.
       Replaces a linear scan over the full vertex list (was the dominant
       per-frame cost — see header on buildSnapIndex). */
    function snapVtx(px: number, py: number): { x: number; y: number } | null {
      if (snapIndex.buckets.size === 0) return null;
      /* polygon-local query coord (undo the snapOX/snapOY translate). */
      const qx = px - snapOX, qy = py - snapOY;
      const gx = Math.floor(qx / SNAP_CELL_SIZE);
      const gy = Math.floor(qy / SNAP_CELL_SIZE);
      let bd = Infinity, bx = 0, by = 0;
      for (let dgx = -1; dgx <= 1; dgx++) {
        for (let dgy = -1; dgy <= 1; dgy++) {
          const arr = snapIndex.buckets.get(snapBucketKey(gx + dgx, gy + dgy));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const v = arr[i];
            const ddx = qx - v[0], ddy = qy - v[1];
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < bd) { bd = d2; bx = v[0]; by = v[1]; }
          }
        }
      }
      return bd < 36 ? { x: bx + snapOX, y: by + snapOY } : null;
    }
    const seamSegs: [number, number, number, number][] = [];
    /* posMap is still string-keyed (used elsewhere with KeyId strings);
       allocate the lookup key only after the cheap allSet + same-band
       filters short-circuit. That cuts the string churn from
       ~12k/frame to ~5k/frame. */
    const septOn = tuning.septimalEnabled;
    /* Uniform septimal: regions vary along the qmod3 axis (qm=2 = B, else A);
       route through regionInfo. */
    function regionParity(q: number, r: number): number {
      return regionInfo(q, r).type === 'B' ? 1 : 0;
    }
    for (let ki = 0; ki < allKeys.length; ki++) {
      const k = allKeys[ki];
      const kq = k.q, kr = k.r;
      for (let di = 0; di < dirsHalf.length; di++) {
        const d = dirsHalf[di];
        const nq = kq + d[0], nr = kr + d[1];
        if (!allSet.has(packQR(nq, nr))) continue;
        const sameBand = bandOf(kq) === bandOf(nq);
        const sameRegion = !septOn || regionParity(kq, kr) === regionParity(nq, nr);
        if (sameBand && sameRegion) continue;
        const nb = posMap[nq + ',' + nr];
        if (!nb) continue;
        const mx = (k.ux + nb.ux) / 2, my = (k.uy + nb.uy) / 2;
        const dx2 = nb.ux - k.ux, dy2 = nb.uy - k.uy, len = Math.sqrt(dx2 * dx2 + dy2 * dy2);
        const nx = -dy2 / len, ny = dx2 / len;
        let p1x = mx + nx * eHL, p1y = my + ny * eHL;
        let p2x = mx - nx * eHL, p2y = my - ny * eHL;
        if (seamBlend > 0.01) {
          const r1 = snapVtx(p1x, p1y);
          if (r1) { p1x += (r1.x - p1x) * seamBlend; p1y += (r1.y - p1y) * seamBlend; }
          const r2 = snapVtx(p2x, p2y);
          if (r2) { p2x += (r2.x - p2x) * seamBlend; p2y += (r2.y - p2y) * seamBlend; }
        }
        seamSegs.push([p1x, p1y, p2x, p2y]);
      }
    }
    if (seamSegs.length) {
      ctx.beginPath();
      seamSegs.forEach((s) => { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); });
      ctx.stroke();
    }
  }

  /* Reference-note marker: dashed hex outline drawn OUTSIDE the hex perimeter
     (in the inter-key gap), so it sits in the cracks between keys without
     overlapping the fill or the note label. White (matches band seams' hue)
     so it reads as structural, not tonal. Shown when the Piano-input toolbar
     is enabled OR when the Piano outline is active — both contexts make the
     reference note meaningful, and the Piano outline is constructed around
     this anchor regardless of whether piano input is on. */
  const pianoCb = document.getElementById('cbPianoEnabled') as HTMLInputElement | null;
  if ((pianoCb && pianoCb.checked) || getOutlineMode() === 'piano') {
    const rk = posMap[referenceNote.q + ',' + referenceNote.r];
    if (rk) {
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      /* Offset outward by ~2.5px so the dashed ring sits in the gap rather
         than on the key. hexR is the in-radius of the inscribed circle of
         a flat-topped hex; +2.5 lands clearly outside the (-0.5) selection
         ring at hexR-0.5. */
      drawHexPath(rk.ux, rk.uy, hexR + 2.5);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.restore();

  /* re-render text for selected keys on top of selection fills */
  if (showN && selection.selectedKeys.size > 0) {
    selection.selectedKeys.forEach((key) => {
      if (flashingSet.has(key)) return;
      const k = posMap[key]; if (!k) return;
      const midi = 57 + 4 * k.q + 7 * k.r; const pc = ((midi % 12) + 12) % 12; const isW = whiteSet.has(pc);
      drawNoteName(k.sx, k.sy, noteName(k.q, k.r), isW, false);
    });
  }
  /* re-render hovered key's note name on top of hover fill (skip if already
     handled by the selection re-render above). */
  if (showN && selection.hoverKey && !selection.selectedKeys.has(selection.hoverKey)) {
    const hk = posMap[selection.hoverKey];
    if (hk) {
      const hmidi = 57 + 4 * hk.q + 7 * hk.r; const hpc = ((hmidi % 12) + 12) % 12; const hW = whiteSet.has(hpc);
      drawNoteName(hk.sx, hk.sy, noteName(hk.q, hk.r), hW, false);
    }
  }

  /* === overlay + outline (rotated context, on top of everything) === */
  const outlineMode = getOutlineMode();
  if (outlineMode !== 'none') {
    ctx.save();
    ctx.translate(view.CW / 2, cyC);
    ctx.rotate(-tiltAngle);

    /* Lumatone/QWERTY outlines stay screen-stationary across ref-driven
       shifts: the lattice underneath translates (refSpine offset) while the
       outline polygon stays at its baseKeys-origin coordinates.
       Piano outline differs: its 88 cells are anchored to refNote in absolute
       lattice space (see compute88PianoCoords). We translate by the lattice
       scroll offset so the polygon tracks the cells it encompasses. */
    let activePaths: Point[][];
    if (outlineMode === 'piano') {
      ensurePianoOutline();
      ctx.translate(-view.viewQ * dxH - view.viewR * dxH * 0.5, view.viewR * dyH);
      activePaths = pianoOutlinePaths;
    } else if (outlineMode === 'qwerty') {
      activePaths = qwertyOutlinePaths;
    } else {
      activePaths = lumatoneOutlinePaths;
    }

    const diag = Math.ceil(Math.sqrt(view.CW * view.CW + view.CH * view.CH));
    ctx.beginPath();
    ctx.rect(-diag, -diag, diag * 2, diag * 2);
    activePaths.forEach((poly) => {
      for (let i = 0; i < poly.length; i++) {
        if (i === 0) ctx.moveTo(poly[i][0], poly[i][1]);
        else ctx.lineTo(poly[i][0], poly[i][1]);
      }
      ctx.closePath();
    });
    ctx.fillStyle = showE ? 'rgba(17,17,17,0.65)' : 'rgba(17,17,17,1.0)';
    ctx.fill('evenodd');

    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3.5; ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    ctx.beginPath();
    activePaths.forEach((poly) => {
      for (let i = 0; i < poly.length; i++) {
        if (i === 0) ctx.moveTo(poly[i][0], poly[i][1]);
        else ctx.lineTo(poly[i][0], poly[i][1]);
      }
      ctx.closePath();
    });
    ctx.stroke();

    ctx.restore();
  }

  /* === valid-ref-region outline (dotted, on top of main outline) ===
     Gated by the "Valid ref bounds" checkbox in the Piano toolbar (off by
     default). Lives in lattice space (coords are absolute (q, r) positions),
     so applies the lattice-scroll translate in every outline mode, including
     'none'. Stroke is sandwiched between the ref-note marker (1.5) and the
     main outline (3.5). */
  const showValidRef = (document.getElementById('cbValidRefBounds') as HTMLInputElement | null)?.checked ?? false;
  if (showValidRef) {
    const validPaths = activeValidRefPaths();
    if (validPaths.length > 0) {
      ctx.save();
      ctx.translate(view.CW / 2, cyC);
      ctx.rotate(-tiltAngle);
      ctx.translate(-view.viewQ * dxH - view.viewR * dxH * 0.5, view.viewR * dyH);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      validPaths.forEach((poly) => {
        for (let i = 0; i < poly.length; i++) {
          if (i === 0) ctx.moveTo(poly[i][0], poly[i][1]);
          else ctx.lineTo(poly[i][0], poly[i][1]);
        }
        ctx.closePath();
      });
      ctx.stroke();
      ctx.restore();
    }
  }

  updateInfo();
}
