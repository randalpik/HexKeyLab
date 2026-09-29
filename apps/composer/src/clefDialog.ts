// Clef modal — Ctrl+Shift+C. Inserts/edits/removes an inline <clef> at the
// cursor's clef SLOT (model/clef-slot.ts) for the cursor's staff, on the
// reusable text-entry shell. A single "Clef" select (arrow-key navigable)
// lists the supported clefs incl. octave (treble+8) and the C-clefs
// (alto/tenor); pre-selected with the clef in force at the slot. "Remove clef
// change" is the direct removal path — clefs change ONLY through this dialog
// (Max, 2026-09-27); choosing the inherited clef removes too (diff-aware).
// Over a beat selection the change is bounded to the span: interior clefs go,
// the prior clef is restored after it. Playback is clef-agnostic (coords
// carry pitch), so this is purely notation.

import type { ComposerModel, ClefSpec, ClefOutcome } from './model/index.js';
import type { HistoryManager } from './history.js';
import { openTextEntryModal, type TextEntryField } from './ui/textEntryModal.js';

/** value = "shape|line|dis|disPlace" (dis/disPlace blank for a plain clef). */
const CLEF_OPTIONS = [
  { value: 'G|2||',        label: 'Treble (G)' },
  { value: 'F|4||',        label: 'Bass (F)' },
  { value: 'C|3||',        label: 'Alto (C)' },
  { value: 'C|4||',        label: 'Tenor (C)' },
  { value: 'G|2|8|above',  label: 'Treble 8va (G, +8)' },
  { value: 'G|2|8|below',  label: 'Treble 8vb (G, −8)' },
  { value: 'F|4|8|below',  label: 'Bass 8vb (F, −8)' },
  { value: 'G|1||',        label: 'French violin (G, line 1)' },
];

/** What the dialog did, for the caller's status line. */
export interface ClefApplyResult { kind: 'changed' | 'removed' | 'noop' }

function specOf(value: string): ClefSpec {
  const [shape, line, dis, disPlace] = value.split('|');
  return { shape, line, dis: dis || null, disPlace: disPlace || null };
}

export function openClefModal(
  model: ComposerModel,
  opts: {
    history: HistoryManager;
    onApply: (res: ClefApplyResult) => void;
    onError?: (msg: string) => void;
    /** When set, apply the clef across the beat span (selection-driven, Phase
     *  4a): interior clefs removed, insert at `startCursor`, restore the prior
     *  clef at `endCursor`. */
    range?: { voice: number; startCursor: number; endCursor: number };
  },
): void {
  const v = model.getCurrentVoice();
  const cursor = model.getCursor();
  const r = opts.range;
  const cur = r ? model.clefInEffectAt(r.voice, r.startCursor) : model.clefAtCursor();
  const curValue = `${cur.shape}|${cur.line}|${cur.dis ?? ''}|${cur.disPlace ?? ''}`;
  /* If the effective clef isn't one of the presets, fall through to Treble. */
  const known = CLEF_OPTIONS.some((o) => o.value === curValue);
  const removable = r ? model.rangeHasClefs(r.voice, r.startCursor, r.endCursor) : model.hasClefAt(v, cursor);

  const fields: TextEntryField[] = [
    { name: 'clef', type: 'select', label: 'Clef', value: known ? curValue : 'G|2||', options: CLEF_OPTIONS },
  ];

  const refuse = (reason: 'pastEnd' | 'inTuplet', endpoint: 'start' | 'end' = 'start'): void => {
    if (reason === 'pastEnd') opts.onError?.('Move the cursor onto a measure first.');
    else if (endpoint === 'end') opts.onError?.('Selection ends inside a tuplet — clef change not applied.');
    else opts.onError?.('Clef change not supported inside a tuplet.');
  };
  const isRefusal = (o: ClefOutcome): o is 'pastEnd' | 'inTuplet' => o === 'pastEnd' || o === 'inTuplet';

  /* One commit path: snapshot, mutate, push history only when the document
     changed, report what happened. */
  const commit = (mutate: () => ClefApplyResult | null): void => {
    const before = model.snapshotState();
    const res = mutate();
    if (!res) return;                       // refused; nothing written
    if (res.kind !== 'noop') opts.history.push(before, model.snapshotState(), 'clef');
    opts.onApply(res);
  };

  openTextEntryModal({
    title: r ? 'Clef change (selection)' : 'Clef change (this staff)',
    fields,
    onOk: (values) => {
      const spec = specOf(String(values.clef ?? 'G|2||'));
      commit(() => {
        if (r) {
          const res = model.applyClefRange(r.voice, r.startCursor, r.endCursor, spec);
          if (!res.ok) { refuse(res.reason, res.endpoint); return null; }
          const changed = res.start !== 'noop' || (res.end !== null && res.end !== 'noop');
          return { kind: !changed ? 'noop' : res.start === 'removed' ? 'removed' : 'changed' };
        }
        const o = model.applyClefAt(v, cursor, spec);
        if (isRefusal(o)) { refuse(o); return null; }
        return { kind: o === 'noop' ? 'noop' : o === 'removed' ? 'removed' : 'changed' };
      });
    },
    extraButtons: [{
      label: r ? 'Remove clef changes' : 'Remove clef change',
      action: 'clef-remove',
      disabled: !removable,
      onClick: () => commit(() => {
        if (r) {
          /* Set the span back to what it inherits at its start: every clef
             inside goes, the clef after the span is preserved. */
          const inh = model.clefInheritedAt(r.voice, r.startCursor);
          const res = model.applyClefRange(r.voice, r.startCursor, r.endCursor, inh);
          if (!res.ok) { refuse(res.reason, res.endpoint); return null; }
          return { kind: 'removed' };
        }
        const o = model.removeClefAt(v, cursor);
        if (isRefusal(o)) { refuse(o); return null; }
        return { kind: o === 'noop' ? 'noop' : 'removed' };
      }),
    }],
  });
}
