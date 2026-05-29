// Keyboard input handler. Keybindings: see ./keybindings.ts (also displayed by the Help modal).

import type { ResolvedNote } from '@hkl/bridge/protocol.js';
import type {
  ComposerModel, Duration, Dots, ChordInput, RestInput, Voice,
} from './model/index.js';
import { ticksOf } from './model/index.js';
import {
  type ExpressionCursor, rebuildCursor, rebuildPedalCursor, currentMoment, step, moveToStart,
  moveToEnd,
} from './cursor/expressionCursor.js';
import {
  addDynam, addHairpin, removeExpression, dynamAt, setDynamText,
  hairpinsAt, momentCompare, measureHasExpression,
  addDir, dirAt, dirText, dirIsItalic, setDirText,
  type Moment,
} from './expressions.js';
import { openTextEntryModal } from './ui/textEntryModal.js';
import { addSlur, removeSlur, collectSlurs } from './slurs.js';
import { togglePedal, pedalMoments, removePedalsAt, type PedalDir } from './pedal.js';
import { beamGroupForElement } from './notation/beams.js';
import type { ArticKind } from './articulations.js';

const ARTIC_KEYS: Record<string, { kind: ArticKind; label: string }> = {
  s: { kind: 'stacc',   label: 'staccato' },
  a: { kind: 'accent',  label: 'accent' },
  t: { kind: 'ten',     label: 'tenuto' },
  f: { kind: 'fermata', label: 'fermata' },
  b: { kind: 'breath',  label: 'breath mark' },
};
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
export type CursorMode = 'voice' | 'expr' | 'pedal' | 'select';

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

interface PendingSlur {
  /** xml:id of the start slot (note or chord). Resolved fresh at close time
   *  so note entry between the two Ctrl+L presses doesn't invalidate it. */
  startId: string;
  voice: Voice;
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
  pedalCursor: ExpressionCursor;
  pendingHairpin: PendingHairpin | null;
  pendingTuplet: PendingTuplet | null;
  pendingSlur: PendingSlur | null;
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
  /** Stop playback and place the editing cursor at the most-recent playback
   *  head (instead of snapping back to its pre-playback position). Bound to
   *  plain ←/→ during playback — "punch out where I hear the music." */
  stopPlaybackAtHead?: () => void;
  /** Seek the audible playback to the next/previous measure boundary
   *  WITHOUT exiting playback. Bound to Ctrl+←/→ during playback —
   *  audio actually jumps to the new position. */
  seekPlaybackByMeasure?: (dir: 'left' | 'right') => void;
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
  pedalCursor: { index: 0, moments: [] },
  pendingHairpin: null,
  pendingTuplet: null,
  pendingSlur: null,
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

/** Drop any chord-internal selection. Called from input.ts at every cursor-
 *  moving keystroke and from main.ts on rewind, matching the invariant
 *  documented on `ChordInternalSel`: cursor movement and voice switches
 *  clear the sel. */
export function clearChordInternalSel(): void {
  state.chordInternalSel = null;
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

function refreshPedalCursor(model: ComposerModel): void {
  const prev = currentMoment(state.pedalCursor);
  state.pedalCursor = rebuildPedalCursor(model.getDoc(), prev);
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
  if (state.cursorMode === 'pedal') return currentMoment(state.pedalCursor);
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

function cancelPendingSlur(hooks: InputHooks): boolean {
  if (!state.pendingSlur) return false;
  state.pendingSlur = null;
  hooks.setStatus?.('Pending slur cancelled.', 'action');
  hooks.onStateChange();
  return true;
}

/* Pedal down (Shift+P) / pedal up (Shift+O). Toggles a <pedal dir=…> at the
   cursor anchor moment (same anchor rule as dynamics: flat[c]). Pressing the
   same key at the same moment removes the mark. Time-anchored, so it survives
   nearby-note deletion. */
function commitPedal(model: ComposerModel, hooks: InputHooks, dir: PedalDir): void {
  const m = momentAtCurrentCursor(model);
  if (!m) {
    hooks.setStatus?.('No cursor anchor for pedal.', 'error');
    return;
  }
  const on = togglePedal(model.getDoc(), m, dir);
  const label = dir === 'down' ? 'Pedal down' : 'Pedal up';
  if (on) {
    hooks.setStatus?.(label + ' at m' + (m.measureIdx + 1) + ' beat ' + formatBeat(m.tstamp) + '.', 'action');
  } else {
    hooks.setStatus?.(label + ' removed.', 'action');
  }
  if (state.cursorMode === 'expr') refreshExprCursor(model);
  if (state.cursorMode === 'pedal') refreshPedalCursor(model);
  hooks.onChange();
  hooks.onStateChange();
}

/* Delete the <pedal> mark(s) at the pedal-layer cursor's moment. Mirrors
   deleteSelectedExpression. */
function deleteSelectedPedal(model: ComposerModel, hooks: InputHooks): boolean {
  const m = currentMoment(state.pedalCursor);
  if (!m) return false;
  const n = removePedalsAt(model.getDoc(), m);
  if (n === 0) {
    hooks.setStatus?.('No pedal mark at this moment.', 'error');
    return false;
  }
  refreshPedalCursor(model);
  /* An empty pedal layer is a dead end (you place marks in voice mode), so
     drop back to voice 4 when the last mark is gone. */
  if (state.pedalCursor.moments.length === 0
      || pedalMoments(model.getDoc()).length === 0) {
    state.cursorMode = 'voice';
    model.setVoicePreservingMeasure(4);
    hooks.setStatus?.('Deleted pedal mark. Voice 4.', 'action');
  } else {
    hooks.setStatus?.('Deleted pedal mark.', 'action');
  }
  hooks.onChange();
  hooks.onStateChange();
  return true;
}

/** The <slur> whose voice matches and whose [start, end] flat-index span
 *  (inclusive) contains the given slot index — i.e. the cursor is "within
 *  the slur". Null if none. */
function findSlurCovering(model: ComposerModel, voice: Voice, index: number): Element | null {
  for (const s of collectSlurs(model.getDoc())) {
    if (s.voice !== voice) continue;
    const a = model.findElement(s.startId);
    const b = model.findElement(s.endId);
    if (!a || !b || a.voice !== voice || b.voice !== voice) continue;
    const lo = Math.min(a.index, b.index);
    const hi = Math.max(a.index, b.index);
    if (index >= lo && index <= hi) return s.el;
  }
  return null;
}

/** Silently drop a pending slur if the voice or cursor-mode changed since the
 *  pre-navigation snapshot. Backlog: "Switching voices exits slur state."
 *  Silent so the post-switch voice status (set by cycleVoice) stays visible. */
function cancelSlurIfVoiceChanged(model: ComposerModel, beforeVoice: Voice, beforeMode: CursorMode): void {
  if (!state.pendingSlur) return;
  if (model.getCurrentVoice() !== beforeVoice || state.cursorMode !== beforeMode) {
    state.pendingSlur = null;
  }
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

/* Common performance-text cues offered as quick-insert chips. */
const EXPRESSIVE_TEXT_PRESETS = [
  'pizz.', 'arco', 'sul tasto', 'sul pont.', 'con sord.', 'senza sord.',
  'dolce', 'espr.', 'cantabile', 'marcato',
];

/* Ctrl+Shift+E: open the reusable text-entry modal to create / edit / delete a
   <dir> (expressive text) at the cursor's moment. Edits in place when a <dir>
   already sits at the moment; submitting empty text removes it. The onOk runs
   after the modal closes, so it manages its own history entry via hooks.history
   (it can't be wrapped by the synchronous withHistory at the dispatch site). */
function openExpressiveText(model: ComposerModel, hooks: InputHooks): void {
  const m = momentAtCurrentCursor(model);
  if (!m) {
    hooks.setStatus?.('No cursor anchor for expressive text.', 'error');
    return;
  }
  const existing = dirAt(model.getDoc(), m);
  openTextEntryModal({
    title: existing ? 'Edit expressive text' : 'Expressive text',
    fields: [
      { name: 'text', type: 'text', label: 'Text',
        value: existing ? dirText(existing) : '', placeholder: 'e.g. dolce' },
      { name: 'italic', type: 'check', label: 'Italic',
        value: existing ? dirIsItalic(existing) : true },
    ],
    presets: EXPRESSIVE_TEXT_PRESETS,
    onOk: (values) => {
      const text = String(values.text ?? '').trim();
      const italic = !!values.italic;
      const before = model.snapshotState();
      const cur = dirAt(model.getDoc(), m); /* re-resolve: doc may have changed */
      let changed = true;
      if (text === '') {
        if (cur) removeExpression(cur);
        else changed = false;
      } else if (cur) {
        setDirText(cur, text, italic);
      } else {
        addDir(model.getDoc(), m, { text, italic });
      }
      if (changed) hooks.history.push(before, model.snapshotState(), 'expr-text');
      if (state.cursorMode === 'expr') refreshExprCursor(model);
      hooks.setStatus?.(text === ''
        ? (changed ? 'Removed expressive text.' : 'No expressive text here.')
        : 'Expressive text: "' + text + '".', 'action');
      hooks.onChange();
      hooks.onStateChange();
    },
  });
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
  if (state.cursorMode === 'pedal') {
    /* Pedal layer sits below voice 4. Up exits back to V4; down is a no-op
       (it's the bottom of the cycle). */
    if (dir === 'up') {
      state.cursorMode = 'voice';
      model.setVoicePreservingMeasure(4);
      hooks.setStatus?.('Voice 4.', 'state');
    }
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
    if (v === 4) {                                          /* 4 → pedal (skip if empty) */
      if (pedalMoments(model.getDoc()).length > 0) {
        state.cursorMode = 'pedal';
        refreshPedalCursor(model);
        hooks.setStatus?.('Pedal layer.', 'state');
      }
      return;
    }
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

/** Read the rendered stem direction for an element with the given xml:id by
 *  comparing its rendered stem and notehead positions. Returns null if the
 *  element isn't currently in the SVG or has no stem (e.g. whole rest, or
 *  a chord/note that hasn't rendered yet). */
function readRenderedStemDir(meiId: string): 'up' | 'down' | null {
  const g = document.getElementById(meiId);
  if (!g) return null;
  const stem = g.querySelector('g.stem, .stem') as Element | null;
  const head = g.querySelector('g.notehead, .notehead') as Element | null;
  if (!stem || !head) return null;
  const sRect = (stem as HTMLElement).getBoundingClientRect();
  const hRect = (head as HTMLElement).getBoundingClientRect();
  if (sRect.width === 0 && sRect.height === 0) return null;
  return sRect.top < hRect.top ? 'up' : 'down';
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
    /* Any alteration magnitude is allowed: (q, r) is the source of truth and
       the render pipeline stacks accidentals beyond ±3 (heji-render.ts). */
    const held = heldRaw;

    /* Chord-extend branch: when a chord-internal selection is set AND we're
       in INS mode, the digit press appends held keys to the selected element
       (chord or bare-note → chord) without advancing the cursor. Duration is
       NOT updated from this digit — chord notes inherit the chord wrapper's
       duration. */
    const extendSel = reconcileChordInternalSel(model);
    if (extendSel && state.mode === 'insert') {
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
    /* Leaving voice mode exits any pending slur. */
    state.pendingSlur = null;
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
    if (state.pendingSlur) { state.pendingSlur = null; }
    state.chordInternalSel = null;
    const entry = isUndo
      ? hooks.history.undo(model, undoEffects)
      : hooks.history.redo(model, undoEffects);
    if (!entry) {
      hooks.setStatus?.(isUndo ? 'Nothing to undo.' : 'Nothing to redo.', 'error');
      return true;
    }
    refreshExprCursor(model);
    refreshPedalCursor(model);
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
      /* Note-decoration keys that respect the chord-internal sel for single-
         note targeting: P (paren caut), L (stem flip), Shift+L (slur dir).
         Articulations S/A/T/F/B attach to the whole slot, so they don't
         use the sel and aren't preserved across (they clear it like any
         non-chord-internal action). */
      const isNoteDecoSingle = state.cursorMode === 'voice'
        && !e.ctrlKey && !e.metaKey && !e.altKey
        && (
          (!e.shiftKey && /^[pPlL]$/.test(e.key))
          || (e.shiftKey && (e.key === 'L' || e.key === 'l'))
        );
      if (!isPureMod && !isAltArrow && !isTie && !isBackspace && !isInsertDigit && !isNoteDecoSingle) {
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

    /* Ctrl+M: insert an empty measure. Rule from the backlog: "at the next
       measure boundary after the cursor (or AT the cursor if it's on a
       measure boundary already)". We use `measureBoundaryCursors` (the
       tstamp-aligned set Ctrl+arrow also lands on) as the authoritative
       boundary set — this avoids the bug where `getMeasureStartCursor` for
       a non-empty M_1 returns cursor=0 (past the leading edge), causing
       cursor=0 to falsely qualify as a boundary even when it visually sits
       on the wrapper between sigs and the first note. Boundaries from
       `measureBoundaryCursors` include cursor=0 (start of score) and all
       seams between existing measures, but NOT mid-measure cursor stops. */
    if (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      if (state.cursorMode !== 'voice') {
        hooks.setStatus?.('Insert-measure requires voice mode.', 'error');
        return;
      }
      if (hooks.isPlaybackActive()) return;
      const v = model.getCurrentVoice();
      const curMIdx = model.cursorMeasureIdx(v, state.mode);
      if (curMIdx < 0) return;
      const cur = model.getCursor(v);
      /* Use tick position to detect boundaries: cursor IS on a measure
         boundary iff its absolute tick is an exact multiple of measureTicks
         AND that boundary is BEFORE some existing measure (not at past-
         end of the last measure). cursor=0 in M_1 qualifies (= start of
         score, can push M_1 forward); past-end of last measure does NOT
         (no measure exists there to push). Mid-measure cursors never
         qualify; Ctrl+M inserts AFTER the current measure. */
      const measureCount = model.allMeasures().length;
      const measureTicks = model.measureTicks();
      const tickPos = model.getTickPositionAt(v, cur);
      const onBoundaryTick = measureTicks > 0
        && (tickPos % measureTicks) === 0
        && tickPos < measureCount * measureTicks;
      const beforeIdx = onBoundaryTick ? Math.round(tickPos / measureTicks) : curMIdx + 1;
      withHistory('insert-measure', () => {
        model.insertMeasureAt(beforeIdx);
        const newStart = model.getMeasureStartCursor(v, beforeIdx);
        model.setCursor(newStart, v);
        return true;
      });
      hooks.setStatus?.('Inserted measure m' + (beforeIdx + 1) + '.', 'action');
      hooks.onStateChange();
      hooks.onChange();
      return;
    }

    /* Ctrl+Shift+E: expressive-text modal at the cursor moment (create / edit /
       delete a <dir>). Opens the reusable text-entry shell. */
    if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      if (hooks.isPlaybackActive()) return;
      openExpressiveText(model, hooks);
      return;
    }

    /* Ctrl+L: slur entry (pending-state toggle). First press marks the start
       slot; second press (after navigating) closes the slur; Ctrl+L on a slot
       already under a slur deletes that slur. Switching voices exits the
       pending state (handled at the arrow-nav call sites). preventDefault is
       critical — Ctrl+L focuses the browser address bar. */
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      if (state.cursorMode !== 'voice') {
        hooks.setStatus?.('Slurs require voice mode.', 'error');
        return;
      }
      if (hooks.isPlaybackActive()) return;
      const voice = model.getCurrentVoice();
      const ref = model.getCurrentElement(voice, state.mode);
      if (!ref || (ref.elem.localName !== 'note' && ref.elem.localName !== 'chord')) {
        hooks.setStatus?.('Place the cursor on a note to slur.', 'error');
        return;
      }
      /* Delete: cursor anywhere under an existing slur in this voice. */
      const covering = findSlurCovering(model, voice, ref.index);
      if (covering) {
        withHistory('slur', () => { removeSlur(covering); return true; });
        state.pendingSlur = null;
        hooks.setStatus?.('Slur deleted.', 'action');
        hooks.onStateChange();
        hooks.onChange();
        return;
      }
      /* Start: enter pending state (no document mutation, no history). */
      if (!state.pendingSlur) {
        state.pendingSlur = { startId: ref.id, voice };
        hooks.setStatus?.('Slur started — navigate to the end note and press Ctrl+L. (Esc to cancel.)', 'state');
        hooks.onStateChange();
        return;
      }
      /* Close: resolve the start slot fresh (note entry may have shifted it). */
      const pending = state.pendingSlur;
      state.pendingSlur = null;
      const startLoc = model.findElement(pending.startId);
      if (!startLoc || startLoc.voice !== voice) {
        hooks.setStatus?.('Slur start note is gone; cancelled.', 'error');
        hooks.onStateChange();
        return;
      }
      if (startLoc.index === ref.index) {
        hooks.setStatus?.('Slur needs two different notes.', 'error');
        hooks.onStateChange();
        return;
      }
      const lowFirst = startLoc.index < ref.index;
      const startId = lowFirst ? pending.startId : ref.id;
      const endId = lowFirst ? ref.id : pending.startId;
      let added = false;
      withHistory('slur', () => {
        added = addSlur(model.getDoc(), startId, endId, voice) !== null;
        return added;
      });
      hooks.setStatus?.(added ? 'Slur added.' : 'Failed to add slur.', added ? 'action' : 'error');
      hooks.onStateChange();
      hooks.onChange();
      return;
    }

    /* Ctrl+Left / Ctrl+Right: bar-jump navigation. Lands at barline cursors
     * — the same set selection mode uses for Ctrl+Shift+Arrow — so the two
     * navigation modes agree on "next/previous measure boundary." Empty
     * measures still contribute a boundary (the wrapper cursor falls on
     * tstamp = barline) so they're not skipped. The "staircase" Ctrl+Left
     * behavior (first press → start of current measure; second press →
     * start of prior measure) falls out naturally from `prev < cur`. */
    if (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      if (state.cursorMode !== 'voice') return;
      /* During playback: Ctrl+←/→ SEEKS the audible head to the adjacent
         measure boundary — playback restarts from there. Doesn't exit
         playback. */
      if (hooks.isPlaybackActive()) {
        hooks.seekPlaybackByMeasure?.(e.key === 'ArrowLeft' ? 'left' : 'right');
        return;
      }
      const voice = model.getCurrentVoice();
      const boundaries = model.measureBoundaryCursors(voice);
      const cur = model.getCursor();
      state.chordInternalSel = null;
      if (e.key === 'ArrowRight') {
        const next = boundaries.find((b) => b > cur);
        if (next !== undefined) model.setCursor(next);
      } else {
        let prev: number | undefined;
        for (const b of boundaries) {
          if (b < cur) prev = b;
          else break;
        }
        if (prev !== undefined) model.setCursor(prev);
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

    /* Pending-hairpin resolution. Cursor navigation within the same voice
       (Left/Right/Home/End, no ctrl/meta/alt) preserves the pending so the
       user can navigate from start to end. The hairpin keys '<' and '>' and
       Escape are handled by their own blocks below. Anything else — note
       entry, dynamics, voice cycling (Up/Down), Ctrl+L, etc. — cancels the
       pending and falls through to its normal handling. Pure-modifier
       keypresses don't count as stray input. */
    if (state.pendingHairpin) {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
        return;
      }
      const isPlainNav = !e.ctrlKey && !e.metaKey && !e.altKey
        && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End');
      const isHairpinSelfKey = e.key === '<' || e.key === '>' || e.key === 'Escape';
      if (!isPlainNav && !isHairpinSelfKey) {
        cancelPendingHairpin(hooks);
        /* no return — handler below processes e */
      }
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

    /* Shift+P / Shift+O: sustain-pedal down / up at the cursor anchor (voice
       mode) or at the pedal-layer cursor's moment (pedal mode). Plain P
       (parenthetical cautionary accidental) is a separate binding disambiguated
       by the Shift guard. */
    if ((state.cursorMode === 'voice' || state.cursorMode === 'pedal')
        && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
        && (e.key === 'P' || e.key === 'O' || e.key === 'p' || e.key === 'o')) {
      e.preventDefault();
      if (hooks.isPlaybackActive()) return;
      const dir: PedalDir = (e.key === 'P' || e.key === 'p') ? 'down' : 'up';
      withHistory('pedal', () => { commitPedal(model, hooks, dir); return true; });
      return;
    }

    /* Voice-mode `L` (no Ctrl): flip stem direction on the current note/chord.
       If the element is in a beam group, every group member flips together
       (Verovio resolves beam stem direction by majority — leaving members
       behind would split or mis-direct the beam). Two-state: pressing L
       when @stem.dir is set CLEARS it (back to natural); when @stem.dir is
       absent SETS it to the opposite of the currently-rendered direction
       (frozen at the override). `Shift+L` does the analogous thing for the
       covering slur's @curvedir. */
    if (state.cursorMode === 'voice' && (e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.shiftKey) {
        e.preventDefault();
        if (hooks.isPlaybackActive()) return;
        const voice = model.getCurrentVoice();
        const ref = model.getCurrentElement(voice, state.mode);
        if (!ref) {
          hooks.setStatus?.('Place the cursor on a slurred note.', 'error');
          return;
        }
        const covering = findSlurCovering(model, voice, ref.index);
        if (!covering) {
          hooks.setStatus?.('No slur at cursor.', 'error');
          return;
        }
        const cur = covering.getAttribute('curvedir');
        if (cur === 'above' || cur === 'below') {
          withHistory('slur-dir', () => { covering.removeAttribute('curvedir'); return true; });
          hooks.setStatus?.('Slur direction cleared (natural).', 'action');
        } else {
          /* Read rendered slur arc direction from its bounding box vs its
             endpoints. If the arc midpoint is above the higher endpoint's
             notehead, it curves "above"; else "below". Heuristic — for v1
             we just toggle in a default direction if reading fails. */
          const arc = document.getElementById(covering.getAttribute('xml:id') ?? '');
          let renderedAbove = true;
          if (arc) {
            const arcRect = (arc as HTMLElement).getBoundingClientRect();
            const startId = covering.getAttribute('startid')?.replace('#', '') ?? '';
            const startEl = startId ? document.getElementById(startId) : null;
            const startRect = startEl ? (startEl as HTMLElement).getBoundingClientRect() : null;
            if (startRect) renderedAbove = arcRect.top < startRect.top - 2;
          }
          const flipped = renderedAbove ? 'below' : 'above';
          withHistory('slur-dir', () => { covering.setAttribute('curvedir', flipped); return true; });
          hooks.setStatus?.('Slur direction = ' + flipped + '.', 'action');
        }
        hooks.onStateChange();
        hooks.onChange();
        return;
      }
      e.preventDefault();
      if (hooks.isPlaybackActive()) return;
      const voice = model.getCurrentVoice();
      const ref = model.getCurrentElement(voice, state.mode);
      if (!ref || (ref.elem.localName !== 'note' && ref.elem.localName !== 'chord')) {
        hooks.setStatus?.('Place the cursor on a note to flip its stem.', 'error');
        return;
      }
      const group = beamGroupForElement(model.getDoc(), ref.elem);
      const anySet = group.some((g) => g.hasAttribute('stem.dir'));
      if (anySet) {
        withHistory('stem-dir', () => {
          for (const g of group) g.removeAttribute('stem.dir');
          return true;
        });
        hooks.setStatus?.('Stem direction cleared (natural)' + (group.length > 1 ? ' on ' + group.length + ' beamed notes.' : '.'), 'action');
      } else {
        const rendered = readRenderedStemDir(ref.id);
        if (!rendered) {
          hooks.setStatus?.('Could not determine current stem direction (re-render and retry).', 'error');
          return;
        }
        const flipped: 'up' | 'down' = rendered === 'up' ? 'down' : 'up';
        withHistory('stem-dir', () => {
          for (const g of group) g.setAttribute('stem.dir', flipped);
          return true;
        });
        hooks.setStatus?.('Stem flipped to ' + flipped + (group.length > 1 ? ' on ' + group.length + ' beamed notes.' : '.'), 'action');
      }
      hooks.onStateChange();
      hooks.onChange();
      return;
    }

    /* Voice-mode `P` toggles `@hkl-paren-caut` on the current note(s). With
       a chord-internal selection set, targets only the selected note; else
       targets every note under the current element (bare note → that note;
       chord → all members). The display pass (accidentals.ts) reads the
       flag and renders the accidental with @enclose="paren". */
    if (state.cursorMode === 'voice' && (e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (hooks.isPlaybackActive()) return;
      const reconciled = reconcileChordInternalSel(model);
      const targetNoteId = reconciled?.noteId;
      let result: { set: boolean; count: number } | null = null;
      withHistory('paren-caut', () => {
        const r = model.toggleParenCautAtCursor(state.mode, targetNoteId);
        if (!r) {
          hooks.setStatus?.('No note under cursor.', 'error');
          return false;
        }
        result = r;
        return true;
      });
      if (result !== null) {
        const rr = result as { set: boolean; count: number };
        hooks.setStatus?.(rr.set
          ? 'Cautionary parens added (' + rr.count + ' note' + (rr.count === 1 ? '' : 's') + ').'
          : 'Cautionary parens removed.', 'action');
      }
      hooks.onStateChange();
      hooks.onChange();
      return;
    }

    /* Voice-mode `H` toggles `@visible="false"` on the current rest. Same
       cursor-anchor rule as dynamics (cursor−1 in INS, cursor in OVR — both
       resolve to flat[c] under the new convention). No-op on non-rest
       elements. */
    if (state.cursorMode === 'voice' && (e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (hooks.isPlaybackActive()) return;
      let result: { hidden: boolean } | null = null;
      withHistory('hide-rest', () => {
        const r = model.toggleHideRestAtCursor(state.mode);
        if (!r) {
          hooks.setStatus?.('No rest under cursor.', 'error');
          return false;
        }
        result = r;
        return true;
      });
      if (result !== null) {
        hooks.setStatus?.((result as { hidden: boolean }).hidden ? 'Rest hidden.' : 'Rest visible.', 'action');
      }
      hooks.onStateChange();
      hooks.onChange();
      return;
    }

    /* Voice-mode articulations: S/A/T/F/B → <artic @artic="stacc|accent|
       ten|fermata|breath"> child of the current note/chord. F (fermata) is
       the only one that also accepts rests. With a chord-internal selection,
       targets only the selected note; else the whole chord wrapper. Each key
       toggles its OWN articulation, so a note can carry multiple (e.g. accent
       + staccato). */
    if (state.cursorMode === 'voice' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const lower = e.key.toLowerCase();
      const ak = ARTIC_KEYS[lower];
      if (ak && /^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        if (hooks.isPlaybackActive()) return;
        let result: { on: boolean; target: 'chord' | 'note' | 'rest' } | null = null;
        withHistory('artic-' + ak.kind, () => {
          const r = model.toggleArticulationAtCursor(state.mode, ak.kind);
          if (!r) {
            const ref = model.getCurrentElement(model.getCurrentVoice(), state.mode);
            const onRest = ref?.elem.localName === 'rest';
            if (onRest && ak.kind !== 'fermata') {
              hooks.setStatus?.(ak.label + ' is not allowed on rests.', 'error');
            } else {
              hooks.setStatus?.('No note under cursor for ' + ak.label + '.', 'error');
            }
            return false;
          }
          result = r;
          return true;
        });
        if (result !== null) {
          const rr = result as { on: boolean; target: 'chord' | 'note' | 'rest' };
          hooks.setStatus?.((rr.on ? 'Added ' : 'Removed ') + ak.label + '.', 'action');
        }
        hooks.onStateChange();
        hooks.onChange();
        return;
      }
    }

    /* Voice-mode `/` toggles `@hkl-beam-break` on the element immediately
       after the cursor (= flat[cursor+1]). regroupBeams (notation/beams.ts)
       treats the marker as "this element starts a new beam," producing a
       manual split mid-beat. No-op when the next element isn't beamable
       (rest, dur < 8, or past-end). */
    if (state.cursorMode === 'voice' && e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (hooks.isPlaybackActive()) return;
      const voice = model.getCurrentVoice();
      const c = model.getCursor(voice);
      /* Cursor c sits between flat[c-1] (just-passed) and flat[c]
         (upcoming). The marker goes on the upcoming element. */
      const next = model.getNextElement(voice, c);
      if (!next) {
        hooks.setStatus?.('No element after cursor for beam split.', 'error');
        return;
      }
      const el = next.elem;
      const dur = el.getAttribute('dur');
      const beamable = el.localName !== 'rest'
        && el.localName !== 'measure'
        && dur !== null
        && parseInt(dur, 10) >= 8;
      if (!beamable) {
        hooks.setStatus?.('Cursor not at a beamable boundary.', 'error');
        return;
      }
      const cur = el.getAttribute('hkl-beam-break');
      if (cur === 'true') {
        withHistory('beam-break', () => { el.removeAttribute('hkl-beam-break'); return true; });
        hooks.setStatus?.('Beam-break cleared.', 'action');
      } else {
        withHistory('beam-break', () => { el.setAttribute('hkl-beam-break', 'true'); return true; });
        hooks.setStatus?.('Beam split at cursor.', 'action');
      }
      hooks.onStateChange();
      hooks.onChange();
      return;
    }

    /* Voice-mode `]` toggles a double bar on the cursor's current measure.
       The last measure of the score is locked to @right="end" and rejects
       the toggle (final bar takes precedence). Anchor is the measure
       containing the cursor, irrespective of INS/OVR. */
    if (state.cursorMode === 'voice' && e.key === ']') {
      e.preventDefault();
      if (hooks.isPlaybackActive()) return;
      const v = model.getCurrentVoice();
      const mIdx = model.cursorMeasureIdx(v, state.mode);
      if (mIdx < 0) {
        hooks.setStatus?.('No measure under cursor.', 'error');
        return;
      }
      const measures = model.allMeasures();
      if (mIdx >= measures.length - 1) {
        hooks.setStatus?.('Last measure already has a final bar.', 'error');
        return;
      }
      withHistory('double-bar', () => {
        const result = model.toggleDoubleBarAt(mIdx);
        if (result === null) return false;
        hooks.setStatus?.(result === 'dbl'
          ? 'Double bar at end of m' + (mIdx + 1) + '.'
          : 'Cleared double bar at end of m' + (mIdx + 1) + '.', 'action');
        return true;
      });
      hooks.onStateChange();
      hooks.onChange();
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

    /* Navigation: Arrow keys, Home/End. Mostly suppressed during playback —
       except plain ←/→ which stops playback and parks the cursor at the
       playback head (so the user can punch out at the audible position). */
    const navKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (navKeys.indexOf(e.key) >= 0) {
      if (hooks.isPlaybackActive()) {
        e.preventDefault();
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight')
            && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
          hooks.stopPlaybackAtHead?.();
        }
        return;
      }
      if (e.key === 'ArrowUp')   { e.preventDefault(); const bv = model.getCurrentVoice(), bm = state.cursorMode; state.chordInternalSel = null; cycleVoice(model, 'up', hooks);   cancelSlurIfVoiceChanged(model, bv, bm); hooks.onStateChange(); hooks.onChange(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); const bv = model.getCurrentVoice(), bm = state.cursorMode; state.chordInternalSel = null; cycleVoice(model, 'down', hooks); cancelSlurIfVoiceChanged(model, bv, bm); hooks.onStateChange(); hooks.onChange(); return; }
      if (state.cursorMode === 'expr') {
        if (e.key === 'ArrowLeft')  { e.preventDefault(); state.exprCursor = step(state.exprCursor, -1); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); state.exprCursor = step(state.exprCursor, +1); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'Home')       { e.preventDefault(); state.exprCursor = moveToStart(state.exprCursor); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'End')        { e.preventDefault(); state.exprCursor = moveToEnd(state.exprCursor); hooks.onStateChange(); hooks.onChange(); return; }
      } else if (state.cursorMode === 'pedal') {
        if (e.key === 'ArrowLeft')  { e.preventDefault(); state.pedalCursor = step(state.pedalCursor, -1); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); state.pedalCursor = step(state.pedalCursor, +1); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'Home')       { e.preventDefault(); state.pedalCursor = moveToStart(state.pedalCursor); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'End')        { e.preventDefault(); state.pedalCursor = moveToEnd(state.pedalCursor); hooks.onStateChange(); hooks.onChange(); return; }
      } else {
        if (e.key === 'ArrowLeft')  { e.preventDefault(); state.chordInternalSel = null; model.moveCursor('left');  hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); state.chordInternalSel = null; model.moveCursor('right'); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'Home')       { e.preventDefault(); state.chordInternalSel = null; model.setCursor(0); hooks.onStateChange(); hooks.onChange(); return; }
        if (e.key === 'End')        { e.preventDefault(); state.chordInternalSel = null; model.cursorToEnd(); hooks.onStateChange(); hooks.onChange(); return; }
      }
    }

    /* Deletion. */
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (state.cursorMode === 'expr') {
        withHistory('delete-expression', () => deleteSelectedExpression(model, hooks));
        return;
      }
      if (state.cursorMode === 'pedal') {
        withHistory('delete-pedal', () => deleteSelectedPedal(model, hooks));
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
      if (state.cursorMode === 'pedal') {
        withHistory('delete-pedal', () => deleteSelectedPedal(model, hooks));
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
      if (cancelPendingHairpin(hooks) || cancelPendingSlur(hooks)) {
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
    if (state.cursorMode === 'expr' || state.cursorMode === 'pedal') return;
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
