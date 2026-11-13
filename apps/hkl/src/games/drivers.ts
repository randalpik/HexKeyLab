// The driver of each hidden game, by the id its motif unlocks (games/motifs.ts).
// Apart from the host (games/mode.ts), which knows no game, and from the motif
// table, which is pure data the Node oracle reads.

import type { GameDriver } from './mode.js';
import { snakeGame } from './snake-game.js';

export const DRIVERS: Readonly<Record<string, GameDriver>> = {
  snake: snakeGame,
};
