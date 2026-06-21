# HKL Composer Guide

HKL Composer is a keyboard-driven music-notation editor. It turns the chords you hold on the HexKeyLab keyboard into engraved notation with the correct just-intonation spelling and lattice colors, plays scores back through HKL's audio engine, and exports to `.hkc`, MusicXML, and PDF.

Open it at **`/composer/`** (same address as HKL, in its own browser tab). It runs standalone for editing, loading, and saving `.hkc` files; entering notes from the HKL keyboard needs an HKL tab open too.

---

## Connecting to HKL

Composer and HKL are two separate tabs that talk over a local channel: no setup, as long as both are open at the same address. The badge in Composer's top bar tells you the state:

- **`no HKL`** (red): no HKL tab found yet.
- **`connected`** (green): an HKL tab is open and linked.
- **`standalone`** (yellow): running on its own; you can still edit and save, just not enter notes live.

When connected, hold a chord on HKL and it becomes the "held notes" Composer is ready to write.

---

## Getting notes in

Composer uses a **Speedy-Entry–style** flow (familiar from Finale): you choose *what's sounding* by holding keys on HKL, then press a **duration digit** to commit it.

- **Hold a chord on HKL**, then press a duration digit (`1`–`7`) → that chord is written at the cursor with the duration you pressed.
- **Hold nothing**, press a duration digit → a **rest** of that duration.
- The status line shows what's currently held (e.g. `held: A3 C4`).

Notes carry their lattice identity (`q`, `r`) and color through every edit, save, and reload, so the just-intonation spelling never drifts.

---

## Keyboard reference

Composer is keyboard-first. The cursor sits in one **voice** at a time; most keys act at the cursor.

### Notes, durations, rests

| Key | Action |
|---|---|
| `1`–`7` | Duration: `1`=64th, `2`=32nd, `3`=16th, `4`=8th, `5`=quarter, `6`=half, `7`=whole. Held HKL keys → chord; nothing held → rest. |
| `.` | Cycle dots (none → dotted → double-dotted → none) on the current note/chord/rest. |
| `=` | Toggle a tie on the current note/chord (see [Ties](#ties-and-tuplets)). |
| `Insert` | Toggle **insert** vs **overwrite** mode. |
| `Backspace` | Delete the element before the cursor. |
| `Delete` | Delete the element after the cursor. |

### Moving around

| Key | Action |
|---|---|
| `←` / `→` | Move the cursor within the current voice. |
| `↑` / `↓` | Switch voice / layer (and into the dynamics, pedal, and tempo layers; see [Pedal, tempo & expressive text](#pedal-tempo-expressive-text)). Lands on the note sounding at the same moment, not the bar start. |
| `Ctrl+←` / `Ctrl+→` | In a dynamics/pedal/tempo layer, jump mark-to-mark. |
| `Home` / `End` | Jump to the start / end of the voice. |
| Click | Click anywhere in the score to place the cursor there. |

### Transport

| Key | Action |
|---|---|
| `Space` | Start / stop playback. |
| `Shift+Space` | Start / stop **performance mode** (you play the part live; see [Playing it back](#playing-it-back)). |

A read-only list of every binding lives in the **Help** dialog (the `?` button); it's always in sync with what the editor actually does.

---

## Voices & the grand staff

A new document is a grand staff (treble + bass) with two voices per staff, four voices in all:

| Voice | Staff |
|---|---|
| 1 | treble (upper) |
| 2 | treble (lower) |
| 3 | bass (upper) |
| 4 | bass (lower) |

`↑`/`↓` cycle through the voices, plus the virtual **dynamics**, **pedal**, and **tempo** layers (shown as `E`, `P`, `T` in the voice indicator). Empty measures autofill with rests so the notation always reads correctly; delete the rests to extend a measure.

---

## Ties and tuplets

**Ties** (`=`) join a note to the next same-pitch note. They're per-pitch in a chord, survive edits and re-spelling, and form automatically when a note's duration overflows a bar line.

**Tuplets**: press `Ctrl+N` (where N is `2`–`7`) to start a tuplet, then a duration digit to set its base note. For example `Ctrl+3` then `5` is a triplet of eighth notes filling a quarter. A tuplet stays within one bar. (`Ctrl+R` is used for trills because Firefox reserves `Ctrl+T`; see [Misc elements](#misc-elements).)

| Tuplet | Ratio | Example |
|---|---|---|
| `Ctrl+2` | 2:3 (duplet) | two in the space of a dotted note |
| `Ctrl+3` | 3:2 (triplet) | the common one |
| `Ctrl+4` | 4:6 | |
| `Ctrl+5` | 5:4 (quintuplet) | |
| `Ctrl+6` | 6:4 (sextuplet) | |
| `Ctrl+7` | 7:8 (septuplet) | |

---

## Dynamics, hairpins, slurs & articulations

**Dynamics & hairpins** live in their own layer (reach it with `↑`/`↓`, or place them straight from voice mode):

- `Shift+1`…`Shift+8` (`!`…`*`) → `fff` … `ppp` (`1` = loudest) at the cursor moment.
- `<` / `>` → start / end a crescendo or diminuendo hairpin (two steps: mark the start, navigate, mark the end).

Dynamics and hairpins affect playback loudness. **Above/below placement**: `Ctrl+↑` / `Ctrl+↓`.

**Slurs** (`Ctrl+L`): press once to mark the start note, navigate, press again to close the slur. `Ctrl+L` on a note already under a slur removes it. In playback, slurs become legato: overlapping releases on plucked/struck instruments, smooth pitch glides on sustained ones.

**Articulations** (in voice mode, a plain letter on the current note/chord/rest):

| Key | Mark |
|---|---|
| `S` | staccato |
| `A` | accent |
| `T` | tenuto |
| `F` | fermata |
| `B` | breath mark |
| `P` | parenthesized (cautionary) accidental |
| `H` | hide a rest |
| `/` | split / join the beam |
| `L` | flip stem direction |
| `Shift+L` | flip slur direction |

Staccato, accent, and tenuto shape playback (shorter, louder, fuller).

---

## Misc elements

- **Repeats**: `{` opens a repeat, `}` closes it; `]` sets a final double bar. Playback expands repeats automatically.
- **1st / 2nd endings**: `Ctrl+E` toggles a volta over the current measure.
- **Octave lines (8va)**: `Ctrl+8` over a selection; the notes sound (and print) an octave higher/lower.
- **Trills & tremolos** (`Ctrl+R`): a trill on a single note, or a tremolo / diatonic trill on a two-note equal-duration selection. Playback realizes the alternation.
- **Page break**: `Ctrl+B`. **Section header**: `Ctrl+Shift+H` (restarts measure numbering).

---

## Pedal, tempo & expressive text

These are navigable layers alongside dynamics:

- **Pedal**: `Shift+P` (down) / `Shift+O` (lift). Drives the sustain engine during playback.
- **Tempo**: `Ctrl+Shift+T` opens a builder for instant markings (♩ = 120) or gradual ones (rit., accel., *a tempo*). All playback follows the tempo timeline.
- **Expressive text**: `Ctrl+Shift+E` adds a `<dir>` text mark (e.g. *dolce*, *pizz.*), with an italic toggle.

---

## Mid-piece signatures, clefs & pickups

From any measure forward (or, in select mode, over the selected span):

- **Time / key signature**: `Ctrl+Shift+S`. The dialog also offers common/cut-time symbols and additive beat groups (e.g. `2+2+3` for 7/8; affects beaming only).
- **Clef change**: `Ctrl+Shift+C` inserts a mid-measure clef; it carries forward until the next change.
- **Pickup / anacrusis**: `Ctrl+Shift+A` sets a short pickup measure at the start of a section. A downbeat tempo marking travels with it.

---

## Multiple instruments

A document starts as one piano (the grand staff). Add more instruments from [Document Setup](#document-setup) → **Instruments → Manage…** (drag to reorder; changes apply on Save). Each instrument gets its own staves, voices, and dynamics/pedal layers.

- A toolbar **instrument selector** filters the view (and PDF export) to a single instrument's part.
- **Pizzicato / arco**: an [expressive-text](#pedal-tempo-expressive-text) `pizz.`/`arco` cue switches the spanned notes to a pizzicato sample where one is available.
- **String harmonics**: `Alt+H` marks an open-diamond harmonic; playback sounds the harmonic pitch.
- MusicXML export writes one part per instrument.

---

## Selecting, copying & pasting

Hold **Shift** while moving the cursor to select:

- **Shift+←/→**: select beats within one voice.
- **Shift+↑/↓**: select measures across staves.
- **Ctrl+Shift+←/→**: extend the selection to the next bar line.

Then **Ctrl+C** / **Ctrl+X** / **Ctrl+V** copy, cut, and paste through the real OS clipboard, so you can move material within a score. Paste snaps to the current beat and pushes following content as needed. **Backspace** / **Delete** clear the selection.

---

## Playing it back

- **Space** plays from the cursor (or from the top). A bar follows each sounding voice; the editing cursor is untouched.
- **Performance mode** (**Shift+Space**) is the inverse: *you* play the part live on the Lumatone and the on-screen bars advance as you strike the matching notes, for recording a scrolling-score video to your own performance. Single instrument; mistakes are simply ignored rather than failing.

The **Play** and **Perform** toolbar buttons switch directly between the two transports.

---

## Document Setup

The **Setup…** button opens a dialog for the whole-document settings:

- **Title**, **Subtitle**, **Composer**, and **Footer** text (subtitle and footer are optional; a blank footer hides it).
- **Time / key…** and **Tempo…** buttons open the measure-1 signature and tempo dialogs (the same ones you can apply mid-piece; see [Mid-piece signatures, clefs & pickups](#mid-piece-signatures-clefs-pickups)).
- **Instruments**: a **Manage…** button to add / remove / reorder (see [Multiple instruments](#multiple-instruments)).
- **Tuning**: the tuning system the score is pinned to; it drives the spelling and the layout HKL adopts when the score is sent over.
- **Reference note**: the lattice cell `(q, r)` the score is centered on.
- **HEJI accidentals**: show comma arrows & septimal hooks.
- **Ignore color**: render noteheads plain black instead of in lattice colors.
- **Dynamics → velocity**: the loudness each dynamic (fff…ppp) plays at, plus the gradual-dynamic step sizes (poco / plain / molto) that hairpins use.
- **Fill incomplete measures with rests**: pads every short measure across the score in one action.

---

## Saving & exporting

| Button | Format | Notes |
|---|---|---|
| Save / Load | **`.hkc`** | Composer's native format: MEI XML carrying the lattice coordinates and colors. The canonical, lossless round-trip. |
| Export | **MusicXML** | One part per instrument; opens in MuseScore / Finale / Sibelius. Pitches, rhythms, colors, clefs and signatures carry over; dynamics, hairpins, and repeats do not yet. |
| Import | **MusicXML** | Loads a `.musicxml` score authored in Finale / MuseScore / Sibelius (notes, chords, multiple voices and instruments, tuplets, ties, slurs, articulations, dynamics, hairpins, tempo, key/meter/clef changes). The document is set to **Equal tuning, HEJI off, colors ignored** — the imported score is a starting point you then retune toward just intonation. Each note keeps its original spelling (a G♭ stays a G♭). |
| Export | **PDF** | Vector, exactly what you see on screen (including HEJI accidentals and colors), honoring the current single-part view. |

`.hkc` files also arrive straight from HKL's **Export to Composer** (HKL transcribes a recording into notation and sends it over; see the [Core guide](core.md#export-to-sheet-music-composer)).

---

## View & theme

Two selectors in the top bar (remembered across reloads):

- **View mode**: **Page** (paginated, for reading/printing) or **Scroll** (one continuous system).
- **Theme**: **Light**, **Dark**, or **Transparent** (no background, for video/overlay use).
