// Source-section "Clear" button. Wipes the persisted draft AND resets the
// in-memory analyzer state to defaults, then re-renders so all form fields
// and the file list / sample table reflect the reset.

import { reset, setStatus } from './stage.js';
import { clearDraft } from './persist.js';

export function initClearButton(): void {
  const btn = document.getElementById('btnClearSource') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!confirm('Clear all loaded files, config, and analysis results? Saved draft will also be wiped.')) return;
    void clearDraft();
    reset();
    setStatus('Ready. Drop files or enter a CDN URL to begin.');
  });
}
