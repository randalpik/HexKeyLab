# Plan — OBS overlay host app (`@hkl/overlay-host`)

## Goal
A self-contained Node distributable the OBS user runs locally. It (a) serves a copy of the
built HKL app so the OBS Browser Source loads `http://127.0.0.1:<PORT>/?overlay` from a LOCAL
origin (dodging Chrome 142+ Local Network Access on the WS), and (b) hosts the existing
`/overlay-ws` pub/sub relay on the same origin/port. The performer runs production HKL from
Netlify in Firefox, which dials `ws://127.0.0.1:<PORT>/overlay-ws`. `pnpm dev` keeps its own
`/overlay-ws` relay unchanged.

---

## 1. New app: `apps/overlay-host/`

Name `@hkl/overlay-host`. It is a **Node server**, not a Vite/browser app — no `vite.config.ts`,
no `index.html`, no `base`/HMR. It is a workspace project (matches `apps/*` glob) so its `.ts` is
auto-typechecked by the root `tsc --noEmit` and scanned by `check:boundaries`.

### Layout
```
apps/overlay-host/
  package.json          # @hkl/overlay-host, "type":"module"
  tsconfig.json         # optional; root tsconfig already includes apps/** — only add if it needs app-specific opts
  src/
    overlay-relay.mjs   # MOVED from vite/overlay-relay.mjs (see §2). Plain .mjs, dependency = ws.
    server.mjs          # the host server: static files + relay upgrade + listen. Plain .mjs.
    static.mjs          # minimal dependency-free static file server (see §3).
  embedded/             # build output: copy of apps/hkl/dist (gitignored; produced by build step)
```

Decision: keep the runtime modules as **`.mjs`** (like `vite/*.mjs`), not `.ts`. Reasons: the
server is pure Node, run directly with `node` in the distributable (no transpile step at run
time); `ws` + Node builtins only, which `check:boundaries` already ignores; and `.mjs` is the
established convention for repo Node tooling. The root `tsc --noEmit` still scans `.mjs`? No — it
type-checks `.ts`. That's fine: this app intentionally ships no `.ts`, so there is nothing for
`tsc` to check, and `check:boundaries` scans `.mjs` too (its `SRC_EXT` includes `mjs`). If we
want type-checking on the server we can author `.ts` + a `build` tsc emit, but that adds a
transpile dependency to the run path for little gain — **recommend `.mjs`**.

### package.json shape
```jsonc
{
  "name": "@hkl/overlay-host",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node scripts/embed-hkl.mjs",   // see §1.1 — copies apps/hkl/dist -> embedded/
    "start": "node src/server.mjs"            // run the distributable
  },
  "dependencies": {
    "ws": "<same version as the relay already uses>"   // add to deps; check:boundaries ignores third-party, but pnpm needs it
  }
}
```
No `@hkl/*` dependency is required: the server imports only its own `src/*.mjs` (relative,
in-project → passes rule 2) plus `ws` + Node builtins. **Boundary check passes** with zero
`@hkl/*` deps.

### 1.1 Build ordering — the load-bearing constraint
`pnpm -r build` runs every package's `build` in dependency order, but `@hkl/overlay-host` has no
`@hkl/*` dep, so pnpm will **not** order it after `@hkl/hkl`. Two options:

- **Recommended: do NOT embed in this app's `build`.** Make `@hkl/overlay-host` `build` a no-op
  (or omit it), and add a dedicated assemble step that mirrors `vite/assemble-dist.mjs`:
  a new `vite/assemble-overlay-host.mjs` (build tooling, not boundary-scanned) that:
  1. asserts `apps/hkl/dist` exists (else error: "run `pnpm --filter @hkl/hkl build` first"),
  2. `rmSync` + `cpSync` `apps/hkl/dist` → `apps/overlay-host/embedded/`,
  3. leaves `src/*.mjs` in place.
  Add a root script `"assemble:overlay-host": "node vite/assemble-overlay-host.mjs"`. The
  distributable is produced by: `pnpm --filter @hkl/hkl build && pnpm assemble:overlay-host`.
  This keeps embedding out of `pnpm -r build`'s unordered graph entirely — same pattern as the
  existing Netlify `assemble`.

- Alternative (rejected): add `@hkl/hkl` as a dep of `@hkl/overlay-host` purely to force build
  order, then embed in this app's own `build`. Rejected because (a) it's a fake dependency the
  server never imports, (b) it pollutes the DAG, (c) `pnpm -r build` would then try to copy
  `apps/hkl/dist` that may be stale within the same `-r` pass. The explicit assemble step is
  cleaner and matches precedent.

Add `apps/overlay-host/embedded/` to `.gitignore` (build artifact).

---

## 2. Relay relocation

Move `vite/overlay-relay.mjs` → `apps/overlay-host/src/overlay-relay.mjs` **verbatim** (it's
already self-contained: `import { WebSocketServer } from 'ws'`, `noServer:true`, exports
`attachOverlayRelay`). Then:

- `apps/overlay-host/src/server.mjs` imports it relatively (`./overlay-relay.mjs`) — in-project,
  passes boundaries.
- `vite/dev-proxy.mjs` changes its import from `./overlay-relay.mjs` to
  `../apps/overlay-host/src/overlay-relay.mjs`. **`vite/` is not boundary-scanned**, so a relative
  reach into the app is allowed (confirmed: `check-boundaries.mjs` `PROJECT_GLOBS = ['packages','apps']`;
  `vite/` is excluded). Dev workflow is otherwise unchanged.

Files touched: delete `vite/overlay-relay.mjs`; edit `vite/dev-proxy.mjs` line 24 import path.

---

## 3. Static file server (`apps/overlay-host/src/static.mjs`)

Dependency-free. There is no generic static server in the repo today (`vite/middleware.mjs` is
fetch/transcode + manifest only), so write a minimal one:

- Resolve request path against `embedded/` root, with `..` traversal rejection (normalize and
  assert the resolved path stays under root).
- Strip query string (the overlay loads `/?overlay` — serve `index.html`).
- Content-type map for the asset types HKL ships: `.html`, `.js`/`.mjs` (`text/javascript`),
  `.css`, `.woff2` (`font/woff2`, used by `BravuraText.woff2`), `.json`, `.wasm`
  (`application/wasm`), `.svg`, `.png`, `.mp3`/`.ogg`/`.wav` (samples), `.ico`. Default
  `application/octet-stream`.
- SPA-ish fallback: if the resolved file doesn't exist AND the path has no file extension, serve
  `embedded/index.html` (so `/?overlay` and any client-route hit index). A missing file *with* an
  extension → 404.
- Stream with `fs.createReadStream`; set `content-length` from `stat`; basic `cache-control`
  (assets are content-hashed by Vite → `immutable, max-age=31536000`; `index.html` →
  `no-cache`).

Note: the relay's `request-snapshot` flow means the overlay needs no warm-up beyond connecting.

### server.mjs assembly
```
import http from 'node:http';
import { attachOverlayRelay } from './overlay-relay.mjs';
import { serveStatic } from './static.mjs';

const PORT = Number(process.env.HKL_OVERLAY_PORT || process.argv[2] || DEFAULT_PORT);
const ROOT = <abs path to embedded/>;
const server = http.createServer((req, res) => serveStatic(req, res, ROOT));
const relay = attachOverlayRelay(server, '/overlay-ws');
server.on('upgrade', (req, socket, head) => {
  if (relay.owns(req.url || '')) relay.handleUpgrade(req, socket, head);
  else socket.destroy();         // only the relay does WS here
});
server.listen(PORT, '127.0.0.1', () => console.log(`HKL overlay host → http://127.0.0.1:${PORT}/?overlay`));
```
Bind `127.0.0.1` (loopback only) — the relay is local-machine only; no reason to expose on LAN.

### Port choice
Avoid 5170–5176. Pick a fixed memorable default — **recommend `5190`** (`HKL_OVERLAY_PORT`).
Overridable via `HKL_OVERLAY_PORT` env or first CLI arg (`node src/server.mjs 5191`). This default
is the number the Netlify build hardcodes (see §4), so it must be stable. Document it in the app
README.

---

## 4. Client URL logic

### `packages/bridge/src/overlay-protocol.ts`
Add a constant beside `OVERLAY_WS_PATH`:
```ts
/** Default port the standalone overlay host (apps/overlay-host) listens on.
 *  A remote-origin (Netlify) performer dials ws://127.0.0.1:<this>/overlay-ws. */
export const OVERLAY_RELAY_PORT = 5190;
```

### `packages/bridge/src/overlay-ws.ts` — constructor URL logic
Replace the unconditional same-origin URL build with origin-aware logic:

```ts
constructor(path: string = OVERLAY_WS_PATH) {
  const host = location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (isLocal) {
    // dev-proxy (5170) AND the distributable (5190) both host the relay same-origin.
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = `${scheme}//${location.host}${path}`;
  } else {
    // Remote origin (Netlify) in Firefox: dial the local overlay-host relay.
    // Firefox permits ws://127.0.0.1 from an https page (loopback mixed-content exempt)
    // and does not enforce Chrome's Local Network Access.
    const port = readPortOverride() ?? OVERLAY_RELAY_PORT;
    this.url = `ws://127.0.0.1:${port}${path}`;
  }
  this.connect();
}
```
- `readPortOverride()`: optional advanced-user escape hatch — read
  `localStorage.getItem('hklOverlayPort')`, parse int, validate 1–65535, else `null`. Documented,
  not surfaced in UI.
- Keep `OverlayMsg`/exports unchanged. `@hkl/bridge` stays DOM-free? It already references
  `location`/`WebSocket` in `overlay-ws.ts` (browser client). Adding `localStorage` is consistent
  with that file's existing browser assumptions — fine, and the boundary check doesn't care about
  DOM globals.

### Robustness when no relay answers (public Netlify visitor concern)
A public visitor who never runs OBS must not hammer localhost forever. The publisher currently
auto-reconnects with capped backoff *indefinitely* once `setOverlayPublishing(true)`. New policy:

- Add a **bounded initial-connect retry**: if the socket has **never successfully opened**, give up
  after N attempts (recommend N=5, reaching the 5 s cap → ~15 s total) and stop quietly. Track a
  `everOpen` flag; in `scheduleReconnect()`, if `!everOpen && attempts >= N`, set `this.closed`
  (or a `gaveUp` flag) and stop.
- **Once `everOpen` is true** (a relay was present at least once → this is a real OBS session),
  keep reconnecting indefinitely as today (performer reload / host restart should recover).
- The subscriber (`?overlay`, always local origin) should keep retrying indefinitely — it's only
  ever loaded inside OBS where the host is present. Gate the give-up behavior to the publisher path
  (e.g. a constructor option `{ giveUpIfNeverOpened: boolean }`, true for publisher, false for
  subscriber). This keeps the public-visitor cost to a bounded ~15 s of localhost dialing, then
  silence.

---

## 5. Drop the publisher checkbox → auto-connect

The subscriber already auto-connects (`overlay-subscribe.ts:105` `new OverlayChannel()` at module
load). Make the **publisher** auto-start too, and remove the toggle/pref.

### Remove
- `apps/hkl/index.html:364` — the `<label><input id="cbObsOverlay">…</label>` checkbox. (Note:
  `apps/hkl/dist/index.html` is a build artifact — regenerated, don't hand-edit.)
- `apps/hkl/src/ui/init.ts:98` — `$('cbObsOverlay').checked = p.obsOverlay;` restore line.
- `apps/hkl/src/ui/init.ts:380–387` — the `cbObsOverlay` `change` listener.
- `apps/hkl/src/ui/init.ts:518–523` — the `if (prefs.obsOverlay) { setOverlayPublishing(true); … }`
  restore block (replaced by unconditional auto-start, see below).
- `apps/hkl/src/ui/tooltips.ts:46` — the `cbObsOverlay` tooltip entry.
- `apps/hkl/src/state/persistence.ts` — the `obsOverlay: boolean;` field (line 146 + its doc
  comment 143–145), the `obsOverlay: false` default (line 190), and the validation block
  (lines 335–338).

### Add — auto-connect
In `apps/hkl/src/ui/init.ts`, replace the removed restore block with an unconditional start near
the existing bridge init (after `initHklBridge()`):
```ts
/* OBS overlay: always publish render state to the local relay. Harmless when no
   relay is present — OverlayChannel gives up quietly after a bounded retry
   (see overlay-ws.ts) and only sustains a connection if an overlay host answers. */
setOverlayPublishing(true);
publishComposerView(prefs.composerView);
```
`setOverlayPublishing` / `publishComposerView` are already imported (init.ts:69) — keep those
imports. The diff-gated `overlayPublishTick()` at end of `draw()` is unchanged. No-op cost when
the channel gave up: `channel` stays non-null but its socket is closed; `send()` buffers ≤32 then
drops. Acceptable; optionally null out `channel` on give-up so `overlayPublishTick`'s
`if (!channel) return;` short-circuits — **recommend** wiring give-up to also tear down so the tick
is a true no-op for public visitors.

Decision check: auto-start means every production-HKL load opens a localhost WS attempt. With the
bounded give-up (§4) this is ~15 s of quiet dialing for a non-OBS visitor, then nothing. Confirmed
acceptable per the task's stated policy.

---

## 6. Distribution packaging (v1)

Artifact = `apps/overlay-host/` after the assemble step:
```
apps/overlay-host/
  src/{server,static,overlay-relay}.mjs
  embedded/            # full copy of apps/hkl/dist (index.html, assets/, BravuraText.woff2, samples/)
  package.json
```
Run command (from the app dir, with `ws` installed):
```
node src/server.mjs           # or: HKL_OVERLAY_PORT=5191 node src/server.mjs
```
For a true "hand someone a folder" distributable, ship `apps/overlay-host/` plus a pruned
`node_modules` containing only `ws` (`pnpm deploy` or `npm pack` of just this app). v1 keeps it
simple: the OBS user has Node, runs `pnpm --filter @hkl/overlay-host start` from the repo, OR we
zip `src/ + embedded/ + a vendored ws/`. Recommend documenting the `node src/server.mjs` path and
deferring polish.

**OBS user steps:** run the host → in OBS add Browser Source URL `http://127.0.0.1:5190/?overlay`,
set width/height to the stream canvas, custom CSS none (page is already transparent/chrome-free).
The performer opens production HKL (Netlify) in Firefox; publishing auto-starts and dials
`ws://127.0.0.1:5190/overlay-ws`.

**Verovio WASM** is CDN-loaded by the composer-frame inside the overlay page → needs internet.
Fine for a streaming machine (already online). No change needed; note it in the README so an
offline user isn't surprised by a missing score render. (Bundling Verovio locally is out of scope.)

### Future (note only, do NOT implement)
Single-executable: `bun build --compile src/server.mjs` or Node SEA. Both need the static assets
either embedded (Bun can embed files; SEA needs an asset blob / `fs` from a bundled dir) — the
`static.mjs` root resolution would switch from `embedded/` on disk to an embedded VFS lookup. `ws`
must be bundleable (it is). Defer.

---

## 7. Verification

Gates (run all before claiming done):
- `pnpm typecheck` — root `tsc --noEmit`. New app ships `.mjs` only → nothing for tsc; the
  `overlay-protocol.ts` / `overlay-ws.ts` edits + HKL deletions are the typed surface.
- `pnpm -r build` — must still pass; the new app's `build` is a no-op (embedding is the separate
  assemble step), so `-r` ordering is unaffected.
- `pnpm check:boundaries` — confirm `apps/overlay-host` passes (no `@hkl/*` imports; only relative
  in-project `.mjs` + `ws` + builtins). Confirm `vite/dev-proxy.mjs`'s new relative reach is NOT
  flagged (vite/ unscanned).

Functional:
1. **Dev unchanged:** `pnpm dev` → open `http://localhost:5170/?overlay` (subscriber) and a second
   `http://localhost:5170/` (publisher, now auto-connecting). Confirm lattice/keys/score mirror.
   The dev relay is now imported from the app path — confirm the dev-proxy startup log still shows
   `/overlay-ws`.
2. **Distributable:** `pnpm --filter @hkl/hkl build && pnpm assemble:overlay-host &&
   pnpm --filter @hkl/overlay-host start`. Open `http://127.0.0.1:5190/?overlay`. Then a second
   instance as publisher — for a real round-trip, point a production-like HKL at it. To test the
   remote-origin dial without Netlify, serve HKL on a non-localhost hostname (e.g. a LAN IP or
   `0.0.0.0` build preview) so `isLocal` is false and the client dials `ws://127.0.0.1:5190` — or
   temporarily set `localStorage.hklOverlayPort` to confirm the override path.
3. **No-relay give-up:** load production HKL with no host running; confirm DevTools shows ~5
   bounded WS attempts then silence (no infinite reconnect spam) and no console errors.
4. **Existing harness:** `test/overlay-inspect/` — run it against both the dev relay and the new
   host to confirm protocol parity (the relay code is byte-identical post-move).

---

## Files summary

**Add**
- `apps/overlay-host/package.json`
- `apps/overlay-host/src/overlay-relay.mjs` (moved from `vite/overlay-relay.mjs`)
- `apps/overlay-host/src/server.mjs`
- `apps/overlay-host/src/static.mjs`
- `vite/assemble-overlay-host.mjs`
- `apps/overlay-host/README.md` (run instructions, port, Verovio/internet note)
- `.gitignore` entry: `apps/overlay-host/embedded/`

**Modify**
- `vite/dev-proxy.mjs` — import relay from `../apps/overlay-host/src/overlay-relay.mjs`
- `packages/bridge/src/overlay-protocol.ts` — add `OVERLAY_RELAY_PORT`
- `packages/bridge/src/overlay-ws.ts` — origin-aware URL + bounded give-up (publisher-gated)
- `apps/hkl/src/bridge/overlay-publish.ts` — (if doing the tear-down-on-give-up) accept/forward
  the give-up option; minor
- `apps/hkl/src/ui/init.ts` — remove checkbox restore + listener + restore block; add
  unconditional `setOverlayPublishing(true)`
- `apps/hkl/src/ui/tooltips.ts` — remove `cbObsOverlay` entry
- `apps/hkl/index.html` — remove checkbox
- `apps/hkl/src/state/persistence.ts` — remove `obsOverlay` field/default/validation
- root `package.json` — add `"assemble:overlay-host"` script
- `pnpm-workspace.yaml` `allowBuilds` — confirm `ws` doesn't need an install-script grant (it's
  pure JS; no native build) — no change expected

**Delete**
- `vite/overlay-relay.mjs`

---

## Risks / gotchas
- **Build ordering** is the main trap: do NOT embed inside `pnpm -r build` (unordered for a
  dep-less app). Use the explicit assemble step. Stated as the recommended approach in §1.1.
- **`dist/index.html` is generated** — editing the source `apps/hkl/index.html` is enough; don't
  touch `apps/hkl/dist/index.html`.
- **Port coordination**: `OVERLAY_RELAY_PORT` (client default) and the host's `DEFAULT_PORT` must
  match and stay stable, because Netlify bakes the client default in. Single source: define the
  number in `overlay-protocol.ts` and have `server.mjs` import it? server.mjs is `.mjs` and
  `overlay-protocol.ts` is TS in `@hkl/bridge` — importing it would add an `@hkl/bridge` dep and a
  build step. Simpler: **duplicate the literal `5190` in `server.mjs` with a comment pointing at
  `OVERLAY_RELAY_PORT`**, accept the tiny duplication (it changes ~never). Flag if Max prefers the
  dep.
- **Firefox-only performer** is a hard constraint from the LNA research — document prominently;
  Chrome/OBS-CEF as the *performer* would be blocked. The overlay (subscriber) in OBS-CEF is fine
  because it's local→local.
- **Auto-connect on public Netlify**: bounded give-up is what makes this acceptable; verify it
  actually stops (§7.3) — an infinite-reconnect regression here would have every public visitor
  silently dialing localhost forever.
