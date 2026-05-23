// Canvas viewport metrics + view center + dirty flags.
//
// CH/kbMinW/kbOffY are populated at module load by render/canvas.ts (from
// baseKeys). CW changes on window resize via sizeCanvas.
//
// viewQ/viewR are the lattice-space view center. They're updated by
// render/animation.ts during a layout-switch tween; read by the draw pipeline.
//
// kbAnchorQ/kbAnchorR are the lattice anchor for the static Lumatone / QWERTY
// outlines — the spine cell that lands at the outline's center. Updated only
// by user-driven ref changes (Ctrl+click in src/ui/init.ts, tuning-mode auto-
// clear in src/ui/controls.ts) so Composer-driven ref changes leave the
// physical Lumatone / QWERTY layout untouched. Piano-mode view geometry is
// ref-coupled by design and reads `referenceNote` directly, not kbAnchor.
//
// hexDirty/textDirty signal that the offscreen layers need rebuild on the next
// draw(). Set true by tuning/layout/extend toggles; cleared by the layer build
// inside draw().
//
// Read or write `view.X` directly.

export const view = {
  CW: 0,
  CH: 0,
  kbMinW: 0,
  kbOffY: 0,
  viewQ: 0,
  viewR: 0,
  kbAnchorQ: 0,
  kbAnchorR: 0,
  hexDirty: true,
  textDirty: true,
};
