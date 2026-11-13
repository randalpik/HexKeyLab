// Pong's rules, as pure functions over a state: no clocks, no notes, no DOM. A
// driver plays them under the host (games/mode.ts), as Snake's does; the Node
// oracle (test/games/oracle.mjs) checks them alone. Spec and rulings:
// docs/local/easter-egg-games.md.
//
// Everything is in the case's frame (games/board.ts): lengths in key widths,
// origin at the field's center, x toward the right half, y toward the top wall.
// Times are in milliseconds, speeds in key widths a second.
//
//   - Two players, one half of the keys each. The two keys exactly on the
//     center line are nobody's, and one of them, (0, 1), is where the ball
//     starts.
//   - A player's first held key is a bumper, a disc. A second one within
//     PADDLE_REACH key steps of it makes a paddle, a round-ended line between
//     the two. Nothing more is honored until one is let go.
//   - The ball is a disc. It flies straight and reflects off the long sides,
//     the bumpers and the paddles, about the surface's normal where it touches.
//     A paddle cannot move, so it adds nothing to the ball's motion.
//   - A press is refused if the bumper or paddle it would make touches the
//     ball, or the ball's place on the starting key, which is kept clear
//     always: the ball never comes back into a paddle.
//   - A goal is the whole ball passing an end. The point goes to the player of
//     the other half. First to WIN_SCORE wins.
//   - The shapes drawn are the shapes the ball meets: `pongShapes` and the
//     collisions read the same sizes.

import {
  keyAt, keyPoint, halfOf, onCenterLine, keyDistance, FIELD_WALL, FIELD_END, ROW, type Half,
} from './board.js';
import type { Shape } from './scene.js';

/** The ball is one key wide. To be tuned. */
export const BALL_RADIUS = 0.5;
/** Half the thickness of a paddle, and the radius of a bumper. To be tuned. */
export const PADDLE_HALF = 0.4;
/** The farthest apart, in key steps, two keys may be to make a paddle. */
export const PADDLE_REACH = 4;
/** The center line: dashes this long with gaps this long, this far to each
 *  side of x = 0. One dash is centered on the field's center. */
export const LINE_DASH = 1;
export const LINE_GAP = 1;
export const LINE_HALF = 0.1;

/** The ball's speed at the first serve; what it gains each second of play; and
 *  its limit. After a goal it drops halfway back to the starting speed. All
 *  guesses, to be tuned. */
export const START_SPEED = 8;
export const SPEED_GAIN = 0.25;
export const TOP_SPEED = 24;
/** The ball moves in steps no longer than this, so it cannot pass through a
 *  bumper or a paddle between two of them. */
export const MAX_STEP = 0.1;

/** The key the ball starts on: the key on the center line nearest the middle. */
export const SERVE_KEY = keyAt(0, 1);
/** Before every serve the ball flashes on and off SERVE_FLASHES times on the
 *  starting key, each change SERVE_FLASH_MS after the last, and then is in
 *  play. No ball is on the field before that warning begins. */
export const SERVE_FLASHES = 3;
export const SERVE_FLASH_MS = 200;
/** After a goal the ball is gone this long before the next serve's warning. */
export const GOAL_PAUSE_MS = 1000;
export const WIN_SCORE = 3;

/** The widest angles a serve may take from the case's long direction, in
 *  degrees, toward each half: the largest whole degrees at which the ball
 *  reaches the end with at most two bounces off the long sides. Worked out
 *  ahead of time (the starting key and the field are facts of the hardware) and
 *  checked by the oracle, which traces the paths; nothing is traced in play.
 *  The four differ because the ends are tilted and the starting key is 0.9
 *  above the middle. */
export const SERVE_RANGE: Readonly<Record<Half, { readonly up: number; readonly down: number }>> = {
  right: { up: 49, down: 48 },
  left: { up: 46, down: 52 },
};

export type PongPhase =
  /** The field is shown with no ball; nothing moves. */
  | 'waiting'
  /** The serve's warning: the ball flashes on the starting key. */
  | 'serve'
  | 'play'
  /** After a goal: the ball is gone. */
  | 'pause'
  | 'over';

export interface PongState {
  phase: PongPhase;
  /** Time spent so far in the serve's warning or the pause. */
  clock: number;
  /** The ball's center: on the starting key through a serve's warning, and
   *  null when there is no ball (before the first warning, after a goal, after
   *  the match). */
  ball: { x: number; y: number } | null;
  /** The ball's direction in play, a unit vector. */
  dir: { x: number; y: number };
  speed: number;
  score: Record<Half, number>;
  /** Each half's honored keys in the order they were pressed: none, one (a
   *  bumper) or two (a paddle). */
  held: Record<Half, number[]>;
  winner: Half | null;
}

/** What happened during an `advance`, in order. */
export type PongEvent =
  /** The warning is over and the ball is moving. */
  | { readonly kind: 'served' }
  /** The ball bounced off a long side. */
  | { readonly kind: 'wall' }
  /** The ball bounced off `half`'s bumper or paddle, made by `keys`. */
  | { readonly kind: 'hit'; readonly half: Half; readonly keys: ReadonlyArray<number> }
  | { readonly kind: 'goal'; readonly scorer: Half }
  | { readonly kind: 'over'; readonly winner: Half };

const HALVES: ReadonlyArray<Half> = ['left', 'right'];
const [START_X, START_Y] = keyPoint(SERVE_KEY);

export function newPong(): PongState {
  return {
    phase: 'waiting', clock: 0,
    ball: null, dir: { x: 1, y: 0 }, speed: START_SPEED,
    score: { left: 0, right: 0 }, held: { left: [], right: [] }, winner: null,
  };
}

/** Whose key `key` is: null for a key on the center line. */
export function playerOf(key: number): Half | null {
  return onCenterLine(key) ? null : halfOf(key);
}

/** Leave the wait: the first serve's warning begins. */
export function begin(state: PongState): void {
  if (state.phase !== 'waiting') return;
  state.phase = 'serve';
  state.clock = 0;
  state.ball = { x: START_X, y: START_Y };
}

/** Whether the ball shows now: in play, and in the lit halves of a serve's
 *  warning, which begins lit. The field has no ball at any other time. */
export function ballLit(state: PongState): boolean {
  if (state.phase === 'play') return true;
  if (state.phase === 'serve') return Math.floor(state.clock / SERVE_FLASH_MS) % 2 === 0;
  return false;
}

/* The point of the bumper (one key) or paddle (two) made by `keys` nearest to
   (x, y): the key's center, or the nearest point of the line between the two. */
function nearestOn(keys: ReadonlyArray<number>, x: number, y: number): readonly [number, number] {
  const [ax, ay] = keyPoint(keys[0]);
  if (keys.length === 1) return [ax, ay];
  const [bx, by] = keyPoint(keys[1]);
  const lx = bx - ax, ly = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * lx + (y - ay) * ly) / (lx * lx + ly * ly)));
  return [ax + t * lx, ay + t * ly];
}

/* How far (x, y) is from the spine of the bumper or paddle made by `keys`. */
function gapTo(keys: ReadonlyArray<number>, x: number, y: number): number {
  const [nx, ny] = nearestOn(keys, x, y);
  return Math.hypot(x - nx, y - ny);
}

/* Whether the bumper or paddle made by `keys` would overlap a ball at (x, y). */
function touches(keys: ReadonlyArray<number>, x: number, y: number): boolean {
  return gapTo(keys, x, y) < BALL_RADIUS + PADDLE_HALF;
}

/** A press of Lumatone key `key`. True when it is honored: the key is now a
 *  bumper, or completes a paddle. A key that is not honored stays that way
 *  until it is pressed again. */
export function press(state: PongState, key: number): boolean {
  if (state.phase === 'over') return false;
  const player = playerOf(key);
  if (!player) return false;
  const held = state.held[player];
  if (held.includes(key)) return true;
  if (held.length >= 2) return false;
  if (held.length === 1 && keyDistance(held[0], key) > PADDLE_REACH) return false;
  const made = [...held, key];
  if (touches(made, START_X, START_Y)) return false;
  if (state.phase === 'play' && state.ball && touches(made, state.ball.x, state.ball.y)) return false;
  held.push(key);
  return true;
}

/** The release of Lumatone key `key`. An honored key is let go; of a paddle,
 *  the other key stays as a bumper. */
export function release(state: PongState, key: number): void {
  for (const half of HALVES) {
    const at = state.held[half].indexOf(key);
    if (at >= 0) state.held[half].splice(at, 1);
  }
}

function serve(state: PongState, random: () => number): void {
  const toward: Half = random() < 0.5 ? 'left' : 'right';
  const range = SERVE_RANGE[toward];
  const angle = (-range.down + random() * (range.up + range.down)) * Math.PI / 180;
  state.dir = { x: (toward === 'right' ? 1 : -1) * Math.cos(angle), y: Math.sin(angle) };
  state.ball = { x: START_X, y: START_Y };
  state.phase = 'play';
}

function goal(state: PongState, scorer: Half, events: PongEvent[]): void {
  state.score[scorer]++;
  state.ball = null;
  state.clock = 0;
  events.push({ kind: 'goal', scorer });
  if (state.score[scorer] >= WIN_SCORE) {
    state.phase = 'over';
    state.winner = scorer;
    events.push({ kind: 'over', winner: scorer });
    return;
  }
  state.phase = 'pause';
  state.speed = (state.speed + START_SPEED) / 2;
}

/* Move the ball for `ms` of play, short enough to be one step, and settle what
   it ran into. */
function step(state: PongState, ms: number, events: PongEvent[]): void {
  const ball = state.ball!, dir = state.dir;
  const far = state.speed * ms / 1000;
  ball.x += dir.x * far;
  ball.y += dir.y * far;
  state.speed = Math.min(TOP_SPEED, state.speed + SPEED_GAIN * ms / 1000);

  /* The long sides: the ball's edge meets the wall. */
  const limit = FIELD_WALL - BALL_RADIUS;
  if (ball.y > limit && dir.y > 0) {
    ball.y = 2 * limit - ball.y;
    dir.y = -dir.y;
    events.push({ kind: 'wall' });
  } else if (ball.y < -limit && dir.y < 0) {
    ball.y = -2 * limit - ball.y;
    dir.y = -dir.y;
    events.push({ kind: 'wall' });
  }

  /* Bumpers and paddles. The step may leave the ball overlapping one; it was
     clear when the step began, so somewhere along the step it first touched.
     That point is found by halving, the direction is reflected about the
     normal there (the line from the nearest point of the shape's spine to the
     ball's center), and the rest of the step is flown in the new direction. */
  const reach = BALL_RADIUS + PADDLE_HALF;
  for (const half of HALVES) {
    const keys = state.held[half];
    if (keys.length === 0 || gapTo(keys, ball.x, ball.y) >= reach) continue;
    let clear = far, inside = 0;
    for (let i = 0; i < 30; i++) {
      const mid = (clear + inside) / 2;
      if (gapTo(keys, ball.x - dir.x * mid, ball.y - dir.y * mid) < reach) inside = mid;
      else clear = mid;
    }
    const cx = ball.x - dir.x * clear, cy = ball.y - dir.y * clear;
    const [px, py] = nearestOn(keys, cx, cy);
    const gap = Math.hypot(cx - px, cy - py);
    if (gap > 0) {
      const nx = (cx - px) / gap, ny = (cy - py) / gap;
      const into = dir.x * nx + dir.y * ny;
      if (into < 0) {
        dir.x -= 2 * into * nx;
        dir.y -= 2 * into * ny;
        ball.x = cx + dir.x * clear;
        ball.y = cy + dir.y * clear;
        events.push({ kind: 'hit', half, keys: [...keys] });
      }
    }
    /* Still overlapping (it was not moving into the shape, or it is wedged
       against something else): set it back to touching. */
    const [qx, qy] = nearestOn(keys, ball.x, ball.y);
    const left = Math.hypot(ball.x - qx, ball.y - qy);
    if (left > 0 && left < reach) {
      ball.x = qx + (ball.x - qx) / left * reach;
      ball.y = qy + (ball.y - qy) / left * reach;
    }
  }

  /* A goal: the whole ball is past an end. */
  const along = ball.x * ROW[0] + ball.y * ROW[1];
  if (along > FIELD_END + BALL_RADIUS) goal(state, 'left', events);
  else if (along < -FIELD_END - BALL_RADIUS) goal(state, 'right', events);
}

/** Let `ms` pass. Nothing happens while the game waits or is over. `random`
 *  picks each serve's side and angle. */
export function advance(state: PongState, ms: number, random: () => number): PongEvent[] {
  const events: PongEvent[] = [];
  let left = ms;
  while (left > 0) {
    if (state.phase === 'waiting' || state.phase === 'over') break;
    if (state.phase === 'serve' || state.phase === 'pause') {
      const whole = state.phase === 'serve' ? 2 * SERVE_FLASHES * SERVE_FLASH_MS : GOAL_PAUSE_MS;
      const use = Math.min(left, whole - state.clock);
      state.clock += use;
      left -= use;
      if (state.clock < whole) break;
      state.clock = 0;
      if (state.phase === 'serve') {
        serve(state, random);
        events.push({ kind: 'served' });
      } else {
        state.phase = 'serve';
        state.ball = { x: START_X, y: START_Y };
      }
      continue;
    }
    const use = Math.min(left, MAX_STEP / state.speed * 1000);
    step(state, use, events);
    left -= use;
  }
  return events;
}

/* The center line's dashes, from wall to wall: one centered on the field's
   center, the rest a dash and a gap apart, cut off at the walls. */
const CENTER_LINE: ReadonlyArray<Shape> = (() => {
  const dashes: Shape[] = [];
  for (let c = 0; c - LINE_DASH / 2 < FIELD_WALL; c += LINE_DASH + LINE_GAP) {
    for (const mid of c === 0 ? [0] : [c, -c]) {
      dashes.push({
        kind: 'line', x1: 0, y1: Math.max(-FIELD_WALL, mid - LINE_DASH / 2),
        x2: 0, y2: Math.min(FIELD_WALL, mid + LINE_DASH / 2), half: LINE_HALF, round: false,
      });
    }
  }
  return dashes;
})();

/** What Pong shows on top of the darkened keys: the center line, each player's
 *  bumper or paddle, and the ball while it is lit. */
export function pongShapes(state: PongState): Shape[] {
  const shapes: Shape[] = [...CENTER_LINE];
  for (const half of HALVES) {
    const keys = state.held[half];
    if (keys.length === 1) {
      const [x, y] = keyPoint(keys[0]);
      shapes.push({ kind: 'circle', x, y, r: PADDLE_HALF });
    } else if (keys.length === 2) {
      const [x1, y1] = keyPoint(keys[0]), [x2, y2] = keyPoint(keys[1]);
      shapes.push({ kind: 'line', x1, y1, x2, y2, half: PADDLE_HALF, round: true });
    }
  }
  if (state.ball && ballLit(state)) {
    shapes.push({ kind: 'circle', x: state.ball.x, y: state.ball.y, r: BALL_RADIUS });
  }
  return shapes;
}
