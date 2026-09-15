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

## `flash-mirror.mjs` — key-blink mirror proof (headless Chromium)

```
pnpm overlay:dist && node test/overlay-inspect/flash-mirror.mjs
```

Proves the re-strike blink (`render/key-flash.ts`) reaches the overlay, **visually**. Spawns its own
overlay-host on a throwaway `HKL_OVERLAY_PORT` and its own Chromium, publishes a `snapshot` with two
lit keys followed by a `flash`, and samples `canvas.toDataURL()` every frame across the blink.
Asserts the lattice changes, changes back, and that the blink lasts on the order of `KEY_FLASH_MS`.

Never touches `:5190` or `:5170`, so it cannot overwrite the retained state a live OBS source is
reading. Tests the **built** bundle, not the dev sources — run `pnpm overlay:dist` first.

Why pixels and not model state: a re-struck key never leaves `selection.selectedKeys`, so the blink
is a modifier on the lit set rather than a change to it. Every natural model-state assertion here
passes whether or not anything is drawn — which is exactly how the overlay went so long without
mirroring it. Verified as a real gate: stubbing out the subscriber's `flash` case makes it fail with
"canvas NEVER changed after the flash message".
