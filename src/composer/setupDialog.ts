// Document Setup modal. Opens a <dialog> with form fields for title,
// composer, key signature, time signature, and tempo. On save, applies
// the values to the model in the right order (title/composer/keysig/
// tempo first, then time signature last — since time-sig change triggers
// the measure rebuild).

import type { ComposerModel } from './model.js';
import { getDynamicMap, setDynamicMap, DYNAMIC_NAMES, DEFAULT_DYNAMIC_MAP } from './expressions.js';

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

interface KeyOption { sig: string; label: string }

const KEY_OPTIONS: ReadonlyArray<KeyOption> = [
  { sig: '7f', label: 'C♭ major / a♭ minor (7♭)' },
  { sig: '6f', label: 'G♭ major / e♭ minor (6♭)' },
  { sig: '5f', label: 'D♭ major / b♭ minor (5♭)' },
  { sig: '4f', label: 'A♭ major / f minor (4♭)' },
  { sig: '3f', label: 'E♭ major / c minor (3♭)' },
  { sig: '2f', label: 'B♭ major / g minor (2♭)' },
  { sig: '1f', label: 'F major / d minor (1♭)' },
  { sig: '0',  label: 'C major / a minor' },
  { sig: '1s', label: 'G major / e minor (1♯)' },
  { sig: '2s', label: 'D major / b minor (2♯)' },
  { sig: '3s', label: 'A major / f♯ minor (3♯)' },
  { sig: '4s', label: 'E major / c♯ minor (4♯)' },
  { sig: '5s', label: 'B major / g♯ minor (5♯)' },
  { sig: '6s', label: 'F♯ major / d♯ minor (6♯)' },
  { sig: '7s', label: 'C♯ major / a♯ minor (7♯)' },
];

const TIME_NUM_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const TIME_DEN_OPTIONS = [1, 2, 4, 8, 16];

interface TempoUnitOption { unit: '1' | '2' | '4' | '8'; dots: 0 | 1; label: string }

const TEMPO_UNIT_OPTIONS: ReadonlyArray<TempoUnitOption> = [
  { unit: '4', dots: 0, label: '♩ (quarter)' },
  { unit: '4', dots: 1, label: '♩. (dotted quarter)' },
  { unit: '8', dots: 0, label: '♪ (eighth)' },
  { unit: '2', dots: 0, label: '𝅗𝅥 (half)' },
];

function populateSelect(sel: HTMLSelectElement, options: ReadonlyArray<{ value: string; label: string }>, current: string): void {
  sel.innerHTML = '';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

function setupSelects(model: ComposerModel): void {
  const keySel = $<HTMLSelectElement>('setupKey');
  if (keySel) {
    populateSelect(keySel,
      KEY_OPTIONS.map((k) => ({ value: k.sig, label: k.label })),
      model.getKeySig());
  }

  const numSel = $<HTMLSelectElement>('setupTimeNum');
  const denSel = $<HTMLSelectElement>('setupTimeDen');
  const ts = model.getTimeSig();
  if (numSel) {
    populateSelect(numSel,
      TIME_NUM_OPTIONS.map((n) => ({ value: String(n), label: String(n) })),
      String(ts.count));
  }
  if (denSel) {
    populateSelect(denSel,
      TIME_DEN_OPTIONS.map((d) => ({ value: String(d), label: String(d) })),
      String(ts.unit));
  }

  const unitSel = $<HTMLSelectElement>('setupTempoUnit');
  const tempo = model.getTempo();
  if (unitSel) {
    populateSelect(unitSel,
      TEMPO_UNIT_OPTIONS.map((o) => ({
        value: o.unit + '|' + o.dots,
        label: o.label,
      })),
      tempo.unit + '|' + tempo.dots);
  }
}

function readForm(): {
  title: string; composer: string; keySig: string;
  count: number; unit: number;
  tempoBpm: number; tempoUnit: '1' | '2' | '4' | '8'; tempoDots: 0 | 1; tempoText: string;
} | null {
  const title = $<HTMLInputElement>('setupTitle')?.value ?? 'Untitled';
  const composer = $<HTMLInputElement>('setupComposer')?.value ?? '';
  const keySig = $<HTMLSelectElement>('setupKey')?.value ?? '0';
  const count = parseInt($<HTMLSelectElement>('setupTimeNum')?.value ?? '4', 10);
  const unit = parseInt($<HTMLSelectElement>('setupTimeDen')?.value ?? '4', 10);
  const tempoBpmRaw = parseInt($<HTMLInputElement>('setupTempoBpm')?.value ?? '120', 10);
  const tempoBpm = Math.max(20, Math.min(300, isFinite(tempoBpmRaw) ? tempoBpmRaw : 120));
  const tempoUnitRaw = $<HTMLSelectElement>('setupTempoUnit')?.value ?? '4|0';
  const [tu, td] = tempoUnitRaw.split('|');
  const tempoUnit = (tu === '1' || tu === '2' || tu === '4' || tu === '8') ? tu : '4';
  const tempoDots = (td === '1' ? 1 : 0) as 0 | 1;
  const tempoText = ($<HTMLInputElement>('setupTempoText')?.value ?? '').trim();
  if (!isFinite(count) || count < 1 || count > 16) return null;
  if (!isFinite(unit) || ![1, 2, 4, 8, 16].includes(unit)) return null;
  return { title, composer, keySig, count, unit, tempoBpm, tempoUnit, tempoDots, tempoText };
}

export function openSetupDialog(model: ComposerModel, onApply: () => void): void {
  const dlg = $<HTMLDialogElement>('setupDialog');
  if (!dlg) return;

  setupSelects(model);
  const tEl = $<HTMLInputElement>('setupTitle');     if (tEl) tEl.value = model.getTitle();
  const cEl = $<HTMLInputElement>('setupComposer'); if (cEl) cEl.value = model.getComposer();
  const bEl = $<HTMLInputElement>('setupTempoBpm'); if (bEl) bEl.value = String(model.getTempo().bpm);
  const txt = $<HTMLInputElement>('setupTempoText'); if (txt) txt.value = model.getTempo().text;
  populateDynamicInputs(model);

  const form = $<HTMLFormElement>('setupForm');

  const onSubmit = (e: SubmitEvent): void => {
    /* form has method="dialog" — the browser closes the dialog after this
       handler. Read the action from the submitter, since dlg.returnValue
       may not yet be set during the submit phase. */
    const submitter = e.submitter as HTMLButtonElement | null;
    const action = submitter?.value ?? '';
    if (action !== 'ok') return;

    const values = readForm();
    if (!values) return;

    const prev = model.getTimeSig();
    const meterChanged = prev.count !== values.count || prev.unit !== values.unit;
    let proceedWithMeterChange = true;
    if (meterChanged) {
      /* Per-measure truncation only drops content when the new measure's
         tick budget is SMALLER than the current one. Enlarging is
         non-destructive (existing measures just have unfilled space), so
         no confirmation needed. */
      const prevTicks = prev.count * (64 / prev.unit);
      const newTicks = values.count * (64 / values.unit);
      const wouldTruncate = newTicks < prevTicks && hasAnyNotes(model);
      if (wouldTruncate) {
        proceedWithMeterChange = window.confirm(
          'Changing time signature may truncate notes that don’t fit in the new measure. Continue?'
        );
      }
    }

    /* Apply in order. */
    model.setTitle(values.title);
    model.setComposer(values.composer);
    model.setKeySig(values.keySig);
    model.setTempo(values.tempoBpm, values.tempoUnit, values.tempoDots, values.tempoText);
    applyDynamicInputs(model);
    if (meterChanged && proceedWithMeterChange) {
      model.setTimeSig(values.count, values.unit);
    } else if (meterChanged && !proceedWithMeterChange) {
      /* No-op — keep existing meter. */
    } else {
      /* Same meter — still call setTimeSig to be idempotent. */
      model.setTimeSig(values.count, values.unit);
    }
    onApply();
  };

  /* Clean up listeners on dialog close (covers both submit and Escape). */
  const onClose = (): void => {
    form?.removeEventListener('submit', onSubmit);
    dlg.removeEventListener('close', onClose);
  };
  form?.addEventListener('submit', onSubmit);
  dlg.addEventListener('close', onClose);

  dlg.returnValue = '';
  dlg.showModal();
}

function populateDynamicInputs(model: ComposerModel): void {
  const map = getDynamicMap(model.getDoc());
  for (const name of DYNAMIC_NAMES) {
    const inp = $<HTMLInputElement>('setupDyn_' + name);
    if (inp) inp.value = String(map[name] ?? DEFAULT_DYNAMIC_MAP[name]);
  }
}

function applyDynamicInputs(model: ComposerModel): void {
  const next: Record<string, number> = {};
  for (const name of DYNAMIC_NAMES) {
    const inp = $<HTMLInputElement>('setupDyn_' + name);
    if (!inp) continue;
    const raw = parseInt(inp.value, 10);
    if (!isFinite(raw)) continue;
    next[name] = Math.max(1, Math.min(127, raw));
  }
  if (Object.keys(next).length > 0) {
    setDynamicMap(model.getDoc(), next);
  }
}

function hasAnyNotes(model: ComposerModel): boolean {
  for (let v = 1 as 1 | 2 | 3 | 4; v <= 4; v = (v + 1) as 1 | 2 | 3 | 4) {
    if (model.getVoiceLength(v) > 0) return true;
    if (v === 4) break;
  }
  return false;
}
