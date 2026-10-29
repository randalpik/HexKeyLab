# HexKeyLab

Live at **<https://hexkeylab.maxrandalmusic.com>**.

A browser-based visualizer, audio engine, and Lumatone controller for hexagonal isomorphic
keyboards in just intonation. HexKeyLab renders the hex lattice in eight tuning systems (Equal,
Ptolemaic, Pythagorean, Semiditonal, Septimal, Schismatic, Syntonic, Polysyntonic) and three key
layouts (Euler, Wicki-Hayden, Chromatic), plays through sample-based instruments and oscillators in
exact just intonation, analyzes intervals and chords with full comma decomposition, records
performances (`.hkr`) and round-trips them as MPE `.mid`, and transcribes them to sheet music. With
a Lumatone connected it lights keys to match the on-screen colors, handles polyphonic aftertouch,
and calibrates the expression pedal and keys over SysEx.

A3 = 220 Hz. In the default Euler layout (the Harmonic Table) the q-axis is major thirds (5:4) and
the r-axis fifths (3:2). The lattice slides under a fixed Lumatone MIDI mapping based on the
reference note: all tuning and layout interpretation is runtime software state.

This README is for contributors. Players want the live link above; their docs are in
[`docs/guide/`](docs/guide/) (start with [`core.md`](docs/guide/core.md)), also served by the Guide
app.

## Repo structure

A **pnpm monorepo**. There is no top-level `src/`.

```
apps/
  hkl/          core viewer/player          (@hkl/hkl)
  composer/     score editor                (@hkl/composer)
  analyzer/     sample analyzer UI + CLI    (@hkl/analyzer)
  orchestrator/ MIDI-device sampler         (@hkl/orchestrator)
  guide/        the user guides as an app   (@hkl/guide)
  overlay-host/ OBS overlay distributable   (@hkl/overlay-host: Node relay + lean overlay build)
packages/
  shared/     @hkl/shared    pure data: tuning math, note naming, segments, dynamics, hki, colors
  engine/     @hkl/engine    sample playback (loop scheduling, crossfade, velocity); published as @hexkeylab/engine
  notation/   @hkl/notation  Verovio/MEI rendering
  bridge/     @hkl/bridge    BroadcastChannel protocol + message types
  analysis/   @hkl/analysis  the analyzer's DOM-free DSP
test/         test suites + verification tooling (composer-test, hkl-midi, engine-smoke, …)
tools/        Lumatone calibration and LED benchmark, OBS loop trimming, music-font build
docs/         guide/ (user-facing), architecture/ (dev reference), lessons, decisions, lumatone-calibration
```

Dependency DAG: `@hkl/shared ← {engine, notation, bridge} ← apps`, and `@hkl/analysis ← {analyzer,
orchestrator}`, enforced by `pnpm check:boundaries`.

## Getting started

Requires Node ≥ 22.13 and **pnpm** (`npm i -g pnpm`).

```bash
pnpm install
pnpm dev          # dev umbrella → http://localhost:5170
```

`pnpm dev` spawns the five app dev servers (each with scoped HMR) behind a single-origin reverse
proxy: **HKL at `/`, Composer at `/composer/`, Analyzer at `/analyzer/`, Orchestrator at
`/orchestrator/`, Guide at `/guide/`**. The shared origin is required: the
HKL↔Composer/Analyzer/Orchestrator `BroadcastChannel` bridges and the `IndexedDB` instrument registry
are per-origin. To run one app standalone: `pnpm --filter @hkl/<app> dev`. (The OBS overlay host is a
separate Node server, not part of the dev proxy: `pnpm overlay:host`; see Companion apps.)

## Build & check

```bash
pnpm build               # build every app to its own dist/
pnpm typecheck           # one root tsc --noEmit over apps + packages
pnpm check:boundaries    # enforce the package dependency DAG
pnpm test:composer       # Composer test suite (needs `pnpm dev` running)
pnpm analyze <config>    # Analyzer CLI: build an instrument from a config
```

More gates live under [`test/`](test/), each with its own README.

**Browser**: Firefox is the primary target. Web MIDI in Firefox needs a secure context (localhost
or HTTPS); `file://` doesn't work. Chromium also works for testing.

## Documentation

- [`docs/guide/`](docs/guide/): **user-facing guides** (how to use each app): core, composer,
  analyzer, orchestrator, overlay. Start with [`core.md`](docs/guide/core.md).
- [`docs/architecture.md`](docs/architecture.md) + [`docs/architecture/`](docs/architecture/):
  developer architecture reference: overview + per-app deep-dives (hkl, composer, analyzer,
  orchestrator, engine, overlay).
- [`docs/lessons.md`](docs/lessons.md): gotchas, anti-patterns, hard-won truths.
- [`docs/decisions.md`](docs/decisions.md): append-only log of non-obvious design choices.
- [`docs/lumatone-calibration.md`](docs/lumatone-calibration.md): numeric per-key Lumatone
  calibration.
- [`AGENTS.md`](AGENTS.md): entry point for coding agents (project context, constraints, verification).

## Companion apps

- **HKL Composer** (`/composer/`): keyboard-driven, Verovio-backed score editor that uses HKL as
  its input device over the bridge. Edits `.hkc` standalone; needs HKL connected for note entry.
- **HKL Analyzer** (`/analyzer/`): builds instruments from audio: a browser UI plus a Node CLI
  (`apps/analyzer/cli/`, run via `pnpm analyze`). See [`apps/analyzer/README.md`](apps/analyzer/README.md).
- **HKL Orchestrator** (`/orchestrator/`): samples a physical MIDI instrument into a
  velocity-layered `.hki`.
- **Guide** (`/guide/`): the user guides in `docs/guide/`, as tabs.
- **OBS overlay host** (`apps/overlay-host`): a small Node server that serves a lean, read-only
  transparent overlay (lattice + Composer view) and a WebSocket relay, so OBS can composite HKL over
  a performance video. `pnpm overlay:dist && pnpm overlay:host`, then add an OBS Browser Source at
  `http://127.0.0.1:5190/?overlay`. See [`docs/guide/overlay.md`](docs/guide/overlay.md) and
  [`docs/architecture/overlay.md`](docs/architecture/overlay.md).

## Connecting a Lumatone

Plug it in and tick Auto-sync. HKL pushes a fixed `(channel, note)` mapping once, then only color
updates ride the SysEx wire. On a unit whose boards 3 and 4 are physically swapped, tick **Swap
boards 3 ↔ 4** in Calibrate Keys (off by default).
