#!/usr/bin/env node
// Drive the inspector through every canonical scenario, dumping per-scenario
// trace JSON + screenshot to an output directory. Reports invariant
// violations across all scenarios.
//
// Usage:
//   node tools/composer-inspect/cursor-trace-all.mjs [outDir]
//
// Default outDir: /tmp/cursor-trace-<timestamp>/

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';
import { CURSOR_TRACE_FN } from './cursor-trace.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const inspector = join(here, 'inspect.mjs');

const outDir = process.argv[2] ?? `/tmp/cursor-trace-${Date.now()}`;
mkdirSync(outDir, { recursive: true });

const summary = {};
let totalViolations = 0;

for (const [name, setup] of Object.entries(SCENARIOS)) {
  const tracePng = join(outDir, `${name}.png`);
  const expr = `(async () => {
    const m = window.__hkl_composer.model;
    ${setup}
    const trace = await (${CURSOR_TRACE_FN})(1);
    return trace;
  })()`;
  const r = spawnSync('node', [inspector, '--screenshot', tracePng, expr], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    console.error(`[${name}] inspector failed: ${r.stderr}`);
    continue;
  }
  let traceJson;
  try { traceJson = JSON.parse(r.stdout); } catch (e) {
    console.error(`[${name}] couldn't parse trace JSON: ${e.message}`);
    console.error(r.stdout.slice(0, 500));
    continue;
  }
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(traceJson, null, 2));
  summary[name] = {
    voiceLen: traceJson.voiceLen,
    flatLen: traceJson.flatLen,
    violations: traceJson.violations?.length ?? 0,
  };
  totalViolations += traceJson.violations?.length ?? 0;
  console.log(`[${name}] voiceLen=${traceJson.voiceLen} flat=${traceJson.flatLen} violations=${traceJson.violations?.length ?? 0}`);
}

writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\nTotal violations across all scenarios: ${totalViolations}`);
console.log(`Output: ${outDir}`);
process.exit(totalViolations > 0 ? 1 : 0);
