// Toolbar selector + visibility wiring.
//
// Each toolbar is a named group of controls (Layout, Playback, Analysis,
// Recording, Lumatone). The selector row at the top of the page is a strip
// of toggle buttons that show/hide their corresponding group. Visibility
// persists across reloads via prefs.toolbars.
//
// CSS handles inter-group dividers via the adjacent-sibling selector against
// `.tb-hidden`, so this module only flips that one class — no JS bookkeeping
// of which divider goes where.

import { loadPrefs, savePrefs } from '../state/persistence.js';
import type { ToolbarVisibility } from '../state/persistence.js';

export type ToolbarName = keyof ToolbarVisibility;
export const TOOLBAR_NAMES: ToolbarName[] = ['layout', 'playback', 'analysis', 'recording', 'lumatone', 'piano'];

const BUTTON_IDS: Record<ToolbarName, string> = {
  layout: 'tbLayout',
  playback: 'tbPlayback',
  analysis: 'tbAnalysis',
  recording: 'tbRecording',
  lumatone: 'tbLumatone',
  piano: 'tbPiano',
};

const GROUP_IDS: Record<ToolbarName, string> = {
  layout: 'tb-group-layout',
  playback: 'tb-group-playback',
  analysis: 'tb-group-analysis',
  recording: 'tb-group-recording',
  lumatone: 'tb-group-lumatone',
  piano: 'tb-group-piano',
};

export function applyToolbarVisibility(vis: ToolbarVisibility): void {
  for (const name of TOOLBAR_NAMES) {
    const group = document.getElementById(GROUP_IDS[name]);
    const btn = document.getElementById(BUTTON_IDS[name]);
    const visible = vis[name];
    if (group) group.classList.toggle('tb-hidden', !visible);
    if (btn) btn.classList.toggle('active', visible);
  }
}

export function initToolbarSelector(): void {
  for (const name of TOOLBAR_NAMES) {
    const btn = document.getElementById(BUTTON_IDS[name]);
    if (!btn) continue;
    btn.addEventListener('click', () => {
      const cur = loadPrefs().toolbars;
      const next: ToolbarVisibility = { ...cur, [name]: !cur[name] };
      applyToolbarVisibility(next);
      savePrefs({ toolbars: next });
    });
  }
}
