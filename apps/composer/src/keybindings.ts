/**
 * Keyboard shortcut catalog for HKL Composer. Data-only: the dispatcher
 * lives in ./input.ts; this file is the source of truth for documentation
 * and is what the Help modal renders.
 *
 * Sections are listed in the order the modal displays them. When adding
 * or changing a keybinding in input.ts, update the matching entry here.
 */

export interface KeyBinding {
  /** Display form. Use "→ ←" for arrow keys; "+" between modifiers; ".." for digit ranges. */
  keys: string;
  /** One-line description. */
  desc: string;
  /** Optional indented sub-line for caveats or sub-rules. */
  note?: string;
}

export interface KeySection {
  title: string;
  intro?: string;
  bindings: KeyBinding[];
}

export const KEYBINDINGS: KeySection[] = [
  {
    title: "Universal",
    intro: "Active regardless of current mode.",
    bindings: [
      {
        keys: "Space",
        desc: "Play from the cursor, or stop. Stopping returns the cursor to where playback started.",
        note: "Also stops Performance mode. Playback needs HKL open in another tab.",
      },
      {
        keys: "Shift+Space",
        desc: "Start Performance mode: play your part on HKL and the score follows. Space stops it.",
        note: "Single-instrument scores only; needs HKL open. Does nothing while playback or Performance mode is running.",
      },
      {
        keys: "Click",
        desc: "Move the cursor to the nearest note / rest (switching to its voice), or to the start of an empty measure. Clicking a dynamic, hairpin, expressive text, pedal or tempo mark selects it in its layer.",
        note: "Ignored during playback or with a modifier held.",
      },
      {
        keys: "←  /  →  (during playback)",
        desc: "Stop playback. Cursor lands where you heard.",
      },
      { keys: "Ctrl+Z", desc: "Undo." },
      { keys: "Ctrl+Y  /  Ctrl+Shift+Z", desc: "Redo." },
      {
        keys: "Ctrl+S",
        desc: "Save. With the local host running, overwrites the open file in place (asks first if it changed on disk); a new score opens a save dialog; otherwise downloads under the score's title.",
      },
      { keys: "Ctrl+O", desc: "Open a .hkc (the local host's file dialog, else the browser's)." },
      { keys: "Shift+=", desc: "Zoom in." },
      { keys: "Shift+-", desc: "Zoom out." },
      { keys: "Escape", desc: "Cancel a pending hairpin, slur or tuplet. In selection mode, exit the selection." },
    ],
  },
  {
    title: "Voice mode",
    intro:
      "Active on any voice: two per staff, so four for a grand-staff instrument and two for a single-staff one. Step entry follows Finale convention.",
    bindings: [
      {
        keys: "1 .. 7",
        desc: "Duration: 1 = 64th, 2 = 32nd, 3 = 16th, 4 = 8th, 5 = quarter, 6 = half, 7 = whole.",
        note: "With held HKL keys → chord at this duration. Without held keys → rest. In OVR mode it replaces the element at the cursor. With a chord note selected (Alt+↑/↓) in INS mode, it adds the held keys to that chord instead (no advance; duration unchanged).",
      },
      {
        keys: ".",
        desc: "Cycle dots on current note/chord/rest (0 → 1 → 2 → 0).",
      },
      {
        keys: "=",
        desc: "Toggle tie on current note (or selected chord note).",
      },
      {
        keys: "]",
        desc: "Toggle a double bar line at the end of the current measure.",
        note: "Not on the last measure (it keeps its final barline).",
      },
      {
        keys: "{  /  }",
        desc: "Toggle a forward / backward repeat barline on the current measure.",
        note: "{ = repeat-start (left barline, any measure); } = repeat-end (right barline, incl. the final measure for a whole-piece repeat). Press again to clear.",
      },
      {
        keys: "Ctrl+E",
        desc: "Toggle a 1st / 2nd ending (volta) on the current measure.",
        note: "Type is context-derived: a measure with a backward repeat becomes a 1st ending, the measure after a backward repeat a 2nd ending, and any other measure extends an adjacent ending.",
      },
      {
        keys: "Ctrl+8",
        desc: "Toggle an 8va (ottava) over the beat selection, or the current beat in voice mode.",
        note: "Applies to the cursor's whole staff (both voices). Spanned notes sound an octave higher. Press again at the same start to remove it.",
      },
      {
        keys: "Ctrl+R",
        desc: "Voice mode: trill on the current note. Selection: two equal notes → trill (diatonic step) or tremolo (otherwise).",
        note: "The two selected notes must combine to a single notehead value.",
      },
      {
        keys: "Ctrl+B",
        desc: "Toggle a page break before the current measure (page view).",
        note: "The measure starts a new page. Not on the first measure; no effect in scroll view.",
      },
      {
        keys: "Alt+Shift+↓",
        desc: "Manual line break (page view): the current and following measures start a new system.",
        note: "The break is locked — a padlock at the end of the system marks it; click the padlock to unlock. Locks save with the score and export to MusicXML as system breaks.",
      },
      {
        keys: "H",
        desc: "Hide / unhide the current rest (a hidden rest still takes up time).",
      },
      {
        keys: "Alt+H",
        desc: "Toggle a string harmonic on the current note or chord: diamond notehead; playback sounds the harmonic pitch.",
      },
      {
        keys: "P",
        desc: "Parenthesized cautionary accidental on the current note or chord.",
        note: "With a chord-internal selection (Alt+↑/↓), applies to just that note.",
      },
      {
        keys: "L",
        desc: "Flip the stem direction of the current note or chord.",
        note: "When the note is beamed, the whole beam flips together.",
      },
      {
        keys: "Shift+L",
        desc: "Flip the curve direction of the slur covering the cursor.",
      },
      {
        keys: "Ctrl+L",
        desc: "Slur: press on the start note, move to the end note (any voice or staff) and press again. On a note already under a slur, deletes that slur.",
        note: "Escape cancels a pending slur. Arrow keys, including ↑/↓ through the layers, keep it pending; entering selection mode or undo drops it.",
      },
      {
        keys: "/",
        desc: "Toggle a beam break at the cursor. Splits a beam mid-beat, or joins one across beats.",
        note: "Between grace notes it splits their beam.",
      },
      {
        keys: "G",
        desc: "Toggle the current note or chord between grace note and normal note.",
        note: "A grace keeps its written value but takes no time in the bar; the next note you enter is its main note (new notes are always normal). Consecutive graces beam together. Turning a grace back into a normal note re-inserts its value, which may push later notes into the next bar.",
      },
      {
        keys: "Shift+G",
        desc: "Toggle the slash on a grace note (acciaccatura ↔ appoggiatura); on a normal note, make it a slashed grace.",
        note: "A slashed grace is never beamed: slashing one in a beamed group takes it out of the beam. In playback a slashed grace sounds before the beat, an unslashed one on it.",
      },
      {
        keys: "S  /  A  /  T  /  F  /  B",
        desc: "Toggle staccato, accent, tenuto, fermata, or breath mark on the current note or chord.",
        note: "Each key toggles its own mark, so marks combine. Only fermata can attach to a rest.",
      },
      {
        keys: "Shift+1 .. Shift+8",
        desc: "Enter dynamic at the cursor anchor: fff, ff, f, mf, mp, p, pp, ppp.",
        note: "Anchor: in INS mode, the just-entered element (cursor−1); in OVR mode, the element at cursor. Replaces any existing dynamic at that moment.",
      },
      {
        keys: "<  /  >",
        desc: "Crescendo / decrescendo. Two-step: first press marks start; second press at a later moment closes the hairpin.",
        note: "Escape cancels a pending hairpin.",
      },
      {
        keys: "Ctrl+↑  /  Ctrl+↓",
        desc: "Move the expressions at the current note above / below the staff (@place): its dynamic, expressive text and any hairpin spanning it.",
        note: "Below the upper staff of a grand staff means between the staves. In the expression layer, Ctrl+↑/↓ moves only the selected mark.",
      },
      {
        keys: "Shift+P  /  Shift+O",
        desc: "Sustain pedal down / up (off) at the cursor anchor.",
        note: "Anchor: in INS mode, the just-entered element (cursor−1); in OVR mode, the element at cursor. Press again at the same moment to remove the mark.",
      },
      {
        keys: "↑  /  ↓",
        desc: "Previous / next voice. Cycle: tempo → 1 → 2 → expr → 3 → 4 → pedal.",
        note: "Tempo is a top-level layer above V1 (it applies to all instruments) and is always reachable. The expression layer is a stop only when the cursor's measure has a dynamic or expressive text or lies under a hairpin; the pedal layer only when the instrument has pedal marks. A single-staff instrument cycles 1 → 2 → expr (no pedal); several instruments follow one another in score order; a part view limits the cycle to that part; staves hidden on the current system are skipped.",
      },
      {
        keys: "←  /  →",
        desc: "Move cursor left / right within the current voice.",
      },
      {
        keys: "Home  /  End",
        desc: "Jump to start / end of the current voice.",
      },
      {
        keys: "Backspace",
        desc: "Delete element at/before cursor.",
        note: "With a chord note selected (Alt+↑/↓), deletes just that note.",
      },
      { keys: "Delete", desc: "Delete element after cursor." },
      { keys: "Insert", desc: "Toggle insert / overwrite mode (INS ↔ OVR)." },
      {
        keys: "M",
        desc: "Insert an empty measure at the next barline after the cursor (at the cursor itself when it sits on a barline, e.g. after Ctrl+→). Cursor lands at its start.",
      },
      {
        keys: "Ctrl+H",
        desc: "Hide empty staves: toggle the hide-empty flag on the current measure of the current staff, if it is empty (or on every empty measure × staff in the selection).",
        note: "Every targeted measure takes the state the fewest of them had (tie → on), so pressing again cycles. In page view a staff drops out of a system once every measure on that system is flagged for it; scroll view always shows every staff. Content entering a measure clears its flag.",
      },
      {
        keys: "Ctrl+M",
        desc: "Multimeasure rest: toggle the multirest flag over the same target as Ctrl+H.",
        note: "In a single-staff view (a one-staff instrument's part, or a one-staff score) two or more consecutive flagged empty measures engrave as one multimeasure rest. Backspace / Delete on it removes the whole run.",
      },
      {
        keys: "Ctrl+←  /  Ctrl+→",
        desc: "Jump cursor to the previous / next measure.",
        note: "During playback: jumps the playhead a measure back or forward.",
      },
      {
        keys: "Alt+↑  /  Alt+↓",
        desc: "Chord-internal note selection. First press enters at bass (Alt+↑) or top (Alt+↓); subsequent presses step through the chord.",
        note: "With a single bare note under the cursor, selects that note.",
      },
      {
        keys: "Alt+←  /  Alt+→",
        desc: "Transpose selected chord note down / up by a syntonic comma (SC).",
        note: "Alt+→ raises by SC, Alt+← lowers. Auto-selects when the target is a bare note.",
      },
    ],
  },
  {
    title: "Tuplet creation",
    intro:
      "Voice-mode sub-flow. Tuplets are non-nested and live within a single measure.",
    bindings: [
      {
        keys: "Ctrl+2 .. Ctrl+7",
        desc: "Begin tuplet creation. Status line prompts for span duration. Press the next digit (1..7) to resolve:",
        note: "Ctrl+2,d = duplet (2:3) in space of dotted-d; Ctrl+3,d = triplet (3:2) in space of d; Ctrl+4,d = quadruplet (4:6) in space of dotted-d; Ctrl+5..7,d = quintuplet/sextuplet/septuplet in space of d.",
      },
      {
        keys: "Ctrl+Shift+3",
        desc: "Tuplet of ANY count: a modal asking for the count, the span in EIGHTH NOTES, and the written note value — every ratio the span admits is listed, the conventional one pre-selected. Enter confirms.",
        note: "Count 9, span 2 → 9:8 in 32nds over a quarter; count 5, span 3 → 5:6 in 16ths over a dotted quarter. A count that fills the span in plain notation (4 over 2 eighths) is refused — that is not a tuplet.",
      },
      {
        keys: "Escape",
        desc: "Cancel a pending tuplet (between Ctrl+N and the digit).",
        note: "Any other non-digit key also cancels it, then acts normally.",
      },
      {
        keys: "1 .. 7  (inside tuplet)",
        desc: "Fill atomic slots with notes/rests of the chosen duration.",
        note: "Durations exceeding remaining tuplet space are rejected. Filling the tuplet completely advances the cursor past it.",
      },
      {
        keys: "Backspace  (inside tuplet)",
        desc: "Nibble one filled slot at a time, regrowing a trailing placeholder.",
        note: "Backspace on the empty-tuplet anchor removes the entire <tuplet> element.",
      },
    ],
  },
  {
    title: "Expression mode",
    intro:
      "One virtual stop per instrument in the ↑/↓ cycle: between a grand staff's upper and lower voices, or after a single staff's two voices; skipped in a measure with no marks. Edits expression marks (dynamics, hairpins, expressive text).",
    bindings: [
      { keys: "←  /  →", desc: "Step through the layer's stops: each mark (a hairpin's start and end separately) and each note onset without a mark." },
      {
        keys: "Ctrl+←  /  Ctrl+→",
        desc: "Jump to the previous / next existing mark, skipping bare note onsets.",
        note: "Also in the pedal and tempo layers. No-op when there is no mark in that direction.",
      },
      {
        keys: "1 .. 8",
        desc: "Enter dynamic at the current moment: fff, ff, f, mf, mp, p, pp, ppp.",
        note: "Bare digit (no Shift) in expression mode. Existing dynamic at this moment is replaced.",
      },
      {
        keys: "<  /  >",
        desc: "Hairpin mark-start / mark-end (same two-step flow as voice mode).",
      },
      {
        keys: "Backspace  /  Delete",
        desc: "Delete the selected expression mark (dynamic, expressive text or hairpin).",
        note: "Coincident marks are separate stops, so each is deleted on its own; a stop with no mark deletes nothing.",
      },
      {
        keys: "Ctrl+↑  /  Ctrl+↓",
        desc: "Move the selected expression mark above / below the staff (@place).",
        note: "In voice mode, Ctrl+↑/↓ moves every expression at the current note instead.",
      },
      { keys: "Escape", desc: "Cancel pending hairpin." },
      { keys: "Home  /  End", desc: "Jump to first / last moment." },
      { keys: "↑", desc: "Leave expression mode upward (back to voice 2)." },
      {
        keys: "↓",
        desc: "Leave expression mode downward (forward to voice 3).",
      },
    ],
  },
  {
    title: "Pedal layer",
    intro:
      "A virtual stop after a grand-staff instrument's lower voices, reachable only when that instrument has pedal marks. Navigates the same moment list as expression mode (note onsets ∪ pedal marks).",
    bindings: [
      { keys: "←  /  →", desc: "Step through the moment list." },
      { keys: "Home  /  End", desc: "Jump to first / last moment." },
      {
        keys: "Shift+P  /  Shift+O",
        desc: "Sustain pedal down / up at the current moment (same as voice mode, anchored to the layer cursor).",
      },
      {
        keys: "Backspace  /  Delete",
        desc: "Delete the selected pedal mark. Deleting the instrument's last pedal mark returns to its last voice (voice 4 on a piano).",
      },
      { keys: "↑", desc: "Leave the pedal layer upward (back to voice 4)." },
    ],
  },
  {
    title: "Tempo layer",
    intro:
      "A score-wide layer at the top of the cycle (↑ from the first instrument's top voice). Tempo applies to all instruments, so it lives in its own layer with a fixed placement above the staff. Navigates note onsets ∪ tempo marks.",
    bindings: [
      { keys: "←  /  →", desc: "Step through the moment list." },
      { keys: "Home  /  End", desc: "Jump to first / last moment." },
      { keys: "Ctrl+Shift+T", desc: "Open the tempo modal at the current moment (also works from voice mode at the cursor)." },
      { keys: "Backspace  /  Delete", desc: "Delete the selected tempo mark. The layer stays reachable when it is empty." },
      { keys: "↓", desc: "Leave the tempo layer downward (to voice 1)." },
    ],
  },
  {
    title: "Configuration modals",
    intro:
      "Ctrl+Shift+letter opens a configuration dialog anchored to the current moment. Enter confirms, Escape cancels.",
    bindings: [
      {
        keys: "Ctrl+Shift+E",
        desc: "Expressive text (pizz, dolce, sul tasto, …) at the cursor moment. Re-open on an existing mark to edit; submit empty to delete. Italic toggle.",
      },
      {
        keys: "Ctrl+Shift+T",
        desc: "Tempo at the cursor moment: instant marking (♩=bpm), ritardando / accelerando (with poco/plain/molto intensity), or a tempo. Retimes playback. Setup's Tempo… button opens the same dialog at measure 1.",
      },
      {
        keys: "Ctrl+Shift+H",
        desc: "Section header (movement title) on the current measure: a centered title that starts a new system, displacing it, with a final barline on the prior measure and measure numbers reset. Submit empty to remove.",
        note: "Not available on the first measure (that's the title block).",
      },
      {
        keys: "Ctrl+Shift+S",
        desc: "Time / key signature, anchored to the cursor's measure. Key picker (major + relative minor) + beats / beat-unit, a Symbol (common C / cut ¢), and an optional additive beat-group pattern (e.g. 2+2+3, beaming only). Setup's controls open the same signature at measure 1. In selection mode, applies over the selected measures with a bounded restore after the range.",
      },
      {
        keys: "Ctrl+Shift+C",
        desc: "Clef change for the cursor's staff at the cursor position (mid-measure allowed). Treble / bass / alto / tenor / octave (treble±8, bass −8). Re-open at the same spot to edit. In selection mode (beat selection), applies over the selected beats and restores the prior clef after.",
      },
      {
        keys: "Ctrl+Shift+A",
        desc: "Pickup / anacrusis at the start of the cursor's section: give its length in EIGHTH NOTES (anything shorter than a full bar). A pickup is a short measure 0 (full time signature still shown); the following measure stays numbered 1. Set to 0 to remove it.",
      },
      {
        keys: "Ctrl+Shift+3",
        desc: "Tuplet of any count at the cursor: count, span in eighth notes, written value (see Tuplet creation).",
      },
    ],
  },
  {
    title: "Selection mode",
    intro:
      "Entered from voice mode via Shift+arrow. Selects a contiguous range of beats (one voice) or measures (one or more two-voice staves). Ctrl+8, Ctrl+R, Ctrl+Shift+S and Ctrl+Shift+C act on the selection; any key not listed here exits it (cursor to the movable end) and then acts normally.",
    bindings: [
      {
        keys: "Shift+←  /  Shift+→",
        desc: "Enter beat selection (from voice mode), or extend the selection by one beat (in selection mode).",
      },
      {
        keys: "Shift+↑  /  Shift+↓",
        desc: "Enter measure selection, or adjust the staff range (in measure selection).",
        note: "First Shift+↑/↓ from beat mode irreversibly promotes to measure mode, covering as many measures as the beat selection touched.",
      },
      {
        keys: "Ctrl+Shift+←  /  Ctrl+Shift+→",
        desc: "Extend the beat selection by a whole measure at a time.",
      },
      {
        keys: "Ctrl+H  /  Ctrl+M",
        desc: "Toggle the hide-empty / multimeasure-rest flag on every empty measure the selection touches, on the selected staves.",
        note: "The selection stays active, so repeated presses cycle (all take the state the fewest had).",
      },
      {
        keys: "Alt+V",
        desc: "Move the selected whole measures into the other voice on the same staff (beat selection only).",
        note: "Needs at least one WHOLE measure holding something, and the other voice free in each of them — otherwise it refuses and says why. The selection follows the music into its new voice, so pressing Alt+V again moves it straight back.",
      },
      { keys: "Ctrl+C", desc: "Copy selection to clipboard." },
      { keys: "Ctrl+X", desc: "Cut selection to clipboard." },
      {
        keys: "Ctrl+V",
        desc: "Paste: a beat clip at the start of the current beat, a measure clip at the current measure. In selection mode it replaces the selection. The pasted content comes back selected; measures are appended when it overflows the score.",
        note: "Also works in voice mode (no selection needed). A measure clip needs a matching time signature. Not available in the expression, pedal or tempo layers.",
      },
      {
        keys: "Backspace  /  Delete",
        desc: "Delete the selection content and exit to voice mode (no clipboard write).",
      },
      {
        keys: "Escape",
        desc: "Exit selection mode (cursor returns to the movable end of the range).",
      },
    ],
  },
];
