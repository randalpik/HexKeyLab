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
// Tuplet creation (voice mode):
//   Ctrl+2..7  = begin tuplet creation. Status line prompts for span
//                duration. The next digit (1..7) press resolves the tuplet:
//                  Ctrl+2,d = duplet (2:3)    in space of dotted-d
//                  Ctrl+3,d = triplet (3:2)   in space of d
//                  Ctrl+4,d = quadruplet (4:6) in space of dotted-d
//                  Ctrl+5,d = quintuplet (5:4) in space of d
//                  Ctrl+6,d = sextuplet (6:4)  in space of d
//                  Ctrl+7,d = septuplet (7:8)  in space of d
//                Atomic written duration = d divided by 2 / 4 / 8 ranks
//                respectively. Span exceeding remaining measure → rejected.
//   Escape     = cancel a pending tuplet (between Ctrl+N and the digit).
//   Inside a tuplet: duration digits fill atomic slots; durations exceeding
//                the remaining tuplet space reject with a status message.
//                Filling the tuplet completely advances the cursor past it.
//   Backspace  inside a tuplet nibbles one filled slot at a time, regrowing
//                a trailing placeholder; a final Backspace on the empty-
//                tuplet fill-anchor removes the <tuplet> element entirely.
//   Beaming inside a tuplet is computed automatically at serialize time:
//                consecutive beam-eligible children (dur ≥ 8, not rests)
//                get a <beam> wrapper.
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
  ComposerModel, Duration, Dots, ChordInput, RestInput, Voice,
} from './model.js';
import { ticksOf } from './model.js';
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

interface PendingTuplet {
  num: number;       /* tuplet ratio numerator (e.g. 3 for triplet) */
  numbase: number;   /* tuplet ratio denominator */
  dotted: boolean;   /* whether the span duration is dotted (N=2,4) */
  atomicK: number;   /* atomic = span-duration divided by K ranks (2/4/8) */
}

export interface InputState {
  duration: Duration;
  mode: EntryMode;
  cursorMode: CursorMode;
  exprCursor: ExpressionCursor;
  pendingHairpin: PendingHairpin | null;
  pendingTuplet: PendingTuplet | null;
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
  setStatus?: (msg: string) => void;
  /** True while score playback is running. While true, cursor/voice
   *  navigation (arrow keys) is suppressed so the user can't fight the
   *  playback cursors. Other keys (digits, backspace) still work. */
  isPlaybackActive: () => boolean;
  /** Step the renderer zoom one preset in the given direction. The owner
   *  (main.ts) decides the actual preset list and reRenders. */
  onZoomChange?: (dir: 'in' | 'out') => void;
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

    /* Pre-flight insertability check: surfaces specific rejection reasons
       (in-tuplet overflow or bar-line displacement) before we attempt the
       insert. The model's insert methods still defensively reject on
       overflow, but those paths surface only a generic "Doesn't fit." */
    {
      const can = model.canInsertHere(dur, 0);
      if (!can.ok) {
        hooks.setStatus?.(can.reason);
        return;
      }
    }

    if (held.length > 0) {
      const chord: ChordInput = { notes: held, duration: dur };
      if (state.mode === 'overwrite') {
        const id = model.replaceChordAtCursor(chord);
        if (id === null) {
          if (model.insertChordAtCursor(chord) === null) {
            hooks.setStatus?.("Doesn't fit.");
            return;
          }
        } else {
          model.moveCursor('right');
        }
      } else {
        if (model.insertChordAtCursor(chord) === null) {
          hooks.setStatus?.("Doesn't fit.");
          return;
        }
      }
    } else {
      const rest: RestInput = { duration: dur };
      if (model.insertRestAtCursor(rest) === null) {
        hooks.setStatus?.("Doesn't fit.");
        return;
      }
    }
    hooks.onStateChange();
    hooks.onChange();
  }

  function commitPendingTuplet(durKey: string): void {
    const pending = state.pendingTuplet;
    if (!pending) return;
    const dur = DIGIT_TO_DUR[durKey];
    state.pendingTuplet = null;
    if (!dur) {
      hooks.setStatus?.('Tuplet span: invalid digit.');
      hooks.onStateChange();
      return;
    }
    const dDenom = parseInt(dur, 10);
    const atomicDenom = dDenom * pending.atomicK;
    if (!ATOMIC_DENOM_VALID.has(atomicDenom)) {
      hooks.setStatus?.('Tuplet atomic duration too small to represent.');
      hooks.onStateChange();
      return;
    }
    const atomicDur = String(atomicDenom) as Duration;
    const spanDots: Dots = pending.dotted ? 1 : 0;
    const r = model.createTupletAtCursor({
      num: pending.num, numbase: pending.numbase,
      spanDur: dur, spanDots, atomicDur,
    });
    if (!r.ok) {
      hooks.setStatus?.(r.reason);
    } else {
      hooks.setStatus?.('Tuplet ' + pending.num + ':' + pending.numbase + ' added.');
    }
    hooks.onStateChange();
    hooks.onChange();
  }

  function handler(e: KeyboardEvent): void {
    if (shouldIgnore(e)) return;

    /* Ctrl+2..7 begins tuplet creation. Must come BEFORE the bail-on-modifier
       check below. preventDefault is critical: in Firefox/Chromium, Ctrl+1..8
       is the tab-nav shortcut, but the browser respects preventDefault on
       keydown for these. */
    if (e.ctrlKey && !e.metaKey && !e.altKey && /^[2-7]$/.test(e.key)) {
      e.preventDefault();
      if (state.cursorMode !== 'voice') {
        hooks.setStatus?.('Tuplet creation requires voice mode.');
        return;
      }
      if (hooks.isPlaybackActive()) return;
      if (model.isCursorInTuplet()) {
        hooks.setStatus?.('Cannot nest tuplets.');
        return;
      }
      const n = parseInt(e.key, 10);
      const cfg = TUPLET_CFG[n];
      state.pendingTuplet = { num: n, numbase: cfg.numbase, dotted: cfg.dotted, atomicK: cfg.atomicK };
      hooks.setStatus?.('Tuplet ' + n + ':' + cfg.numbase + ' — press duration digit for span.');
      hooks.onStateChange();
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
      hooks.setStatus?.('Tuplet cancelled.');
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

  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}
