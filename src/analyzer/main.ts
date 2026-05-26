// HKL Analyzer — entry point.
//
// Boot order matters:
//   1. Load any persisted draft from IndexedDB and hydrate stage state.
//      Done BEFORE views init so the form/source pickers see the loaded
//      state on their first read and populate themselves correctly.
//   2. Init all view modules.
//   3. Subscribe a debounced auto-save on every state change.

import { hydrate, onChange, getState, setStatus } from './stage.js';
import { initSourcePicker } from './sourceLocal.js';
import { initCdnSource } from './sourceCdn.js';
import { initConfigForm } from './configForm.js';
import { initAdvancedPanel } from './advancedPanel.js';
import { initSampleTable } from './sampleTable.js';
import { initAnalyzeControls } from './pipeline.js';
import { initOutputControls, handleImportClick } from './output.js';
import { initBridgeStub } from './bridge.js';
import { initClearButton } from './sourceClear.js';
import { loadDraft, saveDraft } from './persist.js';

function $<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setStatusBarText(text: string, kind?: 'err' | 'ok'): void {
  const el = $('statusText');
  if (!el) return;
  el.textContent = text;
  el.className = kind ? kind : '';
}

function initTopBar(): void {
  const btn = $<HTMLButtonElement>('btnImportConfig');
  const fileInput = $<HTMLInputElement>('fileInputImport');
  if (!btn || !fileInput) return;
  btn.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    void handleImportClick(f).catch(e => {
      setStatusBarText('Import failed: ' + (e as Error).message, 'err');
    });
  });
}

function initTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.tab');
  tabs.forEach(t => {
    t.addEventListener('click', () => {
      const name = t.dataset.tab;
      if (!name) return;
      tabs.forEach(o => o.classList.toggle('active', o === t));
      document.querySelectorAll<HTMLElement>('.tab-panel').forEach(p => {
        p.classList.toggle('active', p.id === `tabPanel${name.charAt(0).toUpperCase()}${name.slice(1)}`);
      });
      const ev = new CustomEvent('analyzer-source-mode', { detail: name });
      document.dispatchEvent(ev);
    });
  });
}

/** Switch the source-mode tab UI to match the source.mode in state. Called
 *  after hydrate so the user sees their previous CDN tab if they were on it. */
function syncSourceTabFromState(): void {
  const mode = getState().source.mode;
  const targetTab = document.getElementById(mode === 'cdn' ? 'tabCdn' : 'tabLocal');
  if (targetTab) (targetTab as HTMLElement).click();
}

/** Debounce wrapper so rapid state changes (typing, sliding) batch into a
 *  single save. 250 ms is fast enough that a reload mid-session won't lose
 *  meaningful work, slow enough not to thrash IDB. */
function debounced<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let h = 0;
  return ((...args: never[]) => {
    if (h) clearTimeout(h);
    h = window.setTimeout(() => { h = 0; fn(...args); }, ms);
  }) as T;
}

async function main(): Promise<void> {
  /* Try to hydrate from IDB before anything renders. saveDraft writes the
     full state minus audioBuffer refs; loaded slots will have file handles
     intact (for local) or url intact (for CDN). */
  const draft = await loadDraft();
  if (draft) hydrate(draft);

  initTopBar();
  initTabs();
  initSourcePicker();
  initCdnSource();
  initConfigForm();
  initAdvancedPanel();
  initSampleTable();
  initAnalyzeControls();
  initOutputControls();
  initBridgeStub();
  initClearButton();

  /* If we hydrated, sync the active tab to match the loaded source mode. */
  if (draft) syncSourceTabFromState();

  /* Mirror state.status to the bottom status bar. */
  onChange(() => {
    setStatusBarText(getState().status);
  });

  /* Debounced auto-save. */
  const persist = debounced(() => { void saveDraft(getState()); }, 250);
  onChange(persist);

  if (!draft) setStatus('Ready. Drop files or enter a CDN URL to begin.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void main(); });
} else {
  void main();
}
