// The Secrets toolbar: the hidden games found so far (games/discovery.ts).
//
// Its selector button and its group are on the page from the start but hidden;
// they appear once a game's motif has been played. The group is three rows: how
// many secrets are found ("1/2 secrets found", "All secrets found"), a button
// per discovered one, and Hide. The wording says "secrets", not "games", so a
// secret that is not a game fits later. Hide asks for confirmation, then
// forgets every discovery and removes button and group again, so a hidden
// toolbar only ever coexists with nothing discovered.
//
// Everything shown is derived from the prefs (secretGames, toolbars.secrets),
// so the Reset button's cleared prefs hide it the same way.

import { loadPrefs } from '../state/persistence.js';
import { MOTIFS } from '../games/motifs.js';
import { setDiscoveryListener, forgetDiscoveries } from '../games/discovery.js';
import { applyToolbarVisibility } from './toolbars.js';

const HIDE_CONFIRM =
  'Hide the Secrets toolbar? The secrets you have found will be locked again until you play their motifs.';

/** Show what the prefs say: the button, the group, the games and the count. */
export function renderSecrets(): void {
  const prefs = loadPrefs();
  applyToolbarVisibility(prefs.toolbars);
  /* Only games this build has: an id saved by a build with more games is kept
     in the prefs but shows nothing here. */
  const found = MOTIFS.filter((m) => prefs.secretGames.includes(m.game));
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
      b.dataset.game = m.game;
      b.textContent = m.label;
      return b;
    }));
  }
  if (count) {
    count.textContent = found.length === 0 ? ''
      : (found.length < MOTIFS.length ? found.length + '/' + MOTIFS.length : 'All') + ' secrets found';
  }
}

export function initSecrets(): void {
  setDiscoveryListener(renderSecrets);
  document.getElementById('btnHideSecrets')?.addEventListener('click', () => {
    if (!window.confirm(HIDE_CONFIRM)) return;
    forgetDiscoveries();
    renderSecrets();
  });
  renderSecrets();
}
