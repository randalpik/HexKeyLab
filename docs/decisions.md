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
