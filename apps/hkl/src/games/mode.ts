// The host of a running hidden game: what every game needs and none should
// write twice. It starts and stops the game, runs its clocks, plays its line of
// notes, hands it the Lumatone's presses and releases, shows its scene on the
// device and the canvas, and tells the toolbar when it starts, stops or ends.
// A game itself is a driver (games/snake-game.ts) over its rules
// (games/snake.ts): the host knows nothing about any one game.
//
// A game lives on the Lumatone's physical keys (games/board.ts). The lattice
// under them only supplies colors and notes, so a ref, mode, mapping or
// alignment change mid-game needs no handling here.
//
// What holds for every game (docs/architecture/hkl.md → Hidden games):
//   - It is played on the Lumatone outline. Leaving that outline ends it at
//     once, without a result.
//   - Its clocks do nothing while the page is hidden, where browsers slow
//     timers down and stop animation frames.
//   - A press on a Lumatone key is the game's to decide: swallowed (not a
//     note), or played as a note at a velocity the game names (midi/handler.ts).
//     A click on one of the outline's keys in the canvas goes to the game and
//     selects nothing (ui/init.ts).
//   - Its own notes are a held source of their own (input/held.ts 'game'), so
//     they behave like a player's: selected, recorded, sent to the output.
//   - When it ends by its own rules, the board stays dark (every key darkened,
//     nothing drawn) until its result is dismissed; only then does the layout
//     come back. The game itself is off the keys from the moment it ends. A
//     game stopped without a result gives the layout back at once.

import { DEFAULT_DYNAMIC_MAP } from '@hkl/shared/dynamics.js';
import { lumatoneCell } from '../layout/physical.js';
import { pressHeld, releaseHeld, restrikeHeld, heldKey } from '../input/held.js';
import { syncLumatoneColors } from '../lumatone/sync.js';
import { requestDraw, getOutlineMode } from '../render/draw.js';
import { KEY_COUNT } from './board.js';
import { setGameScene } from './display.js';
import type { Scene } from './scene.js';
import type { KeyId } from '../types.js';

/** Velocity of a game's quiet notes (the line it traces, a key a player
 *  holds), and of an accented one. Picked by ear. */
export const QUIET_VELOCITY = DEFAULT_DYNAMIC_MAP.pp;
export const ACCENT_VELOCITY = DEFAULT_DYNAMIC_MAP.f;

/** The longest time one animation frame hands a game. A frame that comes later
 *  than this (a stalled tab) counts as this much, so the game does not jump. */
export const MAX_FRAME_MS = 100;

/** What a game does with a press: swallow it, so it is not a note, or let it
 *  play as a note at this velocity. */
export type PressOutcome = 'swallow' | number;

/** A running game, as the host drives it. A driver adds its own state to this
 *  for the toolbar and the gates to read. */
export interface Game {
  /** The id its motif unlocks (games/motifs.ts). */
  readonly id: string;
  /** What it shows now. */
  scene(): Scene;
  /** A press of Lumatone key `key` (0–279). */
  press(key: number): PressOutcome;
  /** The release of Lumatone key `key`, whatever its press came to. */
  release(key: number): void;
  /** A canvas click on Lumatone key `key`. It never plays a note. */
  click(key: number): void;
}

/** What the host gives a game's driver. Once the game is off the keys, none of
 *  it does anything. */
export interface Host {
  /** Show the game's scene as it is now, on the device and the canvas. */
  show(): void;
  /** Call `tick` every `ms` from now on. A clock is known by its tick: asking
   *  again for the same one restarts it. */
  every(ms: number, tick: () => void): void;
  /** Stop the clock of `tick`, if it runs. */
  stop(tick: () => void): void;
  /** Call `tick` on every animation frame with the time since the last one, at
   *  most MAX_FRAME_MS; null stops that. */
  eachFrame(tick: ((ms: number) => void) | null): void;
  /** The game's own line of notes: strike Lumatone key `key`'s note, then let
   *  go of the one before, so the line is legato. */
  sound(key: number, velocity: number): void;
  /** End the line. */
  hush(): void;
  /** Strike again, at `velocity`, each of the Lumatone keys `keys` that a
   *  player is holding as a note. The notes stay the players': they sound until
   *  the keys are let go. */
  accent(keys: ReadonlyArray<number>, velocity: number): void;
  /** The game is over by its own rules: take it off the keys and report `text`.
   *  The board stays dark until that result is dismissed. */
  end(text: string): void;
}

/** Starts a game: called with its host, returns the game. */
export type GameDriver = (host: Host) => Game;

/** How a game ended, in its own words. */
export interface GameResult {
  game: string;
  text: string;
}

type Timer = ReturnType<typeof setInterval>;

interface Run {
  game: Game;
  clocks: Map<() => void, Timer>;
  frameTick: ((ms: number) => void) | null;
  frame: number | null;
  /* Time of the last frame the game was handed, 0 before the first. */
  lastFrame: number;
  /* Held-input id of the note the game's line is sounding, if any. */
  note: string | null;
  notes: number;
}

let run: Run | null = null;

/* A game ended by its rules and its result has not been dismissed yet: the
   board shows this, every key darkened and nothing on it. */
const DARK_BOARD: Scene = { dark: () => true, shapes: [] };
let resultUp = false;

/* Told when a game starts or stops (null) and when one ends by its rules (the
   result). Registered by ui/secrets.ts, which owns the toolbar and the modal. */
let listener: ((result: GameResult | null) => void) | null = null;
export function setGameListener(fn: (result: GameResult | null) => void): void { listener = fn; }

export function runningGame(): Game | null {
  return run ? run.game : null;
}

/** Start the game `driver` makes, replacing any game in progress. */
export function startGame(driver: GameDriver): void {
  if (run) stopGame();
  /* A result still up no longer holds the board: the new game's scene does. */
  resultUp = false;
  const r: Run = {
    game: null as unknown as Game,
    clocks: new Map(), frameTick: null, frame: null, lastFrame: 0, note: null, notes: 0,
  };
  run = r;
  r.game = driver(hostOf(r));
  setGameScene(() => r.game.scene());
  show();
  if (listener) listener(null);
}

/** Stop the game in progress without a result. */
export function stopGame(): void {
  if (!run) return;
  clear();
  if (listener) listener(null);
}

/** The result of the game that ended has been dismissed: the layout comes back.
 *  Called by whoever shows the result (ui/secrets.ts, when its modal closes). */
export function dismissResult(): void {
  if (!resultUp) return;
  resultUp = false;
  setGameScene(null);
  show();
}

/* Take the game off the keys: clocks, note, and its scene, for the layout or
   for the scene `after` it. */
function clear(after: (() => Scene) | null = null): void {
  const r = run;
  if (!r) return;
  r.clocks.forEach((timer) => clearInterval(timer));
  r.clocks.clear();
  if (r.frame !== null) cancelAnimationFrame(r.frame);
  r.frame = null;
  r.frameTick = null;
  run = null;
  setGameScene(after);
  hush(r);
  show();
}

function show(): void {
  requestDraw();
  syncLumatoneColors();
}

function hush(r: Run): void {
  if (r.note) releaseHeld('game', r.note);
  r.note = null;
}

/* Whether a clock's tick should do anything: not while the page is hidden, and
   not once the Lumatone outline is gone, which ends the game. */
function live(): boolean {
  if (document.hidden) return false;
  if (getOutlineMode() !== 'lumatone') { stopGame(); return false; }
  return true;
}

/* The one animation-frame loop, for the running game's frame tick. Asked for
   again before the tick is called, so a tick that ends the game cancels it. */
function gameFrame(now: number): void {
  const r = run;
  if (!r) return;
  r.frame = null;
  if (!r.frameTick) return;
  if (!live()) {
    /* Hidden: keep the loop for when the page is back, and start its time
       again there. Outline gone: live() ended the game. */
    r.lastFrame = 0;
    if (run === r) r.frame = requestAnimationFrame(gameFrame);
    return;
  }
  const ms = r.lastFrame ? Math.min(MAX_FRAME_MS, now - r.lastFrame) : 0;
  r.lastFrame = now;
  r.frame = requestAnimationFrame(gameFrame);
  r.frameTick(ms);
}

function hostOf(r: Run): Host {
  const stop = (tick: () => void): void => {
    const timer = r.clocks.get(tick);
    if (timer === undefined) return;
    clearInterval(timer);
    r.clocks.delete(tick);
  };
  return {
    show() { if (run === r) show(); },
    every(ms, tick) {
      if (run !== r) return;
      stop(tick);
      const beat = (): void => { if (run === r && live()) tick(); };
      /* Named after the tick it wraps: the gates drive a game's clocks by hand
         and tell them apart by that name (test/games/). */
      Object.defineProperty(beat, 'name', { value: tick.name });
      r.clocks.set(tick, setInterval(beat, ms));
    },
    stop,
    eachFrame(tick) {
      if (run !== r) return;
      r.frameTick = tick;
      if (tick && r.frame === null) {
        r.lastFrame = 0;
        r.frame = requestAnimationFrame(gameFrame);
      } else if (!tick && r.frame !== null) {
        cancelAnimationFrame(r.frame);
        r.frame = null;
      }
    },
    sound(key, velocity) {
      if (run !== r) return;
      const [q, c] = lumatoneCell(key);
      const cell = q + ',' + c;
      /* The same key again is struck again in place: letting go of the note
         before would let go of this one. */
      if (r.note && heldKey('game', r.note) === cell) {
        pressHeld('game', r.note, cell, velocity);
        return;
      }
      const id = 'line' + (++r.notes);
      pressHeld('game', id, cell, velocity);
      if (r.note) releaseHeld('game', r.note);
      r.note = id;
    },
    hush() { hush(r); },
    accent(keys, velocity) {
      if (run !== r) return;
      /* A Lumatone key's held input is "channel,note" (midi/handler.ts). */
      for (const key of keys) {
        restrikeHeld('lumatone', (Math.floor(key / 56) + 1) + ',' + (key % 56), velocity);
      }
    },
    end(text) {
      if (run !== r) return;
      const game = r.game.id;
      resultUp = true;
      clear(() => DARK_BOARD);
      /* With nobody to show the result, nobody would dismiss it. */
      if (listener) listener({ game, text });
      else dismissResult();
    },
  };
}

/** Offer a press of Lumatone key `key` (0–279) to the running game. Null when
 *  no game is running, and the press is then an ordinary one. */
export function gamePress(key: number): PressOutcome | null {
  if (!run || key < 0 || key >= KEY_COUNT) return null;
  return run.game.press(key);
}

/** Tell the running game that Lumatone key `key` was released. */
export function gameRelease(key: number): void {
  if (run && key >= 0 && key < KEY_COUNT) run.game.release(key);
}

/** Offer a canvas click on lattice cell `cell` to the running game: taken when
 *  a Lumatone key plays that cell, as a click on that key. */
export function gameClick(cell: KeyId): boolean {
  if (!run) return false;
  for (let key = 0; key < KEY_COUNT; key++) {
    const [q, c] = lumatoneCell(key);
    if (q + ',' + c === cell) { run.game.click(key); return true; }
  }
  return false;
}
