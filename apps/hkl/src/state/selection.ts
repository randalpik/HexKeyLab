import type { KeyId } from '../types.js';

// Per-frame selection state. drawnKeys is rebuilt every animation frame from
// selectedKeys + the current layout-shift delta — see lessons.md (selection
// state is per-frame, recomputed via layout-shift delta).
//
// hoverKey is the lattice key under the mouse cursor (or null). Updated by
// the canvas mousemove handler; read by draw() for the hover lightening pass.
//
// flashUntil holds "q,r" -> performance.now() expiry timestamps for keys that
// should paint as UNSELECTED even though they are in selectedKeys, producing a
// brief off-on blink. It is a modifier on selectedKeys, which is why it lives
// here and why draw() reads both in the same pass. Written only through
// render/key-flash.ts. (It lived in state/audio.ts until 2026-09-15 — a
// render instruction stranded among AudioContext/GainNode fields, which is
// what kept the OBS overlay, audio-free by design, from mirroring the blink.)

export interface DrawnKey {
  q: number;
  r: number;
  /** unrotated lattice space x-offset from view center */
  ux: number;
  uy: number;
  /** screen-space (rotated) center, including kbOffY shift */
  sx: number;
  sy: number;
  /** true if this key is part of the physical Lumatone footprint at the
      current layout shift (vs. an extended-pattern ghost key). */
  isKb: boolean;
}

export const selection: {
  selectedKeys: Set<KeyId>;
  drawnKeys: DrawnKey[];
  hoverKey: KeyId | null;
  flashUntil: Record<KeyId, number>;
} = {
  selectedKeys: new Set(),
  drawnKeys: [],
  hoverKey: null,
  flashUntil: {},
};
