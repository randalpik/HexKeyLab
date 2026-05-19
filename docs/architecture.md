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

### 1.2.1 Lumatone internals (reverse-engineered)

Useful only for per-key hardware calibration on units with broken macro buttons or for diagnostics that the SysEx surface doesn't cover. Normal HKL operation requires none of this; documented here so future sessions can find it.

The Lumatone is a **BeagleBone Black running Debian** plus **five PIC microcontrollers** (one per octave board). The BBB talks to the PICs over UART `/dev/ttyO1`. The host (e.g., HKL) talks to the BBB over USB-MIDI. The BBB also exposes itself as a USB-ethernet gadget; from a Linux host, the device IP is `192.168.6.2` (Mac/Windows: `192.168.7.2`). SSH credentials: `debian` / `temppwd`. The on-device firmware is `/home/debian/TerpstraController/TerpstraController` (ARM 32-bit ELF, not stripped, full debug info). A wrapper script `lmtn_launcher.sh` respawns it in an infinite loop.

**Per-key calibration state** lives in two places:
- On disk: `/home/debian/TerpstraController/files/KeyData_1..5`. Plain text, comma-separated, 4 sections × 56 values per file (MAX threshold, MIN threshold, validity, AT MAX threshold). Loaded at every TC boot via `loadKeySetting`/`loadKeyThresholds` and pushed to PICs via `setMaxPic`/`setMinPic`/`setValidPic`/`setAftertouchMaxPic`. **Persistent.**
- In RAM: the `kbd_preset_params` struct in TC's `.bss`. Stride 638 bytes per board; section offsets `+0x118` (MAX), `+0x150` (MIN), `+0x1c0` (validity), `+0x1fe` (AT MAX). **Volatile; lost at TC restart or power cycle.**

Critical indexing detail: both layers (file naming and in-memory slot) use **PIC number** (`sysex_board`), not spatial board position. Memory slot `i` ↔ `KeyData_(i+1)` ↔ PIC `i+1`. The physical-swap mapping `sysexBoardMap = [1,2,3,5,4]` only enters when translating HKL's spatial board_group to the PIC number — never when indexing the firmware's internal data structures.

The `tools/lumatone-cal/` directory contains Python scripts that read/write this state both volatile (`/proc/<tc-pid>/mem`) and persistent (file edit). See `docs/lumatone-calibration.md` for the per-key calibration workflow.

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
- **Lilypond export**: see §4.14 for the v1 transcription pipeline.

### 4.14 `.hkr` → LilyPond transcription

Takes a `.hkr` recording played at a roughly constant tempo in a user-supplied time signature and produces a `.ly` file with a colored-notehead grand staff. v1 scope: 8th-note minimum granularity (no 16ths or 32nds), middle-C voice split, no microtonal accidentals (12-TET notation; the lattice spelling from `noteName(q,r)` provides the enharmonic spelling).

#### Pipeline

`.hkr` → onsets → tempo → beats → meter → chords → qnotes → voiced → `.ly`.

Eleven modules under `src/transcription/`, each focused on one stage. Identity (`Onset.id`, `QNote.sourceOnsetIds`) flows end-to-end so a future correction UI can map a rendered notehead back to the raw events.

#### Tempo estimation (`tempo.ts`)

IOI autocorrelation on a 10 ms binned onset envelope, weighted by a log-Gaussian prior peaked at 100 BPM (σ = 0.3 in log domain). When the user supplies a BPM hint, the candidate-lag search is hard-constrained to ±15 % of the hint period. Parabolic peak interpolation around the best lag gives sub-bin resolution. Octave errors (half / double tempo) are the standard failure mode — mitigated by the prior + hint constraint but not eliminated.

#### Beat tracking (`beats.ts`)

Ellis-style DP: `C(t) = s(t) + max(0, max_{t' ∈ [t−dMax, t−dMin]} C(t') − λ(t − t' − T)²)` where T is the target period from tempo estimation, `dMin/dMax` are search-window bounds (±50 % of T), and `λ = 0.5` controls tightness. Traceback from the highest-scoring beat in the final T-window gives the beat sequence.

#### Meter / downbeat phase (`meter.ts` + `quantize.ts` extrapolation)

Phase search over `numerator` candidate offsets: for each phase ∈ [0, numerator), sum the aggregate onset strength near beats whose index ≡ phase (mod numerator). Pick the highest-scoring phase.

In `quantize.ts`, the chosen phase's beat time gets extrapolated **backward by whole bars** until the resulting tick origin is ≤ the first onset's time. This preserves the phase search's downbeat choice while guaranteeing no leading notes get dropped — if the phase finder picks a phase whose first downbeat sits past the first onset, the tick origin shifts back so the first onset lands as a pickup in bar 0 rather than being clipped.

#### Chord grouping (`chords.ts`)

Cluster onsets whose `t` is within 30 ms of the first member of the current cluster (NOT the last member — using "last" allows transitive drift through near-30 ms IOIs and over-groups fast 32nd runs into a single chord). Cluster representative `t` is the median; `tOff` is the max.

#### Duration quantization (`quantize.ts`) — the load-bearing module

Per-bar Viterbi DP over an allowed atom set. v1 atom durations (in 64th-note ticks at `subdivisions: 32` per quarter):

| Atom | Ticks | LilyPond | Complexity |
|------|-------|----------|------------|
| 8th  | 16    | `8`      | 0.10       |
| quarter | 32 | `4`      | 0.00       |
| dotted quarter | 48 | `4.` | 0.30   |
| half | 64    | `2`      | 0.05       |
| dotted half | 96 | `2.`  | 0.35       |
| whole | 128  | `1`      | 0.10       |

(v1 deliberately omits 16ths and 32nds; granularity is tempo-dependent and the user's playing rarely exceeds 240 BPM = 16ths at 60 BPM = 8ths at 120 BPM.)

Position snap to a 16-tick grid (one 8th). Within each bar, the DP fills a `(startTick, durTicks)` event with a sequence of atoms minimizing:

```
total_cost = sum(atom.complexity) + Σ TIE_COST × (atoms - 1) + Σ boundary_penalty(atom)
```

- **`TIE_COST = 0.40`** — calibrated so single-atom notations beat tied chains at clean alignments, but ties still win when they should (e.g., a half note from beat 2 of a 4/4 bar gets the boundary penalty for crossing the bar middle and the DP prefers `quarter + quarter tied`).
- **Boundary penalty** = `0.05 × (worst_metric_weight_inside_duration − start_weight)`. Metric weights: bar start = 100, bar middle (4/4) = 50, beat = 25, 8th subdivision = 8, 16th = 6, etc. A note starting on a weak beat that crosses a stronger boundary inside its duration pays the difference.

Rest insertion: if a chord's release-tick is ≥ 16 ticks before the next chord's onset, a rest fills the gap. Below that threshold, the released-but-silent time folds into the preceding note's duration.

#### Voicing (`voicing.ts`)

Middle-C (MIDI 60) threshold per chord. All-treble or all-bass chords go to one staff; mixed chords split — pitches ≥60 to treble (voice 1 of staff 1), <60 to bass (voice 1 of staff 2), at the same `startTick` (LilyPond's grand-staff voicing handles this cleanly).

**Rest consolidation** runs after the voice split. Consecutive `isRest` QNotes in each voice merge into a single duration, slice at bar boundaries, re-fed through `splitDuration` so an all-rest bar collapses to `r1` instead of mirroring the active staff's note rhythm. See `lessons.md` "Rest consolidation in voicing fixes the 'mirroring' bug."

#### LilyPond emission (`lyEmit.ts`)

Standard `\new PianoStaff << \new Staff = "RH" { ... } \\ \new Staff = "LH" { ... } >>`. Dutch syntax (`c`, `cis`, `ees`, `c'`, `c,`). Per-notehead color via `\tweak NoteHead.color #(rgb-color r g b)`. Single-color chords get one `\colorNote` wrapper; heterogeneous chords use per-pitch `\tweak` inside `< >`. Source-onset ids ride along as `% onset-ids: [...]` comments above each chord for future correction-UI hooks.

Pitch spelling reuses `noteName(q, r)` + `keyOctave(q, r)` from `src/tuning/notes.ts` directly. The lattice's natural Pythagorean spelling (sharps on +r, flats on −r) flows through to LilyPond without enharmonic respelling. No key signature inference in v1 — the music is rendered "in C" with explicit accidentals per note.

#### UI

"Export .ly" button in the Recording toolbar opens a modal: title, time-signature numerator (default 4, denominator fixed at 4 in v1), optional BPM hint. The pipeline runs synchronously and downloads the `.ly` via the existing `downloadBlob` helper.

`?hklrec=1` URL param exposes `window.__hkl_rec.transcribe(opts)` for DevTools verification — returns `{ ly, debug }` where `debug` contains every intermediate IR (`onsets`, `tempo`, `beats`, `meter`, `chords`, `qnotes`, `voiced`).

#### Color handling

`darkColorHex(q, r)` in `src/transcription/pitch.ts` wraps `keyColorHex` with a per-hue table (`HUE_PROFILES`) that remaps each of HKL's seven hues to a paper-readable variant: OR/YE shift toward goldenrod, GR shifts toward yellow-green, TE shifts toward cyan, PK shifts magenta-ward — chosen so PK/OR and TE/GR (the two confusion pairs on white background) become clearly distinguishable. Stem/flag/accidental color is suppressed via `\tweak NoteHead.color` (only the notehead carries the lattice color).

#### Out of scope for v1

- Rubato / variable tempo — pipeline assumes near-constant tempo throughout.
- Tuplets (triplets first would be the v2 target).
- Time-signature change mid-piece.
- Microtonal accidentals (HEJI via Ekmelily is a known future path).
- Manual correction UI — the pipeline preserves `sourceOnsetIds` end-to-end so a v2 UI can navigate from notehead to raw events without rewriting the model.

### 4.15 Audio engine

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

- **Loop instruments**: stereo RMS over the steady region returned by `findSteadyRegion` (50 ms RMS window, 10 ms hop, ≥70% peak run). Vibrato instruments pre-smooth the curve over ±150 ms so AMP cycles don't shatter the steady span. The peak amplitude over the same window bounds the gain so a single-voice peak post-boost ≤ −3 dBFS.
- **Decay instruments**: K-weighted integrated loudness per ITU-R BS.1770-4 (pre-filter high-shelf @1681 Hz +4 dB, RLB high-pass @38 Hz, 400 ms momentary windows / 100 ms hop, absolute gate at −70 LUFS, relative gate at −10 LU below pre-gated mean), integrated over the full post-trim region. Returned as a stereo-RMS-equivalent (`sqrt(integrated_combined/2)`) so the gain formula is shared with the loop path. Implementation in `analyzer/k-weighting.js`.

`gain = min(TARGET_RMS / rms, TARGET_PEAK / peak)`, floored at `GAIN_MIN`. Constants live in both `analyzer/generate-samples.js` and `analyzer/backfill-gains.js`: `TARGET_DBFS = −18`, `PEAK_DBFS = −3`, `GAIN_MIN = 0.1`.

The Node analyzer emits `gain` directly into the per-sample object alongside `freq`. The standalone `backfill-gains.js` patches the same field into existing entries in `src/audio/samples.ts` in place — useful for adding normalization to instruments whose loop data was generated before the field existed (trombone, reed_organ) without re-running their full loop pipeline. Reports go to `analyzer/out/<key>-report.md` and `analyzer/out/gain-backfill-report.md`.

---

## 7. HKL Composer

Standalone keyboard-driven score editor at `composer.html`, shipped from the same repo and built by the same Vite config as the main HKL viewer. Uses Verovio (WASM, MEI in / SVG out) for engraving. Consumes HKL's held-keys state via `BroadcastChannel`; dispatches playback requests back. Composer holds the MEI/score state; HKL holds the audio/MIDI/tuning state. The two apps run as separate browser tabs with no shared module imports beyond the bridge protocol.

### 7.1 Two-tab architecture

- **HKL tab** (`index.html`) — Lumatone input, audio engine, tuning state, lattice rendering. Unchanged by Composer's existence.
- **Composer tab** (`composer.html`) — MEI model, Verovio render, cursor overlay, keyboard input handler, playback orchestration. Imports `src/bridge/*` plus pure helpers from `src/transcription/pitch.ts` and `src/tuning/notes.ts`. Does NOT import `src/audio`, `src/midi`, `src/state`, or `src/lumatone`.

Composer is openable standalone (load/save/edit `.hkc` files works without HKL); entry of held chords requires HKL to be connected. The "connection status" indicator in the toolbar reflects three states: `no HKL` (red) before initial handshake, `connected` (green) after `hkl-hello`, `standalone` (yellow) after 1 s with no hello.

### 7.2 Bridge protocol (`src/bridge/`)

Single source of truth: `src/bridge/protocol.ts`. One `BroadcastChannel` named `'hkl-composer-bridge'` carries both directions; per-side type safety via `BridgeChannel<In, Out>` generic in `src/bridge/channel.ts`.

**HKL → Composer events** (`HklEvent`):
- `hkl-hello`, `hkl-bye` — lifecycle.
- `held-keys` — array of `ResolvedNote` records, each `{q, r, pname, accid, oct, midi, colorHex, velocity}`. Broadcast on every change to `selection.selectedKeys` (RAF-polled; signature-diffed so no spam).
- `playback-position` — `{meiId, timeMs}` per chord onset during a play-score; final position with `meiId: null` at end.
- `playback-finished` — playback queue exhausted (or aborted).
- `tuning-changed` — `{mode, description}` informational; Composer updates status text.

**Composer → HKL events** (`ComposerEvent`):
- `composer-hello`, `composer-bye`, `request-state` — handshake / state refresh.
- `play-score` — `{events: PlaybackEvent[]}` with per-event `{atMs, durationMs, notes, meiId?}`. HKL drives its audio engine off this.
- `stop-playback` — cancel any active playback.

(No entry-time monitor: an earlier `play-chord` message that fired on each duration keypress was removed because its scheduled `noteOff` cut the user's still-held Lumatone notes short. Composer only sends playback requests during explicit `play-score`.)

`ResolvedNote` is intentionally fully resolved by HKL: pname, accid, oct, midi, colorHex are derived from `(q, r)` plus current tuning state on the HKL side. Composer never needs to know HKL's current tuning to render correctly. `accid` is a count-form string (`''`, `'s'`, `'ss'`, `'sss'`, `'f'`, `'ff'`, `'fff'`, …, or `'n'` for explicit natural); HKL doesn't clamp at the bridge. See §7.16 for how Composer handles values outside ±3.

### 7.3 HKL-side bridge (`src/bridge/hkl-side.ts`)

Initialized at the end of `ui/init.ts` (after audio + MIDI setup). RAF-polled loop reads `selection.selectedKeys`, resolves each `(q, r)` via `noteName(q, r)` + `keyOctave(q, r)` + `darkColorHex(q, r)`, and broadcasts on signature change. Listens for `composer-hello` / `request-state` and replies with the current state.

Inbound `play-chord` / `play-score` dispatches via existing `audio.noteOn` / `noteOff`. While playback is active:
- A `playbackActive: boolean` flag suppresses the held-keys broadcast (otherwise Composer would see its own playback echoed back as held-key input — feedback loop).
- A `playbackOwnedKeys: Set<KeyId>` tracks which `selectedKeys` entries playback added (vs. keys the user is holding via mouse/Lumatone). On noteOff or abort, only playback-owned keys get removed from `selectedKeys`, so user-held keys survive a playback that happens to play the same coord.
- `draw()` is called after each chord onset and offset so the lattice highlight (via existing `selection.selectedKeys` path) tracks what's currently sounding.

### 7.4 Composer model: MEI in-memory DOM

`src/composer/model.ts`. The MEI document is held as a `Document` (DOMParser-parsed XML). Initial document is a single measure with two staves (grand staff with `bar.thru="true"`) and two layers per staff (four voices). Score metadata — title, composer, key signature, time signature, tempo — lives on the document (`<titleStmt>`, `<scoreDef>` attributes, `<tempo>` element in the first measure). Mutations are direct DOM operations; the document gets re-serialized to a string and handed to Verovio's `loadData()` on every render.

Voice numbering (per Composer convention, top-to-bottom):
- voice 1 = staff 1 (treble), layer 1
- voice 2 = staff 1 (treble), layer 2
- voice 3 = staff 2 (bass), layer 1
- voice 4 = staff 2 (bass), layer 2

Each voice has its own cursor position stored in `cursors: Record<Voice, number>`. The cursor indexes into the **linear flat stream** for that voice — the concatenation of `(chord|note|rest|space-placeholder)` content across all measures, in measure order. Multi-measure traversal is transparent to the cursor model. Mutations: insert/replace/delete at cursor, plus navigation (`switchVoice`, `moveCursor`, `setCursor`, `cursorToEnd`).

Time-aligned voice switching: `switchVoice` snapshots the source voice's cumulative-time-at-cursor (via `getTimeAt`), switches voices, then calls `findCursorAtOrBefore(newVoice, time)` to place the cursor at the latest position in the new voice whose start-time ≤ snapshot time. Durations are computed in 64th-note ticks via `elementDurationTicks(el)`.

The model has two cursor-locator helpers with deliberately different boundary semantics:
- `locateCursor(voice, c)` — insertion-point lookup. Uses strict `<` so that cursor=N at a measure boundary lands in the NEXT measure's layer at `withinIdx=0`. A special-case override in `insertWithSplit` re-aims insertion to the previous measure's trailing edge when the cursor sits between real content (m₁) and a placeholder-only measure (m₂) — the user's intent in that case is to extend m₁ rather than consume m₂'s placeholder.
- `locateFlatElement(voice, idx)` — element-at-flat-index lookup, strict-decrement walker. Used by `deleteAtCursor` and similar to find the element at a specific flat position, not its insertion point.

Every `<note>` carries:
- `data-q` and `data-r` custom attributes so the lattice identity survives a save/load roundtrip. MEI spec ignores unknown attributes — `.hkc` files open fine in other MEI viewers (just without the playback / coord-aware features).
- `xml:id` attribute set via `setAttributeNS(XML_NS, …)` (not bare `setAttribute`) so the attribute lives in the proper XML namespace and our `[*|id]` CSS-selector lookups resolve correctly. See lessons.md "Manually-set xml:id without setAttributeNS".

Every `<staff>` and `<measure>` also carries `xml:id` so the cursor overlay can look up their bounding rects via `renderer.rectForId(staffId)` for empty-voice cursor anchoring (see §7.13).

### 7.5 Render & cursor overlay

`src/composer/render.ts` owns the Verovio toolkit lifecycle. The WASM is loaded from CDN (`https://www.verovio.org/javascript/latest/verovio-toolkit-wasm.js`) via dynamic script injection — no npm dependency to keep the HKL viewer bundle slim. `~6–8 MB` gzipped, `200–800 ms` first-render latency.

Engraving options (current as of 2026-05-16, see decisions.md and lessons.md for the iteration):
- `svgViewBox: false` (default) — SVG has explicit `width`/`height` pixel attrs; browser renders at intrinsic size, no fit-to-container scaling.
- `scale: 100` — natural Verovio render size.
- `pageWidth: 2100` / `pageHeight: 2970` (page mode, breaks: 'auto'); `pageWidth: 100000` / `pageHeight: 400` (scroll mode, breaks: 'none').
- `header: 'none'`, `footer: 'none'` to strip metadata blocks from the output.
- `svgAdditionalAttribute: ['note@data-q', 'note@data-r', 'note@color']` exposes lattice coords on rendered notes.

After Verovio renders, `render.ts` post-processes the SVG: each `<g class="note">` has its `<g class="notehead">` child moved to the LAST sibling position. Since SVG draws in document order, this puts the colored notehead ON TOP of the stem and prevents the (black) stem from intruding into the (colored) circle. CSS additionally forces stems, flags, accidentals, ledger lines, and rhythm dots back to black via `color: #000 !important; fill: #000 !important` (only the literal notehead carries the lattice color).

Sub-pixel rendering: all strokes (staff lines, ledger lines, bar lines, stems) use `shape-rendering: geometricPrecision` in the CSS. An earlier mix of `crispEdges` for some strokes caused inconsistent stem widths (1px vs 2px depending on sub-pixel parity) and bar line gaps (15px instead of the conventional ~4.5px overhang past content). `geometricPrecision` is also the foundation for in-app zoom control — at high zoom-out, `crispEdges` would snap thin strokes to 0px (invisible), while `geometricPrecision` anti-aliases them visibly.

The cursor overlay (`src/composer/cursor.ts`) is a separate `<svg>` appended inside `#score` after each Verovio render. Sized in `main.ts` to match Verovio's emitted dimensions so it scrolls in lockstep. Two modes:

- **Editing mode** — bar/box at the active voice's cursor position. Insert mode anchors to the RIGHT edge of the just-entered element (`flat[cursor - 1]`). Overwrite mode draws a translucent selection BOX around the element at `flat[cursor]` (the one that would be replaced). Empty-voice and at-placeholder cases anchor on the active staff (see §7.13). Includes a "V1"–"V4" label.
- **Playback mode** — per-voice bars (one per voice that has sounded an event), each independently positioned. Editing cursor is hidden. Toggled via `cursor.setPlaybackMode(on)`.

The cursor class deliberately resets its `barRect` / `voiceLabel` / `playbackBars` refs in `attach()` — Verovio's `loadData() + renderToSVG()` writes a fresh `innerHTML` on `#score` which orphans the previous overlay along with the rendered SVG. See lessons.md "Stale DOM refs across `innerHTML` rewrites."

### 7.6 Input model (keyboard-driven)

`src/composer/input.ts`. No mouse-to-document handlers — Speedy-Entry-style keyboard flow with Finale-convention bindings:

- **`1`–`7`** — duration (Finale order: 1=64th, 2=32nd, 3=16th, 4=8th, 5=quarter, 6=half, 7=whole). With held keys → chord; without → rest. Any held key with `|alter| > ±3` is filtered out of the chord input before commit (Verovio's multi-`<accid>` rendering doesn't allocate space and the glyphs overlap; see §7.16). Status message indicates partial / full filtering.
- **`.`** — cycle dots on the CURRENT note/chord/rest (0 → 1 → 2 → 0). In insert mode targets `flat[cursor-1]`; in overwrite mode targets `flat[cursor]`. If adding a dot would overflow the measure, the note is auto-tied across the bar.
- **`=`** — toggle a tie on the current note/chord (Finale convention). Per-pitch: matching pitches in the next element become real ties; non-matching pitches become stubs (see §7.14). Pressing `=` again removes the tie.
- **`↑`/`↓`** — switch voice (cycles 1↔2↔3↔4, time-aligned per §7.4).
- **`←`/`→`** — move cursor within current voice.
- **`Home`/`End`** — jump to start/end of current voice.
- **`Backspace`** — delete the element before the cursor. Skips over placeholders without deleting them; if the deletion empties an entire measure (across all voices), the measure itself is removed unless it's the only one.
- **`Delete`** — delete the element after cursor.
- **`Insert`** — toggle insert / overwrite mode.

Arrow keys are suppressed during playback (the `isPlaybackActive` hook in `InputHooks` short-circuits the navigation block).

Composer never sends entry-time playback to HKL. The user already hears their held Lumatone keys live; sending a `play-chord` back caused a noteOff race that cut held notes short.

### 7.7 Playback orchestration (`src/composer/playback.ts`)

`buildPlayback(model)` walks every measure of every voice in the MEI; for each chord/note (rests and placeholder spaces advance the voice clock but don't emit), it emits a `PlaybackEvent` with cumulative `atMs` per voice and `durationMs` from `elementDurationTicks` at the score's tempo (read from the `<tempo>` element in the first measure, fallback 120 BPM). Tied chains coalesce: a chord with `@tie="i"` emits ONE event with the chain's total duration; subsequent `@tie="m"|"t"` pieces in the same voice don't trigger re-attacks. Events are sorted by `atMs` so simultaneous voice attacks land together.

`startPlayback` (in `main.ts`):
1. Snapshot the editing cursor's `(voice, cursor)` for restore.
2. Send `play-score` to HKL.
3. `cursor.setPlaybackMode(true)` — editing cursor hides, per-voice playback bars become visible.

On each `playback-position` from HKL: look up the meiId's voice via `model.findElement(meiId)`, call `cursor.setPlaybackPosition(voice, meiId)`. The editing cursor's model state is NOT mutated during playback — the per-voice playback bars are pure overlay updates.

On `playback-finished` or `stop-playback`: `finalizePlaybackEnd()` exits playback mode, restores the editing cursor's snapshot via `model.setVoice` / `model.setCursor`, refreshes the overlay.

The Composer-side `.playing` CSS class is toggled on the currently-sounding MEI element via `highlightElement` (in `playback.ts`); no visual styling is applied to it currently (the glow was removed; the class remains as a hook for future styling).

### 7.8 Save / load / export

`src/composer/save.ts`:
- **`.hkc`** — canonical save format. The MEI XML string, including `data-q`/`data-r` custom attributes. `saveHkc(model)` serializes; `loadHkcFromFile(file)` parses and returns a new `ComposerModel`.
- **`.musicxml`** — one-way export via `exportMusicXml(model)`. Walks the model, emits `<score-partwise>` with grand-staff structure, per-voice `<note>` / `<chord>` / `<rest>` elements, `<backup>` to align voices, `<notehead color="...">` for the lattice color. Lossy on dynamics/repeats/articulations (the v1 model doesn't carry those anyway), but pitches/rhythms/colors round-trip cleanly to MuseScore / Finale / Sibelius.
- `MusicXML divisions: 16` (= 16 ticks per quarter, enough for 32nd notes at 2 ticks each).

### 7.9 View modes

Toolbar toggle between "Page" and "Scroll" views. Both use `svgViewBox: false` and `scale: 100`; the difference is `pageWidth` / `pageHeight` / `breaks`. Verovio's `setOptions()` is called on toggle, followed by a re-render (`loadData` + `renderToSVG`) so the new layout takes effect.

### 7.10 Out of scope (still)

- Note-level edits in existing chords (change one pitch within a chord).
- Tuplets, anacrusis / partial-bar pickups.
- Tempo changes mid-score, expressive text, slurs, articulations (planned; see §7.20 "Planned extensions").
- Print / PDF export (Verovio supports this; integration deferred).
- Undo / redo.
- Microtonal / quarter-tone / HEJI accidentals.
- Multi-instrument scores beyond grand staff.
- Tie-chain re-coalescence under time-signature change (currently per-measure truncation; see §7.15).
- Auto-filling partial measures with trailing rests (current model permits partial measures).
- Accidentals beyond ±3 (filtered out at entry; see §7.16).

### 7.11 Standalone tool / sub-app structure

The Composer is built and bundled by the same Vite config as the main HKL viewer:

```ts
// vite.config.ts
build: {
  rollupOptions: {
    input: {
      main:     resolve(__dirname, 'index.html'),
      composer: resolve(__dirname, 'composer.html'),
    },
  },
}
```

Two HTML entries at repo root, two output bundles. Verovio WASM is only pulled into the composer bundle. `npm run dev` serves both; navigate to `/composer.html` for the editor, `/` (or `/index.html`) for the viewer. `npm run build` produces both `dist/index.html` and `dist/composer.html` with separate JS chunks.

### 7.12 Document Setup modal

`src/composer/setupDialog.ts` + the `<dialog id="setupDialog">` element in `composer.html`. A single "Setup…" button in the toolbar opens a native `<dialog>` modal with form fields for:

- **Title** → `<titleStmt><title>`.
- **Composer** → `<titleStmt><respStmt><persName role="composer">`.
- **Key signature** → `<scoreDef key.sig="0|1s..7s|1f..7f">`. Drop-down lists all 15 major keys (Cb…C#); minor modes share key signatures.
- **Time signature** → `<scoreDef meter.count meter.unit>`. Numerator 1–16; denominator 1/2/4/8/16.
- **Tempo** → `<tempo>` as the first child of measure 1, with `mm`, `mm.unit`, optional `mm.dots`, `midi.bpm`, and optional text content (e.g., "Allegro").

The dialog reads current values from the model on open and applies them in dependency order on save (title/composer/keysig/tempo first, then time signature last because it can trigger §7.15 truncation).

Time-signature changes prompt for confirmation only when the new meter is **smaller** than the current one AND the score has content — enlarging is non-destructive.

### 7.13 Empty-voice placeholders

Every layer (per voice, per measure) that has no real content (note/chord/rest) carries one or more `<space dur="…" data-placeholder="true">` children whose tick durations sum to the measure's full duration. The placeholder is invisible to Verovio (no glyph drawn) but reserves the measure's horizontal layout space, which:

- Fixes the empty-initial-measure bar-line / staff-line gap (Verovio would otherwise lay an empty measure out at a degenerate width, leaving the final barline ~15px short of where the staff lines end).
- Lets the cursor navigate to an arbitrary measure of an otherwise-empty voice — placeholders count as flat-children, so the user can `↑` to voice 3 and `→` past placeholders to land in any specific measure, then press a duration to enter content there. No more manual whole-rest stuffing to reach a later measure.

Invariant: each layer either has at least one real-content child (no placeholders) or has only placeholder spaces summing to `measureTicks()`. Enforced by the `normalizePlaceholders()` pass called from every mutation entry point and from `replaceDocument` after load.

When the user inserts content at a placeholder's flat position, `insertWithSplit`'s normal logic handles it: the new content lands in the placeholder's layer, normalization strips the placeholder, the cursor advances naturally. When the cursor sits at a boundary BETWEEN real content (m₁) and a placeholder-only measure (m₂), the insertion is re-aimed at m₁'s trailing edge (extending the partial measure) rather than consuming m₂'s placeholder — see `insertWithSplit` in `model.ts`.

Backspace on a placeholder skips past without deleting (cursor moves left so the next press reaches real content behind the empty area).

When the cursor visually anchors to a placeholder (empty layer), the rendered `<g class="space">` has degenerate 0×0 bbox, so `cursor.ts` falls back to anchoring on the staff: `model.getStaffIdAtCursor(voice)` returns the xml:id of the staff for the voice in the measure CONTAINING the cursor, and `renderer.findSigEndXForStaff(staffId)` returns the rightmost edge of any clef/keysig/meterSig inside that staff's bbox. The cursor lands at `sigEndX + small offset` for first-measure-of-system, or `staff.left + 10` for later measures with no sig changes.

#### 7.13.1 Autofill rests on cursor-leave

When the cursor leaves a partially-filled measure for a different measure (or voice), an autofill sweep finalizes it with visible beat-aligned rests. `autofillMeasure(voice, measureIdx)` in `model.ts` runs from `moveCursor`/`setCursor`/`cursorToEnd`/`switchVoice`/`setVoice` whenever the cursor's `measureIdx` actually changes. Rules:

- Skip if the layer has no real content (fully-empty layers stay as placeholders so the user can still navigate to them and start fresh).
- Skip if the voice has no content in any strictly-later measure (don't pad the trailing tail of a voice — only "abandoned" measures, ones with content following).
- Skip if the layer is already full.
- Otherwise replace trailing placeholder space with `decomposeBeatAlignedRests(startTick, remaining, timeSig)` from `restfill.ts`, which emits one rest per beat (or sub-beat) without crossing beat boundaries.

Autofill rests are plain `<rest>` elements with no special marker — once placed, they behave like manually-entered rests. To extend the measure later the user must explicitly delete them.

Autofill triggers only on navigation, never on mutation. Inserts/deletes/replaces inside the cursor's current measure don't fire the sweep; only when the user navigates away does the abandoned measure get finalized.

### 7.14 Ties

`@tie="i"|"m"|"t"` on `<note>` (single MEI 5 values, not compound forms — Verovio rejects `"ti"`/`"it"`). Each tied pair carries a `data-tie-partner` attribute on both sides (custom; MEI ignores) pointing at the partner's xml:id. This makes orphan cleanup O(1) when one side of a pair is deleted.

`toggleTieOnCurrent` (bound to `=`):
- If the current note has a tie, removes it (and clears its partner).
- Else looks at the next layer element. For each note in the current chord, finds a same-pitch partner (same pname + alter + oct) in the next element. Matched: sets `@tie="i"` on current, `@tie="t"` on partner. Unmatched: leaves the current note as a STUB (no MEI tie attribute; tracked via `data-pending-tie="true"`).

Stub ties don't render visually (Verovio's `<lv>` element draws nothing reliably; manual SVG overlay was rejected as too invasive). They auto-resolve into a real tie pair the moment a matching pitch is entered after them — `resolvePendingTies` runs at the end of every `insertChordAtCursor` / `replaceChordAtCursor`.

When an element is deleted (or replaced), `orphanTiePartners(elem)` walks each inner note's `data-tie-partner`; surviving initiators are demoted back to a pending stub, surviving terminators have their `@tie` cleared. Tie chains across multiple pieces (from §7.15 auto-tie-on-overflow) carry partner pointers between every adjacent pair so a chain unwinds cleanly when any piece is removed.

Auto-tie-on-overflow: when an inserted note exceeds the remaining ticks in the current measure, `insertWithSplit` decomposes the duration into a representable head + tail chain via `decomposeTicks(ticks)` (greedy by 64ths down to a power-of-2 table). Each chain piece gets a `<note>` with the appropriate `@tie` value (i/m/t) and `data-tie-partner` pointing at the previous piece. New measures are appended as needed; `setBarlines()` keeps the final-barline (`@right="end"`) on the last measure.

**Planner + applier** (`planInsert` + `insertWithSplit` in `model.ts`): every layer-level insert is validated by a single walker that simulates the new sequence — inserted note's pieces followed by any post-cursor items — assigning each a `(measureIdx, offset)`. The walker enforces three invariants and surfaces one of three rejection reasons via `canInsertHere`:

- **Measures never exceed their length.** When the walker lands content in a measure past the cursor's, that target layer (for this voice) must currently be empty. Otherwise reject with `Insertion would overflow into next measure's content.` (Closes a latent bug where mid-measure inserts with real post-cursor content silently pushed elements past the barline — the old single-element path only checked `usedBefore + totalTicks <= measureTicks`, ignoring the post-cursor block.)
- **Tuplets stay atomic and never straddle.** A `<tuplet>` that wouldn't fit in its current measure is moved wholesale to the next measure (the gap it leaves in the original measure is absorbed by trailing placeholders, then autofilled with visible rests on cursor-leave — see §7.13.1). If the target measure isn't empty in this voice, reject with `Insertion would push tuplet across bar line.`
- **Existing post-cursor items keep their identity.** Only the freshly-inserted note splits with ties; existing non-tuplet items shift wholesale on overflow, preserving any pre-existing tie wiring (their `xml:id` and `data-tie-partner` cross-refs are invariant under a DOM move).

`canInsertHere` runs the same planner in dry-run mode, so the input layer's status message always matches what the apply path would do.

### 7.15 Time-signature change: per-measure truncation

When the user changes the meter (Setup modal → Time signature), `setTimeSig` calls `truncateOverflowingMeasures()`. Per measure, per voice's layer:

- Walk content in order, summing 64th-note ticks.
- Find the FIRST element that would overflow the new measure's tick budget. Compute `remaining = cap - running`.
- If `remaining > 0`: shorten that element's `@dur`/`@dots` to the largest representable duration ≤ remaining (`decomposeTicks(remaining)[0]`). Pitches, ties, color, lattice coords all preserved.
- If `remaining === 0`: the previous element exactly filled the new measure; drop the overflowing element via `orphanTiePartners + removeChild`.
- Drop every element AFTER the truncation point (`orphanTiePartners + removeChild` each).

After the per-measure pass, `normalizePlaceholders()` regenerates placeholders in any layer that ended up content-empty, `setBarlines()` re-applies the final barline, and each voice's cursor is clamped to its new flat length.

Measure count is preserved (no reflow into new measures). Enlarging is a no-op except for re-normalizing placeholders to the new tick budget. Tied chains that cross the truncation point unwind correctly via the existing orphan logic. This replaces an earlier `rebuildMeasureLayout` approach that flattened content and re-distributed — see decisions.md "Per-measure truncation over rebuild-and-reflow".

### 7.16 Accidentals: carry-state display + clamp at ±3

`src/composer/accidentals.ts` runs at serialize-time on the cloned doc (live doc stays untouched). Per measure × per staff (treble and bass independently; accidentals carry across voices within a staff):

- Initial carry-state = key-signature alterations (a `Record<pname, number>` derived from `key.sig="3s"` → `{f:1, c:1, g:1}` etc.).
- Walk all notes in the staff sorted by start tick (then by layer for ties).
- For each note: compute its absolute alteration from `@accid` or `@accid.ges` (survives save/load); compare to the currently-expected alteration.
  - Matches → hide via `@accid.ges` (remove `@accid`).
  - Tie destination (`@tie="t"|"m"`) → always hide, but DO update carry state.
  - Else → show via `@accid` (the canonical single-token glyph), update state. alter=0 with non-zero state writes `@accid="n"` (natural sign cancellation).

Single-token canonical glyphs only — multi-`<accid>` child stacking was attempted but Verovio doesn't allocate horizontal space for additional children, so they overlap exactly. Composer therefore clamps at ±3:

- `tokenFromAlter(alter)` returns `s`/`f`/`x`/`ff`/`ts`/`tf` for alter ∈ {±1, ±2, ±3}. `x` is the canonical double-sharp glyph (×, U+E263); `ss` would draw two single sharps stacked, which is undesirable. `ts`/`tf` are the triple-sharp/flat tokens (Verovio renders them visually as ×♯ / ♭♭♭ but they remain one MEI token from our side).
- Notes whose HKL-spelled alteration exceeds ±3 are FILTERED OUT at entry by `commitDuration` in `input.ts`. The user sees a status message. To enter such notes the user would have to re-spell via lattice transformation.
- Legacy `.hkc` files with `@accid="ss"` are migrated to `@accid="x"` on load. Legacy files with `<accid>` children (from a brief experimental period) are collapsed into a single clamped `@accid` on load.

The bridge protocol's `accid` field is widened to `string` (count form: `''`, `'s'`, `'ss'`, `'sss'`, …, `'n'`); the bridge does NOT clamp. All clamping lives in Composer's entry path so the bridge stays a simple passthrough.

### 7.17 Intelligent beaming

`src/composer/beams.ts`. Beams are computed at serialize-time on the cloned doc (live doc has no `<beam>` wrappers, keeping cursor/mutation logic simple). `regroupBeams(doc, timeSig)` walks each measure × layer, removes any existing `<beam>` wrappers, then re-wraps consecutive beamable elements (`dur >= 8`, not a rest) within each beat group:

- **Simple meter** (n/{1,2,4}): beat groups of one denominator-note each.
- **Compound meter** (n/{8,16} with n divisible by 3 and ≥6): beat groups of three denominator-notes each (one dotted denominator beat).
- **4/4 special case**: beats 1–2 and beats 3–4 form two super-groups (so 8 eighth notes in 4/4 beam as two groups of 4 rather than four groups of 2).

Rests and durations ≥ quarter break the run. Singletons stay un-wrapped. An element belongs to the beat-group containing its startTick (no group-splitting of a single element).

### 7.18 Bar lines + grand staff

- `bar.thru="true"` on `<staffGrp>` so bar lines render as one continuous line from the top of the treble staff to the bottom of the bass staff (grand-staff convention).
- `@right="end"` on the last measure renders the final thin+thick barline (MEI 5 "final" form; `"dbl"` rendered as a regular double bar, which we don't want at score end).
- CSS forces `shape-rendering: geometricPrecision` on all strokes (staff lines, ledger lines, bar lines, stems). See §7.5.

### 7.19 Headless inspection tool

`tools/composer-inspect/inspect.mjs` — a Node script that launches headless Chromium via remote-debugging-port, navigates to the running dev server's `/composer.html`, waits for Verovio WASM to load and render, evaluates an arbitrary JS expression in the page context, and prints the result as JSON. Used heavily for iterating on engraving / accidental / barline rendering without manual browser cycles. Requires Node 22+ (native WebSocket) and chromium in PATH; no npm dependencies. See `tools/composer-inspect/inspect.mjs` for usage examples.

### 7.20 Expression layer (dynamics + hairpins)

A virtual fifth "voice" sitting between voices 2 and 3 in the navigation cycle, with its own cursor that snaps to the union of {every note onset across all four voices} ∪ {every existing dynam/hairpin moment}. Lives at `src/composer/expressions.ts` (CRUD + tstamp helpers + document-level defaults) and `src/composer/expressionCursor.ts` (moment-list construction + cursor navigation + selection).

**Anchoring is by `@tstamp` / `@tstamp2`, not by `@startid`/`@endid`.** Dynamics and hairpins are siblings of `<staff>` inside their measure with `tstamp="beat"` (and for hairpins `tstamp2="Nm+beat"`). This is the time-based anchoring form supported by MEI 5 control events. The choice means an expression element **survives deletion of any nearby note** — the marking stays glued to its beat moment, which matches conventional notation semantics. The trade-off is that re-barring (changing meter) does NOT carry expressions with their original notes; if this becomes a real problem, fallback would be to migrate orphaned expressions on time-sig change. Slurs and articulations stay note-attached when those features land.

Voice cycle: ArrowUp / ArrowDown cycles through five positions — **1 → 2 → expr → 3 → 4**. The voice indicator shows `E` in expression mode. The cursor mode lives in `InputState.cursorMode: 'voice' | 'expr'` alongside the existing `mode: 'insert' | 'overwrite'`.

**Moment list** (`buildMomentList`): walks all four voices' layers in every measure, emits `(measureIdx, tstamp)` for each note/chord onset (tie-INITIAL only — terminal/medial continuations are not new onsets). Then adds every `<dynam>`'s tstamp and every `<hairpin>`'s start AND end moments (so orphaned expressions are always reachable). Sorted and deduplicated with float epsilon.

**Input commands**:
- Voice mode — `Shift+1`..`Shift+8` (`!@#$%^&*`) enter fff/ff/f/mf/mp/p/pp/ppp at the cursor's anchor moment (Finale order: 1 = loudest, 8 = softest). Insert mode anchors at cursor−1; overwrite mode at cursor. `<` / `>` mark hairpin start/end. Existing dynamic at the same moment is replaced.
- Expression mode — `1`..`8` enter dynamics (same Finale order); `<` / `>` for hairpins; arrows step the moment cursor; `Backspace`/`Delete` removes the selected expression element; `Home`/`End` jump; `Escape` cancels pending hairpin.
- Hairpins are entered in two steps regardless of mode: first key-press marks the start at the current moment, second key-press at a later moment closes the span. Pressing the OTHER form (e.g., `>` while pending a cres.) abandons the pending mark and re-starts. End-must-be-after-start; same-moment closes are rejected with a status hint.

**Visual cursor + selection** (`cursor.ts`): in expression mode the voice-cursor bar is hidden; an orange vertical tick is drawn between the two staves at the moment's x-position. X is sourced from a coincident note's rendered rect (preferring staff-1 voices so the tick sits in the between-staves band), or from the expression element's own rect when the moment is orphan (no co-located note). When the cursor lands on a moment with an existing `<dynam>` or inside a `<hairpin>`'s range, those SVG groups are tagged with `.expr-selected` and highlighted in the same orange.

**Playback** (`playback.ts`): a per-tick velocity timeline is built before walking voices for events:
1. `collectDynams` and `collectHairpins` resolve every element's moment(s) to absolute 64th-note ticks via `absoluteTickForMoment(doc, m) = measureIdx * measureTicks + (tstamp − 1) * ticksPerBeat`.
2. Per onset tick: the piecewise-constant level is "most recent `<dynam>` at-or-before this tick" (default `mf=85` before any dynam). The latest-started `<hairpin>` containing the tick adds linear interpolation between the level at-or-before its start and either (a) the next explicit dynam within its range, or (b) a synthesized end at startLevel ± 25.
3. Each `PlaybackEvent` gets `velocity: <effective>` attached. HKL's `dispatchChord` (hkl-side.ts) reads `ev.velocity ?? audio.keyVelocity[k] ?? 80`.

Per current MVP scope: held notes spanning a hairpin do NOT continuously change loudness — only newly-struck notes inside the span pick up interpolated levels. The bridge is already shaped to permit continuous shaping via `handleAftertouch`'s `pressureGain` ramp; that's a v1.1 extension.

**Document-level defaults** (`<extMeta>`/`<hkl:config>`): the dynamic→velocity map lives in `<meiHead><extMeta><hkl:config><hkl:dynamicMap>` under the `https://hexkeylab.com/ns/mei` namespace. Defaults seeded at document creation; edited via the Setup dialog ("Dynamics → velocity" row). The Setup dialog reads/writes via `getDynamicMap` / `setDynamicMap` from `expressions.ts`. The block round-trips through `XMLSerializer.serializeToString` and is preserved by Verovio. `<extMeta>` is the MEI 5 spec-blessed extension point for non-MEI metadata.

**Save / load**: extra `<measure>` children (`<dynam>`, `<hairpin>`) survive `serialize()` and `loadHkcFromFile` without special handling — they're just additional siblings to `<staff>`. `replaceDocument` calls `ensureExpressionDefaults` so older `.hkc` files without the `<extMeta>` config block get defaults seeded on load.

#### Planned extensions

The infrastructure landed in this iteration (`expressions.ts` Moment+tstamp helpers, `expressionCursor.ts` moment-snap cursor, `playback.ts` velocity timeline, `<extMeta>`/`<hkl:config>` defaults) is intentionally shaped so the following slot in without re-architecting:

- **`<tempo>` mid-score** — `addTempo(doc, moment, opts)` in expressions.ts. Extend `buildPlayback` with a tempo timeline (piecewise-constant; `@func="continuous"` segments interpolate using a `<hkl:tempoAlteration>` percent curve). Bake variable BPM into per-event `atMs` / `durationMs`. Document defaults: `<hkl:tempoMap>` (text → BPM table, e.g., "Largo"=50, "Andante"=80) and `<hkl:tempoAlteration ritPercent="0.65" accelPercent="1.35">` for the curve shape. Setup dialog already has scaffold rows reserved.
- **`<dir>` expressive text** — `addDir(doc, moment, opts)` for "espressivo", "molto", "pizz.", etc. Visual-only; no playback semantics. Same tstamp anchoring as dynamics.
- **`<slur>`** — note-attached via `@startid` / `@endid` (slurs are inherently per-note, not time-based). Lives in its own helper (NOT the tstamp expression layer). Entry via voice mode: select a range of notes, press `(` to wrap them. Visual-only playback for v1; legato/portamento behavior deferred until the audio engine has a model for it.
- **`<artic>` articulations** — children of `<note>`/`<chord>`, containment-based (no IDs). Per-note hotkeys in voice mode (e.g., `.` for staccato — conflicts with cycle-dots, keymap needs design). `@artic="acc stacc"` for stacked articulations. Playback: staccato shortens duration, tenuto extends, accent boosts velocity by a fixed Δ — all trivially layered on the existing per-note velocity/duration pipeline.
- **Continuous-loudness shaping through hairpins** — held notes spanning a hairpin currently keep their strike velocity. The audio engine's `handleAftertouch(key, pressure)` already ramps `pressureGain` smoothly per voice; future work adds a new `ComposerEvent` type carrying timed `(meiId, pressureValue, atMs)` triples so HKL can schedule per-voice pressure events alongside the chord queue. The protocol-level `velocity?: number` field stays as-is for onset-only velocity; the new envelope rides separately.
- **Click-to-select expressions** — Verovio emits xml:ids on rendered `<dynam>`/`<hairpin>` SVG groups; a click handler in `main.ts` can snap the expression cursor to that element's moment via `snapTo(c, moment)` (already exported from `expressionCursor.ts`).
- **Per-staff or per-voice dynamic scoping** — currently `@place="between"` dynamics apply to all four voices in playback. If users need per-staff dynamics (e.g., a `f` on the right hand while the left stays `p`), the velocity-lookup in `playback.ts` would consult the `<dynam>`'s `@staff` attribute and apply only to voices on that staff.
- **MusicXML export of expressions** — currently `save.ts`'s `exportMusicXml` ignores `<dynam>` / `<hairpin>`. Emit `<direction placement="below"><direction-type><dynamics><...></dynamics></direction-type></direction>` per dynam, `<wedge type="crescendo"/>` / `<wedge type="stop"/>` per hairpin. Lossy on `@val` overrides; document-level defaults are HKL-specific and don't translate.
- **Tstamp orphan migration on meter change** — `setTimeSig` calls `truncateOverflowingMeasures` which truncates note content past the new bar line. Expressions are not touched: a dynam at `tstamp="3.5"` in 4/4 stays at 3.5 after switching to 3/4 — now past the bar. If real-world meter edits cause confusion, add `truncateOrMigrateExpressions(prevMeter, newMeter)` alongside. The lessons.md entry "Expression-layer tstamp anchoring trade-off" describes the hook.
- **Continuous-tempo (`rit.`/`accel.`) baking** — when `<tempo @func="continuous">` lands, `buildPlayback`'s tick → ms conversion changes from a single `tickMsFromTempo` constant to a piecewise function with linear-or-cubic interpolation between flanking tempos. The `<hkl:tempoAlteration>` percentages determine the target tempo when no explicit "a tempo" follows.

The user-facing entry point for all of the above is unchanged: cycle ArrowUp/ArrowDown to the appropriate voice or to the expression layer, press a hotkey. New element types are additions to the keymap and the moment-list construction, not restructuring.

### 7.21 Tuplets

Single-measure, non-nested `<tuplet>` support. Ctrl+N (N=2..7) opens a "pending tuplet" state; the next duration digit completes creation by inserting a `<tuplet>` of opinionated ratio + atomic at the cursor. Nested tuplets are out of scope. A tuplet itself never straddles a barline (cross-measure splits inside a tuplet are never performed — the tuplet is the atomic unit of fit), but `insertWithSplit` IS allowed to push an existing tuplet wholesale across a barline if the insertion displaces it; see §7.14's planner.

**Ratio table** (Ctrl+N followed by duration digit `d`):

| N | num:numbase | span | atomic written-dur |
|---|---|---|---|
| 2 | 2:3 | dotted-d | d ÷ 2 |
| 3 | 3:2 | d        | d ÷ 2 |
| 4 | 4:6 | dotted-d | d ÷ 4 |
| 5 | 5:4 | d        | d ÷ 4 |
| 6 | 6:4 | d        | d ÷ 4 |
| 7 | 7:8 | d        | d ÷ 8 |

E.g. Ctrl+3,5 = triplet (3:2) of 8ths in the space of a quarter; Ctrl+7,5 = septuplet (7:8) of 32nds in the space of a quarter. The `num` and `numbase` are written to the MEI `<tuplet>` directly; Verovio renders the bracket and the numeral (count form, no ratio).

**Pending-tuplet flow** (`input.ts`): Ctrl+N sets `state.pendingTuplet`, prompts via the status line, and `preventDefault`s the keydown (browser would otherwise switch tabs). The next plain digit completes via `commitPendingTuplet`. Any other non-modifier key cancels the pending and falls through to its normal handler (so e.g. Ctrl+3 then ArrowRight cancels and moves the cursor; Ctrl+3 then Shift alone is a no-op so the user can still chord with Shift+digit). Ctrl+N at a cursor position genuinely inside a tuplet rejects with "Cannot nest tuplets." (Ctrl+N at the layer-level boundary just before a tuplet is allowed.)

**Data model** (live MEI). A `<tuplet>` element is a direct child of `<layer>`, sibling to `<chord>/<note>/<rest>`. Its `data-tuplet-atomic-dur` attribute records the atomic written-duration (e.g. `"8"`) for use by `regenTupletPlaceholders` (see below). Children are filled content elements (chord/note/rest) followed by zero or more trailing placeholder rests:

```xml
<tuplet xml:id="t-..." num="3" numbase="2"
        bracket.visible="true" num.visible="true" num.format="count"
        data-tuplet-atomic-dur="8">
  <note dur="8" pname="a" oct="3" .../>   <!-- F1 -->
  <rest dur="8" data-tuplet-placeholder="true"/>  <!-- fill anchor -->
  <rest dur="8" data-tuplet-placeholder="true"/>  <!-- atomic-aware regen -->
</tuplet>
```

Placeholders are `<rest>` (not `<space>`) because Verovio's tuplet-bracket-rendering pass only fires when the tuplet contains visible-content children — `<space>` is layout-only and excluded. The rest glyphs are hidden via CSS (see "Bracket workaround" below).

**Cursor stops (iter4 model)** — `navigableChildren(layer)` in `model.ts`:

Each `<tuplet>` element contributes `[tuplet-wrapper, ...in-tuplet-stops]` to the flat list. The wrapper itself is a layer-level stop ("before tuplet"). Its in-tuplet stops are:
- One stop before each filled child Fi (= cursor "inside the tuplet between two children" or at the first filled position).
- One stop on the first trailing placeholder (the "fill anchor") iff any trailing placeholders exist.

The cursor "after the tuplet" at layer level is the natural "before the next layer element" stop (no extra element needed).

Concretely:
- Empty tuplet `[note, tuplet]` → flat `[note, tuplet, fill-anchor]`; cursor positions 0..3 (4 stops: before-note, after-note=before-tuplet, on-fill-anchor, after-tuplet=past-end).
- Partial tuplet `[tuplet[F1], Q]` → flat `[tuplet, F1, fill-anchor, Q]`; cursor positions 0..4 (5 stops: before-tuplet, inside-before-F1, after-F1=on-fill-anchor, after-tuplet=before-Q, after-Q).
- Complete tuplet `[F1, F2, F3]` (no trailing placeholders): tuplet contributes `[tuplet, F1, F2, F3]`; fill anchor is absent.

This model gives the user-facing positions distinct flat-indices: cursor "before the tuplet at layer level" is distinct from cursor "before F1 inside the tuplet" (the former lets you insert AT layer level pushing the tuplet right; the latter lets you insert INSIDE the tuplet pushing F1 right within the bracket).

**Insertion semantics**:
- At "before tuplet at layer level" (`loc.inTuplet=null`, `withinIdx` points at the tuplet in `contentChildren`): layer-level insert via §7.14's planner. The tuplet may be pushed wholesale into the next measure when the insertion's tail leaves no room in the current one; the planner only rejects with "Insertion would push tuplet across bar line." when the target measure isn't empty in this voice. (The straddled-tuplet state is unreachable through any insertion path.)
- At an in-tuplet stop (`loc.inTuplet` set): the new element replaces some trailing placeholders' written-ticks. Total written-tick budget of the tuplet (= num × atomic) is invariant; the fill operation consumes from the trailing placeholders and the regen helper recomposes them.
- At "after tuplet at layer level" (cursor on flat[c]=post-content): layer-level insert before post-content.
- Overflow inside a tuplet rejects with "Doesn't fit in remaining tuplet space."

**Atomic-aware placeholder regeneration** — `regenTupletPlaceholders(tuplet, remainingTicks)`:

After any operation that changes the trailing-placeholder ticks (insert, replace, delete, dot-cycle), we regenerate the placeholder run preferentially as N atomic-sized rests (per the tuplet's `data-tuplet-atomic-dur`), with `decomposeTicks` as a fallback for awkward remainders. This makes fill+delete perfectly reversible: create a triplet of 8ths → `[P_8, P_8, P_8]`; insert an 8th → `[F1_8, P_8, P_8]`; backspace → `[P_8, P_8, P_8]`. Without atomic-aware regen, `decomposeTicks(24)` would yield a single `[P_dotted_quarter]`, which renders narrower than three separate placeholders.

For non-aligned remainders (e.g. inserting a written-dotted-8th = 12 ticks into a triplet of 8ths = 24 ticks budget leaves 12 ticks of placeholder): regen emits one atomic + the leftover decomposed, e.g. `[P_8, P_16]` (4 ticks of 16th-rest leftover from `decomposeTicks(4)`).

**Backspace cases** (`deleteAtCursor`):
- Cursor immediately to the right of the tuplet (or past its right edge): nibble the rightmost filled child, regrow trailing placeholders by its written-ticks. The tuplet's element survives until it's been emptied to all-placeholder state. N backspaces to empty an N-slot tuplet; one more removes the `<tuplet>` element entirely from the empty fill-anchor.
- Cursor "before F1 inside tuplet" (Backspace target = tuplet wrapper itself): cursor moves left to "before tuplet at layer level". Symmetric with the existing skip-left for layer-level placeholders. No deletion.
- Cursor between filled children (Backspace target = previous filled child of the tuplet): nibble that child; following filled content shifts left; trailing placeholders regrow.
- Cursor on fill anchor of an *entirely empty* tuplet: delete the whole `<tuplet>` element.

**Cursor visual rendering** — `cursor.ts:renderVoiceCursor` has two tuplet-specific anchor cases in insert mode (atop the default "right of flat[c-1]"):
- **Entering a tuplet** (flat[c-1] = tuplet wrapper, flat[c] is its first nav child): anchor at the LEFT edge of flat[c] — just inside the bracket — instead of the wrapper's right edge.
- **Exiting a tuplet** (flat[c-1] is a tuplet child, flat[c] doesn't exist or has a different parent): anchor at the parent tuplet's right edge — just past the bracket.

These rules also handle the previous iter3 "cursor on a tuplet placeholder" case: the exit-tuplet rule fires because the placeholder's parent is the tuplet and the next nav stop (post-tuplet content or undef) doesn't share that parent.

**Tuplet-internal beaming** — `beams.ts:regroupOneTuplet`:

After the layer-level beam pass, a second pass walks `doc.querySelectorAll('tuplet')` and beams each tuplet's content children as a single beat group. Consecutive beam-eligible elements (`@dur ≥ 8`, not rests) get a `<beam>` wrapper. Rests inside a tuplet split runs. Placeholder rests are ignored (filtered by `isTupletPlaceholder`). The existing `splitIntoBeamableRuns` and `wrapInBeam` helpers are reused — they take any parent element, not just `<layer>`.

**MusicXML export** — `save.ts:exportMusicXml`:

DIVISIONS is computed as `LCM(16, all tuplet @num values in the doc)` so each tuplet child's sounding ticks come out integer (e.g. triplet of 8ths needs `LCM(16, 3) = 48` divisions per quarter). Each child note inside a `<tuplet>` carries `<time-modification><actual-notes>num</actual-notes><normal-notes>numbase</normal-notes></time-modification>`. The first child's `<notations>` includes `<tuplet type="start" number="1"/>`; the last child has `type="stop"`. For chords inside tuplets, only the chord's *primary* (first) `<note>` carries the `<tuplet>` notation tag; all chord-member notes carry `<time-modification>`. Rests inside tuplets carry `<time-modification>` too (for DAW timing) but no `<tuplet>` decoration.

**Bracket workaround** — invisible tuplet placeholders:

MEI canonical for "invisible rest" is `<space>`, but Verovio's bracket-rendering pass excludes `<space>` as non-content; the bracket doesn't draw over an all-`<space>` tuplet. `<rest visible="false">` would be the spec-correct alternative — but Verovio doesn't honor `@visible` on rests (issue rism-digital/verovio#202 from 2016, still open as of v6.1). So placeholders are real `<rest>` elements with a `data-tuplet-placeholder="true"` marker; the rest glyph is hidden via CSS in `composer.html`:

```css
#score svg g.rest[data-data-tuplet-placeholder="true"] { visibility: hidden }
```

The `data-data-` prefix is Verovio's normalization — it prepends `data-` to attributes exposed via `svgAdditionalAttribute`, so the MEI attribute `data-tuplet-placeholder` becomes `data-data-tuplet-placeholder` in the rendered SVG. `visibility: hidden` preserves layout width (the bracket spans the right range); `display: none` would collapse it.

**Out of scope** (deliberately deferred):
- Nested tuplets — schema-allowed but rare and UX-complex; would need cursor model + bar-line check + status messaging extended. Cursor at any in-tuplet stop rejects Ctrl+N with "Cannot nest tuplets."
- `<tupletSpan>` (cross-bar tuplets) — also rare; can't be expressed atomically by the current placement model.
- Mid-tuplet insertion when out of placeholder space — rejected with status. No "push F2 past the bar" behavior because tuplets can't cross bars.

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
├── transcription/              # .hkr → LilyPond pipeline (§4.14)
│   ├── types.ts                # Onset, BeatGrid, Meter, ChordEvent, QNote, VoicedScore,
│   │                           #   TranscribeOpts, TranscribeResult
│   ├── pitch.ts                # coordToLilyPitch, darkColorHex (per-hue paper-readable
│   │                           #   palette), coordToMidi
│   ├── onsets.ts               # hkrToOnsets — FIFO on/off pairing, density-bonus strength
│   ├── tempo.ts                # IOI autocorrelation + log-Gaussian prior + parabolic peak
│   ├── beats.ts                # Ellis-DP beat tracker
│   ├── meter.ts                # downbeat-phase search
│   ├── chords.ts               # 30 ms first-anchor clustering
│   ├── quantize.ts             # per-bar Viterbi DP over allowed atoms (load-bearing)
│   ├── voicing.ts              # middle-C split + rest consolidation
│   ├── lyEmit.ts               # LilyPond emitter, Dutch syntax, per-notehead \tweak color
│   └── index.ts                # sessionToLilypond — orchestrator
├── bridge/                     # HKL ↔ Composer same-origin BroadcastChannel (§7.2)
│   ├── protocol.ts             # CHANNEL_NAME, HklEvent, ComposerEvent, ResolvedNote,
│   │                           #   CoordRef, PlaybackEvent type defs
│   ├── channel.ts              # BridgeChannel<In, Out> + createHklBridge/createComposerBridge
│   └── hkl-side.ts             # HKL-side subscriber: RAF held-keys poll, play-chord /
│                               #   play-score dispatch, playbackActive feedback suppression
├── composer/                   # HKL Composer entry — see §7
│   ├── main.ts                 # bootstrap + bridge wire-up
│   ├── model.ts                # ComposerModel: MEI as in-memory DOM; per-voice cursors;
│   │                           #   time-aligned switchVoice; mutation ops
│   ├── render.ts               # Verovio toolkit init (CDN), render loop, view modes
│   ├── cursor.ts               # Editing + playback cursor overlay (two modes)
│   ├── input.ts                # Keyboard handler (digit→duration, arrows, backspace, etc.)
│   ├── playback.ts             # buildPlayback, highlightElement, clearHighlights
│   ├── save.ts                 # .hkc save/load, .musicxml export
│   ├── verovio-types.ts        # Narrow TypeScript declarations for window.verovio
│   └── (composer-toolbar markup lives in composer.html)
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

**HKL viewer bundle** (`index.html`):
```
main → ui/init → ui/{controls, keyboard, recorder} → effects → engines (audio, midi, midi-io, lumatone) → recording → transcription → render → state → tuning + layout
                                                                  ↓
                                                          protocol + samples (encapsulated)
                                                                  ↓
                                                          bridge/hkl-side ← initialized at end of ui/init
```

**Composer bundle** (`composer.html`):
```
composer/main → composer/{render, model, cursor, input, playback, save, ui} → bridge/{protocol, channel} + transcription/pitch + tuning/notes + render/colors
```

The two bundles share `src/bridge/protocol.ts` and `src/bridge/channel.ts` plus a small set of pure helpers. Composer-side code must NOT import from `src/audio`, `src/midi`, `src/state`, `src/lumatone`, or `src/effects` — the bridge protocol is the only sanctioned interaction surface between the two apps. Verifiable by grepping `import.*\b(audio|midi|state|lumatone|effects)\b` in `src/composer/`.

Two cycle-prone seams:

1. **Effects ↔ engines**: `effects/onSelectionChanged` calls `syncOutput` (in `midi/engine`) which calls `syncAudio` (in `audio/engine`); `audio/engine.sostenutoOff` calls back into `effects/onSelectionChanged`. Works at runtime because ES modules resolve function bindings lazily — the cycle never executes during module evaluation, only during user-driven events.

2. **Recording capture-point ↔ snapshot apply**: `audio/engine` imports `recording/capture`, which imports `recording/snapshot` (leaf). Separately, `ui/recorder` imports `recording/apply`, which imports `ui/controls` → `audio/engine`. Keeping `apply.ts` separate from `snapshot.ts` is what prevents the cycle from closing through `recording/capture`. See `lessons.md` "Splitting modules to break import cycles beats dynamic imports."

---

## Appendix: Glossary

- **Band** — 3-key-wide region along q-axis where 5-limit JI is pure
- **.hkr** — HexKeyLab Recording format: JSON, version-stamped, layout snapshot + coordinate event stream. The canonical recording. See §4.13.
- **.hkc** — HKL Composer save format: MEI 5 XML with `data-q` / `data-r` custom attributes on every `<note>` preserving the lattice identity. Opens in any MEI viewer (Verovio web demos, etc.); only the playback / coord-aware features need HKL Composer. See §7.4.
- **Bridge protocol** — `BroadcastChannel('hkl-composer-bridge')` carrying typed `HklEvent` / `ComposerEvent` messages between the HKL viewer tab and the HKL Composer tab. Single source of truth: `src/bridge/protocol.ts`. See §7.2.
- **Comma** — small interval between two ratios that should be equivalent (syntonic 81/80, septimal 64/63, schisma, Pythagorean, etc.)
- **Diesis** — 128:125 (great), unreachable in 5-limit but reachable in 7-limit via syntonic adjustments
- **Fixed MIDI layout** — HKL's tuning-independent (channel, note) addressing for every physical key
- **Half-damper** — continuous pedal control over damper depth (vs. binary on/off)
- **HKL Composer** — the keyboard-driven notation editor at `composer.html`. Verovio for engraving; consumes HKL's held-keys via the bridge protocol. See §7.
- **Lumatouch** — Lumatone keyType 3, continuous fader (NOT poly aftertouch)
- **LTN** — Lumatone preset/mapping file format
- **MEI** — Music Encoding Initiative XML format. HKL Composer's canonical in-memory model and `.hkc` save format. See <https://music-encoding.org>.
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
- **Verovio** — RISM Digital Center's MEI → SVG rendering engine. Used by HKL Composer as a WASM module loaded from the verovio.org CDN. Sub-100 ms re-render typical; primary live-engraving back-end for the editor.
