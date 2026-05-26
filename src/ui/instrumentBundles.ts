// UI wiring for imported .hki sample bundles.
//
// Surface:
//   - `+ .hki` button → file picker → reads file → registers in IndexedDB.
//   - `Bundles…` button → opens a <dialog> listing imported bundles with
//     remove buttons.
//   - An <optgroup id="hkiOptgroup"> is dynamically appended to the
//     #waveform <select>, populated from the registry every time it changes.
//
// The waveform <select>'s change handler in src/ui/controls.ts already
// dispatches to engine.changeWaveform() → SampleEngine.loadInstrument(key),
// and the engine now branches on instr.source==='hki' to read bytes from
// the registry instead of fetching. No change to the dropdown semantics
// is needed beyond appending entries.

import * as InstrumentRegistry from '../state/instrumentRegistry.js';
import type { ManifestRecord } from '../state/instrumentRegistry.js';

const HKI_OPTGROUP_ID = 'hkiOptgroup';

function $<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/** Rebuild the imported-bundles <optgroup> from the registry. Idempotent. */
function refreshDropdown(): void {
  const sel = $<HTMLSelectElement>('waveform');
  if (!sel) return;
  let group = sel.querySelector('#' + HKI_OPTGROUP_ID) as HTMLOptGroupElement | null;
  const imports = InstrumentRegistry.listImported();
  if (imports.length === 0) {
    if (group) group.remove();
    return;
  }
  if (!group) {
    group = document.createElement('optgroup');
    group.id = HKI_OPTGROUP_ID;
    group.label = 'Imported (.hki)';
    sel.appendChild(group);
  }
  /* Preserve the user's current selection across refreshes. */
  const prev = sel.value;
  group.innerHTML = '';
  for (const rec of imports) {
    const opt = document.createElement('option');
    opt.value = rec.instrumentKey;
    opt.textContent = rec.manifest.name;
    group.appendChild(opt);
  }
  /* If the selected instrument was just removed, the <select> falls back to
     the first option; leave that to the caller (engine.changeWaveform fires
     via the existing change handler if we synthesize a change). */
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function renderManageList(): void {
  const list = $<HTMLDivElement>('hkiManageList');
  if (!list) return;
  const imports = InstrumentRegistry.listImported();
  if (imports.length === 0) {
    list.innerHTML = '<div style="color:#888;padding:10px 4px">No imported bundles yet. Click <code>+ .hki</code> to import one.</div>';
    return;
  }
  list.innerHTML = '';
  for (const rec of imports) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 4px;border-bottom:1px solid #2a2a2a';
    const label = document.createElement('div');
    label.style.cssText = 'flex:1;min-width:0';
    label.innerHTML =
      '<div style="color:#ddd">' + escapeHtml(rec.manifest.name) + '</div>' +
      '<div style="color:#888;font-size:11px">' +
        escapeHtml(rec.instrumentKey) + ' · ' +
        rec.manifest.samples.length + ' samples · ' +
        fmtBytes(rec.audioBytes) +
      '</div>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Remove';
    btn.onclick = async () => {
      if (!window.confirm(`Remove imported instrument "${rec.manifest.name}"?`)) return;
      await onRemove(rec);
      renderManageList();
    };
    row.appendChild(label);
    row.appendChild(btn);
    list.appendChild(row);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c] as string));
}

async function onRemove(rec: ManifestRecord): Promise<void> {
  /* If the user is currently playing the bundle we're removing, fall back
     to the first static instrument so we don't leave the engine pointing at
     a vanished instrument. */
  const sel = $<HTMLSelectElement>('waveform');
  const wasActive = !!sel && sel.value === rec.instrumentKey;
  await InstrumentRegistry.removeBundle(rec.instrumentKey);
  if (wasActive && sel) {
    /* Pick the first static option (skipping any optgroup ancestor). */
    const firstStatic = [...sel.options].find(o => o.parentElement?.id !== HKI_OPTGROUP_ID);
    if (firstStatic) {
      sel.value = firstStatic.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  /* refreshDropdown() is fired via the onChange subscription. */
}

async function onImportClick(): Promise<void> {
  const inp = $<HTMLInputElement>('fileInputHki');
  if (!inp) return;
  inp.value = '';
  inp.click();
}

async function onFileChosen(e: Event): Promise<void> {
  const inp = e.target as HTMLInputElement;
  const file = inp.files && inp.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const manifest = await InstrumentRegistry.importBundle(new Uint8Array(buf));
    /* Auto-select the newly imported instrument so the user can audition
       immediately. Falls through to the existing waveform change handler. */
    const sel = $<HTMLSelectElement>('waveform');
    if (sel) {
      sel.value = manifest.instrumentKey;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (err) {
    console.error('hki import failed', err);
    window.alert('Failed to import .hki bundle: ' + (err as Error).message);
  } finally {
    inp.value = '';
  }
}

function onManageClick(): void {
  renderManageList();
  $<HTMLDialogElement>('hkiManageDialog')?.showModal();
}

function onManageClose(): void {
  $<HTMLDialogElement>('hkiManageDialog')?.close();
}

/**
 * Wire up the HKI import/manage UI. Call from init.ts AFTER
 * InstrumentRegistry.init() has resolved so the initial dropdown
 * population reflects what's already in IndexedDB.
 */
export function initInstrumentBundlesUi(): void {
  refreshDropdown();
  InstrumentRegistry.onChange(refreshDropdown);

  $<HTMLButtonElement>('btnHkiImport')?.addEventListener('click', () => { void onImportClick(); });
  $<HTMLButtonElement>('btnHkiManage')?.addEventListener('click', onManageClick);
  $<HTMLButtonElement>('hkiManageClose')?.addEventListener('click', onManageClose);
  $<HTMLInputElement>('fileInputHki')?.addEventListener('change', (e) => { void onFileChosen(e); });
}
