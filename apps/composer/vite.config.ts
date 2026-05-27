import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// Served under /composer/ on the shared dev origin (vite/dev-proxy.mjs) and at
// the same sub-path in production. Same origin as HKL is REQUIRED — the
// BroadcastChannel bridge and IndexedDB instrument registry are per-origin.
// Standalone: `pnpm --filter @hkl/composer dev` on :5174 (edits .hkc solo, but
// held-chord entry from HKL needs the umbrella `pnpm dev` for one origin).
export default defineConfig({
  base: '/composer/',
  publicDir: path.resolve(repoRoot, 'public'),
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    hmr: { clientPort: 5170, path: '/composer/' },
  },
  build: { target: 'es2022' },
});
