// Assemble the per-app Vite builds into one publish directory for static
// hosting (Netlify). The umbrella `pnpm dev` reverse-proxies the three app dev
// servers under one origin; production has no proxy, so we lay the apps out as
// real sub-paths that match each app's Vite `base`:
//
//   dist/            <- apps/hkl/dist/*          (base '/')
//   dist/composer/   <- apps/composer/dist/*     (base '/composer/')
//   dist/analyzer/   <- apps/analyzer/dist/*     (base '/analyzer/')
//   dist/orchestrator/ <- apps/orchestrator/dist/* (base '/orchestrator/')
//   dist/guide/      <- apps/guide/dist/*        (base '/guide/')
//
// Asset URLs are already base-prefixed by each app's build, so this is a pure
// copy — no path rewriting. Same origin is preserved, which the HKL<->Composer
// BroadcastChannel bridge and the per-origin IndexedDB registry require.
//
// It also writes dist/THIRD-PARTY-NOTICES.txt: the license notices of every
// npm package the apps bundle (third-party-notices.mjs).
//
// When UMAMI_WEBSITE_ID is set (netlify.toml sets it for the deploy), it adds
// the usage-analytics tag to each app's index.html (analytics-tag.mjs). A local
// assemble without it produces a publish directory with no analytics.
import { cpSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { thirdPartyNotices } from './third-party-notices.mjs';
import { injectAnalytics } from './analytics-tag.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const out = path.join(repoRoot, 'dist');

const apps = [
  { name: 'hkl', dest: out },
  { name: 'composer', dest: path.join(out, 'composer') },
  { name: 'analyzer', dest: path.join(out, 'analyzer') },
  { name: 'orchestrator', dest: path.join(out, 'orchestrator') },
  { name: 'guide', dest: path.join(out, 'guide') },
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
const websiteId = process.env.UMAMI_WEBSITE_ID;
if (websiteId) {
  for (const { dest } of apps) {
    const file = path.join(dest, 'index.html');
    writeFileSync(file, injectAnalytics(readFileSync(file, 'utf8'), websiteId));
  }
  console.log(`assemble-dist: analytics tag added to ${apps.length} index.html files`);
} else {
  console.log('assemble-dist: UMAMI_WEBSITE_ID not set — no analytics tag');
}
const notices = thirdPartyNotices(apps.map(({ name }) => path.join(repoRoot, 'apps', name)));
writeFileSync(path.join(out, 'THIRD-PARTY-NOTICES.txt'), notices.text);
console.log(`assemble-dist: THIRD-PARTY-NOTICES.txt (${notices.packages.length} packages)`);
console.log(`assemble-dist: publish dir ready at ${path.relative(repoRoot, out)}/`);
