// Keyboard input handler. Finale-style step entry plus an "expression layer"
// virtual voice sitting between voices 2 and 3 in the navigation cycle.
//
// Voice mode (current voice 1..4):
//   1-7        = duration (Finale: 1=64th, 2=32nd, 3=16th, 4=8th, 5=quarter,
//                6=half, 7=whole). With held keys → chord; otherwise rest.
//   . (period) = cycle dots (0→1→2→0) on the current note/chord/rest.
//   = (equal)  = toggle tie on the current note/chord.
//   ! @ # $ % ^ & * (Shift+1..8) = enter fff / ff / f / mf / mp / p / pp / ppp
//                at the cursor's anchor moment (Finale convention: 1 = loudest,
//                8 = softest). Existing dynamic at that moment is replaced.
//                Anchor: in insert mode, the just-entered element (cursor−1);
//                in overwrite mode, the element at cursor.
//   <  >       = begin/commit crescendo / decrescendo at the cursor's anchor
//                moment. Two-step: first press marks start; second press at a
//                later moment closes the hairpin. Escape cancels.
//   ArrowUp/Down   = previous/next voice. Cycle: 1 → 2 → expr → 3 → 4.
//   ArrowLeft/Right = move cursor in current voice.
//   Backspace  = delete element at/before cursor.
//   Insert     = toggle insert / overwrite mode.
//   Home / End = jump to start / end of current voice.
//
// Expression mode:
//   ArrowLeft/Right = step through the unified moment list (note onsets
//                     across all voices ∪ existing expression moments).
//   1-8        = enter fff / ff / f / mf / mp / p / pp / ppp at the current
//                moment (Finale convention: 1 = loudest, 8 = softest).
//                Existing dynamic at this moment is replaced.
//   <  >       = hairpin mark-start / mark-end (same flow as voice mode).
//   Backspace / Delete = delete the selected expression element at this
//                moment (dynam first, then any containing hairpin).
//   Escape     = cancel pending hairpin.
//   Home / End = jump to first / last moment.
//   ArrowUp    = leave expression mode upward (back to voice 2).
//   ArrowDown  = leave expression mode downward (forward to voice 3).
//
// Mouse-to-document input is intentionally out of scope per the v1 spec.

import type { ResolvedNote } from '../bridge/protocol.js';
import type {
  ComposerModel, Duration, ChordInput, RestInput, Voice,
} from './model.js';
import { alterFromCount } from './accidentals.js';
import {
  type ExpressionCursor, rebuildCursor, currentMoment, step, moveToStart,
  moveToEnd,
} from './expressionCursor.js';
import {
  addDynam, addHairpin, removeExpression, dynamAt, setDynamText,
  hairpinsAt, momentCompare,
  type Moment,
} from './expressions.js';

export type EntryMode = 'insert' | 'overwrite';
export type CursorMode = 'voice' | 'expr';

interface PendingHairpin {
  start: Moment;
  form: 'cres' | 'dim';
}

export interface InputState {
  duration: Duration;
  mode: EntryMode;
  cursorMode: CursorMode;
  exprCursor: ExpressionCursor;
  pendingHairpin: PendingHairpin | null;
}

export interface InputHooks {
  getHeldKeys: () => ReadonlyArray<ResolvedNote>;
  onChange: () => void;
  onStateChange: () => void;
  setStatus?: (msg: string) => void;
  /** True while score playback is running. While true, cursor/voice
   *  navigation (arrow keys) is suppressed so the user can't fight the
   *  playback cursors. Other keys (digits, backspace) still work. */
  isPlaybackActive: () => boolean;
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
};

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
  /* Insert mode: anchor at the just-entered element (cursor−1). Overwrite
     mode: anchor at the element under the cursor. */
  const anchor = state.mode === 'insert' ? Math.max(0, c - 1) : c;
  return model.momentForCursor(v, anchor);
}

function momentAtCurrentCursor(model: ComposerModel): Moment | null {
  if (state.cursorMode === 'expr') return currentMoment(state.exprCursor);
  return momentAtVoiceAnchor(model);
}

function commitDynamic(model: ComposerModel, hooks: InputHooks, name: string): void {
  const m = momentAtCurrentCursor(model);
  if (!m) {
    hooks.setStatus?.('No cursor anchor for dynamic.');
    return;
  }
  const doc = model.getDoc();
  const existing = dynamAt(doc, m);
  if (existing) {
    setDynamText(existing, name);
    hooks.setStatus?.('Replaced dynamic with "' + name + '".');
  } else {
    addDynam(doc, m, { text: name });
    hooks.setStatus?.('Dynamic "' + name + '" at m' + (m.measureIdx + 1) + ' beat ' + formatBeat(m.tstamp) + '.');
  }
  if (state.cursorMode === 'expr') refreshExprCursor(model);
  hooks.onChange();
  hooks.onStateChange();
}

function commitHairpinStep(model: ComposerModel, hooks: InputHooks, form: 'cres' | 'dim'): void {
  const m = momentAtCurrentCursor(model);
  if (!m) {
    hooks.setStatus?.('No cursor anchor for hairpin.');
    return;
  }
  const pending = state.pendingHairpin;
  if (!pending) {
    state.pendingHairpin = { start: m, form };
    hooks.setStatus?.((form === 'cres' ? 'Crescendo' : 'Decrescendo')
      + ' from m' + (m.measureIdx + 1) + ' beat ' + formatBeat(m.tstamp)
      + ': navigate to end and press ' + (form === 'cres' ? '<' : '>') + '. (Esc to cancel.)');
    hooks.onStateChange();
    return;
  }
  if (pending.form !== form) {
    /* Different form from the pending mark — abandon the old and start a new. */
    state.pendingHairpin = { start: m, form };
    hooks.setStatus?.('Replaced pending hairpin: now ' + (form === 'cres' ? 'crescendo' : 'decrescendo')
      + ' from m' + (m.measureIdx + 1) + ' beat ' + formatBeat(m.tstamp) + '.');
    hooks.onStateChange();
    return;
  }
  /* Same form: try to close. */
  if (momentCompare(m, pending.start) <= 0) {
    /* End must be strictly after start. */
    state.pendingHairpin = { start: m, form };
    hooks.setStatus?.('End must be after start; re-marked start at m' + (m.measureIdx + 1) + ' beat ' + formatBeat(m.tstamp) + '.');
    hooks.onStateChange();
    return;
  }
  const doc = model.getDoc();
  const created = addHairpin(doc, pending.start, m, { form });
  state.pendingHairpin = null;
  if (created) {
    hooks.setStatus?.((form === 'cres' ? 'Crescendo' : 'Decrescendo') + ' added.');
  } else {
    hooks.setStatus?.('Failed to add hairpin.');
  }
  if (state.cursorMode === 'expr') refreshExprCursor(model);
  hooks.onChange();
  hooks.onStateChange();
}

function cancelPendingHairpin(hooks: InputHooks): boolean {
  if (!state.pendingHairpin) return false;
  state.pendingHairpin = null;
  hooks.setStatus?.('Pending hairpin cancelled.');
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
    hooks.setStatus?.('Deleted dynamic.');
    hooks.onChange();
    hooks.onStateChange();
    return true;
  }
  const hairpins = hairpinsAt(doc, m);
  if (hairpins.length > 0) {
    removeExpression(hairpins[0]);
    refreshExprCursor(model);
    hooks.setStatus?.('Deleted hairpin.');
    hooks.onChange();
    hooks.onStateChange();
    return true;
  }
  hooks.setStatus?.('No expression element at this moment.');
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
    setVoicePreservingTime(model, v);
    hooks.setStatus?.('Voice ' + v + '.');
    return;
  }
  const v = model.getCurrentVoice();
  if (dir === 'up') {
    if (v === 1) return;
    if (v === 2) { model.switchVoice('up'); return; }       /* 2 → 1 */
    if (v === 3) {                                          /* 3 → expr */
      state.cursorMode = 'expr';
      refreshExprCursor(model);
      hooks.setStatus?.('Expression layer.');
      return;
    }
    if (v === 4) { model.switchVoice('up'); return; }       /* 4 → 3 */
  } else {
    if (v === 1) { model.switchVoice('down'); return; }     /* 1 → 2 */
    if (v === 2) {                                          /* 2 → expr */
      state.cursorMode = 'expr';
      refreshExprCursor(model);
      hooks.setStatus?.('Expression layer.');
      return;
    }
    if (v === 3) { model.switchVoice('down'); return; }     /* 3 → 4 */
    if (v === 4) return;
  }
}

/** Switch voice while approximately preserving the time position of the
 *  previous cursor (matches the existing switchVoice helper's contract). */
function setVoicePreservingTime(model: ComposerModel, v: Voice): void {
  const prevVoice = model.getCurrentVoice();
  const prevCursor = model.getCursor(prevVoice);
  const prevTime = model.getTimeAt(prevVoice, prevCursor);
  model.setVoice(v);
  const newCursor = model.findCursorAtOrBefore(v, prevTime);
  model.setCursor(newCursor, v);
}

/* ── main dispatch ───────────────────────────────────────────────────────── */

export function initInput(model: ComposerModel, hooks: InputHooks): () => void {
  function commitDuration(dur: Duration): void {
    state.duration = dur;
    const heldRaw = hooks.getHeldKeys();
    /* Filter notes whose alteration exceeds ±3 — Verovio can't render
       compound accidentals legibly (the extra <accid> glyphs overlap
       without horizontal allocation). The user can re-spell or shift
       the lattice to bring them in range. */
    const held = heldRaw.filter((k) => Math.abs(alterFromCount(k.accid)) <= 3);
    if (heldRaw.length > 0 && held.length === 0) {
      hooks.setStatus?.('All held keys have alteration > ±3; not entered.');
      return;
    }
    if (held.length < heldRaw.length) {
      hooks.setStatus?.('Some held keys had alteration > ±3 and were dropped.');
    }
    if (held.length > 0) {
      const chord: ChordInput = { notes: held, duration: dur };
      if (state.mode === 'overwrite') {
        const id = model.replaceChordAtCursor(chord);
        if (id === null) model.insertChordAtCursor(chord);
        else model.moveCursor('right');
      } else {
        model.insertChordAtCursor(chord);
      }
    } else {
      const rest: RestInput = { duration: dur };
      model.insertRestAtCursor(rest);
    }
    hooks.onStateChange();
    hooks.onChange();
  }

  function handler(e: KeyboardEvent): void {
    if (shouldIgnore(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    /* Hairpin shortcuts (apply in BOTH voice and expression mode). Must come
       before the digit handlers so '<' and '>' aren't swallowed by Shift+,/. */
    if (e.key === '<') {
      e.preventDefault();
      commitHairpinStep(model, hooks, 'cres');
      return;
    }
    if (e.key === '>') {
      e.preventDefault();
      commitHairpinStep(model, hooks, 'dim');
      return;
    }

    /* Voice-mode Shift+digit dynamics: !@#$%^ → pp p mp mf f ff. */
    if (state.cursorMode === 'voice' && SHIFT_DIGIT_TO_DYNAMIC[e.key]) {
      e.preventDefault();
      commitDynamic(model, hooks, SHIFT_DIGIT_TO_DYNAMIC[e.key]);
      return;
    }

    /* Expression-mode bare-digit dynamics: 1-8 → fff ff f mf mp p pp ppp. */
    if (state.cursorMode === 'expr' && DIGIT_TO_DYNAMIC[e.key]) {
      e.preventDefault();
      commitDynamic(model, hooks, DIGIT_TO_DYNAMIC[e.key]);
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
      const r = model.cycleDotsOnCurrent(state.mode);
      if (r === null) hooks.setStatus?.('No note under cursor.');
      hooks.onStateChange();
      hooks.onChange();
      return;
    }
    if (state.cursorMode === 'voice' && e.key === '=') {
      e.preventDefault();
      const r = model.toggleTieOnCurrent(state.mode);
      if (r === null) hooks.setStatus?.('No tieable note under cursor.');
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
        deleteSelectedExpression(model, hooks);
        return;
      }
      if (model.deleteAtCursor()) {
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
        deleteSelectedExpression(model, hooks);
        return;
      }
      const v = model.getCurrentVoice();
      const c = model.getCursor();
      const id = model.getElementIdAt(v, c);
      if (id !== null) {
        model.moveCursor('right');
        if (model.deleteAtCursor()) {
          refreshExprCursor(model);
          hooks.onStateChange();
          hooks.onChange();
        }
      }
      return;
    }

    /* Escape: cancel pending hairpin (works in either mode). */
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

  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}
