# OBS overlay — transparent lattice + Composer view for live video

Composite HKL's hex lattice **and** its Composer-view score over a performance video in OBS, with a
transparent background, **live-synced** to the performer's own HKL instance. The performing instance
publishes its render state; a second, read-only instance loaded as an OBS **Browser Source** mirrors
it transparently. (Backlog: LAYOUT — "export lattice + Composer view with transparent background
directly into OBS".)

```
 Performer: production HKL (Netlify, Firefox)  ──ws://127.0.0.1:5190──┐
   #cbObsOverlay on → publishes lattice + composer-frame state         ▼
 OBS Browser Source ── http://127.0.0.1:5190/?overlay ──▶  apps/overlay-host  (the distributable)
   read-only lean visuals, transparent, local origin        Node server: serves the lean overlay
                                                             build + the WebSocket relay (one origin)
```

Operational/run instructions live in [`apps/overlay-host/README.md`](../../apps/overlay-host/README.md);
design rationale + history in [`decisions.md`](../decisions.md) ("OBS live overlay…", "OBS overlay
distributable…", "OBS overlay: single relay…").

---

## Why it's built this way (the constraints)

1. **Transparency requires OBS to render the page itself.** Plain window/display capture can't carry
   an alpha channel — the OS compositor flattens the window first. OBS's **Browser Source** (its own
   embedded Chromium, CEF) is the only alpha-capable path. Chroma key was rejected: the lattice
   palette spans the whole hue wheel, so no collision-free key color exists.
2. **CEF is a separate browser**, so the same-origin `BroadcastChannel` bridge (HKL↔Composer) can't
   reach it. State crosses via a **localhost WebSocket relay**.
3. **The overlay page must be served from a LOCAL origin.** Since Chrome/Edge 142 (WebSockets in
   147), a *public* origin (the Netlify HKL) → `ws://127.0.0.1` is blocked by **Local Network
   Access** behind a permission prompt CEF can't show. Serving the overlay locally makes page +
   relay the same local origin (local→local), so LNA never applies. The **performer** stays on
   production HKL (Netlify) in **Firefox**, which exempts localhost WebSockets (loopback mixed-content
   + LNA bypass).
4. **HKL is the only node.** HKL already renders the Composer view itself (`composer-frame.ts`), so
   both surfaces publish from one place; the Composer app is untouched (still talks to HKL only over
   the existing BroadcastChannel).

These ruled out: window-capture+chroma key; OBS-CEF reading Web MIDI directly (CEF denies the
permission); and a cloud relay (extra hosting + routes performance data off-machine).

---

## The distributable — `apps/overlay-host` (`@hkl/overlay-host`)

A small Node server (`.mjs`, runs with bare `node` — no transpile on the run path). It is the **only
relay**, for both dev and production.

- **`src/server.mjs`** — binds `127.0.0.1` on **port 5190** (`HKL_OVERLAY_PORT` env / first CLI arg
  override), serves `embedded/` + attaches the relay at `/overlay-ws`, destroys non-relay upgrades.
- **`src/static.mjs`** — dependency-free static file server (path-traversal-safe, content-types incl.
  `.woff2`/`.wasm`, extensionless → `index.html`).
- **`src/overlay-relay.mjs`** — the relay (`ws` `noServer`): pub/sub fan-out that **retains
  last-value per message type**, so an OBS source opened mid-performance reconstructs immediately.
- **`embedded/`** — the lean overlay build, copied in by `vite/assemble-overlay-host.mjs`
  (gitignored). The app's `build` is a no-op so `pnpm -r build` ordering is untouched (it has no
  `@hkl/*` dep); embedding is the explicit `assemble:overlay-host` step.

Build + run:

```bash
pnpm overlay:dist        # = build:overlay (lean bundle) + assemble:overlay-host (copy → embedded/)
pnpm overlay:host        # = node apps/overlay-host/src/server.mjs
```

**Internet required:** the lean build bundles `BravuraText.woff2` locally, but Verovio WASM is
CDN-loaded by `@hkl/notation` — fine for a machine online while streaming.

Future: package as a single executable (bun compile / Node SEA) so non-developers don't need Node —
would swap `static.mjs`'s on-disk `embedded/` root for an embedded VFS.

---

## The lean overlay build

`apps/hkl/vite.overlay.config.ts` → `apps/hkl/dist-overlay/` (`pnpm --filter @hkl/hkl build:overlay`):

- Entry **`apps/hkl/src/overlay-main.ts`** (imports only `bridge/overlay-subscribe.js`).
- Reuses the full `index.html` via an **`order:'pre'` `transformIndexHtml`** that swaps the entry
  script to `overlay-main.ts` (no markup/CSS drift) **and** injects
  `<script>window.__HKL_OVERLAY_SAME_ORIGIN=1</script>` (the relay-URL flag, below).
- `publicDir:false` (no sample audio) + a `closeBundle` copy of `BravuraText.woff2` (the CDN
  @font-face fallback proved unreliable in OBS-CEF).
- Result ~110 KB, **verified to exclude** `requestMIDIAccess`/`AudioContext`/`SampleEngine`/
  `recordOn` — the leanness is the whole point (see decoupling).

### Render/engine decoupling (`render/controls-core.ts`)

The overlay's import graph must not reach the audio/MIDI engines. The render-only control primitives
were extracted to **`apps/hkl/src/render/controls-core.ts`** (engine-free): `syncViewToOutline`,
`applyRotation`, `applyHexSize`, and `applyTuningRender` / `applyOutlineRender` (the render fan-outs
of `setTuning` / `setOutline`). `ui/controls.ts` re-exports them and keeps the engine-coupled
`transpose`/`clear` + the full `setTuning`/`setOutline`; `effects/onTuningChanged.ts` calls
`applyTuningRender` then its audio/Lumatone/Composer effects. `overlay-subscribe.ts` uses
`controls-core` + direct state writes — never `ui/controls.ts` — so audio/MIDI/samples/recording
never enter its bundle. (`draw()` also skips `updateInfo()` when `transparentBg`.)

---

## Transparent render (HKL `draw.ts`)

The lattice renders **fully opaque** — solid `#111` base, so inter-hex seams are clean, gap-free
black, identical to normal HKL (a transparent base leaked 1–2 px of video through the seams). The
`transparentBg` flag (set by the `?overlay` subscriber) changes only the **out-of-outline mask**:
the mask that clips the animation-margin hexes switches from an opaque `#111` even-odd fill to a
**`destination-out` erase** when transparent + extend-off — so everything *outside* the keyboard
outline becomes transparent while still clipping per-frame. Extend-on keeps the dim paint (mirrors
the performer's ghost tiling). Chrome is hidden via the `html.overlay` CSS block in `index.html`.

---

## Transport — `@hkl/bridge`

- **`overlay-protocol.ts`** (pure data): the `OverlayMsg` union — lattice `snapshot` / `keys` /
  `view`, the re-exported `composer-score` / `composer-playback` shapes, plus `OVERLAY_WS_PATH`
  (`/overlay-ws`) and `OVERLAY_RELAY_PORT` (`5190`).
- **`overlay-ws.ts`** — the browser `OverlayChannel` (native `WebSocket`, reconnect w/ capped
  backoff). **URL resolution**, in precedence:
  1. `?obsrelay=PORT` query or `localStorage.hklOverlayPort` → `ws://127.0.0.1:PORT` (override; also
     lets a *local dev performer* on `:5170` target the host on `:5190` for local end-to-end tests);
  2. `window.__HKL_OVERLAY_SAME_ORIGIN` (the host-served overlay) → **same origin** (tracks any
     `HKL_OVERLAY_PORT`);
  3. otherwise (dev/Netlify performer, non-host overlay) → `ws://127.0.0.1:OVERLAY_RELAY_PORT`.
  - **Bounded give-up**: a never-opened socket stops after N attempts (the publisher passes
    `giveUpAfter:6`, so a public Netlify visitor with no relay doesn't poke localhost forever); once
    opened, reconnect is unbounded. The subscriber retries indefinitely.

The relay lives in `apps/overlay-host` (not `@hkl/bridge`) so the package stays data-only.

---

## Publisher (performing HKL)

`apps/hkl/src/bridge/overlay-publish.ts`, gated by **`#cbObsOverlay`** ("OBS overlay", Analysis
group, pref `obsOverlay`, **off by default** — so public Netlify visitors never dial localhost).

- **Lattice**: `overlayPublishTick()` runs at the END of `draw()` — the one convergence point every
  state change funnels through — and diff-gates a full `snapshot` (structural change), a `keys` delta
  (`selection.selectedKeys`), and a `view` delta (pan; streamed per-frame during tweens for an exact
  match).
- **Composer frame**: forwarded from `hkl-side.ts` where the bridge already calls
  `setComposerScore`/`setComposerPlaybackBars` (NOT `composer-cursor` — the overlay is **bars-only**,
  no editing caret). HKL already holds this state (mirrored from Composer over BroadcastChannel), so
  nothing is recomputed.
- On (re)connect, the publisher resends a full snapshot + cached composer state.

---

## Subscriber (the `?overlay` instance)

`apps/hkl/src/bridge/overlay-subscribe.ts`, loaded by `main.ts` instead of `ui/init.ts` when
`?overlay` is present (the lean build's `overlay-main.ts` is a thin wrapper around it). At boot it
adds `html.overlay`, sets `transparentBg`, and connects. No audio, MIDI, or input; `savePrefs` is
suppressed under `?overlay` so opening the overlay never clobbers the real instance's prefs.

- **snapshot** → reconstruct lattice state via the `controls-core` primitives + direct state writes.
- **keys** → mutate `selection.selectedKeys` + `requestDraw()`.
- **view** → set `view.viewQ/viewR/kbOffY` + `requestDraw()`.
- **composer-view / composer-score / composer-playback** → toggle `body.composer-view`, feed
  `setComposerScore` / `setComposerPlaybackBars` (the existing `composer-frame.ts` exports). Scroll
  is model-relative (measure index), so it absorbs DPR differences between Firefox and OBS-CEF.

---

## Running it

**Production / OBS.** `pnpm overlay:dist && pnpm overlay:host`. In OBS add a **Browser Source** →
`http://127.0.0.1:5190/?overlay` (size it to the lattice; background is transparent). Perform on
production HKL (Netlify) in **Firefox**, tick **OBS overlay**.

**Dev** (one relay, with HMR). Run `pnpm overlay:host` alongside `pnpm dev`. The performer at
`localhost:5170/` (tick OBS overlay) and an overlay at `localhost:5170/?overlay` both auto-dial the
host's `:5190` relay — HMR for both, no `?obsrelay` needed for the default port. (There is **no**
dev-proxy relay — one relay, no dev/prod divergence.)

---

## Verification — `test/overlay-inspect/`

- **`relay-roundtrip.mjs`** — Node-only: fan-out + retained replay against the relay module.
- **`inspect.mjs`** — headless Chromium: loads `?overlay`, asserts transparent regions + a painted
  keyboard + chrome hidden (`HKL_URL` env to point at the distributable).
- Gates: `pnpm typecheck` · `pnpm -r build` (the no-op host build keeps ordering) · `pnpm
  check:boundaries` (the host imports only `ws`/Node/own-relative; `@hkl/bridge` stays pure).

---

## Critical files

| Concern | File |
|---|---|
| Distributable server + static + relay | `apps/overlay-host/src/{server,static,overlay-relay}.mjs` |
| Embed lean build | `vite/assemble-overlay-host.mjs` (root script `assemble:overlay-host`) |
| Lean build | `apps/hkl/vite.overlay.config.ts`, `apps/hkl/src/overlay-main.ts` → `dist-overlay/` |
| Render decoupling | `apps/hkl/src/render/controls-core.ts`, `ui/controls.ts`, `effects/onTuningChanged.ts` |
| Transparent render | `apps/hkl/src/render/draw.ts` (`transparentBg`, destination-out mask) |
| Publisher / subscriber | `apps/hkl/src/bridge/overlay-publish.ts`, `overlay-subscribe.ts`, `overlay-mode.ts` |
| Composer-frame mirror | `apps/hkl/src/bridge/hkl-side.ts`, `apps/hkl/src/render/composer-frame.ts` |
| Protocol / client | `packages/bridge/src/overlay-protocol.ts`, `overlay-ws.ts` |
| Publisher toggle | `apps/hkl/index.html` (`#cbObsOverlay`), `apps/hkl/src/ui/init.ts`, `state/persistence.ts` |
