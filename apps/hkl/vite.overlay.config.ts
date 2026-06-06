import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// Lean OBS-overlay build → dist-overlay/. Reuses the full index.html (so the
// composer-frame CSS + control-element markup the renderer reads stay in sync,
// no drift) but swaps the entry script to src/overlay-main.ts, whose import
// graph is render-only (no audio/MIDI/samples/recording — see Part 1 decoupling).
//
// publicDir:false — the overlay needs no sample audio (those would bloat the
// distributable). BravuraText.woff2 IS needed (note-name HEJI + Verovio text)
// and is copied in explicitly below — the CDN @font-face fallback proved
// unreliable in OBS-CEF, and a self-contained font keeps the distributable
// working offline. (Verovio WASM is still CDN-loaded by @hkl/notation.)
//
// Consumed by apps/overlay-host (which embeds dist-overlay/ and serves it +
// the relay on one local origin). Build via `pnpm --filter @hkl/hkl build:overlay`.
export default defineConfig({
  base: '/',
  publicDir: false,
  plugins: [
    {
      name: 'hkl-overlay-entry-swap',
      /* order:'pre' so the swap runs BEFORE Vite's build-html plugin extracts
         the <script> entry — otherwise the entry stays src/main.ts (which
         dynamic-imports the full app) and init.js lands in the bundle. */
      transformIndexHtml: {
        order: 'pre',
        handler(html: string) {
          /* Swap the entry to the lean overlay graph, AND flag this page as
             host-served so overlay-ws.ts dials the relay SAME-ORIGIN (tracks
             whatever port the host runs on). Non-host pages (dev/Netlify
             performer) lack the flag and dial the host's default port. */
          return html
            .replace('/src/main.ts', '/src/overlay-main.ts')
            .replace('</head>', '<script>window.__HKL_OVERLAY_SAME_ORIGIN=1</script>\n</head>');
        },
      },
    },
    {
      name: 'hkl-overlay-copy-font',
      /* Bundle just the Bravura font (not all of public/, which has samples) so
         /BravuraText.woff2 resolves locally — no CDN dependency in OBS. */
      closeBundle() {
        copyFileSync(
          path.join(repoRoot, 'public/BravuraText.woff2'),
          path.join(__dirname, 'dist-overlay/BravuraText.woff2'),
        );
      },
    },
  ],
  build: {
    target: 'es2022',
    outDir: path.resolve(__dirname, 'dist-overlay'),
    emptyOutDir: true,
  },
});
