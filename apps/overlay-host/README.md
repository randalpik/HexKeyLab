# @hkl/overlay-host — OBS overlay distributable

A tiny local server that lets OBS composite HKL's lattice + Composer view over a
performance video with a transparent background — **without** running the HKL
dev stack. It does two things on one local origin:

1. serves the **lean, read-only overlay build** (`apps/hkl/dist-overlay`, embedded
   into `embedded/`) — just the lattice + score renderer, no audio/MIDI/recording;
2. hosts the **WebSocket relay** at `/overlay-ws` that mirrors the performer's
   state to the overlay.

## Why a local server (the OBS / Local Network Access constraint)

OBS's Browser Source is its own Chromium (CEF). Since Chrome/Edge 142 (WebSockets
in 147), a **public** origin (the Netlify HKL) connecting to `ws://127.0.0.1` is
blocked behind a Local Network Access permission prompt that CEF can't show.
Serving the overlay page **locally** makes the page and the relay the same local
origin (local→local), so LNA never applies. The **performer** stays on production
HKL (Netlify) in **Firefox**, which exempts localhost WebSockets and reaches the
relay fine.

```
 Performer: production HKL (Netlify, Firefox) ──ws://127.0.0.1:5190──┐
                                                                      ▼
 OBS Browser Source ── http://127.0.0.1:5190/?overlay ──▶  this distributable
       (lean read-only visuals, local origin)              (relay + overlay build)
```

## Build the distributable

```bash
pnpm overlay:dist        # = build:overlay (lean bundle) + assemble into embedded/
```

(or the steps: `pnpm --filter @hkl/hkl build:overlay && pnpm assemble:overlay-host`)

## Run it

```bash
pnpm overlay:host        # = pnpm --filter @hkl/overlay-host start  → node src/server.mjs
```

Prints the URLs. Then, on the same machine:

- **OBS**: add a **Browser Source** → `http://127.0.0.1:5190/?overlay` (set its size
  to the lattice resolution; the background is transparent).
- **Perform**: open your production HKL in **Firefox** and play — publishing
  auto-starts (no toggle); this relay being up is what activates it. The overlay
  mirrors it live. (On Chromium you'll get a one-time "access other apps and
  services" prompt while the relay is running — grant it. With no relay running the
  dial-out is silently refused, so HKL never prompts users who don't stream.)

Port defaults to **5190** (`HKL_OVERLAY_PORT` env or first CLI arg overrides it; if
you change it, also set `localStorage.hklOverlayPort` in the performing tab so it
dials the right port — it's hardcoded to the default otherwise).

**Internet required:** the Bravura font + Verovio WASM load from CDNs (no local
copies in the lean build) — fine for a machine that's online while streaming.

## Dev

The overlay-host is the **only** relay (no separate dev-proxy relay). For local
iteration with HMR, run it alongside `pnpm dev`:

```bash
pnpm dev          # apps on :5170 (HMR)
pnpm overlay:host # the relay + host on :5190   (run `pnpm overlay:dist` first if serving its overlay)
```

Then the **performer** at `http://localhost:5170/` and an
**overlay** at `http://localhost:5170/?overlay` (HMR) both auto-dial the host's
relay at `ws://127.0.0.1:5190` — one relay, dev or prod. (Custom port: set
`HKL_OVERLAY_PORT` and `localStorage.hklOverlayPort` / `?obsrelay=PORT` to match.)

## Notes

- URL resolution (`@hkl/bridge/overlay-ws.ts`): the host-served overlay uses
  same-origin (tracks any host port); every other page (dev/Netlify performer,
  non-host overlay) dials `ws://127.0.0.1:OVERLAY_RELAY_PORT`; `?obsrelay=PORT`
  or `localStorage.hklOverlayPort` overrides both.
- Future: package as a single executable (bun compile / Node SEA) so non-developers
  don't need Node — would swap `static.mjs`'s on-disk `embedded/` root for an
  embedded VFS.
