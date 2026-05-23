// User-preference persistence layer. localStorage-backed, schema-versioned.
//
// Covers musical state (tuning, layout, outline, audio, pedal mode, auto-sync)
// and view toggles. Transient state (selection, MIDI port handles, animation,
// calibration runtime) is intentionally not persisted.
//
// Schema is versioned via the storage key (hkl.prefs.v1). Bump the suffix at
// breaking schema changes and stale prefs are simply ignored.

const STORAGE_KEY = 'hkl.prefs.v1';

export type OutlineMode = 'lumatone' | 'qwerty' | 'piano' | 'none';
/* 5-mode tuning system. Numeric codes ('5', '7', 'E') retained as
   persistence values for back-compat with existing prefs and .hkr
   recordings; new modes use single-letter mnemonics:
     'E' Equal · '5' Ptolemaic · 'P' Pythagorean · 'D' Semiditonal · '7' Septimal */
export type TuningMode = 'E' | '5' | 'P' | 'D' | '7';
export type PedalMode = 'sustain' | 'sostenuto';
export type RotationMode = 'verticalFreq' | 'lumatone' | 'piano';

export interface ToolbarVisibility {
  layout: boolean;
  playback: boolean;
  analysis: boolean;
  recording: boolean;
  lumatone: boolean;
  piano: boolean;
}

export interface PianoGainCurvePrefs {
  floor: number;
  ceiling: number;
  gamma: number;
}

/* Velocity calibration (curve + per-key gain + per-key stats).
   Set by src/audio/velocityCal.ts.
   Absent = defaults (matches prior hardcoded quadratic curve and no per-key gain). */
export interface VelocityCalPrefs {
  floor: number;
  ceiling: number;
  gamma: number;
  perKey: Record<string, number>;
  statsEnabled?: boolean;
  /** Persisted snapshot of per-key velocity stats. Raw samples are session-only
   *  in velocityCal.ts; only this aggregate persists. */
  stats?: Record<string, KeyStatsSnapshot>;
  /** Velocity-input curve, applied to Lumatone-source MIDI velocity at the
   *  midi/handler.ts entry point before storage/audio/recording. Same shape as
   *  the audio-stage curve but the output domain is 0..127 (integer velocity),
   *  not 0..1 (audio gain). Default identity (floor=0, ceiling=127, gamma=1)
   *  is a no-op. Lives here, not above, because it's a Lumatone-only knob.
   *  Phase C: superseded by `intervalCurve` (which shapes at the firmware level
   *  via SysEx 0x20). Kept as a defensive identity layer; migration in
   *  velocityCal.ts resets to identity once the user adopts intervalCurve. */
  inputCurve?: { floor: number; ceiling: number; gamma: number };
  /** Lumatone firmware velocity-interval (CMD 0x20) curve parameters. Defines
   *  the press-time tick thresholds that separate the firmware's 128 velocity
   *  bins, via the parametric `low + (high - low) · (i/126)^gamma` map. HKL
   *  pushes the resolved table to the Lumatone via SysEx 0x20. */
  intervalCurve?: { low: number; high: number; gamma: number };
}

export interface KeyStatsSnapshot {
  n: number;
  mean: number;
  stddev: number;
  /** Coefficient of variation; -1 if undefined. */
  cv: number;
  /** 5th and 95th percentile velocity. Action targets: p5 ≤ 30 (can play quiet)
   *  and p95 ≥ 100 (can play loud) for an unrestricted key. */
  p5: number;
  p95: number;
}

export interface PrefsV1 {
  showNotes: boolean;
  showBands: boolean;
  extendPattern: boolean;
  showAnalysis: boolean;
  showCoords: boolean;
  shortIvl: boolean;
  outline: OutlineMode;
  rotation: RotationMode;
  tuning: TuningMode;
  audioEnabled: boolean;
  waveform: string;
  pedalMode: PedalMode;
  autoSync: boolean;
  toolbars: ToolbarVisibility;
  showDiagnostics: boolean;
  calibrateKeys: boolean;
  captureAudio: boolean;
  velocityCal?: VelocityCalPrefs;
  /** Piano-toolbar input. Selected device is a Web MIDI input id (stable per
   *  port across reloads in modern browsers). */
  pianoInputDeviceId: string | null;
  pianoEnabled: boolean;
  pianoGainCurve?: PianoGainCurvePrefs;
  /** Show a dotted outline marking the valid ref-note placement region
   *  (V5 in 5-limit/12-TET, V7-intersection in 7-limit). Off by default. */
  validRefBounds: boolean;
  /** User's manual reference-note selection (set via Ctrl+click on a hex).
   *  Absent if the user has never set one, or if they cleared it by
   *  Ctrl+clicking the current effective ref. Persists across reloads;
   *  composer-set selections + song-key tier do NOT persist (they're
   *  re-broadcast on the next composer-hello). */
  manualRef?: { q: number; r: number };
  /** When on, HKL aggressively applies any Composer-broadcast layout
   *  requirement (tuning mode + ref). When off, mismatches trigger a prompt
   *  at playback start (no prompt for note entry — that lives Composer-side). */
  syncToComposer: boolean;
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
  rotation: "verticalFreq",
  tuning: "5",
  /* audio defaults to ON to match the long-standing "load piano + play on
     first reload" behavior of pre-persistence HKL */
  audioEnabled: true,
  waveform: "splendid_piano",
  pedalMode: "sustain",
  autoSync: false,
  /* Layout + Playback cover the core single-keyboard workflow; Analysis,
     Recording, and Lumatone are opt-in for users who care about those. */
  toolbars: {
    layout: true,
    playback: true,
    analysis: false,
    recording: false,
    lumatone: false,
    piano: false,
  },
  showDiagnostics: false,
  calibrateKeys: false,
  captureAudio: false,
  pianoInputDeviceId: null,
  pianoEnabled: false,
  validRefBounds: false,
  syncToComposer: false,
};

function isOutlineMode(s: unknown): s is OutlineMode {
  return s === 'lumatone' || s === 'qwerty' || s === 'piano' || s === 'none';
}
function isRotationMode(s: unknown): s is RotationMode {
  return s === 'verticalFreq' || s === 'lumatone' || s === 'piano';
}
function isTuningMode(s: unknown): s is TuningMode {
  return s === 'E' || s === '5' || s === 'P' || s === 'D' || s === '7';
}
function isPedalMode(s: unknown): s is PedalMode {
  return s === 'sustain' || s === 'sostenuto';
}
function loadToolbars(o: unknown): ToolbarVisibility {
  if (!o || typeof o !== "object") return { ...DEFAULT_PREFS.toolbars };
  const t = o as Record<string, unknown>;
  return {
    layout:
      typeof t.layout === "boolean" ? t.layout : DEFAULT_PREFS.toolbars.layout,
    playback:
      typeof t.playback === "boolean"
        ? t.playback
        : DEFAULT_PREFS.toolbars.playback,
    analysis:
      typeof t.analysis === "boolean"
        ? t.analysis
        : DEFAULT_PREFS.toolbars.analysis,
    recording:
      typeof t.recording === "boolean"
        ? t.recording
        : DEFAULT_PREFS.toolbars.recording,
    lumatone:
      typeof t.lumatone === "boolean"
        ? t.lumatone
        : DEFAULT_PREFS.toolbars.lumatone,
    piano:
      typeof t.piano === "boolean"
        ? t.piano
        : DEFAULT_PREFS.toolbars.piano,
  };
}

function loadPianoGainCurve(o: unknown): PianoGainCurvePrefs | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const c = o as Record<string, unknown>;
  if (typeof c.floor !== 'number' || typeof c.ceiling !== 'number' || typeof c.gamma !== 'number') return undefined;
  if (c.gamma <= 0 || c.ceiling <= c.floor) return undefined;
  return { floor: c.floor, ceiling: c.ceiling, gamma: c.gamma };
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
    showNotes:
      typeof o.showNotes === "boolean" ? o.showNotes : DEFAULT_PREFS.showNotes,
    showBands:
      typeof o.showBands === "boolean" ? o.showBands : DEFAULT_PREFS.showBands,
    extendPattern:
      typeof o.extendPattern === "boolean"
        ? o.extendPattern
        : DEFAULT_PREFS.extendPattern,
    showAnalysis:
      typeof o.showAnalysis === "boolean"
        ? o.showAnalysis
        : DEFAULT_PREFS.showAnalysis,
    showCoords:
      typeof o.showCoords === "boolean"
        ? o.showCoords
        : DEFAULT_PREFS.showCoords,
    shortIvl:
      typeof o.shortIvl === "boolean" ? o.shortIvl : DEFAULT_PREFS.shortIvl,
    outline: isOutlineMode(o.outline) ? o.outline : DEFAULT_PREFS.outline,
    rotation: isRotationMode(o.rotation) ? o.rotation : DEFAULT_PREFS.rotation,
    tuning: isTuningMode(o.tuning) ? o.tuning : DEFAULT_PREFS.tuning,
    audioEnabled:
      typeof o.audioEnabled === "boolean"
        ? o.audioEnabled
        : DEFAULT_PREFS.audioEnabled,
    waveform:
      typeof o.waveform === "string" ? o.waveform : DEFAULT_PREFS.waveform,
    pedalMode: isPedalMode(o.pedalMode) ? o.pedalMode : DEFAULT_PREFS.pedalMode,
    autoSync:
      typeof o.autoSync === "boolean" ? o.autoSync : DEFAULT_PREFS.autoSync,
    toolbars: loadToolbars(o.toolbars),
    showDiagnostics:
      typeof o.showDiagnostics === "boolean"
        ? o.showDiagnostics
        : DEFAULT_PREFS.showDiagnostics,
    calibrateKeys:
      typeof o.calibrateKeys === "boolean"
        ? o.calibrateKeys
        : DEFAULT_PREFS.calibrateKeys,
    captureAudio:
      typeof o.captureAudio === "boolean"
        ? o.captureAudio
        : DEFAULT_PREFS.captureAudio,
    velocityCal: loadVelocityCal(o.velocityCal),
    pianoInputDeviceId:
      typeof o.pianoInputDeviceId === 'string'
        ? o.pianoInputDeviceId
        : DEFAULT_PREFS.pianoInputDeviceId,
    pianoEnabled:
      typeof o.pianoEnabled === 'boolean'
        ? o.pianoEnabled
        : DEFAULT_PREFS.pianoEnabled,
    pianoGainCurve: loadPianoGainCurve(o.pianoGainCurve),
    validRefBounds:
      typeof o.validRefBounds === 'boolean'
        ? o.validRefBounds
        : DEFAULT_PREFS.validRefBounds,
    manualRef: loadManualRef(o.manualRef),
    syncToComposer:
      typeof o.syncToComposer === 'boolean'
        ? o.syncToComposer
        : DEFAULT_PREFS.syncToComposer,
  };
}

function loadManualRef(o: unknown): { q: number; r: number } | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const m = o as Record<string, unknown>;
  if (typeof m.q !== 'number' || typeof m.r !== 'number') return undefined;
  if (!Number.isFinite(m.q) || !Number.isFinite(m.r)) return undefined;
  return { q: m.q, r: m.r };
}

function loadVelocityCal(o: unknown): VelocityCalPrefs | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const v = o as Record<string, unknown>;
  if (typeof v.floor !== 'number' || typeof v.ceiling !== 'number' || typeof v.gamma !== 'number') return undefined;
  const perKey: Record<string, number> = {};
  if (v.perKey && typeof v.perKey === 'object') {
    for (const [k, val] of Object.entries(v.perKey as Record<string, unknown>)) {
      if (typeof val === 'number' && val > 0 && val < 10) perKey[k] = val;
    }
  }
  const statsEnabled = typeof v.statsEnabled === 'boolean' ? v.statsEnabled : undefined;
  let stats: Record<string, KeyStatsSnapshot> | undefined;
  if (v.stats && typeof v.stats === 'object') {
    const s: Record<string, KeyStatsSnapshot> = {};
    for (const [k, val] of Object.entries(v.stats as Record<string, unknown>)) {
      if (!val || typeof val !== 'object') continue;
      const r = val as Record<string, unknown>;
      if (typeof r.n === 'number' && typeof r.mean === 'number'
          && typeof r.stddev === 'number' && typeof r.cv === 'number') {
        /* p5/p95 are new — accept stored values when present, otherwise fall
           back to mean ± stddev as a reasonable approximation until samples
           accumulate. */
        const p5 = typeof r.p5 === 'number' ? r.p5 : Math.max(0, r.mean - r.stddev);
        const p95 = typeof r.p95 === 'number' ? r.p95 : Math.min(127, r.mean + r.stddev);
        s[k] = { n: r.n, mean: r.mean, stddev: r.stddev, cv: r.cv, p5, p95 };
      }
    }
    if (Object.keys(s).length > 0) stats = s;
  }
  let inputCurve: { floor: number; ceiling: number; gamma: number } | undefined;
  if (v.inputCurve && typeof v.inputCurve === 'object') {
    const ic = v.inputCurve as Record<string, unknown>;
    if (typeof ic.floor === 'number' && typeof ic.ceiling === 'number' && typeof ic.gamma === 'number') {
      inputCurve = { floor: ic.floor, ceiling: ic.ceiling, gamma: ic.gamma };
    }
  }
  let intervalCurve: { low: number; high: number; gamma: number } | undefined;
  if (v.intervalCurve && typeof v.intervalCurve === 'object') {
    const ic = v.intervalCurve as Record<string, unknown>;
    if (typeof ic.low === 'number' && typeof ic.high === 'number' && typeof ic.gamma === 'number'
        && ic.low >= 0 && ic.high <= 4095 && ic.low < ic.high && ic.gamma > 0) {
      intervalCurve = { low: ic.low, high: ic.high, gamma: ic.gamma };
    }
  }
  return { floor: v.floor, ceiling: v.ceiling, gamma: v.gamma, perKey, statsEnabled, stats, inputCurve, intervalCurve };
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
