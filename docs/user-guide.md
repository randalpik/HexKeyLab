# HexKeyLab v1.0 — User Guide

HexKeyLab is a browser-based hex-keyboard playground for just intonation. It runs at <https://hexkeylab.maxrandalmusic.com> with no install, no login, and nothing to set up. Open it in Firefox or any Chromium browser and you're ready.

This guide walks through what's on screen and how to use it. Most of HKL works without any external hardware — you can play it on your computer keyboard, click chords on screen, hear them in real just intonation, and read off the interval structure. A short Lumatone section at the end covers what changes when one is plugged in.

---

## What you're looking at

The big shape on screen is a **hexagonal isomorphic keyboard** — every cell plays a pitch, and stepping in a given direction always moves by the same musical interval, no matter where you are.

The two axes of the lattice are:

- **q-axis** — major thirds (5:4)
- **r-axis** — perfect fifths (3:2)

Minor thirds, octaves, and everything else fall out as combinations of those two. Because the layout is isomorphic, a chord shape transposes by sliding it without changing its fingering.

A3 = 220 Hz sits at the center. Every key is colored by pitch class — same color = same note name in 12-TET terms — and the colors light up white-or-dark depending on whether the key is a "white-key" or "black-key" pitch.

---

## Tunings

The **Tuning** dropdown switches between three systems. The lattice doesn't change shape — only the frequencies and the colors do.

- **Equal (12-TET)** — the familiar even-tempered tuning. Three colors cycle by octave. Useful as a reference; intervals in the info panel are named in the standard way.
- **5-limit JI** *(default)* — pure just intonation built from prime 2, 3, and 5. The keyboard divides into **3-key-wide bands** along the q-axis. Inside a band, every interval is a clean 5-limit ratio. Between bands you cross a **seam** where the ratios shift — these are visible as dark wedges if "Band seams" is on.
- **7-limit JI** — adds prime 7. The fifths axis is subdivided into alternating **A regions** (pure 5-limit) and **B regions** (septimal — slightly warm-shifted in color). Crossing an A↔B seam changes the ratio by 64:63; crossing a B↔next-A seam by 36:35.

Switching tunings ramps audio frequencies smoothly over 150ms — sustained notes glide from one tuning to the next.

### Septimal seam shift (7-limit only)

When 7-limit is active, a **▲/▼ control** appears next to the dropdown. This slides the A/B region boundaries up and down along the r-axis, putting septimal coloring under whichever notes you want it under. Range −21 to +20 (wraps at 42).

You can also use **ArrowUp / ArrowDown** on your keyboard to bump the shift. Holding the key auto-repeats at the same cadence as click-and-hold on the buttons.

---

## Layouts (♭ ♮ ♯)

Three layout buttons sit at the top-left: **flat ♭**, **natural ♮**, and **sharp ♯**. Each layout offsets the lattice by a different amount, so the same physical key under your finger plays a different pitch in each.

- **Natural ♮** — center position. A3 sits dead-center.
- **Flat ♭** — shifts the whole keyboard so flat-side keys land in comfortable positions.
- **Sharp ♯** — symmetric counterpart for sharp-side keys.

**Keyboard shortcuts**: ArrowLeft / ArrowRight cycle layouts (♭ → ♮ → ♯ → ♭).

Layout switches animate over 500ms with smooth interpolation — sustained notes glide to their new pitches; decaying instruments retrigger at the end of the animation. Selected keys move along with the layout, so a chord you're playing follows the shift musically.

---

## Playing notes

There are four ways to make sound. The first three need no hardware.

### 1. Computer keyboard (QWERTY)

This is the easiest way to play HKL melodically. **The H key is A3.** The four rows of QWERTY keys map to four rows of the hex lattice:

```
1 2 3 4 5 6 7 8 9 0 - =
 Q W E R T Y U I O P [ ]
  A S D F G H J K L ; '
   Z X C V B N M , . /
```

Each row down is a minor third lower. Each step right is a major third higher. So `H J` is a major third, `H U` is a perfect fifth, `H G` is a major third down, `H J U` is a major triad (root, M3, P5), and so on.

Held keys play polyphonically. Releasing a key stops the note (subject to the sustain / sostenuto state). The mapping rides with the active layout — switching layouts moves what each QWERTY key plays, the same way it moves the rest of the keyboard.

**QWERTY transpose**: With the **Outline** dropdown set to "QWERTY", a small ▲/▼ control appears that slides the QWERTY slab by chromatic semitones (range −3 to +3) without moving the lattice or the layout. Useful when the QWERTY footprint isn't centered where you want to play.

### 2. Mouse / click selection

- **Click a hex** to toggle it on or off.
- **Shift+click** to deselect everything else and select only that key (exclusive select).
- **Hover** over keys to highlight them without selecting.
- **Clear** button (or its keyboard equivalent: keep selecting and clearing manually) clears the selection.

Selected keys ring with a white outline and play continuously. Mouse selections are how you build chords for the analyzer to identify — see "Info panel" below.

### 3. Listening — the Audio toggle

Audio is **off by default** to spare you from a surprise tone. Tick the **Audio** checkbox to enable it. The first toggle creates the Web Audio context and loads your selected instrument's samples (you'll see a brief blue "loading…" state on the dropdown for sample-based instruments).

#### Instruments

The **instrument dropdown** offers 16 voices:

- **Decaying** (struck/plucked, no sustain loop): Piano *(default)*, Electric Piano, Harp, Acoustic Guitar.
- **Sustained without vibrato**: Reed Organ, Chamber Organ, Clarinet, Trombone.
- **Sustained with vibrato**: Drawbar Organ, Violin, Viola, Cello, Flute.
- **Oscillators**: Triangle, Sine, Square.

All sample instruments are RMS-normalized to the same loudness target, so switching instruments mid-session doesn't blow your ears out. Sustained instruments are stitched from real recordings via a custom loop-point analyzer; you can hold notes indefinitely without hearing the seam.

Aftertouch and pedal modulation work per-voice (see Lumatone section).

### 4. Lumatone (optional)

If you have a Lumatone hex keyboard, see the Lumatone section near the end. Everything else in HKL works without one.

---

## Visual aids

A row of checkboxes at the top of the toolbar controls what's drawn:

- **Note names** *(on by default)* — letter names + accidentals on each hex. Accidentals scale and stack continuously; a triple-flat looks visibly distinct from a double-flat.
- **Band seams** *(on by default)* — draws the wedge-shaped boundaries between 5-limit bands (or 7-limit A/B regions). Off in 12-TET (no seams there).
- **Extend pattern** *(on by default)* — fills the canvas with the lattice pattern beyond the physical Lumatone footprint. With it off, only the actual Lumatone-shaped region is colored.
- **Show coordinates** — adds `(q=…, r=…, p=…)` to each note in the info panel for studying the lattice math.
- **Short intervals** — abbreviates interval names in the info panel: "perfect fifth" → "P5", "minor third" → "m3", "syntonic comma" → "SC", and so on. Useful for fitting more onto the screen.

### Outline selector

The **Outline** dropdown picks which keyboard footprint is drawn as a white outline:

- **Lumatone** *(default)* — the 280-key Lumatone shape.
- **QWERTY** — the rectangular footprint of the four QWERTY rows. Helpful if you're playing on the computer keyboard and want a visual cue for which hexes correspond to which keys.
- **None** — no outline, just the lattice.

---

## Transposition (5 axes)

Once you have keys selected, the **Transpose** control on the second row lets you slide the whole selection along five musical axes:

| Axis | Interval |
|---|---|
| **P5** | perfect fifth (0, +1) |
| **M3** | major third (+1, 0) |
| **m3** | minor third (−1, +1) |
| **P8** | octave (+3, 0) |
| **SC** | syntonic comma (−7, +4) |

Each axis has ▲/▼ buttons with click-and-hold repeat. Audio glides over 100ms; MIDI re-keys cleanly. The transpose is bounds-checked — if any note in the selection would slide off the visible canvas, the transpose is blocked.

The **SC** (syntonic comma) axis is the surprising one. In 12-TET this is a no-op (the layout shifts back onto itself), but in 5-limit and 7-limit it sounds the same chord on a different "comma row" of the lattice — useful for exploring how comma drift affects voice leading.

---

## Info panel

The strip below the canvas analyzes whatever is currently selected.

### Note tags

Each selected key shows up as a colored tag with its note name, octave, and frequency in Hz. Sorted low to high. With "Show coordinates" on, the tag also shows `(q, r, p)`.

### Chord identification

If three or four selected keys form a recognized chord (template-matched on semitone intervals + letter spacing), HKL labels it: root note, quality, inversion, and the just-intonation ratio of the chord in root position.

Templates include:

- Triads: major, minor, diminished, augmented, sus4, sus2, Pythagorean
- Seventh chords: major 7, dominant 7, minor 7, minor-major 7, half-diminished 7, fully diminished 7, augmented 7, augmented major 7
- Added-second chords
- Augmented sixth chords: Italian, French, German
- Incomplete sevenths

In 5-limit/7-limit, chords whose root-position ratio contains a factor of 7 (and stays simple) are tagged **septimal** — `septimal dominant seventh 4:5:6:7`, for example. In 12-TET, ratios are hidden and the "septimal" tag is dropped.

### Pairwise intervals

Below the chord analysis, every pair of selected notes is listed by interval size, with:

- both note names colored by their lattice hue
- cents
- the interval's name — *every* distinct interval gets a unique name with full comma decomposition (no lossy generic labels)
- the just ratio (in 5-limit / 7-limit)

Interval color codes the **Tenney Height** — a complexity measure of the ratio:

- **green** — simple ratios (TH < 8): unisons, octaves, fifths, simple thirds
- **yellow** — moderately complex (TH 8 to 12.5): commas, less-common just intervals
- **red** — high-complexity (TH ≥ 12.5): exotic intervals, multi-comma stacks

In 12-TET the colors collapse: enharmonic identities (A1, d2, etc. — anything where `semitones % 12 = 0`) are green, everything else red, and ratios are hidden.

### Interval naming

Names are computed by trying to express the ratio as a known reference interval ± a chain of commas (syntonic 81:80, septimal 64:63, schisma, Pythagorean comma, plus three derived commas). The algorithm picks the decomposition with the fewest comma terms, breaking ties by simplicity.

Examples:

- 5:4 → "major third"
- 81:64 → "Pythagorean major third" (also written "M3 + SC")
- 7:6 → "septimal minor third" (or "lesser minor third + 7C")
- 128:125 → "diminished second − schisma + Pythagorean comma" (or similar — depending on the simplest decomposition)

Toggle **Short intervals** to abbreviate ("major 3rd" → "M3", "syntonic comma" → "SC", etc.).

---

## Recording and playback

HKL records every performance — Lumatone, QWERTY, or click — and can play it back, save it, and round-trip it through any DAW that understands MPE.

The recording controls sit in a group on the toolbar, between the Lumatone block and Reset prefs:

- **● Rec** — start / stop recording. While recording, the button pulses red and the status pill ticks elapsed time. Whatever you play (notes, sustain pedal, expression pedal, polyphonic aftertouch) is captured. You can start recording mid-chord — held voices get added to the recording as `t=0` events automatically, so playback reproduces them.
- **▶ Play** — plays the current recording back. The keys flash on the canvas as they play, matching what live input looks like. You can press your own keys at the same time — playback uses a separate voice ledger so Stop only releases what playback created, leaving your own keys alone.
- **Save .hkr** — downloads the current recording as a `.hkr` file (HexKeyLab's native JSON format). `.hkr` is the source of truth — it carries the tuning system, layout, instrument, and the coordinate event stream, so a re-load plays back identically.
- **Load .hkr** — opens a `.hkr` file. On Play, HKL applies the recording's layout snapshot (so loading a 7-limit recording switches you into 7-limit before playback starts).
- **Export .mid** — downloads the recording as a standard `.mid` file using **MPE** (one channel per voice, ±48-semitone pitch bend). Any modern MPE-aware DAW (Logic, Bitwig, Ableton 11+) reads this and reproduces the JI pitches faithfully. Useful for quantizing rhythm, editing notes, or rendering the score through other software.
- **Import .mid** — re-imports a `.mid` (typically one you've edited in a DAW). HKL needs the matching `.hkr` loaded first — the recording's layout snapshot is what makes coordinate identity recoverable from the (note, channel-bend) tuples. Out-of-tolerance notes (>25 cents from the nearest reachable coordinate under the snapshot) are skipped and logged as warnings.

The status pill on the right shows current state: *Idle*, *Recording 0:04*, *Playing 0:02 / 0:18*, or *Loaded 0:18*.

### Why two formats

`.hkr` is the canonical recording. `.mid` is a derived view for DAW interchange. Re-import always anchors against an `.hkr` snapshot so coordinate identity survives even if a DAW quantizes pitch-wheel data — the snapshot tells HKL exactly which lattice positions to map (note, bend) tuples onto.

### Future: Lilypond score export

The `.hkr` schema is designed so a future exporter can walk the events and emit Lilypond source with colored noteheads matching the key colors. That tool isn't shipped yet; the recordings you make today will work with it when it lands.

---

## Persistence

Most toolbar settings — selected layout, tuning, audio toggle, instrument, checkbox states, outline mode — are remembered across page reloads via local storage.

The **Reset prefs** button (far right of the toolbar) clears all stored toolbar settings and reloads the page with defaults. Useful if your browser remembers an old state you don't want.

---

## Lumatone integration

This section is for the small audience that owns a Lumatone. None of it is needed to use HKL.

When a Lumatone is plugged in over USB, HKL becomes a full controller for it:

- **Auto-sync colors** — tick **Auto-sync** and the Lumatone's LEDs match the on-screen colors. Layout switches, tuning changes, septimal seam shifts, and selection highlights all push to the device. The sync is diff-based and message-throttled, so even a full layout switch only sends the bytes that actually need to change.
- **Status badge** — green "Lumatone Connected" / red "Not Connected", plus a sync activity indicator.
- **MIDI input** — physical key presses route through HKL's audio engine using the same tuning math as on-screen play. Polyphonic aftertouch (per-key pressure, modulating per-voice volume) is supported.
- **Pedal modes** — a dropdown selects between two interpretations of the sustain jack:
  - *Sustain* — both pedal jacks contribute to a continuous damper depth (max of CC 4 and CC 64). This is the default. Half-pedaling on a continuous expression pedal attenuates ringing in real time, not just the decay rate.
  - *Sostenuto + Sustain* — the sustain jack becomes a sostenuto pedal (locks held notes to ring through subsequent damper changes); the expression jack is the only damper source.

HKL pushes a single fixed (channel, note) MIDI mapping to the Lumatone on first connect, then never re-maps the device. All tuning interpretation happens in software.

> **Note**: the SysEx board map is hard-coded for the developer's specific Lumatone unit, on which physical boards 3 and 4 are swapped. Other units may need this constant adjusted in `src/lumatone/protocol.ts` before color sync looks correct.

---

## Tips for getting started

A few things that aren't obvious on first contact:

1. **Try the QWERTY keyboard first.** H is A3. Hold H, then add J (M3 up), then U (m3 up) — that's a major triad. Move the whole shape one row down (`H J U` → `N M J`) and you've transposed down a minor third.
2. **Switch tunings while playing a chord.** Hold a major triad, then flip Tuning between Equal and 5-limit. The pure 5-limit version sounds visibly more locked-in.
3. **Click a chord, then look at the info panel.** Every interval is named with full precision. There are no "just dim 7" approximations — every distinct ratio gets its own name.
4. **Use 7-limit and the seam shift** to find barbershop-style harmonies. The dominant 7 with a 7:4 minor seventh sounds noticeably sweeter than the 12-TET version.

---

That's the whole tool. There is nothing hidden behind menus — what you see in the toolbar is what HKL does.
