// Discovering the hidden games: every key press is offered to the motif
// listener (games/motifs.ts), and a completed motif adds its game to the
// discovered list in the prefs and opens the Secrets toolbar (ui/secrets.ts).
//
// Listening never changes a press: the note sounds, selects and records exactly
// as it would otherwise. A motif never starts a game — it only reveals the
// toolbar a game is started from — so playing the melody for its own sake
// costs nothing.
//
// Heard only while the Lumatone outline is shown, from every input that strikes
// a key: the shared strike body (input/held.ts pressHeld: Lumatone, computer
// keyboard, piano input) and a canvas click that selects a key (ui/init.ts).

import { noteName, keyOctave } from '@hkl/shared/notes.js';
import { tuning } from '../state/tuning.js';
import { loadPrefs, savePrefs } from '../state/persistence.js';
import { getOutlineMode } from '../render/draw.js';
import { createMotifListener } from './motifs.js';
import type { KeyId } from '../types.js';

const listener = createMotifListener();

/* Called after a discovery is saved. Registered by ui/secrets.ts rather than
   imported, so the input path does not depend on the toolbar's DOM code. */
let onDiscovered: (() => void) | null = null;
export function setDiscoveryListener(fn: () => void): void { onDiscovered = fn; }

/** Offer the press of lattice cell `key` to the motif listener. */
export function hearKeyPress(key: KeyId): void {
  if (getOutlineMode() !== 'lumatone') { listener.reset(); return; }
  const ci = key.indexOf(',');
  const q = +key.slice(0, ci), r = +key.slice(ci + 1);
  const game = listener.press(
    noteName(q, r, tuning.mapping, tuning.anchor, tuning.banded),
    keyOctave(q, r, tuning.mapping, tuning.anchor, tuning.banded),
  );
  if (game !== null) discover(game);
}

/* A motif already found opens the toolbar again, which is how it comes back
   after the toolbar button switched it off. */
function discover(game: string): void {
  const prefs = loadPrefs();
  const games = prefs.secretGames.includes(game) ? prefs.secretGames : [...prefs.secretGames, game];
  savePrefs({ secretGames: games, toolbars: { ...prefs.toolbars, secrets: true } });
  if (onDiscovered) onDiscovered();
}

/** Forget every discovered game and close the Secrets toolbar (its Hide). */
export function forgetDiscoveries(): void {
  listener.reset();
  savePrefs({ secretGames: [], toolbars: { ...loadPrefs().toolbars, secrets: false } });
}
