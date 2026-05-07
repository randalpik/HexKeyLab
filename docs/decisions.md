# HexKeyLab Decisions Log

Append-only log of non-obvious design choices. Each entry: what we picked, what we rejected, why, and where the decision lives in the code. Add an entry whenever a non-obvious call gets made; future sessions read this before re-litigating settled ground.

---

## Stack: TypeScript + Vite, vanilla DOM

**Picked**: TS + Vite + vanilla DOM, modular by domain. Strict TypeScript, no framework.

**Rejected**: React (rejected explicitly), Lit, Solid, jQuery, vanilla JS in the long run.

**Why**: HKL is mostly engine code (audio, MIDI, render, SysEx state machines) — not a UI app. The toolbar UI is small enough to not need a framework. React would have cost a build step, runtime weight, and a render-cycle abstraction we don't need. If a framework is later wanted *for the toolbar specifically*, Lit or Solid are the considered options.

**Where**: `package.json`, `tsconfig.json`, `vite.config.ts`. Module structure under `src/`.

---

## State pattern: plain objects + effects modules + encapsulated stores for invariant state

**Picked**: Three rules:

1. **Plain state objects** (`export const tuning = { curLayout, septimalEnabled, … }`) for domain state with no invariants beyond "this is the current value". Direct mutation. No setters.
2. **Encapsulated modules** (SampleEngine pattern, generalized) for state with invariants:
   - `lumatone/sysex.ts` — single-message-in-flight queue, ACK matching, busy-retry, predicted snapshot. Private state, public API (`enqueueControl`, `replaceQueue`, `cancel`, `handleResponse`, `query`, `inFlight`).
   - `render/animation.ts` — view animation state machine. Private start/target/animStart; public API (`tweenTo`, `step`, `progress`, `isAnimating`, `duration`).
3. **Effects modules** in `src/effects/` bundle the per-domain fan-out:
   - `onTuningChanged({ rampSec?, colorSync? })` — `rampActiveFreqs + view.hexDirty + draw + (syncLumatoneColors)`
   - `onLayoutChanged()` — `syncLumatoneColors + buildMidiReverse + syncOutput`
   - `onSelectionChanged()` — `syncOutput + draw`

   UI handlers mutate state then call **one** effect — replaces the 3-4 chained sync calls that used to live in every handler.

**Rejected**:
- Setter-function pattern (`setSeptimalEnabled(v)`) — verbose; required two function calls per mutation; setter is just `obj.x = v` in disguise.
- Reactive signals (`@preact/signals-core` or DIY) — adds a reactive abstraction that fights imperative engine code (audio voice mgmt, MIDI send), and HKL doesn't have enough fan-out points to justify the indirection.
- Single god-object store — loses module-level encapsulation; doesn't scale past ~10 domains.

**Why**: HKL has ~6 distinct fan-out points (tuning change, layout change, selection change, audio toggle, MIDI port change, sustain release) — small enough to express as named effect functions. Plain mutation keeps the call sites honest about what they're changing.

**Where**: `src/state/*` (7 plain objects), `src/effects/*` (3 effect functions), `src/lumatone/sysex.ts` + `src/render/animation.ts` (encapsulated stores).

---

## Single static Lumatone configuration in software, not per-layout LTN files

**Picked**: HKL configures the Lumatone *once* with a fixed (channel, note) → (board, key) mapping at the firmware level, and interprets all incoming MIDI in software. Layout switching is purely a software concern; the device's MIDI mapping never changes.

**Rejected**: Distributing per-layout LTN files (one per fingering — natural / flat / sharp) and having the user/Terpstra editor swap them.

**Why**: Layout switching needs to happen *during play* with no audible glitch. Pushing 280 CHANGE_KEY_NOTE messages on every layout switch (~6 seconds at typical SysEx throughput) would block all other communication and produce a visible "wipe". With software-side interpretation, layout switches are instant — only the LED color sync is deferred.

The fixed-MIDI mapping is set up *once* per device-connection in `lumatone/sync.ts` (gated by `lumatone.fixedLayoutSent`). After that, only LED color updates ride the SysEx wire.

**Where**: `lumatone/sync.ts` (initial setup batch), `midi/engine.ts:keyToMidi/buildMidiReverse` (software interpretation).

---

## Lumatone board map `[1,2,3,5,4]` is per-unit

**Picked**: Hard-code `sysexBoardMap = [1, 2, 3, 5, 4]` in `lumatone/protocol.ts`.

**Why**: Boards 3 and 4 are physically swapped on Max's specific Lumatone unit. The naïve `[1,2,3,4,5]` would light the wrong physical boards. Other units wouldn't necessarily need this swap. Documenting in CLAUDE.md (`Critical hardware context`) so a future contributor with a different unit can adjust.

**Where**: `lumatone/protocol.ts:sysexBoardMap`. Used by `lumatone/sync.ts` and the message-builder helpers.

---

## SysEx queue: Option B (in-place swap, in-flight completes naturally)

**Picked**: When a new color sync starts mid-flight, replace the queue but let the in-flight message complete naturally. The new diff folds the in-flight message's intended state into its diff via `sysex.inFlight` (the predicted snapshot).

**Rejected**: Cancelling the in-flight message (Option A) — caused stuck colors when an ACK landed after the new queue was built but before the diff incorporated the predicted state.

**Why**: SysEx ACKs are atomic — the device commits the message either fully or not at all. Cancelling mid-flight produces inconsistent device state. Letting messages complete + folding their intent into the next diff is race-free.

**Where**: `lumatone/sysex.ts:replaceQueue` (in-place swap), `lumatone/sync.ts` (predicted-snapshot trick using `sysex.inFlight`).

---

## Inline-handler bridge (Phase 1 holdover, removed 2026-05-04)

**Picked**: For Phases 1–3, kept `index.html` inline `onclick=`/`onchange=` attributes and exposed the relevant module-scoped handlers on `window` via `Object.assign(window, { … })` at the end of `ui/init.ts`. Removed in Phase 4.1 (2026-05-04) — `index.html` is now wired entirely through `addEventListener` in `ui/init.ts`, and the `Window` interface in `src/types.ts` no longer carries bridge functions (only `AudioContext`/`webkitAudioContext`, which are real platform globals).

**Why kept for the migration**: Removing required dropping 14 inline-handler attributes from `index.html` and adding `getElementById` + `addEventListener` calls in `ui/init.ts`. Mechanical but cross-cutting; kept the scope of Phase 3 to module structure + types.

**Where (post-removal)**: `src/ui/init.ts` ("Toolbar wiring" section, ~14 listener registrations), `index.html` (no inline handlers; one new id `btnResetPedal` was added on the calibration reset button).

---

## Strict TypeScript end-to-end (Phase 4 complete, 2026-05-04)

**Picked**: `tsconfig.json strict: true`, no `@ts-nocheck` anywhere in `src/`.

**History**: Phases 1–3 left two `@ts-nocheck` holdouts — `audio/samples.ts` (1494-line v0.9 IIFE) and `render/draw.ts` (538 lines). Both were converted in Phase 4 (4.2 and 4.3 respectively). Approach:

- **`render/draw.ts`** — single mechanical pass. Annotated top-level decls (`Set<string>`, `number[]`, `Record<KeyId, DrawnKey>`, etc.), function signatures, forEach/map callbacks, and 3 DOM-checkbox `as HTMLInputElement` casts. The `getContext('2d')` swap pattern (`savedCtx = ctx; ctx = gc; … ctx = savedCtx`) was kept — a typed local `gc` is used and assigned to `ctx` for the duration of the layer build. Zero-cost-blit invariant preserved.
- **`audio/samples.ts`** — pragmatic typing. The IIFE's logic is verbatim from v0.9; the SampleEngine encodes sample-loop invariants (no `source.loop = true`, all wraps via `scheduleSegmentSwitch`, `commitRampSync` integrates in-flight ramp position) that are hard to spot from types alone. Rather than over-specifying with deep voice-shape interfaces, internal helpers use `any` for parameters/voice objects and proper types only at module state, the public-API entry points, and the IIFE return surface. The inline cast in `audio/engine.ts` (`as typeof RawSampleEngine & { INSTRUMENTS: Record<string, InstrumentDef> }`) was removed — `INSTRUMENTS: Record<string, any>` is now declared inside samples.ts.

**Don't refactor SampleEngine internals without reading `lessons.md` first** — adding stricter types could tempt a future contributor to "clean up" the loop scheduler or ramp manager, both of which are tightly coupled through voice state.

**Where**: `tsconfig.json` (strict on, unchanged from Phase 3), `src/audio/samples.ts`, `src/render/draw.ts`, `src/audio/engine.ts` (cast removal).

---

## Pedal handling V1: continuous-damper as gain, sostenuto rides on `sustainedKeys`, manual mode dropdown (2026-05-05)

**Picked**: A small set of coupled choices in the pedal rework that replaced the v0.9 binary-CC4-as-sustain placeholder.

1. **Continuous damper = per-voice gain modulation**, not release-time modulation. A `damperGain` node is spliced into every voice graph between `voiceGain`/`gain` (release envelope) and `pressureGain` (aftertouch). While the key is in `sustainedKeys`, `engine.setDamperDepth()` walks the set and applies `setTargetAtTime(depth, now, 0.025)` to each voice's `damperGain`. When depth crosses below `DAMPER_RELEASE_FLOOR = 0.005`, the existing release pipeline runs.

2. **Sostenuto rides on `sustainedKeys`** rather than maintaining a parallel state machine. The note-off branch becomes `if (sustainPedalDown || sostenutoLockedKeys.has(key))` — both pedals push notes into the same set, and per-key membership in `sostenutoLockedKeys` decides whether damper changes attenuate that note.

3. **Manual mode dropdown** (Sustain / Sostenuto+Sustain) controls what CC 64 means, instead of auto-detecting an expression-pedal connection.

4. **Sostenuto-locked keys are exempt from damper attenuation**. Their `damperGain` pins to 1.0 even when damper depth drops. Matches piano physics: the sostenuto rod lifts dampers off the locked strings entirely.

5. **CC4 + CC64 in sustain mode combine via `max(cc4Depth, cc64Depth)`**. Either pedal alone gives sensible behavior; both together don't conflict — the deeper-pressed one wins.

**Rejected**:

- **Depth-as-release-time model** for continuous damper. Considered: leave sustained voices ringing at full volume, scale release time when depth changes. Rejected because it's only audible at the moment the pedal lifts — half-pedaling produces no continuously-changing sound, which fails the "audibly apparent V1" win condition.

- **Modulate `voiceGain` directly** for damper. Rejected because `voiceGain` already carries the release envelope and is targeted by sample-engine cross-fade joins (`samples.ts:1147, 1240`). Adding damper modulation onto it creates `cancelScheduledValues` collisions between release ramps and damper smoothing. The dedicated `damperGain` node is cheap and isolates the two concerns.

- **Linear ramps for damper smoothing**. Rejected — CC 4 arrives as 0–127 integer steps; every message would require `cancelScheduledValues` + `setValueAtTime` + `linearRampToValueAtTime`. `setTargetAtTime` is the correct primitive for tracking a coarse stream and needs no schedule clearing. ~25ms time constant.

- **Auto-detect expression pedal** ("first non-zero CC4 = connected, sticky for session"). Rejected because: Korg-wired pedals produce noise floor that a `d2 > 0` check would falsely interpret; mid-session unplug isn't detectable; pressed-on-boot would stay sticky after unplug. Manual config has zero false positives and fits where the project is heading (general input-routing later).

- **Tail-clamp for CC4 ≥ 124 → 127**. Skipped for V1 — under depth-as-gain, the audible difference between gain=0.984 and 1.0 is imperceptible. Documented in `lessons.md` as a 3-line fix if a future feature needs the exact endpoint.

- **General CC-routing modulation matrix**. Premature. The dropdown is two options (sustain / sostenuto). Once we have ≥3 distinct pedal-driven modulations users want to configure, generalize then.

**Why**:

- Damper-as-gain and gain-modulating-the-sustained-voice are the same thing. The win condition was "audibly apparent" continuous damper; gain modulation produces continuous attenuation in real time, which is the most direct route from "pedal moves" to "sound changes."
- Keeping sostenuto on the same `sustainedKeys` set avoids a combinatorial state-machine problem with two pedals: there's only one "is this note sustained-by-something?" question, answered by Set membership, with `sostenutoLockedKeys` as a side-marker for "ignore damper for this one."
- Manual mode dropdown trades a one-time setup click for zero edge cases. Net positive UX given the pedal types people actually plug in.

**Where**:

- State: `src/state/audio.ts` (`damperDepth`, `sostenutoActive`, `sostenutoLockedKeys`), `src/state/pedal.ts` (`mode`, `cc4Depth`, `cc64Depth`, `lastCC64Value`).
- Voice graph: `src/audio/engine.ts:noteOn` (osc path), `src/audio/samples.ts:sNoteOn`/`sNoteOnFaded` (sample path).
- Engine API: `src/audio/engine.ts` — `setDamperDepth`, `sostenutoOn`, `sostenutoOff`, `applyDamperToVoice`, `pinDamperToOne`, `releaseSustainedKey`. `SampleEngine.setVoiceDamperDepth` is the sample-side accessor.
- Note-off branches: `src/midi/handler.ts` and `src/input/keyboard-notes.ts`.
- UI: `index.html` (`#pedalMode` select; `#calibLive` removed), `src/ui/init.ts` (mode-flip handler with held-CC64 re-evaluation).

---

## Vibrato sample selection: full-chromatic analyze, ~4-semitone spacing, quality-first picks

**Date**: 2026-05-07
**Picked**: For each `vibrato:true` instrument in `samples.ts`, the workflow is
(1) fetch every chromatic note in the soundfont's range; (2) decode with ffmpeg
to `f32le` mono at 44.1 kHz; (3) run `prepareLoopVibrato` on each via the analyzer's
exposed function; (4) classify into green/blue/yellow/red tiers using the same
logic as the analyzer UI (seams ≥ 2/4, usableBs ≥ 2/3, minPickCorr ≥ 0.93 for green);
(5) walk the range in 4-semitone steps starting from the lowest usable note,
picking the highest-tier sample within ±2 semitones at each step (tier rank
first, minPickCorr breaks ties); (6) emit JS source via the same format the
analyzer's `generateOutput` produces; (7) replace the instrument block in
`samples.ts`. End state for the 5 vibrato instruments: 14–20 samples each, all
green or blue, minPickCorr typically 0.95–1.00.

**Rejected**:

- **Hand-selecting samples in the analyzer UI**, the previous workflow. Slow,
  human-bottlenecked, and biases toward whatever notes happen to look good
  on the day — not the highest-quality coverage of the range.
- **Even spacing without quality gating**. A note at exact 4-semitone steps
  might be `red` while a neighbor 2 semitones away is `green`. Strict spacing
  ships worse loops; the ±2-semitone window keeps spacing roughly even
  while always preferring quality.
- **Including `red`/`fail` samples as fallbacks** when the window has nothing
  green/blue/yellow. Red samples produce audible loop seams; better to leave
  a 4-semitone gap and let the engine pick the nearest neighbor.

**Why**:

- The analyzer's tier model is the right quality proxy — `minPickCorr ≥ 0.93`
  means every loop point shares waveform phase with the anchor, so any pair
  loops cleanly. That's exactly what the runtime needs.
- 4-semitone spacing (~3 samples per octave) is dense enough that the engine's
  nearest-pitch lookup never has to stretch a sample by more than ±2 semitones,
  and small enough that 5–7 octaves of an instrument's range fits in 15–20
  samples — comparable to what was hand-curated before, but reproducible.

**Where**:

- Analyzer entry point: `tools/HexKeyLab-analyzer.html` — `prepareLoopVibrato`,
  `prepareLoopMacroPeriod`, and the shared `findSteadyRegion` /
  `buildBackwardForwardGraph` / `correlateWaveforms` / `refineFundamentalPeriod`
  helpers above them. `transpose` config field handles the FatBoy drawbar
  octave-mismatch convention.
- Result: `src/audio/samples.ts`, the 5 `vibrato:true` instrument blocks
  (violin, viola, cello, flute, drawbar_organ).
- The selection script runs entirely outside the browser via Node + ffmpeg
  for batch reproducibility; the analyzer's HTML UI remains for individual-
  sample inspection / debugging.

---

## Octave-mismatched soundfonts: pair filename with actual audio fundamental, no runtime transpose

**Date**: 2026-05-07
**Picked**: For soundfonts where the filename labels are an octave above the
actual recorded audio (FatBoy Hammond drawbar — `A4.mp3` contains audio at
220 Hz, not 440 Hz), each `samples.ts` entry pairs `name:` (the filename to
fetch) with `freq:` (the file's *actual audio fundamental*). The runtime
engine plays the file at native rate=1.0 for its closest pitch. The analyzer
config still has `transpose:2` to tell the analyzer how to interpret the
file (so `refineFundamentalPeriod` searches the right autocorrelation lag),
but the output it emits — and the `samples.ts` block — does NOT carry a
`transpose` field.

**Rejected**:

- **Engine-side `transpose:N` multiplier** (the previous approach). For an
  audible Eb2 (78.4 Hz) request, the engine fetched `Eb2.mp3` (Eb1 audio at
  39.2 Hz) and played it at rate = 78.4 × 2 / 78.4 = 2.0 to lift the audio
  up to the labeled pitch. This worked for pitch but doubled the recorded
  Leslie vibrato speed (~5 Hz became ~10 Hz). Audibly wrong.
- **Re-pitch the audio at decode time** (offline). Possible but adds an
  ffmpeg pass per sample and discards the original recording fidelity.
  Native-rate playback is the simpler choice.

**Why**:

- Runtime playback rate determines BOTH the perceived pitch AND the rate of
  any modulation baked into the file (vibrato, tremolo, chorus, Leslie).
  Native rate is the only setting where modulation matches what the recording
  engineer captured. Anything else is a trade-off.
- Pairing `name` (= filename) with `freq` (= actual audio pitch) loses one
  audible octave at the top (no `Bb8.mp3` exists on the CDN to fill in for
  audible Bb7), but the lowest octave's audible range is still well-covered.
  For Hammond drawbar specifically, the bass register is far more
  important than the top — losing audible Bb7 in exchange for 5 Hz rather
  than 10 Hz Leslie is a clear improvement.

**Where**:

- `src/audio/samples.ts:158` — `drawbar_organ` block, no `transpose:` field;
  each entry's `freq` is the actual audio fundamental of the named file.
- `tools/HexKeyLab-analyzer.html` — `transpose` config field documented;
  analyzer emits `freqActual` as-is (= actual audio fundamental).
- Engine math (`src/audio/samples.ts:428`, `:1009`): `rate = freq *
  (instr.transpose||1) / nearest.freq` still works — drawbar gets transpose=1
  by default and `nearest.freq` already encodes the audio's true pitch.
