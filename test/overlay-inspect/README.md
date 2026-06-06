# overlay-inspect — OBS live-overlay verification

Tooling for the OBS live-overlay feature (transparent lattice + Composer view
mirrored from the performing HKL instance to an OBS Browser Source over a
localhost WebSocket relay). See `docs/architecture/hkl.md` → "OBS overlay" and
`docs/decisions.md`.

## `relay-roundtrip.mjs` — transport proof (no browser)

```
node test/overlay-inspect/relay-roundtrip.mjs
```

Stands up `vite/overlay-relay.mjs` on a throwaway port and drives two native
WebSocket clients to assert: (1) fan-out (publisher → subscriber, no self-echo),
and (2) retained-last-value replay to a late-joining subscriber (what lets an
OBS source opened mid-performance reconstruct current state). Never touches the
`:5170` dev server.

## `inspect.mjs` — overlay render proof (headless Chromium)

```
node test/overlay-inspect/inspect.mjs [--screenshot <out.png>]
```

Requires `pnpm dev` (umbrella `:5170`) running and `chromium` in PATH. Loads
`/?overlay`, reads back the lattice canvas pixels, and asserts:

- `html.overlay` set + toolbar (`.ctrls`) hidden — chrome-free;
- the background is **not** opaque — alpha-0 regions and/or a large fraction of
  partial-alpha pixels (the semi-transparent keyboard backing, which an opaque
  `#111` fill can't produce);
- the lattice is actually painted (opaque hex pixels exist).

`--screenshot` writes a transparent PNG (CDP background override α=0) for
eyeballing. Exits non-zero on any failed assertion (usable as a gate).

## Full live round-trip

The two-browser live path (performer publishes → relay → OBS `?overlay`
subscribes) is exercised by the manual OBS acceptance step: with `pnpm dev`
running, enable **OBS overlay** in the performing tab, add an OBS Browser Source
at `http://localhost:5170/?overlay` (and `?overlay` works in a second normal tab
for eyeballing), and confirm the lattice + Composer frame mirror live with a
transparent background. (A headless two-tab automation can't run against a
pre-existing dev-proxy started before the relay wiring landed — restart
`pnpm dev` first.)
