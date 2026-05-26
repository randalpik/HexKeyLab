# HexKeyLab

Live at **<https://hexkeylab.maxrandalmusic.com>**.

A browser-based visualizer, audio engine, and Lumatone controller for hexagonal isomorphic keyboards in just intonation.

HexKeyLab renders the hex lattice with 5-limit JI, 7-limit JI, or 12-TET tuning, plays through ~15 sample-based instruments (Salamander piano, FluidR3 strings and flute, FatBoy organs / clarinet / electric piano, VCSL renaissance organ, nbrosowsky acoustic guitar) and oscillators, and analyzes intervals and chords with full comma decomposition. It records performances and exports them as MPE `.mid` files for editing in any DAW, then re-imports the edited result with full coordinate fidelity. With a Lumatone connected, it lights the keys to match the on-screen colors, handles polyphonic aftertouch, and supports expression-pedal calibration over SysEx.

A3 = 220 Hz. The Harmonic Table layout maps the q-axis to major thirds (5:4) and the r-axis to fifths (3:2). Three layouts (♭ ♮ ♯) are pure software state — the Lumatone keeps a single fixed MIDI mapping; HKL interprets everything in software.

## Status

v1.0 — first publicly-hosted release. The codebase migrated from a single ~4200-line HTML file into a modular TypeScript + Vite project (~57 modules under `src/`, strict end-to-end). Deployed continuously from `main` to Netlify.

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

## Companion tools

- **HKL Analyzer** (`/analyzer.html`) — user-facing tool for building your own instruments from local audio files or a CDN URL. Produces a `.hki` bundle (local samples) or a JSON config (CDN), importable into HKL directly via a same-origin bridge or via download → file picker.
- **HKL Composer** (`/composer.html`) — keyboard-driven music-notation editor that uses HKL as its input device.

Both are separate Vite entry points shipped alongside HKL. `analyzer/HexKeyLab-analyzer.html` is the legacy dev sidecar; the in-tree `/analyzer.html` supersedes it for end-user use, while the Node CLI under `analyzer/` remains the canonical pipeline for instruments shipped with the app.
