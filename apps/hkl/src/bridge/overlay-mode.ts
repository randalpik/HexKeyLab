// Tiny, dependency-free overlay-mode probe. Kept separate from the heavy
// bootstrap modules so main.ts can branch on it without importing either path.
//
// `?overlay` turns this HKL instance into a passive OBS Browser Source: it
// renders the lattice (+ Composer frame) transparent and chrome-free, driven
// entirely by the WebSocket mirror from the performing instance — no audio, no
// MIDI, no input.

export function isOverlayMode(): boolean {
  return new URLSearchParams(location.search).has('overlay');
}
