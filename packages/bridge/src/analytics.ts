// Usage analytics: the one place app code reports an event. The tracker itself
// (Umami) is a script tag that only the deployed build carries
// (vite/analytics-tag.mjs), so under `pnpm dev`, in tests and behind a content
// blocker there is no `window.umami` and every call here is a no-op.
//
// Rules for callers: a fixed event name, and properties that are short
// enumerations (a kind, a source, a firmware version). Never a file name or
// path, a device name, note data, or anything else a user typed or made.

type Props = Record<string, string | number | boolean>;
interface Tracker { track(name: string, data?: Props): void }

/* The tag loads async, so an event at startup can precede the tracker: hold
   such events and retry for a few seconds, then drop them (no tracker is the
   normal case everywhere but the deployed site). */
const RETRY_MS = 500;
const MAX_TRIES = 20;
const pending: Array<[string, Props | undefined]> = [];
let timer: ReturnType<typeof setInterval> | null = null;
let tries = 0;
let gaveUp = false;

const sentOnce = new Set<string>();

function tracker(): Tracker | undefined {
  return (globalThis as { umami?: Tracker }).umami;
}

function send(t: Tracker, name: string, data?: Props): void {
  /* Analytics must never break the app. */
  try { t.track(name, data); } catch { /* ignore */ }
}

function drain(): void {
  const t = tracker();
  if (t) {
    for (const [name, data] of pending.splice(0)) send(t, name, data);
  } else if (++tries < MAX_TRIES) {
    return;
  } else {
    gaveUp = true;
    pending.length = 0;
  }
  if (timer !== null) { clearInterval(timer); timer = null; }
}

/** Report one event. */
export function track(name: string, data?: Props): void {
  const t = tracker();
  if (t) { send(t, name, data); return; }
  if (gaveUp) return;
  pending.push([name, data]);
  if (timer === null) timer = setInterval(drain, RETRY_MS);
}

/** Test hook: forget what was reported once and drop anything held, so a suite
 *  that reuses one page gets a fresh "page load" per fixture. */
export function resetAnalytics(): void {
  sentOnce.clear();
  pending.length = 0;
  if (timer !== null) { clearInterval(timer); timer = null; }
  tries = 0;
  gaveUp = false;
}

/** Report an event at most once per page load (the first call's properties
 *  win): for things that recur within a session, such as a device reconnecting
 *  or a repeated save, where the question is whether it happened at all. */
export function trackOnce(name: string, data?: Props): void {
  if (sentOnce.has(name)) return;
  sentOnce.add(name);
  track(name, data);
}
