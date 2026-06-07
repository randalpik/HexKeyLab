import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// Served under /guide/ on the shared dev origin (vite/dev-proxy.mjs) and at the
// same sub-path in production. It renders the user-facing guides in
// docs/guide/*.md (imported `?raw`) as a tabbed viewer. `server.fs.allow` lets
// the dev server read those .md files, which live outside this app's root.
// Standalone: `pnpm --filter @hkl/guide dev` on :5177.
export default defineConfig({
  base: '/guide/',
  publicDir: path.resolve(repoRoot, 'public'),
  server: {
    host: '0.0.0.0',
    port: 5177,
    strictPort: true,
    hmr: { clientPort: 5170, path: '/guide/' },
    fs: { allow: [repoRoot] },
  },
  build: { target: 'es2022' },
});
