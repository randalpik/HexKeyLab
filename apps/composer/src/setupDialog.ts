// Document Setup modal. Opens a <dialog> with form fields for title,
// composer, key signature, time signature, and tempo. On save, applies
// the values to the model in the right order (title/composer/keysig/
// tempo first, then time signature last — since time-sig change triggers
// the measure rebuild).

import type { ComposerModel } from './model/index.js';
import { getDynamicMap, setDynamicMap, type LayoutReq } from './expressions.js';
import { DYNAMIC_NAMES, DEFAULT_DYNAMIC_MAP } from '@hkl/shared/dynamics.js';
import { TUNING_MODES, type TuningMode, coordToMidi, MIDI_LOW, MIDI_HIGH } from '@hkl/shared/freq.js';
import { noteName, keyOctave, fmtNote } from '@hkl/shared/notes.js';
import { planRetune, summarizePlan, applyRetune } from './notation/retune.js';
import type { HistoryManager } from './history.js';

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

interface KeyOption { sig: string; major: string; minor: string }

/** Only the active mode is shown in the dropdown; the checkbox toggles which
 *  label table is used. The sig identifier (`'0'`, `'1s'`, …) is unchanged
 *  across modes since major and its relative minor share a key signature. */
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

function keyOptionsForMode(mode: 'major' | 'minor'): ReadonlyArray<{ value: string; label: string }> {
  return KEY_OPTIONS.map((k) => ({ value: k.sig, label: mode === 'minor' ? k.minor : k.major }));
}

const TIME_NUM_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const TIME_DEN_OPTIONS = [1, 2, 4, 8, 16];

interface TempoUnitOption { unit: '1' | '2' | '4' | '8'; dots: 0 | 1; label: string }

const TEMPO_UNIT_OPTIONS: ReadonlyArray<TempoUnitOption> = [
  { unit: '4', dots: 0, label: '♩ (quarter)' },
  { unit: '4', dots: 1, label: '♩. (dotted quarter)' },
  { unit: '8', dots: 0, label: '♪ (eighth)' },
  { unit: '2', dots: 0, label: '𝅗𝅥 (half)' },
];

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
  const keySel = $<HTMLSelectElement>('setupKey');
  const minorChk = $<HTMLInputElement>('setupKeyMinor');
  if (minorChk) minorChk.checked = model.getKeyMode() === 'minor';
  if (keySel) {
    const mode: 'major' | 'minor' = minorChk?.checked ? 'minor' : 'major';
    populateSelect(keySel, keyOptionsForMode(mode), model.getKeySig());
  }
  /* Live relabel without disturbing the current selection. */
  if (minorChk && keySel) {
    minorChk.addEventListener('change', () => {
      const mode: 'major' | 'minor' = minorChk.checked ? 'minor' : 'major';
      const opts = keyOptionsForMode(mode);
      for (let i = 0; i < keySel.options.length && i < opts.length; i++) {
        keySel.options[i].textContent = opts[i].label;
      }
    });
  }

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
  title: string; subtitle: string; composer: string; footer: string;
  keySig: string; keyMode: 'major' | 'minor';
  count: number; unit: number;
  tempoBpm: number; tempoUnit: '1' | '2' | '4' | '8'; tempoDots: 0 | 1; tempoText: string;
  layoutReq: LayoutReq; hejiEnabled: boolean;
} | null {
  const title = $<HTMLInputElement>('setupTitle')?.value ?? 'Untitled';
  const subtitle = ($<HTMLInputElement>('setupSubtitle')?.value ?? '').trim();
  const composer = $<HTMLInputElement>('setupComposer')?.value ?? '';
  /* Footer trimming preserves the user's explicit empty-string intent (= hide
     the footer) — distinguish from "field not present" by reading the raw value. */
  const footerRaw = $<HTMLInputElement>('setupFooter');
  const footer = footerRaw ? footerRaw.value.trim() : 'Engraved with HKL Composer';
  const keySig = $<HTMLSelectElement>('setupKey')?.value ?? '0';
  const keyMode: 'major' | 'minor' = $<HTMLInputElement>('setupKeyMinor')?.checked ? 'minor' : 'major';
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
  const tuningRaw = $<HTMLSelectElement>('setupTuningMode')?.value ?? '5';
  const tuningMode: TuningMode = isTuningMode(tuningRaw) ? tuningRaw : '5';
  const refQ = parseInt($<HTMLInputElement>('setupRefQ')?.value ?? '0', 10);
  const refR = parseInt($<HTMLInputElement>('setupRefR')?.value ?? '0', 10);
  if (!Number.isFinite(refQ) || !Number.isFinite(refR)) return null;
  const refMidi = coordToMidi(refQ, refR);
  if (refMidi < MIDI_LOW || refMidi > MIDI_HIGH) return null;
  const layoutReq: LayoutReq = { tuningMode, refQ, refR };
  const hejiEnabled = $<HTMLInputElement>('setupHeji')?.checked ?? false;
  return { title, subtitle, composer, footer, keySig, keyMode, count, unit, tempoBpm, tempoUnit, tempoDots, tempoText, layoutReq, hejiEnabled };
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
  const bEl = $<HTMLInputElement>('setupTempoBpm'); if (bEl) bEl.value = String(model.getTempo().bpm);
  const txt = $<HTMLInputElement>('setupTempoText'); if (txt) txt.value = model.getTempo().text;
  populateDynamicInputs(model);

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
    model.setKeySig(values.keySig);
    model.setKeyMode(values.keyMode);
    model.setTempo(values.tempoBpm, values.tempoUnit, values.tempoDots, values.tempoText);
    applyDynamicInputs(model);
    if (proceedWithLayout) {
      model.setLayoutReq(values.layoutReq);
    }
    model.setHejiEnabled(values.hejiEnabled);
    if (meterChanged && proceedWithMeterChange) {
      model.setTimeSig(values.count, values.unit);
    } else if (meterChanged && !proceedWithMeterChange) {
      /* No-op — keep existing meter. */
    } else {
      /* Same meter — still call setTimeSig to be idempotent. */
      model.setTimeSig(values.count, values.unit);
    }

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
