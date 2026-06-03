// Time / Key signature modal — Ctrl+Shift+S. Opens the reusable text-entry
// shell anchored to a measure. Reuses setupDialog's KEY_OPTIONS table.
//
// The modal writes the signature effective FROM the anchored measure forward
// (Phase 4.2): measure 0 updates the score-head <scoreDef>; a later measure
// gets an in-section <scoreDef> override, so notes before it keep the prior
// signature. setMeterAt/setKeySigAt encapsulate the placement.

import { type ComposerModel, type MeterSym, parseBeatGroups, formatBeatGroups } from './model/index.js';
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

const TIME_NUM_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const TIME_DEN_OPTIONS = [1, 2, 4, 8, 16];

/** Meter-symbol options. `common` forces 4/4 (renders C), `cut` forces 2/2
 *  (renders ¢); `numeric` is a plain numeral. */
const SYMBOL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'numeric', label: 'Numeric' },
  { value: 'common', label: 'Common time (C)' },
  { value: 'cut', label: 'Cut time (¢)' },
];

/** The count/unit a meter symbol forces (common = 4/4, cut = 2/2). */
function symbolMeter(sym: MeterSym): { count: number; unit: number } | null {
  if (sym === 'common') return { count: 4, unit: 4 };
  if (sym === 'cut') return { count: 2, unit: 2 };
  return null;
}

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
  opts: {
    history: HistoryManager;
    onApply: () => void;
    /** Surfaces a validation error (e.g. bad beat-groups) to the statusline.
     *  When set, an invalid submit reports + applies nothing. */
    onError?: (msg: string) => void;
    /** When set, apply over the inclusive measure span `[measureIdx, rangeEndIdx]`
     *  with a bounded restore after the range (selection-driven — Phase 4a),
     *  instead of "FROM measureIdx forward". */
    rangeEndIdx?: number;
  },
): void {
  /* Populate with the signature in EFFECT at the anchored measure (an existing
     override, or the inherited value), so re-opening shows the current state. */
  const curSig = model.keySigAt(measureIdx);
  const curMode = model.keyModeAt(measureIdx);
  const ts = model.meterAt(measureIdx);
  const curSym: MeterSym = ts.sym;

  const ranged = opts.rangeEndIdx != null && opts.rangeEndIdx >= measureIdx;
  const hi = ranged ? (opts.rangeEndIdx as number) : measureIdx;
  const spanLabel = ranged
    ? 'm' + (measureIdx + 1) + '–m' + (hi + 1)
    : 'm' + (measureIdx + 1);

  const fields: TextEntryField[] = [
    { name: 'key', type: 'select', label: 'Key', value: curSig + '|' + curMode, options: combinedKeyOptions() },
    { name: 'symbol', type: 'select', label: 'Symbol', value: curSym ?? 'numeric', options: SYMBOL_OPTIONS },
    { name: 'count', type: 'select', label: 'Beats', value: String(ts.count),
      options: TIME_NUM_OPTIONS.map((n) => ({ value: String(n), label: String(n) })) },
    { name: 'unit', type: 'select', label: 'Beat unit', value: String(ts.unit),
      options: TIME_DEN_OPTIONS.map((d) => ({ value: String(d), label: String(d) })) },
    { name: 'beatGroups', type: 'text', label: 'Beat groups', value: formatBeatGroups(ts.beatGroups) ?? '',
      placeholder: 'e.g. 2+2+3 (beaming only)' },
  ];

  openTextEntryModal({
    title: 'Time / Key signature — ' + spanLabel,
    fields,
    focusField: 'key',
    /* Symbol coupling: Common forces 4/4, Cut forces 2/2 and hides the numeral
       selects entirely (they no longer apply); Numeric reveals them. */
    onChange: (values, _changed, api) => {
      const sym = String(values.symbol ?? 'numeric') as MeterSym | 'numeric';
      const forced = symbolMeter(sym === 'numeric' ? null : (sym as MeterSym));
      if (forced) {
        api.setValue('count', String(forced.count));
        api.setValue('unit', String(forced.unit));
        api.setHidden('count', true);
        api.setHidden('unit', true);
        /* Additive grouping doesn't apply to a symbol meter — clear + hide it. */
        api.setValue('beatGroups', '');
        api.setHidden('beatGroups', true);
      } else {
        api.setHidden('count', false);
        api.setHidden('unit', false);
        api.setHidden('beatGroups', false);
      }
    },
    onOk: (values) => {
      const [sig, modeRaw] = String(values.key ?? '0|major').split('|');
      const mode: 'major' | 'minor' = modeRaw === 'minor' ? 'minor' : 'major';
      const symRaw = String(values.symbol ?? 'numeric');
      const sym: MeterSym = symRaw === 'common' ? 'common' : symRaw === 'cut' ? 'cut' : null;
      const forced = symbolMeter(sym);
      const count = forced ? forced.count : parseInt(String(values.count), 10);
      const unit = forced ? forced.unit : parseInt(String(values.unit), 10);
      if (!isFinite(count) || count < 1 || count > 16) return;
      if (!isFinite(unit) || !TIME_DEN_OPTIONS.includes(unit)) return;

      /* Beat groups (optional). Must sum to the beat count, else reject the
         whole submit (nothing applied) and report. */
      const groupsText = String(values.beatGroups ?? '').trim();
      let beatGroups: number[] | null = null;
      if (groupsText) {
        beatGroups = parseBeatGroups(groupsText);
        const sum = beatGroups ? beatGroups.reduce((a, b) => a + b, 0) : -1;
        if (!beatGroups || sum !== count) {
          opts.onError?.('Beat groups must be “+”-separated positive integers summing to ' + count + '.');
          return;
        }
      }

      if (meterWouldTruncate(model, measureIdx, count, unit)) {
        const ok = window.confirm(
          'Changing time signature may truncate notes that don’t fit in the new measure. Continue?'
        );
        if (!ok) return;
      }

      const before = model.snapshotState();
      if (ranged) {
        model.setKeySigRange(measureIdx, hi, sig, mode);
        model.setMeterRange(measureIdx, hi, count, unit, { sym, beatGroups });
      } else {
        /* Effective FROM the anchored measure forward (measure 0 = score head). */
        model.setKeySigAt(measureIdx, sig, mode);
        model.setMeterAt(measureIdx, count, unit, { sym, beatGroups });
      }
      opts.history.push(before, model.snapshotState(), 'signature');
      opts.onApply();
    },
  });
}
