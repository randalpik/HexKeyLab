import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// The core HKL viewer — served at the root of the shared dev origin
// (vite/dev-proxy.mjs) and at / in production. Same origin as Composer and
// Analyzer is REQUIRED: the BroadcastChannel bridge and IndexedDB instrument
// registry are per-origin. The /iowa-mis* dev
// endpoints live on the proxy, so use the umbrella `pnpm dev`.
export default defineConfig({
  base: '/',
  publicDir: path.resolve(repoRoot, 'public'),
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    hmr: { clientPort: 5170, path: '/' },
  },
  build: {
    target: 'es2022',
    /* three pages: the app, and the shape guide's two (src/shapes/page.ts and
       scalePage.ts), which share the lattice's painters but none of its audio,
       MIDI or toolbar */
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        shapes: path.resolve(__dirname, 'shapes.html'),
        scales: path.resolve(__dirname, 'scales.html'),
      },
    },
  },
});
