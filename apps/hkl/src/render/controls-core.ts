// Render-only control primitives — the engine-free core extracted from
// ui/controls.ts so the OBS-overlay subscriber can drive the lattice (view,
// rotation, hex size, tuning re-color, outline) WITHOUT pulling in the audio
// engine, MIDI, Lumatone sync, or the Composer bridge.
//
// Everything here imports only geometry / render / state — no `audio/*`,
// `midi/*`, `lumatone/*`, or `bridge/hkl-side`. The full ui/controls.ts
// re-exports these and layers the engine side-effects (onTuningChanged /
// onRefChanged / transpose audio re-keying) on top.

import { view } from '../state/view.js';
import { referenceNote } from '../state/reference.js';
import { setRotation, setHexSize } from '../layout/geometry.js';
import { recomputeCanvasBounds, computePianoViewCenter } from './canvas.js';
import {
  cv, draw, startLayoutAnim, currentMidi64Cell, buildHexLayerForTween,
  snapViewForOutline, invalidatePianoOutline, rebuildScaleGeometry,
} from './draw.js';
import { animation } from './animation.js';
import type { HexSize, OutlineMode, RotationMode } from '../state/persistence.js';

function outlineFromDom(): OutlineMode {
  const sel = document.getElementById('selOutline') as HTMLSelectElement | null;
  return (sel?.value === 'qwerty' || sel?.value === 'piano' || sel?.value === 'none')
    ? sel.value : 'lumatone';
}

/* Compute the view-center the active outline wants and animate to it.
   - piano: solve for the viewport that places refNote at screen-X = 0
     (horizontal center) AND MIDI 64's cell at screen-Y = 0 (vertical
     center). The 2×2 linear system in lattice coords is tilt-aware —
     under any rotation the outline's vertical extent stays minimized
     (MIDI 64 is at the midpoint of the 88-key pitch range) while the
     lattice shifts horizontally as refNote moves.
   - other outlines: the layout-shift center as usual.
   For piano-mode tweens we pre-rebuild the hex layer covering BOTH
   endpoints (start + target) — animating through a region the layer
   wasn't rebuilt for produces the cut-off-borders artifact. The expanded
   layer survives the whole tween and shrinks back on the next normal
   rebuild. `immediate` skips the tween and snaps; used at init so a
   fresh load lands without a startup animation, and for outline-switch
   transitions (where snap was already the design). */
export function syncViewToOutline(outline: OutlineMode, immediate: boolean): void {
  let targetQ: number, targetR: number;
  if (outline === 'piano') {
    const [m64Q, m64R] = currentMidi64Cell();
    [targetQ, targetR] = computePianoViewCenter(referenceNote.q, referenceNote.r, m64Q, m64R);
  } else {
    /* Lumatone / QWERTY / none: lattice slides under the static outline so
       kbAnchor lands at the outline's center. kbAnchor is only updated by
       user-driven ref changes — Composer-driven changes leave it (and thus
       the visible layout) untouched. */
    targetQ = view.kbAnchorQ;
    targetR = view.kbAnchorR;
  }
  if (immediate) {
    view.viewQ = targetQ;
    view.viewR = targetR;
    return;
  }
  if (view.viewQ === targetQ && view.viewR === targetR) return;
  /* Build the hex layer to cover [view → target] before the tween fires so
     each animation frame blits from a layer that actually has the in-flight
     view position covered. */
  buildHexLayerForTween(view.viewQ, view.viewR, targetQ, targetR);
  animation.tweenTo(targetQ, targetR);
  startLayoutAnim();
}

export function applyRotation(mode: RotationMode): void {
  setRotation(mode);
  recomputeCanvasBounds();
  cv.style.height = view.CH + 'px';
  /* Re-snap unconditionally — piano viewport solves a tilt-dependent system,
     so a stale viewQ/viewR drifts the cells + dark-overlay rect off-center
     after a rotation change. No-op for non-piano beyond setting the
     layout-shift center. */
  snapViewForOutline(outlineFromDom());
  view.hexDirty = true;
  view.textDirty = true;
}

/* Apply a hex-size preset: rescale geometry, rebuild scale-dependent caches,
   recompute bounds, and re-snap the view (same lattice cell stays centered —
   hexToScreen is center-relative). Modeled on applyRotation. */
export function applyHexSize(size: HexSize): void {
  setHexSize(size);
  rebuildScaleGeometry();
  recomputeCanvasBounds();
  cv.style.height = view.CH + 'px';
  snapViewForOutline(outlineFromDom());
  view.hexDirty = true;
  view.textDirty = true;
}

/* Render fan-out for a tuning-mode change: re-color/respell (hex+text dirty),
   regenerate the 88-cell footprint (Tenney-Height depends on mode), recompute
   bounds (mode can change CH and MIDI-64's cell), re-snap, redraw. The audio
   re-tune + Lumatone color push + Composer broadcast live in
   effects/onTuningChanged.ts (full app only). */
export function applyTuningRender(): void {
  view.hexDirty = true;
  view.textDirty = true;
  invalidatePianoOutline();
  recomputeCanvasBounds();
  cv.style.height = view.CH + 'px';
  snapViewForOutline(outlineFromDom());
  draw();
}

/* Render fan-out for an outline-mode change: each outline has its own canvas
   bounds; resize, then snap (immediate — the canvas height also changes
   instantly, so animating the view looks half-broken) and redraw. The
   ref-recompute + onRefChanged migration + footprint broadcast live in
   ui/controls.ts setOutline (full app only). */
export function applyOutlineRender(outline: OutlineMode): void {
  recomputeCanvasBounds(outline);
  cv.style.height = view.CH + 'px';
  view.hexDirty = true;
  view.textDirty = true;
  syncViewToOutline(outline, true);
  draw();
}
