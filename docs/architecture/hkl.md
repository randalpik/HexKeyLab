# HKL Core — Architecture & Feature Reference

Human-readable source of truth for the HKL viewer app (`apps/hkl/`). For the project overview, tuning theory, and coordinate system see [`../architecture.md`](../architecture.md). For sample playback internals see [`engine.md`](engine.md) (the `@hkl/engine` package).

---

## Hardware integration

### Lumatone

- **Layout**: 5 boards × 56 keys = 280 keys, hexagonal isomorphic.
- **Physical board swap** (Max's unit): boards 3 and 4 are swapped, encoded as `sysexBoardMap = [1,2,3,5,4]` (group index 0-indexed → SysEx board ID 1-indexed). Every LTN file, MIDI map, and SysEx send must respect this.
- **Connectivity**: USB-MIDI (primary), 5-pin DIN in/thru/out, 1/4" Sustain jack, 1/4" Expression jack.
- **SysEx envelope**: `F0 00 21 50 <board> <cmd> <data1-4> F7`. Manufacturer ID `[0x00, 0x21, 0x50]`. Per-key data: (keyIndex, noteNum, channel-byte 0-indexed, typeByte) where `typeByte = (faderUpIsNull << 4) | keyType`, keyType ∈ {0=disabled, 1=noteOnNoteOff, 2=CC, 3=lumaTouch}.

### Pedal jacks

| Jack | CC | Behavior |
|---|---|---|
| Sustain | 64 (binary) | Switch pedals work; continuous half-damper quantized to binary by firmware. |
| Expression | 4 (Foot Controller) | Roland-wired (wiper on ring). Continuous. |

- **Expression wiring**: Roland convention (T=end1, R=wiper, S=end2). Works: Roland DP-10 (Continuous mode), Roland EV-5, Yamaha FC7 (with firmware Invert toggle). **Does NOT work**: Korg-convention pedals (DS-1H, DS-2H — ring floating, ADC reads noise indistinguishable from a binary switch).
- **Calibration mode** (CMD 0x38): learns ADC bounds for the connected pedal. While active, firmware emits CMD 0x3E status packets every ~100ms with running min/max + valid flag.
- CC numbers are **not** remappable via SysEx. Sensitivity (CMD 0x03) is a 0–127 gain scalar; polarity invert (CMD 0x04) is boolean.

### Lumatone internals (reverse-engineered)

Needed only for per-key hardware calibration (units with broken macro buttons) or diagnostics. Normal HKL operation requires none of it. → full workflow in [`../lumatone-calibration.md`](../lumatone-calibration.md).

- **Hardware**: BeagleBone Black running Debian + 5 PIC microcontrollers (one per board). BBB↔PIC over UART `/dev/ttyO1`; host↔BBB over USB-MIDI. BBB is also a USB-ethernet gadget — device IP `192.168.6.2` (Linux host) / `192.168.7.2` (Mac/Windows). SSH `debian`/`temppwd`. Firmware: `/home/debian/TerpstraController/TerpstraController` (ARM 32-bit ELF, debug info), respawned forever by `lmtn_launcher.sh`.
- **Per-key calibration state** lives in two layers:
  - **Disk** (persistent): `/home/debian/TerpstraController/files/KeyData_1..5`, plain text, 4 sections × 56 values (MAX/MIN/validity/AT-MAX thresholds). Loaded at TC boot, pushed to PICs.
  - **RAM** (volatile): `kbd_preset_params` struct in `.bss`, 638-byte stride/board; offsets `+0x118` MAX, `+0x150` MIN, `+0x1c0` validity, `+0x1fe` AT-MAX. Lost at restart/power cycle.
- **Indexing**: both layers use **PIC number** (`sysex_board`), not spatial board position. Slot `i` ↔ `KeyData_(i+1)` ↔ PIC `i+1`. The `sysexBoardMap` physical-swap only enters when translating spatial board_group → PIC number, never when indexing firmware structures.
- Tooling: `tools/lumatone-cal/` Python scripts read/write both layers (`/proc/<tc-pid>/mem` volatile, file edit persistent).

### Self-contained audio

The Lumatone sends MIDI on a fixed (channel, note) scheme. HKL maps those addresses to lattice positions, computes frequencies from the active tuning system, and renders audio through `@hkl/engine` — no external synth in the path. A3 = 220 Hz is the central reference.

---

## Features

### Display

- **Hex grid** rotated counterclockwise; `tiltAngle` is mode-dependent (set per outline by `setTiltForOutline` in `apps/hkl/src/layout/geometry.ts`: distinct values for Lumatone / Piano / vertical-frequency default). Gradient: q-axis = log(2)/3 per step (octave constraint); r-axis = midpoint of 5-limit log(3/2) and 7-limit adjusted value.
- **Canvas sizing**: width = max(400, viewport − 24px); height from keyboard vertical extent + `padY = hexR + dxH × 0.5`. Vertical centering `kbOffY = −(minY + maxY)/2`. Wrapper `min-width: 424px`.
- Hex shapes drawn in rotated context; note text drawn unrotated for readability.
- **Extend pattern toggle** clamps cell range to keyboard extent when off.

### Controls

Two centered rows.

- **Row 1**: Note names · Band seams · Extend pattern · Show coordinates · Short intervals · Outline selector · Rotation selector.
- **Row 2**: Tuning selector · Transpose controls · Audio + Instrument · Clear · Lumatone status panel · Recording controls · Reset prefs.

| Control | Behavior |
|---|---|
| Tuning selector | {Equal, Ptolemaic, Pythagorean, Semiditonal, Septimal}. Sets `tuning.mode` (derives `equalEnabled`/`septimalEnabled` for legacy sites); ramps audio. |
| Outline selector | {Lumatone, QWERTY, Piano, None}. Selects the footprint outline; lattice slides via refSpine (Lumatone/QWERTY/None) or piano-viewport math (Piano). Ctrl+click any hex sets the ref note → drives positioning. |
| Transpose | 5-axis ▲/▼ stacks (P5, M3, m3, P8, SC), always visible. Key-repeat 400ms initial / 80ms subsequent. Selection transpose only — positioning is via ref note. |
| Audio | Toggle + instrument/waveform selector. Piano default. Samples lazy-load with a blue "loading…" state. |
| Clear | Deselects all. |
| Lumatone status panel | Connection badge; **Pedals dropdown** (Sustain / Sostenuto+Sustain — how the sustain jack is read); **Calibrate Pedal** button; Auto-sync checkbox + status badge. |
| Recording controls | ● Rec / ▶ Play / Save .hkr / Load .hkr / Export .mid / Import .mid + status pill. |

### Keyboard shortcuts

- **Ref note**: set via **Ctrl+click** on any hex — lattice tweens to put that ref's qm=0-normalized spine cell at the outline center. Ctrl+click on the current effective ref clears the manual override.
- No global window-level shortcuts at present (legacy arrow-key layout cycle/seam shift removed). `apps/hkl/src/ui/keyboard.ts` is reserved as the entry point for future shortcuts.

### Selection & interaction

- **Click** toggles a key; **Shift+click** exclusive-selects; **Clear** deselects all.
- **Hover**: `hoverKey` tracks the hovered cell, drawn with a distinct highlight outside selection treatment; cleared on mouseleave.
- **Selected keys**: brightened fill (+90), white border ring at hex edge; persist through layout switches.

### Ref-driven layout animation (500ms)

- Smoothstep position easing via `apps/hkl/src/render/animation.ts:tweenTo(targetQ, targetR)`. View center (`viewQ`, `viewR`) animates old→new on every ref change.
- Audio voices ramp frequencies over the duration (sustained instruments glide; decaying instruments stop+retrigger at end).
- Keyboard outline + dark overlay stay static — the lattice slides underneath; the Lumatone polygon holds its pixel position while cells beneath shift.
- **Hex layer pre-built across `[view → target]`** via `buildHexLayerForTween(startQ, startR, endQ, endR)` so each frame blits from a layer covering both endpoints (otherwise the moving view crosses the offscreen-layer edge mid-tween and shows cut borders). `pendingTweenStart`/`pendingTweenEnd` carry the range into `sizeGridCanvases`, which uses the midpoint as gridRef + half the tween distance as pad. Applies to all outline modes.

### Chord transposition (5 axes)

Axes: P5 (0,+1), M3 (+1,0), m3 (−1,+1), P8 (+3,0), SC (−7,+4).

- **Bounds check**: blocked if any note's screen center would leave canvas.
- **Audio**: 100ms slide (`exponentialRampToValueAtTime`); sustained samples glide-and-fade; decaying instruments stop+retrigger.
- **MIDI**: `stopAllMidi()` + `syncMidi()` after re-keying.
- No-op when nothing selected.

### Note naming

- `fifthName(r)` algorithmically computes names for any fifths distance. Labels render via a single Bravura SMuFL path (`drawHejiLabel` in `apps/hkl/src/render/draw.ts`): sans-serif letter + Bravura combined-glyph chain at 1.8× with shrink-to-fit (`scale = min(1, hexR×1.3 / totalW)`). The chain is built by `hejiLabel()` in `apps/hkl/src/tuning/heji.ts` — bare accidentals when HEJI off, accidental+arrows + septimal hooks when on.
- `drawNoteName` early-returns until `bravuraLoaded` (bundled `public/BravuraText.woff2` resolves on first paint), so the lattice paints nothing pre-load rather than flashing a Unicode chain.
- **Exponent collapse** (`COLLAPSE_THRESHOLD = 4`): when |AD| or |SD| > 4, `hejiLabel()` emits a `collapse` spec — one accidental-form glyph + sans-serif superscript count:
  - **Case A** (both |AD|>4 AND |SD|>4): glyph = accidental + 1 arrow, exponent `k = min(|AD|,|SD|)`, position `before`. Leftover (excess of larger count) distributed by chain code.
  - **Case B** (|AD−SD|>4, greedy): `k = ||AD|−|SD||` absorbs the excess. |SD|>|AD| → natural+1 arrow, `before`; |AD|>|SD| → bare accidental, `after`. Leftover has equal residual AD/SD.
- Septimal hook always sits at the very end regardless of collapse position. Composer's ±3 entry gate is unaffected — collapse is lattice-only.

### Info panel

Scrollable panel below the canvas (max-height to viewport).

- **Row 1 — Note cards**: each selected key as a colored tag (name in keyboard hue, octave, Hz), sorted low→high. With "Show coordinates" also shows `(q= r= p=)`.
- **Row 2 — Chord analysis** (3–4 unique pitch classes): root (colored), quality, inversion, root-position JI ratio. Template matching uses semitone intervals + letter distances over **25 templates**: triads (major, minor, dim, aug, sus4, sus2, Pythagorean); 7ths (major, dominant, minor, minor-major, dim, half-dim, aug, aug-major); added-2nd; aug-6ths (Italian, French, German); incomplete 7ths (dom, minor, major, minor-major, dim). Labeled "septimal" when root-position ratio has a factor of 7 AND max term ≤ 27. Equal mode hides ratio and strips "septimal".
- **Rows 3+ — Intervals**: all pairwise intervals grouped by generic size; colored note names + octaves, cents, named interval.
  - 5/7-limit: JI ratio shown; color by complement-reduced Tenney Height — green (<8), yellow (8–12.5), red (≥12.5).
  - Equal: no ratio; names via `equalIntervalName()` (from actual note names + octaves, not lattice displacement). `semis % 12 === 0` → green (rational: unisons, octaves, d2/A7); else red.

### Short intervals mode

`shortenInterval(name)` post-processor, three phases:
1. Full-phrase specials (harmonic→7m, lesser/greater septimal tritones).
2. Word-by-word abbreviations (P/m/M/d/A, ordinals→cardinals, comma terms SC/7C/PC/7D/A1/Ds/Sc/D/A/C).
3. Structural cleanup (strip spaces, re-insert around ±).

Uses HTML entities for lesser/greater glyphs.

### Interval naming

Every 5/7-limit interval is named `<base interval> ± commas`, where the **base comes from the diatonic spelling of the endpoints**, never from ratio shopping. Enharmonic-equivalent ratios are named by how they're written (F#→D is always a 6th); V-mode band-crossings surface their schisma additively. → rationale in `decisions.md`.

**Algorithm** (`apps/hkl/src/tuning/intervals.ts`):
1. `classifyDiatonic(q1,r1,q2,r2)` → `{ord, qual, extraOct}` from `noteName`+`keyOctave` letter distance + 12-TET semitones (same logic as `equalIntervalName`).
2. `pythagRefExp(ord, qual)` → closed-form Pythagorean prime-exponent vector (no table; from natural fifths-position + apotome stacks).
3. `jiRatioWithState` → actual exponent vector (mode shifts + V-mode schisma stacking).
4. Difference vector → `solveCommas` → `(s, z, h)` syntonic/septimal/schisma counts.
5. `findBaseName(ord, qual, s, z)` picks the **nearest** override: enumerates all `(ord,qual)` overrides + Pythagorean default at `(0,0)`, scores by `|s−s_o| + |z−z_o|`, emits residual as commas. Ties prefer 5-limit (`z_o=0`) over septimal, and any override over the Pythagorean default. (So `(3,M,s=−2)` → "major 3rd − syntonic comma", not "Pythagorean major 3rd − 2× SC".)
6. Schisma `h` always renders as a suffix; never absorbed into the base.
7. `fmtInterval` handles compound ordinals and octave-prefix forms ("2 octaves + apotome").

**Override table** (`PAIRS`): array of complement-pair declarations. Each declares one half (`c1`); the other (`c2`) auto-mirrors via `autoMirror`, which swaps ord suffix (3rd↔6th), quality word (major↔minor, augmented↔diminished), and the adjective pairs **lesser↔greater** and **acute↔grave**. An explicit `mirror:` field overrides auto-mirror for class-specific phrases (apotome, harmonic 7th, chromatic semitone, diminished octave, subminor/supermajor). `c2` is **optional** — single-class declarations for classes whose complement is structurally unreachable (e.g. `(8,A)`, whose complement `(1,d)` never normalizes out of `classifyDiatonic`).

**Naming conventions** (fixed-meaning adjectives, never positional):

| Adjective | Meaning |
|---|---|
| `lesser`/`greater` | The two 5-limit (z=0) variants of a quality, one SC apart, both 5-limit-common. `greater` = higher cents. e.g. lesser/greater augmented 4th. |
| `acute`/`grave` | One-SC variant on the *opposite* side of a 5-limit-common interval (exotic). e.g. acute major 2nd (729:640 vs common 10:9), grave minor 7th (1280:729). |
| `septimal` | One prime-7 factor vs the base; most sit one SC from the Pythagorean ref (9:7, 7:6). A few use the keyboard-accessible (s,z) tuple in Septimal mode (see below). |
| `subminor`/`supermajor` | The (2,m)/(7,M) extension capturing 28:27 / 27:14. Explicit mirror required (word-boundary regex won't transform it). |
| `wolf` | The narrowing 5-limit P-class variants: wolf 4th (27:20), wolf 5th (40:27). Widening-direction P-class has no override — surfaces as "perfect X + syntonic comma". |

**Septimal ratio assignment** (HKL-specific): most follow xen-wiki (`septimal minor 3rd`=7:6, `septimal major 3rd`=9:7, `harmonic 7th`=7:4). Four exceptions bind to the most-accessible Lumatone cell pair in Septimal mode rather than the canonical ratio (→ rationale in `decisions.md`):

| Name | HKL ratio | Canonical (xen-wiki) |
|---|---|---|
| septimal augmented 2nd | 135:112 | 25:21 |
| septimal augmented 4th | 81:56 | 10:7 |
| septimal diminished 5th | 112:81 | 7:5 |
| septimal diminished 7th | 224:135 | (mirror of 25:21) |

Consequence: 10:7 reads as "greater augmented 4th + septimal comma", 7:5 as "lesser diminished 5th − septimal comma".

**Notable spellings**: 9:8 = "Pythagorean major 2nd"; 10:9 = "major 2nd"; 16:9 = "Pythagorean minor 7th"; 9:5 = "minor 7th"; 4096:2187 = "Pythagorean diminished octave"; 531441:524288 = "Pythagorean comma" (via `pythag2` on the `(7,A)↔(2,d)` pair). Pure octave multiples: "perfect octave" (2:1), "perfect 15th" (4:1), "perfect 22nd" (8:1).

**Comma basis**: syntonic 81/80, septimal 64/63, schisma 32805/32768 (3 linearly independent commas spanning the 5/7-limit lattice). Output sticks with primary commas to match HEJI accidental semantics.

**Verification tooling**: `tools/interval-names/enumerate.ts` enumerates every Lumatone key pair in a mode, grouping (ord,qual,s,z,h) by taxicab distance (finds naming gaps); `tools/interval-names/smoke.ts` runs representative cases per mode.

### Lumatone output

**Auto-sync** (checkbox + status badge):
- On every color-affecting state change, `syncLumatoneColors()` computes the 280-entry target, diffs against tracked `deviceColors`, queues only changes.
- **Visual wipe sort**: changed keys pushed +q (L→R), −r (top→bottom).
- **In-flight race**: an awaiting-ACK SysEx's color is folded into the predicted snapshot so the diff accounts for the device's near-future state.
- **Queue swap, not restart**: a new sync replaces `sysexQueue` without cancelling the in-flight message (which finishes naturally). `sysexCancelAll()` tears everything down when Auto-sync is turned off.

**On-connect setup** (first auto-sync after `findLumatone()`):
- 280 × `CHANGE_KEY_NOTE` (fixed MIDI layout)
- `SET_AFTERTOUCH_FLAG (0x0E) = 1`
- `SET_LIGHT_ON_KEYSTROKES (0x07) = 1`
- `queryFirmwareRevision()` (silent; logged)

**Pedal calibration**:
- Calibrate Pedal button toggles cal mode. Active: panel shows live ADC min/max (from CMD 0x3E packets) + valid flag. No CC4 readout (firmware suppresses CC4, sends 0x3E instead).
- Reset to Factory button sends CMD 0x39.
- Max debug logging while active (every 0x3E first+10th raw, every CC4 with timing, entry/exit). Outside cal mode: CC4 endpoints only.

### Lumatone input

`handleMidiMessage(e)` dispatches:

| Message | Handling |
|---|---|
| SysEx CMD 0x3E | calibration packet handler |
| Other SysEx | `sysexHandleResponse` (ACK matching) |
| CC 4 (expression) | `pedal.cc4Depth = d2/127`; `setDamperDepth()`. Verbose during cal; else endpoints (0/127) only. |
| CC 64 (sustain) | role per `pedal.mode`: `'sustain'` → binary damper (`cc64Depth = d2≥64?1:0` + `setDamperDepth()`); `'sostenuto'` → `sostenutoOn/Off()`, no damper touch. |
| Note on/off | audio + selection. Note-off branches on `sustainPedalDown ‖ sostenutoLockedKeys.has(key)`: keep or release. |
| Poly aftertouch (0xA0) | per-voice volume modulation. |

Note routing uses the **fixed MIDI layout**: stable (channel, note) per physical key. `fixedMidiToKey(ch, note)` converts at input time — channels 0–4 = the five board groups, notes 0–55 = key index within board.

### Piano output (external-synth JI playback)

`apps/hkl/src/midi/piano-out.ts`. The "Piano output" toggle (Piano tab) mirrors HKL playback to an external MIDI synth at true JI, even on synths with **no pitch bend / no MPE** (e.g. Korg SP-250).

**Mechanism**: such synths honour **RPN 0001 (channel fine tuning)**, ±100¢ over 14 bits (center 8192, 81.92 steps/cent). A note-on re-applies the channel's current fine-tune to every voice on that channel → distinct tunings need distinct channels. So **one voice per MIDI channel** (`MpeAllocator`, constructor-configurable channel range/reuse/exclusions). Piano output uses channels **1..16 minus 10 and 16** in **FIFO** order:
- ch 10 = GM percussion (note-on plays a drum map, not a pitch).
- ch 16 (this SP-250) ignores note-off and won't accept the RPN tune.
- FIFO lets a reused channel's release tail decay before reuse. → 14 melodic channels.

Per note-on: `keyFreq(q,r)` → nearest 12-TET note + cents (`freqToNoteFine`, A4=440) → RPN 0001 CCs → note-on, on that channel.

**Overflow guard**: keys evicted past the 14-voice cap go into a `shed` set (wanted but silent), skipped by the start loop until they leave `want` — newest 14 sound, no churn. `restrikePianoOut` drops a key from `shed` so a re-strike can re-compete. (Avoids the steal-oldest cascade of a naive membership diff.)

**Hook**: `syncPianoOut()` runs from `syncOutput()` tracking `selectedKeys ∪ sustainedKeys`. Self-gates on its own enabled flag, **independent of `audioEnabled`** — so muting Audio + enabling Piano output makes the external synth the sole source. Sustain needs no CC64 forwarding (HKL defers note-off until pedal release). Aftertouch not forwarded.

**Pedal capture**: a sustain pedal on the piano-input device sends CC 64 on the same port; `piano.ts`'s `pianoMessage` routes it (`handleSustainCC`) through shared `pedal` state via `setDamperDepth`. **Always acts as sustain** (continuous half-damper), independent of the Lumatone sustain/sostenuto dropdown. Feeds HKL's deferred note-off, so held JI notes ring on the external synth until release (matters with Local Control off).

**Rearticulation**: re-striking a pedal-held key doesn't change `selected ∪ sustained` membership, so the diff won't re-fire. `restrikePianoOut(key)` tears down the voice (note-off + free channel) at each re-strike, before the following `syncPianoOut()` re-acquires + re-strikes with updated velocity.

**Composer playback**: the bridge dispatch (`apps/hkl/src/bridge/hkl-side.ts`) drives the engine directly and calls `draw()` (not `onSelectionChanged`, to avoid echoing held-keys to Composer), so `syncPianoOut` is wired explicitly at each point the dispatch mutates `selectedKeys` + draws (chord attack, per-voice note-off timer, `abortActive`); `restrikePianoOut(k)` runs in the same-pitch back-to-back branch. Slur glides surface as note-off-old/note-on-new re-attack via the selection diff.

**Program mirroring**: each channel is an independent timbre slot. `pianoMessage` captures Program Change off the input port (regardless of input-enabled gate) and `setOutputProgram()` **broadcasts to all 16 channels** — on PC capture and after `open()` resolves, never per-note (the CH345 adapter drops bytes under burst). `currentProgram` is null until a PC is seen.

**Channel levels**: `broadcastChannelLevels()` forces every channel to CC7=100, CC11=127 on enable/rebind and after each PC (GM channels have independent volume/expression defaults that otherwise surface as note-to-note jumps).

**Local control**: `sendLocalControl(port, false)` (CC122=0, all channels) on enable/wire so raw 12-ET keys aren't heard; CC122=127 restores on disable / port switch / page close (`beforeunload`). CC122 may be a no-op on some units.

**Device**: output port **auto-matches the selected Piano input device by name** (`rebindPianoOut()` on enable, input-device change, MIDIAccess statechange) — no separate dropdown. The bound port is explicitly `open()`ed (Firefox doesn't open eagerly on `send()`). Requires the synth on Omni On / multi-timbral. Persisted via `pianoOutputEnabled`.

---

## Recording, playback & MIDI round-trip

HKL records every performance (Lumatone, QWERTY, mouse) as a stream of lattice-coordinate events, plays it back through `@hkl/engine`, and exchanges `.mid` files with external DAWs.

### Architecture

- **`.hkr` (JSON, source of truth)**: layout snapshot (tuning, septimalW, instrument, pedal mode, A3 ref) + flat event list `[{t, k, q, r, …}]`. Version-stamped (`format:"hkr", version:1`); event kinds `on/off/pa/cc4/cc64/warn` keyed by `k`. Timing is `audioCtxSec` from `epoch=0` (the engine's ramp-schedule clock). No back-compat with pre-legacy-purge files.
- **`.mid` (binary, derived)**: exported/re-imported deterministically against the same snapshot. The two files travel **separately** — not bundled.
- **MPE export**: single-track format-0. Channel 1 = manager (CC4/CC64 + MPE Configuration Message); channels 2–16 = members (one voice each). Per-member pitch-bend range ±48 semitones via RPN 0. Tempo fixed 120 BPM, PPQ 960.
- **MIDI → `.hkr` inverse**: requires the originating snapshot (UI prompts "Load matching .hkr first"). Builds a frequency index over the lattice under the snapshot's tuning; each noteOn's `(note, channel-bend)` → frequency → nearest-match. 25-cent sanity gate; farther emits a `warn` event.

### Capture point

Hooks live **inside `@hkl/engine`**, not at the MIDI input handler — the convergence point for every source (Lumatone notes after `(channel,note)→(q,r)`, QWERTY, canvas clicks all flow through `noteOn`/`noteOff` before sounding). One line per engine entry point catches everything. CC4/CC64 capture in `setDamperDepth` + `sostenutoOn/Off`; poly aftertouch in `handleAftertouch`. Hooks short-circuit when `audioEnabled === false` — silent input is not recorded (intentional; recording without audio is meaningless).

### Playback

Web-Audio look-ahead scheduler (Chris-Wilson pattern): 25 ms `setTimeout` loop walks events within the next 100 ms window vs `audioCtx.currentTime`, schedules a per-event `setTimeout` to dispatch on time. Dispatch routes per `k`:

| Kind | Action |
|---|---|
| `on` | `noteOn` + add to ledger + add to `selectedKeys` + `draw()` |
| `off` | `noteOff` + remove from ledger + remove from `selectedKeys` + `draw()` |
| `pa` | `handleAftertouch` |
| `cc4` | `pedal.cc4Depth = v; setDamperDepth()` |
| `cc64` | `setDamperDepth()` (sustain) or `sostenutoOn/Off` (sostenuto), per snapshot `pedalMode` |

- **Ledger** (`playbackKeys: Set<KeyId>`) tracks playback-created voices only — stopPlayback releases those, leaving user-held voices alone. Live input is allowed during playback and mixes in.
- Applying the snapshot at play-start drives the real control handlers (`setTuning`, `changeWaveform`) so all side effects fire (color sync, info refresh, prefs). Sample instruments awaited if not loaded.

### Transport

Three mutually-exclusive states `idle | recording | playing`. State lives module-private in `apps/hkl/src/recording/capture.ts` + `playback.ts`; UI in `apps/hkl/src/ui/recorder.ts` reads via `isRecording()` / `isPlaying()`.

**Auto-balance**: starting Record emits synthetic `on` at t=0 for held voices; stopping emits synthetic `off` for still-held voices → the recording is self-balanced, no stuck notes on playback.

### UI

Toolbar group after the Lumatone block: Rec / Play / Save .hkr / Load .hkr / Export .mid / Import .mid + a `recording-status` pill ("Idle" / "Recording 0:04" / "Playing 0:02 / 0:18" / "Loaded 0:18"). Timer runs only while state ≠ idle (`requestAnimationFrame`).

`?hklrec=1` exposes `window.__hkl_rec` with `getSession()`, `setSession(s)`, `selfTestRoundTrip()` for DevTools verification.

### Audio capture (sidecar .wav)

Independent of `.hkr` capture. A "Capture audio" toggle brackets the master-bus output of every record/playback span and downloads a 44.1 kHz / 16-bit stereo `.wav` (`hkl-<isoStamp>.wav`). The tap is an `AudioWorkletNode` (`apps/hkl/src/audio/capture-worklet.js`) as a parallel sink off `limiter` (`limiter → destination` untouched; `limiter → captureNode` runs alongside). The worklet posts stereo Float32 frames; `apps/hkl/src/audio/capture.ts` accumulates and calls `encodeWav16()` in `apps/hkl/src/audio/wav.ts` on stop.

The span ends 1.5 s after Stop/playback-end so release tails land. `.wav` is a separate download (same isoStamp), faithful to the engine output (post high-shelf, post limiter) where a `.hkr` re-render through a non-HKL synth would not be.

### Out of scope for v1

- **Layout change mid-record**: detected; emits one `warn` on first divergence, then continues against the original snapshot.
- **Paused playback**: none.
- **Bundled `.hkr` + `.mid`**: stay separate.
- **Tempo / time signature in `.hkr`**: not modeled (MIDI export uses fixed 120 BPM 4/4 for DAW quantizers).
- **Composer export (`.hkc`)**: see below.

---

## `.hkr` → `.hkc` transcription

Takes a `.hkr` recorded at roughly constant tempo in a user-supplied time signature, produces a Composer-native `.hkc` (MEI 5) colored-notehead grand staff — downloadable or sent straight to Composer over the bridge for editing. **v1 scope**: 8th-note minimum granularity, middle-C voice split, no microtonal accidentals (12-TET notation; lattice spelling from `noteName(q,r)` gives the enharmonics). The `.ly`/LilyPond emitter it replaced is gone.

### Pipeline

`.hkr` → onsets → tempo → beats → meter → chords → qnotes → voiced → `.hkc`. Eleven modules under `apps/hkl/src/transcription/`, one per stage. Identity (`Onset.id`, `QNote.sourceOnsetIds`) flows end-to-end for a future correction UI; each `QNote` also carries a `coords: {q,r}[]` array (parallel to `pitches`) so the emitter spells from the exact lattice cell rather than a MIDI-only guess.

**Tempo (`tempo.ts`)**: IOI autocorrelation on a 10 ms binned onset envelope, weighted by a log-Gaussian prior peaked at 100 BPM (σ=0.3 log). A BPM hint hard-constrains the lag search to ±15% of the hint period. Parabolic peak interpolation for sub-bin resolution. Octave (half/double) errors are the standard failure mode — mitigated, not eliminated.

**Beats (`beats.ts`)**: Ellis-style DP — `C(t) = s(t) + max(0, max_{t'∈[t−dMax, t−dMin]} C(t') − λ(t−t'−T)²)`, T = target period, `dMin/dMax` = ±50% of T, `λ = 0.5`. Traceback from the highest-scoring beat in the final T-window.

**Meter / downbeat (`meter.ts` + `quantize.ts`)**: phase search over `numerator` offsets — for each phase ∈ [0, numerator), sum onset strength near beats whose index ≡ phase (mod numerator); pick the max. In `quantize.ts` the chosen phase's beat time is extrapolated **backward by whole bars** until the tick origin ≤ the first onset's time, so leading notes land as a bar-0 pickup rather than being clipped.

**Chords (`chords.ts`)**: cluster onsets whose `t` is within 30 ms of the **first** member of the current cluster (not the last — "last" allows transitive drift and over-groups fast runs). Representative `t` = median; `tOff` = max.

**Duration quantization (`quantize.ts`)** — the load-bearing module. Per-bar Viterbi DP over an allowed atom set (64th-note ticks at `subdivisions: 32`/quarter):

| Atom | Ticks | Notation base | Complexity |
|---|---|---|---|
| 8th | 16 | `8` | 0.10 |
| quarter | 32 | `4` | 0.00 |
| dotted quarter | 48 | `4.` | 0.30 |
| half | 64 | `2` | 0.05 |
| dotted half | 96 | `2.` | 0.35 |
| whole | 128 | `1` | 0.10 |

(v1 omits 16ths/32nds.) Position snaps to a 16-tick (one-8th) grid. Per bar, the DP fills `(startTick, durTicks)` with atoms minimizing:

```
total_cost = Σ atom.complexity + Σ TIE_COST × (atoms − 1) + Σ boundary_penalty(atom)
```

- **`TIE_COST = 0.40`** — calibrated so single-atom notations beat tied chains at clean alignments, but ties win where they should (a half from beat 2 of 4/4 prefers `quarter + quarter tied`).
- **Boundary penalty** = `0.05 × (worst_metric_weight_inside_duration − start_weight)`. Metric weights: bar start 100, bar middle (4/4) 50, beat 25, 8th 8, 16th 6.
- **Rest insertion**: if a chord's release-tick is ≥ 16 ticks before the next onset, a rest fills the gap; below that, the silent time folds into the preceding note's duration.

**Voicing (`voicing.ts`)**: middle-C (MIDI 60) threshold per chord. All-treble/all-bass → one staff; mixed → split (≥60 to treble voice 1 staff 1, <60 to bass voice 1 staff 2, same `startTick`). **Rest consolidation** runs after the split: consecutive `isRest` QNotes merge per voice, slice at bar boundaries, re-fed through `splitDuration` so an all-rest bar collapses to `r1` instead of mirroring the active staff's rhythm. → see `lessons.md` "Rest consolidation in voicing fixes the 'mirroring' bug."

**MEI emission (`meiEmit.ts`)**: builds the `.hkc` via the shared `@hkl/notation/mei-build` builder — the single source of truth for the `.hkc` dialect, shared with Composer's model (`emptyMeiDoc`, `buildNoteElement`/`buildChordElement`/`buildRestElement` all live there now; Composer re-exports them). `emitMei` reuses the head/`hkl:config`/scoreDef skeleton (`layoutReq.tuningMode` from the recording's snapshot, `refQ/refR = 0,0`), then appends one `<measure>` per bar: treble → staff 1 / layer 1, bass → staff 2 / layer 1 (layer 2 left empty; Composer fills placeholders on load). Each note carries `data-q`/`data-r` + a pre-darkened `color`; spelling reuses `noteName(q,r)` + `keyOctave(q,r)` from `@hkl/shared/notes.js` (sharps on +r, flats on −r; no key-signature inference in v1). **Ties**: a sustained note split across atoms — within a `QNote` or across a bar line (where `quantize` marks the previous QNote's trailing atom tied) — becomes an MEI `@tie` chain (`i`/`m`/`t`) on each note; `data-tie-partner` is left for Composer's `normalizeTies`, which runs on load via `replaceDocument`.

**UI / transports**: "Export to Composer" opens a modal (title, time-sig numerator default 4 / denominator fixed at 4, optional BPM hint) with two actions — **Download `.hkc`** (`downloadBlob`, always available) and **Send to Composer** (gated on a live bridge connection: `isComposerConnected()`; disabled with an explanatory toast otherwise — no silent download fallback). Send dispatches the `import-score` `HklEvent` (`{ type, mei }`); Composer confirms-if-dirty then `replaceDocument` + adopts the score's `layoutReq`. `?hklrec=1` exposes `window.__hkl_rec.transcribe(opts)` returning `{ hkc, debug }` (debug = every intermediate IR: onsets, tempo, beats, meter, chords, qnotes, voiced).

**Round-trip test**: `pnpm test:transcription` (`test/transcription-roundtrip/run.mjs`, needs `pnpm dev`) is a two-page headless check — emit a `.hkc` from a synthetic recording on the HKL page, load it into the Composer page via `replaceDocument`, and assert measure count, per-note `data-q`/`data-r`/`color`, no tie orphans, placeholder invariant, origin spelling, and serialize round-trip stability.

**Color handling**: `darkColorHex(q,r)` in `apps/hkl/src/transcription/pitch.ts` wraps `keyColorHex` with a per-hue table (`HUE_PROFILES`) remapping HKL's seven hues to paper-readable variants (OR/YE→goldenrod, GR→yellow-green, TE→cyan, PK→magenta) so the PK/OR and TE/GR confusion pairs on white become distinguishable. Stem/flag/accidental color suppressed (only the notehead carries lattice color).

**Out of scope for v1**: rubato/variable tempo, tuplets (triplets are the v2 target), time-sig change mid-piece, microtonal accidentals (HEJI via Ekmelily is a future path), manual correction UI (`sourceOnsetIds` preserved for it).

---

## Internal subsystems

Implementation-level notes. For module/file layout see the project overview ([`../architecture.md`](../architecture.md)).

### Render pipeline

**Offscreen build** (on dirty flags):
- `hexCanvas`: colored hex fills for the extended grid (B-region warm-shifted in 7-limit, 3-hue formula in Equal).
- `textCanvas`: note labels on transparent bg, scalable accidentals.

Dirty flags minimize rebuilds: tuning-mode change → hex layer; note names → text layer; resize/extend → both; ref-driven tweens pre-build the hex layer across `[view → target]` (`buildHexLayerForTween`).

**Per-frame draw**:
1. Blit hexCanvas + textCanvas at view-offset.
2. Selection highlights (brightened fill + white ring) in rotated context.
3. Hover highlight if `hoverKey` set.
4. Re-articulate flashes (timestamp-gated).
5. Lattice seams (skipped in Equal); endpoint snap to outline vertices via power-6 curve `|2t−1|^6` during animation.
6. Dark overlay with outline-polygon cutout (opacity 0.65 with extend, 1.0 without).
7. Keyboard outline (3.5px white stroke, round joins).

### Outline geometry (precomputed)

- `kbOutlinePaths`: array of closed polygon paths in baseKey screen coords, computed at init via topology tracing with `edgeIsect`.
- `snapVtx(px, py)`: nearest outline vertex within 6px for seam endpoint snapping (no segment projections / flanking-hex logic).

### Output / input plumbing

- `syncAudio()` — diffs active voices against selection.
- `syncMidi()` — noteOn/noteOff in parallel (Lumatone output; selection only).
- `syncPianoOut()` — external-synth JI mirror; tracks selection ∪ sustained.
- `syncOutput()` — all three.
- `handleMidiMessage(e)` — see [Lumatone input](#lumatone-input).

### Recording subsystem

Three module groups:

- **`apps/hkl/src/recording/`** — domain logic, no DOM.
  - `types.ts` — `HkrSession`, `HkrEvent` union, `LayoutSnapshot`.
  - `clock.ts` — `nowSec()` from `audioCtx.currentTime`, `performance.now()` fallback.
  - `snapshot.ts` — `captureSnapshot()` + `snapshotMatchesLive(s)` (leaf-position; `capture.ts` imports it).
  - `apply.ts` — `applySnapshot(s)` (split from `snapshot.ts` to avoid a cycle through `ui/controls.ts`).
  - `capture.ts` — module-private buffer + per-event recorders (`recordOn/Off/Pa/PedalDepthsChange/Sostenuto`). Auto-balances on start/stop.
  - `playback.ts` — look-ahead scheduler + ledger + dispatch routing.
  - `hkr.ts` — JSON serialize/parse with field validation; `HkrParseError` on schema mismatch.
- **`apps/hkl/src/midi-io/`** — `.hkr` ↔ MIDI, no DOM.
  - `allocator.ts` — `MpeAllocator` (LRU over channels 2..16; on exhaustion evicts oldest + emits forced note-off).
  - `mpe.ts` — `coordToMidi(q,r,snapshot) → {note, bend14}` and `midiToFreq(note, bend14)`. Anchored MIDI 69 = A4 = 440 Hz (HKL's A3=220 lies at MIDI 57).
  - `export.ts` — `sessionToMidi(session)`: MPE Config Message + per-member RPN bend-range preamble, sorts by `(t, ord)`, emits via `midi-file`.
  - `import.ts` — `midiToSession(bytes, snapshot)`: builds `freqIndex` over q∈[−30,30], r∈[−16,16] under the snapshot's tuning; nearest-frequency 25-cent gate. `selfTestRoundTrip(snapshot)` for `?hklrec=1`.
- **`apps/hkl/src/ui/recorder.ts`** — DOM glue: transport buttons, file `<input>` triggers, Blob downloads, status text via RAF. `initRecorderUI()` from `ui/init.ts`.

Capture-point hooks live in `@hkl/engine` (one line per entry point: `noteOn`, `noteOff`, `handleAftertouch`, `setDamperDepth`, `sostenutoOn/Off`); no-op when `isRecording()` is false.

### SysEx queue

Encapsulated in `apps/hkl/src/lumatone/sysex.ts` — private state, public API (`enqueueControl`, `replaceQueue`, `cancel`, `handleResponse`, `queryFirmware`, `inFlight`/`isInProgress` getters).

- Single-message-in-flight ACK queue (queue array, waiting message, ACK timer, busy-retry timer).
- Constants: `SYSEX_TIMEOUT_MS = 2000`, `SYSEX_BUSY_DELAY_MS = 500`, `SYSEX_NOINPUT_DELAY_MS = 35`.
- Status bytes: `SYSEX_NACK = 0x00`, `SYSEX_ACK = 0x01`, `SYSEX_BUSY = 0x02`. BUSY → retry after delay; NACK/ERROR → log and proceed.
- `pushTotal`/`pushSent`/`pushInProgress` drive the visible color-sync push; `pushSilent` skips UI for control-path messages (firmware query, calibration). → queue-swap-vs-cancel choice in `decisions.md`.

### Key constants

```
hexR = 16          # hex circumradius (CSS px)
dxH = hexR * 1.78  # horizontal hex spacing
dyH = hexR * 1.54  # vertical hex spacing
tiltAngle          # counterclockwise rotation, mode-dependent (Lumatone/Piano/default)
outR = hexR + 1    # outline offset from hex centers
septimalW = 3      # 7-limit band width along r-axis
animDuration = 500 # layout animation ms
sysexBoardMap = [1,2,3,5,4]
fixedMidiChannelMap = [0,1,2,3,4]
AFTERTOUCH_RAMP_S
REARTICULATE_FLASH_MS
DAMPER_SMOOTH_TAU      # ~25ms exponential τ for setTargetAtTime damper smoothing
DAMPER_RELEASE_FLOOR   # below this depth, sustained voices release via normal noteOff
```

### Key data structures

- `baseKeys`: 280 [q, r] pairs (5 boards × 56 keys), natural-layout coords.
- `colorTable`: 3×12 `(q%3, r%12) → hue code` (5-limit fast path).
- `equalHueCycle`: `['BL','PU','PK']`.
- `hueC`: hue code → {l, d, sl, sd} hex strings.
- `hueCycleOrder`: `['PU','PK','OR','YE','GR','TE','BL']`.
- `degreeMap`: `(r,p) → scale degree (0–78)`, internal pitch-class index.
- `refSpine(refQ, refR)`: `(q, r) → (q, r)` qm=0-normalized spine cell; drives Lumatone/QWERTY/none layout shift.
- `midiToKey`: fixed-layout reverse `(channel,note) → "q,r"`, recomputed via `buildMidiReverse()` whenever refSpine changes.
- `deviceColors`: 280-entry tracked device state for diff-based auto-sync.
- `kbOutlinePaths`: precomputed outline polygons.
- `kbBaseSet`: Set of `"bq,br"` for all baseKeys.
- `REF`: ~60 reference interval entries.
- `chordTemplates`: 25 chord templates.
