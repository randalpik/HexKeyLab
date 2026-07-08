# Audio engine — `@hkl/engine`

The sample playback library: voice lifecycle, loop scheduling, and segment crossfades. Host-injected and self-contained — owns no HKL app/state/MIDI/UI. Part of [the HexKeyLab architecture](../architecture.md).

## Package shape

`packages/engine/src/`:

- `samples-engine.ts` — voice lifecycle + loop/segment scheduling.
- `segmentLooper.ts` — single-voice multi-segment crossfade chain helper.

Depends **only** on `@hkl/shared`. The HKL app wires it up through the barrel `apps/hkl/src/audio/samples.ts`.

**Library vs. host boundary.** This doc covers the audio engine as a whole, but two layers are involved: the **library** (`packages/engine` — sample-voice lifecycle, loop scheduling, segment crossfade) and the **HKL host audio layer** (`apps/hkl/src/audio/engine.ts`) that drives it. Oscillator synthesis (sine/square/triangle), the damper/pedal model, polyphonic-aftertouch shaping, and the layout/tuning/transpose frequency-ramp orchestration are all **host-side** — their constants (`DAMPER_SMOOTH_TAU`, `AFTERTOUCH_RAMP_S`, the oscillator amplitudes, the ramp durations) live in `apps/hkl/src/audio/engine.ts` and `effects/`, not in `packages/engine`. The library exposes the per-voice primitives those features call; it has no oscillators and no pedal/AT logic of its own.

## Host injection (DI)

`init(ctx, dest, config?)` takes the `AudioContext`, a destination `AudioNode`, and an optional `SampleEngineConfig`:

| Field | Purpose | Default |
|---|---|---|
| `instrumentProvider(key)` | `Promise<{file → bytes}>` for imported (`hki`) instruments | none |
| `velocityToGain(v)` | musical velocity (0–127) → linear gain | bare `v/127` |
| `onSeamEvent(ev)` | sink for loop-seam crossfade diagnostics | none |
| `audioFetch(url)` | `Promise<ArrayBuffer>` for CDN sample URLs + shipped `.hki` bundle URLs | global `fetch` |

`audioFetch` is the last I/O seam: the engine never references a bundler-specific global (the old Vite `import.meta.env.DEV` Iowa-rewrite is gone — see decisions.md "Iowa runtime fetch removed"). A non-browser/RN host can inject byte loading (e.g. resolving expo-asset URIs) without the engine assuming `fetch`. `loadInstrument` also accepts typed `InstrumentDef` / `SampleDef` (exported) instead of `any`.

`loadInstrument(key, instrDef, onProgress?)` takes the instrument **definition** — the host injects it. The barrel passes `INSTRUMENTS[key]` (the HKL-side Proxy merging shipped + imported bundles); the engine never reaches into the registry itself. Loaded instruments coexist in a keyed `buffers` map — there is no "current instrument".

**Instrument is per-voice, not global.** `sNoteOn(voiceKey, freq, velocity, instrumentKey, startAt?)` (and `sNoteOnFaded(..., instrumentKey, ...)`) take the instrument explicitly; each voice records it (`v.instr`), so `sNoteOff`/aftertouch/ramp resolve the *voice's* instrument. Multiple instruments therefore sound simultaneously with no mode-setting — the HKL host tracks its own `audio.activeWaveform` (what live input plays) and per-voice `activeOscs[key].instr`, and passes the key in at each trigger. (There is no `setInstrument`/`isLoaded`; a former global-`currentInstrument` design required set-before-every-note — see decisions.md "instrument per-voice".)

→ see decisions.md "engine dependency injection"

## Signal path

```
sample → segGain (crossfade) → voiceGain (envelope) → damperGain → pressureGain → master
osc    →                       gain      (envelope) → damperGain → pressureGain → dest
```

- `damperGain` — continuous-damper node (default 1.0; ramped via `setTargetAtTime` while the key is in `sustainedKeys`; pinned to 1.0 for sostenuto-locked keys).
- `pressureGain` — polyphonic aftertouch node (default 1.0).

Both sit downstream of the release envelope so neither modulation fights `voiceGain`/`gain` cancel-schedule patterns.

Gain constants: `sampleMaster = 1.0`, `oscGain = squareGain = 1.0` (pass-through; per-waveform amplitude lives in per-note `vol`). Damper smoothing `DAMPER_SMOOTH_TAU = 0.025` (≈25ms τ); below `DAMPER_RELEASE_FLOOR = 0.005` depth, sustained voices not protected by sostenuto are released.

### Per-sample gain normalization

Every sample carries a precomputed linear `gain` bringing its RMS to **−18 dBFS** with a single-voice peak ceiling of −3 dBFS. Applied once at `sNoteOn` (`vol *= nearest.gain`). Oscillator amplitudes are baked into per-note `vol` (sine ≈ 0.1779, triangle ≈ 0.2179, square ≈ 0.1259, so steady-tone RMS = TARGET_RMS); low-frequency Fletcher-Munson boost on sine/triangle preserved. Values computed by `apps/analyzer/cli/backfill-gains.js`. → see decisions.md "−18 dBFS RMS normalization"

### Range attenuation

`rangeAttenuation` tapers volume above the highest sampled note in an instrument.

## Voice anchors (wrap-aligned segment switching)

Per-voice: `sourceStartTime`, `sourceStartOffset`, `sourceLoopA`, `sourceLoopB`, `sourceLoopAIdx`, `sourceLoopBIdx`, `sourceRate`.

- All wraps go through `scheduleSegmentSwitch`; `source.loop = true` is **never** used.
- Switch picks `b` (next wrap), then uniformly picks `a` from `validStartsByEnd[b]`.
- Linear **30ms equal-power crossfade**. `doImmediateSwitch` handles wrap-during-ramp.

## Frequency ramping

| Trigger | Duration |
|---|---|
| Layout switches (`animDuration`) | 500ms — sustained instruments glide, decaying instruments stop+retrigger |
| Tuning/seam changes (`rampActiveFreqs()`) | 150ms |
| Transpositions | 100ms |

`commitRampSync` integrates any in-flight ramp before starting a new one; a `pendingRamp` identity check cancels stale re-anchors, and a position-based wrap check fixes the stale-anchor race in rapid `sRampFreq` calls.

## Polyphonic aftertouch

Per-voice `pressureGain` modulated by poly AT (0xA0), as a **continuous swell upward from the strike volume**. `aftertouchTargetGain(pressure, strikeVel)` (`audio/aftertouch.ts`) is dB-linear in pressure: `(ceilGain / baseVol(strikeVel)) ^ (pressure/127)`, where `ceilGain = baseVol(127) · 10^(AFTERTOUCH_CEIL_HEADROOM_DB/20)` is a common ceiling sitting `AFTERTOUCH_CEIL_HEADROOM_DB` (default 12 dB) **above** the loudest strike. So pressure 0 → gain 1.0 (continuous with the strike, no gate-open jump), and full press → that ceiling regardless of strike — every strike swells (a v127 strike by exactly the headroom; softer strikes more, converging to the same ceiling). The headroom is for voicing; the master limiter (−3 dBFS, ratio 20) absorbs the peak. Decaying instruments (piano/harp, `instrDecays()`) skip AT entirely.

On an AT message the gain ramps from its in-flight value to the new target with `AFTERTOUCH_RAMP_S` smoothing; `inflightExpRampValue` is exported as the host's pre-call anchor polyfill (Firefox lacks `cancelAndHoldAtTime`). The input is gated by `filterPA` (hysteresis open>5/close<2) to reject the sensor's 0↔1 onset flicker.

## Pedal semantics

Two pedal jacks feed a unified damper-depth model plus an optional sostenuto layer. CC 4 (expression jack) is continuous; CC 64 (sustain jack) is binary. The Pedals dropdown selects what CC 64 does:

- **Sustain** (default): both jacks contribute to damper depth, combined as `max(cc4, cc64)` into `audio.damperDepth`. CC 64 alone = classic binary sustain; CC 4 = continuous damper.
- **Sostenuto+Sustain** (continuous pedal plugged in): CC 4 is the only damper source. CC 64 toggles a sostenuto layer that snapshots `selection.selectedKeys` into `audio.sostenutoLockedKeys`; locked notes ride through subsequent damper changes.

Engine API:

- `setDamperDepth()` — recomputes `damperDepth = max(cc4, cc64)`, updates `sustainPedalDown`, walks `sustainedKeys` applying new depth (skipping sostenuto-locked), releases keys when depth crosses below `DAMPER_RELEASE_FLOOR`.
- `sostenutoOn()` — snapshots locked set; pins those voices' `damperGain` to 1.0 immediately (no ramp).
- `sostenutoOff()` — clears the set; re-applies current depth or releases each previously-locked key still in `sustainedKeys`.

Continuous-damper behavior is **gain-based**, not release-time-based: `damperGain` attenuates sustained ringing by `(1 − depth)`, so half-pedaling attenuates in real time rather than deferring a decay rate. Sostenuto-locked keys are exempt (`damperGain` stays 1.0), matching the physical rod lifting dampers off locked strings. → see decisions.md "gain-based continuous damper"

Re-articulation: striking a sustained key triggers `noteOff` + new voice + flash; the new voice gets fresh `damperGain = 1.0`, and the note-off path re-applies current `damperDepth` when it re-enters `sustainedKeys`.

(Mode-dropdown re-evaluation of held CC 64 and the Pedals UI wiring live HKL-side in `apps/hkl/src/ui/init.ts`.)

## Velocity architecture

`audio.keyVelocity[key]` holds a **canonical musical velocity (0–127)** — "how hard the player struck," device-normalized. Three stages:

1. **Input normalization → musical velocity** (per device, at input time, HKL-side):
   - Lumatone: `applyInputCurve(applyPerKeyGain(...))` — per-key hardware gain then the target-gain curve, mapped raw → target gain → house-curve inverse → musical velocity, so `curveGain(applyInputCurve(d2)) === targetGain(d2)` exactly.
   - Piano / SP-250: identity (weighted keyboards already send musical velocity).
   - QWERTY / mouse / Composer / recording: `DEFAULT_DYNAMIC_MAP` / score dynamics, already musical.
2. **House curve** (audio time, device-independent): the injected `velocityToGain` (HKL's `velocityCal.curveGain` / `velocityBaseVol`, gentle — floor 0.05 / ceiling 1.0 / **γ 1.5**). No per-key prepass.
3. **External output**: `piano-out` sends `keyVelocity` unchanged so an external synth applies only its own curve — velocity round-trips.

→ see decisions.md "velocity-domain split" — covers why decompression moved to per-device input, the SP-250 round-trip fix, the `DEFAULT_DYNAMIC_MAP` remap, and `velocityCal version: 3` migration. `.hkr` is **not** migrated (pre-refactor recordings replay with shifted dynamics).

## `.hki` sample bundles

Self-contained instrument bundle (ZIP): analyzer-precomputed metadata + encoded audio in one file. Lets users import sample sets not on a public CDN without the source-and-paste workflow.

Format (canonical schema `@hkl/shared/hki.js`):

```
manifest.json                  // HkiManifest — instrument metadata + per-sample analyzer output
samples/<sample-name>.<ext>    // one audio file per kept sample
provenance.json                // optional — source URL/path, originalFiles, generator, createdAt
```

`HkiManifest` mirrors one `INSTRUMENTS` entry minus `baseUrl`; each sample carries its archive-relative `file`. Loop instruments keep `segments`/`trend`/`trimStart`; decay instruments keep `freq`/`gain`. Reader/writer use `fflate` (`zipSync`/`unzipSync`), identical in Node and browser.

**Audio encoding** (`apps/analyzer/cli/bundle.js`): lossy sources (`.mp3/.ogg/.opus/.aac/.m4a`) kept verbatim; `.wav/.aiff/.flac` → OGG/Opus 128 kbps via `ffmpeg -c:a libopus`; anything else verbatim.

**Production** (analyzer CLI): a config can set `"source": "local"` + `"sourceDir"`; `generate-samples.js` runs the same pipeline regardless of source and (for local, or `--bundle` on CDN configs) invokes `bundle.js:buildBundle` to write `<key>.hki`.

**Consumption** (HKL-side, `apps/hkl/src/state/instrumentRegistry.ts`): an IndexedDB `hkl-instrument-registry` DB (separate manifest/audio stores) exposes `init`/`listImported`/`importBundle`/`removeBundle`/`getAudio`/`reload`; init is awaited top-level before `applyPrefsToDom`. The barrel passes `getAudio` to the engine as `instrumentProvider`. `loadInstrument` branches on `instr.source === 'hki'`: awaits the audio map once, then reads per-sample from memory instead of `fetch()`. Decode + metadata-overlay paths are unchanged — CDN and HKI instruments produce identical voice records once loaded.

CDN-config import is a sibling path (JSON only, no bytes): the `INSTRUMENTS` Proxy falls through static map → HKI → CDN config, synthesizing a runtime-shaped entry that reuses the engine's standard CDN fetch — zero engine changes.

## Standalone verification

- `test/engine-smoke/` — Node proof that `@hkl/engine` imports and runs (`init()` against a stub `AudioContext`) with only `@hkl/shared` present, no HKL app modules.
- `test/react-consumer/` — browser proof: a React app that installs the **built** package and runs `init()` against a real `AudioContext`, decodes a synthetic sample, plays a JI triad, and retunes via `sRampFreq`. `pnpm --filter @hkl/react-consumer smoke` builds the engine, serves the app, and asserts the result in headless Chromium.

## Publishing as `@hexkeylab/engine`

The in-repo package stays `@hkl/engine` (private, raw-`.ts` subpath exports for Vite consumers). `pnpm --filter @hkl/engine build` (tsup) emits a self-contained `dist/` — ESM + CJS + `.d.ts`, with `@hkl/shared` **bundled in** and `fflate` left as the one external dependency (so each consumer's bundler picks fflate's `browser`/`node`/`react-native` build; bundling its Node ESM breaks browser/Metro). `dist/package.json` is generated by the build with the public name + a single `.` export. Publish with `npm publish packages/engine/dist` (NOT `publishConfig.directory` on the workspace package — that redirects the in-repo workspace link to `dist/` and breaks the raw-`.ts` consumers). See `docs/hkle-extraction.md` for the broader initiative (incl. the React Native phase).

## Other shared libraries

Dependency DAG: `@hkl/shared ← {@hkl/engine, @hkl/notation, @hkl/bridge} ← apps`.

- **`@hkl/shared`** (`packages/shared/src/`) — pure data only, no DOM/runtime state: freq/tuning math (`freq.ts`), note naming (`notes.ts`), segments, dynamics, `.hki` schema (`hki.ts`), colors, HEJI, CDN config.
- **`@hkl/notation`** — shared Verovio/MEI rendering ("spell a chord and engrave it"): WASM toolkit loader, grand-staff MEI builder, HEJI glyph passes. Used by Composer's full renderer and HKL's live staff inset.
- **`@hkl/bridge`** — the `BroadcastChannel('hkl-composer-bridge')` protocol and message types (`ResolvedNote`, `play-score`, etc.) linking HKL and Composer.
