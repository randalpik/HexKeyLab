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
// COMPOSER_URL (default http://localhost:5170/composer/).

import { launchChromium, newTabWsUrl } from './lib/chromium.mjs';
import { openPage } from './lib/cdp.mjs';
import { attachConsoleCapture } from './lib/console-capture.mjs';
import { INJECT_LIB, RESET_SNIPPET, setupExpr, cursorTraceExpr } from './lib/runner-core.mjs';
import { typeKeys, focusBody } from './lib/keystroke.mjs';
import { MOCK_BRIDGE_LIB } from './lib/bridge-mock.mjs';
import { visualCheck } from './lib/visual.mjs';
import { FIXTURES, FIXTURE_ASSERTIONS } from './fixtures.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const URL_DEFAULT = process.env.COMPOSER_URL ?? 'http://localhost:5170/composer/';
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
  const result = { name, ok: true, failures: [], counts: { invariants: 0 }, ms: { setup: 0, invariants: 0, total: 0 } };
  const tStart = Date.now();

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
    const tSetup = Date.now();
    const setupRes = await cdp.evalJSON(setupExpr(fixture.setup));
    result.ms.setup = Date.now() - tSetup;
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

  /* The document BUILD necessarily derives (there is no partition yet), so the
     splice ledger starts here: everything after this point is the fixture's own
     edits, and a full render among them is a latency defect unless the fixture
     says otherwise (2026-09-02, Max: "assert splicing for every fixture that
     isn't explicitly full-document"). */
  await cdp.evalJSON(`(() => { const r = window.__hkl_composer && window.__hkl_composer.renderer; if (r && r.clearRenderLedger) r.clearRenderLedger(); return true; })()`);

  const tInv = Date.now();

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
   * position — see plan §Unexpected Behaviors §1). Fixtures whose concern is
   * orthogonal to cursor geometry may declare `skipCursorTrace: true` — the
   * walk scrolls every stop into view, which on a deliberately multi-page
   * document costs minutes (240 stops ≈ 130 s) for coverage every other
   * fixture already provides. */
  if (!fixture.skipCursorTrace) {
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
  }

  /* VISUAL invariant: only on `visual` tier or when fixture declares
   * visualBaseline. Captures a screenshot via CDP and compares to the
   * stored baseline PNG. */
  if (fixture.visualBaseline && (currentTier === 'visual' || currentTier === 'full' || currentTier === 'scenario')) {
    result.counts.invariants++;
    try {
      const v = await visualCheck(cdp, fixture.visualBaseline, { updateBaselines: opts.updateBaselines, fullPage: fixture.visualFullPage === true });
      if (v.meta) result.visualMeta = v.meta;   // capture geometry + renderer state → summary.json
      if (!v.ok) {
        result.ok = false;
        result.failures.push({ kind: 'visual', detail: v.detail });
      }
    } catch (e) {
      result.ok = false;
      result.failures.push({ kind: 'visual', detail: String(e?.message ?? e) });
    }
  }

  /* A non-visual failure has no baseline pair to look at, and the pair that
     answers the DEFECT question is not baseline-vs-output anyway: it is the
     live (spliced) page against a full re-engrave of the same document, in the
     same container, at the same scroll, through the same capture path. Shoot
     both here, into a scratch dir — never into out/, which is tracked — so the
     heatmap can be made without reproducing the ordering by hand. */
  if (!result.ok && result.failures.some((f) => f.kind !== 'visual')) {
    try {
      const dir = process.env.HKL_FAIL_SHOTS || join(tmpdir(), 'hkl-composer-fail');
      mkdirSync(dir, { recursive: true });
      const live = join(dir, name + "-live.png");
      const reeng = join(dir, name + "-reengrave.png");
      const shotOpts = { fullPage: fixture.visualFullPage === true };
      await visualCheck(cdp, name, { ...shotOpts, captureOnly: live });
      await cdp.evalJSON(`(() => { const H = window.__hkl_composer; H.renderer['forceFullRerender'](); H.reRender(); return true; })()`);
      await cdp.evalJSON(`new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 250))`);
      await visualCheck(cdp, name, { ...shotOpts, captureOnly: reeng });
      result.failShots = { live, reengrave: reeng };
    } catch (e) {
      result.failShots = { error: String(e?.message ?? e) };
    }
  }

  /* CONSOLE invariant: drain whatever was captured during this fixture.
     A fixture may declare `allowConsole: [/re/, ...]` for messages it PROVOKES
     ON PURPOSE. Kept per-fixture rather than added to console-capture.mjs's
     global DEFAULT_ALLOW so the message stays fatal everywhere else — e.g. a
     scroll-splice refusal is a latency defect wherever it is not the explicit
     subject of the test (Max, 2026-09-13: "a refusal is a failure"). */
  result.counts.invariants++;
  const allowHere = fixture.allowConsole ?? [];
  const consoleErrs = console_cap.drain()
    .filter((e) => !allowHere.some((re) => new RegExp(re).test(e.text)));
  if (consoleErrs.length) {
    result.ok = false;
    result.failures.push({
      kind: 'console',
      detail: consoleErrs.length + ' error(s): ' +
        consoleErrs.slice(0, 2).map((e) => '[' + e.source + '] ' + e.text.slice(0, 80)).join('; '),
    });
  }

  /* SPLICE invariant (2026-09-02, Max: "assert splicing for every fixture that
     isn't explicitly full-document"). A full engrave among the fixture's OWN
     renders is a latency defect: the refill is command-agnostic, so any user
     command should splice. Two exemptions, both explicit:
       - `single-line partition`, the refill's documented bail for a document
         with one system. Most fixtures are that small, page ownership does not
         apply to them, and it is not a defect.
       - a fixture that declares `fullRender: '<reason>'` because deriving is
         the thing it asserts, or because it exercises a known gap.
     Anything else fails, which is how a command that quietly starts deriving
     gets caught — Ctrl+M's 2.8 s derive lived for weeks because nothing here
     looked. */
  const BY_DESIGN = new Set(['single-line partition']);
  const ledger = await cdp.evalJSON(`(() => { const r = window.__hkl_composer && window.__hkl_composer.renderer; return (r && r.renderLedger) ? r.renderLedger() : []; })()`);
  if (Array.isArray(ledger)) {
    const fulls = ledger.filter((e) => e && e.full);
    result.renders = { total: ledger.length, full: fulls.length };
    if (fulls.length) {
      result.fullRenderReasons = [...new Set(fulls.map((e) => e.deriveReason || e.skipReason || '(unattributed)'))];
      const unexplained = result.fullRenderReasons.filter((why) => !BY_DESIGN.has(why));
      if (unexplained.length && !fixture.fullRender) {
        result.counts.invariants++;
        result.ok = false;
        result.failures.push({
          kind: 'splice',
          name: 'edits splice (no full engrave)',
          detail: fulls.length + ' full render(s) during the fixture\'s own edits: ' +
            unexplained.join('; ') + ' — if deriving is correct here, declare fullRender: \'<why>\'',
        });
      }
    }
  }

  result.ms.invariants = Date.now() - tInv;
  result.ms.total = Date.now() - tStart;
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

    /* Opt-in (HKL_INDEX_CHECK=1): verify every freshly-built VoiceIndex against
     * the original per-query computations across the whole suite. Catches a
     * missed cache invalidation in the model's navigation index (Phase A). */
    if (process.env.HKL_INDEX_CHECK) {
      await cdp.evalJSON(`(window.__HKL_INDEX_CHECK = true)`);
    }

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
    /* Where the wall went (2026-09-02). The suite's cost is concentrated in a
       few fixtures whose SETUP builds a multi-page score one chord at a time;
       print the worst so a slow suite is diagnosable without a bisect. */
    /* Which fixtures full-rendered during their own edits, and why — the
       triage list for the splice invariant. */
    const derived = results.filter((r) => r.renders && r.renders.full > 0);
    const clean = results.filter((r) => r.renders && r.renders.full === 0 && r.renders.total > 0);
    console.log(`  splice ledger: ${clean.length} fixtures rendered with no full engrave, ${derived.length} with one`);
    if (derived.length) {
      const byReason = new Map();
      for (const r of derived) {
        for (const why of (r.fullRenderReasons ?? ['(unattributed)'])) {
          if (!byReason.has(why)) byReason.set(why, []);
          byReason.get(why).push(r.name);
        }
      }
      for (const [why, names] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`    ${String(names.length).padStart(3)}x  ${why}`);
        console.log(`         ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', ...' : ''}`);
      }
    }
    const timed = results.filter((r) => r.ms && r.ms.total > 0).sort((a, b) => b.ms.total - a.ms.total);
    if (timed.length) {
      const sum = (f) => timed.reduce((n, r) => n + f(r), 0);
      console.log(`  setup ${Math.round(sum((r) => r.ms.setup) / 1000)}s of ${Math.round(sum((r) => r.ms.total) / 1000)}s measured; slowest:`);
      for (const r of timed.slice(0, 8)) {
        console.log(`    ${String(r.ms.total).padStart(6)}ms  setup ${String(r.ms.setup).padStart(6)}ms  ${r.name}`);
      }
    }
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
