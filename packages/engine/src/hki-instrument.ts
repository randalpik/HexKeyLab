// Atomic `.hki` → engine instrument adapter.
//
// The engine's public contract splits an instrument's "recipe" (the
// `InstrumentDef` passed to `loadInstrument`) from its raw bytes (the
// `instrumentProvider`/`audioFetch` seams). A `.hki` bundle already carries
// BOTH — a full definition in its `manifest.json` plus the encoded audio — but
// `loadInstrument` never reads the manifest itself. These helpers close that
// gap so an external consumer can treat a `.hki` as a self-sufficient,
// single-file instrument: read the bytes once, get the key + def + audio map,
// wire the audio through `instrumentProvider`, and play.
//
// Lives in `@hkl/engine` (not `@hkl/shared`) because it returns the engine's
// `InstrumentDef` type; `@hkl/shared` may not import engine types. The mapping
// mirrors HKL's own `manifestToInstrument` (apps/hkl/src/audio/samples-data.ts),
// which now delegates here so the two can't drift.

import { readHki, type HkiManifest, type HkiBundle } from '@hkl/shared/hki.js';
import type { InstrumentDef, SampleDef } from './samples-engine.js';

/**
 * Build an engine `InstrumentDef` from a `.hki` manifest.
 *
 * `source: 'hki'` routes `loadInstrument` to the byte provider rather than a
 * network fetch; `baseUrl`/`ext` are emitted empty (and unread on the `'hki'`
 * path) to keep the synthesized entry field-identical to HKL's historical
 * shape. Per-sample fields (file/freq/segments/trend/gain/vel/…) pass through
 * unchanged. `manifest.instrumentKey` is intentionally NOT part of the def — it
 * is the separate first argument to `loadInstrument`; see `readHkiInstrument`.
 */
export function instrumentDefFromManifest(m: HkiManifest): InstrumentDef {
  const def: InstrumentDef = {
    name: m.name,
    source: 'hki',
    baseUrl: '',
    ext: '',
    releaseTime: m.releaseTime,
    volume: m.volume,
    loop: m.loop,
    decays: m.decays,
    // HkiSampleEntry is structurally a SampleDef minus the latter's `[k]: unknown`
    // index signature; every named field is type-compatible and passes through
    // unchanged. The cast bridges that one signature difference.
    samples: m.samples as unknown as SampleDef[],
  };
  if (m.transpose) def.transpose = m.transpose;
  if (m.replayOnTranspose) def.replayOnTranspose = true;
  if (m.vibrato) def.vibrato = true;
  return def;
}

/**
 * Decompose a `.hki` byte buffer into everything `loadInstrument` needs: the
 * registry `key` (the bundle's `instrumentKey`), the `InstrumentDef`, and the
 * `{ file → bytes }` audio map to hand back from `instrumentProvider`.
 *
 * ```ts
 * const { key, def, audio } = readHkiInstrument(bytes);
 * engine.init(ctx, dest, { instrumentProvider: async (k) => k === key ? audio : null });
 * await engine.loadInstrument(key, def);
 * ```
 */
export function readHkiInstrument(bytes: Uint8Array): {
  key: string;
  def: InstrumentDef;
  audio: Record<string, Uint8Array>;
} {
  const bundle: HkiBundle = readHki(bytes);
  return {
    key: bundle.manifest.instrumentKey,
    def: instrumentDefFromManifest(bundle.manifest),
    audio: bundle.audio,
  };
}
