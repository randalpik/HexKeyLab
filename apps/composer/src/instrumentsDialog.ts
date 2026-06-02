// Instruments management modal (Phase 5 multi-instrument): a vertical,
// drag-to-reorder list with Add and per-row Remove. Edits are STAGED — the
// modal mutates a working `InstrEdit[]` list, not the model. Nothing touches
// the score until the user presses Save in the parent Setup dialog, which
// calls reconcileInstruments(). This matches the rest of Setup (edit, then
// Save commits / Cancel discards) rather than applying each change live.

import type { ComposerModel } from './model/index.js';
import { openTextEntryModal } from './ui/textEntryModal.js';

/** A staged instrument row. `origIndex` is the instrument's index in the model
 *  when Setup opened (its IDENTITY, so reorder/keep preserve its content);
 *  null means newly added (no content yet). */
export interface InstrEdit {
  name: string;
  instrKey: string;
  staffCount: 1 | 2;
  origIndex: number | null;
}

/** Build the initial working list from the model's current instruments. */
export function instrEditsFromModel(model: ComposerModel): InstrEdit[] {
  return model.instruments().map((inst, i) => ({
    name: inst.name,
    instrKey: inst.instrKey,
    staffCount: inst.staffNs.length === 2 ? 2 : 1,
    origIndex: i,
  }));
}

/** One-line summary of a working list (for the Setup dialog's Instruments row). */
export function summarizeInstrEdits(edits: ReadonlyArray<InstrEdit>): string {
  return edits.map((e) => e.name + (e.staffCount === 2 ? '' : ' (1)')).join(', ');
}

/** Reconcile the model to a working list (called on Setup Save). Returns true
 *  iff anything changed. Removes dropped originals, appends new instruments,
 *  then reorders to the edit sequence — content travels with each surviving
 *  instrument via its `origIndex` identity. The caller wraps this in its own
 *  single history entry. */
export function reconcileInstruments(model: ComposerModel, edits: ReadonlyArray<InstrEdit>): boolean {
  const n = model.instruments().length;
  /* No-op fast path: same count, every row in its original position, no adds —
     so a Setup Save that didn't touch instruments leaves the cursor alone. */
  if (edits.length === n && edits.every((e, i) => e.origIndex === i)) return false;

  /* 1. Remove originals not kept (high→low so lower indices stay valid). */
  const kept = new Set<number>();
  for (const e of edits) if (e.origIndex != null) kept.add(e.origIndex);
  for (let i = n - 1; i >= 0; i--) if (!kept.has(i)) model.removeInstrument(i);

  /* Surviving originals are now in ascending-orig order at indices 0..k-1. */
  const keptAsc = [...kept].sort((a, b) => a - b);
  const origToCur = new Map<number, number>();
  keptAsc.forEach((orig, pos) => origToCur.set(orig, pos));

  /* 2. Append new instruments in edit order. */
  let cur = keptAsc.length;
  const newToCur = new Map<InstrEdit, number>();
  for (const e of edits) {
    if (e.origIndex == null) {
      model.addInstrument({ name: e.name, instrKey: e.instrKey, staffCount: e.staffCount });
      newToCur.set(e, cur++);
    }
  }

  /* 3. Reorder to the edit sequence (current indices in edit order). */
  if (model.instruments().length > 1) {
    const order = edits.map((e) =>
      e.origIndex != null ? origToCur.get(e.origIndex)! : newToCur.get(e)!);
    model.reorderInstruments(order);
  }
  return true;
}

/** Curated subset of HKL sample-set keys (apps/hkl/src/audio/samples-data.ts).
 *  The stored `hkl:instr` key routes playback timbre; an unloaded key falls
 *  back to HKL's active instrument. */
export const TIMBRE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'piano', label: 'Piano' },
  { value: 'electric_piano', label: 'Electric piano' },
  { value: 'harpsichord', label: 'Harpsichord' },
  { value: 'vibraphone', label: 'Vibraphone' },
  { value: 'harp', label: 'Harp' },
  { value: 'acoustic_guitar', label: 'Acoustic guitar' },
  { value: 'flute', label: 'Flute' },
  { value: 'oboe', label: 'Oboe' },
  { value: 'clarinet', label: 'Clarinet' },
  { value: 'bassoon', label: 'Bassoon' },
  { value: 'saxophone', label: 'Saxophone' },
  { value: 'french_horn', label: 'French horn' },
  { value: 'trombone', label: 'Trombone' },
  { value: 'violin', label: 'Violin' },
  { value: 'viola', label: 'Viola' },
  { value: 'cello', label: 'Cello' },
  { value: 'double_bass', label: 'Double bass' },
  { value: 'pipe_organ', label: 'Pipe organ' },
  { value: 'drawbar_organ', label: 'Drawbar organ' },
];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

/** Open the staged instruments editor over the working list `edits` (mutated in
 *  place). `onChange` fires after every edit so the parent can refresh its
 *  summary. Nothing is applied to the model here — Setup's Save reconciles. */
export function openInstrumentsModal(edits: InstrEdit[], onChange: () => void): void {
  const dlg = document.getElementById('instrumentsDialog') as HTMLDialogElement | null;
  if (!dlg) return;

  let dragFrom = -1;

  function render(): void {
    if (!dlg) return;
    const rows = edits.map((e, i) => `
      <li class="instr-row" draggable="true" data-idx="${i}"
          style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #444;border-radius:4px;margin:4px 0;cursor:grab;background:#2a2a2a">
        <span class="drag-handle" style="opacity:0.6;user-select:none">⠿</span>
        <span style="flex:1">${esc(e.name)}${e.origIndex === null ? ' <span style="opacity:0.5">(new)</span>' : ''}</span>
        <span style="opacity:0.6;font-size:0.85em">${e.staffCount === 2 ? 'grand staff' : '1 staff'}</span>
        <button type="button" class="instr-remove" data-idx="${i}" title="Remove"
                ${edits.length <= 1 ? 'disabled' : ''}>✕</button>
      </li>`).join('');
    dlg.innerHTML = `
      <h3 style="margin:0 0 8px">Instruments</h3>
      <p style="opacity:0.7;margin:0 0 8px;font-size:0.9em">Drag to reorder (top = first staff). Changes apply when you Save the Setup dialog.</p>
      <ul id="instrList" style="list-style:none;margin:0;padding:0">${rows}</ul>
      <div style="display:flex;justify-content:space-between;margin-top:12px">
        <button type="button" id="instrAddBtn">Add instrument…</button>
        <button type="button" id="instrCloseBtn">Done</button>
      </div>`;

    dlg.querySelector<HTMLButtonElement>('#instrAddBtn')?.addEventListener('click', () => {
      openTextEntryModal({
        title: 'Add instrument',
        fields: [
          { name: 'name', type: 'text', label: 'Name', value: '', placeholder: 'e.g. Violin' },
          { name: 'timbre', type: 'select', label: 'Sound', value: 'violin', options: TIMBRE_OPTIONS },
          { name: 'staves', type: 'select', label: 'Staves', value: '1',
            options: [{ value: '1', label: '1 (single staff)' }, { value: '2', label: '2 (grand staff)' }] },
        ],
        okLabel: 'Add',
        onOk: (values) => {
          const instrKey = String(values.timbre ?? 'piano');
          const staffCount = String(values.staves) === '2' ? 2 : 1;
          const label = TIMBRE_OPTIONS.find((o) => o.value === instrKey)?.label ?? instrKey;
          const name = String(values.name ?? '').trim() || label;
          edits.push({ name, instrKey, staffCount, origIndex: null });
          onChange();
          render();
        },
      });
    });

    for (const btn of Array.from(dlg.querySelectorAll<HTMLButtonElement>('.instr-remove'))) {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx ?? '', 10);
        if (Number.isFinite(idx) && edits.length > 1) {
          edits.splice(idx, 1);
          onChange();
          render();
        }
      });
    }

    for (const row of Array.from(dlg.querySelectorAll<HTMLLIElement>('.instr-row'))) {
      row.addEventListener('dragstart', () => { dragFrom = parseInt(row.dataset.idx ?? '', 10); });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.style.outline = '2px solid #6cf'; });
      row.addEventListener('dragleave', () => { row.style.outline = ''; });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.style.outline = '';
        const to = parseInt(row.dataset.idx ?? '', 10);
        if (!Number.isFinite(dragFrom) || !Number.isFinite(to) || dragFrom === to) return;
        const [moved] = edits.splice(dragFrom, 1);
        edits.splice(to, 0, moved);
        onChange();
        render();
      });
    }

    dlg.querySelector<HTMLButtonElement>('#instrCloseBtn')?.addEventListener('click', () => dlg.close());
  }

  render();
  if (!dlg.open) dlg.showModal();
}
