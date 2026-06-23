/* Undo/redo manager for HKL Composer.
 *
 * Snapshot-based, full-state: each entry captures a complete MEI string +
 * cursor quad + active voice for both BEFORE and AFTER one logical user
 * action. Restoring is a single document swap via ComposerModel.restoreSnapshot.
 *
 * Action grouping:
 *   - Atomic mutations push one entry.
 *   - Tuplet/hairpin pending state isn't a mutation — the entry is pushed
 *     only at the commit keystroke, which is naturally one entry.
 *   - Cut → paste merge: if the next push after a `mergeable` cut entry is a
 *     paste with mergeIfTopMergeable, the two are merged into a single
 *     `cut+paste` entry (before = cut.before, after = paste.after,
 *     sourceSelection = cut.sourceSelection). Intervening cursor moves /
 *     voice switches do NOT push, so they don't break the merge. Any other
 *     mutation between cut and paste finalizes the cut as standalone.
 *
 * Cursor-position-match rule (per user spec): when undoing/redoing, only
 * restore the cursor/voice from the snapshot if the user's current focus
 * point (active voice + that voice's cursor) matches the snapshot's "other
 * side." Otherwise we leave focus where the user moved it (model.restoreSnapshot
 * clamps cursors into the restored MEI's valid range).
 *
 * Source-selection restoration: cut/paste entries optionally carry a
 * `sourceSelection`. On UNDO of such an entry, selection mode is re-entered
 * with that selection. On REDO, selection is cleared (committed cut/paste
 * leaves the user in voice mode).
 */

import type { ComposerModel, Voice } from './model/index.js';
import type { SelectionState } from './selection/selection.js';

export interface Snapshot {
  mei: string;
  voice: Voice;
  cursors: Record<Voice, number>;
}

export interface UndoEntry {
  before: Snapshot;
  after: Snapshot;
  label: string;
  sourceSelection?: SelectionState;
  mergeable?: boolean;
}

export interface PushOpts {
  sourceSelection?: SelectionState;
  /** Mark this entry as mergeable. The next push with mergeIfTopMergeable
   *  will fold into this one rather than push a separate entry. */
  mergeable?: boolean;
  /** If the top of the undo stack is mergeable, merge this push into it. */
  mergeIfTopMergeable?: boolean;
}

/** Side-effects an undo/redo applies to the input layer alongside the model
 *  swap. The HistoryManager is decoupled from input.ts internals; callers
 *  pass in a minimal effects object so the manager can drive selection
 *  restoration without importing the InputState type circularly. */
export interface UndoEffects {
  setSelection(sel: SelectionState | null): void;
  setCursorMode(mode: 'voice' | 'expr' | 'select'): void;
}

const DEFAULT_CAP = 1000;

function focusEquals(curVoice: Voice, curCursors: Record<Voice, number>, snap: Snapshot): boolean {
  return curVoice === snap.voice && curCursors[curVoice] === snap.cursors[curVoice];
}

function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.mei !== b.mei) return false;
  if (a.voice !== b.voice) return false;
  const keys = new Set([...Object.keys(a.cursors), ...Object.keys(b.cursors)]);
  for (const k of keys) {
    const v = Number(k) as Voice;
    if (a.cursors[v] !== b.cursors[v]) return false;
  }
  return true;
}

export class HistoryManager {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private cap: number;
  /** The most recently committed state's MEI — the AFTER of the last push, or
   *  the side restored by the last undo/redo. Equals the live doc between
   *  committed edits, so `withHistory` reuses it as the next edit's BEFORE-MEI
   *  to serialize once per edit instead of twice (Phase B3). null = unknown
   *  (after clear / before the first push) → caller serializes fresh. */
  private lastMei: string | null = null;

  constructor(cap = DEFAULT_CAP) {
    this.cap = cap;
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  /** The last committed state's MEI (see `lastMei`), or null if unknown. */
  committedMei(): string | null { return this.lastMei; }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastMei = null;
  }

  /** Push a new entry, OR merge into the top entry if it is `mergeable` and
   *  the caller requested `mergeIfTopMergeable`. Any successful push (not a
   *  merge) clears the redo stack. No-op if before/after are identical
   *  (caller's mutation produced no observable change). */
  push(before: Snapshot, after: Snapshot, label: string, opts: PushOpts = {}): void {
    if (snapshotsEqual(before, after)) return;
    /* The doc now reflects `after` — record it so the next edit's BEFORE-MEI is
       free (see lastMei). Set unconditionally (covers both push + merge). */
    this.lastMei = after.mei;

    if (opts.mergeIfTopMergeable && this.undoStack.length > 0) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (top.mergeable) {
        /* Fold this push into the previous entry. The merged entry keeps
         * the cut's before-state and the cut's sourceSelection (so undoing
         * still restores the source selection at the original cut site). */
        const merged: UndoEntry = {
          before: top.before,
          after,
          label: top.label + '+' + label,
          sourceSelection: top.sourceSelection,
        };
        this.undoStack[this.undoStack.length - 1] = merged;
        this.redoStack = [];
        return;
      }
    }

    const entry: UndoEntry = { before, after, label };
    if (opts.sourceSelection !== undefined) entry.sourceSelection = opts.sourceSelection;
    if (opts.mergeable) entry.mergeable = true;

    this.undoStack.push(entry);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Restore the BEFORE side of the top entry. The model's cursor/voice
   *  restoration is conditional on the user's current focus matching the
   *  entry's AFTER focus. Returns the entry consumed (for status messages /
   *  testing). */
  undo(model: ComposerModel, effects: UndoEffects): UndoEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);

    const curVoice = model.getCurrentVoice();
    const curCursors = this.snapshotCursors(model);
    const focusMatches = focusEquals(curVoice, curCursors, entry.after);

    /* Always restore MEI. Conditionally restore cursors/voice. */
    if (focusMatches) {
      model.restoreSnapshot(entry.before);
    } else {
      model.restoreSnapshotMeiOnly(entry.before, curVoice, curCursors);
    }
    this.lastMei = entry.before.mei;   // doc now reflects the BEFORE state

    /* Selection: re-enter source selection if recorded, else clear. */
    if (entry.sourceSelection) {
      effects.setSelection(entry.sourceSelection);
      effects.setCursorMode('select');
    } else {
      effects.setSelection(null);
      effects.setCursorMode('voice');
    }

    return entry;
  }

  /** Restore the AFTER side of the top entry of the redo stack. */
  redo(model: ComposerModel, effects: UndoEffects): UndoEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);

    const curVoice = model.getCurrentVoice();
    const curCursors = this.snapshotCursors(model);
    const focusMatches = focusEquals(curVoice, curCursors, entry.before);

    if (focusMatches) {
      model.restoreSnapshot(entry.after);
    } else {
      model.restoreSnapshotMeiOnly(entry.after, curVoice, curCursors);
    }
    this.lastMei = entry.after.mei;   // doc now reflects the AFTER state

    /* Redo always lands in voice mode — committed cut/paste exits selection. */
    effects.setSelection(null);
    effects.setCursorMode('voice');
    return entry;
  }

  private snapshotCursors(model: ComposerModel): Record<Voice, number> {
    const out: Record<Voice, number> = {};
    for (let v = 1; v <= model.totalVoices(); v++) out[v] = model.getCursor(v);
    return out;
  }
}
