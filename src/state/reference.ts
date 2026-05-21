// Reference-note state. Defines the lattice cell that piano-keyboard 12-TET
// input is resolved against.
//
// Default: (0, 0) = A3. Composer-driven updates (when connected) carry the
// most-recent-prior-to-cursor pitch and arrive over the bridge. On Composer
// disconnect / composer-bye, the state resets to default. The Piano-MIDI
// handler READS this — it never writes; Composer is the sole authority when
// connected.

export interface ReferenceNoteState {
  q: number;
  r: number;
  source: 'default' | 'composer';
}

export const referenceNote: ReferenceNoteState = {
  q: 0,
  r: 0,
  source: 'default',
};

export function setReferenceFromComposer(q: number, r: number): boolean {
  if (referenceNote.q === q && referenceNote.r === r && referenceNote.source === 'composer') {
    return false;
  }
  referenceNote.q = q;
  referenceNote.r = r;
  referenceNote.source = 'composer';
  return true;
}

export function resetReferenceToDefault(): boolean {
  if (referenceNote.q === 0 && referenceNote.r === 0 && referenceNote.source === 'default') {
    return false;
  }
  referenceNote.q = 0;
  referenceNote.r = 0;
  referenceNote.source = 'default';
  return true;
}
