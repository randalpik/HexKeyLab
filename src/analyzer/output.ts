// Output module — emits .hki (local) or <key>-config.json (CDN) and handles
// re-importing a CDN config to restore editor state.

import { getState, onChange, setConfig, setSource, setSamples, setOpts, setAutoSelectEnabled, setStatus } from './stage.js';
import type { SampleSlot } from './state.js';
import { writeHki, type HkiManifest, type HkiSampleEntry, type HkiBundle, type HkiProvenance } from '../shared/hki.js';
import {
  CDN_CONFIG_VERSION,
  parseCdnConfig,
  stringifyCdnConfig,
  type CdnInstrumentConfig,
  type CdnConfigSampleEntry,
} from '../shared/cdnConfig.js';
import { triggerDownload } from './download.js';
import { setCdnSourceFromConfig } from './sourceCdn.js';

const GENERATOR = 'hkl-analyzer-ui@1';

function pickedSlots(): SampleSlot[] {
  return getState().samples.filter(s => s.picked && s.tier !== 'fail' && s.tier !== 'red');
}

function round(x: number, n: number): number {
  return +x.toFixed(n);
}

function sampleEntryShared(slot: SampleSlot, decays: boolean): {
  freq: number;
  gain?: number;
  segments?: Array<{ a: number; b: number }>;
  trend?: number[];
  trendHopMs?: number;
  trendStartSec?: number;
  trimStart?: number;
} {
  const res = slot.result;
  const freq = (res && typeof res.freqActual === 'number') ? res.freqActual : slot.freq;
  const out: ReturnType<typeof sampleEntryShared> = { freq: round(freq, 3) };
  if (typeof slot.gain === 'number') out.gain = round(slot.gain, 4);
  if (!decays && res?.segments?.length) {
    out.segments = res.segments.map(s => ({ a: round(s.a, 7), b: round(s.b, 7) }));
    if (typeof res.trimStart === 'number') out.trimStart = round(res.trimStart, 7);
    if (res.trend && res.trend.length > 0) {
      out.trend = Array.from(res.trend).map(v => round(v, 5));
      if (typeof res.trendHopMs === 'number') out.trendHopMs = res.trendHopMs;
      if (typeof res.trendStartSec === 'number') out.trendStartSec = round(res.trendStartSec, 7);
    }
  } else if (decays) {
    if (typeof res?.trimStart === 'number') out.trimStart = round(res.trimStart, 7);
  }
  return out;
}

/* ── HKI bundle build ─────────────────────────────────────────────── */

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i).toLowerCase() : '';
}

async function fileBytes(f: File): Promise<Uint8Array> {
  const ab = await f.arrayBuffer();
  return new Uint8Array(ab);
}

export async function buildHkiBundle(): Promise<HkiBundle> {
  const state = getState();
  if (state.source.mode !== 'local') {
    throw new Error('buildHkiBundle: source mode is not local');
  }
  const picks = pickedSlots();
  if (picks.length === 0) throw new Error('No samples picked. Toggle picks first.');

  const samples: HkiSampleEntry[] = [];
  const audio: Record<string, Uint8Array> = {};
  const originalFiles: Record<string, string> = {};

  for (const slot of picks) {
    if (!slot.file) throw new Error(`Sample "${slot.name}" has no file (local-mode bundle requires File handles)`);
    const ext = extOf(slot.file.name) || '.mp3';
    const archivePath = `samples/${slot.name}${ext}`;
    audio[archivePath] = await fileBytes(slot.file);
    originalFiles[slot.name] = slot.originalFileName ?? slot.file.name;

    const shared = sampleEntryShared(slot, state.config.decays);
    samples.push({
      name: slot.name,
      file: archivePath,
      freq: shared.freq,
      ...(shared.gain != null ? { gain: shared.gain } : {}),
      ...(shared.segments ? { segments: shared.segments } : {}),
      ...(shared.trend ? {
        trend: shared.trend,
        trendHopMs: shared.trendHopMs,
        trendStartSec: shared.trendStartSec,
      } : {}),
      ...(shared.trimStart != null ? { trimStart: shared.trimStart } : {}),
    });
  }

  /* Legacy `transpose` field is a playback-rate ratio (samples-engine.ts:351:
     rate = freq * transpose / nearest.freq). Convert from the UI's
     transposeSemis: ratio = 2^(-semis/12). transposeSemis = 0 → ratio = 1. */
  const transposeRatio = Math.pow(2, -state.config.transposeSemis / 12);
  const manifest: HkiManifest = {
    version: 1,
    instrumentKey: state.config.instrumentKey,
    name: state.config.displayName,
    loop: !state.config.decays,
    decays: state.config.decays,
    releaseTime: state.config.releaseTime,
    volume: state.config.volume,
    ...(state.config.transposeSemis !== 0 ? { transpose: +transposeRatio.toFixed(6) } : {}),
    vibrato: !state.config.decays && state.config.vibrato,
    samples,
  };
  const provenance: HkiProvenance = {
    source: 'local',
    originalFiles,
    generator: GENERATOR,
    createdAt: new Date().toISOString(),
  };
  return { manifest, audio, provenance };
}

export async function downloadHki(): Promise<void> {
  const state = getState();
  const bundle = await buildHkiBundle();
  const bytes = writeHki(bundle);
  /* fflate returns a Uint8Array view; copy into a fresh ArrayBuffer to satisfy
     Blob's typed-array semantics. */
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  triggerDownload(blob, `${state.config.instrumentKey || 'instrument'}.hki`);
}

/* ── CDN config build ─────────────────────────────────────────────── */

export function buildCdnConfigJson(): CdnInstrumentConfig {
  const state = getState();
  if (state.source.mode !== 'cdn') throw new Error('buildCdnConfigJson: source mode is not cdn');
  const picks = pickedSlots();
  if (picks.length === 0) throw new Error('No samples picked. Toggle picks first.');

  const samples: CdnConfigSampleEntry[] = picks.map(slot => {
    const shared = sampleEntryShared(slot, state.config.decays);
    const entry: CdnConfigSampleEntry = { name: slot.name, freq: shared.freq };
    if (shared.gain != null) entry.gain = shared.gain;
    if (slot.fileOverride) entry.file = slot.fileOverride;
    if (shared.segments) entry.segments = shared.segments;
    if (shared.trend) {
      entry.trend = shared.trend;
      entry.trendHopMs = shared.trendHopMs;
      entry.trendStartSec = shared.trendStartSec;
    }
    if (shared.trimStart != null) entry.trimStart = shared.trimStart;
    return entry;
  });

  const transposeRatio = Math.pow(2, -state.config.transposeSemis / 12);
  const cfg: CdnInstrumentConfig = {
    version: CDN_CONFIG_VERSION,
    instrumentKey: state.config.instrumentKey,
    name: state.config.displayName,
    baseUrl: state.source.baseUrl,
    ext: inferExtFromPattern(state.source.filePatterns[0] || ''),
    filePattern: state.source.filePatterns[0] || '{NOTE}.mp3',
    ...(state.source.filePatterns.length > 1 ? { filePatterns: [...state.source.filePatterns] } : {}),
    noteStyle: state.config.noteStyle,
    loop: !state.config.decays,
    decays: state.config.decays,
    releaseTime: state.config.releaseTime,
    volume: state.config.volume,
    ...(state.config.transposeSemis !== 0 ? { transpose: +transposeRatio.toFixed(6) } : {}),
    ...(!state.config.decays ? { vibrato: state.config.vibrato } : {}),
    samples,
    editorState: {
      lowOct: state.config.lowOct,
      highOct: state.config.highOct,
      autoSelectEnabled: state.autoSelectEnabled,
      selectedNames: picks.map(s => s.name),
      gateOpts: { ...state.opts },
      trustLabeledPitch: state.opts.trustLabeledPitch,
    },
    provenance: {
      generator: GENERATOR,
      createdAt: new Date().toISOString(),
      sourceUrl: state.source.baseUrl,
    },
  };
  return cfg;
}

function inferExtFromPattern(pattern: string): string {
  const m = pattern.match(/\.([a-z0-9]+)$/i);
  return m ? '.' + m[1].toLowerCase() : '.mp3';
}

export function downloadCdnConfig(): void {
  const state = getState();
  const cfg = buildCdnConfigJson();
  const blob = new Blob([stringifyCdnConfig(cfg)], { type: 'application/json' });
  triggerDownload(blob, `${state.config.instrumentKey || 'instrument'}-config.json`);
}

/* ── Re-import a CDN config (JSON only — .hki re-import goes through HKL) ── */

export async function handleImportClick(file: File): Promise<void> {
  const text = await file.text();
  const cfg = parseCdnConfig(text);

  /* Legacy → UI: legacy `transpose` is a ratio, UI stores semitones.
     semis = -log2(ratio) * 12. ratio=1 → semis=0, ratio=2 → semis=-12.
     Round to nearest integer — the form is integer-only. */
  const legacyRatio = cfg.transpose ?? 1;
  const transposeSemis = legacyRatio !== 1
    ? Math.round(-Math.log2(legacyRatio) * 12)
    : 0;
  setConfig({
    instrumentKey: cfg.instrumentKey,
    displayName: cfg.name,
    noteStyle: cfg.noteStyle,
    lowOct: cfg.editorState.lowOct,
    highOct: cfg.editorState.highOct,
    transposeSemis,
    decays: cfg.decays,
    vibrato: cfg.vibrato ?? true,
    releaseTime: cfg.releaseTime,
    volume: cfg.volume,
  });
  setOpts(cfg.editorState.gateOpts as Record<string, never>);
  setAutoSelectEnabled(cfg.editorState.autoSelectEnabled);

  /* Switch to CDN tab + populate inputs. */
  const tabCdn = document.getElementById('tabCdn');
  if (tabCdn) (tabCdn as HTMLElement).click();
  const filePatterns = cfg.filePatterns ?? [cfg.filePattern];
  setCdnSourceFromConfig(cfg.baseUrl, filePatterns);
  setSource({ mode: 'cdn', baseUrl: cfg.baseUrl, filePatterns });

  /* Rebuild slots from the embedded samples[] — every analyzer result comes
     straight from the imported config; no fetch/decode needed. */
  const slots: SampleSlot[] = cfg.samples.map(s => ({
    name: s.name,
    midi: midiFromNoteName(s.name) ?? 0,
    freq: s.freq,
    picked: cfg.editorState.selectedNames.includes(s.name),
    state: 'done',
    result: {
      trimStart: s.trimStart,
      segments: s.segments,
      trend: s.trend,
      trendHopMs: s.trendHopMs,
      trendStartSec: s.trendStartSec,
      freqActual: s.freq,
    },
    gain: s.gain,
    tier: cfg.decays ? 'green' : 'green', /* trust the imported config */
    status: 'imported',
    fileOverride: s.file,
  }));
  setSamples(slots);
  setStatus(`Imported ${slots.length} samples from ${file.name}. ` +
    `Re-analyze if you want fresh measurements; otherwise just edit and re-download.`, 0);
}

function midiFromNoteName(name: string): number | null {
  const m = name.match(/^([A-Ga-g])([#bs♭♯]?)(-?\d+)$/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const accid = m[2];
  const octave = parseInt(m[3], 10);
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let semi = base[letter];
  if (accid === '#' || accid === 's' || accid === '♯') semi += 1;
  else if (accid === 'b' || accid === '♭') semi -= 1;
  return 12 * (octave + 1) + semi;
}

/* ── UI wiring (called from main.ts) ──────────────────────────────── */

export function initOutputControls(): void {
  const btnHki = document.getElementById('btnDownloadHki') as HTMLButtonElement | null;
  const btnCfg = document.getElementById('btnDownloadConfig') as HTMLButtonElement | null;
  const section = document.getElementById('outputSection');
  const preview = document.getElementById('outputPreview') as HTMLPreElement | null;

  if (btnHki) btnHki.addEventListener('click', () => {
    void downloadHki().catch(e => { setStatus('HKI build failed: ' + (e as Error).message); });
  });
  if (btnCfg) btnCfg.addEventListener('click', () => {
    try { downloadCdnConfig(); }
    catch (e) { setStatus('Config build failed: ' + (e as Error).message); }
  });

  /* Show/hide buttons + preview based on source mode and whether any samples
     are picked. */
  onChange(() => {
    const state = getState();
    const haveAny = state.samples.some(s => s.picked);
    if (section) section.classList.toggle('hidden', state.samples.length === 0);
    if (btnHki) btnHki.hidden = state.source.mode !== 'local' || !haveAny;
    if (btnCfg) btnCfg.hidden = state.source.mode !== 'cdn' || !haveAny;
    if (preview && haveAny) {
      try {
        if (state.source.mode === 'cdn') {
          preview.hidden = false;
          preview.textContent = stringifyCdnConfig(buildCdnConfigJson());
        } else {
          preview.hidden = true;
        }
      } catch {
        preview.hidden = true;
      }
    } else if (preview) {
      preview.hidden = true;
    }
  });
}
