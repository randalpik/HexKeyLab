#!/usr/bin/env node
// HKL Composer test suite entry point.
//
// Usage:
//   node tools/composer-test/run.mjs <tier> [--keep-open]
//   node tools/composer-test/run.mjs scenario <name> [--keep-open]
//
// Tiers:
//   fast    — MODEL + CURSOR + CONSOLE on all fixtures (~10 s, every iter)
//   full    — fast + ROUNDTRIP + RENDER + INPUT (~90 s, pre-merge gate)
//   visual  — pixelmatch only (planned; not yet implemented)
//
// Requires: Vite dev server running (`npm run dev`) at
// COMPOSER_URL (default http://localhost:5173/composer.html).

import { launchChromium, newTabWsUrl } from './lib/chromium.mjs';
import { openPage } from './lib/cdp.mjs';
import { attachConsoleCapture } from './lib/console-capture.mjs';
import { INJECT_LIB, RESET_SNIPPET, setupExpr, cursorTraceExpr } from './lib/runner-core.mjs';
import { typeKeys, focusBody } from './lib/keystroke.mjs';
import { MOCK_BRIDGE_LIB } from './lib/bridge-mock.mjs';
import { visualCheck } from './lib/visual.mjs';
import { FIXTURES, FIXTURE_ASSERTIONS } from './fixtures.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const URL_DEFAULT = process.env.COMPOSER_URL ?? 'http://localhost:5173/composer.html';
const WAIT_MS = Number(process.env.WAIT_MS ?? 2500);

function parseArgs() {
  const args = process.argv.slice(2);
  let mode = 'fast';
  let scenarioName = null;
  let keepOpen = false;
  let updateBaselines = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--keep-open') keepOpen = true;
    else if (a === '--update-baselines') updateBaselines = true;
    else if (a === 'scenario') { mode = 'scenario'; scenarioName = args[++i]; }
    else if (['fast', 'full', 'visual'].includes(a)) mode = a;
    else if (!scenarioName && mode === 'scenario') scenarioName = a;
  }
  return { mode, scenarioName, keepOpen, updateBaselines };
}

function selectFixtures(mode, scenarioName) {
  if (mode === 'scenario') {
    if (!scenarioName || !FIXTURES[scenarioName]) {
      throw new Error('Unknown scenario: ' + scenarioName +
        '. Known: ' + Object.keys(FIXTURES).join(', '));
    }
    return [[scenarioName, FIXTURES[scenarioName]]];
  }
  const wanted = mode === 'full' ? ['fast', 'full'] : ['fast'];
  return Object.entries(FIXTURES).filter(([_, f]) => wanted.includes(f.tier));
}

async function runOne(cdp, name, fixture, console_cap, currentTier, opts = {}) {
  const result = { name, ok: true, failures: [], counts: { invariants: 0 } };

  /* Reset to blank doc — fast path, avoids page reload. */
  const reset = await cdp.evalJSON(RESET_SNIPPET);
  if (reset?.__error || reset !== true) {
    result.ok = false;
    result.failures.push({ kind: 'reset', detail: JSON.stringify(reset) });
    return result;
  }

  /* Drain pre-fixture console noise (Verovio load echoes, etc.). */
  console_cap.reset();

  /* Run fixture setup (JS snippet first, then keystrokes if any). */
  if (fixture.setup) {
    const setupRes = await cdp.evalJSON(setupExpr(fixture.setup));
    result.counts.invariants++;
    if (setupRes?.__error || !setupRes?.ok) {
      result.ok = false;
      result.failures.push({ kind: 'setup', detail: setupRes?.detail ?? JSON.stringify(setupRes) });
      return result;
    }
  }
  if (fixture.setupKeys) {
    await focusBody(cdp);
    try {
      await typeKeys(cdp, fixture.setupKeys);
      result.counts.invariants++;
    } catch (e) {
      result.ok = false;
      result.failures.push({ kind: 'setup-keys', detail: String(e?.message ?? e) });
      return result;
    }
  }

  /* Wait one RAF after re-render so SVG metrics settle before assertions. */
  await cdp.evalJSON(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);

  /* Run fixture-specific assertions. */
  const assertions = FIXTURE_ASSERTIONS[name] || [];
  for (const a of assertions) {
    result.counts.invariants++;
    const res = await cdp.evalJSON(a.expr);
    if (res?.__error) {
      result.ok = false;
      result.failures.push({ kind: 'assertion', name: a.name, detail: res.__error });
    } else if (!res?.ok) {
      result.ok = false;
      result.failures.push({ kind: 'assertion', name: a.name, detail: res?.detail ?? 'no detail' });
    }
  }

  /* Universal placeholder + tie invariants (always-on). */
  const universal = [
    { name: 'placeholder invariant', expr: `window.__test.assertPlaceholderInvariant()` },
    { name: 'no tie orphans',       expr: `window.__test.assertNoTieOrphans()` },
  ];
  if (currentTier === 'full') {
    universal.push({
      name: 'roundtrip serialize→load→serialize',
      expr: `(() => {
        const r = window.__test.runRoundTrip();
        if (r.ok) return { ok: true };
        /* Find first diverging line for a useful detail. */
        const a = r.before; const b = r.after;
        const al = a.split('\\n'); const bl = b.split('\\n');
        let i = 0;
        for (; i < Math.min(al.length, bl.length); i++) if (al[i] !== bl[i]) break;
        return { ok: false, detail: 'diverges at line ' + (i + 1) +
          ': before=' + JSON.stringify((al[i] || '').slice(0, 100)) +
          ' after=' + JSON.stringify((bl[i] || '').slice(0, 100)) };
      })()`,
    });
  }
  for (const u of universal) {
    result.counts.invariants++;
    const res = await cdp.evalJSON(u.expr);
    if (res?.__error) {
      result.ok = false;
      result.failures.push({ kind: 'universal', name: u.name, detail: res.__error });
    } else if (!res?.ok) {
      result.ok = false;
      result.failures.push({ kind: 'universal', name: u.name, detail: res?.detail ?? 'no detail' });
    }
  }

  /* Cursor-trace on V_1 (the dominant voice for fixtures). Fixtures can
   * declare `expectedZeroDeltaPairs: [[from, to], ...]` to exempt pairs
   * of cursor positions that intentionally render at the same x (e.g.,
   * the tuplet wrapper-entered position vs. the inside-first-child
   * position — see plan §Unexpected Behaviors §1). */
  result.counts.invariants++;
  const trace = await cdp.evalJSON(cursorTraceExpr(1, fixture.expectedZeroDeltaPairs ?? []));
  if (trace?.__error) {
    result.ok = false;
    result.failures.push({ kind: 'cursor-trace', detail: trace.__error });
  } else if (trace.violations?.length) {
    result.ok = false;
    result.failures.push({
      kind: 'cursor-trace',
      detail: trace.violations.length + ' violation(s): ' +
        trace.violations.slice(0, 2).map((v) =>
          v.from + '→' + v.to + ' Δ=' + (v.delta?.dx ?? 0) + ',' + (v.delta?.dy ?? 0)
        ).join('; '),
    });
  }

  /* VISUAL invariant: only on `visual` tier or when fixture declares
   * visualBaseline. Captures a screenshot via CDP and compares to the
   * stored baseline PNG. */
  if (fixture.visualBaseline && (currentTier === 'visual' || currentTier === 'full')) {
    result.counts.invariants++;
    try {
      const v = await visualCheck(cdp, fixture.visualBaseline, { updateBaselines: opts.updateBaselines });
      if (!v.ok) {
        result.ok = false;
        result.failures.push({ kind: 'visual', detail: v.detail });
      }
    } catch (e) {
      result.ok = false;
      result.failures.push({ kind: 'visual', detail: String(e?.message ?? e) });
    }
  }

  /* CONSOLE invariant: drain whatever was captured during this fixture. */
  result.counts.invariants++;
  const consoleErrs = console_cap.drain();
  if (consoleErrs.length) {
    result.ok = false;
    result.failures.push({
      kind: 'console',
      detail: consoleErrs.length + ' error(s): ' +
        consoleErrs.slice(0, 2).map((e) => '[' + e.source + '] ' + e.text.slice(0, 80)).join('; '),
    });
  }

  return result;
}

function fmtResult(r) {
  const status = r.ok ? '✓' : '✗';
  const head = `  ${status} ${r.name}  (${r.counts.invariants} checks)`;
  if (r.ok) return head;
  const fails = r.failures.map((f) => `      [${f.kind}${f.name ? ' / ' + f.name : ''}] ${f.detail}`).join('\n');
  return head + '\n' + fails;
}

async function main() {
  const { mode, scenarioName, keepOpen, updateBaselines } = parseArgs();
  const fixtures = selectFixtures(mode, scenarioName);
  const outDir = join(__dirname, 'out');
  mkdirSync(outDir, { recursive: true });

  console.log(`composer-test: tier=${mode}, ${fixtures.length} fixtures, url=${URL_DEFAULT}`);

  const browser = await launchChromium();
  let exitCode = 0;
  try {
    const wsUrl = await newTabWsUrl(browser.port);
    const cdp = await openPage(wsUrl, URL_DEFAULT, { waitMs: WAIT_MS });
    const console_cap = attachConsoleCapture(cdp);

    /* Inject assertion library + cursor-trace fn once. */
    const injected = await cdp.evalJSON(INJECT_LIB);
    if (injected?.__error) throw new Error('injection failed: ' + injected.__error);

    /* Inject bridge mock — opens a second BroadcastChannel and exposes
     * window.__bridgeMock for held-keys/playback simulation. */
    const bridgeReady = await cdp.evalJSON(MOCK_BRIDGE_LIB);
    if (bridgeReady?.__error) throw new Error('bridge mock injection failed: ' + bridgeReady.__error);

    const startedAt = Date.now();
    const results = [];
    for (const [name, fixture] of fixtures) {
      const r = await runOne(cdp, name, fixture, console_cap, mode, { updateBaselines });
      results.push(r);
      console.log(fmtResult(r));
    }
    const elapsedMs = Date.now() - startedAt;
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n${passed}/${results.length} passed  (${elapsedMs} ms)`);
    if (failed > 0) {
      exitCode = 1;
      console.log(`${failed} failed`);
    }

    /* Write a machine-readable summary. */
    writeFileSync(join(outDir, 'summary.json'),
      JSON.stringify({ mode, fixtures: results.length, passed, failed, elapsedMs, results }, null, 2));

    if (keepOpen) {
      console.log('\n--keep-open: browser left running on port ' + browser.port + '; press Ctrl-C to exit.');
      await new Promise(() => {});
    }
    cdp.close();
  } finally {
    if (!keepOpen) browser.stop();
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('runner failed:', e?.stack ?? e);
  process.exit(2);
});
