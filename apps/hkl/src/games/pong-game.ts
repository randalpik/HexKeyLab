// Pong, running: the driver that plays the rules of games/pong.ts under the
// host (games/mode.ts). Its clock, its notes, what it shows and what a press
// does (docs/local/easter-egg-games.md):
//   - Starting shows the field — the layout darkened, the dotted center line —
//     with no ball, and waits. The first press on a Lumatone key starts the
//     first serve's warning, and is an ordinary press besides.
//   - A press the rules honor (a bumper, or the key that completes a paddle) is
//     a note at the quiet velocity, whatever the touch, held until the key is
//     let go. Every other press is swallowed in silence. Canvas clicks do
//     nothing: the game needs two players holding keys.
//   - The clock is the animation frame, from the first press.
//   - In play the ball traces a quiet legato line: the note of the key under
//     its center, changing as it crosses to the next. Over no key (in a
//     notch of the keys' staircase, before a long side) the last note holds.
//   - A hit is a chord: the ball's key and the keys of the bumper or paddle it
//     hit, struck together at the accent velocity. The players' keys are struck
//     again under their own held notes, so they sound on until let go.
//   - A goal ends the line; the pause after it is silent, and so is every
//     serve's warning.
//   - The match ends straight into the modal, with the winner and the score.

import { keyAtPoint } from './board.js';
import { QUIET_VELOCITY, ACCENT_VELOCITY, type Game, type Host } from './mode.js';
import { newPong, begin, press, release, advance, ballLit, pongShapes, type PongState } from './pong.js';

/** Pong in progress, as the gates read it. */
export interface PongGame extends Game {
  readonly state: PongState;
}

export function pongGame(host: Host): PongGame {
  const state = newPong();
  /* The key whose note the ball's line is sounding, −1 for none. */
  let lineKey = -1;

  const game: PongGame = {
    id: 'pong', state,
    /* Every key darkened; the center line, the bumpers and paddles and the
       ball on top. */
    scene: () => ({ dark: () => true, shapes: pongShapes(state) }),
    press(key) {
      if (state.phase === 'over') return 'swallow';
      const honored = press(state, key);
      if (state.phase === 'waiting') {
        begin(state);
        host.eachFrame(frame);
      }
      host.show();
      return honored ? QUIET_VELOCITY : 'swallow';
    },
    release(key) {
      if (!state.held.left.includes(key) && !state.held.right.includes(key)) return;
      release(state, key);
      host.show();
    },
    click() { /* swallowed */ },
  };

  function frame(ms: number): void {
    const phase = state.phase, lit = ballLit(state);
    for (const event of advance(state, ms, Math.random)) {
      if (event.kind === 'hit') {
        const under = state.ball ? keyAtPoint(state.ball.x, state.ball.y) : -1;
        if (under >= 0) {
          host.sound(under, ACCENT_VELOCITY);
          lineKey = under;
        }
        host.accent(event.keys, ACCENT_VELOCITY);
      } else if (event.kind === 'goal') {
        host.hush();
        lineKey = -1;
      } else if (event.kind === 'over') {
        const won = state.score[event.winner], lost = state.score[event.winner === 'left' ? 'right' : 'left'];
        host.end('The ' + event.winner + ' player wins, ' + won + ' to ' + lost + '.');
        return;
      }
    }
    if (state.phase === 'play' && state.ball) {
      const under = keyAtPoint(state.ball.x, state.ball.y);
      if (under >= 0 && under !== lineKey) {
        host.sound(under, QUIET_VELOCITY);
        lineKey = under;
      }
    }
    /* In play every frame moves the ball. Otherwise the picture changes only
       when the ball goes on or off, or the phase turns. */
    if (state.phase === 'play' || state.phase !== phase || ballLit(state) !== lit) host.show();
  }

  return game;
}
