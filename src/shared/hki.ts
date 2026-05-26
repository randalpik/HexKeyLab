// HexKeyLab Instrument bundle (`.hki`) — format reader/writer.
//
// A `.hki` is a ZIP archive (deflate) packaging an instrument's analyzer
// output together with its encoded audio. Two consumers:
//   - HKL (browser): import a bundle, decode samples, play through the
//     sample engine without any network fetch.
//   - The Node CLI (analyzer/bundle.js): write a bundle after a local-source
//     analysis run.
//
// Pure-data module per src/shared/ rules: schema types + fflate-backed
// (un)zip wrappers, no DOM, no engine refs.
//
// Layout inside the archive:
//   manifest.json                  // HkiManifest, JSON
//   samples/<sample-name>.<ext>    // one audio file per kept sample
//   provenance.json                // optional; source URL/path, etc.
//
// The manifest mirrors a single entry in src/audio/samples-data.ts's
// INSTRUMENTS map, minus the `baseUrl` field (the engine reads bytes from
// the in-memory blob map produced by readHki) and with each sample's
// archive-relative path on the per-sample `file` field.

import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

export const HKI_MANIFEST_VERSION = 1 as const;

export interface HkiSampleEntry {
  /** Note name as it appears in the instrument's sample list (e.g. "C4"). */
  name: string;
  /** Archive-relative path to the audio file (e.g. "samples/C4.opus"). */
  file: string;
  /** Analyzer-measured fundamental (Hz). */
  freq: number;
  /** Per-sample gain factor, normalizing to TARGET_DBFS. Defaults to 1.0. */
  gain?: number;
  /** Loop pipeline only — segment (a, b) time pairs in seconds. */
  segments?: Array<{ a: number; b: number }>;
  /** Trend envelope (sustained loop only). Mean-normalized array. */
  trend?: number[];
  trendHopMs?: number;
  trendStartSec?: number;
  /** Silence-trim offset in seconds at the start of the buffer. */
  trimStart?: number;
}

export interface HkiManifest {
  /** Format version. Mismatched versions are rejected by readHki. */
  version: typeof HKI_MANIFEST_VERSION;
  /** Stable key under which the instrument is registered (`INSTRUMENTS[key]`). */
  instrumentKey: string;
  /** Human-facing name shown in the dropdown. */
  name: string;
  /** True for sustained-tone instruments (uses loop-segments). */
  loop: boolean;
  /** True for naturally-decaying instruments (piano, harp, etc.). */
  decays: boolean;
  /** Engine release-tail duration in seconds. */
  releaseTime: number;
  /** Per-instrument gain multiplier. */
  volume: number;
  /** Optional: filename-vs-audio octave offset (e.g. drawbar organs). */
  transpose?: number;
  /** Opt-in: retrigger (not crossfade) on coordinate transposes. */
  replayOnTranspose?: boolean;
  /** Opt-in: analyzer ran with vibrato-loose phase defaults. */
  vibrato?: boolean;
  samples: HkiSampleEntry[];
}

export interface HkiProvenance {
  /** Where this bundle was produced. Free-form metadata; not load-bearing. */
  source?: 'cdn' | 'local' | 'orchestrator' | string;
  sourceUrl?: string;
  sourceDir?: string;
  /** Original filenames keyed by sample.name (pre-encode). */
  originalFiles?: Record<string, string>;
  /** Generator version / git sha for reproducibility. */
  generator?: string;
  /** ISO timestamp at bundle creation. */
  createdAt?: string;
  [extra: string]: unknown;
}

export interface HkiBundle {
  manifest: HkiManifest;
  /** Audio bytes keyed by sample.file (archive-relative path). */
  audio: Record<string, Uint8Array>;
  provenance?: HkiProvenance;
}

const MANIFEST_PATH = 'manifest.json';
const PROVENANCE_PATH = 'provenance.json';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateManifest(raw: unknown): HkiManifest {
  if (!isPlainObject(raw)) throw new Error('manifest.json is not a JSON object');
  if (raw.version !== HKI_MANIFEST_VERSION) {
    throw new Error(`unsupported manifest version ${String(raw.version)} (expected ${HKI_MANIFEST_VERSION})`);
  }
  if (typeof raw.instrumentKey !== 'string' || !raw.instrumentKey) throw new Error('manifest.instrumentKey missing');
  if (typeof raw.name !== 'string') throw new Error('manifest.name missing');
  if (typeof raw.loop !== 'boolean') throw new Error('manifest.loop missing');
  if (typeof raw.decays !== 'boolean') throw new Error('manifest.decays missing');
  if (typeof raw.releaseTime !== 'number') throw new Error('manifest.releaseTime missing');
  if (typeof raw.volume !== 'number') throw new Error('manifest.volume missing');
  if (!Array.isArray(raw.samples) || raw.samples.length === 0) throw new Error('manifest.samples missing or empty');
  for (const s of raw.samples) {
    if (!isPlainObject(s)) throw new Error('sample entry is not an object');
    if (typeof s.name !== 'string') throw new Error('sample.name missing');
    if (typeof s.file !== 'string') throw new Error(`sample.file missing for ${String(s.name)}`);
    if (typeof s.freq !== 'number') throw new Error(`sample.freq missing for ${s.name}`);
  }
  return raw as unknown as HkiManifest;
}

/** Parse a `.hki` byte buffer. Validates manifest shape; throws on malformed input. */
export function readHki(bytes: Uint8Array): HkiBundle {
  const entries = unzipSync(bytes);
  const manifestBytes = entries[MANIFEST_PATH];
  if (!manifestBytes) throw new Error('not a .hki bundle: manifest.json missing');
  const manifest = validateManifest(JSON.parse(strFromU8(manifestBytes)));

  const audio: Record<string, Uint8Array> = {};
  for (const s of manifest.samples) {
    const bytes2 = entries[s.file];
    if (!bytes2) throw new Error(`sample audio missing in bundle: ${s.file}`);
    audio[s.file] = bytes2;
  }

  let provenance: HkiProvenance | undefined;
  const provBytes = entries[PROVENANCE_PATH];
  if (provBytes) {
    try { provenance = JSON.parse(strFromU8(provBytes)) as HkiProvenance; }
    catch { /* malformed provenance is non-fatal */ }
  }

  return { manifest, audio, provenance };
}

/** Serialize a bundle to `.hki` bytes. */
export function writeHki(bundle: HkiBundle): Uint8Array {
  const manifest = validateManifest(bundle.manifest);
  const files: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: strToU8(JSON.stringify(manifest, null, 2)),
  };
  for (const s of manifest.samples) {
    const a = bundle.audio[s.file];
    if (!a) throw new Error(`audio for ${s.file} not provided to writeHki`);
    files[s.file] = a;
  }
  if (bundle.provenance) {
    files[PROVENANCE_PATH] = strToU8(JSON.stringify(bundle.provenance, null, 2));
  }
  return zipSync(files, { level: 6 });
}

/** Total uncompressed size of all sample bytes — useful for storage UI. */
export function bundleAudioSize(bundle: HkiBundle): number {
  let n = 0;
  for (const k in bundle.audio) n += bundle.audio[k].byteLength;
  return n;
}
