# HKL Composer Test Suite

A tiered, mostly-autonomous test suite for HKL Composer. Gates merges by
running invariant checks across ~45 fixtures in <15 seconds.

## Quick start

```bash
# In one terminal: dev server (required for the suite)
npm run dev

# In another terminal: run the gate
npm run test:composer       # full tier (~12 s; pre-merge gate)
npm run test:composer:fast  # fast tier (~8 s; inner loop)
```

Or call the runner directly:

```bash
node tools/composer-test/run.mjs fast
node tools/composer-test/run.mjs full
node tools/composer-test/run.mjs scenario <name>   # single fixture, debug
node tools/composer-test/run.mjs full --keep-open   # leave browser open at end
node tools/composer-test/run.mjs full --update-baselines  # accept new visuals
```

Output:
- Per-fixture pass/fail with failure details
- `tools/composer-test/out/summary.json` (machine-readable)
- `tools/composer-test/out/<name>.png` (screenshot on visual failure)

Exit code: 0 if all pass, 1 if any fail, 2 on infra failure.

## Tiers

| Tier      | Invariants                          | Wall time | When               |
|-----------|-------------------------------------|-----------|--------------------|
| fast      | MODEL + CURSOR + CONSOLE            | ~8 s      | Every iteration     |
| full      | fast + ROUNDTRIP + RENDER + INPUT + VISUAL | ~12 s | Pre-merge gate      |
| visual    | VISUAL only                         | ~5 s      | After intended visual changes |
| scenario  | All applicable invariants, single   | varies    | Debugging           |

## Invariants

Every test asserts one of seven invariants. Categorizing by invariant (not
by feature) keeps coverage wide and redundancy low.

- **MODEL** — direct model query (`model.getVoiceLength`, `flatChildren`,
  `getCurrentElement`, `isCursorAtPastEnd`, etc.) returns the expected
  value after a setup sequence.
- **CURSOR** — cursor-trace invariant: consecutive cursor positions must
  render at visually distinct rects (Manhattan distance > 3 px).
- **RENDER** — DOM/SVG shape: tuplet bracket present, accid glyph count,
  notehead-color isolation, placeholder visibility.
- **ROUNDTRIP** — `serialize() → replaceDocument() → serialize()` is
  bit-identical after normalizing placeholder xml:ids (which are
  regenerated on every load by `normalizePlaceholders`).
- **VISUAL** — pixel-level comparison against a baseline PNG. On first
  run or with `--update-baselines`, seeds the baseline.
- **INPUT** — real keystroke sequence (via CDP `Input.dispatchKeyEvent`)
  produces the same model state as the equivalent direct API call.
- **CONSOLE** — Verovio emits no error-level messages during the run.
  Always-on; failures show the offending text.

## Architecture

```
tools/composer-test/
  run.mjs                — entry point, parses argv, orchestrates
  fixtures.mjs           — every fixture + fixture-specific assertions
  baselines/             — VISUAL reference PNGs
  out/                   — runner artifacts (summary.json, *.png)
  lib/
    chromium.mjs         — headless Chromium launcher
    cdp.mjs              — minimal CDP client (open page, evalJSON, events)
    console-capture.mjs  — subscribe to console.error / Log.entryAdded
    runner-core.mjs      — INJECT_LIB string, RESET_SNIPPET, setup/trace exprs
    assertions.mjs       — in-page assertion library (string-injected)
    cursor-trace.mjs     — in-page cursor walk + violation detector
    keystroke.mjs        — Input.dispatchKeyEvent helpers
    bridge-mock.mjs      — opens a second BroadcastChannel, captures
                           Composer→HKL events, injects HKL→Composer events
    scroll-helpers.mjs   — wait for smooth-scroll to settle
    visual.mjs           — PNG capture + baseline comparison (byte-level
                           for now; replace with pixelmatch when needed)
```

## Adding a fixture

1. Pick the right group in `fixtures.mjs` (single-voice, ties, tuplets,
   sig-changes, ctrl-nav, multi-voice, kbd, bridge, scroll, visual) and
   add a `{ setup, setupKeys? }` entry. The setup snippet has `m`
   (model), `c` (cursor), `r` (reRender), `bridge` variables in scope.

2. Add fixture-specific assertions to `FIXTURE_ASSERTIONS[name]` if the
   universal invariants (placeholder, tie-orphan, cursor-trace, roundtrip,
   console) don't cover the behavior. Each entry is `{ name, expr }`
   where `expr` is a JS expression returning `{ ok: boolean, detail?: string }`.
   Use `window.__test.*` helpers (assertModelState, assertBracketRendered,
   etc.) when applicable.

3. For real-keystroke tests, add `setupKeys: [...]`. Entries are either
   single-character strings or objects: `{ key: 'ArrowRight', ctrl: true }`.

4. For visual regression coverage, add `visualBaseline: '<name>'`. On
   first run the runner seeds `baselines/<name>.png`; subsequent runs
   compare.

5. For fixtures where two cursor positions intentionally render at the
   same x (e.g. distinct nav stops with no glyph between them), add
   `expectedZeroDeltaPairs: [[from, to], ...]` to exempt the
   cursor-trace invariant.

6. Add the fixture to `FIXTURES` at the bottom of `fixtures.mjs` with
   the appropriate tier (`fast` or `full`).

## Growing the suite naturally

The suite is designed to grow alongside the codebase. The discipline is
simple but non-negotiable:

- **Every Composer bug fix lands with a fixture that fails on the broken
  version and passes on the fix.** Use the bug as the fixture's name
  (`m1TieDeleteMiddleFromSplit`, `kbd_ctrlNavBarJump`). The fixture is
  proof that the fix works AND a tripwire against the same bug returning.

- **Every new Composer feature adds fixtures for its happy path plus its
  rejection cases.** Tuplet creation got `m1Triplet*Empty/Partial/Full`
  PLUS `m1TripletInsideTriplet` (nesting rejected) and
  `m1TupletExceedsMeasure` (overflow rejected). Negative scenarios prove
  the validation surface, not just the success path.

- **Reach for existing assertions before writing new ones.** The
  universal invariants already cover placeholder consistency, tie
  orphans, cursor visibility, roundtrip equality, and console silence.
  `window.__test.*` covers most of the rest. Custom assertions are for
  bugs whose invariant doesn't generalize.

- **Wide coverage beats deep coverage.** One scenario per behavior
  surface is enough — let cursor-trace + roundtrip + console run
  automatically across all fixtures rather than writing dedicated checks
  per fixture. The grid (fixtures × invariants) is the actual coverage.

- **When in doubt, add a fixture.** The marginal cost is ~5 lines and
  ~100 ms of runtime. The marginal benefit is one more class of
  regression caught automatically. The break-even is comically low.

## State reset between fixtures

`RESET_SNIPPET` (in `lib/runner-core.mjs`) is the canonical pattern for
clearing state that lives OUTSIDE the model:

- `model.replaceDocument(empty.serialize())` — fresh MEI doc.
- `inputState.{mode, cursorMode, duration, pendingHairpin, pendingTuplet, exprCursor}` — input.ts module-private state machine.
- `__bridgeMock.sendHeldKeys([])` — clears `lastHeldKeys` in main.ts via
  Composer's bridge listener (the only writer to that field).
- `score.scrollLeft / scrollTop = 0` — score viewport position.
- `renderer.setViewMode('scroll')` — forces tight-fit SVG layout so
  visual clips are deterministic; page mode pads to paper size and
  produces mostly-empty screenshots.

**If you add new global / module-private state to Composer, extend
`RESET_SNIPPET` to clear it.** State leaks across fixtures produce
subtle, order-dependent test failures that are painful to diagnose
(see `docs/lessons.md` → "State machines outside the model leak").

## Debugging a failing scenario

```bash
node tools/composer-test/run.mjs scenario <name> --keep-open
```

This leaves Chromium running so you can attach DevTools. The page handle
`window.__hkl_composer` is exposed along with:

- `window.__test.*` — all assertion helpers (`assertModelState`,
  `assertNoTieOrphans`, `assertPlaceholderInvariant`,
  `assertCursorInViewport`, `runRoundTrip`, etc.).
- `window.__bridgeMock` — `sendHeldKeys(notes)`, `captured()`, `drain()`,
  `reset()`.
- `window.__cursorTrace(voice, exemptions)` — single-voice cursor walk
  with invariant check; returns `{ trace, violations }`.
- `window.__waitForScrollSettle(maxMs)` — async wait for `behavior:'smooth'`
  scrolling to stabilize.

For visual diffs: open `out/<name>.png` (current) and
`baselines/<name>.png` (expected) side-by-side. If the diff is
intentional, re-run with `--update-baselines` to accept.

## Self-tests

When changing the suite itself, verify with these deliberate regressions:

- **CURSOR**: Revert `cc2f76b` past-end-conditional and re-run — should
  fail `pastEndConditional_fullLast`.
- **ROUNDTRIP**: Break `setAttributeNS` for `xml:id` — should surface
  Verovio "Unable to match @tie" console errors.
- **INPUT**: Change a keybinding in `input.ts` — should fail
  `kbd_durationDigits` or `kbd_ctrlNavBarJump`.
- **TIE**: Restore the asymmetric `data-tie-partner` setting in
  `insertWithSplit` — should fail `m1TieDeleteMiddleFromSplit` or
  surface a Verovio "Expected @tie median or terminal" warning.
- **VISUAL**: Rename a baseline PNG — diff is written to `out/`.

## Debugging a failing scenario

```bash
node tools/composer-test/run.mjs scenario <name> --keep-open
```

This leaves Chromium running at `http://localhost:<random>` so you can
attach DevTools. The page handle `window.__hkl_composer` is exposed
along with `window.__test.*`, `window.__cursorTrace`, `window.__bridgeMock`.

For visual diffs: open `out/<name>.png` (current) and
`baselines/<name>.png` (expected) side-by-side. If the diff is
intentional, re-run with `--update-baselines`.

## Self-tests

When changing the suite itself, verify with these deliberate regressions:

- **CURSOR**: Revert `cc2f76b` past-end-conditional and re-run — should
  fail `pastEnd_fullLast`.
- **ROUNDTRIP**: Break `setAttributeNS` for `xml:id` — should surface
  Verovio "Unable to match @tie" console errors.
- **INPUT**: Change a keybinding in `input.ts` — should fail
  `kbd_durationDigits` or `kbd_ctrlNavBarJump`.
- **VISUAL**: Rename a baseline PNG — diff is written to `out/`.

## Known gaps (TODOs)

- **Pixelmatch**: `visual.mjs` currently uses byte-equality on the PNG
  blob. Replace with `pixelmatch` + `pngjs` for tolerance to sub-pixel
  anti-aliasing once those deps are added.
- **Expression-layer keystrokes** (dynamics, hairpins): scaffolded via
  `kbd_escClearsPending` but the actual dynamics insertion path needs
  more keystroke fixtures (`Shift+1`..`Shift+8` in voice mode).
- **MusicXML round-trip**: `exportMusicXmlSmoke` not yet implemented.
- **Bridge handshake on startup**: the mock attaches after page load,
  so it can't capture composer-hello/request-state from boot. Tested
  via an explicit `bridge.send()` in `bridgeComposerToHklCapture`.
- **Chromium leak on parent-shell kill**: `lib/chromium.mjs`'s `stop()`
  callback only fires from `main()`'s `finally`. When the runner is
  invoked as a backgrounded shell and the parent dies mid-task, Chromium
  + its `/tmp/hkl-composer-test-*` profile dir leak. Workaround: run
  probes in the foreground (don't pass `run_in_background: true` unless
  the task is genuinely long-lived), or periodically clean with
  `pkill -f "hkl-composer-test-" ; rm -rf /tmp/hkl-composer-test-*`.
  See `docs/lessons.md` → "Headless Chromium leaks on parent-shell kill"
  for a permanent fix sketch.
