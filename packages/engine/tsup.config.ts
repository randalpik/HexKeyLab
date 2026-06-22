import { defineConfig } from 'tsup';
import { writeFile, copyFile } from 'node:fs/promises';

/* Published package identity. The workspace package stays `@hkl/engine`
   (private, raw-.ts subpath exports for in-repo Vite consumers — untouched);
   this build emits a self-contained artifact under the public name below.
   Change PUBLISH_NAME if claiming a different npm scope. */
const PUBLISH_NAME = '@hexkeylab/engine';
const VERSION = '1.0.0';

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
