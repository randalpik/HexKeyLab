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
import type { TuningMode } from '../state/persistence.js';
import { whiteSet, hueC, computeHue, keyColorVariant } from './colors.js';
import { sizeCanvas, getVisibleRange, computePianoViewCenter } from './canvas.js';
import { animation } from './animation.js';
import { updateInfo } from './info.js';
import {
  parseNote, accToVal, noteName, noteNameV,
} from '../tuning/notes.js';
import { jiRatio, tenneyHeightFromExps } from '../tuning/ratios.js';
import { regionInfo } from '../tuning/regions.js';
import { refSpine } from '../tuning/refspine.js';
import {
  hejiCommas,
  hejiLabel,
  type HejiLabel,
  type HejiGlyphFamily,
  type HejiGlyphInfo,
} from "../tuning/heji.js";
import { VALID_REF_TABLE } from './refbounds-table.js';
import { isCtrlHeld } from '../ui/keyboard.js';
import type { KeyId } from '../types.js';

/** Resolve the displayed note name for a cell, accounting for V mode's
 *  M3-distance respelling from refSpine. Other modes use the standard
 *  octave-invariant `noteName(q, r)`. Read at call time so a ref change
 *  re-spells without needing a cache invalidation step. */
function displayedNoteName(q: number, r: number): string {
  if (tuning.mode === 'V') {
    const spine = refSpine(referenceNote.q, referenceNote.r);
    return noteNameV(q, r, spine.q);
  }
  return noteName(q, r);
}

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
const validRefSetByMode: Record<TuningMode, Set<KeyId>> = {
  'E': new Set(VALID_REF_TABLE['E'].map(([q, r]) => (q + ',' + r) as KeyId)),
  '5': new Set(VALID_REF_TABLE['5'].map(([q, r]) => (q + ',' + r) as KeyId)),
  'P': new Set(VALID_REF_TABLE['P'].map(([q, r]) => (q + ',' + r) as KeyId)),
  'D': new Set(VALID_REF_TABLE['D'].map(([q, r]) => (q + ',' + r) as KeyId)),
  '7': new Set(VALID_REF_TABLE['7'].map(([q, r]) => (q + ',' + r) as KeyId)),
  'V': new Set(VALID_REF_TABLE['V'].map(([q, r]) => (q + ',' + r) as KeyId)),
};
const validRefPathsByMode: Record<TuningMode, Point[][]> = {
  'E': computeOutlinePaths(VALID_REF_TABLE['E']),
  '5': computeOutlinePaths(VALID_REF_TABLE['5']),
  'P': computeOutlinePaths(VALID_REF_TABLE['P']),
  'D': computeOutlinePaths(VALID_REF_TABLE['D']),
  '7': computeOutlinePaths(VALID_REF_TABLE['7']),
  'V': computeOutlinePaths(VALID_REF_TABLE['V']),
};

function activeValidRefSet(): Set<KeyId> {
  return validRefSetByMode[tuning.mode];
}

function activeValidRefPaths(): Point[][] {
  return validRefPathsByMode[tuning.mode];
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
       the kbAnchor cell lands at the outline's center. kbAnchor is updated
       only by user-driven ref changes, so Composer-driven changes leave the
       physical layout untouched. */
    view.viewQ = view.kbAnchorQ;
    view.viewR = view.kbAnchorR;
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
  const tMode = tuning.mode;
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
   are the kbAnchor-shifted footprints; piano returns the refNote-anchored
   88-cell set (no lattice shift — those cells are absolute lattice
   positions, recomputed on refNote/tuning change). */
export function activeFootprintSet(): Set<KeyId> | null {
  const outlineMode = getOutlineMode();
  if (outlineMode === 'none') return null;
  if (outlineMode === 'piano') {
    ensurePianoOutline();
    return pianoFootprintSet;
  }
  const sh: readonly [number, number] = [view.kbAnchorQ, view.kbAnchorR];
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
function drawNoteName(
  cx: number,
  cy: number,
  name: string,
  isW: boolean,
  isExt: boolean,
  heji?: HejiLabel,
): void {
  if (name === "?") return;
  /* Bravura is the sole rendering path now: the woff2 is bundled so its load
     window is short (one repaint), and the document.fonts.load hook below
     triggers a redraw the moment it's ready. Painting nothing pre-load
     beats painting a Unicode chain that the eye expects to morph into
     Bravura — the swap mid-session was visually jarring. */
  if (!bravuraLoaded || !heji) return;
  ctx.fillStyle = isW
    ? isExt
      ? "rgba(0,0,0,0.45)"
      : "rgba(0,0,0,0.8)"
    : isExt
      ? "rgba(255,255,255,0.5)"
      : "rgba(255,255,255,0.9)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  drawHejiLabel(cx, cy, heji);
}

/** HEJI-on rendering: letter in sans-serif followed by a chain of combined
 *  Bravura SMuFL glyphs (each carrying one Pythagorean accidental + up to 2
 *  syntonic-comma arrows), optionally ending in a septimal hook. Width
 *  budget mirrors the conventional path — same hexR×1.3 maxW with a
 *  shrink-to-fit floor at 6px. */
/* Per-family vertical fine-tune for HEJI glyphs, in fractions of the
 * Bravura font size. BravuraText's accidentals share a common musical Y
 * anchor (the staff-line they're engraved to sit on), but their *visual*
 * centers don't all align with that anchor — the symmetric glyphs
 * (natural, sharp, double-sharp) center near the anchor, while flats/
 * doubleFlats have asymmetric extents (round body below staff line, stem
 * reaching above) and visually float higher than their anchor. A single
 * shared offset (e.g. natural-bbox-based auto-calibration) under-corrects
 * the symmetric family and over-corrects the flat family.
 *
 * These values are empirical — adjust them if the visual alignment drifts.
 * Positive = shift DOWN (Y down in canvas). The chosen baseline puts the
 * symmetric family centered with the letter; flats compensate downward.
 *
 * If you need to retune: render a cell whose label is, say, "Eb" or "F##"
 * in HEJI mode and eyeball the accidental's visual midpoint against the
 * letter. Adjust the family value by ±0.02 at a time. */
const HEJI_FAMILY_Y_OFFSET: Record<HejiGlyphFamily, number> = {
  natural:     0.06,
  sharp:       0.06,
  doubleSharp: 0.06,
  flat:        0.13,
  doubleFlat:  0.13,
  septimal:    0.18,
};

/* Bare-accidental codepoints per family — used as the layout-slot reference
 * regardless of what arrows are attached. Bravura's combined glyphs (e.g.
 * U+E2C1 = flat+1arrowDown) have the accidental at the LEFT of a wider
 * advance box, with the arrow extending RIGHT. Using the bare advance as
 * the slot keeps the accidental at a consistent X whether arrows are
 * present or not; the arrow extends past the slot's right edge without
 * affecting layout. */
const BARE_ACC_CODE: Record<HejiGlyphFamily, string | null> = {
  natural:     '\u{E261}',
  sharp:       '\u{E262}',
  flat:        '\u{E260}',
  doubleSharp: '\u{E263}',
  doubleFlat:  '\u{E264}',
  septimal:    null,           // no bare alternative — the hook IS the glyph
};

/** Width to reserve for a glyph in the chain. For accidental families this
 *  is the BARE accidental's advance (ignoring any attached arrows); for
 *  septimal hooks it's the hook's own advance. Caller must set ctx.font to
 *  the Bravura font size first. */
function slotAdvance(g: HejiGlyphInfo): number {
  const bare = BARE_ACC_CODE[g.family];
  return ctx.measureText(bare ?? g.ch).width;
}

/* Collapse-exponent typography. The superscript number rides above-right of
 * the collapse accidental in plain sans-serif. The two key numbers:
 *   EXP_SCALE — superscript font size as a fraction of the Bravura font size.
 *     0.55 reads as "small but legible at hex scale"; smaller becomes a dot,
 *     larger competes visually with the accidental itself.
 *   EXP_ASCENT_FRAC — where the digit's bottom (its alphabetic baseline)
 *     sits relative to the accidental's visual top. 0.45 = baseline drops
 *     just below the accidental's apex so the digit overlaps slightly and
 *     reads as attached to it.
 * Tuned by inspection on V mode (refSpine=A, q=+12 → B#⁵). */
const EXP_SCALE = 0.55;
const EXP_ASCENT_FRAC = 0.45;

function drawHejiLabel(cx: number, cy: number, label: HejiLabel): void {
  const baseFontSize = 14;
  /* BravuraText is compiled with text-style metrics, but SMuFL accidental
     glyphs still occupy only a fraction of the em box (engraved to fit a
     5-line staff, so glyph extent is much smaller than the equivalent
     Unicode ♯/♭ in a sans-serif font at the same font-size). To match the
     visual weight of the conventional path, render Bravura glyphs at
     ~1.8× the letter font size. */
  const hejiScale = 1.8;
  /* Layout order (left to right):
       letter
       collapse (if position === 'before')
       chain (all non-septimal glyphs)
       collapse (if position === 'after')
       septimal hook (if present) — always last so it visually trails the
         collapse exponent in case-B-a-heavy + Septimal-mode cells.
     Slot widths are computed against the bare-accidental advance so attached
     arrows extend past their slot's right edge without affecting layout. */
  const chainGs: HejiGlyphInfo[] = [];
  const septimalGs: HejiGlyphInfo[] = [];
  for (const g of label.glyphs) {
    (g.family === 'septimal' ? septimalGs : chainGs).push(g);
  }
  /* width pass at base size */
  ctx.font = '500 ' + baseFontSize + 'px sans-serif';
  let totalW = ctx.measureText(label.letter).width;
  ctx.font = '500 ' + Math.round(baseFontSize * hejiScale) + 'px "BravuraText", sans-serif';
  if (label.collapse) totalW += slotAdvance(label.collapse.glyph) + 0.5;
  for (const g of chainGs) totalW += slotAdvance(g) + 0.5;
  for (const g of septimalGs) totalW += slotAdvance(g) + 0.5;
  if (label.collapse) {
    ctx.font = '500 ' + Math.round(baseFontSize * hejiScale * EXP_SCALE) + 'px sans-serif';
    totalW += ctx.measureText(String(label.collapse.count)).width;
  }
  /* shrink to fit hex */
  const maxW = hexR * 1.3;
  const scale = Math.min(1, maxW / totalW);
  const fontSize = Math.max(6, Math.round(baseFontSize * scale));
  const hejiFontSize = Math.max(5, Math.round(fontSize * hejiScale));
  const expFontSize = Math.max(4, Math.round(hejiFontSize * EXP_SCALE));
  /* measure at final sizes */
  ctx.font = '500 ' + fontSize + 'px sans-serif';
  const flw = ctx.measureText(label.letter).width;
  ctx.font = '500 ' + hejiFontSize + 'px "BravuraText", sans-serif';
  const chainSlotWs = chainGs.map(slotAdvance);
  const septimalSlotWs = septimalGs.map(slotAdvance);
  let collapseSlotW = 0;
  let collapseAscent = 0;
  if (label.collapse) {
    collapseSlotW = slotAdvance(label.collapse.glyph);
    const bare = BARE_ACC_CODE[label.collapse.glyph.family] ?? label.collapse.glyph.ch;
    /* actualBoundingBoxAscent reports the distance from the current
       textBaseline (here, 'middle') to the top of the rendered bbox.
       Firefox + Chromium both populate it for Bravura glyphs; fall back to
       a fraction of the font size on engines that don't. */
    const m = ctx.measureText(bare);
    collapseAscent = m.actualBoundingBoxAscent || hejiFontSize * 0.6;
  }
  ctx.font = '500 ' + expFontSize + 'px sans-serif';
  const expW = label.collapse ? ctx.measureText(String(label.collapse.count)).width : 0;
  let tw = flw;
  if (label.collapse) tw += collapseSlotW + 0.5 + expW;
  for (const w of chainSlotWs) tw += w + 0.5;
  for (const w of septimalSlotWs) tw += w + 0.5;
  /* Render with textAlign='left' so each glyph's LEFT EDGE anchors at the
     slot start. Combined accidental+arrow glyphs have the accidental at
     the left of their advance box, so this keeps the accidental portion
     aligned with the bare-accidental position regardless of arrows. */
  ctx.textAlign = 'left';
  let x = cx - tw / 2;
  ctx.font = '500 ' + fontSize + 'px sans-serif';
  ctx.fillText(label.letter, x, cy);
  x += flw + 0.5;
  const drawCollapse = (): void => {
    if (!label.collapse) return;
    const g = label.collapse.glyph;
    const yOff = HEJI_FAMILY_Y_OFFSET[g.family] * hejiFontSize;
    ctx.font = '500 ' + hejiFontSize + 'px "BravuraText", sans-serif';
    ctx.fillText(g.ch, x, cy + yOff);
    /* Anchor the digit's visual middle near the accidental's upper region:
       cy + yOff is the glyph's musical baseline, ascent carries up to the
       apex, then we drop EXP_ASCENT_FRAC of an ascent so the digit
       overlaps with the top portion of the accidental. textBaseline is
       'middle' so the y we pass is the digit's visual center. */
    const expY = cy + yOff - collapseAscent + collapseAscent * EXP_ASCENT_FRAC;
    ctx.font = '500 ' + expFontSize + 'px sans-serif';
    ctx.fillText(String(label.collapse.count), x + collapseSlotW, expY);
    x += collapseSlotW + 0.5 + expW;
  };
  if (label.collapse && label.collapse.position === 'before') drawCollapse();
  ctx.font = '500 ' + hejiFontSize + 'px "BravuraText", sans-serif';
  for (let i = 0; i < chainGs.length; i++) {
    const g = chainGs[i];
    const yOff = HEJI_FAMILY_Y_OFFSET[g.family] * hejiFontSize;
    ctx.fillText(g.ch, x, cy + yOff);
    x += chainSlotWs[i] + 0.5;
  }
  if (label.collapse && label.collapse.position === 'after') drawCollapse();
  for (let i = 0; i < septimalGs.length; i++) {
    const g = septimalGs[i];
    const yOff = HEJI_FAMILY_Y_OFFSET[g.family] * hejiFontSize;
    ctx.fillText(g.ch, x, cy + yOff);
    x += septimalSlotWs[i] + 0.5;
  }
  /* restore for next caller — drawNoteName sets it on entry, but defensive */
  ctx.textAlign = 'center';
  ctx.font = '500 ' + fontSize + 'px sans-serif';
}

/** Build the Bravura label for a cell. When HEJI is on the chain includes
 *  syntonic-comma arrows / septimal hooks; when HEJI is off the chain is
 *  just bare-accidental glyphs (engraved SMuFL ♯/♭/𝄪/𝄫 from Bravura — read
 *  much cleaner than the Unicode equivalents at lattice scale). High AD/SD
 *  cells additionally receive a collapse-with-exponent spec (see
 *  hejiLabel()'s docstring). Bare-letter cells (no accidentals, no commas)
 *  return an empty `glyphs` array and no collapse. */
function hejiLabelForCell(q: number, r: number): HejiLabel {
  const commas = tuning.hejiEnabled ? hejiCommas(q, r, tuning) : { syn5: 0, sept7: 0 };
  return hejiLabel(displayedNoteName(q, r), commas);
}

/* BravuraText load tracker. Canvas can't synchronously check font readiness
   the way DOM elements can — if we draw before the font is loaded, the
   browser falls back to a system font for the U+E2C0+ codepoints, which
   renders as tofu. Track loaded state, suppress note-name painting until
   ready (see drawNoteName), and trigger one repaint when ready. */
let bravuraLoaded = false;
if (typeof document !== 'undefined' && document.fonts) {
  /* `document.fonts.load` resolves once a face matching the spec is loaded
     (or rejects if no @font-face matches). The 12px size is arbitrary —
     fontFaceSet.load matches by family, the size only matters for caching. */
  document.fonts.load('12px BravuraText').then(() => {
    bravuraLoaded = true;
    view.textDirty = true;
    draw();
  }).catch(() => {/* font unreachable — note names will stay suppressed. */});
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
       else    — lattice slides under a static outline so kbAnchor lands at
                 the outline's center.
     During a view tween (set up by buildHexLayerForTween via pendingTween*),
     gridRef sits at the midpoint of start→end and pad is extended by half
     the tween distance so the layer covers the union of both endpoints.
     This used to be piano-only; now it applies to Lumatone/QWERTY too,
     since kbAnchor shifts can move the view anywhere on the lattice. */
  const outlineMode = getOutlineMode();
  let vQ: number, vR: number;
  if (outlineMode === 'piano') {
    const [m64Q, m64R] = currentMidi64Cell();
    [vQ, vR] = computePianoViewCenter(referenceNote.q, referenceNote.r, m64Q, m64R);
  } else {
    vQ = view.kbAnchorQ; vR = view.kbAnchorR;
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
    /* Add the current kbAnchor shift to the baseline extents so the clamp
       moves with the lattice underneath the static Lumatone/QWERTY outline. */
    const aQ = view.kbAnchorQ, aR = view.kbAnchorR;
    if (mode === 'qwerty') {
      qLo = Math.max(qLo, qwertyBaseQMin + aQ); qHi = Math.min(qHi, qwertyBaseQMax + aQ);
      rLo = Math.max(rLo, qwertyBaseRMin + aR); rHi = Math.min(rHi, qwertyBaseRMax + aR);
    } else if (mode === 'piano') {
      ensurePianoOutline();
      qLo = Math.max(qLo, pianoBounds.qMin); qHi = Math.min(qHi, pianoBounds.qMax);
      rLo = Math.max(rLo, pianoBounds.rMin); rHi = Math.min(rHi, pianoBounds.rMax);
    } else {
      qLo = Math.max(qLo, kbBaseQMin + aQ); qHi = Math.min(qHi, kbBaseQMax + aQ);
      rLo = Math.max(rLo, kbBaseRMin + aR); rHi = Math.min(rHi, kbBaseRMax + aR);
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
    const v = keyColorVariant(k.q, k.r);
    const col = v.isB ? (v.isW ? hueC[v.hue].sl! : hueC[v.hue].sd!) : (v.isW ? hueC[v.hue].l : hueC[v.hue].d);
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
      drawNoteName(
        k.sx,
        k.sy,
        displayedNoteName(k.q, k.r),
        isW,
        false,
        hejiLabelForCell(k.q, k.r),
      );
    });
    ctx = savedCtx;
  }
  view.textDirty = false;
}

// ── main draw ──────────────────────────────────────────────────────────────
export function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  cv.width = view.CW * dpr;
  cv.height = view.CH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, view.CW, view.CH);
  const cyC = view.CH / 2 + view.kbOffY;
  const showN = (document.getElementById("cbNotes") as HTMLInputElement)
    .checked;
  const showB = (document.getElementById("cbBands") as HTMLInputElement)
    .checked;
  const showE = (document.getElementById("cbExtend") as HTMLInputElement)
    .checked;

  /* rebuild layers if needed (not during animation) */
  if (!animation.isAnimating) {
    if (view.hexDirty) buildHexLayer();
    if (view.textDirty) buildTextLayer();
  }

  /* blit hex + text layers at current view offset */
  if (hexCanvas) {
    const dQ = view.viewQ - gridRefQ,
      dR = view.viewR - gridRefR;
    const dux = dQ * dxH + dR * dxH * 0.5,
      duy = -dR * dyH;
    const offX = dux * cosT + duy * sinT;
    const offY = -dux * sinT + duy * cosT;
    const srcX = (gridPadX + offX) * gridDpr,
      srcY = (gridPadY + offY) * gridDpr,
      srcW = view.CW * gridDpr,
      srcH = view.CH * gridDpr;
    ctx.drawImage(hexCanvas, srcX, srcY, srcW, srcH, 0, 0, view.CW, view.CH);
    if (textCanvas)
      ctx.drawImage(textCanvas, srcX, srcY, srcW, srcH, 0, 0, view.CW, view.CH);
  }

  /* build allKeys for seams + click detection (arithmetic only, no rendering) */
  const kbShQ = animation.isAnimating ? Math.round(view.viewQ) : view.kbAnchorQ;
  const kbShR = animation.isAnimating ? Math.round(view.viewR) : view.kbAnchorR;
  const kbSet = new Set<string>();
  baseKeys.forEach((k) => {
    kbSet.add(k[0] + kbShQ + "," + (k[1] + kbShR));
  });
  const vis = getVisibleRange(view.viewQ, view.viewR);
  const allKeys: DrawnKey[] = [];
  for (let r = vis.rMax; r >= vis.rMin; r--)
    for (let q = vis.qMin; q <= vis.qMax; q++) {
      const isKb = kbSet.has(q + "," + r);
      const ux = (q - view.viewQ) * dxH + (r - view.viewR) * dxH * 0.5;
      const uy = -(r - view.viewR) * dyH;
      const sx = ux * cosT + uy * sinT + view.CW / 2;
      const sy = -ux * sinT + uy * cosT + cyC;
      if (
        !isKb &&
        (sx < -hexR * 3 ||
          sx > view.CW + hexR * 3 ||
          sy < -hexR * 3 ||
          sy > view.CH + hexR * 3)
      )
        continue;
      allKeys.push({ q: q, r: r, ux: ux, uy: uy, sx: sx, sy: sy, isKb: isKb });
    }
  selection.drawnKeys = allKeys;
  const posMap: Record<KeyId, DrawnKey> = {};
  allKeys.forEach((k) => {
    posMap[k.q + "," + k.r] = k;
  });
  kbSet.forEach((key) => {
    if (!posMap[key]) {
      const p = key.split(","),
        q = +p[0],
        r = +p[1];
      const ux = (q - view.viewQ) * dxH + (r - view.viewR) * dxH * 0.5,
        uy = -(r - view.viewR) * dyH;
      const sx = ux * cosT + uy * sinT + view.CW / 2,
        sy = -ux * sinT + uy * cosT + cyC;
      const k: DrawnKey = {
        q: q,
        r: r,
        ux: ux,
        uy: uy,
        sx: sx,
        sy: sy,
        isKb: true,
      };
      allKeys.push(k);
      posMap[key] = k;
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
      const hv = keyColorVariant(hk.q, hk.r);
      const hCol = hv.isB
        ? hv.isW
          ? hueC[hv.hue].sl!
          : hueC[hv.hue].sd!
        : hv.isW
          ? hueC[hv.hue].l
          : hueC[hv.hue].d;
      drawHexPath(hk.ux, hk.uy, hexR - 0.5);
      ctx.fillStyle = lightenHex(hCol, 30);
      ctx.fill();
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
    const k = posMap[key];
    if (!k) return;
    const v = keyColorVariant(k.q, k.r);
    let col = v.isB
      ? v.isW
        ? hueC[v.hue].sl!
        : hueC[v.hue].sd!
      : v.isW
        ? hueC[v.hue].l
        : hueC[v.hue].d;
    col = lightenHex(col, 90);
    drawHexPath(k.ux, k.uy, hexR - 0.5);
    ctx.fillStyle = col;
    ctx.fill();
  });

  /* selection rings */
  selection.selectedKeys.forEach((key) => {
    if (flashingSet.has(key)) return;
    const k = posMap[key];
    if (!k) return;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.5;
    drawHexPath(k.ux, k.uy, hexR - 0.5);
    ctx.stroke();
  });

  /* lattice seams — skip in Equal mode (no seams) and Schismatic mode
     (band boundaries don't carry a spelling change: V respells via the M3
     chain so the qm=1 → qm=2 band-crossing reads as a 5-limit M3, not a
     diminished 4th). */
  if (showB && !tuning.equalEnabled && tuning.mode !== "V") {
    const eHL = hexR * 0.55;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.lineCap = "butt";
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
    const dirsHalf: ReadonlyArray<readonly [number, number]> = [
      [1, 0],
      [0, 1],
      [-1, 1],
    ];
    const animT = animation.progress;
    /* seamBlend dips to 0 at mid-tween so seams float to the geometric
       cell-midpoint while cells animate from old to new layout positions
       under a screen-fixed outline (Lumatone/QWERTY layout switches). In
       piano outline the outline polygon translates with view, so the
       outline + cells animate together and seam-snap stays correct
       throughout — keep seamBlend=1 (full snap) to avoid spurious
       unsnap-resnap jitter. */
    const seamBlend =
      animT < 0 || getOutlineMode() === "piano"
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
    if (seamMode === "piano") {
      ensurePianoOutline();
      snapIndex = pianoSnapIndex;
      snapOX = -view.viewQ * dxH - view.viewR * dxH * 0.5;
      snapOY = view.viewR * dyH;
    } else if (seamMode === "qwerty") {
      snapIndex = qwertySnapIndex;
      snapOX = (kbShQ - view.viewQ) * dxH + (kbShR - view.viewR) * dxH * 0.5;
      snapOY = -(kbShR - view.viewR) * dyH;
    } else if (seamMode === "lumatone") {
      snapIndex = lumatoneSnapIndex;
      snapOX = (kbShQ - view.viewQ) * dxH + (kbShR - view.viewR) * dxH * 0.5;
      snapOY = -(kbShR - view.viewR) * dyH;
    } else {
      snapIndex = emptySnapIndex;
      snapOX = 0;
      snapOY = 0;
    }
    /* Spatial-indexed snap: build-time grid + 3×3 bucket scan per query.
       Replaces a linear scan over the full vertex list (was the dominant
       per-frame cost — see header on buildSnapIndex). */
    function snapVtx(px: number, py: number): { x: number; y: number } | null {
      if (snapIndex.buckets.size === 0) return null;
      /* polygon-local query coord (undo the snapOX/snapOY translate). */
      const qx = px - snapOX,
        qy = py - snapOY;
      const gx = Math.floor(qx / SNAP_CELL_SIZE);
      const gy = Math.floor(qy / SNAP_CELL_SIZE);
      let bd = Infinity,
        bx = 0,
        by = 0;
      for (let dgx = -1; dgx <= 1; dgx++) {
        for (let dgy = -1; dgy <= 1; dgy++) {
          const arr = snapIndex.buckets.get(snapBucketKey(gx + dgx, gy + dgy));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const v = arr[i];
            const ddx = qx - v[0],
              ddy = qy - v[1];
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < bd) {
              bd = d2;
              bx = v[0];
              by = v[1];
            }
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
    /* Seams are emitted (a) at band boundaries (5, P, D, 7), and (b) at
       A↔B boundaries when any B-region cells exist — i.e. only in Septimal
       mode. Pure-SC-shift modes (Pythagorean, Semiditonal) signal their
       column boundaries through the SC-shifted hue rotation alone, which
       reads as a subtle overlay; adding seams on top would be redundant
       visual noise (especially Pythagorean, where every qm boundary
       would seam). Equal and Schismatic skip seams entirely (see gate
       above): both lack a different-spelled-interval at the band boundary. */
    const septOn = tuning.mode === "7";
    function regionParity(q: number, r: number): number {
      return regionInfo(q, r).type === "B" ? 1 : 0;
    }
    for (let ki = 0; ki < allKeys.length; ki++) {
      const k = allKeys[ki];
      const kq = k.q,
        kr = k.r;
      for (let di = 0; di < dirsHalf.length; di++) {
        const d = dirsHalf[di];
        const nq = kq + d[0],
          nr = kr + d[1];
        if (!allSet.has(packQR(nq, nr))) continue;
        const sameBand = bandOf(kq) === bandOf(nq);
        const sameRegion =
          !septOn || regionParity(kq, kr) === regionParity(nq, nr);
        if (sameBand && sameRegion) continue;
        const nb = posMap[nq + "," + nr];
        if (!nb) continue;
        const mx = (k.ux + nb.ux) / 2,
          my = (k.uy + nb.uy) / 2;
        const dx2 = nb.ux - k.ux,
          dy2 = nb.uy - k.uy,
          len = Math.sqrt(dx2 * dx2 + dy2 * dy2);
        const nx = -dy2 / len,
          ny = dx2 / len;
        let p1x = mx + nx * eHL,
          p1y = my + ny * eHL;
        let p2x = mx - nx * eHL,
          p2y = my - ny * eHL;
        if (seamBlend > 0.01) {
          const r1 = snapVtx(p1x, p1y);
          if (r1) {
            p1x += (r1.x - p1x) * seamBlend;
            p1y += (r1.y - p1y) * seamBlend;
          }
          const r2 = snapVtx(p2x, p2y);
          if (r2) {
            p2x += (r2.x - p2x) * seamBlend;
            p2y += (r2.y - p2y) * seamBlend;
          }
        }
        seamSegs.push([p1x, p1y, p2x, p2y]);
      }
    }
    if (seamSegs.length) {
      ctx.beginPath();
      seamSegs.forEach((s) => {
        ctx.moveTo(s[0], s[1]);
        ctx.lineTo(s[2], s[3]);
      });
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
  const pianoCb = document.getElementById(
    "cbPianoEnabled",
  ) as HTMLInputElement | null;
  if ((pianoCb && pianoCb.checked) || getOutlineMode() === "piano") {
    const rk = posMap[referenceNote.q + "," + referenceNote.r];
    if (rk) {
      ctx.save();
      ctx.strokeStyle = "#fff";
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
      const k = posMap[key];
      if (!k) return;
      const midi = 57 + 4 * k.q + 7 * k.r;
      const pc = ((midi % 12) + 12) % 12;
      const isW = whiteSet.has(pc);
      drawNoteName(
        k.sx,
        k.sy,
        displayedNoteName(k.q, k.r),
        isW,
        false,
        hejiLabelForCell(k.q, k.r),
      );
    });
  }
  /* re-render hovered key's note name on top of hover fill (skip if already
     handled by the selection re-render above). */
  if (
    showN &&
    selection.hoverKey &&
    !selection.selectedKeys.has(selection.hoverKey)
  ) {
    const hk = posMap[selection.hoverKey];
    if (hk) {
      const hmidi = 57 + 4 * hk.q + 7 * hk.r;
      const hpc = ((hmidi % 12) + 12) % 12;
      const hW = whiteSet.has(hpc);
      drawNoteName(
        hk.sx,
        hk.sy,
        displayedNoteName(hk.q, hk.r),
        hW,
        false,
        hejiLabelForCell(hk.q, hk.r),
      );
    }
  }

  /* === Ctrl-held darkening: dim everything outside the valid-ref region ===
     Transient cue that appears whenever Ctrl is held — the same gesture that
     precedes a Ctrl+click ref-note pick (see src/ui/init.ts) — so the user
     sees which cells are legal targets without having to enable the static
     "Valid ref bounds" dotted outline. Drawn BEFORE the main outline pass so
     that pass's white stroke stays crisp; an after-the-outline overlay would
     dim the white stroke wherever it crosses outside-valid-ref territory.
     Uses the same lattice-space transform as the dotted outline (which lives
     in absolute (q, r) coords and therefore needs the lattice-scroll
     translate in every outline mode). */
  if (isCtrlHeld()) {
    const validPaths = activeValidRefPaths();
    if (validPaths.length > 0) {
      ctx.save();
      ctx.translate(view.CW / 2, cyC);
      ctx.rotate(-tiltAngle);
      ctx.translate(
        -view.viewQ * dxH - view.viewR * dxH * 0.5,
        view.viewR * dyH,
      );
      const diag = Math.ceil(Math.sqrt(view.CW * view.CW + view.CH * view.CH));
      ctx.beginPath();
      ctx.rect(-diag, -diag, diag * 2, diag * 2);
      validPaths.forEach((poly) => {
        for (let i = 0; i < poly.length; i++) {
          if (i === 0) ctx.moveTo(poly[i][0], poly[i][1]);
          else ctx.lineTo(poly[i][0], poly[i][1]);
        }
        ctx.closePath();
      });
      ctx.fillStyle = "rgba(17,17,17,0.5)";
      ctx.fill("evenodd");
      ctx.restore();
    }
  }

  /* === overlay + outline (rotated context, on top of everything) === */
  const outlineMode = getOutlineMode();
  if (outlineMode !== "none") {
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
    if (outlineMode === "piano") {
      ensurePianoOutline();
      ctx.translate(
        -view.viewQ * dxH - view.viewR * dxH * 0.5,
        view.viewR * dyH,
      );
      activePaths = pianoOutlinePaths;
    } else if (outlineMode === "qwerty") {
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
    ctx.fillStyle = showE ? "rgba(17,17,17,0.65)" : "rgba(17,17,17,1.0)";
    ctx.fill("evenodd");

    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3.5;
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
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
  const showValidRef =
    (document.getElementById("cbValidRefBounds") as HTMLInputElement | null)
      ?.checked ?? false;
  if (showValidRef) {
    const validPaths = activeValidRefPaths();
    if (validPaths.length > 0) {
      ctx.save();
      ctx.translate(view.CW / 2, cyC);
      ctx.rotate(-tiltAngle);
      ctx.translate(
        -view.viewQ * dxH - view.viewR * dxH * 0.5,
        view.viewR * dyH,
      );
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2.5;
      ctx.lineCap = "butt";
      ctx.lineJoin = "round";
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
