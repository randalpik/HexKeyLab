// Document Setup modal. Opens a <dialog> with form fields for title,
// composer, key signature, time signature, and tempo. On save, applies
// the values to the model in the right order (title/composer/keysig/
// tempo first, then time signature last — since time-sig change triggers
// the measure rebuild).

import type { ComposerModel } from './model/index.js';
import {
  getDynamicMap, setDynamicMap, getGradualPercents, setGradualPercents,
  type LayoutReq, type GradualPercents,
} from './expressions.js';
import { openTempoModal } from './tempoDialog.js';
import { openSignatureModal } from './sigDialog.js';
import { DYNAMIC_NAMES, DEFAULT_DYNAMIC_MAP } from '@hkl/shared/dynamics.js';
import { TUNING_MODES, type TuningMode, coordToMidi, MIDI_LOW, MIDI_HIGH } from '@hkl/shared/freq.js';
import { noteName, keyOctave, fmtNote } from '@hkl/shared/notes.js';
import { planRetune, summarizePlan, applyRetune } from './notation/retune.js';
import type { HistoryManager } from './history.js';

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const TUNING_LABELS: Record<TuningMode, string> = {
  E: 'Equal (12-TET)',
  '5': 'Ptolemaic',
  P: 'Pythagorean',
  D: 'Semiditonal',
  '7': 'Septimal',
  V: 'Schismatic',
};

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
  const layoutReq = model.getLayoutReq();
  const tuningSel = $<HTMLSelectElement>('setupTuningMode');
  if (tuningSel) {
    populateSelect(tuningSel,
      TUNING_MODES.map((m) => ({ value: m, label: TUNING_LABELS[m] })),
      layoutReq.tuningMode);
  }
  const hejiChk = $<HTMLInputElement>('setupHeji');
  if (hejiChk) hejiChk.checked = model.getHejiEnabled();
  const refQEl = $<HTMLInputElement>('setupRefQ');
  const refREl = $<HTMLInputElement>('setupRefR');
  if (refQEl) refQEl.value = String(layoutReq.refQ);
  if (refREl) refREl.value = String(layoutReq.refR);
  updateRefLabel(layoutReq.refQ, layoutReq.refR);
  /* Live label update as the user edits (q, r). */
  const updateFromForm = (): void => {
    const q = parseInt(refQEl?.value ?? '0', 10);
    const r = parseInt(refREl?.value ?? '0', 10);
    if (Number.isFinite(q) && Number.isFinite(r)) updateRefLabel(q, r);
  };
  refQEl?.addEventListener('input', updateFromForm);
  refREl?.addEventListener('input', updateFromForm);
}

function readForm(): {
  title: string; subtitle: string; composer: string; footer: string;
  gradual: GradualPercents;
  layoutReq: LayoutReq; hejiEnabled: boolean;
} | null {
  const title = $<HTMLInputElement>('setupTitle')?.value ?? 'Untitled';
  const subtitle = ($<HTMLInputElement>('setupSubtitle')?.value ?? '').trim();
  const composer = $<HTMLInputElement>('setupComposer')?.value ?? '';
  /* Footer trimming preserves the user's explicit empty-string intent (= hide
     the footer) — distinguish from "field not present" by reading the raw value. */
  const footerRaw = $<HTMLInputElement>('setupFooter');
  const footer = footerRaw ? footerRaw.value.trim() : 'Engraved with HKL Composer';
  const gradPct = (id: string, dflt: number): number => {
    const v = parseInt($<HTMLInputElement>(id)?.value ?? '', 10);
    return isFinite(v) ? Math.max(0, Math.min(99, v)) : dflt;
  };
  const gradual: GradualPercents = {
    poco: gradPct('setupGrad_poco', 20),
    plain: gradPct('setupGrad_plain', 40),
    molto: gradPct('setupGrad_molto', 60),
  };
  const tuningRaw = $<HTMLSelectElement>('setupTuningMode')?.value ?? '5';
  const tuningMode: TuningMode = isTuningMode(tuningRaw) ? tuningRaw : '5';
  const refQ = parseInt($<HTMLInputElement>('setupRefQ')?.value ?? '0', 10);
  const refR = parseInt($<HTMLInputElement>('setupRefR')?.value ?? '0', 10);
  if (!Number.isFinite(refQ) || !Number.isFinite(refR)) return null;
  const refMidi = coordToMidi(refQ, refR);
  if (refMidi < MIDI_LOW || refMidi > MIDI_HIGH) return null;
  const layoutReq: LayoutReq = { tuningMode, refQ, refR };
  const hejiEnabled = $<HTMLInputElement>('setupHeji')?.checked ?? false;
  return { title, subtitle, composer, footer, gradual, layoutReq, hejiEnabled };
}

function isTuningMode(s: string): s is TuningMode {
  return (TUNING_MODES as ReadonlyArray<string>).indexOf(s) >= 0;
}

function updateRefLabel(q: number, r: number): void {
  const label = $('setupRefLabel');
  if (!label) return;
  const midi = coordToMidi(q, r);
  if (midi < MIDI_LOW || midi > MIDI_HIGH) {
    label.textContent = '(out of range)';
    return;
  }
  const name = noteName(q, r);
  const oct = keyOctave(q, r);
  label.textContent = '= ' + fmtNote(name) + oct;
}

export function openSetupDialog(
  model: ComposerModel,
  onApply: (layoutChanged: boolean) => void,
  history?: HistoryManager,
): void {
  const dlg = $<HTMLDialogElement>('setupDialog');
  if (!dlg) return;

  setupSelects(model);
  const tEl = $<HTMLInputElement>('setupTitle');     if (tEl) tEl.value = model.getTitle();
  const subEl = $<HTMLInputElement>('setupSubtitle'); if (subEl) subEl.value = model.getSubtitle();
  const cEl = $<HTMLInputElement>('setupComposer'); if (cEl) cEl.value = model.getComposer();
  const ftEl = $<HTMLInputElement>('setupFooter');   if (ftEl) ftEl.value = model.getFooter();
  populateDynamicInputs(model);
  populateGradualInputs(model);

  /* Tempo… button — opens the shared tempo modal targeting measure 1, beat 1
     (the initial tempo). Mid-piece tempo changes use Ctrl+Shift+T at the
     cursor. Applies as its own history entry; the Setup dialog stays open. */
  const tempoBtn = $<HTMLButtonElement>('setupTempoBtn');
  const onTempoClick = (): void => {
    if (!history) return;
    openTempoModal(model, { measureIdx: 0, tstamp: 1 }, {
      history,
      onApply: () => onApply(false),
      instantOnly: true,
    });
  };
  tempoBtn?.addEventListener('click', onTempoClick);

  /* Time / key signature… button — opens the shared signature modal targeting
     measure 1 (the score defaults). Mid-piece changes use Ctrl+Shift+S at the
     cursor. Applies as its own history entry; the Setup dialog stays open. */
  const sigBtn = $<HTMLButtonElement>('setupSigBtn');
  const onSigClick = (): void => {
    if (!history) return;
    openSignatureModal(model, 0, { history, onApply: () => onApply(false) });
  };
  sigBtn?.addEventListener('click', onSigClick);

  /* Fill-incomplete-measures button. Applies immediately as its own
     history-tracked action (independent of Save / Cancel), then leaves the
     dialog open so the user can continue editing other fields. */
  const fillBtn = $<HTMLButtonElement>('setupFillIncompleteMeasures');
  const onFillClick = (): void => {
    const before = history ? model.snapshotState() : null;
    const result = model.fillIncompleteMeasures();
    if (history && before) {
      history.push(before, model.snapshotState(), 'fill-incomplete-measures');
    }
    /* Signal a re-render via onApply with layoutChanged=false. */
    onApply(false);
    if (fillBtn) {
      fillBtn.textContent = result.measuresAffected > 0
        ? 'Filled ' + result.measuresAffected + ' measure(s).'
        : 'No incomplete measures.';
      window.setTimeout(() => {
        if (fillBtn) fillBtn.textContent = 'Fill incomplete measures with rests';
      }, 1500);
    }
  };
  fillBtn?.addEventListener('click', onFillClick);

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

    /* Time / key signature are no longer Setup fields — they live in the
       Signature… button → signature modal (applied independently above). */

    /* All setup mutations bundle into a single undo entry. Snapshot BEFORE
       the confirm prompts (so cancellation paths leave history untouched —
       no-op push will be skipped by HistoryManager when before === after). */
    const beforeSnapshot = history ? model.snapshotState() : null;

    /* Layout requirement change. Tuning-mode change retunes existing notes
       (frequency invariant: each note's old freq is preserved as closely as
       possible by moving to a different (q, r) under the new mode). Ref
       changes are informational — they don't affect (q, r) → Hz. */
    const prevLayout = model.getLayoutReq();
    const tuningChanged = prevLayout.tuningMode !== values.layoutReq.tuningMode;
    const refChanged = prevLayout.refQ !== values.layoutReq.refQ || prevLayout.refR !== values.layoutReq.refR;
    const layoutChanged = tuningChanged || refChanged;
    let proceedWithLayout = true;
    if (tuningChanged && model.hasNotes()) {
      const plan = planRetune(model.getDoc(), prevLayout.tuningMode, values.layoutReq.tuningMode);
      const summary = summarizePlan(plan);
      proceedWithLayout = window.confirm(summary);
      if (proceedWithLayout) applyRetune(model, plan);
    }

    /* Apply in order. */
    model.setTitle(values.title);
    model.setSubtitle(values.subtitle);
    model.setComposer(values.composer);
    model.setFooter(values.footer);
    applyDynamicInputs(model);
    setGradualPercents(model.getDoc(), values.gradual);
    if (proceedWithLayout) {
      model.setLayoutReq(values.layoutReq);
    }
    model.setHejiEnabled(values.hejiEnabled);

    /* Push the entire setup apply-block as ONE history entry. */
    if (history && beforeSnapshot) {
      history.push(beforeSnapshot, model.snapshotState(), 'setup');
    }
    onApply(layoutChanged && proceedWithLayout);
  };

  /* Clean up listeners on dialog close (covers both submit and Escape). */
  const onClose = (): void => {
    form?.removeEventListener('submit', onSubmit);
    fillBtn?.removeEventListener('click', onFillClick);
    tempoBtn?.removeEventListener('click', onTempoClick);
    sigBtn?.removeEventListener('click', onSigClick);
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

function populateGradualInputs(model: ComposerModel): void {
  const p = getGradualPercents(model.getDoc());
  for (const k of ['poco', 'plain', 'molto'] as const) {
    const inp = $<HTMLInputElement>('setupGrad_' + k);
    if (inp) inp.value = String(p[k]);
  }
}

