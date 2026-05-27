import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// Served under /analyzer/ on the shared dev origin (vite/dev-proxy.mjs) and at
// the same sub-path in production. Standalone: `pnpm --filter @hkl/analyzer dev`
// on :5175 — the /iowa-mis + /analyzer-configs-manifest dev endpoints live on
// the proxy, so use the umbrella `pnpm dev` for full-fidelity analysis.
export default defineConfig({
  base: '/analyzer/',
  publicDir: path.resolve(repoRoot, 'public'),
  server: {
    host: '0.0.0.0',
    port: 5175,
    strictPort: true,
    hmr: { clientPort: 5170, path: '/analyzer/' },
  },
  build: { target: 'es2022' },
});
