// The Secrets toolbar: the hidden games found so far (games/discovery.ts), and
// where one is started.
//
// Its selector button and its group are on the page from the start but hidden;
// they appear once a game's motif has been played. The group is three rows: how
// many secrets are found ("1/2 secrets found", "All secrets found"), a button
// per discovered one, and Hide. The wording says "secrets", not "games", so a
// secret that is not a game fits later. Hide asks for confirmation, then
// forgets every discovery and removes button and group again, so a hidden
// toolbar only ever coexists with nothing discovered.
//
// A game's button starts it (games/mode.ts), shown as playing while it runs;
// pressed again it stops the game. A game is played on the Lumatone outline, so
// starting one switches the Outline dropdown to it. When a game ends by its
// rules, a modal reports the result.
//
// Everything shown is derived from the prefs (secretGames, toolbars.secrets)
// and the running game, so the Reset button's cleared prefs hide it the same
// way, and a game whose button goes away is stopped.

import { loadPrefs } from '../state/persistence.js';
import { MOTIFS } from '../games/motifs.js';
import { setDiscoveryListener, forgetDiscoveries } from '../games/discovery.js';
import { runningGame, startGame, stopGame, setGameListener, type GameResult } from '../games/mode.js';
import { applyToolbarVisibility } from './toolbars.js';

const HIDE_CONFIRM =
  'Hide the Secrets toolbar? The secrets you have found will be locked again until you play their motifs.';

/** Show what the prefs and the running game say: the button, the group, the
 *  games and the count. */
export function renderSecrets(): void {
  const prefs = loadPrefs();
  /* Only games this build has: an id saved by a build with more games is kept
     in the prefs but shows nothing here. */
  const found = MOTIFS.filter((m) => prefs.secretGames.includes(m.game));
  const playing = runningGame();
  if (playing && !found.some((m) => m.game === playing.id)) {
    stopGame();   /* its button is gone (Hide, Reset); the game listener renders again */
    return;
  }
  applyToolbarVisibility(prefs.toolbars);
  const button = document.getElementById('tbSecrets');
  const group = document.getElementById('tb-group-secrets');
  const list = document.getElementById('secretGames');
  const count = document.getElementById('secretsCount');
  if (button) button.classList.toggle('tb-hidden', found.length === 0);
  if (group && found.length === 0) group.classList.add('tb-hidden');
  if (list) {
    list.replaceChildren(...found.map((m) => {
      const b = document.createElement('button');
      b.className = 'push-btn';
      b.classList.toggle('playing', playing?.id === m.game);
      b.dataset.game = m.game;
      b.textContent = m.label;
      b.addEventListener('click', () => toggleGame(m.game));
      return b;
    }));
  }
  if (count) {
    count.textContent = found.length === 0 ? ''
      : (found.length < MOTIFS.length ? found.length + '/' + MOTIFS.length : 'All') + ' secrets found';
  }
}

function toggleGame(game: string): void {
  if (runningGame()?.id === game) { stopGame(); return; }
  /* A game is played on the Lumatone's keys: show that outline, through the
     dropdown's own handler, as if the user had picked it. */
  const outline = document.getElementById('selOutline') as HTMLSelectElement | null;
  if (outline && outline.value !== 'lumatone') {
    outline.value = 'lumatone';
    outline.dispatchEvent(new Event('change'));
  }
  startGame(game);
}

function showGameOver(result: GameResult): void {
  const dialog = document.getElementById('gameOverDialog') as HTMLDialogElement | null;
  const text = document.getElementById('gameOverText');
  if (!dialog || !text) return;
  const how = result.over === 'wall' ? 'The snake hit the wall.' : 'The snake ran into itself.';
  text.textContent = how + ' Score: ' + result.eaten + '.';
  dialog.showModal();
}

export function initSecrets(): void {
  setDiscoveryListener(renderSecrets);
  setGameListener((result) => {
    renderSecrets();
    if (result) showGameOver(result);
  });
  document.getElementById('btnHideSecrets')?.addEventListener('click', () => {
    if (!window.confirm(HIDE_CONFIRM)) return;
    forgetDiscoveries();
    renderSecrets();
  });
  document.getElementById('gameOverClose')?.addEventListener('click', () => {
    (document.getElementById('gameOverDialog') as HTMLDialogElement | null)?.close();
  });
  renderSecrets();
}
