// Time / Key signature modal — Ctrl+Shift+S. Opens the reusable text-entry
// shell anchored to a measure. Reuses setupDialog's KEY_OPTIONS table.
//
// The modal writes the signature effective FROM the anchored measure forward
// (Phase 4.2): measure 0 updates the score-head <scoreDef>; a later measure
// gets an in-section <scoreDef> override, so notes before it keep the prior
// signature. setMeterAt/setKeySigAt encapsulate the placement.

import type { ComposerModel } from './model/index.js';
import type { HistoryManager } from './history.js';
import { openTextEntryModal, type TextEntryField } from './ui/textEntryModal.js';

interface KeyOption { sig: string; major: string; minor: string }

/** Key-signature labels. The sig identifier (`'0'`, `'1s'`, …) is shared by a
 *  major key and its relative minor. */
const KEY_OPTIONS: ReadonlyArray<KeyOption> = [
  { sig: '7f', major: 'C♭ major (7♭)',  minor: 'a♭ minor (7♭)' },
  { sig: '6f', major: 'G♭ major (6♭)',  minor: 'e♭ minor (6♭)' },
  { sig: '5f', major: 'D♭ major (5♭)',  minor: 'b♭ minor (5♭)' },
  { sig: '4f', major: 'A♭ major (4♭)',  minor: 'f minor (4♭)'  },
  { sig: '3f', major: 'E♭ major (3♭)',  minor: 'c minor (3♭)'  },
  { sig: '2f', major: 'B♭ major (2♭)',  minor: 'g minor (2♭)'  },
  { sig: '1f', major: 'F major (1♭)',   minor: 'd minor (1♭)'  },
  { sig: '0',  major: 'C major',        minor: 'a minor'        },
  { sig: '1s', major: 'G major (1♯)',   minor: 'e minor (1♯)'  },
  { sig: '2s', major: 'D major (2♯)',   minor: 'b minor (2♯)'  },
  { sig: '3s', major: 'A major (3♯)',   minor: 'f♯ minor (3♯)' },
  { sig: '4s', major: 'E major (4♯)',   minor: 'c♯ minor (4♯)' },
  { sig: '5s', major: 'B major (5♯)',   minor: 'g♯ minor (5♯)' },
  { sig: '6s', major: 'F♯ major (6♯)',  minor: 'd♯ minor (6♯)' },
  { sig: '7s', major: 'C♯ major (7♯)',  minor: 'a♯ minor (7♯)' },
];

const TIME_NUM_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const TIME_DEN_OPTIONS = [1, 2, 4, 8, 16];

/** One flat "Key" select combining major + relative-minor (the shell's static
 *  fields can't live-relabel on a mode checkbox the way Setup does). Value is
 *  `"<sig>|<mode>"`, e.g. `"3s|minor"`. */
function combinedKeyOptions(): ReadonlyArray<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  for (const k of KEY_OPTIONS) out.push({ value: k.sig + '|major', label: k.major });
  for (const k of KEY_OPTIONS) out.push({ value: k.sig + '|minor', label: k.minor });
  return out;
}

/** True iff applying (count, unit) FROM `measureIdx` forward would shrink the
 *  measure budget below current and there is destroyable content (note/rest) in
 *  the affected span (measures at or after `measureIdx`). */
function meterWouldTruncate(model: ComposerModel, measureIdx: number, count: number, unit: number): boolean {
  const newTicks = count * (64 / unit);
  if (newTicks >= model.measureTicksAt(measureIdx)) return false;
  /* Real content = notes OR rests (placeholders are <space>). Only the span
     from measureIdx onward is truncated. */
  const measures = model.allMeasures();
  for (let mi = measureIdx; mi < measures.length; mi++) {
    if (measures[mi].querySelector('note, rest')) return true;
  }
  return false;
}

export function openSignatureModal(
  model: ComposerModel,
  measureIdx: number,
  opts: { history: HistoryManager; onApply: () => void },
): void {
  /* Populate with the signature in EFFECT at the anchored measure (an existing
     override, or the inherited value), so re-opening shows the current state. */
  const curSig = model.keySigAt(measureIdx);
  const curMode = model.keyModeAt(measureIdx);
  const ts = model.meterAt(measureIdx);

  const fields: TextEntryField[] = [
    { name: 'key', type: 'select', label: 'Key', value: curSig + '|' + curMode, options: combinedKeyOptions() },
    { name: 'count', type: 'select', label: 'Beats', value: String(ts.count),
      options: TIME_NUM_OPTIONS.map((n) => ({ value: String(n), label: String(n) })) },
    { name: 'unit', type: 'select', label: 'Beat unit', value: String(ts.unit),
      options: TIME_DEN_OPTIONS.map((d) => ({ value: String(d), label: String(d) })) },
  ];

  openTextEntryModal({
    title: 'Time / Key signature — m' + (measureIdx + 1),
    fields,
    onOk: (values) => {
      const [sig, modeRaw] = String(values.key ?? '0|major').split('|');
      const mode: 'major' | 'minor' = modeRaw === 'minor' ? 'minor' : 'major';
      const count = parseInt(String(values.count), 10);
      const unit = parseInt(String(values.unit), 10);
      if (!isFinite(count) || count < 1 || count > 16) return;
      if (!isFinite(unit) || !TIME_DEN_OPTIONS.includes(unit)) return;

      if (meterWouldTruncate(model, measureIdx, count, unit)) {
        const ok = window.confirm(
          'Changing time signature may truncate notes that don’t fit in the new measure. Continue?'
        );
        if (!ok) return;
      }

      const before = model.snapshotState();
      /* Effective FROM the anchored measure forward (measure 0 = score head). */
      model.setKeySigAt(measureIdx, sig, mode);
      model.setMeterAt(measureIdx, count, unit);
      opts.history.push(before, model.snapshotState(), 'signature');
      opts.onApply();
    },
  });
}
