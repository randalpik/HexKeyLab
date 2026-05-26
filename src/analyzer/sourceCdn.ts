// CDN-source picker. Builds candidate sample list from baseUrl + filePatterns
// + octave range + noteStyle (via HKLInstruments.enumerateRange).
//
// No fetching happens here — that's deferred to pipeline.ts during the
// analyze pass (one shot per sample, first non-404 wins). This module just
// constructs the candidate list and updates state.

import { getState, setSource, setSamples, setStatus, onChange } from './stage.js';
import type { SampleSlot } from './state.js';

// @ts-ignore .js module
import { HKLInstruments } from '../../analyzer/analyzer-instruments.js';

interface EnumeratedNote {
  name: string;
  midi: number;
  freq: number;
}

function enumerateForCurrentConfig(): EnumeratedNote[] {
  const state = getState();
  const cfg = state.config;
  return (HKLInstruments as {
    enumerateRange: (lo: number, hi: number, style: string, semis?: number[]) => EnumeratedNote[];
  }).enumerateRange(cfg.lowOct, cfg.highOct, cfg.noteStyle) || [];
}

function buildCdnSlots(): SampleSlot[] {
  const notes = enumerateForCurrentConfig();
  const state = getState();
  const semis = state.config.transposeSemis ?? 0;
  /* Audio freq = labeled freq × 2^(semis/12). semis<0 → audio below label. */
  const semFactor = Math.pow(2, semis / 12);
  const slots: SampleSlot[] = [];
  for (const n of notes) {
    /* slot.midi is the LABELED midi (matches filename). The {MIDI} URL
       placeholder needs this. slot.freq is the AUDIO freq (= labeled freq
       shifted by transposeSemis) — that's what the analyzer hint expects
       and what the output samples[].freq stores. */
    const audioFreq = n.freq * semFactor;
    slots.push({
      name: n.name,
      midi: n.midi,
      freq: +audioFreq.toFixed(2),
      picked: false,
      state: 'pending',
    });
  }
  slots.sort((a, b) => a.midi - b.midi);
  return slots;
}

function rebuildFromInputs(): void {
  const baseUrlEl = document.getElementById('cdnBaseUrl') as HTMLInputElement | null;
  const primaryPatternEl = document.getElementById('cdnFilePattern') as HTMLInputElement | null;
  if (!baseUrlEl || !primaryPatternEl) return;
  const baseUrl = baseUrlEl.value.trim();
  const primary = primaryPatternEl.value.trim() || '{NOTE}.mp3';
  const fallback = collectFallbackPatterns();
  const patterns = [primary, ...fallback].filter(p => !!p);
  setSource({ mode: 'cdn', baseUrl, filePatterns: patterns });
  const slots = buildCdnSlots();
  setSamples(slots);
  if (!baseUrl) {
    setStatus('Enter a CDN base URL above.', 0);
  } else if (slots.length === 0) {
    setStatus('No samples to enumerate. Check octave range + note style.', 0);
  } else {
    setStatus(`Enumerated ${slots.length} candidate samples. Ready to analyze.`, 0);
  }
}

function collectFallbackPatterns(): string[] {
  const host = document.getElementById('cdnFilePatternsExtra');
  if (!host) return [];
  return Array.from(host.querySelectorAll<HTMLInputElement>('input.fallback-pattern'))
    .map(i => i.value.trim())
    .filter(v => !!v);
}

function addFallbackPatternRow(initial = ''): void {
  const host = document.getElementById('cdnFilePatternsExtra');
  if (!host) return;
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.gap = '6px';
  wrap.style.marginTop = '4px';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'fallback-pattern';
  input.placeholder = 'fallback pattern (e.g. sulD/{NOTE}.mp3)';
  input.value = initial;
  input.style.flex = '1';
  input.addEventListener('input', rebuildFromInputs);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn';
  remove.textContent = '−';
  remove.title = 'Remove this fallback';
  remove.addEventListener('click', () => {
    wrap.remove();
    rebuildFromInputs();
  });
  wrap.appendChild(input);
  wrap.appendChild(remove);
  host.appendChild(wrap);
}

export function initCdnSource(): void {
  const baseUrlEl = document.getElementById('cdnBaseUrl') as HTMLInputElement | null;
  const primaryPatternEl = document.getElementById('cdnFilePattern') as HTMLInputElement | null;
  const addBtn = document.getElementById('btnAddFilePattern') as HTMLButtonElement | null;
  if (!baseUrlEl || !primaryPatternEl || !addBtn) return;

  /* Hydrate inputs from any persisted state. */
  const initState = getState();
  if (initState.source.mode === 'cdn') {
    baseUrlEl.value = initState.source.baseUrl;
    primaryPatternEl.value = initState.source.filePatterns[0] || '';
    const host = document.getElementById('cdnFilePatternsExtra');
    if (host) {
      host.innerHTML = '';
      for (let i = 1; i < initState.source.filePatterns.length; i++) {
        addFallbackPatternRow(initState.source.filePatterns[i]);
      }
    }
  }

  baseUrlEl.addEventListener('input', rebuildFromInputs);
  primaryPatternEl.addEventListener('input', rebuildFromInputs);
  addBtn.addEventListener('click', () => addFallbackPatternRow());

  /* Sync DOM inputs to state on any state change. Handles:
       - Clear button: state.source flips back to 'local' default → blank inputs.
       - JSON import: state.source becomes cdn with new values → repopulate.
       - User typing: state mirrors what the user just typed → no-op write.
     A signature compare avoids fighting the user's in-flight input. */
  const computeSrcSig = () => {
    const s = getState().source;
    return s.mode === 'cdn' ? `cdn|${s.baseUrl}|${s.filePatterns.join('|')}` : 'local|';
  };
  let lastSrcSig = computeSrcSig();
  onChange(() => {
    const sig = computeSrcSig();
    if (sig === lastSrcSig) return;
    lastSrcSig = sig;
    const src = getState().source;
    if (src.mode === 'cdn') {
      if (baseUrlEl.value !== src.baseUrl) baseUrlEl.value = src.baseUrl;
      if (primaryPatternEl.value !== (src.filePatterns[0] || '')) {
        primaryPatternEl.value = src.filePatterns[0] || '';
      }
      const host = document.getElementById('cdnFilePatternsExtra');
      if (host) {
        host.innerHTML = '';
        for (let i = 1; i < src.filePatterns.length; i++) addFallbackPatternRow(src.filePatterns[i]);
      }
    } else {
      /* Mode flipped away from CDN (Clear-button reset). Blank the inputs. */
      baseUrlEl.value = '';
      primaryPatternEl.value = '';
      const host = document.getElementById('cdnFilePatternsExtra');
      if (host) host.innerHTML = '';
    }
  });

  /* When user changes lowOct/highOct/noteStyle in the config form, re-enum
     the CDN sample list. */
  let lastSig = '';
  onChange(() => {
    const state = getState();
    if (state.source.mode !== 'cdn') return;
    const sig = `${state.config.lowOct}|${state.config.highOct}|${state.config.noteStyle}|${state.config.transposeSemis}`;
    if (sig === lastSig) return;
    lastSig = sig;
    /* Don't loop indefinitely — only rebuild when config sig changed. */
    rebuildFromInputs();
  });

  /* When the user switches to CDN tab, force a rebuild so any config-form
     changes made while on the local tab take effect. */
  document.addEventListener('analyzer-source-mode', (e: Event) => {
    const detail = (e as CustomEvent<string>).detail;
    if (detail === 'cdn') rebuildFromInputs();
  });
}

/** Programmatically populate CDN form from an imported config. Used by
 *  the JSON import flow in output.ts. */
export function setCdnSourceFromConfig(baseUrl: string, filePatterns: string[]): void {
  const baseUrlEl = document.getElementById('cdnBaseUrl') as HTMLInputElement | null;
  const primaryPatternEl = document.getElementById('cdnFilePattern') as HTMLInputElement | null;
  const host = document.getElementById('cdnFilePatternsExtra');
  if (!baseUrlEl || !primaryPatternEl || !host) return;
  baseUrlEl.value = baseUrl;
  primaryPatternEl.value = filePatterns[0] || '';
  host.innerHTML = '';
  for (let i = 1; i < filePatterns.length; i++) addFallbackPatternRow(filePatterns[i]);
  rebuildFromInputs();
}
