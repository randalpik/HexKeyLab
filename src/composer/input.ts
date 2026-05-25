// Keyboard input handler. Keybindings: see ./keybindings.ts (also displayed by the Help modal).

import type { ResolvedNote } from '../bridge/protocol.js';
import type {
  ComposerModel, Duration, Dots, ChordInput, RestInput, Voice,
} from './model/index.js';
import { ticksOf } from './model/index.js';
import { alterFromCount } from './notation/accidentals.js';
import {
  type ExpressionCursor, rebuildCursor, currentMoment, step, moveToStart,
  moveToEnd,
} from './cursor/expressionCursor.js';
import {
  addDynam, addHairpin, removeExpression, dynamAt, setDynamText,
  hairpinsAt, momentCompare, measureHasExpression,
  type Moment,
} from './expressions.js';
import {
  type SelectionState, type Dir,
  enterBeatSelection, enterMeasureSelection,
  moveBeatRange, moveBeatRangeByMeasure, moveMeasureMovable,
  adjustStaffRange, promoteBeatToMeasure, cursorAtMovable,
  beatBoundariesInVoice, currentBeatAt,
} from './selection/selection.js';
import { serializeClipboard, parseClipboard, type ClipboardContents } from './selection/clipboard.js';
import type { HistoryManager } from './history.js';

const TUNING_LABELS: Record<string, string> = {
  E: 'Equal',
  '5': 'Ptolemaic',
  P: 'Pythagorean',
  D: 'Semiditonal',
  '7': 'Septimal',
};
function tuningLabel(mode: string): string {
  return TUNING_LABELS[mode] ?? mode;
}

export type EntryMode = 'insert' | 'overwrite';
export type CursorMode = 'voice' | 'expr' | 'select';

interface PendingHairpin {
  start: Moment;
  form: 'cres' | 'dim';
}

interface PendingTuplet {
  num: number;       /* tuplet ratio numerator (e.g. 3 for triplet) */
  numbase: number;   /* tuplet ratio denominator */
  dotted: boolean;   /* whether the span duration is dotted (N=2,4) */
  atomicK: number;   /* atomic = span-duration divided by K ranks (2/4/8) */
}

/** Per-note selection of a single `<note>` element. Targets a chord-child
 *  note OR a bare `<note>`. When set:
 *    - Alt+Up/Down step through the parent chord's notes (sorted ascending by
 *      MIDI); on a bare-note target, both are no-ops (only one note).
 *    - Alt+Left/Right SC-transpose the selected note.
 *    - `=` (tie) targets only the selected note (instead of the whole chord).
 *    - Backspace deletes only the selected note; if the parent chord drops to
 *      one note, it collapses to a bare note (the survivor becomes selected).
 *    - In INS mode, pressing a duration digit with held HKL keys appends
 *      those keys to the parent chord (or promotes a bare note into a chord)
 *      without advancing the cursor; selection migrates to the lowest-MIDI of
 *      the just-added notes.
 *  Cleared by any other keystroke, by cursor movement, and by voice switches.
 *  The note's xml:id is stable across SC-transpose (siblings reorder but the
 *  element itself stays) and across bare→chord promotion (the original note
 *  becomes a child of the new wrapper). */
export interface ChordInternalSel {
  voice: Voice;
  noteId: string;
}

export interface InputState {
  duration: Duration;
  mode: EntryMode;
  cursorMode: CursorMode;
  exprCursor: ExpressionCursor;
  pendingHairpin: PendingHairpin | null;
  pendingTuplet: PendingTuplet | null;
  selection: SelectionState | null;
  chordInternalSel: ChordInternalSel | null;
}

/* Ctrl+N → ratio + span-dotted-ness + atomic-rank-divisor. Per the agreed
 * V1 keybinding table: 2/4 are duplets/quadruplets in dotted-span (typically
 * compound-time swing), 3/5/6/7 are plain-span. Atomic written-duration
 * derived as (span-duration's denom) × atomicK. */
const TUPLET_CFG: Record<number, { numbase: number; dotted: boolean; atomicK: number }> = {
  2: { numbase: 3, dotted: true,  atomicK: 2 },
  3: { numbase: 2, dotted: false, atomicK: 2 },
  4: { numbase: 6, dotted: true,  atomicK: 4 },
  5: { numbase: 4, dotted: false, atomicK: 4 },
  6: { numbase: 4, dotted: false, atomicK: 4 },
  7: { numbase: 8, dotted: false, atomicK: 8 },
};

const ATOMIC_DENOM_VALID: ReadonlySet<number> = new Set([1, 2, 4, 8, 16, 32, 64]);

export interface InputHooks {
  getHeldKeys: () => ReadonlyArray<ResolvedNote>;
  onChange: () => void;
  onStateChange: () => void;
  setStatus?: (msg: string, kind?: 'info' | 'error' | 'state' | 'action') => void;
  /** Reset the statusline if its current message is transient (error or
   *  post-action confirmation). Called at the top of every keystroke so
   *  any prior red/purple message clears as soon as the user starts a new
   *  action; if the new keystroke writes its own status, that overrides
   *  naturally. State (blue) messages clear via their own mechanisms. */
  clearStatusIfTransient?: () => void;
  /** True while score playback is running. While true, cursor/voice
   *  navigation (arrow keys) is suppressed so the user can't fight the
   *  playback cursors. Other keys (digits, backspace) still work. */
  isPlaybackActive: () => boolean;
  /** Toggle score playback on/off. Bound to bare Space at the top of the
   *  keydown dispatcher so Space works as the universal transport shortcut. */
  togglePlayback: () => void;
  /** Step the renderer zoom one preset in the given direction. The owner
   *  (main.ts) decides the actual preset list and reRenders. */
  onZoomChange?: (dir: 'in' | 'out') => void;
  /** HKL's most-recently-broadcast tuning mode, or null when HKL hasn't
   *  identified yet. Used by the entry-mismatch gate. */
  getHklTuningMode?: () => string | null;
  /** Send an `apply-layout` bridge message asking HKL to switch to the
   *  score's pinned layout. Wired in main.ts. */
  requestApplyLayout?: () => void;
  /** Undo/redo manager. Constructed once in main.ts and shared with any
   *  module that performs user-initiated mutations (input dispatch, setup
   *  dialog, SC-transpose callback). */
  history: HistoryManager;
}

const DIGIT_TO_DUR: Record<string, Duration> = {
  '1': '64',
  '2': '32',
  '3': '16',
  '4': '8',
  '5': '4',
  '6': '2',
  '7': '1',
};

/** Shift+1..Shift+8 → dynamic level (Finale order: 1 = loudest, 8 = softest).
 *  Indexed by e.key as the browser reports it for the US layout under Shift. */
const SHIFT_DIGIT_TO_DYNAMIC: Record<string, string> = {
  '!': 'fff',
  '@': 'ff',
  '#': 'f',
  '$': 'mf',
  '%': 'mp',
  '^': 'p',
  '&': 'pp',
  '*': 'ppp',
};

const DIGIT_TO_DYNAMIC: Record<string, string> = {
  '1': 'fff',
  '2': 'ff',
  '3': 'f',
  '4': 'mf',
  '5': 'mp',
  '6': 'p',
  '7': 'pp',
  '8': 'ppp',
};

const state: InputState = {
  duration: '4',
  mode: 'insert',
  cursorMode: 'voice',
  exprCursor: { index: 0, moments: [] },
  pendingHairpin: null,
  pendingTuplet: null,
  selection: null,
  chordInternalSel: null,
};

/* Set by the keydown Ctrl+C/X handler; consumed by the DOM copy/cut event
 * handler immediately afterwards (same user-gesture tick). The split-handler
 * approach is documented at the keydown handler. */
let pendingClipboardText: string | null = null;

/* Source selection of the most recent copy/cut. On a future paste, the
 * history entry carries this so that undoing the paste re-enters the source
 * selection (cf. plan: "When undoing a copy-paste or cut-paste, the source
 * selection should be re-selected"). Reset on every copy/cut to point at
 * the new source. Not cleared on external clipboard overwrite — see plan
 * edge case #11; tolerable in practice. */
let lastCopySource: SelectionState | null = null;

export function getInputState(): Readonly<InputState> {
  return state;
}

function shouldIgnore(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((t as HTMLElement).isContentEditable) return true;
  return false;
}

/* ── helpers used by both modes ──────────────────────────────────────────── */

function refreshExprCursor(model: ComposerModel): void {
  const prev = currentMoment(state.exprCursor);
  state.exprCursor = rebuildCursor(model.getDoc(), prev);
}

function momentAtVoiceAnchor(model: ComposerModel): Moment | null {
  const v = model.getCurrentVoice();
  const c = model.getCursor();
  /* Both modes anchor on flat[c] (the element to the cursor's left under
     the new cursor convention). `momentForCursor` uses locateCursor's
     insertion-after semantics, so to get the moment AT flat[c]'s start we
     pass `c - 1` (which makes locateCursor return withinIdx pointing to
     flat[c]'s cc-position, then timeWithinMeasure sums everything before
     it). */
  const anchor = Math.max(0, c - 1);
  return model.momentForCursor(v, anchor);
}

function momentAtCurrentCursor(model: ComposerModel): Moment | null {
  if (state.cursorMode === 'expr') return currentMoment(state.exprCursor);
  return momentAtVoiceAnchor(model);
}

function commitDynamic(model: ComposerModel, hooks: InputHooks, name: string): void {
  const m = momentAtCurrentCursor(model);
  if (!m) {
    hooks.setStatus?.('No cursor anchor for dynamic.', 'error');
    return;
  }
  const doc = model.getDoc();
  const existing = dynamAt(doc, m);
  if (existing) {
    setDynamText(existing, name);
    hooks.setStatus?.('Replaced dynamic with "' + name + '".', 'action');
  } else {
    addDynam(doc, m, { text: name });
    hooks.setStatus?.('Dynamic "' + name + '" at m' + (m.measureIdx + 1) + ' beat ' + formatBeat(m.tstamp) + '.', 'action');
  }
  if (state.cursorMode === 'expr') refreshExprCursor(model);
  hooks.onChange();
  hooks.onStateChange();
}

function commitHairpinStep(model: ComposerModel, hooks: InputHooks, form: 'cres' | 'dim'): void {
  const m = momentAtCurrentCursor(model);
  if (!m) {
    hooks.setStatus?.('No cursor anchor for hairpin.', 'error');
    return;
  }
  const pending = state.pendingHairpin;
  if (!pending) {
    state.pendingHairpin = { start: m, form };
    hooks.setStatus?.((form === 'cres' ? 'Crescendo' : 'Decrescendo')
      + ' from m' + (m.measureIdx + 1) + ' beat ' + formatBeat(m.tstamp)
      + ': navigate to end and press ' + (form === 'cres' ? '<' : '>') + '. (Esc to cancel.)', 'state');
    hooks.onStateChange();
    return;
  }
  if (pending.form !== form) {
    /* Different form from the pending mark — abandon the old and start a new. */
    state.pendingHairpin = { start: m, form };
    hooks.setStatus?.('Replaced pending hairpin: now ' + (form === 'cres' ? 'crescendo' : 'decrescendo')
      + ' from m' + (m.measureIdx + 1) + ' beat ' + formatBeat(m.tstamp) + '.', 'state');
    hooks.onStateChange();
    return;
  }
  /* Same form: try to close. */
  if (momentCompare(m, pending.start) <= 0) {
    /* End must be strictly after start. */
    state.pendingHairpin = { start: m, form };
    hooks.setStatus?.('End must be after start; re-marked start at m' + (m.measureIdx + 1) + ' beat ' + formatBeat(m.tstamp) + '.', 'state');
    hooks.onStateChange();
    return;
  }
  const doc = model.getDoc();
  const created = addHairpin(doc, pending.start, m, { form });
  state.pendingHairpin = null;
  if (created) {
    hooks.setStatus?.((form === 'cres' ? 'Crescendo' : 'Decrescendo') + ' added.', 'action');
  } else {
    hooks.setStatus?.('Failed to add hairpin.', 'error');
  }
  if (state.cursorMode === 'expr') refreshExprCursor(model);
  hooks.onChange();
  hooks.onStateChange();
}

function cancelPendingHairpin(hooks: InputHooks): boolean {
  if (!state.pendingHairpin) return false;
  state.pendingHairpin = null;
  hooks.setStatus?.('Pending hairpin cancelled.', 'action');
  hooks.onStateChange();
  return true;
}

function deleteSelectedExpression(model: ComposerModel, hooks: InputHooks): boolean {
  const m = currentMoment(state.exprCursor);
  if (!m) return false;
  const doc = model.getDoc();
  const dynam = dynamAt(doc, m);
  if (dynam) {
    removeExpression(dynam);
    refreshExprCursor(model);
    hooks.setStatus?.('Deleted dynamic.', 'action');
    hooks.onChange();
    hooks.onStateChange();
    return true;
  }
  const hairpins = hairpinsAt(doc, m);
  if (hairpins.length > 0) {
    removeExpression(hairpins[0]);
    refreshExprCursor(model);
    hooks.setStatus?.('Deleted hairpin.', 'action');
    hooks.onChange();
    hooks.onStateChange();
    return true;
  }
  hooks.setStatus?.('No expression element at this moment.', 'error');
  return false;
}

function formatBeat(t: number): string {
  return t.toFixed(2).replace(/\.?0+$/, '');
}

/* ── voice cycling: 1 → 2 → expr → 3 → 4 ─────────────────────────────────── */

function cycleVoice(model: ComposerModel, dir: 'up' | 'down', hooks: InputHooks): void {
  if (state.cursorMode === 'expr') {
    state.cursorMode = 'voice';
    /* Up exits to voice 2, Down exits to voice 3. */
    const v: Voice = dir === 'up' ? 2 : 3;
    model.setVoicePreservingMeasure(v);
    hooks.setStatus?.('Voice ' + v + '.', 'state');
    return;
  }
  const v = model.getCurrentVoice();
  if (dir === 'up') {
    if (v === 1) return;
    if (v === 2) { model.switchVoice('up'); return; }       /* 2 → 1 */
    if (v === 3) {                                          /* 3 → expr (skip if empty) */
      if (measureHasExpression(model.getDoc(), model.cursorMeasureIdx(3))) {
        state.cursorMode = 'expr';
        refreshExprCursor(model);
        hooks.setStatus?.('Expression layer.', 'state');
      } else {
        model.setVoicePreservingMeasure(2);
        hooks.setStatus?.('Voice 2.', 'state');
      }
      return;
    }
    if (v === 4) { model.switchVoice('up'); return; }       /* 4 → 3 */
  } else {
    if (v === 1) { model.switchVoice('down'); return; }     /* 1 → 2 */
    if (v === 2) {                                          /* 2 → expr (skip if empty) */
      if (measureHasExpression(model.getDoc(), model.cursorMeasureIdx(2))) {
        state.cursorMode = 'expr';
        refreshExprCursor(model);
        hooks.setStatus?.('Expression layer.', 'state');
      } else {
        model.setVoicePreservingMeasure(3);
        hooks.setStatus?.('Voice 3.', 'state');
      }
      return;
    }
    if (v === 3) { model.switchVoice('down'); return; }     /* 3 → 4 */
    if (v === 4) return;
  }
}

/* ── chord-internal selection helpers ─────────────────────────────────────── */

function chordNotesByMidiAscending(chord: Element): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(chord.children)) {
    if (c.localName === 'note') out.push(c);
  }
  return out;
}

/** Returns the cursor's target element when it's selectable: a `<chord>`
 *  (any size) or a bare `<note>`. Returns null for rests/measures/tuplets/etc.
 *  Cursor convention is "cursor c targets flat[c]". */
function selectableTargetAtCursor(model: ComposerModel): Element | null {
  const v = model.getCurrentVoice();
  const ref = model.getCurrentElement(v, state.mode);
  if (!ref) return null;
  if (ref.elem.localName === 'chord' || ref.elem.localName === 'note') {
    return ref.elem;
  }
  return null;
}

/** Walks `voice`'s flat stream and returns the `<note>` element with the
 *  given xml:id, whether it's bare in a layer or a child of a `<chord>`.
 *  Returns null when not found. */
function findNoteById(model: ComposerModel, voice: Voice, noteId: string): Element | null {
  const flat = model.flatChildren(voice);
  for (const el of flat) {
    if (el.localName === 'note' && el.getAttribute('xml:id') === noteId) return el;
    if (el.localName === 'chord') {
      for (const c of Array.from(el.children)) {
        if (c.localName === 'note' && c.getAttribute('xml:id') === noteId) return c;
      }
    }
  }
  return null;
}

/** True when the note's parent element is a `<chord>` wrapper. */
function noteIsInChord(noteEl: Element): boolean {
  return noteEl.parentElement?.localName === 'chord';
}

/** Validate that the saved selection still points at a live `<note>`;
 *  drop it if not. Called before any selection-targeted action. */
function reconcileChordInternalSel(model: ComposerModel): ChordInternalSel | null {
  const sel = state.chordInternalSel;
  if (!sel) return null;
  if (sel.voice !== model.getCurrentVoice()) { state.chordInternalSel = null; return null; }
  const note = findNoteById(model, sel.voice, sel.noteId);
  if (!note) { state.chordInternalSel = null; return null; }
  return sel;
}

/** Resolve the selected note element (or null when sel is stale). */
function selectedNoteElement(model: ComposerModel, sel: ChordInternalSel): Element | null {
  return findNoteById(model, sel.voice, sel.noteId);
}

function diagnoseChordTarget(model: ComposerModel): string {
  const v = model.getCurrentVoice();
  const ref = model.getCurrentElement(v, state.mode);
  const cursor = model.getCursor(v);
  if (!ref) return 'cursor at past-end (cursor=' + cursor + ', no element under cursor)';
  const ln = ref.elem.localName;
  if (ln !== 'chord' && ln !== 'note') {
    return 'cursor on <' + ln + '>, not <chord> or <note>';
  }
  return 'no selectable note under cursor (cursor=' + cursor + ')';
}

function handleChordInternalArrow(
  model: ComposerModel, hooks: InputHooks,
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight',
): void {
  const existing = reconcileChordInternalSel(model);
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    if (!existing) {
      const target = selectableTargetAtCursor(model);
      if (!target) {
        hooks.setStatus?.('Chord-internal: ' + diagnoseChordTarget(model), 'error');
        return;
      }
      if (target.localName === 'note') {
        /* Bare-note target: Alt+Up/Down both activate selection on the only
           note. Subsequent presses are no-ops (clamp at the same note). */
        const id = target.getAttribute('xml:id');
        if (!id) return;
        state.chordInternalSel = { voice: model.getCurrentVoice(), noteId: id };
        hooks.onStateChange();
        return;
      }
      /* Chord target: Alt+Up enters at bass; Alt+Down enters at top. */
      const notes = chordNotesByMidiAscending(target);
      if (notes.length === 0) return;
      const initial = key === 'ArrowUp' ? notes[0] : notes[notes.length - 1];
      const noteId = initial.getAttribute('xml:id');
      if (!noteId) return;
      state.chordInternalSel = { voice: model.getCurrentVoice(), noteId };
      hooks.onStateChange();
      return;
    }
    const noteEl = selectedNoteElement(model, existing);
    if (!noteEl) { state.chordInternalSel = null; hooks.onStateChange(); return; }
    if (!noteIsInChord(noteEl)) {
      /* Bare-note selection: only one note — clamp (no-op). */
      hooks.onStateChange();
      return;
    }
    /* Chord-child selection: step within the chord's MIDI-ascending children. */
    const chord = noteEl.parentElement!;
    const notes = chordNotesByMidiAscending(chord);
    const idx = notes.indexOf(noteEl);
    if (idx < 0) { state.chordInternalSel = null; hooks.onStateChange(); return; }
    const newIdx = key === 'ArrowUp'
      ? Math.min(notes.length - 1, idx + 1)
      : Math.max(0, idx - 1);
    const newNote = notes[newIdx];
    const newId = newNote.getAttribute('xml:id');
    if (!newId) return;
    existing.noteId = newId;
    hooks.onStateChange();
    return;
  }
  /* ArrowLeft / ArrowRight → SC transposition. */
  let sel = existing;
  if (!sel) {
    /* Auto-select on bare notes — Alt+Left/Right is permitted without an
       Alt+Up/Down step since there's only one note to act on. Chord ≥2
       targets still require explicit selection (ambiguous which note). */
    const target = selectableTargetAtCursor(model);
    if (target && target.localName === 'note') {
      const id = target.getAttribute('xml:id');
      if (!id) return;
      sel = { voice: model.getCurrentVoice(), noteId: id };
      state.chordInternalSel = sel;
      hooks.onStateChange();
    } else {
      hooks.setStatus?.('Alt+Up/Down selects a chord note first.', 'error');
      return;
    }
  }
  applySCTranspose(model, hooks, sel, key === 'ArrowRight' ? +1 : -1);
}

/** Stub: real implementation lives in scTranspose.ts. Defined here as a
 *  function reference so the dispatch above can call it; the module-level
 *  binding is assigned in initInput when the scTranspose module is available. */
let applySCTranspose: (
  model: ComposerModel, hooks: InputHooks,
  sel: ChordInternalSel, dir: 1 | -1,
) => void = (_m, hooks) => {
  hooks.setStatus?.('SC transpose not wired (internal).', 'error');
};

/** Allow main.ts (or whoever imports the SC module) to install the real
 *  implementation. Keeps the input handler free of a hard import on
 *  scTranspose so that the keystroke wiring can be tested independently. */
export function installSCTransposeImpl(
  fn: (model: ComposerModel, hooks: InputHooks, sel: ChordInternalSel, dir: 1 | -1) => void,
): void {
  applySCTranspose = fn;
}

/* ── main dispatch ───────────────────────────────────────────────────────── */

export function initInput(model: ComposerModel, hooks: InputHooks): () => void {
  /** Snapshot-wrap a mutation. Pushes a history entry iff fn() returned
   *  truthy (or void) and the before/after MEIs differ. fn returning false
   *  explicitly aborts the push (used when the mutation was rejected). */
  function withHistory(
    label: string,
    fn: () => boolean | void,
    opts: { sourceSelection?: SelectionState; mergeable?: boolean; mergeIfTopMergeable?: boolean } = {},
  ): boolean {
    const before = model.snapshotState();
    const result = fn();
    if (result === false) return false;
    const after = model.snapshotState();
    hooks.history.push(before, after, label, opts);
    return true;
  }

  function commitDuration(dur: Duration): void {
    const heldRaw = hooks.getHeldKeys();
    /* Filter notes whose alteration exceeds ±3 — Verovio can't render
       compound accidentals legibly (the extra <accid> glyphs overlap
       without horizontal allocation). The user can re-spell or shift
       the lattice to bring them in range. */
    const held = heldRaw.filter((k) => Math.abs(alterFromCount(k.accid)) <= 3);

    /* Chord-extend branch: when a chord-internal selection is set AND we're
       in INS mode, the digit press appends held keys to the selected element
       (chord or bare-note → chord) without advancing the cursor. Duration is
       NOT updated from this digit — chord notes inherit the chord wrapper's
       duration. */
    const extendSel = reconcileChordInternalSel(model);
    if (extendSel && state.mode === 'insert') {
      if (heldRaw.length > 0 && held.length === 0) {
        hooks.setStatus?.('All held keys have alteration > ±3; not added.', 'error');
        return;
      }
      if (held.length === 0) {
        hooks.setStatus?.('Hold keys to add to chord.', 'error');
        return;
      }
      /* Layout-mismatch gate still applies: appended notes must match the
         score's pinned tuning so (q, r) maps correctly. */
      const hklMode = hooks.getHklTuningMode?.() ?? null;
      const required = model.getLayoutReq().tuningMode;
      if (hklMode !== null && hklMode !== required) {
        const apply = window.confirm(
          'HKL is in "' + tuningLabel(hklMode) + '" but this score requires "' + tuningLabel(required) + '".\n\n' +
          'Notes added now would sound at HKL\'s current pitches, not the score\'s.\n\n' +
          'Apply the score\'s layout to HKL? (then re-press your keys)'
        );
        if (apply) {
          hooks.requestApplyLayout?.();
          hooks.setStatus?.('Applied score\'s tuning to HKL. Re-press your keys.', 'action');
        } else {
          hooks.setStatus?.('Switch HKL to "' + tuningLabel(required) + '" to add notes.', 'error');
        }
        return;
      }
      withHistory('extend chord', () => {
        const result = model.appendNotesToSelection(extendSel.noteId, held);
        if (!result) {
          hooks.setStatus?.('Cannot extend chord — selection lost.', 'error');
          return false;
        }
        if (result.addedIds.length === 0) {
          hooks.setStatus?.('All held keys already in chord.', 'error');
          return false;
        }
        /* Selection migrates to the lowest-MIDI of the just-added notes
           (per user choice). addedIds are pushed in iteration order; the
           sort step rearranges chord children but addedIds order isn't
           re-sorted. Compute lowest-MIDI explicitly by looking up each
           added id's (q, r) and picking the min. Use a linear scan rather
           than querySelector with the `xml\\:id` attribute escape, which
           has had cross-environment quirks in testing. */
        const allNotes = Array.from(model.getDoc().querySelectorAll('note'));
        let lowest: string | null = null;
        let lowestMidi = Infinity;
        for (const id of result.addedIds) {
          const note = allNotes.find((n) => n.getAttribute('xml:id') === id);
          if (!note) continue;
          const q = parseInt(note.getAttribute('data-q') ?? '0', 10);
          const r = parseInt(note.getAttribute('data-r') ?? '0', 10);
          const midi = 57 + 4 * q + 7 * r;
          if (midi < lowestMidi) {
            lowestMidi = midi;
            lowest = id;
          }
        }
        if (lowest) {
          state.chordInternalSel = { voice: extendSel.voice, noteId: lowest };
        }
        if (result.skipped > 0) {
          hooks.setStatus?.('Added ' + result.addedIds.length + '; skipped ' + result.skipped + ' duplicate(s).', 'action');
        } else {
          hooks.setStatus?.('Added ' + result.addedIds.length + ' to chord.', 'action');
        }
        return true;
      });
      hooks.onStateChange();
      hooks.onChange();
      return;
    }

    state.duration = dur;
    if (heldRaw.length > 0 && held.length === 0) {
      hooks.setStatus?.('All held keys have alteration > ±3; not entered.', 'error');
      return;
    }
    if (held.length < heldRaw.length) {
      hooks.setStatus?.('Some held keys had alteration > ±3 and were dropped.', 'error');
    }

    /* Layout-mismatch gate: keys entered now sound at HKL's current tuning,
       but the score is pinned to a (possibly different) tuning mode. If they
       disagree, the (q,r) values held aren't the ones the score wants. Block
       the commit; offer to push the score's layout to HKL (Cancel-only when
       held is empty — a rest insert is mode-independent). */
    if (held.length > 0) {
      const hklMode = hooks.getHklTuningMode?.() ?? null;
      const required = model.getLayoutReq().tuningMode;
      if (hklMode !== null && hklMode !== required) {
        const apply = window.confirm(
          'HKL is in "' + tuningLabel(hklMode) + '" but this score requires "' + tuningLabel(required) + '".\n\n' +
          'Notes entered now would sound at HKL\'s current pitches, not the score\'s.\n\n' +
          'Apply the score\'s layout to HKL? (then re-press your keys)'
        );
        if (apply) {
          hooks.requestApplyLayout?.();
          hooks.setStatus?.('Applied score\'s tuning to HKL. Re-press your keys.', 'action');
        } else {
          hooks.setStatus?.('Switch HKL to "' + tuningLabel(required) + '" to enter notes.', 'error');
        }
        return;
      }
    }

    /* Pre-flight insertability check: surfaces specific rejection reasons
       (in-tuplet overflow or bar-line displacement) before we attempt the
       insert. The model's insert methods still defensively reject on
       overflow, but those paths surface only a generic "Doesn't fit." */
    {
      const can = model.canInsertHere(dur, 0);
      if (!can.ok) {
        hooks.setStatus?.(can.reason, 'error');
        return;
      }
    }

    const ok = withHistory(held.length > 0 ? 'chord' : 'rest', () => {
      if (held.length > 0) {
        const chord: ChordInput = { notes: held, duration: dur };
        if (state.mode === 'overwrite') {
          const id = model.replaceChordAtCursor(chord);
          if (id === null) {
            if (model.insertChordAtCursor(chord) === null) {
              hooks.setStatus?.("Doesn't fit.", 'error');
              return false;
            }
          } else {
            model.moveCursor('right');
          }
        } else {
          if (model.insertChordAtCursor(chord) === null) {
            hooks.setStatus?.("Doesn't fit.", 'error');
            return false;
          }
        }
      } else {
        const rest: RestInput = { duration: dur };
        if (model.insertRestAtCursor(rest) === null) {
          hooks.setStatus?.("Doesn't fit.", 'error');
          return false;
        }
      }
      return true;
    });
    if (!ok) return;
    hooks.onStateChange();
    hooks.onChange();
  }

  /* ── selection-mode helpers ────────────────────────────────────────────── */

  function formatSelectionStatus(sel: SelectionState): string {
    if (sel.kind === 'beat') {
      const boundaries = beatBoundariesInVoice(model, sel.voice);
      const lo = boundaries[sel.first];
      const hi = boundaries[sel.last + 1];
      const loInfo = model.getFlatStopInfo(sel.voice, lo);
      const hiInfo = model.getFlatStopInfo(sel.voice, hi);
      const loM = (loInfo?.measureIdx ?? 0) + 1;
      const hiM = Math.min(model.allMeasures().length, (hiInfo?.measureIdx ?? 0) + 1);
      const beats = sel.last - sel.first + 1;
      return 'Sel: V' + sel.voice + ' M' + loM + (loM === hiM ? '' : '–M' + hiM)
        + ' (' + beats + ' beat' + (beats === 1 ? '' : 's')
        + ', Shift+arrow to adjust)';
    }
    const mLo = Math.min(sel.anchorMeasure, sel.movableMeasure) + 1;
    const mHi = Math.max(sel.anchorMeasure, sel.movableMeasure) + 1;
    const sLo = sel.firstStaff;
    const sHi = sel.lastStaff;
    return 'Sel: M' + mLo + (mLo === mHi ? '' : '–M' + mHi)
      + ', staff ' + sLo + (sLo === sHi ? '' : '–' + sHi)
      + ' (measure mode)';
  }

  function setStateAfterSelectionChange(): void {
    if (state.selection) hooks.setStatus?.(formatSelectionStatus(state.selection), 'state');
    hooks.onStateChange();
    hooks.onChange();
  }

  /** Snap cursor to the movable end of the current selection, clear selection,
   *  return to voice mode. Caller decides whether to emit status / trigger
   *  re-render. */
  function exitSelectionToMovable(): void {
    if (!state.selection) return;
    const pos = cursorAtMovable(model, state.selection);
    model.setVoice(pos.voice);
    model.setCursor(pos.flatIndex, pos.voice);
    state.selection = null;
    state.cursorMode = 'voice';
  }

  /** Delete the content covered by `sel` and park the cursor at the lastMoved-
   *  side boundary (beat) or movable end (measure). Shared by cut (Ctrl+X) and
   *  Backspace/Delete-on-selection. Must run inside `withHistory(...)`; the
   *  caller is responsible for status, selection/mode cleanup, and re-renders. */
  function deleteSelectionContent(sel: SelectionState): boolean {
    if (sel.kind === 'beat') {
      const boundaries = beatBoundariesInVoice(model, sel.voice);
      /* Cursor lands at the lastMoved-side boundary post-deletion (= the
       * "user's perceived current position"). Capture its tstamp before
       * mutating; the model's flat indices shift but the tstamp is stable. */
      const exitCursorTstamp = model.getTickPositionAt(
        sel.voice,
        sel.lastMoved === 'first' ? boundaries[sel.first] : boundaries[sel.last + 1],
      );
      const tLo = model.getTickPositionAt(sel.voice, boundaries[sel.first]);
      const tHi = model.getTickPositionAt(sel.voice, boundaries[sel.last + 1]);
      model.clearBeatRange(sel.voice, tLo, tHi);
      model.setVoice(sel.voice);
      model.setCursor(
        model.findCursorByTickPosition(sel.voice, exitCursorTstamp),
        sel.voice,
      );
    } else {
      const mLo = Math.min(sel.anchorMeasure, sel.movableMeasure);
      const mHi = Math.max(sel.anchorMeasure, sel.movableMeasure);
      model.clearMeasureRange(mLo, mHi, sel.firstStaff, sel.lastStaff);
      const pos = cursorAtMovable(model, sel);
      model.setVoice(pos.voice);
      model.setCursor(pos.flatIndex, pos.voice);
    }
    return true;
  }

  /** Enter selection mode from voice mode based on the Shift+arrow direction.
   *  Returns true on success. Both Shift+Left and Shift+Right enter beat
   *  mode with the current beat selected (single-beat selection); the
   *  asymmetric anchor/movable entry has been retired. */
  function enterSelectionFromVoice(arrow: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'): boolean {
    const v = model.getCurrentVoice();
    const c = model.getCursor();
    if (arrow === 'ArrowLeft' || arrow === 'ArrowRight') {
      const dir: Dir = arrow === 'ArrowLeft' ? 'left' : 'right';
      const sel = enterBeatSelection(model, v, c, dir);
      if (!sel) {
        hooks.setStatus?.('No beats available in this voice.', 'error');
        return false;
      }
      state.selection = sel;
      state.cursorMode = 'select';
      return true;
    }
    // Shift+Up / Shift+Down — enter measure mode on current measure.
    const mIdx = model.getCursorMeasureIdx(v);
    if (mIdx < 0) {
      hooks.setStatus?.('No measure under cursor.', 'error');
      return false;
    }
    state.selection = enterMeasureSelection(model, v, mIdx);
    state.cursorMode = 'select';
    return true;
  }

  /** Apply a parsed clipboard contents at the model's current cursor. Sets
   *  state.selection to cover the newly-pasted content per spec. Callers
   *  wrap this in `withHistory` so the merge-with-prior-cut rule fires. */
  function applyPasteInner(contents: ClipboardContents): boolean {
    if (contents.kind === 'beat') {
      const voice = model.getCurrentVoice();
      const c = model.getCursor();
      const boundaries = beatBoundariesInVoice(model, voice);
      if (boundaries.length <= 1) {
        hooks.setStatus?.('No beats available in this voice.', 'error');
        return false;
      }
      /* Snap to the boundary at-or-before the current cursor. */
      let snapIdx = 0;
      for (let i = 0; i < boundaries.length; i++) {
        if (boundaries[i] <= c) snapIdx = i;
        else break;
      }
      const beatStart = boundaries[snapIdx];
      const tLoAbs = model.getTickPositionAt(voice, beatStart);
      const result = model.pasteBeatContent(
        voice, tLoAbs, contents.elements, contents.durationTicks,
      );
      if (!result.ok) {
        hooks.setStatus?.('Paste failed: ' + result.reason, 'error');
        return false;
      }
      /* Re-enter beat selection covering the pasted content. */
      const tHiAbs = tLoAbs + contents.durationTicks;
      const newBoundaries = beatBoundariesInVoice(model, voice);
      const firstBeat = currentBeatAt(model, voice, model.findCursorByTickPosition(voice, tLoAbs));
      const lastCursor = model.findCursorByTickPosition(voice, tHiAbs);
      let lastBeat = currentBeatAt(model, voice, lastCursor);
      /* If the right edge of the paste is exactly at a beat boundary, the
       * "current beat" helper reports the beat just ended — which is what we
       * want for `last`. If the paste was a single beat, firstBeat === lastBeat. */
      if (lastBeat < firstBeat) lastBeat = firstBeat;
      if (newBoundaries.length > 1) {
        state.selection = {
          kind: 'beat',
          voice,
          origin: firstBeat,
          first: firstBeat,
          last: lastBeat,
          lastMoved: 'last',
        };
        state.cursorMode = 'select';
      } else {
        state.selection = null;
        state.cursorMode = 'voice';
      }
      hooks.setStatus?.('Pasted ' + contents.durationTicks + ' ticks.', 'action');
      return true;
    }
    // Measure paste.
    const destTs = (() => {
      const ts = model.getTimeSig();
      return ts.count + '/' + ts.unit;
    })();
    if (contents.sourceTimeSig !== destTs) {
      hooks.setStatus?.(
        'Cannot paste: source time-sig ' + contents.sourceTimeSig
        + ' ≠ destination ' + destTs + '.',
        'error',
      );
      return false;
    }
    const voice = model.getCurrentVoice();
    const mDest = model.getCursorMeasureIdx(voice);
    if (mDest < 0) {
      hooks.setStatus?.('No measure at cursor.', 'error');
      return false;
    }
    const result = model.pasteMeasureContent(
      mDest,
      contents.sourceStaffRange.first,
      contents.sourceStaffRange.last,
      contents.measures,
      contents.expressions,
    );
    if (!result.ok) {
      hooks.setStatus?.('Paste failed: ' + result.reason, 'error');
      return false;
    }
    /* Re-enter measure selection covering the pasted measures × staves. The
       cursor's voice's staff anchors as originStaff if it's in range, else
       firstStaff. */
    const curStaff: 1 | 2 = voice <= 2 ? 1 : 2;
    const originStaff = curStaff >= contents.sourceStaffRange.first
      && curStaff <= contents.sourceStaffRange.last
      ? curStaff
      : contents.sourceStaffRange.first;
    state.selection = {
      kind: 'measure',
      originVoice: voice,
      originStaff,
      firstStaff: contents.sourceStaffRange.first,
      lastStaff: contents.sourceStaffRange.last,
      anchorMeasure: result.mLo,
      movableMeasure: result.mHi,
      movableSide: result.mLo === result.mHi ? 'unset' : 'right',
    };
    state.cursorMode = 'select';
    hooks.setStatus?.('Pasted ' + (result.mHi - result.mLo + 1) + ' measure(s).', 'action');
    return true;
  }

  /** Delete the current selection without copying. Used by Ctrl+V in
   *  selection mode (delete-then-paste). Cursor lands at the start of
   *  the deleted range, in the appropriate voice. */
  function deleteSelectionWithoutCopy(sel: SelectionState): void {
    if (sel.kind === 'beat') {
      const boundaries = beatBoundariesInVoice(model, sel.voice);
      const lo = boundaries[sel.first];
      const hi = boundaries[sel.last + 1];
      const tLo = model.getTickPositionAt(sel.voice, lo);
      const tHi = model.getTickPositionAt(sel.voice, hi);
      model.clearBeatRange(sel.voice, tLo, tHi);
      model.setVoice(sel.voice);
      model.setCursor(model.findCursorByTickPosition(sel.voice, tLo), sel.voice);
    } else {
      const mLo = Math.min(sel.anchorMeasure, sel.movableMeasure);
      const mHi = Math.max(sel.anchorMeasure, sel.movableMeasure);
      model.clearMeasureRange(mLo, mHi, sel.firstStaff, sel.lastStaff);
      model.setVoice(sel.originVoice);
      model.setCursor(model.getMeasureStartCursor(sel.originVoice, mLo), sel.originVoice);
    }
  }

  /** Handle a keydown event while in selection mode. Returns true if the
   *  event was consumed (handler should return); false if the event causes
   *  exit-to-movable and should fall through to the rest of the handler. */
  function dispatchSelectionMode(e: KeyboardEvent): boolean {
    const sel = state.selection;
    if (!sel) return false; // defensive
    // Pure modifier keypresses — ignore, stay in selection mode.
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
      return true;
    }
    // Escape — exit to movable.
    if (e.key === 'Escape') {
      e.preventDefault();
      exitSelectionToMovable();
      hooks.setStatus?.('Selection cancelled.', 'action');
      hooks.onStateChange();
      hooks.onChange();
      return true;
    }
    // Shift+Arrow / Ctrl+Shift+Arrow — adjust selection. Selection no
    // longer collapses to zero width (the new beat model preserves at least
    // one beat at all times), so there's no convergence-exit branch.
    if (e.shiftKey && !e.metaKey && !e.altKey) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const dir: Dir = e.key === 'ArrowLeft' ? 'left' : 'right';
        e.preventDefault();
        if (sel.kind === 'beat') {
          state.selection = e.ctrlKey
            ? moveBeatRangeByMeasure(model, sel, dir)
            : moveBeatRange(model, sel, dir);
        } else {
          // Measure mode — Ctrl is ignored.
          state.selection = moveMeasureMovable(model, sel, dir);
        }
        setStateAfterSelectionChange();
        return true;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const updir: 'up' | 'down' = e.key === 'ArrowUp' ? 'up' : 'down';
        if (sel.kind === 'beat') {
          // Promote to measure mode. Per spec, the first Shift+Up/Down from
          // beat mode irreversibly switches to measure mode covering as many
          // measures as the beat selection touched.
          state.selection = promoteBeatToMeasure(model, sel);
        } else {
          state.selection = adjustStaffRange(sel, updir);
        }
        setStateAfterSelectionChange();
        return true;
      }
    }
    /* Ctrl+C / Ctrl+X: do the model side-effects here (serialize the
       selection, exit/delete) and stash the serialized text in
       `pendingClipboardText` for the DOM copy/cut event to ferry into
       `event.clipboardData`. This split lets us
         (a) get reliable OS-clipboard I/O across browsers via DOM events
             (Firefox blocks `navigator.clipboard.readText()` and surfaces
             the "Paste" UI); AND
         (b) keep model side-effects observable from CDP-driven tests
             (which dispatch keydown but don't synthesize clipboard events).
       Ctrl+V is handled entirely by the DOM `paste` event handler below —
       the data isn't known until clipboardData is available. */
    if (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey) {
      if (e.key === 'c' || e.key === 'C') {
        /* Copy leaves the selection intact — only cut/paste mutate state.
           Just serialize into pendingClipboardText for the DOM copy event
           handler to ferry into event.clipboardData; do NOT preventDefault. */
        pendingClipboardText = serializeClipboard(model, sel);
        lastCopySource = sel;
        hooks.setStatus?.('Copied to clipboard.', 'action');
        return true;
      }
      if (e.key === 'x' || e.key === 'X') {
        pendingClipboardText = serializeClipboard(model, sel);
        const capturedSel: SelectionState = sel;
        lastCopySource = sel;
        withHistory(
          'cut',
          () => deleteSelectionContent(sel),
          { sourceSelection: capturedSel, mergeable: true },
        );
        state.selection = null;
        state.cursorMode = 'voice';
        refreshExprCursor(model);
        hooks.setStatus?.('Cut to clipboard.', 'action');
        hooks.onStateChange();
        hooks.onChange();
        return true;
      }
      if (e.key === 'v' || e.key === 'V') {
        /* Paste handled exclusively by the DOM `paste` event — we can't
           do the model side-effect until we have the clipboard data. */
        return true;
      }
    }
    /* Bare Backspace / Delete: delete the selected content and exit to voice
       mode. Same end state as cut, minus the clipboard write. Without this
       branch, the key would fall through to the normal-mode Backspace/Delete
       handler at the post-exit cursor and chew adjacent content. */
    if ((e.key === 'Backspace' || e.key === 'Delete')
        && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const capturedSel: SelectionState = sel;
      withHistory(
        'delete-selection',
        () => deleteSelectionContent(sel),
        { sourceSelection: capturedSel, mergeable: true },
      );
      state.selection = null;
      state.cursorMode = 'voice';
      refreshExprCursor(model);
      hooks.setStatus?.('Selection deleted.', 'action');
      hooks.onStateChange();
      hooks.onChange();
      return true;
    }
    // Any other key → exit selection to movable, then fall through so the
    // key triggers its normal handler at the post-exit cursor position.
    exitSelectionToMovable();
    hooks.onStateChange();
    // Do NOT re-render yet — the fall-through handler may also mutate, and
    // we want a single render at the end.
    return false;
  }

  function commitPendingTuplet(durKey: string): void {
    const pending = state.pendingTuplet;
    if (!pending) return;
    const dur = DIGIT_TO_DUR[durKey];
    state.pendingTuplet = null;
    if (!dur) {
      hooks.setStatus?.('Tuplet span: invalid digit.', 'error');
      hooks.onStateChange();
      return;
    }
    const dDenom = parseInt(dur, 10);
    const atomicDenom = dDenom * pending.atomicK;
    if (!ATOMIC_DENOM_VALID.has(atomicDenom)) {
      hooks.setStatus?.('Tuplet atomic duration too small to represent.', 'error');
      hooks.onStateChange();
      return;
    }
    const atomicDur = String(atomicDenom) as Duration;
    const spanDots: Dots = pending.dotted ? 1 : 0;
    let success = false;
    withHistory('tuplet', () => {
      const r = model.createTupletAtCursor({
        num: pending.num, numbase: pending.numbase,
        spanDur: dur, spanDots, atomicDur,
      });
      if (!r.ok) {
        hooks.setStatus?.(r.reason, 'error');
        return false;
      }
      success = true;
      return true;
    });
    if (success) {
      hooks.setStatus?.('Tuplet ' + pending.num + ':' + pending.numbase + ' added.', 'action');
    }
    hooks.onStateChange();
    hooks.onChange();
  }

  /** Effects bag used by HistoryManager to apply selection / cursorMode
   *  side-effects when undoing/redoing. Defined here so it closes over `state`
   *  and survives across all initInput-scoped calls. */
  const undoEffects = {
    setSelection(sel: SelectionState | null): void { state.selection = sel; },
    setCursorMode(mode: CursorMode): void { state.cursorMode = mode; },
  };

  function dispatchUndoRedo(e: KeyboardEvent): boolean {
    if (!e.ctrlKey || e.metaKey || e.altKey) return false;
    /* Ctrl+Z (undo). Ctrl+Y or Ctrl+Shift+Z (redo). */
    const isUndo = !e.shiftKey && (e.key === 'z' || e.key === 'Z');
    const isRedo = (!e.shiftKey && (e.key === 'y' || e.key === 'Y'))
      || (e.shiftKey && (e.key === 'z' || e.key === 'Z'));
    if (!isUndo && !isRedo) return false;
    e.preventDefault();
    if (hooks.isPlaybackActive()) return true;
    /* Pending state references the model under the cursor; restoring an
     * earlier snapshot may invalidate those references. Cancel first. */
    if (state.pendingHairpin) { state.pendingHairpin = null; }
    if (state.pendingTuplet) { state.pendingTuplet = null; }
    state.chordInternalSel = null;
    const entry = isUndo
      ? hooks.history.undo(model, undoEffects)
      : hooks.history.redo(model, undoEffects);
    if (!entry) {
      hooks.setStatus?.(isUndo ? 'Nothing to undo.' : 'Nothing to redo.', 'error');
      return true;
    }
    refreshExprCursor(model);
    hooks.setStatus?.((isUndo ? 'Undo: ' : 'Redo: ') + entry.label, 'action');
    hooks.onStateChange();
    hooks.onChange();
    return true;
  }

  function handler(e: KeyboardEvent): void {
    if (shouldIgnore(e)) return;

    /* Any non-modifier keystroke counts as "the user took a new action" —
       clear any lingering red error or purple post-action message so it
       doesn't haunt unrelated follow-up keys. The new keystroke may write
       its own status; if so, that overrides the just-cleared default.
       Pure-modifier keys (still arming a combo) don't clear. */
    if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') {
      hooks.clearStatusIfTransient?.();
    }

    /* Bare Space → toggle playback. Browser default for Space on the document
       body is page scroll, so we MUST preventDefault. Handled at the top so
       Space works regardless of selection / chord-internal-sel / pending-tuplet
       state — playback is a transport mode, orthogonal to editing state. Form
       fields are already excluded by shouldIgnore() above. */
    if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      hooks.togglePlayback();
      return;
    }

    /* Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z — undo/redo. Must fire before selection-
       mode dispatch so undo works while a selection is active. */
    if (dispatchUndoRedo(e)) return;

    /* Chord-internal selection lifetime: preserved across Alt+arrow (the
       navigation/transpose keys themselves), across `=` (which retargets to
       the single note), across Backspace (which deletes only the selected
       note, or collapses the chord; the handler manages sel afterward), and
       across INS-mode duration digits (which become chord-extend appends in
       this state; the handler manages sel afterward). Pure-modifier keys
       also preserve. Every other keystroke clears it. */
    if (state.chordInternalSel) {
      const isPureMod = e.key === 'Shift' || e.key === 'Control'
        || e.key === 'Alt' || e.key === 'Meta';
      const isAltArrow = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
        && (e.key === 'ArrowUp' || e.key === 'ArrowDown'
          || e.key === 'ArrowLeft' || e.key === 'ArrowRight');
      const isTie = e.key === '=' && !e.ctrlKey && !e.metaKey && !e.altKey
        && !e.shiftKey;
      const isBackspace = e.key === 'Backspace' && !e.ctrlKey && !e.metaKey
        && !e.altKey && !e.shiftKey;
      const isInsertDigit = state.cursorMode === 'voice' && state.mode === 'insert'
        && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
        && DIGIT_TO_DUR[e.key] !== undefined;
      if (!isPureMod && !isAltArrow && !isTie && !isBackspace && !isInsertDigit) {
        state.chordInternalSel = null;
        /* No onStateChange here — fall through; downstream handlers fire
           onStateChange/onChange as part of their normal work, which will
           cause the cursor overlay to drop the horizontal line. */
      }
    }

    /* Selection mode dispatch — must come first. Selection-mode keys
       (Shift+arrow, Ctrl+Shift+arrow, Ctrl+C/X/V, Escape) are handled here;
       any other key exits selection mode (cursor → movable stop) and falls
       through so the key applies at the post-exit cursor position. */
    if (state.cursorMode === 'select' && state.selection) {
      if (dispatchSelectionMode(e)) return;
      /* Fell through: selection has been exited, voice mode restored. */
    }

    /* Shift+arrow from voice mode → enter selection mode. Must come BEFORE
       the bail-on-modifier check (which only bails on Ctrl/Meta/Alt) and
       BEFORE the navKeys block (which doesn't differentiate by shiftKey). */
    if (state.cursorMode === 'voice' && e.shiftKey &&
        !e.metaKey && !e.altKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight'
          || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      /* Ctrl+Shift+arrow from voice mode is reserved for in-selection use;
         outside selection mode it's a no-op (we don't want to enter selection
         and immediately jump by a measure on the same press). */
      if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      if (hooks.isPlaybackActive()) return;
      const arrow = e.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';
      if (enterSelectionFromVoice(arrow)) {
        setStateAfterSelectionChange();
      }
      return;
    }

    /* Ctrl+V from voice mode is handled by the DOM `paste` event listener
       below (no preventDefault here, no async clipboard read). */

    /* Ctrl+2..7 begins tuplet creation. Must come BEFORE the bail-on-modifier
       check below. preventDefault is critical: in Firefox/Chromium, Ctrl+1..8
       is the tab-nav shortcut, but the browser respects preventDefault on
       keydown for these. */
    if (e.ctrlKey && !e.metaKey && !e.altKey && /^[2-7]$/.test(e.key)) {
      e.preventDefault();
      if (state.cursorMode !== 'voice') {
        hooks.setStatus?.('Tuplet creation requires voice mode.', 'error');
        return;
      }
      if (hooks.isPlaybackActive()) return;
      if (model.isCursorInTuplet()) {
        hooks.setStatus?.('Cannot nest tuplets.', 'error');
        return;
      }
      const n = parseInt(e.key, 10);
      const cfg = TUPLET_CFG[n];
      state.pendingTuplet = { num: n, numbase: cfg.numbase, dotted: cfg.dotted, atomicK: cfg.atomicK };
      hooks.setStatus?.('Tuplet ' + n + ':' + cfg.numbase + ' — press duration digit for span.', 'state');
      hooks.onStateChange();
      return;
    }

    /* Ctrl+Left / Ctrl+Right: bar-jump navigation, keyed off the cursor's
     * VISUAL measure (where the cursor renders), not the insertion-target
     * measure. Empty measures (for the voice) are NOT skipped — they each
     * have one cursor stop (the placeholder, or wrapper-cursor in insert
     * mode) that Ctrl-nav lands on.
     * - Ctrl+Right → first visual stop of the next measure (past-end when
     *   already in the last measure).
     * - Ctrl+Left → first visual stop of the current measure, OR first
     *   stop of the previous measure when the cursor is already there. */
    if (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      if (state.cursorMode !== 'voice') return;
      if (hooks.isPlaybackActive()) return;
      const voice = model.getCurrentVoice();
      const m = model.cursorMeasureIdx(voice, state.mode);
      const total = model.allMeasures().length;
      if (e.key === 'ArrowRight') {
        if (m + 1 < total) {
          const target = model.getFirstVisualCursorInMeasure(voice, m + 1, state.mode);
          model.setCursor(target >= 0 ? target : model.getVoiceLength(voice));
        } else {
          model.setCursor(model.getVoiceLength(voice));
        }
      } else {
        const curStart = model.getFirstVisualCursorInMeasure(voice, m, state.mode);
        if (curStart >= 0 && model.getCursor() !== curStart) {
          model.setCursor(curStart);
        } else if (m > 0) {
          const target = model.getFirstVisualCursorInMeasure(voice, m - 1, state.mode);
          if (target >= 0) model.setCursor(target);
        }
      }
      hooks.onChange();
      hooks.onStateChange();
      return;
    }

    /* Alt+arrow: chord-internal selection (Alt+Up/Down) and SC transposition
       on the selected note (Alt+Left/Right). Must come before the modifier
       bail below — Alt is otherwise unused. We preventDefault unconditionally
       on Alt+Arrow even when no action runs, because Firefox uses Alt+Left
       and Alt+Right as Back/Forward history nav — without preventDefault on
       keydown the browser navigates away from Composer mid-edit. */
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
        && (e.key === 'ArrowUp' || e.key === 'ArrowDown'
          || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      if (state.cursorMode === 'voice' && !hooks.isPlaybackActive()) {
        handleChordInternalArrow(model, hooks, e.key);
      }
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;

    /* Pending-tuplet resolution. A digit press following Ctrl+N completes
       the tuplet; ANY other non-modifier key cancels the pending and falls
       through to its normal handling. Pure-modifier keypresses (Shift /
       Control / Alt / Meta alone) don't count as "stray input". */
    if (state.pendingTuplet) {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
        return;
      }
      if (state.cursorMode === 'voice' && DIGIT_TO_DUR[e.key]) {
        e.preventDefault();
        commitPendingTuplet(e.key);
        return;
      }
      /* Cancel and fall through to normal handling for this key. */
      state.pendingTuplet = null;
      hooks.setStatus?.('Tuplet cancelled.', 'action');
      hooks.onStateChange();
      /* no return — handler below processes e */
    }

    /* Zoom shortcuts. Apply in any mode (voice / expression / mid-pending-tuplet).
       e.key === '+' is Shift+= on US layouts; e.key === '_' is Shift+-. Neither
       is produced unshifted, so the shifted-only intent holds without an extra
       e.shiftKey check. */
    if (e.key === '+' || e.key === '_') {
      e.preventDefault();
      hooks.onZoomChange?.(e.key === '+' ? 'in' : 'out');
      return;
    }

    /* Hairpin shortcuts (apply in BOTH voice and expression mode). Must come
       before the digit handlers so '<' and '>' aren't swallowed by Shift+,/. */
    if (e.key === '<') {
      e.preventDefault();
      withHistory('hairpin', () => { commitHairpinStep(model, hooks, 'cres'); return true; });
      return;
    }
    if (e.key === '>') {
      e.preventDefault();
      withHistory('hairpin', () => { commitHairpinStep(model, hooks, 'dim'); return true; });
      return;
    }

    /* Voice-mode Shift+digit dynamics: !@#$%^ → pp p mp mf f ff. */
    if (state.cursorMode === 'voice' && SHIFT_DIGIT_TO_DYNAMIC[e.key]) {
      e.preventDefault();
      withHistory('dynamic', () => { commitDynamic(model, hooks, SHIFT_DIGIT_TO_DYNAMIC[e.key]); return true; });
      return;
    }

    /* Expression-mode bare-digit dynamics: 1-8 → fff ff f mf mp p pp ppp. */
    if (state.cursorMode === 'expr' && DIGIT_TO_DYNAMIC[e.key]) {
      e.preventDefault();
      withHistory('dynamic', () => { commitDynamic(model, hooks, DIGIT_TO_DYNAMIC[e.key]); return true; });
      return;
    }

    /* Voice-mode durations. */
    if (state.cursorMode === 'voice' && DIGIT_TO_DUR[e.key]) {
      e.preventDefault();
      commitDuration(DIGIT_TO_DUR[e.key]);
      return;
    }

    /* Voice-mode dot cycle + tie toggle. Both are no-ops in expression mode. */
    if (state.cursorMode === 'voice' && e.key === '.') {
      e.preventDefault();
      withHistory('dot', () => {
        const r = model.cycleDotsOnCurrent(state.mode);
        if (r === null) { hooks.setStatus?.('No note under cursor.', 'error'); return false; }
        return true;
      });
      hooks.onStateChange();
      hooks.onChange();
      return;
    }
    if (state.cursorMode === 'voice' && e.key === '=') {
      e.preventDefault();
      const reconciled = reconcileChordInternalSel(model);
      /* When a chord-internal selection is set, derive the note's index
         within the chord's MIDI-ascending children to pass through to the
         model. Bare-note selections (parent === <layer>) leave noteIndex
         undefined; toggleTieOnCurrent then acts on the only note. */
      let noteIndex: number | undefined;
      if (reconciled) {
        const noteEl = selectedNoteElement(model, reconciled);
        if (noteEl && noteIsInChord(noteEl)) {
          const siblings = chordNotesByMidiAscending(noteEl.parentElement!);
          const idx = siblings.indexOf(noteEl);
          if (idx >= 0) noteIndex = idx;
        }
      }
      withHistory('tie', () => {
        const r = model.toggleTieOnCurrent(state.mode, noteIndex);
        if (r === null) { hooks.setStatus?.('No tieable note under cursor.', 'error'); return false; }
        return true;
      });
      hooks.onChange();
      return;
    }

    /* Navigation: Arrow keys, Home/End. Suppressed during playback. */
    const navKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (navKeys.indexOf(e.key) >= 0) {
      if (hooks.isPlaybackActive()) { e.preventDefault(); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); cycleVoice(model, 'up', hooks);   hooks.onStateChange(); hooks.onChange(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); cycleVoice(model, 'down', hooks); hooks.onStateChange(); hooks.onChange(); return; }
      if (state.cursorMode === 'expr') {
        if (e.key === 'ArrowLeft')  { e.preventDefault(); state.exprCursor = step(state.exprCursor, -1); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); state.exprCursor = step(state.exprCursor, +1); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'Home')       { e.preventDefault(); state.exprCursor = moveToStart(state.exprCursor); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'End')        { e.preventDefault(); state.exprCursor = moveToEnd(state.exprCursor); hooks.onStateChange(); hooks.onChange(); return; }
      } else {
        if (e.key === 'ArrowLeft')  { e.preventDefault(); model.moveCursor('left');  hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); model.moveCursor('right'); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'Home')       { e.preventDefault(); model.setCursor(0); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'End')        { e.preventDefault(); model.cursorToEnd(); hooks.onStateChange(); hooks.onChange(); return; }
      }
    }

    /* Deletion. */
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (state.cursorMode === 'expr') {
        withHistory('delete-expression', () => deleteSelectedExpression(model, hooks));
        return;
      }
      let deleted = false;
      /* Chord-internal selection branch: target ONLY the selected note (not
         the whole chord). Bare-note selections fall through to the standard
         whole-element deletion via deleteAtCursor, which already does the
         right thing (the cursor is past the bare note). */
      const delSel = reconcileChordInternalSel(model);
      const delNote = delSel ? selectedNoteElement(model, delSel) : null;
      const targetInChord = !!(delNote && noteIsInChord(delNote));
      withHistory('delete', () => {
        if (delSel && targetInChord) {
          const r = model.deleteNoteInChord(delSel.noteId);
          if (!r) return false;
          /* Selection update: when the chord collapsed to a bare note, the
             survivor's xml:id is preserved as the new selection target.
             When the chord remains a chord, clear sel (the user can re-enter
             via Alt+arrow). */
          if (r.collapsed && r.survivorId) {
            state.chordInternalSel = { voice: delSel.voice, noteId: r.survivorId };
          } else {
            state.chordInternalSel = null;
          }
          deleted = true;
          return true;
        }
        /* Bare-note selection or no selection: standard delete. Clear sel
           after deletion (target gone). */
        deleted = model.deleteAtCursor();
        if (deleted) state.chordInternalSel = null;
        return deleted;
      });
      if (deleted) {
        /* Voice mutation may have changed the expression moment list. */
        refreshExprCursor(model);
        hooks.onStateChange();
        hooks.onChange();
      }
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      if (state.cursorMode === 'expr') {
        withHistory('delete-expression', () => deleteSelectedExpression(model, hooks));
        return;
      }
      const v = model.getCurrentVoice();
      const c = model.getCursor();
      const id = model.getElementIdAt(v, c);
      if (id !== null) {
        let deleted = false;
        withHistory('delete', () => {
          model.moveCursor('right');
          deleted = model.deleteAtCursor();
          return deleted;
        });
        if (deleted) {
          refreshExprCursor(model);
          hooks.onStateChange();
          hooks.onChange();
        }
      }
      return;
    }

    /* Escape: cancel pending hairpin (works in either mode). Pending tuplet
       is cancelled earlier in the handler by the stray-input branch. */
    if (e.key === 'Escape') {
      if (cancelPendingHairpin(hooks)) {
        e.preventDefault();
        return;
      }
    }

    /* Mode toggle. */
    if (e.key === 'Insert') {
      e.preventDefault();
      state.mode = (state.mode === 'insert' ? 'overwrite' : 'insert');
      hooks.onStateChange();
      hooks.onChange();
      return;
    }
  }

  /* DOM clipboard-event handlers. These fire on Ctrl+C/X/V (and on
     right-click → Copy/Cut/Paste) BEFORE the browser's default behavior,
     and crucially give us synchronous access to `event.clipboardData` —
     no `navigator.clipboard.readText()`, no Firefox permission prompt. */
  /* On Ctrl+C/X, the keydown handler stashed the serialized fragment in
     `pendingClipboardText` and did all the model side-effects. Here we just
     ferry the text into the event's clipboardData (the only browser-API
     point at which Firefox lets us write the OS clipboard without prompting). */
  function copyHandler(e: ClipboardEvent): void {
    if (shouldIgnore(e as unknown as KeyboardEvent)) return;
    if (pendingClipboardText === null) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', pendingClipboardText);
    pendingClipboardText = null;
  }

  function cutHandler(e: ClipboardEvent): void {
    if (shouldIgnore(e as unknown as KeyboardEvent)) return;
    if (pendingClipboardText === null) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', pendingClipboardText);
    pendingClipboardText = null;
  }

  function pasteHandler(e: ClipboardEvent): void {
    if (shouldIgnore(e as unknown as KeyboardEvent)) return;
    if (state.cursorMode === 'expr') return;
    if (hooks.isPlaybackActive()) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const contents = parseClipboard(text);
    if (!contents) {
      hooks.setStatus?.('Clipboard is empty or not HKL content.', 'error');
      return;
    }
    e.preventDefault();
    /* One history entry covers (delete-selection-if-any) + paste. Merge into
     * the prior `cut` entry when possible — cut→paste reads as a single
     * "move" action, undoable in one step with source-selection restored. */
    let ok = false;
    const sourceSelForUndo = lastCopySource;
    withHistory(
      'paste',
      () => {
        /* In selection mode: delete the existing selection first, then paste at
           the resulting cursor position. */
        if (state.cursorMode === 'select' && state.selection) {
          deleteSelectionWithoutCopy(state.selection);
          state.selection = null;
          state.cursorMode = 'voice';
        }
        ok = applyPasteInner(contents);
        return ok;
      },
      { sourceSelection: sourceSelForUndo ?? undefined, mergeIfTopMergeable: true },
    );
    if (ok) {
      refreshExprCursor(model);
      hooks.onStateChange();
      hooks.onChange();
    }
  }

  document.addEventListener('keydown', handler);
  document.addEventListener('copy', copyHandler);
  document.addEventListener('cut', cutHandler);
  document.addEventListener('paste', pasteHandler);
  return () => {
    document.removeEventListener('keydown', handler);
    document.removeEventListener('copy', copyHandler);
    document.removeEventListener('cut', cutHandler);
    document.removeEventListener('paste', pasteHandler);
  };
}
