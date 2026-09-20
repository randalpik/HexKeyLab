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

- Analyzer entry point: `analyzer/HexKeyLab-analyzer.html` — `prepareLoopVibrato`,
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
- `analyzer/HexKeyLab-analyzer.html` — `transpose` config field documented;
  analyzer emits `freqActual` as-is (= actual audio fundamental).
- Engine math (`src/audio/samples.ts:428`, `:1009`): `rate = freq *
  (instr.transpose||1) / nearest.freq` still works — drawbar gets transpose=1
  by default and `nearest.freq` already encodes the audio's true pitch.

---

## Per-sample RMS-normalization: −18 dBFS target, baked into sample data

**Picked**: Each sample carries a `gain` field (linear scalar) computed by the analyzer from its measured RMS. Target = **−18 dBFS RMS** for the audibly relevant region (steady span for loops, peak 100 ms window for decays), with a peak ceiling of −3 dBFS that limits gain when crest factor would otherwise cause clipping. The same target applies to the three oscillator instruments via per-waveform peak amplitudes (sine ≈ 0.1779, triangle ≈ 0.2179, square ≈ 0.1259).

**Rejected**:
- **Runtime auto-gain / loudness compressor**: hides level differences in a non-deterministic way and breaks JI dynamic relationships during sustained chords.
- **Single per-instrument volume scalar**: doesn't fix intra-instrument variation (e.g. piano top notes recorded much quieter than mid-range).
- **LUFS / K-weighted loudness target**: more perceptually accurate but adds a filter pass and complicates the analyzer with little gain on the use cases here. RMS over the audible region is good enough for v1.
- **A more empirical target derived from playing test material**: useful as a sanity check via loopOverlay, but the constant is trivial to retune later — pursuing it up front was premature.

**Why**:

- loopOverlay diagnostics surfaced inconsistency: single samples ~−30 dBFS, polyphony peaking ~−15 dBFS, audibly different across instruments. Source sample sets (Salamander, FluidR3, FatBoy) are mastered to different reference levels and individual notes within one set drift.
- −18 dBFS leaves ~15 dB headroom for polyphony to land near −3 dBFS at full chord — matches typical broadcast-style conventions and what was empirically observed in loopOverlay.
- Window choice matters: for decays, the original 500 ms window dragged RMS down by including silent decay tail (harp top end measured −50 dBFS), forcing huge gains. 100 ms aligns with loudness integration time for transient sources and gives values that track perception.
- Peak ceiling (−3 dBFS) prevents single-note clipping for high-crest content (piano top end, percussive transients) while still pushing toward the RMS target for low-crest content (organs, sustained strings).

**Where**:

- `src/audio/samples.ts` — `gain` field on every sample entry; runtime applies it once at `noteOn` (`vol *= nearest.gain`).
- `src/audio/engine.ts` — oscillator buses pass-through (1.0); per-waveform vol = TARGET_RMS × peak/RMS ratio, low-freq Fletcher-Munson boost preserved.
- `analyzer/generate-samples.js` — emits `gain` for newly generated instruments.
- `analyzer/backfill-gains.js` — one-shot tool that measured + patched all existing instruments without disturbing loop points.
- Constants: `TARGET_DBFS = -18`, `PEAK_DBFS = -3`, `GAIN_MAX = 8` (sanity bound; peak ceiling is the real limiter), `GAIN_MIN = 0.1`.

---

## loopOverlay measures energy-summed per-channel RMS, not the AnalyserNode default downmix

**Picked**: Tap `sampleMaster` into a `ChannelSplitter` and run a separate `AnalyserNode` on each channel. In `tick()`, compute `rms = sqrt(rmsL^2 + rmsR^2)` from the two per-channel time-domain buffers.

**Rejected**: Single `AnalyserNode` directly on `sampleMaster`, relying on the default `channelInterpretation = "speakers"` downmix (`0.5 * (L+R)`).

**Why**:
- The analyzer measures sample RMS via ffmpeg `-ac 1`, which is **energy-preserving** (effectively `(L+R)/sqrt(2)`). For correlated stereo channels — i.e. mono recordings packed into a stereo MP3, which is what every shipped sample set is — that's +3 dB above either channel alone.
- The Web Audio AnalyserNode default downmix is **amplitude-averaging** (`0.5 * (L+R)`), which gives per-channel RMS for correlated content.
- Result: the analyzer and the meter were measuring the same signal but disagreeing by exactly 3 dB. After RMS-normalizing every sample to -18 dBFS by the analyzer's measurement, loopOverlay (single AnalyserNode) was consistently reading -21 dBFS at vel=127. The samples weren't actually quiet — the meter was undercounting.
- Energy-summed per-channel RMS (`sqrt(rmsL^2 + rmsR^2)`) matches the analyzer convention and aligns with ITU-R BS.1770 / LUFS channel-summation, which is the standard for measuring perceived loudness across stereo content. Speakers play stereo and the listener integrates both channels; that's the level we care about.

**Where**:
- `src/audio/diagnostics/loopOverlay.ts` — `analyserL`, `analyserR`, `splitter`; per-channel buffers in `tick()`; combined via `Math.sqrt(rmsSqL + rmsSqR)`.
- See `lessons.md` for the general "ffmpeg vs Web Audio downmix conventions" gotcha.

---

## v1 instrument batch: 4 added, 2 deferred

**Picked**: Add clarinet (FatBoy), acoustic guitar (nbrosowsky/tonejs-instruments), electric piano (FatBoy electric_piano_1), chamber organ (VCSL Renaissance Organ 8'). Defer oboe and French horn to v1.x; current oboe sample-set (VSCO-2-CE Sus) hidden in dropdown rather than removed.

**Rejected**:
- MusyngKite as a default-first soundfont: failed clarinet's mid/upper register (only 7 picks clustered C2–F3 below playing range); FatBoy was the right first try.
- Loose-gate oboe ship: MusyngKite oboe + `fwdStabilityThreshold: 10` (effectively disabled) gave 10 analyzer-passing picks but auditioned wobbly.
- VSCO-2-CE Sus oboe ship: 8/9 green at default gates but anechoic professional recording exposed every breath inflection — auditioned worse than MusyngKite.
- Iowa MIS oboe (theremin.music.uiowa.edu): no `Access-Control-Allow-Origin` header → runtime browser fetch blocked.
- SSO peastman oboe: failed default gates with same `clique 0 pts` pattern.
- FluidR3 French horn: failed default gates AND post-clique `no usable loop pathway` at loose gates (steady region < 0.45s).
- Adding envelope slope-matching to `filterToBackwardClique` for v1: substantial change, scoped to v1.x.

**Why**:
- Oboe and French horn share one root cause across 8 sources tested (FluidR3, MusyngKite, FatBoy, VSCO-2-CE Sus, SSO peastman for oboe; FluidR3/MusyngKite/FatBoy for horn): real recordings of these instrument families carry envelope micro-variation that the analyzer's `fwdStabilityThreshold` prefilter rejects on purpose. Three independent recording chains (soundfont rendering, anechoic studio, public-domain library) hit the same wall, so the constraint is the algorithm, not the source quality. See lessons.md.
- Soundfont vendor choice is empirical, not categorical: FatBoy clarinet succeeds where MusyngKite clarinet fails; the user's prior FluidR3 horn rejection was a vendor-quality call but didn't generalize. Per-instrument picks beat any single-vendor strategy.
- Mirroring Iowa MIS to a CORS-friendly location was the only path with reasonable chance of audibly different oboe character — not worth the 30-AIFF transcode work for v1.

**Where**:
- `analyzer/configs/fatboy-clarinet.json`, `tonejs-guitar-acoustic.json`, `fatboy-electric-piano.json`, `vcsl-renaissance-organ.json` — shipped configs.
- `analyzer/configs/vsco2-oboe.json` — last-tried oboe config; samples.ts entry preserved for future re-enable.
- `index.html` — `<select id="waveform">` dropdown registrations; oboe option commented out with deferral rationale inline.
- `src/audio/samples.ts` — 14 INSTRUMENTS entries (13 visible + hidden oboe).
- `analyzer/HexKeyLab-analyzer.html` — `prepareLoopMacroPeriod` and `filterToBackwardClique` (the gates that block oboe/horn).

---

## Forward-stability prefilter is brass-killer-by-design; tune by raising, never disabling

**Picked**: For new instruments, keep `fwdStabilityThreshold` at its default 0.10 (±1 dB / 300ms forward window). When tightening fails to admit picks, raise it incrementally (0.30, 0.40) — but don't ship instruments whose only viable picks come from disabling the gate (`fwdStabilityThreshold: 10` or `Infinity`).

**Rejected**:
- Disabling the gate to admit oboe/horn picks: the boop/swell-at-seam artifact it catches is exactly the failure mode the macro-period algorithm was designed to prevent. Auditioned and confirmed audibly bad on MusyngKite oboe at fwd=10.
- Lowering the default further: would reject more clean instruments unnecessarily.

**Why**:
- The gate is documented at `analyzer/HexKeyLab-analyzer.html:125–138`: "Brass onsets are the canonical case: pts[0] often lands just before the breath-pressure peak. The runtime engine then plays forward from that candidate when looping back to it — directly through the unvalidated overshoot — producing an audible 'boop', swell, or dip."
- Sensitivity sweep on MusyngKite oboe established that the gate boundary is correct: 0.10 → 0 picks, 0.20 → 7, 0.30 → 9, 0.40 → 10, fully-disabled → same 10 as 0.40. Picks admitted between 0.10 and 0.40 had forward deviation 10–40% and audited boopy. Audition concurred with the gate's verdict.
- `cliqueThreshold` direction is also surprising: default 0.25, lower is tighter (reed_organ uses 0.15). Misread once cost an iteration. See lessons.md.

**Where**:
- `analyzer/HexKeyLab-analyzer.html:138–182` — `filterToBackwardClique` forward-stability prefilter; default `fwdStabilityThreshold = 0.10`.
- `analyzer/configs/vsco2-oboe.json` — last-tried oboe config sits at default gates, documenting "we tried not to disable the gate."
- `lessons.md` — "Soundfont and real-instrument oboe/horn share a single wall."

---

## filePattern + URL `#`-encoding now wired end-to-end (runtime parity with analyzer)

**Picked**: Runtime `SampleEngine.loadInstrument` reads `filePattern` from instrument metadata (falling back to `'{NOTE}{ext}'`) and applies `#`→`%23` URL encoding always. Analyzer `emitBlock` writes `filePattern:'…'` only when non-default, leaving existing instrument blocks unchanged.

**Rejected**: Special-casing URL construction by `instrumentKey` (would require runtime branching, doesn't generalize).

**Why**:
- VCSL chamber organ filenames are `RenOrgan_8foot_Room_{NOTE}_rr1.wav`, not `{NOTE}.wav`. Analyzer respected this from day one (`buildUrl` in `generate-samples.js`), but runtime engine hard-coded `baseUrl + name + ext` — the analyzer could fetch samples but the browser couldn't. First chamber organ splice silently 404'd at runtime; visible only on audition.
- Chamber organ also uses `sharp` noteStyle, so its sample names contain `#` (e.g. `A#1`). Existing instruments use `flat` noteStyle (no sharps in names), so the unencoded-`#` issue had never surfaced. Same fix path handles both.
- Analyzer gained two new noteStyles for unrelated source filename conventions: `sharp_s` (nbrosowsky/tonejs-instruments — `Cs`/`Gs`/`As`) and `sharp_lower` (peastman/sso — `c#`/`g#`/`a#`). Both go through the unified runtime URL builder.

**Where**:
- `src/audio/samples.ts:559–560` — runtime URL: `var pat = instr.filePattern || ('{NOTE}'+instr.ext); var url = instr.baseUrl + pat.replace('{NOTE}', s.name).replace(/#/g, '%23');`
- `analyzer/generate-samples.js:34–89` — `NOTES_SHARP_S`, `NOTES_SHARP_LOWER`, `noteStyle` switch; `SEMI` extended with `Cs/Gs/As` for parsing.
- `analyzer/generate-samples.js:367–389` — `emitBlock` conditionally emits `filePattern` when non-default.
- `.claude/skills/add-instrument/SKILL.md` — workflow step 7 (UI dropdown registration in `index.html`) added; samples.ts is NOT auto-enumerated.

---

## `transpose: 0.5` for chamber organ — extends the Hammond-octave precedent

**Picked**: Chamber organ config sets `transpose: 0.5`. The analyzer's autocorrelation searches at `labeledFreq / transpose` (so 0.5 → search at 2× label) and emits the actual measured fundamental as `freqActual`. Runtime engine plays at the measured pitch via the existing `rate = target / nearest.freq` math; no engine change needed.

**Rejected**: Hand-correcting file labels (immutable upstream repo); manually editing each `freq` in samples.ts (defeats reproducibility from config).

**Why**:
- VCSL Renaissance Organ 8' files are labeled with concert-pitch convention (8' = sounding pitch), but the audio recordings are an octave higher than their labels. Verified empirically on first audition: file labeled `D1` plays at ~73 Hz (D2) when runtime trusts the label.
- Inverse of the Hammond/drawbar precedent (`transpose: 2`, where filenames are an octave above content). `transpose: 0.5` extends the same mechanism to "audio is an octave above the label."
- Mechanism generalizes: any rational interval offset between label and content is a valid `transpose` value. Future transposing-instrument labels (e.g., a Bb clarinet recording labeled with C concert) would use `transpose: 9/8` or similar.

**Where**:
- `analyzer/configs/vcsl-renaissance-organ.json` — `"transpose": 0.5`.
- `analyzer/generate-samples.js:469` — `analysisFreq = labeledFreq / cfg.transpose` (autocorrelation seed).
- `src/audio/samples.ts` — `chamber_organ` entry: measured freqs ≈ 2× labels (e.g., D1 file → `freq:73.13`).

---

## Recording format: `.hkr` is canonical, `.mid` is a derived view (2026-05-12)

**Picked**: Recording lands in two file formats with a one-way authority relationship.

- **`.hkr` (JSON)** is the source of truth. Schema: `{format: "hkr", version: 1, createdAt, durationSec, timing, snapshot, events[]}` where `snapshot` is a `LayoutSnapshot` (tuning system, 5-limit layout choice, 7-limit shift, qwertyTranspose, instrument, pedal mode, refHz) and each event is `{t, k, …}` keyed by `k ∈ {on, off, pa, cc4, cc64, warn}`.
- **`.mid`** is exported from and re-imported back to `.hkr`. The two files travel separately (no bundled `.zip` container).

**Rejected**:
- **MIDI-only** as the canonical format: pitch-wheel quantization in third-party DAWs would silently destroy coordinate identity (multiple coordinates can produce identical or near-identical frequencies under any given tuning). MIDI is a fine *interchange* format but a poor *source of truth* for JI.
- **`.hkr` and `.mid` bundled in a `.zip` container** (e.g., extension `.hkr` as zip): tempting for "atomic round-trip" but the user explicitly wanted to extract and edit the `.mid` independently, so they stay separate.
- **Coordinate metadata embedded in `.mid` text/marker meta-events** as a fallback hint: would clutter exported `.mid` files with non-standard data DAWs may strip, and the frequency-index inverse against a stored snapshot is sufficient.

**Why**: HKL's "note" is a lattice coordinate `(q, r)`, not a pitch. Two coordinates can produce equal frequencies in 12-TET, or differ by a comma in JI such that pitch-wheel quantization in a DAW would conflate them. Keeping coordinate identity in the canonical format means re-import always recovers what the recorder saw, and the schema is also friendly to a future Lilypond exporter (coordinate + snapshot → JI ratio + comma decomposition + key color, which is exactly what colored-notehead engraving needs).

**Where**:
- Schema: `src/recording/types.ts` (`HkrSession`, `HkrEvent`, `LayoutSnapshot`).
- Serializer: `src/recording/hkr.ts` (`serializeHkr`, `parseHkr`).
- Capture: `src/recording/capture.ts`.
- Playback: `src/recording/playback.ts`.

---

## MIDI export uses MPE; manager ch 1, members ch 2–16, bend range ±48 semitones (2026-05-12)

**Picked**: `.mid` export targets **MIDI Polyphonic Expression (MPE) lower zone**. One channel per active voice (allocated LRU by `MpeAllocator`), per-channel pitch-bend range = 48 semitones via RPN 0 in the preamble. The track preamble also includes the MPE Configuration Message (RPN 6 on the manager channel = 15 member channels). Tempo is fixed at 120 BPM, PPQ = 960.

**Rejected**:
- **Plain non-MPE MIDI** with a single channel: pitch-bend is per-channel, so simultaneous notes with different JI offsets can't be represented. Either every chord serializes to a single bend value (loses identity) or chords serialize sequentially (loses timing). Both fail for the common JI use case.
- **Bend range of ±2 (default) or ±12 (common)**: insufficient for extreme JI offsets when the 12-TET snap chooses a far-adjacent semitone. ±48 is wide enough to cover any reachable coordinate in any layout under any tuning.
- **Variable tempo or time signature recorded into the `.hkr`**: not in scope for v1. The `.hkr` carries absolute seconds; MIDI export uses a fixed 120 BPM 4/4 grid so DAW quantizers have something to lock onto. A future tempo/meter feature can extend the schema.

**Why**: MPE is the industry-standard format for microtonal MIDI. Logic, Bitwig, Ableton 11+, and any modern MPE-aware synth read it natively. Bend range of ±48 makes round-trip math robust against DAW quantization of the bend value: even a coarsely-edited bend recovers within a cent. The 25-cent tolerance gate in the importer is the canonical signal that something went very wrong (e.g., the user re-imported against the wrong snapshot).

**Where**:
- Math: `src/midi-io/mpe.ts` (`coordToMidi`, `midiToFreq`, `MPE_BEND_RANGE_SEMITONES = 48`).
- Allocator: `src/midi-io/allocator.ts` (channels 2..16, LRU eviction).
- Export: `src/midi-io/export.ts` (preamble + sorted events + EOT).
- Import: `src/midi-io/import.ts` (frequency-index inverse against snapshot).
- Library: `midi-file` (npm, pure read/write codec with explicit delta-time and event tagged union).

---

## Capture-point convergence: hook inside the audio engine, not at the MIDI handler (2026-05-12)

**Picked**: The recording capture hooks (`recordOn`, `recordOff`, `recordPa`, `recordPedalDepthsChange`, `recordSostenuto`) live inside `src/audio/engine.ts` — one line each in `noteOn`, `noteOff`, `handleAftertouch`, `setDamperDepth`, `sostenutoOn`, `sostenutoOff`. The hooks short-circuit when `isRecording()` is false (essentially free when idle).

**Rejected**:
- **Hook at the MIDI input handler** (`src/midi/handler.ts:34` after `fixedMidiToKey`): would miss QWERTY input and mouse-click input, which never go through `handleMidiMessage`. Scattering capture across three call sites (handler.ts + keyboard-notes.ts + the canvas click handler in init.ts) would be fragile — every new input source would need its own hook, and any forgotten site would silently drop input from the recording.
- **Hook at the effects layer** (`src/effects/onSelectionChanged.ts`): selection changes don't capture velocity, aftertouch, or pedal state — only the resulting selection set. Wrong granularity.

**Why**: `noteOn(key, velocity)` is the convergence point for every input source — Lumatone, QWERTY, mouse-click, and any future input — because every one of them ultimately calls into the audio engine. Hooking once here catches everything with a single line per entry point. The capture hooks reading post-translation state means the recording is invariant to firmware-side remappings, Lumatone board-3/4 physical swap, and other input-side quirks.

The trade-off: pure-selection clicks with `audio.audioEnabled === false` don't trigger `noteOn` and therefore don't record. Documented in the module header as acceptable — recording without audio is meaningless.

**Where**:
- Hooks: `src/audio/engine.ts` (six call sites, search for `recordOn`/`recordOff`/etc.).
- Capture funnel: `src/recording/capture.ts` — module-private buffer with no-op-when-idle behavior.

---

## Playback writes to `selection.selectedKeys`; visual highlight matches live input (2026-05-12)

**Picked**: Playback dispatch adds played coordinates to `selection.selectedKeys` and calls `draw()` on each `on`/`off` event, so keys flash on the hex canvas exactly as they would for live user input. Playback maintains a separate `playbackKeys: Set<KeyId>` ledger so Stop releases only voices it created.

**Rejected**:
- **Audio-only playback**: leaves the canvas static while sound plays. Felt disconnected during audition; the canvas is the user's primary feedback channel.
- **A UI toggle** to choose between highlight and audio-only: premature configurability. If a future workflow wants the canvas free during playback (e.g., showing the next chord), add the toggle then.
- **Re-route playback through `onSelectionChanged`** (the normal selection-mutation fan-out path): would trigger `syncMidi()` which sends external MIDI for each event, double-emitting the recording's MIDI to the Lumatone if it's connected. Bad.

**Why**: The visual feedback is "free" — selectedKeys + draw is the same machinery live input uses. The separate ledger preserves the invariant that Stop never kills user-held voices. Bypassing `onSelectionChanged` means playback events don't roundtrip out through MIDI/Lumatone sync — they affect audio + canvas only, which is what playback should do.

**Where**: `src/recording/playback.ts` (dispatch table, `playbackKeys`, `stopPlayback`).

---

## MIDI re-import requires the originating `.hkr` snapshot, not live HKL state (2026-05-12)

**Picked**: Importing a `.mid` back into HKL requires the user to first load the matching `.hkr` for the layout snapshot. The UI gates the Import .mid button on `session !== null` and shows "Load matching .hkr first" if invoked without one. After import, the session's snapshot is preserved (so re-export round-trips against the same anchor).

**Rejected**:
- **Use the live HKL tuning/layout/instrument settings as the snapshot**: convenient but silently produces wrong coordinates if the user happened to be in a different tuning when they hit Import. The 25-cent sanity gate catches gross mismatches but a 12-TET-vs-5-limit swap on the same instrument produces matches within 25 cents that are still musically wrong.
- **Auto-detect the originating tuning from the MIDI**: the bend distribution might cluster around 5-limit vs 12-TET ratios, but the inference is fragile and silent-misclassification is a worse failure than a friendly "load .hkr first" prompt.

**Why**: Snapshot mismatch is the dominant correctness risk in round-trip workflows. Forcing the user to declare which `.hkr` the `.mid` belongs to makes the mismatch impossible. The cost is one extra click on the rare "I edited my .mid in a DAW and now want to bring it back" workflow.

**Where**:
- UI gate: `src/ui/recorder.ts` — `onImportMidiClick` checks `curSession !== null`.
- Inverse: `src/midi-io/import.ts` — `midiToSession(bytes, snapshot)` takes the snapshot as required argument.

---

## `applySnapshot` lives in `recording/apply.ts`, not `recording/snapshot.ts` (2026-05-12)

**Picked**: Two-file split.
- `recording/snapshot.ts` — `captureSnapshot`, `snapshotMatchesLive`. Leaf in the module graph; imported by `capture.ts` (which is imported by `audio/engine.ts`).
- `recording/apply.ts` — `applySnapshot`. Imports `ui/controls.ts` (to drive `setTuning` / `setLayout` / etc.) and `effects/onTuningChanged`. Imported only by `ui/recorder.ts`.

**Rejected**:
- **One file with both functions**: creates a module cycle `audio/engine → recording/capture → recording/snapshot → ui/controls → audio/engine`. Initially worked around with dynamic `await import('../ui/controls.js')` calls inside `applySnapshot`, but Vite issued chunking warnings and the runtime async overhead was unnecessary.

**Why**: The split keeps `recording/snapshot.ts` leaf-position, which lets `recording/capture.ts` (and through it `audio/engine.ts`) import from it without dragging in the entire UI/controls chain. The naming is intentional — `snapshot.ts` covers passive read-side operations; `apply.ts` covers the active write-side operation that mutates live state.

**Where**:
- `src/recording/snapshot.ts` — `captureSnapshot`, `snapshotMatchesLive`.
- `src/recording/apply.ts` — `applySnapshot`.
- See `lessons.md` for the general "splitting modules to break cycles beats dynamic imports."

---

## Audio capture format: 44.1k/16-bit WAV via AudioWorklet (2026-05-13)

**Picked**: AudioWorklet tap off `audio.limiter`, accumulate Float32 frames on the main thread, encode 16-bit PCM WAV on stop. Capture is auto-bracketed around `.hkr` record/playback when the "Capture audio" toggle is on.

**Rejected**:
- **MediaRecorder → WebM/Opus**: small files, simple, but lossy and inconsistent MIME support across browsers. Misses the goal of "step toward packaging the sample engine for general use" — that future leans on bit-exact output, which a lossy codec gives up.
- **ScriptProcessor**: simpler one-file path (no separate worklet module), but deprecated; AudioWorklet was a small extra cost for a cleaner long-term shape.
- **Bundle the WAV inside the `.hkr`**: a `.hkr` is a small JSON event stream; merging a multi-MB binary into it would invert the size relationship and break the existing JSON-load path. The WAV travels alongside (same isoStamp), not inside.

**Why**: WAV is universal in DAWs, lossless, and trivially decoded by anyone who wants to consume the engine output without HKL. The tap point post-limiter captures exactly what the listener hears (high-shelf + limiter applied), so the file matches the live experience instead of an idealized clean signal. Worklet-side processing keeps the audio thread untouched and the encode work parked on the main thread.

**Worklet bundling subtlety**: the worklet is `.js`, not `.ts`, and imported via `?url` (`import workletUrl from './capture-worklet.js?url'`). A `.ts` worklet would either be served as raw TypeScript (invalid JS in a worklet scope) or rejected by `audioWorklet.addModule()` on MIME grounds. Vite 6 inlines small assets as data: URLs by default — modern Firefox/Chrome accept `data:text/javascript` for `addModule`, but `?url` is the explicit form that documents intent and survives future inline-threshold changes.

**Capture span ends Stop + 1500 ms** so sample release tails (samples-engine voiceGain fade) and oscillator envelope releases land in the file. Without the tail, recordings end on an audible chop.

**Where**:
- `src/audio/capture.ts` — lifecycle (`initCapture`, `startCapture`, `stopCapture`).
- `src/audio/capture-worklet.js` — worklet processor.
- `src/audio/wav.ts` — WAV encoder.
- `src/audio/engine.ts:initAudio` — fire-and-forget `initCapture(ctx)` call.
- `src/ui/recorder.ts` — auto-bracket + toggle wiring.
- `src/state/persistence.ts` — `captureAudio: boolean` field on `PrefsV1`.

---

## `.hkr` recording t0 anchors at first event, not at button press (2026-05-13)

**Picked**: `t0` in `recording/capture.ts` lazy-anchors on the first `pushEvent` call. Dead time between hitting record and the first action is trimmed; the first user event lands at `t = 0`.

**Rejected**: Anchoring `t0 = nowSec()` at `startRecording()` (the previous behavior). Produced a leading silence in every recording equal to the operator's reaction time, which then shows up as empty leading bars in MIDI exports and shifts all downstream timestamps off the start of bar 1.

**Why**: The recording is supposed to capture the *performance*, not the moment the operator clicked a button. Trimming up-front silence makes the `.hkr` and its exported `.mid` open cleanly in a DAW at bar 1.

**Subtlety**: seed events (already-held notes, already-depressed pedals at record-start) still need to sit at `t = 0` so playback reproduces a recording that begins mid-chord. They use the same `tNow()` path — the first seed call anchors `t0` immediately, subsequent seed calls return ~0 because they happen in the same tick. If there are no seeds, `t0` simply stays unanchored until the first real input.

**Where**:
- `src/recording/capture.ts` — `tNow()` lazy-anchor, `t0Anchored` flag, `startRecording` reordered so seed pushes go through `tNow()`.

---

## Decay-path gain normalization switched to K-weighted LUFS (2026-05-13)

**Picked**: Replace the 200ms post-trim RMS measurement on the decay path with ITU-R BS.1770-4 integrated loudness — K-weighting biquads (pre-filter high-shelf @1681 Hz +4 dB, RLB high-pass @38 Hz), 400ms momentary windows at 100ms hop, absolute gate at −70 LUFS, relative gate at −10 LU below pre-gated mean, integrated over the full post-trim region. Returned as a stereo-RMS-equivalent (`sqrt(integrated_combined/2)`) so the existing `gain = TARGET_RMS / rms` formula and the −3 dBFS peak ceiling stay unchanged.

**Rejected** (during this iteration):
- **Lengthen the 200ms window to 1–2 seconds**: cheap fix but still attack-weighted; doesn't account for frequency sensitivity. Marginal vs the LUFS path.
- **Skip the attack and measure only sustain RMS**: helps but still misses the wide-band perceptual weighting that K-filtering provides; comparable code complexity to LUFS now that the module exists.
- **Keep the 200ms window**: the prompting symptom was Maestro grand piano E5 sounding much louder than D#5 despite matched 200ms attack peaks in the loop overlay. Post-mortem showed the source samples differ by ~8 dB in absolute level; the 200ms measurement equalized only the attack, leaving the sustained decay 6–15 dB apart in different directions across the keyboard.

**Why**:
- The 200ms window was dominated by the hammer transient. Two adjacent decay samples with matched attack RMS can have very different sustained loudness when their sources are mastered inconsistently — exactly Maestro's failure mode.
- K-weighted integrated loudness measures over the *audible portion of the entire decay* with frequency-weighting that tracks perception. On Iowa piano (clean source) the post-gain integrated loudness now sits within ~0.5 dB across mid-range notes. On Maestro (poorly-mastered source with many notes already at −3 dBFS peak), the peak ceiling still bottlenecks; K-weighting reduces the worst-case inter-sample mismatch from ~8 dB to ~3–4 dB.

**Constraint surfaced**: When a source's per-sample peaks already sit near the −3 dBFS ceiling, K-weighted RMS normalization can't fully equalize sustained loudness because the peak ceiling holds back the gain on the louder samples. For Maestro this is the dominant remaining cause of inter-sample drift; the actual fix at that point is a better source recording, not a different normalizer. Documented in `lessons.md`.

**Where**:
- `analyzer/k-weighting.js` — new module: `kWeightingCoeffs`, `applyBiquadInPlace`, `findTrimStart`, `measureDecayLufs`.
- `analyzer/generate-samples.js` — `measureDecay` now wraps `measureDecayLufs`; report adds a LUFS column for decay picks; `DECAY_RMS_WINDOW_S` removed.
- `analyzer/backfill-gains.js` — same swap; backfill report adds a LUFS column.

---

## Per-key Lumatone calibration via direct memory poke + file edit (2026-05-15)

**Picked**: Per-key threshold calibration for Max's unit happens via SSH-driven scripts in `tools/lumatone-cal/` that (a) edit the running TerpstraController's in-memory `kbd_preset_params` struct via `/proc/<pid>/mem` and set the appropriate dispatch bits in `picMessage0Flag` to push updates to PICs sub-second, and (b) commit changes to `KeyData_N` files on the BBB's filesystem for reboot persistence.

**Rejected**:
- **Built-in 0x24 calibration with macro-button spoofing.** The PIC microcontroller firmware on each board waits for its own hardware macro-button signal to commit and exit cal mode. There is no PIC command for "end calibration" (exhaustively verified by disassembly). Spoofing the BBB-side cascade (subtype-4 message simulation) succeeds at the BBB level but the PICs themselves stay stuck in cal mode and refuse subsequent queries with `STATE` (0x04). Reboot is the only escape, at which point all learned-in-PIC values are lost.
- **Vendor SysEx that wraps per-key writes.** Would require running a daemon on the BBB. Feasible but defers; current flow requires SSH for calibration sessions but not for everyday play, which is acceptable for the manual frequency.
- **Firmware patching.** Brick risk too high for the marginal benefit over the file-edit path.

**Why**:
- The macro-button hardware on three of five boards is disconnected from a prior repair attempt. Standard 0x24 calibration finishes on boards 2/3 but never on 1/4/5.
- Per-key thresholds at the PIC layer are 8-bit per key per board (4 fields × 56 keys × 5 boards), with `cmdSetMax`/`cmdSetMin`/`cmdSetValid`/`cmdSetAftertouchMax` all addressable by writing the right bytes in TC's in-memory struct and setting one bit in `picMessage0Flag`. The path is short, scriptable, and reversible (power-cycle restores from on-disk files; on-disk files are explicitly backed up before any commit).
- TC restart loop (`while :; do sudo TerpstraController ; done`) makes the worst-case "TC crash from a bad poke" automatically recoverable.
- The MAX-threshold semantic (high = stricter / dead, low = permissive) gives a 0..254 dial-in range per key; combined with MIN tuning to control press-time-measurement window width, lets each weak/dead key be tuned individually by ear in seconds.

**Where**:
- `tools/lumatone-cal/keydata-live.py` — live edit + commit (the main tool).
- `tools/lumatone-cal/keydata-locate.py` — local file inspection / coord → file slot mapping.
- `tools/lumatone-cal/lmtncal-read.py` — diagnostic state dump.
- `tools/lumatone-cal/lmtncal-poke.py` — earlier (failed) macro-button spoof attempt, kept for diagnostic reference; marked obsolete in the README and in `docs/lessons.md`.
- `docs/lumatone-calibration.md` — full how-to guide.

---

## `.hkr` → LilyPond transcription: tempo + Ellis-DP beats + per-bar Viterbi DP (2026-05-15)

**Picked**: Build a custom 11-module transcription pipeline under `src/transcription/`:

1. **Onset pairing** (`onsets.ts`) — FIFO match of `on`/`off` events per (q,r); strength = velocity + density bonus.
2. **Tempo estimation** (`tempo.ts`) — IOI autocorrelation of an onset envelope (10 ms bins) weighted by a log-Gaussian prior centered at 100 BPM; optional ±15 % hard constraint when the user supplies a BPM hint. Parabolic peak interpolation for sub-bin resolution.
3. **Beat tracking** (`beats.ts`) — Ellis-style DP: `C(t) = s(t) + max(0, max_{t' ∈ [t−dMax, t−dMin]} C(t') − λ(t − t' − T)²)`. Traceback from the best-scoring tail beat.
4. **Meter / downbeat phase** (`meter.ts`) — phase search over `numerator` candidate offsets; extrapolate the chosen phase backward by full bars in `quantize.ts` until the tick origin sits at or before the first onset (so no leading notes get dropped).
5. **Chord grouping** (`chords.ts`) — 30 ms cluster window anchored on the first member (not the last) to prevent transitive drift through near-30 ms IOIs.
6. **Duration quantization** (`quantize.ts`) — the load-bearing module. Per-bar Viterbi DP over an allowed atom set ({8th, quarter, dotted quarter, half, dotted half, whole} — v1 deliberately excludes 16ths and 32nds). Cost = atom complexity + tie cost (0.40) + boundary penalty. Position snap to 16-tick grid (one 8th). Rests inserted when release gap ≥ 16 ticks.
7. **Voicing** (`voicing.ts`) — middle-C threshold per chord; mixed chords split across staves. Post-split rest consolidation: consecutive rests in a voice merge → re-split at bar boundaries → re-fed through `splitDuration` so an all-rest bar collapses to a whole rest instead of mirroring the other staff's note shapes.
8. **LilyPond emission** (`lyEmit.ts`) — Dutch syntax, `\tweak NoteHead.color` per chord-tone, `% onset-ids:` comments preserve identity for future correction-UI hooks.

Pitch spelling reuses `noteName(q, r)` / `keyOctave(q, r)` from `src/tuning/notes.ts` directly — sharps on +r, flats on −r, no enharmonic respelling, no key-signature inference.

**Rejected**:
- **midi2ly** (ships with LilyPond) — officially "not recommended for human-generated MIDI"; per-note grid snap with no joint optimization.
- **music21** `quarterLengthDivisors` — same per-note independent snap; produces garbage tuplets.
- **MuseScore 3/4 importer** — strongest OSS quantizer (adaptive grid + beat tracking) but GPL/C++ and not extractable from the editor.
- **PM2S** (Liu et al., ISMIR 2022) — neural CRNN that beats commercial software on MV2H, but requires Python + PyTorch + ASAP-corpus model weights; doesn't know our coordinate metadata.

**Why**:
- The literature (Cemgil/Kappen, Raphael, Nakamura, Ellis, Klapuri) is mature, but the academic problem assumes audio onset detection from acoustic input. Our input is symbolic, our tempo is near-constant, and our time signature is user-supplied — three constraints that collapse the academic search space dramatically. The "load-bearing step every OSS pipeline skips" is the DP over notation-grids, not per-note snapping; building that as ~200 lines was cheaper than wrangling an external dependency.
- `TIE_COST: 0.40` is tuned so that "dotted half rest from beat 1" (cost 0.35) beats "quarter + half rest tied" (cost 0.45), and "quarter + half rest starting on beat 2" beats "dotted half rest across the bar midpoint" (whose boundary penalty balloons to 1.25). This matches standard engraving rules without hard-coding them.

**Where**:
- `src/transcription/{types,onsets,tempo,beats,meter,chords,quantize,voicing,pitch,lyEmit,index}.ts`
- UI hook: "Export .ly" button + modal in `src/ui/recorder.ts`; dialog in `index.html`.
- `?hklrec=1` exposes `__hkl_rec.transcribe(opts)` for DevTools verification.

---

## Path A (Finale 25 + Wine + RGP Lua bridge) ruled out by spike (2026-05-16)

**Picked**: Do not pursue a Finale 25 plugin for HKL-driven note entry. Pivot to HKL Composer (Verovio-backed standalone app).

**What was tried** (`tools/finale-bridge/` spike, 2026-05-16):
- S1 (RGP Lua loads under Wine + Finale 25) — ✓
- S2 (per-notehead color via `FCNoteheadMod`) — ✗
- S3 (LuaSocket TCP polling under Wine) — ✗

**Why dismissed**:
- **The Finale PDK Framework exposes no per-notehead color setter anywhere.** Exhaustive search of the public method index (pdk.finalelua.com) shows `Set*Color*` methods only on `FCGridsGuidesPrefs` (grid/guide preferences). `FCNoteheadMod`, `FCEntryAlterMod`, `FCNote`, `FCNoteEntry` have no color members. The PDK can set notehead font/char, but not RGB. Per-note color in Finale 25 is available only via the manual UI (Edit Filter → color), not scriptable.
- **Workarounds are too limited for HKL's palette**: 4-layer routing gives at most 4 simultaneous colors (vs. our 7-hue × dark/light × septimal variants); SMuFL character swaps are brittle and don't preserve note semantics.
- **LuaSocket isn't bundled** with RGP Lua. `luaosutils.internet` ships but is HTTPS outbound only — Finale cannot be a TCP server. Workable by flipping direction (HKL hosts HTTP, Finale polls) but moot once color is off the table.
- The headline value of bridging HKL into Finale was the per-(q,r) notehead color. Without that the side-channel adds nothing the user doesn't already have from existing Finale Speedy Entry on a piano.

**Where**:
- `tools/finale-bridge/` — spike scripts (`spike-1-hello.lua`, `spike-2-color.lua`, `spike-3-poll.lua`) + README with the decision matrix. Gitignored (this directory is in `.gitignore`).

---

## Verovio over LilyPond for live composition rendering (2026-05-16)

**Picked**: Verovio (RISM Digital Center, v6.1.0, in-browser WASM, MEI in / SVG out) as the engraving back-end for HKL Composer. Frescobaldi / LilyPond binary kept as the *batch* transcription target for `.hkr` → `.ly` (recording-based path) but NOT used in the live editor.

**Rejected** (after research):
- **Frescobaldi as live preview surface for streamed `.ly` writes**: confirmed via doc + source review that Frescobaldi has no auto-reload watcher. Best case is a Qt "file changed" prompt on focus; worst case a silent stale buffer. F5 reload would be manual per change.
- **LilyPond binary for live re-renders**: typical compile times are ~1–3 s (Guile startup dominates the cost even on empty files). Not "live" by keystroke standards.
- **`midi2ly` and similar batch tools**: not suitable for live entry (no incremental update path).
- **Drawing notation with bare SVG / VexFlow**: VexFlow exists and is mature for rendering chord/measure widgets but isn't engraving-quality. Verovio renders SMuFL glyphs and applies real engraving rules (collision avoidance, beam slants, accidental layout) at sub-100 ms per chord — comparable in quality to Finale/Sibelius output, faster in browser than any LilyPond round-trip can match.

**Why**:
- Verovio's render is sub-100 ms on small scores. Re-rendering on every chord entry feels instantaneous. This is the load-bearing property for a Speedy-Entry-style workflow.
- MEI's `<note color="#RRGGBB">` is in the MEI 5 schema directly. Per-notehead RGB in chord brackets works without overrides. CSS `.stem`, `.flag`, `.accid` can be forced back to black via `!important` so only noteheads carry the lattice color.
- Click-to-locate is trivial: every MEI `xml:id` becomes the corresponding SVG element's `id`. `event.target.closest('g.note').id` resolves to the MEI element.
- Playback-position sync is first-class: `tk.getElementsAtTime(ms)` returns the active element ids, `tk.getTimeForElement(xmlId)` is the inverse.

**What Verovio does NOT give us** (we build):
- The composition UX — cursor model, navigation, insert/delete operations, voice management, duration changes, pitch changes. Verovio's `edit()` API exists but is explicitly "experimental code not to rely on" and supports only `drag` (move existing element) and `insert` (low-level). All high-level composition operations are HKL Composer code.
- Cursor rendering — Verovio has no built-in cursor. Composer draws its own SVG overlay layered on top.

**Where**:
- `src/composer/render.ts` — Verovio toolkit init, render loop, view mode (scroll/page).
- `src/composer/verovio-types.ts` — narrow TypeScript declarations for the toolkit methods we use.
- Verovio loaded from CDN (`https://www.verovio.org/javascript/latest/verovio-toolkit-wasm.js`) via dynamic script injection — no npm dependency to keep the HKL bundle slim. ~6–8 MB gzipped WASM, 200–800 ms startup.

---

## HKL Composer as a multi-page Vite entry, not a separate project (2026-05-16)

**Picked**: Add a second HTML entry (`composer.html` at repo root) alongside the existing `index.html`. Configure `vite.config.ts` with `build.rollupOptions.input` for both. Both bundles share `src/*` modules. The composer entry imports `src/bridge/*` plus a narrow set of pure helpers from `src/transcription/pitch.ts` and `src/tuning/notes.ts`; it does NOT import `src/audio`, `src/midi`, `src/state`, or `src/lumatone`.

**Rejected**:
- **Separate repo / separate package.json**: would force code duplication for the tuning/coords helpers Composer needs, plus a release cycle decoupled from HKL. The two apps are versioned together by design.
- **Composer as a "mode" inside HKL** (same HTML, toolbar toggle): tangles the data models — HKL's selection/audio state would have to coexist with Composer's MEI/cursor state in the same global scope. Two tabs gives us free process-isolation of those state worlds.
- **Composer as an iframe inside HKL**: introduces postMessage round-trips even for purely-Composer concerns and breaks DevTools console scoping.

**Why**:
- Vite's multi-page support is first-class; one config change covers it. Bundles split cleanly (composer-only Verovio WASM doesn't pollute the HKL viewer bundle).
- Two tabs = two BrowsingContexts with their own DOM, history, and devtools but same-origin (so `BroadcastChannel` works without a network hop). The user explicitly wanted this shape — opens HKL in one tab, Composer in another, switches between them like any other browser-native app pair.
- The hard separation of `src/composer/` imports (no `src/audio`, `src/midi`, etc.) keeps the bridge surface honest: anything Composer needs from HKL must travel through the protocol, not through a shared module. Verifiable via grep, not just convention.

**Where**:
- `composer.html` — entry HTML at repo root.
- `vite.config.ts` — `build.rollupOptions.input.{main, composer}`.
- `src/composer/` — Composer-only modules.

---

## Bridge transport: BroadcastChannel with fully-resolved chord data (2026-05-16)

**Picked**: `BroadcastChannel('hkl-composer-bridge')` for HKL ↔ Composer messaging. All chord data flowing over the channel is fully resolved by HKL — Composer never sees raw `(q, r)` pairs without `{pname, accid, oct, midi, colorHex, velocity}` already attached.

**Rejected**:
- **`postMessage` via `window.opener`**: requires Composer to be opened by HKL (no opener if user opens composer.html directly).
- **SharedWorker**: persists across tabs but needs a worker file, lifecycle management, and a typed channel layer of its own. Overkill for two-app messaging.
- **WebSocket via a local helper process**: an external Node process adds an install step and a failure mode neither browser tab has alone. Justified for HKL ↔ Wine bridging (Path A's hypothetical scenario), not for same-origin tabs.
- **Send raw `(q, r)` and let Composer resolve via shared tuning helpers**: would force Composer to import `src/state/tuning` and `src/tuning/*` to compute names/colors, defeating the decoupling.

**Why**:
- BroadcastChannel is sub-millisecond, same-origin, no boilerplate, supported in Firefox and Chromium. No external processes; no install steps.
- Fully-resolved payloads let Composer be input-agnostic. HKL knows whether the keys came from Lumatone, QWERTY, or mouse; Composer doesn't need to. The bridge protocol becomes the only shared contract.
- The protocol is one file (`src/bridge/protocol.ts`) and a typed wrapper (`src/bridge/channel.ts`). Both sides import the type definitions; mismatched fields fail at compile time.

**Where**:
- `src/bridge/protocol.ts` — `HklEvent`, `ComposerEvent`, `ResolvedNote`, `CoordRef`, `PlaybackEvent` type definitions. Constants: `CHANNEL_NAME`, `PROTOCOL_VERSION`.
- `src/bridge/channel.ts` — `BridgeChannel<In, Out>` generic wrapper; `createHklBridge()` / `createComposerBridge()` factories.
- `src/bridge/hkl-side.ts` — HKL-side subscriber. RAF polls `selection.selectedKeys` and broadcasts held-keys diffs; dispatches incoming `play-chord` / `play-score` to the audio engine; suppresses broadcasts while `playbackActive` is true to avoid feedback.

---

## `.hkc` canonical save format = MEI 5 XML with `data-q` / `data-r` extensions (2026-05-16)

**Picked**: HKL Composer saves to `.hkc` files which are just MEI 5 XML with `data-q` and `data-r` attributes on every `<note>` carrying the lattice coordinates. MEI's spec is permissive about unknown attributes (they're ignored by validators), so a `.hkc` file opens in any MEI-aware viewer (Verovio web demos, MuseScore via the Humdrum bridge, etc.) — the only thing those viewers lose is the lattice identity, not the displayed score.

**Rejected**:
- **Custom JSON format** that bundles MEI as a string + extra metadata: forces a parsing layer on every load, and the metadata is `(q, r)` per-note anyway — there's no extra info worth a separate envelope.
- **Compress as `.hkcz` (zipped MEI)**: meaningful savings only on very large scores; .hkc text-XML compresses well at HTTP/storage layer if needed.

**Why**:
- MEI is Verovio's native input format. Round-tripping through it has zero loss for everything Verovio renders.
- `data-q` / `data-r` are valid HTML5/XML attribute names (the `data-*` namespace is officially open for custom attributes). MEI parsers ignore them; HKL Composer reads them on load to drive playback (`coordToKeyId` for the play-chord/play-score dispatch).
- MusicXML export is one-way (lossy via Verovio's importer per known limitations on dynamics/repeats), but pitches/rhythms/colors round-trip cleanly. Users who want WYSIWYG editing in Finale/Sibelius can `.musicxml` export and re-import there.

**Where**:
- `src/composer/model.ts` — MEI DOM construction with `data-q`/`data-r` on every `<note>`.
- `src/composer/save.ts` — `saveHkc`, `loadHkcFromFile`, `exportMusicXml`, `downloadMusicXml`.

---

## Path C → Path C-Full → "HKL Composer as standalone tool" framing (2026-05-16)

**Picked**: Treat HKL Composer not as a "feature inside HKL" but as a sibling application that uses HKL as its input device. Ambition: become the user's primary composition surface, eventually replacing Finale for day-to-day work.

**Rejected** (earlier framings considered during planning):
- **"Path C2" — one-shot HKL Speedy Entry → MusicXML → external editor**: user pushed back. Without in-editor edit-during-input (cursor navigation, voice targeting, in-place modification), the workflow isn't meaningfully better than text-editing LilyPond by hand.
- **"Path C / Path C-Full" framing as a feature of HKL**: this framing under-budgeted the editing UX. Verovio handles engraving; the *editor* is the bulk of the work and lives in HKL Composer.

**Why**:
- The user explicitly framed the criteria as: live preview, Speedy-style entry, backspace, four voices, cursor navigation, insert/overwrite modes, save/load, MusicXML export, playback with cursor follow. These define a real notation editor, not a thin feature.
- The decoupled architecture (bridge protocol, MEI canonical, Verovio engraver) means the editor's growth doesn't bloat HKL's audio/MIDI codepath. New features in Composer (tuplets, dynamics, articulations, ornaments, multi-instrument scores, PDF export, undo/redo) land under `src/composer/` and don't touch HKL.
- The user's stated playback need ("HKL keys highlight + cursor moves on each voice + return-to-original-position on stop") is already met by the v1 architecture without changing HKL's audio engine — confirmation that the decoupling is right.

**Where**:
- Planning file (transient): `/home/max/.claude/plans/now-that-we-have-idempotent-pudding.md`.
- All Phase 1 implementation under `src/composer/`, `src/bridge/`, `composer.html`, and `vite.config.ts`.

---

## Per-key velocity calibration metrics: p5/p95 over mean/CV (2026-05-17)

**Picked**: Per-key velocity diagnostic surface uses `p5` and `p95` (outlier-rejecting velocity floor and ceiling) as the primary metrics. Three outlier categories tied to direct hardware actions: "Can't play quiet" (p5 > 30 → raise MAX), "Can't play loud" (p95 < 100 → raise MIN), "Narrow range" (p95−p5 < 60 → raise MAX, accept hardware ceiling, lean on HKL gain/curve for residual).

**Rejected**:
- **Mean + coefficient-of-variation (the initial implementation)**: built on a noise-floor hypothesis where MIN=0 was supposed to be catching rest-state sensor noise, producing random velocity output. CV>0.3 was the predicted alarm. Empirically refuted on Max's unit: across 280 keys with MIN=0 and full play-through, **zero keys** showed CV>0.3. The "random velocity" symptom Max originally reported was actually constrained-range keys feeling inconsistent because their narrow output range got stretched across his intended dynamics — diagnosable by p5/p95 but invisible to mean/CV.
- **Raw ADC capture via SSH backchannel**: technically reachable but ~3× the implementation cost and would mostly tell us what MIDI velocity statistics already encode. Deferred indefinitely.

**Why**:
- MIN/MAX are independent monotonic knobs that shift the velocity distribution. Mean only captures the center; CV only captures variance. Neither identifies which *end* of the velocity range is constrained, which is what determines whether to raise MAX (drops p5) vs raise MIN (lifts p95).
- p5/p95 are outlier-resistant (one weird press doesn't move them), but still capture the "this is what realistic play can actually produce" envelope.
- The three failure modes map directly to actions: position on a (p5, p95) scatter plot identifies the right hardware knob without further interpretation.

**Constraint surfaced**: The threshold tuning ceiling is the key's intrinsic dynamic range — physical ADC swing × user's hand-speed range. MIN/MAX position the velocity distribution within that envelope but cannot independently expand both ends. Keys hitting that ceiling get residual range bridged by HKL's per-key gain and global curve.

**Where**:
- `src/audio/velocityCal.ts` — `KeyStats` now carries `p5`/`p95`; `KeyStatsSnapshot` persists them.
- `src/state/persistence.ts` — `KeyStatsSnapshot` interface; validator gracefully accepts older snapshots that lack p5/p95 by approximating from mean±stddev.
- `src/lumatone/lumadiag.ts` — scatter axes are (p5, p95); outlier lists are the three action-oriented categories; inspector histogram has p5/p95 markers.

---

## Per-key calibration via bulk-raise + per-key rescue (2026-05-17)

**Picked**: Convergence pattern is *asymmetric*. Raise MAX globally via `--bulk-raise`, identify the small minority of keys that go dead at the new level, rescue them individually with single-key writes. Iterate 3-4 global passes; `--bulk-raise` only writes keys whose current value is below the target so each pass preserves prior rescues automatically.

**Rejected**:
- **Per-key bottom-up tuning** (raise each key independently until it's just-right): correct but expensive (~280 iterations of bisecting per key) and unnecessary — most keys have plenty of physical swing headroom and behave well at any reasonable MAX.
- **Stats-driven per-key target computation** (read p95 → compute per-key MAX): would require coordinating data flow from HKL localStorage → BBB script. Not needed when the empirical iteration converges fast.
- **Lower-then-raise** (start permissive, iteratively narrow): biased the wrong way. The keyboard's worst-case key dictates the floor, but most keys want more space.

**Why**:
- Empirically Max's keyboard has ~5-20 dead keys at MAX=100, fewer at 130, very few at 160. Healthy keys dominate. Asymmetric search converges in ~1 hour vs. days of per-key bottom-up.
- `--bulk-raise` semantics make iteration safe: prior per-key rescues at a lower MAX stay lower because they're already below the next target. No script needs to track which keys were hand-tuned.

**Where**:
- `tools/lumatone-cal/keydata-live.py` — `--bulk` (unconditional), `--bulk-raise` (only-if-below), `--bulk-lower` (only-if-above) commands.
- `docs/lumatone-calibration.md` — full workflow procedure under "Workflow: full-keyboard calibration".

---

## Composer cursor: linear flat-children across measures (2026-05)

**Picked**: The cursor is a single integer per voice, indexing into the *concatenated* flat stream of `(chord|note|rest|space-placeholder)` content across all measures, in measure order. `locateCursor(voice, c)` maps that integer to `(measureIdx, layer, withinIdx)` at insertion-point semantics; `locateFlatElement(voice, idx)` does element-at-index lookup at strict-less-than semantics for deletes.

**Rejected**: A per-measure cursor — `{ measureIdx, withinIdx }` — would have matched MEI's tree shape more directly, but every navigation primitive (arrow keys, voice switch, dot/tie targeting) becomes two coordinates that need to be moved in concert. The linear-integer model collapses voice traversal to `cursor++` / `cursor--` and keeps `getCurrentElement` and friends as one-liners.

**Why**: the keyboard flow is sequential — the user enters notes one after another, occasionally backing up. They don't usually think "measure 3 beat 2" while entering; they think "the next note" or "the previous note". Linear cursors match that mental model. Multi-measure traversal is automatic.

**Constraint surfaced**: boundary semantics get subtle. Cursor=N at a position where flat[N] is in measure m+1 and flat[N-1] is in measure m means "the cursor sits between m and m+1." For insertion, that should target m's trailing edge OR m+1's leading edge depending on context. We use strict-less-than for the locator (cursor advances to next layer at boundary) plus a special-case override in `insertWithSplit` for the "partial real measure followed by placeholder-only measure" case (extends m₁ rather than consuming m₂'s placeholder).

**Where**:
- `src/composer/model.ts` — `flatChildren`, `locateCursor`, `locateFlatElement`, and every navigation/mutation that consumes a cursor.

---

## Composer empty-voice placeholders: `<space>` over `<mSpace>`, `<mRest>`, or manual SVG (2026-05)

**Picked**: every layer with no real content carries one or more `<space dur="…" data-placeholder="true">` children whose ticks sum to the measure's full duration. Verovio honors `<space dur>` as a width-reserving layout-only element (no glyph drawn). Placeholders also count as flat-children, so the cursor can navigate to an arbitrary measure of an otherwise-empty voice. The `data-placeholder="true"` private attribute distinguishes them from any user-meaningful `<space>` elements (we don't emit those today; the marker is defensive).

**Rejected**:
- `<mSpace/>` — the standard MEI "tacit measure" marker. Verified via headless inspector: **zero layout effect** in Verovio. Same bar-line / staff-line gap as a truly-empty layer.
- `<rest dur="1">` with `@visible="false"` — proper layout width allocation, but `@visible="false"` is NOT honored by Verovio. The rest renders visibly.
- Hand-drawing the empty-measure layout (cursor overlay covering Verovio's degenerate bbox + custom barline placement) — too invasive, fragile across Verovio updates, fights the engraver.

**Why**:
- `<space>` is the only MEI element we tested that both reserves measure width AND draws nothing.
- Using it as a navigation target lets the user start a voice partway through the score without manually entering whole rests to reach that measure. The lattice-coord-driven workflow benefits.
- The placeholder invariant ("a layer either has real content OR has placeholders summing to measure, never both") is enforced by `normalizePlaceholders()` called from every mutation entry point. Idempotent and cheap.

**Where**:
- `src/composer/model.ts` — `normalizePlaceholders`, integration with insert/delete/replace, `replaceDocument` migration.
- `src/composer/cursor.ts` — staff-anchored fallback positioning for placeholder targets (degenerate bbox).
- `src/composer/playback.ts` — `<space>` advances voice clock silently so empty-voice measures correctly time-shift later content.
- `src/composer/save.ts` — MusicXML export skips placeholders; the padding-with-rest logic handles voice-silent-this-measure naturally.

---

## Composer accidentals: clamp at ±3 + per-staff carry-state display pass (2026-05)

**Picked**: Composer supports alterations from ±1 to ±3, expressed as a single canonical MEI accidental token (`s`, `f`, `x` for ×, `ff`, `ts`, `tf`). Higher alterations are FILTERED OUT at entry in `input.ts:commitDuration` with a status message. The accidental display pass runs at serialize-time on the cloned doc, walks per-measure per-staff, and decides each note's `@accid` (visible) vs `@accid.ges` (hidden) based on carry-state + key signature.

**Rejected**:
- **Multi-`<accid>` children for compound alterations** (e.g., `<accid x/><accid x/>` for ×4). MEI 5 allows it; Verovio source has comments suggesting it handles spacing. **It doesn't, in practice** — headless verification: two children render at identical bbox, complete overlap. Fixing would require Verovio patches or hand-positioning glyphs (which spirals into reserving layout space). User accepted clamping at ±3.
- **`@accid="ss"` (precomposed `##`)** instead of `@accid="x"` (canonical ×) for double-sharp. Both are valid MEI 5 tokens but map to different SMuFL glyphs (U+E269 vs U+E263). × is the conventional engraving form.
- **Bridge-side clamping** at ±3. The bridge passes through the full HKL spelling string; clamping happens in Composer's entry path. Keeps the bridge a simple passthrough.

**Why**:
- The single-token range covers 99%+ of real-world cases. ±4+ on HKL's lattice means extreme positions you'd practically reach only via septimal shifts; the user can re-spell.
- Single-token form is idempotent across save/load and supports clean visibility hiding via `@accid.ges` (one attribute, lossless gestural pitch).
- Per-staff (not per-voice) carry-state matches engraving convention.

**Constraint surfaced**: a previous iteration tried multi-`<accid>` stacking with greedy decomposition (one triple `ts` first, then doubles `x`). Headless inspection caught the overlap. The whole feature was reverted to single-token + entry filter; legacy `.hkc` files that briefly saved with `<accid>` children get migrated on load to a single clamped `@accid`.

**Where**:
- `src/composer/accidentals.ts` — `alterFromCount`, `alterFromToken`, `tokenFromAlter`, `getNoteAlter`, `computeAccidentalDisplay`.
- `src/composer/model.ts` — `buildNoteElement` emits single `@accid`; `replaceDocument` migrates legacy forms.
- `src/composer/input.ts` — `commitDuration` filters held notes with `|alter| > 3`.

---

## Composer ties: private stub flags + bidirectional partner pointers + auto-resolve on insert (2026-05)

**Picked**: realized tie pairs use single-letter `@tie` values (`i`/`m`/`t`) per MEI 5. Each side carries a `data-tie-partner` custom attribute pointing at the partner's xml:id for O(1) orphan lookup. Stubs (a tie initiated by `=` with no destination yet) use a private `data-pending-tie="true"` attribute and have no Verovio rendering. They auto-resolve into a real `@tie="i"/"t"` pair when a matching pitch is entered after them.

**Rejected**:
- **Compound `@tie="ti"` / `"it"` for medial pieces** — not valid MEI 5; Verovio rejects with `Unsupported data.TIE 'ti'`. Use `m` for medial.
- **`<lv>` (laissez vibrer)** for stub ties — Verovio renders nothing without `endid` or `tstamp2` (implements older MEI 4 stricter rule). `@dur` isn't consulted. Tested several configurations, all silent.
- **`@tie="i"` (single MEI form) on a stub** — same silent rendering AND triggers "Expected median or terminal" warnings.
- **Console-level suppression of Verovio tie warnings** — user rejected; tie warnings are diagnostically useful elsewhere.

**Why**:
- Single-letter `@tie` is the only form Verovio reliably renders.
- Bidirectional `data-tie-partner` makes orphan unwind O(1).
- Auto-resolve at insert time means the user doesn't have to remove and re-add a stub once they've entered the destination note.

**Where**:
- `src/composer/model.ts` — `toggleTieOnCurrent`, `resolvePendingTies`, `orphanTiePartners`, chain-tie wiring in `insertWithSplit`.

---

## Composer time-sig change: per-measure truncation over rebuild-and-reflow (2026-05)

**Picked**: when the user changes the meter, walk each measure × voice's layer in place. Find the FIRST element that overflows the new measure's tick budget; shorten it to fit (or drop if `remaining === 0`); drop everything after. Re-normalize placeholders; clamp cursors; re-apply barlines. Measure count is preserved; enlarging is a no-op.

**Rejected**: an earlier `rebuildMeasureLayout` flattened all content per voice, coalesced tied chains into single notional events, tore down every measure, built a fresh measure 1, and replayed the streams through `insertChordAtCursor`-with-auto-split. Worked when the model was simple but became misaligned once placeholders / multi-measure / per-measure invariants landed.

**Why**:
- Truncation respects measure boundaries the user has laid out. Going from 4/4 → 3/4 keeps each measure's first three quarters and drops the fourth; reflow would shift everything.
- The truncation algorithm is O(notes-per-measure) and uses existing orphan-cleanup primitives. The rebuild path had ~80 lines of snapshot-and-replay with tie-chain coalescing logic that misbehaved when key-sig / tempo / accidental state was involved.
- "Don't surprise me when I change the meter" — truncation is predictable.

**Constraint surfaced**: tied chains crossing the new truncation point unwind via `orphanTiePartners`, but no automatic re-tying under the new meter. Documented as out-of-scope.

**Where**:
- `src/composer/model.ts` — `truncateOverflowingMeasures`, `truncateLayer`, `setTimeSig`.
- `src/composer/setupDialog.ts` — confirmation prompt only when the new meter is SMALLER and content exists.

---

## Composer rendering polish: notehead-on-top + geometricPrecision everywhere (2026-05)

**Picked**:
- After every Verovio render, `render.ts` walks each `<g class="note">` and moves its `<g class="notehead">` child to the LAST sibling position so SVG document order puts the colored notehead ON TOP of the black stem.
- All strokes (staff lines, ledger lines, bar lines, stems) use `shape-rendering: geometricPrecision` in CSS.

**Rejected**:
- Default Verovio child order (notehead first, then stem) — stem then paints over the colored notehead, producing a visible black intrusion into the colored circle.
- `crispEdges` selectively per-element — caused inconsistent stem widths (1px vs 2px depending on sub-pixel x parity) and the empty-initial-measure bar-gap problem. Degrades badly at high zoom-out: 1px strokes round to 0.

**Why**:
- DOM reorder is a 4-line post-process; doesn't fight Verovio's layout. SVG z-order = document order.
- `geometricPrecision` anti-aliases sub-pixel positions so every stroke renders to its specified width regardless of placement. Foundation for in-app zoom control: at high zoom-out, anti-aliased strokes fade to a faint line instead of disappearing.

**Where**:
- `src/composer/render.ts` — notehead-on-top reorder after `tk.renderToSVG`.
- `composer.html` — single CSS rule covering all stroke classes.

---

## Composer headless inspection tool (2026-05)

**Picked**: `tools/composer-inspect/inspect.mjs` — Node script that launches headless Chromium via remote-debugging-port, navigates to the running dev server's `/composer.html`, waits for Verovio WASM to load and render, runs an arbitrary JS expression in the page context via CDP `Runtime.evaluate`, and prints the result as JSON. No npm dependencies (uses Node 22+'s native WebSocket + chromium in PATH).

**Rejected**:
- Playwright / Puppeteer — adds a dev dependency and ~250 MB of browser binaries (Chromium is already on the system).
- Manual browser cycle for every iteration — slow and error-prone for Verovio rendering details that vary 1-2 px between cases.

**Why**:
- Verifying engraving details (where exactly does the bar line land vs the staff lines? what SMuFL glyph rendered for `@accid="ts"`? does Verovio space multi-`<accid>` children apart?) requires reading the rendered SVG, not the MEI input. The DOM is only available after Verovio runs in a real browser context.
- Many decisions in this iteration cite "headless verification" — the tool is what made those decisions empirical rather than speculative.
- Reusable for future iteration: any time Composer's rendering needs verification, `node tools/composer-inspect/inspect.mjs '<JS-expr>'`. No setup beyond `npm run dev`.

**Where**:
- `tools/composer-inspect/inspect.mjs` — the script; ~110 lines.
- Used heavily across the May 2026 Composer engraving sessions.

## Composer expression layer: tstamp anchoring over startid (2026-05-17)

**Picked**: `<dynam>` and `<hairpin>` anchor by `@tstamp` (and `@tstamp2` for hairpin spans), NOT by `@startid`/`@endid`. The expression element is a sibling of `<staff>` inside its measure, glued to a beat moment.

**Rejected**: anchoring dynamics / hairpins by `@startid` to a note's `xml:id`. This was the initial proposal and is the more common MEI convention for editors that prioritize re-bar stability.

**Why**:
- The user's primary requirement was that expressions survive deletion of nearby notes. With `@startid`, deleting the anchor note either orphans the expression (Verovio can't render it) or requires cascade-delete logic that loses user intent. With `@tstamp`, the dynamic stays exactly where the user put it on the timeline regardless of what notes come and go.
- Conventional notation behaves this way: an `f` marking on beat 2 of measure 3 is "at beat 2 of measure 3", not "attached to whatever note is here right now". The mental model is time-based.
- Re-barring (changing meter) is a less common operation than note editing. The trade-off (tstamp positions don't move with a re-bar) is acceptable; if it bites in practice, we can migrate orphaned expressions at time-sig change.

**Caveat (recorded in lessons.md)**: slurs and articulations DO stay note-attached. A slur is inherently "from this note to that note"; an articulation is inherently "on this note". Different semantics → different anchoring.

**Where**:
- `src/composer/expressions.ts:addDynam` / `addHairpin` emit `@tstamp` + `@tstamp2`.
- `src/composer/playback.ts:buildVelocityLookup` resolves moments → absolute ticks via `absoluteTickForMoment` keyed off the document meter.

## Composer expression layer: virtual "fifth voice" cursor over modal toggle (2026-05-17)

**Picked**: a fifth navigation position between voices 2 and 3 (cycle `1 → 2 → expr → 3 → 4`), with its own moment-snapping cursor that visits the union of {all note onsets across all voices} ∪ {existing dynam/hairpin moments}. Selection is implicit — whatever dynam exists at the cursor's moment, plus any hairpin whose [start, end] range contains it, is "selected" and highlighted.

**Rejected**:
- Modal toggle (press `e` to enter expression-edit mode, press `Escape` to leave). Less discoverable; the user has to remember a special hotkey.
- Per-voice expressions (each voice gets its own dynamic layer). The user explicitly wanted "applies to all staves" semantics; cluttering by voice would defeat that and the moment-snap dedup logic.

**Why**:
- Cycle-through navigation reuses the existing ArrowUp/Down voice-switch hotkeys — zero new keybindings to learn.
- "Between voices 2 and 3" matches the visual placement of `@place="between"` dynamics in MEI grand-staff rendering, so the position in the cycle mirrors the position on the page.
- Moment-snap guarantees no expression can ever be orphaned: even if a user enters a dynam at a moment, then deletes every note around it, the cursor can still reach that moment because the existing dynam contributes its moment to the snap-list.

**Where**:
- `src/composer/expressionCursor.ts` — moment list construction + cursor state.
- `src/composer/input.ts:cycleVoice` — five-position cycle.

## Composer velocity model: note-onset only for MVP (2026-05-17)

**Picked**: each `PlaybackEvent` carries a single `velocity` computed from the dynamic-level-at-tick plus hairpin interpolation. Held notes spanning a hairpin keep their strike velocity throughout — only newly-struck notes within the hairpin's range pick up the interpolated level.

**Rejected**: continuous-loudness shaping via synthesized aftertouch ramps on the existing `pressureGain` chain. The audio engine already supports this (`handleAftertouch(key, pressure)` ramps `pressureGain` smoothly), but driving it requires a new bridge message type that schedules timed pressure events per held note, which is non-trivial wiring.

**Why**:
- Onset-only velocity is the simplest possible playback semantics — pre-baked into the event list, no real-time control needed.
- For most musical contexts (especially the user's piano use case where notes decay anyway), continuous shaping of held notes during a hairpin is a small refinement over per-onset levels.
- The bridge protocol's new `velocity?: number` field on `PlaybackEvent` is forward-compatible: when continuous shaping lands, we can add an optional `pressureRamp?: ...` envelope alongside it without breaking anything.

**Where**:
- `src/bridge/protocol.ts` — `PlaybackEvent.velocity?: number`.
- `src/composer/playback.ts:buildVelocityLookup` — piecewise + linear-interp lookup.
- `src/bridge/hkl-side.ts:dispatchChord` — applies `ev.velocity ?? keyVelocity[k] ?? 80`.

---

## Velocity shaping: software input curve over hardware MAX raising (2026-05-17)

**Picked**: Lumatone-input-only velocity remap inside HKL — a `floor + (ceiling - floor) · (v/127)^gamma` curve in velocity space, applied at `midi/handler.ts` before raw velocity lands in `audio.keyVelocity[key]`. Identity by default; dialed in via lumadiag. Lumadiag stats keep sampling RAW velocity so the (p5, p95) scatter continues to reflect the firmware envelope. Phase B (deferred): bake the dialed-in curve into a 128-entry SysEx 0x08 LUT and push it to the firmware so external consumers of raw Lumatone MIDI see the shaped values too.

**Rejected**:
- **Continued iterative hardware MAX raising via `--bulk-raise` / `--bulk-change`**: the prior strategy (`decisions.md` entry "Per-key calibration via bulk-raise + per-key rescue (2026-05-17)" above) assumed a manageable casualty distribution as MAX climbed. Empirically on Max's keyboard, dead-key count jumps from ~3 at MAX=70 to 20+ at MAX=80 — the asymmetric rescue search degenerates. And even on surviving keys, p5 doesn't drop when MAX rises; the firmware's press-time → velocity LUT is insensitive to where the measurement window sits within Max's narrow physical ADC swing.
- **Audio-stage curve as the primary dynamic-range lever**: the existing `floor + gamma + ceiling` audio gain curve already handles tonal shaping, but it only fires inside the audio engine — recording and MIDI export still hold the raw firmware-compressed values. Putting the dynamic-range fix there leaves DAW round-trip exports flat.
- **Per-input shaping for QWERTY / mouse-click**: those sources emit clean fixed velocities (typically 100); running them through the curve would unexpectedly crush them. Curve is Lumatone-MIDI-only.

**Why**:
- The hardware lever (MAX) is physically gated by the keyboard's ADC swing distribution. For keyboards with a tight swing distribution like Max's, it's exhausted. Software shaping is the only remaining lever.
- Placing the curve at the MIDI input boundary makes it the single source of truth — audio engine, recording (`.hkr`), MIDI export (`.mid`), and bridge events to Composer all see the same shaped values.
- Identity-by-default + lumadiag preview means it's invisible until tuned; existing setups don't break on upgrade.
- The same parameter shape as the audio-stage curve keeps the user-facing model coherent (two curves, one in velocity space at input, one in gain space at audio).
- Phase B (firmware LUT bake) gives external consumers the same benefit and increases input resolution (with identity LUT, firmware-side range compression halves the input bins HKL receives).

**Constraint surfaced**: the prior `decisions.md` entry's optimism about asymmetric MAX-raising was unit-specific. The intrinsic-dynamic-range envelope (`decisions.md:749`) varies dramatically by keyboard; some units may need software shaping immediately and never need hardware MAX-raising at all.

**Where**:
- `src/audio/velocityCal.ts` — `inputCurve` state, `applyInputCurve`, `setInputCurveFloor/Ceiling/Gamma`, `resetInputCurve`, `isInputCurveIdentity`.
- `src/midi/handler.ts` — Lumatone note-on entry: raw `d2` → `recordForStats` (diagnostic), then `applyInputCurve` → `audio.keyVelocity[key]` + `recordSample`.
- `src/state/persistence.ts` — `VelocityCalPrefs.inputCurve` (optional, gracefully loaded).
- `src/lumatone/lumadiag.ts` — "Input velocity curve (Lumatone)" subsection in the velocity calibration panel.

---

## Firmware velocity interval table (CMD 0x20) over HKL-side input curve (2026-05-18)

**Picked**: Push a user-tuned 127-entry press-time threshold table to the Lumatone firmware via SysEx `0x20 SET_VELOCITY_INTERVALS`. Lumadiag exposes a parametric `low/high/gamma` editor that builds the table via `thresh[i] = low + (high − low) · (i/126)^gamma`. The Phase A HKL-side input curve is demoted to an identity-default defensive layer (code retained, UI removed). CMD `0x08 SET_VELOCITY_CONFIG` stays at identity — that's the output-relabeling table and HKL has always pushed identity there.

**Rejected**:
- **Continue tuning via Phase A HKL-side input curve only**: HKL only sees post-binning MIDI velocity. With Max's compressed press-time range, the firmware emits ~30 distinct values out of 128 possible bins. The HKL curve stretches those 30 values across 0–127 but cannot synthesize values in between. Hits a resolution ceiling that software-side shaping fundamentally cannot exceed.
- **Bake the HKL curve into CMD 0x08 (the originally-planned Phase B)**: investigation showed CMD 0x08 is pure output relabeling, not bin distribution. Baking into 0x08 gives no resolution benefit over HKL-side shaping. Was a misread on my part; the user's intuition that the firmware exposed a *real* bin lever proved correct, just for a different command than I'd been targeting.
- **Auto-push interval table on Lumatone connection**: ruled out for the MVP because `midi/engine.ts` explicitly documents "We DO NOT auto-configure the device without Auto-sync checked." Existing identity LUT push is button-only; keeping interval table push button-only matches the established convention. Can revisit later if 0x20 turns out to be volatile across power cycles and re-pushing becomes tedious.

**Why**:
- Per `TerpstraSysEx.2014/Source/TerpstraMidiDriver.cpp:366–380` and `KeyboardDataStructure.cpp:49`, the firmware splits velocity processing into two independent tables. `0x20` defines the press-time tick thresholds (127 × 12-bit), `0x08` defines the bin → MIDI-velocity output mapping (128 × 7-bit). Tightening `0x20` into the user's actual press-time range increases the number of distinct velocity values the firmware can physically emit — software downstream cannot synthesize bins.
- 12-bit precision (0–4095) on tick thresholds is much higher than the 7-bit output space; this is the only place in the pipeline where that precision is exposed.
- Parametric `low/high/gamma` model matches the HKL audio curve's UX and is enough resolution for the use case. A draggable-points editor was considered but deferred — three sliders cover the actually-useful curve shapes.
- Migration: on `loadFromPrefs`, if a Phase A `inputCurve` is non-identity AND an `intervalCurve` exists, reset the inputCurve to identity. Prevents double-compression for users who tuned gamma=10 in Phase A and then upgrade.

**Constraint surfaced**: CMD 0x20 persistence semantics are unverified. The Terpstra driver source has `SAVE_VELOCITY_CONFIG (0x09)` for 0x08 but no apparent analogue for 0x20. If 0x20 doesn't survive power cycles, the user will need to re-push after each Lumatone reboot. Mitigation: button-only push is acceptable for the MVP; if it becomes painful, add an opt-in auto-push gated on `lumatone.autoSyncEnabled`.

**Where**:
- `src/lumatone/protocol.ts` — `SYSEX_CMD_SET_VELOCITY_INTERVALS = 0x20`, `buildSetVelocityIntervalConfig`.
- `src/audio/velocityCal.ts` — `intervalCurve` state, `setIntervalCurve{Low,High,Gamma}`, `resetIntervalCurve`, `buildIntervalTable`, `isIntervalCurveFactory`, Phase A migration in `loadFromPrefs`.
- `src/state/persistence.ts` — `VelocityCalPrefs.intervalCurve` (optional, validated).
- `src/lumatone/lumadiag.ts` — "Hardware velocity intervals (CMD 0x20)" subsection (replaces the Phase A "Input velocity curve" UI in the same slot), with factory-trace overlay on the preview canvas.

---

## Velocity curve calibration: γ_int=1.10, γ_audio=3.58, floor=0.03 (empirical, 2026-05-18)

**Picked**: After Phase C shipped, an empirical sweep against the full press-time → bin → velocity → audio-gain chain (sim at `/tmp/velocity_sim*.mjs`, regenerable) settled on:

| Parameter | Value | Source |
|---|---|---|
| `intervalCurve.low` | 3 | fastest reliable press time on Max's unit, ticks |
| `intervalCurve.high` | 50 | slower than the slowest natural "pp" press |
| `intervalCurve.gamma` | 1.10 | minimizes std-dev of dB-per-press-time step (0.13 dB) |
| audio-stage `gamma` | 3.58 | best-fit to preserve perceptual ramp with γ_int=1.10 |
| audio-stage `floor` | 0.03 | 30 dB curve dynamic range — "digital piano" convention |
| audio-stage `ceiling` | 1.00 | unchanged |

**Rejected**:
- **γ_int = 2 (matched to γ_audio=2)** — appealing theory ("matched power-law curves"), but math doesn't compose to uniform dB. Empirically: produces audible 1.7 dB stairsteps at the loud end because adjacent integer press-times land in non-adjacent bin indices (13-bin gaps). User can hear them in soft-of-loud passes.
- **γ_int = 1.0 (pure linear)** — almost as good as 1.10 for dB-step uniformity but very slightly worse. 1.10 wins the sweep by a hair.
- **Floor lower than 0.03** — produces full 40 dB acoustic-piano range, but ppp at −50 dB at the speaker (after polyphony clearance) drops near typical room noise floor. Defensible for headphone monitoring; impractical for typical home listening.
- **Floor higher than 0.03** — narrower than digital-piano convention. With normalized samples (no sample-side dynamic range), all dynamic range must come from the curve, so we need 30+ dB.
- **Range-shrinking fits (e.g. ceiling<1 to reduce dB-RMSE vs reference)** — the optimizer found these as numerical artifacts but they're cheating: smaller range divided by same step count gives smaller steps trivially. Reject by pinning ceiling=1.

**Why**:
- The composition of γ_int=k and γ_audio=k is *not* perceptually uniform — it's just a steeper power law. For true uniform dB-per-press-time, you'd want the press-time → velocity map to be exponential, not power-law, which the firmware can't produce. Linear is the closest power-law approximation that puts adjacent integer press-times in adjacent bins.
- 30 dB curve range matches typical digital piano touch curves. With HKL's sample loudness normalization (no sample-side dynamic range), the curve has to carry all the expressivity itself, so the upper end of the convention range is the right target.
- γ_audio=3.58 is the best-fit single power-law that reproduces the *shape* of the original (γ_int=2 + γ_audio=2) perceptual ramp when the input is a near-linear v(T). Loud end now flat (max 0.75 dB step), mid and soft within ~1 dB of the reference.

**Three-way trade-off** (worth naming for future tuning):
1. Uniform dB-per-press-time steps (achieved by γ_int=1.10)
2. Full 0 to −20 dB curve range (achieved by floor=0.10, ceiling=1.00)
3. Identical perceptual ramp shape to factory-style (γ_int=2 + γ_audio=2)

Any two can coexist; all three cannot. We picked (1) and (2)-ish (with floor=0.03 expanding the range to 30 dB beyond the original 20), accepting that loud-end *shape* deviates by 1–2 dB from the reference in the T=4–10 region — which is exactly where the reference had its audible stairsteps anyway. This deviation is the cost paid for smoothness.

**Where**:
- `docs/lumatone-calibration.md` — Phase 2b recipe.
- `src/audio/velocityCal.ts:DEFAULT_INTERVAL_CURVE`, audio `DEFAULT_CAL` defaults remain factory-shaped; user settings via lumadiag.
- Simulation at `/tmp/velocity_sim*.mjs` (regenerable from this entry for future re-sweeps).

---

## Velocity-event label semantics: integer press-time, not threshold pair (2026-05-18)

**Picked**: Loopdiag velocity-event labels show the actual integer press-time(s) that produce each emitted MIDI velocity, derived from the firmware's bin-rule `thresh[i-1] < T ≤ thresh[i]`. Format: `v124 (4t)` for single-integer bins, `v? (3–5t)` for multi-integer bins (rare with γ_int near 1), `v127 (≤3t)` and `v0 (>50t)` for the open-ended boundary bins.

**Rejected**: The earlier format showed `intTable[bin-1] – intTable[bin]` (a threshold pair). For γ_int=1.10 with `intTable[2]=3, intTable[3]=4`, this rendered v124 as `(3–4t)` — which read as "press_times 3 and 4 both produce v124." Actually only T=4 produces v124; T=3 produces v127 via bin 0. The threshold-pair format is unambiguous to someone who knows the open-closed semantics, but confusing to anyone (including the author) glancing at the readout.

**Why**: The integer press-time is what the user actually played. The threshold-pair was a leaky implementation detail.

**Where**:
- `src/audio/diagnostics/loopOverlay.ts` velocity-event label block.

---

## Velocity calibration final form: γ_int=1 + high=130 + γ_audio≈13.9 (2026-05-18)

**Picked** (supersedes the 2026-05-18 γ_int=1.10/γ_audio=3.58 entry above and the bake-LUT exploration that briefly followed):

| Knob | Value | Rationale |
|---|---|---|
| `intervalCurve.low` | 3 | user's fastest reliable press (PIC tick count) |
| `intervalCurve.high` | **130** | gives ~128 distinct integer thresholds across the 127 entries → near-1:1 tick→bin mapping → no irregular reachable-bin pattern from binary_search-on-duplicates |
| `intervalCurve.gamma` | 1.0 | linear distribution; only sensible value given the high=130 choice |
| audio `floor` | 0.03 | 30 dB curve range, digital-piano convention |
| audio `ceiling` | 1.00 | unchanged |
| audio `gamma` | **13.9** | empirical sweep finds this minimises dB-step stddev *subject to achieving the full ~30 dB range* on the user's natural press range (T = 3..50, vel = 80..127 under 1:1) |
| CMD 0x08 LUT | "identity-from-1" (`lut[0]=1`, rest identity) | gives emitted range 1..127 instead of 0..127 (a played note shouldn't emit MIDI vel 0 = note-off) |

**Rejected**:
- **`high=50`**: produces only 48 distinct integer thresholds across 127 table entries → binary_search on duplicates returns a non-uniform reachable bin pattern (alternating runs of 2 and 3 reachable bins). User's natural play range maps to 47 + 2 boundary bins ≈ 48 velocities, but the periodic step pattern (3 small dB steps + 1 big step) is audibly stuttered. The previously-recommended γ_audio=2.30 minimised dB-stddev under this constraint, but the max-step (1.43 dB) was visibly larger than the high=130 setup's (0.94 dB).
- **CMD 0x08 "bake" LUT** (briefly explored and removed): tried to map binary_search-reachable bins to evenly-spaced velocities. Unnecessary once we accept γ_int=1 and choose high appropriately — the reachable bin count is determined by the threshold *integer range*, and CMD 0x08 identity is already correct for "bin index = velocity output." Bake just re-encoded what CMD 0x20 already controlled.
- **Stevens-power-law-based γ_audio ≈ 1.67** (perceived-loudness-linear-in-tick): empirically valid as a theoretical target, but doesn't achieve the full 30 dB dynamic range pianists expect — gives ~7 dB range with high=130 or ~20 dB with high=50. Wrong tradeoff for piano feel.

**Why**:
- The integer-tick limit is the fundamental resolution floor. With low=3, high=50 you get exactly `high − low + 1 = 48` distinct integer thresholds, producing 48 + 2 ≈ 49 reachable velocity bins on the BBB's binary_search. Widening to high=130 gives 128 distinct thresholds, which is a 1:1 match for the 127-entry table — every adjacent tick produces an adjacent bin index, no irregular step pattern.
- The user's *physical* press-time range is still 3..50, so widening high doesn't increase the velocity count they actually reach (still 48). But it eliminates the irregular step pattern by ensuring binary_search always finds an exact match.
- Compressing the user's natural press range (vel 80..127) into the full 0 to −30 dB audio range requires a much steeper curve than the previous high=50 setup. γ_audio=13.9 fits.
- The "identity-from-1" LUT is the minimal fix to avoid emitting vel=0 (note-off) for the slowest physical press. Two slowest bins both emit vel 1, but bin 126 isn't reachable in practice for this threshold table, so the merger is silent.

**Constraint surfaced** (worth knowing if/when a future keyboard changes):
- Per-tick dB steps are inherently non-uniform under a power-law audio curve: ~1.0 dB/tick at the loud end (vel ≈ 127) tapers to ~0.1 dB/tick at the soft end (vel ≈ 80). This is a property of the math, not a bug. Pianos behave similarly — wide differentiation at loud dynamics, compression near floor.
- γ_audio is the only useful global lever once γ_int=1, low/high, and floor are fixed. Per-key residuals go to auto-capture (per-key gain). Sample-loudness residuals go to sample-side normalisation.

**Where**:
- `src/audio/velocityCal.ts:DEFAULT_INTERVAL_CURVE` (note: factory defaults left as `low=1, high=310, gamma=2.1` for first-time users; Max's per-unit calibration overrides via lumadiag).
- `src/lumatone/lumadiag.ts:pushIdentityVelocityLut` — clamps `lut[0]=1`.
- `src/lumatone/lumadiag.ts` — slider ranges: γ_audio 0.5..20, interval low 0..100, interval high 0..200 (step=1 for finer per-tick tuning).
- Sweep scripts (regenerable): `/tmp/gamma_audio_sweep.mjs` (high=50), `/tmp/gamma_audio_sweep_h130_v2.mjs` (high=130).

---

## Future piano-realism factors (filed for later, 2026-05-18)

**Filed but out of scope** for the current calibration cycle. None of these are gain-curve tweaks; they're sample-engine work.

1. **Velocity → low-pass cutoff modulation**: real piano hammers excite more harmonics at higher velocities, so hard hits sound brighter. Without it, soft and loud notes have identical timbre. Probably the *single biggest* missing piece for piano realism given HKL's normalised single-layer samples. Implementation would be a per-voice biquad LPF with cutoff = `f(velocity)` — a 6 dB high-shelf delta between vel=1 and vel=127 in the 2–8 kHz region would be perceptually significant.

2. **Velocity → attack-time modulation**: harder hits produce sharper attacks. ~5–15 ms shorter at vel=127 vs vel=1. Subtle but adds "bite" to loud notes.

3. **Soft-clipping at high vel**: model a piano hammer reaching mechanical limits — slight compression of the vel=120..127 region. Subtle realism cue for extreme-loud passes.

**Filed as NOT impactful enough to chase**:
- Velocity-dependent reverb send
- Loudness compensation (Fletcher-Munson)
- Per-key velocity curve (per-key gain already covers most variance)
- Velocity-dependent release-time

**Where**: any of (1)-(3) would land in `src/audio/sampleEngine.ts` (or wherever per-voice gain is applied), wiring a velocity-dependent filter/envelope-time/clipper into the existing voice graph.

---

## Composer tuplets: opinionated Ctrl+N table, single-measure only (2026-05-18)

**Picked**: Ctrl+N (N=2..7) followed by a duration digit creates a `<tuplet>` of opinionated ratio + atomic at the cursor. The ratio table is fixed (2:3 duplet, 3:2 triplet, 4:6 quadruplet, 5:4 quintuplet, 6:4 sextuplet, 7:8 septuplet), with N=2 and N=4 implying a dotted span. Atomic written-duration is derived from N and the digit (e.g. Ctrl+3,5 = triplet of 8ths in a quarter; Ctrl+5,5 = quintuplet of 16ths in a quarter). Nested tuplets and cross-bar `<tupletSpan>` are out of scope.

**Rejected**:
- A submenu / dialog asking for num, numbase, and atomic separately. Too many keystrokes for a common operation (especially triplets for localized swing). Finale's tuplet shortcut is also two-step; our design adds one more keystroke (explicit span duration) in exchange for never having to think about "atomic" — it's derived from the digit. This is the right trade for HKL Composer's flat-UX style.
- Supporting arbitrary num:numbase ratios via a typed input. Same UX cost, rarely needed in practice. If a user wants e.g. 11:8, they'd have to wait for a custom-ratio entry path (filed as future work).
- Nested tuplets. Schema-allowed in MEI but cursor model + bar-line check + status messaging all extend non-trivially. Cursor at any in-tuplet stop rejects Ctrl+N with "Cannot nest tuplets."

**Why**: Triplets dominate practical tuplet use; quintuplets and septuplets are rare; nested and cross-bar are exotic. The fixed table covers the common-case space in two keystrokes (Ctrl+N + digit) without any modal UI. The atomic derivation is opinionated but unambiguous (e.g. "Ctrl+3,5" means "triplet 8ths in a quarter" — no possibility for the user to specify "triplet 16ths in a quarter" because that's a sextuplet, picked separately with Ctrl+6,5).

**Where**:
- `src/composer/input.ts` — `TUPLET_CFG` lookup table + `commitPendingTuplet`.
- `src/composer/model.ts` — `createTupletAtCursor`, the `<tuplet>` builder, `data-tuplet-atomic-dur` attribute.

---

## Composer tuplet cursor stops: tuplet wrapper as a layer-level nav stop (iter4, 2026-05-18)

**Picked**: `navigableChildren(layer)` adds the `<tuplet>` element itself to the flat list, IN ADDITION to its in-tuplet stops. The wrapper is the "before tuplet at layer level" stop; the in-tuplet stops come right after it (one per filled child + optionally one fill-anchor). Cursor "before tuplet at layer level" (flat[c]=tuplet wrapper) and cursor "before F1 inside tuplet" (flat[c]=F1) are two distinct adjacent flat-indices at the same visual x.

**Rejected**:
- **iter2's "tuplet transparent, locateCursor returns inTuplet for any in-tuplet target"**: failed because the first-filled-child position became ambiguous — `locateCursor` correctly flagged it as in-tuplet, but the user perceives it as "before the tuplet at layer level" (their cursor visually sits at pre-content's right edge, outside the bracket). False "Doesn't fit in remaining tuplet space" errors when trying to insert before the tuplet.
- **iter3's "between rule" (locateCursorEffective)**: special-cased the first-filled-child position as layer-level OUTSIDE the tuplet. Fixed the false-fire, but hid the legitimate "inside before F1" position the user needs for prepending into a partial tuplet. Also still had iter1's "trailing placeholder isn't a nav stop when post-content exists" rule which made it impossible to APPEND to a partial tuplet once content follows.

**Why iter4 is right**: each user-intent position needs a distinct flat-index. The wrapper-as-stop approach gives them: layer-level "before tuplet" and in-tuplet "before F1" are now two adjacent stops with distinct flat-indices. The trailing fill anchor is ALWAYS a nav stop (no iter1 hiding rule) — appending to a partial tuplet just works. Forward-facing `locateCursor` (without any "effective" wrapper / between-rule) naturally distinguishes them: flat[c]=tuplet wrapper has parent=layer → inTuplet=null; flat[c]=F1 has parent=tuplet → inTuplet=set.

**Where**:
- `src/composer/model.ts` — `navigableChildren` adds the wrapper to the flat list, `tupletNavStops` simplified to drop the `hasPostTupletContent` parameter. `locateCursorEffective` removed entirely; all callers use raw `locateCursor`.
- `src/composer/cursor.ts` — new "entering a tuplet" anchor (LEFT of flat[c] when flat[c-1]=wrapper) and "exiting a tuplet" anchor (parent tuplet's right edge when flat[c-1] is a tuplet child and flat[c] is not in the same tuplet). Replaces the iter3 placeholder-specific anchor.
- `src/composer/model.ts:deleteAtCursor` — new skip-left branch when target = tuplet wrapper (symmetric to placeholder skip-left). Backspace at "before F1 inside tuplet" moves the cursor to "before tuplet at layer level" without deleting.

---

## Composer tuplet placeholders: atomic-aware regeneration (iter4, 2026-05-18)

**Picked**: Each `<tuplet>` records its atomic written-duration on creation via `data-tuplet-atomic-dur`. After any operation that changes the trailing-placeholder ticks (insert / replace / delete / dot-cycle), `regenTupletPlaceholders(tuplet, remainingTicks)` emits N atomic-sized `<rest>` placeholders, with `decomposeTicks` as a fallback for awkward remainders. Fill+delete is perfectly reversible: a freshly-created triplet of 8ths is `[P_8, P_8, P_8]`; insert + backspace returns to the same shape.

**Rejected**:
- Naive `decomposeTicks(remainingTicks)` (iter3 behavior): emits the smallest-possible-piece-count, e.g. `[P_dotted_quarter]` for 24 written ticks. That's semantically valid (total ticks correct) but visually collapses the tuplet's width — a single dotted-quarter rest renders narrower than three 8th rests in three layout slots. The bracket shrinks, the "perfectly reversible" invariant is broken visually.
- Always emit N atomic placeholders (no `decomposeTicks` fallback): can't represent awkward leftovers, e.g. inserting a written-dotted-8th (12 ticks) into a triplet of 8ths (24 ticks budget) leaves 12 ticks unfilled, which `12 / 8 = 1` atomic + 4 ticks left over. Without the fallback we'd lose 4 ticks or fail. Hybrid is right.

**Why**: visual stability of the tuplet bracket matters for user trust. After a fill+delete sequence, the bracket should look identical to its freshly-created state. The atomic-aware regen preserves that. The `decomposeTicks` fallback is rare in practice (only fires for non-atomic-aligned inserts) and is layout-equivalent to the iter3 behavior, so it costs nothing.

**Where**:
- `src/composer/model.ts:regenTupletPlaceholders` — the helper.
- 5 call sites in model.ts use it: `insertWithSplit` in-tuplet branch, `replaceChordAtCursor` placeholder branch, `replaceChordAtCursor` filled-replace branch, `deleteAtCursor` case (b), `cycleDotsOnCurrent` in-tuplet branch.
- `createTupletAtCursor` records `data-tuplet-atomic-dur` on the new tuplet element.

---

## Composer tuplet placeholders: `<rest>` + CSS-hide, not `<space>` (iter3, 2026-05-18)

**Picked**: Tuplet-internal placeholders are real `<rest>` elements marked with `data-tuplet-placeholder="true"`. The rest glyph is hidden in CSS via `#score svg g.rest[data-data-tuplet-placeholder="true"] { visibility: hidden }`. Verovio sees them as "content" and draws the tuplet bracket; the user sees an empty (but layout-reserved) bracket area.

**Rejected**:
- **`<space>` placeholders**: layout-only, draw nothing. Verovio's tuplet bracket-rendering pass excludes `<space>` as non-content; the bracket doesn't draw. An empty just-created tuplet would render with no bracket at all — confusing for the user.
- **`<rest visible="false">` placeholders**: spec-correct MEI 5 form. Verovio doesn't honor `@visible` on rests — issue rism-digital/verovio#202 from 2016, still open as of v6.1. The glyph draws regardless.

**Why**: this is the only combination that gives "bracket visible + glyph hidden + layout width reserved". The CSS workaround is small and self-contained (one rule in composer.html). When/if Verovio fixes #202, we can drop the CSS and switch placeholders to `<rest visible="false">` cleanly (the `data-tuplet-placeholder` marker stays).

**Where**:
- `src/composer/model.ts:buildTupletPlaceholder` — element constructor.
- `src/composer/render.ts` — `svgAdditionalAttribute: [..., 'rest@data-tuplet-placeholder']` so Verovio propagates the marker to the SVG output (with the `data-data-` prefix that Verovio always adds).
- `composer.html` — the single CSS rule.

---

## Composer MusicXML export: full tuplet semantics with dynamic DIVISIONS (iter3, 2026-05-18)

**Picked**: When the doc contains any `<tuplet>` elements, `exportMusicXml` computes `DIVISIONS = LCM(16, all tuplet @num values)` so every tuplet child's sounding ticks come out integer. Each child note inside a `<tuplet>` carries `<time-modification><actual-notes>num</actual-notes><normal-notes>numbase</normal-notes></time-modification>`. The first child's `<notations>` includes `<tuplet type="start" number="1"/>`; the last child gets `type="stop"`. Chords inside tuplets: only the chord's *primary* (first) `<note>` carries the `<tuplet>` notation; all chord members carry `<time-modification>`. Rests inside tuplets carry `<time-modification>` (for DAW timing accuracy) but no `<tuplet>` notation.

**Rejected**:
- Best-effort emit with no `<time-modification>` and a TODO: DAW import wouldn't recognize the tuplet — pitches/durations would import but the timing would be wrong (sounding ticks ≠ what the DAW expects). Round-trip to a DAW for further editing would be unusable for tuplet-containing scores.
- Fixed `DIVISIONS = 16` (legacy): can't represent triplet 8th sounding ticks as integers (16/3 ≈ 5.33). Output would be lossy or invalid.

**Why**: DAW round-trip is a v1 goal for HKL Composer's MusicXML export. Tuplets are common enough that lossy export would be a regression. Dynamic DIVISIONS is one helper function (`computeDivisions`) + LCM math; per-note `<time-modification>` and `<notations>` are mechanical adds to `emitEventXml`. Total: ~50 lines.

**Where**:
- `src/composer/save.ts:computeDivisions` — LCM(16, all tuplet num values).
- `src/composer/save.ts:gatherEventsFromDoc` — descends into `<tuplet>` and attaches `tupletInfo` to each event.
- `src/composer/save.ts:emitEventXml` — emits `<time-modification>` and `<notations><tuplet/>` per the event's `tupletInfo`.

---

## Composer measure-fill invariants: planner+applier insert path, navigation-only autofill (2026-05-19)

**Picked**: A single `planInsert` walker validates every layer-level insertion before any DOM mutation. It walks `[inserted, ...post-cursor]` assigning each item a `(measureIdx, offset)`, splits the inserted note on barlines (with `i`/`m`/`t` ties), and moves post-cursor items wholesale. Three block reasons (mapped to existing/new status strings) cover the new invariants: (1) the inserted note's tail can never land in a measure whose layer for this voice already has content; (2) tuplets are allowed to be pushed wholesale across a barline as a unit, but only into an empty next-measure layer — else "Insertion would push tuplet across bar line."; (3) tuplets are atomic (never split themselves).

Autofill rests run lazily — only when the cursor's `measureIdx` changes (via `moveCursor`/`setCursor`/`cursorToEnd`/`switchVoice`/`setVoice`). The abandoned measure's trailing placeholders become beat-aligned `<rest>` elements via `decomposeBeatAlignedRests` in `restfill.ts`. The rests are plain (no special attribute) — they behave like manually-entered rests once placed, and to extend the measure later the user deletes them.

**Rejected**:
- **Auto-fill rest "magic reversal"** (rests revert to placeholders on cursor-enter): adds non-obvious behavior tied to cursor location. Picked stays-as-rests instead so a rest at a given position means the same thing regardless of where the cursor is.
- **Autofill on every mutation** (sweep all measures after every insert/delete): correct under all paths but pays an O(measures × voices) scan per keystroke. Picked the laziest variant: only on navigation, only on the measure the cursor just left.
- **Splitting existing post-cursor non-tuplet elements with ties on overflow**: musically idiomatic but requires non-trivial tie-partner rewiring (an existing element's xml:id is what other ties point to; splitting forces head/tail to carry both incoming and outgoing tie state with proper `m` flags and `data-tie-partner` updates on third parties). Picked wholesale-move instead — existing elements keep their identity (and their xml:id, so their `data-tie-partner` cross-refs remain valid under a DOM move).
- **Replacing all top-level `<space data-placeholder>` nav stops with a single synthetic trailing stop per gap** (more uniform model): broader refactor; existing placeholder-clicks would change semantics. Picked minimal change instead — past-end of full last measure already works via the existing `cursor >= voiceLen` past-end render branch; added `isCursorAtPastEnd` as a helper so the renderer can differentiate that case if desired in the future.

**Why**: the user wants the same level of rigor for measure-fill that the tuplet work already established. The previous `insertWithSplit` had a latent bug where mid-measure inserts with real post-cursor content silently pushed elements past the barline — the single-element fit check was `usedBefore + totalTicks <= measureTicks` and ignored the post-cursor block. `replaceChordAtCursor`'s in-place path had the same gap. The planner-walker pattern fixes both with one code path and produces the right status messages for the new block reasons.

**Where**:
- `src/composer/model.ts:planInsert` — the walker. Validation + action list in one pass.
- `src/composer/model.ts:insertWithSplit` — apply path (lifts post-cursor, places per actions, wires inserted-piece ties, advances cursor).
- `src/composer/model.ts:canInsertHere` — dry-runs the planner so the input layer's status message matches the apply path's block reason exactly.
- `src/composer/model.ts:replaceChordAtCursor` — simple-fit check now subtracts post-block ticks; overflow path falls through to the new `insertWithSplit`.
- `src/composer/model.ts:autofillMeasure` + cursor entry points — lazy navigation-triggered sweep.
- `src/composer/restfill.ts` — beat-aligned rest decomposition.

---

## Composer measure nav-stops mirror tuplets; explicit measure deletion (iter, 2026-05-19)

**Picked**: each (voice, measure) contributes a wrapper stop (the `<measure>` element itself), one stop per real content child, and — for partial layers — a single trailing fill-anchor stop (the first `<space data-placeholder>`). Empty layers collapse to a single wrapper stop. A synthetic past-end "wrapper of the not-yet-existent next measure" sits at `flatChildren.length` for every voice. Backspace deletes containers (tuplet OR measure) only at the explicit empty-container anchor stop — fill-anchor for empty tuplets, wrapper for empty measures (its only stop). The "auto-delete measure when emptied via content backspace" branch is gone.

**Rejected**:
- **Keep all placeholders as nav stops + add a past-end stop only when the last measure is full** (the prior iteration's "minimal change" pick). It preserved the boundary-rule silent re-aim that had no way to express "enter the next measure" vs "extend this one"; user testing surfaced this as ambiguous and undesirable, and the past-end stop never actually appeared in practice because partial last measures left placeholders that swallowed the navigation.
- **Auto-delete emptied measures** (existing behavior). The user can't fully replace a measure's contents this way — deleting all content makes the measure vanish, leaving nowhere to type the replacement.
- **Two stops (wrapper + fill-anchor) on fully-empty measures** (matching tuplet's empty-tuplet behavior exactly). Two cursor positions at the same visual point produces a right-arrow with no visible motion; user picked the one-stop collapse for empty measures via AskUserQuestion.

**Why**: the boundary-rule re-aim was load-bearing UX glue that papered over an ambiguity in the cursor model. Replacing it with two explicit stops (fill-anchor of M_k for "extend current"; wrapper of M_{k+1} for "enter next") makes the user's intent unambiguous AND fixes the premature autofill — cursor at fill-anchor stays in M_k, so `cursorMeasureIdx` doesn't change, so autofill doesn't fire. The tuplet container model already handled all these concerns; bringing measures into the same shape removes one set of special cases instead of adding another.

**Where**:
- `src/composer/model.ts:flatChildren` + `layerStops` — measure-level emission of wrapper + content + fill-anchor.
- `src/composer/model.ts:locateCursor` + `resolveStopIndex` + `measureStopCount` — translate flat-index back to a `(measureIdx, layer, withinIdx)`. Past-end uses a fresh empty `<layer>` so downstream code sees `contentChildren = []`.
- `src/composer/model.ts:getVoiceLength` — +1 for the synthetic past-end stop.
- `src/composer/model.ts:normalizePlaceholders` — now emits trailing placeholders for partial layers too (so the fill-anchor stop has a real DOM element to anchor on).
- `src/composer/model.ts:deleteAtCursor` — adds the empty-measure-wrapper delete branch and the wrapper skip-left arm; removes the auto-delete-on-empty branch.
- `src/composer/model.ts:insertWithSplit` + `canInsertHere` — boundary-rule re-aim removed; cursor advance after insert uses `findIndex` to land just past the rightmost inserted element (handles the extra wrapper + fill-anchor stops a freshly-created measure contributes).
- `src/composer/model.ts:autofillAndReanchor` — captures the cursor's target element BEFORE the autofill sweep and snaps to its new flat-index after, so right-arrow `fill-anchor → wrapper-of-next` doesn't visibly displace the cursor when autofill changes the flat.
- `src/composer/cursor.ts:renderVoiceCursor` — three new render cases (wrapper stop, fill-anchor stop, past-end synthetic stop).

---

## Composer wrapper-collapse + doc-wide autofill sweep (iter, 2026-05-19)

**Picked**: emit M_k's wrapper stop UNLESS the previous measure is full and M_k has at least one real-content child (in which case "after last content of M_{k-1}" and "wrapper of M_k" collapse to a single nav stop). The wrapper is always emitted for M_1, for fully-empty M_k, and when M_{k-1} is partial. Autofill is triggered on every mutation + every navigation event, scanning all measures except the cursor's current one.

**Rejected**:
- **Always emit wrapper of M_k** (the iteration before this). Surfaces the wrapper of M_{k+1} right at the bar line, visually indistinguishable from "still in M_k". When M_{k+1} is empty and the user is "visually in M_k" after the bar line, backspace there fires the empty-measure delete unexpectedly.
- **Autofill only on cursor measureIdx change** (the previous iteration's trigger). Missed the common abandonment pattern where the abandoned measure's later-content sibling appears AFTER the cursor's move-out, so the autofill condition was checked at the wrong time.

**Why**: the user explicitly identified both root causes in hands-on testing. Collapsing the wrapper when M_{k-1} is full removes a visually-confusing redundant stop while preserving the dot/tie operations the user expects from "after last note of previous measure" (those still work because the previous note is `flat[c-1]`). Scanning on every event is O(measures × voices) per keystroke — cheap — and catches the abandonment as soon as the conditions hold.

**Where**:
- `src/composer/model.ts:shouldEmitWrapper` (new), `layerIsFull` (new) — the per-measure wrapper-emission decision.
- `src/composer/model.ts:flatChildren` / `measureStopCount` / `resolveStopIndex` / `locateCursor` / `locateFlatElement` — consume the emission decision, with `resolveStopIndex(idx=0)` returning the first content stop when the wrapper is collapsed.
- `src/composer/model.ts:autofillAllAbandoned` / `autofillAllAndReanchor` — doc-wide sweep. Wired into every mutation entry point (`insertChord/Rest/Replace`, `deleteAtCursor` × 5 return paths, `createTupletAtCursor`, `cycleDotsOnCurrent`, `toggleTieOnCurrent`, `setTimeSig`) plus every navigation entry point.
- `src/composer/cursor.ts:anchorAtMeasureLeft` — `findSigEndXForStaff` / first-content / first-placeholder / `measure.rect.left + 30` fallback chain. `setVerticalFromStaff` ensures the wrapper / past-end cursor spans only the voice's staff, not the whole grand staff.

---

## Composer cursor verification tooling + voiceLen no-+1 (iter, 2026-05-19)

**Picked**: `tools/composer-inspect/inspect.mjs --screenshot` writes a PNG via CDP `Page.captureScreenshot`. `tools/composer-inspect/cursor-trace-all.mjs` runs every canonical scenario in `scenarios.mjs`, walks all cursor positions, and reports invariant violations (consecutive positions whose rendered cursor-bar rect is < 4px apart — the "state changes but pixel doesn't" failure mode). The `data-cursor-role="voice"` attribute on the cursor bar makes it queryable from inside the page.

`getVoiceLength` returns `flatChildren.length` (no +1). Past-end is `cursor === voiceLen` directly; `moveCursor`'s `c < len` already lets the cursor reach `len`, and `locateCursor` resolves out-of-range cursor as past-end.

`shouldEmitWrapper`: wrapper is emitted only for empty M_k OR when M_{k-1} is partial. M_1 with content has its wrapper collapsed (no predecessor to extend, cursor=0 already anchors at sigEnd).

Cursor renderer: when `flat[c]` is a measure wrapper (`nextRef.elem.localName === 'measure'`), anchor at the wrapper's measure's LEFT edge — INSIDE the measure, past the previous bar line. This makes empty-measure-deletion semantics match where the cursor visually is.

**Rejected**:
- **Run scenarios as one big inspector invocation** (sharing Chromium across scenarios): more efficient but coupled — easier to debug per-scenario when each invocation has a fresh page.
- **Hard-coded staff heights / per-scenario tolerances**: pure invariant-based check works without those.

**Why**: three iterations in a row shipped cursor-model changes that compiled and passed model-only tests, then broke under hands-on testing because the rendered cursor positions weren't distinct from each other (cursor state changed without the visual moving). The user's request to "show me what steps you will take to improve your understanding before we do anything else" forced the right intervention: build the visual + numeric verification, run it against the broken state to surface the exact diagnoses (35 violations across 6 scenarios before the fix), then apply the fixes with the tooling-confirmed effect (0 violations after).

**Where**:
- `tools/composer-inspect/inspect.mjs` — `--screenshot` mode.
- `tools/composer-inspect/cursor-trace.mjs` — in-page trace + invariant function.
- `tools/composer-inspect/scenarios.mjs` — canonical doc-build snippets.
- `tools/composer-inspect/cursor-trace-all.mjs` — driver, one PNG + one JSON per scenario.
- `src/composer/model.ts:getVoiceLength` (no +1), `shouldEmitWrapper` (collapse M_1 with content), `autofillAllAndReanchor` (snap to `voiceLen`, not `voiceLen - 1`).
- `src/composer/cursor.ts` — `data-cursor-role="voice"` attribute on the bar; `insert-before-measure-wrapper` render case that anchors inside the upcoming measure; `cursor === 0` branch routed through the same wrapper anchor logic.
- `src/composer/main.ts` — exposes `reRender` on `window.__hkl_composer` so the headless tooling can trigger a Verovio re-render after model mutations.

---

## Auto-autofill disabled (2026-05-19)

**Picked**: unwire automatic autofill triggers from cursor motion (`switchVoice`, `setVoice`, `moveCursor`, `setCursor`, `cursorToEnd`) and from `setTimeSig`. Cursors that leave a partial measure no longer materialize visible rests in its trailing placeholder space. The autofill primitives (`autofillMeasure`, `autofillAllAbandoned`, `autofillAllAndReanchor`, `autofillOnLeave`, plus the `restfill.ts` beat-aligned decomposer) are retained as dead code, queued for an explicit "fill all partial measures with rests now" command.

`setTimeSig` keeps its post-truncate cursor re-anchor (inline `reanchorCursorAfter` with a captured `lookForward`), because per-measure truncation can still drop the element the cursor pointed at; that re-anchor is structural, not autofill-driven.

**Rejected**:
- **Keep the autofill triggers**: forced fill-on-leave produces surprise edits — the user's scratch measures get cemented with rests the moment the cursor crosses a bar, defeating the partial-measure scribble workflow.
- **Delete the autofill code entirely**: the beat-aligned rest decomposition is non-trivial and useful as an explicit user-invoked sweep ("normalize the whole document"). Cheaper to leave it dormant than to re-derive later.

**Why**: hands-on use revealed that automatic autofill removed agency more often than it helped. Composing partial-content measures is a normal mid-edit state, and the fill sweep kept overwriting that state every time the user navigated. The fix is the same shape as several other reverted "automatic" behaviors in this codebase — leave the primitive, remove the auto-trigger.

**Where**:
- `src/composer/model.ts:setTimeSig` — inline reanchor replaces the autofill-and-reanchor call.
- `src/composer/model.ts:switchVoice` / `setVoice` / `moveCursor` / `setCursor` / `cursorToEnd` — `autofillOnLeave` calls removed; `prevMIdx` capture no longer needed.
- `src/composer/model.ts` — autofill helpers retained in place with a docblock above `autofillMeasure` explaining the disable and the path to re-enable.
- `src/composer/restfill.ts` — beat-aligned decomposer retained.

---

## Composer test suite — tiered, invariant-categorized, in-process bridge mock (2026-05-19)

**Picked**: a dedicated `tools/composer-test/` runner with three tiers (`fast` ~10 s for inner-loop iteration; `full` ~15 s as the pre-merge gate; `visual` for baseline-diff). Fixtures are organized by concern (cursor-convention, single-voice, multi-voice, tuplets, ties, sig-changes, keystroke-dispatch, bridge, scroll, visual). Each fixture runs through whichever of the seven invariants apply (MODEL, CURSOR, RENDER, ROUNDTRIP, VISUAL, INPUT, CONSOLE). Universal invariants (placeholder, tie orphans, cursor-trace, roundtrip on full, console capture) auto-apply to every fixture; fixture-specific assertions in `FIXTURE_ASSERTIONS[name]` cover the rest.

The runner reuses the existing `tools/composer-inspect/` CDP plumbing (factored into `lib/chromium.mjs` + `lib/cdp.mjs`). It launches headless Chromium once, navigates to the dev server (`http://localhost:5173/composer.html`), injects an assertion library + bridge-mock + cursor-trace fn under `window.__test` / `window.__bridgeMock` / `window.__cursorTrace`, then iterates fixtures with a fresh model state per fixture. Real-keystroke testing goes through CDP `Input.dispatchKeyEvent` so `input.ts`'s document-level keydown handler is exercised end-to-end. The bridge mock opens a second `BroadcastChannel('hkl-composer-bridge')` from inside the page — Composer's own `bridge.on` listener receives mock events as if from real HKL, and Composer→HKL emissions get captured by the mock's listener.

**Rejected**:
- **Vitest / Jest / Playwright**: heavyweight (config, runners, transformers); a direct CDP driver is ~50 lines and gives full control over the in-page state machine.
- **State reset by full page reload**: ~3 s per scenario for the Verovio cold-start dominates wall time; instead `RESET_SNIPPET` calls `model.replaceDocument(emptySeed.serialize())`, resets `inputState.mode/cursorMode/pendingHairpin/pendingTuplet` (runtime-mutable despite the TS Readonly type), broadcasts an empty `held-keys` event to clear `lastHeldKeys`, zeroes `score.scrollLeft/scrollTop`, and forces scroll-mode rendering. The full reset takes <50 ms.
- **Page-mode rendering for visual tests**: Verovio's page-mode SVG is sized to the paper, not the content — the screenshot clipped to the SVG bbox came back mostly empty. Scroll mode produces a tight-fit SVG that clips usefully.
- **Pre-deletion partner cleanup as the correctness mechanism for ties** (see "Tie system" entry below): replaced with post-mutation `normalizeTies()`, which is chain-aware and idempotent. The suite's tie-stress fixtures (`m1TieDeleteInitiatorFromSplit`, `m1TieDeleteMiddleFromSplit`, `m1TieToggleOnTerminal*`) lock in the new behavior.

**Why**: the previous tooling (`tools/composer-inspect/cursor-trace-all.mjs`) asserted ONE invariant (consecutive cursor positions render at distinct rects) over EIGHT scenarios. Necessary but not sufficient — wrong-position cursor, wrong content rendered, missing tuplet bracket, accidental glyph wrong, tie-partner orphan, color leak, MEI validation errors all slipped past. The new suite found six real bugs during construction (data-tie-partner asymmetry, cursor-stuck-at-tuplet-entry stale state, placeholder-id roundtrip drift, autoflow-overflow rest decomposition behavior, `setCursor`-at-past-end + `deleteAtCursor` semantics confusion, ASI bug in injected template literal — see lessons.md for each), then continued catching the user's "extend tie on terminal note" gap once shipped.

**Where**:
- `tools/composer-test/run.mjs` — entry point, parses tier/scenario args, orchestrates.
- `tools/composer-test/fixtures.mjs` — every fixture's setup snippet + fixture-specific assertions.
- `tools/composer-test/lib/` — chromium / cdp / assertions / keystroke / bridge-mock / scroll-helpers / cursor-trace / visual / console-capture / runner-core.
- `tools/composer-test/baselines/*.png` — VISUAL reference PNGs (clipped to SVG bbox, scroll-mode).
- `tools/composer-test/README.md` — how to run, how to add fixtures.
- `package.json` — `test:composer` + `test:composer:fast` scripts.
- `CLAUDE.md` workflow patterns — "before declaring any Composer change done" gate.

---

## Tie system: intent + realization, normalizeTies() as single source of truth (2026-05-19)

**Picked**: split tie state into two concerns. Per-note INTENT (`wantsForward`: encoded as `@tie ∈ {"i","m"}` OR `data-pending-tie="true"`) is the persisted user expression. REALIZATION (`@tie` values for rendering, `data-tie-partner` forward-only xml:id references, `<lv>` hanging-arc elements) is **derived** by a single `normalizeTies()` function that runs after every structural mutation. `normalizeTies` strips all realization, snapshots intent, then forward-walks each voice's flat order and rebuilds. Idempotent.

`data-tie-partner` is **forward-only** — `@tie="i"` or `"m"` notes point at the NEXT chain member; terminals (`@tie="t"`) carry no partner. A note can simultaneously hold `@tie="t"` (incoming) AND `data-pending-tie="true"` (outgoing intent unfulfilled), so "extend an already-tied-to note forward" works naturally.

**Rejected**:
- **Bidirectional `data-tie-partner` on each tie pair** (the original `toggleTieOnCurrent` approach): forced every cleanup site to handle two directions, and didn't generalize to chains of length 3+ from auto-tie-on-overflow.
- **Backward-only `data-tie-partner` on the `m`/`t` side** (the original `insertWithSplit` approach): asymmetric — deleting the `i` initiator left the downstream `m`/`t` survivors with `data-tie-partner` pointing at a deleted note. Verovio emitted "Expected @tie median or terminal in note 'X'" warnings; the user reported "ties don't appear at all sometimes".
- **Ad-hoc cleanup at each call site** (`orphanTiePartners` pre-deletion, `resolvePendingTies` post-insert, manual chain wiring in `insertWithSplit`): three independent passes with different conventions; any new mutation path had to remember to call all three in the right order. Centralizing into `normalizeTies` removes that maintenance burden.

**Why**: the asymmetric `data-tie-partner` had been latent for months because typical use (toggle on two adjacent notes; delete the second) hit the symmetric code path. The auto-tie-on-overflow case (whole-note typed near a bar line; deletion of any chain piece) was rarer and surfaced only when the user pushed on it. Splitting intent from realization eliminates the entire class of "this mutation path forgot a cleanup step" bug: every mutation just needs to call `normalizeTies()` once, and the per-chain consistency is restored from scratch.

`toggleTieOnCurrent` is simplified to a pure intent flip (set/clear `data-pending-tie` on each note in the chord, or downgrade `@tie="m"` to `"t"` when toggling off), then `normalizeTies`. The previous code had to look ahead, find same-pitch partners, set `@tie` on both sides, and wire `data-tie-partner` bidirectionally — all of which is now derived.

**Where**:
- `src/composer/model.ts:normalizeTies` — new; the centerpiece.
- `src/composer/model.ts:orphanTiePartners` / `resolvePendingTies` — reduced to backward-compat stubs (no-op / alias for `normalizeTies`) so the dozen call sites don't all need rewriting in one commit.
- `src/composer/model.ts:insertWithSplit` — tie wiring loop now sets only `@tie` intent per piece; `data-tie-partner` is derived.
- `src/composer/model.ts:toggleTieOnCurrent` — simplified to intent-flip + `normalizeTies`.
- `src/composer/model.ts:deleteAtCursor` / `replaceChordAtCursor` / `setTimeSig` / `replaceDocument` — every mutation path calls `normalizeTies()` after the structural change.
- `tools/composer-test/fixtures.mjs` — 9 tie fixtures lock in the behavior, including the previously-broken chain-deletion cases.

## Composer selection: origin+first+last over anchor+movable (2026-05-20)

**Decision**: Beat-mode selection state stores `{ origin, first, last, lastMoved }` (beat indices) instead of `{ anchor, movable }` (flat indices). Both Shift+Left and Shift+Right at the same cursor enter beat mode with the same single-beat selection (`first == origin == last == currentBeatAt(cursor)`); `lastMoved` is set from the entry direction for natural exit-cursor placement.

**Alternatives**:
- **Original anchor+movable**: asymmetric entry (Shift+Left placed anchor on the right of the current beat with movable one left; Shift+Right vice versa). Allowed zero-width selection at convergence, with a special "convergence-exit" branch in the mover. Two issues motivated the rewrite: (a) entry direction has no real musical meaning — the user just wants to select the beat under the cursor — and (b) the zero-width case adds a special-case path everywhere selection state is consumed.
- **Single-side mover** (mover tracks "active side", always-grow): would need a separate "switch active side" gesture; complicates the keybinding surface.

**Why**: mirrors measure-mode's symmetric `originStaff`-anchored growth. Eliminates the convergence-exit path (selection is always ≥ 1 beat, so `Shift+Left` then `Shift+Right` shrinks back to the single-beat state rather than exiting). Makes the model trivially extensible to per-side asymmetric growth in either direction without bookkeeping "which side is movable".

**Where**:
- `src/composer/selection.ts`: new state shape, `currentBeatAt`, `moveBeatRange`, `moveBeatRangeByMeasure` (Ctrl+Shift+Arrow as a loop over `moveBeatRange` until measure-boundary).
- `src/composer/input.ts`: `dispatchSelectionMode` Shift+Arrow branch no longer has the convergence-exit case.
- `tools/composer-test/fixtures.mjs`: `sel_beat_converge_exits` replaced by `sel_beat_shrink_to_origin` (selection persists as single-beat at origin instead of exiting).

## Composer clipboard via DOM events, not navigator.clipboard (2026-05-20)

**Decision**: Copy / cut / paste use the DOM-level `copy` / `cut` / `paste` events with `event.clipboardData.setData('text/plain', …)` and `getData(...)`. The keydown handler stashes serialized text in a module-level `pendingClipboardText` variable for the same-tick DOM event to ferry into the OS clipboard.

**Alternative**: `navigator.clipboard.writeText` / `readText` (the original implementation). `readText` is unreliable on Firefox — surfaces a "Paste" permission UI that often returns empty / stale data even after the user accepts. `writeText` is more reliable but pairing the two gives an asymmetric experience.

**Why**: DOM clipboard events work in both Chromium and Firefox without permission prompts, fire synchronously on user gesture, and expose the OS clipboard via a stable API. Tradeoff: CDP-driven tests don't synthesize DOM clipboard events from keystroke dispatch — so the keydown handler keeps the model side-effects (serialize, delete, etc.) and the DOM event only owns the OS clipboard write. Tests observe model state via the keydown path; real browsers get both.

**Where**:
- `src/composer/input.ts`: `copyHandler` / `cutHandler` / `pasteHandler` registered on `document`. Keydown's Ctrl+C/X branches do the model side-effects + set `pendingClipboardText`; the DOM event picks it up. Ctrl+V keydown is a no-op; the paste event handles everything.
- `src/composer/clipboard.ts`: `serializeClipboard` / `parseClipboard` are pure functions — no I/O.

## Composer selection rendering: per-element vertical span (beat mode) (2026-05-20)

**Decision**: Beat-mode selection rects use the union of selected element bboxes (chord / note / rest / tuplet) within each system's voice layer, padded with `CURSOR_VPAD` (= 6 px, same as the editing cursor's vertical extent). Measure-mode rects still use the full staff bbox.

**Alternative**: Use the staff bbox for both modes. Simpler but makes it visually ambiguous WHICH voice is selected when both voices on a grand staff are populated — the rect fills the same y range either way.

**Why**: at a glance, the selection rect should make voice-membership obvious. The cursor's own visual anchor uses the same per-element bbox-with-VPAD pattern, so the selection is consistent with where the user expects the cursor.

**Where**: `src/composer/selectionOverlay.ts:staffYRangeForMeasure` — branches on `sel.kind`; for beat mode, walks the layer's content children and unions bboxes via `renderer.rectForId(element.id)`.

---

## 7-limit mode revamp: uniform septimal qm=2 rule (2026-05-22)

**Picked**: New 7-limit (`tuning='7'`, `septimalMode='uniform'`) replaces the prior experimental per-cell region map with a single rule: every cell with `qmod3 === 2` is region B with `(aDepth=1, aUpper=true)`; qm=0 and qm=1 are A-d0. Pure function of `qmod3` — three lines in `regionInfoWithState`. The old global-shift behavior is preserved as a hidden `'7-legacy'` mode (`septimalMode='global'`).

`TuningMode = '5' | '7' | '7-legacy' | 'E'`. Dropdown shows three entries (`Equal / 5-limit / 7-limit`); `'7-legacy'` is only reachable by editing localStorage. Migration on load: old `'7'` → `'7-legacy'`; old experimental `'7x'` → `'7'`.

**Rejected**:
- **Per-cell `EXP_REGION_MAP` decision panel** (the experimental predecessor): exposed a 6-row decision grid in the UI for the user to pick A/B per `(qmod3, rmod6)` cell. Powerful but over-configurable: most settings made the lattice musically incoherent, and the optimal pick was always the same. Replacing it with a fixed `qmod3`-only rule is strictly simpler and produces the same musical result.
- **Re-coloring the 7-limit gate as "9-limit" or similar**: the rule is intentionally a 7-limit story (the 7/4 harmonic 7th two rows up in qm=2). Renaming would obscure the actual ratio basis.
- **Dropping `'7-legacy'` entirely**: hidden but kept, in case users have existing recordings or workflows that depend on global-shift behavior. The seam-shift UI control is restored conditionally on `septimalMode === 'global'`.

**Why**:
- Every qm=0 Pythagorean-spine cell now has its harmonic 7th (7/4) exactly two rows up in qm=2 of the same r, because the qm=2 B-d1-upper syntonic adjustment cancels against the (q+1) major-third stack. This collapses all alternate Pythagorean m3 problems back into the original heptachord.
- Major triads stay 5-limit-pure (4:5:6) via qm=0 + qm=1; dominant 7 (4:5:6:7) reachable from any qm=0 root; half-dim 7 (5:6:7:9) reachable from any qm=1 root.
- Fully key-symmetric. The Lumatone-layout root is selected via the ref note (the new ref-driven shift, §2.10), not via tuning-mode state.
- The one musical trade is 5-limit minor (10:12:15) → Pythagorean (32:27) or septimal subminor (7:6). Use `'5'` for 5-limit minor.

**Where**:
- `src/tuning/regions.ts` — `uniformRegion()` branch; `EXP_REGION_MAP` removed; `setExpRegionMap`/`getExpRegionMap` removed.
- `src/state/tuning.ts` — `septimalMode: 'global' | 'uniform'`.
- `src/state/persistence.ts` — `TuningMode` union + `migrateTuningMode`.
- `src/ui/controls.ts:setTuning` — maps `'7'` → uniform, `'7-legacy'` → global, hides seam-shift in uniform mode.
- `index.html` — dropdown options; experimental decision panel UI removed.
- `src/tuning/exp-decisions.ts` — DELETED.

---

## Ref-driven layout shift via refSpine (2026-05-22)

**Picked**: The legacy 3-layout button group (♭ ♮ ♯) and the QWERTY transpose ▲/▼ are replaced by a continuous ref-driven mechanism. Selecting any cell as the reference note (Ctrl+click on any hex) slides the lattice under the static Lumatone / QWERTY / none outlines so that `refSpine(refQ, refR)` lands at the outline's center.

```ts
// src/tuning/refspine.ts
refSpine(refQ, refR) = qmod3 === 0  → (refQ,     refR)
                       qmod3 === 1  → (refQ - 1, refR)   5-limit M3 above same-row qm=0
                       qmod3 === 2  → (refQ + 1, refR)   same-row Pythag spine
```

Applies to ALL outline modes (`'lumatone'`, `'qwerty'`, `'none'`) and ALL tuning modes (`'5'`, `'7'`, `'7-legacy'`, `'E'`). Ref change tweens via `animation.tweenTo` with the existing 500ms machinery; hex layer pre-built across `[view → target]` via `buildHexLayerForTween` so no cut-off-borders artifact appears mid-tween. `tuning.curLayout`, `setLayout`, `applyLayoutImmediate` are kept as vestigial back-compat for `.hkr` load.

**Rejected**:
- **Keep the 3-layout buttons + add ref-shift on top**: two layout-positioning mechanisms running in parallel created confusion (which one wins when they disagree?) and doubled the test surface. Pick one.
- **Multi-step ref selection (e.g. click then confirm)**: Ctrl+click is the existing ref-set gesture in piano mode and works in all outline modes naturally.
- **qm=2 normalizes via (q−1, r±1)** (5-limit-m3-below interpretation): tested and rejected. Same-row Pythag spine (q+1, r) lines up better with the user's mental model of "this key, its octave-equivalents, and its spine" — qm=2 cells are visually adjacent to their same-row qm=0 spine on the lattice.
- **Bound the canvas to refSpine variance**: the Lumatone outline is visually static and the lattice slides underneath. Canvas bounds are determined by outline extent alone; refSpine adds no bounds dependency.

**Why**:
- The 3-layout system was a special case of ref-positioning. Generalizing it makes the 12 Pythagorean keys plus their syntonic siblings equally reachable from a single gesture, rather than three preset positions.
- Holding the lattice positioning concept in one mechanism (ref note + refSpine) replaces three (layout buttons + QWERTY transpose + Composer-set song key) with one. Composer's ref-broadcast and the manual Ctrl+click both feed the same path.
- Tweening via the existing `animation.tweenTo` reuses 500ms-smoothstep machinery already exercised by the layout-button system, so the animation behavior is unchanged in spirit.

**Where**:
- `src/tuning/refspine.ts` — NEW. The 3-line normalization helper.
- `src/render/draw.ts` — Lumatone-side `kbShQ/kbShR` derived from `refSpine(referenceNote.q, referenceNote.r)`; `sizeGridCanvases` extended to tween hex layer across `[view → target]` for ALL outline modes.
- `src/ui/controls.ts:syncViewToOutline` — calls `buildHexLayerForTween` for all outline modes; `setLayout`/`applyLayoutImmediate` reduced to no-ops; `updateLayoutButtonsForOutline` stubbed.
- `src/midi/engine.ts:buildMidiReverse` + `fixedMidiToKey` + new `fixedMidiToKeyAt(ch, note, spQ, spR)` for migration lookups.
- `src/input/keyboard-notes.ts:codeToKey` uses `refSpine` directly (no `qwertyTranspose`).
- `src/render/canvas.ts:staticOutlineCells` — QWERTY just returns `qwertyKeys` (no union over transpose).
- `index.html` — `#layoutBtnGroup` and `#qwertyTransposeCtrl` removed.

---

## Held physical voices migrate on ref change; click-sourced voices anchor (2026-05-22)

**Picked**: When ref note changes (and the lattice shifts via refSpine), voices originating from PHYSICAL inputs migrate to follow their physical key: Lumatone MIDI voices (tracked in `midi/handler.ts:heldLumatonePhys` as `"ch,note"` strings) and QWERTY voices (tracked in `input/keyboard-notes.ts:heldCodes` as `e.code` strings) re-target from the old lattice cell to the new one. Voices originating from mouse clicks stay anchored to the lattice cell they were clicked on. Fan-out lives in `src/effects/onRefChanged.ts`, called after `referenceNote` mutates with the `(dq, dr)` delta.

**Rejected**:
- **All voices migrate (mouse clicks too)**: would mean ctrl+click on a hex moves a previously-clicked-and-held hex along with the lattice. The user-mental-model for a clicked hex is "this lattice cell", not "this screen position". Migrating clicks breaks that.
- **No voices migrate (everything plays through to the old cell)**: Lumatone players would hear a held chord jump pitches when the lattice shifts. Wrong.
- **A single combined held-voice store** (instead of two per-input): the input-source identity is load-bearing — mouse clicks have no `"ch,note"` or `e.code` analog. Keeping per-input stores makes the migration condition self-documenting.

**Why**:
- A held Lumatone key continues to send the same `(channel, note)` MIDI; the lattice cell that addresses lands on changes when refSpine moves. The user is still pressing the same physical key, so they expect the same physical-key-relative pitch.
- Same logic for QWERTY: physical key = `e.code`, lattice cell = lookup under current refSpine. The key follows the lattice.
- Mouse clicks have no physical persistence — the click event is one-shot and the held voice is identified by lattice cell, not by a persistent input identity. Migrating clicks would force a synthetic "phantom click on a different cell" semantic that doesn't match anything the user did.

**Where**:
- `src/effects/onRefChanged.ts` — NEW. `onRefChanged(dq, dr)` fan-out.
- `src/midi/handler.ts` — `heldLumatonePhys: Set<string>`, `migrateHeldLumatoneVoices(dq, dr)`, `clearHeldLumatoneTracking()`.
- `src/input/keyboard-notes.ts` — `heldCodes: Set<string>`, `migrateHeldQwertyVoices(dq, dr)`.
- Callers: any code that mutates `referenceNote.q` / `referenceNote.r` calls `onRefChanged(dq, dr)` after the mutation.

---

## Ref validation: MIDI range + ≤±3 accidentals only (2026-05-22)

**Picked**: `validateRefNoteCandidate(q, r)` checks exactly two conditions:
1. `coordToMidi(q, r) = 57 + 4q + 7r ∈ [21, 108]` — MIDI range.
2. Every cell in the 88-cell footprint the picker produces under this ref spells with `≤ ±3` accidentals.

For `'7-legacy'` the accidental check intersects over `septimalShift ∈ [0, 5]` (the wrap period) so seam shifts can never orphan a placed ref. The validator runs LIVE (i.e., re-runs `compute88PianoCoords` per candidate); it does not consult the cached V5 / V7-uniform / V7-legacy outline sets that the "Valid ref bounds" overlay draws.

**Rejected**:
- **Use the cached valid-ref sets as the gate** (the prior approach): the cache was built by a square scan `q ∈ [−30, 30], r ∈ [−30, 30]`, which missed some valid refs at extreme q. Symptom: "Reference out of valid region" fallback fired on refs that passed accidental/MIDI checks. Fix: live check + a band-iterating cache (see below) for the visual outline.
- **Drop the accidental cap entirely**: would let the user set a ref whose 88-cell footprint contains quadruple-flat/sharp spellings that Composer can't render and the lattice can't visually convey. The ±3 limit matches Composer's accidental clamp (§7.16).
- **Cap accidentals at ±2 or ±4**: ±3 matches the canonical single-token MEI accidental glyphs (`s`, `ss/x`, `ts` and flat counterparts) — same threshold as Composer.

**Why**: simpler is better. The validator's job is "would this ref produce a usable footprint", which decomposes into "is the ref note within the piano range" and "does any cell need more than 3 accidentals to spell". Adding extra gates (must be in V5; must be in cached set; etc.) created false negatives without a corresponding musical benefit.

**Where**:
- `src/render/draw.ts:validateRefNoteCandidate` — live two-condition check.
- `src/render/draw.ts:ensureValidRefCaches` — band-scan cache for visual outlines only.
- `src/ui/init.ts` — ctrl+click handler calls the validator before setting ref.

---

## Band-scan valid-ref cache iterates the diagonal MIDI band exactly (2026-05-22)

**Picked**: The cache that powers the "Valid ref bounds" dotted outline iterates the lattice over `r ∈ [−25, 25]` and, per row, `q ∈ [⌈(−36 − 7r)/4⌉, ⌊(51 − 7r)/4⌋]` — the exact diagonal MIDI band `4q + 7r ∈ [−36, 51]` (= MIDI ∈ [21, 108]). For each `(q, r)` it runs `validRefForState(q, r, state)` against the three state vectors (V5, V7-uniform, V7-legacy-with-intersection-over-shifts) and accumulates the cells into three sets, then computes outline paths once.

**Rejected**:
- **Square scan `q ∈ [−30, 30], r ∈ [−30, 30]`** (the prior approach): missed valid refs at extreme q within the band. The band is diagonal — at `r = −20` the valid q range extends well past `+30`. Hand-checking found refs that passed `validateRefNoteCandidate` live but were not in the cached set, so the visual outline showed gaps and (when the cache was incorrectly the gate) refs were rejected.
- **Iterate the full integer lattice with bounds-based early-out**: equivalent to the band scan but messier code. Direct band iteration is one helper function (`bandQRange`) and a clean nested loop.
- **Cache as a single set per current mode** instead of three: would require rebuild on every mode switch. Three separate caches built once + active-set selector is cheaper.

**Why**: the valid-ref region is bounded by the diagonal MIDI band, not by a square. Scanning the band exactly costs about the same as a generous square and never misses cells.

**Where**:
- `src/render/draw.ts:bandQRange(r)` — `[⌈(−36 − 7r)/4⌉, ⌊(51 − 7r)/4⌋]`.
- `src/render/draw.ts:ensureValidRefCaches` — band-scan loop, lazy-built once.
- `src/render/draw.ts:activeValidRefSet / activeValidRefPaths` — mode-aware selector.

---

## Hex layer expansion for ALL outline modes during view tween (2026-05-22)

**Picked**: `sizeGridCanvases` uses `pendingTweenStart` / `pendingTweenEnd` (set by `buildHexLayerForTween`) as the source of truth for the offscreen layer's spatial coverage, irrespective of outline mode. When a tween is pending, `gridRef` sits at the midpoint of the tween range and the pad is extended by half the tween distance, so the layer covers both endpoints. `syncViewToOutline` calls `buildHexLayerForTween(view.viewQ, view.viewR, targetQ, targetR)` for every outline mode (was previously piano-only).

**Rejected**:
- **Pre-build only the destination layer**: causes cut-off-borders as the moving view crosses the offscreen edge before reaching the destination's center.
- **Build a single oversized fixed-pad layer**: cheaper for short tweens but wastes memory for the common case (small tween distances). Tween-aware sizing scales with the actual movement.
- **Skip the pre-build for non-piano outlines** (the previous behavior): assumed Lumatone/QWERTY tweens were always too short to cross the layer edge. Now that ref-driven shifts can move the view to any (q, r), this assumption no longer holds — any refSpine jump that moves the view by more than the static pad shows cut-off borders.

**Why**: a single tween-aware sizing path eliminates the "piano works, Lumatone shows borders" asymmetry. The cost is one extra `buildHexLayerForTween` call per outline-mode ref change, which is dominated by the actual hex-layer rebuild cost anyway.

**Where**:
- `src/render/draw.ts:sizeGridCanvases` — unified `view = computePianoViewCenter` (piano) | `refSpine` (else); pendingTween-aware gridRef + pad.
- `src/render/draw.ts:buildHexLayerForTween(startQ, startR, endQ, endR)` — sets pendingTween bounds, triggers a hex layer rebuild, then clears the pendingTween state.
- `src/ui/controls.ts:syncViewToOutline` — calls `buildHexLayerForTween` for all outline modes when the view actually changes.

---

## Octave-normalized picker tiebreak preserves ref-on-lineage invariant (2026-05-22)

**Picked**: `compute88PianoCoords(refQ, refR)` tiebreaks equal-Tenney-Height candidates by `|proj − PROJ_PER_OCT · round((midi − refMidi) / 12)|` where `proj = 7(q − refQ) − 4(r − refR)` and `PROJ_PER_OCT = 21` (= 7·Q_PER_OCT − 4·R_PER_OCT for octave step `(+3, 0)`). The octave-normalized target ensures each pitch class follows its own ref-aligned lineage: at the ref's own MIDI the picker returns `(refQ, refR)` exactly; Eb3 and Eb4 collapse to the same enharmonic spelling.

**Rejected**:
- **Zero-centered `|proj|` tiebreak** (the earlier attempt): at the ref's MIDI it correctly picks `(refQ, refR)` (proj = 0). But in 7-limit, a B-region cell can tie TH=0 with the ref's natural lineage cell because the syntonic adjustment cancels against the (7, −4) shift's comma. With zero-centered tiebreak, the picker can pick the syntonic sibling and relocate the ref to a different cell visually — the ref ends up outside its own 88-cell footprint, breaking the "validateRefNoteCandidate passes ⇒ ref ∈ footprint" invariant.
- **Largest-`proj` tiebreak**: monotone in proj, breaks 469 octave-consistency cases. Same-pitch-class at adjacent octaves end up at different enharmonic spellings.
- **Minimum `|proj|` tiebreak via Manhattan distance**: equivalent to the zero-centered case at the ref's octave; still broken at other octaves.

**Why**: pitch-class lineage is the user-visible invariant. The picker's job per MIDI is "give me the spelling that fits the user's keyboard mental model" — and the mental model is "this pitch class follows its ref-aligned column up and down the octaves". Octave-normalization expresses that directly.

**Where**:
- `src/render/draw.ts:compute88PianoCoords` — tiebreak uses `octaveDelta = Math.round((midi − refMidi) / 12); projTarget = PROJ_PER_OCT · octaveDelta; absNProj = |proj − projTarget|`.

---

## Legacy purge: back-compat-free pre-release cleanup (2026-05-22)

**Picked**: While HKL is unreleased, delete all migration and back-compat code for the user's own intermediate states. Persistence validates strictly: any unrecognized scalar pref reverts to default; any unrecognized pref key is dropped. No multi-version `.hkr` parsing, no schema upshifts, no "this used to be called X" fallbacks.

Specifically removed:

| Item | Why it was there | Why deleted |
|---|---|---|
| `TuningMode = '7-legacy'` + the entire global-shift septimal mode | Preserved the old `septimalMode='global'` behavior (alternating A/B bands shifted along r by `septimalShift`, ▲/▼ seam-shift UI) for users who'd loaded a `.hkr` from a previous experimental version | No such users exist; one user is also the developer; uniform septimal is strictly better musically |
| `septimalMode: 'global' \| 'uniform'` field | Distinguished the two modes | Only `'uniform'` survives, so the field is gone — uniform is the implicit default |
| `septimalShift` state, `shiftSeams` handler, ▲/▼ seam-shift UI, ArrowUp/Down handler, `seamShiftCtrl`/`seamShiftInd` DOM | Legacy global-shift parameter | Uniform mode is `qmod3`-only with no shift parameter |
| 3-layout system: `curLayout`, `setLayout`, `applyLayoutImmediate`, `layoutShifts {1: [0,0], 2: [7,-4], 3: [-7,4]}`, `updateLayoutButtonsForOutline`, ♭/♮/♯ button group, ArrowLeft/Right cycle | Replaced by `refSpine` but kept as no-ops for `.hkr` load back-compat | refSpine fully subsumes; old `.hkr` files won't load (acceptable pre-release) |
| `qwertyTranspose` + `qwertyTransposeShift()` + `QWERTY_TRANSPOSE_MIN/MAX` | Per-step QWERTY semitone shift, replaced by refSpine | Same as 3-layout — refSpine subsumes |
| `migrateTuningMode` (`'7x'` → `'7'`, `'7'` → `'7-legacy'`) | localStorage migration for users of pre-revamp experimental modes | No such users; strict validation handles bad values |
| `normalizeRotation` (`'qwerty'` → `'piano'`) | localStorage migration for the rotation-rename | Same |
| `isLayoutId`, `LayoutId` type | curLayout's type validator | curLayout gone |
| `LayoutSnapshot.curLayout / septimalShift / qwertyTranspose` fields | Stored in `.hkr` for back-compat with future feature reintroductions | None planned; strict snapshot parser now rejects unrecognized layouts |
| `EXP_REGION_MAP` + `setExpRegionMap`/`getExpRegionMap` (already deleted) + `exp-decisions.ts` | Per-hex experimental decision panel (pre-uniform) | Already gone; verified no lingering imports |
| `onLayoutChanged` effect | Fan-out for the curLayout change that's no longer a thing | No callers |
| `pairOf(r)` formula in `computeHue` (the syntonic-pair rotation) | Hue cycle correction for legacy global-shift mode | Uniform mode is qmod3-only; hue cycle stays at 5-limit baseline + B-region warm shift |
| V7-legacy outline cache + `V7_SHIFT_PERIOD` shift-intersection loop in `ensureValidRefCaches` | Visual aid for `'7-legacy'` valid-ref region | No such mode |

Migrations retained (still meaningful):
- Unrecognized scalar pref → default value. E.g. `tuning: 'banana'` becomes `'5'` on load.
- Missing pref key → the field is simply absent and `DEFAULT_PREFS` supplies the value via fallthrough in `loadPrefs`.

**Rejected**:
- **Keep `'7-legacy'` hidden but reachable**: would require keeping the entire global-shift code path, the seam-shift UI, the cache intersection logic, and the migration. No users.
- **Keep `curLayout` in the snapshot for round-trip stability**: irrelevant pre-release; recording / DAW round-trip is the user's own workflow and he can re-record.
- **Schema version bump on `.hkr`**: pre-release schema-version bumping is theater. Old recordings load nowhere; new recordings use the new schema.

**Why**: every retained migration is permanent maintenance overhead — it has to keep working through every future refactor and is exercised only by a small finite set of legacy states. Pre-distribution is the cheapest moment to delete that overhead. Once the app ships, every migration becomes a load-bearing API.

**Constraint surfaced**: typecheck + build catches every syntactic dangling reference (imports of deleted exports, references to gone-fields). What it doesn't catch is *runtime* behavioral references — e.g. a comment claiming "X happens when seam shifts" is now wrong but compiles fine. Grepping for the removed identifiers across the docs in this commit caught those.

**Where**:
- `src/state/persistence.ts` — `TuningMode = '5' | '7' | 'E'`; `PrefsV1` shrunk by 2 fields; validators slimmed.
- `src/state/tuning.ts` — `{ septimalEnabled, equalEnabled, septimalW }` only.
- `src/tuning/regions.ts` — uniform-only region rule; legacy bands and `isRegionB` / `regionBandIdx` deleted.
- `src/tuning/frequency.ts` — `septimalShift` tempering line dropped.
- `src/layout/baseKeys.ts` — `layoutShifts` and `qwertyTransposeShift` deleted.
- `src/render/{colors, draw, canvas}.ts` — pair-shift hue correction dropped; valid-ref cache halved; PIANO_BOUNDS_TABLE regenerated.
- `src/recording/{types, snapshot, apply, hkr}.ts` — snapshot fields trimmed; parser rejects extra-keys-missing.
- `src/ui/{controls, init, keyboard}.ts` — `shiftSeams` IIFE, `setLayout`/`applyLayoutImmediate`, ArrowUp/Down handler all deleted.
- `src/midi/engine.ts` — `degreeMap` comment updated; `buildMidiReverse` uses `refSpine` (unchanged in behavior).
- `src/lumatone/sync.ts` — Lumatone target colors use `refSpine` instead of `layoutShifts[curLayout]`.
- `src/effects/onLayoutChanged.ts` — DELETED.
- `index.html` — seam-shift control block deleted.
- `tools/bounds-probe/{compute-bounds,octave-consistency}.mjs` — `septimalShift` / `layoutShifts` / `qwertyTranspose` iterations replaced with uniform-only / single-refSpine logic.


## Five-layout tuning system: rename + Pythagorean + Semiditonal (2026-05-23)

**Picked**: Five-mode selector — `Equal · Ptolemaic · Pythagorean · Semiditonal · Septimal` — driven by a mode-keyed `regionInfoWithState`. Each cell's `RegionInfo` (type, aDepth, aUpper) is a pure function of `(mode, qmod3)`; the existing frequency/ratio loops apply whatever the RegionInfo dictates.

Per qm column:
- Ptolemaic `'5'`: A-d0 everywhere (5-limit base).
- Pythagorean `'P'`: qm=0 A-d0, qm=1 A-d1-lower (+SC), qm=2 A-d1-upper (−SC). Every M3 → 81/64; every m3 → 32/27. No 5-limit ratios anywhere.
- Semiditonal `'D'`: qm=2 A-d1-upper (−SC) only. qm=2 cells become enharmonic to their (+7,−4) 5-limit siblings — Pythagorean m3 reachable inside a band.
- Septimal `'7'`: qm=2 B-d1-upper (current). Unchanged behavior.
- Equal `'E'`: 12-TET early-return in frequency math; regions not consulted.

Persistence values `'E' / '5' / '7'` stay (no migration); `'P'` and `'D'` are new. UI labels are descriptive (no numeric prime-limit suffixes); the conceptual names cover what numeric labels can't — "Ptolemaic" foregrounds that this is the 5-limit Ptolemaic-major tuning rather than any flexible 5-limit, and "Semiditonal" foregrounds the Pythagorean-minor-third (semiditone) coverage.

**Rejected**:
- **Migrate to descriptive slugs everywhere** (`'Pt' / 'Py' / 'Sd' / 'Sp' / 'Eq'`): would need a persistence migration, an `.hkr` parser branch, and bridge protocol bump for zero functional gain. Single-char codes stay; comments document the meaning.
- **Three new color variant fields** (`.dl/.dd` for −SC, `.ul/.ud` for +SC) on `HueColors`: `computeHue` already encodes the SC equivalence — an SC shift of `(q,r)` lands you in the cell whose hue is the SC-shifted sibling's hue. The keyColorVariant helper just looks up `computeHue(q±7·d, r∓4·d)`. No new tables.
- **Seams on every region boundary** (full RegionInfo equality check): would draw seams between qm=0 / qm=1 / qm=2 in Pythagorean mode (three different shift profiles). User judgment was that the SC-shifted hue rotation already reads as the column boundary; adding seams on top is visual noise. Septimal stays the only mode that emits A↔B seams — the (subtle) septimal hue overlay benefits from the seam, the (more prominent) SC hue rotation does not.
- **Mode-specific analysis labels**: not needed. The chord classifier in `tuning/chords.ts` is already prime-content-based (`hasFive` / `hasSeven` → prefix); in Pythagorean mode every triad's ratio vector is 3-limit and gets labeled "Pythagorean major triad" / "Pythagorean minor triad" without code changes. Interval naming via `tuning/intervals.ts` decomposes through the existing comma basis.

**Constraint surfaced**: each mode's picker output differs because TH ranking uses mode-correct exponents. Pythagorean and Semiditonal canvas extents are larger than Ptolemaic / Septimal (1343×406 piano vs 1257×307 for refQ scan-window) because their pickers reach further along r for the SC-shifted siblings. PIANO_BOUNDS_TABLE and VALID_REF_TABLE both regenerated per-mode by the probes.

**Where**:
- `src/state/persistence.ts` — `TuningMode = 'E' | '5' | 'P' | 'D' | '7'`.
- `src/state/tuning.ts` — adds `mode: TuningMode` as canonical source; `equalEnabled` / `septimalEnabled` kept as derived booleans.
- `src/tuning/regions.ts` — mode-switched `regionInfoWithState`; new `modeHasShifts` helper.
- `src/tuning/{frequency,ratios}.ts` — gates flipped from `septimalEnabled` to `modeHasShifts(mode)`.
- `src/render/colors.ts` — new `keyColorVariant(q, r)` helper. For SC-only shifts (type='A', aDepth>0) computes hue at SC-shifted sibling coords; B-region keeps existing warm-shift variants.
- `src/render/{draw,info}.ts` — call sites switched to `keyColorVariant`; seam gate is `tuning.mode === '7'` (A↔B only).
- `src/render/{canvas,refbounds-table}.ts` — bucket tables now `Record<TuningMode, …>`, regenerated.
- `src/ui/controls.ts` — `setTuning` sets `tuning.mode` and derives flags; revalidates ref on any mode change.
- `src/bridge/hkl-side.ts`, `src/recording/{snapshot,hkr}.ts` — descriptors and snapshot serialization updated.
- `index.html` — five-option selector with conceptual labels.
- `tools/bounds-probe/{compute-bounds,compute-refbounds}.mjs` — iterate full TuningMode set.

## Future-layout sketches (deferred from 2026-05-23)

Ideas examined while landing the five-layout system, not pursued now but worth recording so we don't re-derive them later.

### Two-B-column Septimal variant

Adjacent to current Septimal in the design space: put **both qm=1 and qm=2 in region B** (`B-d1-lower` and `B-d1-upper` respectively, or some other combination) while keeping qm=0 as the 5-limit / Pythagorean spine. The current uniform Septimal trades 5-limit minor for 7-limit access through qm=2 alone; a two-B-column variant would retain qm=1's 5-limit major-third access while opening *two* septimal lineages relative to the root — useful for septimal voice leading that needs more than one B-cell reachable in a band.

Concretely: qm=1 becomes some B-region (likely `B-d1-lower` mirroring qm=2's `B-d1-upper`, so its septimal-comma direction is opposite — gives 9/7 or similar where qm=2 gives 7/4 / 7/6 / 7/9). The 5-limit M3 in qm=1 is lost, but the surrounding 5-limit context survives via qm=0 chains. 5-limit minor (10:12:15) is still lost as in current Septimal.

Open question: which exact `B-d?-?` profile for qm=1 produces the most useful septimal coverage. Worth a small notebook session.

### 49-limit / deep septimal (`aDepth = 2`)

Bump some column's `aDepth` from 1 to 2, surfacing 49-limit relations like 49/32 (`7^2 / 2^5`) and 49/48. Closest to Septimal's spirit but harmonically denser. The frequency / ratio math already handles arbitrary aDepth — only the region rule and the probe inputs need extending. Could live as "Septimal+" alongside the uniform variant.

### Out-of-scope (recorded so we don't accidentally re-evaluate)

- **Meantone family** (tempers r-axis fifth itself rather than redistributing commas across qm). Architecturally orthogonal — needs a `fifthTemperingCents` dimension. Interesting as a historical study layer but a different axis of variation than the qm-shift layouts.
- **11-limit / 13-limit**: lattice has no third axis; would need a comma-equivalence trick analogous to how Septimal collapses 7 onto qm=2.
- **Adaptive JI**: real-time tuning machinery already exists (audio-engine ramps), but out of scope for static-layout switching.

## Schismatic ('V') tuning mode (2026-05-24)

**Decision**: Added experimental `TuningMode = 'V'` ("Schismatic"). Sixth tuning option in the selector, marked study-only. Pythagorean's qm shifts unchanged; the band factor in `freqAt` gains a `SCHISMA^b` multiplier (schisma = 32805:32768 ≈ 1.954c). Result: every band is `(PM3, pure 5/4, PM3)` summing to octave + schisma — pure thirds everywhere at the cost of ~14c octave drift across the 7-octave span.

**Name caveat**: "Schismatic" was picked to reflect the layout-level schisma stacking (each band contributes one schisma; play across many bands and the schismas accumulate). This is **NOT** the classical schismatic temperament of fifths (which tempers each fifth by ~⅛ schisma so that 8 fifths approximate a pure 5/4). HKL's r-axis fifth stays pure 3:2 here — only the band/q axis stacks schismas. The TS code retains the original `'V'` (for "variant") as the persistence key to disambiguate from any future literal schismatic-temperament mode and to avoid breaking prefs.

**Why**: Max observed that 2·PM3 + M3 = octave + schisma is the identity behind Pythagorean's near-pure dim4 and Semiditonal's near-pure aug2. In existing modes the schisma is absorbed into the seam interval (making the dim4 tempered, ~2c flat of pure 5/4). V mode redistributes that schisma into the octave, leaving every third rationally pure.

**Railsback connection**: V mode's octave stretch magnitude (~1.95c/octave central, ~14c at 7-octave extreme) lands in the same range as the empirical Railsback curve of real pianos (~1–3c/octave central, ~25–35c extreme). Railsback's accepted cause is string inharmonicity; V mode is an independent schisma-driven stretch in the same direction. So pianistically-trained ears find V mode natural rather than jarring — the original "14c is unplayable" concern from the planning phase was wrong. V isolates the pure-thirds component of natural-sounding octave stretch from the inharmonicity component pianos add on top.

**Four non-trivial dispatches diverge from Pythagorean**:
1. `freqAt` in `src/shared/freq.ts` — multiplies by `Math.pow(SCHISMA, b)` for V.
2. `jiRatioWithState` in `src/tuning/ratios.ts` — adds `db × (−15, +8, +1, 0)` to the prime-exponent vector (the schisma's prime decomposition 3^8·5/2^15) so the interval analyzer naturally surfaces "octave + schisma" annotations via the existing comma machinery.
3. `keyColorVariant` in `src/render/colors.ts` — bypasses the SC-sibling redirect in favor of an M3-chain index: `chainStep = floor((2q+1)/3)`, `idx = (5 − midiOct − 2·chainStep) mod 7` in `hueCycle`. Cells share color iff on the same M3 chain in the same MIDI octave; the chain crosses bands (qm=1 of band b pairs with qm=2 of band b+1). This matches the Color Guide's V-mode principle — M3-related notes in the same octave share color, PM3 transitions change color. For ref=A, the Q-chain Db → F → A → C# → E# colors as TE, TE, PU, YE, YE.
4. Lattice seams in `src/render/draw.ts` — V mode joins Equal in skipping band seams entirely (gate is `!tuning.equalEnabled && tuning.mode !== 'V'`). Other modes seam at band boundaries because the qm=1 → qm=2 band-crossing is a different-spelled interval (diminished 4th rather than M3). V mode respells via the M3 chain, so the same boundary reads as a 5-limit M3 — no spelling change, no seam.

**Respelling**: `noteNameV(q, r, rsQ)` / `keyOctaveV(q, r, rsQ)` in `src/tuning/notes.ts` walk the M3 chain from refSpine: each Δq applies one `m3up`/`m3dn` step. Accidentals accumulate without clamping: A → C# → E# → G## → B## → D### → F#### at q=0..6. Cells in the same band as refSpine spell identically to standard naming; divergence begins one band away. `displayedNoteName` helper in `render/draw.ts` and the V branch in `bridge/hkl-side.ts:resolveKey` route through the new functions when `tuning.mode === 'V'`.

**Rejected alternatives**:
- **Schisma-tempered Pythagorean** (octave-preserving, all thirds slightly off): connects to classical schismatic temperament. Cheap to implement (just temper each fifth by schisma/8) but breaks the JI ratio analysis since no third is rationally exact. Max's stated reaction: "the existing dim4 interval already sounds close enough to M3 anyway, so it would add a whole new dimension for almost no reason." V mode trades the other way — preserve pure thirds, accept octave drift.
- **Schisma annotation overlay only** (no new layout): already exists in the interval analyzer (C#4→F4 in Pythagorean reads "M3 − schisma" today). Doesn't let Max *hear* the pure-thirds variant directly, which is the actual goal.

**Known degradation, accepted**: Composer score view clamps accidentals at ±3 per Verovio's clean-render constraint (`CLAUDE.md` § Composer architecture). V mode produces ±4+ at far M3-distances; Composer's visual score degrades for those cells but bridge frequencies stay accurate, so playback works. V is HKL-side study; not a composition mode.

**Reused, not regenerated**: `VALID_REF_TABLE['V']` and `PIANO_BOUNDS_TABLE[*]['V']` alias the Pythagorean entries. Justification: V uses identical qm shifts to P, and the ~2c/band schisma drift falls well within picker-TH tie thresholds in the central play range. Re-probe `tools/bounds-probe/` if V's experimental status changes.

**Files touched**: `src/shared/freq.ts` (TuningMode + TUNING_MODES + SCHISMA + freqAt), `src/state/persistence.ts` (TuningMode + isTuningMode), `src/tuning/regions.ts` (case V), `src/tuning/ratios.ts` (schisma exponent injection), `src/tuning/notes.ts` (noteNameV + keyOctaveV), `src/render/colors.ts` (V early return), `src/render/draw.ts` (displayedNoteName helper + validRefSetByMode/validRefPathsByMode V entries), `src/render/canvas.ts` (PIANO_BOUNDS_TABLE V entries), `src/render/refbounds-table.ts` (V alias to P via GENERATED.P), `src/bridge/hkl-side.ts` (description + isTuningMode + TUNING_LABELS + resolveKey V branch), `src/recording/hkr.ts` (isTuningMode), `src/composer/main.ts` (isMode), `src/composer/notation/retune.ts` (MODE_LABELS), `src/composer/setupDialog.ts` (TUNING_LABELS), `index.html` (option).

## HEJI accidentals on the lattice (2026-05-24)

**Decision**: Add an opt-in HEJI (Extended Helmholtz-Ellis JI Pitch Notation)
display mode that decorates each lattice cell label with SMuFL combined
"accidental + N syntonic-comma arrows" glyphs, plus standalone septimal
hooks where needed. Scope is **lattice + analysis vocabulary only** —
Composer rendering is deferred; V-mode M3-chain spelling is unchanged.

**Why**:
1. Backlog item `docs/backlog.md:89` — the interval analyzer was preferring
   *derived* commas (Pythagorean comma = syntonic+schisma, diaschisma,
   septimal diesis) over primary commas (syntonic, septimal, schisma). HEJI
   notates only primary commas; aligning analysis text with HEJI vocabulary
   ("syntonic comma" instead of "Pythagorean comma − schisma") makes the
   analyzer's output read identically to HEJI annotations even when the
   display toggle is off. This is a free correctness win and the default.
2. Backlog item `docs/backlog.md:88` — V mode's M3-chain accidental stacks
   are unreadable without a comma-context layer. HEJI doesn't *fix* the
   stacking (that's a separate respelling decision Max is reserving), but
   it adds back the harmonic-distance information the stacked accidentals
   strip away.

**Scope explicitly NOT in this iteration**:
- Composer MEI emission. Verovio can encode HEJI via `<accid glyph.num>`,
  but the Composer integration is deferred until Max wants to commit to
  one rendering path (native Verovio vs. SVG overlay).
- V-mode respelling redesign. `noteNameV` still walks the M3 chain
  unbounded. The "octave + schisma → A7?" question is a separate decision.
- 11-limit / 13-limit accidentals. HKL is 7-limit; no e11/e13 in the prime
  vector.
- Cents annotations above/below comma symbols.

**Glyph strategy (after one dead-end)**: SMuFL's HEJI range contains
*combined* glyphs only — `accidentalSharpOneArrowDown` (U+E2C3) is a sharp
with the arrow attached as one composite, NOT a standalone arrow. So the
rendering path can't be "sans-serif accidental + Bravura arrow alongside."
Instead each Pythagorean accidental in the label is REPLACED by its
combined Bravura SMuFL glyph carrying up to 2 attached arrows. Extras
spill onto appended natural-sign carriers (also combined glyphs). Standalone
septimal hooks (U+E2DE / U+E2DF) sit at the end — those *are* standalone in
SMuFL since they don't combine with Pythagorean accidentals. See
`docs/lessons.md` "SMuFL HEJI syntonic-comma arrows are combined glyphs"
for the dead-end I hit first.

**Label assembly rules** (in `src/tuning/heji.ts:hejiLabel`):
1. Build the conventional accidental chain: `[single, doubles...]` per
   accidental sign + count (e.g. accVal=+3 → `[♯, 𝄪]`).
2. Distribute syntonic commas across the chain in a **balanced** pass —
   one arrow per glyph left to right, then a second arrow per glyph left
   to right (capacity stays 2/glyph). F#### with one syntonic comma
   renders `x↓ x↓`, not `x↓↓ x`; the chain reads as visually uniform
   instead of front-loaded. (Earlier draft was greedy left-to-right.)
   Each glyph becomes its "accidental + N arrows" SMuFL variant.
3. Extras (chain capacity exceeded) spill onto natural-sign carriers
   greedily packed at 2 arrows each. Carriers exist only to carry arrows,
   so packing them maximally minimizes glyph count.
4. One septimal hook glyph at the end if `sept7 ≠ 0`. (Current layouts
   produce |sept7| ≤ 1; the 2× hook glyphs exist in SMuFL but are unused.)

The only label form WITHOUT any full accidental glyph is the bare-letter
Pythagorean-spine case (accVal=0 AND syn5=0 AND sept7=0). Even a
"natural-letter" pitch with a syntonic comma (e.g. `E` from `m3up(C)` in
Ptolemaic mode with e5=+1) renders as `E` + combined `natural + 1 arrow
down` SMuFL glyph. No "naked arrows" — every arrow lives on a carrier.

**Toolbar + auto-on behavior**: Single `cbHeji` checkbox in the Layout
toolbar; persisted as `PrefsV1.hejiEnabled`. `setTuning()` auto-flips ON
when the user enters V mode and HEJI is currently off (V mode's stacked
accidentals are the load-bearing reason HEJI exists). Leaving V mode
preserves the user's HEJI preference — once they've turned it on in V,
they may want it elsewhere.

**Analysis-vocabulary change**: `optimizeCommas(s, z, h)` in
`src/tuning/intervals.ts` now defaults to emitting raw `(s, z, h)` counts
of primary commas. The legacy six-permutation substitution search (which
preferred derived commas to reduce displayed groups) is preserved behind a
new `useDerived=true` flag, but no caller currently passes it. The
phrasing in `fmtInterval` was already HEJI-compatible — only the
optimizer's substitution preference changed.

**Font**: Bravura (Steinberg, SIL OFL). Specifically BravuraText.woff2 —
the text-style variant compiled with tight em-box cropping for inline use.
Vendored at `public/BravuraText.woff2` (~335KB); jsdelivr URL is a `src:`
fallback. Bravura glyphs render at 1.8× the letter font size in HEJI
labels to match the visual weight of the conventional sans-serif path —
see `docs/lessons.md` "Bravura SMuFL glyphs render much smaller…"

**Rejected alternatives**:
- *Unicode arrows in sans-serif* (`↑ ↓ ⇈ ⇊` for syntonic) alongside
  sans-serif accidentals. Loses HEJI's visual identity; the combined SMuFL
  glyphs convey the binding between accidental and arrow correctly.
- *Render the whole label in Bravura including the letter*. BravuraText
  doesn't include Latin letters in the normal way — it's a music-symbol
  font. Letter rendering stays in sans-serif.
- *Composer integration in this iteration*. Verovio's MEI parser
  reportedly handles `<accid glyph.num="U+E2C3">` via the `@glyph.num`
  attribute path, and Bravura ships with the WASM build, but the rendering
  spike that would confirm horizontal layout is non-trivial. Deferred
  until Max wants to commit.

**Files touched**: `src/tuning/heji.ts` (new — `hejiCommas`, `hejiLabel`,
SMuFL codepoint tables), `src/tuning/intervals.ts` (`optimizeCommas`
default flip), `src/state/persistence.ts` (`hejiEnabled` field + load
path), `src/state/tuning.ts` (`hejiEnabled` runtime flag), `src/ui/controls.ts`
(setTuning V auto-on), `src/ui/init.ts` (cbHeji wiring +
applyPrefsToDom), `src/render/draw.ts` (`drawHejiLabel`,
`drawConventionalLabel` split + `hejiLabelForCell`),
`src/effects/onTuningChanged.ts` (textDirty on mode change),
`index.html` (cbHeji + `@font-face`), `public/BravuraText.woff2` (new),
`tools/heji-check.mjs` (new — comma-count fixture), `package.json`
(check:heji script).

## Exponent collapse on high-AD/high-SD lattice cells (2026-05-24)

**Decision**: Collapse the long accidental-and-arrow chain on lattice cells
with |AD|>4 or |SD|>4 into a single accidental-form glyph + sans-serif
typographic superscript (`#⁷`, `(#↑)⁵`, …). Implemented in
`src/tuning/heji.ts:hejiLabel` (Step 0 of the label assembly) and rendered
by `src/render/draw.ts:drawHejiLabel`. Lattice-only — Composer's ±3
alteration entry gate stays untouched.

**Why**: V mode's M3-chain respelling (`noteNameV` in `src/tuning/notes.ts`)
produces unbounded accidental counts (`B#####` at q=+12 from refSpine A,
etc.). With HEJI on, the chain piles arrows onto each accidental and
spills extras to nat carriers. Either way, the label runs off the hex
face. This is the unread-V-mode-cells item from `docs/backlog.md:88` that
was explicitly deferred when HEJI shipped.

**Algorithm** (greedy in both cases):
- **Case A** — both |AD|>T and |SD|>T (T=4): collapse target =
  accidental + 1 arrow (`#↑/#↓/♭↑/♭↓`). Exponent `k = min(|AD|, |SD|)`
  absorbs one of each per unit. Leftover is the excess of whichever was
  larger. Position 'before' (target carries an arrow).
- **Case B** — `|AD−SD|>T`, NOT Case A: collapse target = bare accidental
  (if AD-heavy) or natural + 1 arrow (if SD-heavy). Exponent
  `k = ||AD| − |SD||` absorbs the entire excess. Position 'after' for
  bare-target, 'before' for natural+arrow target. Leftover always has
  equal residual AD/SD (= `min(|AD|, |SD|)` each), so the existing chain
  distributor pairs them efficiently with no natural-carrier spillover.

**Why the greedy formula for Case B**: an earlier draft used
`k = AD − 2·⌈SD/2⌉`, reasoning that the leftover needed even-double
carriers for the SD arrows. Max corrected: greedy is simpler, gives a
shorter visual result in all cases, and leaves the same number of glyphs
or fewer. Worked-case regression in the plan file confirms parity with
his backlog examples.

**Why "always at the end" septimal hook**: when Case B-a-heavy fires AND
the cell carries a septimal hook (Septimal mode + high-r Pythagorean spine
cell), the renderer must place the hook AFTER the collapse-after-chain
glyph — not in its natural chain slot — to preserve the visual rule that
the hook trails the entire label. Implemented by separating septimal
glyphs out of the chain pre-layout in `drawHejiLabel`.

**Why drop `drawConventionalLabel`**: the conventional Unicode-glyph path
existed as a fallback during the Bravura font-load window. The font is
bundled at `public/BravuraText.woff2`, so the load resolves on the first
or second paint; the fallback was visually jarring (chain morphs from
Unicode to Bravura on font-ready). New policy: paint nothing until
`bravuraLoaded` is true, then paint the full Bravura-only label. The
`document.fonts.load(...)` hook re-triggers `draw()` on ready.

**Threshold**: `COLLAPSE_THRESHOLD = 4` (strict `>`, so collapse fires at
|AD|≥5 or |SD|≥5). Matches `docs/backlog.md:88`. Common cases (F##, Bb,
F# with one arrow) keep their existing multi-glyph rendering.

**Typography**: superscript at `0.55 × hejiFontSize` in sans-serif. Vertical
anchor computed from the collapse accidental's `actualBoundingBoxAscent`
(see `docs/lessons.md` "`actualBoundingBoxAscent` is relative to the
current textBaseline"). The two tuning constants (`EXP_SCALE`,
`EXP_ASCENT_FRAC`) sit at the top of the typography block in `draw.ts`
and are documented as empirically-tuned.

**Files touched**: `src/tuning/heji.ts` (`COLLAPSE_THRESHOLD`, `CollapseSpec`,
collapse decision in `hejiLabel`), `src/render/draw.ts` (collapse + exponent
rendering in `drawHejiLabel`, bravuraLoaded gate in `drawNoteName`,
`drawConventionalLabel` removed, dead `SHARP/FLAT/DBLSHARP/DBLFLAT`
imports cleaned).

---

## Composer cursor-ref gated on piano outline mode

**Picked**: HKL's selection tier accepts a `composer`-source value
(`setSelectionFromComposer`) but only treats it as effective when outline
mode = `'piano'`. In `'lumatone' | 'qwerty' | 'none'` the song-key tier
takes over instead. Manual selections (Ctrl+click) apply in every outline
mode.

**Rejected**:
- Cursor-ref always wins (prior behavior). The cursor's most-recent prior
  note is genuinely useful when the user is staring at the 88-key piano
  outline, but it's noise when the Lumatone outline is showing: opening
  HKL second would land the lattice on whatever random note the cursor
  was last next to (often "C" from a score's opening chord) instead of
  on the song key.
- Clearing composer-selection on every `set-song-key`. Too aggressive —
  would interrupt live-edit cursor reference during a normal key-sig
  change.
- Clearing only at handshake (composer-hello). Doesn't help when set-
  reference-note arrives after composer-hello in the same burst (which it
  does — both fire from the same handler).

**Why outline-gated**: the cursor-ref is conceptually a piano-outline
feature — "where you're entering notes lives here on the 88 keys". The
song-key is conceptually a band-orientation feature — "the key signature
puts this tonic at the center of a band". Picking the right one per
outline mode resolves the tension without either side having to back
down.

**Where**: `selectionActive()` + `readOutlineMode()` in
`src/state/reference.ts`. `setOutline()` in `src/ui/controls.ts` now
captures `view.kbAnchor`, calls `recomputeReferenceForOutline()`, and
fans out via `onRefChanged` (with `invalidatePianoOutline`) when the
effective ref flips on an outline-mode toggle.

---

## Song-key picker: qm=0 spine, lowest MIDI ≥ F3

**Picked**: `findTonicCoord` in `src/composer/cursor/refNote.ts` places
the song-key tonic on the qm=0 Pythagorean spine in the lowest octave
at or above F3 (MIDI 53). r is fixed by tonic identity (the spine *is*
the fifth-chain from A — `fifthName(r)` is the canonical map, used to
seed the `TONIC_R` lookup so the table stays in sync with the lattice
naming algorithm). q starts at 0 and walks by ±3 (one octave per step)
into the MIDI window [53, 64].

**History**: original rule was `keyOctave(q, r) ∈ {3, 4}` (spelled-octave
target). Replaced 2026-05-25 because the spelled-octave check let
tonics with MIDI < 53 sneak through (C3 = 48, D3 = 50, E3 = 52, B♭3 = 46,
etc. all spell as octave 3). Floor now reads MIDI directly so the
constraint is unambiguous.

**Rejected**:
- Bounded grid search minimizing taxicab `|q| + |r|` (prior-prior
  behavior). No qm or octave constraint, so distant-octave or off-spine
  cells could win. Especially bad in Schismatic ('V') mode, where each
  band carries a schisma — landing the ref on a distant band makes the
  lattice visually drift.
- Search with constraints + tiebreak. Unnecessary — for any tonic the
  qm=0 spine has exactly one cell per octave, so once the band is
  picked, the (q, r) is determined.
- Putting the F3 floor inside HKL's `validateRefNoteCandidate`
  (`src/render/draw.ts`). User-selectable refs (Ctrl+click, cursor
  ref, pref restore) should remain free to land below F3 — the floor
  is a property of the Composer→HKL broadcast, not of every ref the
  user can manually choose. Keeping the rule in `findTonicCoord` keeps
  the two tiers independent.

**Why qm=0 + MIDI ≥ F3**: qm=0 is the band's center position, so the
ref always lands in the visually central column of a band. F3 is the
lowest pitch at which the 88-cell picker produces a clean lattice
under the ±3-accidental rule; refs below F3 drag the outline into
the lattice's bass tail where spellings get cramped.

**Coverage**: all 15 key-sig tonics reach a valid (q, r) in [53, 64].
Concrete sample: C → (3, −3) = C4, F → (4, −4) = F3, E → (−6, 4) = E4,
G → (1, 1) = G3, A → (0, 0) = A3. Verified by
`song_key_csharp_from_empty_voice` fixture (asserts qm=0 + MIDI window
structurally rather than locking to a specific coordinate).

**Where**: `TONIC_R` map (derived from `fifthName(r)` for r ∈ [-10, 7] —
upper bound was 4 pre-keyMode; see below) and `findTonicCoord` in
`src/composer/cursor/refNote.ts`.

## Composer keyMode: standard MEI `@mode` on `<scoreDef>` (2026-05-25)

**Picked**: Composer carries an explicit `keyMode: 'major' | 'minor'`
doc-level setting, persisted as standard MEI `@mode` on `<scoreDef>`
(alongside `@key.sig`). Surfaced as a checkbox in Setup that relabels the
key drop-down between major-tonic and relative-minor labels (only the
active mode's name is shown). `computeSongKeyRef` reads `keyMode` and
passes it to `keySigToTonic(sig, mode)` — minor returns the relative-minor
tonic (`'0'` → `'A'`, `'7s'` → `'A#'`, etc) so the song-key broadcast lands
on the actual tonic. `TONIC_R`'s precomputed range extends to r ∈ [-10, 7]
to cover the three minor tonics (`g♯`/`d♯`/`a♯` at r=5/6/7) that fall
above the major-only window.

**Why now**: the ref-spine-driven layout slides the lattice so the ref
note centers under the static Lumatone/QWERTY outlines. Pre-keyMode the
song-key tier always resolved to the major-key tonic — a piece in A minor
got C-major-centered geometry. Tuning modes that bias toward particular
chord shapes (Septimal's clean dominant-7, Pythagorean/5-limit minor
variants) compound the cost. The minor flag makes the lattice center
match the music's actual tonic.

**Rejected**:
- HKL custom `hkl:mode` attribute alongside `hkl:layoutReq` in
  `<extMeta><hkl:config>`. Consistent with the existing custom-attr
  pattern, but wouldn't round-trip MusicXML mode without bespoke
  serialization. `<scoreDef @mode>` is MEI 5 standard.
- UI-only ephemeral toggle. Doesn't match how Setup's other settings
  behave; loses state on reload.
- Labeling both names in the drop-down ("a minor (C major)") and bolding
  the active side. Useful but Firefox renders styled `<option>` text
  inconsistently. The picked design shows only the active mode's name
  and relies on the checkbox for the relationship.

**Why MEI standard @mode**: portable across MEI consumers, survives `.hkc`
roundtrip via the existing `<scoreDef>` element (snapshot/undo come along
for free via MEI cloning), and maps cleanly to MusicXML `<mode>` on
export. Defaults to `'major'` when absent, so older `.hkc` files load
without migration.

**Where**: `getKeyMode`/`setKeyMode` in `src/composer/model/index.ts`;
`keySigToTonic(sig, mode)` in `src/composer/notation/accidentals.ts`;
`computeSongKeyRef` + extended `TONIC_R` in
`src/composer/cursor/refNote.ts`; `#setupKeyMinor` checkbox and live
re-label in `src/composer/setupDialog.ts` + `composer.html`; `<mode>`
emission in `src/composer/save.ts`. Fixtures:
`keyModeMinor_0_BroadcastsA`, `keyModeMinor_7s_BroadcastsAsharp`,
`keyModeMajor_3s_BroadcastsA`, `keyModeRoundtrip` in
`tools/composer-test/fixtures.mjs`.

## V-mode picker routes through D state (2026-05-25)

**Decision**: `compute88PianoCoords` in `src/render/draw.ts` constructs a
hypothetical `TuningStateLike` with `mode: 'D'` when the live
`tuning.mode === 'V'`, and passes it to `jiRatioWithState` in place of
the live state. The offline probes (`compute-refbounds.mjs`,
`compute-bounds.mjs`) apply the same V→D substitution in their inlined
`pianoCells` mirrors. `VALID_REF_TABLE['V']` and
`PIANO_BOUNDS_TABLE[*]['V']` are regenerated and now byte-identical to
D's entries.

**Why**: V's per-band schisma exponent — added in `jiRatioWithState`
lines 51–55 as `db × (−15, +8, +1, 0)` — is the prime decomposition of
the schisma (32805:32768). When the picker measures TH against this
adjusted exponent vector, the natural (3k, 0) lineage cells, which
spell as the ref's letter at every octave (A3 → A4 → A5 → …),
accumulate a schisma per band and rise to TH ≈ 30·|k|. Diaschisma-
spelled alternates at the same MIDI come in lower (TH ≈ 22) and win
the comparison. Concrete: at ref A3 = (0,0), MIDI 69 (A4) picked
(−4, 4) at +19.55c off pure 2:1 over (3, 0) at +1.95c. At MIDI 105
the picker landed on (−2, 8) "G##" with TH 0 — an arithmetic
coincidence where V's schisma adjustment exactly canceled a 5-limit
residue. Neither outcome is what V mode wants: the design is that
qm=0 cells in successive bands spell as the same letter (per CLAUDE.md
§ V mode), and the picker was breaking that invariant.

**The fix is one line.** D mode shares V's qm shifts (qm=2 −SC, no
others) but doesn't apply the schisma exponent, so under D rules
(3k, 0) has exps (k, 0, 0, 0) → ratio = 2^k → TH 0 at every octave,
and the projection tiebreak picks the lineage cell. Audio playback is
untouched: `freqAt(…, 'V')` still applies the `SCHISMA^b` factor, so
the audible schisma stretch (~2c/octave central, ~14c at the 7-octave
extreme) is preserved. The picker is the *only* place that opts out;
the interval analyzer, color logic, HEJI, and seam drawing all still
see V's schisma exponent.

**Rejected alternative**: a red-tier cents-to-pure tiebreak — when the
picker's best-TH candidate is itself red-tier (TH ≥ 12.5), fall back
to minimum cents distance to the nearest green-tier JI ratio
(`tenneyHeightFromExps < 8`) at the candidate's pitch class mod 1200.
Worked at the diaschisma case (MIDI 69 → (3, 0)) but had a fatal
pathology: the green-tier-mod-1200 list contains arithmetic targets
like 119.44c (some pure JI semitone) that lattice-exotic cells can
land within 2c of via syntonic-comma stacking, even at TH 200+. The
picker started preferring `(−28, 11)` "A#" — far on the lattice, TH
240, but its pitch class is 1.84c from a green ratio — over the
natural `(0, −5)` "Bb" at TH 16. Tightening with a `±1` accidental
filter from `refAcc` didn't help; the exotic cells just spelled with
one sharp. The V→D substitution avoids this entire class of
arithmetic-coincidence picks by never assigning the cells a low-TH
score in the first place.

**Backlog items addressed**: `docs/backlog.md:86` (recompute V valid-
ref bounds after mode is finalized) and `:88` (red-tier cents
tiebreak) — both resolved by this change; the cents rule turned out
to be unnecessary once the V→D substitution was in.

**Where**: `src/render/draw.ts:compute88PianoCoords`,
`tools/bounds-probe/compute-refbounds.mjs:pianoCells`,
`tools/bounds-probe/compute-bounds.mjs:pianoCells`. Regenerated:
`src/render/refbounds-table.ts` (`VALID_REF_TABLE['V']`) and
`src/render/canvas.ts` (`PIANO_BOUNDS_TABLE[*]['V']`).

**Future cleanup option**: since V's entries duplicate D's, the
per-mode tables could alias V to D directly in code
(`validRefSetByMode['V'] = validRefSetByMode['D']` and similar). Kept
separate for now to preserve explicit per-mode dispatch; revisit if a
later mode-related refactor benefits from deduping.

## Interval naming is spelling-driven with per-complement-pair declarations (2026-05-25)

**Picked**: `src/tuning/intervals.ts` now drives interval naming from the diatonic spelling of the endpoints, not from the ratio. `classifyDiatonic` → `pythagRefExp` (closed-form) → `solveCommas` → override lookup or algorithmic `"Pythagorean <bare>"` default. Overrides are declared in `PAIRS`, one entry per complement pair (`{c1, c2, entries[…], pythag1?, pythag2?}`); the second half is auto-mirrored by `mirrorName` (ord swap, M↔m/A↔d, lesser↔greater flip), with an explicit `mirror:` field for class-specific phrases that the auto-mirror can't synthesize (apotome, harmonic 7th, chromatic semitone, diminished octave). Schismas always render as a suffix; perfect intervals never carry the `"Pythagorean"` prefix.

**Why**: Schismatic exposed the underlying bug — `intervalName(num, den)` was ratio-only, scoring against a REF table by Tenney height. F#→D in V mode collapsed onto "augmented 5th + syntonic comma" because aug 5th (25:16) outranks Pythag m6 (128:81) on TH and both have a one-comma decomp. Same class of failure exists in every JI mode whenever enharmonic spellings tie on cost.

Considered alternatives:
- **Expand the REF table** with more entries (e.g., add "Pythagorean diminished 4th" 8192:6561 etc.). Rejected: ratio shopping still picks the wrong base for cases like F#→D. Symptom, not cause.
- **Flat bucket table** keyed by `(ord, qual, s, z) → name` for every named interval. Rejected during planning: ~60 entries, complement symmetry maintained by hand, every edit risks asymmetric drift, every "Pythagorean diminished 4th"-style niche needs its own entry. Max's directive after the first draft was specifically against this.
- **Per-class profile objects** (one record per `(ord, qual)`). Rejected: still requires writing each half of every complement pair separately.

The per-pair structure with auto-mirror was the right axis: complement symmetry is enforced *by data shape*, not by review discipline. Editing one half implies the other; the explicit `mirror:` field surfaces every place where naming convention breaks symmetry (and those are the actually-interesting cases — apotome's complement isn't "lesser/greater Pythag diminished octave", harmonic 7th's complement isn't "subharmonic 2nd"). The algorithmic Pythag default catches everything outside the table without an entry, so adding modes or coordinate gymnastics doesn't require an explicit name addition until/unless the user wants a non-default name for some specific `(ord, qual, s, z)`.

**Renames carried in** (existing REF strings that didn't match the cleaner pattern): 9/8 was "greater major 2nd" → "Pythagorean major 2nd"; 10/9 was "lesser major 2nd" → "major 2nd"; 16/9 was "lesser minor 7th" → "Pythagorean minor 7th"; 9/5 was "greater minor 7th" → "minor 7th"; 7/5 was "lesser septimal tritone" → "septimal diminished 5th"; 10/7 was "greater septimal tritone" → "septimal augmented 4th"; 4096/2187 was unnamed → "Pythagorean diminished octave". The m7↔M2 pair is now Pythagorean/unaltered (matching m3↔M6 and M3↔m6); the m2↔M7 pair stays Pythagorean/lesser/greater (3-rung ladder). Both are valid per-class conventions kept symmetric across complements.

**Gone**: the old `intervalName(num, den, preE?)` function, the REF array, the complement-decomposition fallback, and the `optimizeCommas(useDerived=true)` branch (the derived-comma substitution rules — diaschisma / Pythagorean comma / septimal diesis). Only one external caller (`render/info.ts:127`); migrated to `intervalNameFromCoords`. No backwards-compat shim — coords are always available at the analyzer callsite.

**Smoke verification**: `tools/interval-names/smoke.ts` walks representative intervals across all six modes. Run with `npx tsx tools/interval-names/smoke.ts`. Confirms the V-mode A3→A4 case prints "perfect octave + schisma", A3→A5 prints "perfect 22nd + 2× schisma", E4→C5 (m6 across one band) prints "Pythagorean minor 6th + schisma".

**Where**: `src/tuning/intervals.ts`, `src/render/info.ts:127`. `chords.ts` template names are unaffected — they're constructed from prime-content gates, not REF lookups.

## Composer keybindings.ts is documentation-as-data, not a dispatch table (2026-05-25)

**Picked**: `src/composer/keybindings.ts` is a typed `KEYBINDINGS: KeySection[]` constant that drives the Help modal and serves as the canonical reference for every Composer keystroke. The actual key-event dispatcher remains hand-written in `src/composer/input.ts` (~1600 lines of branching). Adding a binding requires editing BOTH files; they're kept in sync by review discipline + the Help-modal fixture's content assertion, not by code generation.

**Why**: The backlog item asked for a reference modal that "becomes the doc source rather than the current giant input.ts header docstring." Two reasonable readings: (1) modal-as-doc only — replace the docstring, leave dispatch alone; (2) full unification — make `keybindings.ts` a dispatch table and have `input.ts` interpret it. Picked (1).

Considered alternative — dispatch-driven-by-data — was rejected because:
- The dispatch is rich: pending-state machines (tuplet armed → digit; hairpin start → hairpin end), mode predicates (voice vs expression vs select, with selection-mode having its own sub-dispatcher), context flags (chord-internal selection preserved across specific keys), platform quirks (Alt+arrow `preventDefault` to defeat Firefox back/forward nav, `Input.dispatchKeyEvent` in tests). Capturing all of this in declarative data would require either a complex DSL or rendering the data structure into something only marginally more readable than the existing switch-style code.
- The expected drift risk (someone adds a binding to `input.ts` without updating `keybindings.ts`) is low because: (a) the modal renders the *complete* catalog, so missing entries are user-visible; (b) the Help fixture in `tools/composer-test/fixtures.mjs` asserts specific binding strings are present; (c) most binding changes are deliberate enough to touch both files.
- The data-only catalog is also a useful future surface for searching/filtering bindings (Cmd-K palette), which a dispatch table is not.

**Where**: `src/composer/keybindings.ts` (catalog + types), `src/composer/helpDialog.ts` (lazy render + open), `src/composer/input.ts:1` (one-line pointer where the docstring used to live), `tools/composer-test/fixtures.mjs:HELP_MODAL` (assertion that specific bindings render).

If a future task DOES want to collapse the two files into a single dispatch-driven catalog, the seam to design around is the pending-state machinery in `input.ts` — that's where the declarative-data path gets hard, not the simple key-to-action mappings.

---

## Interval naming: nearest-match base + named adjective hierarchy + Lumatone-accessibility-driven septimal ratios

**Picked**: A three-layer base-name selection scheme for `intervalNameFromCoords`, plus four fixed-meaning adjective conventions, plus four septimal-name reassignments tied to Lumatone reach rather than xen-wiki canonical ratios.

1. **Nearest-match base name** (`findBaseName` in `src/tuning/intervals.ts`): enumerate every override entry for `(ord, qual)` plus the Pythagorean default at `(s_o=0, z_o=0)`; pick the entry minimizing `|s − s_o| + |z − z_o|`; emit the residual `(s − s_o, z − z_o)` as commas. Replaces the previous exact-match lookup, which fell through to `defaultPythagName` + full `(s, z)` residual whenever no override matched exactly. Eliminates outputs like "Pythagorean major 3rd − 2× syntonic comma" in favor of "major 3rd − syntonic comma" (using the 5-limit override as the closer base). Ties prefer `z_o=0` (5-limit) over `z_o≠0` (septimal) over Pythagorean default.

2. **Named-adjective hierarchy**:
   - `lesser / greater` — the two 5-limit (z=0) variants of a quality, both reasonably common. `greater` = higher cents.
   - `acute / grave` — wider/narrower than the common 5-limit form, much more exotic. Mirror-flips acute↔grave.
   - `septimal` — one prime-7 factor.
   - `subminor / supermajor` — explicit mirror required, currently used only for the 28:27 / 27:14 family.
   - `wolf` — fixed name for narrowing P-class variants (27:20, 40:27).

   Both `lesser/greater` and `acute/grave` mirror-flip in `autoMirror`.

3. **Single-class declarations** (`c2` optional in `PairDecl`): for classes whose complement is structurally unreachable. `(8, A)` is unreachable as `(1, d)` because `classifyDiatonic` normalizes to ascending direction (semis ≥ 0 always); ord=1 never produces qual='d'. Same logic applied to any future `(N, A)` whose mirror is `(1, d)`-family.

4. **Septimal ratio reassignment**: `septimal augmented 2nd / 4th` and `septimal diminished 5th / 7th` are bound to the most-accessible cell pair on the Lumatone in Septimal mode, not the xen-wiki canonical ratio. Specifically: `septimal augmented 4th` = 81:56 (not 10:7); `septimal diminished 5th` = 112:81 (not 7:5); `septimal augmented 2nd` = 135:112 (not 25:21); `septimal diminished 7th` = 224:135 (mirror).

**Rejected**:

For (1) — keeping exact-match lookup: produced misleading "Pythagorean X − 2× syntonic comma" outputs even when the 5-limit override sat one comma away. Confusing, more verbose, more commas than necessary.

For (2) — using lesser/greater for all SC-shift variants regardless of how exotic: would have over-decorated the common 5-limit names ("lesser major 2nd" for 10:9 instead of just "major 2nd"). The user wanted the bare names reserved for the common case. Hence acute/grave for the rarer side.

For (3) — pairing (8, A) with (1, d) anyway and accepting dead overrides: simpler change, but populates the map with names that are unreachable in practice ("lesser diminished unison") and creates a forward-safety hazard if `classifyDiatonic` is ever reworked. Optional `c2` is structurally honest.

For (4) — keeping 10:7 / 7:5 as `septimal A4 / d5` per xen-wiki: those ratios sit at taxicab distance 7 from any ref cell in Septimal mode on the Lumatone, while their replacements (81:56 / 112:81) sit at distance 4. Since the analyzer reads from played cells, the name on screen should match the more-frequent reach. Trade: 10:7 and 7:5 now read as `greater augmented 4th + septimal comma` and `lesser diminished 5th − septimal comma`.

**Why**: HKL's interval analyzer surfaces names for whatever the user is *playing*, in real time. A naming scheme optimized for written-music theory (xen-wiki canonical ratios, Pythagorean defaults preferred) loses to one optimized for what the player's fingers reach. The nearest-match algorithm minimizes comma clutter; the adjective hierarchy gives consistent names to the SC-pair structure of the lattice; the septimal reassignment respects the geometry of Septimal mode specifically.

**Where**: `src/tuning/intervals.ts` — `PairDecl` interface (optional `c2`), `findBaseName`, `autoMirror` (lesser↔greater + acute↔grave flips), `PAIRS` declarations. `tools/interval-names/enumerate.ts` for verification / gap-finding. `docs/architecture/hkl.md` (interval naming).

---

## `.hki` is a ZIP archive, not a custom container or JSON-with-base64 (2026-05-25)

**Picked**: `.hki` is a deflate ZIP with `manifest.json` + `samples/*.<ext>` + optional `provenance.json`. Reader/writer is `src/shared/hki.ts` over `fflate` (`zipSync` / `unzipSync`), pure-data per the `src/shared/` rules. Same library and code path used by the Node CLI bundler and the in-browser importer.

**Why**: Considered three alternatives.

1. **Custom binary container** (length-prefixed manifest header + raw audio blob concatenation). Rejected: reinvents the wheel; gains nothing over ZIP at HKL's bundle sizes (5-50 MB); harder to inspect with `unzip -l` during debugging.

2. **JSON-only with base64-embedded audio**. Rejected: ~33% size overhead vs raw bytes; forces a full JSON parse + decode pass before any sample is usable; doesn't stream; doesn't let the user crack the bundle open in a normal archive viewer to sanity-check what's inside.

3. **ZIP via `fflate`** (picked). Tiny dep (~30 KB gzipped, MIT, no transitives), works in Node + browser, deflate compression handles the lossless-and-already-encoded mix cleanly (encoded audio is incompressible — deflate adds ~0% overhead — and the manifest JSON compresses ~5×). `unzip -l <bundle>.hki` and `unzip -p <bundle>.hki manifest.json` work for debugging without writing a custom CLI.

The format is producer-agnostic by design: a Phase 2 in-browser analyzer will write `.hki` via the same `writeHki` consumers use to read it. The format spec lives in the TypeScript types in `src/shared/hki.ts`; everything else implements that spec.

**Where**: `src/shared/hki.ts` (schema + reader/writer), `analyzer/bundle.js` (Node producer), `src/state/instrumentRegistry.ts` (browser consumer + IndexedDB persistence), `docs/architecture/engine.md`.

---

## `.hki` codec policy: keep lossy verbatim, re-encode lossless to Opus (2026-05-25)

**Picked**: When building a `.hki` from cached source audio, the encoder dispatches on source extension:
- `.mp3 / .ogg / .opus / .aac / .m4a` → kept byte-for-byte (no transcoding)
- `.wav / .aiff / .flac` → encoded to OGG/Opus 128 kbps via `ffmpeg -c:a libopus -b:a 128k -ar 48000 -vbr on`
- Unknown extensions → kept verbatim (engine attempts to decode whatever it is)

**Why**: Re-encoding lossy audio compounds quantization noise — encoding an MP3 to Opus produces audibly worse output than either the original MP3 OR a fresh Opus encode from the original WAV. The CDN soundfonts HKL already ships are mostly MP3; bundling them via `.hki` (for distribution of a complete soundfont set, say) should preserve the original bytes. Conversely, when a user imports their own WAV-based sample library, encoding to Opus 128 kbps (which is transparent for almost all musical content) reduces bundle size 5-10× with no perceptible quality loss.

Opus chosen over Vorbis: ~30-50% smaller at the same perceived quality; universally supported in Firefox + Chromium since 2017; preferred by every modern codec recommendation. FLAC was considered as the "no compromise" option but rejected — it produces bundles 2-4× the size of Opus, and `.hki` is meant to be cheap to distribute, not archival.

User input on this choice was explicit ("OGG/Opus unless original source was mp3 already, then keep mp3"), generalized to the full lossy-vs-lossless extension list.

**Where**: `analyzer/bundle.js` — `LOSSY_EXTS`, `LOSSLESS_EXTS`, `targetExt()`, `encodeOpus()`.

---

## `INSTRUMENTS` is a Proxy, not a function call surface, for imported-bundle fallthrough (2026-05-25)

**Picked**: `src/audio/samples-data.ts` exports `INSTRUMENTS` as a `Proxy` over the static map. The `get` trap returns the static entry when present, else synthesizes-and-caches one from `getImportedManifest(key)` (with `source: 'hki'` marker). The `has` trap mirrors this. Iteration (`for..in`, `Object.keys`) is deliberately NOT intercepted — there's no `ownKeys` trap.

**Why**: Considered three options.

1. **Migrate consumers to `resolveInstrument(key): any`**. Touches `src/audio/samples-engine.ts` (4 sites: `loadInstrument`, `sNoteOn`, `sNoteOff`, plus the membership check in `engine.ts:instrIsSample`). Each site would need updating; future consumers might forget and call `INSTRUMENTS[key]` directly. The migration surface is large enough to introduce bugs and small enough to be annoying to maintain forever.

2. **Always merge into a single object on every imported-bundle change**. Simple, no Proxy. But every imported manifest synthesizes a per-sample-object eagerly, and a re-import has to rebuild the merged map. With 280 keys on the Lumatone and ~50-100 samples per imported instrument, this is wasteful but not catastrophic. Loses the "lazy synthesis" property — useful when an imported instrument is in the registry but never gets selected this session.

3. **Proxy with read-through** (picked). Zero changes to consumer call sites. `[key]` and `key in obj` work transparently. Lazy synthesis: imported entries are only built when first accessed, cached per-manifest-identity via WeakMap. Re-importing replaces the cache entry's identity, naturally invalidating the WeakMap entry.

Iteration was deliberately left out because the only iteration HKL does over instruments is the toolbar `<optgroup>` build, which reads `InstrumentRegistry.listImported()` directly — bypassing INSTRUMENTS. Static instruments are enumerated in the HTML, not in code. Adding an `ownKeys` trap with no consumer is unused complexity.

**Where**: `src/audio/samples-data.ts` — `STATIC_INSTRUMENTS` const, `manifestToInstrument`, `importedCache` (WeakMap), `INSTRUMENTS` Proxy export. `src/audio/samples-engine.ts:loadInstrument` branches on `instr.source === 'hki'`.

---

## HKL stores imported `.hki` bytes in IndexedDB, not File System Access (2026-05-25)

**Picked**: On import, HKL copies the `.hki` bytes into IndexedDB (two object stores: `manifests` keyed by `instrumentKey`, `audio` keyed by `${instrumentKey}/${sampleFile}` with a `byInstrument` index for cleanup). The original on-disk file is never referenced after import — the user can move or delete it. Bundles persist across sessions; the registry's manifest cache is warmed synchronously after `init()` resolves, and audio bytes are pulled on-demand at `loadInstrument` time.

**Why**: File System Access API would let the browser hold a persistent handle to the user's original `.hki` and re-read it on each session, avoiding the storage duplication. But:
- Max's primary browser is Firefox, which doesn't fully support FSA (the persistent-permission half is Chromium-only).
- FSA's "user grants access to a file" UX is friction-heavy: every reload prompts a permission re-grant for revoked handles.
- HKL bundles are 5-50 MB typical; modern browsers allow at least 1 GB of IndexedDB storage in normal profiles. Cost of duplication is real but small.
- "HKL remembers local file locations of hki bundles" (backlog wording) is satisfied by remembering the *bundle contents*, not the *file path*. The user experience is identical.

Considered "ask every session" (no persistence). Rejected: contradicts backlog wording and produces a friction loop where the user re-picks the same file every reload to play notes.

**Where**: `src/state/instrumentRegistry.ts` — `openDb`, `init`, `importBundle`, `removeBundle`, `getAudio`. Database name `hkl-instrument-registry`, version 1.

---

## Phase 1 (.hki format + CLI + import UI) shipped without Phase 2 (browser analyzer rewrite) (2026-05-25)

**Picked**: Phase 1 is the minimum that unblocks "host samples locally and produce an importable bundle." The Node CLI gains a `source: "local"` mode and a `--bundle` flag; HKL gains an import/manage UI. The browser analyzer (`analyzer/HexKeyLab-analyzer.html`) is untouched — it still iterates the existing CDN-config matrix.

**Why**: Phase 2 (focused single-instrument UI, in-browser OGG encoding, drag/drop local files, sample-engine preview playback inside the analyzer) is a separate workflow surface — most of the design lives in UI, not in shared modules. Bundling Phase 1+2 would have produced one large PR touching three apps (analyzer, HKL, eventually orchestrator), with the Phase 2 UI work blocking Phase 1's shipability for a feature Max needed to try MQ piano samples *now*.

The `.hki` format is intentionally producer-agnostic — Phase 2 will produce bytes via the same `writeHki` from `src/shared/hki.ts` that the Node CLI uses, and HKL won't care which produced any given bundle. The Phase 2 preview-playback path is also one line on top of the existing import flow: the analyzer hands the in-progress manifest+blobs straight to `loadInstrument` via the registry path, no new engine support needed.

If Phase 2 reveals a format change is warranted (e.g., per-velocity-layer audio for the orchestrator path described in backlog under ORCHESTRATOR), `HKI_MANIFEST_VERSION` bumps to 2 and `readHki` rejects v1 with a clear message. Both producer and consumer go through `validateManifest` so the migration is symmetric.

**Where**: Phase 1 added `src/shared/hki.ts`, `analyzer/bundle.js`, `src/state/instrumentRegistry.ts`, `src/ui/instrumentBundles.ts`; modified `analyzer/generate-samples.js`, `src/audio/samples-data.ts`, `src/audio/samples-engine.ts`, `src/ui/init.ts`, `vite.config.ts`, `index.html`, `package.json`. Phase 2 scope is in the backlog under ANALYZER.

---

## User-facing Analyzer UI (HKLA) shipped as third Vite multi-page entry (2026-05-26)

**Picked**: `/analyzer.html` is a new Vite multi-page sibling of `index.html` (HKL) and `composer.html` (HKLC), with its own module tree under `src/analyzer/`. Single-instrument focus per backlog L144 ("Streamline analyzer UI ... focus should be on one instrument at a time"). Reuses the existing browser-runnable engine in `analyzer/*.js` (analysis-analysis.js, k-weighting.js, analyzer-visualization.js, analyzer-instruments.js) unchanged. Outputs `.hki` for local-source instruments and a new round-trippable `<key>-config.json` for CDN-source instruments. The per-sample diagnostic chart (envelope, slope, segments, candidates) is the existing HKLViz module reused as-is — strict parity with the dev sidecar so we can retire it.

**Rejected**:
- Embed the analyzer UI in HKL itself (modal/side-panel). Couples analyzer code into HKL's bundle, defeats the future monorepo separation (backlog "HKLA" surface), crowds the toolbar.
- A different URL slug (e.g. `/hkla.html` or `/instruments.html`). Same-origin BroadcastChannel and IndexedDB work regardless of slug; `.html` parity with the other entries is enough.
- Single-channel multi-tenant bridge sharing the Composer protocol file (see next entry).

**Why**: The HKL ecosystem already has a same-origin sibling-app pattern (HKL ↔ HKLC), which works well with BroadcastChannel + IndexedDB. Adding HKLA as a third sibling fits the existing grain; the analyzer's `src/analyzer/` import constraints (no `src/audio/`, `src/midi/`, `src/state/`, `src/render/`, `src/lumatone/`, `src/composer/` — only `src/shared/`, `src/engine/`, `src/bridge/`, and the existing `analyzer/*.js` engine modules) keep the future monorepo split possible. Heavy analysis runs in a dedicated `pipeline-worker.ts` (Vite `?worker` import) so the UI stays responsive on 30+ second single-instrument runs.

**Where**: New `analyzer.html` at project root; new `src/analyzer/` tree (~20 modules); new `src/shared/cdnConfig.ts` for the CDN config format; new `src/engine/segmentLooper.ts` for the shared loop chain (see next entry). `vite.config.ts` gains a third `rollupOptions.input` entry.

---

## `src/engine/` as its own top-level dir for shared Web Audio code (2026-05-26)

**Picked**: A new `src/engine/` top-level directory hosts runtime audio code shared between HKL's main sample engine (`src/audio/samples-engine.ts`) and the Analyzer UI's audition. First inhabitant: `src/engine/segmentLooper.ts` (single-voice multi-segment crossfade chain). Modules under `src/engine/` may use Web Audio APIs and per-voice runtime state, but MUST NOT import `src/audio/`, `src/state/`, `src/midi/`, `src/render/`, or `src/composer/`. May import `src/shared/`.

**Rejected**:
- Put the source-chaining state machine in `src/shared/segments.ts` alongside `pickNextSeam`. Rejected: `src/shared/` is pure data per its rules ("no Web Audio, no DOM, no runtime state"). Mixing Web Audio in there would erode the boundary.
- Leave the duplication: HKL's `samples-engine.ts:scheduleSegmentSwitch` AND a new copy inside `src/analyzer/audition.ts`. Rejected: same algorithm, two source-of-truths — drift is inevitable.
- Make `src/audio/` shareable with the analyzer. Rejected: `src/audio/` is full of HKL-app state (voice tracking, MIDI velocity, range attenuation, INSTRUMENTS map) and the analyzer is supposed to be independent of HKL.

**Why**: The "segment-loop executor" is exactly the HKLE (Engine) surface described in `docs/backlog.md` ENGINE section ("audio handler, normalizer, segment-loop executor"). Putting it in its own directory now seeds the eventual extracted library — the analyzer is the first non-HKL consumer, but the orchestrator will be the second. The split also forces the boundary at design time: the looper takes `AudioContext` + `AudioBuffer` + segments and produces audio, with no awareness of voices, MIDI, or instruments.

The `pickNextSeam` algorithm is genuinely pure data (no Web Audio, no state) and lives in `src/shared/segments.ts`. The state machine that drives `AudioBufferSourceNode` lifecycles lives in `src/engine/segmentLooper.ts`. `samples-engine.ts` and `audition.ts` both call `pickNextSeam` from shared; audition uses `startSegmentLooper` from engine; samples-engine still owns its own scheduleSegmentSwitch because rate ramps + voice keys aren't yet factored out (future refactor, not Phase 2 scope).

**Where**: `src/shared/segments.ts` (new, pickNextSeam + findInitialSegIdx), `src/engine/segmentLooper.ts` (new, startSegmentLooper). Modified `src/audio/samples-engine.ts` (delegates segments branch of pickNextSeam to shared), `src/analyzer/audition.ts` (uses startSegmentLooper). CLAUDE.md documents the new `src/engine/` rules.

---

## Two BroadcastChannels for HKL ↔ {Composer, Analyzer}, not one multi-tenant channel (2026-05-26)

**Picked**: `'hkl-composer-bridge'` and `'hkl-analyzer-bridge'` are two physical BroadcastChannels with independent protocol modules (`src/bridge/protocol.ts` and `src/bridge/analyzer-protocol.ts`). Both reuse the same `BridgeChannel<In, Out>` generic class — the channel name is passed via constructor argument. HKL's `src/bridge/hkl-side.ts` instantiates both at module load; the dispatcher is a `bridge.on()` per channel rather than a single multi-tenant switch.

**Rejected**:
- One channel, one protocol union containing all message types from both clients. Rejected: HKL would have to filter messages by type-prefix to route them; analyzer messages and composer messages have nothing in common; future protocol changes to one client would risk breaking the other.
- Two channels but a shared protocol file. Rejected: same problem — type-union pollution across clients.

**Why**: BroadcastChannel is cheap (single-Map dispatch in modern browsers), so two channels cost nothing meaningful. Independent protocol files make message-type ownership explicit per client, and the `BridgeChannel<In, Out>` generic ensures TypeScript catches accidental cross-channel sends at compile time. The same pattern can extend to future clients (Orchestrator, Documentation) without further refactoring.

**Where**: `src/bridge/analyzer-protocol.ts` (new, defines AnalyzerEvent + HklAnalyzerEvent), `src/bridge/channel.ts` (parameterized BridgeChannel constructor, added `createAnalyzerHklBridge` + `createHklAnalyzerBridge` factories), `src/bridge/hkl-side.ts` (second `analyzerBridge` instance + parallel switch handler).

---

## `.hki` bridge transport inlines bytes through structured clone, NOT shared-IDB rendezvous (2026-05-26)

**Picked**: When the Analyzer's "Send to HKL" button fires a `.hki` import, the bundle's Uint8Array is inlined in the `import-hki { instrumentKey, bytes }` bridge message. HKL receives + calls `InstrumentRegistry.importBundle(bytes)` itself. CDN configs also inline (`import-cdn-config { instrumentKey, config }`).

**Rejected**: Have the Analyzer write directly to the shared `hkl-instrument-registry` IDB (via `InstrumentRegistry.importBundle()`), then send only a small bridge ping (`import-hki { instrumentKey }`); HKL calls `InstrumentRegistry.reload()` to refresh its in-tab cache. This was the original Phase 2 plan.

**Why the flip**: The IDB-rendezvous approach required `src/analyzer/` to import `src/state/instrumentRegistry.ts`. That violates the analyzer's import constraints in `CLAUDE.md` (Analyzer-side may NOT import `src/audio/`, `src/state/`, etc.). Two ways to resolve:
- Loosen the constraint to allow IDB-only registry modules. Rejected: erodes the boundary that the constraints exist to enforce.
- Inline the bytes through structured clone. ✓ Accepted: `.hki` bundles are 10–50 MB typical, structured-clone transfer cost is ~50 ms, dwarfed by the seconds the analyzer just spent doing analysis. The bridge stays stateless. The receiving tab uses the same code path as its own `+ .hki` file picker.

`InstrumentRegistry.reload()` is still added (10 lines) as a defensive primitive for future cross-tab nudge scenarios (e.g. one HKL tab importing while another HKL tab is open), but the analyzer bridge doesn't use it.

**Where**: `src/bridge/analyzer-protocol.ts` (`import-hki` carries `bytes: Uint8Array`), `src/analyzer/bridge.ts` (`sendHkiToHkl` serializes via `writeHki` and sends inline), `src/bridge/hkl-side.ts` (analyzer-side switch handler calls `InstrumentRegistry.importBundle(msg.bytes)` directly).

---

## CDN config registry parallels HKI registry, not unified `.hki` import (2026-05-26)

**Picked**: A new `src/state/cdnConfigRegistry.ts` (parallel to `instrumentRegistry.ts`) stores runtime-imported `CdnInstrumentConfig` objects. The INSTRUMENTS proxy in `samples-data.ts` gets a third fallback: static → HKI → CDN config. The waveform dropdown gains a second `<optgroup label="Imported (CDN config)">`. Import surfaces: `+ JSON` file picker (parity with `+ .hki`) inside the Import modal, plus the analyzer bridge.

**Rejected**:
- Convert CDN configs to `.hki` at import time. Rejected: forces the user to download large audio bundles for an instrument that already lives on a public CDN. The whole point of CDN configs is to skip the byte-storage cost; converting at import-time defeats it.
- Extend the `.hki` ZIP format to support a "CDN-only" manifest with no `samples/` directory. Rejected: `.hki` semantics ("instrument bundle, audio included") would become muddier; readHki would need a branch for the no-audio case; manifest validation would need to know which fields are required per source-type.
- Stuff CDN configs into `INSTRUMENTS_LOCAL` localStorage with no IDB. Rejected: localStorage is 5-10 MB cap per origin and synchronous; IDB is the right primitive.

**Why**: The CDN config is fundamentally a different artifact from `.hki` — it carries URLs + analyzer metadata only, no bytes. A parallel registry matches that asymmetry. The engine doesn't care: `configToInstrument` returns the same shape as a compile-time entry in `samples-data.ts`, so the engine's CDN-fetch path (line ~219 in samples-engine.ts) handles runtime-imported CDN configs unchanged. Zero engine changes — proven by Phase 2 shipping with `src/audio/samples-engine.ts` NOT in the modified-files list.

**Where**: `src/state/cdnConfigRegistry.ts` (new), `src/shared/cdnConfig.ts` (Phase 1, defines the type), `src/audio/samples-data.ts` (extended INSTRUMENTS proxy + `configToInstrument` synth + `cdnConfigCache` WeakMap), `src/ui/instrumentBundles.ts` (second `<optgroup>` + second manage-dialog section + `+ JSON` button), `src/ui/init.ts` (one new `init()` call).

---

## Phase 2 (analyzer bridge to HKL) shipped (2026-05-26)

**Picked**: Phase 2 is the bridge handoff from `/analyzer.html` to `/index.html` — Analyzer's "Send to HKL" button puts the new instrument in HKL's waveform dropdown without ever touching the filesystem. Both `.hki` and CDN-config payloads supported. Closes the Phase-1 → Phase-2 arc opened on 2026-05-25.

**Why**: Phase 1 shipped the analyzer UI + download flow; Phase 2 closes the loop. The bridge transport is described above ("`.hki` bridge transport inlines bytes..."), the registry is described above ("CDN config registry parallels HKI registry..."), the two-channel architecture is described above ("Two BroadcastChannels..."). All four entries together describe the Phase 2 surface.

The HKL toolbar button is renamed `Bundles…` → `Import`, with the two file-picker buttons (`+ .hki`, `+ JSON`) moved inside the modal. The "Import" verb is broader and accommodates the new CDN-config branch; the modal stays one-stop for any import action.

**Where**: NEW `src/bridge/analyzer-protocol.ts`, `src/state/cdnConfigRegistry.ts`. MODIFIED `src/bridge/channel.ts`, `src/bridge/hkl-side.ts`, `src/state/instrumentRegistry.ts` (added `reload()`), `src/audio/samples-data.ts` (INSTRUMENTS proxy), `src/ui/instrumentBundles.ts`, `src/ui/init.ts`, `src/analyzer/bridge.ts` (replaced Phase 1 stub), `src/analyzer/output.ts` (Send-to-HKL wiring), `index.html` (button rename + modal restructure), `analyzer.html` (Send button title). NO CHANGE to `src/audio/samples-engine.ts` — the engine handles runtime CDN configs through the same code path as compile-time entries.

---

## HEJI accidentals + arbitrary stacks in Composer (2026-05-26)

**Picked**: Render HEJI comma arrows / septimal hooks AND >±3 accidental stacks in HKL Composer by (1) emitting distinct placeholder `<accid>` siblings to make Verovio reserve horizontal space, then (2) post-processing the rendered SVG to swap every accidental's glyph for a BravuraText `<text>` at the true codepoint. Accidentals are uniformly Bravura; rests/clefs/noteheads stay Leipzig. `(q, r)` is the source of truth; the transform is render-only and never persisted.

**Rejected**:
- `<accid glyph.auth="smufl" glyph.num="U+E2D0"/>` (the book.verovio.org SMuFL path). Verovio 6.2.0 silently ignores `@glyph.num`/`@glyph.name` — empty group, zero width. Dead in the WASM build.
- Global `font: 'Bravura'` to align native accidentals with injected glyphs. It restyles the whole score; the Bravura rests read worse (Verovio's default is Leipzig). Chosen instead: inject ALL accidentals as BravuraText (plain ones at their own SMuFL codepoint), leaving everything else on Leipzig — "Bravura accidentals only."
- Verovio's native Gould quarter-tone arrow tokens (`su`/`sd`/U+E270 block) for the ±1 syntonic case. They render but in a different visual style from the Ellis HEJI glyphs HKL uses; mixing Gould (singles) and Ellis (doubles, hooks) within one score is inconsistent. Used only as width-reservation placeholders, then swapped.
- Persisting the HEJI/stack structure in the doc. Display is a pure function of `(q, r)` + tuning mode + the HEJI toggle, so it's recomputed at render; `.hkc` stays clean conventional MEI and the toggle re-renders instantly.

**Why**: Information-theoretic completeness — anything the lattice renders (arbitrary stacks, ±1 syntonic arrow on the first glyph, appended septimal hook) the score editor renders too; only the lattice's readability "collapse" (`#⁷` superscript) is dropped. The ±3 clamp was purely a Verovio-collision workaround, not a musical limit, so it's lifted at entry/transpose/retune/render. Multi-`<accid>` siblings collapse only for *same* tokens; *distinct* tokens space correctly — that one fact unlocks both the hook and the stacks.

**Where**: NEW `src/shared/heji.ts` (pure chain + comma math, shared with the lattice), `src/composer/notation/heji-render.ts` (transform + injection). MODIFIED `src/tuning/heji.ts` + `src/tuning/regions.ts` (slim to wrappers over shared), `src/composer/notation/accidentals.ts` (HEJI-aware carry-state + `noteAlter`), `src/composer/render/render.ts` (`accid@type`, call injection), `src/composer/model/index.ts` (`serialize({hejiEnabled})`), `src/composer/{input,notation/retune,notation/scTranspose}.ts` (clamp removed), `src/composer/expressions.ts` + `setupDialog.ts` + `composer.html` (toggle + `@font-face`), `src/composer/save.ts` (MusicXML alter via `noteAlter`). Spike findings + the four Verovio facts are in `docs/lessons.md`.

---

## Slurs in Composer: note-attached entry + legato playback (2026-05-26)

**Picked**: Slurs are entered in voice mode via a `Ctrl+L` pending-state toggle (first press marks the start slot, second closes; `Ctrl+L` anywhere under an existing slur's span deletes it; switching voices / Esc / undo exits the pending state). They are stored as note-attached MEI `<slur startid endid>` control events (a measure child, `data-voice` recording the voice), in a dedicated helper `src/composer/slurs.ts`. Verovio renders the arc natively. Playback marks each `PlaybackEvent` with `voice` + `slurredToNext`; HKL picks the realization from `instrReplaysOnTranspose()`: a **note-proportional release overlap (12%)** for decay + replay-on-transpose instruments, and a **single-voice pitch glide** ("transpose effect") for sustained loopers.

**Rejected**:
- **Time-based (`@tstamp`/`@tstamp2`) anchoring** like dynamics/hairpins. A slur's identity is its two endpoint notes; tstamp anchoring is for markings that must survive nearby-note deletion. This is the deliberate exception to the "prefer tstamp" rule (lessons.md / the expressions.ts header comment). Trade-off: a deleted endpoint dangles the slur, handled by `pruneDanglingSlurs`.
- **The older `(`-wraps-a-selection entry** described in a prior architecture.md draft. The backlog (Max's source of truth) specifies the `Ctrl+L` pending-state flow; that supersedes it. docs/architecture/composer.md (slurs) rewritten to match.
- **Deciding the legato mechanism Composer-side.** The instrument is HKL-side state, so Composer only ships slur *connectivity* (`voice`, `slurredToNext`) and HKL picks overlap-vs-glide from `instrReplaysOnTranspose()`.
- **Refactoring the live pitch-transpose path to share the glide primitive.** The new batched `glideVoices(pairs, rampMs)` in `audio/engine.ts` was extracted for playback, but `keyboard-notes.ts`'s sustained-transpose branch (ear-tuned, working) was left calling its own inline handoff to avoid destabilizing it. A future dedup could route it through `glideVoices`.
- **Per-event continuous-loudness shaping across a slur** and richer chord-slur handling — out of scope for v1. Chord-involved slur joins fall back to normal abutting playback.

**Why**: `pruneDanglingSlurs` is hooked into `normalizeTies` (the shared post-mutation pass) and `applyRetune`, so every structural edit that can orphan a slur also cleans it — no per-call-site discipline. Membership/ordering use flat-slot indices (`getCurrentElement`/`findElement`), which sidesteps meter/tick math. The glide is realized as a voice handoff (`computeLegatoPlan` sets `noOff` on the predecessor and `glideFromKey` on the successor; `dispatchChord` migrates `heldKeys`/`voiceSeq`/`selectedKeys`/`playbackOwnedKeys` old→new). **Slur audio (both overlap and glide) is verified by ear, not the headless harness — composer-test only validates the Composer-side `voice`/`slurredToNext` metadata + entry; HKL-side `playScore` isn't exercised there.**

**Where**: NEW `src/composer/slurs.ts`. MODIFIED `src/composer/input.ts` (pending state + `Ctrl+L` dispatch + voice/Esc/undo exits), `src/composer/model/ties.ts` (`pruneDanglingSlurs` in `normalizeTies`), `src/composer/notation/retune.ts` (prune after drops), `src/bridge/protocol.ts` (`PlaybackEvent.voice` + `slurredToNext`), `src/composer/render/playback.ts` (compute both), `src/audio/engine.ts` (`glideVoices` primitive), `src/bridge/hkl-side.ts` (`computeLegatoPlan` + overlap/glide realization in `dispatchChord`). Fixtures in `tools/composer-test/fixtures.mjs` (`slur_*`).

---

## Piano output: external-synth JI via per-channel RPN fine-tuning (2026-05-26)

**Picked**: A "Piano output" toolbar toggle (`src/midi/piano-out.ts`) mirrors HKL playback to an external MIDI synth at true JI, using **RPN 0001 channel fine-tuning** (±100¢/14-bit) with **one voice per MIDI channel** (full 1..16, steal-oldest). Validated first in the `tools/sp250-spike/` browser spike against a Korg SP-250. Hooked at `syncOutput()` via `syncPianoOut()`, tracking `selectedKeys ∪ sustainedKeys`, gated on its own `pianoOutputEnabled` flag (independent of `audioEnabled`). Output port auto-matches the selected Piano *input* device by name.

**Rejected**:
- **Pitch bend / MPE** (as `src/midi-io/export.ts` uses for `.mid`). The target class of synths (SP-250 and similar consumer digital pianos) **does not receive pitch bend or MPE** — confirmed by spike. RPN 0001 fine-tune is the only tuning channel they honour.
- **Single-channel sequential retune.** Initially assumed the synth froze pitch per-voice at onset (the spike's sustain test suggested so). The chord player disproved it: a **note-on re-applies the channel's current fine-tune to every sounding voice on that channel**, so a single channel can hold only one tuning at a time. Hence one-voice-per-channel. Both the sustain-test result and the chord behavior are consistent under "bare retune doesn't move held notes, but a note-on does re-tune all of the channel's voices."
- **Hooking inside `engine.noteOn/noteOff`** (where the recording capture taps). Those are short-circuited when Audio is muted (`syncAudio` → `stopAllNotes` at `audioEnabled` false), which would force internal audio on and double the sound. Hooking at `syncOutput`/`syncPianoOut` keeps the external synth usable as the *sole* source.
- **Forwarding CC64 sustain.** Unnecessary — HKL already defers `engine.noteOff` until pedal release (released-under-pedal keys live in `sustainedKeys`), so note-off *timing* carries sustain to the synth for free.
- **Forwarding aftertouch.** SP-250 doesn't receive it.
- **A separate output-device dropdown.** Auto-match by input-device name (Max's call) — the SP-250's in/out ports share a name; exact-match then colon-prefix fallback.

**Why**: `MpeAllocator` already implemented the exact steal-oldest LRU needed, so it was generalized with an optional `(min,max)` channel range (default 2..16 preserves MPE export) rather than duplicated. The whole feature is additive and off by default (`pianoOutputEnabled: false`); existing users see no change. **Verified by typecheck + build only — the actual SP-250 audio/tuning behavior needs Max's hardware (no device in-session).** Requires the synth set to Omni On / multi-timbral; partial chords = wrong receive mode, not an allocator bug.

**Where**: NEW `src/midi/piano-out.ts`. MODIFIED `src/midi-io/allocator.ts` (configurable channel range), `src/midi/engine.ts` (`syncOutput` calls `syncPianoOut`), `src/state/midi.ts` (`pianoOut`), `src/state/persistence.ts` (`pianoOutputEnabled`), `index.html` (`cbPianoOutput`), `src/ui/init.ts` (`initPianoOut`), `src/midi/piano.ts` (`rebindPianoOut` on input-device change). Spike: `tools/sp250-spike/`.

---

## Velocity: canonical "musical velocity" domain, device curves at input (2026-05-26)

**Picked**: `audio.keyVelocity` now holds a **canonical musical velocity (0–127)**, normalized across input devices. Device-specific shaping moved to *input* (Lumatone: per-key gain + a decompression input curve; piano/SP-250: identity; QWERTY/Composer: re-mapped `DEFAULT_DYNAMIC_MAP`), and a single gentle device-independent **house curve** (`velocityCal.curveGain`, floor 0.05 / ceiling 1.0 / γ 1.5) maps musical velocity → audio gain at playback. `piano-out` sends `keyVelocity` unchanged so external synths round-trip. Lumadiag's curve sliders re-bind to the Lumatone input (decompression) curve. See docs/architecture/engine.md.

**Rejected**:
- **Status quo (Lumatone-domain keyVelocity).** The old design folded the Lumatone's velocity decompression into a steep γ≈15.5 audio gain curve and normalized every source into that domain — piano input pre-inverted it (`normalizePianoVelocity`). Fine when the Lumatone was the only physical instrument whose velocity mattered, but it (a) broke the SP-250 round-trip via `piano-out` (the SP-250 re-applied its own curve on top → compressed) and (b) squashed QWERTY/Composer.
- **Re-derive piano velocity at piano-out (`pianoFeel⁻¹(audioCurve(keyVelocity))`).** Only valid for piano-input notes and piano-out can't tell sources apart — would corrupt other sources. (This was option B in the planning.)
- **Exact-preserve the Lumatone feel** via a fixed derived curve. Rejected by Max — he chose tunable sliders + re-tune by ear (the decompression isn't a clean power law, so exact-preserve would sacrifice tunability).
- **`.hkr` migration.** Rejected by Max — pre-refactor recordings replay with shifted dynamics; no v2 schema.

**Why**: separating *decompression* (per-device, input) from *velocity→gain* (gentle, shared) is what makes velocity portable: a soft hit is a low number on every device, and that number means the same thing to HKL's audio and to an external synth. `DEFAULT_DYNAMIC_MAP` was re-mapped down (`v_new = houseCurve⁻¹(steepCurve(v_old))`, e.g. f 120→74, ppp 96→21) so non-Lumatone **loudness is preserved, not amplified** — Max flagged that QWERTY/mouse/Composer were already pre-corrected for the steep curve and must be uncorrected in lockstep. `velocityCal` prefs versioned (v2) with a one-time migration (old audio γ → input-curve seed, house curve reset gentle). Aftertouch and Composer hairpin constants now live in the musical domain and are flagged for by-ear tuning rather than guessed transforms. **Verified by typecheck + build only — velocity feel is by-ear and Max's to confirm/re-tune (Lumatone decompression especially).**

**Where**: `src/audio/velocityCal.ts` (gentle house curve default, decompression input-curve default, v1→v2 migration), DELETED `src/audio/pianoVel.ts` (`normalizePianoVelocity`/`pianoGainCurve`), `src/midi/piano.ts` (identity), `src/midi/handler.ts` (per-key gain + decompression at input), `src/audio/engine.ts` (dropped per-key prepass + aftertouch strike prepass), `src/shared/dynamics.ts` (re-mapped `DEFAULT_DYNAMIC_MAP`), `src/lumatone/lumadiag.ts` (sliders → input curve, composite preview), `src/state/persistence.ts` (velocityCal `version`, dropped `pianoGainCurve`), `src/composer/render/playback.ts` (hairpin delta), `src/audio/aftertouch.ts` (domain note).

---

## Sample engine: injected host dependencies (Phase 1 of the monorepo split, 2026-05-26)

**Picked**: `src/audio/samples-engine.ts` no longer imports HKL app state directly. Its three former couplings are now host-injected via an optional `SampleEngineConfig` passed to `init(ctx, dest, config?)`:
- `instrumentProvider(key) => Promise<Record<file, bytes> | null>` replaces the direct `state/instrumentRegistry.getAudio` call (the `source:'hki'` load path).
- `velocityToGain(v) => gain` replaces the `aftertouch.velocityBaseVol` import (which transitively pulled `state/audio` + `velocityCal`). Defaults to a bare `v/127` so the engine is usable with no host curve.
- `onSeamEvent(ev)` replaces the `diagnostics/loopOverlay.recordSeamEvent` import.

HKL re-supplies all three at `engine.ts:initAudio` so runtime behavior is identical. The pure `inflightExpRampValue` (PA-ramp polyfill) moved out of `aftertouch.ts` into the engine and is re-exported from the `samples.ts` barrel; `loopOverlay`'s `SeamEvent` now `extends` the engine's emitted type rather than duplicating it.

**Rejected**:
- **Moving the instrument manifest (`INSTRUMENTS`) injection too.** `samples-engine` still imports `samples-data` (→ `INSTRUMENTS`), which reaches into the registry for imported-instrument manifests. That's a larger "manifest injection" refactor deferred to the package-extraction phase — Phase 1 was scoped to the three named state couplings to keep the audio-path change small and by-ear-verifiable.
- **A workspace tool first.** Nx and even pnpm workspaces fix nothing about this coupling; the DI is the actual blocker to an importable `@hkl/engine` and is repo-shape-independent, so it lands in the current single-package repo where the test loop is simplest.

**Why**: this is the first concrete step of the approved pnpm-monorepo plan (`@hkl/engine` = HKLE, importable outside HKL). The seam is deliberately a config object on `init` rather than module-level setters so a standalone consumer wires everything in one call and the engine has no implicit global host. **Verified by typecheck + build only — the DI sits in the audio path, so loop crossfades / aftertouch swells / transpose-glide / imported-`.hki` playback are Max's by-ear gate before commit.**

**Where**: `src/audio/samples-engine.ts` (`SampleEngineConfig` + `PaRampState`/`SeamEvent` types, injected module vars, relocated `inflightExpRampValue`, `init` config arg), `src/audio/samples.ts` (re-export `inflightExpRampValue` + config types), `src/audio/engine.ts` (wires the three deps at `initAudio`, imports `inflightExpRampValue` from the barrel), `src/audio/aftertouch.ts` (dropped `inflightExpRampValue`), `src/audio/diagnostics/loopOverlay.ts` (`SeamEvent` extends the engine's emitted type). Plan: `~/.claude/plans/i-d-like-to-do-temporal-thimble.md`.

---

## pnpm workspace + first library packages (Phase 2–3 of the monorepo split, 2026-05-27)

**Picked**: Migrated to a **pnpm workspace** and carved four pure library packages out of `src/`: `@hkl/shared` (was `src/shared/*` + the pure `tuning/notes.ts`), `@hkl/engine` (was `src/engine/segmentLooper.ts`), `@hkl/notation` (was `src/notation/*`), `@hkl/bridge` (was `src/bridge/{protocol,analyzer-protocol,channel}.ts`). The dependency DAG is `@hkl/shared ← {engine, notation, bridge}`; the root package consumes all four via `workspace:*`. Conventions:
- **Subpath exports point at `.ts` source**, with a `.js`→`.ts` pattern: `"exports": { "./*.js": "./src/*.ts" }`. This keeps the codebase's existing NodeNext-style `.js` import specifiers a **pure prefix swap** (`'../shared/freq.js'` → `'@hkl/shared/freq.js'`) — no extension churn, no build step for internal consumption. Vite and `moduleResolution: bundler` both follow the pattern straight to source.
- **Intra-package imports stay relative** (`./verovio-types.js`); only **cross-package** imports use the bare `@hkl/*` specifier. The import-rewrite was per-resolved-path, not blanket sed, because `../notation/` and `../bridge/` are **ambiguous** — `src/composer/notation/*` and `src/bridge/hkl-side.ts` are app code that must NOT be rewritten (see below).
- **`packageManager: pnpm@11.3.0`** pinned; `package-lock.json` removed.

**Rejected**:
- **A single barrel per package** (`@hkl/shared` re-exporting everything). Subpath exports preserve granular imports + tree-shaking and made the migration mechanical.
- **Moving `src/bridge/hkl-side.ts` and `src/composer/notation/*` into their packages.** `hkl-side.ts` imports `state/audio/render/midi` — it's HKL-app glue, so only the pure protocol/channel/types became `@hkl/bridge`; `hkl-side.ts` stays in `src/` (→ `apps/hkl` later). Likewise `src/composer/notation/*` (accidentals/beams/retune/scTranspose) is composer-app code, distinct from the shared `@hkl/notation` lib that shares the `notation/` basename.
- **TS project references, for now.** Boundaries currently rest on pnpm's per-package dep lists (a package only resolves what it declares). Composite tsconfigs + root references (for `tsc -b` enforcement) are deferred to land with the per-app tsconfigs in Phase 4 (task #7).
- **Moving `transcription/pitch.ts` into `@hkl/shared`.** It imports `render/colors.js` (not pure), so it can't join shared until decoupled — deferred to the composer split.

**Why / gotchas**:
- **`allowBuilds` in `pnpm-workspace.yaml` is load-bearing.** pnpm 11 blocks dependency install-scripts by default and *writes a placeholder `allowBuilds:` block with non-boolean values, then exits non-zero*. Because pnpm runs a pre-script deps-status-check (itself an `install`), that non-zero exit made **every `pnpm <script>` fail** until the block was filled: `allowBuilds: { esbuild: true, core-js: false }`. esbuild's postinstall places Vite's native binary; core-js's is only a donation banner.
- `analyzer/bundle.js` (a Node CLI outside module resolution) imports the `.hki` writer by **relative path**, updated to `../packages/shared/src/hki.ts` rather than the bare specifier.
- Verified each package incrementally with `pnpm typecheck` + `pnpm build` + dev-server smoke (all three entry points + each `@hkl/*` specifier serve 200). `git mv` preserved rename history.

**Where**: NEW `pnpm-workspace.yaml`, `packages/{shared,engine,notation,bridge}/package.json`. `package.json` (`packageManager`, four `@hkl/* workspace:*` deps). MOVED the files listed above into `packages/*/src/`. Import rewrites across ~50 `src/` files (relative → `@hkl/*`). Plan: `~/.claude/plans/i-d-like-to-do-temporal-thimble.md`.

---

## Per-app split + same-origin dev proxy (Phase 4 of the monorepo split, 2026-05-27)

**Picked**: `src/` is gone; the three apps now live as workspace packages `apps/{hkl,composer,analyzer}`, each with its own `index.html`, `vite.config.ts`, `package.json` (isolated deps), and `src/`. The repo root holds no app code — `package.json` is a pure workspace root (`dev` → the proxy, `build` → `pnpm -r build`), and one root `tsconfig.json` with `include: ["apps","packages"]` typechecks the whole tree in a single `tsc --noEmit`. Per-app dev servers (hkl :5173, composer :5174, analyzer :5175) each get scoped HMR; **`vite/dev-proxy.mjs` reverse-proxies all three under ONE origin `http://localhost:5170`** (`pnpm dev` spawns the three + the proxy). Routing: `/composer/*`→5174, `/analyzer/*`→5175, else→5173; each app sets `base` to its sub-path and `server.hmr.clientPort: 5170` so HMR websockets dial the proxy and ride the same prefixes.

**Why the proxy is non-negotiable**: the HKL↔Composer bridge is `BroadcastChannel` and the instrument registry is `IndexedDB` — **both are per-origin**. Separate dev-server ports are separate origins, which would break held-chord entry and the shared registry in dev. The proxy collapses them to one origin while keeping per-package HMR. (Max's call: he wanted separate servers for scoped reload + one spin-up script, with the proxy bridging — over option A's single multi-page server.) Production already serves the apps co-located (same origin), so this matches deploy. The dev-only `/iowa-mis*` + `/analyzer-configs-manifest` endpoints are mounted on the **proxy** (origin level, via `vite/middleware.mjs`), so any app's absolute `fetch` reaches them regardless of `base`; standalone `pnpm --filter @hkl/<app> dev` works for pure UI work but lacks those endpoints + the cross-app bridge.

**Rejected**:
- **Single multi-page root vite config** (option A): simpler + same-origin for free, but no per-package scoped HMR and not "self-contained servable apps."
- **Per-app servers with no proxy** (different origins): breaks the bridge + registry in dev.
- **TS project references**: still deferred (task #7). One root tsconfig with `include` globs keeps typecheck whole and green without per-package composite builds; pnpm dep lists already isolate packages at resolution/build time (composer's `node_modules` only has its declared deps — verified).
- **Per-app middleware copies**: the dev endpoints live once, on the proxy.

**Enabling refactor**: composer's last HKL-core edge (`scTranspose → transcription/pitch.coordToMidi`) was removed by deduping the redundant `coordToMidi` (canonical pure copy already in `@hkl/shared/freq.js`); `darkColorHex`/`coordToLilyPitch` stay in `transcription/pitch.ts` (HKL-side, stateful via `render/colors`). After that, composer reaches nothing outside its own subtree + `@hkl/*`.

**Gotchas**: `public/` stays at repo root; each app points `publicDir` at `../../public` (shared favicon + Bravura font + shipped `.hki`s). Analyzer's imports into the root `analyzer/*.js` CLI engine gained one `../` level. `tools/composer-test` repointed to `http://localhost:5170/composer/` and the in-fixture dynamic `import('/src/composer/save.ts')` → `/composer/src/save.ts` (base-prefixed). 3 HEJI visual baselines were re-seeded — they predated a recent accidental-position fix and had never been re-run (a skipped plan step), NOT a split regression. Suite: 129/129 full.

**Where**: NEW `apps/{hkl,composer,analyzer}/{index.html,vite.config.ts,package.json}`, `vite/dev-proxy.mjs`, `vite/middleware.mjs`. MOVED `src/*` → `apps/hkl/src` (HKL-core), `src/composer` → `apps/composer/src`, `src/analyzer` → `apps/analyzer/src`; root `*.html` → `apps/*/index.html`. DELETED root `vite.config.ts`. `package.json` (workspace root), `tsconfig.json` (`include`), `tools/composer-test/{run,fixtures}.mjs`. Re-seeded `tools/composer-test/baselines/heji_*.png`.

---

## Sample playback engine fully moved into @hkl/engine via manifest injection (Phase 6, 2026-05-27)

**Picked**: `samples-engine.ts` (the voice lifecycle + loop-scheduling engine, ~1130 lines) moved out of the HKL app into **`packages/engine/src/`** alongside `segmentLooper.ts`. Its last app coupling — importing the global `INSTRUMENTS` Proxy from `samples-data.ts` (which pulls `state/instrumentRegistry` + `state/cdnConfigRegistry`) — is gone. Instead the **instrument definition is injected per-load**: `loadInstrument(key, instrDef, onProgress?)` caches `loadedInstruments[key] = instrDef`, and the three internal `INSTRUMENTS[currentInstrument]` lookups (sNoteOn / sNoteOff / sNoteOnFaded) read the cache. `@hkl/engine` now imports **only `@hkl/shared`** (dynamics, hki, segments). The HKL-side barrel `apps/hkl/src/audio/samples.ts` preserves the legacy `SampleEngine.loadInstrument(key, onProgress)` signature by wrapping: `(key, onProgress) => engine.loadInstrument(key, INSTRUMENTS[key], onProgress)` — so every HKL caller is unchanged and the shipped/imported-bundle Proxy stays an HKL concern.

Combined with the Phase 1 DI (instrument-audio provider, velocity→gain curve, seam-event sink), `@hkl/engine` is now a self-contained library: it takes instrument defs + a `.hki`/audio provider + a velocity curve from its host and owns nothing of HKL's state, MIDI, render, or UI.

**Proof (Phase 6 acceptance)**: NEW workspace `examples/engine-smoke/` (added `examples/*` to `pnpm-workspace.yaml`) depends only on `@hkl/engine`, imports `samples-engine.js`, asserts the full public API, and runs `init()` against a stub AudioContext with injected host deps — `pnpm --filter @hkl/engine-smoke start` passes in plain Node (Node 25 strips types and resolves the `.ts` engine + shared deps through the `exports` map). Real `.hki` audio playback still needs a browser AudioContext + `decodeAudioData` (the browser sandbox / Max's by-ear test), not this headless check.

**Rejected**: a `getInstrument(key)` provider injected via `init` config (like the audio provider) — load-time def injection is simpler and the engine already caches per-key, so there's no need for a global lookup callback.

**Why / verification**: behavior is identical — the barrel feeds the same `INSTRUMENTS[key]` value the engine used to look up itself, and `loadedInstruments[currentInstrument]` resolves to the same cached def. typecheck + `pnpm -r build` + composer 129/129 green; hkl app serves the relocated engine via the dev umbrella. **But this is audio-path code — loop crossfades / aftertouch / transpose-glide / imported-`.hki` playback are Max's by-ear gate before relying on it** (same posture as the Phase 1 DI).

**Where**: MOVED `apps/hkl/src/audio/samples-engine.ts` → `packages/engine/src/samples-engine.ts` (dropped the `INSTRUMENTS` import, added `loadedInstruments` cache + `instrDef` param). `apps/hkl/src/audio/samples.ts` (barrel: imports from `@hkl/engine`, injects `INSTRUMENTS[key]`). NEW `examples/engine-smoke/`, `pnpm-workspace.yaml` (`examples/*`).

---

## Boundary enforcement via a DAG-checker, not TS project references (2026-05-27)

**Picked**: `tools/check-boundaries.mjs` (run by `pnpm check:boundaries`) — a dependency-free scanner that enforces the monorepo DAG with two rules per `packages/*` + `apps/*` project: (1) every bare `@hkl/<pkg>` import must be a declared dependency in that project's `package.json` (so the package.json dep list *is* the allow-list — `@hkl/shared` may import no `@hkl/*`, composer may not import `@hkl/engine`, an app may not import a sibling app); (2) relative imports may not escape the project dir (cross-package reaches must use a bare `@hkl/*` specifier). One documented exception: `apps/analyzer` may relatively import the repo-root `analyzer/*.js` CLI engine modules. Self-tested (injected an illegal `@hkl/engine` import + a relative escape → both caught, exit 1).

**Rejected**:
- **Full composite TS project references** (the original plan's task #7). Composite projects require `.d.ts` emit, which fights the deliberate "subpath exports point at `.ts` source" choice (the thing that made every import rewrite a clean prefix-swap) — I'd have to emit declarations to a types dir + add a `types` export condition, and switch `pnpm typecheck` to `tsc -b` build mode. Heavy machinery for marginal gain, because…
- **…pnpm already enforces the DAG at resolution time**: each package's `node_modules` holds only its declared deps, so an illegal cross-import fails to resolve in vite/build regardless. The checker adds a fast, explicit, CI-friendly assertion of the *intended* graph (catches a stray import before it even reaches a build) without disturbing the exports setup.

**Where**: NEW `tools/check-boundaries.mjs`; `package.json` (`check:boundaries` script).

---

## Repo cleanup: analyzer domain into apps/analyzer, `test/` folder, dead-code prune (2026-05-27)

**Picked**: Three top-level reorganizations after the monorepo split.
- **Root `analyzer/` dissolved into `apps/analyzer/`.** It had tangled (a) shared analysis engine
  modules imported at runtime by the analyzer UI *and* the CLI, (b) the Node batch CLI, (c) dead
  files. Now: `apps/analyzer/analysis/` (the `.js` engine modules — `analyzer-analysis`,
  `analyzer-instruments`, `analyzer-visualization`, `k-weighting`), `apps/analyzer/cli/` (the batch
  pipeline — `generate-samples`/`insert-instrument`/`bundle`/`backfill-*`), `apps/analyzer/configs/`
  (instrument source-of-truth). The CLI "runs through" the analyzer package (imports its in-package
  `analysis/` + `@hkl/shared`) — **no separate `packages/analysis`** (Max's call: don't scope the
  shared modules beyond the analyzer package that owns them). This also dropped the
  `apps/analyzer → root analyzer/` relative-escape exception in the boundary checker.
- **New top-level `test/`** holds all verification tooling: `composer-test`, `composer-inspect`,
  `bounds-probe`, `interval-names`, `engine-smoke` (moved from `examples/`), `heji-check.mjs`,
  `check-boundaries.mjs`. (Max: a future suite will run `bounds-probe` to check the committed
  bounds tables, and `interval-names` is a future-test utility, so both are test scope.) `tools/`
  is left with hardware/ops only (`lumatone-cal/`, `reset-calibration.sh`).
- **Deleted**: `HexKeyLab-analyzer.html` (old standalone sidecar), `analyzer-output.js` (only the
  HTML used it), `didgeridoo.js` (its only consumer of the HTML), and the finished spikes
  `verovio-spike/` + `sp250-spike/` (git history + the decisions.md entries preserve them).

**Why / found along the way**: the analyzer CLI, `bounds-probe`, and `interval-names` had all gone
stale during the app split (they sit outside typecheck/build): the CLI wrote
`REPO/src/audio/samples-data.ts` (now `apps/hkl/src/...`); `interval-names` imported
`../../src/tuning/*` incl. `notes.ts` (which had moved to `@hkl/shared`). The cleanup doubles as
fixing them. `bounds-probe` turned out NOT broken — its `'../state/persistence.js'` is part of the
*generated* `refbounds-table.ts` output string (valid from `apps/hkl/src/render/`), and the scripts
replicate the picker/geometry math inline, so they're self-contained. The boundary checker caught
`bundle.js` reaching into `packages/shared` by relative path → switched to the bare `@hkl/shared/hki.js`.
`interval-names` is a manual `npx tsx` utility (the app's `.js`-specifier imports only resolve under
tsx/vite bundler resolution, not plain `node`) — paths fixed, runner unchanged.

**Where**: MOVED `analyzer/{analyzer-*,k-weighting}.js` → `apps/analyzer/analysis/`;
`analyzer/{generate-samples,insert-instrument,bundle,backfill-*}.js` → `apps/analyzer/cli/`;
`analyzer/configs` + `README.md` → `apps/analyzer/`; `.cache`/`out` preserved (mv).
`tools/{composer-test,composer-inspect,bounds-probe,interval-names}` + `{heji-check,check-boundaries}.mjs`
+ `examples/engine-smoke` → `test/`. REWIRED: app analysis imports (`../../../analyzer` → `../analysis`),
CLI path constants (samples-data → `apps/hkl/src/...`, `.cache`/`out`/`configs`/analysis depth, `REPO`),
`interval-names` imports, `package.json` scripts (`test/...` + `analyze` → `apps/analyzer/cli/`),
`vite/dev-proxy.mjs` (configs path), `.gitignore` (`apps/analyzer/{.cache,out}`),
`pnpm-workspace.yaml` (`examples/*` → `test/*`), `check-boundaries.mjs` (dropped analyzer exception).
DELETED the 3 dead analyzer files + 2 spikes.

---

## Transcription emits `.hkc` (Composer-native), not `.ly`; shared MEI builder in `@hkl/notation` (2026-05-27)

The `.hkr` → sheet-music pipeline predated Composer and emitted LilyPond `.ly` — a dead-end
artifact that couldn't be reopened or edited and duplicated spelling/color logic Composer already
owns. Replaced the `lyEmit.ts` stage with `meiEmit.ts`, which produces a Composer-native `.hkc`
(MEI 5) document. Two transports from the "Export to Composer" dialog: **Download `.hkc`** (always
available) and **Send to Composer** (a new one-directional `import-score` `HklEvent` over the
existing bridge; Composer confirms-if-dirty then `replaceDocument` + adopts `layoutReq`).

**MEI construction is now a single source of truth.** Extracted Composer's MEI skeleton +
note/chord/rest builders out of `apps/composer/src/model/` into **`@hkl/notation/mei-build.ts`**
(`el`/`newId`/`escapeXml`, `Duration`/`Dots`, `NoteSpec`, `buildNoteElement`/`buildChordElement`/
`buildRestElement`, `buildScoreSkeletonXml`/`emptyMeiDoc`). Composer re-exports them so its many
`import { el, newId, MEI_NS, Duration } from './index.js'` sites stayed zero-touch; HKL's emitter
imports the same builders. **Decision that made this clean**: the shared builders take a structural
`NoteSpec` (`{q,r,pname,accid,oct,midi,colorHex}`), NOT the bridge's `ResolvedNote` — `@hkl/notation`
and `@hkl/bridge` are siblings under `@hkl/shared`, so a bridge import would break
`check:boundaries`. `ResolvedNote` is structurally assignable to `NoteSpec`, so Composer call sites
pass it unchanged.

**Tie correctness**: the `ComposerModel` *constructor* runs `normalizePlaceholders` but NOT
`normalizeTies`; however the real load path (`main.ts` file-open, and the new `import-score`
handler) routes through `replaceDocument`, which does. So the emitter only needs to bake correct
`@tie i/m/t` tokens (per-atom within a QNote, and across bar lines where `quantize` marks the prior
QNote's trailing atom tied); `data-tie-partner` is recomputed on load. `QNote` gained a
`coords: {q,r}[]` field (replacing the LilyPond-only `lyPitches`) so the emitter spells from the
exact lattice cell, not a MIDI-only guess (distinct `(q,r)` can collide to one MIDI).

**Removed**: `lyEmit.ts`, `coordToLilyPitch`/`darkColorScheme` from `pitch.ts` (`darkColorHex` stays
— it has live importers in `tuning/spell.ts`, `bridge/hkl-side.ts`, `transcription/onsets.ts`),
`TranscribeResult.ly` → `.hkc`, `sessionToLilypond` → `sessionToHkc`.

**Verified**: `pnpm typecheck` + `pnpm -r build` + `pnpm check:boundaries` + `pnpm test:composer`
(129/129, proves the builder extraction didn't regress Composer) + a new
`pnpm test:transcription` (`test/transcription-roundtrip/run.mjs`) two-page headless round-trip:
emit on the HKL page → load on the Composer page → assert measures/coords/no-tie-orphans/
placeholder-invariant/origin-spelling/serialize-stability. Visually confirmed the engraved
grand staff (colored noteheads, cross-bar tie arc, accidentals) renders in Composer.

## Cross-staff slurs work natively in Verovio (2026-05-28)

**Spike resolved.** A `<slur @startid @endid>` with endpoints on different staves (e.g. V1 in
treble + V3 in bass) renders cleanly: one continuous `g.slur` arc curving between staves, no
collision with the brace, no layout collapse. Verified by hand-crafted MEI fragment (screenshot:
`test/composer-test/out/cross_staff_slur_spike.png` from the Phase 1 spike).

**Code-side implication**: `apps/composer/src/slurs.ts` is already xml:id-based and the model's
`findElement(meiId)` resolves IDs to (voice, index) across all four voices, so no slur-CRUD change
is needed. The only thing currently preventing cross-staff entry is the `Ctrl+L` close handler in
`input.ts`, which checks `startLoc.voice !== voice` and bails. Lifting that check (or relaxing it
to "same staff group OR cross-staff explicit confirm") would enable user entry.

**`data-voice` semantics for cross-staff slurs**: keep `@data-voice` = the START voice. The
playback `slurredToNext` flag is per-voice (each voice walks its own attack stream), so a
cross-staff slur primarily marks the start voice. Cross-staff legato playback (gliding the
voice handoff across staves) is out of scope for v1.

## Phase 3 Composer: repeats, 8va, trills/tremolos, breaks, section headers (2026-05-30)

Non-obvious choices made implementing Composer roadmap Phase 3. Full as-built notes in
`docs/composer-roadmap.md` §9; the decisions worth remembering:

**Repeat playback composes by re-stamping, not re-walking.** `buildPlayback` keeps its
original single linear walk to produce *canonical* events tagged with their measure index
(`_mi`), then — only when `hasRepeatStructure(mei)` — replays `expandPlayOrder()` and
re-stamps each event's `atMs` by accumulating per-measure ms over the *played* order. Every
other lookup (velocity, tempo rate, octave shift) stays keyed on the note's ORIGINAL tick, so
a replayed note reuses its original-tick dynamics. No-repeat docs hit the untouched linear
path verbatim (keeps the heavily-tested fast path byte-stable). Repeat expansion is
**start-aware**: a backward repeat is honored only if its rptstart was seen at/after the seek
measure — seeking *into* a repeated body plays it through once. Capped at 2 passes (no nested
repeats v1).

**Verovio `<octave>` needs `@startid`/`@endid`, and warns if `@tstamp` coexists.** An octave
with only `@tstamp`/`@tstamp2` renders an EMPTY `g.octave` (no bracket); adding the note
anchors fixes it but Verovio then warns "has both @startid and @tstamp" (the suite fails on
console warnings). Resolution: octave carries note anchors for rendering and the playback
tick-span on Verovio-ignored `data-hkl-t0`/`data-hkl-t1` (same convention as tempo's
`data-hkl-*`). 8va pitch shift is `q ± 3` per octave (band structure: +3 q = exactly 2:1).

**Verovio `breaks` is global, not mixable.** `'auto'` ignores encoded `<pb>`/`<sb>`;
`'encoded'`/`'line'` honor them but disable auto-wrapping. There is no "honor my one break AND
auto-wrap the rest." So page break (Ctrl+B) and section headers (which force an `<sb>`) switch
page view to `breaks:'encoded'` only when the doc actually contains a manual break — once it
does, the user owns all breaks. Accepted v1 tradeoff.

**Section headers are custom post-render injection** (`main.ts:injectSectionHeaders`). Verovio
has no native centered, space-reserving mid-score movement title (only the page-top pgHead
centers; a `<section>` label doesn't render). So we translate the section's rendered
`g.system` (and every later system in the page) DOWN by a fixed reserve, grow the page
viewBox/height, and inject a page-centered `<text>` in the freed band. The model side
(`setSectionHeaderAt`) tags the measure, forces an `<sb>`, sets the prior measure's final
barline, and `renumberMeasures` is now section-aware (restarts at each `data-hkl-section-title`).

**Selection-mode actions must opt out of the exit-to-movable catch-all.** `dispatchSelectionMode`
exits the beat selection on any non-selection key before the main handler runs. `Ctrl+8` /
`Ctrl+T` operate ON the live selection, so they're whitelisted to fall through WITHOUT exiting
(their handlers read the selection, mutate, then exit themselves). Without this they silently
ran their voice-mode branch on the post-exit cursor.

## Composer breaks: smart+breaksSmartSb:0 for sections, two-pass bake for page breaks (2026-05-30)

Refines the Phase 3 note above ("Verovio breaks is global"). The "once any manual break
exists, no auto-wrap" tradeoff was unacceptable — a section header or page break made all
following material cram onto one line regardless of measure count. Resolution (render.ts):

- **Section/system breaks only** (`<sb>`, no `<pb>`): render with `breaks:'smart'` +
  `breaksSmartSb:0`. `breaksSmartSb` is the threshold below which 'smart' DROPS an encoded
  `<sb>` (to avoid tiny systems) — at the default ~0.66 it silently ignored our section break
  (a 1-measure system). Setting it to **0** forces 'smart' to honor EVERY encoded `<sb>`
  while still auto-wrapping overflow. This is the single-pass path for section headers.
- **Page breaks** (`<pb>`): 'smart' ignores `<pb>` (it calculates pages), so page breaks
  still require `breaks:'encoded'` — which alone won't wrap. So `layoutBreaks()` does a
  **two-pass**: pass 1 renders with smart+breaksSmartSb:0 to get the ideal system layout,
  reads which measure starts each rendered system, bakes an `<sb>` before each into the MEI,
  then the caller renders with `'encoded'` so the forced `<pb>` AND the baked system breaks
  are all honored (pages split + content wraps). The bake is render-only (never touches the
  model, so roundtrip is unaffected).

Also: the section final barline is now DERIVED in `setBarlines()` (every measure immediately
before a `data-hkl-section-title` measure gets `@right="end"`), so inserting a measure near a
section boundary can't orphan it. And `insertMeasureAt` inserts before a section `<sb>` (not
between it and its title measure) so the break + title stay together.

Trill rebound from Ctrl+T → **Ctrl+R**: Firefox reserves Ctrl+T (new tab) at the browser
level and ignores page `preventDefault`; Ctrl+R (reload) IS page-cancelable, so preventDefault
blocks it.

## Tremolo/trill playback = alternation-as-slur; fTrem needs tick support everywhere (2026-05-30)

Tremolos were doubly broken: they took half their intended duration on the page and were
skipped entirely in playback (desyncing the voice). Root cause: `<fTrem>` (and `<bTrem>`) had
no @dur and was unhandled in EVERY tick/enumeration path, so it hit `writtenTicks`'s 16-tick
fallback and was invisible to placeholders, cursor nav, and the playback walk. Fix: treat a
tremolo's sounding time as the SUM of its wrapped notes' written durations, and recognize
`fTrem`/`bTrem` as a first-class content slot in all of: `writtenTicks` (model/ticks.ts),
`contentChildren` (model/index.ts), `layerStops` (model/cursor-location.ts),
`normalizePlaceholders` (model/placeholders.ts), `pushContentChildren` (render/playback.ts),
and the test harness `layerTicks` (composer-test/lib/assertions.mjs). Anytime a new wrapper
element is added, all six sites need it.

Playback (per Max): a trill or tremolo plays as a **slur of alternating notes** — emit a rapid
alternation across the wrapper's span, each note `slurredToNext` so HKL applies the
instrument's glide/overlap. Speed is a static `TRILL_NOTE_MS` (~100ms, tunable later).
**Lattice positions are preserved from the source notes, never computed**: a tremolo alternates
between its two `<fTrem>` notes' real cells; the selection trill collapses to one notehead but
stores the discarded note's exact `(q,r)` on the kept note as `data-hkl-trill-q/r` so playback
alternates between the two real cells. A voice-mode trill (single note, no second cell stored)
plays as a plain note — there is no second lattice position to preserve and we don't synthesize
one.

## HKL Orchestrator (HKLO) + velocity-layered sampling (2026-05-30)

A multi-part feature: sample a physical MIDI instrument's audio into a velocity-layered `.hki`.
Non-obvious choices made along the way:

**`@hkl/analysis` extraction.** The analyzer's DOM-free DSP (loop/decay analysis, k-weighting,
normalize/computeGain, tier, autoSelect, instrument enumeration) moved to a new engine-tier
package `packages/analysis` so both the Analyzer and the Orchestrator consume it (the boundary
checker forbids one app importing another app's `src/`). Two refinements over the obvious port:
(1) **clean type-split, not a wholesale `state.ts` move** — DSP types live in
`packages/analysis/src/types.ts`; the analyzer's UI-state (`SampleSlot`'s `File`/`AudioBuffer`,
`ConfigState`, `initialState`) stays app-local and re-exports the DSP types, so the package has
**zero deps** and no app-UI leaks in, and the 9 app consumers needed no import changes. (2) The
three `.js` DSP files stay `.js` (no `allowJs` — it would surface ~83 KB of untyped DSP to
`tsc`), so the package's `exports` uses an **array fallback** `"./*.js": ["./src/*.js",
"./src/*.ts"]` (the rest of the repo is `.ts`-only). Vite `?worker` entries stay in apps; the
package exports pure functions only.

**`.hki` v2 = flat `samples[]` + optional `vel?`, with a v1→v2 upcast (overrides the earlier
"reject v1" intent).** A velocity-layered note is just multiple flat `samples[]` rows sharing
`name`+`freq` at different `vel` — chosen over a nested `layers[]` shape because the engine
already flattens `samples[]` into per-row buffers and groups by freq at load time, and the
registry keys audio per-file; nesting would have forced a flatten/regroup and migrated every
consumer that iterates `manifest.samples`. `readHki` **losslessly upcasts** v1→v2 (stamps the
version; v1 has no `vel` = single-layer everywhere) rather than rejecting — every shipped and
user bundle today is v1 and v1 data is a strict subset of v2, so rejecting would be a gratuitous
regression.

**Velocity-layer playback = discrete nearest-layer pick + gain-trim; the velocity curve owns
loudness.** `findNearest(freq, velocity)` is two-stage: nearest pitch, then nearest layer by
reference `vel`. The gain math is **unchanged** — because the analyzer normalizes every layer to
the *same* TARGET (−18 dBFS), after `× nearest.gain` all layers play at one reference loudness, so
the layer choice changes timbre, not level; loudness stays owned by the existing house velocity
curve evaluated at the actual input velocity. A `curveGain(v)/curveGain(layerVel)` ratio would
double-count velocity and is explicitly wrong. Single-layer notes (`vel` absent) short-circuit to
byte-identical pre-feature behavior; the `pickLayer` tie rule resolves a midpoint to the lower
layer.

**Decay sampling holds the key for the full natural decay; note-off only at the stop.** Releasing
the key after a short hold would engage a damper and truncate the decay. So the recorder holds
note-on for the whole capture and sends note-off only when the held note's natural decay falls
below −60 dBFS (or 12 s). Discovery probes use `fixedDuration` (hold the probe length, then off).

**HKLO bridge = its own channel, mirroring the Analyzer.** `hkl-orchestrator-bridge` +
`orchestrator-protocol.ts` + two factories; HKL gains an `orchestratorBridge`. The `import-hki`
handler body is shared with the Analyzer via a factored `handleHkiImport()` helper in
`hkl-side.ts`. `InstrumentRegistry.importBundle` needed no change (per-file audio keying already
handles N files/note).

**Lossless intermediate + bundle format = 32-bit float WAV.** The capture worklet emits raw
Float32; the bundle encodes each layer to IEEE-float WAV (bit-exact, no WASM encoder,
`decodeAudioData`-compatible, deflated by the `.hki` zip). Analysis runs on the main thread with
yields (a worker is a deferred optimization — `computeGain`/`measureDecay` are fast).

**Discovery = adjacent-distance peak-pick with an absolute floor.** Fingerprint each swept
velocity (triangular-filterbank + log-compressed band shape + centroid + level), L2-distance
adjacent fingerprints, peak-pick boundaries above `max(mean+1.5·std, absFloor)`. The **absFloor**
is load-bearing: a velocity-invariant device produces all-tiny distances, where `mean+k·std`
would threshold on noise. A warm-up discarded capture + a gap longer than the ring-out keep the
first probe from reading as a false low-end boundary.

## Composer Phase 4.1/4.2 — the Ctrl+Shift+S signature modal + mid-piece sigs

**One flat "Key" select (30 entries), not a select + minor checkbox.** The reusable
`textEntryModal` shell renders static fields and can't live-relabel a select when a checkbox
toggles (the way Setup's bespoke form does). So `sigDialog.ts` flattens major + relative-minor
into one select with `value="<sig>|<mode>"` (e.g. `"3s|minor"`). KEY_OPTIONS is exported from
setupDialog.ts and shared, not duplicated.

**The modal writes FROM the anchored measure forward, via `setKeySigAt`/`setMeterAt`.** Measure 0
writes the head `<scoreDef>` (= the old global path); a later measure gets an in-section
`<scoreDef>` override inserted immediately before it (`ensureScoreDefBefore`, mirroring
insertMeasureAt's `<ending>`/`<sb>` ref-walk; reuses an existing override sibling). `setMeterAt`
truncates only `[mi .. nextMeterOverrideIdx-1]`. The `meterTable()` walk gained `meterByEl` +
`keyByEl` maps so `meterAt`/`keySigAt`/`keyModeAt`/`keySigForMeasure` resolve the real (count,unit)
and key in effect at any measure (NOT ticks-derived — 6/8 vs 3/4 are distinguishable).

**The setters are diff-aware, so submitting an unchanged signature writes nothing.** Each setter
compares against what the measure INHERITS (`meterAt(mi-1)` / `keySigAt(mi-1)`); if equal it clears
that attribute from the measure's own override and prunes the override node when it goes empty
(`overrideScoreDefBefore` + `pruneEmptyScoreDef`). Without this, re-submitting the modal on a later
measure rendered a redundant key+meter change there. The modal also POPULATES from the effective
sig at the anchored measure (`keySigAt`/`meterAt(measureIdx)`), so re-opening shows current state.

**Setup relegates time/key to a "Time / key… (measure 1)" button** that opens the same modal at
measure 0 (mirroring the existing Tempo… button) — the inline key/time selects were removed from
the Setup form. KEY_OPTIONS moved into `sigDialog.ts` (its only consumer now; avoids a
setupDialog↔sigDialog import cycle). Setup's Save no longer touches key/meter.

## Composer Phase 4.3 — mid-measure per-staff clef (Ctrl+Shift+C)

**A clef change is an inline `<clef>` layer child, not a measure-boundary `<staffDef>`.** That's the
only encoding Verovio renders MID-measure (the user's requirement). `model.setClefAt(shape, line,
dis, disPlace)` inserts/edits it at the cursor's tick — before the content child at `withinIdx`, or
before the first trailing placeholder when the cursor is past content (so it lands at the cursor's
x, not after the invisible padding). Re-running at the same spot edits the clef already there.
Inside a tuplet → returns false (unsupported v1). Per-staff: it goes in the cursor's layer.

**An inline `<clef>` is a zero-duration layer child — it rides the existing content whitelists.**
`contentChildren`, `pushContentChildren`, `normalizePlaceholders`, `layerStops`, and the harness
`layerTicks` all whitelist note/chord/rest/tuplet/fTrem/bTrem, so a `<clef>` is transparent (not a
cursor stop, not counted toward the measure budget). Two guards were still needed: `realTicks`/
`writtenTicks` now return 0 for `clef` (else the 16-tick fallback), and `annotateLayer` (beams)
marks the note after a clef `breakBefore` so a clef splits a beam run — otherwise `wrapInBeam`
(which moves a run's notes together) would reorder the clef out from between them.

**Clef is playback-irrelevant** (coords carry pitch — `buildPlayback` never reads clef), so the
whole feature is notation-only: DOM insert + re-render + history, no meter-cache/placeholder churn.

**Per-measure accidental spelling is computed inside `computeAccidentalDisplay`, from the doc it's
handed — NOT from a model-keyed map.** The accidental pass runs on the serialize CLONE, whose
elements differ from the live doc, so a `Map<liveMeasureEl,key>` can't be looked up. Instead the
function walks the clone's own `<section>` `scoreDef`/`measure` nodes (seeded by the head key) to
build a clone-local per-measure key map, resetting carry-state to the new key at each change
(silent switch — no courtesy naturals; a required accidental like E♮ in E♭ major still shows).
`serialize()` is unchanged — it still passes `this.getKeySig()` as the head seed.

**The whole expression-layer moment→tick mapping (`absoluteTickForMoment`) is now per-measure.**
This was initially deferred and mislabeled "tempo-ramp tick math" — it's broader: `absoluteTickForMoment`
(expressions.ts) maps `{measureIdx, tstamp}` → absolute tick for tempo, dynamics, hairpins, 8va
spans, and pedal. It was `measureIdx × head-ticks-per-measure`; any of those anchored at/after a
mid-piece METER change landed at the wrong tick (e.g. a forte on m3 of `[4/4,3/4,3/4]` registered at
128 not 112, so m3's notes got the pre-forte velocity). Fixed with a doc-local cumulative walk over
in-section `<scoreDef>` meter overrides (same pattern as the per-measure key walk), using the
measure's OWN beat unit for the `(tstamp-1)` term. `momentForCursor` (the model-side inverse) now
uses `meterAt(measureIdx).unit` so creation/playback round-trip consistently. `buildTempoTimeline`'s
`pieceEndTick` uses the true cumulative total. (Note: mid-piece KEY changes never needed this —
key doesn't affect ticks.)

**Beaming is per-measure** (`regroupBeams` + `beamGroupForElement`): a `perMeasureTimeSig(doc, head)`
walk gives each measure its own `TimeSigInfo`, so a mid-piece 6/8 measure beams 3+3 (dotted-quarter)
instead of the head meter's grouping.

**MusicXML export is per-measure (best-effort, untested against external readers).** `save.ts` emits
a fresh `<attributes>` with `<key>`/`<time>` in any measure where they change (vs the previous
measure), uses per-measure `measureTicks` for rest-padding, and tracks per-staff clefs — a clef
change is emitted in the opening `<attributes>` of the measure it occurs in (a truly mid-measure
change is approximated to the measure start; inline-position MusicXML clefs aren't emitted).
`exportMusicXml` is exposed on `window.__hkl_composer` for the test harness.

## Composer Phase 4 prerequisite — per-measure meter model

**Per-measure meter/key/clef rides in-`<section>` `<scoreDef>` overrides, NOT data attributes.**
MEI 5 lets a `<scoreDef>` placed as a child of the single `<section>` before a `<measure>` override
meter/key/clef from that point; Verovio renders it natively. The clincher: `querySelector("scoreDef")`
returns the *head* scoreDef in document order, so the existing global getters (`getTimeSig`/`getKeySig`/
`getKeyMode`) keep working unchanged as "score default" — only the new per-measure walk reads the
overrides. (Clef is the exception — mid-measure clef changes can't be a measure-boundary override, so
clef will use an inline `<clef>` in the `<layer>`; that's Phase 4.3.)

**The uniform `measureTicks()` assumption is replaced by a cached cumulative tick table, not
compute-on-demand.** `meterTable()` walks the section's `scoreDef`/`measure` nodes once, producing
`perMeasure[]` + `prefix[]` + a `Map<measureEl, budget>`. `measureStartTick(mi)` (= `prefix[mi]`)
replaces every `mi * measureTicks()`; `measureTicksAt(mi)` replaces single-measure capacity checks;
`measureIdxAtTick(t)` replaces `Math.floor(t / W)`. On-demand would be O(n²) because `measureStartTick`
runs inside O(flat) cursor loops. **Cache invalidation is centralized in `normalizePlaceholdersAll()`**
(which invalidates then rebuilds): nearly every structural mutation already ends in a placeholder
normalize, and the table depends only on the measure set + meter — not note content — so content
mutations never stale it. `setTimeSig` invalidates explicitly as belt-and-suspenders. The lynchpin
was `getTickPositionAt` (`loc.measureIdx * measureTicks()` → `measureStartTick(loc.measureIdx)`).

**`normalizePlaceholders` takes a per-layer budget callback, not a single number.** Signature is now
`normalizePlaceholders(doc, (layer) => ticks)`; the model wraps it as `normalizePlaceholdersAll()` with
`measureTicksForLayer`. This keeps the placeholders module model-free (no DAG violation) while filling
each layer to ITS measure's budget. The deprecated `measureTicks()` is retained as the score-default
alias for the ~20 sites that legitimately want the head meter (deleting it would be gratuitous churn).

## HKLO capture/gate/pitch/NR refinements — from a real Korg capture session (2026-05-31)

The scaffold's gates were calibrated against the clean, full-level loopback; a real session (Korg
headphone-out → audio-interface line-in, padded by the cable's lo switch to ~−15 dBFS, with a fixed
noise floor) surfaced that **absolute-dBFS thresholds are wrong** for a padded-then-normalized chain.

**Gates went noise-floor-relative.** Each capture's pre-attack pre-roll is a clean noise sample, so
gates self-measure the floor and judge in **SNR** (preserved by normalization) rather than absolute
level: `quiet` = SNR < 12 dB (not peak < −24 dBFS), `short` = audible-*above-noise* length < 0.12 s
(not 0.5 s absolute — fast-decaying high notes are real, and padded soft notes aren't "silent"),
`clip` stays absolute (−0.1 dBFS). Final knobs: **quiet 12 dB, short 0.12 s.**

**Recorder stop is noise-floor-relative too.** Hold the note through the natural decay; stop when the
trailing RMS comes within **1 dB** of the measured floor (was an absolute −60 dBFS, which chopped loud
tails early and never triggered on padded-quiet ones). 1 dB lets the tail ring into the floor; the
residual is removed by NR.

**Trust the claimed pitch; pitch detection is informational only** (the big one). Period-detection
reads systematically **sharp** on piano — string inharmonicity pulls the autocorrelation toward the
stretched upper partials — and is noisy at low SNR, i.e. measurably *worse* than the digital
instrument's own equal-temperament accuracy (a uniform ~16 ¢-sharp + ±30 ¢ scatter in practice). So
`buildHki` stores the **claimed MIDI→12-TET frequency (A440)** as each sample's `freq`, never the
detected one — mirroring the analyzer's `trustLabeledPitch` (default-on for local sources,
`generate-samples.js:140`). The JI correction is computed from the tuning system at playback. The
pitch gate no longer rejects anything (only displays cents). **Two octave-guard attempts were removed**
(absolute `rHalf≥0.85`, then ratio `rHalf≥rFull·0.9`): autocorrelation can't distinguish a
weak-fundamental high note from an octave-up, so any guard false-fails real high notes — and we don't
need octave detection (the device plays the MIDI note we send).

**Noise reduction = spectral subtraction with the pre-roll as the per-capture profile** (`denoise.ts`,
run in `buildHki` before WAV encode). WOLA STFT (Hann, 75 % overlap, zero-padded edges), subtract
`α·noiseMag` with spectral floor `β·|X|`; defaults **α 1.5, β 0.04** (conservative; the floor kills
musical noise). Strong on tonal noise (hum/whine, ~20–28 dB), modest on broadband; the note body is
left intact. This is what keeps the soft layers (intrinsically near the floor at the lo cable setting)
and stacked chords clean — and is why `quiet` could relax to 12 dB.

**localStorage persistence** (`persist.ts`): config + velocity bins + last device IDs survive reload
(and Vite HMR, which was wiping the session on every edit). The live `CaptureDevice` and captured PCM
are deliberately NOT persisted (unserializable / too large) — the dropdowns repopulate, you re-Connect.

**The non-repeat playback path needed NO change.** It accumulates each event's absolute tick by summing
content+placeholder durations per voice — so once placeholders fill to per-measure budgets it is
automatically mixed-meter-correct. Only the repeat path's `canonStart(mi) = mi * W` became
`tempo.atMsAt(measureStartTick(mi))`. `buildTempoTimeline` (tempo-ramp tick math) and `beams.ts`
beat-grouping still read the head meter — deferred to 4.2, since both are visual/timing-ramp concerns
and there are no mid-piece meters until then. The `setMeterAt(mi>0)`/`setKeySigAt`/`setClefAt` setters
were deliberately NOT landed in the prerequisite (no caller yet → would be dead/lint-flagged code);
they are 4.2's first step. The harness's universal placeholder invariant now reads
`measureTicksForLayer` so a mixed-meter doc validates correctly (fixture `phase4_mixed_meter_prereq`).

## Composer Phase 5 — multi-instrument (2026-06-01)

**Instrument model = an instrument table over the staffGrp set, NOT a `Voice` tuple.** `Voice`
stayed a `number` (was `1|2|3|4`); a cached `instrumentTable()` (mirrors Phase 4's `meterTable()`:
lazy build, invalidated in `normalizePlaceholdersAll`) walks the head `<scoreDef>`'s root `<staffGrp>`
and maps the flat voice index → `(instrument, global staff @n, layer @n)`. Every `voice<=2?1:2` /
`voice===1||voice===3?1:2` ternary became `model.staffForVoice(v)` / `layerForVoice(v)`. This kept the
blast radius to indirection (one source of truth) rather than a type-surface rewrite, and a single
2-staff instrument reproduces the historic v1→s1l1 … v4→s2l2 mapping exactly — so steps 2–8 are pure
refactors with zero baseline churn (the proof the indirection is faithful).

**MEI encoding: nested `<staffGrp>` per instrument + `hkl:instr` namespaced attr + `<label>`.** An
A0 probe (Verovio toolkit, headless) confirmed Verovio renders nested staffGrps with N staves,
preserves the `hkl:`-namespaced attribute through round-trip, and draws `<label>` as the brace-group
name — chose `hkl:instr` over `data-hkl-instr` to avoid any Verovio data-attr stripping on structural
elements. The legacy single-piano doc (root staffGrp with direct `<staffDef>`s) is treated as ONE
implicit instrument and **never rewritten on load** (the hard byte-identity gate). The first
`addInstrument` PROMOTES it to nested form; a remove that leaves a sole default piano DEMOTES back
(strips the added `hkl:instr` + `<label>`) — so add-then-remove round-trips to byte-identical MEI
(modulo placeholder ids, the documented exception).

**Layers: expr + pedal are PER-INSTRUMENT, tempo stays score-global.** The cursor cycle is now a stop
list derived from the instrument table (`buildVoiceStopList`): `tempo → (per instrument: its voices,
its expr between/above its staves, its pedal below — pedal only for 2-staff instruments)`. One 2-staff
piano yields exactly `tempo→1→2→expr→3→4→pedal` (identical). Expr/pedal moment-lists,
`measureHasExpression`, `pedalMoments`, `dynamAt`/`dirAt`/`hairpinsAt`/`pedalsAt`, and the render bands
all gained an optional staff-filter (default = all staves = historic behavior); new dynam/dir/hairpin
attach to the active instrument's top staff, pedal to its bottom staff. Pedal is per-grand-staff-
instrument (Max): below the last staff of each 2-staff instrument, affecting only that instrument's
playback.

**Audio: `PlaybackEvent.instrumentKey` / `PedalEvent.instrumentKey`, tagged ONLY for multi-instrument
scores.** A single-instrument score leaves the key absent so HKL plays through its current active
instrument (the user picks the sound in HKL, not the model's "piano" default) — exact back-compat.
`computeLegatoPlan` went global→per-voice (each voice's instrument decides glide-vs-overlap, so one run
mixes both); `noteOn(…, instrumentKey?)` overrides the waveform per-event (the `SampleEngine.setInstrument`
call was already per-call); the damper went per-instrument (`pb.pedalSustained` is now `Map<KeyId,
instrumentKey>`, `pedalEngagedInstr` a per-instrument set, `pedalCapturesNoteEndingAt`/`pedalDownAt`
filter by the note's own instrumentKey, a pedal-up releases only its instrument's deferred voices).
**External CC-64 mirroring stays global/unchanged** (per-instrument external routing deferred — Max).
`playScore` pre-scans + lazy-loads any per-event sample-set not already loaded.

**MusicXML export: all staves/voices under ONE `<part>` (best-effort), not yet per-instrument parts.**
`<staves>` = totalStaves, voice loop = totalVoices, per-staff clefs — so nothing is silently dropped,
but a proper one-`<part>`-per-instrument split is the deferred single-part/export follow-on (§12).

**Deferred follow-ons (NOT in the prerequisite):** single-part view + per-instrument MusicXML export,
pizz/arco, string harmonic `Alt+H`, ignore-color-in-setup, per-instrument external pedal CC, and
multi-instrument **selection-mode** (the `Staff = 1|2` measure-selection in `selection.ts`/`input.ts`
stayed 2-staff; single-instrument selection is unchanged).

### Phase 5 post-ship fixes (2026-06-02)

**Instrument reorder = a dedicated draggable modal, not a textEntryModal.** `instrumentsDialog.ts`
(`openInstrumentsModal`) renders a vertical HTML5-DnD list (drag handle / name / staff badge / remove
✕ / Add) in a new `<dialog id="instrumentsDialog">`; each mutation (add / remove / drag-drop reorder)
applies immediately with its own history entry + re-render (the Tempo/Signature independent-apply
pattern). Model side: `reorderInstruments(order)` re-sequences the nested `<staffGrp>`s then calls
`renumberStaves`, which now **also reorders each measure's `<staff>` elements by their new @n** — the
content travels with the staff element, so a moved instrument keeps its notes. (The `appendChild`-in-
sorted-order dance is a no-op for add/remove, so the byte-identical demote round-trip still holds.)
Setup's inline Add/Remove buttons collapsed into one "Manage…" button.

**The playback-cursor-missing bug for added instruments was the `1..4` all-voices caps** — see
lessons.md "Widening `Voice` to a `number`". `findElement` + ~8 other model loops + `save.ts`
gather-break + `scTranspose` + `history.snapshotCursors` now bound on `totalVoices()`. (Selection-mode's
`Staff = 1|2` loops stay 2-staff — multi-instrument selection is still a deferred follow-on.)

**Sync-to-Composer now follows the cursor's instrument.** New `composer-active-instrument`
(`{instrumentKey}`) ComposerEvent, broadcast diff-filtered from `onStateChange` (and on connect) **only
for multi-instrument scores**. HKL applies it via a new `setActiveWaveform(wf)` (load-on-demand, updates
the #waveform selector, does NOT persist to prefs) **only when `prefs.syncToComposer` is on** — so
note-entry preview is heard in the cursor's instrument's timbre. External CC-64 + the user's saved
default instrument are untouched.

**Same-pitch / same-onset cross-instrument conflict → topmost instrument wins (no separate streams).**
HKL keys audio voices by `(q, r)`, so two instruments sounding the same pitch at the same time collide
on one KeyId (cancel/retrigger). Rather than run separate per-instrument audio streams for Composer
playback (a large engine change), `buildPlayback` resolves the conflict at the event level: within each
onset group (voice-ascending = topmost-first), the first instrument to claim a `(q, r)` keeps it and any
OTHER instrument's duplicate of that pitch is dropped (an emptied chord becomes a silent pulse that still
echoes its meiId, so that voice's cursor still advances). Scoped to DIFFERENT instruments (a same-
instrument unison is left alone) and gated on `isMultiInstrument`, so single-instrument playback is
byte-identical. Accepted tradeoff (Max): not ideal voicing, but preferable to building Composer-only
playback streams.

**Per-instrument playback NEVER falls back to a different timbre (2026-06-02).** The original Phase 5
wiring let `noteOn` fall back to `audio.activeWaveform` when an event's `instrumentKey` wasn't loaded —
combined with a fire-and-forget lazy load in `playScore`, this raced: if an instrument's sample-set
hadn't finished loading when playback started, that ENTIRE instrument played with the active
instrument's timbre ("occasionally an entire instrument plays as the wrong one"). Fixed two ways:
(1) `playScore` is now `async` and **awaits** all needed sample-set loads before starting the driver
(so a multi-instrument score's first play may pause briefly while violin/etc. load; cached thereafter),
and (2) `noteOn` with an `instrumentKey` plays ONLY that instrument — if it isn't loaded it **skips the
note** (silent) rather than sounding the wrong one (Max: "rather not play at all than play with the
wrong voice, if the voice exists"). A note with NO instrumentKey (single-instrument scores / live
input) still uses `audio.activeWaveform` — that's the intended instrument, not a fallback. A play-score
superseded during the load (newer play-score / stop) bails without double-driving.

**Glide slurs are per-instrument (2026-06-02).** A sustained-instrument slur hands one voice off via
`glideVoices` (crossfade old→new pitch). But `glideVoices` created the new voice through
`SampleEngine.noteOnFaded`, which uses the SampleEngine's GLOBAL current instrument — left at whatever
the last `noteOn` set. In multi-instrument playback that's often a DIFFERENT instrument, so a glide
crossfaded into the wrong timbre and garbled the whole slurred passage ("a glide slur completely breaks
playback"). Fix: `glideVoices(pairs, rampMs, atTime?, instrumentKey?)` calls `SampleEngine.setInstrument`
up front (a slur is within one voice = one instrument); the playback driver passes `ev.instrumentKey`.
Live-input callers omit it and keep the global instrument. Additionally, `canGlide` now requires the
live voice at `glideFromKey` to belong to the event's instrument (`pb.voiceInstr` tracks per-KeyId
instrument) — so a unison pitch shared by two instruments can't have one instrument's slur steal the
other's voice; on mismatch the slur target re-attacks fresh in its own instrument instead of gliding.

**Sync-to-Composer proactively loads the whole instrument set (2026-06-02).** Cursor-follow
(`composer-active-instrument` → `setActiveWaveform`) lazy-loads on demand, so until the load finished,
live note-entry preview played the previously-active instrument (wrong). Per "never play wrong" extended
to composition: Composer now also broadcasts `composer-instruments` (the score's distinct sample-set
keys) on connect and on any instrument-set change (add/remove; reorder is diff-filtered out since the
SET is unchanged). HKL caches it and — when Sync is on — eagerly loads every one (also on the
Sync-toggle-on, via the exported `preloadComposerInstruments`). So moving the cursor between instruments
switches HKL's active instrument instantly to an already-loaded sample-set; live input (no instrumentKey
→ `audio.activeWaveform`) then previews in the correct timbre. Multi-instrument only (single-instrument
sends `[]` and keeps the user's chosen HKL instrument). Loads stay fire-and-forget here (a brief gap on
first cursor-visit to a still-loading instrument is acceptable for live preview; playback itself still
hard-awaits — see the playback no-fallback entry).

**Instrument edits are STAGED to Setup's Save (2026-06-02).** Superseding the earlier "each
add/remove/reorder applies immediately as its own history entry": the Manage… modal now edits a working
`InstrEdit[]` list (each row carries an `origIndex` identity, or null for new) and touches nothing.
Setup's Save calls `reconcileInstruments(model, edits)` — remove dropped originals (high→low), append
news, reorder to the edit sequence (content travels via origIndex) — folded into Setup's single history
entry; a no-op edit set is detected and skipped (so an unrelated Save doesn't reset the cursor). Cancel/
Escape discards (the model was never touched). Consistent with the rest of Setup (edit → Save commits /
Cancel discards) rather than the Tempo/Signature buttons' independent-apply pattern. (Also fixed: the
Manage button's click listener wasn't removed in the dialog's onClose, so it stacked across Setup opens.)

**Pizz/arco is `<dir>`-driven, not a per-note flag (2026-06-02).** A "pizz."/"arco" expressive-text
`<dir>` (already in the chips) switches a voice's sounding timbre for the notes it governs, via a
per-staff piecewise cue lookup (`buildArticCueLookup`, keyed on absolute written tick so it's
repeat-invariant like velocity) that overrides the emitted `instrumentKey` to a variant from
`ARTIC_VARIANTS` (`render/playback.ts`). Chosen over a dedicated per-note flag: reuses the existing
chips + render path, and the cue genuinely spans notes. The variant map currently holds only
`{ viola: 'viola_pizz' }` — the sole shipped `_pizz` bundle. A pizz cue on an instrument without a
variant stays **render-only** (text draws, timbre unchanged) rather than going silent under `noteOn`'s
never-fall-back rule. Composer can't read HKL's sample registry (package boundary), so the map is a
hand-maintained Composer-side constant (like `TIMBRE_OPTIONS`); extend it + ship the matching `.hki` to
add instruments. `maybeBroadcastInstruments` adds the variants to the preload set. Multi-instrument only
(matches the instrumentKey-tagging gate — a single-instrument score leaves instrumentKey absent so HKL
owns the timbre).

**String-harmonic playback = pitch-shift the emitted coord, not a harmonic timbre (2026-06-02).**
`Alt+H` marks a note/chord harmonic: `data-hkl-harmonic` on the slot + `@head.shape="diamond"` AND
`@head.fill="void"` on the highest written note. `head.fill="void"` forces the OPEN diamond (SMuFL
noteheadDiamondHalf E0D9) regardless of duration so it's unfilled (a quarter would otherwise draw the
filled black diamond; lattice @color then tints the open outline). Playback (`harmonicParts` +
`harmonicSoundingCoord`): the diamond's sounding pitch is computed from the **next-lowest note directly
below it** (the reference / stopped note) — natural (nothing below) → +1 octave (`q+3`); **P4**
(Δ = `q+3, r−1`) → 2 octaves above the reference (`q+6`); **M3** (Δ = `q+1`) → 2 octaves + P5
(`q+6, r+1`); else → +1 octave above the diamond. Coord deltas: octave = `q+3`, P5 = `r+1`, M3 = `q+1`.
In a chord ONLY the diamond is transformed and the reference is dropped (stopped note silent); **every
other note plays at its written pitch**, so a harmonic in a larger chord never silences the rest (the
first cut collapsed the whole slot to one pitch — a 3-note chord lost its other notes). The diamond is
identified by `@head.shape`, ordering by diatonic `oct·7+step` rank. 8va composes on top. Chosen over a
dedicated harmonic sample-set (no new bundle; stays in the score's timbre).

**Single-part view filters the render clone WITHOUT renumbering staff @n (2026-06-02).**
`model.serialize({viewStaves})` drops the non-viewed instrument's `<staff>`/`<staffDef>` (+ emptied
`<staffGrp>` + staff-/startid-anchored control events) from the render clone only — the live/saved doc
is whole. Staff @n are deliberately left at their global values (a violin viewed alone still renders as
staff n=3) because the cursor overlay resolves staves by the doc's @n → xml:id via `rectForId`, and
`cloneNode` preserves xml:ids; renumbering would break that lookup. The cursor never targets a hidden
staff because `buildVoiceStopList` restricts the ↑/↓ cycle to the viewed instrument and `setViewInstr`
parks the cursor inside it. MusicXML export, by contrast, DOES renumber staves/voices part-local (one
`<part>` per instrument) — different consumer, different requirement (a part's clef `number`/`<staves>`
must be part-local).

**Composer PDF export uses PDFKit, not jsPDF (2026-06-02).** PDF must be WYSIWYG with the screen,
including HEJI accidentals — which are injected post-render as `<text font-family="BravuraText">`
(comma arrows / septimal hooks), not Verovio glyphs. jsPDF renders text with its OWN embedded-font
system and supports only TrueType-`glyf`; a spike confirmed it **silently drops** the Bravura OTF
(CFF) — `glyphFor` throws, the error is swallowed, and the PDF embeds no font (no FontFile2/3), so
HEJI would vanish. Bravura ships only as OTF/woff/woff2 (no TTF), so jsPDF can't be made to work.
Spiked the alternative: **PDFKit + svg-to-pdfkit + fontkit** embeds the Bravura OTF as a `FontFile3`
(CFF subset) AND renders Verovio's SVG faithfully (clefs/noteheads via `<use>`/`<path>`, colored
noteheads, HEJI `<text>`), validated by rasterizing real output. So `downloadPdf` now: serializes
with the same `{hejiEnabled}` + view-filter the screen uses → for each page parses the SVG into an
**off-screen-but-attached** host (HEJI injection's `getComputedTextLength` needs layout) → runs the
screen pipeline (`injectHejiGlyphs` → `forceNonNoteheadBlack` → `liftNoteheadsAbove`) → `SVGtoPDF`
into a PDFKit page with `Bravura` registered (a `fontCallback` maps `bravura|leipzig|smufl|…` →
Bravura, serif → Times, else Helvetica). The doc is its own stream — chunks are collected into a Blob
directly (blob-stream references a Node `global` and breaks in-browser). Import the **standalone**
build (`pdfkit/js/pdfkit.standalone.js`); the `.es.js` build still imports Node builtins (fs/events)
and won't bundle. `BravuraText.otf` ships in `/public` (repo-root, the composer's `publicDir`). The
1.38 MB pdfkit chunk is lazy-loaded on first export. Removed `jspdf` + `svg2pdf.js`. PDF export is
WYSIWYG with the toolbar instrument-view selector (single-part view prints just that part).

**Pizz falls back to any library pizzicato when an instrument lacks its own (2026-06-02).** We ship
only `viola_pizz`, so `pizzVariantFor(baseKey)` returns the instrument's own variant if present
(`ARTIC_VARIANTS`), else **any** library pizz (currently viola_pizz) — Max: "I'd rather hear viola
pizz than no pizz for any other string." The preload broadcast (`maybeBroadcastInstruments`) now sends
the whole `PIZZ_VARIANTS` set (not per-instrument) since any instrument can route to any of them.
Supersedes the §14.3 "render-only when no own variant" note in the earlier Phase-5 entry.

**Phase 5 dependents + the deferred infra all shipped (2026-06-02) — Composer roadmap CLOSED.** The
"Deferred follow-ons" listed in the Phase-5 prerequisite entry above all landed: single-part view +
per-instrument MusicXML `<part>` split, pizz/arco (with library fallback), string harmonic `Alt+H`,
ignore-color-in-setup, and the multi-instrument **selection-mode** generalization (`Staff` widened
`1|2`→`number`; the `voice<=2?1:2` ternaries in `selection/{selection,clipboard,selectionOverlay}.ts`
+ `input.ts` now route through `model.staffForVoice`/`layerForVoice`; `adjustStaffRange` clamps to
`totalStaves()`). Plus PDF/print export (PDFKit migration — see its entry). Only per-instrument
EXTERNAL pedal CC remains deferred (no use case). The `docs/composer-roadmap.md` planning doc was
deleted at this point; its durable how-it-works now lives in `docs/architecture/composer.md`, the
non-obvious calls here, and gotchas in lessons.md.

**Ignore-color is a render-clone strip, mirroring the HEJI flag (2026-06-02).** `<hkl:config
@ignore-color>` (getter/setter beside `getHejiEnabled`) + a Setup checkbox; `model.serialize`'s
render path drops `@color` from every `<note>` on the clone when set, so noteheads draw black on
screen while the live/saved doc keeps lattice color (export already blacks via `forceNonNoteheadBlack`).

**Click-to-position: global nearest-target search, not point-hit-testing (2026-06-03).** `click.ts`
originally mapped a click to a note/rest via `elementFromPoint` + a tiny expanding cross, so clicks in
whitespace no-op'd. Replaced with a single nearest-target search over the whole rendered score
(point-to-bounding-box distance, 0 when inside): candidates are note/chord/rest glyphs, **empty-measure
staff regions** (first-class — a click nearest an empty bar lands at its measure-start stop, not a
fallback), and dynam/hairpin/pedal/dir/tempo controls; closest wins and switches to the appropriate
cursor. Glyph placement follows the INS-cursor convention (cursor renders to a note's right): click
at/right of a glyph's left edge → cursor = its flat index (drawn at its right edge), else `index − 1`;
so the gap between two notes resolves to the left note from either side. Per-click `[click]` console
logging (kept for now). Verified live behavior matters here — fixtures exercise it via `dispatchEvent`,
but a click below the staff resolves to the bass staff's empty region, etc.

**Expression moments anchor to the cursor's VISUAL measure (2026-06-03).** A bar-line cursor position is
the same instant as both "prev measure, beat count+1" and "next measure, beat 1". `momentForCursor`
returns the former; Verovio draws a `@tstamp` at the note glyph for that beat, so storing a mark on a
measure's first note in the PREVIOUS measure at beat count+1 drew it on the bar line. Fix:
`momentAtVoiceAnchor` re-expresses the moment in `model.cursorMeasureIdx` (the cursor renderer's visual
measure, via `flat[c].closest('measure')`) — when it differs from `momentForCursor`'s measure, anchor to
`{visualMeasure, beat 1}`. Narrow (voice-mode expression source only); `momentForCursor` and the broader
measure-index system are untouched. **Abandoned** a render-time "hairpin inset" hack (`insetBoundaryHairpins`,
nudging tstamp 1→1.5) — it was built on the false premise that `@tstamp` touches the bar line; once the
moment is in the right measure, `@tstamp` aligns to the note glyph natively, so the inset (which actually
pushed the start *between* the notes) was deleted.

**Verovio rend needs explicit fontstyle AND fontweight to control italic/bold (2026-06-03).** `<tempo>`
renders **bold** by default and `<dir>` renders **italic** by default. To make a gradual tempo (rit./
accel./a tempo) italic-AND-non-bold, the text `<rend>` needs BOTH `fontstyle="italic"` + `fontweight="normal"`
(fontstyle alone leaves it bold-italic). To make a `<dir>` non-italic, "italic off" must write an explicit
`<rend fontstyle="normal">` — plain text still renders italic. So both `setTempoContent`/`setDirContent`
always wrap text in a `<rend>` with explicit style attrs rather than relying on the element default.

**Clef setter is diff-aware and clef inheritance carries across measures (2026-06-03).** `setClefAt`
mirrors `setMeterAt`/`setKeySigAt`: if the requested clef equals the one already in effect, it REMOVES
the inline `<clef>` instead of stacking a redundant one (so setting a clef back to the prevailing one
clears the override — previously only `undo` could). The "in effect" computation is
`effectiveClefForVoice(exclude?)`, which walks the staffDef default + every inline `<clef>` in the
voice's layer across ALL measures up to the cursor (clef changes persist forward, as Verovio renders
them) — the old `clefAtCursor` only scanned the current layer, so it (and the redundancy check, and the
modal seed) wrongly treated staff 1 as treble after a clef change in an earlier bar. `clefAtCursor` now
delegates to the helper.

**textEntryModal shell: keyboard-first submit + builder hooks (2026-06-03).** Enter submits from any
field — including a focused `<select>`, where the browser would otherwise just close the dropdown — but
NOT from a focused `<button>` (left to native activation, so Enter on Cancel dismisses and on OK submits;
forcing submit on any Enter made Cancel commit). Added an `onChange(values, changed, api)` builder hook
(`api.setPlaceholder/setValue/setDisabled/setHidden`) and a `focusField` option; the tempo modal uses
them to focus Kind and hide the ♩=/beat-note/show-mm rows for non-instant kinds. Composer modals also
restore a checkbox focus ring (`.hkl-dialog input[type=checkbox]:focus`) that HKL suppresses globally —
these dialogs are keyboard-driven, so a focused checkbox needs a visible cue.

**Phase 4b/4c: meter symbol + additive beat-groups + pickup ride existing scoreDef/budget machinery (2026-06-03).**
Three structural features added with almost no new architecture, because the per-measure meter/budget
table (`meterTable()`) was already the single chokepoint:
- **Cut/common time** = `meter.sym ∈ {"common","cut"}` on the `<scoreDef>` (Verovio renders C/¢ natively).
  The budget still comes from count×unit (common=4/4, cut=2/2), so capacity is untouched. The sig modal's
  Symbol select forces the numerals (common→4/4, cut→2/2).
- **Additive meters** (e.g. 7/8 = 2+2+3) = `hkl:beat-groups="2+2+3"` (HKL ns) on the same `<scoreDef>`,
  **beaming-only** per Max: `meter.count` stays the sum so the displayed numeral is plain. Threaded through
  `TimeSigInfo.beatGroups` → `perMeasureTimeSig` → `beatGroupBoundaries` (authoritative, overrides the
  simple/compound/4-4 logic). A `<scoreDef>` that touches meter resets the whole descriptor
  (count/unit/sym/groups) together — `meterAt(mi)` returns the `MeterInfo` quad.
- **Pickup / anacrusis** = a dedicated measure 0 with `hkl:pickup-ticks` (reduced budget) + `@metcon="false"`
  (Verovio skips meter-conformance and renders the short bar without padding — spiked & confirmed before
  building the API). `meterTable.budgetByEl` honors `hkl:pickup-ticks`, so autofill/truncation/placeholder
  normalization respect it for free. `renumberMeasures` numbers the pickup 0. Chose **insert a dedicated
  measure** (beats=0 deletes it; title travels to/from the pickup) over converting the first measure.

**Phase 4a: selection-driven span sig/clef/key = two diff-aware calls, not a new mutator (2026-06-03).**
`setMeterRange(lo,hi,…)`/`setKeySigRange` capture the value at `hi+1` first, set at `lo`, then restore the
captured value at `hi+1` — the "bounded restore after the range". Because `setMeterAt`/`setKeySigAt` are
already diff-aware, the restore self-elides when the span change didn't actually alter what `hi+1` inherits.
`setClefRange` mirrors it over beat cursors (capture the clef at `endCursor`, insert at `startCursor`,
restore at `endCursor`); `setClefAt`/`setClefRange` both delegate to the cursor-parameterized
`setClefAtCursor`. Dispatch is intercepted in `dispatchSelectionMode` (before the voice-mode handlers) so
select-mode Ctrl+Shift+S/C apply over the span instead of falling through to single-measure/voice mode.
Time/key work over the measures any selection touches; clef is beat-mode only (measure selection rejected).

**Composer accidentals: deliberate downward house-offset, not Verovio's default (2026-06-03).**
All accidentals in Composer render as BravuraText `<text>` swapped in by `injectHejiGlyphs`
(`@hkl/notation/heji-render.ts`) — note accidentals, key-sig accidentals, and HEJI comma stacks alike,
so the whole score is uniformly Bravura. Empirically (measured on-a-line via `test/composer-inspect`)
Verovio's own placement left every accidental reading slightly HIGH — its optical centre sits above the
notehead's staff line. Our injected glyph matched Verovio within ~0.07 space, so this is not an injection
bug; centering on the line is a deliberate deviation from the engraving default. Lever: the single global
`ACCID_BASELINE_CORRECTION_SPACES`, tuned **1.5 → 1.6** (≈0.1 space further down) — it moves every injected
glyph the same amount. Only the septimal hook (U+E2DE/E2DF) still sat ~0.2 space high at that baseline, so
its per-family `FAMILY_Y_OFFSET.septimal` → **0.05** (≈0.2 space down) to match the flat it trails. The five
conventional families share offset 0. Values are empirical (verified glyph-centred on a staff line for
natural/flat/sharp/double-sharp/double-flat + ±arrow variants + flat+hook); re-tune against the same
on-a-line probe if the font or scale changes, never against `getBBox`/`getBoundingClientRect` (see lessons).

**Composer status-message taxonomy: purple ⇔ undoable edit; only `state` persists (2026-06-03).**
`setStatus(text, kind, source)` kinds map to colour and lifetime: **info** (gray) = neutral/loading +
benign "nothing happened" + any action that does NOT mutate the model (layer/mode switches, navigation,
zoom, view-filter, rewind, save/load/export, copy, cancels); **action** (purple) = confirmation of a real
**undoable** model edit, and every purple call site must accompany one (audited); **error** (red) =
failures + blocked attempts; **state** (blue) = genuinely persistent context that must survive keystrokes
(pending hairpin/slur/tuplet, held-keys echo, selection-span readout). `clearStatusIfTransient` now clears
EVERYTHING except `state` (and the resting `Ready.` default) on the next keystroke — the fix for "messages
persist too long". Voice-switch `Voice N.` messages were dropped entirely (the top-bar `#voiceIndicator`
already shows voice / E / P / T live), and the E/P/T layer-entry messages demoted blue→gray since they
don't mutate the model.

**Composer voice switch selects the target element SOUNDING at the source note's onset (2026-06-03).**
`setVoicePreservingMeasure` (model). The cursor "selects" the element to its LEFT (`flat[c]`; cursor.ts:
c is "past flat[c]"). Moving vertically between voices must land ON the target voice's note at the same
moment, so we (1) take the source current element's absolute ONSET (`getCursorAbsoluteTicks − realTicks`),
(2) find the target element with `onset ≤ srcOnset < onset+dur`, and (3) set the cursor to THAT element's
flat index (= past it → it becomes current). Matching the onset TICK instead lands the cursor at the note's
left edge — i.e. the measure start when the note begins at tick 0 — which reads as "dropped to the start of
the bar" (the bug). Matching the END tick (the older behaviour) jumps when the target has a longer note
spanning the source end with no stop there. A zero-duration current element (measure-start wrapper /
past-end) has no note to select, so it falls back to the positional `findCursorByTickPosition`. The
visual-measure fallback (`getFirstVisualCursorInMeasure`) is unchanged.

**Composer Shift+arrow beat selection is direction-aware on a boundary (2026-06-03).**
`enterBeatSelection` (selection.ts). When the cursor sits exactly on a mid-score beat boundary (= end of
note A / start of note B), Shift+Right selects the beat to the RIGHT (note B = that boundary's own beat)
and Shift+Left the beat to the LEFT (note A), so the selection matches the cursor's visual position.
Strictly-inside-a-beat is direction-independent (the containing beat). Implemented with a module-private
`boundaryAt`; `currentBeatAt` is left untouched because paste-range (`input.ts`) and 8va depend on its
existing "just-ended beat" semantics at a boundary.

**Dark notation theming is a shared, light-is-no-op mechanism in @hkl/notation (2026-06-03).**
Dark mode for both Composer (score) and the HKL staff inset is driven by one stylesheet
(`packages/notation/src/notation-theme.ts`, injected once by `applyNotationTheme`) scoped under
`[data-notation-theme="dark"]`, plus `--notation-ink`/`--notation-bg` tokens. **Light theme sets NO
attribute** — `applyNotationTheme(el,'light')` deletes `data-notation-theme` so the shared rules don't
match and the SVG renders byte-identically to the unthemed path (this is what keeps the ~30 existing visual
baselines passing; an early version that tagged `="light"` perturbed every baseline's background by an
imperceptible amount and failed them all). Dark recoloring is THREE structural rules, NOT a per-class list
and NO `!important` (a per-class list is whack-a-mole — Verovio renders many marks, e.g. the system-bracket
line, as bare unclassed `<path>`s): (1) `color: --notation-ink` on the whole svg (+ `g.note *`) — Verovio
strokes every shape with `stroke: currentColor`, so this recolors EVERY stroke at once with no list to
maintain; (2) `use, text { fill }` — universal SMuFL-glyph + text fill (neither is ever an open shape); (3)
`.grpSym/.slur/.tie/.beam/.dots { fill }` — the complete set of filled non-glyph shapes. Open stroked
spanners (hairpins, tuplet/octave brackets) are caught by rule 1 and deliberately excluded from fills.
Noteheads are repainted by `applyNotationTheme` with an INLINE `color`+`fill` (the `data-light-color`
light-source variant): inline beats the ordinary rules so beamed/grouped noteheads keep their color, and
matching `color` to `fill` means their own currentColor stroke draws no ink outline. An earlier `!important`
version was wrong — it overrode the inline notehead fill, so beamed noteheads (matched by `.beam *`) lost
their color. → lessons.md "Recolor a Verovio SVG with THREE structural rules".

**Verovio prefixes `svgAdditionalAttribute` names with `data-` (2026-06-03).**
A MEI attribute `data-light-color` surfaces in the rendered SVG as `data-data-light-color` (same as
`data-q` → `data-data-q`). `applyNotationTheme` reads `data-data-light-color`. An early version read
`data-light-color`, silently missed it, and fell through to a brightness-filter fallback that *looked*
plausible (bright-ish noteheads) — masking the bug. When reading a baked MEI attr back off the SVG, expect
the double prefix.

**Two notehead color variants over the bridge: ink vs light source (2026-06-03).**
`ResolvedNote.colorHex` stays the ink-on-white variant (`darkColorHex`, for light theme); a new
`lightColorHex` carries the bright on-screen variant for dark theme. The dark variant is `lightSourceHex`
(`render/colors.ts`) — ALWAYS the `.l`/`.sl` light hue, *not* `keyColorHex` (which returns the dark `.d`
variant for black keys; those are near-invisible on a dark staff). The accidental glyph already conveys
sharp/flat, so dropping the white/black `.l`-vs-`.d` distinction on noteheads is fine. Both colors are baked
(`color` + `data-light-color`) into the MEI by `mei-build.ts`/`chord-mei.ts` (and the transcription emitter,
`meiEmit.ts`); `FootprintCell` gained a 4th tuple element so SC-transpose recolor updates both.

**Imported files without `data-light-color`: reverse-map to a SANCTIONED color, never approximate
(2026-06-04).** A dark notehead must be one of our sanctioned light-source colors. The renderer
(`applyNotationTheme`) picks it as: the baked `data-light-color` if it's a sanctioned light hex; else the
sanctioned light reverse-mapped from the baked ink `color`; else **white** (an obvious "bad import" flag —
NOT a graceful approximation). The reverse-map works because `darkColorHex`'s outputs are exactly 7 fixed
hexes (one per `HUE_PROFILE`), so `@hkl/shared/colors.ts` builds `SANCTIONED_INK_TO_LIGHT` (ink→`.l`) +
`SANCTIONED_LIGHT` (every `.l`/`.sl`) using the SAME hsl→rgb→hex path `darkColorHex` uses, so keys match its
outputs exactly. (An earlier attempt used a CSS `brightness(2.2)` filter as the fallback — it clipped RGB
channels and MERGED adjacent hues, e.g. yellow↔green and blue↔teal, which is why imported scores looked
wrong in dark mode. Hue-preserving HSL lightening was also rejected: the rule is sanctioned-or-flagged, not
"closest looking".) `HUE_PROFILES` + the hsl/rgb helpers now live in `@hkl/shared`; `pitch.ts`'s
`darkColorHex` imports them. → lessons.md "Recolor a Verovio SVG with THREE structural rules".

**"Composer view in HKL" streams MEI, not SVG; renders the cursor instrument only (2026-06-03).**
HKL's optional bottom-bar frame (`apps/hkl/src/render/composer-frame.ts`, body class `composer-view`,
replacing the analysis line + staff inset) renders a read-only mirror of the Composer score. Composer
broadcasts the **cursor instrument's** single-instrument MEI (`composer-score`, gated on content/instrument
change) + the editing-cursor measure (`composer-cursor`, on cursor move); HKL re-renders it via
`@hkl/notation` `renderMeiToContainer({geometry:'scroll',theme:'dark'})` and horizontally scrolls to follow.
Grand staff is the target; multi-instrument degrades to the one part at the cursor (no room for the full
score). No new message carries the playback head — HKL drives playback and already knows the sounding
`meiId` it echoes via `playback-position`, so it scrolls the frame directly (resolves only for the cursor
instrument's notes; others are simply not found = no-op).

**Cursor geometry is a single shared function; the mirror reproduces, never reconstructs (2026-06-04).**
HKL's Composer-view frame must show a cursor PIXEL-IDENTICAL to Composer's 50%-scroll view. Rather than
re-derive it HKL-side (which repeatedly drifted from `cursor.ts` — fixed-px HPAD/VPAD offsets, note-box vs
staff-box height, sig-end/tuplet/past-end/overwrite cases), the geometry is ONE pure function
`computeVoiceCursorRect(anchor, query)` (+ `computePlaybackBarRect`) in `@hkl/shared/cursor-geom.ts`. Split:
the case DECISION needs the model, so it lives in Composer (`resolveVoiceCursorAnchor`) and ships over the
bridge as a render-agnostic `VoiceCursorAnchor`; the GEOMETRY is the shared fn, called by BOTH Composer's
`cursor.ts` (its drawn bar IS the shared output) and HKL's frame (queried over its identical re-render). The
shared package is the right home (apps + bridge both reach it; the type is re-exported through
`@hkl/bridge/protocol`). It's pure number-in/number-out (a `CursorRectQuery` abstracts the DOM), so it stays
within `@hkl/shared`'s "no DOM/state" rule. Verified: at 50% scroll the bar sits at note.right+4 / note.top−6,
width 2, height note+12 in BOTH. → lessons.md "A mirrored view's cursor must SHARE geometry code".

**Bridge handshake self-heals on focus, not via retry loop (2026-06-05).**
`BroadcastChannel` has no buffering: a message is delivered only to channels that already
exist at post time. Each app posts its hello exactly once at load (Composer: `composer-hello`
+ `request-state` at module eval; HKL: `announce()` via one-shot `initHklBridge`). Sequential
load is robust — the second loader's hello always reaches the first (which is up + listening)
and the first replies, and even a lost first-hello self-heals because the second's hello
triggers a fresh reply. The ONLY wedge is losing the hello in BOTH directions, which needs
near-simultaneous (re)load of both tabs — exactly what shared-package HMR causes (it reloads
HKL + Composer at once). Fix is NOT a retry loop: both apps re-announce on `focus` /
`visibilitychange` (HKL `announce()`; Composer re-sends hello + request-state, whose `hkl-hello`
reply re-drives `broadcastComposerView`). Since Max already focuses HKL to start the
AudioContext, the handshake completes on the one action he performs. Debounced 100ms so
focus+visibilitychange coalesce; the broadcasts it triggers are diff-gated so repeats are cheap.
→ lessons.md "BroadcastChannel drops messages posted before the peer channel exists".

**Dark-mode cursor + staff/bar lines are theme vars in the shared notation stylesheet (2026-06-05).**
`notation-theme.ts` dark block defines `--cursor-color` (#a96bff, brighter than the light-mode
#7226e4) and `--notation-line` (#9a9a9a, a darker silver than `--notation-ink` #f2f2f2). The
cursor overlays (`cursor.ts` + `composer-frame.ts`) live inside the themed container, so they
consume `var(--cursor-color, #7226e4)` via INLINE `style.fill`/`stroke` (SVG presentation
attributes don't resolve `var()`; inline style does). Staff lines (the 5 bare `<path>` DIRECT
children of `g.staff` — clef/keySig/layers are all `<g>`, so `g.staff > path` isolates the lines
from notes/stems/beams under `g.layer`), bar lines (`.barLine`/`.barLineAttr`), and the
grand-staff system-initial connecting line (the lone bare `<path>` DIRECT child of `g.system`,
right of the brace — `g.system > path`) all get `--notation-line` via a rule that out-specifies
the blanket `color` recolor. The brace symbol itself (`g.grpSym`) and ledger lines stay ink (they
read as part of the note/decoration, not the ruling). Both apply to Composer + the HKL frame from
one stylesheet.

**Per-voice playback bar clears at note-expiry; meiId:null + voice = clear one voice (2026-06-05).**
The per-voice playback bar only moved on the next event's onset, so a voice whose content ended
before the score did left its bar orphaned at the last note for the rest of playback. Fix: the HKL
scheduler precomputes each event's next same-voice onset (`nextVoiceOnset`, a backward sweep over
the atMs-sorted events) and, when no same-voice event starts by an event's WRITTEN end (a gap or
the voice's last element, note OR rest), schedules a clear at that written end. The clear extends
the `playback-position` message with an optional `voice`: meiId=null + voice clears ONLY that
voice's bar (both the HKL frame via `setComposerPlaybackBar(voice, null)` and Composer via the
handler), distinct from the meiId=null-no-voice finish signal that drops all bars.

**Performance mode is input-driven playback (2026-06-05).**
A second Composer transport (Shift+Space / `#btnPerform`, single-instrument only) that inverts
clock playback: the player performs live on the Lumatone and the per-voice bars advance as the
matching notes are struck — for recording scrolling-score videos to one's own performance. HKL
forwards each live note-on as `player-note-struck { ResolvedNote }` (new HklEvent, gated by
`start-performance`/`stop-performance` ComposerEvents, suppressed during a `play-score`); Composer
sends NO `play-score` (audio is the live instrument). The matcher (`render/performance.ts`) reuses
`buildPlayback` for per-voice ordered attacks (sounding coords, tie coalescing, rest-skipping) and
holds a strict per-voice frontier: a voice advances only when its current chord's full expected set
is struck; voices advance independently; a strike matching no current frontier is ignored (the only
leniency — Max's framing: polished recordings, a mistake means restart). Match identity = exact
frequency expressed as `(note name, octave, color)` — `noteName(q,r) | keyOctave(q,r) | color`,
where color is `darkColorHex(q,r)` (octave-invariant: `profileForHue(hue)`), read off `@color`
(expected) / `ResolvedNote.colorHex` (played). This distinguishes enharmonic/comma variants in
Equal/JI; in the duplicate-key modes Pythagorean/Semiditonal a `freqAt` fallback additionally
accepts any same-pitch variant. Color resolution stays on the score side because `darkColorHex`
lives in apps/hkl (Composer can't import it), but `@color` is already stamped on every `<note>` at
insert — so no cross-app color recompute is needed. v1 doesn't follow harmonics, frontier
play-ahead, or mid-piece starts.

**OBS live overlay = HKL-only WebSocket mirror (2026-06-06).**
Goal (backlog LAYOUT #1): composite the hex lattice + Composer view over a performance video in OBS,
transparent and live-synced to Max's own performing instance. Plain window capture can't carry alpha
(the OS flattens the window before OBS sees it) and chroma key is unreliable (the palette spans the
whole hue wheel). So OBS renders the content itself: a second HKL instance loaded as a Browser Source
at `?overlay` (true alpha, chrome-free), driven by a WebSocket mirror from the performer. Decided
HKL is the ONLY node — it already renders the Composer view itself (`render/composer-frame.ts`), so
both surfaces publish from one place; the Composer app is untouched. Transport: a dev-only relay
(`vite/overlay-relay.mjs`, `ws` noServer mode) attached to the dev-proxy at `/overlay-ws` (single
origin, no extra port), with retained-last-value per message type so a late-joining OBS source
reconstructs immediately. Protocol types in `@hkl/bridge/overlay-protocol.ts` (pure data; outline/
rotation/hexSize typed `string` to avoid reaching into the app), WS client in
`@hkl/bridge/overlay-ws.ts`; transport stays out of `@hkl/shared`, boundaries green. Publisher
(`bridge/overlay-publish.ts`) taps the ONE convergence point — end of `draw()` — and diff-gates three
signals: a full `snapshot` on structural change, a `keys` delta when `selection.selectedKeys`
changes, a `view` delta on pan (streamed per-frame during tweens; trivial on localhost and gives the
overlay an exact pan match with no tween-reproduction). Composer-frame state is forwarded explicitly
from the existing `hkl-side.ts` handlers (`composer-score`/`composer-playback`; NOT `composer-cursor`
— overlay is bars-only, no editing caret, per Max). Subscriber (`bridge/overlay-subscribe.ts`,
loaded by main.ts INSTEAD of ui/init.ts under `?overlay`) reconstructs state via the same high-level
apply functions the toolbar uses (`setTuning`/`applyRotation`/`applyHexSize`/`setOutline`/
`setSelectionFromManual`) — their audio/MIDI/Lumatone side effects all self-gate on uninitialised
subsystems, and `savePrefs` is suppressed under `?overlay` so opening the overlay never clobbers the
real instance's prefs (shared origin/localStorage). Transparent render: a `transparentBg` flag in
draw.ts clears the main canvas + hex-layer base to transparent (vs filling `#111`); the keyboard bed
stays opaque `#111` so inter-hex seams are solid black (Max: 1–2px of video through the seams reads
as noise). The out-of-outline mask — which also clips the animation-margin hexes the layer renders
just beyond the outline — was the real "black rectangle" culprit: it even-odd-filled outside the
keyboard with opaque `#111` (invisible on a `#111` page, solid black over OBS video). Fix: when
transparent + extend-off, that mask switches to a `destination-out` ERASE (same per-frame clip, but
the masked area becomes transparent so the video shows through); extend-on keeps the dim paint
(mirrors the performer's ghost tiling) — no separate static display mode needed.
Chrome hidden via `html.overlay` CSS. Verified: `test/overlay-inspect/relay-roundtrip.mjs` (fan-out +
retained replay) and `inspect.mjs` (transparent render, chrome hidden, painted). The live
two-browser path is the manual OBS acceptance step.

**OBS overlay distributable = lean read-only build + standalone relay/host (2026-06-06).**
Shipping the OBS overlay to users without the dev stack, given two hard constraints: (1) HKL
production is static Netlify hosting (no server, so no relay there); (2) OBS-CEF blocks a public
page → ws://127.0.0.1 via Local Network Access (Chrome 142/147+), and CEF can't show the permission
prompt. Solution (Max's framing — NOT bundling all of HKL): a small distributable that serves a
**lean read-only overlay build** (lattice + score visuals only) AND the relay on one LOCAL origin, so
OBS loads `http://127.0.0.1:5190/?overlay` (local→local WS, no LNA). The performer stays on
production HKL (Netlify) in Firefox, which exempts localhost WebSockets + loopback mixed-content.
Three parts: (a) **render/audio decoupling** — `render/controls-core.ts` holds the engine-free render
primitives (`syncViewToOutline`/`applyRotation`/`applyHexSize` + extracted `applyTuningRender`/
`applyOutlineRender`); `ui/controls.ts` re-exports them and keeps the engine-coupled
transpose/clear + `setTuning`/`setOutline`; `onTuningChanged` calls `applyTuningRender` then its
audio/Lumatone/Composer effects; `overlay-subscribe.ts` uses controls-core + direct state writes, so
its import graph never reaches audio/MIDI/samples/recording. `draw()` skips `updateInfo()` when
`transparentBg` (info panel hidden in overlay). (b) **lean build** — `src/overlay-main.ts` entry +
`vite.overlay.config.ts` (reuses index.html via an `order:'pre'` `transformIndexHtml` script-swap to
avoid markup/CSS drift; `publicDir:false` so no samples; font/Verovio via CDN) → `dist-overlay/`
(~110KB, verified to exclude requestMIDIAccess/AudioContext/SampleEngine/recordOn). (c) **distributable**
`apps/overlay-host` (`@hkl/overlay-host`) — Node `.mjs` server: `static.mjs` (dependency-free file
server) + the relay (moved here from `vite/`; dev-proxy now imports it from here), binds 127.0.0.1:5190,
embeds `dist-overlay` via `vite/assemble-overlay-host.mjs` (no-op `build` so `pnpm -r build` ordering
is untouched). Client URL (`overlay-ws.ts`): local origin → same-origin `/overlay-ws` (dev-proxy AND
distributable); remote origin (Netlify performer) → `ws://127.0.0.1:OVERLAY_RELAY_PORT` (5190,
`localStorage.hklOverlayPort` override). Publisher gives up after 6 failed connects (never-opened) so
public Netlify visitors don't poke localhost; the `cbObsOverlay` publisher gate is KEPT off-by-default
(reversing the earlier drop-it idea) so public visitors never dial out at all. Verified: relay
round-trip, lean-bundle engine-exclusion scan, and a live publisher→relay→browser-subscriber e2e
through the running distributable (extend-off snapshot → 74% transparent). Future single-exe (bun
compile / Node SEA) noted, not built.

**OBS overlay: single relay (overlay-host only), no dev-proxy relay (2026-06-06).**
Consolidated to ONE relay — the `apps/overlay-host` distributable — rather than maintaining a second
copy in `vite/dev-proxy.mjs` (Max: don't maintain two). Dev now runs `pnpm overlay:host` alongside
`pnpm dev`; the 5170 tabs dial the 5190 host relay. `overlay-ws.ts` URL resolution: `?obsrelay=PORT`
/`localStorage.hklOverlayPort` override wins; else a host-served overlay (flagged via
`window.__HKL_OVERLAY_SAME_ORIGIN`, injected into the lean build's HTML by the overlay vite config)
uses same-origin so it tracks any `HKL_OVERLAY_PORT`; else (dev/Netlify performer, non-host overlay)
dials `ws://127.0.0.1:OVERLAY_RELAY_PORT` (5190). Also: the lean build now bundles `BravuraText.woff2`
locally (publicDir:false had dropped it → /BravuraText.woff2 404; the CDN @font-face fallback proved
unreliable in OBS-CEF), so the distributable's font is self-contained (Verovio WASM still CDN).

**Transport mutual-exclusion: keys stop-or-start, buttons switch (2026-06-06).**
Clock playback (`isPlaying`) and Performance mode (`performanceActive`) are mutually exclusive, with
keyboard and buttons given DELIBERATELY DIFFERENT semantics (Max). Keys: **Space** (`spaceTransport`)
stops whichever transport runs, else starts playback; **Shift+Space** (`shiftSpaceTransport`) starts
Performance only if neither runs, else no-op (Space is the universal stop). Buttons `#btnPlay`/`#btnPerform`
are *switch-to-this-transport* controls: each shows the STOP glyph while its OWN transport runs, and
pressing one while the other is active deactivates the other and activates this one (Play during
performance → stop performance AND start playback). `startPerformance` already stops playback, so only
`#btnPlay` needed an explicit `stopPerformance` before `startPlayback`. All in `apps/composer/src/main.ts`
(hook bodies + button click handlers) + `apps/composer/src/input.ts` (hook names; the old `togglePlayback`/
`togglePerformance` were renamed since they're no longer toggles). HKL unchanged — it already gates
`broadcastPlayerNote` on `!performanceMode || playbackActive`.

**Setup ref drives HKL's score-ref tier; sync-gated selection clear (2026-06-06).**
The song-key tier was renamed **score-ref** (`set-song-key`→`set-score-ref`; reference.ts
`songKey`→`scoreRef`) and repointed: HKL's cursor-independent fallback ref is now fed by the score's
Setup-dialog ref coordinates (`layoutReq.refQ/refR`), not the key-sig tonic. The key-sig tonic
(`computeSongKeyRef`) survives but ONLY seeds the Setup dialog's ref-coordinate default when the stored
ref is the doc default (0,0). Fixes "Setup ref overridden by song key" — previously the Setup ref reached
HKL only via `applyLayoutFromComposer`'s selection-tier write, gated on `syncToComposer` AND piano
outline, so the key-tonic song-key tier won whenever those gates failed. `applyLayoutFromComposer` is now
tuning-only; the ref arrives via `set-score-ref` regardless of sync/outline. Sync interaction (Max):
**sync ON** → a `set-score-ref` also `clearSelection()` (lattice must match the score exactly);
**sync OFF** → updates the score-ref tier but leaves the user's explicit selection (they keep their own
ref/layout against a mismatched score); **toggling sync ON** with Composer connected →
`reconcileSelectionOnSyncEnable()` clears the selection iff it differs from the score-ref tier. Files:
`packages/bridge/src/protocol.ts`, `apps/hkl/src/{state/reference.ts,bridge/hkl-side.ts,ui/init.ts}`,
`apps/composer/src/{main.ts,cursor/refNote.ts,setupDialog.ts}`.

**OBS overlay: drop the off-by-default checkbox, auto-publish on boot (2026-06-06).**
Reverses the earlier "KEEP `#cbObsOverlay` off-by-default" decision (above). The overlay item also
overflowed the Analysis toolbar and never belonged there (it's output, not analysis). Why dropping
the gate is now safe — and why the original prompt-fear was misdiagnosed: per the WICG Local Network
Access spec (https://wicg.github.io/local-network-access/), the LNA permission check is inserted into
HTTP-network fetch **"right after checking that the newly-obtained connection is not failure"** — i.e.
**after** the TCP connection is established. So a **closed port (no relay) is refused before the check
runs → no prompt, fully silent**; only an **established** connection (a relay is actually present)
reaches the prompt. WICG issue #96 confirms a refused connection leaks "no new information vs. any
closed port." The spec text is for fetch; WS gating is the Chrome 147+ extension and necessarily rides
the same ordering (a WS upgrade can't happen without an established TCP connection) — confirmed by the
A/B test on Max's Chromium 148 (relay down → no prompt; relay up → the "access other apps and
services on this device" prompt). Net: the bare WebSocket attempt is itself the silent presence-probe
Max wanted — a `fetch()` probe would be strictly worse (it's the one thing that DOES prompt on a
closed port). So: no checkbox, no probe, no UA-sniff, no `?obs`. `ui/init.ts` calls
`setOverlayPublishing(true)` unconditionally at boot; `giveUpAfter` lowered 6→3 so a non-OBS visitor
logs only a couple of silent connection-refused lines before stopping. Removed: `#cbObsOverlay`
(index.html), its listener + startup gate (init.ts), the `obsOverlay` pref (persistence.ts), the
tooltip (tooltips.ts). Firefox (loopback-exempt) and the localhost dev origin (loopback→loopback)
never prompt regardless. Files: `apps/hkl/index.html`, `apps/hkl/src/ui/{init,tooltips}.ts`,
`apps/hkl/src/state/persistence.ts`, `apps/hkl/src/bridge/overlay-publish.ts`.


---

## Prime-exponent vectors as the canonical tuning quantity (`coordExps`)

**Picked**: One function `coordExps(q, r, mode)` in `@hkl/shared/freq.js` returns a cell's
prime-exponent vector `[e2,e3,e5,e7]` relative to 220 Hz, with all per-mode region/schisma shifts
baked in. `freqAt` multiplies it into Hz once; `jiRatioWithState` takes the difference of two cells'
vectors; Tenney Height reads the vector directly (`tenneyHeightFromExps`). Integer/Hz multiplication
of exps for *display* happens only in the analysis box (`fmtFactors` / `num:den`).

**Rejected**: the prior split where `freqAt` (shared) and `jiRatioWithState` (apps/hkl, via
`regions.ts` deltas) each encoded the qm-region + schisma math independently — two copies that had
to stay in sync, and a `num/den` that rounds off for large Pythagorean stacks (>2^53).

**Why**: single source of truth — frequency and interval analysis provably can't drift (verified
bit-exact against a pre-refactor baseline over the lattice × all modes). Exps are always exact, so
cents/tier/ratio for huge intervals no longer depend on rounded integers. Enabled the "Show factors"
analysis-box toggle (prime-power form for every interval) as a thin render-time formatter. `regions.ts`
stays as the source of `RegionInfo` for *coloring* (A/B septimal semantics beyond the exp vector);
`ratios.ts` no longer imports it. Files: `packages/shared/src/freq.ts` (`coordExps`, `freqAt`),
`apps/hkl/src/tuning/ratios.ts`, `apps/hkl/src/render/info.ts`.

**Note**: the bounds-probe scripts `test/bounds-probe/compute-bounds.mjs` +
`compute-refbounds.mjs` still read old pre-monorepo `src/...` paths and error on launch (unrelated
monorepo-migration breakage); `octave-consistency.mjs` runs and passes.


---

## Polyphonic aftertouch = continuous dB swell from strike to an above-v127 ceiling

**Picked**: `aftertouchTargetGain(pressure, strikeVel)` (`apps/hkl/src/audio/aftertouch.ts`) is
dB-linear in pressure: `(ceilGain / baseVol(strikeVel)) ^ (pressure/127)`, where
`ceilGain = baseVol(127) · 10^(AFTERTOUCH_CEIL_HEADROOM_DB/20)` is a common ceiling sitting
`AFTERTOUCH_CEIL_HEADROOM_DB` (default 12 dB) **above** the loudest possible strike. Pressure 0 →
gain exactly 1.0 (continuous with the strike volume); full press → that ceiling regardless of strike.
The floor is the note's own strike volume, not a constant. The master limiter (−3 dBFS, ratio 20)
absorbs the resulting peaks. Decaying instruments (piano/harp) still skip AT.

**Rejected**:
- The original fixed-floor remap `eqVel = 72 + t·55; gain = baseVol(eqVel)/baseVol(strikeVel)` —
  the `FLOOR=72` came from a pre-calibration observation ("AT only fires past the velocity-80 zone").
  After per-key onset calibration that floor is stale: it made gain *jump* the instant `filterPA`'s
  gate opened (up for soft strikes, down for hard), and coupled the swell range to strike velocity.
- An interim "strike → v127, linear in eqVel" model (capped the swell at `baseVol(127)`): fixed the
  discontinuity but gave a v127 strike *zero* headroom and the loudest swell only ~+8 dB. Too
  conservative — a single hard strike already sits ~−15 dBFS, leaving room Max wanted for voicing.
- A strike-independent fixed dB swell (e.g. always +6 dB): rejected because it doesn't converge
  fully-pressed voices to a common loudness, which is what makes voicing a chord tone read clearly.

**Why**: now that onsets are calibrated and the post-onset pressure range is wide, AT should give
*wide, consistent, click-free* expression. dB-linear converging-to-a-common-ceiling gives a
perceptually even crescendo where every strike — including a full-velocity one — can swell to bring
a held tone out above the others (voicing). The ≥10 dB ceiling above max strike was Max's explicit
target; 12 dB is the default and the one knob to tune by ear (a lumadiag slider for it is deferred).
Files: `apps/hkl/src/audio/aftertouch.ts` (whole change); `handleAftertouch` in `audio/engine.ts`
is unchanged (already passes `strikeVel` and ramps `pressureGain` over `AFTERTOUCH_RAMP_S`).

---

## Board 3↔4 swap: runtime toggle, not a hardcoded map (supersedes "Lumatone board map `[1,2,3,5,4]` is per-unit")

**Picked**: Replace the hardcoded `sysexBoardMap = [1,2,3,5,4]` const with `sysexBoardFor(group)`
in `lumatone/protocol.ts`, backed by runtime state (`setBoards34Swapped`/`getBoards34Swapped`)
seeded from a persisted, **off-by-default** pref `swapBoards34`. The swap is exposed as a checkbox
in the Calibrate Keys overlay ("Swap boards 3 ↔ 4 (this unit)").

**Why**: the swap is specific to units with boards 3 & 4 physically transposed (Max's). Hardcoding
it broke routing on every standard unit and was a recurring "don't 'fix' this" gotcha in the docs.
A default-off toggle makes HKL correct out of the box for standard units; Max enables it once and it
persists. Putting it in Calibrate Keys (where the rest of the per-board hardware quirks live) keeps
it out of the everyday toolbar.

**Key invariant**: only the **SysEx board-routing byte** flips. `fixedMidiChannelMap` is group-keyed
and stays `[0,1,2,3,4]` — physical routing is the board byte's job; the per-group channel is
independent. Flipping the toggle resets `lumatone.fixedLayoutSent`/`deviceColors` and re-runs
`syncLumatoneColors()` so the relocated boards re-light.

**Where**: `lumatone/protocol.ts` (state + `sysexBoardFor`), `lumatone/sync.ts` (two call sites),
`lumatone/lumadiag.ts` (toggle UI + resync + title refresh), `state/persistence.ts` (`swapBoards34`),
`ui/init.ts` (startup backfill). The `tools/lumatone-cal/` Python scripts are independent and still
assume the swapped mapping for Max's unit.

---

## HKL-side console scanners: `test/hkl-inspect/` (Chromium CDP + Firefox BiDi), inspection-only

**Picked**: Two headless console scanners for the HKL core app, reusing Composer's app-agnostic
CDP layer. `console-scan.mjs` drives Chromium via CDP (imports
`test/composer-test/lib/{cdp,chromium,console-capture}.mjs` unchanged); `console-scan-firefox.mjs`
drives Firefox via its built-in WebDriver BiDi remote agent (no geckodriver). Both enable the staff
inset + HEJI and hold an A/S/D chord (Verovio renders lazily, only on held notes), then print a
deduped console + (Chromium) network-failure report. `report.mjs` holds the shared dedup/print.
Scripts: `pnpm scan:hkl`, `pnpm scan:hkl:firefox`.

**Rejected**: (a) a pass/fail CONSOLE gate like Composer's — these are *inspection* tools (always
exit 0); their job is to let an agent read warnings, not block CI. (b) geckodriver for Firefox —
the remote agent's BiDi endpoint (announced on stderr as `WebDriver BiDi listening on ws://…`,
connect to `<that>/session`, `session.new`) is enough. (c) an HKL-side debug global like Composer's
`window.__hkl_composer` — unnecessary, since QWERTY play is ungated `window` keydown and CDP/BiDi
can dispatch synthetic key events to trigger a render.

**Why**: HKL had no console-inspection harness; Composer's CDP layer was directly reusable. Firefox
is Max's primary browser, so a BiDi variant matters for Firefox-specific console output.

**Hard limitation (see lessons.md "Headless console capture … can't see DevTools-console-internal
warnings")**: neither protocol exposes browser-internal subsystem warnings (font OTS, WASM `'try'`,
source-map). Those need pasted text from an interactive session. The scanners catch console-API
output + JS exceptions only.

**Where**: `test/hkl-inspect/` (+ `README.md`), `package.json` scripts.

---

## Verovio CDN WASM warnings (`'try'` deprecation, empty source-map) accepted as upstream

**Picked**: Leave the Firefox console warnings that originate in Verovio's CDN-loaded WASM
(`verovio.org/javascript/latest/verovio-toolkit-wasm.js`) — the deprecated WASM `'try'` exception
instruction, and the DevTools source-map worker error from an empty `sourceMappingURL` custom
section. No code change.

**Rejected**: self-hosting a `wasm-strip`-ed / recompiled Verovio binary to remove them — commits a
multi-MB binary, version-couples it to their JS wrapper, and abandons the deliberate CDN-load of
Verovio (see CLAUDE.md). Not worth it for two benign, DevTools-only cosmetic notices.

**Why**: both are baked into upstream's Emscripten build, not our source. Both are warnings, not
errors — Verovio renders correctly. Loading `latest` means the `'try'` notice self-heals whenever
the Verovio project rebuilds with `try_table`; pinning a version would freeze us on it.

**Where**: `packages/notation/src/verovio.ts` (`VEROVIO_CDN`).

---

## Default instrument pref: `maestro_piano` (a real menu option), not `splendid_piano`

**Picked**: `DEFAULT_PREFS.waveform = "maestro_piano"` (the `#waveform` menu's "Piano" option).

**Rejected**: keeping `"splendid_piano"` — a valid `INSTRUMENTS` key but **not** a `<select>` option,
so `applyPrefsToDom`'s `sel.value = p.waveform` silently fell back to `''` on every fresh profile,
leaving `activeWaveform = ''` until the user manually picked an instrument (and emitting an empty-type
oscillator on the first note). The alternative fix — adding a `splendid_piano` option to the menu —
was not chosen since `maestro_piano` is already the menu's "Piano".

**Why**: a pref mirrored into a `<select>` must be a value the select can hold (see lessons.md
"`DEFAULT_PREFS.waveform` must be a real `#waveform` `<option>` value"). Backed by a second guard:
`isOscType(wf)` in `audio/engine.ts` now gates the oscillator note path so an invalid waveform never
reaches `osc.type`.

**Where**: `state/persistence.ts` (`DEFAULT_PREFS.waveform`), `audio/engine.ts` (`isOscType` guard).

## MusicXML import: spelling-preserving picker (not the piano-layout picker)

**Decision**: MusicXML import (`apps/composer/src/importMusicXml.ts`) resolves each pitch to (q, r) via a new `coordForSpelling` (`@hkl/notation/coord-spelling.ts`) that **preserves the source's exact enharmonic spelling**, NOT via the 88-cell piano picker `compute88PianoCoords`.

**Why**: the piano picker holds exactly one cell per MIDI key, so it canonicalizes enharmonics (`Gb`→`F#`) — unacceptable when round-tripping a notated score. A named pitch+octave pins a 12-TET MIDI, so `4q+7r` is fixed and the same-named comma-variants lie on the `(7,−4)` (syntonic-comma) line; the lattice therefore holds a cell for *any* spelling at *any* accidental count. Among the same-named variants we pick **min Tenney height** relative to the **major-key root of the active key signature** (per Max — `keySigToTonic(sig,'major')` → `findTonicCoord`, tracked through key changes), so comma-variants sit simplest-relative-to-the-tonic. Import forces Equal/HEJI-off/ignore-color-on, so (q, r) affects only the lattice coordinate (for later JI retuning), never the rendered pitch.

**Where**: `coordForSpelling`; `reduceExps`/`tenneyHeightFromExps` relocated from `apps/hkl/src/tuning/ratios.ts` to `@hkl/shared/freq.ts` (pure exp-vector math, re-exported from ratios.ts) so `@hkl/notation` can rank without a cross-package reach.

## Tie engine: `normalizeTies` realizes ties across tuplet boundaries

**Decision**: `normalizeTies` walks a per-voice `tieEventSequence` that descends into `<tuplet>`s (emitting their inner note/chord/rest events as real adjacency slots) instead of `flatChildren` (which treats a `<tuplet>` as one atomic slot and emits `<measure>` wrappers).

**Why**: ties that cross a tuplet boundary (a note tied into the first note of a triplet, or out of the last — 18 such in the reference Sonata) were never realized: `extractNoteElements(<tuplet>)` returns `[]`, so the tuplet's edge notes were invisible to tie pairing and became laissez-vibrer stubs. Descending tuplets makes pairing pure musical-time adjacency, which also makes cross-barline ties cleaner. A measure where the voice has no content pushes a barrier slot, preserving "an empty measure breaks the tie chain" (regression-guarded by `phase1_insertMeasure_breaksTie`).

**Where**: `apps/composer/src/model/ties.ts` (`tieEventSequence`). Cursor/editing flat model (`flatChildren`) is untouched — only tie realization changed.

## Composer scroll spot-splice (Phase B2): synthetic spacer measure, not propper-finding

**Decision**: A scroll-view edit re-engraves only the affected measure run and **splices** it into the persistent single-system SVG (`apps/composer/src/render/splice.ts`, `ScrollSplicer`). Verovio sizes each inter-staff gap to that system's max inter-staff content, so a sub-range produces different gaps than the full render. To conform, the sub-render appends ONE **synthetic spacer measure** whose per-gap content forces each gap to exactly the full render's px value, then discards it.

**Why this mechanism**: The original plan was to *find the real measures that prop each gap* (clearance-argmin from the full DOM). The B2 spike proved that wrong — a 1-D bbox clearance ignores horizontal position, and even an x-aware sweep mispredicts Verovio (barlines/braces span the gap, cross-staff stems cross the midpoint). Render-based propper-finding is correct but ~5–18 s. The spacer approach computes the gap-forcing content **by formula** (zero render-time search): `stem.len` on a stemmed note is linear (~unit·scale/100 px per unit), honors fractional values, and floors at the min gap, so `gap = slope·stem.len + intercept` inverts to any px. Calibrated once per full render (2 offscreen renders → per-gap law). The spacer forces a **local treble clef** on every staff (confined to the discarded measure) so the control note sits on one fixed line (f5, top) regardless of the real clef, its down-stem protruding only below its staff. Validated: gaps reproduced to 0 px, edited measures pixel-identical to a full render, splice in ~15–40 ms (build+render).

**Splice mechanics**: diff the new MEI's measures vs the cached signatures (common prefix/suffix by id+signature) → changed run; expand outward past any crossing spanner; sub-render `[run ± context]` + spacer; anchor dx/dy on an UNCHANGED context measure that is NOT the sub's system-first measure (which gets a spurious leading clef); replace the changed `g.measure`s, single `translate(dx,dy)`; x-cascade trailing measures by Δ; merge glyph defs by SMuFL codepoint.

**No auto full-render fallback** (Max's hard rule): full re-engrave only on file open, explicit reflow, or a view/zoom/theme/instrument-view change (`renderer.forceFullRerender()`). A splice that can't be performed logs loudly + full-renders — a visible bring-up safety net, never a silent hang.

**Where**: `apps/composer/src/render/splice.ts` (new); `render.ts` (`renderScroll`, dedicated `spliceTk`, `forceFull` on `setViewMode`/`setZoom`/`setTheme`); `main.ts` (overlay cleanup, `forceFullRerender` on file open + instrument-view). Guard: `scrollEditSplicesNotFullRender` fixture.

## Composer splicer uses a dedicated Verovio toolkit (`spliceTk`)

**Decision**: The `ScrollSplicer`'s offscreen renders (calibration + sub-renders) run on a **second** Verovio toolkit instance (`spliceTk`), never the live score's `tk`.

**Why**: Verovio's `loadData`/`setOptions` mutate per-instance state. Sharing `tk` for the splicer's offscreen renders left it loaded with the tiny calibration doc and broke subsequent cursor geometry (re-discovered the chunk-era `chunkTk` lesson — see composer-virtualization-handoff.md). Kept entirely separate.

**Where**: `apps/composer/src/render/render.ts` (`spliceTk` created in `bindToolkit`, passed via `spliceCtx`).

## `@hkl/engine` published as a standalone package `@hexkeylab/engine` (2026-06-22)

**Context**: HKLE is being lifted out of the monorepo for reuse in unrelated apps (first a browser-React app, later Intonalogy via React Native — see `docs/hkle-extraction.md`). This is the build/publish step on top of the earlier DI + manifest-injection work.

**Picked**:
- **Dual identity, one source.** The workspace package stays `@hkl/engine` (private, `"exports": {"./*.js": "./src/*.ts"}`) so in-repo Vite consumers keep importing raw `.ts` with zero disruption. A **tsup** build (`pnpm --filter @hkl/engine build`) emits a separate self-contained `dist/` — ESM + CJS + `.d.ts` — with its own generated `dist/package.json` naming the public package `@hexkeylab/engine` and a single `.` export.
- **Bundle `@hkl/shared`, externalize `fflate`.** `noExternal: [/^@hkl\//]` inlines the shared subset so the published package carries no `@hkl/*` deps; `fflate` stays the one real dependency. Bundling fflate inlines its **Node** ESM (`import { createRequire } from "module"`) and breaks browser/Metro builds — caught by the react-consumer gate. Leaving it external lets each consumer's bundler resolve fflate's own `browser`/`node`/`react-native` condition.
- **Publish from `dist/`, NOT `publishConfig.directory`.** Setting `publishConfig.directory: "dist"` on the workspace package made pnpm redirect the **in-repo** workspace link to `packages/engine/dist` (whose exports only has `.`), breaking every in-repo `@hkl/engine/samples-engine.js` import. So the workspace package has no `publishConfig.directory`; publish with `npm publish packages/engine/dist` (the dir is a complete manifest, `publishConfig.access: public` baked in).
- **Final couplings removed.** Deleted the engine's Vite-only `import.meta.env.DEV` Iowa-rewrite (legacy dev-server patch that never worked live, predated `.hki`); added an injectable `audioFetch` hook (default global `fetch`); typed the public `loadInstrument` arg as exported `InstrumentDef`/`SampleDef`. HKL's 4 dead Iowa CDN instruments (`piano`/`vibraphone`/`bassoon`/`french_horn`) removed from `samples-data.ts` + the stale UI options; `activeWaveform` placeholder default repointed to `maestro_piano`. The shared `/iowa-mis` dev proxy stays — the **analyzer** still uses it to make `.hki` bundles.

**Verified**: `pnpm typecheck` + `pnpm -r build` (all apps incl. HKL) + `pnpm check:boundaries` + `test/engine-smoke` (Node) + `test/react-consumer` (headless-Chromium browser gate: import → `init()` on a real `AudioContext` → decode → JI triad → `sRampFreq` retune, all green) + `npm publish packages/engine/dist --dry-run` (9 files, no `@hkl/*` deps). **Audio-path behavior is Max's by-ear gate** (loop crossfades / aftertouch / transpose-glide / `.hki` playback) per the standing posture. `test:composer` not run — no Composer/bridge/notation code changed.

**Where**: `packages/engine/{tsup.config.ts,package.json,README.md,LICENSE,src/index.ts}`, `samples-engine.ts` (audioFetch + types, Iowa-rewrite removed). `apps/hkl/src/audio/samples-data.ts` (Iowa entries), `state/audio.ts` (placeholder), `index.html` (options). NEW `test/react-consumer/`. `docs/hkle-extraction.md` (initiative tracker).

## Instrument is per-voice, not a global "current instrument" (engine 2.0.0, 2026-07-07)

**Context**: The sample engine held a single global `currentInstrument`; every note trigger had to `setInstrument(key)` immediately before `sNoteOn`. That's an anti-pattern (instrument is a per-voice property, not a mode) and it hid a latent bug: `sNoteOff` read the *global* instrument's `releaseTime`, not the released voice's. Flagged before shipping the engine into a real product (MusiQuest). Fixed **at the source** in both `@hexkeylab/engine` and HKL rather than worked around in the consumer.

**Picked**:
- **Engine**: `sNoteOn(voiceKey, freq, velocity, instrumentKey, startAt?)` and `sNoteOnFaded(..., instrumentKey, ...)` take the instrument explicitly; `findNearest`/`rangeAttenuation` take it too. The voice already stored its `instr` def; `sNoteOff` now reads `v.instr.releaseTime` (bug fixed), and it also stores `v.instrKey` for the dead-voice re-attack in `sRampFreq`. Deleted `currentInstrument`, `setInstrument`, `isLoaded`; `loadInstrument` no longer sets a "current". `buffers` (keyed, all instruments coexist) + `isInstrumentLoaded`/`unloadInstrument` stay. Other per-voice ops (`sRampFreq`/`sSlideAndFadeOut`/`sHardStop`/aftertouch/damper) were already voice-keyed — no change.
- **HKL host**: `apps/hkl/src/audio/engine.ts` `noteOn` drops `setInstrument` and passes `wf` to `SampleEngine.noteOn`; `activeOscs[key]` now carries `instr` (new `SampleVoice.instr` field in `types.ts`). `glideVoices` derives the instrument from the OLD voice (`e.instr`) and passes it to `noteOnFaded` — dropped its now-redundant `instrumentKey` param (one caller updated in `hkl-side.ts`). `handleAftertouch` gates on the *voice's* `instrDecays(e.instr)`, not the global active waveform. The three live crossfade sites (`input/keyboard-notes.ts`, `midi/handler.ts`, `ui/controls.ts`) thread `e.instr` into `noteOnFaded`. HKL keeps `audio.activeWaveform` as host state for live input (legitimate — one host lookup, not an engine global mutated per note).
- **Breaking → engine 2.0.0**, republished. Consumers pass instrument per note; simultaneous multi-instrument is just multiple `sNoteOn` calls with different keys — no ordering hazard. Also fixed a stale CLI import (`apps/analyzer/cli/{generate-samples,backfill-gains}.js` pointed at the pre-`@hkl/analysis`-extraction `../analysis/` path) so bundle generation runs again.

**Verified**: `pnpm typecheck` + `pnpm -r build` + `pnpm check:boundaries` + **`pnpm test:composer` (317/317, incl. `phase5_multi_instr_selection`)** + `test/engine-smoke` + `test/react-consumer` (per-voice signature) + `npm publish --dry-run` (2.0.0). **Audio feel is Max's by-ear gate** (live play, transpose glide, simultaneous multi-instrument Composer playback, aftertouch, recordings, `.hki`).

**Where**: `packages/engine/src/samples-engine.ts` (+ `tsup.config.ts`/`package.json` version, `README.md`). `apps/hkl/src/audio/{engine.ts,samples.ts}`, `types.ts`, `input/keyboard-notes.ts`, `midi/handler.ts`, `ui/controls.ts`, `bridge/hkl-side.ts`. `apps/analyzer/cli/{generate-samples,backfill-gains}.js`. NEW `docs/musiquest-handoff.md` + `handoff/musiquest/` (three `.hki` + def JSONs).

## Scroll splice serializes only the edited range (O(range), not O(total))

**Decision**: A scroll edit no longer round-trips the whole document. `main.ts` calls `renderer.renderComposer(model, viewStaves)` (not `render(model.serialize(full))`); the splicer works from the model's LIVE doc — it diffs per-measure live signatures to find the changed run, then calls `model.serializeRangeForRender(loIdx, hiIdx, forRender, viewStaves)` which trims a doc clone to the range (interior scoreDefs preserved, pre-`lo` folded into the head as running context) and runs the SAME accidental/HEJI/beam passes as `serialize()` over only those measures. The synthetic spacer is string-appended before `</section>`.

**Why**: profiling a single-measure edit on the 446-bar sonata showed the per-edit cost was dominated by `model.serialize()` (~65 ms headless, the whole-doc HEJI/accidental/beam transforms) + the splicer's full DOMParse (~34 ms) — both O(total), ~2 s on a slower browser. The transforms reset accidental carry at each barline and seed the per-measure key from the head, so running them on a range-trimmed clone is byte-identical for the kept measures. Splicing is gated to all-parts view (`viewStaves == null`) — the gap calibration assumes the full staff set, so single-part view full-renders.

**Remaining O(total) per edit** (smaller, acceptable / future work): the live-doc per-measure signature diff (~7 ms) and the whole-doc clone inside `serializeRangeForRender` (~5 ms); plus main.ts's post-render overlay/cursor/scroll work and the browser re-laying-out the single giant SVG on mutation (the larger cost on slow renderers). **Where**: `model/index.ts` (`serializeRangeForRender`, `runningScoreDefContext`, `stampRunningCtx`), `render/splice.ts` (capture/splice from the model), `render/render.ts` (`renderComposer`), `main.ts` (reRender).

## MusiQuest library conversion: pickSpacing, note-level trim, keepAllRange, and the transpose split (2026-07-08)

**Context**: Converting MusiQuest's ~101 MB chromatic sample library (42 pitched sets at `~/musiquest-assets/audio/samples`) into `.hki` bundles for MQ integration. Requirements: minor-third thinning everywhere, half-step granularity for six voice sets, note-level natural-range trim (violin ≥ G3, etc.), loop analysis with an aggregated success report. 38 instruments converted (Max dropped `male_ooo`, `voice`, `mmm`, `la`); result ~26 MB staged in `handoff/musiquest/`.

**Picked**:
- **`pickSpacing` (default 4) parametrizes the picker**; window `±floor(S/2)`, gap threshold `> S`. **Decay-path thinning is gated on the *presence* of `pickSpacing`**, not its value — legacy decay configs (`local-viola-pizz.json`) keep every usable sample byte-identically; dense chromatic sources opt in with `pickSpacing: 3`. Verified by before/after byte-diffs of block + .hki (modulo provenance timestamp) on `local-viola.json` (loop) and `local-viola-pizz.json` (decay).
- **`lowNote`/`highNote`** trim enumeration *before* fetch/analyze (note-level, inside the octave-granular `lowOct`/`highOct` sweep). Since the engine resamples from the nearest kept sample, trimming never removes playable pitches — it swaps MQ's pre-stretched artifact samples for engine interpolation.
- **`keepAllRange` (tier-inclusive) added for voices**; `keepAllGreenRange` keeps its green-only meaning. Rationale: ~2 s voice samples can tier blue/yellow (fewer surviving segments), and green-only retention would drop those semitones back to the spacing picker — reintroducing the vowel seams the mechanism exists to prevent. Loop tier measures randomization variety, not pitch/timbre correctness.
- **Analysis `transpose` is a label convention (filenameLabel ÷ audioFundamental), never a runtime multiplier.** `bundle.js` no longer copies it into the manifest/def (latent octave bug — `manifestToInstrument` feeds `manifest.transpose` to the engine's rate math, but emitted freqs are already actual fundamentals; it only never fired because no bundled config had transpose ≠ 1 before `musiquest/double_bass_arco.json` (labels one octave above audio, verified by autocorrelation — same convention as fatboy-drawbar). Defs emit `transpose: 1` unconditionally for external-loader ergonomics.
- **Def JSON emission lives in `bundle.js`** (`out/<key>-def.json`, staged as `handoff/musiquest/defs/<key>.json`): built from the same `sampleEntries` written into the bundle, so it cannot drift from the manifest. **`out/<key>-summary.json`** (machine-readable tier/pick/fail summary) is emitted by generate-samples for batch aggregation — the batch runner (`pnpm analyze:musiquest [keys…]`) never parses report.md, and a subset re-run re-merges ALL configs' summaries into the report instead of clobbering it.
- **Resistant instruments ship as decay (legacy MQ parity) or sparse loops, not nothing**: `cello` (53/53 red — deep source modulation defeats segment phase-matching) and `dubstep_bass` (wobble LFO, 58/58 red) ship one-shot on the decay path, which is exactly what MQ's Howler playback did. `violin`/`flute`/`oboe`/`double_bass_arco` ship sparse-but-functional loop spines (3–6 picks) and sit in the report's hand-investigation queue for Max.

**Verified**: backward-compat byte-diffs (above); `pnpm check:boundaries`; all 38 staged bundles unzip + manifest-validate (loop samples all carry segments, defs match manifests, no stray transpose); total 26 MB vs 101 MB source. **Loop smoothness by ear is Max's gate** — import staged `.hki` via HKL's `+ .hki` button.

**Where**: `apps/analyzer/cli/{generate-samples,bundle,batch-musiquest}.js`, `apps/analyzer/configs/musiquest/*.json` (38), `package.json` (`analyze:musiquest`), `handoff/musiquest/{*.hki,defs/*.json,generation-report.md,musiquest-handoff.md}`, `docs/architecture/analyzer.md`.

## .hki imports override static instruments; imports evict the engine cache (2026-07-09)

**Context**: Importing the MusiQuest `.hki` set into HKL surfaced key collisions — e.g. an imported `bassoon.hki` kept playing/fetching an old Iowa bassoon profile. Investigation found three stacked causes: (1) the `INSTRUMENTS` proxy resolved static → HKI → CDN-config, so the 8 MQ keys that collide with static entries (`flute, oboe, clarinet, trombone, violin, viola, cello, viola_pizz`) could never be auditioned — their imports were silently dead; (2) nothing evicted the engine's decoded-buffer cache on import/remove, and `isInstrumentLoaded` short-circuits reloads, so even a non-shadowed key kept serving whichever profile loaded first for the whole session (the actual Iowa-bassoon vector: a stale CDN-config from an old Analyzer "Send to HKL" in IndexedDB loads first, then the `.hki` import changes nothing); (3) the dropdown had no cross-registry dedupe, showing duplicate options for a colliding key.

**Picked** (deliberately NOT deleting the static entries — Max kept all of them as fallbacks):
- **Proxy order is now HKI imports → static → CDN-config imports** (`samples-data.ts`). A `.hki` import is explicit user intent and overrides; removing it restores the static. CDN-config imports stay BELOW static on purpose — they arrive via Analyzer sends and can linger in IDB for months; a stale send must not silently shadow a shipped instrument.
- **Every import/remove path evicts the key from the engine** (`SampleEngine.unloadInstrument`) before re-selecting: the `+ .hki`/`+ JSON` pickers and both manage-list removals (`ui/instrumentBundles.ts`), and the Analyzer/Orchestrator bridge import handlers (`bridge/hkl-side.ts`). Evicting mid-note is safe — live voices hold their own AudioBuffer references; only new note-ons wait for the reload.
- **The dropdown hides (hidden+disabled) static options shadowed by an HKI import**, un-hiding on removal. Removing an active import re-selects the SAME key when it still resolves (static fallback reloads in place) instead of jumping to the first static option.

**Verified**: headless CDP run through the real UI at :5170 (scenario: `baritone_voice`, which has both a static hki-shipped entry and an import) — 9/9 assertions: option hidden/restored, auto-select, post-import load pulls from IDB with NO fetch of the static bundleUrl, post-remove reload DOES fetch it (proves both the proxy flip and the eviction). Plus `pnpm typecheck` + `pnpm check:boundaries` + `pnpm --filter @hkl/hkl build` + `pnpm test:composer` (317/317). The leftover Iowa-bassoon CDN-config itself lives in Max's browser IndexedDB (not in the repo — the 4 dead Iowa entries were already removed during the engine extraction); it's removable via Manage instruments → Imported (CDN config) → Remove, and with the new order it can no longer shadow anything that matters.

**Where**: `apps/hkl/src/audio/samples-data.ts` (proxy), `apps/hkl/src/ui/instrumentBundles.ts` (eviction, shadow-hiding, reselect), `apps/hkl/src/bridge/hkl-side.ts` (bridge-import eviction), `docs/architecture/engine.md` (consumption section).

## Seam clicks were a Firefox runtime bug, not an analyzer failure — engine 2.0.1 (2026-07-09)

**Context**: All segment-looped instruments — including analyzer-green ones like MQ bassoon — played clicks of varying loudness at loop seams ("crackling on chords"). Suspected discriminator failure; investigated by measurement instead of gate-tuning.

**Investigation** (each step narrowing the suspect list):
1. Rendered every emitted bassoon seam pair through the engine's exact 30 ms linear crossfade on the analyzer's own PCM (Node): zero impulsive clicks; residual mismatch −6.6…−20 dB — and the click-free-verified baritone PoC showed the same distribution (worst −5.4 dB). Data exonerated.
2. Reproduced the full browser path (real `decodeAudioData` of the .hki mp3 bytes, real Web Audio scheduling) in Chromium's OfflineAudioContext at 44.1k/48k, rate 1.0/1.059/0.944: all seams ≤0.4 dB over baseline. Chromium exonerated.
3. Same experiment in Firefox: rate 1 clean, **rate 1.05946 clicked up to +13.4 dB**, per-seam severity varying — HKL/MQ play fractional rates on essentially every note (JI + minor-third thinning), matching the symptom exactly.
4. Isolated with a solo-source render: at fractional `playbackRate`, Firefox emits ~3–4 samples of resampler pre-ring BEFORE the scheduled `start()`; the incoming crossfade GainNode still sits at its DEFAULT value 1 (its `setValueAtTime(0, switchTime)` hasn't landed), so the ring passes at full level and is truncated at the seam → click ∝ waveform amplitude at the seam entry.

**Picked**: initialize every future-scheduled gain to silence at creation (`gain.value = 0` before scheduling events) — five sites: `sNoteOn` segGain, `scheduleSegmentSwitch` newSG, `doImmediateSwitch` newSG, `sNoteOnFaded` segGain (samples-engine.ts) and `segmentLooper.ts` newGain. **Engine 2.0.1** (package + tsup VERSION + dist rebuilt) — needs republish to npm for MusiQuest; HKL consumes source directly.

**Deferred (Max's call)**: the investigation also quantified a real-but-secondary discriminator gap — pair correlation is validated over 3 fundamental periods (~11 ms at C4) while the runtime crossfade is 30 ms, letting greens ship pairs whose full-window residual reaches −6.6 dB (audible as a soft seam wobble, not a click). A strictly better gate exists: render the actual 30 ms crossfade at validation time and threshold the residual directly. Not implemented — revisit if seams are still audible after 2.0.1.

**Verified**: fix harness re-run in Firefox — worst seam +13.4 dB → 0.0 dB; `pnpm typecheck`, engine tsup build, `test/engine-smoke`, `pnpm check:boundaries`, HKL build all green. **By-ear confirmation in Firefox is Max's gate.**

**Where**: `packages/engine/src/{samples-engine.ts,segmentLooper.ts}`, `packages/engine/{package.json,tsup.config.ts}` (2.0.1), `docs/lessons.md` (Firefox pre-ring entry), `handoff/musiquest/musiquest-handoff.md` (version note).

## Crossfade-residual gate + analyzer-chosen per-sample crossfade — engine 2.1.0 (2026-07-09)

**Context**: After the Firefox click fix (2.0.1), the quantified secondary issue remained: the pair discriminator validated Pearson correlation over ~3 fundamental periods (~11 ms at C4) while the engine crossfades 30 ms, so slowly-diverging pairs shipped as green with audible seam wobble. Measured worst kept-seam residuals before: female_aaa **+5.1 dB** (residual louder than signal), trumpet +0.6, alto_sax −1.2, english_horn −3.7, viola −4.1, bassoon −6.6.

**Picked**:
- **Crossfade-residual gate** (`selectSegments`, `@hkl/analysis`): every surviving pair is validated by rendering what the engine actually plays — RMS of `x(a+t)−x(b+t)` over the crossfade window, dB rel. local signal RMS. Reject above `xfadeResidualDbMax` (default **−10 dB**; `gateOpts`-overridable; `null` disables and restores single-pass legacy behavior). This is strictly more predictive than correlation: it IS the injected artifact energy.
- **Per-sample crossfade window search**: divergent material (vibrato FM) seams better over shorter windows (female-voice pairs at +2.0 dB @30 ms measured −9.7 dB @8 ms; phase-stable pairs barely move), so selection runs per candidate window (`xfadeCandidatesSec` default `[0.030, 0.015, 0.008]`, floored at 1.5 fundamental periods) and the winner (most segments → lowest worst residual → longer window) sets the emitted **`crossfadeSec`** (omitted at the 30 ms default). Emitted through block/manifest/def (`hki.ts` additive field, manifest version unchanged); consumed by `samples-engine` (per-voice, both switch paths) and `segmentLooper`/analyzer audition.
- **Structure**: `selectSegmentsCore` = the previous pipeline + the residual gate; `selectSegments` = the window-search wrapper. Diag carries `worstResDb`, `rejectByResidual`, per-window trials, per-seam residuals; reports add `xf (ms)` / `worstRes (dB)` columns; summaries add `worstResDb` + crossfade histogram.

**Results (full MQ regen)**: every staged loop instrument now bounds worst seam residual at ≤ −10 dB (independently verified by the seam harness at each sample's emitted crossfade) with pick counts unchanged (only trumpet 12→11, violin 6→5) and the six voices keeping full half-step coverage. All three windows are in active use (~40% 30 ms, ~30% 15 ms, ~30% 8 ms). **oboe** lost its last 4 marginal pairs at any window and now ships on the decay path (legacy MQ one-shot; joins cello with the documented double-reed wall). Note: regeneration of ANY existing config now produces different (better) output by default — the gate is intentionally not backward-output-compatible; disable with `xfadeResidualDbMax: null` to reproduce legacy selections.

**Verified**: typecheck, boundaries, engine tsup build (2.1.0), engine-smoke, HKL + analyzer builds, full batch regen (38/38 staged, 25.9 MB), harness cross-check of four instruments matches summary claims. **By-ear seam audition is Max's gate** — HKL shipped instruments in samples-data.ts keep their old segments until regenerated.

**Where**: `packages/analysis/src/analyzer-analysis.js` (core+wrapper), `packages/shared/src/hki.ts`, `packages/engine/src/{samples-engine.ts,segmentLooper.ts}` + 2.1.0 version, `apps/analyzer/cli/{generate-samples,bundle,batch-musiquest}.js`, `apps/analyzer/src/{audition,sampleTable}.ts`, `apps/analyzer/configs/musiquest/oboe.json` (decay), docs (analyzer.md, engine.md, handoff).

## Loop window (auto) + unconditional bundle tail-cut (2026-07-09)

**Context**: The VSCO vib probes exposed a size problem: sources run 4–14 s of internally cut-and-pasted sustain, the distance-descending picker spreads segments across the whole file, and the bundler kept every byte — violin_vib.hki was 3.0 MB for 11 samples. Audio past the last segment's `b` never plays by design (engine's furthest read = maxB + crossfade + release), so retaining it is pure waste (Max: tail must ALWAYS be cut).

**Picked**:
- **`gateOpts.loopWindowSec`** (`@hkl/analysis` prepareLoop): number = fixed clamp of loop candidates to the first N s of the steady region; `null`/`0` = full region (legacy); **unset = AUTO (default)** — run the full window as the quality reference, then take the smallest ladder window (2.5/4/6/9 s) that preserves the segment count (capped at 5). Fixed windows proved wrong per-instrument (violin's mid-register pairs live late in its files: 3.5 s cost 6 of 11 picks; even 8 s left a 14-semitone hole); AUTO is per-note optimal — notes with late loopable material keep their full window. Ladder floor 2.5 s keeps seam density ≤ ~1 wrap/s (the density already shipping in the 2 s MQ bundles). Chosen window surfaced as `stats.loopWindowSec`.
- **Unconditional bundle tail-cut** (loop path): generate-samples marks `bundleCutSec = maxSegB + 0.03 + releaseTime + 0.1` on every pick whose source runs longer; `bundle.js` executes it — lossy sources via ffmpeg stream-copy (`-c copy -t`, no generation loss, same extension, mp3-frame granularity is fine under the 100 ms margin), lossless folded into the existing Opus encode (`-t`). Tail-cut only, never head-cut: `segments`/`trimStart`/`trend` need no time-shifting and the engine needs zero changes. Decay instruments are never cut (one-shots play full length).

**Results**: five replacement probes went 9.2 MB → 5.0 MB with coverage preserved or improved (violin_vib 3.0 MB → 2.2 MB at 12/12 green — auto BEAT the unconstrained run's 11 picks; oboe_vib 1.4 → 0.76; flute_vib 1.5 → 0.80; contrabass_vib 2.0 → 0.92; cello_phil 0.42 → 0.40). AUTO is the new default for all future loop generations — regenerations change (smaller, same quality target); pin `loopWindowSec: null` to reproduce legacy selections.

**Where**: `packages/analysis/src/analyzer-analysis.js` (candsUpTo/selectForCands/auto ladder), `apps/analyzer/cli/generate-samples.js` (durationSec, bundleCutSec), `apps/analyzer/cli/bundle.js` (copyCut, cut-aware staging), `apps/analyzer/configs/vsco2-*-vib.json` (auto), `docs/architecture/analyzer.md`.

## MQ replacements staged + honest pitch for the mallet transposers (2026-07-10)

**Context**: Five MQ instruments were unloopable from MQ-native samples (one-shot = fail per Max — loop or don't ship through HKLE). Replacements verified under the residual gate and staged via rewritten `configs/musiquest/` entries: `violin` + `double_bass_arco` ← SSO solo (the bass was the once-hidden `sso-double-bass` config — hiding reason was never documented, only its `HIDDEN_SUSTAINED_KEYS` bucketing in the pre-split analyzer; it analyzes 15/15 green under the modern pipeline), `oboe` + `flute` ← VSCO-2-CE vib articulations (CC0), `cello` ← Philharmonia solo arco-normal (license: commercial-ok but no "as is" sample redistribution — accepted for MQ; config regen reads `~/Downloads/philharmonia/cello`). VSCO Solo Contrabass rejected by ear (audible bowings); VSCO violin rejected on quality.

**Also picked**:
- **`xylo`/`glockenspiel` `transpose: 0.5`** — both sound exactly one octave above their labels (strongest low partial 2.0× label; the decay pitch-check was subharmonic-aliased, so they shipped at label pitch). Emitted freqs are now true sounding pitch per the honest-freq convention; MQ preserves its written-pitch grids with request-side `midi + 12` (and `midi − 12` for double bass) — documented in the handoff doc. Request-side, never def `transpose`: nearest-sample selection runs on requested freq, so a runtime multiplier mis-selects by an octave.
- **Batch runner stale-staging guard**: a CDN config without `"bundle": true` writes no fresh `.hki`, and the runner used to stage a stale same-keyed file from `out/` (shipped three wrong instruments for one run). It now refuses to stage when `summary.bundleBytes` is null and flags the config.

**Verified**: fresh provenance + complete loop data in all five staged bundles; xylo C4 emits 523.25 Hz, glockenspiel F3 emits 349.23 Hz (= 2.0× label); handoff total 22.7 MB. **By-ear pass on all five replacements is done (Max)**; mallet octave audition pending.

**Where**: `apps/analyzer/configs/musiquest/{violin,oboe,flute,cello,double_bass_arco,xylo,glockenspiel}.json`, `apps/analyzer/cli/batch-musiquest.js` (guard), `handoff/musiquest/{*.hki,defs/*.json,generation-report.md,musiquest-handoff.md}`.

## HKL sustained-set refresh: full regen + eight MQ/replacement additions (2026-07-10)

**Context**: With the seam pipeline mature (residual gate, per-sample crossfade, auto loop window, tail-cut), Max directed a full regeneration of HKL's shipped sustained instruments plus additions from the MusiQuest handoff set (rights confirmed — the source samples already ship in the commercial MQ product).

**Picked**:
- **All 11 CDN-sourced sustained instruments regenerated in place** (flute, clarinet, saxophone, baroque_recorder, trombone, violin, cello, double_bass, pipe/renaissance/drawbar organs): zero collapses, every worst seam ≤ −10 dB (trombone −17.2). The two timbre-hidden ones (saxophone, baroque_recorder) now analyze clean but STAY hidden pending re-audition.
- **Eight added/changed instruments ship as `.hki` from `public/samples/`** (hki-shipped): accordion, alto_sax, bassoon, french_horn, trumpet, tuba (new, MQ-sourced), viola (REPLACES FluidR3 viola, MQ-sourced), oboe (re-sourced to VSCO-2-CE Vib — the shipped VSCO Sus was unloopable). `double_bass` un-hidden (SSO, CDN like violin).
- **`emitShipped: true` config flag**: emits the samples-data block in hki-shipped form for a CDN-sourced config (runtime fetches the ~0.7 MB tail-cut bundle from `/samples/<key>.hki` instead of ~12 MB of raw CDN wavs per load). Auto-true for local sources; used by `configs/musiquest/oboe.json`.
- **index.html dropdown in score order**: woodwinds (fl, ob, cl, sax, bsn) → brass (hn, tpt, tbn, tba) → strings (vn, va, vc, db) → free reed/organs (accordion, organs). `insert-instrument.js` monorepo path fixed (`../..` → `../../..`; first use since the apps/ split).

**Verified**: typecheck + boundaries + HKL build green; dropdown↔entries↔bundles consistency script (28 options, 11 hki-shipped, all bundles present); **headless end-to-end load test: 15/15 new/changed instruments load in the real app** (engine "loaded" console signal per instrument). `public/samples/` grows 6.7 → 11 MB (committed binaries, per baritone/soprano precedent). **By-ear pass is Max's gate.**

**Where**: `apps/hkl/src/audio/samples-data.ts` (18 blocks spliced), `apps/hkl/index.html`, `public/samples/*.hki` (+8), `apps/analyzer/cli/{generate-samples,insert-instrument}.js`, `apps/analyzer/configs/musiquest/oboe.json`, `docs/guide/core.md`.

## Fill pass admits spine-skipped greens (picker bug fix, 2026-07-10)

**Context**: The violin_sso2 probe (raw ldk1609 takes, 33 greens chromatic) picked only 11 samples and left a 6-semitone gap (label C4→F#4) with greens sitting inside it. Cause: the spine walk's quality-first tiebreak (tier → segments → steady) may pick the far edge of its ±⌊S/2⌋ window (gap up to S+⌊S/2⌋), and the fill pass pool was scoped to blue+yellow only — greens that lost a window vote were invisible to it, so all-green neighborhoods got *worse* coverage guarantees than mixed ones.

**Picked**: `fillTier = usable minus spine` (`pickSamples`, generate-samples.js) — the fill pass considers every usable sample the spine didn't take; the existing tiebreak already ranks green > blue > yellow, so skipped greens win their gaps. Max: "Obviously we would rather have a green over a blue or yellow."

**Effect**: any regen of an instrument with skipped greens inside a >S gap can gain picks (not backward-output-compatible, same spirit as the residual gate). violin_sso2: 11 → 15 picks (E3/E4/A4/G#5 labels joined), all green, max gap 4 st (= max stretch ±2). violin_phil re-run: identical output (its greens were all spine picks — the fix's blast radius is exactly the skipped-green case).

**Where**: `apps/analyzer/cli/generate-samples.js` (`pickSamples` pass 2 + comments).

## Violin re-sourced to SSO "Violin 2" (raw ldk1609 takes) for HKL + MQ (2026-07-10)

**Context**: The 2026-07-09 regen left the violin with a 9-semitone G3→E4 hole (B3/C4 nearest-sample seam + B3 wobble). Diagnosis proved the published SSO Violin folder unloopable on vibrato notes — reverb mastering, not the performance and not the gates (lessons.md "Wet (reverberant) vibrato is unloopable"). Source research found the free-violin field otherwise empty: Philharmonia solo violin probed 36/49 red (1.5 s bucket), VCSL/Karoryfer have no violin, most "alternatives" (bigcat, VPO, NBO) are the same ldk1609 recording.

**Picked**: `configs/musiquest/violin.json` re-pointed at the SSO **"Violin 2"** folder — the raw dry ldk1609 takes (CC0 at source) the published folder was edited from. Chromatic labels one octave below sounding (`transpose: 0.5`, chamber-organ precedent), `bundle` + `emitShipped` (oboe precedent: HKL ships the 1.08 MB tail-cut bundle from `public/samples/violin.hki` instead of ~15 MB of 5–8 s raw wavs per load). Result: 33G/3Y/5R analyzed, **15 all-green picks, max gap 4 st** (max stretch ±2; B3/C4 covered by sounding A3+C#4). Includes the fill-pass fix (previous entry) — 4 of the 15 picks are gap-fills. Old `configs/sso-violin.json` marked DEPRECATED (same key, wet source — regen footgun).

**Rejected**: Philharmonia solo violin (36/49 red, mixed forte/fortissimo picks, 8 dB LUFS spread); reverting to pre-gate data or admitting 2-segment samples (Max: no).

**Verified**: typecheck + boundaries + HKL build green; headless load test against the live dev proxy — dropdown holds `violin`, `/samples/violin.hki` 200, engine decodes and a held note plays with no console errors beyond environmental headless noise. **By-ear audition passed (Max, 2026-07-10) on the probe bundle with identical pick data.** Batch note: `analyze:musiquest violin` staged violin cleanly; the run flags cello/clarinet/flute/trombone as stale-summary (their `out/` summaries were overwritten by the bundle-less HKL-side refresh) — pre-existing, their Jul 9 handoff bundles remain valid; a re-run would also pick up the fill fix and change their pick sets, so it awaits an explicit decision.

**Where**: `apps/analyzer/configs/musiquest/violin.json`, `apps/analyzer/configs/sso-violin.json` (deprecation note), `apps/hkl/src/audio/samples-data.ts` (violin block, hki-shipped), `public/samples/violin.hki`, `handoff/musiquest/{violin.hki,defs/violin.json,generation-report.md,musiquest-handoff.md}`.

## Full loop-instrument sweep under the fill-pass fix (2026-07-10)

**Context**: After the fill-pass fix (skipped greens now fillable — see "Fill pass admits spine-skipped greens"), Max directed regenerating every HKL and MQ instrument that would actually change, to put the whole set on the latest methodology before his full MQ testing pass.

**Scope discipline**: only loop-path configs can change (decay instruments never enter the fill pass — 15 MQ + all pianos/guitars/mallets skipped by construction). Sequencing: HKL-side configs regenerated + spliced BEFORE the MQ batch, because flute/clarinet/trombone/cello share `out/` keys across the two config sets. Live HKL configs identified by exact `baseUrl` match against `samples-data.ts` blocks (top-level `configs/` is mostly dead probes).

**Results** (change = pick-set/segment diff vs pre-sweep snapshot):
- **HKL CDN blocks, all additive** (regenerated Jul 9 under current gates, so delta = pure fill fix): flute 10→16, clarinet 15→18, saxophone 10→16, baroque_recorder 9→15, trombone 12→16, cello 13→18, double_bass 10→15, pipe_organ 14→19, renaissance_organ 13→21, drawbar_organ 21→25.
- **MQ defs: 28/38 unchanged; 10 changed, all additive**: bassoon 13→20, french_horn 14→19, double_bass_arco 10→15, saw_synth 21→26, square_synth 20→24, english_horn 11→14, clarinet 15→17, trumpet 11→13, accordion 21→22, viola 14→15. The five that HKL also ships as `.hki` (accordion, bassoon, french_horn, trumpet, viola) were re-spliced + restaged to `public/samples/`.
- **Voices are a bigger delta than the fill fix**: baritone_voice 33→34, soprano_voice 35→**33** — last generated May 25 under the pre-residual-gate pipeline, so their regen applies the entire new methodology and the gate DEMOTED previously-shipped soprano samples. Flagged for by-ear attention specifically.
- Handoff staging total 21.51 → 24.12 MB; the four stale-summary batch warnings (cello/clarinet/flute/trombone) cleared by this run.

**Verified**: typecheck + boundaries + HKL build green; headless load spot-check on bassoon (hki 200, plays, no errors) and renaissance_organ (CDN path, plays, no failed requests). **By-ear pass on all changed instruments is Max's gate — that is the point of this sweep** (he tests each instrument in MQ next).

**Where**: `apps/hkl/src/audio/samples-data.ts` (17 blocks), `public/samples/{accordion,bassoon,french_horn,trumpet,viola,baritone_voice,soprano_voice}.hki`, `handoff/musiquest/*`, no code changes beyond the already-logged picker fix.

## Note-on scheduling lead split 50ms → 15ms (loop) / 5ms (decay) (2026-07-10)

**Context**: Max reported constant, clearly perceptible onset latency on every sample instrument (oscillators instant). Investigation ruled out the trim gate — measured against all 38 VCSL harpsichord samples, `TRIM_GATE_NORM` lands a median 0.2 ms before the 10%-of-peak point (files are tightly pre-cut). The cause was the flat 50 ms first-source pre-schedule in `sNoteOn`/`sNoteOnFaded`, added so `source.start` is never clamped and `sourceStartTime` stays exact for the first seam crossfade. Its comment claimed 50 ms is imperceptible as onset latency; it is not.

**Picked**: split the live-input lead by instrument type. Decay instruments: 5 ms (the existing late-delivery floor) — segment switching is never armed for them, so nothing depends on start-time exactness; `sourceStartTime` is only read by retune-ramp position math where a few-ms clamp error is inaudible. Loop instruments: 15 ms — ~5 render quanta of margin over the normal 1–2-quanta delivery window; worst case under an extreme GC pause is a one-time subtle dip at the first seam of that one note (later sources pre-schedule on the audio clock and stay exact). `sNoteOnFaded` keeps 50 ms — it fires mid-note under an equal-power crossfade, so its lead is not audible onset latency. `startAt` (lookahead scheduler) paths unaffected.

**Rejected**: keeping 50 ms for loop instruments (the latency is just as audible on sustained attacks); trying to detect/compensate clamping after the fact (Web Audio exposes no actual-start observation).

**Verified**: typecheck + boundaries + HKL build green. By-ear latency check is Max's gate.

**Where**: `packages/engine/src/samples-engine.ts` (`sNoteOn` lead computation + comment).

## Score size relative to page = page-dimension scaling, not unit/scale (2026-07-11)

**Context**: Max wanted a Composer control to change the score size *relative to the page* (backlog "Change size relative to the page"). The obvious lever — Verovio's `unit` (staff size) or `scale` — would resize the notation, but that collides with the three carefully pixel-crisp zoom presets (`CRISP_PRESETS`: scale/unit/line-width/margin-parity co-tuned so staff lines land on whole device pixels). Under `svgViewBox:false`, `scale` is a true output zoom (page + notation together), so the existing zoom is pure magnification and does not change music-per-page.

**Picked**: keep `scale`/`unit`/line-widths *fixed* at the crisp zoom preset (content size + crispness owned entirely by zoom), and add a per-document **`pageScale`** (60–160%, default 100) that scales only the page rectangle — `pageWidth`/`pageHeight` + the four margins — in **page view**. The notation keeps its on-screen size while the paper grows/shrinks around it and bars-per-system reflow: exactly "score size relative to the page," orthogonal to zoom. Stored as `page-scale` on `<hkl:config>` (like `heji`/`ignore-color`), so it travels with the `.hkc` and drives PDF export; absent ⇒ 100 (no migration). Crispness survives because scale/unit are untouched and the scaled top margin still flows through `crispMarginTop()`. Scroll view (no page rectangle) ignores it — which also means the HKL read-only Composer-view frame (scroll-mode) needs no change and streamed-cursor pixel-parity holds.

**Rejected**: varying `unit` (breaks the crisp presets — Max's explicit constraint); a localStorage view-pref (wanted it saved with the file + in export); a continuous free `scale` slider (same crispness problem).

**Verified**: `pnpm typecheck` + `pnpm build` + `pnpm check:boundaries` green; composer-test fixture `pageScaleGrowsPageNotContent` (page SVG ~1.4× wider at 140%, notehead device size unchanged, value serialized) + cursor-trace `pageScale140` scenario.

**Where**: `apps/composer/src/expressions.ts` (`get/setPageScale`), `apps/composer/src/model/index.ts` (wrappers), `apps/composer/src/render/render.ts` (`pageScale` + `scalePageGeom` + `buildOptions`), `apps/composer/src/main.ts` (`reRender` sync), `apps/composer/src/setupDialog.ts` + `apps/composer/index.html` (Setup field), `test/composer-test/fixtures.mjs`, `test/composer-inspect/scenarios.mjs`.

## Orchestrator NR = de-whine notch (calibrated) + decision-directed Wiener (2026-07-12)

**Context**: The SP-250 5-layer `.hki` had an ever-present narrowband whine that survived the existing spectral-subtraction NR and stacked across soft chords. Isolating it (Max's `noise.wav`, maxed volume) showed a fixed **harmonic comb at ~1502 Hz spacing** (peak 8th harmonic = 12 kHz) plus a discrete 15625 Hz (1 MHz/64) timer tone — a DAC/switching-clock artifact: ever-present, scales with the instrument's master volume (so unrecordable-around, confirmed by ear), identical in every note (so it stacks coherently). It's post-volume/analog-out, so no cabling/grounding/level fix applies.

**Picked**: split NR into two stages on the raw capture. **(1) De-whine** — because the artifact is a set of *pure fixed tones*, notch it, don't subtract it: `detectCombTones` (Welch spectrum → prominence + global-floor peak-pick, sub-bin interpolated) finds the tones from an idle recording (the **Calibrate whine** step in Connect, stored as `whineProfile`), and `dewhineChannels` applies a zero-phase (filtfilt) RBJ notch at each. Runs first, so the pre-roll feeding stage 2's profile is already tone-free. **(2) Broadband** — replace spectral subtraction with **decision-directed (Ephraim-Malah) Wiener** (a-priori SNR α=0.98, Wiener gain floored at 0.06); the temporal smoothing kills the musical-noise birdies subtraction left. Whine detection is auto-calibrated per device (not hardcoded), general to any comb.

**Rejected**: recording each layer at a different master volume to raise SNR (whine scales with volume → no SNR gain, and it costs the inter-layer loudness data); higher-`α`/lower-`β` spectral subtraction (can't touch a tone it can't profile from silence, and lowering the floor *adds* musical noise); a fixed low-pass (the dominant tone is at 12 kHz, in-band — dulls the piano); K-weighting the whine away (it's tonal, not a loudness-weighting problem).

**Verified**: `test/orchestrator-smoke/dewhine-test.mjs` (node, via `register-ts.mjs` loader) — detect finds the comb with no spurious peaks, notch ≥20 dB with the note preserved, Wiener floor drop ≥6 dB with body preserved. Smoke `calibrateWhineTest` (loopback `enableWhine`) + the NR hook (floor drop 24.4 dB, body 0 dB). typecheck/build/boundaries green. Real-capture audition is Max's gate.

**Where**: `apps/orchestrator/src/analysis/dewhine.ts`, `.../analysis/wiener.ts` (replaces deleted `denoise.ts`), `.../capture/whineCal.ts`, `.../device/recorder.ts` (`recordIdle`), `.../device/loopback.ts` (`enableWhine`), `.../analysis/buildHki.ts` (`cleanOf` chain), `.../state.ts` + `persist.ts` (`whineProfile`), `.../ui/stepConnect.ts` (Calibrate button).

## Per-layer perceptual softening = keyboard velocity-response ÷ house curve (2026-07-12)

**Context**: Supersedes the "**Velocity-layer playback … the velocity curve owns loudness … layer choice changes timbre, not level**" decision above. Normalizing every layer to a flat −18 dBFS target made a brighter layer read as a perceived-loudness **tier** at each boundary: perceived loudness ≈ actual dBFS + brightness, so a timbre jump with flat dBFS pops. The keyboard maker already balanced its layers; flat normalization threw that away.

**Picked**: keep the flat normalization, then multiply each layer's gain by a **softening scale ≤ 1** derived from the *device's own* data. The Discover sweep already measures velocity→loudness `L(v)`; per reference velocity, residual `r(v) = L(v)/houseCurve(v)` (house curve = `velocityCurveGain` in the new `@hkl/shared/velocity.ts`, the single source HKL's `velocityCal` `DEFAULT_CAL` now wraps), normalized to `max(r)` → attenuation-only. Comparing to *our* curve (not restoring raw levels) is the crux: the house curve already applies velocity loudness at playback, so restoring absolute levels would double-count and re-tier; taking only the residual leaves the proven curve owning the bulk of the dynamics and bakes in just the keyboard's deviation. Multi-layer notes only; no sweep data ⇒ scale 1.0 (prior flat behavior).

**Rejected**: preserving the raw captured inter-layer levels (brighter=louder → worsens the tier — the double-count); a per-instrument velocity curve stored in the `.hki` + applied at playback (Max: don't touch the proven velocity system; and a scalar-per-layer gain can't shape within-bin loudness anyway); K-weighting/LUFS-equalizing the layers (a perceptual *guess* — the keyboard's measured balance is the ground truth); softening as a fix for the soft-sample noise bugs (it only ever attenuates soft layers *less*, so it doesn't help those — orthogonal).

**Verified**: smoke `softeningTest` — flat keyboard response ⇒ strictly-decreasing scale anchored at 1.0 (`[1, 0.47, 0.28, 0.19, 0.14]`), null response ⇒ all 1.0; `exportTest` equal-loudness invariant still holds (it passes null). typecheck/build/boundaries green.

**Where**: `packages/shared/src/velocity.ts` (house curve), `apps/hkl/src/audio/velocityCal.ts` (`DEFAULT_CAL` wraps it), `apps/orchestrator/src/analysis/buildHki.ts` (`layerSofteningScale` + apply), `.../ui/stepDiscover.ts` (capture `velocityResponse`), `.../state.ts` + `persist.ts`.

## High-soft capture reliability = post-gain-noise skip + auto-retry + short-decay fallback (2026-07-12)

**Context**: After the de-whine/Wiener + softening landed, the high register at low velocity still had whines, late onsets, and "missing" notes. Diagnosed on a real capture: these notes are genuinely quiet, so flat-normalizing them to −18 dBFS needs **166–328×** gain, which (a) amplifies the noise floor into an audible whine, (b) boosts pre-note residual past the engine trim gate → leading noise = late onset, and (c) where the note is too short for the K-weighting window, leaves `computeGain` null → gain defaults to 1.0 → **silent** (C6, C8). The SP-250's top octave (A6–C8) turned out to have a systematic ~−76 dBFS floor vs ~−100 below — a hard cliff, not per-take noise.

**Picked**: three coordinated changes, no volume adjustment (Max's constraint — a note is kept at its real gain or skipped, nothing in between):
1. **`measureDecay` RMS fallback** (`@hkl/analysis`): a note too short for the K-weighting momentary window falls back to a loudest-window RMS gain instead of null → the note normalizes instead of going silent. This distinguishes *clean-but-short* (keep) from *noisy* (skip).
2. **Per-layer skip on post-gain noise floor** (`buildHki`): the reliable whine predictor is `gain × cleaned pre-roll floor` (a clean high note with a big gain is fine; a noisy one isn't — gain alone mis-ranks). Drop any layer over **−45 dBFS** (clean 26 dB gap in the data between F#6 −56 and A6 −30) and report it; playback falls back to the nearest surviving layer via `pickLayer`. Never empties a note (keep the least-noisy layer if all fail).
3. **Auto-retry-once** (`loop.ts`): re-record a yellow take once — failed gate, post-gain noise over threshold, or a **local gain outlier** (> 1.6× the sliding same-velocity median; same-velocity gains trend smoothly with pitch so a spike like A4's 105× vs ~65× neighbours stands out without flagging the whole quiet top register). Keep the cleaner take.

**Rejected**: an SNR-aware **gain cap / any volume adjustment** (Max: don't touch note volume beyond velocity + layer softening — cap it or skip it); using **raw gain** as the skip signal (mis-ranks clean-high vs noisy-high); flat gain cap (penalizes clean high notes that just need a big boost); recording high notes louder (whine scales with master volume → no SNR gain, and it costs the inter-layer data).

**Verified**: replicated the classification on the real `(1).hki` — C6 rescued (fallback 111.8×, kept), A6/C7/D#7/F#7/A7/C8 skipped (−24…−30), A4/C5/D#6/F#6 kept (−56…−64). Smoke `normalizationTest` (fallback gives a real gain, clean kept / noisy skipped) + typecheck/build/boundaries. By-ear on a fresh capture is Max's gate — confirmed major improvement.

**Where**: `packages/analysis/src/normalize.ts` (`measureDecay` fallback), `apps/orchestrator/src/analysis/clean.ts` (`cleanCapture`, `assessRaw`, `postGainNoiseDb`, `POSTGAIN_NOISE_SKIP_DB`), `.../analysis/buildHki.ts` (per-layer skip + `skippedLayers`), `.../capture/loop.ts` (assess + auto-retry + local-outlier), `.../ui/stepCapture.ts` + `stepExport.ts` (whine profile threading + skip report).

## Composer instrument identity is a name HKL resolves against its dropdown (2026-07-14)

**Context**: Playback of multi-part imported scores (e.g. a Viola+Piano sonata) moved the cursor and lit keys but produced **no audio**. Root cause: instruments were identified by an opaque `hkl:instr` sample-set *key* passed verbatim to HKL, but (a) the MusicXML importer hardcoded `hkl:instr="piano"` on **every** part and (b) HKL has no `"piano"` sample-set key (its piano sets are `splendid_piano`, `maestro_piano`, …). So HKL's per-event instrument load was skipped (guarded by `INSTRUMENTS[key]`) and every `noteOn` early-returned at the unloaded-instrument gate — silent — while the visual/cursor path (independent of instrument) still ran. Composer's `TIMBRE_OPTIONS` key vocabulary had also drifted from HKL's dropdown (case + `piano`/`vibraphone` mismatches).

**Picked**: collapse instrument identity to a single free-text **name** (the `<staffGrp>`'s `<label>`), and make HKL own the name→timbre resolution:
- **Composer** removed `instrKey`, `hkl:instr`, and the Setup timbre dropdown (`TIMBRE_OPTIONS`). An instrument is just a name; the Add-instrument dialog collects name + staff count. `buildPlayback`/`buildPedalEvents`/`composer-instruments`/`composer-active-instrument` send the name verbatim. MusicXML import names each part from `<part-name>` and writes no `hkl:instr`.
- **HKL** `resolveInstrumentLabel(name)` matches the name **case-sensitively** against the live `#waveform` dropdown option TEXT (so user-imported instruments participate for free) and falls back to the "Piano" option's key (guaranteed present as the base instrument) when nothing matches. Resolution runs once at the bridge boundary (play-score events + pedals, composer-instruments, composer-active-instrument) so all downstream scheduler code keeps reading a valid `.instrumentKey`.
- **Pizz/arco** moved from a Composer-computed variant *key* to a notation-level `pizz` **flag** on the event; HKL owns the base-key→pizz-variant map (`ARTIC_VARIANTS`) and applies it after name resolution.

**Consequences / accepted limits**: it's the user's job to name a Composer instrument to match an HKL dropdown label; a mismatch (or an unrecognized imported part name) plays Piano — the stated safety net. Two parts with the same label collapse to one HKL instrument identity (pre-existing; fine for now). Single-instrument scores are unchanged: they send no name and play through HKL's active instrument (historic behavior — the user picks the sound in HKL). Removing `TIMBRE_OPTIONS` deletes the Composer-vs-HKL "keep-in-sync" antipattern outright.

**Rejected**: keeping the opaque-key contract and just remapping `"piano"` (leaves the vocabulary-drift antipattern); fetching HKL's dropdown labels over the bridge to populate a Composer picker (Max: not worth the complexity); case-insensitive / fuzzy matching (case-sensitive is predictable, Piano fallback covers misses).

**Where**: `packages/bridge/src/protocol.ts` (`instrumentName`/`pizz` wire fields), `apps/composer/src/{model/index.ts,instrumentsDialog.ts,importMusicXml.ts,main.ts,render/playback.ts}`, `apps/hkl/src/bridge/hkl-side.ts` (`resolveInstrumentLabel`, `ARTIC_VARIANTS`, `resolveEventInstrument`, resolve at ingestion).

## VoiceId decouples audio-voice identity from lattice KeyId (multi-instrument same-note overlap) (2026-07-14)

**Context**: Two different instruments could not sound the same (q, r) at the same time. The `KeyId` `"q,r"` served as BOTH the lattice/visual identity and the audio-voice identity: `audio.activeOscs`, `sustainedKeys`, and the SampleEngine's voice map were all keyed by it, and `noteOn` early-returns when a key is occupied. Composer worked around it with a topmost-wins dedup that dropped the lower instrument's duplicate note. There's no UX reason for the limitation — the same lattice cell can legitimately be voiced by multiple overlapping instruments.

**Picked**: introduce a `VoiceId` (`apps/hkl/src/types.ts`) as the AUDIO identity, distinct from `KeyId` (the visual identity). `voiceId(key, instrumentKey?)` returns the bare `KeyId` when no instrument is given (live input, single-instrument playback — byte-identical to before) and a composite `instr\0q,r` when one is. The SampleEngine was already voice-key-agnostic (opaque string), so the change is entirely in HKL's app layer:
- **Engine** (`audio/engine.ts`): `activeOscs`/`sustainedKeys` key by `VoiceId`; `noteOn`/`noteOff`/`glideVoices` operate on it. Voices now carry their `q,r` (on the `Voice` object) so `activeOscs`-iterating ops (`rampActiveFreqs`) read the coord from the voice, not by parsing the key. Live reconcilers that RE-attack (`syncAudio`, `replayActiveNotes`, `changeWaveform`) skip composite voices (`coordOf(k) !== k`) — they own only live voices; playback owns its own.
- **Scheduler** (`bridge/hkl-side.ts`): per-voice bookkeeping (`heldKeys`, `voiceSeq`, `pedalSustained`) keys by `VoiceId`; the visual highlight is refcounted per coord (`playbackVoiceCount`) so a lattice cell stays lit until ALL instruments' voices on it release. The old `voiceInstr` same-instrument-glide guard is gone — a VoiceId lookup enforces it inherently.
- **Composer** (`render/playback.ts`): the cross-instrument drop is replaced by same-instrument-only unison collapse (dedup by `(instrumentName, pitch)` within an onset) — different instruments overlap; two voices of one instrument at one pitch/onset still collapse to one (they'd share a VoiceId). Two parts sharing a name resolve to one instrument and collapse too (accepted same-label behavior).

**Scope**: multi-instrument PLAYBACK only (Max). Live multi-instrument input isn't a concern; live-selection ops (transpose, clear, record snapshot) skip composite voices so they never touch playback voices.

**Rejected**: a secondary `overlapOscs` map for just the "loser" voices (splits voice state across two maps; branches pedal/slur/aftertouch everywhere). The VoiceId split is the conceptually correct model and keeps every non-playback path byte-identical.

**Verified**: typecheck / build / check:boundaries / `pnpm test:composer` (328, incl. `phase5_crossInstrument_samePitchOverlap` = both kept, `phase5_sameInstrument_unisonCollapses` = one kept). Runtime overlap is Max's by-ear gate on the Sonata.

## Lazy per-voice pan: StereoPannerNode only when a pan is specified (2026-07-23)

**Context**: Consumer-side analysis of `@hkl/engine` for Intonalogy (React Native, RNAA — Phase 2 of docs/hkle-extraction.md) found the engine has no pan control. Requirement: Web Audio −1..1 pan, added without disturbing existing consumers (HKL, MusiQuest, react-consumer, engine-smoke).

**Picked**: per-voice `StereoPannerNode` spliced as the voice's outermost node (`pressureGain → panNode → master`), created **lazily — only once a pan is actually specified** via `sSetVoicePan(voiceKey, pan, rampSec?)` or the new optional trailing `pan` arg on `sNoteOn`/`sNoteOnFaded`. Outermost placement survives seam-crossfade source rotation (seams reconnect into `voiceGain` only). Feature-detected: hosts without `createStereoPanner` no-op silently. Engine **2.4.0** (additive).

**The trap that forced laziness**: a StereoPannerNode at pan=0 is NOT transparent for mono sources — the equal-power center law emits cos(π/4) ≈ 0.707 per channel, ~3 dB below the plain mono→stereo up-mix copy an unpanned voice gets. Unconditionally inserting a panner in every voice would have audibly quieted every mono-sampled instrument in HKL. Lazy creation keeps never-panning consumers' graphs byte-identical to the pre-pan engine. Accepted wart (documented in README/engine.md): a voice explicitly panned to 0 sits ~3 dB below a never-panned mono voice — inherent to equal-power panning, consistent within any consumer that pans everything.

**Mid-note splice**: `pressureGain.disconnect(master) → connect(panNode) → panNode.connect(master)` applies atomically at a render-quantum boundary; in the note-on path it runs inside the pre-start scheduling lead anyway (≥5 ms), so the common case wires before any audio renders. `pan` is a native AudioParam — none of the aftertouch Firefox anchor polyfill applies.

**Rejected**: unconditional per-voice panner (the −3 dB mono trap above); mono→stereo pre-upmix at decode to make center transparent (doubles mono PCM memory for a feature HKL doesn't use); pan on `segmentLooper` (Max: skip — its caller owns the destination node and can pan outside).

**Verified**: `pnpm typecheck` + `pnpm check:boundaries` + `pnpm --filter @hkl/engine build` green; engine-smoke exercises lazy splice / node reuse / note-on pan arg / absent-voice no-op / missing-`createStereoPanner` no-op against the stub ctx; react-consumer smoke asserts the lazy panner appears on a real `AudioContext` through the built package.

**Where**: `packages/engine/src/samples-engine.ts` (`ensureVoicePanNode`, `sSetVoicePan`, `pan?` args, voice `panNode` field), `packages/engine/{package.json,README.md}`, `test/engine-smoke/index.mjs`, `test/react-consumer/src/App.tsx`, `docs/architecture/engine.md`, `docs/hkle-extraction.md`.

## Ramp-aware seams: every-step reschedule, analytic trajectory, no getter reads (2026-07-24)

**Context**: Intonalogy's live retune stress (hold a button, `sRampFreq` ±1¢ every few tens of ms) produced a loud hiccup at every loop seam while ramping, plus occasional wildly-wrong landing pitches on Android. Reproduced in `test/ramp-stress/` (one voice, hold-to-step harness). Root cause chain: (1) `sRampFreq` cancelled any pre-scheduled wrap-aligned switch and DEFERRED rescheduling to a re-anchor timer that only fired after the ramp settled — under continuous stepping "settled" never arrives, so the clean seam path starved; (2) the only remaining wrap path was `doImmediateSwitch`, which splices from the CURRENT mid-segment playhead to a new segment's `a` — not the validated `b→a` pair, phase-unvalidated → audible hiccup at every wrap while ramping; (3) all seam paths propagated rate via the `playbackRate.value` getter and gave new sources a constant snapshot with no ramp events — mid-ramp the getter is host-dependent (computed on Chromium, last-set on some hosts; RNAA/Android suspect), and a poisoned read at a seam sticks as the voice's rate (the wrong-pitch landings, if the hold ends right after that seam).

**Picked**:
- **Analytic trajectory, never the getter**: `rateAtTime`/`positionAtTime`/`timeAtPosition` evaluate the anchor + `pendingRamp{Start,End,R0,R1}` piecewise (constant r0 on [t0,rs], linear ramp on [rs,re], constant r1 after; position inversion solves the quadratic — `(−r0+√(r0²+2kd))/k` is the forward crossing for both ramp signs).
- **Ramp-aware switch time**: `scheduleSegmentSwitch` computes the wrap moment via `timeAtPosition`, so the crossfade lands sample-accurately on the validated `b→a` pair mid-ramp.
- **Ramp-carrying new sources**: `carryRampOnto` schedules value-at + the remaining linear leg on each new source — old and new follow the SAME trajectory through the crossfade (phase-locked), and the ramp survives the seam instead of freezing at a snapshot.
- **Every-step reschedule** (Max: "every-step is the correct approach"): each `sRampFreq` commits the in-flight ramp (`commitRampSync`, rs===t0 invariant), cancels + re-schedules the pending switch under the new trajectory. A crossfade already in flight is never yanked — identical ramp events go on BOTH sounding sources and the commit timer reschedules.
- **Re-anchor timer deleted**: with the trajectory fully analytic there is nothing to defer; removing it eliminates the stale-snapshot race class it existed to patch. Seam commits normalize the pending-ramp bookkeeping instead (`normalizeRampAtAnchor`; a ramp lingering after the last step is clamped analytically and cleared at the next seam).
- **`doImmediateSwitch` demoted to backstop** (playhead already at/past `loopB` after an extreme JS stall), itself fixed to analytic rate + ramp carry. **`SeamEvent.kind: 'wrap' | 'immediate'`** (additive) makes the distinction observable; the ramp-stress harness counts both.

**Accepted approximation**: a ramp issued mid-crossfade anchors with constant-r0 over the ≤30ms [switchTime, rs] stretch — µs-scale buffer-position error at cent-scale steps, far below seam tolerance.

**Verified**: headless harness drives — strings 400×1¢@50ms/60ms (16 seams), 600×1¢@15ms with overlapping 100ms ramps, −400×1¢@30ms down, winds + brass 300×1¢@40ms: **all 0 immediate seams, settled drift 0.00¢**; no-ramp sustained hold (8s, 7 wraps) unregressed. `pnpm typecheck` + `check:boundaries` + engine build + engine-smoke + react-consumer smoke green; HKL headless load/play spot-check clean. **By-ear pass on the harness is Max's gate; Android/RNAA re-test is the Phase-2 acceptance.**

**Where**: `packages/engine/src/samples-engine.ts` (trajectory helpers, `carryRampOnto`, `normalizeRampAtAnchor`, `sRampFreq` rewrite, `SeamEvent.kind`, re-anchor removal), `test/ramp-stress/` (seam-kind counters), `docs/architecture/engine.md`, `docs/hkle-extraction.md`.

## t=0 timeline seed on every non-default AudioParam write (engine 2.4.1, 2026-08-13)

**Context**: Intonalogy (react-native-audio-api 0.13.2, Android) root-caused a click at the seam rate to the born-silent idiom: `gain.value = 0` + `setValueAtTime(0, futureT)`. RNAA defers the `.value` setter AND resolves evaluation before the first timeline event from the param's **constructor default** (1.0), never the intrinsic value — so every source start (note-on + every seam) rendered its first sample at unity gain, injecting the raw buffer value additively. Audibility tracked segment-entry amplitude, disguising an all-instruments bug as a one-instrument bug. Zero browsers reproduce it (spec-conforming intrinsic-value fallback). Full report: `handoff/hkle-born-silent-gain-fix.md`.

**Picked**: pair EVERY `.value = x` write whose `x` can differ from the param's constructor default with `param.setValueAtTime(x, 0)` — t=0 is unconditionally in the past, so the seed is always the earliest event and the timeline is authoritative from birth on every host; it cannot interfere with later events (audit: no post-creation `.value =` writes exist anywhere in the engine — all later control is timeline-based). Eleven seeds: the report's five verified born-silent gains (`sNoteOn`/`scheduleSegmentSwitch`/`doImmediateSwitch`/`sNoteOnFaded` segGain/newSG + segmentLooper `newGain`), plus the same-class audit: segmentLooper `g0` gain (latent audible bug whenever `gain ≠ 1` — the moment `schedulePending` queues future fade-out events, the whole pre-switchTime region resolves to 1.0 on RNAA; first segment only, later gains have past events by the time they're current), `carryRampOnto`'s rate write (covers both seam paths; one wrong-rate first sample = sub-sample position offset, inaudible but same defect), and the direct `playbackRate.value =` writes (sNoteOn, sNoteOnFaded, segmentLooper ×2). Writes intended at the default (voiceGain/damperGain/pressureGain/sampleMaster = 1.0) stay bare — the wrong lookup returns the right value. Canonical rationale comment lives at `scheduleSegmentSwitch`; engine-wide convention documented in `docs/architecture/engine.md` → Host AudioParam contract.

**Rejected**: a wrapper helper (eleven one-liners across two files read cleaner inline next to their params); fixing only the report's five sites (the audit surface is the same defect class and the report itself recommends covering it); relying on upstream RNAA fixing the divergence (HKLE is BYO-AudioContext — the contract must not assume spec-exact pre-event semantics).

**Verified**: reporter measured ~50 defects/10s → **exactly 0** on-device with the gain seeds applied (their patch, same sites). Our side (seeds must be behaviorally invisible on spec hosts): `pnpm typecheck` + `check:boundaries` + engine build green; engine-smoke + react-consumer smoke pass; headless ramp-stress drive — strings sustained 8s (12 wrap seams), strings 200×+1¢@30ms, winds 150×−1¢@40ms: **0 immediate seams, settled drift ≤ 0.0001¢, 0 rejected calls, no page exceptions**. dist manifest confirmed 2.4.1.

**Where**: `packages/engine/src/samples-engine.ts` (5 gain + 3 rate seeds, canonical comment), `packages/engine/src/segmentLooper.ts` (2 gain + 2 rate seeds), `packages/engine/{package.json,tsup.config.ts}` (2.4.1), `docs/architecture/engine.md`, `docs/lessons.md`.

## Cancel pending switches at switchTime, not now (engine 2.4.2, 2026-08-14)

**Context**: Intonalogy (engine 2.4.1, web + native alike) reported two one-cause symptoms from `cancelPendingSwitch`: a click on every note onset (attack fade deleted → silence-to-full in ~1.5ms where `sNoteOnFaded(dur=0.1)` should ramp 100ms) and a hard `setValueAtTime` throw inside the fade window. Cause: the function's teardown restored `oldSegGain` to `v.vol` anchored at `now` — written for the mid-crossfade case, where the gain sits at steady `v.vol`. But `segGain` also carries the voice's own attack (sNoteOn's 4ms `ATTACK_FADE_S` ramp, sNoteOnFaded's 100ms equal-power `setValueCurveAtTime`), which sits earlier on the same timeline, and every looping voice carries a `pendingSwitch` from birth. Cancel before the attack started → `cancelScheduledValues(now)` deleted the fade and the 5ms restore drove the gain to full before the source's start (click); cancel with the attack in flight → `setValueAtTime(now)` landed inside the live curve (throw on strict hosts). Reachable from every teardown/retune path — `sNoteOff`, `sHardStop`, `sRampFreq`, `sSlideAndFadeOut` (the report missed this one), defensively `scheduleSegmentSwitch` — so a retune sweep over future-scheduled voices clicked every note of a sequence. Report: `handoff/hkle-cancel-pending-switch-attack.md`.

**Picked** (the report's own proposal, verified correct against source): branch on `now < p.switchTime`. Crossfade not yet begun → `cancelScheduledValues(p.switchTime)` only — everything `scheduleSegmentSwitch` put on `oldSegGain` sits at/after `switchTime`, so cancelling there removes exactly those two events and leaves an unstarted/in-flight attack intact; nothing to restore, the voice's own envelope is left alone. Crossfade in flight → the existing 5ms restore, unchanged. This also removes any `setValueAtTime` from the pre-crossfade path, so no event can land inside a live curve from this function.

**Rejected**: consumer-side avoidance (no call site avoids the function; the reporter confirmed no app-side workaround exists — their TEMPORARY `Pitch.tuneTo` guard should now be removed); `cancelAndHoldAtTime`-based restore (changes the designed in-flight behavior, and the hold semantics diverge across hosts).

**Flagged, not fixed** (latent, unhit by current instruments): (a) a sample whose loop segment is shorter than its attack would make `scheduleSegmentSwitch` itself schedule `setValueAtTime(v.vol, switchTime)` inside the live attack curve — same throw class, different site; (b) the in-flight restore reads `gain.value` after `cancelScheduledValues(now)`, so "restore from wherever it reached" actually reads the post-cancel value (snaps rather than ramps).

**Verified**: scratch before/after repro against the built dist (scratchpad, both symptoms): Chromium `OfflineAudioContext` PCM render — retune-before-start onset rise-to-50/90% of steady RMS: before **0/0ms** (the click), after **20/46ms** vs untouched control 21/44ms; Firefox 152 real-time — `sNoteOff` inside the fade window: before `NotSupportedError: AudioParam.setValueAtTime: Can't add events during a curve event`, after clean. Regression: headless ramp-stress 400×1¢@50ms/60ms (the fix's hot path — every step cancels + reschedules): **0 immediate seams, 38 wraps, 0 rejected, settled drift −0.00004¢**; `pnpm typecheck` + `check:boundaries` + engine build + engine-smoke + react-consumer smoke all green; dist manifest confirmed 2.4.2.

**Where**: `packages/engine/src/samples-engine.ts` (`cancelPendingSwitch`), `packages/engine/{package.json,tsup.config.ts}` (2.4.2), `docs/architecture/engine.md`, `docs/lessons.md`.

## Seam-lag refinement + forte-only phil-cello + compare harness (2026-08-17)

**Context**: Intonalogy handoff quality pass. The shipped phil-cello (`strings.hki`) measured as-played (trend applied engine-style to the shipped mp3s): 8/16 samples carry seams above the −10 dB residual gate that was live at build time — worst Fs4 −3.3 dB — and mixes dynamics (G2/B2/F3 fortissimo among forte). Diagnosis: two seam failure modes — (1) period misalignment: the +ZC grid aligns vibrato-FM material only to the average period (Fs4 −3.3 → −11.0 dB with a 6-sample b-shift); (2) shape divergence near the release tail of Philharmonia's ~2.1 s "15" bucket (B5: best-lag only −4.7 → −6.7 dB; the source has ~1 s of usable sustain, hard ceiling — no longer arco-normal bucket exists). The dynamics mix is a symptom of (1): red tier fires the `filePatterns` fallback, and the forte takes went red under fixed-phase validation while `15_forte` actually covers C2–C6 gap-free.

**Picked**: (a) `seamLagRefine` in `selectSegmentsCore` (opt-in `gateOpts`) — per-pair b-side lag search (±0.6 periods, coarse-to-fine, full-window-in-buffer clamp) run BEFORE the corr gate, refined b emitted; forte G2 3 → 24 valid pairs, full 49-note run ~15 s. (b) `phil-cello-v2.json`: forte-only patterns, `seamLagRefine: true`, `xfadeResidualDbMax: −14` (drone use case) → 12 picks, all seams ≤ −14.1, single dynamic — but a 10-st As3–F4 hole. Probes at −12/−10 staged alongside for the by-ear call (gap-free at −10, worst −10.1). (c) `compare.html` in the analyzer: A/B harness playing both builds through the production engine path with as-played metrics + seam-zoom visuals (see architecture/analyzer.md).

**Rejected**: patching the shipped manifests' b values in place (lag-refined endpoint rescue fixes only 8/15 bad seams; the top octave needs re-search, and rebuild-from-source is strictly better); replacing the low trombone samples from FluidR3 (survey: Bb1–G2 is one zone-locked rendered source — every note has the same 5–6 dB attack splat; the attack fix is trend-head shaping at build time, full-set phase); alternative sample sources (explicitly out of scope until the in-source route is exhausted).

**Flagged**: residual gate is non-monotonic in picks — −12 lost C2 while −14 and −10 keep it (distance-descending greedy admits long-marginal pairs at looser gates, displacing short clean ones via endpoint separation). Per-note gate-ladder composition (tightest gate yielding ≥3 segments) is the likely full-set mechanism. Also: v1's shipped-vs-predicted residual discrepancy remains unexplained (gate was live on 2026-07-11 but −3…−9 dB seams shipped); v2 as-played now matches predicted exactly (C2 −15.1 both), so the harness measures what plays and the question is moot for rebuilds.

**Verified**: `pnpm typecheck` + `check:boundaries` + `@hkl/analyzer` build green; harness headless-verified (19-row union render, seam-zoom, query-param loading; as-played C2 −15.1 = report −15.1). By-ear pass on the harness is Max's gate before anything replaces `handoff/intonalogy`.

**Where**: `packages/analysis/src/analyzer-analysis.js` (`seamLagRefine`, `refineSeamLag`, pair-loop, `selectForCands` pass-through, `selectedSeamStats.bLag`), `apps/analyzer/configs/phil-cello-v2.json`, `apps/analyzer/{compare.html,src/compare/main.ts,vite.config.ts}`, `apps/analyzer/out/compare/` (staged builds + index.json), `docs/architecture/analyzer.md`.

## Perceptual seam selection: minimize, don't filter (2026-08-18)

**Context**: With clicks eradicated (residual gate + lag refinement), the remaining audible loop artifacts on the Intonalogy cello were wrap-aligned bumps/wahs, ear-confirmed via the compare harness's solo-seam looper as H1 (flash-aligned). Diagnosis chain, each step ear-validated by Max: (1) Δφ modulation-phase chop, severity ordering red>yellow>green confirmed; (2) FM channel was missing and is dominant for strings — added via harmonic-locked pitch tracks (weak-fundamental low strings: Ds2 h1 −23 dB, C2 −42 dB, broke fundamental-locked tracking both ways — first ±0¢ false-negative, then octave-junk false-positives); (3) vibrato-vs-artifact discrimination requires CROSS-HARMONIC RATE AGREEMENT — correlation is fooled by bow jitter (common-mode but aperiodic; open C2 h3↔h2 corr +0.80 at scattered rates), and depth must be sinusoid-amplitude-at-rate, not std; (4) the vibrato-free bump (open C2, all seams audible, worst first) is PER-PARTIAL SPLICE DISCONTINUITY — independent partial beats teleport the spectral snapshot (worst seam +7.4 dB partial step, carrier phases aligned, residual −15 dB), invisible to total residual; measurement windows must resolve partial spacing (≥3 cycles of f0) or "per-partial" becomes band mush.

**Picked**: `seamPerception` layer in selectSegmentsCore + `seam-perception.js` (profile built once per sample, memoized). Three stages — catastrophe-only admission (0.4 cyc / 8 dB), quality-bucket-first greedy ordering with distance-ordering coverage fallback (quality-first can strand the SCC — clean pairs that don't overlap), and post-SCC quality prune to ear targets (0.15 cyc / 2.5 dB / 3 dB, wrap-rate-scaled below 0.5 s pair length) while ≥3 segments remain, bridges never dropped. Ear calibration: audible partial steps started at 2.6 dB, clean control ≤1.2 dB; /16 maps dB onto the Δφ severity scale. Plus: pickSamples tiebreak ranks worst kept-seam severity between tier and segment count. phil-cello v3 ships C2 all-green (was p7/p6/p3), 14 picks C2–B5, max gap 6 st, residual relaxed to −10 (perceptual layer carries the quality load — the −14-vs-gap tradeoff from 2026-08-17 dissolves).

**Rejected**: hard gates at audibility thresholds (starved coverage: 7 picks, whole low octave red — sources with inherent beats can't meet 2.5 dB and still deserve their best seams); per-note threshold ladder (the prune achieves per-note adaptivity in one run); severity-weighted greedy without buckets (hairline severity diffs would override length and shred coverage).

**Fixed en route**: pickSamples empty-spine gap emitted `isHead:false` so the fill walk started at minMidi+S−1 and silently dropped the lowest usable note (only bites with zero greens — now common since the quality prune trims most notes to exactly 3 segments = yellow; lost C2 before the fix).

**Flagged**: G2-forte has never passed the pipeline (1 segment regardless of perception gates — my earlier python "24 valid pairs" was the approximation flattering it); B2-class similar. Bottom-octave coverage relies on neighbors. Repetition salience beyond the wrap-rate scaling (a p1 seam at 9 wraps/s is still audible per Max) may need a minimum-segment-length raise for drone use.

**Verified**: pnpm typecheck + check:boundaries + analyzer build green; v3 as-played metrics recomputed independently in the harness match intent (C2 ≤p2 all seams, Gs3 p0, remaining reds are min-keep floors); Max's by-ear pass on the staged v3 is the gate before handoff replacement.

**Where**: `packages/analysis/src/seam-perception.js` (new), `packages/analysis/src/analyzer-analysis.js` (admission/ordering/fallback/prune, profile build, diag), `apps/analyzer/cli/generate-samples.js` (tiebreak, gap-flags fix), `apps/analyzer/configs/phil-cello-v3.json`, `apps/analyzer/src/compare/main.ts` (metrics evolution), `docs/architecture/analyzer.md`.


## Slow-state step channel + A-weighted max-over-span partial admission (2026-08-18, addendum)

**Context**: Second C2 listening round: a seam shipped green while an audible ~740 Hz (h11) partial shift played through it, and the macro cause was a >1 s spectral onset tail the wrap kept re-entering. Two measurement holes: (1) partial admission used ONE mid-span window at unweighted −20 dB rel — anti-correlated with risk (a beating partial sampled at its dip is exactly the kind that steps at seams) and salience-blind (740 Hz is audible far below a 196 Hz anchor's level at C2's register); (2) nothing measured slow spectral evolution — level-flat, endpoint-matched settling passes RMS steadiness, trend flattening, and the instantaneous splice step alike.

**Picked**: admission by max A-weighted level over nine windows spanning the loop; new per-partial SLOW-STATE STEP channel (|300 ms-smoothed envelope at a − at b|) as admission bar + prune target + severity term in selector, picker tiebreak, and harness. Catastrophe admission bars raised 8 → 12 dB / 0.4 → 0.45 cyc (admission must not kill notes — 8 dB silently deleted E3 once the fixed admission saw more partials; the prune owns quality).

**Rejected**: interior drift RANGE as the settling metric — monotonically grows with segment length, so it systematically punished long segments (whole pick set reshuffled toward short ones, C2 dropped); slow evolution replayed over a long segment is gentle and musical, the defect is the endpoint-state mismatch the wrap resets.

**Found**: v3's green C2 was fake-green (blind admission); with honest metrics C2's seams are red (slow 5.6–7.6 dB) and STRUCTURALLY so: its amplitude-steady region (0.36–1.59 s) sits inside its spectral settling window (>1.2 s), so clean seams do not exist within the current steady-region constraint. Open per-note options: teach the steady region to extend across trend-flattened declining tails (pipeline change), or let the severity pick-tiebreak substitute the cleaner Cs2 repitched a semitone (it does this on its own when C2's severity is worse). Max's ear decides.

**Where**: `packages/analysis/src/seam-perception.js` (aWeightDb, multi-window loudPartials, partSlowEnvs, partialSlowStepDb), `packages/analysis/src/analyzer-analysis.js` (slow-step bar/target/severity, raised catastrophe bars), `apps/analyzer/cli/generate-samples.js` (tiebreak), `apps/analyzer/src/compare/main.ts` (mirrored), `apps/analyzer/configs/phil-cello-v4.json`, `docs/architecture/analyzer.md`.


## Gate audit: retire the inaudible, add pitch-state (2026-08-18, third round)

**Context**: Max: "make sure we aren't discarding candidate seams based on something I can't actually hear." Audit found the legacy amp-step gate at its 1% core default (0.09 dB) rejecting 20k–1.7M pairs per note — the true cause of the 3-segment ceiling (the quality prune was exonerated by measurement: disabling it changed almost nothing). Legacy-off reruns grew pools 30–50× with equal-or-better perceptual severities and extra segments. The 5¢ pitchStep gate was rejecting on 200ms-smoothed-curve vibrato wiggle (Fs4: 226k pairs, costing a segment), not on sustained pitch mismatch.

**Picked**: perception mode retires amp (kept as 0.30 ≈ 3 dB perf bar), slope, tilt, tiltSlope (∞), corr (−1; residual subsumes it — applyConfigDefaults marks vibrato-injected corr via _corrDefaulted so perception can override it). pitchStep replaced by the PITCH-STATE channel: 400ms-smoothed common pitch track (raw, pre-detrend; per-harmonic inharmonicity offsets cancel in a-vs-b differences), |state(a)−state(b)| in cents — target 3¢, bar 12¢, severity ¢/20 — tuning-honest and live on non-vibrato notes. Ordering severity uncapped to 1.0 (0.5 cap collapsed rough material into one bucket where length won the tie toward worse — E3 regression). Candidate thinning to a 10 ms grid in perception mode (the retired amp gate was the accidental perf throttle; a first attempt ran >10 min on exploded pools) with the lag-invariant partial-step bar moved before the lag search.

**Result (phil-cello v5)**: 46/49 notes usable (was ~14–20 across v2–v4), C4/D4 pickable for the first time in any build, E4/Fs4 at 4 mostly-green segments, mid-register largely p1–p4, 14 picks C2–C6 max gap 6 st, 43 s CLI run. C2 remains honest-red (structural: steady window inside its settling zone) and won its pick slot over Cs2 on measured severity.

**Flagged**: tail-cut samples measure ~+529 samples off in the compare harness (uncompensated decode shift — D4 seg0 shows an inflated p19 the selector never saw); Intonalogy compensates at runtime, the harness does not. Segment counts still mostly 3 — remaining ceiling is endpoint separation (0.1 s) × usable span geometry, no longer gate starvation.

**Where**: `packages/analysis/src/analyzer-analysis.js` (perception-mode legacy defaults, pitch-state bar/target/severity, uncapped ordering, pre-lag partial bar, candidate thinning), `packages/analysis/src/seam-perception.js` (raw common pitch track, pitchStateStepCents), `apps/analyzer/cli/generate-samples.js` (tiebreak), `apps/analyzer/src/compare/main.ts` (mirrored), `apps/analyzer/configs/phil-cello-v5.json`, `docs/architecture/analyzer.md`.


## Density round: retire the pick-thinning era (2026-08-18, fourth round)

**Context**: Max: 46/49 usable but only 14 picked with 5–6 st gaps — where are they? Answer: `pickSpacing` default 4, the CDN-era thinning policy, was deliberately discarding 32 usable notes, and the 5–6 st gaps were S=4 window-vote artifacts. Also: 3 segments/sample audibly cycles on held drones (shipped instruments carry 4–5), and the 0.1 s `minEndpointSepSec` — set before perceptual scoring existed — was the ceiling's last support.

**Picked**: phil-cello-v6 = v5 + `pickSpacing: 3` (the minor-third goal from the project brief; rough notes lose window votes to cleaner neighbors, so red-avoidance emerges from the severity tiebreak — native C2 lost to Cs2 automatically); perception-mode defaults `minEndpointSepSec` 0.05 (5.5 Hz vibrato puts 50 ms-apart endpoints 0.27 cycle apart — distinct seams, not duplicates) and `minKeepSegments` 4 (variety floor per Max).

**Result**: 21 picks C#2–C6, zero gaps > 3 st, zero red tier (41 green / 4 blue / 4 yellow), 4–6 segments per note, 520 KB bundle, 37 s run. As-played: bulk of seams p1–p3 green/yellow; residual seam-level reds are the floor-4 fourth-best seams and scattered Δφ cases.

**Where**: `packages/analysis/src/analyzer-analysis.js` (perception defaults), `apps/analyzer/configs/phil-cello-v6.json`, decisions above for the audit arc.


## Onset-overshoot sample gate (2026-08-18, fifth round)

**Context**: Max: the approved Gs5 has a level blip after the onset that no segment picker can fix (pre-steady, plays every note-on) — quantify it without false positives. Envelope inspection showed the defect class is a SLOW overshoot (attack swells 5.5 dB above eventual sustain at ~0.6 s, then sags), which a fast-vs-slow residue misses entirely (the bulge lives in the slow trend).

**Picked**: onsetOvershootDb = max(300 ms slow envelope − steady median) over [trim+150 ms, steadyStart], in seam-perception. False-positive guards: the rising attack can't trigger it (below steady by construction); first 150 ms exempt (percussive onsets = articulation — D2's 5.2 dB @0.03 s stays legal); threshold from the measured set distribution (defects 4.2–5.5 dB vs clean < 1.5 dB). Red bar 4 dB (`gateOpts.onsetOvershootDbMax`) with report reason; sub-bar values compete in pick votes at /16. phil-cello v7: Gs5 (5.3) and E5 (4.2) demoted, G5 auto-substituted, coverage unchanged (21 picks, gaps ≤ 3 st).

**Rejected**: fast-pop channel (|fast−slow| residue) — structurally noisy: the slow trend lags any steep rise, flagging half the set; deferred until that defect class appears (needs slope-aware fitting). Per-cycle fast envelope windows (2/f0) — sub-vibrato at high f0, inflating steady residue to 7–10 dB and drowning real defects; fixed 30 ms windows.

**Where**: `packages/analysis/src/seam-perception.js` (onsetOvershoot), `packages/analysis/src/analyzer-analysis.js` (stats emission), `apps/analyzer/cli/generate-samples.js` (classifyLoop demotion + reason, tiebreak term), `apps/analyzer/src/compare/main.ts` (mirror + detail-line display), `apps/analyzer/configs/phil-cello-v7.json`, `docs/architecture/analyzer.md`.


## Onset gate corrected: blip, not overshoot (2026-08-18, sixth round)

**Context**: Max rejected the fifth-round methodology: onset overshoot — even 1 s+ — is normal attack shape and must never gate (brass would be destroyed; E5 was wrongly demoted). The Gs5 defect is a QUICK blip mid-onset (at ~0.93–1.0 s, riding a smooth trajectory), qualitatively distinct, not merely "a bigger overshoot".

**Picked**: two-sided flank-extrapolation detector (linear fits on ±45–150 ms flanks; score = sign-consistent min residual — a blip departs from both predictions, a knee/swell sits between them and scores 0), normalized against the onset region's own p90 (NOT steady-region residuals, which are dominated by vibrato AM the flanks can't track — that mis-normalization sank two earlier formulations). Red iff ≥2.5 dB AND ≥2× local. v8: fires Gs5/G3/D4/G4 with per-report reasons at the true blip locations, restores E5, picks/coverage unchanged (21 picks, gaps ≤3 st, G5 covers Gs5).

**Rejected**: slow-envelope overshoot-above-sustain (fifth round — gates musical attack shape); centered-moving-average residuals (slope lag flags every steep rise); steady-region normalization (vibrato AM reference is apples-to-oranges vs a pre-vibrato onset).

**Where**: `packages/analysis/src/seam-perception.js` (onsetBlip replaces onsetOvershoot), `packages/analysis/src/analyzer-analysis.js` (stats), `apps/analyzer/cli/generate-samples.js` (classifyLoop bars + tiebreak), `apps/analyzer/src/compare/main.ts` (mirror + display), `apps/analyzer/configs/phil-cello-v8.json`; v7 delisted from the compare index.


## Vibrato-depth seams + set-relative gates (2026-08-18, seventh round)

**Context**: Max: (a) G5's first seam wraps into a pre-vibrato region — audible vibrato collapse, visible in the AM/FM strips; suspected legacy-gate casualty. (b) B3 sticks out as a harsher, differently-articulated attack "as if from a different dynamic band" — and what happened to the theorized set-wide gates? Answer: (a) was never a legacy gate — no retired gate measured modulation; the Δφ channel is structurally blind to vibrato PRESENCE (a flat trajectory has no phase). (b) The set-wide gates were theorized in session one and never built.

**Picked**: (a) modulation-DEPTH-step channel — same single-bin DFT as Δφ, magnitude instead of angle; |depth(a)−depth(b)| per active channel + a PRESENCE ratio bar (3×), because collapse understates in dB (G5's 8× ratio = 1.4 dB). Result: G5's kept seams all moved inside the vibrato region (a ≥ 1.04 s). (b) set-relative outlier gate in pickSamples: attackTonalLagMs (tonal onset = sustained harmonic-fraction > 0.6; B3 speaks in 5 ms vs neighbors' 30–85) and steadyBrightnessDb (B3: −6.2 vs −10.8 median) vs ±6 st usable-neighbor medians; demote at ≥ 0.4 audible severity with report reasons; borderline (0.31–0.34) only loses votes. B3's "late onset" percept resolved as its INVERSE: B3 is instant, the neighbors are late — set-relative framing was the only way to see it.

**Rejected**: source-level deviation as a demotion criterion — inaudible after gain normalization; a first cut demoted half the set on level alone (B2/C3/A3/C6 false positives). Level lives on as a half-weight tiebreak signal. Demotion bar 0.3 → 0.4 after the borderline cluster (15 vs 50 ms attack lags) showed the map's soft floor.

**Result**: phil-cello v9 — 22 picks, zero gaps > 3 st, G5 vibrato-consistent, B3/D2/G2/E2 out on stated audible grounds, borderline suspects retained but vote-handicapped.

**Where**: `packages/analysis/src/seam-perception.js` (ampAtT, modDepthStep + ratio, attackTonalLagMs, steadyBrightnessDb), `packages/analysis/src/analyzer-analysis.js` (depth bars/targets/severity/stats), `apps/analyzer/cli/generate-samples.js` (set-relative gate + tiebreak), `apps/analyzer/src/compare/main.ts` (depth-step mirror), `apps/analyzer/configs/phil-cello-v9.json`.


## Quality-first picker + soft variety floor (2026-08-18, eighth round)

**Context**: Max: As3 is as timbrally divergent as B3 (would rather gap Gs3→Cs4 than bridge with it); v9 admitted D3 with four terrible red seams while As2/C3 also shipped reds — "is there nothing better in that whole range, and why aren't we finding it?" Band inventory answered: there WAS better — A2 (worst seam 0.11), Cs3 (0.17), Ds3 (0.13) all skipped while As2 (0.34), C3 (0.32), D3 (0.70!) got picked. Two legacy-picker blind spots: TIER outranked seam severity in the tiebreak (green-but-red-seamed D3 beat clean-but-blue Cs3 — blue = bridge-shape, irrelevant to audibility), and fixed spacing windows skipped notes entirely (A2 fell between windows).

**Picked**: (a) quality-first picker in perception mode — severity-bucket greedy (0.1 buckets, legacy tiebreak inside a bucket) at ≥2 st separation, sub-red (sev < 0.3, `gateOpts.pickWorstSevMax`) only, plus a coverage pass that fills gaps > S with the best remaining sub-red at relaxed ≥1 st separation (rescued A2 next to Gs2). Gaps now emerge exactly where no sub-red material exists — preferred over bridging with an outlier, per Max. (b) SOFT variety floor in the quality prune: a 4th seam beyond 2× targets is a defect, not variety (D3's forced red 4ths); hard floor stays 3. (c) brightness outlier map sharpened (dev−1)/6 — As3 (3.9 dB brighter than neighbors) now detects at 0.48 instead of requiring the manual veto; F3 (darker outlier) also demotes. (d) `excludeNotes` config veto hatch. (e) CLI tiebreak bug: never learned the depth channel — fixed.

**Result**: v10 — As3/B3/D3/As2/C3 all out on stated grounds, A2/Cs3/Ds3 in, 19 picks. Remaining gaps (A2→Cs3 4 st, Gs3→Cs4 5 st, Fs4→As4 4 st) are deliberate: every in-gap candidate measures red or outlier. Answer to "why aren't we finding better": we now are — the low-mid rough zone (As2/B2/C3/D3) is genuinely the source's weakest material and the picker routes around it.

**Where**: `apps/analyzer/cli/generate-samples.js` (quality-first picker + coverage pass, brightness map, excludeNotes, tiebreak depth fix), `packages/analysis/src/analyzer-analysis.js` (soft floor), `apps/analyzer/configs/phil-cello-v10.json`.


## Unsteady vibrato, vibrato-depth set dimension, A2 veto (2026-08-18, ninth round)

**Context**: Max on v10: A2's first seam fails the ear test (prefers the Gs2–Cs3 gap); Ds3 has a Gs5-class vibrato mismatch + a click and "reads as sloppy unsteady vibrato". Forensics: Ds3 had `nCh 0` — its rate-locked FM depth (1.9¢) sits under the 3¢ channel floor because unsteady vibrato spreads energy across the band, so EVERY modulation gate silently switched off — the crack between coherent-vibrato (gated) and no-vibrato (nothing to gate). A2: selector-side seams clean AND as-played residuals clean (−16.4..−18.5, tail-cut notwithstanding); the harness red + Max's ear implicate the modulation channels on the (uncompensated) playback path — unresolvable by ear here, and his gap preference decides it.

**Picked**: (a) band-limited unsteady-vibrato sample gate: 3–9 Hz FM band energy minus the dominant line, red at ≥4¢ off-line AND ≥2.5× the rate line — catches rateless-FM cases (D3, A3). A first broadband-std cut demoted clean low notes on ZC tracker noise and missed Ds3 — rejected. (b) Ds3 itself is a SET-RELATIVE vibrato-depth outlier: rate line ±1.9¢ vs neighborhood ~±7¢ — its absolute numbers are the smallest in the set; only neighbor contrast is audible. Vibrato depth (log-domain) joins the set-outlier audible dimensions. (c) the sub-red pick bar applies to SEAM severity only; set-deviation ranks but does not bar below the 0.4 demotion level (a 0.31 set-deviation nearly cost the approved G5). (d) A2 excluded via the excludeNotes veto (first use).

**Notes**: E3 and G5 are excluded by the pick bar on real −5/−6 dB mid-fade partial-dip seams (an earlier probe under-printed dips — the metrics were right); G5's slot is covered by Fs5 (seamSev 0.17, tiebreak winner — needs Max's ear, it is a new face), E3's by the deliberate Cs3–Fs3 gap. HKL_PICK_DEBUG env var dumps picker severities.

**Where**: `packages/analysis/src/seam-perception.js` (fmUnsteadyCents/fmBandCents), `packages/analysis/src/analyzer-analysis.js` (stats), `apps/analyzer/cli/generate-samples.js` (unsteady gate, vibrato-depth set dimension, seam-only pick bar, debug hook), `apps/analyzer/configs/phil-cello-v11.json` (excludeNotes).


## Brass round: pick-bar leak, tail-margin bar, tonal-lag band fix (2026-08-18, tenth round)

**Context**: First non-cello run through the perceptual pipeline (FluidR3 trombone → `trombone_v2`, new config drops the legacy corr/rmsStep overrides). Three defects surfaced, none cello-visible: (1) the ninth round's "pick bar is seam-only" decision was never fully implemented — `worstSeamSeverity` still folded `_setOutlierSev` in, so sub-demotion set-deviation (including the inaudible source-LEVEL term) hard-barred G3/C2/Bb2 from picking (engineered loops make pure seam sev 0.02–0.07 set-wide, so set-dev dominated the entire ordering). (2) Five picks' seams ended 33–47 ms from the physical EOF — FluidR3 renders run hot to the last sample, quality-first ordering reaches deepest into the tail, and Db2's wrap landed past the browser's decoded end (loop died permanently; decoders disagree by up to an mp3 frame + the +529 cut shift). v1's retired throttle gates had been accidentally load-bearing (zero late-b segments in the shipped set). (3) `attackTonalLagMs`'s fixed k≤6 harmonic cap spans only 78–467 Hz at Eb2 where a bright forte trombone keeps ~30% of its energy — the 0.6 dominance fraction never crossed (verified: sustain fraction 0.19–0.35) and a silent fallback reported the steady-region start, manufacturing a bogus 585-vs-135 ms "attack cliff" that Max's ear (fast, aggressive low-zone onsets) correctly contradicted.

**Picked**: (1) remove the fold — set-deviation ranks via the `sev` blend, never bars (completes round nine's stated design). (2) `rejectByTailMargin` in `selectSegmentsCore`: refined `b` must leave ≥ crossfade + 100 ms of physical audio (the xfade-residual gate can't cover this — near-EOF windows return −Infinity = free pass). (3) harmonic band capped by FREQUENCY (all k·f0 ≤ 3 kHz, min 6 harmonics) and never-crossed emits null instead of a plausible-magnitude masquerade (nulls skip the set-relative median/gate). `HKL_PICK_DEBUG` now prints per-note blip/setdev/attack/brightness/vibrato — doubles as a candidate-soundfont coherence screen.

**Result**: trombone_v2 = 20 picks C2–Bb5 (v1: 16, D2 floor), all 8 segments/SCC ok, worst margin 133 ms, F4's late-b seam replaced (−13.1 → −22.2 dB residual). With the band fix the attack dimension is UNIFORM across the set (20–50 ms everywhere) — no attack cliff exists; the low zone is aggressive, not slow. Ab2 demotion stands on vibrato alone (±6.1¢ vs ±0.3¢ → 0.61): its exclusion removes the only sustained-character discontinuity at the zone boundary (brightness has no step; the feared §6 mass-firing on zone cliffs did not materialize). Low-zone picks reshuffled by the greedy cascade (C2 D2 E2 G2 Bb2); C2 ships with a 0.33 set-deviation flag (2.8¢ vibrato among flat neighbors) — exactly the sub-demotion class the seam-only bar is designed to ship rather than gap. Cello unaffected in artifacts (all picks ≥150 ms margin; shipped strings.hki untouched) but a low-end rebuild would now differ: D2/G2/E2 outlier verdicts and gap fills deserve a re-check whenever a v12 happens.

**Where**: `apps/analyzer/cli/generate-samples.js` (fold removal, debug decomposition), `packages/analysis/src/analyzer-analysis.js` (tail-margin bar + diag), `packages/analysis/src/seam-perception.js` (frequency-capped band, null fallback), `apps/analyzer/configs/fluidR3-trombone-v2.json`, compare harness (`trombone-v1-shipped` vs `trombone-v2-percep`, defaults). Lessons: "A ranking signal folded into a shared helper becomes a gate", "Tail-less sources: segment selection must own the end-of-file margin", "A bounded-band fraction measure degenerates…".


## Loudness evenness: Bark-band sones correction, attenuation-only (2026-08-18, eleventh round)

**Context**: Max, three times and correctly: trombone C2–G2 *sustains alone* sound significantly louder than the rest, at matched levels. Measured post-gain sustains were matched (−18.0 K-weighted across the set; flat RMS within ±0.7 dB), splat shoulder explained the first ~500 ms but not the steady state. The percept lives in neither the level domain nor a fixed spectral weighting: a Zwicker-lite model (Welch PSD → Terhardt outer-ear weighting → Bark-band E^0.23 summation) measures the low-zone sustains at **1.33–1.51× the set median** in sones — because they occupy 17–18 of 24 Bark bands vs 11 for mids and 5–6 for the top octave, and total loudness is the sum of compressive per-band loudness. Critical-band occupancy is structurally invisible to RMS and BS.1770 alike. Cello cross-check: nearly flat (0.87–1.20×, mild E4–F♯5 hump ≈ the octave-3–5 ascents Max noticed in Intonalogy scales) — consistent with Max parking the cello case but not this one.

**Picked**: `sustainSones()` in new `packages/analysis/src/loudness.js` (zero-dep; uncalibrated in absolute level — RELATIVE use only, documented). `cfg.loudnessEvenness` (0..1, default 0) in generate-samples: post-pick, per pick over its segment span at its normalized gain, notes above the pick-set median attenuate by evenness × 10·log₂(rel) dB (phon-dB heuristic); **attenuation-only** — Max: the natural high-note falloff usefully cancels brightness, do not boost highs. One-shot, not iterated (the blend factor is the ear-trim knob). Trombone config at 0.6: C2 −2.5 → G2 −3.6 dB, Bb2–Gb3 shoulder −1.5..−2.5, Ab3+ untouched; verified post-build lows land 1.17–1.25× (sones respond ~gain^0.46, so 0.6 halves the phon excess).

**Rejected**: boosting sub-median notes toward the target (breaks the brightness-canceling falloff, re-raises peak headroom questions); iterating to exact sone-flatness (model precision it doesn't have); consumer-side EQ (one curve for all notes cannot address BETWEEN-note loudness at matched spectra-weighted levels — this is per-note or nothing).

**Open**: peak-ceiling window bug stands unfixed (loop-path −3 dBFS ceiling measures the steady region only; low-zone attack peaks ship at −1.0..−2.1 dBFS — `measureLufs` already has `peakStartSample/peakEndSample` hooks). Max declined attack shaping (splat = breath-support realism). `backfill-gains.js` does not yet mirror loudnessEvenness — regenerating a corrected set requires the full pipeline. Blend 0.6 is a first guess pending the harness A/B (`trombone-v2-evenness` vs `trombone-v2-percep`, staged as defaults).

**Where**: `packages/analysis/src/loudness.js` (new), `apps/analyzer/cli/generate-samples.js` (loadConfig default, rawPath on records, post-pick correction pass), `apps/analyzer/configs/fluidR3-trombone-v2.json` (loudnessEvenness 0.6 + comment).


## Density thinning + winds control result (2026-08-18, twelfth round)

**Context**: Brass shipped (Max ear-approved v2E; attacks keep their perceptual difference as an explicit breath-support realism choice; `handoff/intonalogy/brass.hki` = fluidR3-trombone-ship.json under production key `trombone`). Winds control rerun (fatboy-clarinet-v2, gates-only minimal delta): 60/60 green both builds, zero gate firings, seam extremes improved (Db2 −10.6 gone; B6 −10.9→−14.1, A6 −11.4→−15.6; v1 had six picks worse than −15 dB, v2 one) — perception defaults validated on healthy material. But the quality-first greedy densified picks to ~2.2 st (18→27, +50% bundle): on a healthy set nearly everything is sub-red, so the ≥2 st separation becomes the effective spacing and pickSpacing only gates coverage fills.

**Picked** (Max): *never keep a pick between two fully-green picks that are ≤ pickSpacing apart.* Implemented as a final thinning pass in the perception picker, after the coverage pass: iterative worst-first (combined severity, then inverse legacy tiebreak) to a fixpoint — one-shot scans would over-drop runs that stop violating once one neighbor is gone. Thinning leaves gaps ≤ S by construction, so it can never re-open a coverage gap. Clarinet: 8 thinned, 27→19 picks, 397 KB. Trombone ship verified UNCHANGED (0 removals — its flanker spans all exceed 3 st), so the shipped brass predates nothing.

**Notes**: clarinet Bark-sones profile shows a mid-range hump (Ab3–E4 at 1.23–1.40× median, chalumeau ~0.95, altissimo 0.71–0.94) — Max reads it as the clarinet's natural registers, no evenness applied; app-side verification his. Shipped strings (cello v11, 17 picks ≈ 2.8 st at S=3) predates thinning — a future rebuild may thin it; re-audition applies.

**Where**: `apps/analyzer/cli/generate-samples.js` (thinning pass), `apps/analyzer/configs/{fatboy-clarinet-v2,fluidR3-trombone-ship}.json`, compare harness (clarinet v1/v2 as defaults).


## Strings parked at v11; v12 candidate rejected; next-phase direction (2026-08-18, thirteenth round)

**Context**: All three Intonalogy handoffs shipped same-day (strings v11 / brass v2E / winds thinned v2). A cello v12 candidate through the post-brass pipeline (pick-bar fix, tonal-lag band fix, tail-margin bar, thinning; NO evenness) produced 5 pick substitutions vs the shipped v11 (+E3 +Gs4 +F2 +G5, −Ds2 −Fs2 −As4 −Fs5).

**Picked** (Max): **strings stay at v11.** None of the v12 substitutions improve on what they replace and some are much worse — the v11 picks were each individually ear-verified and documented during the v11 rounds, and that adjudication is not being redone. **loudnessEvenness stays OFF for strings** (the E4–D5 hump is the projecting register, same policy as the clarinet's registers; also v12's quiet-side outliers F2 0.78×/E3 0.85× are exactly what attenuation-only cannot fix). Intonalogy's goal is achieved; the program pivots to a wider exploration/improvement sweep for HKL and other consumers.

**Next steps recorded in the handoff doc §10** (Max's priority order): (1) root-cause the v12 regression before trusting the pipeline on other string sources — lead hypothesis: the coverage pass lost its outlier guard when the pick bar went seam-only (E3/Gs4 entered v11's deliberate gaps on sub-red SEAM alone despite 0.32/0.33 set-deviation, violating "gap preferred over audible outlier"), plus the real-valued attack dimension possibly over-eager on bowed strings (Ds2). (2) Korg piano (HKLO): investigate per-velocity-layer gain recalculation with the Bark-sones model — sustained-span model needs a decay adaptation; between-layer dynamics ordering must be preserved.

**Where**: `docs/analyzer-perception-handoff.md` §§9–11 rewritten to current state; compare harness keeps cello-v12 as regression-study material.

## 2026-08-25 — Inflight-crossfade-cut repro harness: real-time capture in ramp-stress, injection-validated detector, no engine changes

**Context**: Intonalogy's third HKLE handoff (`handoff/hkle-inflight-crossfade-cut.md`, engine 2.4.2) — clicks when a note-off lands during an in-flight seam crossfade (Cause 1: unconditional `newSrc.stop(0)` in `cancelPendingSwitch`) and while retuning from a slider (Cause 2 hypothesis: `sRampFreq`'s in-flight gate races the audio clock). Max's reframe: live-tuning clicks are the pressing issue, and the engine's command-shaped tuning API (self-contained `sRampFreq` calls, hammered at 40ms by the consumer as a workaround) is the design gap to keep in view.

**Picked**: extend `test/ramp-stress/` (not a new harness) with an automated capture+detect mode — `src/repro.js` scenarios + AudioWorklet PCM recorder fed from `tapMaster` (44.1kHz real-time ctx, `--mute-audio` Chromium so runs are silent at the machine), `detect.mjs` (second-difference outliers vs block-local median, impulsiveness-gated), `run.mjs` CDP driver (own vite server on a fresh port; reuses `test/composer-test/lib/{chromium,cdp}.mjs`, which gained an optional `extraArgs`). Real-time rather than OfflineAudioContext because Cause 2 is a JS-thread-vs-render race that offline suspend/resume cannot exhibit, and offline wall-timer desync would corrupt the engine's commit bookkeeping. Every engine call is logged with a pre-call `pendingSwitch` snapshot — all `cancelPendingSwitch` invocations are triggered by harness calls, so cancels are inferred exactly with zero engine instrumentation (the engine under test stays pristine). The detector is gated per-run by injection validation (synthetic instant-dip-with-5ms-recovery cuts into the clean capture; 100% at depth ≥ 0.2, zero false positives required) — the handoff's analyze_seams.py lesson, first such detector in-repo. Verdicts are categorical (zero vs many), never count ratios. `--gate` mode (exit non-zero on any in-window defect) is the post-fix regression gate.

**Findings** (pre-fix baselines on disk in `test/ramp-stress/out/`): Cause 1 confirmed 12/12 in-window (mag 0.03–0.14 ∝ vol×progress×|sample|, deterministic per seam+offset); controls categorical zero. Cause 2 as-worded did NOT reproduce on desktop Chromium (60 snipes incl. 19 final-quantum straddles → zero cuts — see lessons.md 2026-08-25). The audible web-side tuning artifact is instead the **now+5ms deferral-clamp splice** (seam-dip floor 0.807 clean → 0.553 @20ms / 0.500 @40ms cadence; ten deepest dips all at call-gap exactly 5.0ms; one-ramp-per-gesture = zero degradation). Fix design is the next phase: the report's fade-then-stop + quantization-tolerant gates, PLUS the clamp-splice needs its own treatment, PLUS the API-level continuous-retune question (one long ramp per gesture already measures clean — strong signal that a follow/glide API for consumers like Intonalogy removes the whole exposure class).

**Where**: `test/ramp-stress/{run.mjs,detect.mjs,src/{repro,engine-setup}.js,README.md}`; lessons.md 2026-08-25 ×2.

## 2026-08-25 — Engine 2.4.3: never disturb an in-flight/imminent seam crossfade (fix for both measured inflight-crossfade-cut defects)

**Context**: the repro above confirmed two defects and killed one hypothesis. Cause 1 (sNoteOff mid-fade `stop(0)` step) reproduced 12/12; the Cause-2 stale-gate race did not reproduce on desktop Chromium (60 phase-aligned snipes, 19 final-quantum straddles, zero cuts) and gets no dedicated fix — blind fixes for un-pinned bugs aren't landed (Max). The measured live-tuning artifact was instead the `now+5ms` reschedule floor deferring fades past the validated wrap under retune cadence (seam-dip floor 0.807→0.500). Competing fix ideas: repair the retune+wrap conflict vs a continuous-retune engine API.

**Picked** (Max): **fix the contract — crossfades only ever run at their scheduled sample-aligned validated points; nothing defers a fade.** The continuous-retune API was rejected: it relocates Intonalogy's own hard problem into the engine without making it easier, is tailor-made for one consumer, and the cadence data shows it's unnecessary — with the splice fixed, fine-grained command streams are exactly as clean as one long ramp (`cadence-single` vs `cadence-pair40`, both at the 0.807 clean floor post-fix).

**Shape**: a single horizon constant `XFADE_GUARD_S = 12ms` (5ms reschedule floor + 2 render quanta for the two clock reads that can each straddle a boundary + JS execution budget — 8ms measurably still deferred under load, 3 seams in the sub-ms hammer scenario). Within it: `sRampFreq` takes the existing xfInFlight both-sources ramp path (fade completes on schedule; trajectory shift sub-sample); `sNoteOff`/`sSlideAndFadeOut` leave the fade running under the closing `voiceGain` — no gain surgery, no `.value` reads, incoming source stopped at release/glide end with its own disconnect cleanup (`sSlideAndFadeOut` glides both sources). `sHardStop` keeps its hard-cut semantics. The `now+5ms` floor survives as stall-only insurance and is observable: `SeamEvent.deferredMs` (non-zero under normal load = bug; the ramp-stress driver prints per-scenario deferral counts + seam-dip floors).

**Verified**: `run.mjs --gate` full set — R1 12/12→0/12, all controls zero, seam-dip floors restored to clean (r2 0.553→0.805, cadence-pair40 0.500→0.807, r2-sharpened 0.497→0.806 with 0 deferred after the 12ms widening), 113-seam snipe clean; typecheck, boundaries, engine-smoke, react-consumer (dist 2.4.3) all pass. Version dual-site bumped (tsup VERSION + changelog). NOTE: `test/ramp-stress/out/` now holds the post-fix captures — the pre-fix baseline WAVs were overwritten by the gate runs; the pre-fix numbers live in this entry, lessons.md 2026-08-25, and the scratchpad logs of that session.

**Where**: `packages/engine/src/samples-engine.ts` (XFADE_GUARD_S, sRampFreq gate, sNoteOff, sSlideAndFadeOut, scheduleSegmentSwitch deferral tracking, SeamEvent.deferredMs), `packages/engine/tsup.config.ts` (2.4.3), `docs/architecture/engine.md`, `test/ramp-stress/` (seamDipStats + driver printout), `test/react-consumer/run.mjs` (--mute-audio, keeping autonomous runs silent at the machine).

## 2026-08-29 — Composer Tier-1 render-latency fixes: theme repaints in place, view switches restore stashed DOM, redoLayout rejected

**Context**: the sonata (446 bars / 37 pages) profiled at ~4.5 s per page-view full render, ~6.7 s per page→scroll switch, ~6.4 s per theme change (Chromium; Firefox worse — up to 10 s observed). Baseline + full lever list in docs/composer-render-perf.md; this entry records the first tranche (Tier 1), scoped performance-only, ahead of Tier 2 (page virtualization + progress feedback) and Phase C (system-splice cascade).

**Picked**:
1. **Theme = DOM repaint, never a re-engrave.** `applyNotationTheme` was already fully reversible (dark tags the container + inline-paints noteheads; light removes both), so `Renderer.setTheme` is now a pure state setter and the theme handler calls the new `applyThemeToRendered()` on the existing DOM. Splicer and mode caches survive theme changes. 6.4 s → ~0.5 s on the sonata.
2. **View switches stash + restore real DOM nodes.** `renderComposer` grows a mode-change branch (`stashAndRestore`): the outgoing mode's container children are detached and stashed keyed on (render-serialize string, zoom, pageScale, theme); the incoming mode's stash is re-attached when the key matches, re-applying theme if it drifted while stashed. Detached REAL nodes — not HTML strings — so the scroll splicer's element refs stay valid across a round-trip and steady-state splicing resumes immediately after a restore. A mode-change cache MISS forces a full engrave (`forceFull` + splicer invalidate) — a splice must never target DOM the other mode owns. `renderComposer` returns `fresh: boolean`; main.ts skips page-only injections + crisp snap on a restore (already baked in). `forceFullRerender()` and the string-entry `render()` clear the cache. Switches with an unchanged doc: ~4.3 s/6.7 s → ~0.7–0.8 s (Chromium; dominated by the browser re-laying-out the re-attached SVG).
   - Key soundness: byte-equal serialize ⇒ identical xml:ids ⇒ render-equivalent DOM (placeholder-id drift makes any `replaceDocument` miss the cache naturally). Relies on the existing invariant that every model mutation re-renders before a mode switch can happen (all mutation paths funnel through reRender).
3. **redoLayout shortcut rejected** (implemented + reverted same day): `setOptions`+`redoLayout()` did not re-apply page geometry (scroll→page relayout yielded 2 pages instead of 37) and zoom relayout was a 0 ms silent no-op. See lessons.md 2026-08-29; DEAD END comment left in render.ts.

**Verified**: typecheck, composer build, boundaries, `HKL_INDEX_CHECK=1 test:composer` 328/328; headless probe asserts restored page counts (37 / 45 across zooms), scroll SVG width, single cursor overlay, and notehead fills across dark/light round-trips incl. the restore-with-stale-theme path. Awaiting Max's Firefox pass.

**Where**: `apps/composer/src/render/render.ts` (ModeCacheEntry, stashAndRestore, applyThemeToRendered, renderPage split, render() cache/splicer reset), `apps/composer/src/main.ts` (freshRender gate on injections, theme handler), docs/composer-render-perf.md, docs/lessons.md.

## 2026-08-29 — Composer Tier-2: virtualized page view + heavy-render deferral/coalescing (page edits 4.5 s → 1.25 s Chromium)

**Context**: after Tier 1 (see the prior entry), every page-view edit still paid a full 4.5 s pipeline: loadData 1.25 s + renderToSVG×37 1.8 s + ~1.3 s DOM post-processing, all synchronous and unannounced — Max's "extreme lag in page view" and "stacking repeated inputs". Verovio separates layout (loadData, all pages) from drawing (renderToSVG, one page), which makes drawing lazily an option; the layout pass itself is unbreakable on the main thread.

**Picked**:
1. **T2.1 — draw only pages the user can see.** The renderComposer path renders page 1, sizes fixed-dim `.score-page-pending` placeholders from its measured SVG box (BEFORE any observer exists, so a zero-height placeholder can't look "visible"), mounts viewport±1 pages + the cursor's page synchronously, and lazy-mounts the rest via IntersectionObserver (root #score, rootMargin 100%). Page-scoped injections moved from reRender's whole-container pass into a renderer-owned `onPageMounted` hook — exactly once per mount, because injectSectionHeaders translates systems (not idempotent). `ensureMeasureMounted` got its real page-mode implementation (measure id → `getPageWithElement` → mount) behind a DOM-presence fast path — locating an unmounted element needs the page layout in the toolkit, and a scroll engrave / PDF export may have replaced it (`pageVirt.tkCurrent`; reload once on demand, ~1 s). Virtualization state survives the T1.2 stash/restore (IO disconnected on stash, re-armed + visible pages mounted on restore). The string-entry `render()` keeps the legacy all-pages DOM (old tooling asserts on it).
2. **T2.2 — busy badge + coalescing instead of a progress bar.** The planned per-page determinate progress died with T2.1 (the loop is now ~2 pages; the dominant block is ONE loadData). Shipped: `renderer.predictNextRenderHeavy` (recorded last-full-engrave durations per mode + the exact splice test renderScroll uses, threshold 250 ms — small docs and splices stay fully synchronous, so all 328 fixtures and normal scores behave exactly as before); heavy renders defer via double-rAF + setTimeout so the static `#renderBusy` badge (sibling of #score; deliberately unanimated — nothing animates while WASM blocks the thread) paints first; re-render requests arriving while queued/frozen coalesce into one render of the latest model state; post-render DOM readers moved to an `afterRender()` queue (scroll-into-view at 6 call sites, viewInstr overlay refresh); file load/import handlers wrap parse + render in the badge (the `await file.text()` yields the paint).

**Measured** (headless Chromium, sonata, probe in scratchpad — pattern in [[project_composer_perf_repro]]): page full render/edit 4.5 s → **1.25 s** (loadData ~1.0–1.2 s is now ~90 %), zoom 4.0 s → **1.35 s** (correct 45 pages), page restore 0.75 s → **0.43 s**, theme ~50 ms, lazy mount 40–70 ms/page, 3-burst reRender → exactly 1 loadData, overlay spans all placeholders, busy badge cleans up after every step.

**Rejected/limits**: per-page determinate progress (moot, above); animated spinner (frozen thread); v1 limits accepted — selection overlays draw only on mounted pages, a section-header page grows on lazy mount (shifts pages below), scroll full engrave (~7 s) untouched. Remaining floors: loadData per page edit (T2.3 worker or Phase C), scroll engrave (Phase C).

**Verified**: typecheck, composer build, boundaries, `HKL_INDEX_CHECK=1 test:composer` 328/328, probe assertions on page counts/pending counts/lazy mounts/restore/theme/zoom. Awaiting Max's Firefox pass.

**Where**: `apps/composer/src/render/render.ts` (pageVirt, renderPage(virtualize), mountPage/mountVisiblePages/armPageIo, ensureTkHoldsPageLayout, ensureMeasureMounted, setOnPageMounted, predictNextRenderHeavy, lastFullMs), `apps/composer/src/main.ts` (reRender wrapper + afterRender + busy, onPageMounted registration, overlay sizing over placeholders, injectHeaderFooter selector relax, playback-position mount, import/load busy), `apps/composer/index.html` (#renderBusy), `packages/notation/src/verovio-types.ts` (getPageWithElement), docs.

## 2026-08-29 — View-switch atomicity under deferred renders: the mode class flips inside doReRender

**Context**: Max's Firefox pass of Tier 2 caught a torn view switch — selecting Scroll restyled `#score` to the scroll shape immediately while the page DOM stayed put for the whole deferred engrave. Cause: `applyViewMode` flipped the CSS class eagerly; T2.2's deferral separated that from the content swap by seconds.

**Picked**: `applyViewMode` no longer touches the class; `doReRender` calls `applyViewModeClass(renderer.getViewMode())` in the same synchronous block as `renderComposer`'s DOM write — class + content commit in one paint. During the deferred window the old view stays fully intact under the busy badge. Idempotent on every non-switch render. Boot's pre-render class set stays (correct background before Verovio loads). Probe-verified both directions (page DOM + `view-page` intact mid-deferral; atomic swap after; restore path 260 ms). Generalized as a rule in lessons.md: under deferral, every visible flip travels with the content swap.

**Where**: `apps/composer/src/main.ts` (applyViewMode, doReRender), docs/composer-render-perf.md status log, lessons.md.

## 2026-08-30 — Scroll splicer: one document-order measure coordinate system + tstamp2 span expansion + ending-glyph reconcile

**Context**: the 2026-08-30 probes confirmed two silent scroll-splice staleness bugs (lessons.md, same date): the model reports dirty ranges in document-order measure coordinates while the splicer + `serializeRangeForRender` counted direct `<section>` children — `<ending>` voltas split the frames, so converted edits after the sonata's voltas spliced stale and volta-internal edits always did; separately, `expandForSpanners` resolved only `@startid`/`@endid`, so an edit at a multi-measure (tstamp2-anchored) hairpin's host measure re-rendered a range the wedge couldn't resolve against — Verovio warned and dropped it, and the splice transplanted the loss.

**Picked**:
1. **Document order everywhere.** `sectionMeasures()` (all `<measure>` descendants of `<section>`, document order) feeds capture/splice order + sig maps; `cloneRangeStructure` counts the same way and clones `<ending>` wrappers carrying their in-range members; `runningScoreDefContext` walks the same stream (its old direct-children walk never matched a volta-wrapped target and consumed the whole section); `computeHeadSig` walks top-level siblings of the first measure's section-level ancestor.
2. **Runs contain whole endings** (`expandForEndings`): the run AND its context slots (two left, one right) are expanded until no touched `<ending>` is partial — a partially re-rendered volta would re-engrave its bracket over a different member set, and a wrapped context measure would taint the anchor. Adjacent 1st/2nd endings chain naturally.
3. **tstamp2 spans expand the run**: `expandForSpanners` also resolves `tstamp2="Nm+B"` as [host, host+N] (clamped); `pedal` added to the selector.
4. **`g.ending` reconcile in spliceDom** (found by the new fixture): Verovio draws each `<ending>` as a SYSTEM-level `g.ending` group (id = the ending's xml:id) containing the anonymous `g.voltaBracket`, with member measures as flat system children — measure imports never carry it, so the bracket stayed at its stale width when a volta's measures changed. The splicer now replaces the group from the sub-render for endings inside the run (on the run's dx/dy frame), drops orphans whose ending left the document, and cascades downstream groups with their measures (translate bookkeeping shares the tx/ty maps; bracket ids count as "present" in the cleanup).

**Verified**: three new fixtures — `scrollSpliceAfterEnding` (two volta bars defeat markEditAround's ±1 buffer; converted delete past them + stale-glyph check + splice-vs-full parity), `scrollSpliceInsideEnding` (volta-internal delete + parity incl. volta-bracket geometry), `scrollSpliceHairpinHostEdit` (wedge survives a host edit, geometry parity) — **all three fail against the pre-fix code** (verified by stashing the fix) and pass now; `HKL_INDEX_CHECK=1 test:composer` 331/331; sonata probes: post-volta converted edits splice real work under the dirty-coverage gate, hairpin host/tail edits at exact parity with zero Verovio warnings. Gotcha caught on the way: `toggleEndingAt` silently no-ops without a repeat context, which made the first fixture drafts vacuous — the fixtures set `toggleRepeatEndAt` first.

**Where**: `apps/composer/src/render/splice.ts` (sectionMeasures, computeHeadSig, expandForSpanners, expandForEndings, spliceDom ending reconcile), `apps/composer/src/model/index.ts` (cloneRangeStructure, runningScoreDefContext, serializeRangeForRender docs), `test/composer-test/fixtures.mjs` (3 fixtures + assertions), docs/lessons.md (both entries marked fixed), docs/composer-page-splice-design.md.

## 2026-08-30 — serializeRangeForRender: boundary scoreDefs render inline (commit-on-measure context folding)

**Context**: page-splice spike 2 (composer-page-splice-design.md) — a mid-piece key/meter `<scoreDef>` sitting directly before a range's first measure was folded into the sub-render's head scoreDef, so the signature-change glyphs the full render draws at that exact spot vanished, freeing ~a signature's width and flipping line fills (the d59 failure cluster). Also a latent scroll-splice fidelity hazard for runs starting at a signature boundary.

**Picked**: `cloneRangeStructure` includes interior section elements at position `seen >= loIdx` (was `>`), cloning a boundary scoreDef/sb inline; `runningScoreDefContext` buffers scoreDefs and commits them to the head ctx only once a MEASURE follows (pending ones at the boundary are discarded — they arrive inline; folding AND inlining would suppress the change glyph in the other direction, since Verovio draws no glyph for an unchanged signature).

**Verified**: typecheck + `HKL_INDEX_CHECK=1 test:composer` 331/331 (incl. the three scroll-splice regression fixtures); spike-2 battery: the pure boundary-scoreDef failure cluster (systems 59–62) cleared, tier-A pass 87 %.

**Where**: `apps/composer/src/model/index.ts` (cloneRangeStructure, runningScoreDefContext), docs/composer-page-splice-design.md.

## 2026-08-30 — Composer Phase C-A: page-view line-break ownership (render-time pins + breaks:'line'), refill driven by an owner-held sig baseline

**Context**: composer-page-splice-design.md spikes 3+5 validated pinning the system partition as encoded breaks; the open implementation questions were pin lifecycle, pagination ownership, the k87 scoreDef-adjacency placement, and how the refill learns what changed. Implemented same day as `apps/composer/src/render/linebreaks.ts` (`PageLineBreaks`) + `Renderer.renderPageComposer`.

**Picked** (each point probe-driven on the sonata, probes in session scratchpad):
1. **Display = breaks:'line' for sb/plain docs** — probed: 'line' honors every `<sb>` VERBATIM (a deliberately merged 8-measure line stays unwrapped; 'smart' re-wraps it) AND auto-paginates by height. So C-A owns systems while Verovio keeps pages — no pager code, pagination height-true, and enablement is pixel-exact (max per-measure x/width delta 0.0 vs the smartSb0 render; the design doc's ≤52 px encoded-respacing acceptance item dissolved). smartSb0 as refill display was refuted empirically: its castoff re-wrapped every refilled 5-measure line (naturals fill ~1.0–1.1) — its internal fit metric is not reproducible from naturals, which also rules out "tune FIT_MAX until castoff agrees". Docs with user `<pb>` render 'encoded' as today (their verbatim-page semantics are unchanged, including the pre-existing giant-page quirk on large docs — surfaced, not introduced; C-B pagination ownership is the real fix).
2. **Pins are render-time injections only** (`injectPins` on the serialized render MEI): the live doc, saves, undo snapshots, history and the bridge never see a pin — no stripping code exists. Placement: `<sb xml:id="hklpin-N">` directly before the line-start measure; INSIDE a preceding `<ending>` as last child (the spike-3 rule); directly AFTER an adjacent `<scoreDef>` (matches the model's own section-break order `scoreDef, sb, measure`; both orders probe-identical for partition parity, so the model's convention won).
3. **The refill never consumes the model's renderDirty.** Its reset-then-narrow lifecycle silently swallows an earlier mutation's 'all' under batch-mutate-then-render flows — found live: the composer-test runner's doc RESET (replaceDocument, no render) left a stale adopted partition that a later narrow edit then refilled against, re-partitioning a foreign document (the pageViewMultiSystemCrisp visual regression). `PageLineBreaks` instead keeps per-measure live-doc serializations from its last commit and prefix/suffix-diffs the live doc against them (~13 ms on 446 bars, amortized into a >1 s render) — the same never-trust-the-hint stance the scroll splicer takes with its sig maps. A renderer-side "accumulate dirty at reRender()" scheme was implemented first and REMOVED for this. Foreign-document guard: <50 % of line-start ids surviving → derive.
4. **Adoption is lazy + idle-chunked**: derive renders stay byte-identical to today (zero cost at doc load); the partition is read from the laid-out toolkit via idle renderToSVG slices (~2 s sonata) and finished synchronously if an edit arrives first (~4 s one-time cold-start edit).
5. **Single-line partitions always derive**: breaks:'line' with zero `<sb>` WARNS ("Requesting layout with line breaks but nothing provided") and falls back to castoff internally — and the 1-vs-2-line cusp is where our rules and castoff could flip-flop. Small docs render synchronously under the deferral threshold anyway. (This was the cause of the 202-fixture warning storm on the first suite run.)
6. **Fill rules as prototyped**: FIT_MAX 1.2 / MIN_FILL 0.7 (tunable, design item 1c); sigW measured per refill window from the leading clef+key glyphs (meter excluded); naturals from breaks:'none' windows with 2-left/1-right context + the scroll splicer's (now exported) spanner/ending expansions; only missing/dirty ids ever (re)written to the naturals cache (determinism). Backward min-fill rebalance scoped to the refilled lines; doc-final and hard-start lines exempt.
7. **Safety net**: after every refill render the mounted pages' system starts are verified against the pins — mismatch warns + re-adopts from the rendered layout (throws under HKL_INDEX_CHECK). Refill semantics (documented in the user guide): the first edit in a region re-breaks it from the edited line by OUR rules; thereafter identical content always yields the identical partition, and a no-change render moves nothing.

**Verified**: typecheck/build/boundaries clean; `HKL_INDEX_CHECK=1 test:composer` 334/334 incl. 3 new fixtures (`pageLineBreaksRefill` + visual baseline, `pageLineBreaksNoopDeterminism` — double round-trip + no-op stability, `pageLineBreaksDeriveFallback`); sonata battery: enablement parity 0.0, six-edit battery all refill-path with pins verbatim (voltas + key-change boundaries included), cascades 1–5 lines, untouched-line geometry bit-stable (the one 33-unit "violation" is the previous line's end-of-line courtesy signature appearing when a boundary moved next to a scoreDef — correct under full re-render; C-B's re-splice-k−1 rule), cold-start + derive-fallback + re-adopt paths probed. Latency unchanged by design (~1.5–2 s Chromium per edit, loadData-bound) — C-A is the structural prerequisite for C-B's splice, not the latency win.

**Where**: `apps/composer/src/render/linebreaks.ts` (new), `apps/composer/src/render/render.ts` (renderPageComposer, buildOptions 'line' + geomMode, pageBreaksCtx, measureBudgetW), `apps/composer/src/render/splice.ts` (expandForSpanners/expandForEndings exported), `test/composer-test/fixtures.mjs` (PAGE_LINEBREAKS group + assertions), docs/composer-page-splice-design.md (Implementation section), docs/composer-render-perf.md (T3.0), docs/lessons.md (3 entries), docs/architecture/composer.md, docs/guide/composer.md.

## 2026-08-30 — Page-view edits preserve scroll; composer-test visual capture reworked (viewport-fit raster, compact-vs-fullPage framing, capture meta)

**Context**: after Phase C-A, Max reported every page-view edit shifting vertical scroll then scroll-into-view correcting it, even for edits that move nothing. Probing confirmed a T2.1-era flaw: the virtualized rebuild's zero-height placeholders + the page-1 measurement forced layout on a collapsed extent, clamping #score.scrollTop (25392 → 2744 on the sonata, content-identical edit). Fixing it and pinning it with a fixture then unravelled a chain of test-infrastructure problems, several of which Max diagnosed from screenshots after instituting the surface-both-images-and-stop rule.

**Picked**:
1. **renderPage (virtualized) captures and restores scrollTop/scrollLeft in the same synchronous block** — after placeholder sizing, before mountVisiblePages, so the pages at the restored position mount. Shorter documents re-clamp naturally. The numeric offset is preserved (content below a merged line legitimately shifts); anchor-based preservation belongs to Phase C-B's splice, which will stop rebuilding the container entirely.
2. **Visual capture (test/composer-test/lib/visual.mjs) reworked** after Max found every page-mode baseline was cutting the paper: (a) the viewport is temporarily resized (device-metrics override) so the card stack actually rasterizes — an inner scroller's overflow is otherwise dark capture fill, captureBeyondViewport notwithstanding; (b) capture waits for geometry to be STABLE across consecutive frames (a fixed delay shot the pagescale relayout mid-flight); (c) framing is compact content-union by default and full page card via `visualFullPage: true` (set on pageViewMultiSystemCrisp, pageScaleGrowsPageNotContent, pageLineBreaksRefill), per Max — compact was right for everything except page-level fixtures; (d) every capture reports meta (pages, card dims, zoom, pageScale, scroll) into summary.json — the meta table immediately proved zoom/pageScale do NOT leak across fixtures (pagescale 1.4 confined to its fixture) and made the remaining flake self-describing.
3. **Runner hardening**: per-fixture reset of the renderer's `lastFullMs` (one heavy fixture otherwise flips later fixtures into deferred rendering — timing-coupled baselines); `skipCursorTrace` fixture flag (the walk scrolls every stop into view — minutes on a deliberately multi-page doc); scenario runs now perform the visual check (single-fixture verify/re-seed in ~1 s instead of full runs); `PageLineBreaks.lastDeriveReason` names every refill bail in failure details; pageLineBreaks fixtures engage ownership via a settle loop instead of asserting on idle-timing-dependent intermediates.
4. **All 35 baselines re-seeded** under the new capture rules. Note for later (Max): pagescale_140 shows a suspected intersection with the known backlog item "footer text doesn't reflow with page scaling" — not addressed here.

**Verified**: scroll fix probe-confirmed on the sonata (25392 → 25394 across an edit; was → 2744); `HKL_INDEX_CHECK=1 test:composer` 335/335 twice (re-seed run + plain verification run); typecheck/build/boundaries clean. New fixtures: pageEditPreservesScroll (multi-page doc, scroll held across an edit).

**Where**: `apps/composer/src/render/render.ts` (renderPage scroll preservation), `apps/composer/src/render/linebreaks.ts` (lastDeriveReason), `test/composer-test/lib/visual.mjs`, `test/composer-test/lib/runner-core.mjs` (reset: scroll + lastFullMs), `test/composer-test/run.mjs` (skipCursorTrace, scenario visuals, visualMeta), `test/composer-test/fixtures.mjs` (pageEditPreservesScroll + visualFullPage flags + engagement loops), `test/composer-test/baselines/*` (re-seeded), docs/lessons.md (three entries).

## 2026-08-30 — Phase C-B v1: the contained page-view system splice ("measure, don't emulate" vertical gate; stateless splicer; synthetic leader AND trailer)

**Context**: with C-A's line-break ownership in place, page-view edit latency was still loadData-bound (~1.6–2 s Chromium, 2–3 s Firefox on the sonata). The design doc's C-B item calls for splicing re-engraved systems into the mounted page SVGs from pin-anchored window renders. Probes (`test/composer-inspect/phasec/cb-structure.js`, `cb-window.js`) settled the ground truth: volta brackets ride INSIDE `g.system` (no reconcile needed, unlike scroll); Verovio stacks page systems by content-driven clearance with NO vertical justification and margin-anchored first systems; and a pin-anchored window (page geometry, tall page, breaks:'line', synthetic mRest leader) reproduces mid-score systems pixel-exactly — including consecutive-system spacing (delta 0.0), the pairwise-locality fact the whole approach rests on.

**Picked**:
1. **Splice only when nothing else moves (v1)**. Instead of emulating Verovio's content-driven stacker (the same trap spike 5 refuted for castoff fit), the splicer MEASURES the window's own consecutive-system spacing chain against the live DOM: every replaced system must land exactly at its live position (spacing-above per line, content-top hang for page-first lines, spacing-below after the last replaced line, bottom-extent stability for page-last lines — which also pins pagination). Any implied movement → full refill render, loudly. dy-cascades, page-boundary moves, and pagination ownership (pb pins + our height-fit rule) are C-B2.
2. **The splicer is stateless** (`render/pagesplice.ts`, `PageSystemSplicer`): everything it needs lives in the mounted DOM, the refill result (`tryRefill` now returns changed run + old/new partition + a LAZY `mei()` so the splice path skips the ~130 ms full serialize+pin), and the model. Nothing to invalidate, no index to drift.
3. **Synthetic leader AND trailer**: windowed renders diverge at BOTH sub-document edges — the leader (spike 2) absorbs score-start artifacts; the new pinned mRest TRAILER absorbs the end-of-score final barline (~5 px wider bbox on the window's last measure — found by the battery's context check as dW=52/dRelX=0). No trailer when the window reaches the true doc end.
4. **Context-line sanity check as the divergence detector**: the unchanged neighbour lines (a−1, b+1) must reproduce their live per-measure x/width within 25 units. This structurally catches the section-boundary window divergence (probe k=59 — the k87 "castoff state at a mid-piece scoreDef" family) without any zone blacklist. Line 0 (score-start) is excluded outright; section-header measures are excluded (mount-only injections).
5. **New refill guards, needed the moment rendering stopped being whole-doc**: `computeInteriorSig` (mid-piece section-level scoreDefs are invisible to per-measure sig diffs) and composer/footer credits in `headSig` — both bail to derive. A signature-identical render request is now a NO-OP SKIP (page DOM untouched; sound because of those guards). `lastFullMs.page` updates only on actual full engraves so splices don't poison the heaviness predictor.
6. **Inline acceptance gate under HKL_INDEX_CHECK**: every splice re-renders the same pinned MEI offscreen and throws on any divergence in system sequence, per-measure x/width, or spacing (section-header pages exempt spacing — their reserve translate is a main.ts injection, not Verovio's).

**Verified**: typecheck/build/boundaries clean; `HKL_INDEX_CHECK=1 test:composer` full suite green incl. 3 new fixtures (`pageSystemSpliceEdit` + visual baseline, `pageSystemSpliceVerticalBail`, `pageSystemSpliceNoopSkip`); sonata battery (`cb-splice-battery.js`): reference parity on EVERY edit across all 37 pages/446 measures (max x/width delta ≤ 5 units ≈ snap noise, spacing ≤ 9), spliced edits 398–628 ms wall vs 1.6–3.1 s full renders; `cb-focus.js`: 3/3 consecutive same-region edits splice at ~350–380 ms. Known hit-rate shape: the FIRST edit in a region usually full-renders ('line count changed' — C-A's documented re-break to our fill rules); a "prefer the current boundary when still legal" fill bias would lift it (design item 1c, Max's call).

**Where**: `apps/composer/src/render/pagesplice.ts` (new), `render/linebreaks.ts` (RefillResult, lazy mei, interiorSig, credits in headSig), `render/render.ts` (splice wiring, pageSpliceCtx, styleVoltaNumbers moved here, conditional lastFullMs), `render/splice.ts` (mergeGlyphDefs extracted), `apps/composer/src/main.ts` (imports styleVoltaNumbers), `test/composer-test/fixtures.mjs` (PAGE_SPLICE group), `test/composer-inspect/phasec/` (4 new probes + README), docs/composer-page-splice-design.md (Implementation C-B v1 + C-B2 items), docs/lessons.md (2 entries).

## 2026-08-30 — Page-view reflow is CONSERVATIVE: the partition is repaired, never re-derived (legality bounds become the tuning surface)

**Context**: Max, after living with Phase C-A: "Preventing no-op edits from ever being able to reflow from the original render should be top priority. It's currently possible (and the most common behavior) to delete one note, then the system gains a measure, then undo and the gained measure is still there." Root cause: C-A's refill RE-DERIVED the affected region greedily, and a greedy packer accepts any line up to FIT_MAX — so a measure pulled into a line by a deletion was still "legal" once the deletion was undone. Classic threshold hysteresis: the layout drifted one measure per edit and never drifted back. The fix is not a better fill rule; it is not re-deriving at all.

**Picked**:
1. **Carry the partition across the edit by MEMBERSHIP, then repair only what became illegal** (`PageLineBreaks.repartition`). Each old line keeps its first surviving member as its start (so deleting a line's first measure just advances that line's start; an inserted measure joins the line whose range contains it; a line whose members all vanished disappears) — no widths consulted. Only lines whose content changed are then examined for legality, plus whatever a repair cascades into.
2. **Repairs move ONE measure across ONE boundary at a time** — push the last measure forward when overfull, pull the next line's first measure back when underfull — so a reflow is exactly as large as the illegality demands. User breaks are never moved (an overfull line before one gets a NEW line instead). Guards: a line that pushed never pulls back (oscillation), an overfull line that can only trade one illegality for another is left as-is (content over churn), and a step cap falls back to a derive render.
3. **Legality bounds widened to contain Verovio's own castoff envelope**: FIT_MAX 1.2 → **1.45**, MIN_FILL 0.7 → **0.65** (the sonata's 118 castoff lines measure 0.706–1.426 by this same naturals model). This makes an ADOPTED partition legal by construction — so the first edit in a region moves nothing — and turns the two constants into exactly what Max asked for: load-bearing knobs tuned by feel, where narrower = more eager reflow.
4. **Reflow is now path-dependent by design** (a partition reflects the edits that reached it, not a fresh engraving of its content). Accepted deliberately: an explicit "reflow the document as if freshly engraved" command and explicit move-measure-between-systems commands are the intended companions, and are OUT OF SCOPE for now (Max) — the current focus is reliable edit-latency reduction.
5. **Stale-mount hole closed** (found by the same probe): a C-B splice edits the mounted pages without re-loading the toolkit, so a lazily-mounted page would have drawn PRE-EDIT content. `pageVirt.stale` now marks the page data dirty at splice time; the next mount re-serializes + re-pins from the live model (`PageLineBreaks.pinRenderMei`) before rendering, with `pageVirt.options` switched to the pinned 'line' options the rebuilt data expects.
6. **MAX_SPLICE_LINES 3 → 5** (windows 9 lines / 80 measures): a single-note edit can legitimately touch several lines when a spanner chain closes the run over them (sonata measure 250 was full-rendering at 2.4 s for a one-note delete). Every replaced line is still proven by the context-line and vertical gates, so the cap is a cost knob, not a safety one.

**Verified** (sonata, `cb-noreflow.js` — real keystrokes, note-count-checked): 4/4 edits and 4/4 undos held the partition with `movedLines` 0; undo restored content 4/4; post-undo geometry bit-exact in 3/4 cases and 3 units (0.3 px snap noise) in the 4th. **The latency payoff is large and was the point**: the C-B splice battery went from 3/8 to **7/8 edits spliced** (380–673 ms vs ~1.95 s), every one reference-parity clean at ≤ 4 units document-wide, because repaired partitions almost never change the line count. Suite 337/339 — the two failures are visual baselines that legitimately changed (the layout no longer re-breaks) and are left for Max to accept. Fixtures: new `pageLineBreaksUndoRestoresLayout` (delete via Backspace + Ctrl+Z: note count restored, no boundary moved, geometry bit-identical); `pageLineBreaksRefill`'s obsolete "recomputed ≥1 line" assertion removed (0 moved lines is now the desired outcome); `pageLineBreaksNoopDeterminism` comment updated to the stronger invariant. **Its visual baseline legitimately changes** — the doc now keeps the adopted partition instead of re-breaking it — and is left for Max to accept.

**Where**: `apps/composer/src/render/linebreaks.ts` (repartition replaces refillLines+rebalance; FIT_MAX/MIN_FILL; persisted sigW; pinRenderMei), `render/render.ts` (pageVirt.stale + lastModel + pinnedMeiForCurrentModel), `render/pagesplice.ts` (caps), `test/composer-test/fixtures.mjs`, `test/composer-inspect/phasec/cb-noreflow.js` + `cb-noreflow2.js` + `cb-undodiff.js`, docs/lessons.md (probe-artifact entry), docs/composer-page-splice-design.md ("Reflow semantics (current)").

## 2026-08-30 — Phase C-B2a: pagination ownership (`<pb>` pins + breaks:'encoded'), and the splice-latency profile

**Context**: with lines owned and reflow made conservative, the next chunk was pagination — needed for cross-page cascades, and the route to 2× faster full renders. The gating question was whether `breaks:'encoded'` (the only mode honoring `<pb>`) reproduces today's `'line'` display. Probe answer: pagination and per-page system split reproduce EXACTLY, loads are 2× faster (577 ms vs 1191 ms), but intra-line justification redistributes up to ~52 px and system tops move up to ~49 px. Max compared both renders of sonata page 3 as images, saw no difference, and approved on the condition that the new system be self-consistent.

**Picked**:
1. **Pages are adopted, pinned, and carried exactly like lines.** The derive-render walk that adopts the partition now also records each page's first line; those ids are pinned as `<pb>` and every owned render uses `'encoded'`. A page keeps its start id while that id still begins a line, otherwise moves to the next surviving line start (never backwards). A splice requires pagination UNCHANGED; cross-page moves are C-B2b.
2. **Self-consistency is the acceptance criterion** (Max's wording), and it holds: live DOM vs a fresh full render of the same pinned MEI — 446 measures, 0 sequence mismatches, max delta 4 units. Verified by `cb-pageown.js`.
3. **Owning pages means owning overflow.** Verovio only re-paginates while it owns the pages, so `Renderer.overflowingPage()` checks every mounted page after a pinned full render and hands pagination back (derive + re-adopt) on a spill; `verifyRenderedPartition` additionally asserts each page begins at its pinned line.
4. **The window render must use the SAME strategy as the live render** — encoded and line justify differently, so a 'line' window spliced into an 'encoded' page would carry ~52 px of wrong spacing. Consequence accepted: the first edit after a derive full-renders (the live DOM is still the derive strategy's justification, and the context check correctly refuses).
5. **Two self-inflicted latency bugs fixed** (found by profiling, worth ~900 ms on the affected edits): (a) the splice marked the LIVE toolkit invalid although it renders through `spliceTk` — the next lazy mount reloaded the whole document for nothing; staleness is now PER-PAGE (`pageVirt.stalePages`), since a splice only changes the pages it edited and every other page still matches the loaded layout; (b) every page edit was deferred behind the busy badge because `predictNextRenderHeavy` keyed off the last FULL render — it now predicts light when the previous page render spliced (mirroring the scroll path).

**The profile** (`cb-profile.js`, steady-state splice, sonata, Chromium): 313 ms total = renderComposer 164 (splice 108 + refill 55) + cursor.update 57 (TWO calls) + model mutation 45 + ~47 other. **Verovio is 58 ms of it.** The rest is whole-document bookkeeping — 32 k querySelectorAll calls, 495 measure serializations — which is precisely why a page edit costs more than the same edit on a short score. Remaining levers are recorded in the design doc; none are implemented yet and the cursor one is Max's call because it touches the input pipeline.

**NOT fixed**: the user-`<pb>` giant-page quirk (a Ctrl+B break still routes through the derive path and paginates only at encoded breaks: 37 → 2 pages). It needs the derive path to paginate by height itself and union the user's breaks in — the same page-fit machinery vertical justification will need.

**Where**: `render/linebreaks.ts` (pageStartIds: adopt/carry/pin, pinRenderMei, paginationOwned, page assertion in verifyRenderedPartition), `render/render.ts` (encoded strategy selection, per-page staleness, overflowingPage, lastPageSpliced, mei/options pairing), `render/pagesplice.ts` (lastPages, strategy-matched window options), `test/composer-inspect/phasec/` (cb-pagination, cb-pagerender, cb-pageown, cb-profile + runner `--arg`/`--screenshot`), docs/composer-page-splice-design.md.

## 2026-08-30 — One break algorithm everywhere: the castoff pass becomes a never-painted bootstrap (page-based getMEI makes it affordable)

**Context**: after pagination ownership shipped, the first edit following any derive render full-rendered instead of splicing — the live DOM carried the derive strategy's justification while splice windows rendered `encoded`, so the context-line check correctly refused. Max: "The first edit full-rendering is not harmless, it's first-interaction friction equal to the difference between full render latency and splice latency." He then challenged the premise itself — "I have not seen any evidence that smartSb0 and encoded justification actually differ. And if they do, they shouldn't. Show me." — and, when shown, asked the right question: "Why can't we simply force Verovio to always use the same break algorithm we are?"

**Measured first** (the evidence he asked for, `cb-modes.js` / `cb-whymode.js` / `cb-sbcorrelate.js`): on BYTE-IDENTICAL data (same `<sb>` pins, only the `breaks` option changed) `line` vs `encoded` moves 409 of 446 measures — median 26 units (~2.6 px), p90 121, max 515 — with identical pagination and identical measures-per-system. Adding the `<pb>` elements changes **0** measures, so the elements are inert and the ALGORITHM is the entire cause. Not a section-break artifact either: 85 of 118 lines have no encoded break or scoreDef nearby and still average 77 units of drift. `line` ≡ `smartSb0` exactly, which is why this hid behind C-A's parity claim. **Correction recorded**: `breaks:'line'` DOES honor `<pb>` (pagination followed our pins exactly, spacing unchanged) — the C-A note saying otherwise is wrong, so ownership never required the mode switch; Max declined `line` anyway because it costs 1157 ms per full render against `encoded`'s 538 ms.

**Picked**:
1. **The castoff pass is no longer painted.** A derive render loads the castoff strategy (`loadData` only — never rendered to SVG), adopts the partition, and paints the pinned `encoded` render. Every pixel the user sees comes from one algorithm, so the first edit splices like any other. Anything unreadable falls back to painting the castoff layout and arming the old idle walk.
2. **Adoption reads page-based MEI instead of rendering pages.** `getMEI({scoreBased:false})` returns `<page>`/`<system>` wrappers encoding exactly what castoff decided: **98 ms including parse, versus 1830 ms for the page-by-page SVG walk**, with a byte-identical partition (118 lines / 37 pages). Being synchronous is what makes the bootstrap possible at all. Gotchas: `{pageNo:N, scoreBased:false}` returns an EMPTY string (ask for the whole document), and Verovio echoes our `hkl:` metadata without its `xmlns:hkl` declaration, so the output must have the prefix re-declared before parsing.
3. **Accepted trade** (Max: "First paint is the one case I accept additional time, as long as it truly happens once"): first paint 1.2 s → ~2.0 s on the sonata (one extra loadData), against ~870 ms off every first interaction and the elimination of ~1830 ms of idle work. Total work per load-and-first-edit drops ~4.2 s → ~2.3 s. Verified the cost is per-derive only — three consecutive forced derives at ~2.0 s, no warnings, first edit after each splices at 333 ms, no idle tail.

**Visual consequence, approved**: page rendering moved from `smartSb0` to `encoded` everywhere, so four page-mode baselines shifted (median ~2.6 px). Max reviewed and approved a full reseed. He flagged the `phase3_section_header` case, where the same phenomenon is extreme because a single whole note absorbs an entire page of slack (note moves 1368 → 2935 from the measure left) and because `encoded` leaves the document-final system at its natural width (18790 → 2553) instead of stretching an empty measure across the page — the latter being conventional engraving. Both characterised in the design doc; both are Verovio's behaviour, not tunable short of choosing the mode.

**Where**: `render/linebreaks.ts` (`adoptFromCastoff`), `render/render.ts` (`castoffPlan` extracted from renderPage, `derivePageRender`), `test/composer-test/fixtures.mjs` (derive detection now uses `lastDeriveReason` — the old "idle adoption re-armed" proxy is dead now that adoption is synchronous; `pageLineBreaksDeriveFallback` engages ownership first), 4 baselines reseeded, `test/composer-inspect/phasec/` (cb-modes, cb-whymode, cb-sbcorrelate, cb-linepb, cb-getmei, cb-tkapi, cb-pagebased, cb-wholenote, cb-loadcost), docs/lessons.md.

## 2026-08-30 — Scope boundary: Verovio owns musical spacing, permanently

**Context**: while scoping Phase D (making the page-view edit path O(edit) rather than O(document)), I floated "own intra-measure spacing" as the endgame for sub-50 ms edits — reasoning that since we already own line breaks and pagination, repositioning glyphs directly would remove the per-edit engraver round-trip.

**Ruled out by Max, permanently**: "Anything related to your 'endgame' is firmly out of scope of this effort. Our system is to use Verovio to render our scores. Musical spacing is incredibly complex in ways I don't even fully comprehend, and trying to replicate it ourselves for tens of ms is always a losing battle."

**The settled division of labour**: **we own break decisions (line partition, pagination) and DOM surgery; Verovio owns everything inside a system.** Do not propose replicating spacing, justification, or glyph placement again.

**What this fixes and what it costs**: the latency floor now includes one small window engrave per edit. Measured, that is ~17 ms `loadData` FLAT in document length (22 ms on a one-page doc, 17 ms on the 446-bar sonata — the window is the same size either way), plus the window's own drawing cost, which scales with musical density rather than score size. Every remaining millisecond has to come from OUR overhead: the O(document) tax (Phase D), the mounted-DOM layout-flush cost, and how many measurements the splice takes. Realistic target ~120–150 ms, flat in document size — and flatness is the property that matters, since it is what makes a 2000-bar score behave like a 200-bar one.

**Where**: docs/composer-page-splice-design.md (Phase D scope boundary, TODO A6, scaling baseline).

## 2026-08-30 — Derived-state caches on the edit path are invalidated by DOM mutation, not by call discipline

**Context**: Phase D's goal is an O(edit) rather than O(document) page-view edit path. The three biggest whole-document taxes per keystroke on the sonata were the cursor-stop enumeration (`flatChildren`, asked ~15 times), the measure list (`allMeasures`, ~17–26 times), and the refill's per-measure signature baseline (`XMLSerializer` over all 446 measures). All three want caching.

**The obvious design fails, and the gate proved it immediately.** The model already has a single documented invalidation point — `invalidateMeterCache()`, "reached by every structural/content/meter mutation" — and already caches `voiceIndexCache` on it. Caching `flatChildren` there produced 286 fixture failures on the first `HKL_INDEX_CHECK` run, all one message: `insertWithSplit` reads `flatChildren` in the MIDDLE of its mutation, between its own DOM writes and its closing `normalizePlaceholdersAll()`. The design doc had warned exactly this ("`flatChildren` is deliberately NOT cached — mutation code reads it mid-operation"). No call-site audit makes an end-of-operation invalidation safe against a mid-operation read.

**Picked: a `MutationObserver` on the live document.** The load-bearing property is that `takeRecords()` drains **synchronously**, so a read taken mid-mutation sees the writes that preceded it in the same task. Correctness needs two details: the observer's own callback can drain the queue first on its microtask, so a `fired` flag must cover that path (`takeRecords().length || fired`); and undo/redo/load swap the document object, so document identity is compared and a swap counts as "everything changed". Invalidation is then exact by construction rather than by audit — strictly safer than the discipline it replaces, and it needs no cooperation from mutation code.

The same records give the owner a per-measure dirty set: fold each record's target up to its containing `<measure>`; a target ABOVE measure level (a `<section>` childList insert/remove, a mid-piece `<scoreDef>`, the head) means the measure SET or the shared context moved, so nothing is assumed clean. Storing element identity beside each cached signature (`sigEl`) closes the last hole — a measure that is still the same object and was never mutated cannot serialize differently.

**Verifications are permanent, not one-shot.** Under `HKL_INDEX_CHECK` the model re-enumerates and compares on every cache HIT, and the owner re-serializes the whole document and compares every string. The 339-fixture suite is therefore a standing gate on the mechanism itself, at no production cost — and measured, it did not slow the suite down (~190 s either way).

**Measured (sonata, steady-state spliced edit)**: `querySelectorAll` 31 969 → ~3 400 calls, `XMLSerializer` 495 → 54 calls, `cursor.update` 62.6 → 1.8 ms, wall 308 → ~206 ms. Behaviour gate: the `cb-splice-battery` sonata battery was run on both code states — identical splice/skip outcome edit-for-edit, reference-clean on all 37 pages in both, every edit faster.

**Where**: `apps/composer/src/model/index.ts` (`documentVersion`, `flatChildren`, `allMeasures`), `apps/composer/src/render/linebreaks.ts` (`captureSigs`/`drainSigDirty`/`noteSigMutations`), docs/lessons.md, docs/composer-page-splice-design.md (Phase D passes 1–3).

## 2026-08-31 — Crisp zoom presets use a CONSTANT unit 8, so zoom stops re-breaking the score

**Context**: the page-view partition cache needed a key, and keying it on the zoom label exposed that zoom is not layout-neutral. Verovio's `scale` has no layout effect (proven: zoom 50 vs 100 differ only in `scale`, share `unit: 9`, and produce byte-identical partitions), but `CRISP_PRESETS` used `unit: 10` at 75 % where 50/100 use 9 — and `scalePageGeom` scales the page by `pageScale` only, never by zoom. So zooming the 446-bar sonata to 75 % moved it from 118 lines / 37 pages to **134 lines / 45 pages**: eight extra pages from a zoom. Max: *"zoom should be a no-op in terms of line count and distribution, not add 8 pages."*

**No prior justification existed to override.** `unit: 9` is Verovio's *default*, inherited rather than chosen; the 50/75/100 ladder predated `render-presets.ts`; `unit: 10` arrived in b37e1b7 ("dark mode and related tweaks") purely to make an already-existing 75 % step crisp. And this file previously asserted the opposite of the defect — "the existing zoom is pure magnification and does not change music-per-page" — so the trade-off was never weighed. (That claim is TRUE again as of this entry.)

**Picked**: `unit: 8` at scales 50/75/100 — one unit for every zoom. The available scales at a given unit are governed by `gcd(unit, 50)`: a scale must be a multiple of `50/gcd(unit,50)` for staff-space (`unit × scale / 50` device px) to be an integer. Unit 9 (gcd 1) allows only multiples of 50 — nothing between 50 % and 100 %, which is exactly why 75 % had to co-tune. Unit 8 (gcd 2) allows multiples of 25, so all three levels are crisp at one unit: staff-space 8/12/16 px, strokes 1.0/0.975/2.0 px (widths 0.25/0.1625/0.25 → internal 20/13/20). Clean scales also remove the root-`<svg>` ceil drift the old scale 70 (→ 0.0701) needed `pinExactScale` to correct.

**Rejected**: (a) `unit: 9` with a fractional `scale: 77.78` — refuted by the presets' own derivation (breaks the whole-device-px stroke rule: 20 × 0.07778 = 1.56 px, and re-opens the ceil drift). (b) **Compensating the paper by `unit / 9`** — a measured DEAD END: it matched `contentWidth / unit` to five digits (208.79 vs 208.78) and still gave 113 lines where 118 was wanted, because Verovio's horizontal spacing has terms that do not scale with `unit`. Fitting the factor empirically would be reverse-engineering the spacing model (out of scope). (c) Dropping the 75 % step for a unit-9 50/100/150 ladder — would have preserved today's default size exactly (18 px is uniquely `unit 9 × scale 100/50`), but Max explicitly did not want the default preserved at the cost of the ladder.

**Accepted cost**: every level is ~11 % smaller — 100 % staff-space 18 px → 16 px — so scores are more compact (sonata 30 pages instead of 37, 18 measures on page 1 instead of 14) and every existing score re-breaks once. Max reviewed a six-image side-by-side of sonata page 1 at all three zooms before approving. 36 visual baselines reseeded.

**Benefit beyond correctness**: with a constant unit the partition cache holds ONE entry for all zooms, so every zoom change is a cache hit — measured 740/733/705 ms across 50 → 75 → 100, versus up to 2134 ms when 75 % needed its own castoff pass.

**Where**: `packages/notation/src/render-presets.ts` (presets + a "WHY unit 8" block warning against reintroducing a per-zoom unit), `apps/composer/src/render/render.ts` (`partitionKey` keyed on `unit`, not the zoom label; DEAD END comment on `scalePageGeom`), `test/composer-inspect/phasec/cb-zoomunit.js` (regression gate — `zoom75_differs` must stay false), `test/composer-test/fixtures.mjs` (`pageEditPreservesScroll` buys its third page with `setPageScale(70)` instead of 2× the inserts — 235 s → 31 s), 36 reseeded baselines, docs/lessons.md.

## 2026-08-31 — User page breaks: pagination computed per inter-break SEGMENT, and the break merged into the line partition

**Context**: with pagination owned, a Ctrl+B page break was broken in two visible ways (Max): *"it doesn't do a cascade reflow at all. So if I put a page break before the last line of a page, it creates a new page with just that line. Putting a page break in the middle of a system also does not try to reflow measures."* Measured on the sonata: our page list one short of the DOM, a 1-system page, `verifyRenderedPartition` false with a "diverged from pins" warning on every render.

**Root cause — no Verovio break mode does both jobs.** `breaks:'line'` paginates by height but treats `<pb>` as a SYSTEM break (a document with one Ctrl+B returns the *same* page count as with none, and the break measure is not a page start); `breaks:'encoded'` honors `<pb>` as a page break but never paginates by height (that was the older 37 → 2 giant-pages defect). We took `'line'`'s page starts — computed as if the break did not exist — and painted `'encoded'`, which honored the `<pb>` **on top of** those unchanged pins: an extra boundary inserted with nothing after it re-packed.

**Picked**: `castoffSegmentedByUserBreaks` — split the document at user breaks and cast off each segment independently with `'line'` (the global line partition pinned as `<sb>`, so Verovio decides only how many lines fit per page), then concatenate the segments' page starts. Verovio stays the page-fit engine; we only choose where to cut, so **no height model was needed** (which keeps this inside the Phase D scope boundary). A one-line segment short-circuits without a layout pass — it cannot overflow a page, and handing `'line'` data with no encoded break makes Verovio warn and silently fall back to castoff.

**The load-bearing step, initially omitted**: a page begins with a new system, so the break measure MUST start a line — but the whole-document castoff runs under smartSb0, which ignores `<pb>`, leaving those measures mid-line and absent from the partition. They are now merged into the line partition before segmenting. Omitting it was self-inconsistent (the segment *begins* at that measure, so Verovio necessarily starts a line there) and was caught by the partition-equality check between "what I pinned" and "what came back", which bailed to the old path instead of painting a layout the page list did not describe. **That same merge is what makes a MID-SYSTEM break reflow its measures** — the measures before it finish the now-shorter previous line.

**Verified** (`cb-pbcases.js`, sonata), both reported cases: break splits its line, starts a page, page list == DOM (31/31 and 30/30, was 30/31), **no single-system page** (was 1 in both), `verifyRenderedPartition` true, no warnings, and removing the break restores exactly. Case B even keeps the page count at 30 — the displaced line is absorbed downstream. Suite **340/340** under `HKL_INDEX_CHECK` with the new `pageUserBreakReflows` fixture; battery unchanged at 6/8 spliced, all reference-clean; boundaries + build clean.

**Where**: `apps/composer/src/render/render.ts` (`userPageBreakIndices`, `castoffSegmentedByUserBreaks`, `layoutBreaksWithLines`, derive hook), `test/composer-test/fixtures.mjs` (`pageUserBreakReflows`), `test/composer-inspect/phasec/` (cb-userpb, cb-pbadopt, cb-pbconverge, cb-pbunion, cb-segdiag, cb-pbcases), docs/lessons.md.

## 2026-08-31 — Page splice B1: the window mirrors live pagination, so a moving system's position is measured rather than modelled

**Context**: Phase C-B v1 spliced only when NOTHING moved — four vertical
refusals (`page-first hang`, `spacing above`, `page-last bottom extent`,
`spacing below`) sent the edit to a full render. On the sonata battery that was
the difference between 6/8 and 8/8, with `edit-page-first` costing 1152 ms.
B1's premise (design doc) was that the splice already measures the new spacing
in its window, so the dy is known.

**True for systems inside a page, false for a page's first system.** A spike
(`cb-dycascade.js`) compared the plan against what the ensuing full render
actually did: intra-page spacing predictions were exact (±3), while page-first
predictions were off by up to 85 units. Root causes in lessons.md — Verovio
counts a different overflow than `getBBox` reports (`<text>`: `g.dir`,
`g.tempo`, HEJI `g.accid`), and the window's `header: 'none'` removed the
running-header band that anchors every page's first system (~419 units).

**Picked**: the window carries `<pb>` pins at the live page starts and renders
with the **live page options verbatim**. `'encoded'` paginates only at encoded
breaks, so the tall-page/`adjustPageHeight`/`header:'none'` trick — needed back
when windows rendered `breaks:'line'` — is unnecessary once pagination is
owned, and dropping it removes the one geometry difference between window and
page. A page-first system is then page-first in the window, and the plan READS
its staff top instead of deriving it. Worst prediction error over 19 samples:
**425 → 8 units**. (Unowned pagination keeps the tall-page window; a live
page-first system simply refuses there, as in v1.)

**Rejected**: (a) measuring the hang over a restricted "counted" element set —
an unverifiable model of Verovio's internals whose failure mode is silently
mis-positioned systems; (b) calibrating the anchor constant from another page —
it is not constant (a floor applies once the counted overflow is small).

**All-or-nothing application.** The plan is accurate to ~±8 units, so applying
a 3-unit movement adds error and re-snaps a whole page for a sub-pixel edit —
it surfaced immediately as a visual-baseline diff on `pageSystemSpliceEdit`.
A splice therefore either pins systems to their live positions exactly (v1
behaviour, `plan.static`: nothing moves by more than EPS 25) or applies the
whole plan plus the follower cascade.

**Cross-page moves: repaginate, do not splice across.** Under owned pagination
a full render never moves a system between pages either (page starts are
pinned), so a splice matching the reference must not do so. What CAN happen is
that a cascade pushes its page past the paper — Verovio will happily draw past
a pinned page. The splice now runs the same `overflowingPage()` check the
pinned full-render path uses (scoped to the edited pages) and hands pagination
back to Verovio (derive + re-adopt) on a spill. Verified end-to-end
(`cb-cascade-overflow.js`): two successive extent-growing edits consume page 1's
410 px of slack; the second warns, re-derives, and page 1 goes 6 systems → 5
with nothing drawn past the paper.

**Measured**: sonata battery **6/8 → 7/8 spliced**, all 8 reference-clean
(max x/width 4 units, max spacing 8, max ABSOLUTE staff top 6, over 30 pages /
446 measures); `edit-page-first` **1152 ms → ~440 ms**. The remaining fallback
is the section-header line. Suite 342/342 under `HKL_INDEX_CHECK`.
(2026-09-01: "by-design" here was wrong — that guard is unresolved, not a
choice; see the exhaustive-sweep entry.)

**Where**: `apps/composer/src/render/pagesplice.ts` (`VerticalPlan`,
`verticalPlan`, page-pinned window, multi-page hosts, follower cascade,
absolute-top reference gate), `apps/composer/src/render/render.ts`
(`pageSpliceCtx` window options, scoped `overflowingPage`, post-splice spill
handling), `test/composer-test/fixtures.mjs` (`pageSystemSpliceBottomExtent`
replaces `pageSystemSpliceVerticalBail` — that edit legitimately splices now —
plus `pageSystemSpliceDyCascade` and `pageSystemSpliceCascadeOverflow`),
`test/composer-inspect/phasec/` (cb-dycascade, cb-anchor, cb-topmost,
cb-cascade-overflow; cb-splice-battery gained the absolute-top check),
docs/lessons.md.

## 2026-08-31 — Section-header reserve is subtracted, not exempted: the splice reasons in Verovio coordinates and titles travel with their systems

**Context**: Max, after B1 shipped: *"in certain cases, an edit on a line above a
section header causes the page to reflow while the header stays in place,
overlapping it. We have to make sure our knowledge of the headers matches the
derive path."* Reproduced immediately (`cb-header-overlap.js`): the header's
system moved 149 px down, the title moved 0, clearance 40.7 → 189.7 px.

**Two defects, one root cause.** `injectSectionHeaders` (main.ts) runs at page
MOUNT: it displaces the header's system and every later system on that page by
`SECTION_HEADER_RESERVE`, and appends the title `<text>` to the page-margin at
an ABSOLUTE y. Verovio knows neither fact. So once B1 started moving systems,
(1) the title had nothing moving it, and (2) the vertical plan's chain — which
runs on LIVE staff tops — was wrong by the whole reserve wherever a chained
pair straddled the header boundary: `dyFollow` came out **1536.9 where 2436.9
was correct**, mis-placing the music by 900 units on top of stranding the word.

**Picked**: the plan works in **Verovio coordinates**. Each `LiveSys` carries
its accumulated header reserve; the chain subtracts it before chaining and adds
it back afterwards, and the cascade moves every title whose system it moves.
The reserve is **read back from the DOM** — the injector records what it applied
as `data-reserve` on the title element — so there is one source of truth rather
than a constant duplicated into the render layer (which cannot import from
main.ts anyway). A title with no readable reserve REFUSES the splice
(`section-header reserve unreadable`) rather than guessing.

**Rejected**: (a) refusing to splice on any page carrying a section header —
safe, but it gives up precisely the pages B4 was meant to reclaim, and it leaves
the wrong-by-900 arithmetic latent for any future caller; (b) re-running
`injectSectionHeaders` after a splice — it is deliberately not idempotent (it
translates systems cumulatively), and making it so would rebuild geometry the
splice just placed.

**The gate exemption was the actual bug-enabler.** Both reference gates skipped
the vertical checks on section-header pages, so a 900-unit misplacement and a
stranded title passed everything. They now subtract the reserve and verify those
pages like any other, and the inline gate additionally asserts every title still
sits inside its own reserve band. The sonata battery consequently verifies its
three header pages for the first time — still clean (max absolute staff-top
delta 6 units over 30 pages).

**Also removed**: the `section-header page anchor` refusal B1 added — a
page-first system on a header page is now placed correctly by the reserve
arithmetic. The `section-header line` refusal (the replaced run itself contains
a header measure) STAYS: re-placing that title needs the injector's baseline
rule, not just its reserve, and a full render there is correct and rare.

**Verified**: new fixture `pageSectionHeaderCascade` grows then shrinks the line
directly above a header and asserts the title/system clearance is unchanged in
both directions — it FAILS on the pre-fix build with exactly the reported
symptom (40.7 → 189.7 px). Suite 343/343 under `HKL_INDEX_CHECK`; sonata battery
7/8 spliced, all reference-clean with header pages no longer exempt;
typecheck/build/boundaries clean.

**Where**: `apps/composer/src/main.ts` (`data-reserve` on the title),
`apps/composer/src/render/pagesplice.ts` (`PageHeaders`/`pageHeaders`,
`LiveSys.reserve`, Verovio-coordinate chain, title cascade, un-exempted
reference gate + title-band assertion), `test/composer-test/fixtures.mjs`
(`pageSectionHeaderCascade`), `test/composer-inspect/phasec/cb-header-overlap.js`,
`test/composer-inspect/phasec/cb-splice-battery.js` (reserve-adjusted compare),
docs/lessons.md.

## 2026-08-31 — Splice coverage measured by sweep, not sample: placeholder sizing fixed, spanner expansion made one-pass

**Context**: Max, after B4: *"many entire systems refuse any steady-state splice
(regardless of proximity to a header), and any deletion causes the entire scroll
position of the screen to move down by a few px, every time. Why hasn't your
battery found it?"* Neither symptom was observable by the existing gates —
`cb-splice-battery.js` calls `mountAll()` before each of its 8 edits and its
reference compare is entirely page-INTERNAL.

**New instrumentation** (`cb-sweep.js`): walks every line, scrolls each into
view through the real `IntersectionObserver` (never calls `mountPage`), edits,
restores via `restoreSnapshot`, and records outcome, skip reason, wall time,
pages mounted, and the viewport/page-box state around each edit. It asserts the
edit landed by `docVersion()`, not by the return value — the exact hole that let
two battery edits silently no-op for months. Baseline: **hit rate 56.5%**, and
the skip-reason histogram turned "many systems refuse" into a ranked list.

### 1. Placeholders were sized from the wrong box (the drift)

Virtualization measured page 1's **inner SVG** (2794 px) *before*
`finishPageMount`, and gave every placeholder those dims; a mounted page is the
**`.score-page` div** (2796 px) *after* post-processing. Every page therefore
grew exactly 2 px on mount — 56 px across the sonata. Splices never touch the
page grid; a full render rebuilds it, so the drift tracked fallbacks (34 of 42
full renders vs 3 of 65 splices) and read as "every deletion" only because 44 %
of edits were falling back. **Picked**: measure `p1.getBoundingClientRect()`
after `finishPageMount`. Per-page error 2 px → **0**; over a sweep,
`scrollHeightChanged` 24 → **0** and the next-page anchor (which can never sit
inside an edit) moved on 7 of 39 edits — every one exactly −2.0 px — before, and
**0 of 20** after.

### 2. Spanner expansion iterated to a fixed point (the refusals)

`expandForSpanners` is a transitive closure, and the page splicer wrapped it in
a second loop that rounded to line boundaries and re-expanded. On the sonata's
926 spanners — 922 slurs, none longer than 3 measures, **none crossing more than
one line boundary** — ordinary legato phrasing (each slur ending where the next
begins) let one seed walk **17 slurs deep, 24 measures, 6 lines**.

**Picked** (Max's rule): *a spanner with one end inside the replaced set needs
the window to cover its other end.* Two single containment passes, no fixed
point — `L = onePass(changed measures)`, then `window = onePass(L) ± 1 context
line`. A spanner wholly outside the replaced set cannot change how those lines
draw; one dangling out of a context line is harmless, since context lines are
only measured for x/width. Implemented as a NEW `expandForSpannersOnce` used
only by the page splicer — the scroll splicer's run expansion and the naturals
window are a different geometry and were not measured, so they keep the closure.

**Rejected**: raising `MAX_WINDOW_LINES` (treats the symptom); truncating
spanners at the window edge and anchoring them to the synthetic leader/trailer
(the right answer for a genuinely document-long spanner — the sonata has none,
so it stays unbuilt rather than speculatively built).

**Measured** (per-measure seeds, all 446 measures): replaced set max 5 → **2**,
window max 14 → **6**, mean window 6.33 → **4.14**, seeds over
`MAX_WINDOW_LINES` **52 → 0**. Neither cap binds any more; both are now
backstops for pathological input.

**Sweep comparison, before → after** (116 lines, realistic mounting):

| | before | after |
|---|---|---|
| hit rate | 56.5 % | **66.1 %** |
| `window too many lines` | 12 | **0** |
| `changed line not mounted` / `score-start line` | 3 / 1 | **0 / 0** |
| `section-header line` | 5 | **1** |
| `context line below not mounted` | 11 | 19 |
| splice median / max | 261 / 526 ms | **245 / 389 ms** |

The `score-start` and four of five `section-header` refusals disappeared as a
side effect: a smaller replaced set no longer drags line 0 or a header measure
into the run. `context line below not mounted` ROSE because those edits
previously died earlier on the window cap — **B5 is now the dominant refusal
(19 of 39)** and is the next coverage item.

**Accepted cost**: the 8-edit battery went 7/8 → 6/8 — `insert-rest-ripple` now
refuses with `context line below diverged (dW=69)`, because a smaller window
puts a different line in the context slot. All 8 remain reference-clean, so this
is coverage, not correctness, and document-wide the trade is +11 splices for −1.
The context-diverged count held at 10 across the whole sweep, so the rule did
not create new divergences; those `dW` values are the same B3
courtesy-signature family.

**Where**: `apps/composer/src/render/render.ts` (placeholder sizing),
`apps/composer/src/render/splice.ts` (`expandForSpannersOnce`),
`apps/composer/src/render/pagesplice.ts` (one-pass replaced set + window,
`lastRun` diagnostic, cap comments), `test/composer-inspect/phasec/`
(cb-sweep, cb-pagebox, cb-window-walk, cb-spanchain), docs/lessons.md.

## 2026-08-31 — B5: the page splice mounts a lazily-virtualized page instead of refusing

**Context**: once `cb-sweep.js` stopped pre-mounting, mount misses became the
largest refusal class — 19 of 39 after the one-pass window rule landed. In real
use only 2–6 of the sonata's 30 pages are mounted, so a splice's context line
(usually the one BELOW, at a page boundary) is frequently still a placeholder.

**Picked**: `PageSpliceCtx.ensurePageMounted(page)` → `Renderer.mountPageIfCheap`,
called for every page the splice will MEASURE (the replaced lines plus the two
context lines) before the live-system lookups. Two guards, both load-bearing:

- **`tkCurrent`** — the toolkit already holds this page layout, so the mount is
  one `renderToSVG` (~50 ms). Without it `ensureTkHoldsPageLayout` reloads the
  whole document (~600 ms), which is most of what the fallback costs anyway.
- **not `stalePages.has(p)`** — a page an earlier splice edited would be
  re-serialized from the CURRENT model, i.e. rendered POST-edit, into a DOM the
  splice is about to patch with post-edit systems. Every live system the
  splicer measures must be pre-edit.

Either guard failing simply refuses, exactly as before.

**The page of a line comes from the PARTITION, not the DOM** — an unmounted
line has no element to look up. Pagination is pinned and `paginationHeld` is
checked by the caller, so `newPageStartIds` describes the mounted DOM too.

**Measured** (sweep, 116 lines): hit rate **66.1 % → 82.6 %**, `changed line
not mounted` and `context line below not mounted` **19 → 0**. Excluding the 8
rows where the edit never changed the document, that is **95 of 107 real edits
(88.8 %)**. Splice median 245 → 266 ms and max 389 → 534 ms — the mount cost,
paid on the edits that previously cost ~1.2 s. Battery unchanged at 6/8, all
reference-clean (it pre-mounts, so B5 cannot affect it). Suite 344/344.

**Fixture**: `pageSystemSpliceEnsureMount` forces page 2 back to a placeholder,
edits the last line of page 1 (whose context-below is page 2's first line), and
asserts the splice mounts rather than refusing. Verified to FAIL on the pre-B5
build with `refused on a mount miss instead of mounting`. Writing it also
surfaced a trap worth remembering: a full render REPLACES `pageVirt`, so a test
that captures it before re-rendering un-mounts a stale copy and leaves the
renderer's `mounted` set disagreeing with the DOM — an inconsistency production
code cannot produce and the splicer cannot detect.

**Remaining refusals** (sweep, 20 of 115): 8 edits that never changed the
document, 10 `context line diverged` (the B3 courtesy-signature family, `dW`
43–347 units), 1 `section-header line`, 1 `dRelX=36` outlier. B3 is now the
largest real class.

**Where**: `apps/composer/src/render/render.ts` (`mountPageIfCheap`,
`pageSpliceCtx`), `apps/composer/src/render/pagesplice.ts` (`ensurePageMounted`,
partition-derived `pageOfLine`, pre-lookup mounting),
`test/composer-test/fixtures.mjs` (`pageSystemSpliceEnsureMount`).

## 2026-08-31 — Page virtualization gets an eviction policy: the mounted set is a window around the cursor, not an accumulator

**Context**: after B5 the slowest splices were all mount cases (534 ms max, all
eight slowest had `mountedDelta 1`), and the mount measured **~138 ms**, not the
~50 ms the B5 note estimated. Max: *"we're waiting until after an edit is
requested to mount the adjacent pages. That's never worth it… why do we ever
need more than 3 total pages mounted at a time?"*

**The answer was that nothing ever un-mounted.** `mountPage` only added to
`pageVirt.mounted`; the only thing that removed pages was a full render
rebuilding the grid. So the mounted set was monotonic between full renders and
converged on "every page you have visited" — the sweep drifted 2 → 9 and the
battery's `mountAll` reaches 30. Perversely, B5 raised the ceiling *because*
improving the hit rate removed the full renders that were collecting the
garbage. Every `getBBox` in a splice flushes layout over all mounted pages
(A6), so the accumulator was a slow leak in edit latency: ~400 ms per splice at
30 pages versus ~245 ms at 2–6, and the scaling baseline is +260 % from 1 page
to 37.

**Picked**: `updateMountWindow(cursorMeasure)`, scheduled on idle from every
cursor update. Mount everything within ONE viewport of the view (the same band
the IntersectionObserver arms, so the two never fight) plus the cursor's page
and its two neighbours; evict anything mounted, unpinned, and beyond TWO
viewports. The gap between the bands is the hysteresis — without it, scrolling
along a page boundary churns, and a re-mount costs the same ~138 ms. The
cursor's neighbours are mounted eagerly because that is where the next edit
needs context, which moves B5's mount off the edit path entirely.

**Eviction only became safe earlier the same day.** Un-mounting restores the
explicit placeholder dims; while a placeholder was 2 px shorter than the mounted
page, evicting would have shifted the document under the reader — the very drift
that pass removed. Mount and un-mount are now geometry-neutral, and the sweep
confirms it: `scrollHeightChanged` 0, `pageBoxChanged` 0, and the next-page
anchor moved on **0 of 111** edits (the sample grew from 20 to 111 precisely
because the window keeps the next page mounted).

**Stale pages are evictable like any other.** Re-mounting one reloads the
document once (~600 ms) and leaves the toolkit current for everything after —
better than pinning every edited page in memory forever, which would rebuild the
accumulator out of exactly the pages an editing session touches.

**Measured** (sweep, 116 lines, cursor parked before each timed edit):

| | B5 only | + mount window |
|---|---|---|
| pages mounted at edit (min/median/max) | 2 / 5 / **9** | 2 / **3** / **3** |
| splices that mounted mid-edit | 19 | **0** |
| splice median / p95 / max | 266 / 494 / 534 ms | **236 / 340 / 381 ms** |
| hit rate | 82.6 % | 82.6 % |

Coverage is unchanged — eviction costs no splices, because B5's on-demand mount
remains as the fallback for anything the window did not anticipate.

**Verification harnesses opt out.** `setMountWindowEnabled(false)` exists for
gates that compare the WHOLE document or locate a measure through the page DOM.
The battery needs it both ways: eviction narrowed its reference compare from 30
pages to 5 *non-deterministically* (it lands on an idle callback), and it broke
`edit-page-first` outright — that edit finds its target via
`.score-page[data-page="3"] g.measure`, which returns null once page 3 is a
placeholder, so the edit silently did not apply. Caught only because the probe
asserts `docVersion()` changed rather than trusting the return value. Latency in
the battery is therefore worst-case by construction; `cb-sweep.js` is the probe
that measures realistic mounting.

**Where**: `apps/composer/src/render/render.ts` (`unmountPage`,
`pageOfMeasure`, `updateMountWindow`, `scheduleMountWindow`,
`setMountWindowEnabled`, IO callback re-evaluates the window),
`apps/composer/src/main.ts` (schedule on both cursor-update paths),
`test/composer-inspect/phasec/cb-splice-battery.js`,
`test/composer-test/fixtures.mjs` (`pageSystemSpliceEnsureMount` pins it off).

## 2026-08-31 — B3: the splice window pulls in the line that GENERATES an end-of-line courtesy signature

**Context**: `context line ... diverged` was the last large refusal class — 11
of the 20 remaining on the coverage sweep, every one reporting `dRelX=0.0` with
`dW` between 43 and 347 units.

**The design doc's framing was wrong.** It described B3 as *"a boundary moving
next to a clef/key change re-spaces the PREVIOUS line's end-of-line courtesy
signatures"*, with the fix being to re-splice line k−1. But all 11 refusals have
**`refillLines: 0`** — no boundary moved at all. The real mechanism is a
sub-document artifact: Verovio draws an end-of-line courtesy signature because
of the line that FOLLOWS, and the splice window does not contain that line, so
its last line renders without a courtesy the live page has. Width-only, which is
exactly the `dRelX=0.0, dW≠0` signature.

**Correlated before fixing** (`cb-courtesy.js`): 9 of the 11 have a
clef/key/meter change beginning the line immediately beyond the window's bottom
edge. Of the other two, one is a clef at the window's top edge and one is the
document's final line.

**Picked**: after the window is computed, extend it while the line just beyond
begins a signature change — bounded at two, because the sonata has runs of
consecutive meter changes that would otherwise chain the window forward
indefinitely. `beginsSignatureChange` recognises a section-level `<scoreDef>`
before the measure, or a `clef`/`keySig`/`meterSig` ahead of any event in its
first staff (a signature AFTER the first note is mid-measure and generates no
courtesy). Extending costs at most one or two lines on ~22 % of windows, and
adds no comparisons — the context check still only compares the two lines
adjacent to the replaced set, which are interior.

**Rejected**: re-splicing k−1 (the doc's plan — solves a case that does not
occur); teaching the synthetic trailer to carry the next line's signature change
(cheaper in window size, but reproducing an arbitrary clef/key/meter change on a
synthetic measure is far more fragile than including the real line).

**Measured** (sweep, 116 lines): diverged refusals **11 → 4**, hit rate
**82.6 % → 88.7 %** (95 → 102 splices). Splice median unchanged at 237 ms.
(At the time, 8 of the 115 rows were not edits at all — see the sweep-retarget
entry below; retargeting made all 115 real and left the rate at 88.7 %.) The battery recovers
`insert-rest-ripple` — the one edit the one-pass window rule had cost — and is
back to **7/8 spliced**, all reference-clean over 30 pages; the only remaining
fallback there is the section-header line.
(2026-09-01: not "by design" — an unresolved guard; see the exhaustive-sweep
entry.)

**Fixture**: `pageSystemSpliceCourtesySig` puts a key change at a line start and
edits **two** lines before it, so the courtesy-carrying line is the compared
context line and the line generating that courtesy sits just beyond the window.
Verified to FAIL pre-fix with `context line below diverged (dW=101.0)`. Worth
noting: the first version edited the line *directly* before the change and
passed on both code states — the generating line was already the context line,
hence already inside the window. A fixture for a boundary condition has to be
checked against the unfixed build, or it silently tests nothing.

**Remaining** (4 of 115): two more `context line below diverged` (dW 49 and
347), one top-edge `dRelX=36.0`, and the document's last line. Different or
compound causes; not chased.

**Where**: `apps/composer/src/render/pagesplice.ts` (`beginsSignatureChange`,
window extension), `test/composer-test/fixtures.mjs`,
`test/composer-inspect/phasec/cb-courtesy.js`.

## 2026-09-01 — The coverage sweep targets real content, so every line is a real edit

**Context**: 8 of the sweep's 115 per-line edits left the document unchanged,
sitting in the hit-rate denominator without testing anything. `cb-noopedits.js`
inspected them: **not empty measures** — all eight hold 7–24 notes. The cursor
was landing on a placeholder.

- **5 of 8: the edited VOICE is empty.** Staff 1 / layer 1 holds only an `mRest`
  (the music is in staves 2–3), and `flatChildren` skips that placeholder, so
  voice 1 has no events in the measure at all.
- **2 of 8**: the first event in voice 1 is a rest.
- **1 of 8**: the cursor lands on a `tuplet` boundary.

**Not an API defect** (Max, 2026-09-01): a delete with the cursor on a measure
or tuplet placeholder moves the cursor one position left — intentional, and
`true` reports that the requested action was performed, not that a delete
occurred. Undo restoring the cursor position is intentional too. So nothing
changes in the model; the earlier note calling this "an API wart… the same shape
as the bug that left two battery edits dead" was wrong on both counts — that bug
was a probe asserting nothing, and the API was accurate here as well. The
transferable rule is test-side only: assert `docVersion()` when you mean "the
document changed".

**Picked**: the sweep now targets the first `note`/`chord` on the line in
whichever voice has one, preferring measures after the line's first (mirroring
the battery's `delete-mid-line`) and falling back to the line's first measure.
It asserts a target was found rather than editing nothing.

**Measured**: 115 measured, **0 not applied, 0 without a target**. Hit rate
**94.8 % (109/115)**, splice median 231 ms — the best figures yet, and the first
where every sampled line is a real edit.

**A bug in the first version of this, worth recording** because the symptom was
the giveaway: it stopped at each voice's first in-line note, which is the
earliest in DOCUMENT order and therefore the WORST rank whenever it falls in the
line's first measure — the common case. So it silently retargeted all 115 lines
onto their first measure instead of the 8 that needed it, and reported
**exactly** 102/115 again. Max caught it on that alone: an intervention that
changes 8 samples and reproduces the previous total to the unit has not done what
it claims. (My reading of it — "none of the newly real edits splice" — was also
wrong; the targets had changed everywhere.)

**What the buggy run does show, measured per position** (`cb-seedreach.js`,
seeding the closure at every measure in the document):

| measure's position in its line | n | closure reaches prev line | reaches next line | mean systems replaced |
|---|---|---|---|---|
| first | 114 | **54 (47.4 %)** | 0 | **1.47** |
| middle | 216 | **2 (0.9 %)** | 0 | **1.01** |
| last | 114 | 0 | **56 (49.1 %)** | **1.49** |

The splice replaces whole systems, but HOW MANY comes from a MEASURE-level
closure of the changed measures rounded to lines — so where in the line the edit
lands decides whether that closure crosses a boundary. A first or last measure
is ~half the time an endpoint of a slur or tie whose other end is on the
neighbouring system, which must then be replaced too (its segment of that
spanner genuinely changes). A middle measure almost never is. Cross-checks
against the spanner census: 50 of 926 slurs cross a line boundary over 115
boundaries, plus tie edges.

The cause is NOT boundary movement — `refillLines > 0` in **zero** rows of
either sweep. Downstream, the extra system reaches line 0 and header lines:
lines 1 and 2 refuse `score-start line` with run `{0,1}` where the mid-line
target gives `{1,1}`/`{2,2}`, and lines 37 and 58 refuse `section-header line`
with runs extending one line back.

**RETRACTED 2026-09-01 by the exhaustive sweep.** The paragraph here used to
conclude that mid-line is "the easiest target" and that run B's 88.7 % was the
sweep sampling a harder case. Editing all 446 measures refutes it: splice rate by
position is **first 92.7 % (n=109), middle 91.5 % (n=201), last 92.6 % (n=108)** —
statistically identical. Position changes the closure's REACH (47.4 % vs 0.9 %)
and hence the number of systems replaced (1.47 vs 1.01), but not the outcome,
because the extra system is almost always fine. The B-vs-C gap was sampling
variance across 115 clustered samples, exactly as Max suspected when he first
pushed back. Two mechanisms proposed and both wrong before anyone measured the
thing the claim was actually about.

**The effect on the hit rate is small and clustered, though** — an earlier
version of this entry claimed "first-measure edits are measurably harder,
88.7 % vs 94.8 %", which overstates it. Only **9 of 115 lines flip**, one of them
in the OPPOSITE direction, and they are not independent: lines 77/78/79 all
refuse on the same divergent context line (dW=604.2), lines 1/2 share one cause
and 37/58 another. Four or five underlying causes, not seven independent
samples. The backward-extension count is the solid finding; the hit-rate gap is
not.

**Comparing figures across dates**: hit rates recorded before 2026-09-01 used a
measure-start cursor, where 8 lines performed a cursor move rather than a
deletion. They are internally consistent (B3's 82.6 % → 88.7 % is a valid
before/after — both sides used measure-start targeting) but are NOT comparable
to the 94.8 % above.

**Where**: `test/composer-inspect/phasec/cb-sweep.js`,
`test/composer-inspect/phasec/cb-noopedits.js`.

## 2026-09-01 — Exhaustive every-measure sweep: refusal is a function of the replaced set, so mid-line sampling is the right routine gate

**Question** (Max): does splice refusal depend on more than the specific line(s)
in the replaced set? If not, a mid-line sweep is a complete inventory and
first/last-measure edits merely re-derive adjacent lines. Sharpened to the
decisive form: *is there any case where lines L−1 and L each splice on their own,
while the replaced set {L−1, L} fails?*

**Method**: `cb-allmeasures.js` edits EVERY measure that has deletable content
(first note/chord in whichever voice has one), records the replaced set and
outcome, and restores via `restoreSnapshot`. Chunked by `allmeasures.sh` — the
runner's `Runtime.evaluate` deadline is 300 s and the full walk needs ~4× that;
each chunk is saved as it completes so a kill costs one chunk and a re-run
resumes. `allmeasures-report.mjs` merges and analyses.

**Answer: no such case exists.** 446 measures, 420 real edits, 0 undetermined:

- **0 of 62 multi-line replaced sets fail while every constituent splices.** All
  5 failing multi-line sets are inherited from a failing constituent
  (`{0,1}←{0}`, `{36,37}←{36}`, `{53,54}←{54}`, `{57,58}←{57}`, `{59,60}←{59}`),
  and every constituent was sampled, so the test is conclusive rather than
  partial.
- **Refusal is a function of the replaced set**: 170 distinct sets, **0
  conflicts** — no set ever produced both a splice and a refusal, regardless of
  which measure or which voice triggered it.
- **Position within the line does not affect the outcome**: first 92.7 %,
  middle 91.5 %, last 92.6 %. See the retraction above.

**Full refusal inventory on the sonata — 7 causes, 34 of 420 edits (91.9 %
splice rate)**:

| n | cause |
|---|---|
| 9 | `section-header line` — NOT by design; see below |
| 6 | `score-start line` — NOT by design; see below |
| 6 | context below diverged `m-5o3` dW=347 |
| 5 | context below diverged `m-5iq` dW=49 |
| 5 | context above diverged `m-5x4` dRelX=36 dW=12 |
| 2 | context below diverged `m-8ej` dW=604.2 |
| 1 | context above diverged `m-cy6` dW=89 |

Five distinct divergent context lines, none of them the courtesy-signature class
B3 fixed.

**Correction (Max, 2026-09-01): the first two are not "by design"** — this doc
had repeatedly called them that, and it is wrong. The code comments say the
section-header title and reserve are *"page-mount injections (NOT idempotent)"*
and that line-0 window fidelity is *"unproven ... drifts ~1px"*. Both are
unresolved problems. They are also **44 % of all refusals** (15 of 34) against
19 spread over five separate divergent lines — two root-causings for nearly as
much coverage as five. And both are now more tractable than when the guards were
written: the reserve is already readable from `data-reserve` (B4), leaving only
the title's own y to recompute when the header's system is replaced; and the
line-0 drift of ~1 px is ~10 units, INSIDE the `EPS` of 25 the context check
tolerates everywhere else, so that guard may simply be stale. Re-measure k=0
before writing code. These lead the next thread.

**Decision**: `cb-sweep.js` (one mid-line measure per line) stays the routine
gate — it reaches 127 of the 170 replaced sets and finds 6 of the 7 causes. The
exhaustive pass stays as periodic tooling, because it is what produced this
inventory and it is the only thing that would catch a failure class appearing
ONLY in multi-line sets. **One known blind spot** in the routine gate:
`m-cy6 dW=89` (n=1) was seen only at a line edge — the document's final line.

**Where**: `test/composer-inspect/phasec/cb-allmeasures.js`, `allmeasures.sh`,
`allmeasures-report.mjs`, `cb-seedreach.js`, `cb-noopedits.js`.

## Render errors are logged and, under HKL_INDEX_CHECK, re-thrown (2026-09-01)

**Context**: `doReRender` ended every render-path throw at
`setStatus('render error: …', 'error')` — DOM text, no console. The page
splicer's `verifyAgainstReference` gate therefore detected divergences and lost
them: it reported a 643-unit staff-top error and the suite passed. See
lessons.md, "A gate whose throw is caught is not a gate".

**Decision**: that catch now always `console.error`s, and re-throws when
`globalThis.__HKL_INDEX_CHECK === true`. The composer-test suite fails on any
console error, so a gate failure now fails the run; under the index check it
also propagates to the caller, so a fixture's own `H.reRender()` throws where
the assertion can see it. The three user-action catches (save, MusicXML export,
PDF export) keep their status messages — telling the user is correct there — but
they log as well; a failure the user is told about should not also be invisible
to the developer.

**Rejected**: re-throwing unconditionally. A render error mid-session would then
take the app down rather than degrade; the status bar is the right UX for a
human, it was simply the ONLY thing happening.

**Verification discipline this establishes**: a gate is confirmed by making it
fail on purpose, not by observing that it exists. Note that `pnpm test:composer`
is `run.mjs full` and does NOT set `HKL_INDEX_CHECK` — use
`HKL_INDEX_CHECK=1 node test/composer-test/run.mjs full` when the reference gate
is what you are relying on.

## The two named-zone splice refusals are retired: line 0 and section-header lines (2026-09-01)

**Context**: the exhaustive pass attributed 15 of 34 refusals to two guards
excluded BY NAME rather than by measurement — `score-start line` (6) and
`section-header line` (9). Per the correction above, neither was a design
choice.

**Line 0**: the guard cited a probe (`cb-window.js` k=0, "~1 px") that measured
the PRE-ownership window recipe — tall page, `header:'none'`, closure-based
spanner expansion — none of which the splicer still uses. Under the current
recipe a window whose `wLo` is 0 takes no synthetic leader and simply IS the
score start: same meiHead, same credits band. Re-measured on the sonata at
8/12/9 units (x / width / absolute staff top) against the `EPS` of 25 the
context check tolerates everywhere. What IS structurally special is that line 0
has no predecessor, so `ctxPrev` is now optional and the splice asserts line 0
is page-first (it must be) rather than chaining a vertical plan from a line
above it.

**Section headers**: the guard called the title and reserve "page-mount
injections (NOT idempotent)". That is true of re-RUNNING `injectSectionHeaders`,
which a splice never does — it replaces systems inside an already-injected page.
The reserve half was already solved (B4). The remaining half is the title's own
y, and the fix is the same shape: the injector now records `data-baseline`
beside `data-reserve`, so the DOM states the whole placement rule — **a title's
baseline sits at its system's content top, minus the reserve accumulated at that
system, plus the baseline offset** — and the splicer re-derives it from the
replacement's measured content top whenever it re-engraves a title's own system.
Recorded rather than imported, for the same reason the reserve was: one source
of truth, and an unreadable value refuses the page instead of being guessed.

**Consequence**: nothing is excluded by name any more. Refusals are structural
only — the context-line check. Sonata battery **7/8 → 8/8** spliced (all
reference-clean); routine sweep **94.8 % → 95.7 %**; exhaustive every-measure
pass **91.9 % → 94.5 %** with refusals **34 → 23** and causes **7 → 6**. The 15
refusals the two guards held became 11 splices and 4 at `m-5q8` — a sixth
divergent context line the header guard had been masking, sitting directly above
the movement-III header, and therefore a candidate to share a cause with the
backlog's "no preview signature changes over section breaks". The pass also
confirms no failure class specific to multi-line replaced sets: 3 of 62 fail,
all inherited from a failing constituent, 0 failing while every constituent
splices.

**What it cost to find**: removing the line-0 guard exposed a real bug in the
UNOWNED window recipe (`header: 'none'` removed the page-1 `pgHead` band, so the
absolute page-first anchor was 650 units off and the page slid under its own
title). Fixed by not suppressing the header there. The sonata could not have
caught it — its pagination is owned. See lessons.md, "Two window recipes".

**Fixtures**: `pageScoreStartSplice`, `pageSectionHeaderOwnLine` — both verified
to fail on the unfixed build. **Probe**: `cb-startzone.js`.

## 2026-09-01 — Every remaining context-line refusal on the sonata traced to three mechanisms; the run widens for a relocated clef at the SPLICER, not in the signature

The six divergent context lines left in the design doc's START HERE list were
root-caused in one pass with a refusal-path diagnostic (`lastContextDiff`,
`lastWindow`, `lastWindowMei` on `PageSystemSplicer`; probe `cb-ctxdiverge.js`)
rather than by hypothesis. Three mechanisms, all fixed:

1. **Courtesy check holes** (`beginsSignatureChange`, pagesplice.ts) — the B3
   rule pulls in the line that generates an end-of-line courtesy, but it tested
   only the measure's immediate previous sibling for a `scoreDef` (the importer
   and `setSectionHeaderAt` emit `scoreDef > sb[section] > measure`) and scanned
   only the first staff for a leading clef. Now walks back to the nearest
   measure-bearing sibling and scans every staff. Lines 55, 56, 78 (dW 49 / 347
   / 604 — the II→III and III→IV movement boundaries).
2. **Range head clef** (`runningScoreDefContext`, model/index.ts) — a range
   opening at a measure with a leading clef drops that clef
   (`relocateInitialClefs(clone, true)`) but the head scoreDef kept the clef
   from BEFORE the measure, so the whole sub-render drew in the old clef. The
   target's leading clefs (first child of a layer — exactly what the relocation
   drops) are now folded into the head. Lines 56, 58 (windows opening at
   measures 226 and 230, `dRelX 22 / 36`). This path is shared with the scroll
   splicer.
3. **Relocation dependency** (`trySplice`, pagesplice.ts) — `relocateInitialClefs`
   renders measure i's measure-initial clef inside measure i−1, so an edit that
   makes a clef measure-initial (or stops it being so) re-engraves the measure
   before the changed run. The run now extends one measure left when its first
   measure holds any layer clef. Line 114 (the document's last measure, `dW 89`).

**Where the relocation dependency lives.** The alternative was to make the
per-measure signature of measure i−1 incorporate measure i's leading-clef state,
so the sig-diff itself would report both measures changed. Rejected: the
signature is a serialization of the measure's own content and is cached per id
(`sigEl`), so a cross-measure term would need its own invalidation when the
NEXT measure mutates — a second dirty-tracking path for one dependency. Widening
the run at the splicer is one line, needs no pre-edit model (any layer clef in
the run's first measure triggers it, covering both directions), and costs at
most one extra measure of window. The same one line went into the scroll
splicer's run derivation (`splice.ts`), which imports only `lo..hiNew` and
would otherwise leave i−1's change glyph stale.

**Measured** (sonata): the six seeds that refused now all splice
(`cb-ctxdiverge.js`), `cb-splice-battery.js` 8/8 reference-clean, routine sweep
**95.7 % → 100 %** (115/115). Fixtures: `pageSystemSpliceCourtesyBehindSectionBreak`,
`pageSystemSpliceCourtesyClefOtherStaff`, `pageSystemSpliceRelocatedClef`,
`rangeSerializeLeadingClefHead`. The exhaustive every-measure pass is recorded
in the design doc's status log: **94.5 % → 100 %**, 420/420, empty refusal
inventory.

## 2026-09-01 — Inline clefs are interior structure: a clef edit derives (page view) or full-renders (scroll view)

Found while fixturing the relocation rule above: after `setClefAtCursor` in page
view, the splice re-engraved only the clef's own line and left every later line
in the OLD clef (the reference gate showed lines 4–5 960 units short and in the
wrong clef). The per-measure sig-diff marks one measure dirty; the clef governs
the rest of the staff.

**Decision**: treat inline layer clefs exactly like mid-piece `<scoreDef>`s.
`computeInteriorSig` now includes every `layer > clef` as `position:staff:
shape+line:dis` (never xml:id), so any insert/remove/change of a clef bails the
refill to a derive — the same conservative path key and meter changes already
take. The scroll splicer gets the matching guard: if the changed run's SET of
clef tags (ids stripped) differs between the old and new signatures, it returns
false and the caller full-renders. A clef that merely MOVES (a note deleted
ahead of it, making it measure-initial) leaves both signatures unchanged and
stays on the splice path — that case is the relocation rule's job.

**Rejected**: extending the dirty run to the next clef on that staff. It would
usually be the rest of the document, hit the run caps, and full-render anyway —
with a second dirty-tracking mechanism to maintain. Clef edits are rare; a
derive is the right price for a correct render.

**Cost**: `computeInteriorSig` gains one `querySelectorAll('layer > clef')` per
edit (tens of elements on the sonata). Fixture `pageSystemSpliceRelocatedClef`
(its first render after the clef insertion is now the derive; its delete is the
splice under test).

**Noted, not fixed**: a clef set on an EMPTY layer does not roundtrip
(`<clef/><space/>` → `<space/><clef/>` on load). See lessons.md.

## 2026-09-01 — A running scoreDef context only overwrites what it carries (`meter.sym`)

Max's smoke test after the sonata refusals were cleared: any edit on the first
line turned the cut-time signature into "2/2"; remounting restored it. The
splice window's range head had lost `meter.sym`. `stampRunningCtx` wrote the
running meter's symbol as `if (sym) set else remove`, unconditionally, and a
range opening at measure 0 has an EMPTY running context — nothing precedes the
target — so the document head's own `cut` was removed while its 2/2 stayed.
Mid-score windows had the same hole and never showed it (the meter is drawn only
on the discarded leader); line 0 had been refused by name until the day before.

**Decision**: the symbol is written or cleared only when the context carries a
meter override (`meterCount`/`meterUnit` non-null), mirroring how the context
itself only records a symbol alongside an override (`applySd`). Key and clef
already followed this rule; meter.sym was the one attribute with an
unconditional clear. General rule for any future context field: "no override
seen" and "override with an empty value" are different states.

**Why no gate saw it**: every gate compares geometry, and the cut-time glyph is
within `EPS` of the stacked numerals. Fixture `pageScoreStartSpliceKeepsMeterSym`
reads the meter glyph codepoints across a line-0 splice. Whether to add a
glyph-identity comparison to the reference gate and the context check is
proposed in the design doc's START HERE (Max's call — the context-check half
changes splice behaviour).

## 2026-09-01 — The reference gate compares signature glyph identity, not only geometry

Two same-day findings passed every geometry gate: a window drawn in the wrong
clef (refused only by 11–36 units of incidental ledger-line drift) and cut time
rendered as "2/2" on a line-0 splice (not refused at all). `verifyAgainstReference`
(the `HKL_INDEX_CHECK` deep gate) now also compares, per measure, the SMuFL
codepoints of every `g.clef` / `g.keySig` / `g.meterSig` glyph between the
spliced DOM and the fresh reference render (`sigGlyphs`, the `use` href before
its per-render hash). Exact, no layout flush, index-check only — so no hot-path
cost and no behaviour change. The reference host is POST-PROCESSED first (the
same `postProcessRendered` the live pages and window hosts get): the HEJI pass
replaces key-signature `use` glyphs with injected `<text>`, so a raw reference
compares its flats against a live page that has none — the check's first run on
the sonata's line 0 was exactly that false divergence.

**Deliberately NOT done yet**: the same comparison in the live context check
(`spliceDom`), which would refuse a wrong-signature window by construction. That
changes splice behaviour (more refusals are possible) and is Max's call; it is
listed in the design doc's START HERE. The census that would feed it is already
recorded on the refusal path (`lastContextDiff`).

## 2026-09-01 — Signature glyph identity is a LIVE splice refusal, not only a test-time gate (Max)

Earlier today the glyph comparison went into `verifyAgainstReference` only, with
the live half left as Max's call because it can add refusals. Max's ruling:
promote it — "that's exactly the kind of silent failure that we need to catch.
Promoting it to a refusal is the only way for us to find and fix it, and would
have stopped the time signature bug from persisting unnoticed as long as it did."

**What refuses now** (`spliceDom`, `sigGlyphDiff`): per measure, the SMuFL
codepoints of every `g.clef` / `g.keySig` / `g.meterSig` glyph must match
between (a) each context line's window system and its live system, and (b) each
REPLACED line whose two boundaries did not move and the live system it is about
to replace. (b) is sound because on the splice path nothing may change a line's
signatures — a clef, key or meter edit derives via the head/interior signature,
and a moved boundary is excluded — so any difference is a window that
mis-rendered. (b) is also the check that would have refused cut time drawn as
"2/2" on the sonata's line 0 at the FIRST splice. Both sides carry the same
post-processing (window hosts and mounted pages), so the comparison is
symmetric; it reads attributes only. A refusal records `lastContextDiff` for the
context-line case so the census names what differed.

**One exemption, found by the first run** (`pageSystemSpliceRelocatedClef`
refused with `window "E07C" vs live ""`): clef glyphs on a replaced line that
holds a layer clef, or whose successor begins with one. There the clef SET is
unchanged but its drawn form legitimately moves — `relocateInitialClefs` turns
a clef that has just become measure-initial into a system-start clef on its own
line and a cautionary on the line above. Key and meter glyphs have no such
mechanism and are compared on every standing line; clef-bearing lines keep
their clef check in the reference gate. Context lines are compared in full.

**Cost**: `querySelectorAll` over the ~14 systems a splice profiles — no layout
flush, no measurable time. **Risk accepted**: a legitimate glyph difference we
have not thought of would surface as a new refusal reason in the sweep
histogram ("signature glyphs diverged"), which is the point.

Fixture `pageSystemSpliceRefusesGlyphMismatch` (forges a meter glyph href on the
live context line, expects the refusal and the repairing full render).

## 2026-09-01 — Signature changes are RANGES, not derives; the replaced lines are never compared live (Max)

Two corrections from Max to the day's work, both to the same misconception.

**The principle** (Max, verbatim): "The goal is to hit O(edit) in ALL cases. Any
time the user is exposed to O(document) on a live path when they didn't ask for
a change to the full document is a failure, full stop." A clef, key or meter
change governs the measures from that point to the next change of the same kind
on the same staff — that range, and only that range, must re-engrave. A change
with a later reset is O(range); one without genuinely governs the rest of the
staff, and re-engraving that much is what the user asked for. Whether that still
splices is the run caps' business (B2), not a reason to route every such edit
down the slow path.

**What was wrong.** Mid-piece key/meter changes had derived since the interior
signature was introduced (2026-08-30); earlier today inline clefs were added to
that signature so clef edits derived too, and the scroll splicer got a matching
full-render guard. I then described "clef/key/meter edits derive" as an
invariant and built a live glyph comparison on the REPLACED lines on top of it,
with a clef exemption to patch the case where the "invariant" failed. A fallback
is not an invariant, and the replaced set is by definition what the edit told
Verovio to redraw — its post-edit appearance is unknowable live, so comparing it
against the pre-edit page tests nothing legitimate.

**Decision.** `render/sigranges.ts` holds the signature STATE both splicers
capture with their per-measure baseline: the head scoreDef's key and meter
parts (everything else in the head, plus the pre-first-measure elements and the
credits, is `rest`), every interior scoreDef anchored by element identity and by
the id of the measure that follows it, and per-staff clef tags of any measure
the diff marked changed. `signatureRanges` turns the differences into governed
ranges — `[pos, next reset of the same kind)` for key and meter (head or
interior), `[measure, next clef on that staff)` for clefs — which are unioned
into the changed run BEFORE the partition repair, so the range's natural widths
are re-measured and the normal replaced-set logic decides splice vs fallback.
Only a `rest` change (a staffDef, a structural element) still derives /
full-renders. The replaced-line glyph comparison and its exemption are removed;
the context-line glyph comparison and the reference-gate glyph comparison
stay — context lines must look the same, and the reference gate is where every
test run verifies the replaced lines against a fresh full render.

**Found on the way.** In scroll view a mid-piece key change rendered NOTHING —
the scroll splicer's per-measure diff cannot see a section-level scoreDef and
nothing else forced a render (`cb-...` probe, 2026-09-01). The range rule fixes
it: the change's governed range splices into the persistent SVG.

**Superseded**: the entries "Inline clefs are interior structure" (derive) and
the replaced-line half of "Signature glyph identity is a LIVE splice refusal"
above. Fixtures: `pageKeyChangeSplicesGovernedRange`,
`pageMeterChangeSplicesGovernedRange`, `pageClefChangeSplicesGovernedRange`,
`scrollKeyChangeSplicesGovernedRange`, `scrollClefChangeSplicesGovernedRange`.

**Refinements from the first fixture runs of the range rule (same day):**
- **Every range starts one measure early.** A signature change at measure p
  also re-engraves p−1: the end-of-line courtesy (key/meter) and a
  measure-initial clef's relocated change glyph land there. Without it the line
  above rendered as an unchanged context line that had changed, and the context
  check refused (dW 101 on `pageKeyChangeSplicesGovernedRange`).
- **A clef range includes the measure holding the next clef when that clef is
  mid-measure** (its notes before the clef, and its system clef if it begins a
  line, are still in the changed prevailing clef) and excludes it when the clef
  is measure-initial. Key/meter resets sit before their measure, so those ranges
  end one measure before the reset.
- **The dirty range is measured in one window before the repair loop.** The
  repair loop ensured naturals per examined line under `MAX_ENSURES` (4), so a
  bounded range over four lines derived anyway. One window over the range costs
  exactly the range.
- **Namespace declarations are not structure.** `setMeterAt` writes
  `hkl:beat-groups` with setAttributeNS, which adds `xmlns:hkl` to the scoreDef;
  left in `rest`, every meter change read as "interior structure changed".

## 2026-09-01 — Splice size caps dropped (both splicers); a subset render is never the worse deal (Max)

Max: "Isn't it always better to rerender any subset of the document instead of
the full document?" It is. `MAX_SPLICE_LINES` (5), `MAX_WINDOW_LINES` (9) and
`MAX_WINDOW_MEASURES` (80) were backstops from the fixed-point spanner
expansion, which could balloon a window; after the one-pass rule the sonata's
worst case was 3 replaced lines and a 7-line window, and they survived only as
a safety net. A window costs linearly in its measures right up to the whole
document, where it equals a full render — and the splice reuses every mounted
page where a full render rebuilds them — so no size is a reason to refuse. The
scroll splicer's `RUN_CAP` (60 measures) went for the same reason.

**What limits a large splice is structural**: the line count must not change
(N → M replacement is unbuilt, B2), pagination must hold (a reflow across a page
boundary hands pagination back), and the fidelity gates. Those refuse; size
never does.

**Measured (sonata, `HKL_INDEX_CHECK` reference-clean)**: a key change at line
20 governing to the next key change replaces 17 lines through a 78-measure
window in 1.18 s (naturals window 0.48 s, window `loadData` 0.39 s); a
width-neutral meter change replaces 25 lines / 106 measures in 1.32 s; a
staff-1 clef change 7 lines in 0.44 s. A full render is ~1.7 s. All three
refused on `too many changed lines` before. The two linear costs — the naturals
window at ~5.5 ms per measure and the window load at ~5 ms per measure — are the
first A-thread targets for large edits.

**Also measured, test-mode only**: under `HKL_INDEX_CHECK` the same key change
takes ~44 s, because `flatChildren` (4 751 calls, 12.5 s) and `allMeasures`
(25 121 calls, 2.5 s) re-verify their caches on every hit and a large-range edit
multiplies the call sites. Not a production cost; noted under A.

**Addendum (same evening) — interior scoreDefs are matched by their successor
measure's id, never by element identity.** The first cut aligned old and new
interior entries by element object. `restoreSnapshot`, undo and redo swap the
whole document, so every scoreDef element was new, every entry read as removed
and re-added, the union became the whole document, and every undo of an edit on
a document with interior scoreDefs derived (`cb-bigrange.js`: three undos, zero
naturals windows; the sonata sweep's 115 restores then blew its 300 s deadline
even alone). Measure ids survive a swap; the entry key is now `nextId`, two
scoreDefs before one measure merge, and the structural flag is computed at
capture time. Undo of the 17-line key change: derive → splice in 1.24 s. The
page-range fixtures now assert the undo splices too.

**Also seen**: a large replaced set can still fall back with `changed line not
mounted` when a line sits on a page a PREVIOUS splice marked stale — B5's cheap
mount refuses stale pages (it would render post-edit content into a DOM about
to be patched). Listed with the remaining O(document) paths.

## 2026-09-01 — Test-mode verifications run once per document version; `locateCursor` reads the cached stops

The design doc's A-thread item "test-mode O(n²)": under `HKL_INDEX_CHECK` the
model verified `flatChildren` / `allMeasures` against the live DOM on EVERY
cache hit, and a 17-line key change on the sonata made 25 121 `allMeasures` and
4 751 `flatChildren` hits — 45 s in test mode against 1.2 s in production.
Two changes:

1. **Verify once per document version.** `measuresVerifiedVer` and a per-voice
   `flatVerified` set (cleared with the flat cache) record what has been
   checked at the current version. This is not a weaker gate: the version is
   drained synchronously from the MutationObserver at the top of each accessor,
   so two hits at the same version have zero mutation records between them and
   would compare the identical DOM — the second check could only repeat the
   first. Every DOM mutation type that `querySelectorAll('measure')` or the
   stop enumeration can see (childList, attributes, characterData, subtree) is
   observed, so nothing escapes the version.
2. **`locateCursor` / `locateFlatElement` use `model.flatChildren(voice)`**, the
   cached accessor, instead of the module-level implementation. They are
   called once per stop by the uncached tick/boundary helpers that
   `assertVoiceIndexConsistent` runs, so the fresh enumeration made one
   cross-check O(stops × document): 24 s of the 27 s that remained after (1).
   Production callers of `locateCursor` (one or two per mutation) save ~2 ms
   each on the sonata. The cross-check stays independent: the cached stops are
   themselves compared against the fresh enumeration on their first hit per
   version, and the check's own first step enumerates fresh.

Not changed: `getMeasureStartCursorUncached` is O(measure index) per call and
the check calls it once per measure — 0.7 s per index build on the sonata under
the flag. Once per build, not per edit range; recorded in the design doc as the
test-mode residual. Attribution probe: `cb-checkcost.js`. Bigrange under the
flag: key case 45.1 → 3.8 s, meter 38.8 → 2.5 s (the remainder over production
is the reference gate's own full render); outcomes and reference gate identical
across all three cases before and after.

## 2026-09-01 — A thread measured before it is built: where the splice time goes, and three dead ends

Max: "get these ideas fleshed out and get a better idea of the real savings
available" (the three A items: A6 flush-bound DOM, naturals window cost, window
`loadData`). Four probes (`cb-splicecost.js`, `cb-naturalsalt.js`,
`cb-windowalt.js`, `cb-svgopts.js`) answered them; the numbers are in the
design doc's "Where the time goes". What was decided:

- **Verovio's `renderToSVG` is the cost, not `loadData`, and it is intrinsic.**
  0.6 vs 3.4–4.5 ms/measure on the naturals shape; the first draw after a load
  carries the lazy layout (+30–40%) and production always pays it. SVG string
  formatting is not the cost (`svgFormatRaw` leaves the draw unchanged), so no
  output option makes Verovio faster — only a smaller window does.
- **The window is not shrinkable without a gate change** — leader and trailer
  are ~3 ms and the leader is gate-only (the replaced line's geometry is
  identical without it), so the ~60 ms available from a replaced-lines-only
  window all comes from dropping the context lines, i.e. the only live
  fidelity test, plus the courtesy for the replaced line and out-of-set spanner
  endpoints. Recorded as unavailable; the 84 ms is the floor for this shape.
- **Naturals stay on one giant `breaks:'none'` system.** Pinned lines are no
  cheaper (5.4 vs 5.2 ms/measure) and would need per-system clef/key
  corrections on system-first measures. The removable part of the naturals
  cost is the DOM side (parse + layout flush + `getBBox` ≈ 1.5 ms/measure) —
  A7 reads widths from the staff-line paths of a never-attached parse.
- **The DOM side was mis-sized.** The doc said ~16 ms; the splice's DOM work is
  ~50 ms once the post-processing of the window hosts (30 ms, 14 of whose 20
  measures are discarded) and the forced flushes (~21 ms on the splice path,
  27 in all) are counted. A6's call-count framing was right that flushes rule
  and wrong about the budget.
- **Ordered plan** (all gate-neutral): A7 layout-free naturals (~16 ms), A8
  post-process only the replaced systems with HEJI still on the whole host
  (10–15 ms, measure the passes first), A9 `svgFormatRaw` (~3 ms), A10 lazy
  history snapshot (~12 ms), then A6 one-layout-per-host (~4.5 ms, fragile).
  ≈ 40–45 ms of ~170 (25%). Behaviour gate for each: `cb-splice-battery.js`
  on both code states, outcomes and `reference.ok` identical; then
  `cb-splicecost.js` for the wall.

## 2026-09-01 — A7: naturals are read from the SVG text; `sigW` is keyed on the window's folded head

The naturals window (the refill's offscreen `breaks:'none'` render that
supplies unjustified measure widths) used to be attached to `<body>` and read
with `getBBox` — a forced layout of a page-sized SVG per window, plus a second
forced layout when the splice first read the live page (dirty only because the
host had been attached and removed). Now the width is the measure's staff-line
path extent parsed out of the SVG string with `DOMParser`; nothing is attached.

- **Why the span is the right number**: proven equal to the old bbox natural on
  441/443 interior sonata measures and every window-last measure. The two
  differences are window-FIRST measures, where the bbox started 144 units left
  of the staff line (the system-start brace/barline) — i.e. the old reading
  over-counted measure 0 by the brace. The span is the width Verovio lays the
  measure out with; the cache stays deterministic because every measure now
  gets the same value whichever window measures it.
- **`sigW` stays a `getBBox` measurement** (glyph ink metrics), but is
  re-measured only when the window's folded head — the sub-MEI before
  `<section>`, into which `serializeRangeForRender` folds the running
  clef/key/meter at `lo` — differs from the head of the window that last
  measured it. Interior scoreDefs and inline clefs inside a window do not
  change the LEADING signature and never changed the old measurement either
  (it read the first system's leading glyphs), so they don't trigger. A first
  cut that triggered on any scoreDef/clef inside the section re-measured on
  every sonata window (the LH clef changes are everywhere) and saved nothing.
- **Gates**: battery identical to the pre-A7 run (8/8 spliced, reference
  clean), suite 358/358 under the flag, `cb-splicecost.js` naturals 48 → 37 ms
  and the first live read 7.3 → 2.2 ms.

## 2026-09-01 — A8: post-process only the systems the splice imports; the host's first geometry read is the real cost

`postProcessRendered` gained a `scope` (the `g.system` elements that will be
imported). Per-system passes — `snapBarlines`, `snapSystemRightEdge`, notehead
reorder, `applyNotationTheme` — run only on those; `pinExactScale` (root-svg
box, which every snap reads through `getScreenCTM`) and `injectHejiGlyphs`
(the context gate compares key-signature glyph identity against HEJI-processed
live pages) stay host-wide. An EMPTY scope means "nothing on this host is
imported" and does not fall back to the whole host. The notation helpers now
take `Element`; `snapSystemRightEdge` accepts a system itself as its container.
The page splicer calls it from `spliceDom` once the window systems are located.

Result: post 30 → 24 ms, splice 147 → 143. The per-pass timings
(`Renderer.lastPostStats`) explain the small win: on one scoped system,
`snapBarlines` alone is ~22 ms, all of it the first `getScreenCTM` — the first
geometry query on a freshly parsed page-sized SVG host forces its initial
layout. That ~20 ms flush had been hiding inside "post" and is the DOM-side
floor while ANY read on the host needs layout. Recorded as A11 (a never-laid-out
host: path-based profiles on both sides; snap the imported systems in the live
page instead), which is a redesign of the gate's measurement basis and goes to
Max as a proposal first.

Gate note: the context-line comparison is now raw-window vs snapped-live; the
snaps move a barline ≤ ½ device px (≤ 10 user units at the 50% preset), inside
EPS 25, and the two sides' snaps were computed in different device frames
before too. Battery identical to base (8/8 spliced, reference clean). The full
suite failed `pageKeyChangeSplicesGovernedRange` once with `editLine=-1` (its
pre-edit line-2 start no longer started a line); re-run 3× on A8 and 3× with
A8 stashed: 6/6 pass — a marginal partition in that fixture, not A8.

## 2026-09-01 — A9: Verovio emits raw (unindented) SVG everywhere

`svgFormatRaw: true` in the renderer's `BASE_OPTIONS`. Verovio pretty-prints
its SVG by default — indentation proportional to nesting depth on ~18 000
elements per 100 measures — which is 40% of the string and a third of the
browser's parse time (`cb-svgopts.js`: 1.68 → 1.0 MB, `innerHTML` 41.8 → 26.8
ms per 100 measures; `renderToSVG` itself unchanged). Pretty-printing never adds
whitespace adjacent to text content, so `<text>` is byte-identical; element
counts are identical; nothing in the composer walks whitespace-sensitive
siblings (the mode cache's `childNodes` is element-agnostic). Measured on the
steady edit: window hosts' parse 10 → 5.7 ms, naturals parse 2.3 → 1.9. Gates:
battery identical to base, every visual baseline unchanged under the full
suite. Side effect: the PDF export's toolkit inherits the persisted option, so
exported SVG is raw as well — whitespace only.

## 2026-09-01 — A10: the history AFTER snapshot is serialised lazily, never after the document changes

`withHistory` serialised the whole document twice per edit until Phase B3
halved it by reusing the previous AFTER as the next BEFORE; the remaining AFTER
`XMLSerializer` (~12 ms on the sonata) was the largest non-Verovio cost left on
the keystroke. It is now lazy: `model.snapshotStateLazy()` returns a snapshot
whose `mei` is a getter, plus the exact document version.

- **The invariant** is that a lazy snapshot is materialised before the document
  can change. Every mutation path in Composer takes a BEFORE snapshot first, so
  `snapshotState` / `snapshotStateReusing` materialise any pending lazy one;
  so do `restoreSnapshot*` (undo/redo swap the document) and `replaceDocument`
  (load). An idle callback (300 ms timeout) serialises it when the user pauses;
  a second edit before idle pays it at its own start — the same 12 ms as
  before, never twice. Under HKL_INDEX_CHECK, materialising after the version
  moved throws; in production it warns. This is the same failure class the
  existing "reused MEI is stale" assert catches one edit later.
- **No-op detection moved.** `push` compared MEI strings, which would force the
  lazy AFTER. Equal document versions prove an identical document (the
  MutationObserver drain is exact) and push nothing. Different versions do not
  prove a change — `setAttribute` to the same value bumps the version — so the
  entry is pushed optimistically and the comparison is settled when the AFTER
  materialises (`resolvePending`, run before any push / undo / redo / canUndo):
  an identical MEI retracts the entry and restores the redo stack it cleared,
  exactly what the eager check used to do. The cut→paste merge path settles
  eagerly (not a keystroke path). Dialogs keep eager snapshots (no version) and
  the eager compare.
- `HistoryManager.lastMei` became `lastCommitted: Snapshot`; `committedMei()`
  reads it — which materialises a lazy AFTER precisely when the next edit needs
  it as its BEFORE. `canUndo`/`canRedo` have no callers outside the manager, so
  deferred retraction has no UI consequence.

## 2026-09-01 — A finished adoption may commit once, and only while it is the current task

The suite's `pageKeyChangeSplicesGovernedRange` failed in about half of the
full runs after A8 landed (never in isolation, never before): after a
successful splice the owner's `startIds` held ONE entry. A setter trap on
`startIds` recording each write's stack showed three writes — the refill's
7-line commits for the reset edit and the edit, then, 150 ms later,
`commitAdoption` from an idle `step` writing one entry.

Mechanism: the between-fixture reset renders a one-measure blank document,
whose derive arms an idle-sliced adoption (`armAdoption`, `pageCount` 1). The
next fixture's setup render arrives while that walk is pending, so
`tryRefill` runs `finishAdoptionNow`, which walks the remaining page
synchronously (the live toolkit still holds the blank layout: one system,
one start), commits, and clears `this.adoption` — but does not cancel the
task, and its `scheduleIdle(step)` continuation is still queued. When the
main thread finally idles, `step` finds `nextPage > pageCount`, skips the
walk, and calls `commitAdoption` again, re-installing `[blankMeasureId]`
over whatever the refill had committed since. Order- and timing-dependent
(the setup's render is deferred behind the busy badge on this fixture, which
is why the idle step could run so late), and the timing shift that exposed it
was A8's.

Fix: `commitAdoption` returns without writing unless `this.adoption === task`
and the task is not cancelled, and marks the task cancelled once it commits.
`invalidate()` already cancelled in-flight tasks; the hole was a task that
had FINISHED but whose continuation was still armed. Gates: two full suite
runs green under the flag, battery identical to base.

## 2026-09-02 — A11: the splice reads geometry from the SVG text on both sides; the window is never laid out

Max: pursue A11 in place of the fragile A6, "but we have to thoroughly prove
the path-based profile is actually reliable." A8's pass timings had shown the
DOM-side floor was one thing — the window host's initial layout (~20 ms),
forced by the first geometry read — so the only way past it was to read
nothing that needs layout.

- **The profile.** A measure's horizontal extent is its staff-line path
  (`M x1 y L x2 y`): `relX`/`w` from x1/x2, the staff top from y, plus the
  staff and system `transform`s. Same function on the window (a `DOMParser`
  document, never attached) and on the live page (whose `d` attributes are
  the same text). The bbox reading it replaces was polluted by content — a
  measure's bbox includes spanners reaching into neighbours and, on a
  system's first measure, the brace 144 units to the left — which never
  mattered for the gate only because both sides carried the same pollution.
- **The proof** (`cb-pathprofile.js`): 126 real edits (a deletion on every
  sonata line, 12 governed-range key changes with replaced sets of 3–16
  lines), 117 splices, 118 context lines. Against the bbox reading: staff
  top, dx and dy identical on every system (Δ 0), gate verdicts identical
  (max width delta ≤ 3 units under BOTH — the live right-edge snap moving a
  staff-line end by ½ device px, which rewrites the path and so is seen by
  both readings). Zero outliers.
- **What moved.** Post-processing of the replaced systems (barline /
  right-edge snaps via `getScreenCTM`, notehead order, HEJI, theme) runs on
  the IMPORTED systems in the live page, in the page's own device frame,
  sharing the layout flush the retitle and `snapPage` need anyway. This also
  retires the host-frame snap that a fractional device `dx` un-snapped (the
  "dx ≠ 0" question). `mergeGlyphDefs` accepts the parsed document as the
  glyph source. The extent fields (`bboxTop/Bot`, `newBottom/liveBottom`)
  are gone — nothing consumed them beyond diagnostics; page-fit reads the
  live page after surgery. `sigGlyphs` reads a HEJI-injected `text` as the
  codepoint it carries (heji-render.ts writes the glyph as the text content),
  so glyph identity compares across a raw window and a HEJI-processed page.
- **A6 is subsumed**: the snap flush is now the single layout a splice
  causes, and it is the one it always needed.
- Fixture `pageSpliceNoHostAttach`: a `MutationObserver` on `<body>` during a
  splice (after a warm-up edit so sigW is already measured, and with the
  test-mode reference gate — which attaches a host by design — turned off for
  that edit) sees nothing attached. Fails on pre-A11 code.

Gates for A11 (2026-09-02): suite 360/360 under `HKL_INDEX_CHECK`; battery
identical to base with walls roughly halved (272/109/369/370/231/259/309/181
vs 389/300/695/627/547/679/442/368 ms); `cb-sweep.js` 115/115 lines spliced,
no errors (Verovio's own unmatched-tie/slur warnings on window renders as
before); `cb-splicecost.js` steady edit 214 → 144 ms instrumented, i.e. 258 →
144 across the A thread (≈ −44%): splice 147 → 90 ms, imported-system
post-processing 5.5 ms, snap 1.8, no live flush before surgery.

## 2026-09-02 — For the record: the steady-state edit before and after the A thread (instrumented, Chromium, sonata)

Moved here from the design doc when it was refocused on current state. Numbers
are `cb-splicecost.js` instrumented walls (wrapper overhead over ~4 000 wrapped
calls inflates them; the bare edit was ≈ 170 ms before) — read the shares.
Window: 1 replaced line, 4 window lines (above + replaced + below + a courtesy
extension) + leader + trailer = 20 measures on 2 window pages.

Before (2026-09-01, wall 258): splice 158 — Verovio `loadData` 25.5 +
`renderToSVG` 59 = 84; `innerHTML` parse of two hosts 10; post-processing of
the two hosts 30 (of 20 measures only 6 were imported); window MEI build 9;
`liveSystem` ×3 7 (one 5.3 ms flush); `spliceDom` 14 (a 3.5 ms profile flush,
snapPage 5.2 with a 4.5 ms flush). Refill 49, all naturals: a 5-measure
`breaks:'none'` window — `renderToSVG` 15, `getBBox` 8 (one flush, 118 reads),
`loadData` 6, serialize 3, `innerHTML` 2. Outside the render 50: mutation 14,
history `XMLSerializer` 12, overlay-height read 5.5 (paint layout brought
forward), `cursor.update` ×2 1.6, dispatch ~16. Forced layout flushes ≈ 27 ms
in five places; the number of `getBBox` calls was irrelevant.

After A7–A11 (2026-09-02, wall 144): splice 90 — Verovio ≈ 84 unchanged;
`spliceDom` 10 (imported-system post-processing 5.5 sharing the snap's flush,
snap 1.8, profiles + imports from text ≈ 3); no pre-surgery live flush (0.4).
Refill 33 (naturals from a never-attached parse; sigW re-measured only when the
window's folded head changes). Outside the render ≈ 22 (history snapshot lazy).
The one remaining layout flush is the post-surgery snap, which the splice always
needed. Verovio's `renderToSVG` dominates and is intrinsic (draw time, not
string formatting: `svgFormatRaw` cut bytes 40% and parse 36% but not the draw;
the first draw after a `loadData` carries the lazy layout, +30–40%).

## 2026-09-02 — B2: line-count changes and pagination changes are splices; overflow is repaired by a measured cascade, never handed back

**Context**: after the A thread, three O(document) exits remained on an
ordinary page-view edit — the splicer's `line count changed` refusal (its
replaced set was index-based, so an N→M partition diff was unrepresentable), the
`paginationHeld` id-compare in `renderPageComposer` (a refill that changed a
page-start id bypassed the splicer with no diagnostic), and the post-splice
`overflowingPage` → derive. The first is the commonest flow there is: composing
at the end of a score opens a new final line every few bars, and each one was a
1.2 s full render. Max also set the direction these paths must serve: complete
ownership of pagination and system distribution within a page (D1), with the
cascade past the cursor's surroundings eventually off the interactive layer.

**Picked**:

1. **The replaced set is a line HUNK** `old [a..bOld] → new [a..bNew]` — the
   prefix/suffix diff of old vs new start ids, unioned with the changed run (and
   a cascade's moved block). Lines outside the hunk are identical on both sides,
   so old lines locate the live systems and new lines build the window; the
   vertical plan chains through the M new systems and the followers below the
   hunk take one measured dy. A changed boundary pulls the line above into the
   hunk (its extent moved). `SpliceRequest` carries both partitions, both
   paginations, the changed run and the optional `moveLines`.
2. **Pages are carried by LINE inside the repair, not by id in `tryRefill`.**
   The id carry had a latent defect: deleting only the first measure of a
   page-start line moved the line's remnant onto the PREVIOUS page. By line
   index (tracked through the repair loop, since an inserted line shifts later
   pages), a surviving line never changes page because of an edit; a page whose
   every line vanished collapses into its successor. `paginationHeld` is gone —
   every refill reaches the splicer, and a count change is a collapse the splicer
   reports as an emptied page element for the renderer to remove and renumber.
3. **Page legality is overflow-only and judged live after surgery.** No
   pull-up on deletion: a page keeps its slack, as a line keeps its content
   over churn; a page-side minimum and vertical justification are one D1/D2
   decision for Max, not a B2 default.
4. **Overflow repair = `repairPagination`, a cascade of measured move-splices.**
   Step(P): the tail from the fold on (first system whose bottom crosses the
   page box) moves to the head of page P+1 — the owner's page start moves to the
   block's first line (`replacePageStarts`), and the move lands as a splice whose
   hunk has unchanged lines and a new target page; its window pins the block
   page-first, so its position is read, never modelled (B1's rule holds). Then
   P+1 is checked. A last page spills into a page CREATED from the window's own
   page SVG with the systems stripped (`createPage`, then the full mount pass).
   When the receiving page is a placeholder that cannot be mounted cheaply, the
   step is LAZY: the block leaves the spilling page, both pages are marked
   stale, and the receiving page draws the block — and checks its own fold —
   when it mounts (`mountPage` now runs the repair for any lazily mounted page).
   The synchronous cost is therefore one step per mounted page below the edit
   (cursor page ± 1) and the rest settles at mount time — the interim answer
   to Max's "the cascade must not tie up the interactive layer once the cursor's
   surroundings are complete". A step that cannot land restores the last
   consistent pins; the edit path derives, the mount path warns.
5. **Structured for the scheduled continuation.** The cascade is a `pending`
   list of pages driven by a loop; an idle/rAF driver with "finish synchronously
   before the next edit" (adoption's rule) is a driver swap. The step is also
   where D1's page-fit model would apply: with tracked system heights a step
   could predict the fold and distribute systems instead of measuring after
   surgery.
6. **The reference gate runs once the cascade has settled**, against the
   owner's CURRENT pins (`pinnedMeiForCurrentModel`, not the refill closure),
   over every page the splice and its steps touched; `verifyRenderedPartition`
   asserts the renumbered `data-page` grid against the pins.
7. **Dated refusals**, each a named `lastSkipReason`, none silent: a section
   title whose measure the edit deleted; a header line the hunk or cascade would
   move to another page (title migration across page-margins is unbuilt); a
   moved block landing on a page it cannot own; more than one page to create in
   one step; a single system taller than its page; `MAX_CASCADE_STEPS` 64.

**Rejected**: predicting overflow in the refill from a page-fit model before
any measurement (the model does not exist yet and a page-first anchor is not
modelable from bboxes — B1's finding; measuring after surgery costs one extra
small window only on an overflow event); moving a spilled system's `<g>` by DOM
transplant without a window (its page-first position must be read from a page
that starts with it); silencing Verovio's justification warning at the toolkit
(it would also hide unresolved-spanner diagnostics in window renders — the
suite allowlists the exact four-line family instead, and the observation goes
to D2: `FIT_MAX 1.45` admits lines Verovio compresses to ~0.7 and warns about
below 0.8).

**Two bugs the suite caught in the first run, both in the hunk's
representation** (lessons.md): an unchanged partition read as "no suffix" and
extended every replaced set to the document's end (seven fixtures, seven
different symptoms); an empty NEW side (a deleted line) read as "unchanged" and
imported the successor line without removing its old system. Fixed by holding
explicit bounds on both sides and testing "unchanged" as `N === M && pre === N`.

**Measured**: sonata battery **10/10 spliced, all reference-clean, all
edits applied** (the two new edits: `append-at-end` — four bars appended in
one render opened a new line AND spilled the last page into a created page 31,
705 ms wall including the second window and the created page's mount pass;
`delete-whole-line` — a mid-document line's five measures removed in every
voice, 3.5 s wall of which the scripted deletion itself — hundreds of model
operations, each walking the 446 measure ids — is nearly all, the render being
a splice), the eight prior edits 113–396 ms, max reference deltas x/width 5,
spacing 9, absolute top 10 units. Battery walls are worst-case by construction
(every page mounted). Five new
fixtures (`pageSpliceNewLineAtEnd`, `pageSpliceNewPageAtEnd`,
`pageSpliceLineMerge`, `pageSplicePageCollapse`, and
`pageSystemSpliceCascadeOverflow` rewritten to assert the move) pass under
`HKL_INDEX_CHECK`; the seven fixtures the first run broke pass again.

**Where**: `apps/composer/src/render/pagesplice.ts` (`SpliceRequest`, hunk,
target pages, created/emptied pages, generalized `verticalPlan`, public
`verifyAgainstReference`), `apps/composer/src/render/linebreaks.ts`
(line-index page carry in `repartition`, `replacePageStarts`),
`apps/composer/src/render/render.ts` (`repairPagination`, `foldOf`,
`lazyMoveOut`, `createPage`, `removePage`, `registerSpliceEffects`, mount-time
repair, `MAX_CASCADE_STEPS`), `test/composer-test/fixtures.mjs`,
`test/composer-test/lib/console-capture.mjs`,
`test/composer-inspect/phasec/cb-splice-battery.js` (edits 9–10),
docs/composer-page-splice-design.md, docs/architecture/composer.md, docs/lessons.md.

## 2026-09-02 — Header pages keep Verovio's box: `pinExactScale` honours the injector's recorded base height (addendum to B2)

**Context**: re-running `cb-sweep.js` after B2 to re-verify 115/115 also
re-read its viewport counters, which had stood at 0/0 since the placeholder fix
and had not been read since: `pageBoxChanged 3`, `scrollHeightChanged 6`, and
the next-page anchor moved 90 px on the sonata's three movement-start lines.
Reproduced (`probe-hdr`): a header page mounts with its inner viewBox grown by
the 900-unit reserve but its root box at Verovio's 2794 px (the injector's
height update targets the inner svg, which has no height attribute — dead
code), so it is drawn ~3 % small; since A8 the splice's in-place
post-processing re-ran `pinExactScale` on that page, which recomputed the root
height from the grown viewBox: +90 px and everything below shifted. A pre-B2
regression (A8, 2026-09-01), caught by B2's verification.

**Picked**: geometry-preserving stabilization. The injector records the
pre-growth viewBox height (`data-hkl-vb-base`) and `pinExactScale` uses it, so
the page box is identical on every run — no jump, status quo look. The 3 %
squeeze is documented as an open decision (design doc → Open work): the
proper fix makes header pages taller at true scale, which is visible and needs
header-aware placeholder sizing, and belongs with D1 (a header's reserve is
page-fit budget, not paper added after pagination).

**Rejected**: growing the root box now (visible change plus placeholder
mismatch on header pages — the eviction lesson — without Max); skipping
`pinExactScale` on header pages (the same box, but the imported systems would
be snapped under a stale pin if the zoom ever changed).

**Where**: `apps/composer/src/main.ts` (`injectSectionHeaders`),
`packages/notation/src/render-presets.ts` (`pinExactScale`), docs/lessons.md.

## 2026-09-02 — Section headers are page budget: the injector stops growing the viewBox, a spilled header line carries its title (supersedes the stabilizer above)

**Context**: the screenshots of the 90 px jump showed more than a height
change — the whole drawing changed scale and the margins shrank. Max: *"The
scaling must always stay the same at the fixed box. We must fully own height,
with the header being another component with reserved height, distinct from a
system. Adding a header should cause the bottom system to overflow if there was
not enough extra space on the page for it."* `injectSectionHeaders` growing the
viewBox was a hack from before pagination was owned; the stabilizer recorded
in the previous entry only froze the hack's squeezed state (and, it turned out,
was never even served — see lessons.md on `packages/` edits and the dev server).

**Picked**:
1. **The paper is fixed and the scale is pinned at the box.** The injector
   still shifts a header's system and everything below it by the reserve and
   records `data-reserve`/`data-baseline`; it no longer touches the viewBox or
   the box. `pinExactScale` is back to its one-line form and is idempotent by
   construction because nothing grows a viewBox after mount.
2. **A header consumes budget.** A page whose systems no longer fit below its
   headers overflows, and the owned pagination repairs it exactly like any
   other spill: B2's cascade runs after every mount too — `repairAtMount`
   covers lazy mounts, page 1 of a full render and created pages — so adding a
   header to a full page pushes its tail onto the next page, at mount, with no
   derive loop (the castoff knows nothing about reserves; the repair does).
3. **A spilled header line carries its title.** The splicer migrates the title
   element to the receiving page's page-margin and re-places it from the
   injector's rule; the receiving page's followers take the migrated reserve on
   top of the measured dy (`followerReserveDelta`); a title landing on a page
   being created is dropped and re-injected by that page's mount pass; a lazy
   step removes the title with its block for the same reason. The B2 refusals
   `section header line changes page` and `lazy move of a section-header line`
   are gone; `section header measure removed` remains the one header bail.
4. **Mount-time repairs are reference-gated** under `HKL_INDEX_CHECK` like
   edit-path splices.

**Consequence accepted**: on a document with headers, each header page that
does not fit gives up its tail on first mount, so the pagination seen before
this change shifts once; vertical justification within the budget (D1 proper)
is a later feature. Fixture `pageSectionHeaderOverflow` (headers on a full
page's first and last lines: box fixed, nothing overflows, titles above their
systems on the right page, pins agree with the DOM).

**Where**: `apps/composer/src/main.ts` (`injectSectionHeaders`),
`packages/notation/src/render-presets.ts` (`pinExactScale`),
`apps/composer/src/render/render.ts` (`repairAtMount`, `lazyMoveOut`),
`apps/composer/src/render/pagesplice.ts` (title migration,
`followerReserveDelta`), `test/composer-test/fixtures.mjs`.

## 2026-09-02 — Courtesy stub: the courtesy-generating line enters the splice window as ONE measure (vertical-ownership plan, Phase 0)

**Context**: the design doc's START HERE 2 priced the window's two context lines
and the courtesy-extension line at ~60 of the 84 ms of Verovio time per edit and
framed shrinking the window as a gate question. Inventorying what the context
lines actually do (against `verticalPlan`, not the comment above it) found a
third job: they are the two ends of the READ spacing chain — the first replaced
system is placed by `ctxPrev.staffTop + (window L − window L−1)` and the
followers by `(window L+1 − window L_last)`. That is geometry, not
verification, so the context lines cannot go while the vertical plan is read
from Verovio; Verovio 6.3.0-dev (the CDN build, checked in source) stacks
systems as `B(k) + G + A(k+1)` with the overflow-aware inter-system variant
commented out, so a model of it would be exact today and one release from
wrong. Max: D1 ("we always own height") removes the geometry job entirely, and
the cascade (START HERE 1) and the window question both fall out of it. The
three items became one sequenced plan,
the vertical-ownership plan (retired 2026-09-04; results rolled into [composer-page-splice-design.md](composer-page-splice-design.md));
this entry is its Phase 0, the only in-principle reduction of the window that
does not depend on owning height.

**Picked**: the courtesy-extension line — pulled in whole (bounded at two lines)
so the compared context line L+1 renders the end-of-line courtesy its successor
generates — is replaced by that successor's FIRST MEASURE as a pinned
one-measure stub system before the trailer (`lastWindow.stubId`). Same
partial-absorber idea as the leader and trailer: a real document measure, so
`serializeRangeForRender` already carries it and the scoreDef / section `<sb>`
before it; pinned `<pb>` when its line begins a page so L+1 ends exactly as it
does live; never compared, never imported, never chained from. The bound-at-two
disappears with the chain it bounded (a stub's own courtesy is nobody's
business). The ending closure runs before the courtesy rule and treats the
measure past the range as touched, so a stub is never an `<ending>` member: an
ending that begins right past the window joins it whole and the stub is the
first measure of the line after — a cleaner invariant than the tolerance the
plan expected to document.

**Proof** (`cb-courtesystub.js`, both code states, stash / pop): every sonata
line edited once (116 positions; 107 splice, 9 are MEI-identical no-ops). Per
window system — leader, L−1, hunk, L+1 — per-measure x/width, staff top and
clef/key/meter glyph codepoints identical to 0.01 on all 107; window span and
page count identical on the 87 positions without an extension; on the 20 with
one, the stub is the extension line's first measure and the window drops from
22.4 to 18.1 measures (−3…−9; two chained extensions 33 → 24), Verovio
loadData + renderToSVG 103 → 86 ms mean. Battery on both states: 10/10
spliced, `reference.ok` identical, `insert-rest-ripple` (a courtesy position)
24 → 20 window measures. Sweep 115/115, `pageBoxChanged` /
`scrollHeightChanged` / `scrollTopChanged` 0, splice median 234 ms (82–496).
Fixtures `pageSystemSpliceCourtesyStubChain` (consecutive signature lines: one
stub measure, the second line stays out) and
`pageSystemSpliceCourtesyStubAfterEnding` (ending closure first, then the
stub); both fail on the unfixed source; the three existing courtesy fixtures
now assert the stub is exactly one measure past the last window line.

**Two probe lessons on the way** (lessons.md): a multi-page window's SVGs must
be parsed one `DOMParser` document per page — two `<svg>` roots in one string
is not XML and silently drops the second page's systems; and measure ids carry
a per-import random suffix, so nothing keyed on ids (a window-MEI hash included)
compares across two runs — compare by position and by the id's stable prefix.

**Where**: `apps/composer/src/render/pagesplice.ts` (`trySplice`, `buildWindowMei`,
`spliceDom`, `lastWindow.stubId`), `test/composer-test/fixtures.mjs`,
`test/composer-inspect/phasec/cb-courtesystub.js`.

## 2026-09-02 — Composer owns height: one placement rule over measured extents replaces Verovio's stacking on every page (vertical-ownership plan, Phase 1)

**Context**: the design doc's START HERE 2 priced the splice window's context
lines as gate-only; they were also the two ends of the READ vertical chain
(`verticalPlan`, `dyFollow`), which is why the window could not shrink and why
every vertical position on a page came from Verovio — a derive's page from its
castoff, a spliced page from a window that had to reproduce Verovio's spacing
around the hunk, a cascade's moved block from a window that had to paginate
where the block would land. Max, on the 90 px header jump earlier the same
day: *"We must fully own height."* The plan
(the vertical-ownership plan (retired 2026-09-04; results rolled into [composer-page-splice-design.md](composer-page-splice-design.md)))
makes that Phase 1, the enabling step for the cascade on a model (Phase 2) and
for the window question (Phase 3).

**Measured before building** (`cb-placement.js`, 30 sonata pages, 116 systems,
pre-ownership build). Verovio 6.3.0-dev stacks a page as: first content top =
page header bottom + 2 units (`bottomMarginHeader`); between systems
`max(below, F) + G + max(above, F)` with F = 6 units (half a staff spacing:
the first staff's and the bottom alignment's floor, `CalcMinimumRequiredSpacing`)
and G = 4 units (`spacingSystem`); the overflow-aware inter-system variant is
present in `AlignSystemsFunctor::VisitSystem` and commented out. With
`above`/`below` read from the rendered post-processed bbox instead of Verovio's
internal overflow, that rule reproduces Verovio's consecutive gaps within 1
unit on 73 of 86 pairs and within 3 on 85, and every page-first within 0.1
unit on glyph-topped pages. The residue is where Verovio's metrics and the
browser's bbox disagree: text (tempo, dir, measure numbers) and one chord
whose bbox reaches ~3 units further below than Verovio's overflow.

**Picked**:
1. **`render/pagefit.ts`**: extents `{staffTop, staffBot, above, below}` in the
   system's own frame — staff lines from the path text, content from
   `getBBox` on the attached, post-processed system (HEJI text included,
   section titles excluded: they are page components); `placeSystems(items,
   k, y0)` — the rule above, with a section header as a reserved band
   (`SECTION_HEADER_RESERVE`, moved here from main.ts) above its system and
   the title baseline `SECTION_HEADER_BASELINE` into the band; `foldIndex`;
   `ExtentsStore` per line (filled by every pass; Phase 2 reads it for
   unmounted pages). Constants in SVG user units from the Verovio `unit`
   (80 at unit 8, shared by every crisp preset — zoom-invariant): F 6u, G 4u,
   HEADER_GAP 2u, and C0 5.25u for a page with no header element (= the
   autogenerated one-line page-number header's bottom + the gap — that is
   what the first calibration measured as "the page-first constant" before the
   header was recognised as a component; page 1's header is the title and is
   taller, which is why the first build crowded titles until the header was
   read per page).
2. **`Renderer.placePage`** runs on every mount (`finishPageMount`, between
   post-processing and the main.ts injections) and on every touched page of a
   splice (before the snap — after it would undo the snap's ≤ ½ px staff
   shifts): measure every system, place, write a translate only when a system
   moves by more than 0.01 units, stamp `data-hkl-band-top` on header systems,
   put existing titles into their bands, record extents. `placeFor` is the
   read-only twin (reference gate, fold). `injectSectionHeaders` no longer
   moves systems; it draws the title at the stamped band. A derive's page and
   a spliced page therefore agree by construction.
3. **The splicer** imports systems with the horizontal frame only and hands
   every touched page to `placePage`; `verticalPlan`, `dyFollow`, the
   follower shift, the header-reserve arithmetic, `retitle` and the
   `winIsPageFirst` check are gone, and the window carries no `<pb>` pins —
   it is one page, nothing is read from its vertical layout. Title migration
   across pages stays (which page a title is on is the splice's business;
   where on the page is the placement's).
4. **Reference gate** (`verifyAgainstReference`, `cb-splice-battery.js`):
   the reference render's systems are measured and placed by the rule
   (`placeFor`) and must land where the live page put its systems (TOL 30),
   and the live page must be self-consistent (placed by the rule over its own
   extents). Header pages are verified like any other with nothing subtracted.
5. **Fold predicted** (`foldOf`): `foldIndex` over the read-only placement
   against the paper bottom read from Verovio's inner `definition-scale`
   viewBox (the outer svg's viewBox is in tenths — the first build read that
   one and folded every page at its first system); 2 device px of tolerance
   as before; under `HKL_INDEX_CHECK` the prediction must equal the measured
   fold or it throws.

**Result** (sonata, both builds via `cb-placement.js`): every gap and every
page-first on the owned build within 1 unit of the rule (86/86, 30/30);
against the old Verovio placement 92 of 116 systems within 1 unit, 19 within
3, 5 beyond (max 5.1 units, all interior gaps under a text- or chord-bottomed
predecessor). Page 1's first system sits 1 unit LOWER than Verovio put it: the
tempo's rendered box is taller than Verovio's metric, so the title gains
clearance. Suite: every non-visual invariant green; the visual fixtures that
render page view moved by sub-pixel to a few units and were re-seeded after
Max reviewed the montages (baseline / new / diff per fixture, plus sonata
pages 1 and 23 on both builds). Gates on the second build: typecheck /
build / boundaries clean; battery identical on both code states (10/10
spliced, `reference.ok` everywhere, `maxD` 4 → 0); sweep 115/115 with the
viewport counters at 0; allmeasures 420/420 at 100 % splice rate; full tier
370/370 under `HKL_INDEX_CHECK` (three new fixtures included); reference placement 30 pages / 0
divergences; the default splicecost 166 → 147 ms steady. Numbers and the
fixture list in the plan doc's Phase 1 status.

**Where**: `apps/composer/src/render/pagefit.ts` (new), `render.ts`
(`placePage`, `placeFor`, `foldOf`, `finishPageMount`, ctx), `pagesplice.ts`
(`spliceDom`, `verifyAgainstReference`, window pins), `apps/composer/src/main.ts`
(`injectSectionHeaders`), `test/composer-inspect/phasec/cb-placement.js`,
`cb-splice-battery.js`, fixtures `pageSystemSpliceDyCascade`,
`pageSectionHeaderCascade` (restated without the plan), `pagePlacementOwned`,
`pagePlacementTextTopped`, `pageSpliceNoPbPins` (new).

## 2026-09-02 — The cascade runs on the model: transplant, created page from the spilling page's shell, arithmetic past the mounted set, the extents job (vertical-ownership plan, Phase 2)

**Context**: with Composer placing every system (Phase 1), a cascade step no
longer needed Verovio for anything: the spilled block's systems already exist
on the spilling page, placed by the rule; moving them is a DOM operation, and
a page nobody has mounted can be folded by arithmetic over stored extents. B2's
step was still a splice (a window render of the block, page-first, imported
into the receiving page) and past the mounted set it parked — the receiving
page drew the block and checked itself at mount. Plan
(the vertical-ownership plan (retired 2026-09-04; results rolled into [composer-page-splice-design.md](composer-page-splice-design.md)) §3
Phase 2).

**Picked**:
1. **A step is a transplant** (`Renderer.repairPagination`, `detachBlock` /
   `attachBlock`): the block's `g.system` elements and their titles move to
   the head of the receiving page's margin, both pages are re-placed by the
   rule and snapped. No window, no `SpliceRequest.moveLines`, no created page
   from the splicer — that whole path is gone from `pagesplice.ts` (the
   `section header measure removed` bail with it: a title whose measure the
   edit deleted is simply removed, the header being a component of the model).
2. **A last page spills into a page made from the spilling page's own SVG**
   (`createPageFromShell`): systems, titles, injected texts and selection
   rects stripped, the page-number header bumped (page 1's title header is
   dropped instead), the glyph `<defs>` emptied. Detach the block, place and
   snap the spilling page while only its root is dirty, THEN create and fill
   the new page and run its mount pass — two small flushes, not one over both
   roots.
3. **Glyph defs travel under fresh ids** (`attachBlock`): a glyph the
   receiving page already defines is reused; one it lacks is copied from the
   spilling page under `<id>-c<n>` and the moved `use` hrefs are rewritten.
   Every page of one render shares its glyph ids, and appending duplicates
   invalidates every referencing `use` in the document — ~100 ms of the
   created page's first layout with 31 pages mounted.
4. **Arithmetic where a step used to park** — NOT instead of a cheap mount.
   When the receiving page is a placeholder the B5 rule can still mount from
   the toolkit's layout (not stale), it IS mounted and receives a transplant:
   ~50 ms now, and the page is drawn. Arithmetic (pins move, both pages
   stale, the receiving page's fold predicted from the `ExtentsStore`,
   `appendPlaceholderPage` for a spill past the last page) applies when the
   cheap mount is unavailable and the lines' extents are known; a PARK only
   when they are not. Reason: an arithmetic step leaves a stale page whose
   eventual mount costs a document reload (~600 ms on the sonata); the plan's
   "arithmetic when extents are known" read literally would have traded 50 ms
   now for that. `pageCascadeArithmeticPastMount` marks its page stale to be
   the case that parked.
5. **The extents job** (`armExtentsJob`): armed after every page render that
   leaves ownership active; idle slices render each unmounted, non-stale page
   offscreen from the toolkit's current layout, post-process it, measure its
   systems into the store, discard the SVG. Adoption's discipline — the
   current job only, cancelled by any document change, re-render, splice in
   progress or a toolkit that no longer holds the layout; a page that mounts
   meanwhile measures itself and is skipped. Test hooks `runExtentsJobNow`,
   `extentsJobState`, `extentsKnown`.
6. **Diagnostics**: `Renderer.lastCascade` = {steps, transplanted,
   arithmetic, parked, created, ms, msFold, msClone, msMove, msPlace, msSnap,
   msMount}; the sweep sums them (`parkedSteps` must be 0), the battery records
   them per edit, `cb-splicecost.js --arg edit=append|appendnear|appendskipdefs`
   attributes the cascade onto a created page.

**Measured** (sonata): the mid-document one-note edit is unchanged (145 ms
steady, no cascade). Append-at-end with the last three pages mounted — the
user's condition when composing at the end — costs 37 ms of cascade, 31 of it
the created page's mount pass: the plan's "mount pass alone". With all 31
pages mounted (the battery's `mountAll`) the created page's FIRST LAYOUT costs
~180 ms and scales with the mounted set (a new SVG root, not the defs: skipping
the copy saves ~30 ms; unique ids saved ~100), so the battery's append-at-end
wall reads ~+75–250 ms against the old code in that condition (921 vs 793 in
the probe; 802–1017 across six battery runs vs 728, the created page's mount
pass 196–305 of it). Why the old window-shell root laid out
cheaper there than a clone of the live page's root is not understood; the
mounted-set scaling is the known accumulator (page virtualization evicts, so a
user never has 31 mounted). Left as is, noted for Phase 3's measurements.

**Result**: battery identical on both code states (10/10 spliced,
`reference.ok` on every edit, append-at-end `created: 1, transplanted: 1`);
sweep 115/115, viewport counters 0/0/0, `parkedSteps` 0; full tier 374/374
under `HKL_INDEX_CHECK` — the five B2 cascade fixtures re-asserted on the
transplant (the very element that was page 1's tail heads page 2), plus
`pageCascadePredictedFold`, `pageCascadeArithmeticPastMount`,
`pageExtentsJobEditDuring`, `pageExtentsJobScrollDuring`, each failing on the
unfixed source; every-measure pass 420/420 at 100 % splice rate, 0
conflicts, empty refusal inventory.

**Where**: `apps/composer/src/render/render.ts` (`repairPagination`,
`detachBlock`/`attachBlock`/`moveBlock`, `createPageFromShell`,
`appendPlaceholderPage`, `predictFoldFromStore`, `lineReserve`,
`laterPageY0`, `armExtentsJob`/`runExtentsJobNow`/`measurePageExtentsOffscreen`,
`lastCascade`), `pagesplice.ts` (moved-block path and page creation removed),
`linebreaks.ts` (`scheduleIdle` exported), `test/composer-inspect/phasec/`
(`cb-sweep.js` counters, `cb-splice-battery.js` cascade record,
`cb-splicecost.js` append modes), `test/composer-test/lib/cdp.mjs`
(`exceptionDetails` surfaced), fixtures above.

## 2026-09-02 — An edit costs what is ON SCREEN: the replaced set is clipped to the mounted band, re-flow is separated from re-draw, and the break signature keys on identity

**Context**: Max, on inserting a blank measure into the sonata: *"This is
inserting a blank measure in the middle of a line, which does not change any
other lines at all. This should be a localized replaced set, no more taxing
than a single deletion. Something is wrong."* And, on the mechanism: *"Aren't
unmounted pages supposed to be deferred off the main thread? A synchronous wait
for a 34-line window shouldn't be possible."* Both were right. Ctrl+M cost
2.9 s at the start of a section and 4.1 s in the last one, position-dependent,
with no cascade involved. Four separate defects, found in this order
(`cb-commands.js`, `cb-insertpos.js`, `cb-splicecost.js --arg edit=ctrlm`):

1. **The edit never reached the splicer.** `computeUserBreakSig` encoded each
   user break as a running MEASURE COUNT (`230sb`), so inserting a measure
   above any break changed the signature and the refill bailed with `user
   breaks changed` — a full derive for an edit that changed no break at all.
   Now keyed on the `xml:id` of the measure each break precedes. Ctrl+B and
   section headers still report a change, correctly: they DO add a break.
   2852 → 523 ms. (lessons.md, "A signature that encodes POSITION".)
2. **The mutation was O(slurs × measures).** `insertMeasureAt` located each
   slur endpoint with `measures.findIndex((m) => m.querySelector('[*|id=…]'))`
   — 922 slurs over 446 measures, 432 154 `querySelector` calls, 406 ms of a
   523 ms mutation. One pass mapping the wanted ids to measure indices: 450
   queries, 57 ms. 523 → 288 ms. (lessons.md, "O(spanners × measures)".)
3. **Re-flow and re-draw were one question.** The per-measure signature is the
   measure's serialized XML, so the section-aware `renumberMeasures` reported
   every measure to the end of the section as changed, and the changed run
   drove BOTH the partition repair with its naturals measurement AND the
   splice. Measure numbers are rendered (111 on the sonata, one per line
   start), so those lines do need REDRAWING — Max: *"Those measure numbers do
   need to be updated when a measure is added. We just don't need to wait for
   the main thread to do it."* — but a number is an overlay label above the
   staff, so their widths and their lines' fills cannot move. `measureFlowSig`
   (own `@n` stripped) gives a second diff: the FLOW run drives repartition and
   naturals, the FULL run is what the splicer redraws. Naturals for an insert
   at m8 went 585 ms / 137 measures → 77 ms / 19; at m340, 1162 → 73 ms.
4. **Unmounted pages were not deferred.** The replaced set was computed in line
   space over the whole document and then B5's `ensurePageMounted` DREW every
   page it touched (834 ms for 8 pages) so one window could re-engrave all 146
   measures (650 ms) — synchronously, for an edit on page 1. Nothing had
   revisited that: B5 mounted eagerly because a missing page used to force a
   full render, and the tradeoff inverted once the splice could do partial
   work. The splice now processes only the lines whose old AND new page lie in
   the maximal contiguous run of mounted pages containing the edit, and DEFERS
   the rest: `lastDeferredPages` are marked stale and any that were drawn are
   returned to placeholders (a drawn page holding pre-edit systems under
   post-edit pins is what `verifyRenderedPartition` rightly fails on), each
   redrawing from the committed pins on mount. Same deferral the Phase 2
   cascade uses for its arithmetic steps. Page granularity keeps the processed
   lines contiguous, which the window needs.
   - A context line outside the band cannot be compared and is not the edit's
     business (`aboveComparable` / `belowComparable`): the window still renders
     it so entering spanners resolve, it just is not checked. Max's standing
     ruling applies — the live context comparison is a fallback, not an
     invariant — and the reference gate still covers every replaced line.
   - B5's eager mount survives for the EDIT's own neighbourhood only (lines
     a−1..a+1), so an evicted cursor page is still drawn before the splice.
   - The idle extents job now WARMS what a clip deferred: one
     `ensureTkHoldsPageLayout` in an idle slice clears the stale set, so a
     later mount costs ~50 ms instead of a ~600 ms document reload on the
     user's scroll. Adoption's discipline throughout: any document change
     cancels the job first.

**Measured** (sonata, insert a blank measure, Chromium):

| at measure | before | after |
|---|---|---|
| m2 | 2953 ms | 515 ms |
| m8 | 2153 ms | 386 ms |
| m20 | 2445 ms | 327 ms |
| m60 | 1816 ms | 745 ms |
| m120 | 665 ms | 592 ms |
| m223 | 440 ms | 564 ms |
| m340 | 4139 ms | 437 ms |
| m440 | 421 ms | 521 ms |

Position dependence is gone: the worst case is 745 ms against 4139, and the
window went from 145 measures to 13-39. A one-note delete is 161 ms, so an
insert is now the same order as any other edit rather than 25x it.

**Command inventory** (`cb-commands.js`, new): every document-mutating user
command on the sonata, through the real key path where there is no dialog and
through the model method where there is. 24 mutating commands, 19 splice. The
five that derive all say why: three add a user break (Ctrl+B page-break,
section header, pickup), a mid-piece meter change exhausts the repair cap
(`repartition window/cap exhausted`), and `add instrument` is structural
(`head context changed`). Copy, cut, paste, paste-into-selection and undo/redo all splice
(195-306 ms). Mid-piece time signature exhausts the repair cap and `add
instrument` is structural — both documented derives. This inventory exists
because nothing asserted that a command splices, which is how the Ctrl+M
derive survived unnoticed; `Renderer.renderLedger` now records every page
render's outcome so a fixture can assert it.

**Left open, now named**: the refill still has no operation that INTRODUCES a
line boundary, so the three commands that add a user break (Ctrl+B page break,
section header, pickup) derive. The splicer downstream already handles a
changed line count (`pageSpliceNewLineAtEnd`); what is missing is a
repartition step that splits the line containing a new hard start, merges
where one was removed, and lets the existing repair fix the fills. That would
cover all three at once. Two fixtures carry `fullRender` flags naming this gap
so they fail loudly when it closes.

**Where**: `render/linebreaks.ts` (`computeUserBreakSig`, `measureFlowSig`,
`sigFlow`, the second prefix/suffix diff, the flow/redraw branch),
`model/index.ts` (`insertMeasureAt`), `render/pagesplice.ts` (the band clip,
`lastDeferredPages`/`lastDeferredLines`, `aboveComparable`/`belowComparable`,
`isPageMounted` on the ctx), `render/render.ts` (`registerSpliceEffects`
deferral, the extents job's warm step, `renderLedger`),
`test/composer-inspect/phasec/cb-commands.js` + `cb-insertpos.js` (new),
`cb-splicecost.js` (`edit=ctrlm|append*` modes, per-phase `querySelector`
counts), fixtures `pageSpliceClipsToMountedBand`, `pageRenumberIsRedrawOnly`,
`pageExtentsJobWarmsDeferred`, and `pageSystemSpliceEnsureMount` re-asserted
(B5's eager context mount is superseded by the clip).


## 2026-09-03 — The splice window has no context lines: the reference gate is the only fidelity detector (vertical-ownership plan, Phase 3)

**Context**: the window carried the edited line's neighbours, L−1 and L+1, and
compared each against the mounted page (per-measure x/width + signature glyph
codepoints); a mismatch refused the splice. Phases 1 and 2 removed two of the
three jobs those lines did — the vertical spacing chain (every system is now
placed by Composer's rule over measured extents, `render/pagefit.ts`) and the
end-of-line courtesy (Phase 0's one-measure stub) — leaving only the live
fidelity comparison. Max, 2026-09-02, stated exactly what that comparison is:
a replaced set short by ONE line becomes a full render with a reason nobody
reads in production; short by two, or wrong at the same width (a dropped slur
segment, a missing articulation), is a wrong page with or without it. In test
runs it detects nothing the reference gate does not, and every dependency the
window rules encode was discovered in such a run. So it is a fallback that
masks a subset of our own replaced-set defects — the pattern the governing
principle rejects.

**Decision**: drop them. The window is now leader? + the spanner/ending-closed
hunk lines + courtesy stub? + trailer?. `profilesMatch`, `sigGlyphDiff`,
`ContextDiff`/`contextDiff`/`clefGlyphs`, `lastContextDiff`, `EPS` and the
`aboveComparable`/`belowComparable` clip flags are gone. The live neighbour
LOOKUPS stay — they are DOM structure, not verification: they resolve a target
line's page, anchor a non-page-first first line, and are the partition-drift
detectors. `dxFrame` now reads the hunk's own outgoing live system against its
incoming window replacement (both x0 are set by the page frame and the margins,
not by content), because no context line exists to read it from.

The preconditions were tasks, and three of them found real defects rather than
documentation to write:

1. **`spannerExtents` covered a hand-maintained SUBSET of the control events
   the model knows about.** `SPANNER_NAMES` in `render/splice.ts` restated part
   of `CONTROL_EVENT_NAMES` in `model/index.ts`; two lists that had to agree
   did not. It is now DERIVED from that set, so the drift class is
   unrepresentable. Enumerating from the emitters (not from the sonata) found:
   - `tempo` was missing, and a GRADUAL tempo (accel./rit.) carries `@tstamp2`
     exactly like a hairpin. Measured (`cb-spangaps.js`, probe A) this one was
     LATENT, not live: Verovio draws no extension line for it, so the host
     measure renders identically whether or not the `@tstamp2` target is in
     range. Covered anyway — the argument should hold by construction, not by
     that luck.
   - `@tie="m"` — the interior note of a 3+-note chain (`realizeSlot`,
     `model/ties.ts` writes a bare `'m'`) — set NEITHER tie edge, because the
     test was `includes('t')` / `includes('i')`. A range seeded at a medial
     measure pulled in neither neighbour. Live defect, proven: probe B renders
     that measure with no tie where the full render draws one.
   - `pedal` is emitted as two independent point events (`dir="down"`/`"up"`,
     no `@tstamp2`), so no range exists to resolve — but `cb-pedalspan.js`
     shows the `up` measure renders byte-identically without its `down`
     partner: Verovio draws independent glyphs, not a connecting line. No
     dependency to cover, contingent on nobody enabling `pedalStyle`
     line/bracket.
2. **Repeat barlines: the merge is real, and strictly INTRA-LINE.** Verovio
   merges an `rptend` with a following `rptstart` into one barline drawn inside
   the PREDECESSOR's group — `cb-repeatmerge.js`: adding `@left="rptstart"` to
   measure i+1 deletes measure i's right barline (dW −10) and the pair renders
   as four dots on i (dW +320). Across a system break the two sides are
   independent, and `both` is the exact union of each alone. Since the replaced
   set is whole LINES, measure i is either in the same line (covered) or across
   a break (no dependency), so no window rule is needed. `@left`/`@right` are
   attributes on `<measure>`, hence inside its serialized signature, so the
   changed-run detector already sees such an edit.
3. **`beginsSignatureChange` looked at only the FIRST layer of each staff.** It
   `return`ed false at the first layer that opened with an event, so a clef
   change entered on a voice mapped to layer 2 (`layerForVoice`) was invisible
   whenever voice 1's layer began with a note — the common case. Each layer is
   now judged on its own leading elements. This matters more after the drop:
   the stub rule is load-bearing for the replaced line's own courtesy, so a
   missed change is a wrong page, not a slow render.
4. **The reference gate could not see an equal-width content loss.** It
   compared x/width, staff tops and signature glyph codepoints, so a dropped
   slur segment or articulation at the same width passed every check — and the
   context comparison that used to refuse such a window on incidental drift is
   now gone. The gate gained a per-measure glyph-CLASS census AND a per-system
   RESIDUE census. The residue half is load-bearing: Verovio draws the
   continuation segment of a spanner crossing a system break as a direct child
   of `g.system`, outside every measure (4 slurs and 9 ties on the sonata's
   mounted pages), so a per-measure census alone would miss precisely the
   defect a too-small window produces. `pb`/`sb` are excluded: `injectPins`
   upgrades a page start's `<sb>` to `<pb>` in the render copy, so the
   reference legitimately carries `g.pb` where the spliced page carries
   `g.sb`. That exclusion was measured, not assumed — before it, it was the
   ONLY divergence the census reported across all 377 fixtures, which is also
   the evidence that the census is tight rather than noisy.
5. Fixture `pageSystemSpliceRefusesGlyphMismatch` forged a glyph on a context
   line and asserted the refusal; the window no longer renders that line, so it
   became `pageReferenceGateCatchesForgedDefects` — it performs a real splice,
   asserts the gate ACCEPTS it, then forges each of the three defect shapes
   into the replaced line (wrong signature form, a removed glyph group, a
   removed out-of-measure segment) and asserts the gate names each one.
6. Before removing the fallback, it had to be shown redundant on known
   documents: `cb-sweep.js` 115/115 spliced with an EMPTY refusal histogram (no
   `context line diverged` entry at all) and viewport counters 0/0/0, and the
   every-measure pass 420/420 edited at a 100 % splice rate, 0 conflicts, 69
   multi-line sets with 0 failing, empty refusal inventory.

**Measured** (`cb-splicecost.js`, default position — measure 223, line 55 — same
edit and the same replaced set of 1 line / 6 measures on both code states):

| | pre-drop | post-drop |
| --- | --- | --- |
| window | 3 lines / 15 measures | 1 line / 7 measures |
| window Verovio (load + render) | 74.6 ms (17 measures) | 36.1 ms (9 measures) |
| splice `totalMs` | 103 | 57 |
| splice `loadMs` | 79 | 39 |
| steady edit, wall | 173.6 ms | 127.7 ms |

The window is now exactly leader + the hunk's own line + courtesy stub +
trailer. The plan estimated ~6.5 window measures, Verovio 84 → ~38 ms, and a
steady edit near 100 ms; the shape and the Verovio figure landed as predicted
(7 measures, 36.1 ms), and the edit saving is the same ~46 ms off a baseline
this machine measures at 173.6 rather than the plan's 144.

The splice ledger over the fixture suite improved from 31 fixtures rendering
with no full engrave to 47, and its refusal histogram now holds only the two
by-design entries (`single-line partition`, `user breaks changed`) — the
`context line ... diverged` class is gone from the codebase, not merely
unobserved.

## 2026-09-03 — Last-system justification follows our own MIN_FILL, and the splice window renders under the options that PAINTED the page

**Context**: found by the HKL_INDEX_CHECK reference gate the moment Phase 3
removed the live context-line comparison. Fixture
`phase3_ctrlM_keeps_section_bar` began failing with a 6180-unit width
divergence on a system the splice had not even replaced. Two independent
defects sat underneath it, and the context check had been hiding both by
refusing that splice for an unrelated reason and falling back to a full render.

**1. The window and the gate used different options than the paint.**
The pinned and refill renders force `breaks:'encoded'` whenever a LINE
partition is pinned. But `pageSpliceCtx()` and `ensureTkHoldsPageLayout`
re-derived the strategy from `paginationOwned()`, which is PAGE ownership
(`pageStartIds.length > 1`). For every single-page multi-line document the two
disagreed: the DOM was painted `'encoded'` at normal page geometry while the
splice window was built `'line'` with the tall-page trick (`pageHeight:
60_000`, `adjustPageHeight: true`) and the gate's reference was built `'line'`
too. So a replaced line was engraved under different options than the page it
was imported into, and the gate compared the result against a reference nobody
had painted (`cb-p3mei.js`: same MEI byte-for-byte, `optDiff = breaks: stored
'encoded' vs live 'line'`).

Now `Renderer.paintedBreaks()` — `ownershipActive() ? 'encoded' : 'line'` —
serves both, so the reference is rendered exactly as the pages were and the
window engraves in the page's own regime. `optDiff` is empty and the DOM,
the painted-options render and the reference agree. Page ownership still
governs the only thing it should: whether a pagination REPAIR has pins to move
(`repairPagination`, `repairAtMount`).

Cost: two visual baselines (`page_linebreaks_refill`,
`page_system_splice_edit`) shifted SUBPIXEL, confined to the replaced line and
nothing else — the notes moved onto the positions a full engrave of that page
produces. Proven by A/B: with `paintedBreaks` reverted both fixtures match
their old baselines again, while `pagescale_140` does not (that one is defect 2).
The spliced line now sits 3-4 units from a full re-engrave, which is the
`snapSystems` crisp-snap noise the gate already tolerates 30 for.

**2. Last-system justification was Verovio's rule, not ours.** Verovio's
`minLastJustification` defaults to 0.8: a final line whose natural width fills
less than 80 % of the line is left unstretched. We had never set it, so the
threshold governing our final lines was a number nobody chose. It is now
driven by `MIN_FILL` (0.65, exported from `render/linebreaks.ts`) — the fill
below which the line-break owner already considers a line ILLEGAL. One rule
instead of two: a final line is justified exactly when it is a legal line, and
left at its natural width when it is too sparse to be one. Scroll keeps
Verovio's default deliberately — it renders the whole score as ONE system
against a 100 000-unit page, so there is no line to justify to (measured:
43561 either way), and the line-break owner's naturals windows measure NATURAL
widths at that geometry, where justification would corrupt the measurement the
partition is built from. Set explicitly in both branches for the reason
`adjustPageHeight` is: page and scroll share one toolkit and Verovio's
`setOptions` persists any option that is not re-specified.

**Explicitly NOT fixed here** (Max: it belongs with the auto-balance item on
the backlog): end-of-document still does not behave like end-of-section. A
section-final line is not "the last system" as far as Verovio is concerned, so
it justifies at ANY fill, while a document-final line respects the threshold —
measured on a two-section document where both end mid-line
(`cb-lastjustify2.js`): section-final 18790, document-final 4290. Parity is
only reachable in the always-justify direction through this option, and
always-justify is wrong for the low-N case the balancer exists to handle, so
closing the gap needs the balancer to decide N and the per-line fill. The
one-option experiment is recorded in that probe: `minLastJustification: 0`
gives parity at 18790 and costs 35 visual baselines, since almost every test
fixture is a one-line document and therefore the very edge case that should
not stretch.

## 2026-09-03 — Composer owns the STAFF, not just the system: one pass places, nothing snaps afterwards

**Context**: Phase 3's reference gate threw on one sweep position. Chasing it
found that the page splice had never satisfied its own correctness contract — *a
spliced page equals a full re-engrave of the same pinned MEI* — and that
`TOL = 30` had been concealing it for as long as it existed. Measured over the
sonata (115 edits × mounted pages = 338 pairs): **328 pairs deviated**, median
~9 units, on both code states, with the pre-Phase-3 build worse at the extreme
(76.3 units vs 57.6). The gate could not say so, because a tolerance can only
report "nothing exceeded 30" — "exact" and "off by 29 everywhere" are the same
answer to it.

**Two defects, both ours, both from vertical ownership stopping at the system
boundary.**

1. **Place-then-snap.** `placeSystems` chose a system's top from measured
   extents; `snapStaffLinesToGrid` then ran AFTER placement and moved each
   `g.staff` by ≤ ½ device pixel for crispness — mutating the `above`/`span`
   placement had just consumed. A page was `snap(place(x))` while re-measuring
   said `place(snap(x))`, and since a system's extents feed the top of every
   system below it, the error was page-wide. With NO edits at all: 0–10.6 units
   on every page.
2. **The staff correction was a function of the SCREEN, not the music.**
   Correcting each staff row against its device position makes the correction
   depend on the render's arbitrary origin — and a system engraved in a splice
   WINDOW sits at a different raw `y` than the same system in a full page
   render (`lineY` 6255 vs 6812, different residues mod the grid). Each render
   chose a different correction; it landed in `staffTop`; `measureExtents`
   folded it into `above`; placement consumed `above` and put the system a
   whole pixel off. **Every element in those systems was visibly displaced
   while every staff stayed perfectly crisp** — 2.9 % of page 4's pixels — so a
   phase audit read clean and three fix attempts looked straight past it.

**Decision**: one pass owns vertical position, for staves as well as systems.
`alignStaffRows(sys, grid)` spaces a system's staff rows a whole number of
device pixels apart RELATIVE to the system's first row, which is left
untouched — pure intra-system geometry, identical in any render of the same
music. `placeSystems(..., originPhase)` carries the phase, nudging each system
so its first row lands crisp; the rows below, spaced whole pixels away, land on
it too. Both run before `measureExtents`, so `above` is measured from an
uncorrected staff top and is a property of the music rather than of the render.
The reference gate gives its offscreen host identical treatment
(`ctx.alignStaves`). `snapPage` no longer has anything to do on the page path.

**Measured**: page 4 vs a full re-engrave 285 990 differing pixels (258 615
significant) → **97, none significant, max delta 4**. Mount exactness 0–10.6 →
**0** on every page; placement self-error → **0**; exact (edit, page) pairs
**10/338 → 317/338**; deviations ≥ 30 **6 → 0**; off-grid staves **0 of 150**;
systems moved outside the replaced set **0** (unchanged — the splice was never
the problem). Per-measure relX, per-measure width and placement
self-consistency are now all EXACTLY 0 across the document; only the staff top
still deviates, by at most one device pixel, on pages 2/4/25 in some
mounted-set states.

**`TOL` 30 → 10**, one device pixel, set from that measurement rather than
guessed. Lower it only with a census showing the residual gone.

**Dead ends, measured, do not retry** (recorded in `placeSystems`): quantizing
every placement term to the grid made exactness worse (280 exact → 199, six
pairs back over 30); so did quantizing only the `above` clearance (→ 212).
Rounding a noisy input amplifies the noise near a boundary rather than
absorbing it. Round once, as late as possible.

---

## Rule v2: a page distributes its own slack (2026-09-04)

Phase 4 of the (now retired) vertical-ownership plan — the last of it. Phase 1
gave every page a placement rule at MINIMUM clearance, which left all of a
page's unused height in one lump above the bottom margin: on the sonata, 4.0 to
75.5 units, mean 30.6.

**Picked**: one water level per page. The gaps that equalize are the
inter-system gaps AND the gap between the last system and the bottom of the
content column; their sum is fixed by the systems' own heights, so an ordinary
page just shares it out. Three shaping rules, each of which Max set explicitly:

- **A maximum gap, and nothing else.** `maxGap` = 14 units. No fill threshold,
  no last-page exemption: a page too sparse to fill is left sparse rather than
  smeared across the paper, and the cap is the only thing that decides where
  that starts. 14 is not a taste pick — it is the smallest cap at which no
  ORDINARY sonata page clamps (the binding page needs 11.96), and therefore the
  smallest cap that keeps the top gap for genuinely sparse pages. Below it,
  pages 3/7/12/25 clamp and start opening their top gaps, which defeats the
  gating below.
- **A gap wider than the level cannot be compressed**, so the level is the L
  solving `Σ max(gap_k, L) + L = C`, not `C / n`. One sonata page exercises it
  (page 21: a header system whose `above` is 1.2 units forces an 8.8-unit gap);
  with `C / n` it lands 5.2-unit gaps over a 1.7-unit bottom gap.
- **The page-header → first-system gap is a last resort, not a participant.**
  It opens only when the systems have taken all they may (the level hit
  `maxGap`) AND the bottom gap still exceeds `maxGap`, up to `topMax` = 10
  units — and NEVER on page 1, whose first system keeps its distance to the
  title block under all circumstances. On the sonata it opens on exactly four
  pages (6, 17, 19, 20), all 3-system.

**Rejected**: distributing into the top gap on equal footing with the others
(it lowered the knee to 12 units but opened the top on ordinary pages, which is
what the gating exists to prevent); a fill threshold (D2's MIN_FILL question —
Max: maximum gap only); exempting the last page (the cap already handles it).

**Two things the measurement forced, neither of them in the plan.**

1. **The running footer moved into the bottom margin** (`FOOTER_Y` in main.ts,
   was `PAGE_INNER_H − 200`, now `+ 370`). It had been sitting INSIDE the
   content column with the whole 14 mm bottom margin empty below it, which cost
   every page 10.1 units of reach and already put the music THROUGH the footer
   text on sonata pages 21 and 23 — a live defect, not a new one. Repaginating
   against the footer where it stood cost a page and four near-miss 3-system
   pages (a 4th system missing by 1.2–6.0 units); moving it costs nothing and
   leaves pagination byte-identical. Consequence worth having: adding or
   removing a footer can no longer change pagination. How far down is a
   PRINTABILITY question and the margin is tight — 14 mm of margin against 3.6
   mm of footer ink means a footer wholly below the column can never be more
   than 0.41 in from the paper edge; 0.378 in is what we take.
2. **The fold limit is the content column, not the paper edge.** Verovio's
   castoff used the column; `foldIndex` used the paper, one bottom margin
   lower, so a REPAIRED page could hold a system a fresh castoff would not
   (sonata pages 6, 17, 19). Now both stop at the column, and the justification
   target is the same line. Zero pagination change on the sonata.

**Placement is now NON-LOCAL within a page** — the load-bearing consequence.
Under v1 a system's position depended only on the systems above it; under v2 it
depends on every system on the page, through the level. So every path that
changes a page's system set must re-place the whole page. All of them did
except one (`lazyMoveOut`, the arithmetic-past-mount cascade step), which the
reference gate caught as a staircase of downward shifts on the spilling page.
See lessons.md, "Rule v2 made placement non-local".

**Ordering**: pagination is judged on v1 and only then is the resulting page
distributed. `placeSystems` takes the distribution as an argument; `placePage`
and the reference gate pass it, `foldOf` and `predictFoldFromStore` do not.
Feeding a distributed placement to `foldIndex` would be circular.

**Where it lives**: `placeSystems` / `distributionExtras` / `DistributeOpts` in
`apps/composer/src/render/pagefit.ts`; `contentBottomOf`, `headBottomOf` and
the `PlaceOpts` plumbing in `render/render.ts`; `FOOTER_Y` and the page-1-only
credit in `main.ts`.

---

## Snap-as-output in placement; the gated sweep (2026-09-04)

**Problem**: with rule v2 live, the battery reported staff tops 30 units off on
every edit and a 2-pixel staircase on sonata page 18 after `delete-whole-line`.
Three of those readings were the battery's own (it placed both sides
undistributed, and its reference host got neither `alignStavesIn` nor
`decorateHost`, all of which the gate does — fixed in the probe). The remainder
was real: `layoutSystems` accumulated positions from each system's SNAPPED top
and `distributionExtras` solved the level on snapped geometry, so one system's
≤½-pixel rounding fed every system below it.

**Picked**: snapping is an output transform. `PlacedSystem` carries `rawTop`
and `rawContentBottom`; the accumulator runs on `rawTop`; the level is solved on
unsnapped gaps; `ty` is the only place the grid appears. The one-device-pixel
residual on a single system is unchanged and remains accepted (`TOL` 10, not
revisited).

**Rejected, measured**: quantizing the level once per page — 7 deviating
(page, system) pairs at most 20 units became 13 at most 40. Same mechanism as
the rule-v1 dead end: rounding a noisy shared quantity near a boundary
multiplies the flip by every system beneath it. Recorded in `placeSystems`.
Also rejected without trying, on Max's reasoning: whole-pixel inter-system
advances chained from a snapped first system — the first system's rounding
would still drive the chain.

**Measured**: battery deviations 7 → 4, max 20 → 10, no page with more than
one system moved; gated sweep 4/25 → 0/25; then **0 divergences over all 115
positions** — the first sweep this project has run with the reference gate
enabled. Suite 375/377 → 377/377 after two baselines were re-seeded (approved).

**Verification changes that made this findable**: `cb-sweep.js --arg check=1`
enables the gate and catches its throw per position (it used to abort the
probe); `from=` chunks a gated pass under the runner's 300 s cap (sampling with
`stride` had shown 0/23 where stride 1 showed 4/25 — sampling and chunking are
not interchangeable). The battery records every deviation (`devs`), not only
the worst, and can leave one page in `#score` for a screenshot
(`shot=<edit>,mode=spliced|reengrave,page=N`) so the self-consistency pair can
be heatmapped. `run.mjs` shoots that same pair automatically on any non-visual
fixture failure (`HKL_FAIL_SHOTS`). `visualMeta` records the capture framing
(`clip`, `vpW`/`vpH`, `leftEl`).

## 2026-09-04 — Engraving conventions batch (backlog Correctness + Opinionation)

**Context**: with Composer's performance at an acceptable baseline, Max asked for the musical-level backlog items (Correctness ×4, Opinionation ×7) to each get an attempt. Every mechanism below was probed against the live Verovio 6.3 toolkit first (lessons.md, 2026-09-04 entries) and lands with a fixture (`ENGRAVING` group, `engr_*`). One entry per non-obvious choice.

### Brace + `bar.thru` mark a grand staff only

The root `<staffGrp>` had carried `symbol="brace" bar.thru="true"` since the skeleton was piano-only; the MusicXML importer copied that onto the root of multi-part scores, so the sonata braced viola + piano together, ran barlines between the instruments, and the piano itself had no brace; a solo one-staff import braced a lone staff (Verovio draws a brace on any group that asks). **Picked**: brace + bar.thru on two-staff groups only — the root of an implicit two-staff doc, or each nested two-staff instrument group — never on a multi-instrument root or a one-staff group; enforced on every load by `normalizeStaffGroupConventions` (replaces the old "add bar.thru to the first staffGrp" migration, which would have joined instruments on a nested doc) and emitted directly by the importer. Idempotent, so the roundtrip invariant holds. **Where**: `model/index.ts`, `importMusicXml.ts`.

### Rests coincide / stay unaffected by hidden rests via `@loc`, not `<space>`

Two identical rests at one moment in a staff's two voices drew above and below the staff; a hidden rest displaced the visible one. **Rejected**: converting the layer-2 twin / the hidden rest to `<space>` on the render clone — Verovio centres the survivor (probed), but `g.space` is an empty group with a zero bbox, so the cursor, click hit-testing and the selection overlay would lose the element (they resolve rests by xml:id). **Picked**: pin `@loc` (single-layer default: 6 for whole/`mRest`, 4 otherwise) on a rest whose span meets only void content, or exactly one identical visible rest, in the other layer; two rests at one `@loc` render as one glyph with no x shift (probed). Never against a note/chord/tuplet — that collides. **Where**: `notation/restlayout.ts`, run by `applyRenderConventions`.

### Section breaks draw no courtesy signatures — Verovio restart + invisible meter, unconditionally

Verovio has no switch; the only mechanism is `<section restart="true">`, which drops the key cautionary but not the meter (see lessons). **Picked**: on the render clone, wrap each section-start boundary `<scoreDef>` in a content-less nested restart section placed before the break, give a meter change `meter.form="invis"` and inject a visible layer-level `<meterSig>` into the first measure. **Accepted side effects** (Verovio's restart semantics, all visible on the sonata's movement II page): the new movement's first system draws full instrument labels and is indented like the score's first system; the blanked meter reserves ~½ staff space; scroll view draws a clef at the restart measure. **Rejected**: restructuring the document into sibling `<section>`s (every break-pinning / range-clone / splice site assumes one section) and hiding the cautionaries in the SVG (Verovio has already spaced for them — a 758-unit hole before the barline). **Applied in every render path**, not gated to page view: the naturals windows, castoff, splice windows and page render must all see the same measure widths, and the scroll-view clef at a movement boundary reads fine. A section break WITHOUT a signature change is untouched (no restart, so no labels) — if Max wants every movement to restate labels/meter, an empty restart scoreDef would do it. **Where**: `notation/sectionRestart.ts`.

### Instruments sit 18 units apart, via `staffDef@spacing` on the render clone

`spacingStaff` floors every pair (the piano's inner gap grew with it); `staffDef@spacing` is per pair. 18 units = 9 staff spaces against the grand staff's 6 — chosen by eye on the sonata's page 1, tunable in one constant (`INSTRUMENT_GAP_UNITS`). Stamped on the render clone, so it is a Composer default rather than a per-file setting and no `.hkc` changes. **Where**: `notation/instrumentSpacing.ts`.

### Dynamics: `dynamDist 3.5` + a DOM centring pass; the PDF is behind

Verovio's default sat a dynamic's top a quarter staff space under the line. `dynamDist` has a dead zone below 2 (see lessons); 3.5 puts the top ~0.7 space down. Centring between a grand staff's staves is not a Verovio option at all, so it is a DOM post-process (`render/textlayout.ts`) in `postProcessRendered`, before placement measures the system: centre in the inter-staff gap, clamped by the other staff's glyphs in the mark's x-range; `<dir>` under any other staff nudged to the dynamics' clearance (the one case that grows a system's extents — hence before placement). Blocks of x-overlapping marks move together so Verovio's stacking and dynamic↔hairpin alignment survive. **Known gap**: PDF export re-renders through Verovio and never ran the DOM passes — it now shares `dynamDist` but not the centring, and it also predates the injected footer/composer/section titles and the page-size factor. Closing it means rendering the PDF from the same page DOM the screen shows; not done here.

### Running header: outer-corner page numbers + centred title on pages 2+

Verovio's "– N –" centred header is restyled in place (x/anchor of its `tspan.rend`, dashes removed; baseline untouched so the header band `firstContentTop` measures is unchanged) — even pages left, odd right, the edge away from the binding — and the title is injected as a sibling `<text>` centred at the same baseline. Page 1 keeps Verovio's title block and stays unnumbered, as before. The number's corner is recomputed on every mount from `data-page`, so a renumbered page corrects itself when it re-mounts (the same staleness class as the number text). `createPageFromShell` strips the running title like the other injected texts.

### Injected page text follows the page's real column

Footer, composer credit and section titles used the unscaled US-Letter constants; at a 140 % page size the footer landed a third of the way up the paper. Now every injector reads the page's `definition-scale` viewBox and `page-margin` translate (`pageFrameOf`); the footer's drop into the margin scales with the margin. The constants remain as the fallback for an unreadable frame.

### MusicXML engraving fidelity: stems, hollow heads, tuplet visibility, and a tuplet rescale

`<stem>` → `@stem.dir`/`@stem.visible`, `<notehead filled="no">` → `@head.fill="void"`, `<tuplet bracket/show-number>` → `@bracket.visible`/`@num.visible`. Explicit stems become "manual" stems in Composer (later transposition keeps them) — the same treatment MuseScore/Sibelius give imported stems; accepted. Finale's measured tremolo (two 32nds under a 1:8 tuplet) is rescaled to `k : numbase·k/num` (2:16) because Composer's tuplet model — placeholders, the placeholder invariant — holds exactly `num` atoms; the ratio is unchanged. **Slur analysis** (backlog "Verovio problem or ours? Can we detect it?"): ours by omission — dropping the source stems let Verovio's layer default flip m. 82's whole configuration; Verovio's layer rule itself (upper-voice slur above) is standard two-voice engraving and was not overridden. Detecting a slur on the bracket side is possible post-render (compare bboxes) but flipping it in m. 82 would run it through the layer-2 chord, so no automatic flip was added for native entry.

**Addendum (same day)**: the restyle changed the header's bbox bottom by one unit (dash glyph cells), which flipped rule v2's pixel quantization on re-placed pages and showed up ONLY in the gated sonata sweep (6 one-pixel divergences, 0 on the pre-change tree). `styleRunningHeader` now records the original bottom as `data-hkl-head-bottom` before touching the text and `headBottomOf` prefers it, so placement sees Verovio's header on every host. → lessons.md "Anything that touches the page header changes placement".

**Addendum (same day, dynamics pass)**: the pass measures in SVG user space via `getBBox` + `getCTM`, rounded to whole units — its first version used screen rectangles, which differ per host by the sub-pixel phase and flipped placement by a pixel on re-placed pages (gated sweep). → lessons.md "A DOM pass that feeds placement must measure in SVG user space".

**Addendum (same day, reference gate)**: the remaining three one-pixel gate divergences were the accepted header-non-determinism residual (live first-pass header 252.00000763 vs reference 254, same extents to three decimals) rejected by float noise at the exact tolerance boundary (15259.999999999998 vs 15270 → 10.000000000002 > 10). `TOL` in `verifyAgainstReference` is now `10 + 1e-6` — still one device pixel, now compared as one. Not a widening: a real defect is ≥ 2 units past a pixel, never a billionth. → lessons.md 2026-09-04 follow-up.

## 2026-09-05 — Engraving batch, second pass (Max's review of the 09-04 batch)

Four corrections from Max's hands-on review, each a decision in its own right:

### Dynamics clearance: `dynamDist` 3.5 → 4.5
3.5 moved a dynamic's top from a quarter to 0.7 of a staff space below the line — "still only a few px". 4.5 puts it 1.2 spaces down (a "p" centred about two spaces below the line); `DIR_GAP_PER_UNIT` follows (24 → 192 user units) so expressive text shares the baseline. Probed in-app, not only in a bare toolkit, before choosing.

### Slur side: a render pass, not imported stems
Max: the invariant is placement of elements relative to each other — a slur never on the tuplet-bracket side, on the beam side only when unavoidable — and exact Finale replication is not the goal, so importing Finale's `<stem>` (09-04) was reverted. Verovio's rules, probed exactly: in a two-voice staff stems follow the LAYER per moment (1 up, 2 down) whenever the other layer holds any element with a duration there — notes, rests, hidden rests — and the pitch rule only when it holds `<space>`; tuplet brackets go on the stem-majority side; slurs go opposite the stems in a single voice but by layer in two voices (1 above, 2 below), which lands the upper voice's slur on its own beams and brackets (m. 82) and the lower voice's on its own (m. 84). `notation/slurSides.ts` sets `@curvedir` to the notehead side for slurs whose endpoints meet non-space content in the other layer; everything else stays Verovio's. My 09-04 claims that Verovio's two-voice rule is standard and that m. 82's flipped slur would run into the lower voice were wrong (Max) and are withdrawn; the flipped m. 82 renders cleanly.

### Inter-instrument clearance: `defaultBottomMargin` 2.0, `staffDef@spacing` reverted
The 09-04 `staffDef@spacing="18"` governed the distance between the staff LINES, so it separated empty staves and left the actual problem — colliding overflow between instruments — unchanged (Max). Reverted. Verovio widens a collision-driven staff distance by the colliding boxes plus their margins, and the margin every element gets by default is half a unit; `defaultBottomMargin: 2.0` raises that to about one staff space of clearance between overflowing elements and touches nothing else (probed: an uncollided pair stayed at 960; `defaultTopMargin` had no effect on the case). Sonata: systems with overlapping cross-instrument elements 18 → 9 of 116, tight ones (< ½ unit) 29 → 14, 33 → 31 pages once the empty-staff gaps came back. Not a DOM pass: Verovio still owns intra-system spacing, and this is its own knob.

### Section breaks: courtesy meter only; the restart wrapper is gone
Restating the instrument names at a movement start is unacceptable (Max) — "I just asked for the courtesy signatures to be removed, nothing more". Probed every way to keep the restart without labels (empty `<label>`s on the restart scoreDef, bare staffDefs, empty `<labelAbbr>` in the head): Verovio's restart always draws the full labels. So `notation/sectionRestart.ts` now only blanks the courtesy METER (`meter.form="invis"` + layer-level meterSig, which never needed the restart); the courtesy KEY stays until Verovio grows a switch (upstream: two lines in `SetCautionaryScoreDefFunctor::VisitStaff`). The alternative — hiding the key courtesy in the DOM — leaves its allocated width as a blank before the barline and was not taken; Max can choose it.

## 2026-09-05 — Movement breaks via restart + label replacement; unbroken barlines; text marks inside their measure

**Section restarts** (`notation/sectionRestart.ts`, `applySectionRestarts`): the
restart wrapper removed in the morning is back, now with the instrument-name
problem solved instead of accepted. Options weighed with Max: (a) a full
restart — rejected, restates names and indents; (b) patching Verovio — a fork
to carry on every update; (c) deleting the courtesy from the SVG — leaves its
width in the justified line; (d) a blank stub measure after the double bar on
the new line, removed post-render — borrows the courtesy-stub machinery but
leaves its width too; (e) a restart whose labels Verovio is told to drop —
Max's preference "if we can do it". (e) is possible in 6.3.0 through
`ScoreDef::ReplaceDrawingLabels` (see lessons.md for the three traps). The
recipe: head staffGrps get `@n`; the boundary scoreDef is wrapped in a
childless restart section; a second plain section carries a second scoreDef
with `<staffGrp n><label>ABBR</label><staffDef n=firstStaff/>` per labelled
group. The restart system then draws what every continuation system draws
(today: no labels — Composer's instruments have no `<labelAbbr>`), with the
same indent, and no courtesy key or meter precedes it. Saved document unchanged.

**Barlines never break** (`render/barlines.ts`): Verovio's draw-time erasure of
`bar.thru` barlines under marks is refilled from the barline's own segments,
draw-only, only inside grand-staff gaps the barline actually enters. Chosen
over hiding the marks from Verovio (impossible: the erasure has no option) and
over leaving the mark where Verovio put it (the vertical centring is the point).

**Text marks stay inside their own measure** (`render/textlayout.ts`): a
`<dynam>`/`<dir>` whose box overlaps one of its measure's barlines is moved to
the near side, half a unit clear, before the vertical rules run — the mark is
encoded in that measure, so it is drawn in it; a mark at tstamp beats+1 lands
just before the barline, where Finale's `relative-x` nudge had it. Applied to
every text mark, not only those inside a grand staff (Max: nothing sits on a
measure boundary); hairpins exempt; a mark wider than its measure stays put.
Import-time normalisation (moving a beats+1 dynamic to the next measure's
tstamp 1) was considered and NOT done — it changes the document and would
stack the mark on any downbeat text (sonata m. 90 "cresc.").

Verified: typecheck/build/boundaries; `pnpm test:composer` 392/392 (2 new
fixtures + `engr_sectionBreakNoCourtesySigs` tightened to reject a courtesy
key); sonata whole-document inventory with every page mounted — 0 erased
stretches, 0 marks on barlines, 2 fills, 7 horizontal nudges, all three
movement boundaries courtesy-free with continuation indent, 0 Verovio warnings
on a full re-render.

## 2026-09-05 — Section balancing: a section-final line below MIN_FILL is redistributed into its section, never left as a lone bar

**Context**: Verovio's castoff packs measures greedily at natural width ≤ 1.0
and justifies, so every section ends in whatever remainder is left. Measured on
the sonata: all four movements ended below MIN_FILL (fills 0.16 / 0.56 / 0.32 /
0.25) — movement I's last system was ONE bar justified across the page before
the movement break, movement IV's a one-bar stub at the end of the document.
The edit path had the same hole: `repartition` repairs a line by moving one
measure across a boundary, pulling only from the NEXT line, so a section-final
line has nothing to pull from — composing at the end produced a stub, deleting
at a section end a sparse stretched line. Backlog line 99; the 2026-09-03
last-justification entry deferred end-of-section parity to "the balancer".
Max's rules: (1) within a run of systems where measures move freely, similar
fill per system — similar, not optimal if optimal is expensive; (2) in the
section that ends the document, if that cannot be done with every system ≥
MIN_FILL (small documents), keep the last measure a stub as before.

**Decision** (`render/balance.ts`, driven from `render/linebreaks.ts`):

1. **One trigger everywhere**: a section (the lines between two hard starts —
   `hardStartIds`) is *defective* when its final line's fill is below MIN_FILL.
   MIN_FILL already meant "too sparse to be a line" and "not justified"; the
   balancer makes the three uses one rule. Nothing else ever triggers it — a
   section whose castoff fills range 0.71–1.0 is left exactly as cast off
   (Max: defective sections only, 2026-09-05).
2. **The balancer is a repair, not a re-derivation**: merge rule first (the
   sparse final line folds into its predecessor while the merged fill stays ≤
   `MERGE_MAX` 1.2), then a DP minimising Σ(fill−mean)² over the section at the
   CURRENT line count with every line inside [MIN_FILL, FIT_MAX], plus a change
   penalty `BALANCE_LAMBDA` 0.02 per line start absent from the current
   partition while any of the section's lines is mounted (0 when none is —
   nothing visible changes, so the even optimum is free). N−1 is tried only when
   N has no legal partition and only if its densest line stays ≤ MERGE_MAX. No
   legal partition → the repaired partition stands: a document-final stub stays
   and `minLastJustification` leaves it unstretched (rule 2); a mid-document
   section too small for two legal lines stays stretched by Verovio (no option
   value changes that; an `<mdiv>` split is the only lever and is not taken).
   Evidence for λ and MERGE_MAX (offline replay on the sonata's measured widths,
   `test/balance/run.mjs`): the plain DP rewrote 70 of 35 boundaries when one
   bar was deleted at the end of movement I; λ = 0.02 + MERGE_MAX 1.2 turned the
   same sequence into alternating 2- and 1-boundary repairs with the movement
   holding mean 0.85, sd 0.05; λ ≤ 0.005 still rippled, MERGE_MAX 1.0 never
   merged. N is otherwise kept because pagination is carried by line.
3. **Where it runs** (decided with Max 2026-09-05: sync for the initially
   mounted band, lazy for the rest):
   - **Derive, before the first pinned paint** (`Renderer.balanceInitialBand`):
     the sections with a line on the first `INITIAL_BAND_PAGES` (2) pages. The
     justified width comes from the castoff layout the live toolkit holds,
     rendered to a detached host (nothing is mounted yet, and a previous render's
     DOM may sit at another page scale). Only the final line is measured to
     decide; the whole section only when defective. Sonata movement I: 139
     measures, 0.8–1.0 s, 63 boundaries changed, one line removed — and page 1
     is painted balanced, so it never re-flows under the reader.
   - **Idle job** (`PageLineBreaks.armBalanceJob`) for every other section,
     mounted sections first: ≤ `BALANCE_SLICE` 40 naturals per idle slice (each
     ~250–420 ms of Verovio — the adoption walk's 40 ms budget is unreachable
     for a render, and an idle callback's forced 1 s timeout can land one before
     a keystroke; accepted). The final line first, then the WHOLE section
     regardless of the verdict, so every section is warm for a later edit (the
     edit path never measures a whole section). A balanced section lands through
     `Renderer.applyPartitionChange`: a `SpliceRequest` with `partitionOnly`,
     which the splicer defers whole (pins committed, pages stale) when its first
     line is unmounted and for which B5's ensure-mount is skipped — the first
     run mounted movement II's far pages, spliced them, threw, and left a zombie
     job; slices now run under try/catch (cancel + warn; rethrow under
     HKL_INDEX_CHECK). The partition cache records `balanced` when the job
     finishes, so a zoom round-trip neither re-balances nor re-arms.
   - **Edit path** (`repartition`, after the repair loop, `balanceTouched`):
     the sections the edit touched, with λ, and only when their naturals are all
     cached — a section the job has not reached keeps today's behaviour and the
     job balances it on arrival. Never a whole-section window on the hot path.
4. **`minLastJustification` moves to MIN_FILL − `LAST_JUSTIFY_SLACK` (0.05)**.
   The 2026-09-03 "one rule" tied it to MIN_FILL, but the two yardsticks are
   different numbers: a balanced 9-bar document-final section measured 0.657 by
   our naturals fill and drew UNJUSTIFIED (12710 of 19010) under the bare
   constant. With the slack, a line the balancer kept legal is always drawn
   justified; a stub it kept is far below by both yardsticks and is not.

**Results** (sonata, headless Chromium, `cb-balance.js`): movements I/III/IV
lose one line each (the stub folds into its neighbour), II keeps 21; minimum
line fill 0.16/0.56/0.32/0.25 → 0.81/0.83/0.84/0.83, per-movement sd ≈ 0.05,
116 → 113 lines, 31 pages; job 5.7 s in 10 slices; `page1Changed: false`; no
Verovio or page-breaks notices. Suite 392/392 (no baseline moved — the balancer
only fires on a defective section) + 4 new fixtures (`pageBalanceSectionFinal`
with a full-page baseline, `pageBalanceDocFinalSmallDocKeepsStub`,
`pageBalanceComposeAtEnd`, `pageBalanceDeleteAtSectionEnd`).

**Rejected**: re-deriving the whole section on every edit (the hysteresis Max
ruled out on 2026-08-30 returns as jitter); synchronous whole-document naturals
at load (3.4–3.9 s on the sonata); tail-scoped balancing (cheaper naturals, but
leaves a density step of ~0.2 between the balanced tail and the body — rule 1
asks for the section); always-justify via `minLastJustification: 0` (wrong for
the small-document case rule 2 exists for); balancing every section at load
(rule 1 literally — Max chose defective-only: minimal deviation from castoff,
same trigger as the edit path).

**Splicer fix found on the way** (`pagesplice.ts` `spliceDom`): a page-first
hunk line's target page was "the page its start measure sits on now", which
sends the line to the PREVIOUS page whenever a page-start boundary moves back —
routine for the balancer, latent for an edit pushing onto a single-line last
page. With an unchanged page count the target is the element numbered p
(lessons.md 2026-09-05).

**Window-builder fix found on the way** (`pagesplice.ts` `buildWindowMei`): the
synthetic leader/trailer counted every `staffDef` in the window, including the
restart's label-replacement ones (sectionRestart.ts, this morning), so a window
holding a movement boundary got a 5-staff leader for a 3-staff score and
Verovio crashed on loadData ("null function"). The count now comes from the
head scoreDef; fixture `pageSpliceLeaderAtSectionRestart` (lessons.md
2026-09-05).

**Not done, adjacent**: the refill still derives on a NEW hard start (Ctrl+B,
section header) — the merge rule's `linesReplaced` bookkeeping is one of the
building blocks that gap needs; D3 reflow-document and D4 move-measure commands
remain future work. Undo after a push or merge does not restore the line count
(unchanged for boundary-moving edits; `pageLineBreaksUndoRestoresLayout` still
guards the legality-preserving case).


## 2026-09-05 — PDF export is the page DOM, page for page

**Decision**: `downloadPdf` takes the live page SVGs (`Renderer.mountAllPages()`, which mounts every virtualized placeholder through the ordinary mount path) and prints each one; it no longer serializes, sets options, or calls Verovio at all. Scroll view exports by switching to page view for the duration (deferred render awaited, then switched back).

**Why**: the export dated from June, when the screen was Verovio SVG plus three passes, and it kept a private copy of those three under its own fixed options (Letter, `scale 100`, `breaks 'auto'`). Since then the page layout moved into post-Verovio work on the page DOM — line-break and vertical ownership, balancing, the below-staff text layout, header/footer/section-title injection, `pageScale` — none of which reached the PDF, and its cast-off inputs differed from the screen's before any of that (the "WYSIWYG gap" of 2026-09-04). Two pipelines can only diverge; one cannot. Max: "Couldn't we just have it render the pages in the same way and export them as is?" — yes. Zoom is not a variable: page geometry is scaled by the zoom's unit compensation (`scalePageGeom`), so the layout in staff spaces is zoom-invariant, and vector output makes the device scale irrelevant.

**Consequences**: the export clones every page synchronously before its first `await` — the mount window can evict far pages on the next idle tick (a pending IntersectionObserver callback schedules it); a detached SVG keeps its subtree, but the export must be one consistent picture of the screen. Print normalization (`normalizePageForPrint`) is all that remains of the old path — light theme forced (tags stripped, inline notehead colors removed), non-notehead black, hidden rests removed, stylesheet stroke inlined, and stylesheet text weight/slant inlined (`inlineComputedTextStyle`, added the same day after Max read the tempo's missing bold off the heatmap) — because svg-to-pdfkit reads presentation attributes and inline style only. The paper stays US Letter (`pageScale` is score-relative-to-page, not sheet size). The live toolkit's layout is never replaced, so `pageVirt.tkCurrent` has no export case left to guard. Sonata probe (31 pages): 31 PDF pages for 31 DOM pages; pages 1–2 pixel-aligned against clipped live captures (heatmap: edge antialiasing only); export ≈ 6 s plus ≈ 6.5 s to mount 30 pages. **Residual**: `Times, serif` text uses PDFKit's built-in Times, whose advances differ from the browser's substitute serif (the sonata's tempo text is visibly wider on screen) — fixing it means shipping one serif face for both screen and PDF; not done here. Probe: `test/composer-inspect/phasec/pdf-wysiwyg.mjs`.

## 2026-09-05 — Composer layout backlog pass (the six "Layout:" items)

Max asked for a solution and/or report on each. Four fixed, one rule refined,
one assessed.

### Theme: the light switch retags every page wrapper (fixed)
`Renderer.applyThemeToRendered()` re-ran `applyNotationTheme` on `#score`
only. `postProcessRendered` tags each MOUNTED page wrapper (and each spliced
system) with its own `data-notation-theme`, and the theme CSS keys on any
tagged ancestor — so a page mounted under dark kept its dark tag after the
switch to light; with the inline notehead paint just removed, the dark ink
rules clobbered that page's noteheads white until the next re-render retagged
it ("sometimes": only pages mounted while dark). The switch now clears / sets
the tag on every tagged descendant too. Probed on the sonata (page 3 mounted
under dark → light: tags `[]`, fills back to ink). Fixture
`engr_themeLightSwitchClearsPageTags`.

### Layer scroll-follow tracks the layer's moment (fixed)
`visualCursorMeasure()` — the anchor for scroll-into-view and page mounting —
always returned the VOICE cursor's measure. In the expression / pedal / tempo
layers the reader is looking at the layer's moment; every layer action that
re-rendered (selecting / moving a mark) then scrolled back to wherever the
voice cursor was parked — the first page, typically, whose unmounted state is
how Max described it. The anchor is now `momentAtCurrentCursor` in those
modes (exported from input.ts). Fixture `scrollExprLayerFollowsMoment`.

### Tuplet brackets: Verovio's default, never forced (fixed)
Probed (6.3): with `@bracket.visible` unset Verovio draws the bracket unless
the tuplet is wholly under ONE beam (a beam over part of the tuplet, a rest
outside the beam, or unbeamed quarters all keep it); `bracket.visible="true"`
forces it onto the beam. Composer's `createTupletAtCursor` wrote "true", and
the importer wrote "true" for every source `bracket="yes"`. Both now omit the
attribute (the importer still writes "false" for `bracket="no"`), and
`replaceDocument` strips a "true" from older files. Max's rule: numbers alone
on full beams. Fixtures `m1Triplet8BeamedNumberOnly`,
`m1TripletQuarterBracket`; `engr_slurNoteheadSideTwoVoice` no longer expects a
bracket on its beamed triplet.

### Hairpins alone go to the dynamics' line (fixed)
Probed: Verovio's `dynamDist` governs `<dynam>` only — a lone hairpin's top
sits 0.3 space under the staff at every setting, and a hairpin is aligned to a
dynamic only when both share a moment (then its top sits 2 px above the
dynamic's). In the sonata's viola, mm. 49–52, the crescendo's centre was 15 px
BELOW the following `f` (Verovio aligned it to something lower) and the
decrescendo's 16 px ABOVE the following `p` (it hugged the staff) — exactly the
"crescendo too low, decrescendo too high" Max saw. `render/textlayout.ts`
under a non-grand staff now clusters dynamics, text and hairpins alike: a
cluster holding a dynamic is left as Verovio placed it (dynamDist is the
baseline; Verovio aligned what touches it); text is pushed down to the
clearance as before; a hairpin-only cluster is put AT the line, up or down,
its top `HAIRPIN_LIFT` (a quarter unit) above `DIR_GAP` to mirror Verovio's
own alignment offset. Grand-staff centring is unchanged. Fixture
`engr_hairpinAloneOnDynamicsLine`.
**Left for Max**: his note that the added separation should apply to staff
lines, not notes. Probed: `dynamDist` does NOT stack on low notes (a dynamic
under a note below the staff sits at the same y for dynamDist 1 and 4.5). The
note-to-dynamic clearance of a full staff space comes from
`defaultBottomMargin: 2.0` (2026-09-05, the inter-instrument overflow fix) —
Verovio has no dynam-specific bottom margin, and the same margin is what
separates the viola's dynamics from the piano's high notes. Lowering it (1.0
≈ half a space) trades one against the other; not changed.

### Slur side: keep the flip, re-draw what Verovio displaces (fixed, second pass)
Sonata m. 83, bass staff: layer 1 a slurred pair of beamed triplets (d♭4 → b2,
stems up), layer 2 a dotted-half chord b1+b2 sharing the slur's downbeat. The
09-05 pass flipped the slur below; Verovio drew it from under the chord —
start point 65 px (8 units) below its own notehead, then a 100-px scoop.
Max: there IS room under the notes; moving the slur up is unnecessary, and a
pitch-based gate on the flip (tried first, withdrawn the same afternoon) put
p. 17's slurs back above tuplet brackets. Bare-toolkit probes on the extracted
staff: removing the chord (or dropping it an octave) puts the start 9 px under
its notehead; stripping the chord's stem changes nothing; without layer 2 the
stems flip to the pitch rule and the beams block the slur instead;
`slurEndpointFlexibility` 0 (the default) still shifts the start;
`@bezier` and `@bulge` change nothing; `@startvo`/`@endvo` do move the
endpoints (in units, negative = down) but would have to be predicted before
the render. So Verovio's endpoint rule treats the other layer's noteheads in
the slur's own start column as part of it and starts below them.

**Decision**: `render/slurlayout.ts`, a DOM post-process in
`postProcessRendered` (before placement): every flipped slur whose rendered
endpoint sits > 2 units from its notehead is re-drawn from the noteheads —
endpoints ¾ unit past them on the slur side, a cubic bulging 0.12 × span
(1.25–3.5 units), grown to 6 units until the sampled curve clears every glyph
box of the staff in its span by half a unit; no clear curve → Verovio's path
stays (`data-hkl-slur="kept"`). Same shape as Verovio's (two cubics, 0.1-unit
stroke, 0.6-unit midpoint); `data-hkl-orig-d` for idempotency. Slurs Verovio
places at their notes (p. 17's bass slurs, m. 81/85/89) are untouched. The
side pass also now compares staff / layer NUMBERS: a slur across a barline was
read as cross-staff and never flipped (p. 17 m. 31, m. 39). Sonata after:
m. 83 start 6 px under its notehead, p. 17 bass slurs all below, m. 82/84 as
before. Fixture `engr_slurBelowRedrawnAtNotes` (m. 83's geometry) replaces the
withdrawn gate's fixture. **Broken slurs** (same day, Max: "the slur in
V5 collides with V6 on both sides of the break" between p. 17 and p. 18): 44
of the sonata's 922 slurs cross a system break; Verovio draws two segments
(the continuation `class="slur id-<id> spanning"`, no id) and parks each open
end at a fixed staff-relative spot — just under the bottom line for a
below-slur — so a flipped bass slur's first segment dives from mid-staff to
below it and the continuation starts there and climbs through the staff and the
lower voice (3 of the 44 hit lower-voice noteheads: m. 43→44, 52→53, 88→89;
none of the 41 unflipped ones did). The re-draw now handles a segment whose
other note is on another system — resolved within its own system, since the
far note's page may not be mounted: the open end is anchored past the covered
notehead of the slur's own layer NEAREST the break (the extreme head anywhere
in the segment put a stub's start under the lower voice), at Verovio's
open-end x; a segment whose Verovio curve runs through a glyph is re-drawn
even when its endpoints look fine (the m. 43→44 continuation started at a
sensible height and cut through the staff); an open end that cannot clear
moves back toward the covered notes half a unit at a time; a last attempt
shrinks the end gap and margin. Ledger lines left the obstacle list — a slur's
own end hangs at the level of the ledger line under its notehead, so every
slur ending beyond the staff had been unsolvable. And one case is impossible:
an other-voice note STARTING in the endpoint's column within a THIRD of the
slur's end note on the flip side (heads a space tall already overlap at a
third — m. 52→53; a pitch-only test also caught m. 83, whose chord began nine
steps below at the slur's START); `slurSides` now skips that flip, the
invariant's "unavoidable". Sonata after: 44 broken
slurs, 7 segments re-drawn, 0 lower-voice collisions. Fixture
`engr_slurBrokenAtBreakRedrawn`.

**Mixed stem directions — investigated, not built** (Max: a slurred group
should try to make all its stems face one way; its own thread): 112 of the
922 slurs (12 %) span notes whose stems Verovio points both ways; 110 are
single-voice (viola 56, piano right hand 49, left hand 3), and Verovio puts
every one of them above. 48 of them currently sit on the beam or bracket side
(20 with a drawn bracket) — the visible invariant violations the feature would
remove; the other 60 are over unbeamed notes, where "above" is acceptable.
Majority direction: down 61, up 18, tie 29. The cost of unifying is the
minority notes' distance from the middle line: 75 within one space, 14 at two,
19 at three or more (max 6) — those last would get 6.5-space stems and want a
cap. Bare-toolkit probe: `@stem.dir` on each note of a beam flips the whole
beam and Verovio then places the slur opposite the unified stems (a `stem.dir`
on the `<beam>` element is ignored). Proposed shape: a render-clone pass before
`settleSlurSides` that, per single-voice slur (longest first, notes not yet
assigned), predicts each note's natural direction from pitch (beam groups by
their mean), picks the majority (ties → the direction of the note farthest
from the middle, Verovio's own beam rule), skips groups whose minority notes
sit more than ~2.5 spaces off the middle, respects explicit `@stem.dir`, and
writes `@stem.dir` on the group's notes and chords; the slur side then follows
without a `@curvedir`. Roughly a day with sonata before/after counts as the
gate.

**Open**: nothing else on slurs. (The mixed-stem feature was built the same
evening — see "Slur stems unified" below.)

### Tuplet numerals off steep beams (fixed)
With the bracket gone, Verovio sets a wholly-beamed tuplet's numeral against
its beam; on p. 17 three steep bass triplets (f3 → b♭3 → d♭4) had the "3"
7.7 px INTO the beam while all 51 other numerals on the page cleared theirs by
≥ 4 px (measured at the polygon's edge under the numeral — a bounding-box
test flags every sloped beam and was discarded). `render/tupletnums.ts` moves a
bracketless numeral clear by half a unit, along its beam side; bracketed
numerals stay with their bracket. Fixture `engr_tupletNumClearsSteepBeam`.

### Single-part view is owned and balanced like the score (done)
**Context**: the balancer runs inside the page line-break OWNER, and the owner
was bypassed whenever `viewStaves != null`: `derivePageRender` painted the
filtered serialization with Verovio's castoff and `invalidate()`d, `tryRefill`
bailed with 'filtered view', and the partition cache, extents job, heaviness
predictor and page splicer were all gated `viewStaves == null`. Nothing in the
balancer cares about staves — ids, hard starts and fills carry over — but a
part has its own WIDTHS (a viola line holds more bars), so it needs its own
partition. Plan approved by Max the same afternoon.

**Decision**: thread the staff subset, never renumber. `PageLineBreaks.setView`
(called by `renderComposer` before every page render) keys the owner on
`viewKeyOf(viewStaves)` — a different subset invalidates everything owned
(partition, naturals, sigW, budget) — and the owner's serializes carry it: the
refill's pinned MEI and the naturals windows. The renderer keeps the same
`viewStaves` for `pinnedMeiForCurrentModel` (lazy mounts after a splice, the
reference gate), the segmented castoff and `partitionKey` (`|v…`, so the
score's cached partition survives a round-trip through a part). The page
splicer gets `PageSpliceCtx.viewStaves` for its window, and its synthetic
leader / trailer now takes the filtered head's staffDef NUMBERS instead of
`1..n` (the viola alone is staff 3; a synthetic staff 1 would have had no
staffDef). The derive bail and the four gates are gone; a view CHANGE still
derives (`forceFullRerender` → `invalidate`). Scroll view's splicer stays
all-parts only (its gap calibration assumes the full staff set).

**Results** (sonata, viola-only, headless Chromium): ownership engages on the
filtered layout — 81 lines, 9 pages (score: 113 / 31); the sync band balance
fires before the paint (movement I: 9 boundaries moved, one line removed); the
idle job finishes in 10 slices / 2.0 s; per-movement fills min 0.89 / 0.85 /
0.89 / 0.80, sd ≤ 0.057; view switch 1.2–1.4 s (castoff + adopt + balance +
pinned paint, where it was one plain render); back to all parts 0.7–0.85 s via
the cached score partition; no console notices. An edit in the view goes
through the same refill: composing past the end with the last page mounted
splices; with it unmounted the splicer refuses ('edit line not mounted') and
the pinned refill renders, exactly as in the score. Suite: fixtures
`pageBalanceSinglePartView` (13 + 9-bar viola part viewed alone: owned,
balanced, only staff 3 drawn, all systems justified) and
`pageSinglePartViewEditSplices` (composing past the end in the view splices).

**Not done**: the scroll splicer in single-part view; a per-part partition
cache means up to one entry per (zoom, page scale, HEJI, staff subset) — the
24-entry cap still bounds it.

## 2026-09-05 — Slur stems unified (the mixed-stem feature, built)

Max: build it as outlined. `notation/slurStems.ts` (`unifySlurStems`), a
render-clone pass in `applyRenderConventions` after beaming and before
`settleSlurSides`. Per slur, longest first: covered slots (same staff and layer
NUMBER, start → end across measures), grouped into units (a beam / tremolo, or
a lone note / chord), each unit's natural direction predicted from pitch
against the middle line (note: down at or above; chord: its farthest note;
beam: the mean; ties down), the majority over the covered notes (tie → the
note farthest from the middle), and `@stem.dir` written on every note and
chord of every unit — the whole beam when it reaches past the slur. Verovio
then places the single-voice slur opposite the unified stems; no `@curvedir`.

Refinements on the proposal, made while building: (1) "single-voice" is
tested at EVERY covered note (not just the ends) — one two-voice moment under
the slur and Verovio stems by layer there, so the group is left alone;
(2) an explicit `@stem.dir` (the `L` key) or a direction a longer slur already
wrote is a FIXED vote: it decides the group's direction, and a group whose
fixed directions disagree is left; (3) the cap is measured on the minority
units' extreme note on the stem side (`CAP_STEPS` 5 = 2.5 spaces), not on
every note; (4) the middle line is tracked through head and interior
`staffDef` clefs (`clef.dis` too) and per-layer inline `<clef>`s; (5) grace
notes, cross-staff notes (`@staff`), unpitched staves and slurs with an
explicit `@curvedir` are skipped; (6) each judged slur is tagged `@hkl-stems`
(unified-up / unified-down / capped / fixed) — surfaced by
`svgAdditionalAttribute` as `data-hkl-stems` (Verovio prepends `data-`, so
the MEI attribute must NOT carry the prefix; `data-hkl-stems` came out as
`data-data-hkl-stems`).

**Gate** (`test/composer-inspect/phasec/cb-slurstems.js`, the sonata, 918 of
its 922 slurs resolvable to one staff + layer): the investigation's 112 mixed
slurs were 104 — the first census read a chord's stem against ONE notehead,
a coin flip for octave chords; the probe now reads the stem's reach past all
of them. Before: 104 mixed (102 single-voice; majority down 53, up 18, tie
31), 75 slurs on a beam side, 22 on a bracket side. After: 92 unified (35 up,
57 down), 10 capped; 13 mixed remain — the 10 capped (9 on a beam, 1 on a
bracket: m. 99 LH), the 2 two-voice ones (Verovio's per-moment rule mixes
them; m. 3→4 LH, m. 84→85 viola), and one unexplained at m. 57 LH (bass
clef, single-voice by every test here, yet Verovio stems one beam up and the
next down — likely a cross-staff or per-moment layer effect this model does
not see; one slur, not chased). Beam-side slurs 75 → 16 (the 12 mixed above
plus 4 uniform two-voice slurs whose flip `settleSlurSides` already leaves as
unavoidable), bracket-side 22 → 1. Page 1 before/after was shown to Max.
Fixture `engr_slurUnifiesMixedStems` (a unified group with a beam, and a
capped group; the saved document carries no `stem.dir`). Docs:
architecture/composer.md (`slurStems.ts` bullet), guide/composer.md, phasec
README.

**Forced stems are fixed votes** (same evening, Max on p. 15: "the slur
between measure 3 and 4 of the third movement is flipped such that it goes
through the stems … because the note after the bar line has its stem forced
up by the second voice, the triplet before the bar line should also have its
stems up. Slur going through stems is unacceptable under any circumstance").
The first cut skipped any slur with a two-voice moment under it; there the
end note's stem was forced up by layer, the side pass flipped the slur below
(the end's notehead side), and the single-voice triplet before the barline
kept its down stems under it. Now a covered note in a two-voice moment
carries Verovio's layer direction as a FIXED vote, like an explicit
`@stem.dir`, and the cap does not apply to a group a fixed vote decides —
leaving it mixed is exactly the slur through the stems. Sonata: mixed
13 → 9 (the 2 two-voice ones unified; 2 formerly capped groups now decided by
a fixed vote), beam-side 16 → 12, unified 97, capped 8. Fixture
`engr_slurStemsFollowForcedVoice` (the m. 3→4 shape: a triplet before the
barline, a forced note after it; asserts no slur sample inside any stem or
beam box). Page 15 after was shown to Max.

**The beam rule is the chord rule** (later the same evening). The one
unexplained slur — p. 13, II m. 57, piano LH, a two-note slur joining two
beamed quintuplets whose stems Verovio points opposite ways — was a
misprediction: the pass called both beams up by the MEAN of their notes
(b♭4 e♭5 b4 a♭4 g4 a4 in treble averages −⅙ step), found no mixing and left
them. Verovio stems that beam down. A probe over every untouched
single-voice beam of the sonata settled the rule: the notes farthest above
and below the middle line decide, down when the top is at least as far as
the bottom (ties down) — the same rule as for a chord — 899 of 899 beams,
where the mean rule matched 891 and a count-above-vs-below rule 887; the
note rule (down at or above the middle) 860/860, the chord rule 655/655.
The pass now uses the extreme-notes rule for beams too; the m. 57 pair is
unified. Max reviewed the 8 capped slurs (pp. 2, 2, 7, 8, 8, 15, 21, 29) and
the 3 blocked two-voice slurs the through-stem test flagged (pp. 19, 20):
all read as fine, no worse than Finale's treatment — the cap stays at 2.5
spaces. The census (`cb-slurstems.js`) now reports page and movement per
row (measure numbers restart per movement — a first diagnostic keyed on
measure + staff alone merged m. 57 of every movement into one story; Max
caught it) and a `throughStem` column: slur-path samples inside a stem or
beam box of the slur's own notes.

**Open**: nothing on this feature.

## 2026-09-06 — Composer layout backlog pass, second batch (the eight "Layout:" items)

Max asked for a solution and/or report on each. Seven built (each with a
fixture), one — the inter-instrument spacing — measured and designed, not
built. Gates: typecheck, boundaries, composer build, `pnpm test:composer`
415/415 (36 page-view baselines re-seeded: every page-mode doc carries the
default title, whose block grew — heatmaps show a uniform shift plus the
larger "Untitled", footer unchanged), sonata probes before/after via the new
`test/composer-inspect/phasec/pageshots.mjs` (import + optional probe +
clipped PNG per requested page).

### Every tempo marking imports (P1, built)
`importMusicXml.ts` took only the FIRST `<direction>` with `<metronome>` /
`<sound tempo>` and then skipped every later tempo direction's words — the
sonata's 17 other markings ("Poco più mosso", "Tempo I", "Allegro
scherzando", "Grave", …) were silently dropped. Now `scanPartDirections`
collects a `TempoRec` per tempo direction (words = verbal text, bpm from
`<sound tempo>` or `<per-minute>`, metronome SHOWN only when the source drew
`<metronome>`, italic when every word is), plus a bare measure-level
`<sound tempo>` (Finale's hidden tempo change) as a text-less playback-only
`<tempo>`; records identical in (moment, text, bpm) across parts collapse to
one, emitted through `addTempo` above staff 1. Sonata: 1 → 18 `<tempo>`
(one text-less at II m. 57, bpm 115). Playback already read `collectTempi`.
**For Max**: the hidden tempo is a real, invisible element in the tempo
layer; say if it should be dropped instead. Fixture `phase5_musicxml_tempi`.

### Rests inside tuplet brackets: the two-voice rule (built)
Sonata III, piano bass: m. 30's voice-1 eighth rest against a low half note
sat in the staff's upper half; m. 35's against a low quarter was lifted clear
of the staff into its tuplet bracket — Verovio's two-voice offset is keyed to
the other note's DURATION (lessons.md). `notation/restlayout.ts` now pins
`@loc` for a rest whose span meets only notes/chords in the other layer: voice
1 at the raised spot (6; whole rests 8) or higher until its glyph clears the
predicted ink top by half a location, voice 2 at 2 (whole 4) or lower against
the ink bottom; the prediction is heads from pitch + clef (`staffpos.ts`,
extracted from `slurStems.ts`), stems on the layer's side (explicit
`@stem.dir` wins; `unifySlurStems` moved ahead of it) 3.5 spaces and at least
to the middle line, beams at the group's farthest stem, +2 locations for an
accidental or articulation. A rest that would leave the staff by more than
one location (`STAFF_SLACK`), a tremolo, an unpitched note or a rest in the
other layer stays Verovio's. Glyph extents table `REST_EXTENT` from the probed
eighth (2.0 … 1.46 locations about its loc) and Bravura metrics. Sonata: mm.
35/37/38 rests at loc 6 inside the staff, brackets clear; m. 30 unchanged
(loc 6 was Verovio's too); III m. 10's quarter rests 6 (one location above
the top line, allowed). Fixture `engr_tupletRestOnStaffTwoVoice`.

### Text colliding with slurs (built; one residual is item 4)
p. 21 m. 94: the piano's "rit." (above staff 2) sat on the right hand's slur —
Verovio's positioners avoid notes, not curves. `render/textlayout.ts` gains an
above-staff rule for `<dir>`/`<dynam>`/`<tempo>` (hence `tempo@staff/@place`
in `svgAdditionalAttribute`): sample every slur/tie outline (48 points via
`getPointAtLength`, mapped to the frame); a curve whose outline dips below the
mark's top (anchored at the mark's staff or lower) and whose top within the
mark's x-range reaches the box lifts the mark, stacked marks with it, to
half a unit clear — limited by the staff above and its content. Sonata: 95
above-marks, 14 lifted, 1 still on a curve: m. 94 itself, which rose 273 and
stopped one space under the viola (rule below) with the slur's top still 189
inside its box — only more room between the instruments fixes it. Fixture
`engr_dirAboveClearsSlur`.

### Elements too close to the next instrument (reported, not built)
Max: "the mf on the viola part [p. 16, top system] reads as part of the piano
part. Can we devise some metric to detect cases of elements in close
proximity and increase the spacing?" Diagnosis: III m. 10's viola triplets
have their numerals BELOW the staff, Verovio stacks the mf under the numeral
(573 user units = 3.6 spaces below the viola), and its collision margin
(`defaultBottomMargin` 2.0 = one space) then packs the piano to 161 above the
mf's box: right relative to the viola, wrong relative to the piano.
**Metric** (probe over all 115 sonata systems with viola + piano): for each
viola below-mark, `dOwn` = mark top − viola bottom line, `dOther` = nearest
piano ink or line below within its x-range − mark bottom. 123 marks: 46 sit
nearer the piano than their own staff (`dOther < dOwn`), 21 within one space
of piano ink; worst p. 21 m. 99 "dim." (785 vs 72), p. 13 m. 58 dynamic (757
vs 163), p. 16 m. 22 "cresc." (669 vs 151). The viola→piano line gap is 960
(Verovio's `spacingStaff` floor) on the median system, so almost every case is
Verovio packing to its margin. **Proposed rule**: shift the lower instrument
down by `max(0, min(dOwn, CAP) − dOther)` over its neighbour's marks (CAP 6
units so a mark under a very low ledger note does not demand its whole
distance), plus a general ink floor of one space; on the sonata that moves 39
systems, p90 shift 319 user units (2 spaces), max 408. **Mechanism**: a DOM
pass in `postProcessRendered` before placement (like `textlayout.ts`), per
system per adjacent instrument pair: translate the lower instrument's
`g.staff` groups and every control event attributed to them (`data-staff` for
dynam/dir/hairpin/tempo; slurs/ties/fermatas/trills/pedals by their start
note's staff — `startid` exposed via `svgAdditionalAttribute`; system-level
continuation slurs by endpoint row), translate barLine paths inside the moved
rows and LENGTHEN the ones that span the boundary (the system's left line;
`barlines.ts` already parses `M x y L x y`), move the brace/labels, round the
shift to whole device pixels, compose with `textlayout`'s transforms (it
resets and rewrites marks first, so this pass must run after it and undo only
its own tags), and record `data-hkl-ishift` for idempotency. Interactions to
gate: `alignStavesIn` (staff phase), rule v2 extents (the pass grows the
system, which placement then consumes — the same contract as the dir nudge),
the reference gate (both hosts run the pass), PDF (page DOM), the splice
window (scoped runs). About a day with the gated sweep as the correctness
bar. Not built: it touches system geometry and the splice contract — Max's
call. Built now as a partial: `textlayout.ts` pushes text DOWN toward another
instrument to `INSTR_CLEAR` (one space) instead of the grand-staff half unit;
Verovio-placed marks are untouched, so the 46 cases stand.

### Courtesy clef at section breaks (built)
The importer encodes a movement-start clef change as a layer-initial `<clef>`
and `relocateInitialClefs` moved it into the previous measure — Composer's
own courtesy clef before II's double bar (piano right hand to bass clef).
`relocateInitialClefs` now leaves a section-start measure's leading clef in
place and `applySectionRestarts` removes it from the layers and writes it as
a staffDef into a THIRD scoreDef in a third plain nested section after the
labels — the Verovio loophole in lessons.md ("a later scoreDef in the same run
escapes the restart cautionary"); a clef-only boundary gets an attribute-less
restart scoreDef. Sonata: II's last measure has no clef glyph, III starts in
bass clef, no labels, zero console output. A clef set at the END of the
previous measure's layer (an unusual native edit) is not folded — noted, not
handled. Fixture `engr_sectionBreakNoCourtesyClef`.

### Header sizes and the subtitle (built)
`render/pageheader.ts` `styleTitleBlock`, run from `postProcessRendered`
(before placement, so the header's bbox — `firstContentTop`'s anchor — grows
with it): title leaf 540 → `TITLE_FONT_PX` 600 with its ink top kept (baseline
+53), and the subtitle's positioned tspan moved so its box sits
`SUBTITLE_GAP` 100 below the title's box (Verovio's `<lb/>` stepped it by the
outer rend's 347-unit line height: boxes overlapping by 33 on the sonata).
Sonata page 1: header bottom 778 → 971, first system 936 → 1136, still 31
pages. Pages 2+: running title and page number 288 → `RUNNING_HEADER_FONT_PX`
320 (the footer's size; main.ts `styleRunningHeader`, band recorded first).
The composer credit's anchor read the first system's `getBBox().y` without
its placement translate — invisible until the header moved the system — and
now adds `translateOf(system).ty`. Fixture `engr_titleBlockSizes`.

### Max's review, same day: rests touched chord heads; header gap
Voice-1 rest against a voice-2 chord topping at the middle line or third
space: the rest pinned by the new two-voice rule sat on the top head. Cause: a
head's ink box reaches 1.1 locations above its centre (measured), the rule
assumed 0.5, and its margin was another 0.5 — a quarter space of "clearance"
became contact. Now `HEAD_HALF` 1.1, `MARGIN` one location (half a space),
accidentals/articulations 2.5 from the centre, half and whole rests snapped to
a line. Consequence: a rest against a chord at the middle line or higher
computes a location above the staff's slack and defers to Verovio (whose own
anchor for that case is location 8); the rule now only ever moves a rest DOWN
from Verovio's default into the staff when the other voice sits low (sonata
mm. 30/35/10 unchanged at location 6). Fixture
`engr_twoVoiceRestClearsChordHead`. Header: subtitle 288 → `SUBTITLE_FONT_PX`
320 (the title's 600/540 ratio), and `SUBTITLE_GAP` = one subtitle line
between the two text boxes (100 units "barely moved" — Max wants a full gap
between the blocks).

### Max's second review: "subtitle" = the composer credit; Setup subtitle inert
What Max calls the subtitle is the right-aligned composer/opus line — not the
`<title type="subtitle">` the Setup dialog offers (which, separately, never
reached the page: a Setup apply took the refill path, and Verovio's header is
only regenerated by a full engrave — it now `forceFullRerender`s). The credit
was injected after placement, anchored to the first system's top, so it sat
beside the title with the two text boxes overlapping vertically, and nothing
could make room under the title for it. Now `render/pageheader.ts` draws it
INSIDE `g.pgHead` before placement: `CREDIT_FONT_PX` 360 (324 × 600/540, the
title's ratio), box top a full credit line (`CREDIT_GAP` 360) below the title
block (title, or the subtitle when present), right-aligned to the page's real
column; the header band grows and the first system follows. A title-less
document with a composer gets a synthesized `g.pgHead` so the band exists. The
real subtitle keeps the 320 px / full-line rule from the morning, untested by
Max. Fixture `engr_titleBlockSizes` (extended); `pageFrameOf` moved from
main.ts to pageheader.ts.

### Title block is computed, not measured (Firefox: no tspan getBBox)
Max, testing on Firefox: "no gap is honored at all" — the credit sat on the
title's line, and the title never grew, no matter how the gap constants were
set. `styleTitle` derived the whole block from `getBBox()` on the title /
subtitle `<tspan>`s, which Gecko does not answer, so it bailed to `null` and
the credit took its `blockBottom === null ? 0` branch. Every constant above
was Chromium-only. `styleTitleBlock` now measures NOTHING: each edge is the
nominal em-box of a (baseline, font-size) pair, so the same header yields the
same numbers on every engine and in detached hosts (splice window, reference
gate) where `getBBox` throws regardless.

The metric is `ASCENT` 0.891 / `DESCENT` 0.216 (Times), **quantized to whole
CSS pixels** — Verovio's `definition-scale` makes 1 px = 10 user units, and
that quantization is exactly what the old measurement was picking up
(Chromium reported ascent 480 and 530 at font-size 540 and 600, not 481.1 and
534.6). Skipping it is not cosmetic: the unrounded value put the title
baseline 3 units low, grew the header band 551 → 554, and — because the band
feeds `headBottomOf` → `firstContentTop` — crossed a device-grid snap that
moved every system and section header on the page a full pixel, failing
`phase3_section_header` and `phase5_musicxml_barlines`. Quantized, the output
is identical to the measured version at all six of the sonata header's
readings, so no visual baseline moved. Fixture
`engr_titleBlockWithoutTspanBBox` poisons `SVGTSpanElement.prototype.getBBox`
to throw, reproducing Gecko inside the Chromium suite (RESET_SNIPPET restores
it); `engr_titleBlockSizes` now also states the credit clears the TITLE, the
relation that was broken, not just the subtitle.

### Subtitle: the credit's size, on the next line
Max, closing out the header work: "increase the font to match the composer
line, remove the additional gap above it." `SUBTITLE_FONT_PX` is now
`CREDIT_FONT_PX` (360, was 320) — the subtitle and the credit read as a pair,
so they share a size — and `SUBTITLE_GAP` is 0. Zero is not an overlap: the
block is measured in em-boxes, so a gap of 0 puts the subtitle's box top
exactly on the title's box bottom, i.e. ordinary consecutive-line spacing,
where Verovio's own `<lb/>` step (the outer rend's line height, less than the
grown title's size) genuinely overlapped them. The subtitle baseline is now
SET rather than `Math.max`-clamped against Verovio's step: the clamp existed
to never pull the line above where Verovio put it, but at gap 0 it would
reinstate whatever arbitrary gap that step left — the gap being removed. The
credit keeps `CREDIT_GAP`, a full line of its own size, below the block.
Fixtures `engr_titleBlockSizes` / `engr_titleBlockWithoutTspanBBox` assert
360 px and that the title/subtitle boxes MEET (|gap| <= 1.5 px) rather than
clearing by a line.

## 2026-09-08 — Beat-level text anchoring: `<offset>` honored, same-moment marks un-stacked

**Context**: the two remaining `Layout:` items in backlog.md meet in one
measure. p. 21 m. 99 (`<measure number="323">` of the sonata) holds six marks
and exhibits both faults: three land at `tstamp=4` in a **3/4** bar because
`<offset>` was never read, and the piano's `p` + `dim.` land at an identical
`(measure, tstamp, staff, place)` because Finale's horizontal nudge is dropped,
so Verovio draws them at one x and stacks them — the deep stack the 09-06
proximity metric read as its worst case (785 units below its own staff vs 72
above the piano). Fixing the anchor first means the inter-instrument pass does
not pay for stacks that should not exist.

**Numbers re-derived from the XML** (not relayed): of 351 `<direction>`s, 16
carry `<offset>` and all 16 change their anchor; 33 land at `tstamp > beats`, of
which 8 come back inside the bar and 25 legitimately stay at the bar end (13 are
`wedge type="stop"`); and exactly **3** groups collide at an identical anchor —
`@n` 31, 121, 99 — all three carrying the `default-x`/`relative-x` that
separated them in Finale.

**The two populations are disjoint.** All 3 collisions sit at `tstamp=1` with no
offset involved, and none of the 16 offset marks collides with anything. So
honoring `<offset>` fixes none of the stacks, and the placement rule was a
required deliverable rather than a contingency — the opposite of the phasing
first assumed.

1. **`<offset>` is applied to the anchor moment** (`importMusicXml.ts`,
   `scanPartDirections`), for `dynam`/`dir`/`tempo`/`hairpin` (per direction, so
   a wedge's start and stop each take their own). It moves the single `@tstamp`,
   so the playback effect travels with the glyph. Every sonata offset is
   `sound="no"` — MusicXML asks for visuals only — but the offset position is
   the musically correct one: m. 43's diminuendo wedge is written AT the bar end
   with offset −480, so un-offset it *begins on the barline*. Max chose to move
   both.
2. **`<octave-shift>` is excluded**: its `startDiv`/`endDiv` decide which notes
   get rewritten an octave, so an offset there would change content rather than
   placement, and the bracket is drawn from `@startid`/`@endid` anyway.
3. **A negative offset past the bar start clamps to beat 1**, not migrating into
   the previous measure — the same call as the 2026-09-05 entry that declined
   import-time anchor normalisation ("it changes the document and would stack
   the mark on any downbeat text"). No upper clamp: `beats+1` is what the
   barline nudge exists for.
4. **Finale's horizontal nudges stay dropped**, and the separation is DERIVED
   (`textlayout.ts`): a cluster's dynamic keeps its place and its same-anchor
   `<dir>`s move to its right, centred on its line. `@ho` was rejected without a
   probe on the strength of lessons.md's HEJI finding — it nudges a glyph but
   reserves no layout space, so it could not ask Verovio to make room. Gated on
   `dynam@tstamp`/`dir@tstamp` (new in `svgAdditionalAttribute`, mirrored in
   `@hkl/notation`, which had also drifted on `tempo@staff`/`@place`) so only a
   genuinely identical anchor qualifies — overlapping boxes alone must not
   un-stack two marks a beat apart. A run with no room (crossing the measure's
   barline or reaching the next cluster) is abandoned; Verovio's stack is the
   honest answer, and p. 21 m. 99 is 259 tenths wide holding one dotted-half
   chord, so that guard was expected to fire there. It did not — all three
   groups found room.
5. **The centring phase now ADDS its dy** instead of assigning it, so the
   un-stack composes with a grand-staff centring. Equivalent for every cluster
   that has no un-stack (the assignment was always the first write).

**Verified**: typecheck / boundaries / composer build clean; `pnpm test:composer`
419/419 after the import change, then 420/420 with the two new fixtures
(`phase5_musicxml_direction_offset`, `engr_sameMomentDynamAndDirSideBySide`), no
visual baseline drift. Sonata, in the rendered DOM: m. 35's `dim.` moved from
tstamp 4 to 2; all three same-anchor groups now lay out side by side and
vertically overlapping, m. 99's `dim.` moving right 253 units and its pair
aligned in the grand-staff gap.

### The census probe, and a phantom it produced first
`test/composer-inspect/phasec/cb-instrgap.js` is the committed inter-instrument
census (the 09-06 one was ephemeral): per adjacent instrument pair per system,
each mark's `dOwn` / `dOther` / demand, a bare ink-floor term, the residue
inventory, and the system-spanning-path check. Its first run reported 90
ink-floor violations and 96 of 113 systems moving. **That was a probe bug**:
Verovio emits zero-size `g.accid` groups whose `getBBox` is 0×0 at the local
origin, and mapped into the frame they land at (0,0) and read as ink touching
across the whole system — 78 of the 90 had a gap of *exactly* 0, which is what
gave it away. The guard cannot live in the box helper (staff LINES are
legitimately zero-height, and guarding there zeroed the whole census); it
belongs at the ink and mark consumers, exactly where `textlayout.ts` already
puts it (`!(box.right > box.left)`).

Corrected, the census **reproduces the 09-06 numbers**: 45 upper-below marks
nearer the other instrument against the recorded 46 (the delta is A1 having
already moved 16 anchors), 18 within one space against 21. Two-sided it is 151
marks at the boundary, 61 nearer the other instrument, 35 within a space, demand
p50 228 / p90 383 / max 403 (recorded: p90 319, max 408), **45 systems moved by
the mark term, 25 by the ink floor, 50 in all** of 113. The 09-06 estimate of 39
was the mark term alone.

**Residue inventory (what an instrument-shift pass must attribute)**: `slur` 966
carry `@startid` ✓ and `dynam`/`dir`/`hairpin`/`tempo` carry `@staff` ✓, but
**`tie` 290 carry neither** and nor do `grpSym` 113 (the braces), `mNum` 109,
`fermata` 4, `voltaBracket` 4, `trill` 3, `octave` 3, `ending` 2, `label` 2,
`section` 8, `systemMilestoneEnd` 10. And the inventory **refuted the plan's
guess** that no line crosses an instrument boundary: there are **113
system-spanning vertical paths**, one per system at x≈10 — the system's left
line — which a shift must LENGTHEN. Assuming otherwise (as the 09-06 sketch
did, reasoning from `bar.thru` being grand-pair-only) would have shipped a
visibly broken left edge.

## 2026-09-08 — Inter-instrument clearance: built, measured, and gated OFF on a pagination boundary

**Context**: the second half of the Layout pair above — the 09-06 "elements too
close to the next instrument" item, whose mechanism sketch this supersedes.
`render/instrgap.ts` shifts a lower instrument down until every boundary mark is
at least as close to its own staff as to its neighbour.

**The 09-06 sketch was wrong in two ways**, both found by reading before
writing:

1. **`alignStaffRows` (pagefit.ts) is the sole owner of a `g.staff` transform.**
   It rewrites every row from the staff-line path text (`staffLineYs` ignores
   the transform) and `placePage` calls it FIRST — on the reference host too —
   so the sketch's "translate the lower instrument's `g.staff` groups" would be
   destroyed before it was ever measured. Instead the shift is recorded as
   `data-hkl-ishift` and `alignStaffRows` ADDS it to its own phase correction.
   Because the shift is a whole `grid` multiple, `rel` is arithmetically
   unchanged and the crispness invariant holds.
2. **"Lengthen the barlines that span the boundary" was reasoned from
   `bar.thru` being grand-pair-only, and the inventory refuted it**: there are
   **113 system-spanning vertical paths**, one per system at x≈10 — the system's
   left line. It is lengthened (in the element's OWN local space, converted
   through the frame→element y scale, since the nested `svg.definition-scale`
   viewBox means local units are not frame units), with `data-hkl-igrow` holding
   the original `d` for idempotency.

**Ordering** (`postProcessRendered`): `textlayout` → `instrgap` → `textlayout`
again, on the systems that moved only (48 of 113). The pass needs marks SETTLED
(its metric measures what is drawn) and must also release textlayout's
`INSTR_CLEAR` clamp — the thing that left p. 21 m. 94's "rit." on a slur. One
extra round suffices by construction: widening only LOOSENS a clamp, and the
grant is exactly the demand the first round could not meet.

**Attribution is by attribute, never by guess.** A `g.staff` carries its own
notes/stems/beams, so translating it moves the music. Everything else is
resolved by `data-staff` (dynam/dir/hairpin/tempo/octave), `data-startid` → the
note's staff (slur/tie/fermata/trill/lv — new in `svgAdditionalAttribute`;
fermata/trill/lv are note-anchored in our MEI and carry no `@staff`, probed), or
the instrument band (grpSym, label — unambiguous, probed). `mNum`/`ending`/
`voltaBracket` ride the top staff. **A tie could not be attributed
geometrically** — of 290, 131 sit in the piano's band, 43 in the viola's, 72 in
the inter-instrument gap and 44 above every staff — which is why `tie@startid`
exists. An element that resolves to nothing leaves its system UNSHIFTED and
warns; on the sonata that is 1 system of 112 (a continuation slur whose start
note is in the previous system and whose band is ambiguous).

**Measured, pass on**: marks nearer the other instrument 59 → 28, within one
space 33 → 12, systems with unmet demand 48 → 11, demand p50 223 → 80. 40
systems shift, 10–410 user units, every value a whole device pixel. The residual
28 are CAP-limited BY DESIGN: after a shift of `min(dOwn, CAP) − dOther` a mark
whose `dOwn` exceeds CAP (480) is still nearer its neighbour, which is the point
of the cap — a mark under a very low ledger note must not demand its whole
distance.

**Status: ON, with one known defect** (`ENABLED = true` in instrgap.ts, at
Max's request so it can be investigated live).

**Two wrong diagnoses were recorded here first; both are retracted.** (a) "The
overflow cascade never ran" — that reading of `lastCascade` was taken before
`mountAllPages`, so the cascade simply had not happened yet. (b) "The cascade
drops a block on failure, losing four measures" — that came from probes that
measured a **PRE-SETTLE** layout. `balanceJobActive()` is false BEFORE the job
is armed, so waiting for `!active` returns instantly; on the sonata the
partition is still 31 pages / 115 lines at t=0 and only reaches its final 30 /
113 at **~5.7 s**. Max caught it: the output matched a state he had seen before
his own render settled. → lessons.md "Wait for the partition to stop changing".

**The real defect**: after the partition settles to 30 pages, there are still
**31 page divs** — the count is frozen from the initial `tk.getPageCount()`
castoff and does not follow the settled pins — so `mountAllPages` renders 112
of the 113 lines and the stale 31st div sits empty. Mounting the last page
ALONE draws the finale correctly (`106-108 | 109-112 | 113-116`, cascade 0
steps), which is why nothing is wrong in ordinary reading. It bites the
**bulk-mount path**, and PDF export uses exactly that path (`save.ts` mounts
all pages and clones the live SVGs), so an export would be short a system.

The pass is what exposes it: taller systems make the settled partition SHRINK
from the castoff's 31 pages to 30, and only a settled count that is LOWER than
the div count produces the mismatch. Whether a pass-off render settles at 31
(and so never mismatches) is the open question — it would also explain why
Max's session shows a consistently different partition from the headless one
(his page 30 starts at m. 97 and page 31 at m. 112; the headless settled
partition has 30 pages with page 30 starting at m. 106).

**The fix belongs in the page-div count, not in this pass**: the number of page
divs should follow the settled pins. (The earlier "the cascade is one page short at the end" reading is also
retracted — the cascade only ran at all because bulk mounting drove it, and from
a settled state with a correct div count there is nothing for it to repair.)

Diagnostic committed: `test/composer-inspect/phasec/cb-pagegrowth.js` prints
every quantity that disagrees (Verovio's page count vs the frozen virt count vs
page divs, lineStarts vs rendered systems, doc vs rendered measures, the cascade
counters, empty pages, per-page system counts) in one run. **Read the cascade
counters AFTER `mountAllPages`** — that is the mistake above.

Gated off, the tree is unchanged behaviour: sonata renders 446/446 measures, 113
systems, 31 pages; typecheck / boundaries / build clean. The plumbing
(`alignStaffRows`'s `data-hkl-ishift`, textlayout's `data-hkl-clamped` and
ishift composition) is inert without the pass. **Fixtures are still owed** and
land with the feature.

## A mark's transform stays textlayout's; instrgap only tags it (2026-09-09)

`render/instrgap.ts` shifts an instrument by writing translates, but a
`g.dynam`/`g.dir`/`g.hairpin`/`g.tempo` is the one thing it does NOT write: it
records `data-hkl-ishift` and lets `render/textlayout.ts` re-run and compose
`translate(dx, dy + ish)`. The alternative — instrgap composing the mark's
transform itself — was rejected: textlayout re-runs on every shifted system
anyway (it must, to release its own `INSTR_CLEAR` clamp), and two passes both
writing one attribute is how the idempotency bookkeeping (`data-hkl-vshift`
against `data-hkl-ishift`) gets ambiguous. Single ownership per attribute is
worth an extra rule.

The rule that ownership costs, and that was missing until the marks came out a
whole shift low (lessons.md "A deferred transform must be MEASURED in the frame
it will be written in"): **a pass that defers a transform must publish the frame
it deferred, and every consumer must measure in it.** Concretely — textlayout
measures a tagged mark through `markBox` (bbox + `ish`), not `svgBox`, because
its staff rows already read post-shift; instrgap's `resetSystem` subtracts its
own term back out of a mark's transform as well as a staff's, so a re-run
measures one consistent pre-shift frame; and the tag is read with `parseFloat`
everywhere (at zoom 75 the device grid is 40/3 user units, so it is fractional).

Also settled here: the sonata is not a fixture, so the class of defect it
exposes needs a synthetic shape. `engr_instrGapCenteredDynamic` is a
single-staff instrument ABOVE a grand staff — instrgap only ever shifts
instruments BELOW a boundary, so an upper grand staff cannot exercise the
composition at all — and it asserts the PREMISE (a shift actually happened)
alongside the conclusion, so it can never pass vacuously if the demand
heuristics change. This discharges part of the "fixtures are still owed" note
in the preceding entry; the pagination defect remains open and unfixtured.

## Same-moment marks are separated on the render clone, by `@tstamp` (2026-09-09)

`notation/unstack.ts` nudges each same-moment `<dir>` a quarter beat past its
`<dynam>` anchor **on the serialize clone**, so Verovio engraves the group as
one row and sizes the inter-staff gap for one row. The DOM rule in
`render/textlayout.ts` that used to own this (2026-09-08) is kept as the
fallback for groups with no room left in their measure.

Why the clone and not the document: the nudge decouples the rendered anchor
from the musical one. Nothing downstream of engraving depends on a `<dir>`'s
tstamp — playback reads `<dynam>`/`<hairpin>` off the LIVE doc and `<dir>` has
no playback role — and the saved document is never this clone. It is the same
liberty the importer takes with `<offset>`. Fixture
`engr_sameMomentDynamAndDirSideBySide` asserts the document keeps both marks on
one tstamp and that the clone-only tag never leaks into it.

Rejected, all measured (lessons.md has the table): `@ho`, which Verovio honours
as a pure draw-time offset and which therefore leaves the reserved row behind;
`@vgrp`, which did nothing whatsoever; and merging the pair into a single
`<dynam>`, which does reserve one row but returns a 1910-unit-tall bbox that
would corrupt every downstream measurement.

`NUDGE_BEATS` is 0.25, not 0.5: both break Verovio's row reservation
identically (sonata gaps 1240 / 1800 / 1800 either way), but 0.5 overshoots far
enough that textlayout's clearance fine-tune has to drag the mark back up to
781 user units, and the measure was engraved wide enough to hold it there. The
nudge only has to defeat the overlap; the exact clearance is set afterwards.

The clearance itself stays in the DOM (`UNSTACK_GAP`, one staff space) because
x is not knowable before the engrave. It replaces `PAD` (a quarter space, 4 px
at scale 100), which Max reported as too tight on m. 99's `p dim.`. Since the
nudge means the pair no longer shares a tstamp, each mover names its anchor in
`hkl-unstack` → `data-hkl-unstack`.

One consequence worth remembering: separated marks are no longer ONE cluster,
so textlayout's vertical rules reach them independently — the dynamic keeps
`dynamDist` while a now-lone `<dir>` goes to the `dirGapUser` line, and those
lines differ by the glyph-vs-text box metrics (7.4 px in the fixture, not even
overlapping). A final step in `layoutSystem` puts each mover's centre back on
its anchor's, which is what the cluster rule did when it owned the separation.

## The instrgap `ENABLED` flag is gone (2026-09-09)

`render/instrgap.ts` shipped behind `const ENABLED = true` because a grown
system pushed the sonata's tail past the last page div — page 31 empty, 442 of
446 measures rendered — page divs being Verovio's castoff at `loadData`, which
predates anything the pass grows. That is fixed: pagination is owned, and
`cb-pagegrowth.js` now reports paginationOwned with 446/446 measures, 113
systems, 31 page divs, no empty pages and a 16-step cascade resolved entirely
arithmetically. The flag and its early bail are removed; the pass is
unconditional.

Re-measured at the same time, since the centring fix and the same-moment
separation both moved marks the census counts: marks nearer the other
instrument than their own staff 59 → 29 (the entry above said 28), within one
space of the other instrument's ink 33 → 12, systems with unmet demand 48 → 11,
43 systems shifted, none bailing on an unattributable element.

Still owed, and now the only thing standing between this pass and "done": no
FIXTURE asserts that every measure of a multi-page document renders.
`cb-pagegrowth.js` is a probe, so nothing in `pnpm test:composer` would catch a
regression of the original defect.

## Score-global tempo, restated per part on the render clone (2026-09-09)

Backlog Layout: "Tempo markings need to be duplicated between parts". The
observed asymmetry was in the imported sonata — a "rit." appears above the
viola AND the piano, "Poco più mosso" only above the viola — and it is an
artifact of two import paths, not a decision: Finale writes a tempo
`<direction>` into every part, so a bare `<words>` "rit." becomes a per-part
`<dir>` while a direction carrying `<metronome>`/`<sound tempo>` collapses to
ONE `<tempo staff="1">` (importMusicXml's `seenTempi`).

The copies are made on the RENDER CLONE (`notation/parts.ts`
`duplicateTempiAcrossParts`), not in the model. The model's `<tempo>` is
score-global by design — one element per moment is what makes the tempo layer a
single cursor stop, what `tempoAt` edits, what Backspace deletes, and what
`buildTempoTimeline` reads — and every one of those would need a "which copy is
canonical" rule if the duplication were real. Nothing downstream of the model
learns about the copies; the saved `.hkc` and the MusicXML export keep one
marking (export writes it into the first part only, as before).

Two placement details are load-bearing:

- It runs in `serialize`/`serializeRangeForRender` **before `filterToStaves`**,
  not in `applyRenderConventions` (which is after). Single-part view drops
  control events anchored to a hidden staff, so a view of the piano in a
  viola+piano score used to lose every tempo marking; the copy it now owns is
  what keeps it. This is the only render-clone convention that runs outside
  `applyRenderConventions`, and the reason is exactly this ordering.
- A text-less `<tempo>` is neither copied nor allowed to occupy its moment. The
  document's head tempo (`ComposerModel.setTempo`) is a playback-only
  `<tempo tstamp="1" staff="1">` carrying `@mm`/`@midi.bpm` and no content, and
  `@mm` alone renders nothing in this Verovio build. Copying it drew invisible
  zero-height groups, and — worse — it shadowed a real marking written on beat
  1 of measure 1, because the moment was already "covered" by the time the
  visible mark was considered.

Copy ids are the source id plus `-p<staffN>`: a FOURTH id segment, which
`newId`'s three-segment `prefix-<b36>-<b36>` form cannot produce, so a copy id
is always distinguishable from a real one. `selectLayerElementById` still tries
the literal id FIRST and only then strips the suffix — a genuine `newId` random
segment can be the string `p3` — so clicking a restated marking selects the one
model element. Ids are derived, not generated, which keeps a range sub-render
byte-identical to the full render.

Rejected: restating only at the top of each instrumental family (the orchestral
convention). HKL Composer's scores are chamber-sized, every part gets a copy,
and a family model would need instrument taxonomy the score does not carry.

## Fermatas are pinned outside the grand staff (2026-09-09)

Backlog Layout: "Fermata should default to the outside on a grand staff".
Verovio places a fermata above the note's OWN staff regardless of layer (probed
on the default piano, all four voices: every fermata above its staff), so on a
grand staff the lower staff's fermata lands in the inter-staff gap — staff 2's
at y 451–471 between a staff 1 ending at 433 and a staff 2 starting at 488.

`notation/parts.ts` `settleFermataSides` (in `applyRenderConventions`) writes
`@place="above"` on an instrument's top staff and `@place="below"` on its
bottom one, so the pair reads outside the brace. Verovio derives the inverted
glyph (E4C1) from `place="below"` on its own — no `@form` is written.

Scope limits, all deliberate: single-staff instruments keep Verovio's default
(there is no gap to fall into); the MIDDLE staff of a three-staff instrument is
left alone (both sides of it are "between", so neither answer is the
convention, and a three-manual organ is not a case the score model has been
exercised on); and an explicit `@place` always wins, so a future above/below
control — `Ctrl+↑`/`Ctrl+↓` excludes fermatas today — needs no change here. The
side is decided on the render clone rather than at creation time so it tracks
instrument edits (a staff added to a part re-decides its fermatas for free) and
so imports get it without an importer rule.

## MusicXML export writes every tempo, into every part (2026-09-09)

Follow-on to the render-clone restatement above: Max asked for the export to
match. It did not — and the gap was bigger than "one part vs all". The exporter
read `model.getTempo()`, which is `doc.querySelector("tempo")`, i.e. the
document's FIRST `<tempo>`, and emitted it once, in the first part, at measure
1. Every mid-piece marking was dropped; on the sonata that is 17 of 18. Worse,
`getTempo()` is positional, so a score whose only tempo is a mid-piece one
exported that marking as if it sat at bar 1.

`exportMusicXml` now indexes `collectTempi(doc)` by measure and emits each mark
in EVERY part. Choices worth keeping:

- **Directions at the measure head with an `<offset>`** in divisions, rather
  than interleaved into the note stream at the right tick. The importer has
  read `<offset>` since 2026-09-08, so it round-trips, and emitting at the head
  keeps the exporter's one-pass-per-voice structure intact (Finale writes the
  mirror image — at the measure END with a negative offset).
- **`<metronome>` only when the mark shows one**, `<sound tempo>` whenever
  there is a bpm. The old code always wrote a metronome, so the seed
  document's tempo — which HKL draws as bare text, its `@mm` invisible —
  exported a ♩=N that was never on screen, and re-importing turned `showMm`
  on. Now the export matches the page and a DAW still gets the tempo.
- **A text-less mark becomes a bare `<sound tempo>`**, not a direction: an
  empty `<direction-type>` is invalid MusicXML, and a bare measure-level
  `<sound>` is exactly Finale's hidden-tempo encoding, which the importer
  already recognises.
- **Gradual rit./accel. and "a tempo" export as italic `<words>` with no tempo
  value.** MusicXML has no gradual-tempo element; italic words are what Finale
  writes. They re-import as per-part `<dir>` expressive text — visually
  identical, but the gradual playback semantics are lost. Accepted: `.hkc` is
  the lossless format, and the alternative (a private attribute Finale would
  ignore) buys round-trip fidelity only against ourselves.

`ComposerModel.setTempo` had no callers before this and `getTempo()` now has
none either; both are left in place rather than removed in a change about
export.

## MusicXML export brought to parity (2026-09-09)

Max: "address as many export issues as possible… iterate until we hit parity."
The audit below listed what was missing; this is what closing it taught.

**Measure, then fix.** Three probes drove every step and each disproved a
plausible reading of the code:
`phasec/cb-xmlexport.js` (feature counts, model vs XML),
`phasec/cb-xmldur.js` (every measure of every part sums to its budget in every
voice; no dangling spanner endpoints), and `phasec/cb-xmlroundtrip.js` (export
→ re-import → compare the model against itself). The round-trip probe is the
one that matters: element counts prove the XML CONTAINS the music, only a
re-import proves a reader can rebuild it. Four of the five hard bugs below were
invisible to counting and showed up only as a round-trip delta. Several probe
"failures" were also probe bugs — a counter that subtracted the wrong subset,
a model-side query that double-counted — so a surprising row got the counter
re-read before the code did.

**The five structural fixes**, none of them a missing emitter:

1. *Beamed tuplets dropped whole.* The tuplet branch filtered the tuplet's
   children for note/chord/rest while `regroupBeams` had put the members inside
   a `<beam>` child. 500 of 513 tuplets, 1 453 of 9 099 notes, plus 6 in an
   `<fTrem>` — an exact 1 459-note shortfall that the XML gave no sign of.
2. *Pickups padded to full bars.* The trailing-rest fill used `meter.count`;
   the measure's own budget lives in `model.measureTicksAt`.
3. *Ottava pitches an octave off.* MEI stores WRITTEN pitch under an
   `<octave>`; MusicXML `<pitch>` is SOUNDING with `<octave-shift>` describing
   the printing. The two conventions are inverses and nothing in the code said
   so — a re-import shifted a second time.
4. *Directions must sit in the note stream, not at the measure head.*
   `<offset>` is advisory; our own importer ignores it for `<octave-shift>`
   because that span's STREAM position decides which notes get rewritten. A
   head-parked ottava contained in one measure therefore spanned nothing and
   was dropped. Directions now ride in the first voice of their staff with
   content, carrying a residual offset (negative where the anchor falls between
   onsets — MusicXML allows it and Finale writes them).
5. *Slur numbers belong to document order, not musical time.* A measure is
   written one voice at a time separated by `<backup>`, so a slur ending late
   in voice 3 is emitted after one starting early in voice 1; a reader pairing
   numbered spanners in document order saw a number opened twice. An
   intermediate fix — block a number for the whole measure it ends in — cured
   those four slurs and then ran the pool past MusicXML's limit of 6, where it
   wrapped and lost two others. Ordering by (measure, voice-index-in-part,
   tick) is the honest fix; the wrap is now unreachable in practice.

Late additions once the round-trip was clean, each a plain omission the
coverage probe did not think to ask about until the model was re-read for
what else it carries: the cut / common meter SYMBOL (`meter.sym` — the sonata
is in cut time and exported as a plain 2/2), `<part-abbreviation>` from a
group's `<labelAbbr>`, and manual `<pb>` / `<sb>` breaks as `<print>`. The
lesson is that a coverage table only measures the rows someone wrote: the
model's own element vocabulary is the checklist, not the probe.

Smaller corrections: `<note>` children were out of DTD order (`<dot>` before
`<type>`, `<staff>` before `<notehead>`); a tuplet beginning or ending on a
rest got no bracket tag; an empty voice was written as a measure-long rest
instead of omitted; a part silent for a whole measure now writes one
`<rest measure="yes">` so its timeline cannot drift.

**Accepted losses.** `<space>` re-imports as `<rest visible="false">` — both
are invisible time and MusicXML has one encoding (`<forward>`) for them, so 20
of the sonata's come back in the other form; the round-trip is otherwise
identical. A section's movement TITLE is left alone — see the entry below.
Grace notes are absent because the model has none.
HEJI commas stay unrepresentable (W3C #263). Gradual rit./accel. still export
as italic words — see the entry above.

## Movement titles stay out of the MusicXML bridge (2026-09-09)

Claimed, wrongly, that no MusicXML element carries a movement title mid-score.
Finale does write them, as page-level credits — the sonata holds
`<credit page="10"><credit-words … font-size="20.4" halign="center">II</credit-words>`
for each of II / III / IV, plus a `<movement-title>`, a composer credit, and a
page-number and running-title credit for each of its 33 pages.

We neither read nor write them, and that is deliberate. A `<credit>` is
anchored to a PAGE and to absolute coordinates, with no link to a measure, so
using one means (a) mapping source pages to measures — possible, the sonata
has 64 `new-page="yes"` prints — and then (b) telling a movement title from a
running header or a page number by font size, position and repetition. Max,
asked: "This is not worth fragile heuristics."

Nothing is actually lost for an imported score. The importer SYNTHESIZES the
numeral from the structure (a mid-piece `light-heavy` barline starts a section,
titled with the next Roman numeral), so the sonata's II / III / IV come out
right — our convention and Finale's numbering agree, which is exactly why the
gap went unnoticed. Only a title typed by hand via `Ctrl+Shift+H` is replaced
by its numeral on a round-trip.

Worth remembering as a method point: the round-trip census reported
`sectionTitles` 3 → 3 with no delta, and that was true — the titles are
regenerated, not carried. A derived value passing a round-trip proves the
derivation is stable, not that the data survived.

## MusicXML export coverage is audited, not assumed (2026-09-09)

Asked what else the exporter loses, the answer came from measurement rather
than reading: `test/composer-inspect/phasec/cb-xmlexport.js` imports the
sonata, exports it, and counts every model feature against the corresponding
MusicXML element. Keep using it — the first hypothesis it disproved was mine
(that beamed tuplets were being dropped because `contentChildren` does not
flatten `<beam>` into `<tuplet>`; in fact zero tuplets sit inside a beam — it
is the reverse nesting that breaks).

The real defect: `gatherEventsFromDoc`'s tuplet branch filters the tuplet's
CHILDREN for note/chord/rest, and `regroupBeams` puts the members of a beamed
tuplet inside a `<beam>` child — so such a tuplet yields no events at all.
That is 500 of the sonata's 513 tuplets and 1 453 of its 9 099 notes; a further
6 notes sit in an `<fTrem>` that `contentChildren` also skips, for an exact
1 459-note shortfall. Second defect: the per-voice trailing-rest fill pads every
measure to `meter.count`, so a pickup exports as a full bar with no
`implicit="yes"`. Both are silent — the XML is well-formed and opens fine.

Everything else missing is plain omission (slurs, articulations, dynamics,
hairpins, expressive text, fermatas, trills, tremolos, ottavas, diamond
noteheads, repeat barlines, double bars, voltas, section headers). The counts
are in docs/architecture/composer.md under Save / load / export; re-run the
probe rather than trusting them after any exporter change.

## Empty-cell flags: hide empty staves + multimeasure rests (2026-09-11)

Two Finale-parity features, one model. Decisions worth remembering:

- **Flags live on `<staff>` inside `<measure>`, as plain `data-hkl-*` attributes.**
  Considered `staff@visible="false"` (MEI-native): rejected — Verovio consumes
  it (barline flags for all-invisible measures) and its meaning is "hidden in
  this measure", which is stronger than "hide if the whole system is flagged".
  Both flags are per (measure, staff) because the command targets the
  selection's measure × staff rectangle; a multirest flag on one staff of a
  piano is inert (only a one-staff view collapses) and harmless.
- **Only empty cells may hold a flag, and content drops it in
  `normalizePlaceholders`.** That pass is the one every edit path already runs
  over every dirty layer, so no call site knows about flags; a layer `<clef>`
  counts as content.
- **One command, "fewest wins", tie → on.** `on <= off` sets every target ON.
  Max's spec: 10001 → 11111 → 00000. The selection is kept alive so the press
  cycles; Ctrl+H/Ctrl+M join Ctrl+8/Ctrl+R in the selection-mode fall-through.
- **Multirests collapse at RENDER time over a unit index, never in the model.**
  The spec makes collapse view-dependent (the same bars stay separate in the
  full score), so a model-level `<multiRest>` measure was never an option.
  The unit index (`renderUnits`) is the single source of truth and the
  serialize pass takes its runs — two computations would drift.
- **Runs break at every hard boundary** (scoreDef/sb/pb, ending edges, section
  starts, pickups, interior control events, `@left`/`@right`, `tstamp2`
  spanners) so line-break ownership stays truthful and a run is one rendered
  measure that can never straddle a system. A control event counts only when
  it concerns the staff — by `@staff`, or by the staff of its start/end note;
  the Sonata's piano slurs under viola rests were splitting every viola run
  until spanners were attributed through their notes (staff-less events with
  no notes, like a score-global tempo, still break).
- **Cursor skipping lives in the input layer**, not the flat index: `moveCursor`,
  `flatChildren`, `shouldEmitWrapper` are untouched, so bridge payloads and the
  model/roundtrip fixtures are unaffected; only wrapper stops are ever skipped.
- **Splicing works on day one** (Max's call, over a "derive first" proposal):
  range serialize snaps to unit edges, interior naturals are 0, repartition and
  balancing move whole units. The one remaining derive is the scroll splicer
  for a one-staff DOCUMENT with an active run (part views never spliced in
  scroll view anyway).
- **Hidden staves: Verovio's optimizer rejected, per-system substitution
  instead.** Read from source: `Score::ScoreDefNeedsOptimization` (none / @optimize
  / >1 grpSym heuristic) and `ScoreDefOptimizeFunctor::VisitStaff` (a staffDef
  shows iff some staff on the system has a `<note>`, or a clef change, or —
  with `condenseTempoPages` — the measure has a tempo/fermata, which FORCES
  visibility). It cannot honour a per-region flag; invisible-clef/note hacks
  were rejected as fragile. `condense` is now pinned `'none'` — its `auto`
  default would have started hiding rest-only staves the day a scoreDef grew a
  second group symbol. Composer re-renders a hidden-set system alone with the
  single-part filter minus the hidden staves (the splicer's own window recipe)
  and swaps it in before placement — including for systems the page splicer
  imports, which is simpler than splitting the splice window per hidden set
  (the plan's first idea) and costs one extra small render only when a window
  touches such a system.
- **Toggles are ordinary edits.** The flag changes the measure's serialized
  signature, so the refill/splicer re-flows the touched lines like a note
  edit; no forced derive, and the SPLICE invariant keeps it honest.
- **Deleting a multirest** removes the whole run only when every member is
  empty on every staff (a part view's other parts may have content); a
  measure-selection Delete keeps its clear-only semantics (Max: run delete
  only).
- **MusicXML**: Finale's `staff-details print-object` ranges and
  `multiple-rest` are read onto empty cells and written back; the Sonata's
  m95–103 piano hide region arrives pre-flagged.
- Insert-measure moved from Ctrl+M to plain **M**; Ctrl+H (Firefox history
  sidebar) is page-cancelable like Ctrl+R — Max verifies in Firefox.


## Beat selection over empty space draws at the cursor's edge (2026-09-11)

**Symptom** (Max, hands-on): Shift+←/→ "reports that a selection was
completed, but no box appears and the cursor is also invisible." The cursor is
hidden in select mode by design; the selection overlay was computing zero
rects, and `setStateAfterSelectionChange` prints the `Sel:` status before any
drawing is attempted. Reproduced headlessly on the default empty document, an
imported `<mRest>`, voice 2 of an empty bar, an empty M2 after a full M1, and
Shift+→ from the end of two entered quarters (the empty remainder of the bar).
Shift+← from the same spot worked, because it selects the note.

**Cause**: `<space>` placeholders and `<mRest>` are not cursor stops, so a
content-free beat has no elements between its boundary cursors and the overlay's
content scan (`selectionMeasureRange`) returned null. Measure mode has no such
scan, hence the asymmetry.

**Choices**:
- **Fall back to the boundary ticks' measures**, not the boundary cursors'
  `getFlatStopInfo` measures: a cursor past the last note of Mₖ carries
  measureIdx k while its tick is Mₖ₊₁'s start; ticks give the span the user
  means. The content scan stays primary (it disambiguates wrapper-collapsed
  starts for free); the fallback only fires when the scan finds nothing.
- **Empty-region x anchor = flat[c]'s right edge**, mirroring the voice
  cursor's `elementRight`, so the box edge sits where the cursor was. Verovio
  renders a placeholder as a `g.space` with an empty bbox, so it cannot anchor
  anything; linear interpolation by ticks was rejected as false precision
  (Verovio's spacing is not linear in duration). Side effect, deliberate: a
  last-note beat no longer stretches over the trailing placeholders — it hugs
  the note, and the empty-remainder beat begins exactly where it ends.
- **Staff-height y for empty beats** (the existing `staffYRangeForMeasure`
  fallback), not a synthetic note-height band: there is no note to hug.
- **Not changed**: beat boundaries inside an empty region. Placeholders emit no
  interior boundaries, so the remainder after two quarters is one "beat" (the
  status says `1 beat` for two beats of time). Cut/delete over it clears the
  remainder, which is empty — harmless; a finer grid would mean making
  placeholders stops or synthesising boundaries, a cursor-semantics change left
  for Max to call.
- **Fixture gate**: every new fixture asserts the rect COUNT and geometry, not
  just `state.selection` — none of the prior `sel_*` fixtures started from an
  empty beat or checked that a rect existed, which is how this shipped.

## Lazy page mounts go through a visible-first pump with a fast-scroll gate (2026-09-11)

**Decision.** In page view the IntersectionObserver (root `#score`, ±100 %
margin) no longer mounts pages; it wakes `pumpMounts`, which runs once per
animation frame and mounts ONE page that intersects the viewport (nearest the
viewport top first). Pages that are only inside the band go to the idle mount
window (`updateMountWindow`), which now mounts one page per idle slice and
reschedules itself. Pages that have left the band are dropped. Neither
consumer mounts while `viewportMoving()`: the container's `scroll` events are
sampled, and "moving" means the newest sample is younger than
`PUMP_SETTLE_MS` (120) and the view travelled more than `PUMP_FAST_VH` (0.5)
viewports over `PUMP_VELOCITY_MS` (400). Render/restore-time
`mountVisiblePages` and the cursor path's `ensureMeasureMounted` stay
synchronous. The toolkit warm is re-armed after the paint-time pagination
repair and at balance completion (`rearmWarmIfStaleUnmounted`).

**Why.** Measured on the sonata (Chromium): the callback-mounts design drew
the off-screen neighbour before the visible page on a jump (294 ms to the
visible page) and, on a scrollbar drag, mounted every page swept through the
band ahead of the landing page (15 mounts, 2.75 s), then evicted them. A
first mount past page 14 also paid a 784 ms stale reload. With the pump: jump
136 ms, drag ~410 ms / 1 mount, zero `loadData` on scroll.

**Alternatives rejected.** (a) Mount ALL visible pages synchronously in the
pump — at zoom 50 a viewport shows 4–6 pages, i.e. a 0.6–0.9 s block with
nothing painted; one per frame paints progressively and costs a 16 ms frame
per extra page. (b) A plain scroll debounce before any mount — adds its whole
delay to every single jump (PageDown, scroll-into-view); the displacement
rule mounts a lone jump on the very next frame and only holds back while
there is travel. (c) Velocity from the pump's own frames — see lessons.md
("sample scroll velocity from the scroll event"). (d) Attacking the ~150 ms
per-mount cost first — of it, only Verovio's 30–50 ms is avoidable (the SVG
string the extents job already renders offscreen could be kept); the first
layout of the SVG (30–60 ms) is inherent to mounting into the live DOM, and
the scheduler removes 85–95 % of the wait by itself. Deferred.

**Constants.** `PUMP_FAST_VH` 0.5: a wheel notch is ~0.1 viewport, a PageDown
~0.9 in one frame (registers as travel for one frame, then mounts), a
scrollbar drag many viewports per frame. `PUMP_VELOCITY_MS` 400 keeps a slow
flick (~1500 px/s) in the gate until it stops. `PUMP_SETTLE_MS` 120 is the
latency a drag's landing page pays after the thumb stops — below the ~150 ms
mount that follows it.

## Manual line breaks are a plain `<sb>` plus a partition edit — never a derive (2026-09-11)

*(Revised the next day — the pull directive, the forced atom and the kept over-tight line described below were removed; see "Locks reflow like any measure-count change" (2026-09-12). The `<sb>`-as-lock, the partition-edit path, pin-removed-only unlock and the layout snapshots stand.)*

**Decision.** A forced line break ("lock", Alt+Shift+↓ / Alt+Shift+↑, backlog
Composer → Features) is a plain `<sb>` before the measure the break precedes
— no new attribute, no MEI `<section>` split. The page line-break owner
already treats any section-level `<sb>`/`<pb>` as a hard start and a
reflow-section boundary (`hardStartIds`, `sectionRanges`, the repair loop,
`injectPins`), the `.hkc` is the raw doc, and the MusicXML exporter already
writes `<print new-system="yes"/>` for it — so the model side is two methods
(`setLineLockAt`, `hardBreakBefore`; a section header's `<sb data-hkl-section>`
is distinguished by its attribute). What did NOT exist is the render path: a
user-break change made `tryRefill` bail to a derive, and a derive lets
Verovio's castoff re-decide every line of the document. For a command whose
whole point is one local move that is exactly wrong, so the sig now encodes
`lock:` entries separately from `sb:`/`pb:` and a `lock:`-only diff is a
`repartition` edit: split at added locks, then the ordinary conservative
repair + section balance. An unlock is pin-removed-only (Max): the partition
stays, the boundary is merely soft again, the render is a signature no-op.

**Why a directive for the pull.** `[a..m]` joining the previous system means
the SOFT start at `a` disappears, which no document element expresses, so the
command hands the owner a `BreakDirective { unbreakAt, forceGroup }` consumed
by the next refill (dropped, logged, if that render derives). `forceGroup` is
the previous system's last unit plus the pulled measures: Max's rule is that
the pulled measures never flow back down — when the merged line is over
FIT_MAX the forced section is reflowed around that fused atom
(`balance.ts forceSection`: same line count, then one more, λ-penalised), and
when no legal reflow exists the over-tight line is KEPT. Alternatives
rejected: pushing the overflow back down before the new lock (the repair
loop's default — it partially undoes the command), refusing (makes the
command useless exactly when the previous line is full).

**Why layout snapshots ride on history entries.** Content edits are
reversible because the repair is conservative; a deliberate partition move
is not — an undone push would leave the measures where the command put them
with no lock left to click (a drift with no handle). The command captures the
owned partition before mutating (`LayoutSnapshot`, keyed on the renderer's
layout inputs incl. the break structure) and records the settled one after
the render; undo/redo restore them through `replacePartition` (re-baseline
WITHOUT `invalidate`, so no natural is re-measured) + a partition-only
splice. A zoom/page-scale change in between makes the key miss and the
ordinary refill decides — logged, not silent.

**Semantics fixed with Max.** Push at a system start locks the existing
boundary (nothing moves). Pull is refused across a section start or a page
break and on the first system; an existing lock at the pulled system's start
is dissolved by the pull. A pull that would not change the document (nothing
after m to lock, no lock at a to drop) is refused rather than performed
unpersistably. The padlock (`render/lockmarks.ts`) is a draw-only child of
`g.page-margin` like the section titles, redrawn by every placement and after
every splice, and by `syncLockMarks` after the no-op render an unlock makes.

## Locks reflow like any measure-count change — no layout state the document cannot reproduce (2026-09-12)

**Decision.** Max reversed the pull semantics fixed the day before: the
`BreakDirective` (dissolve the soft start the pull crosses; keep the pulled
measures on one line with the previous system; keep the merged line even
when over FIT_MAX) is gone, and so is the idea of a manual reflow command. A
lock is a plain `<sb>` in the document and NOTHING else. Alt+Shift+↓ locks the
break before the cursor measure, Alt+Shift+↑ the break after it (removing a
lock at the system's start, since the user wants those measures to join what
precedes); the owner splits the line at the lock and the ordinary
carry/repair/section-balance decides everything else, exactly as for a
measure insert — the merge rule folds a sparse remainder into the previous
system when the merged line stays ≤ MERGE_MAX, the DP rebalances the section
otherwise, and a remainder that is already a legal line stays put.

**Why.** The directive produced layouts the document could not express: an
over-tight line held only by the partition's memory, and a joined system
that castoff would not reproduce. Both silently revert on the next reload
(and the tight line on the next edit touching it) — a transient state that
undoes itself, which Max ruled out outright: "we must keep it fully
deterministic". A full derive is NOT required to satisfy that: the refill
path is deterministic given the document and the current partition, and it
is the same path every content edit already takes.

**Consequences.** The pull is weaker than the backlog wording ("move the
current and preceding measures to the previous system"): it guarantees the
lock, and the join only when the balancer agrees. `forceSection`
(balance.ts) and `balanceSectionForced` (linebreaks.ts) were removed rather
than left as dead code. The layout snapshots on history entries stay — they
carry no post-reload state, they only make undo exact.

## Alt+Shift+↑ dropped: a lock says where a break must be, never where one must not be (2026-09-12)

**Decision.** The backlog's second command ("move the current and preceding
measures to the previous system") is not offered. Under the ruling above it
had become exactly Alt+Shift+↓ on the following measure plus an unlock click
— its only distinct content was removing a lock at the system's start. The
guide tells users to lock the break after the measures they want moved up.

**Why.** "Join the previous system" means "no break at a", and no document
element can say that; anything ↑ did beyond ↓ was partition-only state. The
alternative — a persisted "keep with previous" marker that the balancer
treats as an atom and the derive path must also honour (Verovio has no such
thing) — is a second break type with its own reflow semantics, not a tweak.
Not worth it for what is a cursor-placement convenience. Recorded so the
backlog wording is not re-implemented as written.

## The partition cache carries the owner's width caches (2026-09-12)

**Decision.** A cache-hit restore (`Renderer.derivePageRender` → `restorePartition`)
now passes the entry's `OwnerWidths` (naturals + leading-signature widths)
back into the owner instead of leaving them empty after `invalidate()`.

**Why.** Max's contract: zoom is a visual-only change and must not alter
what the model or the owner knows. A zoom round-trip kept the lines but lost
the widths, so from then on the edit-path balancer — which refuses to work on
partial data by design — silently declined every section-final defect
(seen as an orphaned bar after a manual line break at 50 % zoom). The widths
are zoom- and page-scale-independent (measured identical), so restoring them
is exact; only the budget is re-measured. Rejected: re-arming the idle warm
job after a cache hit (leaves a window in which edits still see partial data
— non-deterministic), and warming synchronously (makes every zoom change pay
a full-document measure).

## Perceptual-onset trim replaces the amplitude gate for decay instruments (2026-09-12)

**Context**: Max's live-play program (lag / inconsistent onsets / inconsistent loudness on the Korg SP-250 5-layer `.hki`). A whole-instrument audit of the 144 samples (K-weighting + Bark-sones from `@hkl/analysis`, engine trim gate + house curve reproduced in Node) showed the engine started playback 10–50 ms BEFORE the perceptual strike: median time from start to −12 dB rel. the attack peak was 11 / 13.5 / 22 / 29 / 30 ms for the v24…v120 layers, cross-note spread within a layer up to 47 ms, within-note spread with velocity up to 36 ms (A3: 13 → 49 ms). Cause: every sample carries a low-level pre-strike segment (~−23 dB rel. peak, harmonic to the note, ramping into the strike, longer at higher velocity, absent above F#7) and the fixed gate `TRIM_GATE_NORM = 0.02` on the gain-normalized signal tripped on it. The orchestrator's Wiener NR was ruled out as the source (a synthetic tone burst through `wiener.ts` pre-echoes ≤15 ms at −40 dB); the leading, unverified inference is the Korg's own velocity-dependent sample start offset exposing the sampled pre-strike.

**Picked**: `findPerceptualOnset(data, sr, gain)` in `samples-engine.ts`, run at load in the decay-instrument trim block (manifest `trimStart` stays ignored for decays, as before). 2 ms RMS envelope, 0.5 ms hop, from the first −54 dBFS crossing over 400 ms; attack peak = envelope max; start = first hop reaching **peak −9 dB**, backed off 1 ms, never before the low gate. Thresholds are relative to the sample's own attack peak, so they hold for RMS-normalized sets (peaks vary ~10 dB) as well as peak-limited ones. The plateau tops out at −12…−15 dB rel. peak just before the strike and the strike climbs −12 → −6 dB in ~1.5 ms, so −9 dB sits on the steep part with margin. The existing 4 ms attack fade covers the start step.

**Rejected**: raising the fixed gate (no absolute level separates a −23…−12 dB plateau from the strike across sets with different crest factors); baking an onset field at HKLO export (needs a re-export, and doesn't fix CDN piano sets — can still be added later as a manifest override); a slope-based knee detector (more parameters, no measured need).

**Verified**: re-running the audit's onset columns from the new start over all 144 WAVs: time to −12 dB = 1.0–2.0 ms at every layer (spread 1.0 ms), shift vs the old gate median 9 / 13 / 20 / 29 / 29 ms, no start before the low gate, top notes already tight move ≤1.3 ms. `test/engine-smoke` fixture (synthetic plateau at gain 2× and 60×, pre-cut parity, silence guards) + `pnpm typecheck` + `pnpm --filter @hkl/hkl build` + `pnpm check:boundaries`. By-ear on the Lumatone is Max's gate. Loudness work (peak-ceiling normalization, sones monotonicity) deliberately deferred until the onset change is heard in isolation.

**Addendum (same day)**: Max confirmed the timing improvement but heard **occasional clicks on onsets**. Cause: a latent race the old gate masked — `sNoteOn` schedules `source.start(startT)` and the 4 ms `segGain` ramp at the same `startT` with only a 5 ms lead for decay instruments; when the render thread has already passed `startT`, the source is clamped to start "now" from the trim point while the automation ramp has already (partly) elapsed, so the first samples play at (near) full gain. At −34 dBFS that step was inaudible; at the perceptual onset (−25…−7 dB rel. peak) it clicks. **Picked**: bake a 3 ms raised-cosine fade into the decoded PCM from the onset at load (`bakeOnsetFade`, exported + smoke-tested), keeping the automation ramp; the PCM fade starts from zero regardless of when the source actually starts, and the combined attack stays under the ~5 ms softening line. **Rejected**: lengthening the lead (adds latency — the whole point of the change), lengthening the automation ramp (still mistimed under a clamp), observing the clamp from JS (Web Audio exposes no actual-start time).

**Where**: `packages/engine/src/samples-engine.ts` (`findPerceptualOnset`, `bakeOnsetFade`, `ONSET_*` constants, trim block in `loadInstrument`), `test/engine-smoke/index.mjs`, `docs/architecture/engine.md`.

## Perceptual re-gain of layered decay bundles — equal-sones layers, no level cap (2026-09-12)

**Context**: Second half of the live-play program after the onset fix. The Korg SP-250 audit showed the flat −18 dBFS normalization never applied: `computeGain`'s −3 dBFS peak ceiling bound on 127/144 samples, so baked integrated loudness followed crest factor (−14.6…−25.4 LUFS; C6 4–6 dB low at every layer, A6 3–5 dB high, ±3 dB on F#2/A2/C3/D#5/F#5), adjacent midrange notes alternated by up to 40 % in Bark-sones, and the brighter layers read as loudness tiers (+27/+21/+15/+2 % sones when crossing a layer boundary at the same input velocity). Max's targets: sones monotonic, the note-to-note alternation eliminated, register tilt second.

**Picked**: a post-export CLI, `apps/analyzer/cli/hki-regain.mjs`, that rewrites only the manifest `gain` values (audio untouched) from a Bark-sones measurement over 400 ms from the engine's own perceptual onset. Model: (1) within a note, every layer targets the note's geometric-mean sones × tier^`--layer-span`; (2) across notes, a Gaussian-weighted local linear fit of log-sones vs MIDI (σ 6 semitones) removes alternation and keeps the register curve, blended toward the set median by `--tilt`; (3) correction = `--strength` × 10·log₂(target/measured) dB (phon rule), boosts allowed. Four variants were graphed before anything was exported (Max's gate). **Max's rulings**: `--layer-span 0` — "the whole point is to eliminate gaps in perceived loudness between layers": with hard-switched layers the only continuous solution is equal baked sones, the house curve owns ALL loudness and layers carry only timbre; the played LUFS span shrinking from 17 to ≈8 dB (v24→v120) is a house-curve question, not a reason to keep layer jumps. `--tilt 0` (keep the register curve). **No level cap**: the −3 dBFS peak target is a normalization convention, not a limit (float graph, only the DAC clips, behind the −3 dBFS master limiter) — "I'd much rather have one layer of one note be limited at the very top of the range than have the note's RMS differ from others"; shifting the whole set to keep one boosted note under the limiter (6–13 dB depending on variant, always driven by C6) was rejected. The tool instead reports each layer's played peak at the top of its `pickLayer` zone; 9 samples (top-octave v120 layers, C6 v72) reach −1…−2.4 dBFS there.

**Rejected**: keeping the layer tiers smoothed (`--layer-span 1`; preserves dynamic range but keeps boundary steps); flattening the register (`--tilt 1`; up to +9 dB treble boosts, a character change); attenuation-only (can't fix the C6 hole); whole-set shift for the ceiling (see above); porting straight into HKLO `buildHki` before a by-ear pass.

**Verified**: exported `korg-sp-250-5layer-regain.hki` (all 144 gains changed, provenance carries the parameters) and re-audited with the same tooling: layer sones medians 77/79/84/86/87 (was 62/70/88/106/108); boundary sones steps 7/5/3/0 % (was 27/21/15/2); adjacent-note |Δsones| C3–C6 mean 6–7 %, max 13–21 % (was 13–14 %, max 40–44 % — the remainder is the kept register slope); played sones monotonic on all 30 notes (was 27); played LUFS now non-monotonic on F#5/C6/F#6 between v72 and v96 — the model's claim that the brighter layer is as loud at lower level, the specific thing to listen for. Calibration caveat: the lite model scales as gain^0.46 (≈13 dB/doubling) while the correction used the phon rule (10 dB), so re-measurement shows ≈24 % of each deviation as residual; `--strength` (0..1.5, 1.31 zeroes it under the model's exponent) is the ear-trim knob. `pnpm check:boundaries` green (the CLI imports `@hkl/engine`, `@hkl/analysis`, `@hkl/shared`, all declared). By-ear is Max's gate.

**Where**: `apps/analyzer/cli/hki-regain.mjs`; `docs/architecture/analyzer.md` (Gain normalization → Perceptual re-gain), `docs/architecture/orchestrator.md` (softening superseded note). Audit/plot tooling lives in the session scratchpad (audit.mjs, plot-loud.py, plot-options.py) — recreate from the analyzer.md description if needed.

## Layer-blend slider: level-match ↔ sones-match as one live knob (2026-09-13)

**Context**: Max played the equal-sones re-gain: "smoother and more consistent overall, but the inter-layer adjustments are too extreme, especially at the lowest 2 boundaries." Neither pure level (K-weighted) nor the lite Bark-sones model alone calibrates the hard layer switches to audible smoothness. Options laid out: (1) use the Korg's own raw inter-layer balance as the reference — rejected by Max: the Korg has no discrete layers, so we inherently need more smoothing at boundaries than the source does, and it would rock the whole pipeline for something that isn't a 1:1 match anyway; (2) calibrate the metric against the ear; (3) a time-varying loudness model — deferred.

**Picked (Max's design)**: option 2 as a single knob rather than per-layer adjustment, exposed as a slider in the live app next to the existing lumadiag velocity sliders, with limits = the level match and the current sones match. The bundle carries both endpoint gains (`gain` = sones-matched layers, `gainLevel` = level-matched layers, same cross-note reference so the slider isolates the inter-layer metric alone); the engine blends log-linearly (`blendedGain`, `setLayerBlend`) at note-on; the slider persists as `prefs.layerBlend` and is applied at `initAudio`. `hki-regain.mjs --bake-blend <t>` bakes the chosen value into `gain` alone afterwards. The level endpoint is K-weighted level over the SAME 400 ms attack window as the sones measurement — not the old bundle's gains, which were peak-limited and carried the note-to-note noise. On the SP-250 the two endpoints put the upper layer −4.0 / −2.5 / −2.0 / −0.2 dB apart at the four boundaries; Max expects the answer near the middle.

**Rejected**: per-boundary or per-layer sliders (too many knobs; the metric question is one parameter); the old bundle as the level endpoint (confounded by the peak limit); porting anything into HKLO before the setting is chosen.

**Verified**: engine-smoke fixture (`blendedGain` endpoints, geometric midpoint, missing/non-positive `gainLevel` fallbacks, setter clamps); `pnpm typecheck`, `pnpm check:boundaries`, `pnpm --filter @hkl/hkl build` green; the exported bundle carries `gainLevel` on all 144 samples. Slider rendering + the live setting are Max's by-ear pass on the Lumatone.

**Where**: `packages/engine/src/samples-engine.ts` (`gainLevel` on `SampleDef`, `layerBlend`, `setLayerBlend`/`getLayerBlend`/`blendedGain`, load + both note-on gain reads), `packages/shared/src/hki.ts` (`HkiSampleEntry.gainLevel`), `apps/hkl/src/audio/samples.ts` (pass-through), `apps/hkl/src/audio/engine.ts` (`initAudio` applies the pref), `apps/hkl/src/state/persistence.ts` (`layerBlend`), `apps/hkl/src/lumatone/lumadiag.ts` (slider), `apps/analyzer/cli/hki-regain.mjs` (level endpoint, `--bake-blend`), `test/engine-smoke/index.mjs`.

## The layer-blend slider stays — it's a control, not a calibration step (2026-09-13)

**Decision.** The inter-layer loudness-match blend (level ↔ Bark-sones) is a permanent, user-facing control. It is not a temporary instrument for picking one value to bake. Re-gained bundles keep carrying both `gain` and `gainLevel`, and HKLO's eventual port of the re-gain model into `buildHki` must emit both as well.

**Why.** Max, after playing it: "I want to keep the slider indefinitely. I can see use cases for the whole spectrum, and there's no reason to lock one in." The two endpoints aren't error bars around a single right answer — they are two defensible definitions of *equally loud* across a hard velocity-layer switch (equal energy vs equal critical-band loudness), and which one reads as smooth depends on the material, the register, and how hard the player is digging in. The previous entry's plan (choose a value by ear → `--bake-blend` → single gain) is superseded.

**Consequences.**
- `--bake-blend <t>` survives with a narrower role: collapsing the two gains for consumers that can't expose the blend (external `@hexkeylab/engine` embedders, `handoff/` bundles). It is no longer the endgame of the re-gain work.
- The blend is playback-side state and is deliberately **not** captured in `.hkr`: a recording stores coordinates + velocity, and the whole gain model (velocity curve, per-key gain, layer blend) is re-applied at playback under whatever is set then — same contract as the velocity calibration.
- `prefs.layerBlend` defaults to 1 (the sones endpoint, the model's own answer) for a profile that has never touched it; Max's own position persists across sessions.
- Placement stays the Calibrate Keys overlay beside the velocity sliders, per Max's request, even though it is an audio-engine setting rather than a Lumatone-specific one.

**Where**: `apps/analyzer/cli/hki-regain.mjs` (header), `packages/engine/src/samples-engine.ts` (`layerBlend` comment), `docs/architecture/analyzer.md`, `docs/guide/core.md`.


---

## The scroll splicer owns the SVG box, and adopts the system's vertical frame (2026-09-13)

**Context**: Live editing in scroll view was producing cut-off, malformed staves. Two independent defects, both original to the scroll splicer (checked every revision of `render/splice.ts` back to its introduction — neither behaviour was ever present and then lost).

**Defect 1 — the box never moved.** Verovio emits the root `<svg>` + nested `<svg class="definition-scale">` viewBox once, at full-engrave time, sized to the content; `pinExactScale` derives the root's px dims from that viewBox. The splicer edits measures *inside* the box and never touched it. Typing 13 bars from a blank doc measured a **345 px box over 29 477 user units of content** — and because the root element's own width stayed small, `#score` had **no scrollable extent at all**, so the content was unreachable, not merely clipped.

**Defect 2 — `dy` came from the ink bbox.** The fresh run was aligned on the anchor measure's `getBBox()`, on the stated assumption that the anchor is "an UNCHANGED measure present in both renders". But the anchor is `lo > 0 ? lo - 1 : 0`, so **editing bar 1 makes the anchor the edited measure**. Measured on a grand staff: a high note in bar 1 produced `dy = +267` where the true frame delta was `-885`, seating that bar 1152 user units (~115 px) below bars 2–4 while the brace (`g.grpSym`) and the system's left line (a bare `<path>`) — system-level children the splicer never imports — stayed with the untouched bars.

**Picked**:

1. **`render/scrollbox.ts` owns the box.** Box↔content offsets are *captured* at each full render (`padRight` measured at exactly 290 user units across every document size and zoom sampled) and the extent is maintained from O(1) measurements: one **last-measure** bbox per splice. Width is exact in both directions, so a delete shrinks the extent instead of ratcheting.

2. **Frame adoption, not frame pinning.** `dy` now comes from **staff-line geometry** (`staffFrameOf`), which is structural and content-independent, so it is correct even when the anchor measure is the edited one. When the sub-render seats its staves lower — the range now demands headroom the system lacks — **the sub-render's frame is the correct one**: the fresh run lands at `dy = 0` and every *other* direct child of `g.system` is migrated by `dyFrame`. Verified byte-identical to a full re-engrave (all bars at staff y 1365/2965, brace at 1385).

3. **Adoption is GROW-ONLY, and the asymmetry is load-bearing.** `dyFrame < 0` says the *range* wants less headroom, which says nothing about the *document* — the sub-render only ever sees `[cLo..cHi]`. The first implementation adopted both ways and was caught in development: a high note in bar 1 adopted correctly, then the very next edit (four notes appended at the end, a range with nothing tall in it) dragged all six bars back up 885 units and re-clipped the note. So a shallower sub frame loses and the fresh run is seated onto the persistent one. The frame only grows between full renders — always ≥ what every range needs, so nothing clips — and a full re-engrave reclaims the slack.

**Rejected**:

- **Re-measuring `g.system`.getBBox() per splice.** Correct and trivial, but it is O(document) geometry — precisely the cost the splicer exists to avoid.
- **Refusing the splice on a vertical frame change** (the first design proposed). Max's ruling: *a refusal is a failure, and a uniform displacement should not require re-rendering the whole score — it just needs to re-render what's on screen.* The y-cascade is the same cost class as the x-cascade that already runs (hundreds of `setAttribute` calls) against a ~3.8 s full engrave, and it self-heals: afterwards every measure shares the new frame, so the next edit computes `dyFrame = 0`.
- **Reconciling the brace and left line explicitly** (volta-bracket style). Unnecessary once `dy` is right: staff-line anchoring means the furniture is stale only when the frame moved, and the adoption walk covers it. The walk iterates `g.system`'s *direct children* rather than a list of known classes — that is what catches the left line (a bare `<path>`, no class at all) without naming it.

**Still refused — inter-staff spacing.** A high note in the *lower* staff of a grand staff changes the gap itself (probed: 1600 → 2165, top staff unmoved). No single translate repairs that: the staff-spanning verticals (barlines, brace, left line) must *lengthen*. One translate per staff row plus that lengthening is what `render/instrgap.ts` already does for page view, and reusing it is the follow-up. Until then the per-staff frame deltas are checked for agreement and a disagreement refuses, so the fall-through re-engrave draws it correctly rather than splicing a wrong gap.

**Residual, sub-pixel and understood**: splice vs full render differs by ~3 user units in width (content-level spacing: 18 977 vs 18 980) and ~5 in height (Verovio derives page height from its layout model, not the ink bbox). Both under half a device pixel at zoom 100. The box itself is exact — `rightSlack` is 290 in spliced and fully engraved states alike.

**Deliberate asymmetry with page view**: `pinExactScale` carries the contract *"nothing may grow a page's viewBox after mount"*, from the section-header injector bug (2026-09-02). Scroll view is one continuous system rendered with `adjustPageHeight` and needs the opposite. The growth lives in `scrollbox.ts`, not inside `pinExactScale`, so both rules stay true — do not "unify" them.

**Where**: `apps/composer/src/render/scrollbox.ts` (new), `apps/composer/src/render/splice.ts` (`staffFrameOf`, frame adoption in `spliceDom`), `test/composer-test/lib/assertions.mjs` (`assertScrollSystemCoherent`).

---

**Performance mode's bar trails the player, and the end of the score is not an exit (2026-09-14).**
Two changes to Performance mode (see "Performance mode is input-driven playback", 2026-06-05), both
Max's calls, both about the mode being a *performance* transport rather than a follow-along.

1. **The bar sits past the note just played, not before the note expected next.** `PerfAdvance` now
reports the step it just COMPLETED with `edge: 'right'`, so the bar lands at `rect.right + CURSOR_HPAD`
— the exact offset the voice cursor takes after a note is entered, so the two read identically.
Max's reasoning: *"I'd rather smoothly track the notes played than clearly see what's next"*, plus the
scrolling consequence — a trailing bar is monotonic in x as long as the score is played in order, so
the follow-scroll never jumps backward, whereas a leading bar moves to the next note the instant one
is completed and can retreat at a wrap. Only the pre-first-strike position keeps a left edge (nothing
played yet). The edge is a `PlaybackBarEdge` in `@hkl/shared/cursor-geom.ts` threaded through
`setPlaybackPosition` → `computePlaybackBarRect` → the `composer-playback` bridge message and the
overlay mirror (`edge` optional, absent → `'left'`), so HKL's Composer-view frame and the OBS overlay
stay pixel-identical with no second geometry path. Clock playback keeps `'left'`: there the bar marks
the moment being HEARD, which is the note's onset, and that is a different question from this one.

2. **Consuming the last step no longer stops the mode.** It only sets the status once. Max: being
thrown back to wherever the editing cursor was the instant the last note lands is exactly wrong at the
end of a take. Exit is manual — `#btnPerform`, Space, or switching transports — and `restoreEditingTransport`
runs then. A finished voice likewise keeps its bar parked past its final note instead of clearing it,
so a voice that ends early doesn't blink out mid-performance.

**Where**: `packages/shared/src/cursor-geom.ts`, `packages/bridge/src/{protocol,overlay-protocol}.ts`,
`apps/composer/src/{render/performance.ts,cursor/cursor.ts,main.ts}`, `apps/hkl/src/render/composer-frame.ts`.
Fixtures: `perfBarTrailsPlayed` (rendered geometry: bar at `A3.right+4`, x strictly increasing, mode
still active at the end, Perform button exits), plus `perfTwoVoiceFrontier` / `perfChordWaitsForAll`
updated to the trailing-edge semantics.

---

**The heavy-render predictor stops guessing the PATH; splice fixtures await the deferred render (2026-09-14).**
`pageSystemSpliceCourtesyBehindSectionBreak` failed 2-in-6 on an unchanged tree. Not a flake, and
not the splicer: the edit under test splices every time (verified 6/6 once awaited, `out=spliced`
at 35–42 ms with a proper window).

**Root cause.** `reRender()` defers behind the busy badge (double-rAF + timeout) when
`predictNextRenderHeavy()` is true, RETURNING BEFORE ANYTHING RENDERS. In page mode that predicate
was `lastPageSpliced && ownershipActive()` else `lastFullMs.page > 250`. `lastPageSpliced` is false
after ANY derive, so the edit following a derive was priced at the derive's cost. The fixture's own
setup derives (adding a section header adds a user break), and that engrave measures **221–298 ms**
on the same machine — straddling `HEAVY_MS`. Above it the delete's render deferred, the assertion
read the header render's stale `lastOutcome` ('noop') and reported a splice failure that never
happened. Same-run pairing, 6/6, no exceptions: `predictHeavy=true` → fail, `false` → pass.

**The second symptom had the same cause.** Failing runs showed 3 renders / 2 full vs 2 / 1 on passes,
the extra one `(unattributed)` (full, no derive reason, no splicer skip reason) — the queued render
escaping the assertion boundary and being superseded by a full engrave. Awaiting the render collapses
every run to 2 / 1. So the deferral window is a hole where a ~40 ms splice can be upgraded into a
full engrave.

**Decision 1 — predict the path by asking, not by remembering.** Page mode now returns "light" when
`pageBreaks.canAttemptRefill()`, the structural analogue of the scroll branch's `canSplice()` three
lines below. Document cost genuinely carries between renders (measures/staves/zoom barely move); the
PATH does not, and a one-sample path predictor is wrong exactly at the derive→edit boundary — which
is the most common edit there is. Like `canSplice()` this is readiness, not a guarantee: a refill
that refuses and derives costs one un-badged slow render, the failure mode this predictor already
accepts. Safety: `forceFullRerender()` → `pageBreaks.invalidate()` nulls BOTH `startIds` and
`adoption`, so zoom / file-open / HEJI / page-scale keep their badge.

**Decision 2 — fixtures await the render they measure.** New `window.__waitForRender(maxMs)` test hook
(backed by `__hkl_composer.renderPending()` = `renderQueued || renderInFlight`), applied after every
`reRender()` in the 34 assertion blocks that read splicer outcome state. It resolves immediately when
nothing is pending, so it is free on the synchronous path. Rejected: a `reRenderSync()` that bypasses
the defer — it would hide the deferral path from the suite entirely, and the deferral is real product
behavior that tests should be able to exercise. Two cascade fixtures needed their `withWarnsCaptured`
helper made async-aware (the reRender they measure sits inside that callback).

**Known gap, not fixed here**: `fullRender: '<why>'` switches the runner's unexplained-full-render
check off WHOLESALE (`if (unexplained.length && !fixture.fullRender)`), so a fixture that declares one
expected derive is blind to every OTHER full render it performs. That is why the extra engrave above
never failed the run on its own — it only appeared in the summary listing. Worth making the flag name
the reason or the count it permits.

**Verification**: target fixture 10/10 (was 4/6); full suite 481/481; `(unattributed)` in the splice
ledger down from 4 fixtures to 3, the remainder being the zoom/roundtrip ones where `forceFull` is
correct. `pnpm typecheck` + `pnpm build` + `pnpm check:boundaries` clean.

**Where**: `apps/composer/src/render/render.ts` (predictNextRenderHeavy), `apps/composer/src/main.ts`
(`renderPending`), `test/composer-test/lib/runner-core.mjs` (`__waitForRender`),
`test/composer-test/fixtures.mjs` (34 blocks).

---

## The OBS overlay's Composer frame follows Composer's zoom; HKL's own frame stays at 50 % (2026-09-14)

**Problem**: the overlay renders the mirrored Composer score at a hardcoded 50 %, which is too small
to read in a portrait stream capture.

**Decision**: transport Composer's zoom level and let the **overlay** frame render at it, while HKL's
own bottom-bar frame stays pinned at 50 %. New `composer-zoom` on both the Composer→HKL bridge and
the overlay protocol; Composer sends it on connect and on every zoom step; `hkl-side.ts` forwards it
to `overlay-publish` and — uniquely among the composer-frame messages — does **not** apply it
locally. The publisher caches it for the reconnect snapshot.

**Why the two surfaces differ** (Max's call): HKL's frame lives in the fixed-height `.info-row` under
the lattice canvas with `overflow-y:hidden`, so a 2× render just clips; there is no room to mirror
the zoom there. The overlay is a separate page whose capture is usually portrait and has the height
to spare. Same module (`composer-frame.ts`), different page instances, so a module-level `frameZoom`
is all the divergence needs.

**Why this is safe to vary at all**: the unit-8 crisp-preset ladder (2026-08-31) makes `unit`
constant across 50/75/100, so zoom is pure magnification with identical layout. The frame renders the
same MEI with the same breaks and spacing; the read-only cursor / playback bars are computed in
client px and mapped through the SVG's CTM, so they scale for free with no geometry changes. At 75
and 100 the frame's `crispMarginTop(30, …)` even resolves to 30 — matching Composer's scroll
`pageMarginTop` exactly, where the 50 % preset has always used 31 for its half-pixel line phase.

**Rejected**: a CSS transform on `#composerFrame` — cheap, but it scales the rasterized SVG and
blurs the very staff lines the crisp-preset ladder exists to keep sharp. Also rejected: a separate
overlay-only size control in HKL's UI — another knob to forget mid-performance when the answer is
already sitting in Composer's zoom.

**Ceiling**: 100 %. A larger overlay score needs a new entry in `CRISP_PRESETS` (scale must be a
multiple of 25 at unit 8 to keep an integer staff-space), not a transform.

**Wire type**: `composer-zoom.zoom` is a plain `number`, not the `ZoomLevel` union — the ladder lives
in `@hkl/notation`, which `@hkl/bridge` must not depend on. The receiver snaps it with the new
`resolveZoomLevel` (nearest preset), so an out-of-ladder value from an older or newer peer still
renders crisply instead of indexing `CRISP_PRESETS` to `undefined`.

**Where**: `packages/notation/src/{verovio.ts (RenderOpts.zoom, scrollOptions()), render-presets.ts
(resolveZoomLevel)}`, `packages/bridge/src/{protocol.ts, overlay-protocol.ts}`,
`apps/hkl/src/render/composer-frame.ts` (`setComposerFrameZoom`),
`apps/hkl/src/bridge/{hkl-side.ts, overlay-publish.ts, overlay-subscribe.ts}`,
`apps/composer/src/main.ts` (`broadcastComposerZoom`).

**Composer-frame scroll-follow is hand-rolled, not `behavior:'smooth'` (2026-09-15).**
The mirrored Composer frame scrolls one `scrollTo` per note onset. Chromium restarts a programmatic
smooth scroll **from rest** on every retarget (duration ≈ √delta: 42 ms at 10 px, 565 ms at 1200 px),
so the frame hopped and stalled — 31–50 % dead frames, velocity CV ≈ 1.0 — while Firefox, which
preserves velocity across retargets, glided. No browser exposes smooth-scroll duration or easing, so
parity required dropping the native animation. `@hkl/notation/scroll-follow.ts` is a
**critically-damped spring chasing a mutable target**: retargeting moves the target and nothing else,
so velocity carries across onsets. Under a steady onset stream it settles into constant-velocity ramp
tracking with a constant lag of `2v/ω` — at 60 px/120 ms and `SPRING_K = 1000`, a steady 500 px/s
trailing ~32 px. Measured after: **0 % dead frames and CV 0.32–0.39** at note rate.

**Closed form, not Euler**: the obvious semi-implicit Euler step is unstable at dt = 1/30 s with
`SPRING_K = 1000` (eigenvalue −1.83) — i.e. it would diverge on a 30 fps OBS Browser Source while
looking perfect at 60 fps. Critical damping has an exact solution for a target held constant across
the frame, so a 30 fps source traces the *same* trajectory as a 60 fps desktop, merely sampled half
as often. Do not "simplify" it back to an Euler step. `SPRING_K` is the single tunable: lower = more
continuous across slow onsets, at the cost of more trailing lag.

**Placement**: `@hkl/notation` rather than `@hkl/shared` — the animator touches the DOM, and
`@hkl/shared` is pure data. Both HKL and Composer already depend on `@hkl/notation`, and the overlay
bundle already pulls it in, so this costs the lean overlay build nothing (+765 B).

**Scope: the frame only.** `apps/composer/src/main.ts` keeps its native `scrollTo` — it follows per
*measure*, not per note, so the hop is far less visible, and Composer is driven in Firefox where the
native behaviour is already correct. Max's call: "just fix the frame, that's where steady scroll
matters." If Composer is ever driven in Chromium for performance, this is the one-line swap.

**Also**: `prefers-reduced-motion: reduce` jumps instead of animating, preserving what the native
smooth scroll did for that user. A re-render resets `scrollLeft` to 0, so `doRender` /
`clearComposerFrame` call `cancelScrollFollow` — otherwise the loop chases a position that no longer
exists. The call site compares against the animation *target*, not `el.scrollLeft`, which mid-flight
is a point on the trajectory rather than the thing that was asked for.

**Where**: `packages/notation/src/scroll-follow.ts` (new),
`apps/hkl/src/render/composer-frame.ts` (`scrollToId`, `doRender`, `clearComposerFrame`).

**The re-strike blink is render state, not audio state (2026-09-15).**
A strike on an already-sounding key (sustain-captured, re-struck under the pedal) paints that key as
*unselected* for 60 ms to confirm the re-trigger. The key never leaves `selection.selectedKeys` —
`draw()` subtracts it at paint time. That expiry map used to be `audio.rearticulateFlashUntil` in
`state/audio.ts`, written by `triggerRearticulateFlash()` in `audio/engine.ts`. It was the only
purely-visual field in a module of `AudioContext` / `GainNode` / `BiquadFilterNode` / `damperDepth`,
and it was `engine.ts`'s *only* reason to import the renderer at all.

Now: the map is `selection.flashUntil` in `state/selection.ts` (beside `selectedKeys`, which it
modifies — `draw()` reads both in one pass), and the sole entry point is `flashKey()` in
`render/key-flash.ts`. Audio and MIDI **call** it; nothing in render imports audio to make it work.
Renamed for the visual, not the audio event, so a future non-audio trigger (a cue, a count-in) needs
no second migration.

**What the misplacement cost**: the OBS overlay never mirrored the blink. The overlay renders keys
but excludes the audio engine by design — that exclusion is what keeps the lean bundle lean — so it
could reach neither the state nor the setter. The first fix considered was to publish from the audio
engine and move `REARTICULATE_FLASH_MS` into `state/audio.ts`, i.e. have the overlay's subscriber
write into audio-engine state to make a key blink. Max rejected it: "key visuals should not be tied
up with audio." Correct call — that would have entrenched the coupling that caused the bug. Moving
the state made the overlay side a three-line handler with no audio import, and cost the lean bundle
+80 bytes.

**Its own message, not a `keys` delta**: `{ t: 'flash'; keys }`. Folding it into `litKeys` would need
no new message type, but the blink is a *modifier* on the lit set, not a change to it — so `keys`
keeps meaning exactly `selection.selectedKeys`, a retained snapshot can never strand a key dark, and
a dropped message costs one missed blink instead of a stuck key. The subscriber times the 60 ms off
its own clock, so relay jitter cannot stretch or compress it. Publishing from inside `flashKey()`
covers all five trigger sites by construction rather than by remembering each one.

**Where**: `apps/hkl/src/render/key-flash.ts` (new), `apps/hkl/src/state/{selection,audio}.ts`,
`apps/hkl/src/render/draw.ts`, `apps/hkl/src/audio/engine.ts`,
`apps/hkl/src/{input/keyboard-notes,midi/piano,midi/handler,bridge/hkl-side}.ts`,
`apps/hkl/src/bridge/{overlay-publish,overlay-subscribe}.ts`,
`packages/bridge/src/overlay-protocol.ts`, `test/overlay-inspect/flash-mirror.mjs` (new).

## Sub-audible damper threshold: notes release at damper contact, not at pedal zero (2026-09-15)

`DAMPER_RELEASE_FLOOR` raised 0.005 → 0.05, and `audio.sustainPedalDown` re-gated from `depth > 0`
onto the same constant.

**Problem**: damper depth multiplies voice gain linearly, so a pedal change that never returns the
pedal fully to rest leaves notes ringing at a few percent — inaudible, but still in `sustainedKeys`,
therefore still in `selection.selectedKeys`, therefore still lit on the canvas, on the Lumatone LEDs,
and in the Composer held-keys bridge. On video this reads as a growing wash of stuck keys that the
viewer cannot hear. The old floor was a float epsilon guarding the release comparison, never a
musical threshold.

**Unlight and stop are the same event, deliberately.** A visual-only threshold was considered and
rejected: "lit == sounding" is currently free, since canvas, LED sync and the bridge all derive from
`selectedKeys` through `onSelectionChanged`. Decoupling them means threading a second "lit" set
through all three consumers for the sole purpose of making the light disagree with the audio. Taking
the existing release branch gets both for one constant, and matches the physical model — below
contact the damper is on the string. `noteOff` already ramps 60 ms, so the crossing does not click.

**Why the threshold is not an input clamp on `cc4Depth`**: lessons.md records that the CC 4 = 1
at-rest quirk was deliberately fixed at the input boundary so `pedal.cc4Depth` reads a true 0 at rest
for the HUD. That reasoning still holds. This is a sustain-semantics decision, not a signal-cleanup
one, so it belongs in `setDamperDepth`. `cc4Depth` continues to report the pedal's real position.

**The coupled `sustainPedalDown` change is the load-bearing half.** It is the gate deciding whether a
released key enters `sustainedKeys`. Left at `depth > 0`, the band `(0, 0.05]` becomes a stuck-note
zone — nothing re-evaluates the damper while the pedal sits still. See the new lessons.md entry.

**No hysteresis.** Release is one-directional: a released key is out of both sets, and re-pressing
does not resurrect it (correct — the dampers have landed). Chatter at the threshold is impossible.

**Fixed constant, not a pref.** Max's call; he is auditing the value against his own pedal travel.
0.05 ≈ -26 dB at full voice gain, and lower in absolute terms since a note reached by a pedal change
has already decayed.

**Known consequence**: `.hkr` playback replays CC 4 through `setDamperDepth`, so recordings made
before this change release slightly earlier on playback. Accepted.

**Deferred**: a longer (~150–250 ms) damped fade for threshold-triggered releases specifically, which
would model light damper contact better than the generic 60 ms `noteOff` ramp. `noteOff` takes no
release-duration parameter, so it is real scope; not folded in.

**Where**: `apps/hkl/src/audio/engine.ts`, `apps/hkl/src/state/audio.ts`,
`apps/hkl/src/ui/pedalHud.ts` (stale-tint gate moved onto the shared threshold so a resting partial
press is not flagged as divergence), `apps/hkl/src/midi/handler.ts` (comment only).

---

**Performance mode expects voices only in the measures where they exist (2026-09-17).**
A voice that didn't enter until later in the piece drew a playback bar from m1 and matched strikes
from the downbeat, independently of every other voice. Root cause: `PerformanceMatcher` discarded
`atMs` at construction (`list.map((x) => x.step)`) and so held **no position information at all** —
`onStrike` tested every voice against every strike forever. A voice entering at m20 was advanced by
any m1 strike whose `(name, octave, color)` identity matched its entry note, teleporting its bar 19
bars ahead; the far side of every mid-piece rest had the same hole, since rests are filtered out of
the step list entirely.

**Not a redesign** (Max, explicitly): per-voice frontiers and per-voice bars are the intended visual
and are untouched, as are identity matching, strict chord completion, independent advance and the
trailing bar. What was added is a measure-scoped notion of where the performance is:

- **Current measure** = the measure of the earliest **pending** step across unfinished voices.
  Pending rather than last-played is load-bearing: the instant m19's last note is consumed the
  current measure becomes m20, so a voice entering on the m20 downbeat is already listening when
  that downbeat is struck — including when it is struck simultaneously with another voice's, which
  a last-played definition would drop.
- **`listening(V)`** = V's pending step is in the current measure. This is the whole fix: a late
  entry, or a note on the far side of a rest, is simply not matchable until the performance
  arrives. Within a measure nothing changes.
- **`barVisible(V)`** = V has content in the current measure — Max's rule verbatim: "if the current
  measure does not have a voice that has an active cursor in a previous measure, that cursor should
  disappear." Uses `model.isMeasureEmptyInVoice` (index.ts:1310), which was dead code until now.
  It counts **written** rests as content, so a voice notated tacet for a bar keeps its bar (it is on
  stage, just silent) and only a truly empty layer — invisible placeholders / `<mRest>` — hides it.
- The two rules deliberately differ: a voice can be on stage without being listened to, when it is
  present in the measure but has already consumed its notes there.
- **No cue on re-entry** (Max's call): a returning voice's bar stays hidden until it strikes, then
  reappears trailing the note just played. The pre-first-strike left-edge bar survives only for
  voices in play in the first sounding measure.
- **No deadlock by construction**: the voice attaining the earliest pending step is always listening.

**Repeat-safety**: steps carry a measure **occurrence** ordinal, not a measure index — assigned in
one pass over `buildPlayback`'s globally atMs-sorted stream, opening a new occurrence whenever the
measure changes. Measures are global, so a measure's attacks are contiguous in that stream whatever
voices they belong to, and a repeated measure opens a second, distinct occurrence. Comparing raw
indices would make a repeat's two passes indistinguishable.

**Supersedes, in part, "Performance mode's bar trails the player" (2026-09-14)**: a voice that ends
mid-piece no longer keeps its bar parked once the current measure has no content for it. The
end-of-score half of that ruling is preserved and now falls out of the gate for free — with every
voice finished there are no pending steps, hence no current measure, so every bar freezes where it
is and the mode stays on.

**Cost**: none at runtime worth measuring — the single-instrument gate caps this at 4 voices, so the
current measure is a 4-element min per strike. Construction resolves each step's measure off the
cached voice index (`findElement` + `getFlatStopInfo`, O(1)) rather than `getMeasureIdxForId`'s
per-call scan, folded into the `findElement` lookup `colorsForElement` already performed.

**Where**: `apps/composer/src/render/performance.ts` (the whole substance), plus one `expected()`
line on main.ts's `__performance` test hook. No bridge, cursor or overlay change was needed:
`PerfAdvance.meiId` is already nullable, `cursor.setPlaybackPosition(voice, null)` already deletes
and hides a bar, main.ts's advance loop already guards scroll/head-tracking with `if (a.meiId)`, and
the `composer-playback` message and OBS overlay rebuild `bars` wholesale from `getPlaybackBars()`.
Fixtures: `perfLateVoiceDormant` (late entry dormant + no cue + ended-voice bar clears + end-of-score
freeze), `perfVoiceRestGapHidesBar` (mid-piece gap; the gap note unclaimable until its measure),
`perfWrittenRestKeepsBar` (the written-rest-vs-empty-layer distinction).

## Pickup length is counted in EIGHTH NOTES, not in denominator beats (2026-09-17)

**Decision** (Max, backlog Composer/Features): `Ctrl+Shift+A` takes the anacrusis length in eighth
notes — anything shorter than a full bar — rather than in beats of the meter's denominator.

**Why**: beats cannot express a half-beat pickup in 4/4, which is the commonest anacrusis there is,
and in 2/2 could not express a sub-bar pickup *at all* — the only beat there is a half note, so the
old `0..count-1` range was `{0, 1}` and `1` was already the whole bar. Max's framing: eighths "cover
all cases at the expense of a little more effort to create one", the effort being a larger number for
the ordinary cases (a quarter-note pickup in 4/4 is now `2`, not `1`).

**Not a storage change.** `hkl:pickup-ticks` was always an absolute tick budget on the 64-per-whole-
note grid, so an eighth is 8 ticks in every meter and every `.hkc` written before this reads back
identically. Only the dialog's unit and the model's two conversion helpers moved.

**Consequences worth stating**:
- the full-bar guard is now `budget >= fullBarTicksAt(idx)` rather than `beats >= meter.count`, so it
  holds for meters whose bar is not a whole number of eighths (3/16) instead of accidentally passing;
- `maxPickupEighthsAt` is `ceil(fullBar / 8) - 1`, which is the largest whole eighth strictly shorter
  than a bar — 7 in 4/4 and 2/2, 5 in 3/4 and 6/8;
- `pickupEighthsForSection` reports a **sub-eighth** pickup as `1`, never `0`. Sub-eighth pickups are
  import-only (MusicXML carries whatever duration the file had) and `0` is the value the dialog
  REMOVES on, so reporting it truthfully would turn an innocent OK into a deleted measure. Re-applying
  quantizes that bar up to an eighth, which is visible and explainable; losing it is neither.

Fixtures: `phase4_pickup_eighthGranularity` (a 1-eighth pickup in 4/4 driven through the dialog),
`phase4_pickup_add` (now 4 eighths for the same half-bar pickup, plus the `maxPickupEighthsAt` bound).

## A bar emptied in full is an empty cell, whatever selection mode pointed at it (2026-09-17)

**Decision** (Max, backlog Composer/Features): clearing a beat selection that covers a whole measure
leaves that voice's cell EMPTY — the whole-measure `<space data-placeholder>` — instead of refilling it
with beat-aligned rests. Partial spans are unchanged.

**Why**: measure-mode selection already did this (`clearMeasureRange` strips the layer and lets
`normalizePlaceholders` install the placeholder), and beat mode refilled unconditionally. The same bar,
emptied by the same keystroke, produced a different document depending on which mode the user had
pointed with. Selection mode is how you point at music; it should not be an assertion about what you
want left behind.

**Where**: one condition in `clearBeatRange` (`model/measure-ops.ts`), `clearsWholeMeasure =
tLoIn <= 0 && tHiIn >= cap`, gating the `decomposeBeatAlignedRests` refill. Both delete paths inherit it
(`deleteSelectionContent` for Ctrl+X and Backspace/Delete, `deleteSelectionWithoutCopy` for
paste-over-selection), and paste is unaffected in substance since it clears its destination range anyway.

**Stated in ticks, not in "did we remove everything"** — deliberately. The refill is sized by
`removedTicks`, which counts only the content that was actually present, so a PART-FULL bar (one quarter
plus trailing placeholder) selected in full used to come back as a lone quarter rest at the head of an
otherwise empty bar. The tick test covers that case as the same rule rather than as a special one.

**Per measure**, so a span from mid-bar 1 through mid-bar 3 empties bar 2 and leaves rests in the two
partial ends — each measure answers the question for itself.

Fixtures: `sel_beat_cut_fullMeasure_empties`, `sel_beat_delete_partFullMeasure_empties`, and
`sel_beat_cut_partialMeasure_keepsRests` (the guard that the ordinary partial case still fills — it
passes on both old and new code by design, which is what makes it a regression guard rather than a
restatement of the change).

## Alt+V moves selected whole measures to the other voice (2026-09-17)

**Decision** (Max; hotkey his call after I surveyed what was free): in a BEAT selection, `Alt+V` moves
the measures the selection covers in full into the other voice on the same staff. Purpose: correcting
notes entered into the wrong voice, which is easy to do.

**Why Alt+V, and why the alternatives lost.** Every branch in `dispatchSelectionMode` explicitly excludes
Alt, so the whole Alt namespace was free there. I first proposed `Alt+↑`/`Alt+↓` — it reads off voice
mode's plain `↑`/`↓` ("previous / next voice") and avoids `Alt+←`/`Alt+→`, which are Back/Forward in
Firefox. Max ruled that directionality is meaningless with two voices per staff and chose the single
combo. `Ctrl+Shift+V` was rejected as Firefox's paste-plain-text sitting next to Ctrl+V; `Alt+V` carries
the same class of risk (menu accelerators), which `preventDefault` is relied on to suppress — flagged to
Max, who confirmed. **Not verified in Firefox from here** (no browser testing on Max's machine).

**All-or-nothing, deliberately.** It refuses when no whole measure with content is covered, when the
destination is occupied in any measure it would write into, or when the staff has no partner voice — with
a reason naming the measure by `@n`. A feature whose job is to undo a mistake must not half-apply and
create a subtler one. A fully-selected measure that is EMPTY in the source voice is skipped rather than
refused, so it cannot make the destination check fail for a bar nothing would be written into.

**The destination test is stricter than `layerIsEmpty`**: "nothing but placeholder `<space>`s". The house
predicate (model/empty-flags.ts, used by hide-empty and multirest) also calls a layer holding an `<mRest>`
empty, and an `<mRest>` is a written whole-measure rest — moving notes onto one would yield a measure with
both.

**The selection follows the music.** "Stay in selection mode" (Max) is implemented as retargeting the beat
range onto the sibling voice over the moved measures, not leaving the highlight on the now-empty source.
The highlight is *of the notes*, and the notes moved — and it makes `Alt+V` its own inverse, which is what
you want from a fix-a-mistake key. It spans first-to-last moved measure, since the move set can skip a bar
that was empty in the source.

**Beat mode only.** Measure selection is staff-scoped and already spans both voices, so "the other voice"
has no referent there; it errors.

**`e.code === 'KeyV'` is matched before `e.key`** — Alt+letter does not give a plain letter in `e.key` on
every platform (macOS composes Alt+V into '√'), and the binding means the physical key.

Fixtures: `sel_altV_movesToOtherVoice`, `sel_altV_roundTripsBack`, `sel_altV_undoRestores`,
`sel_altV_refusesOccupiedVoice`, `sel_altV_refusesPartialSelection`, `sel_altV_refusesMeasureMode`.


## 2026-09-17/18 — The balancer is the single partition authority (page view)

**Non-alignment is the defect.** Composing at the end drifted a section to `4,5,5,5,5,9` — its first
line frozen at fill 0.70, its last at 1.42 — because the balancer only ran when a section's FINAL line
fell below MIN_FILL. A growing last line is legal all the way from 0.65 to 1.45, so nothing rebalanced
until it overflowed. Max's ruling on the fix went further than the symptom: *"If we can't align castoff,
derive, AND the rebalancer to reproduce the same measure counts per line for the same document — in all
cases, by construction — this is a failure. Non-alignment between those things is exactly what leads to
unexpected rebalancing which prevents serious layout work."*

**Castoff cannot be aligned, so it stops deciding.** Measured: no cap makes a greedy pack over our
naturals reproduce castoff's line CONTENTS (1 of 24 movement×cap cells matched, coincidentally) — our
naturals are not Verovio's internal widths. Alignment is therefore only achievable by having one
producer. The derive path now discards castoff's partition and computes its own; castoff still engraves
measures, justifies within a pinned line, paginates by height, and supplies the naturals.

**`BALANCE_LAMBDA = 0`.** λ was the change penalty that kept an edit's reflow local. Any history
dependence is by definition misalignment, so it had to go. The trade it was paying for is real and was
measured over the sonata and a 30-bar append trace:

| λ | derive ≡ edit | boundaries moved per +1 bar (med/p90/max) | worst fill spread |
|---|---|---|---|
| 0 | 23/23 | 30 / 38 / 70 | 0.15 |
| 0.005 | 17/23 | 2 / 16 / 20 | 0.16 |
| 0.02 | 15/23 | 0 / 6 / 12 | 0.32 |

λ > 0 is what froze that first line: the even partition was 15× better on variance but cost 5 × 0.02 in
penalty, so the ragged one won. λ stays in the code as the only tuning surface, 0 in every caller.

**Line count from content, arrangement from the DP.** `greedyLines` at `BALANCE_SOFT_MAX` 1.00 ("never
compress a line past its natural width; if it would, use another line"), then minimum-variance
`dpPartition` at N, N+1 or N−1. The merge rule, the N−1 fallback and `MERGE_MAX` are gone — choosing N
from content subsumes them. At cap 1.00 the count matches castoff's own on all four sonata movements
(36/21/22/37), so adopting the partition moves no page boundary; the contents differ, necessarily.

**No stubs, and no depth cap** (Max, 2026-09-18): *"The last line must always be justified, not
alternating between justified and stub depending on its context."* A depth-capped tail repair was
rejected for that reason. The accepted cost is that an append can re-flow its whole section (24 bars
`[6,6,6,6]` → 25 bars `[5,5,5,5,5]`). **Rule 2** survives only as the short-section edge case: no
feasible line count at all → `balanceSection` returns null, the caller keeps what it had, the stub
renders unjustified. Fixture `pageBalanceRule2StubKept`.

**A user page break makes a section boundary, and both sides rebalance** (approved 2026-09-18). A break
early in a document can therefore collapse the measures before it onto a single system — five measures
on one line rather than two sparse ones. `pageUserBreakReflows` lost its `+1 line` and
`no single-system pages` assertions, which were arithmetic specific to the old behaviour; it keeps the
round-trip, which a pure-function partition now makes exact.

**The idle balance job is removed.** Balancing the whole document before the paint (2026-09-08) had
already made it unreachable — `armBalanceJob`'s only call site was guarded by a flag that could never be
false. It was a latent second authority holding λ, so it is deleted rather than left dormant, along with
`BalanceJob`, `BALANCE_SLICE`, `balanceJobActive`, `finishBalanceJobNow`, the `balanced` cache flag and
the `commitPartition` hook. `Renderer.applyPartitionChange` stays — line-break undo still uses it.

**Three width-model defects, each found by disbelieving a number** (2026-09-18):
- **The budget was measured, and inflated.** `measureBudgetW` read the system's *bbox*, which carries a
  constant ~222 units of ink overhang that the per-measure naturals do not. Every fill was ~1.2 % too
  small. It disqualified a legal `[4,4]` by 0.0049 and collapsed an 8-measure locked section onto one
  compressed line of 8. Now computed: `(pageWidth − marginLeft − marginRight) × 10`
  (`Renderer.pageBudgetW`), verified across six geometries. This also removes the bootstrap — the
  partition no longer needs a laid-out page to exist, which is what lets castoff stop running first.
- **The leading block was double-counted.** Measure 0's natural already contains the clef+key+meter
  (its bbox starts at 0 with the clef at x≈99 inside it, 3963 against 2930 for a plain measure), and
  `sigW` was added on top — pushing a six-measure first line to 1.008 against a 1.00 ceiling, so the
  first line held one measure fewer than every other and fewer than castoff places.
- **The instrument-name indent was free.** The first system's staff starts at 1342–2009 while every
  later system's starts at 0 — up to 10.7 % of the budget, charged to nothing. `sigWForLine(0)` now
  returns it, carried through `OwnerWidths` so a partition-cache restore cannot blank it.


## 2026-09-18 — Page overflow repair covers the ONE-page document, and a created page draws itself

**What.** `repairPagination` / `repairAtMount` are gated on a new `paginationRepairable()`
(`ownershipActive() && pageStartIds.length >= 1`) instead of `paginationOwned()`
(`pageStartIds.length > 1`). `paginationOwned()` is unchanged and still governs `<pb>` emission
(`pageSet()`) and the painted breaks strategy.

**Why.** The two predicates answer different questions and diverge on exactly one state — a one-page
owned document — where no `<pb>` is pinned but the paint is still `'encoded'`, which never paginates by
height. Gating the repair on the pin question made page growth unreachable from a one-page score: the
cascade is the only thing that can add a page on the splice path, and it required a page to already have
been added. Composing into an empty score never produced page 2 (measured: 1 page live vs 4 imported for
the same 161 measures), violating the contract that populating content live equals importing it. See
lessons.md, same date.

**A created page is never a header page (Max's ruling).** The header page always already exists, so the
cascade never has to build one. That also settles how to grow 1→2: page 1's `g.pgHead` is the TITLE
block, so `createPageFromShell` cannot clone a correct running header from it — its number-bump scan
finds no page number and drops the header entirely, leaving a page placed at C0 with no page number,
which is NOT what the same document imported produces. So when the spilling page's head is a title block
(`headIsTitleBlock`, mirroring the bump scan so the two cannot disagree), the new page is appended as a
PLACEHOLDER and draws itself from the pins — which now carry a `<pb>` — instead of being transplanted
into a cloned shell. It is then identical to a derived page by construction, headers included. Only
reachable on the 1→2 growth of a one-page score; every later page is cloned from a numbered header and
renumbers correctly, which is why pages 3+ were wrong too until page 2 became right. Verified: live
composition and a forced full render of the same document now agree on page count, page starts, per-page
system counts, page headers and first-system tops.

**Rejected: hand pagination back to Verovio at the 1→2 boundary.** A derive there would be cheap (the
document is one page by definition) and reuses a proven path, but it reintroduces the edit-path hand-back
Phase 2 removed, and it does not fix the symmetric case of a score that collapses to one page and then
grows again. "We own pagination, we create new pages and populate them" (Max).

**Also.** Under `HKL_INDEX_CHECK`, a landed splice now asserts `overflowingPage() === 0`. The cascade was
the only fit check on that path and nothing asserted it had actually run — which is how this shipped
silently. Zero production cost.


## 2026-09-18 — The refill always paints `'encoded'`; `'line'` keeps only its discovery role

**What.** `refill.strategy` (`linebreaks.ts`) was `newPageStartIds.length > 1 ? 'encoded' : 'line'` and is
now unconditionally `'encoded'`.

**Why the fallback existed.** A one-page document pins no `<pb>` (`pageSet()` is null), so painting it
`'encoded'` yields exactly one page however tall it grows. `'line'` handed height pagination back to Verovio,
and that is what kept one-page scores paginating at all. It is not needed now the overflow cascade covers a
one-page document (same-date entry above): an overfull page is grown by the repair. Verified by experiment —
with the cascade guard reverted and the strategy forced to `'encoded'`, `pageGrowFromOnePage` fails; with the
cascade fix in, the full suite is green.

**Why it had to go.** `'line'` ignores `<pb>` (1 page vs 2 on identical data). A user page break therefore
survived the derive and was destroyed by the next edit — Ctrl+B, type one note, the break is gone, with the
`<pb>` still in the model. Fixture `pageUserBreakSurvivesEdit`.

**What still chooses `'line'`, and why that is right.** Two sites, both about DISCOVERY rather than painting:
`castoffPlan` uses `'line'` for `<pb>`-bearing data because `'encoded'` paginates ONLY at explicit breaks and
so cannot discover where pages belong (one Ctrl+B on the sonata gave pages of 15 and 104 systems — the C1
measurement in that function's comment); and `paintedBreaks()` uses `'line'` before ownership is active,
where there are no pins to honor. Neither can repaint an owned document, so neither can lose a `<pb>`.

**Not fixed here.** An edit in a document with a user `<pb>` still falls back to the full refill render: the
splice window carries the `<pb>`, paginates, and trips `'window paginated'`. Pre-existing and measured both
ways (2 full renders under the old strategy, 1 under this one).


## 2026-09-18 — The segmented castoff's single-line bail moves onto the merged line set

**What.** `castoffSegmentedByUserBreaks` judged `baked.lines.length <= 1` on the raw whole-document castoff,
before merging in the user's break measures; it now judges `mergedLines.length <= 1` after the merge.

**Why.** A user page break always splits its line, and the merge twenty lines below the old guard is what
encodes that. Judging the raw castoff meant any score short enough to cast off as ONE line — two measures —
could never have a page break adopted, so the owner held one page start against a two-page paint. That
mismatch is what forced the cascade to tolerate pages beyond its own index (same-date entry).

**Verified before/after** on a 2-measure document with one Ctrl+B, partition cache cleared so the derive
reaches the branch: `pageStarts` 1 → 2 and `paginationOwned` false → true, with an 18-bar control at 2/true
in both runs. The natural flow needs no cache poking: Ctrl+B now yields `pageStarts` 2 / owned, and it
survives the following edit. Fixture `pageUserBreakSurvivesEdit` carries both assertions and was confirmed to
fail without the change ("owner holds 1 page start(s) for a 2-page render").

**Correction to a comment.** `castoffPlan` claims `'line'` "honors the user's `<pb>` AND still paginates the
rest by height". The first half is false — measured on the baked data it produces, `'line'` gives 1 page
where `'encoded'` gives 2. Honoring `<pb>` is precisely what the segmented path is for.


## 2026-09-18 — An offscreen host must be handed the live page's HORIZONTAL phase too

**What.** `snapSystemRightEdge` takes an optional `originPhaseX`; `Renderer.originPhaseXOf` supplies it from
the live page's `g.page-margin` (`ctm.e`, where the existing `originPhaseOf` reads `ctm.f`); the splice
gate's reference host is post-processed with it.

**Why.** That snap lands a system's right edge on an ABSOLUTE device pixel, read through
`getScreenCTM()`, so it depends on where the host sits in the viewport. The gate's reference host lives at
`left:-99999px` and therefore snapped the same staff end to a different pixel than the live page. One snap
moves at most half a device pixel, so two hosts disagree by at most a whole one — `1 / ctm.a` user units:
10 at scale 100, 13.3 at 75, 20 at 50. TOL is 10, so the worst case EQUALS the tolerance at zoom 100 and can
never trip it, while at zoom 50 it is twice the tolerance. That is the whole of `lock_after_zoom_reflows`,
and why it was zoom-50-only: not a splice defect, and not something to fix by widening TOL.

**Scope.** One call site. The splice window is post-processed inside the live page, so its imported systems
already snap on the live phase — a spliced page always agreed with a full re-engrave; only the reference
disagreed. Default behaviour is unchanged when the phase is omitted, which a real on-screen page relies on.

**Verified.** Whole-document inventory 0 diverging measures at zoom 50/75/100 (was 4 at zoom 50, one per
system — the last measure of each, `dRelX` 0, music and bar lines identical). Flagged gate 499/499, up from
498/499; unflagged suite 499/499.

**Ref note derives from the key signature at the cursor (2026-09-18).**
Reverses "Setup ref drives HKL's score-ref tier" (2026-06-06) and revises "Song-key picker: qm=0 spine,
lowest MIDI ≥ F3". The reference note is **no longer a user-selectable property**: the Setup dialog's
`(q, r)` inputs are gone, `LayoutReq` shrinks to `{ tuningMode }`, and `refQ`/`refR` are dropped from
`<hkl:layoutReq>`, from `layout-req-changed`/`apply-layout`, and from the blank-score auto-adopt. Legacy
`.hkc` files keep the attributes; they are simply never read, so no migration is needed (`setLayoutReq`
strips them as documents are re-saved). HKL's score-ref tier is now fed by `computeSongKeyRefAt(model,
measureIdx)` — the tonic of the key signature **in effect at Composer's current position**, placed on the
qm=0 Pythagorean spine at the octave **nearest C4**.

**Why**: the ref was *stored state*, so a stale value rode the document forever ("ref stuck at the wrong
coordinates") and had no relationship to the key ("ref doesn't update on key change", backlog:102/108).
Deriving it leaves the bug class nowhere to live. Max's accepted cost: the ref can change unexpectedly as
the cursor crosses a key change — cheap, because syncing to Composer is opt-in.

**Placement rule**: window `[54, 66)` replaces `[53, 65)`. Verified against `VALID_REF_TABLE` for all 18
tonics × all 6 tuning modes: every coord is a valid ref (no silent `validateRefNoteCandidate` rejection),
and **exactly one tonic moves** — F, from F3 (53) to F4 (65), since 65 is 5 semitones from C4 and 53 is 7.
The tritone (F♯/G♭) is genuinely equidistant (54 vs 66) and the half-open window resolves it **downward**,
preserving F♯3. B minor → `(-3, 2)` = B3, posInBand 1 — the worked example the feature was specified against.

**Import is unaffected** by the window change. `findTonicCoord`'s other caller is the MusicXML comma-variant
key center, which feeds `coordForSpelling` → `tenneyHeightFromExps` → `reduceExps`, and that octave- *and*
complement-reduces: shifting the center's `e₂` by a constant shifts every candidate's `log2r` equally, so
`r0 = e0 − oct` is unchanged and the ranking is identical. Confirmed empirically — a 9099-note Sonata import
hashes identically under both windows, against a control (forcing `r = 0`) that changes the hash completely.

**Transport follow (Max)**: while either transport runs, `refSourceMeasure()` returns the **sounding**
measure (`lastPlaybackHeadId`, which both the `playback-position` handler and `onPlayerNoteStruck` already
maintain, falling back to a scan of `cursor.getPlaybackPositions()`), so the lattice follows the music
through a key change during *both* clock playback and Performance mode; transport teardown re-derives from
the restored editing cursor. Playback pitch is unaffected — `onRefChanged` migrates only physical-input held
voices, and Composer-driven notes are coordinate-anchored.

**Kept** (Max): the prior-note **selection** tier (`set-reference-note`) is unchanged and still outranks the
score-ref tier in piano outline mode.

**Two latent bugs this surfaced, both fixed because the feature depends on them:**
- `setKeySigAt` diff-elided on `sig` alone, so a same-sig mode flip (D major → B minor, both `'2s'`) wrote
  nothing and was silently dropped. Now keyed on the `(sig, mode)` pair; an unchanged sig with a changed mode
  writes `mode` **alone** onto the override `<scoreDef>` — `meterTable` reads the two attributes
  independently, `pruneEmptyScoreDef` keeps a node that still has an attribute, and `sectionRestart` keys on
  `key.sig`, so no redundant courtesy key signature and no spurious restart.
- `setKeySig`/`setKeyMode` (the head setters) never called `invalidateMeterCache()`, so `keySigAt`/`keyModeAt`
  kept reporting the *old* key for every measure. Harmless while only `getKeySig()` read the head directly;
  load-bearing now.

Also removed the **silent total-save abort**: a blank or out-of-range ref made `readForm()` return `null`, and
the submit handler's `if (!values) return` discarded every *other* Setup edit while the dialog still closed.

**Test-harness note**: both ref tiers are diff-gated by module-global snapshots, and the score-ref now
broadcasts constantly, so `__testReset` clears both caches — otherwise a snapshot left by the previous fixture
silently suppresses the next one's first broadcast. Fixtures must also read `__bridgeMock.captured()` behind a
frame wait: BroadcastChannel delivery is asynchronous, so a synchronous read straight after a strike sees nothing.

**Files**: `apps/composer/src/{cursor/refNote.ts,main.ts,setupDialog.ts,importMusicXml.ts,expressions.ts,model/index.ts}`,
`apps/composer/index.html`, `packages/{notation/src/mei-build.ts,bridge/src/protocol.ts}`,
`apps/hkl/src/{bridge/hkl-side.ts,transcription/meiEmit.ts}`. Fixtures: `score_ref_broadcast_carries_key_tonic`,
`score_ref_tonic_f_is_f4`, `score_ref_follows_midscore_key_change`, `score_ref_updates_on_keymode_flip`,
`playback_score_ref_follows_position`, `perfScoreRefFollowsPosition`, plus the rewritten `keyMode*` /
`song_key_csharp_from_empty_voice` (now assert on the broadcast, not a dialog seed) and a no-ref-fields check
in `phase4_setup_sig_button`. Suite 504/504.

## 2026-09-18 — A tuplet at a bar line is a cursor RE-READING, not overflow

Entering tuplets back to back was impossible across a bar line: at the end of a full measure
`createTupletAtCursor` always rejected with `Tuplet span exceeds remaining measure space`.

**Cause.** Cursor stops are element-anchored (`c` = "past `flat[c]`") and `locateCursor` resolves an
anchor to an insertion point *inside the anchor's own parent* — so the stop past the last note of
measure M is expressed in M's coordinates, `withinIdx === cc.length`. `shouldEmitWrapper` suppresses
M+1's wrapper stop **exactly when M is full**, so that one stop denotes two locations. Every insertion
there has to know it; `planInsert` does (bounded M→M+1 overflow), and `createTupletAtCursor` was the
one layer-level insertion that bypassed it for a hand-rolled `spanTicks > capM0 − usedBefore` check.
At the end stop `remaining` is 0, so it could never succeed. The same check was copied a third time
into the tuplet paste path (`insertClonedAtCursor`).

**Rejected: route tuplets through `planInsert`.** That planner's overflow rule is *more permissive*
than what we want — it would also spill an oversized tuplet out of a PARTIAL measure. Its bounded
overflow exists so a NOTE can be split across the bar line and tied; a tuplet is atomic and can do
neither. Max's ruling: spill only from a stop that is truly past the last moment of a **full** measure;
anywhere in a partial measure, reject for lack of space.

**Decision.** Treat this as disambiguating the cursor, not as overflow — which shrinks the fix rather
than growing it. `resolveTupletTarget` re-reads the location as the head of M+1 iff the cursor is past
all content of a full measure; the M-side reading has zero capacity and can never host anything, so the
M+1 reading is the only viable one. Then an unchanged one-measure fit test applies, now counting
post-cursor content. No eviction, no bar-line straddling, no shared applier, no `planInsert` change.

The second rule fixed a **latent dual bug** in the same gate, in the opposite direction: measuring only
cursor→barline (not cursor→next element) accepted a mid-measure tuplet in a full bar and silently
produced a 5-quarter 4/4 measure. Verified live before and after.

A partial measure keeps its own M+1 wrapper stop, so its end is unambiguous and needs no spill — the
two conditions are exactly complementary, which is why no new cursor stop was added. Adding one would
undo the deliberate navigational-smoothness tradeoff in `shouldEmitWrapper`. The target measure is
materialized only after the fit test passes, so a rejection leaves no stray measure; `createTupletAtCursor`
also gained the `setBarlines()` it never called and now seats the cursor by xml:id (the old `+1` assumed
the tuplet stayed in the cursor's measure).

**Ruling — displacement is not creation** (Max, 2026-09-18). `insertWithSplit` can push an EXISTING
tuplet wholesale across a bar line when an insert displaces it. That was raised as a possible remaining
inconsistency (a tuplet ending up in a measure it could not have been created in) and is explicitly
INTENDED. The two are categorically different: a displaced tuplet keeps its identity and its contents and
got there by a deliberate edit at an earlier point, whereas creating a tuplet in M+1 while M still has
room reads as a bug. Rule 1's `remaining === 0` trigger is precisely what keeps creation out of that case,
which is why the spill is scoped to a stop with zero remaining capacity rather than made a general
overflow. The two paths are not to be unified.

**Files**: `apps/composer/src/model/{tuplet-ops.ts,index.ts}`. Fixtures: `tupletAtBarlineOpensNextMeasure`,
`tupletAtBarlineBeforeExistingContent`, `tupletMidFullMeasureRejected`, `tupletPartialMeasureNoSpill`,
`tupletBarlineBothMeasuresFull`, `tupletSequentialAcrossBarline`. Suite 510/510.

---

## Page partition: no balance gate — every touched section rebalances, always (2026-09-19)

**Picked**: `balanceSectionLines` runs on every section an edit touches, unconditionally. The
`structural` flag (`oN !== nN || hasEdit || lockDiff !== null`) and the `force` parameter it fed are
gone, along with the gate `if (!force && lastFill >= MIN_FILL) return none('')`.

**Rejected**: keeping the gate and widening its trigger — the obvious repair was to also open it when
`greedyLines` over the current widths disagrees with the live line count. That works, but it needs the
greedy N recorded per section to avoid a permanent mismatch whenever `balanceSection` settles on N0±1
(the min-fill fallback), i.e. new state to keep in sync. A gate that costs state to protect a 1.8 ms
no-op is not worth having.

**Why**: with `BALANCE_LAMBDA` 0 the partition is a pure function of content, so re-balancing unchanged
content is *idempotent* — it reports `changed = 0` and returns. There is therefore nothing for a gate to
save, and every gate tried so far has instead frozen a stale partition on screen. The previous rule
(Max, 2026-09-17: "sub-measure edits should still hold divisions unless they trigger an absolute min or
max") only ever implemented the MIN, and only on the section-final line. Widening measures IN PLACE —
note entry, the common case — therefore tripped nothing at all: 20 whole rests in voice 1 plus quarter
rests taken in voice 3 from bar 11 held two lines for 26 consecutive keystrokes, compressing to fill
**1.433** (43% over natural — stems into accidentals) while a fresh derive wanted three lines from the
4th keystroke on. It escaped only when the line crossed FIT_MAX and the *repair* loop split it. Undo
then looked like it broke its contract, but the asymmetry was a symptom, not a second bug: the layout
on screen had never been the one the content implied, so restoring the correct one looked like a change.
After the fix the same trace is a balancer fixed point at **every** step and peaks at fill 1.018.

**Cost, measured before committing** (Max: "I want to quantify that if that's what the blocker is"):

| section (sonata) | lines | measures | balance | boundaries moved |
|---|---|---|---|---|
| movement I | 36 | 139 | 1.2 ms med / 1.8 max | 0 |
| movement II | 21 | 91 | 0.2 / 0.3 | 0 |
| movement III | 22 | 100 | 0.3 / 1.5 | 0 |
| movement IV | 37 | 116 | 0.4 / 0.5 | 0 |

Worst case is 1.2 ms against a **342 ms** edit (0.35%), and a 16-edit sub-measure battery moved zero
boundaries, derived nothing and spliced every time — median wall 342 ms gated vs 345 ms ungated, inside
noise. The O(M²·N) worst-case bound on `dpPartition` badly overstates it: the `minFill`/`fitMax`
feasibility check prunes the inner loop to a narrow legal band, making it O(M·band·N) in practice.

**Ruling — correctness over churn** (Max, 2026-09-19): "I would always rather have the correct partition
immediately than hold it to avoid churn." The `force` distinction was a holdout from the minimal-change
philosophy that predates the balancing rework; once λ = 0 made the partition pure, the gate and the
purity were redundant.

**Known, separate, NOT addressed here**: the line COUNT is chosen by `greedyLines` at
`BALANCE_SOFT_MAX` 1.00 while `MIN_FILL` 0.65 tolerates 54% stretch, so the two bounds are maximally
asymmetric and N flips late — measured on the same trace, the balancer takes 53% stretch to avoid 3.6%
compression, and escapes only when the 3-line option becomes *illegal* rather than when the 2-line one
becomes better. Max's position: compression must be avoided because it always has the potential to cause
collisions, though whether fill > 1.0 is *always* a collision risk depends on how Verovio counts fill,
which is unverified. A symmetric `(ln fill)²` cost was tried on the trace and overshoots badly (it picks
+30% compression at the other end), so any fix needs asymmetric weighting and Max's eye on real renders.

**Files**: `apps/composer/src/render/linebreaks.ts` (gate + `structural`/`force` threading removed),
`docs/architecture/composer.md`. Fixture: `pageBalanceSubMeasureWiden` — verified to FAIL against the
gated code ("stale partition after quarter #3: 2 lines on screen, a fresh balance moves 3 boundaries").
