#!/usr/bin/env node
// Monorepo dependency-boundary checker (dependency-free; `pnpm check:boundaries`).
//
// Enforces the documented DAG (@hkl/shared ← {engine, notation, bridge} ← apps)
// without TS project references or composite emit. Two rules per workspace
// project under packages/* and apps/*:
//
//   1. Every bare `@hkl/<pkg>` import must be a declared dependency in the
//      project's package.json. (So @hkl/shared may import no @hkl/* at all;
//      composer may not import @hkl/engine; an app may not import a sibling
//      app; etc. — the allow-list IS the package.json dep list.)
//   2. Relative imports may not escape the project's own directory (that would
//      be a cross-package reach that should go through a bare @hkl/* specifier).
//
// Documented exception: apps/analyzer may relatively import the repo-root
// analyzer/*.js CLI engine modules (browser-runnable, not a workspace package).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_GLOBS = ['packages', 'apps'];
const SRC_EXT = /\.(ts|mjs|js)$/;
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|(?:^|\s)import\s+['"]([^'"]+)['"]/gm;

/** Allowed relative escapes, keyed by project dir (relative to repoRoot). */
const RELATIVE_ESCAPE_ALLOW = {
  'apps/analyzer': [path.join(repoRoot, 'analyzer')], // root CLI engine modules
};

function listProjects() {
  const out = [];
  for (const g of PROJECT_GLOBS) {
    const base = path.join(repoRoot, g);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) out.push({ dir, rel: `${g}/${name}`, pkg: JSON.parse(fs.readFileSync(pkgPath, 'utf8')) });
    }
  }
  return out;
}

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (SRC_EXT.test(e.name)) acc.push(p);
  }
  return acc;
}

function specifiersOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const specs = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) specs.push(m[1] || m[2] || m[3]);
  return specs.filter(Boolean);
}

const violations = [];
for (const proj of listProjects()) {
  const declared = new Set(Object.keys(proj.pkg.dependencies || {}).filter((d) => d.startsWith('@hkl/')));
  const allowedEscapes = RELATIVE_ESCAPE_ALLOW[proj.rel] || [];
  for (const file of walk(proj.dir, [])) {
    for (const spec of specifiersOf(file)) {
      const bare = spec.split('?')[0]; // drop ?worker etc.
      if (bare.startsWith('@hkl/')) {
        const pkgName = bare.split('/').slice(0, 2).join('/');
        if (!declared.has(pkgName)) {
          violations.push(`${path.relative(repoRoot, file)}\n    imports ${pkgName} — not a declared dependency of ${proj.pkg.name} (add to package.json or remove the import)`);
        }
      } else if (bare.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), bare);
        if (!resolved.startsWith(proj.dir + path.sep) && resolved !== proj.dir) {
          const allowed = allowedEscapes.some((a) => resolved.startsWith(a + path.sep) || resolved === a);
          if (!allowed) {
            violations.push(`${path.relative(repoRoot, file)}\n    relative import "${spec}" escapes ${proj.rel} → ${path.relative(repoRoot, resolved)} (use a bare @hkl/* specifier instead)`);
          }
        }
      }
    }
  }
}

if (violations.length) {
  console.error(`\n✗ ${violations.length} boundary violation(s):\n`);
  for (const v of violations) console.error('  ' + v + '\n');
  process.exit(1);
}
console.log('✓ boundaries OK — every package imports only its declared @hkl/* deps; no cross-package relative reaches.');
