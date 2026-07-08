# HKLE as a standalone package — extraction initiative

Living tracker for lifting `@hkl/engine` (HKLE) out of the HexKeyLab monorepo into a
standalone, publishable package, and reusing it in unrelated apps. Update incrementally.

## Why

HKLE already does, robustly and click-free, exactly what Intonalogy needs: render
just-intonation chords and retune them in real time. The end goal is to replace
Intonalogy's bespoke audio stack with HKLE and upgrade its instrument samples from
1-cycle waveform approximations to real **`.hki` bundles** (sustained samples with
analyzer-computed loop segments). Cleaning up Intonalogy's platform-specific audio code
is a welcome side effect, not the main motivation.

## How HKLE stays portable

- Pure DI: `init(audioCtx, destNode, config)` takes the Web Audio context + a config of
  host hooks (`instrumentProvider` for `.hki` bytes, `velocityToGain`, `onSeamEvent`,
  `audioFetch` for URL loading). No DOM / window / MIDI / storage; no Vite coupling.
- Click-free looping is HKLE's invariant: never `source.loop=true`; loops are discrete
  one-shot `BufferSource`s crossfaded at segment seams on the audio clock. Half the
  quality is the engine; the other half is the HKL **analyzer** finding good loop points.

## Phase 1 — Web app (browser-React) — DONE (2026-06-22)

The package builds and is proven in a browser-React app. `pnpm --filter @hkl/engine build`
(tsup) emits a self-contained `dist/` (`@hexkeylab/engine`: ESM + CJS + `.d.ts`, `@hkl/shared`
bundled in, `fflate` the sole external dep). Publish with `npm publish packages/engine/dist`.

Acceptance met: `test/react-consumer/` (a React app linking the **built** package) imports it,
runs `init()` against a real `AudioContext`, decodes a sample, plays a JI triad, and retunes
via `sRampFreq` — green in a headless-Chromium gate (`pnpm --filter @hkl/react-consumer smoke`).
HKL-side audio behavior (loop crossfades / aftertouch / transpose-glide / `.hki` playback)
confirmed unchanged by-ear after the Iowa removal + `audioFetch` refactor (2026-06-22).

**Effort parked here for now.** The only remaining Phase-1 action is the operational publish
itself: claim the `@hexkeylab` org on npm (the name is final), then `npm publish
packages/engine/dist`. Nothing in code is blocking.

## Phase 2 — React Native (Intonalogy) — FUTURE, gated on Android spike

Target: one HKLE-driven `react-native-audio-api` (RNAA) implementation across
iOS/web/Android; retire the Android SoundPool Expo module and the duplicate `.android.ts`
files; upgrade Intonalogy timbres to `.hki` bundles produced by the HKL analyzer.

**Verified (RNAA 0.10.1 typings):** full HKLE surface present —
`AudioBufferSourceNode.start(when, offset, duration)`, overlapping independent sources,
audio-clock `AudioParam` ramps (set/linear/exponential/target/curve), `playbackRate`
ramps, `StereoPannerNode`, and **native `cancelAndHoldAtTime`** (HKLE's Firefox polyfill
becomes unnecessary, harmless). Native C++ engine → scheduling off the JS thread, the
prerequisite for sample-accurate crossfades.

**Root cause of the old Android click:** `source.loop=true` hard-cutting at the seam,
maximized by ~1-cycle samples. HKLE sidesteps this by construction (scheduled crossfades),
independent of platform — *if* RNAA honors future-scheduled `start(when)`/ramps
sample-accurately on Android.

**THE GATE — Android device spike (~1 hr):** drive HKLE's segment-crossfade loop against a
sustained `.hki` sample on a physical Android device via RNAA; confirm click-free seams +
accurate scheduling. **Do not delete any native code until this is green.** This spike is
the entire gate for Phase 2.

**Sample story:** feed `.hki` bytes via `instrumentProvider` (expo-asset / file-system);
real-time JI retuning via `sRampFreq` / `sNoteOnFaded`.

## Resolved decisions (2026-06-22)

- **Published name: `@hexkeylab/engine`** — final. (`@hexkeylab` org still to be claimed on npm.)
- **License: MIT** — final (`packages/engine/LICENSE`, baked into `dist/package.json`).
- **`@hkl/shared` is bundled into the engine build**, not published separately. `fflate` stays
  the single external dependency (so each consumer's bundler picks the right fflate build).

## Engine 2.0.0 — instrument is per-voice (2026-07-07)

Removed the global "current instrument" anti-pattern: `sNoteOn`/`sNoteOnFaded` take an explicit
`instrumentKey`, each voice remembers its instrument, and `setInstrument`/`isLoaded` are gone.
Multiple instruments now sound simultaneously with no set-before-trigger. Fixed at the source in
both the engine and HKL (317/317 composer, incl. multi-instrument). See decisions.md "instrument
per-voice". Breaking → **2.0.0**.

## Phase 1.5 — MusiQuest POC handoff (browser) — READY

First real consumer: MusiQuest (`~/musiquest-mono`, browser React 19 / Vite / Nx, Howler-based
`SoundPlayer`). Handoff doc + staged instruments delivered:
- **`docs/musiquest-handoff.md`** — full HKL-engine briefing (API, share `Howler.ctx`, adapter,
  gotchas, acceptance).
- **`handoff/musiquest/`** — Violin, Trombone, Baritone Voice as self-contained `.hki` + def JSONs
  (bundles git-ignored/regenerable; defs committed). Consumed via `source:'hki-shipped'` — engine
  fetches + unzips internally, MusiQuest writes no unzip code.

Implementation is delegated to a MusiQuest-context agent.

## Open items

- Operational: claim `@hexkeylab` on npm + publish **2.0.0** (`npm publish packages/engine/dist`).
- Phase 2 (React Native / Intonalogy) — gated entirely on the Android device spike.
