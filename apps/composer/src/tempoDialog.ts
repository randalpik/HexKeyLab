// Tempo modal — create / edit / delete a <tempo> at a given moment, on the
// reusable text-entry shell. Shared by Ctrl+Shift+T (input.ts, at the cursor
// moment) and the Setup dialog's "Tempo…" button (at measure 1, beat 1).
//
// A <tempo> is one of: an INSTANT tempo marking (optional ♩=bpm), a GRADUAL
// rit/accel, or an "a tempo". The kind dropdown selects which — except in the
// measure-1 / Setup case (`instantOnly`), where only an instant marking is
// allowed. Gradual INTENSITY is not a field: it's read from the text (poco /
// molto / neither), with magnitudes set once in Setup. Playback retiming
// (render/playback.ts buildTempoTimeline) interprets the result.

import type { ComposerModel } from './model/index.js';
import type { HistoryManager } from './history.js';
import { openTextEntryModal, type TextEntryField } from './ui/textEntryModal.js';
import {
  addTempo, tempoAt, readTempoEl, removeExpression,
  type Moment, type GradualDir,
} from './expressions.js';

/* Beat-note options encode "unit|dots" so dotted values fit one select. */
const UNIT_OPTIONS = [
  { value: '4|0', label: '♩ quarter' },
  { value: '4|1', label: '♩. dotted quarter' },
  { value: '2|0', label: '\u{1D15E} half' },
  { value: '2|1', label: '\u{1D15E}. dotted half' },
  { value: '8|0', label: '♪ eighth' },
];
const KIND_OPTIONS = [
  { value: 'instant', label: 'Tempo marking (♩=)' },
  { value: 'rit', label: 'Ritardando' },
  { value: 'accel', label: 'Accelerando' },
  { value: 'atempo', label: 'A tempo' },
];

export function openTempoModal(
  model: ComposerModel,
  at: Moment,
  opts: { history: HistoryManager; onApply: () => void; instantOnly?: boolean },
): void {
  const existingEl = tempoAt(model.getDoc(), at);
  const ex = existingEl ? readTempoEl(existingEl) : null;
  const kindVal = ex ? (ex.gradual ?? (ex.aTempo ? 'atempo' : 'instant')) : 'instant';
  const unitVal = ex ? String(ex.unit) + '|' + (ex.dots ? 1 : 0) : '4|0';

  const fields: TextEntryField[] = [];
  /* Measure-1 / Setup: only a tempo marking is allowed (no rit/accel/a tempo). */
  if (!opts.instantOnly) {
    fields.push({ name: 'kind', type: 'select', label: 'Kind', value: kindVal, options: KIND_OPTIONS });
  }
  fields.push(
    { name: 'text', type: 'text', label: 'Text', value: ex?.text ?? '', placeholder: 'e.g. Allegro / poco rit.' },
    { name: 'bpm', type: 'number', label: '♩ =', value: ex?.bpm != null ? String(ex.bpm) : '', placeholder: 'tempo marking only', min: 20, max: 400 },
    { name: 'unit', type: 'select', label: 'Beat note', value: unitVal, options: UNIT_OPTIONS },
    { name: 'showMm', type: 'check', label: 'Show ♩ = N', value: ex ? ex.showMm : true },
  );

  /* Default label per gradual/a-tempo kind, so the Text field's placeholder
     advertises what's used when left blank — no need to type the word. */
  const defaultLabelFor = (kind: string): string =>
    kind === 'rit' ? 'rit.' : kind === 'accel' ? 'accel.' : kind === 'atempo' ? 'a tempo' : '';

  openTextEntryModal({
    title: ex ? 'Edit tempo' : 'Tempo',
    fields,
    /* Lead with the Kind selector (the choice that shapes the rest of the form),
       not the Text field. Setup's instant-only flow has no Kind field, so it
       falls back to focusing Text. */
    focusField: opts.instantOnly ? undefined : 'kind',
    onChange: (values, _changed, api) => {
      const kind = opts.instantOnly ? 'instant' : String(values.kind ?? 'instant');
      /* The ♩= metronome machinery (bpm / beat note / show-mm) only applies to
         a Tempo marking; hide it entirely for gradual rit/accel and "a tempo". */
      const instant = kind === 'instant';
      api.setHidden('bpm', !instant);
      api.setHidden('unit', !instant);
      api.setHidden('showMm', !instant);
      api.setPlaceholder('text', instant
        ? 'e.g. Allegro / poco rit.'
        : defaultLabelFor(kind) + ' (default)');
    },
    onOk: (values) => {
      const kind = opts.instantOnly ? 'instant' : String(values.kind);
      const text = String(values.text ?? '').trim();
      const [uStr, dStr] = String(values.unit ?? '4|0').split('|');
      const unit = parseInt(uStr, 10) || 4;
      const dots = dStr === '1' ? 1 : 0;
      const showMm = !!values.showMm;
      const before = model.snapshotState();
      /* Edit = replace: drop any existing mark at this moment, then re-add. */
      const cur = tempoAt(model.getDoc(), at);
      if (cur) removeExpression(cur);
      let added = false;
      if (kind === 'instant') {
        const bpm = parseInt(String(values.bpm), 10);
        const hasBpm = isFinite(bpm) && bpm > 0;
        if (text !== '' || hasBpm) {
          addTempo(model.getDoc(), at, { text, bpm: hasBpm ? bpm : undefined, unit, dots, showMm: hasBpm && showMm, italic: false });
          added = true;
        }
        /* else: empty marking → just the removal above (delete) */
      } else if (kind === 'rit' || kind === 'accel') {
        addTempo(model.getDoc(), at, {
          text: text || (kind === 'rit' ? 'rit.' : 'accel.'),
          gradual: kind as GradualDir,
          italic: true,
        });
        added = true;
      } else if (kind === 'atempo') {
        addTempo(model.getDoc(), at, { text: text || 'a tempo', aTempo: true, italic: true });
        added = true;
      }
      if (cur || added) opts.history.push(before, model.snapshotState(), 'tempo');
      opts.onApply();
    },
  });
}
