// Public barrel for the standalone published package (@hexkeylab/engine).
//
// In-repo consumers (apps/hkl, apps/analyzer) import the submodules directly
// via the `@hkl/engine` workspace export (raw .ts). This barrel is the clean,
// single entry point for *external* installs of the built package: it re-exports
// the sample playback engine + the standalone segment looper.
export * from './samples-engine.js';
export * from './segmentLooper.js';
