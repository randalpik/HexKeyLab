// Layout-switch view tween. Encapsulated state machine: private start/target
// + animStart timestamp; public API updates view.viewQ/viewR each step.
//
// Usage from main.ts (the raf scheduler):
//   animation.tweenTo(targetQ, targetR);
//   if (animId) cancelAnimationFrame(animId);
//   animId = requestAnimationFrame(function tick() {
//     const running = animation.step();
//     draw();
//     animId = running ? requestAnimationFrame(tick) : null;
//   });

import { view } from '../state/view.js';
import type { AnimationModule } from '../types.js';

const ANIM_DURATION = 500;

let startQ = 0, startR = 0;
let targetQ = 0, targetR = 0;
let animStart = 0;

export const animation: AnimationModule = {
  /* tween duration in ms — referenced by setLayout for audio ramp duration */
  get duration(): number { return ANIM_DURATION; },

  /* true while a tween is in flight (between tweenTo and final step) */
  get isAnimating(): boolean { return animStart > 0; },

  /* normalized [0, 1] tween progress, or -1 if not animating.
     Used by render code that reads "where in the tween are we?" */
  get progress(): number {
    if (animStart === 0) return -1;
    return Math.min(1, (Date.now() - animStart) / ANIM_DURATION);
  },

  /* start a tween from the current view to (targetQ, targetR). If a tween is
     already in flight, the in-flight raf will pick up the new target on its
     next step (caller may also cancel + re-schedule for cleanliness). */
  tweenTo(tq: number, tr: number): void {
    startQ = view.viewQ; startR = view.viewR;
    targetQ = tq; targetR = tr;
    animStart = Date.now();
  },

  /* Advance the tween. Updates view.viewQ/viewR. Returns true while still
     animating, false after the final frame (caller stops scheduling raf). */
  step(): boolean {
    if (animStart === 0) return false;
    const t = (Date.now() - animStart) / ANIM_DURATION;
    if (t >= 1) {
      view.viewQ = targetQ;
      view.viewR = targetR;
      animStart = 0;
      return false;
    }
    const e = t * t * (3 - 2 * t); /* smoothstep ease */
    view.viewQ = startQ + (targetQ - startQ) * e;
    view.viewR = startR + (targetR - startR) * e;
    return true;
  },
};
