// Live-chord staff inset. Renders the currently-held notes as a single
// grand-staff whole-note chord through Verovio (with HEJI accidentals tracking
// the analysis-panel HEJI toggle), into the #staffInset box. Self-gates on the
// "Show staff notation" checkbox; Verovio's WASM is loaded lazily on first
// actual render, so the inset costs nothing until enabled.

import { selection } from '../state/selection.js';
import { tuning } from '../state/tuning.js';
import { resolveNoteSpec, type NoteSpec } from '../tuning/spell.js';
import { buildChordMei } from '../notation/chord-mei.js';
import { renderMeiToContainer } from '../notation/verovio.js';

const EMPTY_HINT = '<span class="staff-inset-hint">No notes held</span>';

let rafScheduled = false;
let renderSeq = 0;

function cbChecked(id: string): boolean {
  const cb = document.getElementById(id) as HTMLInputElement | null;
  return cb?.checked ?? false;
}

/** Re-render the inset to reflect the current held notes. Coalesces bursts of
 *  note-on/off within a frame via requestAnimationFrame. No-op (and no Verovio
 *  load) while the inset is disabled. */
export function renderStaffInset(): void {
  if (!cbChecked('cbStaff')) return;
  const container = document.getElementById('staffInset');
  if (!container) return;
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    void doRender(container);
  });
}

async function doRender(container: HTMLElement): Promise<void> {
  const seq = ++renderSeq;
  const notes: NoteSpec[] = [];
  for (const id of selection.selectedKeys) {
    const ci = id.indexOf(',');
    if (ci < 0) continue;
    const q = +id.slice(0, ci);
    const r = +id.slice(ci + 1);
    if (Number.isFinite(q) && Number.isFinite(r)) notes.push(resolveNoteSpec(q, r));
  }
  if (notes.length === 0) {
    container.innerHTML = EMPTY_HINT;
    return;
  }
  const mei = buildChordMei(notes, tuning.mode, cbChecked('cbHeji'));
  await renderMeiToContainer(mei, container);
  /* A newer render was requested while Verovio was loading — let it own the
     final DOM write so we don't clobber it with stale content. */
  if (seq !== renderSeq) return;
}
