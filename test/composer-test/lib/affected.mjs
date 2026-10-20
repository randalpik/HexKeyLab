// `run.mjs affected`: pick the fixtures a working-tree change can affect.
//
// Source side: every module in out/coverage-map.json carries a snapshot of the
// source that was measured. Each changed module is diffed against its snapshot
// and the touched OLD-side lines (a pure insertion touches the lines on both
// sides of it) select:
//   - inside a function: every fixture that executed one of those lines;
//   - at module scope, on a line that compiles to code: every fixture that
//     executed anything in the module (top-level code runs once at load, so it
//     is never attributed to a fixture, but everything reading it depends on it);
//   - type-only / comment lines (no generated code): nothing.
// Changed lines that compile to code no fixture executes are reported — the
// change is untested, which usually means a fixture is missing.
//
// Test side: a fixture whose spec or assertions differ from HEAD is selected.
// A changed runner/lib file, or a changed source file the map does not know
// (new module, CSS, HTML), is reported but selects nothing — run --group or
// the full tier for those.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64ToBitset, hasBit } from './coverage.mjs';

const REPO = new URL('../../../', import.meta.url).pathname;
const ts = createRequire(import.meta.url)('typescript');

/** [startLine, endLine] of every function-like body in a TypeScript source.
 *  Parsed from the snapshot rather than taken from V8, which reports only the
 *  functions it has compiled so far. Lines outside all of them are module
 *  scope (including class field initializers — conservative). */
function functionRanges(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const out = [];
  const walk = (n) => {
    if (ts.isFunctionLike(n) && n.body || ts.isClassStaticBlockDeclaration(n)) out.push([line(n.getStart(sf)), line(n.getEnd())]);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}
const git = (...args) => execFileSync('git', args, { cwd: REPO, maxBuffer: 64 << 20 }).toString();

/** Touched old-side line numbers between two texts (git's line diff). */
function touchedLines(oldText, newText) {
  const dir = mkdtempSync(join(tmpdir(), 'hkl-affected-'));
  try {
    writeFileSync(join(dir, 'a'), oldText);
    writeFileSync(join(dir, 'b'), newText);
    const r = spawnSync('git', ['diff', '--no-index', '--unified=0', join(dir, 'a'), join(dir, 'b')], { maxBuffer: 64 << 20 });
    const out = r.stdout.toString();
    const lines = new Set();
    for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
      const a = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]);
      if (n === 0) { lines.add(a); lines.add(a + 1); }
      else for (let l = a; l < a + n; l++) lines.add(l);
    }
    return lines;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Compact "12-15,40" form of a set of line numbers. */
function spans(set) {
  const xs = [...set].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(i === j ? String(xs[i]) : xs[i] + '-' + xs[j]);
    i = j;
  }
  return out.join(',');
}

/** Fixture names whose spec or assertions differ from HEAD's (null if HEAD has
 *  no fixtures/ index to compare against). */
async function changedFixtureSpecs(fixtures, assertions) {
  const rel = 'test/composer-test/fixtures';
  let listing;
  try { listing = git('ls-tree', '--name-only', 'HEAD', rel + '/').split('\n').filter(Boolean); } catch { return null; }
  if (!listing.includes(rel + '/index.mjs')) return null;
  const dir = mkdtempSync(join(tmpdir(), 'hkl-fixtures-head-'));
  try {
    mkdirSync(join(dir, 'fixtures'));
    for (const f of listing) writeFileSync(join(dir, 'fixtures', f.slice(rel.length + 1)), git('show', 'HEAD:' + f));
    writeFileSync(join(dir, 'fast-tier.json'), git('show', 'HEAD:test/composer-test/fast-tier.json'));
    const head = await import(join(dir, 'fixtures', 'index.mjs'));
    const ser = (v) => JSON.stringify(v, (k, x) => x instanceof RegExp ? String(x) : x);
    const strip = ({ tier, category, ...rest }) => rest;
    return Object.keys(fixtures).filter((n) => !head.FIXTURES[n]
      || ser(strip(head.FIXTURES[n])) !== ser(strip(fixtures[n]))
      || ser(head.FIXTURE_ASSERTIONS[n]) !== ser(assertions[n]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function affectedSelection(mapPath, fixtures, assertions) {
  const report = [];
  const selected = new Map();   // name → reasons[]
  const pick = (name, why) => { if (!fixtures[name]) return; if (!selected.has(name)) selected.set(name, []); selected.get(name).push(why); };

  if (!existsSync(mapPath)) {
    report.push(`no coverage map at ${mapPath} — run \`node test/composer-test/run.mjs full --coverage\` once; selecting test-side changes only`);
  }
  const map = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')) : { files: {}, fixtures: {} };
  if (map.generated) report.push(`coverage map: ${map.generated.slice(0, 16).replace('T', ' ')} @ ${String(map.commit).slice(0, 8)}, ${Object.keys(map.fixtures).length} fixtures`);
  const fixtureBits = Object.entries(map.fixtures).map(([name, f]) => [name, Object.fromEntries(Object.entries(f.files).map(([p, b]) => [p, b64ToBitset(b)]))]);

  /* Source changes against the measured snapshots. */
  for (const [path, info] of Object.entries(map.files)) {
    const abs = join(REPO, path);
    const now = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    if (now === info.content) continue;
    const touched = touchedLines(info.content, now);
    const mapped = b64ToBitset(info.mapped);
    const fns = functionRanges(path, info.content);
    const inFn = (l) => fns.some(([a, b]) => l >= a && l <= b);
    const code = [...touched].filter((l) => hasBit(mapped, l));
    const moduleScope = code.filter((l) => !inFn(l));
    const before = selected.size;
    const hit = new Set();
    for (const [name, files] of fixtureBits) {
      const bits = files[path];
      if (!bits) continue;
      if (moduleScope.length) { pick(name, path + ' (module scope)'); continue; }
      for (const l of code) if (hasBit(bits, l)) { pick(name, path + ':' + l); hit.add(l); }
    }
    const untested = moduleScope.length ? [] : code.filter((l) => !hit.has(l));
    report.push(`${path}: ${touched.size} touched line(s), ${code.length} compile to code` +
      (moduleScope.length ? `, ${moduleScope.length} at module scope (${spans(new Set(moduleScope))})` : '') +
      ` → +${selected.size - before} fixture(s)`);
    if (untested.length) report.push(`  UNTESTED: no fixture executes ${path}:${spans(new Set(untested))}`);
  }

  /* Changed files the map cannot speak for. */
  let changed = [];
  try {
    const base = map.commit ?? 'HEAD';
    changed = [...git('diff', '--name-only', base).split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean);
  } catch {}
  const srcRe = /^(apps\/composer\/(src\/|index\.html)|packages\/(notation|shared|bridge)\/src\/)/;
  const unmapped = [...new Set(changed.filter((p) => srcRe.test(p) && !map.files[p]))];
  if (unmapped.length) report.push(`not in the coverage map (new, unloaded, or non-JS — choose --group or full): ${unmapped.join(', ')}`);
  const runner = [...new Set(changed.filter((p) => /^test\/composer-test\/(lib\/|run\.mjs)/.test(p)))];
  if (runner.length) report.push(`runner changed (affects every fixture — consider the full tier): ${runner.join(', ')}`);

  /* Test-side changes. */
  const specChanged = await changedFixtureSpecs(fixtures, assertions);
  if (specChanged === null) report.push('HEAD has no fixtures/index.mjs — fixture spec changes not detected');
  else {
    for (const n of specChanged) pick(n, 'fixture changed');
    if (specChanged.length) report.push(`fixtures new/changed vs HEAD: ${specChanged.length}`);
  }
  return { selected, report };
}
