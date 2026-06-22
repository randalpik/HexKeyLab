# @hkl/react-consumer — browser-React MVP gate

Proves the **built, published** `@hexkeylab/engine` artifact installs and runs in
an unrelated React app against a real Web Audio `AudioContext`. It depends on the
engine via `file:../../packages/engine/dist` — the real build output, not the
workspace raw-`.ts` source.

The app (`src/App.tsx`) on mount:
1. imports `@hexkeylab/engine`,
2. runs `init()` against `new AudioContext()`,
3. decodes a synthetic in-memory WAV through the `instrumentProvider` hook,
4. plays a just-intonation major triad (1/1, 5/4, 3/2 on A3),
5. retunes the third in real time via `sRampFreq()`,

and writes the outcome to `window.__SMOKE_RESULT`.

## Run

```sh
# 1. Build + install the engine artifact this consumer points at.
pnpm --filter @hkl/engine build && pnpm install

# 2a. Automated headless gate (builds, serves, asserts in Chromium):
pnpm --filter @hkl/react-consumer smoke

# 2b. Or open it for a by-ear check (audible Play / Retune / Stop buttons):
pnpm --filter @hkl/react-consumer dev
```

The headless gate exits non-zero if any step fails. The audible buttons need a
user gesture (browser autoplay policy), so they're for the manual `dev` path.
