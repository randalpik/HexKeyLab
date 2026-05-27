# HexKeyLab

Live at **<https://hexkeylab.maxrandalmusic.com>**.

A browser-based visualizer, audio engine, and Lumatone controller for hexagonal isomorphic
keyboards in just intonation. HexKeyLab renders the hex lattice across six tuning systems (Equal,
Ptolemaic, Pythagorean, Semiditonal, Septimal, Schismatic), plays through sample-based instruments
and oscillators with proper JI tuning, analyzes intervals and chords with full comma decomposition,
records performances (`.hkr`) and round-trips them as MPE `.mid`, and transcribes them to sheet
music. With a Lumatone connected it lights keys to match the on-screen colors, handles polyphonic
aftertouch, and calibrates the expression pedal over SysEx.

A3 = 220 Hz; the Harmonic Table maps the q-axis to major thirds (5:4) and the r-axis to fifths
(3:2). The lattice slides under a fixed Lumatone MIDI mapping based on the reference note — all
tuning/layout interpretation is runtime software state.

This README is for contributors. End users want the live link above; players' docs are in
[`docs/user-guide.md`](docs/user-guide.md).

## Repo structure

A **pnpm monorepo**. There is no top-level `src/`.

```
apps/
  hkl/        core viewer/player        (@hkl/hkl)
  composer/   score editor              (@hkl/composer)
  analyzer/   sample analyzer UI + CLI  (@hkl/analyzer)
packages/
  shared/     @hkl/shared    pure data: tuning math, note naming, segments, dynamics, hki, colors
  engine/     @hkl/engine    sample playback (loop scheduling, crossfade, velocity)
  notation/   @hkl/notation  Verovio/MEI rendering
  bridge/     @hkl/bridge    BroadcastChannel protocol + message types
test/         test suites + verification tooling (composer-test, bounds-probe, …)
tools/        hardware/ops (lumatone-cal)
docs/         architecture/, user-guide, lessons, decisions, lumatone-calibration
```

Dependency DAG: `@hkl/shared ← {engine, notation, bridge} ← apps`, enforced by
`pnpm check:boundaries`.

## Getting started

Requires Node 20+ and **pnpm** (`npm i -g pnpm`).

```bash
pnpm install
pnpm dev          # dev umbrella → http://localhost:5170
```

`pnpm dev` spawns the three app dev servers (each with scoped HMR) behind a single-origin reverse
proxy: **HKL at `/`, Composer at `/composer/`, Analyzer at `/analyzer/`**. The shared origin is
required — the HKL↔Composer/Analyzer `BroadcastChannel` bridge and the `IndexedDB` instrument
registry are per-origin. To run one app standalone: `pnpm --filter @hkl/<app> dev`.

## Build & check

```bash
pnpm -r build            # build every app to its own dist/
pnpm typecheck           # one root tsc --noEmit over apps + packages
pnpm check:boundaries    # enforce the package dependency DAG
pnpm test:composer       # Composer test suite (needs `pnpm dev` running)
pnpm analyze <config>    # Analyzer CLI: generate an instrument from a config
```

**Browser**: Firefox is the primary target. Web MIDI in Firefox needs a secure context (localhost
or HTTPS); `file://` doesn't work. Chromium also works for testing.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — entry point for AI-assisted sessions (agent guardrails + navigation).
- [`docs/architecture.md`](docs/architecture.md) + [`docs/architecture/`](docs/architecture/) —
  source-of-truth reference: overview + per-app deep-dives (hkl, composer, analyzer, engine).
- [`docs/user-guide.md`](docs/user-guide.md) — end-user guide for the HKL viewer.
- [`docs/lessons.md`](docs/lessons.md) — gotchas, anti-patterns, hard-won truths.
- [`docs/decisions.md`](docs/decisions.md) — append-only log of non-obvious design choices.
- [`docs/lumatone-calibration.md`](docs/lumatone-calibration.md) — per-key hardware calibration.

## Companion apps

- **HKL Composer** (`/composer/`) — keyboard-driven, Verovio-backed score editor that uses HKL as
  its input device over the bridge. Edits `.hkc` standalone; needs HKL connected for held-chord
  entry.
- **HKL Analyzer** (`/analyzer/`) — builds instruments from audio: a browser UI plus a Node CLI
  (`apps/analyzer/cli/`, run via `pnpm analyze`) that batch-generates loop/gain data and `.hki`
  bundles. Dev-facing.

## Connecting a Lumatone

Plug in, click Auto-sync. HKL pushes a fixed `(channel, note)` mapping once, then only color
updates ride the SysEx wire.

> **Note**: the SysEx board map `[1, 2, 3, 5, 4]` in `apps/hkl/src/lumatone/protocol.ts` is
> hard-coded for Max's unit, on which physical boards 3 and 4 are swapped. Other units may need
> this adjusted.
