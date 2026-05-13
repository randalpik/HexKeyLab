# HexKeyLab Architecture & Feature Reference

Authoritative description of what HexKeyLab is, what it does, and how the codebase is organized. v0.9 behavior parity is preserved through the v0.10 modular TypeScript migration; the descriptions below are the current state.

---

## 1. Hardware Integration

### 1.1 Lumatone

- **Layout**: 5 boards × 56 keys = 280 keys, hexagonal isomorphic.
- **Physical board swap on Max's unit**: boards 3 and 4 are swapped. This is encoded as `sysexBoardMap = [1,2,3,5,4]` mapping group index (0-indexed) to SysEx board ID (1-indexed). Every LTN file, MIDI map, and SysEx send must respect this.
- **Connectivity**: USB-MIDI (primary), 5-pin DIN MIDI in/thru/out, 1/4" Sustain jack, 1/4" Expression jack.
- **SysEx envelope**: `F0 00 21 50 <board> <cmd> <data1-4> F7`. Manufacturer ID `[0x00, 0x21, 0x50]`. Per-key data passes (keyIndex, noteNum, channel as 0-indexed byte, typeByte). `typeByte = (faderUpIsNull << 4) | keyType` where keyType is 0=disabled, 1=noteOnNoteOff, 2=CC, 3=lumaTouch.

### 1.2 Pedal jacks

**Sustain jack** is hardcoded to emit CC 64 (binary). Switch-style pedals work; continuous half-damper pedals are quantized to binary by firmware on this jack.

**Expression jack** is hardcoded to emit CC 4 (Foot Controller) and is **wired in the Roland convention**: wiper expected on the ring (T = pot end1, R = pot wiper, S = pot end2). Pedals that follow this convention work natively (Roland DP-10 with body switch in "Continuous" mode, Roland EV-5, Yamaha FC7 with the firmware's Invert Pedal toggle). Pedals using the Korg convention (DS-1H, DS-2H — pot between tip and sleeve, ring floating) do NOT work: the ADC reads a floating pin and produces noise indistinguishable from a binary switch pedal.

The expression jack supports a runtime calibration mode (CMD 0x38) that learns the ADC bounds for the connected pedal. While calibration is active, firmware emits spontaneous CMD 0x3E status packets every ~100ms with running min/max bounds and a valid flag.

CC numbers cannot be remapped via SysEx; the firmware does not expose this. Sensitivity (CMD 0x03) is a 0–127 gain-style scalar. Polarity invert (CMD 0x04) is a boolean.

### 1.3 Audio architecture

HKL is self-contained. The Lumatone sends MIDI on a fixed (channel, note) addressing scheme; HKL maps those addresses to lattice positions based on the current layout, computes frequencies from the active tuning system, and renders audio directly through its sample/oscillator engine. There is no external synth in the signal path. A3 = 220 Hz is the central reference of the tuning system.

---

## 2. Tuning System

### 2.1 Layout: Harmonic Table

Three hexagonal axes mapped to musical intervals:
- **q-axis**: major thirds (5:4)
- **r-axis**: perfect **fifths** (3:2) — NOT minor thirds (verified from LTN data; lattice (0,1) maps to 3/2)
- **Derived axis**: minor thirds (6:5) via direction (-1, +1) in (q, r) since (5/4)⁻¹ × (3/2) = 6/5

### 2.2 Banded JI

The keyboard is divided into **3-key-wide bands** along the q-axis:
- Within each band, intervals are pure 5-limit JI
- **Seams** exist between bands where JI breaks down
- **Octave constraint**: every key is exactly 2:1 above the key 3 positions to its left on q
- This allows complex JI chord progressions that stay within bands and avoid seams
- 5-limit mode constrains prime-5 exponent to ±2 (because `posInBand ∈ {0,1,2}`); diesis (128:125, requires |e5|=3) is unreachable in 5-limit but reachable in 7-limit via syntonic adjustments

### 2.3 Frequency formulas

**5-limit**:
```
freq(q, r) = 220 × 2^bandOf(q) × (5/4)^(posInBand(q)−1) × (3/2)^r
where:
  bandOf(q)    = floor((q+1)/3)
  posInBand(q) = ((q+1) % 3 + 3) % 3
A3 (220 Hz) at (0, 0): bandOf=0, posInBand=1
```

**7-limit**: same base, with region adjustments. The fifths axis is divided into alternating **A (pure)** and **B (septimal)** regions of width `septimalW = 3`, determined by lattice r (not physical rPhys). A regions get syntonic comma cancellation per A-band depth from center. B regions inherit their paired A's adjustment then ×63/64 (septimal comma). Global tempering ×(80/81)^(septimalShift/6) smooths the 42-step cycle. Result: A↔B seams are 64:63, B↔nextA seams are 36:35.

**Equal temperament**:
```
freq(q, r) = 220 × 2^((4q + 7r) / 12)
```
Pure 12-TET. No bands, no regions, no adjustments.

### 2.4 JI ratio between two keys (5-limit)

The ratio `freq(q2,r2) / freq(q1,r1)` factors as `2^e2 × 3^e3 × 5^e5`:
- `e5 = dp` where dp = posInBand(q2) − posInBand(q1)
- `e3 = dr` where dr = r2 − r1
- `e2 = db − 2·dp − dr` where db = bandOf(q2) − bandOf(q1)

In 7-limit, `jiRatio()` extends with prime-7 exponent tracking. Each region adjustment modifies exponents: syntonic ×(81/80) shifts (e2, e3, e5), septimal ×(63/64) shifts (e2, e3, e7).

### 2.5 Septimal seam shift (7-limit only)

Controls position of the A/B region boundaries:
- Range: −21 to 20 (42 positions)
- Wrap: `((s + dir + 21) % 42 + 42) % 42 − 21`
- Controls: ▲/▼ buttons + ArrowUp/ArrowDown keyboard shortcuts (custom repeat timer at animation-frame cadence; browser auto-repeat suppressed)
- ▲ increases septimalShift → seams move +r (upward)

### 2.6 Coordinate system summary

- **q**: position along major-third axis (5:4)
- **r**: position along **fifths** axis (3:2)
- **p**: posInBand(q), position within the 3-wide octave band (0, 1, 2)
- **Minor thirds**: derived direction (−1, +1) in (q, r)
- **Origin**: A3, in the middle of the keyboard

### 2.7 Coverage and analysis findings

- **5-limit**: 55 unique MIDI notes per layout, 79 combined across the 3 layouts
- **7-limit**: 45–46 notes per layout, 118 combined
- **7-limit unique pitches**: ~208–210 unique pitches reachable from any central key (280 keys minus ~70 duplicates from syntonic comma cancellation)
- **Coverage proof**: Q ≡ 7V (mod 12) for all keyboard intervals, where V = 12-TET semitone equivalent and Q = (e3 + 4e5 − 2e7) mod 12. All 12 V-classes covered by the reference table.

### 2.8 Tuning deliverables

A single LTN file configures the Lumatone with the **fixed MIDI layout** — every physical key gets a stable (channel, note) address (see §4.12). HKL handles all tuning interpretation and layout switching at runtime. There are no per-layout LTN files, no .scl/.kbm files, and no external synth configuration to maintain in sync.

Layouts (Natural ♮, Flat ♭, Sharp ♯) are pure software state in HKL; switching layouts changes which lattice positions the keys represent, but does not change the Lumatone's MIDI output addressing.

| Layout | Lattice shift |
|---|---|
| Natural ♮ | (0, 0) |
| Flat ♭ | (+7, −4) |
| Sharp ♯ | (−7, +4) |

---

## 3. Color Scheme

### 3.1 5-limit / 7-limit: 7-hue system

7 hues × {light, dark} = 14 base colors. Plus 14 B-region warm-shifted variants in 7-limit = 28 total.

| Code | Hue | Light (white key) | Dark (black key) |
|---|---|---|---|
| PK | Pink | #FF4C79 | #59002C |
| PU | Purple | #C94CFF | #3E0059 |
| BL | Blue | #4C96FF | #002559 |
| TE | Teal | #4CFFBA | #005937 |
| GR | Green | #55FF4C | #045900 |
| YE | Yellow | #FFF94C | #595600 |
| OR | Orange | #FF884C | #591D00 |

**Hue assignment (unified formula)**:
```
computeHue(q, r) = hueCycle[(floor(midi/12) − bandOf(q) − 2·pairOf(r − septimalShift) − 4) % 7]
where:
  midi = 57 + 4q + 7r
  pairOf(r) = floor((r − septimalShift + 3.5) / 6)
  hueCycle = ['PU','PK','OR','YE','GR','TE','BL']
```

The +3.5 offset in `pairOf` ensures no hex sits on a floor boundary, giving symmetric animation timing.

In 5-limit mode (pair = 0), this reduces to the original `colorTable[q%3][r%12]` lookup.

**B-region warm shift**: B-region keys get `.sl`/`.sd` color variants, 50% lerp toward the next hue in `hueCycle`.

### 3.2 Equal temperament: 3-hue system

3-hue octave cycle using PK, PU, BL only:
```
equalHueCycle[floor(midi/12) % 3]   where equalHueCycle = ['BL','PU','PK']
```
Derived from the Lumatone's standard harmonic table color pattern (`floor(note/12) % 3`) rotated so A3 = purple. No band correction, no pair term, no warm shifts.

### 3.3 Light vs dark (all modes)

Determined by 12-TET equivalent pitch class `(57 + 4q + 7r) % 12`:
- white key (light): pitch class ∈ {0, 2, 4, 5, 7, 9, 11}
- black key (dark): everything else

---

## 4. HKL Feature Set

### 4.1 Display

- **Hex grid** rotated counterclockwise ~34.6° (`tiltAngle = π/2 − atan2(gy, gx)`) so constant-frequency runs horizontally. Gradient: q-axis = log(2)/3 per step (octave constraint), r-axis = midpoint of 5-limit log(3/2) and 7-limit adjusted value.
- **Canvas sizing**: width = max(400, viewport − 24px); height computed from actual keyboard vertical extent + padding `padY = hexR + dxH × 0.5`. Vertical centering via `kbOffY = −(minY + maxY) / 2`. Wrapper has `min-width: 424px`.
- **Rotation handling**: hex shapes drawn in rotated context, note text drawn unrotated for readability.
- **Extend pattern toggle** clamps the cell range to keyboard extent when off.

### 4.2 Controls (two rows, centered)

**Row 1**: Layout selector (♭ ♮ ♯), Note names, Band seams, Extend pattern, Show coordinates, Short intervals.

**Row 2**: Tuning selector + seam shift | Transpose controls | Audio + Instrument | Clear | Lumatone status panel | Recording controls | Reset prefs.

- **Tuning selector**: dropdown {Equal, 5-limit, 7-limit}. Sets internal flags, shows/hides seam shift, ramps audio.
- **Seam shift**: ▲/▼ buttons with value display; visible only in 7-limit. Key-repeat 400ms initial / 80ms subsequent. ArrowUp/Down keyboard shortcuts use a custom repeat timer.
- **Transpose**: 5-axis ▲/▼ stacks (P5, M3, m3, P8, SC) always visible. Same key-repeat behavior.
- **Audio**: toggle + instrument/waveform selector. Piano default. Samples lazy-load on first selection with blue "loading…" state.
- **Clear**: deselects all.
- **Lumatone status panel**: connection badge (green/red), **Pedals dropdown** (Sustain / Sostenuto+Sustain — controls how the sustain jack is interpreted, see §4.14), **Calibrate Pedal button**, Auto-sync checkbox + status badge.
- **Recording controls** (see §4.13): ● Rec / ▶ Play / Save .hkr / Load .hkr / Export .mid / Import .mid + a status pill.

### 4.3 Keyboard shortcuts

- **ArrowLeft / ArrowRight**: cycle layout (♭ → ♮ → ♯ → ♭)
- **ArrowUp / ArrowDown**: septimal seam shift (no-op outside 7-limit)
- `shouldIgnore()` detects text input focus and lets keystrokes through; outside text inputs, focused checkbox/radio is blurred on arrow press
- Browser auto-repeat suppressed; custom repeat timers handle held keys
- Keyup only stops repeat if up-key matches active down-key (prevents stuck-key)

### 4.4 Selection and interaction

- **Click**: toggle key on/off
- **Shift+click**: exclusive select
- **Clear button**: deselect all
- **Mouse hover**: `hoverKey` tracks hovered key; renderer draws distinct highlight outside selection treatment; cleared on mouseleave
- **Selected keys**: brightened fill (+90), white border ring at hex edge; persists through layout switches

### 4.5 Layout animation (500ms)

- Smoothstep position easing
- View center (`viewQ`, `viewR`) animates from old to new
- Key selections shift by layout delta
- Audio voices ramp frequencies over animation duration (sustained instruments glide; decaying instruments stop+retrigger at end)
- Keyboard outline and dark overlay remain static (precomputed from baseKey geometry)

### 4.6 Chord transposition (5 axes)

P5 (0, +1), M3 (+1, 0), m3 (−1, +1), P8 (+3, 0), SC (−7, +4).

- **Bounds check**: blocked if any note's screen center would leave canvas
- **Audio**: 100ms slide via exponentialRampToValueAtTime; sustained samples use sSlideAndFadeOut/sNoteOnFaded; decaying instruments stop+retrigger
- **MIDI**: stopAllMidi() + syncMidi() after re-keying
- No-op when nothing selected

### 4.7 Note naming

`fifthName(r)` algorithmically computes note names for any fifths distance. Accidentals rendered as decomposed Unicode glyphs (♯, ♭, 𝄪, 𝄫) with continuous font scaling (`scale = min(1, maxW/totalW)` where `maxW = hexR × 1.3`) and double-flat cascade nudge (`i × −fontSize × 0.14`).

### 4.8 Info panel

A scrollable panel below the canvas (max-height constrained to viewport):

- **Row 1 — Note cards**: each selected key as a colored tag (note name in keyboard hue, octave, frequency Hz). Sorted low to high. With "Show coordinates" enabled, also shows `(q=… r=… p=…)`.
- **Row 2 — Chord analysis** (3–4 unique pitch classes): root (colored), quality name, inversion, root-position JI ratio. Template matching uses semitone intervals + letter distances. 25 templates: triads (major, minor, diminished, augmented, sus4, sus2, Pythagorean), seventh chords (major, dominant, minor, minor-major, diminished, half-diminished, augmented, augmented major), added-second chords, augmented sixth chords (Italian, French, German), incomplete sevenths (dominant, minor, major, minor-major, diminished). Chords labeled "septimal" when root-position ratio has a factor of 7 AND max term ≤ 27. Equal mode: ratio hidden, "septimal" prefix stripped.
- **Rows 3+ — Intervals**: all pairwise intervals grouped by generic interval size. Each shows colored note names with octaves, cents, and named interval.
  - 5-limit / 7-limit: JI ratio displayed; color-coded by complement-reduced Tenney Height: green (TH < 8), yellow (8–12.5), red (≥12.5)
  - Equal mode: no ratio. Standard names via `equalIntervalName()` (computes from actual note names + octaves, NOT lattice displacement). Intervals where `semis % 12 === 0` are green (rational ratios — unisons, octaves, enharmonic spellings d2/A7); everything else is red.

### 4.9 Short intervals mode

"Short intervals" checkbox applies `shortenInterval(name)` post-processor in three phases:
1. Full-phrase specials (harmonic→7m, lesser/greater septimal tritones)
2. Word-by-word abbreviations (P/m/M/d/A, ordinals→cardinals, comma terms SC/7C/PC/7D/A1/Ds/Sc/D/A/C)
3. Structural cleanup (strip spaces, re-insert around ±)

Uses HTML entities for lesser/greater glyphs.

### 4.10 Interval naming: reference table + comma decomposition

Every 5/7-limit interval is expressed as a named reference interval ± commas, with zero information loss.

**Algorithm**:
1. Factor the ratio into prime exponents (e2, e3, e5, e7) via `factor7()`. Large ratios whose num/den exceed 2^53 use the `e` vector returned by `reduce()` rather than trial-dividing num/den (which would silently lose precision).
2. Octave-reduce to [1, 2), counting extra octaves
3. Try **direct decomposition** against all reference entries
4. Try **complement decomposition** (2/ratio against all refs)
5. Pick result with fewest displayed comma groups, tiebreak by fewer total items, then lower TH, then direct over complement
6. Format: compound ordinals absorb octaves ("minor 10th"); non-ordinals prepend ("2 octaves + apotome")

**Octave-multiple naming**: pure octave multiples with no reference interval and no commas are named ET-style: "perfect octave" (2:1), "perfect 15th" (4:1), "perfect 22nd" (8:1), etc.

**Comma basis** (7 commas, 3 linearly independent): syntonic 81/80, septimal 64/63, schisma 32805/32768, Pythagorean comma 531441/524288, plus three derived commas. The optimizer tries all 6 permutation orderings of derived comma substitutions.

**Pythagorean reference entries**: 256:243 (m2), 9:8 (M2), 32:27 (m3), 81:64 (M3), 27:16 (M6), 243:128 (M7), 531441:524288 (Pythagorean comma).

**Reference table size**: ~60 entries, covering full augmented/diminished interval space.

**Score function**: `groups × 100 + items`, TH tiebreak.

### 4.11 Lumatone integration (output)

#### Auto-sync architecture

- **Auto-sync checkbox** + sync status badge replace older Retry/Push UI
- On every state change affecting colors, `syncLumatoneColors()` computes the 280-entry target, diffs against tracked `deviceColors`, and queues only the changes
- **Visual wipe sort**: changed keys pushed in +q (left-to-right), −r (top-to-bottom) order
- **In-flight race handling**: if a SysEx is awaiting ACK when a new sync kicks off, its color is folded into the predicted snapshot so the diff accounts for what the device is about to become
- **Queue swap, not restart**: a new sync replaces `sysexQueue` without cancelling the in-flight message, which finishes naturally before the new queue proceeds
- `sysexCancelAll()` tears down everything when Auto-sync is turned off

#### On-connect setup

On first auto-sync after `findLumatone()` succeeds:
- 280 × `CHANGE_KEY_NOTE` (fixed MIDI layout)
- `SET_AFTERTOUCH_FLAG (0x0E) = 1`
- `SET_LIGHT_ON_KEYSTROKES (0x07) = 1`
- `queryFirmwareRevision()` (silent; response logged)

#### Pedal calibration

- **Calibrate Pedal button** in Lumatone status panel toggles calibration mode
- **Active state**: panel below canvas shows live ADC min/max bounds (parsed from spontaneous CMD 0x3E packets) and valid flag. No CC4 live readout — firmware suppresses CC4 emission during cal mode (it sends 0x3E instead), so a "live" CC4 number inside the cal panel would be misleading.
- **Reset to Factory button** in panel sends CMD 0x39
- **Maximum debug logging** in console while cal mode active: every CMD 0x3E packet (first + every 10th in raw hex), every CC 4 message with timing, calibration entry/exit events
- **Outside cal mode**: minimal CC 4 logging (endpoints only)

### 4.12 Lumatone integration (input)

`handleMidiMessage(e)` dispatches:
- **SysEx CMD 0x3E** → calibration packet handler
- **Other SysEx** → `sysexHandleResponse` (ACK matching for queue)
- **CC 4** (expression jack) → continuous damper depth: `pedal.cc4Depth = d2/127`, then `setDamperDepth()`. Verbose debug log during calibration; outside cal mode, only endpoint hits (0/127) are logged.
- **CC 64** (sustain jack) → role depends on `pedal.mode`: in `'sustain'` mode it's binary damper (`pedal.cc64Depth = d2 ≥ 64 ? 1 : 0`, then `setDamperDepth()`); in `'sostenuto'` mode it calls `sostenutoOn()`/`sostenutoOff()` and does not touch damper depth.
- **Note on/off** → audio + selection. Note-off branches on `audio.sustainPedalDown || audio.sostenutoLockedKeys.has(key)`: keep-sustained or release.
- **Polyphonic aftertouch (0xA0)** → per-voice volume modulation

Note routing uses the **fixed MIDI layout**: every physical key has a stable (channel, note) address. `fixedMidiToKey(ch, note)` converts at MIDI-input time. Channels 0–4 = the five board groups. Notes 0–55 = key index within board.

### 4.13 Recording, playback, and MIDI round-trip

HKL records every performance — Lumatone, QWERTY, or mouse — as a stream of lattice-coordinate events, plays it back through the audio engine, and exchanges `.mid` files with external DAWs for editing.

#### Architecture

- **`.hkr` (JSON, source of truth)**: layout snapshot (tuning system, 5-limit layout, 7-limit shift, instrument, pedal mode, A3 reference) + a flat event list `[{t, k, q, r, …}]`. Schema version-stamped (`format:"hkr", version:1`); event kinds are `on / off / pa / cc4 / cc64 / warn` keyed by `k`. Timing is `audioCtxSec` from `epoch=0` (the same clock the audio engine ramps schedule against).
- **`.mid` (binary, derived view)**: exported and re-imported deterministically against the same snapshot. The two files travel separately — they are NOT bundled.
- **MPE export**: single-track format-0 MIDI. Channel 1 is the manager (carries CC4/CC64 + MPE Configuration Message); channels 2–16 are members (one voice each). Per-member pitch-bend range = ±48 semitones via RPN 0, wide enough that any JI offset fits even when the 12-TET snap chooses an adjacent semitone. Tempo fixed at 120 BPM, PPQ 960.
- **MIDI → `.hkr` inverse**: requires the originating snapshot (the UI prompts: "Load matching .hkr first"). Builds a frequency index over the lattice under the snapshot's tuning, then each MIDI noteOn's `(note, channel-bend)` triple is converted to frequency and nearest-matched against the index. 25-cent sanity gate — anything farther emits a `warn` event instead of a coordinate.

#### Capture point

The recording hooks live **inside the audio engine**, not at the MIDI input handler. This is the convergence point for every input source: Lumatone notes (after `(channel, note) → (q, r)` translation), QWERTY presses, and canvas clicks all flow through `audio.noteOn`/`noteOff` before sounding. Hooking once here means a single line per engine entry point catches everything; the alternative (per-input-source hooks) would scatter capture across `midi/handler.ts`, `input/keyboard-notes.ts`, and the canvas click handler. CC4/CC64 capture lives in `setDamperDepth` + `sostenutoOn/Off`; poly aftertouch in `handleAftertouch`.

Hooks short-circuit when `audio.audioEnabled === false`, which means silent input is not recorded — documented as a "feature not bug" since recording without audio is meaningless.

#### Playback

Web-Audio look-ahead scheduler (Chris-Wilson pattern): a 25 ms `setTimeout` loop walks events that fall within the next 100 ms window against `audio.audioCtx.currentTime`, schedules a per-event `setTimeout` to dispatch at the right moment. Dispatch routes per `k`:
- `on` → `noteOn` + add to playback ledger + add to `selection.selectedKeys` + `draw()`
- `off` → `noteOff` + remove from ledger + remove from `selectedKeys` + `draw()`
- `pa`  → `handleAftertouch`
- `cc4` → `pedal.cc4Depth = v; setDamperDepth()`
- `cc64` → routes through `setDamperDepth()` (sustain mode) or `sostenutoOn/Off` (sostenuto mode), per the snapshot's `pedalMode`

The playback **ledger** (`playbackKeys: Set<KeyId>`) tracks voices created by playback only — stopPlayback releases those, leaving any user-held voices alone. Live user input (Lumatone, QWERTY, mouse) is allowed during playback and mixes with playback audio.

Applying the snapshot at play-start drives the existing control handlers (`setTuning`, `setLayout`, `changeWaveform`) so all side effects fire (color sync, info-panel refresh, prefs persistence). Sample-based instruments are awaited if not yet loaded.

#### Transport

Three states: `idle | recording | playing`, mutually exclusive. State lives module-private in `recording/capture.ts` and `recording/playback.ts`; the UI in `ui/recorder.ts` reads via `isRecording()` / `isPlaying()`.

Auto-balance on transitions: starting Record emits synthetic `on` events at t=0 for any currently-held voices; stopping Record emits synthetic `off` events for any voice still held. The recording is therefore self-balanced — playback never produces stuck notes.

#### UI

A control group in the toolbar after the Lumatone status block: Rec / Play / Save .hkr / Load .hkr / Export .mid / Import .mid + a `recording-status` pill ("Idle" / "Recording 0:04" / "Playing 0:02 / 0:18" / "Loaded 0:18"). The status timer runs only while state ≠ idle (via `requestAnimationFrame`).

`?hklrec=1` URL param exposes `window.__hkl_rec` with `getSession()`, `setSession(s)`, and `selfTestRoundTrip()` — for in-DevTools verification.

#### Audio capture (sidecar .wav)

Independent of `.hkr` capture, a "Capture audio" toggle in the Recording group brackets the master-bus output of every record-or-playback span and downloads it as a 44.1 kHz / 16-bit stereo `.wav` named `hkl-<isoStamp>.wav`. The tap is an `AudioWorkletNode` (`src/audio/capture-worklet.js`) connected as a parallel sink off `audio.limiter` — `limiter → destination` (existing) is untouched; `limiter → captureNode` runs alongside while capturing. The worklet copies stereo Float32 frames per `process()` block and `postMessage`s them to the main thread, where `src/audio/capture.ts` accumulates chunks and hands them to `encodeWav16()` in `src/audio/wav.ts` on stop.

The capture span ends 1.5 s after the user-visible Stop / playback-end so sample release tails and oscillator envelope releases land in the file. `.wav` is *not* bundled with `.hkr` — it's a separate download that travels alongside the `.hkr` for the same isoStamp. This path is faithful to the engine output (post high-shelf, post limiter) where `.hkr` re-render through a non-HKL synth would not be. It also lays the foundation for a future offline-render mode.

#### Out of scope for v1

- **Layout change mid-record**: detected (snapshot vs live mismatch), emits a single `warn` event the first time it diverges, otherwise continues recording against the original snapshot.
- **Paused playback**: no pause state in v1.
- **Bundled `.hkr` + `.mid`**: files stay separate.
- **Tempo / time signature in `.hkr`**: not modeled. MIDI export uses fixed 120 BPM 4/4 so DAW quantizers have something to grid against.
- **Lilypond export**: the `.hkr` schema is designed to support it (coordinates + snapshot are all an exporter needs), but the exporter itself is future work.

### 4.14 Audio engine

`SampleEngine` IIFE module encapsulates sample loading, voice lifecycle, and segment scheduling.

#### Signal path
```
sample → segGain (crossfade) → voiceGain (envelope) → damperGain → pressureGain → master
osc    →                       gain      (envelope) → damperGain → pressureGain → dest
```

`damperGain` is the continuous-damper modulation node (default 1.0; ramped via `setTargetAtTime` while the key is in `sustainedKeys`; pinned to 1.0 for sostenuto-locked keys). `pressureGain` is the polyphonic aftertouch node (default 1.0). They sit downstream of the release envelope so neither modulation fights `voiceGain`/`gain` cancel-schedule patterns.

Gain constants: `sampleMaster = 1.0`, `oscGain = squareGain = 1.0` (pass-through; per-waveform target amplitude is in the per-note `vol`). Damper smoothing: `DAMPER_SMOOTH_TAU = 0.025` (≈25ms exponential τ for `setTargetAtTime`); below `DAMPER_RELEASE_FLOOR = 0.005` damper depth, sustained voices not protected by sostenuto are released.

#### Per-sample gain normalization
Every sample entry carries a precomputed `gain` (linear scalar) that brings its measured RMS to a uniform target of **−18 dBFS**, with a single-voice peak ceiling of −3 dBFS to prevent transient clipping. Applied once at `sNoteOn` (`vol *= nearest.gain`). Oscillators carry equivalent target amplitudes baked into the per-note `vol`: sine ≈ 0.1779, triangle ≈ 0.2179, square ≈ 0.1259 (so steady-tone RMS = TARGET_RMS for all three). Low-frequency Fletcher-Munson boost on sine/triangle is preserved. See decisions.md for rationale; see `analyzer/backfill-gains.js` and the §6 analyzer notes for how the values are computed.

#### Velocity curve
`0.10 + 0.90 × (vel/127)²` — quadratic with 10% floor.

#### Range attenuation
`rangeAttenuation` tapers volume above the highest sampled note in an instrument.

#### Voice anchors (wrap-aligned segment switching)
`sourceStartTime`, `sourceStartOffset`, `sourceLoopA`, `sourceLoopB`, `sourceLoopAIdx`, `sourceLoopBIdx`, `sourceRate`. All wraps via `scheduleSegmentSwitch`; `source.loop = true` is never used. Switch picks `b` (next wrap), then uniformly picks `a` from `validStartsByEnd[b]`. Linear 30ms equal-power crossfade. `doImmediateSwitch` for wrap-during-ramp.

#### Frequency ramping
- **Layout switches**: 500ms (`animDuration`); sustained instruments glide, decaying instruments stop+retrigger
- **Tuning/seam changes**: 150ms via `rampActiveFreqs()`
- **Transpositions**: 100ms

#### `commitRampSync` race handling
Integrates in-flight ramp sync before starting a new one. `pendingRamp` identity check cancels stale re-anchors. Position-based wrap check fixes stale-anchor race in rapid `sRampFreq` calls.

#### Polyphonic aftertouch
Per-voice `pressureGain`. Velocity-anchored handover: when AT message arrives, voice gain ramps from current to AT-implied target with `AFTERTOUCH_RAMP_S` smoothing.

#### Pedal semantics

Two pedal jacks (CC 4 = expression jack continuous, CC 64 = sustain jack binary) feed a unified damper-depth model plus an optional sostenuto layer. The Pedals dropdown selects what the sustain jack does:

**Sustain mode** (default, no expression pedal needed): both jacks contribute to damper depth. `pedal.cc4Depth` (0..1) and `pedal.cc64Depth` (0 or 1) are combined as `max()` into `audio.damperDepth`. CC 64 alone gives the classic binary-sustain experience; CC 4 alone (or both together) gives continuous damper.

**Sostenuto+Sustain mode** (with continuous expression pedal plugged in): CC 4 is the only damper source. CC 64 toggles a sostenuto layer that snapshots `selection.selectedKeys` at sostenuto-on into `audio.sostenutoLockedKeys`. Locked notes ride through any subsequent damper-pedal change.

State:
- `audio.damperDepth` — current effective damper depth, 0..1
- `audio.sustainPedalDown` — mirrors `damperDepth > 0` (single-bit "is the damper engaged at all"); kept for note-off keep-or-release branching
- `audio.sustainedKeys` — keys released physically but still sounding because either pedal holds them
- `audio.sostenutoActive` / `audio.sostenutoLockedKeys` — sostenuto layer
- `pedal.mode`, `pedal.cc4Depth`, `pedal.cc64Depth`, `pedal.lastCC64Value` — input-side routing state

Engine API:
- `setDamperDepth()` — recomputes `audio.damperDepth = max(cc4, cc64)`, updates `sustainPedalDown`, walks `sustainedKeys` applying the new depth (skipping sostenuto-locked keys), and runs the per-key release sequence when depth crosses below `DAMPER_RELEASE_FLOOR`.
- `sostenutoOn()` — `sostenutoLockedKeys = new Set(selectedKeys)`; pins those voices' `damperGain` to 1.0 immediately (no ramp) so locked notes ring at full volume regardless of damper depth at the moment.
- `sostenutoOff()` — clears the locked set; for each previously-locked key still in `sustainedKeys`, either re-applies current damper depth (if damper engaged) or releases (if damper is up).

Continuous-damper behavior is **gain-based**, not release-time-based: a per-voice `damperGain` node attenuates sustained ringing in proportion to `(1 − depth)`. Half-pedaling produces audibly attenuated ringing in real time, not a deferred decay rate. See `decisions.md` for the rationale.

Sostenuto-locked keys are exempt from damper attenuation while locked — their `damperGain` stays at 1.0 even with `damperDepth < 1`. This matches piano physics (the sostenuto rod lifts dampers off the locked strings entirely) and prevents the half-damper from attenuating notes that should be unaffected.

Mode-dropdown change at runtime re-evaluates the held CC 64 state (`pedal.lastCC64Value`) so a held sustain pedal isn't stranded when the user toggles between sustain and sostenuto modes mid-press. Wired in `ui/init.ts`.

Re-articulation: striking a sustained key triggers `noteOff` + new voice + flash (`triggerRearticulateFlash` / `rearticulateFlashUntil`). The new voice gets a fresh `damperGain = 1.0`; the next note-off path that adds it to `sustainedKeys` re-applies current `damperDepth`.

#### Instruments

Roughly 15 sample-based + 3 oscillator voices in the dropdown today. The set rotates as new sources are audited; see `samples-data.ts` for the authoritative list and `index.html`'s `<select id="waveform">` for what's currently visible. Categories:

- **Decay/non-looped**: piano (Salamander), electric_piano, harpsichord, harp, acoustic_guitar.
- **Sustained/looped, no vibrato (macro-period)**: clarinet, trombone, organs (pipe / renaissance / drawbar).
- **Sustained/looped, vibrato**: violin / viola / cello, flute.
- **Oscillators**: triangle, sine, square — peak-amplitude tuned to match the −18 dBFS RMS target.

Source vendor selection is empirical per-instrument, not categorical. FatBoy works for clarinet but failed clarinet's mid/upper register on the MusyngKite render; FluidR3 ships strings/flute/trombone but its french horn was rejected; VCSL ships chamber/renaissance organ but doesn't have oboe or horn at all. Try multiple sources via the analyzer before settling. Oboe and French horn share an algorithm-side blocker — see `lessons.md` "Soundfont and real-instrument oboe/horn share a single wall."

The dropdown in `index.html` is hand-maintained — `samples-data.ts` is NOT auto-enumerated. Adding an instrument requires both the `samples-data.ts` splice (via `analyzer/insert-instrument.js`) AND an `<option>` line in `<select id="waveform">`. See the `add-instrument` skill.

`SampleEngine.INSTRUMENTS` registry contains `{name, baseUrl, ext, releaseTime, volume, loop, decays, [vibrato], [filePattern], samples[]}` per instrument, with each sample carrying `{name, freq, gain, [loopPts, validStartsByEnd, trimStart, slopeCV]}`. The `filePattern` field defaults to `'{NOTE}{ext}'` if absent; runtime URL builder applies `#`→`%23` encoding.

---

## 5. Internal Subsystems

Implementation-level notes. For module/file layout see the **Module Structure** section near the end of this document.

### 5.1 Render pipeline

**Offscreen build** (on dirty flags):
- `hexCanvas`: colored hex fills for entire extended grid, B-region warm-shifted in 7-limit, 3-hue formula in Equal mode
- `textCanvas`: note name labels on transparent background, scalable accidentals

`hexDirty` / `textDirty` flags minimize rebuilds:
- septimalShift only dirties hex layer
- note names only dirty text layer
- resize/extend dirty both
- Layout switches are zero-cost (pure offset change)

**Per-frame draw**:
1. Blit hexCanvas + textCanvas at view-offset
2. Selection highlights (brightened fill + white ring) in rotated context
3. Hover highlight if `hoverKey` set
4. Re-articulate flashes (timestamp-gated)
5. Lattice seams (skipped in Equal mode); endpoint snap to outline vertices via power-6 curve `|2t−1|^6` during animation
6. Dark overlay with outline polygon cutout (opacity 0.65 with extend, 1.0 without)
7. Keyboard outline (3.5px white stroke, round joins)

### 5.2 Outline geometry (precomputed)

- `kbOutlinePaths`: array of closed polygon paths in baseKey screen coordinates
- Computed at init via topology tracing with `edgeIsect`
- `snapVtx(px, py)`: nearest outline vertex within 6px for seam endpoint snapping (no segment projections, no flanking hex logic)

### 5.3 Output / input plumbing

- `syncAudio()` — diffs active voices against selection
- `syncMidi()` — sends noteOn/noteOff in parallel
- `syncOutput()` — both
- `handleMidiMessage(e)` — see §4.12

### 5.4 Recording subsystem

Three module groups:

- **`src/recording/`** — domain logic, no DOM.
  - `types.ts` — `HkrSession`, `HkrEvent` discriminated union, `LayoutSnapshot`.
  - `clock.ts` — `nowSec()`, sources from `audio.audioCtx.currentTime` with `performance.now()` fallback.
  - `snapshot.ts` — `captureSnapshot()` + `snapshotMatchesLive(s)`. Kept leaf-position in the dep graph because `capture.ts` imports it.
  - `apply.ts` — `applySnapshot(s)`. Pulled out of `snapshot.ts` to avoid a cycle through `ui/controls.ts` (which the snapshot apply must call into for side effects).
  - `capture.ts` — module-private buffer + per-event recorders (`recordOn`, `recordOff`, `recordPa`, `recordPedalDepthsChange`, `recordSostenuto`). Auto-balances on start (synthetic ons for held voices) and stop (synthetic offs for still-held voices).
  - `playback.ts` — look-ahead scheduler + playback ledger + dispatch routing. Owns its own per-key `Set` so Stop releases only playback's contributions.
  - `hkr.ts` — JSON serialize/parse with field validation; emits `HkrParseError` on schema mismatch.

- **`src/midi-io/`** — `.hkr` ↔ MIDI, no DOM.
  - `allocator.ts` — `MpeAllocator` (LRU over channels 2..16; on exhaustion evicts oldest and emits forced note-off on the same channel).
  - `mpe.ts` — `coordToMidi(q, r, snapshot) → {note, bend14}` and `midiToFreq(note, bend14)`. Anchored on MIDI 69 = A4 = 440 Hz (the MIDI-standard reference); HKL's A3 = 220 Hz lies at MIDI 57.
  - `export.ts` — `sessionToMidi(session)`. Builds the MPE Configuration Message + per-member RPN bend-range preamble, walks events, sorts by `(t, ord)`, emits via `midi-file`.
  - `import.ts` — `midiToSession(bytes, snapshot)`. Builds a `freqIndex` over the lattice (q ∈ [-30,30], r ∈ [-16,16]) under the snapshot's tuning; nearest-frequency match with 25-cent gate. `selfTestRoundTrip(snapshot)` is exported for the `?hklrec=1` debug harness.

- **`src/ui/recorder.ts`** — DOM glue only. Transport buttons, hidden `<input type="file">` triggers, Blob+URL downloads, `recording-status` text driven by `requestAnimationFrame` while active. `initRecorderUI()` is called once from `ui/init.ts`.

The capture-point hooks live in `src/audio/engine.ts` (one line per entry point: `noteOn`, `noteOff`, `handleAftertouch`, `setDamperDepth`, `sostenutoOn`, `sostenutoOff`). The hooks no-op when `isRecording()` is false.

### 5.5 SysEx queue

Encapsulated in `lumatone/sysex.ts`: private state, public API (`enqueueControl`, `replaceQueue`, `cancel`, `handleResponse`, `queryFirmware`, `inFlight` getter, `isInProgress` getter).

- Single-message-in-flight ACK queue. Internal: queue array, waiting message, ACK timer, busy-retry timer.
- Constants: `SYSEX_TIMEOUT_MS = 2000`, `SYSEX_BUSY_DELAY_MS = 500`, `SYSEX_NOINPUT_DELAY_MS = 35`
- Status bytes: `SYSEX_NACK = 0x00`, `SYSEX_ACK = 0x01`, `SYSEX_BUSY = 0x02`
- BUSY → retry after delay; NACK/ERROR → log and proceed
- `pushTotal` / `pushSent` / `pushInProgress` track UI for the visible color-sync push; `pushSilent` skips UI updates for control-path messages (firmware query, calibration)
- See `decisions.md` for the queue-swap-vs-cancel choice (Option B).

### 5.6 Key constants

```
hexR = 16          # hex circumradius in CSS px
dxH = hexR * 1.78  # horizontal spacing between hex centers
dyH = hexR * 1.54  # vertical spacing between hex rows
tiltAngle ≈ 34.6°  # counterclockwise rotation
outR = hexR + 1    # outline offset from hex centers
septimalW = 3      # 7-limit region band width along r-axis
animDuration = 500 # layout animation duration in ms
sysexBoardMap = [1,2,3,5,4]
fixedMidiChannelMap = [0,1,2,3,4]
AFTERTOUCH_RAMP_S
REARTICULATE_FLASH_MS
DAMPER_SMOOTH_TAU      # ~25ms exponential τ for setTargetAtTime damper smoothing
DAMPER_RELEASE_FLOOR   # below this depth, sustained voices release through normal noteOff
```

### 5.7 Key data structures

- `baseKeys`: 280 [q, r] pairs defining physical keyboard shape (5 boards × 56 keys), in natural-layout coordinates
- `colorTable`: 3×12 array, `(q%3, r%12) → hue code` (5-limit fast path)
- `equalHueCycle`: `['BL','PU','PK']`
- `hueC`: hue code → {l, d, sl, sd} hex strings
- `hueCycleOrder`: `['PU','PK','OR','YE','GR','TE','BL']`
- `layoutShifts`: `{1: [0,0], 2: [7,−4], 3: [−7,4]}`
- `degreeMap`: `(r,p) → scale degree (0–78)` — internal pitch-class index used by tuning math
- `midiToKey`: fixed-layout reverse lookup `(channel,note) → "q,r"`
- `deviceColors`: 280-entry tracked device state for diff-based auto-sync
- `kbOutlinePaths`: precomputed outline polygons
- `kbBaseSet`: Set of `"bq,br"` strings for all baseKeys
- `REF`: ~60 reference interval entries
- `chordTemplates`: 25 chord templates
- `SampleEngine.INSTRUMENTS`: 14 sample-based instruments (13 visible + 1 hidden oboe) + their precomputed loop-point data

---

## 6. Companion Tool: HexKeyLab-analyzer

Not shipped with HKL. Used offline to generate `loopPts`, `validStartsByEnd`, `trimStart`, `slopeCV`, and `gain` baked into `SampleEngine.INSTRUMENTS`. Two entry points: the in-browser `analyzer/HexKeyLab-analyzer.html` (interactive, exposes the same algorithms) and the Node-based pipeline under `analyzer/` (`generate-samples.js` for new instruments, `backfill-gains.js` for adding `gain` to existing entries without disturbing loop points).

### 6.1 URL templating

Both the analyzer (Node) and the runtime engine build sample URLs from the same metadata, so config changes propagate end-to-end without engine edits.

- `filePattern`: `'{NOTE}{ext}'` default; non-default values like `'RenOrgan_8foot_Room_{NOTE}_rr1.wav'` (chamber organ) are emitted into `samples.ts` and consumed by `SampleEngine.loadInstrument` at line 559.
- `noteStyle`: enumeration controls enharmonic spelling.
  - `'flat'` — `Bb`, `Db`, `Eb`, `Gb`, `Ab` (gleitz/FluidR3/MusyngKite/FatBoy default).
  - `'sharp'` — `C#`, `D#`, `F#`, `G#`, `A#` (VCSL).
  - `'sharp_s'` — `Cs`, `Ds`, `Fs`, `Gs`, `As` (nbrosowsky/tonejs-instruments — `s` suffix is filename-safe).
  - `'sharp_lower'` — `c#`, `d#`, `f#`, `g#`, `a#` (peastman/sso, lowercase letters).
  - `'salamander'` — sparse map `{0:'C', 3:'Ds', 6:'Fs', 9:'A'}` paired with sparse sampling.
- `noteSemis`: list of per-octave semitones to enumerate. Default `[0..11]` (chromatic). Wholetone-sampled sources use `[0,2,4,6,8,10]`; minor-third-sampled use `[1,4,7,10]`; etc.
- `transpose`: rational ratio expressing audio fundamental ÷ filename label. Defaults to 1. `2` for Hammond convention (filenames an octave above audio). `0.5` for chamber organ (audio an octave above labels). Generalizes to any rational interval offset.
- Sharp `#` characters in any constructed URL are URL-encoded as `%23` automatically by both `buildUrl` (analyzer) and `SampleEngine.loadInstrument` (runtime).

### 6.2 Per-instrument gate overrides (`gateOpts`)

Configurable per instrument: `rmsGate`, `specGate`, `cliqueThreshold`, `minSpacingSec`, `minBackwardSec`, `minForwardSec`, `xfadeSec`, `rmsStepThreshold`, `fwdStabilityThreshold`, `fwdStabilitySec`.

**Defaults are surprising — read before tuning**: `cliqueThreshold` and `rmsStepThreshold` both default to **0.25** (lower is *tighter*, higher is *looser*). `fwdStabilityThreshold` defaults to **0.10** (±10% RMS deviation in a 300ms forward window; `Infinity` disables). The reed_organ's `cliqueThreshold: 0.15` is a tightening, not a loosening — its samples are unusually steady. See `lessons.md` and `decisions.md` for the brass-killer-by-design rationale on `fwdStabilityThreshold`.

### 6.3 Macro-period algorithm (`prepareLoopMacroPeriod`)

- Steady region detection via RMS envelope (50ms window, 10ms hop, ≥70% peak runs)
- Anchor candidates at quartile positions; pick anchor with largest qualifying-N pool
- At each candidate N: compare 60ms Hann-windowed FFT log-magnitude spectrum + RMS to anchor; gate by `rmsGate`, `specGate`
- Score = `rmsRel × 10 + specMse`; `minSpacing` filter preserves diversity
- Snap each pick to nearest +going zero crossing within ±T/2 whose local slope matches anchor's
- Returns `trimStart`, `loopPts[]`, `slopeCV` (std of slope / mean slope)

### 6.4 Freq-guided algorithm (`prepareLoopFreqGuided`)

Fallback for clean periodic samples. Places K·T target positions in a loop window around the anchor, locks each to the nearest high-correlation +ZC within ±T/2. `corrThresh` default 0.85.

### 6.5 Vibrato-aware pipeline (`prepareLoopVibrato`)

For instruments flagged `vibrato: true` (violin, viola, cello, flute, drawbar_organ).
- RMS envelope (20ms window, 5ms step, ±30ms smoothing); pitch via zero-crossing period tracking
- Auto-select AMP or PITCH signal by higher coefficient of variation
- Hysteresis state machine (H = 0.5 × std) extracts vibrato cycle boundaries
- Consistency filter: keep only loop points within [0.75, 1.25] × median vibrato period spacing
- Two-pass correlation-based waveform-phase snap

### 6.6 Backward-clique filter (`filterToBackwardClique`)

Shared post-process for all three algorithms.

- **Pair quality metric** `xfadeDev(a, b)`: midpoint RMS deviation over central 20% of a 30ms crossfade window
- **Amplitude-step gate** `ampStepDev(a, b) = |envRms[a] − envRms[b]| / max(envRms[a], envRms[b])` where envRms is 50ms-window envelope. Orthogonal to phase coherence.
- Edge in graph iff `xfadeDev ≤ cliqueThreshold` AND `ampStepDev ≤ rmsStepThreshold`
- Max-clique growth around each candidate; minimum-spacing collapse drops redundant points
- Output: `validStartsByEnd[b]` (graph form) ready for runtime consumption

### 6.7 Tier color coding

Result rows colored by algorithm + quality:
- `mp-{red,yellow,blue,green}` — macro-period (clique size + slopeCV + span)
- `fg-{red,orange,blue}` — freq-guided (kept-point count)
- `vb-{red,yellow,blue,green}` — vibrato (mirrors macro-period)
- `legacy` — deep-fallback correlation-anchor path

### 6.8 Validation

Final pairwise correlations across kept loop points typically ≥ 0.99 for a good sample. Bimodal clusters indicate mixed phases; two-pass re-anchoring isolates the main cluster. Tier color gives quick visual check on sample quality across the range.

### 6.9 RMS-normalization gain

After loop / decay analysis, each sample is measured for amplitude:

- **Loop instruments**: RMS over the steady region returned by `findSteadyRegion` (50 ms RMS window, 10 ms hop, ≥70% peak run). Vibrato instruments pre-smooth the curve over ±150 ms so AMP cycles don't shatter the steady span. The peak amplitude over the same window bounds the gain so a single-voice peak post-boost ≤ −3 dBFS.
- **Decay instruments**: peak 100 ms RMS window post-trimStart, slid in 20 ms hops. Shorter than the 500 ms window used for pitch refinement because amplitude wants perceptual loudness (transient sources decay quickly), not pitch stability.

`gain = min(TARGET_RMS / rms, TARGET_PEAK / peak)`, clamped to `[GAIN_MIN, GAIN_MAX]`. Constants live in both `analyzer/generate-samples.js` and `analyzer/backfill-gains.js`: `TARGET_DBFS = −18`, `PEAK_DBFS = −3`, `GAIN_MIN = 0.1`, `GAIN_MAX = 8.0` (sanity bound; the peak ceiling is the real limiter).

The Node analyzer emits `gain` directly into the per-sample object alongside `freq`. The standalone `backfill-gains.js` patches the same field into existing entries in `src/audio/samples.ts` in place — useful for adding normalization to instruments whose loop data was generated before the field existed (trombone, reed_organ) without re-running their full loop pipeline. Reports go to `analyzer/out/<key>-report.md` and `analyzer/out/gain-backfill-report.md`.

---

## Module Structure

```
src/
├── main.ts                     # entry point: import './ui/init.js'
├── types.ts                    # shared domain types (KeyCoord, JiRatio, SysexCmd, …)
├── state/                      # plain {…} objects, mutated directly
│   ├── tuning.ts               # curLayout, septimal*/equal*, septimalShift, septimalW
│   ├── view.ts                 # CW, CH, kbMinW, kbOffY, viewQ, viewR, hexDirty, textDirty
│   ├── selection.ts            # selectedKeys, drawnKeys, hoverKey
│   ├── audio.ts                # audioCtx, oscGain, squareGain, audioEnabled, activeWaveform,
│   │                           #   activeOscs, keyVelocity, sustainPedalDown, sustainedKeys,
│   │                           #   damperDepth, sostenutoActive, sostenutoLockedKeys,
│   │                           #   aftertouchSnapshot, rearticulateFlashUntil, wfLoadingKey
│   ├── midi.ts                 # midiAccess, midiOut, midiIn, activeMidiNotes, midiToKey
│   ├── lumatone.ts             # autoSyncEnabled, deviceColors, fixedLayoutSent
│   └── pedal.ts                # calibrating, debug, lastMin/Max/Valid, packetCount,
│                               #   lastCC4Value, lastCC4Time, mode (sustain/sostenuto),
│                               #   cc4Depth, cc64Depth, lastCC64Value
├── effects/                    # one-call fan-outs per state-change domain
│   ├── onTuningChanged.ts      # rampActiveFreqs + view.hexDirty + draw + (syncLumatoneColors)
│   ├── onLayoutChanged.ts      # syncLumatoneColors + buildMidiReverse + syncOutput
│   └── onSelectionChanged.ts   # syncOutput + draw
├── tuning/                     # PURE math: no DOM, no audio, no MIDI
│   ├── notes.ts                # note naming (handles any r), fmtNote, keyOctave
│   ├── ratios.ts               # gcd, jiRatio, intervalTier
│   ├── regions.ts              # 7-limit A/B region partitioning
│   ├── frequency.ts            # keyFreq for Equal / 5-limit / 7-limit
│   ├── intervals.ts            # comma decomposition, REF table, intervalName,
│   │                           #   shortenInterval, equalIntervalName
│   └── chords.ts               # template-based chord recognition + classification
├── layout/                     # PURE math: lattice ↔ screen
│   ├── baseKeys.ts             # 280-key map, layoutShifts {1, 2, 3}
│   ├── coords.ts               # bandOf, posInBand
│   └── geometry.ts             # hexR/dxH/dyH, tilt, hexToScreen
├── render/
│   ├── colors.ts               # colorTable, hueC, computeHue, keyColorHex
│   ├── canvas.ts               # sizeCanvas, getVisibleRange (load-time IIFE for CH/kbOffY)
│   ├── animation.ts            # encapsulated view tween (tweenTo / step / progress / isAnimating)
│   ├── draw.ts                 # cv, ctx, draw, hexAtPoint, animateLayout, hex/text offscreen
│   │                           #   layers, drawing helpers, kbOutlinePaths, hover/selection,
│   │                           #   seam blend
│   └── info.ts                 # updateInfo (info panel renderer), sizeInfoPanel
├── audio/
│   ├── aftertouch.ts           # AFTERTOUCH_*, velocityBaseVol, target/handover helpers
│   ├── engine.ts               # noteOn/Off, sustain, aftertouch, init/changeWaveform, ramp
│   ├── samples.ts              # SampleEngine barrel (samples-engine + samples-data)
│   ├── samples-data.ts         # INSTRUMENTS registry: loop points + gains + URL patterns
│   ├── samples-engine.ts       # Sample voice scheduler — verbatim v0.9 logic, see lessons.md
│   └── diagnostics/
│       └── loopOverlay.ts      # ?loopdiag=1 RMS meter + loop-point overlay
├── midi/
│   ├── engine.ts               # keyToMidi, port discovery (findLumatone, requestMidi),
│   │                           #   syncMidi, syncOutput, fixedMidiToKey, midiNoteOn/Off
│   └── handler.ts              # inbound MIDI router (SysEx, CC, aftertouch, notes)
├── midi-io/
│   ├── allocator.ts            # MPE channel allocator (LRU over 2..16)
│   ├── mpe.ts                  # coord ↔ (note, bend14) math, ±48-semi range
│   ├── export.ts               # sessionToMidi: builds MPE preamble + RPN + delta-time events
│   └── import.ts               # midiToSession: snapshot-anchored frequency-index inverse
├── recording/
│   ├── types.ts                # HkrSession, HkrEvent, LayoutSnapshot
│   ├── clock.ts                # nowSec() → audioCtx.currentTime
│   ├── snapshot.ts             # captureSnapshot, snapshotMatchesLive (leaf)
│   ├── apply.ts                # applySnapshot — drives setTuning/setLayout/changeWaveform
│   ├── capture.ts              # buffer + recordOn/Off/Pa/PedalDepths/Sostenuto
│   ├── playback.ts             # look-ahead scheduler + playback ledger + dispatch
│   └── hkr.ts                  # serializeHkr, parseHkr, HkrParseError
├── lumatone/
│   ├── protocol.ts             # SYSEX_CMD_*, sysexBoardMap = [1,2,3,5,4], message builders
│   ├── sysex.ts                # ENCAPSULATED queue (private state, public API)
│   ├── sync.ts                 # syncLumatoneColors, toggleAutoSync
│   ├── calibration.ts          # togglePedalCalibration, resetPedalBounds,
│   │                           #   handleCalibrationPacket
│   └── lumadiag.ts             # ?lumadiag=1 diagnostic panel for SysEx/firmware probing
├── input/
│   ├── qwerty.ts               # QWERTY → (q, r) mapping
│   └── keyboard-notes.ts       # held-voice migration on layout/transpose change
└── ui/
    ├── controls.ts             # setTuning, shiftSeams, setLayout, transposeSelection,
    │                           #   clearSelection (+ seam-shift / transpose repeat IIFEs)
    ├── keyboard.ts             # ←/→ layouts, ↑/↓ seam shift
    ├── recorder.ts             # transport buttons, file save/load, status pill
    └── init.ts                 # bootstrap: initAudio, requestMidi, mouse/resize listeners,
                                #   addEventListener wiring for the toolbar controls
```

**Dependency direction** (top to bottom; lower modules don't import from higher):

```
main → ui/init → ui/{controls, keyboard, recorder} → effects → engines (audio, midi, midi-io, lumatone) → recording → render → state → tuning + layout
                                                                  ↓
                                                          protocol + samples (encapsulated)
```

Two cycle-prone seams:

1. **Effects ↔ engines**: `effects/onSelectionChanged` calls `syncOutput` (in `midi/engine`) which calls `syncAudio` (in `audio/engine`); `audio/engine.sostenutoOff` calls back into `effects/onSelectionChanged`. Works at runtime because ES modules resolve function bindings lazily — the cycle never executes during module evaluation, only during user-driven events.

2. **Recording capture-point ↔ snapshot apply**: `audio/engine` imports `recording/capture`, which imports `recording/snapshot` (leaf). Separately, `ui/recorder` imports `recording/apply`, which imports `ui/controls` → `audio/engine`. Keeping `apply.ts` separate from `snapshot.ts` is what prevents the cycle from closing through `recording/capture`. See `lessons.md` "Splitting modules to break import cycles beats dynamic imports."

---

## Appendix: Glossary

- **Band** — 3-key-wide region along q-axis where 5-limit JI is pure
- **.hkr** — HexKeyLab Recording format: JSON, version-stamped, layout snapshot + coordinate event stream. The canonical recording. See §4.13.
- **Comma** — small interval between two ratios that should be equivalent (syntonic 81/80, septimal 64/63, schisma, Pythagorean, etc.)
- **Diesis** — 128:125 (great), unreachable in 5-limit but reachable in 7-limit via syntonic adjustments
- **Fixed MIDI layout** — HKL's tuning-independent (channel, note) addressing for every physical key
- **Half-damper** — continuous pedal control over damper depth (vs. binary on/off)
- **Lumatouch** — Lumatone keyType 3, continuous fader (NOT poly aftertouch)
- **LTN** — Lumatone preset/mapping file format
- **MPE** — MIDI Polyphonic Expression. One channel per active voice within a "zone"; pitch-bend, aftertouch, and timbre CCs apply per-channel rather than across the whole zone. HKL exports to MPE with the lower zone (manager ch 1, members ch 2–16) and ±48-semitone per-member pitch-bend range.
- **posInBand (p)** — position within a band (0, 1, or 2)
- **Region (A/B)** — 7-limit band along r-axis; A = pure, B = septimal
- **Roland-style pedal wiring** — wiper on ring of TRS plug (the Lumatone expects this)
- **Korg-style pedal wiring** — pot between tip and sleeve, ring floating (incompatible with Lumatone expression jack)
- **SC** — syntonic comma 81/80; also a transpose axis (−7q, +4r)
- **Seam** — boundary between bands or between 7-limit A/B regions
- **Septimal shift** — 7-limit seam position parameter (range −21 to 20, wraps 42)
- **TH (Tenney Height)** — log₂(num × den) of a ratio; a complexity measure
- **Tuning** — currently {Equal, 5-limit, 7-limit}
- **typeByte** — Lumatone per-key flags, `(faderUpIsNull << 4) | keyType`
