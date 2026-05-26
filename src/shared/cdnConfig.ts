// HexKeyLab CDN-source instrument config (`<key>-config.json`) — round-trippable
// editor output for CDN-sourced instruments built in the Analyzer UI.
//
// Twin sibling to src/shared/hki.ts. The Analyzer emits one of two artifacts:
//   - Local sources  → `.hki` bundle (src/shared/hki.ts)
//   - CDN sources    → `<key>-config.json` (this module)
//
// The CDN file is BOTH a paste-ready source for a new entry in
// src/audio/samples-data.ts AND a re-importable editor state so the user
// can resume tweaking. The per-sample analyzer output (segments, trend,
// gain, freq) is embedded in `samples[]` so re-import doesn't have to
// re-fetch + re-analyze; the form state lives separately in `editorState`
// so the user can re-analyze with different gate opts if they want.
//
// Pure-data per src/shared/ rules: no DOM, no engine refs.

export const CDN_CONFIG_VERSION = 1 as const;

export type NoteStyle = 'flat' | 'sharp' | 'salamander' | 'sharp_s' | 'sharp_lower';

export interface CdnConfigSampleEntry {
  /** Note name as it appears in the dropdown / samples-data.ts (e.g. "C4"). */
  name: string;
  /** Optional explicit filename component (e.g. when filePattern + name can't
   *  reconstruct the URL — jRhodes needs both NOTE and MIDI). */
  file?: string;
  /** Analyzer-measured (or labeled, per trustLabeledPitch) fundamental Hz. */
  freq: number;
  /** Per-sample gain factor, normalizing to TARGET_DBFS (−18 dBFS RMS). */
  gain?: number;
  /** Loop pipeline only — segment (a, b) time pairs in seconds. Sorted by `a`. */
  segments?: Array<{ a: number; b: number }>;
  /** Trend envelope (sustained loop only). Mean-normalized samples. */
  trend?: number[];
  trendHopMs?: number;
  trendStartSec?: number;
  /** Silence-trim offset in seconds at the start of the buffer. */
  trimStart?: number;
}

export interface CdnInstrumentConfig {
  /** Format version. Mismatched versions are rejected on import. */
  version: typeof CDN_CONFIG_VERSION;
  /** Stable key under which the instrument is registered (`INSTRUMENTS[key]`). */
  instrumentKey: string;
  /** Human-facing name shown in the dropdown. */
  name: string;
  /** Base URL for CDN fetch. */
  baseUrl: string;
  /** Filename extension (informational; filePattern supplies the actual path). */
  ext: string;
  /** Primary filename pattern. Supports placeholders: {NOTE}, {NOTE_LETTER},
   *  {NOTE_LOWER}, {MIDI}. */
  filePattern: string;
  /** Ordered fallback pattern list (Iowa sul-string style: try sulG → sulD → …). */
  filePatterns?: string[];
  /** How to spell each note in the filename. */
  noteStyle: NoteStyle;
  /** Optional sparse semi subset (e.g. [0,3,6,9] for Salamander). */
  noteSemis?: number[];
  /** True for sustained-tone instruments (uses loop-segments). */
  loop: boolean;
  /** True for naturally-decaying instruments (piano, harp, etc.). */
  decays: boolean;
  /** Engine release-tail duration in seconds. */
  releaseTime: number;
  /** Per-instrument gain multiplier. */
  volume: number;
  /** Optional: filename-vs-audio octave offset (e.g. drawbar organs at 2). */
  transpose?: number;
  /** Opt-in: analyzer ran with vibrato-loose phase defaults. */
  vibrato?: boolean;
  /** Opt-in: retrigger on coordinate transposes instead of crossfading. */
  replayOnTranspose?: boolean;
  /** Per-sample analyzer output. Mirrors the shape of an entry in
   *  samples-data.ts so this JSON is directly usable as a runtime source. */
  samples: CdnConfigSampleEntry[];

  /** Round-trip half: the editor state that produced this analysis run.
   *  Redundant for playback; lets re-import restore the form including
   *  manual pick overrides and gate-knob tweaks. */
  editorState: {
    lowOct: number;
    highOct: number;
    autoSelectEnabled: boolean;
    /** Names of samples the user kept (may differ from samples[] if the user
     *  manually unchecked a sample post-analysis). */
    selectedNames: string[];
    /** Gate parameters used for the current analysis pass. Stored as a loose
     *  Record so additions to the analyzer's opts surface don't break this
     *  format. */
    gateOpts: Record<string, unknown>;
    trustLabeledPitch?: boolean;
    keepAllGreenRange?: boolean;
  };

  /** Optional free-form provenance. */
  provenance?: {
    generator?: string;
    createdAt?: string;
    /** Original CDN base, before any Iowa-MIS dev-proxy rewrites. */
    sourceUrl?: string;
    notes?: string;
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse + validate a `<key>-config.json` string. Throws on malformed input.
 *  Defensive validation only — extra fields are preserved (cast to the
 *  declared type via the same trick as validateManifest in hki.ts). */
export function parseCdnConfig(text: string): CdnInstrumentConfig {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (e) { throw new Error('CDN config: invalid JSON (' + (e as Error).message + ')'); }
  if (!isPlainObject(raw)) throw new Error('CDN config: top-level JSON is not an object');
  if (raw.version !== CDN_CONFIG_VERSION) {
    throw new Error('CDN config: unsupported version ' + String(raw.version) +
      ' (expected ' + CDN_CONFIG_VERSION + ')');
  }
  for (const f of ['instrumentKey', 'name', 'baseUrl', 'ext', 'filePattern', 'noteStyle'] as const) {
    if (typeof raw[f] !== 'string' || !(raw[f] as string)) {
      throw new Error('CDN config: missing/empty field "' + f + '"');
    }
  }
  for (const f of ['loop', 'decays'] as const) {
    if (typeof raw[f] !== 'boolean') throw new Error('CDN config: missing boolean field "' + f + '"');
  }
  for (const f of ['releaseTime', 'volume'] as const) {
    if (typeof raw[f] !== 'number') throw new Error('CDN config: missing number field "' + f + '"');
  }
  if (!Array.isArray(raw.samples)) throw new Error('CDN config: samples is not an array');
  for (const s of raw.samples) {
    if (!isPlainObject(s)) throw new Error('CDN config: sample entry is not an object');
    if (typeof s.name !== 'string') throw new Error('CDN config: sample.name missing');
    if (typeof s.freq !== 'number') throw new Error('CDN config: sample.freq missing for ' + String(s.name));
  }
  if (!isPlainObject(raw.editorState)) throw new Error('CDN config: editorState missing');
  return raw as unknown as CdnInstrumentConfig;
}

/** Serialize a CDN config to a pretty-printed JSON string. */
export function stringifyCdnConfig(cfg: CdnInstrumentConfig): string {
  return JSON.stringify(cfg, null, 2);
}
