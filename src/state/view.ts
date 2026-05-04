// Canvas viewport metrics + view center + dirty flags.
//
// CH/kbMinW/kbOffY are populated at module load by render/canvas.ts (from
// baseKeys). CW changes on window resize via sizeCanvas.
//
// viewQ/viewR are the lattice-space view center. They're updated by
// render/animation.ts during a layout-switch tween; read by the draw pipeline.
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
  hexDirty: true,
  textDirty: true,
};
