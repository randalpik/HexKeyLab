// Shared engine/context wiring for the ramp-stress harness pages.
// Both the manual UI (main.js) and the automated repro mode (repro.js) need
// the same one-time engine init, .hki bundle fetching, and seam-event feed —
// the engine holds module-level state, so init() must happen exactly once and
// every consumer must share the same AudioContext.

import { init, loadInstrument, readHkiInstrument } from '@hkl/engine/index.js';

// 44100 explicitly: the Intonalogy handoffs specify a 44.1kHz context, and the
// repro detector's sample↔time alignment assumes the rate it was captured at.
// The browser resamples to the device rate on output; the render graph (and
// the capture tap) runs at 44100 either way.
export const SAMPLE_RATE = 44100;

let ctx = null;
const seamListeners = new Set();

// The select carries FILE basenames (handoff/intonalogy naming); the engine
// instrument key comes from each bundle's own manifest, so renames of the
// staged files never break the harness.
const bundles = new Map();      // file basename → { key, def, audio }
const audioByKey = new Map();   // manifest instrumentKey → audio map (provider lookup)

export async function fetchBundle(file) {
  if (bundles.has(file)) return bundles.get(file);
  const res = await fetch(`/${file}.hki`);
  // Vite's SPA fallback answers missing files with 200 + index.html — catch
  // that explicitly rather than letting readHki die on "invalid zip data".
  if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) {
    throw new Error(`/${file}.hki missing from handoff/intonalogy (got ${res.status} ${res.headers.get('content-type')})`);
  }
  const parsed = readHkiInstrument(new Uint8Array(await res.arrayBuffer()));
  bundles.set(file, parsed);
  audioByKey.set(parsed.key, parsed.audio);
  return parsed;
}

export async function ensureEngine() {
  if (ctx) return ctx;
  ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  init(ctx, ctx.destination, {
    instrumentProvider: async (k) => audioByKey.get(k) ?? null,
    velocityToGain: (v) => v / 127,
    onSeamEvent: (ev) => { for (const l of seamListeners) l(ev); },
  });
  return ctx;
}

export function getCtx() { return ctx; }

export function onSeam(listener) {
  seamListeners.add(listener);
  return () => seamListeners.delete(listener);
}

export async function loadBundle(file) {
  const { key, def } = await fetchBundle(file);
  await loadInstrument(key, def);
  return { key, def };
}
