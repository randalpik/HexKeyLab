// What a running game shows on the Lumatone's keys. A game sets one function
// from key index to look; the two renderers read it and nothing else about the
// game: the device sync (lumatone/sync.ts) turns a look into an LED color, and
// the canvas (render/draw.ts) paints the same look over the Lumatone outline.
//
// Kept apart from games/mode.ts, which drives the game and pulls in the audio
// and input paths: this module is state only, so the color sync and the lean
// overlay build can import it.

/** How a key looks while a game runs: its normal layout color, that color
 *  darkened, or white. */
export type KeyLook = 'normal' | 'dim' | 'white';

/** Brightness a darkened key keeps on the device: each LED channel scaled toward
 *  off. Starts at the ref-edit dim's level (lumatone/sync.ts REF_DIM_LED); set by
 *  eye. The canvas uses its own cover (render/colors.ts REF_DIM_FILL). */
export const GAME_DIM_LED = 0.3;

let picture: ((key: number) => KeyLook) | null = null;

/** Set by the running game (games/mode.ts); null when no game is shown. */
export function setGamePicture(fn: ((key: number) => KeyLook) | null): void {
  picture = fn;
}

export function gameShowing(): boolean {
  return picture !== null;
}

/** The look of Lumatone key `key` (0–279): 'normal' when no game is shown. */
export function gameKeyLook(key: number): KeyLook {
  return picture ? picture(key) : 'normal';
}
