// Config form — two-way binding between DOM and state.config.

import { getState, setConfig, onChange } from './stage.js';
import type { NoteStyle } from '../shared/cdnConfig.js';

function $<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

type Field =
  | { id: string; field: 'instrumentKey' | 'displayName'; kind: 'text' }
  | { id: string; field: 'noteStyle'; kind: 'select-style' }
  | { id: string; field: 'lowOct' | 'highOct' | 'transposeSemis'; kind: 'int' }
  | { id: string; field: 'releaseTime' | 'volume'; kind: 'float' }
  | { id: string; field: 'decays' | 'vibrato'; kind: 'bool' };

const FIELDS: Field[] = [
  { id: 'cfgInstrumentKey', field: 'instrumentKey',   kind: 'text' },
  { id: 'cfgDisplayName',   field: 'displayName',     kind: 'text' },
  { id: 'cfgNoteStyle',     field: 'noteStyle',       kind: 'select-style' },
  { id: 'cfgLowOct',        field: 'lowOct',          kind: 'int' },
  { id: 'cfgHighOct',       field: 'highOct',         kind: 'int' },
  { id: 'cfgTranspose',     field: 'transposeSemis',  kind: 'int' },
  { id: 'cfgDecays',        field: 'decays',          kind: 'bool' },
  { id: 'cfgVibrato',       field: 'vibrato',         kind: 'bool' },
  { id: 'cfgReleaseTime',   field: 'releaseTime',     kind: 'float' },
  { id: 'cfgVolume',        field: 'volume',          kind: 'float' },
];

function readField(f: Field, el: HTMLInputElement | HTMLSelectElement): unknown {
  const v = el.value;
  switch (f.kind) {
    case 'text': return v;
    case 'select-style': return v as NoteStyle;
    case 'int': {
      const n = parseInt(v, 10);
      return isFinite(n) ? n : 0;
    }
    case 'float': {
      const n = parseFloat(v);
      return isFinite(n) ? n : 0;
    }
    case 'bool': return v === 'true';
  }
}

function writeField(f: Field, el: HTMLInputElement | HTMLSelectElement, value: unknown): void {
  switch (f.kind) {
    case 'text':
    case 'select-style':
      el.value = String(value ?? '');
      break;
    case 'int':
    case 'float':
      el.value = String(value ?? 0);
      break;
    case 'bool':
      el.value = String(value === true);
      break;
  }
}

export function initConfigForm(): void {
  /* Hydrate form from initial state. */
  const state = getState();
  for (const f of FIELDS) {
    const el = $<HTMLInputElement | HTMLSelectElement>(f.id);
    if (!el) continue;
    writeField(f, el, (state.config as unknown as Record<string, unknown>)[f.field]);
  }

  /* Wire changes back to state. */
  for (const f of FIELDS) {
    const el = $<HTMLInputElement | HTMLSelectElement>(f.id);
    if (!el) continue;
    const handler = () => {
      const value = readField(f, el);
      setConfig({ [f.field]: value } as Partial<typeof state.config>);
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }

  /* Mirror state → form for programmatic updates (e.g. JSON import). */
  let lastSig = '';
  onChange(() => {
    const s = getState();
    const sig = JSON.stringify(s.config);
    if (sig === lastSig) return;
    lastSig = sig;
    for (const f of FIELDS) {
      const el = $<HTMLInputElement | HTMLSelectElement>(f.id);
      if (!el) continue;
      const target = String((s.config as unknown as Record<string, unknown>)[f.field] ?? '');
      if (el.value !== target) writeField(f, el, (s.config as unknown as Record<string, unknown>)[f.field]);
    }
  });
}
