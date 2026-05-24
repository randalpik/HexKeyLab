// Per-scenario orchestration. Resets the page to a fresh composer document,
// runs the fixture's setup snippet, then runs each requested invariant
// against the resulting state. Returns a structured result for the runner
// to aggregate.

import { CURSOR_TRACE_FN } from './cursor-trace.mjs';
import { ASSERTION_LIB } from './assertions.mjs';
import { SCROLL_SETTLE } from './scroll-helpers.mjs';

/** Reset Composer to a blank document. Replaces the document with a
 *  fresh empty MEI seed (faster than reloading), then walks through the
 *  ambient state machines that aren't owned by the model:
 *    - input.ts's mode / cursorMode / pending hairpin / pending tuplet
 *    - main.ts's lastHeldKeys (cleared via a held-keys: [] bridge event)
 *    - the score's scroll position (#score scrollLeft/scrollTop)
 *  Without these resets, state leaks across fixtures: a prior fixture
 *  pressing the Insert key leaves `mode='overwrite'` set for the next,
 *  and a prior bridge held-keys event leaves notes "held" indefinitely. */
export const RESET_SNIPPET = `
(() => {
  /* Fresh model. */
  const old = window.__hkl_composer.model;
  const cls = old.constructor;
  const fresh = new cls();
  old.replaceDocument(fresh.serialize());
  old.setVoice(1);
  old.setCursor(0);

  /* Reset input state (the input.ts module-private \`state\` object is
   * the same reference returned by inputState() — runtime-mutable). */
  const inp = window.__hkl_composer.inputState();
  inp.mode = 'insert';
  inp.cursorMode = 'voice';
  inp.duration = '4';
  inp.pendingHairpin = null;
  inp.pendingTuplet = null;
  inp.exprCursor = { index: 0, moments: [] };
  inp.chordInternalSel = null;
  inp.selection = null;

  /* Clear undo/redo history between fixtures so cross-fixture state doesn't
   * survive Ctrl+Z and pollute later assertions. */
  if (window.__hkl_composer.history) window.__hkl_composer.history.clear();

  /* Clear held keys via a bridge broadcast — main.ts's bridge.on
   * handler is the only writer to lastHeldKeys. The test-side mock
   * channel is a different BroadcastChannel instance, so its sends
   * reach Composer's listener like real HKL traffic. */
  if (window.__bridgeMock) window.__bridgeMock.sendHeldKeys([]);

  /* Reset score scroll. */
  const score = document.getElementById('score');
  if (score) { score.scrollLeft = 0; score.scrollTop = 0; }

  window.__hkl_composer.reRender();
  return true;
})()
`;

/** Inject the assertion library and the cursor-trace fn under fixed names.
 *  NB: parenthesize the embedded expressions to defeat ASI — a newline
 *  between `return` and a `(` would be parsed as `return;` followed by an
 *  unreachable expression statement. */
export const INJECT_LIB = `
(() => {
  window.__cursorTrace = (${CURSOR_TRACE_FN});
  window.__waitForScrollSettle = (${SCROLL_SETTLE});
  return (${ASSERTION_LIB});
})()
`;

/** Build an in-page expression that runs the fixture setup AND returns
 *  setup success/failure as JSON. */
export function setupExpr(setupSnippet) {
  return `(() => {
    try {
      const m = window.__hkl_composer.model;
      const c = window.__hkl_composer.cursor;
      const r = window.__hkl_composer.reRender;
      const bridge = window.__hkl_composer.bridge;
      ${setupSnippet}
      window.__hkl_composer.reRender();
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: String(e && e.stack || e) };
    }
  })()`;
}

/** Build an in-page expression that runs cursor-trace on the current voice. */
export function cursorTraceExpr(voice = 1, expectedZeroDeltaPairs = []) {
  return `window.__cursorTrace(${voice}, ${JSON.stringify(expectedZeroDeltaPairs)})`;
}
