// The running hidden game: its clocks, its notes, the input it takes, and when
// it starts and ends. The rules are games/snake.ts; what it shows is one
// function handed to games/display.ts, which the device sync and the canvas
// read.
//
// A game lives on the Lumatone's physical keys (games/board.ts). The lattice
// under them only supplies colors and notes, so a ref, mode, mapping or
// alignment change mid-game needs no handling here.
//
// Snake (docs/local/easter-egg-games.md):
//   - Starting shows the board — the layout darkened, the snake white, the food
//     flashing at its normal color — and waits. The first press on a Lumatone
//     key (or a click on one in the canvas) starts the snake and is not a turn.
//   - After that a press on the right half of the case turns the snake
//     clockwise and one on the left half counter-clockwise. Presses the game
//     takes are not notes (midi/handler.ts, ui/init.ts).
//   - The snake plays the note under its head at each step, quietly and legato,
//     and accents the note of a key where it ate. It plays as a held source of
//     its own (input/held.ts 'game'), so the notes behave like a player's.
//   - Running into the rim or itself ends the game with a short sequence: the
//     snake's note stops, the background stays dark (the food too), and the
//     snake flashes on and off three times, then stays off for a second. Then
//     the game leaves the keys and the listener is told the result.
//   - Leaving the Lumatone outline ends a game at once, without a result.
//
// Three clocks, each a plain interval: the food's flash (from the start), the
// snake's step (from the first press), and the game-over flash (which replaces
// both). None does anything while the page is hidden, where browsers slow
// timers down.

import { DEFAULT_DYNAMIC_MAP } from '@hkl/shared/dynamics.js';
import { lumatoneCell } from '../layout/physical.js';
import { pressHeld, releaseHeld } from '../input/held.js';
import { syncLumatoneColors } from '../lumatone/sync.js';
import { requestDraw, getOutlineMode } from '../render/draw.js';
import { KEY_COUNT, halfOf } from './board.js';
import { setGamePicture } from './display.js';
import { newSnake, turn, step, type SnakeState, type GameOver } from './snake.js';
import type { KeyId } from '../types.js';

/** Time between the snake's steps. Constant: the snake's length is what makes
 *  the game harder. To be tuned. */
export const STEP_MS = 300;
/** Time between the food's changes, lit to dark or back. Its own clock, apart
 *  from the step. */
export const FLASH_MS = 200;
/** The game-over sequence: the snake goes on and off OVER_FLASHES times, each
 *  change OVER_FLASH_MS after the last, then stays off for OVER_HOLD_MS. */
export const OVER_FLASHES = 3;
export const OVER_FLASH_MS = 100;
export const OVER_HOLD_MS = 1000;
/** Velocity of the note under the snake's head, and of the note where it ate.
 *  Picked by ear. */
export const QUIET_VELOCITY = DEFAULT_DYNAMIC_MAP.pp;
export const ACCENT_VELOCITY = DEFAULT_DYNAMIC_MAP.f;

/** How a game ended. */
export interface GameResult {
  game: string;
  over: GameOver;
  /** Foods eaten. */
  eaten: number;
}

/** The game in progress, as the toolbar and the gates read it. */
export interface RunningGame {
  readonly id: string;
  /** False while the board is shown and the game waits for its first press. */
  started: boolean;
  /** True once the snake has crashed and the game-over sequence is playing. */
  over: boolean;
  /** Whether the food shows its normal color right now (it flashes). */
  foodLit: boolean;
  /** Whether the snake shows white right now (it flashes in the game-over
   *  sequence, and is lit otherwise). */
  snakeLit: boolean;
  readonly snake: SnakeState;
}

type Timer = ReturnType<typeof setInterval>;

interface Run extends RunningGame {
  flashTimer: Timer | null;
  stepTimer: Timer | null;
  overTimer: Timer | null;
  /** Ticks of the game-over clock so far. */
  overTicks: number;
  /** Set when the snake crashes; reported when the sequence is done. */
  result: GameResult | null;
  /** Held-input id of the note the snake is sounding, if any. */
  note: string | null;
  notes: number;
}

let run: Run | null = null;

/* Told when a game starts or stops (null) and when one ends by its rules (the
   result). Registered by ui/secrets.ts, which owns the toolbar and the modal. */
let listener: ((result: GameResult | null) => void) | null = null;
export function setGameListener(fn: (result: GameResult | null) => void): void { listener = fn; }

export function runningGame(): RunningGame | null {
  return run;
}

/** Start game `id`, replacing any game in progress. */
export function startGame(id: string): void {
  if (run) stopGame();
  if (id !== 'snake') return;
  const snake = newSnake(Math.random);
  const r: Run = {
    id, snake, started: false, over: false, foodLit: true, snakeLit: true,
    flashTimer: setInterval(flashTick, FLASH_MS), stepTimer: null, overTimer: null,
    overTicks: 0, result: null, note: null, notes: 0,
  };
  run = r;
  setGamePicture((key) => {
    if (snake.body.indexOf(key) >= 0) return r.snakeLit ? 'white' : 'dim';
    return key === snake.food && r.foodLit ? 'normal' : 'dim';
  });
  show();
  if (listener) listener(null);
}

/** Stop the game in progress without a result. */
export function stopGame(): void {
  if (!run) return;
  clear();
  if (listener) listener(null);
}

function stopClocks(r: Run): void {
  if (r.flashTimer !== null) clearInterval(r.flashTimer);
  if (r.stepTimer !== null) clearInterval(r.stepTimer);
  if (r.overTimer !== null) clearInterval(r.overTimer);
  r.flashTimer = r.stepTimer = r.overTimer = null;
}

function silence(r: Run): void {
  if (r.note) releaseHeld('game', r.note);
  r.note = null;
}

/* Take the game off the keys: clocks, picture, note. */
function clear(): void {
  const r = run;
  if (!r) return;
  stopClocks(r);
  run = null;
  setGamePicture(null);
  silence(r);
  show();
}

function show(): void {
  requestDraw();
  syncLumatoneColors();
}

/* Whether a clock's tick should do anything: not while the page is hidden, and
   not once the Lumatone outline is gone, which ends the game. */
function live(): boolean {
  if (document.hidden) return false;
  if (getOutlineMode() !== 'lumatone') { stopGame(); return false; }
  return true;
}

function flashTick(): void {
  const r = run;
  if (!r || !live()) return;
  r.foodLit = !r.foodLit;
  show();
}

function stepTick(): void {
  const r = run;
  if (!r || !live()) return;
  const moved = step(r.snake, Math.random);
  if (moved.over) { crash(r, moved.over); return; }
  sound(r, moved.head, moved.ate);
  show();
}

/* The snake's line: strike the key now under its head, then release the one
   before, so the notes overlap into a legato line. */
function sound(r: Run, key: number, accent: boolean): void {
  const [q, c] = lumatoneCell(key);
  const id = 'head' + (++r.notes);
  pressHeld('game', id, q + ',' + c, accent ? ACCENT_VELOCITY : QUIET_VELOCITY);
  if (r.note) releaseHeld('game', r.note);
  r.note = id;
}

/* The snake ran into the rim or itself: begin the game-over sequence. The step
   and the food's flash stop, the note stops, and the whole board goes dark with
   the snake flashed off first. */
function crash(r: Run, over: GameOver): void {
  stopClocks(r);
  r.over = true;
  r.result = { game: r.id, over, eaten: r.snake.eaten };
  r.foodLit = false;
  r.snakeLit = false;
  r.overTicks = 0;
  silence(r);
  r.overTimer = setInterval(overTick, OVER_FLASH_MS);
  show();
}

/* The snake was flashed off at the crash; the next 2 × OVER_FLASHES ticks turn
   it on, off, …, on, off: OVER_FLASHES flashes, ending dark. It stays dark for
   the hold, and then the game leaves the keys. */
function overTick(): void {
  const r = run;
  if (!r || !live()) return;
  r.overTicks++;
  const flashTicks = 2 * OVER_FLASHES;
  if (r.overTicks <= flashTicks) {
    r.snakeLit = r.overTicks % 2 === 1;
    show();
    return;
  }
  if (r.overTicks < flashTicks + OVER_HOLD_MS / OVER_FLASH_MS) return;
  const result = r.result;
  clear();
  if (listener) listener(result);
}

/** Offer a press of Lumatone key `key` (0–279) to the running game. True when
 *  the game took it, and the press is then not a note. */
export function captureGamePress(key: number): boolean {
  const r = run;
  if (!r || key < 0 || key >= KEY_COUNT) return false;
  if (r.over) return true;   /* nothing to steer; a stray press should not sound */
  if (!r.started) {
    /* The first press starts the snake, a whole step from now; it is not a turn. */
    r.started = true;
    r.stepTimer = setInterval(stepTick, STEP_MS);
    return true;
  }
  turn(r.snake, halfOf(key) === 'right' ? 'cw' : 'ccw');
  return true;
}

/** Offer a canvas click on lattice cell `cell` to the running game: taken when
 *  a Lumatone key plays that cell, as a press of that key. */
export function captureGameClick(cell: KeyId): boolean {
  if (!run) return false;
  for (let key = 0; key < KEY_COUNT; key++) {
    const [q, c] = lumatoneCell(key);
    if (q + ',' + c === cell) return captureGamePress(key);
  }
  return false;
}
