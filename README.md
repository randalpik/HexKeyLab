# HexKeyLab

A browser-based visualizer, audio engine, and Lumatone controller for hexagonal isomorphic keyboards in just intonation.

HexKeyLab renders the hex lattice with 5-limit JI, 7-limit JI, or 12-TET tuning, plays through 13 sample-based instruments (Salamander piano, FluidR3 strings and flute, FatBoy organs / clarinet / electric piano, VCSL chamber organ, nbrosowsky acoustic guitar) and oscillators, and analyzes intervals and chords with full comma decomposition. With a Lumatone connected, it lights the keys to match the on-screen colors, handles polyphonic aftertouch, and supports expression-pedal calibration over SysEx.

A3 = 220 Hz. The Harmonic Table layout maps the q-axis to major thirds (5:4) and the r-axis to fifths (3:2). Three layouts (♭ ♮ ♯) are pure software state — the Lumatone keeps a single fixed MIDI mapping; HKL interprets everything in software.

## Status

Pre-v1.0 (`0.10.0-dev`). Behavior is at v0.9 parity; the codebase has been migrated from a single ~4200-line HTML file into a modular TypeScript + Vite project. v1.0 will be the first publicly-hosted release.

## Running it

Requires Node 20+ and npm.

```bash
npm install
npm run dev      # http://localhost:5173
```

Other scripts:

- `npm run build` — produce a static bundle in `dist/`
- `npm run preview` — serve the built bundle for testing
- `npm run typecheck` — `tsc --noEmit`

### Browser

Firefox is the primary target. Web MIDI in Firefox requires a secure context (localhost or HTTPS); `file://` does not work. Chromium also works for testing.

### Connecting a Lumatone

Plug in, click Auto-sync. On first connection HKL pushes a fixed (channel, note) mapping to the device once, then only color updates ride the SysEx wire after that.

> **Note**: the SysEx board map `[1, 2, 3, 5, 4]` in `src/lumatone/protocol.ts` is hard-coded for Max's specific unit, on which physical boards 3 and 4 are swapped. Other units may need this adjusted.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — what HKL does and how the codebase is organized
- [`docs/lessons.md`](docs/lessons.md) — gotchas, anti-patterns, hard-won truths
- [`docs/decisions.md`](docs/decisions.md) — log of non-obvious design choices
- [`CLAUDE.md`](CLAUDE.md) — context for AI-assisted sessions

## Companion tool

`tools/HexKeyLab-analyzer.html` is a dev-only sidecar that generates the loop-point data baked into the sample instruments. Not shipped as part of HKL.
