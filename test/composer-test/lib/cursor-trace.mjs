// Cursor-trace invariant: walks every cursor position 0..voiceLen in the
// current voice, captures the rendered cursor bar's bounding rect, and
// flags any consecutive-position pair whose Manhattan distance is ≤
// MIN_DELTA.
//
// Wraps the existing tools/composer-inspect/cursor-trace.mjs and adds an
// `expectedZeroDeltaPairs` mechanism: pairs in that list (as [from, to]
// tuples on actualC) are exempted, in case two distinct cursor stops
// legitimately render at the same x (e.g., a tuplet wrapper position vs.
// the first-inside-tuplet position when they happen to share an x).

export const CURSOR_TRACE_FN = `async function(voice, expectedZeroDeltaPairs) {
  const m = window.__hkl_composer.model;
  const cursor = window.__hkl_composer.cursor;
  const inputState = window.__hkl_composer.inputState && window.__hkl_composer.inputState();
  const entryMode = (inputState && inputState.mode) || 'insert';

  const allowedSet = new Set(
    (expectedZeroDeltaPairs || []).map(([a, b]) => a + '->' + b)
  );

  const restoreCursor = m.getCursor(voice);
  const restoreVoice = m.getCurrentVoice();
  if (restoreVoice !== voice) m.setVoice(voice);

  const cursorRect = () => {
    const bars = document.querySelectorAll('rect[data-cursor-role="voice"]');
    let live = null;
    for (const b of bars) if (b.isConnected) { live = b; break; }
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

  const reRender = window.__hkl_composer.reRender;
  const refresh = () => {
    if (typeof reRender === 'function') reRender();
    if (cursor && typeof cursor.update === 'function') {
      /* Read the live cursorMode so we don't paint the voice cursor over
       * a selection-mode state — that bled through to the visualCheck
       * screenshot and made it look like the cursor was still visible.
       * Coerce 'expr'/'pedal' to 'voice' because the walker passes
       * exprCursor/pedalCursor: null and those renderers dereference them;
       * this walker tests the VOICE cursor regardless of which mode the
       * fixture left the model in. */
      const rawMode = (window.__hkl_composer.inputState && window.__hkl_composer.inputState().cursorMode) || 'voice';
      const liveMode = (rawMode === 'expr' || rawMode === 'pedal') ? 'voice' : rawMode;
      cursor.update(m, { entryMode, cursorMode: liveMode, exprCursor: null, pedalCursor: null });
    }
  };
  const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  refresh();
  await tick();

  const voiceLen = m.getVoiceLength(voice);
  const trace = [];
  for (let c = 0; c <= voiceLen; c++) {
    m.setCursor(c, voice);
    refresh();
    await tick();
    const actualC = m.getCursor(voice);
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
      const pair = trace[i].actualC + '->' + trace[i + 1].actualC;
      if (allowedSet.has(pair)) continue;
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
