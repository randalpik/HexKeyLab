// Keyboard input handler. Finale-style step entry:
//
//   1-7        = duration (Finale convention: 1=64th, 2=32nd, 3=16th, 4=8th,
//                5=quarter, 6=half, 7=whole).
//                If keys are currently held in HKL, commits a chord;
//                otherwise commits a rest.
//   . (period) = toggle dot on next entry
//   ArrowUp/Down   = previous/next voice
//   ArrowLeft/Right = move cursor in current voice
//   Backspace  = delete element at/before cursor
//   Insert     = toggle insert / overwrite mode
//   Home / End = jump to start / end of current voice
//
// Mouse-to-document input is intentionally out of scope per the v1 spec.

import type { ResolvedNote } from '../bridge/protocol.js';
import type {
  ComposerModel, Duration, Dots, ChordInput, RestInput,
} from './model.js';

export type EntryMode = 'insert' | 'overwrite';

export interface InputState {
  duration: Duration;
  dots: Dots;
  mode: EntryMode;
}

export interface InputHooks {
  getHeldKeys: () => ReadonlyArray<ResolvedNote>;
  playChord: (notes: ReadonlyArray<ResolvedNote>, durationMs: number) => void;
  onChange: () => void;
  onStateChange: () => void;
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
  dots: 0,
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

/* Approximate ms-per-whole-note at 120 BPM (a quarter = 500ms → whole = 2000ms).
   Only used for the playback-monitor chord on entry, not for score timing. */
const MS_PER_WHOLE = 2000;
function durationToMs(dur: Duration, dots: Dots): number {
  const base = MS_PER_WHOLE / parseInt(dur, 10);
  if (dots === 1) return base * 1.5;
  if (dots === 2) return base * 1.75;
  return base;
}

export function initInput(model: ComposerModel, hooks: InputHooks): () => void {
  function commitDuration(dur: Duration): void {
    state.duration = dur;
    const held = hooks.getHeldKeys();
    if (held.length > 0) {
      const chord: ChordInput = { notes: held, duration: dur, dots: state.dots };
      if (state.mode === 'overwrite') {
        const id = model.replaceChordAtCursor(chord);
        if (id === null) model.insertChordAtCursor(chord);
        else /* replace doesn't advance cursor */ model.moveCursor('right');
      } else {
        model.insertChordAtCursor(chord);
      }
      /* Audible confirmation via HKL. */
      hooks.playChord(held, durationToMs(dur, state.dots));
    } else {
      const rest: RestInput = { duration: dur, dots: state.dots };
      if (state.mode === 'overwrite') {
        /* No chord-replace-with-rest API yet; just insert. v2 concern. */
        model.insertRestAtCursor(rest);
      } else {
        model.insertRestAtCursor(rest);
      }
    }
    /* Dots are a one-shot modifier; reset after use. */
    state.dots = 0;
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

    /* Dot toggle. */
    if (e.key === '.') {
      e.preventDefault();
      state.dots = (state.dots === 0 ? 1 : (state.dots === 1 ? 2 : 0));
      hooks.onStateChange();
      return;
    }

    /* Voice / cursor navigation. Suppressed during playback so the user
       doesn't fight the per-voice playback cursors. */
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
      /* Delete the element immediately to the right of the cursor. */
      const v = model.getCurrentVoice();
      const c = model.getCursor();
      const id = model.getElementIdAt(v, c);
      if (id !== null) {
        /* Move cursor right then deleteAtCursor (which removes the now-left
           element — i.e. what was at the original cursor). */
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
      return;
    }
  }

  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}
