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
  /** Full MEI. For a keystroke edit's AFTER this is a LAZY getter (A10): the
   *  model serialises on idle, or synchronously before anything that could
   *  change the document. Reading it always yields the right string. */
  mei: string;
  voice: Voice;
  cursors: Record<Voice, number>;
  /** Exact document version at capture (`model.docVersion()`, driven by the
   *  MutationObserver drain). Equal versions = identical document, which lets
   *  `push` detect a no-op edit without touching `mei`. Absent on snapshots
   *  taken by the dialog paths, which stay eager. */
  docVer?: number;
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

function cursorsEqual(a: Record<Voice, number>, b: Record<Voice, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const v = Number(k) as Voice;
    if (a[v] !== b[v]) return false;
  }
  return true;
}

function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.mei !== b.mei) return false;
  if (a.voice !== b.voice) return false;
  return cursorsEqual(a.cursors, b.cursors);
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
  private lastCommitted: Snapshot | null = null;
  /** A lazily-pushed entry whose no-op check is still owed (A10). `push` cannot
   *  compare MEI strings without forcing the lazy AFTER, so when the document
   *  versions differ it pushes optimistically and settles the comparison here,
   *  the first time anything looks at the stacks. Always the top of the undo
   *  stack: every push / undo / redo resolves before touching them. */
  private pending: { entry: UndoEntry; check: Snapshot; savedRedo: UndoEntry[] } | null = null;

  constructor(cap = DEFAULT_CAP) {
    this.cap = cap;
  }

  canUndo(): boolean { this.resolvePending(); return this.undoStack.length > 0; }
  canRedo(): boolean { this.resolvePending(); return this.redoStack.length > 0; }

  /** The last committed state's MEI (see `lastCommitted`), or null if unknown.
   *  Reading it materialises a lazy AFTER — which is exactly when the next edit
   *  needs it: as its BEFORE, before it mutates anything. */
  committedMei(): string | null { return this.lastCommitted ? this.lastCommitted.mei : null; }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastCommitted = null;
    this.pending = null;
  }

  /** Settle a lazily-pushed entry (A10): reading `after.mei` materialises the
   *  snapshot (the model asserts, under HKL_INDEX_CHECK, that the document has
   *  not moved since); if it equals the BEFORE the edit changed nothing
   *  observable — an attribute rewritten to its own value bumps the version
   *  without changing the document — and the entry is retracted exactly as the
   *  eager check used to skip it, restoring the redo stack it cleared. */
  private resolvePending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (p.entry.after.mei !== p.check.mei) return;
    if (this.undoStack[this.undoStack.length - 1] === p.entry) {
      this.undoStack.pop();
      this.redoStack = p.savedRedo;
    }
    /* lastCommitted: BEFORE and AFTER are the same document; leave it. */
  }

  /** Push a new entry, OR merge into the top entry if it is `mergeable` and
   *  the caller requested `mergeIfTopMergeable`. Any successful push (not a
   *  merge) clears the redo stack. No-op if before/after are identical
   *  (caller's mutation produced no observable change). */
  push(before: Snapshot, after: Snapshot, label: string, opts: PushOpts = {}): void {
    this.resolvePending();
    /* No-op detection. Versioned snapshots (A10): equal versions mean the
       MutationObserver saw nothing — identical document, nothing pushed and
       nothing serialised. Different versions do not PROVE a change, so the
       string comparison is deferred to resolvePending, after the AFTER has
       materialised on idle (or at the next history operation), and a no-op
       entry is retracted then. Unversioned snapshots keep the eager compare. */
    const versioned = before.docVer !== undefined && after.docVer !== undefined;
    if (versioned) {
      if (before.docVer === after.docVer && before.voice === after.voice
          && cursorsEqual(before.cursors, after.cursors)) return;
    } else if (snapshotsEqual(before, after)) return;
    /* The doc now reflects `after` — record it so the next edit's BEFORE-MEI is
       free (see lastCommitted). Set unconditionally (covers both push + merge). */
    this.lastCommitted = after;

    if (opts.mergeIfTopMergeable && this.undoStack.length > 0) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (top.mergeable) {
        /* A merge is a paste after a cut — not a keystroke path. Settle the
           no-op question eagerly (this forces a lazy AFTER) so the merged entry
           needs no deferred retraction. */
        if (versioned && snapshotsEqual(before, after)) return;
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

    const savedRedo = this.redoStack;
    this.undoStack.push(entry);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
    this.redoStack = [];
    if (versioned) this.pending = { entry, check: before, savedRedo };
  }

  /** Restore the BEFORE side of the top entry. The model's cursor/voice
   *  restoration is conditional on the user's current focus matching the
   *  entry's AFTER focus. Returns the entry consumed (for status messages /
   *  testing). */
  undo(model: ComposerModel, effects: UndoEffects): UndoEntry | null {
    this.resolvePending();   // materialises the top entry's AFTER while the doc still IS that state
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
    this.lastCommitted = entry.before;   // doc now reflects the BEFORE state

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
    this.resolvePending();
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
    this.lastCommitted = entry.after;   // doc now reflects the AFTER state

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
