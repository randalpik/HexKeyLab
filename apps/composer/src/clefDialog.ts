// Clef modal — Ctrl+Shift+C. Inserts/edits a mid-measure inline <clef> for the
// cursor's staff, on the reusable text-entry shell. A single "Clef" select
// (arrow-key navigable) lists the supported clefs incl. octave (treble+8) and
// the C-clefs (alto/tenor). Playback is clef-agnostic (coords carry pitch), so
// this is purely notation — model.setClefAt writes a zero-duration <clef>.

import type { ComposerModel } from './model/index.js';
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

export function openClefModal(
  model: ComposerModel,
  opts: { history: HistoryManager; onApply: () => void; onError?: (msg: string) => void },
): void {
  const cur = model.clefAtCursor();
  const curValue = `${cur.shape}|${cur.line}|${cur.dis ?? ''}|${cur.disPlace ?? ''}`;
  /* If the effective clef isn't one of the presets, fall through to Treble. */
  const known = CLEF_OPTIONS.some((o) => o.value === curValue);

  const fields: TextEntryField[] = [
    { name: 'clef', type: 'select', label: 'Clef', value: known ? curValue : 'G|2||', options: CLEF_OPTIONS },
  ];

  openTextEntryModal({
    title: 'Clef change (this staff)',
    fields,
    onOk: (values) => {
      const [shape, line, dis, disPlace] = String(values.clef ?? 'G|2||').split('|');
      const before = model.snapshotState();
      const ok = model.setClefAt(shape, line, dis || null, disPlace || null);
      if (!ok) {
        opts.onError?.('Clef change not supported inside a tuplet.');
        return;
      }
      opts.history.push(before, model.snapshotState(), 'clef');
      opts.onApply();
    },
  });
}
