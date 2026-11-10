// Third-party notices for the published site.
//
// The app bundles contain code from npm packages whose licenses (MIT and
// similar) require their copyright and permission notices to travel with every
// copy. Minified bundles drop those comments, so assemble-dist.mjs writes one
// THIRD-PARTY-NOTICES.txt at the site root from this module.
//
// The list is the runtime dependency closure of the given projects: every
// package under `dependencies`, followed through workspace (@hkl/*) packages
// and through each package's own `dependencies`. That can name a package the
// bundler tree-shook away; a notice too many is harmless, one too few is not.
// devDependencies are build tools and never reach a bundle.

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

const RULE = '='.repeat(78);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Where dependency `name` resolves from `fromDir`: the nearest node_modules up
 *  the tree, as Node looks it up (pnpm keeps a package's dependencies beside it). */
function findPackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dir === path.dirname(dir)) return null;
  }
}

function declaredLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type).filter(Boolean).join(' OR ');
  return '';
}

function licenseText(dir) {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)([.-]|$)/i.test(f));
  return file ? readFileSync(path.join(dir, file), 'utf8').trim() : null;
}

/** Every third-party package in the runtime dependency closure of `projectDirs`,
 *  sorted by name: `{ name, version, license, url, text }` (`text` null when the
 *  package ships no license file). */
export function collectThirdParty(projectDirs) {
  const found = new Map();
  const seen = new Set();
  const visit = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const pkg = readJson(path.join(dir, 'package.json'));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const depDir = findPackageDir(name, dir);
      if (!depDir) throw new Error(`third-party-notices: cannot resolve "${name}" from ${dir}`);
      if (!name.startsWith('@hkl/')) {
        const dep = readJson(path.join(depDir, 'package.json'));
        const repo = typeof dep.repository === 'string' ? dep.repository : dep.repository?.url;
        found.set(`${dep.name}@${dep.version}`, {
          name: dep.name, version: dep.version, license: declaredLicense(dep),
          url: dep.homepage ?? repo ?? '', text: licenseText(depDir),
        });
      }
      visit(depDir);
    }
  };
  for (const dir of projectDirs) visit(realpathSync(dir));
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The notices file for `projectDirs`: `{ text, packages }`. */
export function thirdPartyNotices(projectDirs) {
  const packages = collectThirdParty(projectDirs);
  const sections = packages.map((p) => [
    RULE,
    `${p.name} ${p.version}${p.license ? ` (${p.license})` : ''}`,
    ...(p.url ? [p.url] : []),
    RULE,
    '',
    p.text ?? `This package ships no license file. Its package.json declares: ${p.license || 'no license'}.`,
    '',
  ].join('\n'));
  const text = [
    'THIRD-PARTY NOTICES',
    '',
    "HexKeyLab's web apps include code from the npm packages below. Each is listed",
    'with its version, its declared license and the license text it ships with.',
    '',
    ...sections,
  ].join('\n');
  return { text, packages };
}
