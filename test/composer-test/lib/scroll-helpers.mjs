// Helpers for testing scroll-into-view behavior. main.ts uses
// `behavior: 'smooth'` for scrollTo, which animates over a few frames.
// To assert end-state, wait for the score's scrollTop/scrollLeft to
// stabilize (two consecutive RAFs with identical values).

export const SCROLL_SETTLE = `
async function waitForScrollSettle(maxWaitMs) {
  const score = document.getElementById('score');
  if (!score) return { ok: false, detail: 'no #score element' };
  const deadline = performance.now() + (maxWaitMs ?? 800);
  let prevL = score.scrollLeft, prevT = score.scrollTop, stable = 0;
  while (performance.now() < deadline) {
    await new Promise((r) => requestAnimationFrame(r));
    const l = score.scrollLeft, t = score.scrollTop;
    if (l === prevL && t === prevT) {
      stable++;
      if (stable >= 2) return { ok: true, scrollLeft: l, scrollTop: t };
    } else {
      stable = 0;
      prevL = l; prevT = t;
    }
  }
  return { ok: true, scrollLeft: score.scrollLeft, scrollTop: score.scrollTop, timedOut: true };
}
`;
