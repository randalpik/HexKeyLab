// UI wiring for imported instruments. Two registries surface here:
//
//   .hki bundles      — manifest + audio bytes in IDB (state/instrumentRegistry.ts).
//                       Source-of-bytes for offline / locally-recorded samples.
//   CDN configs       — JSON config in IDB (state/cdnConfigRegistry.ts). Engine
//                       fetches audio per-sample at playback time from
//                       config.baseUrl + filePattern, same path as the static
//                       compile-time INSTRUMENTS entries in samples-data.ts.
//
// Surface:
//   - `+ .hki` button       → file picker → InstrumentRegistry.importBundle.
//   - `+ JSON` button       → file picker → cdnConfigRegistry.importConfig.
//   - `Bundles…` button     → opens a <dialog> with two sections (one per
//                              registry), each with Remove buttons.
//   - Two <optgroup>s appended to #waveform:
//       #hkiOptgroup        — "Imported (.hki)"
//       #cdnConfigOptgroup  — "Imported (CDN config)"
//
// The waveform <select>'s change handler in src/ui/controls.ts dispatches to
// engine.changeWaveform() → SampleEngine.loadInstrument(key); the INSTRUMENTS
// proxy in samples-data.ts resolves the key through (static → hki → cdn).

import * as InstrumentRegistry from '../state/instrumentRegistry.js';
import * as CdnConfigRegistry from '../state/cdnConfigRegistry.js';
import type { ManifestRecord } from '../state/instrumentRegistry.js';
import type { ConfigRecord } from '../state/cdnConfigRegistry.js';
import { parseCdnConfig } from '@hkl/shared/cdnConfig.js';
import { SampleEngine } from '../audio/samples.js';

const HKI_OPTGROUP_ID = 'hkiOptgroup';
const CDN_OPTGROUP_ID = 'cdnConfigOptgroup';

function $<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/** Rebuild a single <optgroup>. Removes it when empty. Preserves the user's
 *  current <select> value if it survives the refresh. */
function rebuildOptgroup(
  groupId: string,
  label: string,
  entries: Array<{ key: string; name: string }>,
): void {
  const sel = $<HTMLSelectElement>('waveform');
  if (!sel) return;
  let group = sel.querySelector('#' + groupId) as HTMLOptGroupElement | null;
  if (entries.length === 0) {
    if (group) group.remove();
    return;
  }
  if (!group) {
    group = document.createElement('optgroup');
    group.id = groupId;
    group.label = label;
    sel.appendChild(group);
  }
  const prev = sel.value;
  group.innerHTML = '';
  for (const e of entries) {
    const opt = document.createElement('option');
    opt.value = e.key;
    opt.textContent = e.name;
    group.appendChild(opt);
  }
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function refreshDropdown(): void {
  rebuildOptgroup(
    HKI_OPTGROUP_ID,
    'Imported (.hki)',
    InstrumentRegistry.listImported().map(r => ({ key: r.instrumentKey, name: r.manifest.name })),
  );
  rebuildOptgroup(
    CDN_OPTGROUP_ID,
    'Imported (CDN config)',
    CdnConfigRegistry.listImported().map(r => ({ key: r.instrumentKey, name: r.config.name })),
  );
  /* A .hki import overrides a static entry with the same key (INSTRUMENTS
     proxy resolution: HKI → static → CDN config), so hide the shadowed
     static <option> — otherwise the dropdown shows two rows with the same
     value and the static label wins the display while the import wins
     playback. Un-hides when the import is removed. */
  const sel = $<HTMLSelectElement>('waveform');
  if (sel) {
    const hkiKeys = new Set(InstrumentRegistry.listImported().map(r => r.instrumentKey));
    for (const opt of [...sel.options]) {
      const group = opt.parentElement?.id;
      if (group === HKI_OPTGROUP_ID || group === CDN_OPTGROUP_ID) continue;
      const shadowed = hkiKeys.has(opt.value);
      opt.hidden = shadowed;
      opt.disabled = shadowed;
    }
  }
}

/* Drop an instrument's decoded buffers so the next selection re-resolves
   INSTRUMENTS[key] and reloads. Without this the engine's `isInstrumentLoaded`
   guard keeps serving whatever profile loaded first for the key — importing
   bassoon.hki over an already-loaded CDN-config bassoon would silently keep
   playing (and fetching) the old CDN profile for the rest of the session.
   Live voices keep their own AudioBuffer references, so evicting mid-note is
   safe; only new note-ons wait for the reload. */
function evictFromEngine(key: string): void {
  SampleEngine.unloadInstrument(key);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c] as string));
}

function emptyMsg(text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.style.cssText = 'color:#888;padding:10px 4px';
  d.innerHTML = text;
  return d;
}

function renderHkiManageList(): void {
  const list = $<HTMLDivElement>('hkiManageList');
  if (!list) return;
  const imports = InstrumentRegistry.listImported();
  list.innerHTML = '';
  if (imports.length === 0) {
    list.appendChild(emptyMsg('No imported bundles yet. Click <code>+ .hki</code> to import one.'));
    return;
  }
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
      await onRemoveHki(rec); /* fires onChange → renderHkiManageList */
    };
    row.appendChild(label);
    row.appendChild(btn);
    list.appendChild(row);
  }
}

function renderCdnConfigManageList(): void {
  const list = $<HTMLDivElement>('cdnConfigManageList');
  if (!list) return;
  const imports = CdnConfigRegistry.listImported();
  list.innerHTML = '';
  if (imports.length === 0) {
    list.appendChild(emptyMsg('No imported CDN configs yet. Click <code>+ JSON</code> to import one.'));
    return;
  }
  for (const rec of imports) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 4px;border-bottom:1px solid #2a2a2a';
    const label = document.createElement('div');
    label.style.cssText = 'flex:1;min-width:0';
    label.innerHTML =
      '<div style="color:#ddd">' + escapeHtml(rec.config.name) + '</div>' +
      '<div style="color:#888;font-size:11px">' +
        escapeHtml(rec.instrumentKey) + ' · ' +
        rec.config.samples.length + ' samples · ' +
        escapeHtml(new URL(rec.config.baseUrl, 'http://x/').hostname || rec.config.baseUrl) +
      '</div>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Remove';
    btn.onclick = async () => {
      if (!window.confirm(`Remove imported instrument "${rec.config.name}"?`)) return;
      await onRemoveCdnConfig(rec); /* fires onChange → renderCdnConfigManageList */
    };
    row.appendChild(label);
    row.appendChild(btn);
    list.appendChild(row);
  }
}

function renderManageLists(): void {
  renderHkiManageList();
  renderCdnConfigManageList();
}

/** Pick the first non-imported (= static) option in the dropdown. Used when
 *  the currently-active instrument is removed. */
function fallbackToFirstStatic(sel: HTMLSelectElement): void {
  const firstStatic = [...sel.options].find(o =>
    o.parentElement?.id !== HKI_OPTGROUP_ID
    && o.parentElement?.id !== CDN_OPTGROUP_ID
    && !o.hidden,
  );
  if (firstStatic) {
    sel.value = firstStatic.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/** After removing an import that was active: if the key still resolves (a
 *  static entry the import was shadowing, or the other registry), stay on it
 *  and reload the fallback profile; otherwise jump to the first static. */
function reselectAfterRemove(sel: HTMLSelectElement, key: string): void {
  if (key in SampleEngine.INSTRUMENTS) {
    sel.value = key;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    fallbackToFirstStatic(sel);
  }
}

async function onRemoveHki(rec: ManifestRecord): Promise<void> {
  const sel = $<HTMLSelectElement>('waveform');
  const wasActive = !!sel && sel.value === rec.instrumentKey;
  await InstrumentRegistry.removeBundle(rec.instrumentKey);
  evictFromEngine(rec.instrumentKey);
  if (wasActive && sel) reselectAfterRemove(sel, rec.instrumentKey);
}

async function onRemoveCdnConfig(rec: ConfigRecord): Promise<void> {
  const sel = $<HTMLSelectElement>('waveform');
  const wasActive = !!sel && sel.value === rec.instrumentKey;
  await CdnConfigRegistry.removeConfig(rec.instrumentKey);
  evictFromEngine(rec.instrumentKey);
  if (wasActive && sel) reselectAfterRemove(sel, rec.instrumentKey);
}

async function onHkiFileChosen(e: Event): Promise<void> {
  const inp = e.target as HTMLInputElement;
  const file = inp.files && inp.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const manifest = await InstrumentRegistry.importBundle(new Uint8Array(buf));
    evictFromEngine(manifest.instrumentKey);
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

async function onCdnConfigFileChosen(e: Event): Promise<void> {
  const inp = e.target as HTMLInputElement;
  const file = inp.files && inp.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const cfg = parseCdnConfig(text);
    await CdnConfigRegistry.importConfig(cfg);
    evictFromEngine(cfg.instrumentKey);
    const sel = $<HTMLSelectElement>('waveform');
    if (sel) {
      sel.value = cfg.instrumentKey;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (err) {
    console.error('cdn config import failed', err);
    window.alert('Failed to import CDN config: ' + (err as Error).message);
  } finally {
    inp.value = '';
  }
}

function onManageClick(): void {
  renderManageLists();
  $<HTMLDialogElement>('hkiManageDialog')?.showModal();
}

function onManageClose(): void {
  $<HTMLDialogElement>('hkiManageDialog')?.close();
}

/**
 * Wire up the import/manage UI. Call from init.ts AFTER both registries'
 * init() promises have resolved so the initial dropdown population reflects
 * what's already in IndexedDB.
 */
export function initInstrumentBundlesUi(): void {
  refreshDropdown();
  /* Both the dropdown <optgroup>s AND the open manage-dialog lists must react to
     registry changes. Previously only the dropdown was subscribed, so importing
     a bundle (the `+ .hki` button lives inside the open dialog) updated the
     dropdown but left the dialog list stale until it was closed and reopened —
     and stale rows made removal look broken too. Subscribing the lists makes
     every add/remove reflect immediately regardless of which surface triggered it. */
  InstrumentRegistry.onChange(refreshDropdown);
  InstrumentRegistry.onChange(renderHkiManageList);
  CdnConfigRegistry.onChange(refreshDropdown);
  CdnConfigRegistry.onChange(renderCdnConfigManageList);

  $<HTMLButtonElement>('btnHkiImport')?.addEventListener('click', () => {
    const inp = $<HTMLInputElement>('fileInputHki');
    if (!inp) return;
    inp.value = '';
    inp.click();
  });
  $<HTMLButtonElement>('btnCdnConfigImport')?.addEventListener('click', () => {
    const inp = $<HTMLInputElement>('fileInputCdnConfig');
    if (!inp) return;
    inp.value = '';
    inp.click();
  });
  $<HTMLButtonElement>('btnHkiManage')?.addEventListener('click', onManageClick);
  $<HTMLButtonElement>('hkiManageClose')?.addEventListener('click', onManageClose);
  $<HTMLInputElement>('fileInputHki')?.addEventListener('change', (e) => { void onHkiFileChosen(e); });
  $<HTMLInputElement>('fileInputCdnConfig')?.addEventListener('change', (e) => { void onCdnConfigFileChosen(e); });
}
