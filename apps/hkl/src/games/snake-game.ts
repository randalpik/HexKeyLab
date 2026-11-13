// Snake, running: the driver that plays the rules of games/snake.ts under the
// host (games/mode.ts). Its clocks, its notes, what it shows and what a press
// does (docs/local/easter-egg-games.md):
//   - Starting shows the board — the layout darkened, the snake white, the food
//     flashing at its normal color — and waits. The first press on a Lumatone
//     key (or a click on one in the canvas) starts the snake and is not a turn.
//   - After that a press on the right half of the case turns the snake
//     clockwise and one on the left half counter-clockwise. Every press is
//     swallowed: steering is silent.
//   - The snake plays the note under its head at each step, quietly and legato,
//     and accents the note of a key where it ate.
//   - Running into the rim or itself ends the game with a short sequence: the
//     snake's note stops, the background stays dark (the food too), and the
//     snake flashes on and off three times, then stays off for a second. Then
//     the game ends, with its score.
//
// Three clocks: the food's flash (from the start), the snake's step (from the
// first press), and the game-over flash (which replaces both).

import { halfOf } from './board.js';
import { QUIET_VELOCITY, ACCENT_VELOCITY, type Game, type Host } from './mode.js';
import { newSnake, turn, step, type SnakeState, type GameOver } from './snake.js';

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

/** Snake in progress, as the gates read it. */
export interface SnakeGame extends Game {
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

export function snakeGame(host: Host): SnakeGame {
  const snake = newSnake(Math.random);
  /* Ticks of the game-over clock so far, and what the modal will say. */
  let overTicks = 0;
  let ending = '';

  const game: SnakeGame = {
    id: 'snake', snake, started: false, over: false, foodLit: true, snakeLit: true,
    /* Every key darkened but the food while it is lit; the snake's keys white
       on top while it is lit. */
    scene: () => ({
      dark: (key) => !(key === snake.food && game.foodLit),
      shapes: game.snakeLit ? snake.body.map((key) => ({ kind: 'tile' as const, key })) : [],
    }),
    press(key) {
      if (game.over) return 'swallow';   /* nothing to steer; a stray press should not sound */
      if (!game.started) {
        /* The first press starts the snake, a whole step from now; it is not a turn. */
        game.started = true;
        host.every(STEP_MS, stepTick);
        return 'swallow';
      }
      turn(snake, halfOf(key) === 'right' ? 'cw' : 'ccw');
      return 'swallow';
    },
    release() { /* steering is the press alone */ },
    click(key) { game.press(key); },
  };

  function flashTick(): void {
    game.foodLit = !game.foodLit;
    host.show();
  }

  function stepTick(): void {
    const moved = step(snake, Math.random);
    if (moved.over) { crash(moved.over); return; }
    host.sound(moved.head, moved.ate ? ACCENT_VELOCITY : QUIET_VELOCITY);
    host.show();
  }

  /* The snake ran into the rim or itself: begin the game-over sequence. The step
     and the food's flash stop, the note stops, and the whole board goes dark with
     the snake flashed off first. */
  function crash(over: GameOver): void {
    host.stop(stepTick);
    host.stop(flashTick);
    game.over = true;
    ending = (over === 'wall' ? 'The snake hit the wall.' : 'The snake ran into itself.')
      + ' Score: ' + snake.eaten + '.';
    game.foodLit = false;
    game.snakeLit = false;
    overTicks = 0;
    host.hush();
    host.every(OVER_FLASH_MS, overTick);
    host.show();
  }

  /* The snake was flashed off at the crash; the next 2 × OVER_FLASHES ticks turn
     it on, off, …, on, off: OVER_FLASHES flashes, ending dark. It stays dark for
     the hold, and then the game ends. */
  function overTick(): void {
    overTicks++;
    const flashTicks = 2 * OVER_FLASHES;
    if (overTicks <= flashTicks) {
      game.snakeLit = overTicks % 2 === 1;
      host.show();
      return;
    }
    if (overTicks < flashTicks + OVER_HOLD_MS / OVER_FLASH_MS) return;
    host.end(ending);
  }

  host.every(FLASH_MS, flashTick);
  return game;
}
