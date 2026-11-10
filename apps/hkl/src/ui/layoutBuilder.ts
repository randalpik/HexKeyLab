// The layout builder: a shallow, non-modal tray above the toolbars, opened by
// "Custom…" at the bottom of the Mapping dropdown. It edits the three
// values a layout is — octave division, shear, invert (docs/architecture.md →
// Note-name mapping) — and every edit switches the live layout at once, so
// the lattice below is the readout. The dialog is opened with show(), not
// showModal(): no backdrop, nothing outside it is blocked.
//
// The tray holds no layout state. Every control is a view of `tuning.mapping`,
// redrawn by syncLayoutBuilder() after each switch (applyMapping calls it), so
// a layout arriving from elsewhere — the Mapping dropdown, a recording,
// Composer, Reset — shows here too. The tray has no preset picker of its own:
// it leaves the toolbar's Mapping dropdown in view, which names the preset
// whenever the three values match one.

import { tuning } from '../state/tuning.js';
import { DIVISIONS, specOf, mappingOf, shearRange, clampShear, type LayoutSpec } from '@hkl/shared/mapping.js';
import { coordToMidi } from '@hkl/shared/freq.js';
import { applyMapping } from './controls.js';

/* An axis step named by its semitone count: the spelling it has inside a band
   where that is one spelling, a neutral name where it is two (a semitone is a
   minor second or an augmented unison, a tritone an augmented fourth or a
   diminished fifth). */
const INTERVAL_NAMES = [
  'unison', 'semitone', 'major second', 'minor third', 'major third', 'perfect fourth', 'tritone',
  'perfect fifth', 'minor sixth', 'major sixth', 'minor seventh', 'major seventh', 'octave',
];
function intervalName(semitones: number): string {
  const size = Math.abs(semitones);
  const name = INTERVAL_NAMES[size] ?? size + ' semitones';
  return semitones < 0 ? 'descending ' + name : name;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Switch to `spec` with its shear clamped to the nearest valid value: a
 *  division or invert change can leave the old shear out of range. */
function apply(spec: LayoutSpec): void {
  applyMapping(mappingOf({ ...spec, shear: clampShear(spec.division, spec.shear, spec.invert) }));
}

/** Redraw every control from the live layout. Cheap, and a no-op while the
 *  tray is closed. */
export function syncLayoutBuilder(): void {
  const dlg = document.getElementById('layoutBuilder') as HTMLDialogElement | null;
  if (!dlg || !dlg.open) return;
  const mapping = tuning.mapping;
  const { division, shear, invert } = specOf(mapping);
  $<HTMLSelectElement>('lbDivision').value = String(division);
  $<HTMLInputElement>('lbInvert').checked = invert;
  const [lo, hi] = shearRange(division, invert);
  $('lbShear').textContent = String(shear).replace('-', '−');
  $<HTMLButtonElement>('lbShearDown').disabled = shear <= lo;
  $<HTMLButtonElement>('lbShearUp').disabled = shear >= hi;
  const step = (dq: number, dr: number): string =>
    intervalName(coordToMidi(dq, dr, mapping) - coordToMidi(0, 0, mapping));
  $('lbRows').textContent = step(1, 0);
  $('lbColumns').textContent = step(0, 1);
  $('lbDiagonal').textContent = step(-1, 1);
}

/** Open the tray on the current layout, changing nothing. */
export function openLayoutBuilder(): void {
  const dlg = document.getElementById('layoutBuilder') as HTMLDialogElement | null;
  if (!dlg) return;
  if (!dlg.open) dlg.show();
  /* show() focuses the first control; a focused select would swallow QWERTY
     note keys (input/keyboard-notes.ts), so hand the focus back */
  (document.activeElement as HTMLElement | null)?.blur();
  syncLayoutBuilder();
}

export function initLayoutBuilderUi(): void {
  const dlg = document.getElementById('layoutBuilder') as HTMLDialogElement | null;
  if (!dlg) return;
  const selDivision = $<HTMLSelectElement>('lbDivision');
  selDivision.replaceChildren(...DIVISIONS.map((d) => new Option(String(d), String(d))));
  const cbInvert = $<HTMLInputElement>('lbInvert');

  /* each control blurs after its edit, like the toolbar's, so QWERTY keys keep
     playing the lattice while the tray is open */
  selDivision.addEventListener('change', () => {
    selDivision.blur();
    apply({ ...specOf(tuning.mapping), division: +selDivision.value });
  });
  cbInvert.addEventListener('change', () => {
    cbInvert.blur();
    apply({ ...specOf(tuning.mapping), invert: cbInvert.checked });
  });
  const stepShear = (btn: HTMLButtonElement, by: number): void => {
    btn.addEventListener('click', () => {
      btn.blur();
      const spec = specOf(tuning.mapping);
      apply({ ...spec, shear: spec.shear + by });
    });
  };
  stepShear($<HTMLButtonElement>('lbShearDown'), -1);
  stepShear($<HTMLButtonElement>('lbShearUp'), 1);
  $('lbClose').addEventListener('click', () => dlg.close());
  /* a non-modal dialog has no Escape of its own, and the focus is rarely
     inside it (the controls blur); a modal on top keeps its own Escape */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dlg.open && !document.querySelector('dialog:modal')) dlg.close();
  });
}
