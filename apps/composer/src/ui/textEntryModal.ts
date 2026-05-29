// Reusable text-entry modal shell. Extracted from setupDialog.ts's native
// <dialog> lifecycle (method="dialog" auto-close, automatic focus-trap +
// Escape, listener cleanup on `close`). Unlike setupDialog — which drives a
// fixed form baked into index.html — this builds its fields dynamically into a
// single shared <dialog id="textEntryDialog">, so multiple features (expressive
// text now; tempo in 2.3; clef/sig later) reuse one shell.
//
// The shell is model-agnostic: it collects field values and hands them to the
// caller's onOk, which owns all model mutation + history. Enter submits (OK is
// the only submit button); Escape / Cancel dismiss without calling onOk.

export type TextEntryField =
  | { name: string; type: 'text'; label: string; value?: string; placeholder?: string }
  | { name: string; type: 'check'; label: string; value?: boolean };

export interface TextEntryModalOpts {
  title: string;
  fields: TextEntryField[];
  /** Quick-insert chips that set the FIRST text field's value (e.g. pizz/arco).
   *  Click or keyboard-activate to fill, then edit/submit. */
  presets?: string[];
  okLabel?: string;
  /** Called with field values keyed by `name` when the user confirms (OK /
   *  Enter). Not called on Cancel / Escape. */
  onOk: (values: Record<string, string | boolean>) => void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

function fieldRowHtml(f: TextEntryField): string {
  if (f.type === 'check') {
    return `<label class="row"><span>${esc(f.label)}</span>`
      + `<span><input type="checkbox" data-field="${esc(f.name)}"></span></label>`;
  }
  return `<label class="row"><span>${esc(f.label)}</span>`
    + `<input type="text" autocomplete="off" data-field="${esc(f.name)}"`
    + (f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '') + `></label>`;
}

/** Open the shared text-entry modal. Builds the form, seeds values, focuses the
 *  first text field, and wires submit / cancel / cleanup. */
export function openTextEntryModal(opts: TextEntryModalOpts): void {
  const dlg = document.getElementById('textEntryDialog') as HTMLDialogElement | null;
  if (!dlg) return;

  const presetsHtml = opts.presets && opts.presets.length > 0
    ? `<div class="row"><span>Common</span><fieldset class="te-presets">`
      + opts.presets.map((p) => `<button type="button" class="te-preset" data-preset="${esc(p)}">${esc(p)}</button>`).join('')
      + `</fieldset></div>`
    : '';

  dlg.innerHTML =
    `<form method="dialog">`
    + `<h2>${esc(opts.title)}</h2>`
    + opts.fields.map(fieldRowHtml).join('')
    + presetsHtml
    + `<div class="actions">`
    + `<button type="button" class="te-cancel">Cancel</button>`
    + `<button type="submit" value="ok" class="te-ok">${esc(opts.okLabel ?? 'OK')}</button>`
    + `</div></form>`;

  const form = dlg.querySelector('form') as HTMLFormElement | null;
  const fieldEl = (name: string): HTMLInputElement | null =>
    dlg.querySelector(`[data-field="${CSS.escape(name)}"]`) as HTMLInputElement | null;

  /* Seed initial values. */
  for (const f of opts.fields) {
    const el = fieldEl(f.name);
    if (!el) continue;
    if (f.type === 'check') el.checked = !!f.value;
    else el.value = f.value ?? '';
  }

  const firstText = opts.fields.find((f) => f.type === 'text');

  /* Preset chips fill the first text field, then refocus it for editing. */
  const onPresetClick = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest('.te-preset') as HTMLButtonElement | null;
    if (!btn || !firstText) return;
    const el = fieldEl(firstText.name);
    if (el) { el.value = btn.dataset.preset ?? ''; el.focus(); el.select(); }
  };
  dlg.querySelector('.te-presets')?.addEventListener('click', onPresetClick);

  const cancelBtn = dlg.querySelector('.te-cancel') as HTMLButtonElement | null;
  const onCancel = (): void => dlg.close();
  cancelBtn?.addEventListener('click', onCancel);

  const onSubmit = (e: SubmitEvent): void => {
    const submitter = e.submitter as HTMLButtonElement | null;
    if (submitter?.value !== 'ok') return;
    const values: Record<string, string | boolean> = {};
    for (const f of opts.fields) {
      const el = fieldEl(f.name);
      values[f.name] = f.type === 'check' ? !!el?.checked : (el?.value ?? '');
    }
    opts.onOk(values);
  };
  form?.addEventListener('submit', onSubmit);

  /* Cleanup on close (covers OK submit, Cancel, and Escape). Clearing innerHTML
     drops all the per-open listeners with the nodes they were bound to. */
  const onClose = (): void => {
    form?.removeEventListener('submit', onSubmit);
    cancelBtn?.removeEventListener('click', onCancel);
    dlg.removeEventListener('close', onClose);
    dlg.innerHTML = '';
  };
  dlg.addEventListener('close', onClose);

  dlg.returnValue = '';
  dlg.showModal();
  /* Focus the first text field for immediate typing. */
  if (firstText) fieldEl(firstText.name)?.focus();
}
