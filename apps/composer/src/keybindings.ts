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
      { keys: "Space", desc: "Play / pause from cursor." },
      {
        keys: "Click on note / rest",
        desc: "Move the cursor to that note and switch to its voice.",
      },
      {
        keys: "←  /  →  (during playback)",
        desc: "Stop playback. Cursor lands where you heard.",
      },
      { keys: "Ctrl+Z", desc: "Undo." },
      { keys: "Ctrl+Y  /  Ctrl+Shift+Z", desc: "Redo." },
      { keys: "Shift+=", desc: "Zoom in." },
      { keys: "Shift+-", desc: "Zoom out." },
      { keys: "Escape", desc: "Cancel pending hairpin or pending tuplet." },
    ],
  },
  {
    title: "Voice mode",
    intro:
      "Active when the current voice is 1..4. Step entry follows Finale convention.",
    bindings: [
      {
        keys: "1 .. 7",
        desc: "Duration: 1 = 64th, 2 = 32nd, 3 = 16th, 4 = 8th, 5 = quarter, 6 = half, 7 = whole.",
        note: "With held HKL keys → chord at this duration. Without held keys → rest.",
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
        desc: "Double bar line at the end of the current measure.",
      },
      {
        keys: "H",
        desc: "Hide the current rest (still affects timing).",
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
        keys: "/",
        desc: "Toggle a beam break at the cursor. Splits a beam mid-beat, or joins one across beats.",
      },
      {
        keys: "S  /  A  /  T  /  F  /  B",
        desc: "Add staccato, accent, tenuto, fermata, or breath mark to the current note or chord.",
        note: "Only fermata can attach to a rest.",
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
        keys: "Shift+P  /  Shift+O",
        desc: "Sustain pedal down / up (off) at the cursor anchor.",
        note: "Anchor: in INS mode, the just-entered element (cursor−1); in OVR mode, the element at cursor. Press again at the same moment to remove the mark.",
      },
      {
        keys: "↑  /  ↓",
        desc: "Previous / next voice. Cycle: 1 → 2 → expr → 3 → 4 → pedal.",
        note: "The expression and pedal layers appear in the cycle only when they contain marks; create marks in voice mode, then navigate the layer to edit/delete.",
      },
      {
        keys: "←  /  →",
        desc: "Move cursor left / right within the current voice.",
      },
      {
        keys: "Home  /  End",
        desc: "Jump to start / end of the current voice.",
      },
      { keys: "Backspace", desc: "Delete element at/before cursor." },
      { keys: "Delete", desc: "Delete element after cursor." },
      { keys: "Insert", desc: "Toggle insert / overwrite mode (INS ↔ OVR)." },
      {
        keys: "Ctrl+M",
        desc: "Insert a new empty measure after the current one. Cursor lands at its start.",
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
        keys: "Escape",
        desc: "Cancel a pending tuplet (between Ctrl+N and the digit).",
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
      "A virtual voice between voices 2 and 3 in the cycle. Edits expression marks (dynamics, hairpins).",
    bindings: [
      { keys: "←  /  →", desc: "Step through the unified moment list." },
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
        desc: "Delete the selected expression element at this moment (dynam first, then any containing hairpin).",
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
      "A virtual layer after voice 4 in the cycle (reachable only when pedal marks exist). Navigates the same moment list as expression mode (note onsets ∪ pedal marks).",
    bindings: [
      { keys: "←  /  →", desc: "Step through the moment list." },
      { keys: "Home  /  End", desc: "Jump to first / last moment." },
      {
        keys: "Shift+P  /  Shift+O",
        desc: "Sustain pedal down / up at the current moment (same as voice mode, anchored to the layer cursor).",
      },
      {
        keys: "Backspace  /  Delete",
        desc: "Delete the pedal mark(s) at this moment. Deleting the last mark exits to voice 4.",
      },
      { keys: "↑", desc: "Leave the pedal layer upward (back to voice 4)." },
    ],
  },
  {
    title: "Selection mode",
    intro:
      "Entered from voice mode via Shift+arrow. Selects a contiguous range of beats (one voice) or measures (one or more two-voice staves).",
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
      { keys: "Ctrl+C", desc: "Copy selection to clipboard." },
      { keys: "Ctrl+X", desc: "Cut selection to clipboard." },
      {
        keys: "Ctrl+V",
        desc: "Paste at the cursor. Auto-appends measures when content overflows the score.",
        note: "Also works in voice mode (no selection needed for paste).",
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
