import { defineConfig } from 'tsup';
import { writeFile, copyFile } from 'node:fs/promises';

/* Published package identity. The workspace package stays `@hkl/engine`
   (private, raw-.ts subpath exports for in-repo Vite consumers — untouched);
   this build emits a self-contained artifact under the public name below.
   Change PUBLISH_NAME if claiming a different npm scope. */
const PUBLISH_NAME = '@hexkeylab/engine';
// 2.0.0: breaking — sNoteOn/sNoteOnFaded take an instrumentKey; the global
// setInstrument/isLoaded are gone (instrument is per-voice now).
// 2.2.0: onset-lead timing fix — the flat 50ms pre-schedule lead (audible,
// constant note-onset latency on sample instruments) is split by instrument
// type: 15ms for looped, 5ms for decay. Also documents per-layer baked-gain
// (perceptual softening) semantics.
// 2.3.0: additive — atomic `.hki` adapter. New `readHkiInstrument(bytes)` →
// `{ key, def, audio }` and `instrumentDefFromManifest(manifest)` let a consumer
// treat a single `.hki` as a self-sufficient instrument (no separately authored
// defs JSON). Also re-exports the shared bundle API (`readHki`/`writeHki` +
// `HkiManifest`/`HkiBundle`/`HkiSampleEntry`). No breaking changes.
// 2.4.0: additive — (a) per-voice stereo pan: `sSetVoicePan(voiceKey, pan,
// rampSec?)` + optional trailing `pan` on sNoteOn/sNoteOnFaded (lazy
// StereoPannerNode — unpanned voices keep a byte-identical graph); (b)
// ramp-aware seams: wrap-aligned switching stays on the validated b→a pair
// during sRampFreq ramps (analytic trajectory, no playbackRate.value getter
// reads, ramp carried across seams; `SeamEvent.kind` tags wrap vs immediate).
// Fixes audible hiccups + wrong-pitch landings under live cent-step retuning.
// 2.4.1: fix — every AudioParam write whose value differs from the param's
// constructor default (born-silent gains, playbackRate, segmentLooper g0)
// now ALSO seeds the value into the timeline via setValueAtTime(x, 0).
// Deferred-setter hosts (react-native-audio-api 0.13.2) never consult the
// intrinsic .value once events are scheduled and resolve the pre-first-event
// region from the constructor default, leaking one unity-gain raw-buffer
// sample per source start — a click at the seam rate on instruments whose
// segment entries sit away from zero crossings. Verified on-device: ~50
// defects/10s → 0 (handoff/hkle-born-silent-gain-fix.md).
const VERSION = '2.4.1';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2022',
  sourcemap: true,
  /* Bundle @hkl/shared INTO the output (no @hkl/* deps leak to consumers), but
     keep `fflate` EXTERNAL — it must stay a normal dependency so each consumer's
     bundler resolves fflate's own `browser`/`node`/`react-native` export
     condition for its target. (Bundling it inlines fflate's Node ESM build,
     which does `import { createRequire } from "module"` and breaks browser /
     Metro builds — caught by test/react-consumer.) */
  noExternal: [/^@hkl\//],
  external: ['fflate'],
  /* Emit the publish manifest into dist/. pnpm's `publishConfig.directory:
     "dist"` (see package.json) packs THIS directory, using this package.json —
     so the published name/exports/deps are these, not the workspace ones. */
  async onSuccess() {
    const pkg = {
      name: PUBLISH_NAME,
      version: VERSION,
      description:
        'HexKeyLab audio engine (HKLE): sample-based just-intonation playback ' +
        'with click-free segment-loop crossfades. Bring your own Web Audio ' +
        'AudioContext; no app/DOM/MIDI coupling.',
      type: 'module',
      main: './index.cjs',
      module: './index.js',
      types: './index.d.ts',
      dependencies: { fflate: '^0.8.3' },
      exports: {
        '.': {
          types: './index.d.ts',
          import: './index.js',
          require: './index.cjs',
        },
      },
      sideEffects: false,
      license: 'MIT',
      publishConfig: { access: 'public' },
      keywords: [
        'audio', 'web-audio', 'just-intonation', 'microtonal',
        'sampler', 'looping', 'crossfade',
      ],
    };
    await writeFile('dist/package.json', JSON.stringify(pkg, null, 2) + '\n');
    await copyFile('README.md', 'dist/README.md').catch(() => {});
    await copyFile('LICENSE', 'dist/LICENSE').catch(() => {});
  },
});
