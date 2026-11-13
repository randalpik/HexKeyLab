// What a running game shows on the Lumatone's keys. The game's host sets one
// function that returns the scene (games/scene.ts: darkened keys and white
// shapes); the two renderers read it and nothing else about the game. The
// device sync (lumatone/sync.ts) turns it into LED colors, and the canvas
// (render/draw.ts) paints the same scene over the Lumatone outline.
//
// Kept apart from games/mode.ts, which hosts the game and pulls in the audio
// and input paths: this module is state only, so the color sync and the lean
// overlay build can import it.

import type { Scene } from './scene.js';

/** Brightness a darkened key keeps on the device: each LED channel scaled toward
 *  off. Starts at the ref-edit dim's level (lumatone/sync.ts REF_DIM_LED); set by
 *  eye. The canvas uses its own cover (render/colors.ts REF_DIM_FILL). */
export const GAME_DIM_LED = 0.3;

let source: (() => Scene) | null = null;

/** Set by the host of the running game (games/mode.ts); null when no game is
 *  shown. The function is asked each time a renderer draws, so it returns the
 *  game's scene as it is then. */
export function setGameScene(fn: (() => Scene) | null): void {
  source = fn;
}

export function gameShowing(): boolean {
  return source !== null;
}

/** The running game's scene now, or null when no game is shown. */
export function gameScene(): Scene | null {
  return source ? source() : null;
}
