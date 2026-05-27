/**
 * Help modal — read-only keybinding reference. Content is built from
 * KEYBINDINGS in ./keybindings.ts on first open and cached thereafter.
 * The dialog uses native <dialog>.showModal(), inheriting focus trap +
 * Escape-to-close from the browser. No keystroke suppression in input.ts
 * is needed: the showModal focus trap keeps keydown out of the document.
 */

import type { KeyBinding, KeySection } from './keybindings.js';
import { KEYBINDINGS } from './keybindings.js';

let rendered = false;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderBinding(b: KeyBinding): string {
  const note = b.note ? `<div class="help-note">${esc(b.note)}</div>` : '';
  return `<kbd class="help-keys">${esc(b.keys)}</kbd><div class="help-desc">${esc(b.desc)}${note}</div>`;
}

function renderSection(s: KeySection): string {
  const intro = s.intro ? `<p class="help-intro">${esc(s.intro)}</p>` : '';
  const rows = s.bindings.map(renderBinding).join('');
  return `<section class="help-section">
    <h3>${esc(s.title)}</h3>
    ${intro}
    <div class="help-grid">${rows}</div>
  </section>`;
}

function renderHelpHtml(sections: KeySection[]): string {
  const body = sections.map(renderSection).join('');
  return `<h2>Keybindings</h2>
<div class="help-body">${body}</div>
<form method="dialog" class="actions"><button type="submit" id="helpClose">Close</button></form>`;
}

export function openHelpDialog(): void {
  const dlg = document.getElementById('helpDialog') as HTMLDialogElement | null;
  if (!dlg) return;
  if (!rendered) {
    dlg.innerHTML = renderHelpHtml(KEYBINDINGS);
    rendered = true;
  }
  dlg.showModal();
}
