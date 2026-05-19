// In-page cursor trace function: walks every cursor position 0..voiceLen,
// captures the rendered cursor-bar bbox at each, and reports
// "state-changes-but-pixel-doesnt" invariant violations.
//
// Exported as a STRING (an async function expression). The driver inlines
// it into the inspector's eval and calls it with the voice number.

export const CURSOR_TRACE_FN = `async function(voice) {
  const m = window.__hkl_composer.model;
  const cursor = window.__hkl_composer.cursor;
  const inputState = window.__hkl_composer.inputState && window.__hkl_composer.inputState();
  const entryMode = (inputState && inputState.mode) || 'insert';

  const restoreCursor = m.getCursor(voice);
  const restoreVoice = m.getCurrentVoice();
  if (restoreVoice !== voice) m.setVoice(voice);

  /* Re-queried each iteration: reRender rebuilds the cursorOverlay (and
     hence the bar element) each time, so a single captured reference goes
     stale immediately. */
  const cursorRect = () => {
    const bars = document.querySelectorAll('rect[data-cursor-role="voice"]');
    /* Multiple bars can briefly coexist if old overlays haven't been GC'd —
       pick the one that's currently visible in the DOM (still has a parent
       attached to the body). */
    let live = null;
    for (const b of bars) {
      if (b.isConnected) { live = b; break; }
    }
    if (!live) return null;
    const r = live.getBoundingClientRect();
    return {
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      opacity: parseFloat(live.getAttribute('opacity') ?? '1'),
    };
  };

  const describeEl = (el) => {
    if (!el) return null;
    const out = { tag: el.localName };
    if (el.getAttribute && el.getAttribute('data-placeholder') === 'true') out.kind = 'placeholder';
    if (el.getAttribute && el.getAttribute('data-tuplet-placeholder') === 'true') out.kind = 'tuplet-ph';
    if (el.localName === 'measure') {
      const measures = Array.from(document.querySelectorAll('measure'));
      out.measureIdx = measures.indexOf(el);
    }
    if (el.getAttribute) {
      const id = el.getAttribute('xml:id');
      if (id) out.id = id;
      const dur = el.getAttribute('dur');
      if (dur) out.dur = dur;
    }
    return out;
  };

  /* Force a full re-render — Verovio re-renders the SVG (rebuilding the
     id→rect map the cursor reads), then the cursor overlay updates. The
     dev shell normally hooks this via onStateChange + onChange in input.ts;
     in our headless context we trigger reRender directly. */
  const reRender = window.__hkl_composer.reRender;
  const refresh = () => {
    if (typeof reRender === 'function') reRender();
    if (cursor && typeof cursor.update === 'function') {
      cursor.update(m, { entryMode, cursorMode: 'voice', exprCursor: null });
    }
  };
  const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  /* Initial re-render so the scenario's content shows up before we start
     walking cursor positions. */
  refresh();
  await tick();

  const voiceLen = m.getVoiceLength(voice);
  const flat = m.flatChildren(voice);
  const trace = [];
  for (let c = 0; c <= voiceLen; c++) {
    m.setCursor(c, voice);
    refresh();
    await tick();
    const actualC = m.getCursor(voice);
    /* Snapshot AFTER any reanchor that setCursor's autofill sweep may have done. */
    trace.push({
      requestedC: c, actualC,
      voiceLen: m.getVoiceLength(voice),
      flatLen: m.flatChildren(voice).length,
      rect: cursorRect(),
      ref: actualC > 0 ? describeEl(m.flatChildren(voice)[actualC - 1]) : null,
      at: describeEl(m.flatChildren(voice)[actualC]),
      mode: entryMode,
    });
  }

  m.setCursor(restoreCursor, voice);
  refresh();
  if (restoreVoice !== voice) m.setVoice(restoreVoice);

  /* Invariant: consecutive cursor positions must have visually distinct
     rects (Manhattan distance > 3 px). */
  const MIN_DELTA = 3;
  const violations = [];
  for (let i = 0; i < trace.length - 1; i++) {
    const a = trace[i].rect;
    const b = trace[i + 1].rect;
    if (!a || !b) continue;
    if (a.opacity === 0 || b.opacity === 0) continue;
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    if (dx + dy <= MIN_DELTA) {
      violations.push({
        kind: 'stuck-cursor',
        from: trace[i].actualC, to: trace[i + 1].actualC,
        delta: { dx, dy },
        fromRef: trace[i].ref, fromAt: trace[i].at,
        toRef: trace[i + 1].ref, toAt: trace[i + 1].at,
      });
    }
  }

  return { voice, voiceLen, flatLen: m.flatChildren(voice).length, trace, violations };
}`;
