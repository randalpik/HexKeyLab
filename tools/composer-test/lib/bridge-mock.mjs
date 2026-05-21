// In-page bridge mock. Simulates the HKL side of the bridge by opening a
// second BroadcastChannel on the same name and using it to:
//   - Send held-keys / playback-position / playback-finished events to
//     Composer (which already has a bridge.on listener).
//   - Capture play-score / stop-playback / composer-hello / request-state
//     events that Composer sends.
//
// Exposed in-page as window.__bridgeMock with methods:
//   sendHeldKeys(notes), sendPlaybackPosition(meiId, timeMs),
//   sendPlaybackFinished(), captured(), drain(), reset().
//
// The runner injects MOCK_BRIDGE_LIB once after page load (after the
// page's own bridge has been created). Composer's own bridge.on handler
// will receive the events as if they came from real HKL.

export const MOCK_BRIDGE_LIB = `
(() => {
  const CHANNEL = 'hkl-composer-bridge';
  const ch = new BroadcastChannel(CHANNEL);
  const captured = [];
  ch.addEventListener('message', (e) => {
    const m = e.data;
    /* Only capture Composer→HKL events. Composer's own listener will get
     * the events we send. We filter by type prefix to avoid recording our
     * own emissions. */
    if (m && typeof m.type === 'string' &&
        (m.type === 'play-score' || m.type === 'stop-playback' ||
         m.type === 'composer-hello' || m.type === 'composer-bye' ||
         m.type === 'request-state' || m.type === 'set-reference-note')) {
      captured.push(m);
    }
  });

  window.__bridgeMock = {
    sendHeldKeys(notes) {
      ch.postMessage({ type: 'held-keys', keys: notes });
    },
    sendPlaybackPosition(meiId, timeMs) {
      ch.postMessage({ type: 'playback-position', meiId, timeMs });
    },
    sendPlaybackFinished() {
      ch.postMessage({ type: 'playback-finished' });
    },
    sendHklHello() {
      ch.postMessage({ type: 'hkl-hello', version: 1 });
    },
    captured() { return captured.slice(); },
    drain() { const s = captured.slice(); captured.length = 0; return s; },
    reset() { captured.length = 0; },
  };
  return 'ready';
})()
`;
