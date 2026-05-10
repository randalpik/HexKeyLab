// User-preference persistence layer. localStorage-backed, schema-versioned.
//
// Covers musical state (tuning, layout, outline, audio, pedal mode, auto-sync)
// and view toggles. Transient state (selection, MIDI port handles, animation,
// calibration runtime) is intentionally not persisted.
//
// Schema is versioned via the storage key (hkl.prefs.v1). Bump the suffix at
// breaking schema changes and stale prefs are simply ignored.

const STORAGE_KEY = 'hkl.prefs.v1';

export type OutlineMode = 'lumatone' | 'qwerty' | 'none';
export type TuningMode = '5' | '7' | 'E';
export type PedalMode = 'sustain' | 'sostenuto';
export type LayoutId = 1 | 2 | 3;

export interface PrefsV1 {
  showNotes: boolean;
  showBands: boolean;
  extendPattern: boolean;
  showAnalysis: boolean;
  showCoords: boolean;
  shortIvl: boolean;
  outline: OutlineMode;
  tuning: TuningMode;
  septimalShift: number;
  curLayout: LayoutId;
  qwertyTranspose: number;
  audioEnabled: boolean;
  waveform: string;
  pedalMode: PedalMode;
  autoSync: boolean;
}

/* Defaults mirror the HTML attributes + state/*.ts initial values, so a fresh
   user (no localStorage entry) gets the same first-load behavior as today. */
export const DEFAULT_PREFS: PrefsV1 = {
  showNotes: true,
  showBands: true,
  extendPattern: true,
  showAnalysis: true,
  showCoords: false,
  shortIvl: false,
  outline: "lumatone",
  tuning: "5",
  septimalShift: 0,
  curLayout: 1,
  qwertyTranspose: 0,
  /* audio defaults to ON to match the long-standing "load piano + play on
     first reload" behavior of pre-persistence HKL */
  audioEnabled: true,
  waveform: "piano",
  pedalMode: "sustain",
  autoSync: false,
};

function isLayoutId(n: unknown): n is LayoutId {
  return n === 1 || n === 2 || n === 3;
}
function isOutlineMode(s: unknown): s is OutlineMode {
  return s === 'lumatone' || s === 'qwerty' || s === 'none';
}
function isTuningMode(s: unknown): s is TuningMode {
  return s === '5' || s === '7' || s === 'E';
}
function isPedalMode(s: unknown): s is PedalMode {
  return s === 'sustain' || s === 'sostenuto';
}
function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/* Read prefs from localStorage. Missing/invalid fields fall back per-field
   to DEFAULT_PREFS — a corrupted single field doesn't wipe valid ones. */
export function loadPrefs(): PrefsV1 {
  let raw: string | null = null;
  try { raw = localStorage.getItem(STORAGE_KEY); }
  catch { /* SecurityError in sandboxed/private contexts */ }
  if (raw === null) return { ...DEFAULT_PREFS };
  let obj: unknown;
  try { obj = JSON.parse(raw); }
  catch {
    console.warn('hkl: prefs JSON parse failed; using defaults');
    return { ...DEFAULT_PREFS };
  }
  if (!obj || typeof obj !== 'object') return { ...DEFAULT_PREFS };
  const o = obj as Record<string, unknown>;
  return {
    showNotes: typeof o.showNotes === 'boolean' ? o.showNotes : DEFAULT_PREFS.showNotes,
    showBands: typeof o.showBands === 'boolean' ? o.showBands : DEFAULT_PREFS.showBands,
    extendPattern: typeof o.extendPattern === 'boolean' ? o.extendPattern : DEFAULT_PREFS.extendPattern,
    showAnalysis: typeof o.showAnalysis === 'boolean' ? o.showAnalysis : DEFAULT_PREFS.showAnalysis,
    showCoords: typeof o.showCoords === 'boolean' ? o.showCoords : DEFAULT_PREFS.showCoords,
    shortIvl: typeof o.shortIvl === 'boolean' ? o.shortIvl : DEFAULT_PREFS.shortIvl,
    outline: isOutlineMode(o.outline) ? o.outline : DEFAULT_PREFS.outline,
    tuning: isTuningMode(o.tuning) ? o.tuning : DEFAULT_PREFS.tuning,
    septimalShift: isFiniteNumber(o.septimalShift) ? o.septimalShift : DEFAULT_PREFS.septimalShift,
    curLayout: isLayoutId(o.curLayout) ? o.curLayout : DEFAULT_PREFS.curLayout,
    qwertyTranspose: isFiniteNumber(o.qwertyTranspose) ? o.qwertyTranspose : DEFAULT_PREFS.qwertyTranspose,
    audioEnabled: typeof o.audioEnabled === 'boolean' ? o.audioEnabled : DEFAULT_PREFS.audioEnabled,
    waveform: typeof o.waveform === 'string' ? o.waveform : DEFAULT_PREFS.waveform,
    pedalMode: isPedalMode(o.pedalMode) ? o.pedalMode : DEFAULT_PREFS.pedalMode,
    autoSync: typeof o.autoSync === 'boolean' ? o.autoSync : DEFAULT_PREFS.autoSync,
  };
}

/* Merge a partial patch into the stored prefs and write back. Read-modify-write
   so concurrent saves from independent handlers don't clobber each other's fields. */
export function savePrefs(patch: Partial<PrefsV1>): void {
  const cur = loadPrefs();
  const next = { ...cur, ...patch };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
  catch { /* QuotaExceededError or SecurityError — best effort */ }
}

export function clearPrefs(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
}
