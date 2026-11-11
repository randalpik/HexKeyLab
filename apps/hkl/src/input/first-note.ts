// The first note of a page load, reported once for usage analytics: which
// input struck it, and the tuning mode and layout in force. It separates a
// visit that played something from one that only opened the page.
//
// Called from the per-note path of every input source, so the guard is a
// plain boolean and nothing is built after the first call.

import { trackOnce } from '@hkl/bridge/analytics.js';
import { tuning } from '../state/tuning.js';

export type NoteSource = 'lumatone' | 'qwerty' | 'piano' | 'pointer';

let reported = false;

export function markFirstNote(source: NoteSource): void {
  if (reported) return;
  reported = true;
  trackOnce('first-note', { source, mode: tuning.mode, mapping: tuning.mapping });
}
