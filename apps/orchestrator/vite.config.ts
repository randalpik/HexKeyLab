import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// Served under /orchestrator/ on the shared dev origin (vite/dev-proxy.mjs) and
// at the same sub-path in production. Standalone: `pnpm --filter @hkl/orchestrator
// dev` on :5176 — but the HKL bridge (Send-to-HKL) needs the umbrella `pnpm dev`
// so HKL and the Orchestrator share one origin (BroadcastChannel is per-origin).
//
// `worker: { format: 'es' }` is required: the capture AudioWorklet and the
// analysis ?worker are ES modules.
export default defineConfig({
  base: '/orchestrator/',
  publicDir: path.resolve(repoRoot, 'public'),
  server: {
    host: '0.0.0.0',
    port: 5176,
    strictPort: true,
    hmr: { clientPort: 5170, path: '/orchestrator/' },
  },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
