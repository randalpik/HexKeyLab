// Assemble the per-app Vite builds into one publish directory for static
// hosting (Netlify). The umbrella `pnpm dev` reverse-proxies the three app dev
// servers under one origin; production has no proxy, so we lay the apps out as
// real sub-paths that match each app's Vite `base`:
//
//   dist/            <- apps/hkl/dist/*       (base '/')
//   dist/composer/   <- apps/composer/dist/*  (base '/composer/')
//   dist/analyzer/   <- apps/analyzer/dist/*  (base '/analyzer/')
//
// Asset URLs are already base-prefixed by each app's build, so this is a pure
// copy — no path rewriting. Same origin is preserved, which the HKL<->Composer
// BroadcastChannel bridge and the per-origin IndexedDB registry require.
import { cpSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const out = path.join(repoRoot, 'dist');

const apps = [
  { name: 'hkl', dest: out },
  { name: 'composer', dest: path.join(out, 'composer') },
  { name: 'analyzer', dest: path.join(out, 'analyzer') },
];

for (const { name } of apps) {
  const src = path.join(repoRoot, 'apps', name, 'dist');
  if (!existsSync(src)) {
    console.error(`assemble-dist: missing ${path.relative(repoRoot, src)} — run \`pnpm -r build\` first`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
for (const { name, dest } of apps) {
  const src = path.join(repoRoot, 'apps', name, 'dist');
  cpSync(src, dest, { recursive: true });
  console.log(`assemble-dist: ${path.relative(repoRoot, src)} -> ${path.relative(repoRoot, dest) || '.'}`);
}
console.log(`assemble-dist: publish dir ready at ${path.relative(repoRoot, out)}/`);
