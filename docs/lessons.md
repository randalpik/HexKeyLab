# HexKeyLab Lessons Learned

Hard-won truths that aren't obvious from reading the code. Anti-patterns that burned us. Subtle behaviors that look like bugs but aren't. Read this before debugging anything that smells familiar, and add to it whenever something costs more than 30 minutes to figure out.

---

## Hardware

### The Lumatone expression jack is wired Roland-style

The expression jack expects the wiper signal on the **ring** of a TRS plug. Korg-style pedals (DS-1H, DS-2H, switch sustain pedals) put the pot between tip and sleeve and leave the ring unconnected. Plugged into the Lumatone, those pedals look like a floating ADC pin — slow capacitive drift downward, mechanical perturbations spiking to rail, no actual position information.

Two pedals with completely different electrical signatures producing identical behavior is the diagnostic tell. Calibration and sensitivity adjustments cannot rescue this — there is no signal on the read pin.

**Working pedals**: Roland DP-10 (with body switch in "Continuous" mode), Roland EV-5, Yamaha FC7 (with Invert Pedal toggle).

### Boards 3 and 4 are physically swapped on Max's unit

Every LTN file, SysEx push, and MIDI map must respect this via `sysexBoardMap = [1,2,3,5,4]`. This is a per-unit hardware quirk, not a firmware feature. If a build is generated with naive `[1,2,3,4,5]` mapping, key colors and remappings appear on the wrong physical boards.

### CC numbers for the pedal jacks are firmware-hardcoded

Sustain jack → CC 64 (binary). Expression jack → CC 4 (continuous). There is **no SysEx command to remap these**. The Editor doesn't expose it because the firmware doesn't support it. Don't waste time looking. HKL adapts by routing CC 4 → continuous damper handler internally.

### The Lumatone expression jack quantizes during calibration mode

While CMD 0x38 calibration is active, the firmware suppresses CC 4 emission and instead emits spontaneous CMD 0x3E status packets every ~100ms. CC 4 only resumes after calibration is exited. UI design: don't try to show "live CC 4" inside the calibration panel; either hide it during calibration or only update outside cal mode. We picked "remove it entirely" — a CC4 number in the cal panel was previously interpreted as broken when it stayed blank during a sweep, but the panel only renders during cal mode, so the field could never update. Better to leave the cal panel as ADC bounds + valid flag only.

### Calibrated CC 4 ceiling may not reach 127 in normal use

Calibration captures the *peak* ADC value during a sweep, then commits it as the upper bound. The firmware linearly maps live ADC to 0–127 against those bounds. If your steady-state full-press reading is a few counts below the peak you reached during cal (very common — pedals have a bit of mechanical "slam" headroom), the runtime CC 4 will top out at 124–126, not 127.

Two ways to deal with it: (1) recalibrate with softer max-press so the learned ceiling matches steady-state; (2) accept it. With the depth-as-gain damper model in HKL, gain=0.984 vs 1.0 is imperceptible — no need to tail-clamp in software. If a future feature genuinely needs the exact endpoint, the cheapest fix is `d2 ≥ 124 → 127` in the CC 4 handler.

### CC 4 at-rest sometimes emits 1 instead of 0 — causes intermittent stuck-sustain

The *bottom* of the calibrated range is symmetric to the top: the pedal's mechanical at-rest position can occasionally read one ADC count above the calibrated minimum, producing CC 4 = 1 as the final value of a release sweep instead of CC 4 = 0. With `pedal.cc4Depth = 1/127 ≈ 0.0078` and `DAMPER_RELEASE_FLOOR = 0.005`, that's above the floor — `setDamperDepth` keeps notes in `sustainedKeys` and held-but-released notes ring on indefinitely.

Manifests as intermittent stuck-sustain: notes hang after release until the next pedal press generates a fresh release-to-0 sweep. Diagnosed via the pedal HUD (`?pedaldiag=1`) + `pedal.dumpRecent()`: a stuck occurrence showed the tail of `recentEvents` ending with `value=1`, no `value=0` arriving.

Fix lives in `src/midi/handler.ts`: clamp `d2 <= 1` to `cc4Depth = 0`. We chose the input-boundary clamp over raising `DAMPER_RELEASE_FLOOR` because (a) the quirk is specifically about the bottom-of-travel reading, not a general "small depths are noise" issue; and (b) it makes the displayed `pedal.cc4Depth` correctly read 0 at rest rather than 0.0078.

### Web MIDI in Firefox requires a secure context

`file://` URLs do NOT work in Firefox. localhost or HTTPS only. Chromium permits `file://` for testing. Max develops with both browsers; the deployment target needs to assume Firefox + secure context.

### Firefox's `MIDIAccess` is a snapshot — no statechange events, no live port updates

Firefox does not dispatch `MIDIAccess.onstatechange` on hotplug, AND the existing port references in `access.outputs` / `access.inputs` don't update their `port.state` either. The access object is effectively a frozen snapshot of the moment `requestMIDIAccess` was called. Polling `findLumatone` against the existing access does nothing. Chromium dispatches statechange and updates port.state as the spec describes.

The only way to see a newly-plugged device in Firefox is to **re-call `navigator.requestMIDIAccess({sysex:true})`** and replace `midi.midiAccess`. Subsequent calls don't re-prompt for permission once granted. A fresh access yields fresh port state — and possibly fresh port *objects* with the same `id` — so identity checks in `findLumatone` must compare `port.id`, not JS object identity, or every refresh falsely fires the new-connection path.

**Don't refresh while connected.** A `requestMIDIAccess` call is heavy enough in Firefox to audibly glitch playback and disrupt outbound SysEx. We therefore poll-refresh ONLY while `midi.midiOut === null` (looking for connection). Once connected, the poll suspends; the user manually re-checks via a click on the `lumaStatus` indicator (`cursor: pointer`, tooltip wired in `requestMidi`) — or just refreshes the page — if they unplug. Chromium gets unplug-while-connected for free via `statechange`.

Poll cadence is `HOTPLUG_POLL_MS` in `src/midi/engine.ts`.

### Per-board threshold/sensitivity SysEx values are 4-bit, not 8-bit

Commands `0x29`, `0x2A`, `0x2B`, `0x2C`, `0x32` (per-board max/AT thresholds, min hysteresis, CC/AT sensitivity, CC active threshold) are documented in the Terpstra Editor source as taking 8-bit values (`0..0xFE`) packed as two nibbles. **The shipping firmware on Max's unit only honors the low nibble** — sending any non-zero high nibble breaks that board (notes stop registering until a reset). The clamp in HKL's `protocol.ts` builders is therefore 4-bit, and the lumadiag sliders are 0..15.

The read-back commands `0x3A` / `0x3B` still return the full byte (`hi<<4 | lo`), but in practice all valid stored values have hi=0 — useful as a sanity check that a board hasn't been corrupted.

Don't "fix" the clamp upward without first verifying empirically on the device — this was discovered the hard way.

---

## Tuning math

### r is the fifths axis, NOT the minor-thirds axis

Easy to misremember because the layout is called "Harmonic Table" and minor thirds have a natural place in harmonic tables. The r axis is **fifths** (3:2). Minor thirds are a derived direction (−1, +1) in (q, r). Verified empirically: lattice (0, 1) produces a frequency ratio of 3/2 above A3, i.e., a perfect fifth — not a minor third.

### `reduce()` on large ratios loses precision past 2^53

JS numbers are 64-bit floats; integer precision breaks at 2^53. Several reference intervals (Pythagorean comma 531441/524288) and any compound interval crossing many octaves can hit this. Solution: use the exact prime exponent vector `e = [e2, e3, e5, e7]` returned by `reduce()` rather than dividing num/den. Trial-dividing num/den silently produces wrong results.

### Octave-multiple naming uses ET-style ordinals when commas are absent

Pure octave multiples (no reference interval, no commas) render as "perfect octave" / "perfect 15th" / "perfect 22nd" etc., matching ET conventions. Compound forms with commas like "2 octaves − syntonic comma" use `octStr` instead. Don't unify these — they reflect different musical situations.

### Equal mode interval naming must use letter distance, not lattice displacement

`equalIntervalName()` computes intervals from actual `noteName() + keyOctave()`, NOT from raw lattice displacement `(2·dq + 4·dr)`. Band structure means lattice displacement and letter distance can diverge in Equal mode (where the band concept doesn't apply). Use the letter-distance path or you'll mislabel d2 vs A1 etc.

### Equal mode "rational interval" coloring uses `semis % 12`, not the ratio

In Equal mode, only octave-equivalent intervals are rational (unisons, octaves, and their enharmonic spellings: d2, A7, dd3, AA6, …). The check is `semis % 12 === 0` — green if true, red otherwise. The ratio-based TH coloring used in 5/7-limit doesn't apply because every other ET interval is irrational.

---

## Audio engine

### `commitRampSync` must integrate in-flight ramps before starting new ones

Rapid `sRampFreq` calls (e.g., during fast transposition) will race if the new ramp doesn't first integrate the in-flight ramp's current position into the source anchors. Symptom: voices snap back to old frequencies mid-ramp. Solution: `pendingRamp` identity check; cancel stale re-anchors; position-based wrap check.

### Wrap-aligned segment switching: never use `source.loop = true`

All sample wraps go through `scheduleSegmentSwitch`. Native looping doesn't compose with crossfade scheduling, ramp races, or the `validStartsByEnd` graph. If you find yourself wanting `loop = true`, you're solving the wrong problem.

### Polyphonic aftertouch handover needs velocity anchoring

When the first AT message arrives for a voice, you can't just snap voiceGain to the AT value — you'd discontinuously change loudness mid-note. Solution: store the velocity-implied initial gain at note-on, ramp from current gain to AT-implied target with `AFTERTOUCH_RAMP_S` smoothing.

### Sustain re-articulation requires explicit noteOff

Striking a key that's currently sustained (held only by the pedal) needs `noteOff(key)` to stop the old voice cleanly, then create a fresh voice with the new velocity. Without the explicit noteOff, the old voice continues indefinitely. The flash (`triggerRearticulateFlash` / `rearticulateFlashUntil`) is the visual confirmation that re-articulation happened.

### `ampStepDev` is orthogonal to `xfadeDev`

In the analyzer, two loop points can be phase-coherent (low `xfadeDev`) but volume-mismatched (high `ampStepDev`). Trombone is the canonical case — vibrato keeps phase reasonably aligned but envelope drifts. Both gates must pass to admit an edge in the validStartsByEnd graph. Thresholds: 0.08 for trombone, 0.15 for reed_organ, 0.25 default.

### Soundfont and real-instrument oboe/horn share a single wall

Tested 5 oboe sources (FluidR3, MusyngKite, FatBoy, VSCO-2-CE Sus, SSO peastman) and 3 french horn sources (FluidR3, MusyngKite, FatBoy). All eight failed default analyzer gates with the same `clique filter reduced to 0 pts (picks=N)` pattern, N=2–8.

Root cause: `filterToBackwardClique`'s pre-clique forward-stability prefilter (`fwdStabilityThreshold`, default ±10% RMS dev in 300ms forward window). Brass and double-reed samples — soundfont-rendered or anechoic-studio — carry breath/embouchure micro-variation in the post-onset window. The gate documents this exact case ("Brass onsets are the canonical case…").

Loosening (`fwdStabilityThreshold: 0.4` or higher) admits picks but produces audible boop/swell artifacts at loop seams. Audited MusyngKite oboe at 0.40 (still wobbly) and VSCO-2-CE Sus at default 0.10 (clean analyzer-side, still wobbly to the ear because the anechoic recording exposes every breath inflection). Both confirm the gate's verdict.

**Implication**: oboe and french horn are unattainable through the current macro-period algorithm regardless of source. Proper handling requires envelope slope-matching at the loop seam — currently only done in the `vibrato` path, and only for *periodic* modulation. v1.x algorithm task. See `decisions.md` for the v1 deferral entry.

### Default `gateOpts` are surprising; check the `||0.25` defaults before tuning

`cliqueThreshold` default is **0.25**, NOT 0.97 or any near-1.0 number. Higher values are *looser* (admit more pairs at higher midpoint-RMS deviation); lower values are *tighter*. `reed_organ` uses 0.15 because reed-organ samples are unusually steady, allowing tighter mid-crossfade tolerance.

Misreading the direction once cost an entire oboe iteration: set `cliqueThreshold: 0.15` thinking it was loose, it was tighter than default and failed harder. Always look at the `||0.25` fallback in `filterToBackwardClique` (`analyzer/HexKeyLab-analyzer.html`) before guessing.

Same convention for `fwdStabilityThreshold`: default 0.10 is *strict*; 0.30/0.40 are *looser*; 10 (or `Infinity`) effectively disables.

### Loop pathway needs ≥0.45s steady region (`minBackwardSec` + `minForwardSec`)

Even with permissive clique gates, every viable pick must satisfy `backward seam ≥ minBackwardSec` (default 0.15s) AND have a forward partner `≥ minForwardSec` (default 0.30s) = 0.45s minimum loop pathway.

FluidR3 french horn at loose gates passed the clique filter but failed every sample with `no usable loop pathway: no b has both a clean backward seam (≥0.15s) and a forward partner (≥0.3s)`. Brass samples often have steady regions shorter than 0.45s. Independent of clique-filter quality, not gate-tunable without compromising runtime loop quality (audible repetition at very short loops).

### Analyzer measures actual freq, never trusts source labels

Source-label tuning offsets don't matter to the pipeline. The analyzer's autocorrelation refines the fundamental within a search window seeded by `labeledFreq / cfg.transpose`, then emits `freqActual` as the canonical pitch in samples.ts. Runtime plays at `rate = target / nearest.freq` — labels are not in this path.

Tested:
- SSO peastman oboe (5–15¢ flat per its SFZ tune corrections): autocorrelation finds actual pitch transparently.
- VCSL Renaissance Organ 8' (octave-shifted): with `transpose: 0.5`, autocorrelation searches at 2× label and finds the true fundamental.
- Salamander piano (Railsback +22¢ at top): autocorrelation captures the stretched tuning baked into the recording.

**Implication**: don't disqualify a candidate source for "labels are off" or "tuning is non-standard." The analyzer handles it. The label is only a search seed.

### Iowa MIS (theremin.music.uiowa.edu) has no CORS headers

`Access-Control-Allow-Origin` is not returned for cross-origin requests. Disqualifies it as a direct browser-fetch source. To use Iowa samples in HKL, they must be mirrored to a CORS-friendly location (GitHub raw, our own static host) or transcoded into the repo as binary assets.

---

## Rendering

### Seam endpoints must snap to outline vertices

`snapVtx(px, py)` searches for the nearest outline vertex within 6 pixels. Use vertex search only — no segment projections, no flanking-hex logic. The simpler approach is correct here; cleverness produces visual artifacts at corners.

### `Math.floor` boundaries need a +0.5 offset for symmetric animation

`pairOf(r) = floor((r − septimalShift + 3.5) / 6)` — the +3.5 is not arbitrary. Without it, hex centers can sit on floor boundaries and animation timing becomes asymmetric (some hexes animate one frame ahead of their visual neighbors).

### Selection highlights live outside the offscreen build

Hex/text canvases are rebuilt on dirty flags (layout extent, septimal shift, note name visibility). Selection state is per-frame because it changes constantly. Don't try to bake selections into the offscreen canvases — the rebuild cost will dominate.

### Layout switches are zero-cost via offset change

The offscreen canvases are built at fixed reference (0, 0) with padding covering all layout travel distances. Layout switches just change the blit offset; no rebuild. If you find yourself dirtying the offscreen on layout switch, you've broken this invariant.

---

## CSS / DOM

### Class sharing across handler types is a footgun

`querySelectorAll('.tpab')` matched both transpose AND seam-shift buttons because both used `.tpab` for styling. Seam-shift buttons lacked `data-dq/data-dr`, so the transpose handler hit `+undefined = NaN`, then `keyFreq(NaN) = NaN`, then `setValueAtTime(NaN, …)` threw. Symptom was a vague audio breakage on seam shift.

**Rule**: when a handler depends on specific attributes, qualify selectors with attribute filters: `.tpab[data-dq]`. Don't rely on the class alone if other elements share it for styling.

### `:has()` is fine to use; we already do

`.ctrls label:has(input){cursor:pointer}` is in the existing CSS. Browser support is universal as of 2024. Don't waste time avoiding it.

---

## SysEx / MIDI plumbing

### CMD 0x3E packets are spontaneous, not ACK responses

Calibration packets from the Lumatone are NOT replies to a sent message; they're emitted automatically every ~100ms while calibration mode is active. The standard ACK-matching logic in `sysexHandleResponse` will silently drop them because there's no waiting message to match against. Route them separately from `handleMidiMessage` BEFORE calling `sysexHandleResponse`.

### `pushSilent` flag separates UI-affecting pushes from control-path pushes

Color sync should show progress in the status badge. Firmware queries and calibration commands shouldn't. Both share the queue infrastructure. The `pushSilent` flag toggles UI updates without forking the queue. When adding a new control-path command, set `pushSilent = true`.

### In-flight messages finish naturally on queue swap

When a new sync starts mid-push, the in-flight message is NOT cancelled. It finishes, ACKs, then the new queue takes over. The `predicted` snapshot folds the in-flight message's intended state into the diff so the new queue accounts for it. Don't try to abort the in-flight message — that creates ACK/timeout races.

---

## Process / workflow

### Stop and ask when hitting circular reasoning

If a problem keeps not yielding to attempts, stop guessing and ask. Examples that should have triggered earlier asks: the descending-once-per-second pedal behavior (turned out to be hardware wiring, not firmware), the band/region distinction in 7-limit (turned out to need careful reading of LTN files). Cheap ask, expensive guess.

### Run `npm run typecheck` and `npm run build` before claiming a change works

Cheap, deterministic, catches the regression before Max does. The build also surfaces import-resolution failures that strict TypeScript alone misses.

### Re-Read files between edits when other tool calls may have modified them

If `Edit` fails with "file modified since read", re-Read the file and re-attempt the same change before moving on. Skipping the re-Read is how silent edit losses happen — the failure looks final but isn't.

### Design before code on complex features

For anything touching the audio engine, sample loop logic, SysEx state machines, or coordinate systems: propose the design first. Simple tweaks can be implemented directly. The cost of reverting a wrong implementation is much higher than the cost of a design discussion.

### Refactor, don't rewrite

The audio engine especially has subtle, well-tested behavior (segment switching, ramp races, sustain semantics) that's expensive to reproduce. Move things between modules, add types, but don't redesign internals. Mixing mechanical refactor with internal redesign is the standard rewrite-doom failure mode.

---

## Architectural decisions

Settled choices that shouldn't be re-litigated without a strong new reason. Recorded here so that future sessions don't waste cycles re-evaluating them. (For decisions made *during* the v0.9→v1.0 migration, see `decisions.md`.)

### Single static Lumatone mapping; HKL interprets layout in software

**Old approach** (deprecated): three LTN files (`5_limit_natural.ltn`, `5_limit_flat.ltn`, `5_limit_sharp.ltn`) each encoding a different MIDI mapping for the same physical keys, plus a shared SCL/KBM tuning loaded into Surge XT. Layout switches required swapping the LTN file in the Lumatone Editor; tuning lived externally in Surge.

**Current approach**: one static LTN file configures the Lumatone with a fixed (channel, note) address per physical key. HKL receives MIDI from the Lumatone, maps the address to a lattice position based on the current layout, computes the frequency from the active tuning system, and renders audio directly. Layout switching is pure software state in HKL.

**Why we changed it**:
- Layout switching at the Editor level was a workflow break — physical interaction with a laptop mid-session
- Tuning and layout were coupled across two tools (Lumatone Editor + Surge), creating sync hazards
- The SCL format couldn't represent 7-limit's full pitch space (118 unique pitches > 79-note SCL ceiling), forcing compromises
- Once HKL had its own audio engine, going through an external synth was redundant signal path
- One static Lumatone configuration is one less thing to keep in sync across machines

**Implications for new code**:
- HKL is the synth. Don't add code paths assuming an external synth will receive MIDI.
- The fixed MIDI layout is the only Lumatone addressing scheme. Don't add per-layout MIDI mappings.
- Tuning math runs at HKL runtime, not at LTN-build time.

---

## Stereo-to-mono downmix conventions disagree by 3 dB

ffmpeg's `-ac 1` and Web Audio's `AnalyserNode` (default `channelInterpretation = "speakers"`) use *different* downmix formulas, and they disagree by exactly 3 dB on mono content packed into a stereo container:

- **ffmpeg `-ac 1`**: energy-preserving, effectively `(L+R)/sqrt(2)`. For correlated channels (mono content), RMS is `sqrt(2) * per_channel_rms` = +3 dB above either channel alone.
- **Web Audio AnalyserNode "speakers" downmix**: amplitude-averaging, `0.5 * (L+R)`. For correlated channels, RMS = `per_channel_rms`.

Most CDN instrument samples (FluidR3, FatBoy, Salamander) are mono recordings packed into stereo MP3s. The two channels are nearly identical, so this 3 dB gap shows up directly: the analyzer's measured RMS is +3 dB above what `loopOverlay` would have read with the default single-tap AnalyserNode setup. Symptom we hit: `loopOverlay` was reading 3 dB low across every instrument vs. the analyzer's normalization target.

Fix in `src/audio/diagnostics/loopOverlay.ts`: tap `sampleMaster` into a `ChannelSplitter`, give each channel its own AnalyserNode, and combine via energy-summed RMS (`sqrt(rmsL^2 + rmsR^2)`) in `tick()`. This matches ffmpeg's downmix and the LUFS / ITU-R BS.1770 channel-summation convention, both of which approximate perceived loudness rather than amplitude average.

Lesson: when normalizing audio levels, the measurement convention is half the answer. Always check that your analyzer and your meter agree on what "the level" means, especially for stereo content.

---

## Recording / MIDI

### Capture point is the audio engine, not the MIDI handler

The "post-MIDI-translation" framing for the recording capture point is right in spirit (record `(q, r)`, not `(channel, note)`) but the actual implementation should hook one step further downstream: inside `audio.noteOn`/`noteOff`/`handleAftertouch`/`setDamperDepth`/`sostenuto*`. The audio engine is the convergence point for every input source — Lumatone, QWERTY, mouse-click — and any future input source will pass through it too. Hooking at `midi/handler.ts` after `fixedMidiToKey` would silently drop QWERTY and click input from recordings. Hooks short-circuit when `isRecording()` is false; cost is essentially zero when idle.

### Splitting modules to break import cycles beats dynamic imports

`recording/snapshot.ts` originally contained both `captureSnapshot` (used by `capture.ts`, hence `audio/engine.ts`) and `applySnapshot` (used by `ui/recorder.ts`, which calls `ui/controls.ts`, which transitively re-enters `audio/engine.ts` and back into `recording/capture.ts`). The cycle was broken with dynamic `await import('../ui/controls.js')` inside `applySnapshot`. It worked, but Vite emitted chunking warnings and the indirection was hard to follow.

Fix: split into `snapshot.ts` (leaf, read-side: `captureSnapshot`, `snapshotMatchesLive`) and `apply.ts` (write-side: `applySnapshot`, imports `ui/controls.ts` statically). The split lets `recording/snapshot.ts` stay leaf-position, which is what makes the engine-side hook chain clean. Module-graph hygiene is worth a small file split.

### `midi-file` library conventions: pitch bend is signed, channel is 0-indexed

The `midi-file` npm package uses two conventions that bite if you don't read its source:

- **Pitch bend value is signed in [-8192, +8191]**, not unsigned 14-bit. The writer adds 0x2000 internally. So pass `bend14 - 8192` when constructing a pitchBend event, where `bend14 ∈ [0, 16383]` is the raw 14-bit value.
- **Channel field is 0-indexed**. MIDI channel 1 (the MPE manager) is `channel: 0`; channels 2–16 (MPE members) are `channel: 1` through `channel: 15`. Easy to off-by-one because the SysEx/MPE specs talk in 1-indexed terms.

Both verified in the package's `lib/midi-writer.js` and `lib/midi-parser.js`. Worth keeping the conversion explicit at the boundary (e.g., the `MpeAllocator` returns 1-indexed channels and `export.ts` subtracts 1 at the write call).

### MPE pitch-bend range must precede the first note-on per channel

MPE export emits pitch bend BEFORE noteOn for every voice event, not just at the start. Reason: per-channel RPN bend range = 48 semitones is set in the t=0 preamble, but each subsequent note-on on that channel needs a fresh pitch-bend value because the previous voice's bend is still latched. The stable-sort `(t, ord)` in `export.ts` preserves the pitchBend-before-noteOn invariant within a single timestamp window — don't reorder events by note number or channel inside a tick.

### Web Audio's `audioCtx.currentTime` keeps ticking even when the context is suspended

Used as the timestamp source for recording (via `clock.ts:nowSec()`) so recorded times align with what the engine ramps schedule against. The clock advances monotonically regardless of `suspend()`/`resume()` calls — which is correct for recording, but worth knowing if you ever read `currentTime` thinking it pauses with audio playback. It doesn't.

### Recording capture short-circuits when audio is disabled — by design

Capture hooks live inside `audio.noteOn`/`noteOff`, which both early-return when `audio.audioEnabled === false`. So pure-selection clicks (no sound) don't record. This is intentional: recording without audio is meaningless. Documented in `src/recording/capture.ts` and surfaced in the UI as "Enable Audio first" when the user clicks Record with audio off.

### Sample normalization can't fix source-level mismatch when the peak ceiling is tight

The decay-path gain normalizer (now K-weighted LUFS via `analyzer/k-weighting.js`) targets a fixed RMS-equivalent loudness with a −3 dBFS per-sample peak ceiling. When a source's individual samples already sit near that ceiling — Maestro grand piano is the prompting case, many of its notes peak at −3 dBFS direct from the recording — the peak ceiling clamps the gain before RMS-targeting completes. Adjacent notes with matched peaks but different sustained loudness will then play back at different integrated LUFS levels, despite the normalizer's best effort.

K-weighting reduces the mismatch (Maestro: ~8 dB → ~3–4 dB across the keyboard) but doesn't eliminate it. Iowa piano, which is recorded with substantial headroom, normalizes cleanly to within ~0.5 dB.

Diagnostic: if `analyzer/out/<key>-report.md` shows a `Peak (dBFS)` column clustered at −3 with non-uniform LUFS, the peak ceiling is binding. The fix isn't a different normalizer — it's a better-mastered source recording. Don't reach for the headroom by raising `TARGET_PEAK_DBFS` (allows single-note clipping) or lowering `TARGET_DBFS` (makes the whole instrument quiet relative to others).
