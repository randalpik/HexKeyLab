# HexKeyLab Guide

HexKeyLab (HKL) is a hexagonal keyboard for just intonation, in the browser. You play it with the mouse, the computer keyboard, a MIDI keyboard or a Lumatone. It sounds every note at its exact just pitch, colors each key by that pitch, and names the chords and intervals you play. It also records what you play, and it is the keyboard for [HKL Composer](composer.md).

---

## Quick start

1. Open HKL. Audio is on by default, though your browser may wait for your first click before it plays anything.
2. Click a hex to sound it, and click it again to stop it. Or play the computer keyboard: **H** is A3.
3. The panel below the keyboard names the chord you're holding and every interval in it.
4. Pick another tuning in the **Tuning** dropdown and listen to the same chord again.

The toolbar's tabs each show or hide a group of controls, and you can have several open: **Layout** (tuning, mapping and how the keyboard looks), **Playback** (sound, instruments and transposition), **Analysis** (the panel below the keyboard), **Recording**, **Lumatone**, and **Piano** (a MIDI keyboard). **Reset** returns every setting to its default.

---

## What you're seeing

The keyboard is an **isomorphic** hexagonal layout: each direction always steps by the same interval, so a chord or scale has the same shape in every key. In the default Euler mapping, a step to the right is a major third (5:4), a step up-right a perfect fifth (3:2), and a step up-left a minor third (6:5), so a major or minor triad is three touching keys.

**A3** (220 Hz) is at the center. Each key's color comes from its exact pitch, so two versions of a note a comma apart have different colors; a light or dark shade marks a white-key or black-key note name. In Equal tuning, three colors cycle by octave instead.

In the Euler mapping the keyboard is divided into **bands** three keys wide, and every key sounds exactly an octave above the key three places to its left. The boundaries between bands are **seams**, drawn as dark wedges.

### Display options (Layout tab)

- **Hex size**: Small, Medium or Large.
- **Note names**: the note name on each key. Turn on **HEJI accidentals** (Analysis tab) for the exact just spelling, with comma arrows and septimal accidentals.
- **Band seams**: draw the seams.
- **Extend pattern**: color the whole canvas rather than only the area inside the outline.
- **Outline**: the keyboard footprint drawn in white: **Lumatone** (280 keys), **QWERTY**, **Piano** (88 keys around the reference note), or **None**.
- **Rotation**: **Vertical Freq** (pitch rises straight up), **Lumatone** (the instrument's tilt) or **Piano**. Only the picture turns.

---

## Playing

**Mouse**: click a hex to turn it on, and again to turn it off; **Shift+click** turns everything else off. Keys stay on until you turn them off, which is how you build a chord to study. **Clear** (Playback tab) turns everything off and silences any held or pedal-sustained note; use it if a note sticks.

**Computer keyboard**: **H** is A3, and four rows of keys play four rows of the lattice:

```
1 2 3 4 5 6 7 8 9 0 - =
 Q W E R T Y U I O P [ ]
  A S D F G H J K L ; '
   Z X C V B N M , . /
```

In the Euler mapping each row down is a minor third lower and each key to the right a major third higher: `H J` is a major third, `H U` a perfect fifth, and `H J U` a major triad. The other mappings have their own steps. Keys play at a fixed forte, and a key pressed with Shift, Ctrl, Alt or Cmd never plays a note.

**Lumatone** and **MIDI keyboard**: see [Lumatone](#lumatone) and [MIDI keyboard](#midi-keyboard-piano-tab).

---

## Tunings

The **Tuning** dropdown (Layout tab) sets how every key is tuned. The keyboard keeps its shape; only the pitches and colors change, and sustained notes glide to the new tuning.

- **Equal**: ordinary 12-tone equal temperament, for comparison.
- **Ptolemaic** (default): 5-limit just intonation, from primes 2, 3 and 5. Every interval inside a band is a pure 5-limit ratio.
- **Pythagorean**: built from fifths alone: major thirds are 81:64 and minor thirds 32:27.
- **Semiditonal**: 5-limit major thirds, with the Pythagorean minor third (the semiditone) close to the root. The most practical tuning for tonal harmony.
- **Septimal**: adds prime 7. In the Euler mapping every third column is lowered by a septimal diesis (36:35), which turns a minor seventh into the harmonic seventh (7:4): 4:5:6:7 chords and 5:6:7:9 half-diminished chords are in reach from any root.
- **Schismatic**: like Semiditonal, with octaves stretched by a schisma (about 2 cents). The diminished fourth across a seam then equals the Pythagorean major third, so playing across seams is the most fluid. Choosing it turns on HEJI accidentals.
- **Syntonic** and **Polysyntonic**: made for the Wicki-Hayden and Chromatic mappings (below).

### Syntonic and Polysyntonic

- Every band is Pythagorean, so scales and octaves inside a band are pure and consistent.
- Whole bands are shifted by a syntonic comma (81:80) against their neighbors: the band left of the **home band** is lowered, the one to its right raised. A pure major third (5:4) is then the same key one band to the left, and a pure minor third (6:5) the same key one band to the right.
- **Syntonic** comes back to unaltered every second band (0, +1, 0, −1 commas going right). **Polysyntonic** keeps stacking, one more comma per band, so a note's comma variants sit side by side.
- The home band is the band holding your [reference note](#reference-note). Move the reference into another band and that band becomes home: the keys keep their notes, and the tunings, arrows and colors re-anchor around it.
- Colors follow the comma count: from a purple A, one comma up is orange, two is green, and one down is teal.
- A MIDI keyboard plays the simplest just ratio from your reference, which is 5-limit wherever the bands offer it.

---

## Mappings

The **Mapping** dropdown (Layout tab) chooses where the notes sit on the keyboard. It works with every tuning.

- **Euler** (default): rows of major thirds, fifths up-right, minor thirds up-left; bands are 3 keys wide.
- **Wicki-Hayden**: rows of whole tones, fifths up-right, fourths up-left; bands are 6 keys wide. A scale is two compact rows, the same shape in every key. In the just tunings the whole tones alternate between 9:8 and 10:9, so some shapes land on comma variants.
- **Chromatic**: rows of semitones, fifths up-right, tritones up-left; bands are 12 keys wide, and two steps up-left is an octave. Every row is a chromatic scale:
  - In Ptolemaic, it is the just chromatic scale of your reference, with the leading tone directly to its left.
  - In Syntonic and Polysyntonic, the two keys just left of the reference's column (its major sixth and seventh) come from the lowered band next door, so the leading tone and major sixth are just and the reference's major I, IV and V chords are all just within three keys.

On the Lumatone, Wicki-Hayden covers about 4½ octaves. Chromatic spans MIDI notes 12–102: each board covers about five octaves top to bottom, a fifth lower than the board to its left.

Switching mapping keeps what you're holding. Mouse and MIDI-keyboard notes keep their pitch and move to that note's new key; Lumatone and computer-keyboard notes stay on their key and glide to its new pitch.

---

## Reference note

The reference note is the key the outline (Lumatone, QWERTY or Piano) is centered on: **A3** by default.

- **Ctrl+click** a key (**Cmd+click** on a Mac) to make it the reference. The keyboard slides so it sits at the center of the outline. Lumatone and computer-keyboard notes you're holding move with it, so a held chord keeps its shape; mouse notes stay on their keys.
- While Ctrl is held, keys that can't be the reference are dimmed: a reference must be in the 88-key piano range, and the keys around it must be spelled with at most triple sharps or flats. **Valid ref bounds** (Piano tab) outlines the allowed area permanently.
- Ctrl+click the current reference again to clear it. It goes back to the score's key if Composer is open, otherwise to A3. Switching to a tuning in which your reference isn't valid also clears it.

With Composer open, the score's key is the reference unless you've Ctrl+clicked one. With **Sync to Composer** on (in the toolbar's Composer group, shown while Composer is connected), each key change in the score replaces your Ctrl+click. Moving Composer's cursor doesn't move the reference, except with the Piano outline, where the note before the cursor becomes the reference.

---

## Transposition

**Transpose** (Playback tab) slides the keys you have on along five axes, each with ▲ / ▼ buttons (hold to repeat): perfect fifth (**P5**), major third (**M3**), minor third (**m3**), octave (**P8**) and syntonic comma (**SC**). Sustained instruments glide to the new pitch; struck and plucked instruments and organs strike again. A step that would push a note off the canvas is refused.

The **SC** step moves the chord to the keys a syntonic comma away. In Equal the pitch doesn't change. In the just tunings the result depends on the tuning and on where the chord sits, because the step crosses seams: in Ptolemaic it raises the chord by 81:80 (about 21.5 cents) or lowers it by about 19.6 cents.

---

## Instruments

The instrument dropdown (Playback tab) offers sampled instruments (keyboards, plucked and bowed strings, woodwinds, brass, organs, accordion and voices) and three oscillator waves. Piano is the default. All are matched in loudness, and sustained instruments loop seamlessly, so you can hold a note as long as you like. While an instrument loads, the dropdown turns blue and counts its samples. Untick **Audio** to silence HKL.

**Import** adds your own instrument: a `.hki` bundle made in the [Analyzer](analyzer.md) or [Orchestrator](orchestrator.md), or a CDN-config `.json`. Imported instruments appear at the bottom of the dropdown, stay across reloads, and can be removed in the same dialog.

**Diagnostics** is a developer view for checking sampled instruments' loops; you can leave it off.

---

## Analysis

With **Show analysis** on (Analysis tab), the panel below the keyboard describes the keys you have on:

- **Notes**: each key's name, octave and frequency, from low to high.
- **Chord**: three or four keys that form a known chord are named, with root, quality and inversion, and with the chord's just ratio in root position. HKL knows triads, seventh chords, added-second chords, augmented sixths (Italian, French, German) and incomplete sevenths. A chord whose ratio uses 7 is tagged *septimal* (`septimal dominant seventh 4:5:6:7`), and one built only from 2s and 3s *Pythagorean*.
- **Intervals**: every pair of keys, with its size in cents, its name and its just ratio. The color shows how complex the ratio is: green for simple ratios (unisons, octaves, fifths, thirds), yellow for moderately complex ones (commas, less common just intervals), red for very complex ones. In Equal, ratios are hidden and only unisons and octaves are green.

**Interval names**: every distinct interval gets its own name, and complementary intervals get mirrored names. A name starts from the spelling (a major 3rd, a diminished 5th) and says how the just interval differs from the Pythagorean one, in syntonic commas, septimal commas and schismas. Common combinations have names of their own (*lesser* / *greater*, *acute* / *grave*, *septimal*, *subminor* / *supermajor*, *wolf*). For example:

- 5:4: "major 3rd" (M3)
- 81:64: "Pythagorean major 3rd" (PM3)
- 81:80: "syntonic comma" (SC)
- 7:6: "septimal minor 3rd" (7m3)
- 7:4: "harmonic 7th" (7m7)

The Analysis tab's other switches:

- **Short intervals**: the short names above.
- **Show factors**: ratios as prime factors (5:4 → 5:2²).
- **Show coordinates**: each note's position on the lattice.
- **HEJI accidentals**: exact just spellings, here and on the keys.
- **Show staff notation**: the keys you have on, on a staff in the corner (**Dark staff notation** for a dark one).
- **Composer view**: the connected Composer score, read-only, in place of the analysis panel.

---

## Recording

The Recording tab captures everything you play, from any input: notes, pedals and aftertouch. It needs Audio on.

- **● Rec** starts and stops a recording. Notes already held when you start are included.
- **▶ Play** plays it back, lighting the keys as it goes. You can play along.
- **Save .hkr** / **Load .hkr**: HKL's own recording format. It also stores the tuning, layout and instrument, so it plays back exactly, switching HKL to its tuning when you play it.
- **Export .mid**: an MPE MIDI file (one channel per note), which MPE-aware DAWs such as Logic, Bitwig and Ableton 11+ play at the exact just pitches.
- **Import .mid**: brings back a `.mid` you've edited in a DAW. Load the matching `.hkr` first; HKL uses it to put each note back on its key. Notes more than 25 cents from any key are skipped.
- **Capture audio**: also saves what you hear as a `.wav` file.

### Export to Composer

**Export to Composer** turns the recording into a score: HKL finds the tempo and the beats, quantizes the rhythm, and writes a Composer score with every note spelled and colored as on the keyboard. Give it a title, a time signature (in quarter notes) and, if you like, a tempo hint. **Send to Composer** opens it in a connected Composer tab; **Download .hkc** saves it.

---

## Lumatone

Everything in this section needs a Lumatone; nothing else in HKL does.

Plug the Lumatone in over USB. The status badge shows **Lumatone connected** (green) or **Lumatone Not Connected** (red); click it to check again.

- **Auto-sync**: HKL configures the Lumatone and keeps its lights matching the screen. The first sync sets up all 280 keys, polyphonic aftertouch and light-on-keystroke. After that, reference, tuning and mapping changes are sent as they happen (only the keys that change), and keys light up as you press them. Without Auto-sync, the Lumatone's own preset decides what each key sends.
- **Playing**: keys play through HKL in the current tuning. Polyphonic aftertouch controls each note's volume.
- **Pedal mode**: **Sustain** (default) makes both pedal jacks one continuous damper, so half-pedaling damps ringing notes gradually. As on a piano, a note the damper has quieted never swells back, and notes stop once the pedal is all but released. **Sostenuto + Sustain** makes the sustain jack a sostenuto pedal and leaves the expression jack as the only damper.
- **Calibrate Pedal**: learns the travel of a continuous expression pedal. Run it once after plugging the pedal in; **Reset to Factory** undoes it.
- **Calibrate Keys** (shown once a Lumatone is connected; also `Shift+\`): per-board key threshold and sensitivity, velocity curves and per-key statistics, for units with uneven keys. It also holds two settings:
  - **Swap boards 3 ↔ 4**, for the few units whose boards 3 and 4 are physically swapped, which puts colors and notes on the wrong boards. Off by default.
  - **Layer loudness match**, for velocity-layered instruments that support it: **0** matches the layers by level, **1** by perceived loudness. Adjust it to taste.

If you switch the Lumatone off while HKL is open, it may sound a few stray notes as it powers down. HKL notices that it has stopped answering and releases them, usually within a second.

---

## MIDI keyboard (Piano tab)

- **Device**: choose your MIDI keyboard.
- **Piano input**: play HKL from it. Velocity and the sustain pedal pass through as played. It needs an **Outline** other than None, and plays only keys inside the outline (a note outside it shows "out of layout").
- **Piano output**: plays HKL's notes on an external synth in true just intonation, even one without pitch bend or MPE, by giving each note its own MIDI channel and fine-tuning that channel: up to 14 notes at once. The synth must receive on all 16 channels. While output is on, HKL turns the synth's Local Control off (and back on afterward) and copies the sound you choose on the synth to every channel. Untick **Audio** to hear only the synth.
- **Valid ref bounds**: outlines where the [reference note](#reference-note) may go.

---

## Settings and Reset

HKL remembers its settings (tuning, mapping, display, instrument and switches) between visits. **Reset** returns them all to their defaults in place, including the reference note, the Lumatone velocity calibration, the board swap and layer loudness. Imported instruments are kept.

---

## Companion apps

These run at the same address as HKL, and the tab row links to each one and to this guide:

- **HKL Composer** (`/composer/`): a notation editor that uses HKL as its keyboard. See the [Composer guide](composer.md).
- **HKL Analyzer** (`/analyzer/`): builds sampled instruments from audio files. See the [Analyzer guide](analyzer.md).
- **HKL Orchestrator** (`/orchestrator/`): samples a MIDI instrument into an HKL instrument. See the [Orchestrator guide](orchestrator.md).
- **OBS overlay**: shows the live keyboard, and the Composer score, over video in OBS. See the [Overlay guide](overlay.md).
