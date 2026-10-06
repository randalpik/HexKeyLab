// Arbitrary tuplet modal — Ctrl+Shift+3. Three fields: the COUNT of notes, the
// SPAN they occupy in EIGHTH NOTES (the pickup modal's unit), and the WRITTEN
// value each note takes — a select of every ratio that span admits, with the
// conventional one pre-selected (model/tuplet-ops.ts `defaultTupletRatio`).
// The Ctrl+N table stops at 7 and fixes one ratio per N; this path has no cap
// and keeps every valid ratio reachable (7:4 as well as 7:8, 4:6 as well as
// 4:3). The count and span alone decide the tuplet in the common case — type
// count, Tab, span, Enter. Mirrors pickupDialog.ts: the shell collects values,
// this module owns model mutation + history.

import type { ComposerModel, Duration } from './model/index.js';
import { ticksOf } from './model/index.js';
import type { HistoryManager } from './history.js';
import { openTextEntryModal, type TextEntryField } from './ui/textEntryModal.js';
import {
  tupletRatioOptions,
  defaultTupletRatio,
  tupletFitsExactly,
  tupletFreeTicksAtCursor,
  type TupletRatioOption,
} from './model/tuplet-ops.js';

const EIGHTH_TICKS = 8;

const WRITTEN_LABEL: Record<Duration, string> = {
  '1': 'whole notes', '2': 'half notes', '4': 'quarter notes', '8': 'eighth notes',
  '16': '16th notes', '32': '32nd notes', '64': '64th notes',
};

function optionLabel(count: number, o: TupletRatioOption): string {
  return count + ':' + o.numbase + ' — ' + WRITTEN_LABEL[o.atomicDur];
}

function eighthsLabel(n: number): string {
  return n + ' eighth note' + (n === 1 ? '' : 's');
}

export function openTupletModal(
  model: ComposerModel,
  opts: {
    history: HistoryManager;
    /** The current entry duration; seeds the span field (in eighths, ≥ 1). */
    defaultSpanDur: Duration;
    onApply: (num: number, numbase: number) => void;
    onError?: (msg: string) => void;
  },
): void {
  const maxEighths = Math.floor(tupletFreeTicksAtCursor(model) / EIGHTH_TICKS);
  if (maxEighths < 1) {
    opts.onError?.('No room for a tuplet at the cursor.');
    return;
  }
  const seedEighths = Math.min(maxEighths,
    Math.max(1, Math.round(ticksOf(opts.defaultSpanDur, 0) / EIGHTH_TICKS)));

  const fields: TextEntryField[] = [
    { name: 'count', type: 'number', label: 'Notes in tuplet', value: '', min: 2, placeholder: '2 or more' },
    { name: 'eighths', type: 'number', label: 'Span (eighth notes)', value: String(seedEighths), min: 1, max: maxEighths,
      placeholder: '1–' + maxEighths + ' eighth notes' },
    { name: 'written', type: 'select', label: 'Written as', options: [{ value: '', label: '—' }] },
  ];

  const parseFields = (values: Record<string, string | boolean>): { count: number; eighths: number } => ({
    count: parseInt(String(values.count ?? ''), 10),
    eighths: parseInt(String(values.eighths ?? ''), 10),
  });

  openTextEntryModal({
    title: 'Tuplet — any count',
    fields,
    focusField: 'count',
    /* Rebuild the written-value list whenever count or span changes, and
       re-select the conventional default; a change to the select itself is the
       user's pick and is left alone. */
    onChange: (values, changed, api) => {
      if (changed === 'written') return;
      const { count, eighths } = parseFields(values);
      if (!Number.isInteger(count) || count < 2 || !Number.isInteger(eighths) || eighths < 1) {
        api.setOptions('written', [{ value: '', label: '—' }], '');
        return;
      }
      const spanTicks = eighths * EIGHTH_TICKS;
      if (tupletFitsExactly(count, spanTicks)) {
        api.setOptions('written',
          [{ value: '', label: count + ' notes fill ' + eighthsLabel(eighths) + ' exactly — no tuplet needed' }], '');
        return;
      }
      const options = tupletRatioOptions(count, spanTicks);
      const def = defaultTupletRatio(count, options);
      api.setOptions('written',
        options.map((o) => ({ value: o.atomicDur, label: optionLabel(count, o) })),
        def?.atomicDur ?? '');
    },
    onOk: (values) => {
      const { count, eighths } = parseFields(values);
      if (!Number.isInteger(count) || count < 2) {
        opts.onError?.('Tuplet count must be a whole number, 2 or more.');
        return;
      }
      if (!Number.isInteger(eighths) || eighths < 1) {
        opts.onError?.('Tuplet span must be a whole number of eighth notes, 1 or more.');
        return;
      }
      const spanTicks = eighths * EIGHTH_TICKS;
      if (tupletFitsExactly(count, spanTicks)) {
        opts.onError?.(count + ' notes fill ' + eighthsLabel(eighths) + ' exactly — no tuplet needed.');
        return;
      }
      const options = tupletRatioOptions(count, spanTicks);
      const picked = options.find((o) => o.atomicDur === values.written) ?? defaultTupletRatio(count, options);
      if (!picked) {
        opts.onError?.('No written value can express that tuplet.');
        return;
      }
      const before = model.snapshotState();
      const r = model.createTupletAtCursor({ num: count, numbase: picked.numbase, atomicDur: picked.atomicDur });
      if (!r.ok) {
        opts.onError?.(r.reason);
        return;
      }
      opts.history.push(before, model.snapshotState(), 'tuplet');
      opts.onApply(count, picked.numbase);
    },
  });
}
