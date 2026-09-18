// Pickup / anacrusis modal — Ctrl+Shift+A. A single numeric field: the length
// of the pickup in EIGHTH NOTES (0..just under a full bar) at the start of the
// cursor's section. 0 removes the pickup measure entirely. The displayed time
// signature stays full; the pickup is a dedicated measure 0 with a reduced tick
// budget (model.setPickupAt). Mirrors clefDialog.ts.
//
// The field counted denominator BEATS until 2026-09-17 (Max): that cannot
// express a half-beat anacrusis in 4/4 — the commonest kind — and in 2/2 could
// not express a sub-bar pickup at all, the only beat there being a half note.
// Eighths cover every case beats did and every half-beat one besides, at the
// cost of typing a larger number for the ordinary ones (a quarter-note pickup
// in 4/4 is now 2, not 1).

import type { ComposerModel } from './model/index.js';
import type { HistoryManager } from './history.js';
import { openTextEntryModal, type TextEntryField } from './ui/textEntryModal.js';

export function openPickupModal(
  model: ComposerModel,
  sectionStartIdx: number,
  opts: { history: HistoryManager; onApply: () => void; onError?: (msg: string) => void },
): void {
  const maxEighths = model.maxPickupEighthsAt(sectionStartIdx);
  const cur = model.pickupEighthsForSection(sectionStartIdx);

  const fields: TextEntryField[] = [
    { name: 'eighths', type: 'number', label: 'Pickup eighths', value: String(cur), min: 0, max: maxEighths,
      placeholder: '0–' + maxEighths + ' eighth notes (0 removes)' },
  ];

  openTextEntryModal({
    title: 'Pickup / anacrusis — section start',
    fields,
    focusField: 'eighths',
    onOk: (values) => {
      const eighths = parseInt(String(values.eighths ?? '0'), 10);
      if (!isFinite(eighths) || eighths < 0 || eighths > maxEighths) {
        opts.onError?.('Pickup length must be between 0 and ' + maxEighths + ' eighth notes.');
        return;
      }
      const before = model.snapshotState();
      const changed = model.setPickupAt(sectionStartIdx, eighths);
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
