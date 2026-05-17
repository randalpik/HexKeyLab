// Keyboard input handler. Finale-style step entry:
//
//   1-7        = duration (Finale convention: 1=64th, 2=32nd, 3=16th, 4=8th,
//                5=quarter, 6=half, 7=whole).
//                If keys are currently held in HKL, commits a chord;
//                otherwise commits a rest.
//   . (period) = cycle dots (0→1→2→0) on the current note/chord/rest.
//                In insert mode: targets the just-entered element (cursor-1).
//                In overwrite mode: targets the selected element (cursor).
//                Auto-ties across the bar if adding the dot overflows.
//   = (equal)  = toggle tie on the current note/chord. Attaches per-pitch
//                to the next element when pitches match; stub otherwise.
//   ArrowUp/Down   = previous/next voice
//   ArrowLeft/Right = move cursor in current voice
//   Backspace  = delete element at/before cursor
//   Insert     = toggle insert / overwrite mode
//   Home / End = jump to start / end of current voice
//
// Mouse-to-document input is intentionally out of scope per the v1 spec.

import type { ResolvedNote } from '../bridge/protocol.js';
import type {
  ComposerModel, Duration, ChordInput, RestInput,
} from './model.js';

export type EntryMode = 'insert' | 'overwrite';

export interface InputState {
  duration: Duration;
  mode: EntryMode;
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

const state: InputState = {
  duration: '4',
  mode: 'insert',
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

export function initInput(model: ComposerModel, hooks: InputHooks): () => void {
  function commitDuration(dur: Duration): void {
    state.duration = dur;
    const held = hooks.getHeldKeys();
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

    /* Durations. */
    if (DIGIT_TO_DUR[e.key]) {
      e.preventDefault();
      commitDuration(DIGIT_TO_DUR[e.key]);
      return;
    }

    /* Cycle dots on the current element. */
    if (e.key === '.') {
      e.preventDefault();
      const r = model.cycleDotsOnCurrent(state.mode);
      if (r === null) hooks.setStatus?.('No note under cursor.');
      hooks.onStateChange();
      hooks.onChange();
      return;
    }

    /* Toggle tie on the current note/chord. */
    if (e.key === '=') {
      e.preventDefault();
      const r = model.toggleTieOnCurrent(state.mode);
      if (r === null) hooks.setStatus?.('No tieable note under cursor.');
      hooks.onChange();
      return;
    }

    /* Voice / cursor navigation. Suppressed during playback. */
    const navKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (navKeys.indexOf(e.key) >= 0) {
      if (hooks.isPlaybackActive()) { e.preventDefault(); return; }
      if (e.key === 'ArrowUp')    { e.preventDefault(); model.switchVoice('up');   hooks.onStateChange(); hooks.onChange(); return; }
      if (e.key === 'ArrowDown')  { e.preventDefault(); model.switchVoice('down'); hooks.onStateChange(); hooks.onChange(); return; }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); model.moveCursor('left');  hooks.onStateChange(); hooks.onChange(); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); model.moveCursor('right'); hooks.onStateChange(); hooks.onChange(); return; }
      if (e.key === 'Home')       { e.preventDefault(); model.setCursor(0); hooks.onStateChange(); hooks.onChange(); return; }
      if (e.key === 'End')        { e.preventDefault(); model.cursorToEnd(); hooks.onStateChange(); hooks.onChange(); return; }
    }

    /* Deletion. */
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (model.deleteAtCursor()) {
        hooks.onStateChange();
        hooks.onChange();
      }
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      const v = model.getCurrentVoice();
      const c = model.getCursor();
      const id = model.getElementIdAt(v, c);
      if (id !== null) {
        model.moveCursor('right');
        if (model.deleteAtCursor()) {
          hooks.onStateChange();
          hooks.onChange();
        }
      }
      return;
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
