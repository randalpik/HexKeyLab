// Velocity-continuous scroll-follow for a score viewport.
//
// THE PROBLEM. `el.scrollTo({ behavior: 'smooth' })` is NOT portable for a
// follow-the-music scroller, because the two engines disagree about what a
// SECOND smooth scroll means while a first is still running:
//   • Firefox models smooth scrolling as a mass-spring-damper and PRESERVES the
//     current velocity when the destination moves. A stream of destinations
//     arriving a note apart reads as one continuous glide.
//   • Chromium replaces the running animation with a fresh ease-in-out curve
//     starting FROM REST, whose duration scales with the remaining distance
//     (measured here: 42 ms for 10 px, 131 ms for 80 px, 565 ms for 1200 px —
//     roughly sqrt(delta)). So each onset is a self-contained hop.
//
// Measured in headless Chromium, retargeting 60 px every 120 ms (about a note
// rate), the per-frame scroll deltas are:
//
//     3 23 19 7 5 2 1 0 0 | 3 23 19 7 5 2 0 | 3 23 19 8 4 3 0 | ...
//
// — an accelerate-from-rest/decelerate-to-rest burst of 5-7 frames followed by
// dead frames. 31-50 % of all frames do not move at all and the per-frame
// velocity has a coefficient of variation near 1.0. That is the "extremely
// jerky" OBS scroll: not OBS's doing, and not a dropped animation, just a fast
// hop with a stall behind it. An OBS Browser Source makes it worse without
// causing it, since it drives rAF at the source FPS: at 30 fps the 5-frame
// burst becomes 2-3 frames and reads as a pure jump.
//
// No browser exposes smooth-scroll duration or easing (no CSS property, no API
// option), so matching Firefox means not using the native animation at all.
//
// THE FIX. One persistent rAF loop per element driving a CRITICALLY DAMPED
// SPRING toward a MUTABLE target. Retargeting moves the target and nothing
// else — the velocity carries across onsets, which is the Firefox property we
// are after. Under a steady stream of onsets the spring settles into
// constant-velocity ramp tracking with a constant lag of 2v/omega: at
// 60 px/120 ms and SPRING_K = 1000 that is a steady 500 px/s trailing ~32 px
// behind the target, i.e. the score glides past at a constant rate. The lag is
// the tradeoff and it is what SPRING_K buys; there is room for it because the
// caller parks the sounding moment at 2/3 of the viewport.
//
// WHY THE CLOSED FORM and not Euler integration. The obvious semi-implicit
// Euler step is UNSTABLE at exactly the frame rate we care about: with
// SPRING_K = 1000 (omega = 31.6) and dt = 1/30 s, the update matrix has an
// eigenvalue of -1.83, so an OBS source running at 30 fps would oscillate and
// diverge rather than glide. Substepping would fix the stability but not the
// frame-rate dependence. Critical damping has an exact closed-form solution for
// a target held constant across the frame, so we use it: unconditionally stable
// at any dt, and a 30 fps OBS source traces the SAME trajectory as a 60 fps
// desktop, merely sampled half as often. Do NOT "simplify" this back to an
// Euler step.

/** Spring constant (omega^2). Sets both the settle time for a stationary target
 *  (~5.8/omega, about 185 ms) and the trailing lag while tracking a moving one
 *  (2v/omega). Tuned to sit where Firefox's smooth scrolling lands. */
const SPRING_K = 1000;
const OMEGA = Math.sqrt(SPRING_K);
/** Settle thresholds: below both, snap to the target and stop the loop. While
 *  playback is driving the target these are never met (the tracking lag keeps
 *  the error near 32 px), which is intended — the loop runs until the music
 *  stops moving the target. */
const EPS_POS = 0.25;
const EPS_VEL = 5;

interface FollowState {
  /** Destination, in the element's scroll coordinates. Caller clamps it. */
  target: number;
  /** Our own authoritative position. Fractional: browsers store fractional
   *  scroll offsets, so this stays subpixel-smooth on HiDPI. We do not read
   *  el.scrollLeft back while animating — the write is ours and re-reading only
   *  invites rounding drift. */
  cur: number;
  vel: number;
  raf: number;
  last: number;
}

const states = new WeakMap<HTMLElement, FollowState>();

function reduceMotion(): boolean {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The destination currently being animated toward, or null when idle. Compare
 *  against THIS rather than el.scrollLeft when deciding whether a new
 *  destination is a real change: mid-flight, scrollLeft is a point on the
 *  trajectory, not the thing that was asked for. */
export function scrollFollowTarget(el: HTMLElement): number | null {
  return states.get(el)?.target ?? null;
}

/** Stop following and drop the state. Call before replacing the element's
 *  content: a re-render resets scrollLeft to 0, which would leave `cur` stale
 *  and the loop fighting the fresh layout. */
export function cancelScrollFollow(el: HTMLElement): void {
  const st = states.get(el);
  if (!st) return;
  cancelAnimationFrame(st.raf);
  states.delete(el);
}

/** Smoothly scroll `el` horizontally toward `left`, preserving velocity if a
 *  follow is already in flight. `left` must already be clamped to
 *  [0, scrollWidth - clientWidth] by the caller (which has typically just
 *  forced layout anyway to measure the target element). Re-issuing the target
 *  the view has already settled on is a no-op. */
export function scrollFollow(el: HTMLElement, left: number): void {
  const st = states.get(el);
  if (st) { st.target = left; return; } /* retarget: velocity carries */
  if (Math.abs(left - el.scrollLeft) < EPS_POS) return;
  if (reduceMotion()) { el.scrollLeft = left; return; }
  const next: FollowState = { target: left, cur: el.scrollLeft, vel: 0, raf: 0, last: 0 };
  states.set(el, next);
  next.raf = requestAnimationFrame((t) => { next.last = t; step(el, next, t); });
}

function step(el: HTMLElement, st: FollowState, t: number): void {
  const dt = Math.max(0, (t - st.last) / 1000);
  st.last = t;
  /* Exact critically-damped response over dt, for x measured RELATIVE to the
     target: x(t) = (x0 + (v0 + omega*x0) t) e^(-omega t), v = dx/dt. A long dt
     (backgrounded tab, stalled source) drives e^(-omega t) to 0 and lands on
     the target with zero velocity, which is the right recovery. */
  const x0 = st.cur - st.target;
  const b = st.vel + OMEGA * x0;
  const e = Math.exp(-OMEGA * dt);
  const x = (x0 + b * dt) * e;
  st.cur = st.target + x;
  st.vel = (b - OMEGA * (x0 + b * dt)) * e;
  if (Math.abs(x) < EPS_POS && Math.abs(st.vel) < EPS_VEL) {
    el.scrollLeft = st.target;
    states.delete(el);
    return;
  }
  el.scrollLeft = st.cur;
  st.raf = requestAnimationFrame((tt) => step(el, st, tt));
}
