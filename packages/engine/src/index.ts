// Public barrel for the standalone published package (@hexkeylab/engine).
//
// In-repo consumers (apps/hkl, apps/analyzer) import the submodules directly
// via the `@hkl/engine` workspace export (raw .ts). This barrel is the clean,
// single entry point for *external* installs of the built package: it re-exports
// the sample playback engine + the standalone segment looper.
export * from './samples-engine.js';
export * from './segmentLooper.js';
// Atomic `.hki` → InstrumentDef adapter, so a single `.hki` is a self-sufficient
// instrument for external consumers (no separately-authored defs JSON needed).
export * from './hki-instrument.js';
// Re-export the shared bundle API: external installs get only `@hexkeylab/engine`
// (not `@hkl/shared`), and tsup bundles `@hkl/shared` into dist, so these resolve
// with no additional dependency.
export { readHki, writeHki, type HkiManifest, type HkiBundle, type HkiSampleEntry } from '@hkl/shared/hki.js';
