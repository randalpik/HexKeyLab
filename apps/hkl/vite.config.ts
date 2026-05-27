import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// The core HKL viewer — served at the root of the shared dev origin
// (vite/dev-proxy.mjs) and at / in production. Same origin as Composer and
// Analyzer is REQUIRED: the BroadcastChannel bridge and IndexedDB instrument
// registry are per-origin. The /iowa-mis* + /analyzer-configs-manifest dev
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
  build: { target: 'es2022' },
});
