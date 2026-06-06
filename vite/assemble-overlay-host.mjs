// Embed the lean overlay build into the overlay-host distributable.
//
// apps/overlay-host has no @hkl/* workspace dep (it only relays + serves files),
// so `pnpm -r build` won't order it after @hkl/hkl. Embedding therefore lives
// in this explicit step, not the app's (no-op) build. Run AFTER the lean build:
//
//   pnpm --filter @hkl/hkl build:overlay && pnpm assemble:overlay-host
//
// Result: apps/overlay-host/embedded/ holds the dist-overlay assets; run the
// distributable with `node apps/overlay-host/src/server.mjs`.

import { cpSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const src = path.join(repoRoot, 'apps/hkl/dist-overlay');
const dest = path.join(repoRoot, 'apps/overlay-host/embedded');

if (!existsSync(src)) {
  console.error(`assemble-overlay-host: missing ${path.relative(repoRoot, src)} — run \`pnpm --filter @hkl/hkl build:overlay\` first`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`assemble-overlay-host: ${path.relative(repoRoot, src)} -> ${path.relative(repoRoot, dest)}`);
