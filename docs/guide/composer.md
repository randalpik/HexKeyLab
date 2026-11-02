# HKL Composer Guide

HKL Composer is a keyboard-driven notation editor for just intonation. You play notes on HexKeyLab and press a key for their duration; Composer engraves them with their exact just-intonation spelling and lattice colors. It lays the score out as printable pages, plays it back through HKL, follows along while you perform it live, and saves `.hkc`, MusicXML and PDF.

Open it at **`/composer/`**, at the same address as HKL, in its own tab. It edits, opens and saves files on its own; entering notes, playback and performance mode need an HKL tab open too.

---

## Quick start

1. Open HKL and Composer in two tabs. Composer's top bar shows **`HKL connected`** (green) once they find each other. **`no HKL`** (red) means no HKL tab is open; **`standalone`** (yellow) means none answered when Composer loaded: you can still edit and save.
2. Hold a note or chord on HKL and press a duration digit: `5` for a quarter note, `4` for an eighth. It is written at the cursor. A digit with nothing held writes a rest.
3. Move with the arrow keys, undo with `Ctrl+Z`, and play the score back with `Space`.
4. Save with `Ctrl+S`.

The **Help** button lists every key. This guide covers the ones you need and how they fit together.

---

## Entering notes

| Key | Action |
|---|---|
| `1`–`7` | Write the held notes, or a rest, with this duration: `1` 64th, `2` 32nd, `3` 16th, `4` eighth, `5` quarter, `6` half, `7` whole |
| `.` | Cycle dots on the note, chord or rest at the cursor: none, dotted, double-dotted |
| `=` | Tie the note to the next note of the same pitch |
| `Backspace` / `Delete` | Delete the element before / after the cursor |
| `Insert` | Switch between insert and overwrite mode (`INS` / `OVR` in the toolbar) |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo (`Ctrl+Shift+Z` also redoes) |
| `Esc` | Cancel a pending hairpin, slur or tuplet |

The status line shows what HKL is holding (`held: A3 C4`). Composer starts in insert mode, where new notes go in at the cursor. In overwrite mode, held notes and a digit replace the note or chord at the cursor instead. A note longer than the room left in its bar is split and tied across the bar line.

Each note remembers the HKL key you played, so its spelling, tuning and color stay the same through every edit, save and reload.

### Chord notes and comma adjustments

- `Alt+↑` / `Alt+↓` select one note of the chord at the cursor (`Alt+↑` starts from the bottom, `Alt+↓` from the top; repeat to step through). `Backspace` then deletes just that note and `=` ties just that note.
- `Alt+→` / `Alt+←` move the selected note up or down by a syntonic comma: the same letter name with a different comma arrow, retuned to match. On a single note it is selected automatically.

### Tuplets

Press `Ctrl+2` to `Ctrl+7` to start a tuplet, then a duration digit for the span it fills, then enter its notes as usual: `Ctrl+3` then `5` makes an eighth-note triplet in the space of a quarter. The ratios are 2:3, 3:2, 4:6, 5:4, 6:4 and 7:8; for `Ctrl+2` and `Ctrl+4` the span is dotted (`Ctrl+2` then `5` is a duplet over a dotted quarter). Inside a tuplet, digits fill its slots and `Backspace` removes them one at a time. A tuplet stays within one bar.

For any other count, `Ctrl+Shift+3` opens a dialog: the number of notes, the span in eighth notes, and the written note value (the usual one is preselected).

### Grace notes

`G` turns the note or chord at the cursor into a grace note and back. To enter one, play it at the value you want written, press `G`, then play its main note. A grace takes no time in the bar.

`Shift+G` adds or removes the slash: slashed is an acciaccatura, unslashed an appoggiatura. On a normal note, `Shift+G` makes a slashed grace in one step. In playback an appoggiatura sounds on the beat, taking time from its main note; an acciaccatura sounds just before the beat, taking time from the note before.

---

## Moving and selecting

| Key | Action |
|---|---|
| `←` / `→` | Move through the current voice |
| `Ctrl+←` / `Ctrl+→` | Previous / next measure |
| `Home` / `End` | Start / end of the voice |
| `↑` / `↓` | Previous / next voice or layer (below) |
| Click | Put the cursor on the nearest note or rest; clicking a mark selects it |

### Voices and layers

Each staff has two voices. A new score is a piano: voices 1 and 2 on the treble staff, 3 and 4 on the bass. Marks that aren't notes have layers of their own, and `↑` / `↓` visit everything in score order: the **tempo** layer at the top, then voice 1, voice 2, the **expression** layer (dynamics, hairpins and expressive text), voice 3, voice 4 and the **pedal** layer. A one-staff instrument has voice 1, voice 2 and its expression layer. The toolbar's voice indicator shows where you are (`E`, `P` and `T` for the layers).

The cursor skips the expression layer in a measure with no marks, and the pedal layer on an instrument with no pedal marks, so place the first mark from a voice (see [Markings](#markings)).

A bar with nothing entered on a staff shows a whole-bar rest; anything you enter replaces it.

### Selecting, copying and pasting

- `Shift+←` / `Shift+→` select beats in one voice; `Ctrl+Shift+←` / `Ctrl+Shift+→` extend the selection a measure at a time.
- `Shift+↑` / `Shift+↓` select whole measures across staves.
- `Ctrl+C`, `Ctrl+X` and `Ctrl+V` copy, cut and paste through the system clipboard. Paste starts at the current beat and overwrites what is there; nothing after it moves. Copied measures paste only where the time signature matches.
- `Backspace` / `Delete` clear the selection.
- `Alt+V` moves the selected whole measures into the other voice of the same staff, the fix for notes typed into the wrong voice. Press it again to move them back.
- `Esc` leaves the selection.

---

## Markings

### Articulations

In a voice, these keys act on the note or chord at the cursor:

| Key | Mark | In playback |
|---|---|---|
| `S` | staccato | half length |
| `A` | accent | louder |
| `T` | tenuto | full length |
| `F` | fermata | held 50 % longer |
| `B` | breath mark | a short gap after the note |
| `Alt+H` | string harmonic | sounds the harmonic pitch |
| `P` | cautionary accidental (in parentheses) | |
| `L` | flip the stem | |
| `/` | split or join the beam at the cursor | |
| `H` | hide a rest (it still takes time) | |

### Slurs

Press `Ctrl+L` on the first note, move to the last (in any voice or staff), and press `Ctrl+L` again. `Ctrl+L` on a note under a slur removes the slur; on a slur's last note it starts the next slur from there. `Shift+L` flips the slur's curve. Slurs play legato.

### Dynamics, hairpins and expressive text

From a voice:

- `Shift+1` to `Shift+8` place **fff** to **ppp** at the cursor.
- `<` starts a crescendo and `>` a decrescendo: move to where it ends and press the same key again.
- `Ctrl+Shift+E` adds expressive text (*dolce*, *pizz.*, …), italic or not. Reopen it on an existing mark to edit it; submit it empty to delete it.
- `Ctrl+↑` / `Ctrl+↓` move the marks at the note above or below the staff.

Dynamics and hairpins shape playback loudness; Setup sets how loud each dynamic plays. In the expression layer, `←` / `→` step through the marks one at a time (a hairpin's start and end are separate stops), `Ctrl+←` / `Ctrl+→` jump from mark to mark, plain `1` to `8` enter dynamics, and `Backspace` deletes the selected mark.

### Pedal

On a grand-staff instrument, `Shift+P` puts the sustain pedal down and `Shift+O` lifts it. Playback follows it. The pedal layer edits pedal marks the same way the expression layer edits dynamics.

### Tempo

`Ctrl+Shift+T` opens the tempo dialog: a marking (text such as *Allegro*, a ♩ = value and its beat note), a *ritardando* or *accelerando* (*poco*, plain or *molto*), or *a tempo*. A tempo marking belongs to the whole score: it is engraved above every part, and playback follows it. Edit or delete markings in the tempo layer.

### Trills, tremolos and octave lines

- `Ctrl+R` adds a trill to the note at the cursor. On a selection of two equal notes it makes a trill if they are a step apart and a tremolo otherwise. Playback plays the alternation.
- `Ctrl+8` puts an 8va line over the selection or the current beat: the notes print where they are and sound an octave higher.

---

## Score structure

### Signatures, clefs and pickups

These apply from the cursor's measure onward, or over the selection:

- `Ctrl+Shift+S` sets the time and key signature, including common and cut time, and beat groups such as `2+2+3` for beaming.
- `Ctrl+Shift+C` inserts a clef change at the cursor, even mid-measure: treble, bass, alto, tenor, treble 8va or 8vb, bass 8vb, or French violin. It lasts until the next change. Reopen the dialog at the same spot to change or remove it; deleting notes never removes a clef.
- `Ctrl+Shift+A` sets a pickup measure at the start of a section. Give its length in eighth notes (`2` for a quarter-note pickup); `0` removes it.

### Bars and sections

- `{` and `}` mark the start and end of a repeat. Playback plays the repeats.
- `Ctrl+E` adds a 1st or 2nd ending: a 1st ending on a measure that ends with `}`, a 2nd on the measure after it.
- `]` puts a double bar at the end of the measure.
- `M` inserts an empty measure at the next bar line.
- `Ctrl+Shift+H` starts a new section or movement at the measure: a centered title, a final bar line before it, and measure numbers starting again from 1. (Not on the first measure, which has the score's title.)

### Instruments

A new score is one piano. Add, remove and reorder instruments in **Setup → Instruments → Manage…** (they apply when you click **Save**). With more than one, the toolbar's instrument selector shows a single part, laid out as a score of its own, for reading, editing or PDF export.

In playback, each instrument plays through the HKL instrument with exactly the same name (case matters), or Piano when none matches. A one-instrument score plays through whatever instrument HKL has selected. In a score with several instruments, a `pizz.` or `arco` expressive text switches a string part to pizzicato and back.

---

## Document Setup

The **Setup** button opens the score's settings:

- **Title**, **Subtitle**, **Composer** and **Footer**: printed on the pages (page view and PDF).
- **Time / key…** and **Tempo…**: measure 1's signature and tempo. These two and **Fill incomplete measures with rests** apply at once; undo them with `Ctrl+Z`, not Cancel.
- **Instruments**: see [Instruments](#instruments).
- **Tuning** and **Mapping**: the tuning system and HKL key arrangement the score is written in. Changing either on a score with notes offers to retune them, keeping each pitch where it can and listing any note that moves by a comma or schisma. If HKL is set differently, entering notes or playing offers to switch HKL to match.
- **Page size** (%): a larger page fits more bars per line, so the notation looks smaller on the page.
- **HEJI accidentals**: comma arrows and septimal accidentals. On by default.
- **Ignore color**: black noteheads instead of lattice colors.
- **Dynamics → velocity**: how loud each dynamic plays.
- **Gradual tempo change (%)**: how much *rit.* and *accel.* change the tempo for *poco*, plain and *molto* (20, 40 and 60 % by default).
- **Fill incomplete measures with rests**: pads every short measure in one step.

While you work, HKL centers its keyboard on the root of the key signature at the cursor (a piece in B minor centers on B3), following key changes, and during playback it follows the music. In **Syntonic** and **Polysyntonic** scores the key also sets the home band (see the [HKL guide](core.md)), so changing a key signature retunes the notes under it.

---

## Page layout

Two toolbar selectors set the view:

- **View**: **Page** shows the score paginated as it prints; **Scroll** shows one continuous line.
- **Theme**: **Light**, **Dark**, or **Transparent** (no background, for video).

Zoom with `Shift+=` and `Shift+-` (50, 75 and 100 %).

Page view lays the score out for you. It fills each system, evens out the last systems of each section, and spaces systems down each page. The layout depends only on the music and the breaks you set, so the same score always looks the same, after an undo or a reload. You control it with:

- **Line breaks**: `Alt+Shift+↓` locks a line break before the current measure, marked by a padlock at the end of the system. Click the padlock to remove it. A lock can only force a break; to pull measures up onto the previous system, lock the break after them instead.
- **Page breaks**: `Ctrl+B` before the current measure.
- **Hiding empty staves**: `Ctrl+H` on an empty bar, or a selection of them, flags it; a staff disappears from a system once all of its bars there are flagged. Scroll view still shows hidden staves: select the bars there and press `Ctrl+H` again to bring them back.
- **Multimeasure rests**: `Ctrl+M` flags empty bars the same way. Where only one staff is shown (a one-staff score, or a one-staff instrument's part), consecutive flagged bars are engraved as one rest with a bar count; a full score with more staves keeps them separate.

Over a selection, `Ctrl+H` and `Ctrl+M` switch every empty bar in it together. A bar loses both flags as soon as you enter music into it.

---

## Playback and performance mode

**Playback**: `Space` plays from the cursor (click **Rewind** first to start from the beginning). A bar follows each sounding voice. `Space` again stops and returns the cursor to where playback started; `←` / `→` stop and leave the cursor where you heard; `Ctrl+←` / `Ctrl+→` skip back or forward a measure. Playback follows the tempo, dynamics, articulations, slurs, pedal and repeats.

**Performance mode** (`Shift+Space`, or **Perform**): you play the score live on HKL and the cursor follows you, for recording a video with the score moving along. It works on one-instrument scores.

- Each voice's bar moves on when you play its next note; any other note is ignored.
- A voice shows a bar only where something is written for it (notes or visible rests), so a voice that enters later appears when you play its first note.
- You don't restrike tied notes. A trill counts as one note, however many times you alternate. A note two voices share is played once.
- At the end of the score the mode stays on; press **Perform** or `Space` to leave it.

---

## Saving, importing and exporting

| Button | Format | |
|---|---|---|
| **Save .hkc** / **Load .hkc** | `.hkc` | Composer's own format. Keeps everything. |
| **Export ▾ → .musicxml** | MusicXML | For MuseScore, Finale or Sibelius; one part per instrument. Carries everything Composer writes except movement titles, HEJI comma accidentals and cautionary (parenthesized) accidentals. |
| **Export ▾ → .pdf** | PDF | The page view exactly as on screen (only the shown part, if one is selected), on US Letter. |
| **Import .musicxml** | MusicXML | A score from another program, as a starting point: it opens in Equal tuning with HEJI off and colors ignored, ready to retune toward just intonation, and every note keeps its spelling. Percussion parts are skipped and compressed `.mxl` files aren't supported; Composer lays the score out anew. |

HKL's **Export to Composer** also sends a recording here as a score (see the [HKL guide](core.md#export-to-composer)).

### Where files are saved

In a plain browser, **Load** and **Import** use the browser's file picker, and **Save** and **Export** download the file, named after the file you opened or the score's title.

With the local host running (`pnpm overlay:host`, the same server the OBS overlay uses; see the [Overlay guide](overlay.md#what-you-need)), Composer works like a desktop editor:

- **Load** (`Ctrl+O`) and **Import** open your desktop's file dialog.
- **Save** (`Ctrl+S`) writes back to the file you opened, asking first if it changed on disk since. After an import, the first save writes a `.hkc` with the same name next to the MusicXML file.
- A new score's first save, **Save As…** and **Export** ask where to save.
- The toolbar shows the file **Save** writes to.

The host needs `kdialog`, `zenity` or `yad` for its dialogs, and only opens and saves score files inside your home folder.
