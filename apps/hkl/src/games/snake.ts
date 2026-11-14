// Snake on the Lumatone's keys: the rules only. No clock, color, sound or input
// lives here; games/mode.ts drives this state and shows it. Keys are indices
// into the board (games/board.ts).
//
// Rules (docs/architecture/hkl.md → Hidden games):
//   - The snake starts with its head on the key at offset (0, 0) and three body
//     keys behind it on the same row, heading along the row toward higher u.
//   - Each step moves the head one key along the heading. Leaving the board or
//     entering the snake's own body ends the game. The tail moves out of the way
//     first, so the head may enter the key the tail is leaving.
//   - A turn rotates the heading by one of the six directions, at once; turns
//     made before the next step add up.
//   - Entering the food grows the snake by one key and places new food.
//   - Food never appears on the snake. Among the free keys it avoids, while it
//     can, keys in the snake's direct path, keys touching an edge, and keys
//     touching the snake — giving up the last of those first, then the edge,
//     then the path.

import { HEADINGS, KEY_COUNT, keyAt, neighbor, neighbors, touchesEdge } from './board.js';

export type Turn = 'cw' | 'ccw';
export type GameOver = 'wall' | 'self';

export interface SnakeState {
  /** Keys the snake occupies, head first. */
  body: number[];
  /** Index into HEADINGS. */
  heading: number;
  /** The food's key, or −1 when the board has no free key. */
  food: number;
  /** Foods eaten so far. */
  eaten: number;
  /** Set once the game has ended; no further step changes the state. */
  over: GameOver | null;
}

export interface StepResult {
  /** The head's key after the step, or −1 when the step ended the game. */
  head: number;
  /** True when this step ate the food. */
  ate: boolean;
  over: GameOver | null;
}

/** `random` returns a number in [0, 1), like Math.random. */
export type Random = () => number;

export const START_LENGTH = 4;

export function newSnake(random: Random): SnakeState {
  const body: number[] = [];
  for (let n = 0; n < START_LENGTH; n++) body.push(keyAt(-n, 0));
  const state: SnakeState = { body, heading: 0, food: -1, eaten: 0, over: null };
  state.food = placeFood(state, random);
  return state;
}

export function turn(state: SnakeState, t: Turn): void {
  if (state.over) return;
  const n = HEADINGS.length;
  state.heading = (state.heading + (t === 'ccw' ? 1 : n - 1)) % n;
}

export function step(state: SnakeState, random: Random): StepResult {
  if (state.over) return { head: -1, ate: false, over: state.over };
  const next = neighbor(state.body[0], state.heading);
  if (next < 0) return end(state, 'wall');
  const ate = next === state.food;
  /* The tail's key is free to enter unless the snake grows this step, and it
     only grows onto food, which is never on the snake. */
  if (state.body.indexOf(next) >= 0 && next !== state.body[state.body.length - 1]) return end(state, 'self');
  state.body.unshift(next);
  if (ate) {
    state.eaten++;
    state.food = placeFood(state, random);
  } else {
    state.body.pop();
  }
  return { head: next, ate, over: null };
}

function end(state: SnakeState, over: GameOver): StepResult {
  state.over = over;
  return { head: -1, ate: false, over };
}

/** The keys from the head along the current heading to the edge. */
export function directPath(state: SnakeState): number[] {
  const path: number[] = [];
  for (let k = neighbor(state.body[0], state.heading); k >= 0; k = neighbor(k, state.heading)) path.push(k);
  return path;
}

/** The food candidates in order of preference: each list drops one more wish
 *  than the one before, and the first non-empty one is used. */
export function foodTiers(state: SnakeState): number[][] {
  const onSnake = new Set(state.body);
  const nearSnake = new Set<number>();
  state.body.forEach((k) => { neighbors(k).forEach((n) => nearSnake.add(n)); });
  const inPath = new Set(directPath(state));
  const free: number[] = [];
  for (let k = 0; k < KEY_COUNT; k++) if (!onSnake.has(k)) free.push(k);
  const offPath = free.filter((k) => !inPath.has(k));
  const offEdge = offPath.filter((k) => !touchesEdge(k));
  const clear = offEdge.filter((k) => !nearSnake.has(k));
  return [clear, offEdge, offPath, free];
}

/** A key for new food, or −1 when the snake covers the whole board. */
export function placeFood(state: SnakeState, random: Random): number {
  for (const tier of foodTiers(state)) {
    if (tier.length) return tier[Math.min(tier.length - 1, Math.floor(random() * tier.length))];
  }
  return -1;
}
