// Pickup / anacrusis modal — Ctrl+Shift+A. A single numeric field: the number
// of pickup beats (0..beatsPerMeasure-1) at the start of the cursor's section.
// 0 removes the pickup measure entirely. The displayed time signature stays
// full; the pickup is a dedicated measure 0 with a reduced tick budget
// (model.setPickupAt). Mirrors clefDialog.ts.

import type { ComposerModel } from './model/index.js';
import type { HistoryManager } from './history.js';
import { openTextEntryModal, type TextEntryField } from './ui/textEntryModal.js';

export function openPickupModal(
  model: ComposerModel,
  sectionStartIdx: number,
  opts: { history: HistoryManager; onApply: () => void; onError?: (msg: string) => void },
): void {
  const { count } = model.meterAt(sectionStartIdx);
  const maxBeats = Math.max(0, count - 1);
  const cur = model.pickupBeatsForSection(sectionStartIdx);

  const fields: TextEntryField[] = [
    { name: 'beats', type: 'number', label: 'Pickup beats', value: String(cur), min: 0, max: maxBeats,
      placeholder: '0–' + maxBeats + ' (0 removes)' },
  ];

  openTextEntryModal({
    title: 'Pickup / anacrusis — section start',
    fields,
    focusField: 'beats',
    onOk: (values) => {
      const beats = parseInt(String(values.beats ?? '0'), 10);
      if (!isFinite(beats) || beats < 0 || beats > maxBeats) {
        opts.onError?.('Pickup beats must be between 0 and ' + maxBeats + '.');
        return;
      }
      const before = model.snapshotState();
      const changed = model.setPickupAt(sectionStartIdx, beats);
      if (!changed) {
        /* No-op (e.g. removing a pickup that isn't there) — don't push history. */
        opts.onApply();
        return;
      }
      opts.history.push(before, model.snapshotState(), 'pickup');
      opts.onApply();
    },
  });
}
