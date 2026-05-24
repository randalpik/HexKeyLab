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
- **Three new color variant fields** (`.dl/.dd` for −SC, `.ul/.ud` for +SC) on `HueColors`: the colorTable already encodes the SC equivalence — an SC shift of `(q,r)` lands you in the cell whose hue is the SC-shifted sibling's hue. The keyColorVariant helper just looks up `computeHue(q±7·d, r∓4·d)`. No new tables.
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

**Three non-trivial dispatches diverge from Pythagorean**:
1. `freqAt` in `src/shared/freq.ts` — multiplies by `Math.pow(SCHISMA, b)` for V.
2. `jiRatioWithState` in `src/tuning/ratios.ts` — adds `db × (−15, +8, +1, 0)` to the prime-exponent vector (the schisma's prime decomposition 3^8·5/2^15) so the interval analyzer naturally surfaces "octave + schisma" annotations via the existing comma machinery.
3. `keyColorVariant` in `src/render/colors.ts` — bypasses the SC-sibling redirect, returning `computeHue(q, r)` directly. So cell (q=2, r=0) — teal F4 in Pythagorean (via SC sibling at (9, −4)) — becomes yellow E#4 in V mode (its actual 5-limit hue, matching the respelled name).

**Respelling**: `noteNameV(q, r, rsQ)` / `keyOctaveV(q, r, rsQ)` in `src/tuning/notes.ts` walk the M3 chain from refSpine: each Δq applies one `m3up`/`m3dn` step. Accidentals accumulate without clamping: A → C# → E# → G## → B## → D### → F#### at q=0..6. Cells in the same band as refSpine spell identically to standard naming; divergence begins one band away. `displayedNoteName` helper in `render/draw.ts` and the V branch in `bridge/hkl-side.ts:resolveKey` route through the new functions when `tuning.mode === 'V'`.

**Rejected alternatives**:
- **Schisma-tempered Pythagorean** (octave-preserving, all thirds slightly off): connects to classical schismatic temperament. Cheap to implement (just temper each fifth by schisma/8) but breaks the JI ratio analysis since no third is rationally exact. Max's stated reaction: "the existing dim4 interval already sounds close enough to M3 anyway, so it would add a whole new dimension for almost no reason." V mode trades the other way — preserve pure thirds, accept octave drift.
- **Schisma annotation overlay only** (no new layout): already exists in the interval analyzer (C#4→F4 in Pythagorean reads "M3 − schisma" today). Doesn't let Max *hear* the pure-thirds variant directly, which is the actual goal.

**Known degradation, accepted**: Composer score view clamps accidentals at ±3 per Verovio's clean-render constraint (`CLAUDE.md` § Composer architecture). V mode produces ±4+ at far M3-distances; Composer's visual score degrades for those cells but bridge frequencies stay accurate, so playback works. V is HKL-side study; not a composition mode.

**Reused, not regenerated**: `VALID_REF_TABLE['V']` and `PIANO_BOUNDS_TABLE[*]['V']` alias the Pythagorean entries. Justification: V uses identical qm shifts to P, and the ~2c/band schisma drift falls well within picker-TH tie thresholds in the central play range. Re-probe `tools/bounds-probe/` if V's experimental status changes.

**Files touched**: `src/shared/freq.ts` (TuningMode + TUNING_MODES + SCHISMA + freqAt), `src/state/persistence.ts` (TuningMode + isTuningMode), `src/tuning/regions.ts` (case V), `src/tuning/ratios.ts` (schisma exponent injection), `src/tuning/notes.ts` (noteNameV + keyOctaveV), `src/render/colors.ts` (V early return), `src/render/draw.ts` (displayedNoteName helper + validRefSetByMode/validRefPathsByMode V entries), `src/render/canvas.ts` (PIANO_BOUNDS_TABLE V entries), `src/render/refbounds-table.ts` (V alias to P via GENERATED.P), `src/bridge/hkl-side.ts` (description + isTuningMode + TUNING_LABELS + resolveKey V branch), `src/recording/hkr.ts` (isTuningMode), `src/composer/main.ts` (isMode), `src/composer/notation/retune.ts` (MODE_LABELS), `src/composer/setupDialog.ts` (TUNING_LABELS), `index.html` (option).
