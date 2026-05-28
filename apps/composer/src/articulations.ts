// Articulation marks attached to notes / chords. Routed by kind:
//
//   stacc, acc, ten  → `<artic @artic="…">` child of the owning <note>
//                      or <chord>. Containment-based: auto-removed when
//                      the parent deletes. Verovio renders dots, accent
//                      wedges, tenuto bars natively.
//
//   fermata          → `<fermata @startid="#noteId">` sibling of <staff>
//                      in the measure. Verovio refuses @artic="fermata"
//                      ("Unsupported value 'fermata' for data.ARTICULATION")
//                      — the fermata arch is a separate MEI element.
//
//   breath           → `<breath @startid="#noteId">` sibling of <staff>
//                      in the measure. Same reasoning as fermata; also
//                      semantically "after the note" rather than on it.
//
// The xml:id-bound siblings (fermata, breath) need a dangling-prune hook
// when their anchor note disappears — call `pruneDanglingArticControls`
// from the shared post-mutation hook (slurs.ts has the same machinery).
//
// Playback shaping (velocity boost for accent, duration trim for staccato,
// hold for fermata, pause for breath) lives in `render/playback.ts` and
// uses `articulationsOn(slot)` to read every kind in one call.

import { realTicks } from './model/ticks.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Logical articulation identifier — internal, decoupled from MEI encoding. */
export type ArticKind = 'stacc' | 'accent' | 'ten' | 'fermata' | 'breath';

/** Logical kind → MEI @artic value (only for the `<artic>`-encoded subset). */
const ARTIC_ATTR_VALUE: Record<'stacc' | 'accent' | 'ten', string> = {
  stacc: 'stacc',
  accent: 'acc',
  ten: 'ten',
};

let nextSeq = 3_000_000;
function newId(prefix: string): string {
  nextSeq++;
  return prefix + '-' + nextSeq.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

function stripHash(v: string | null): string | null {
  if (!v) return null;
  return v.charAt(0) === '#' ? v.slice(1) : v;
}

/* ── note-attached <artic> child (stacc, acc, ten) ───────────────────── */

function hasArticChild(parent: Element, value: string): boolean {
  for (const c of Array.from(parent.children)) {
    if (c.localName === 'artic' && c.getAttribute('artic') === value) return true;
  }
  return false;
}

function addArticChild(parent: Element, value: string): void {
  for (const c of Array.from(parent.children)) {
    if (c.localName === 'artic' && c.getAttribute('artic') === value) return;
  }
  const doc = parent.ownerDocument!;
  const el = doc.createElementNS(MEI_NS, 'artic');
  el.setAttributeNS(XML_NS, 'xml:id', newId('a'));
  el.setAttribute('artic', value);
  parent.appendChild(el);
}

function removeArticChild(parent: Element, value: string): void {
  for (const c of Array.from(parent.children)) {
    if (c.localName === 'artic' && c.getAttribute('artic') === value) {
      parent.removeChild(c);
    }
  }
}

/* ── sibling-of-staff control events (fermata, breath) ────────────────── */

/** Find a sibling control event in `measure` anchored to the given note id.
 *  Fermatas use @startid (overlay above the note); breath marks use a marker
 *  attribute `data-hkl-anchor` because Verovio's @tstamp encoding loses the
 *  source-note linkage (we need the linkage to toggle / prune). */
function findSibling(measure: Element, localName: string, anchorId: string): Element | null {
  for (const c of Array.from(measure.children)) {
    if (c.localName !== localName) continue;
    if (stripHash(c.getAttribute('startid')) === anchorId) return c;
    if (c.getAttribute('data-hkl-anchor') === anchorId) return c;
  }
  return null;
}

/** Compute (tstamp, staff) at the END of the given note/chord, used for
 *  positioning a breath mark BETWEEN this note and its successor. */
function computeEndOfNoteTstamp(note: Element): { tstamp: number; staff: number } | null {
  const slot = note.parentElement?.localName === 'chord' ? note.parentElement : note;
  if (!slot) return null;
  const measure = slot.closest('measure');
  const layer = slot.closest('layer');
  const staff = slot.closest('staff');
  if (!measure || !layer || !staff) return null;
  const staffN = parseInt(staff.getAttribute('n') ?? '1', 10);
  let ticksBefore = 0;
  for (const c of Array.from(layer.children)) {
    if (c === slot) break;
    if (c.localName === 'note' || c.localName === 'chord' || c.localName === 'rest' || c.localName === 'tuplet') {
      ticksBefore += realTicks(c);
    }
  }
  const noteTicks = realTicks(slot);
  const sd = note.ownerDocument!.querySelector('scoreDef');
  const unit = parseInt(sd?.getAttribute('meter.unit') ?? '4', 10);
  const ticksPerBeat = 64 / unit;
  const endTicks = ticksBefore + noteTicks;
  /* MEI tstamp is 1-indexed; place the breath slightly INSIDE the
     anchor note (~5% of note length back from its end) so it visually
     sits between the note's release and the next attack rather than
     hugging the next note. Tuned empirically — bigger offsets push the
     comma uncomfortably far back; smaller offsets crowd the next note. */
  const offsetTicks = noteTicks * 0.05;
  const endBeat = (endTicks - offsetTicks) / ticksPerBeat + 1;
  return { tstamp: endBeat, staff: staffN };
}

function addSibling(measure: Element, localName: 'fermata' | 'breath', anchorEl: Element): void {
  const doc = measure.ownerDocument!;
  const anchorId = anchorEl.getAttribute('xml:id');
  if (!anchorId) return;
  const el = doc.createElementNS(MEI_NS, localName);
  el.setAttributeNS(XML_NS, 'xml:id', newId(localName.charAt(0)));
  if (localName === 'fermata') {
    /* Anchors to the note via @startid — Verovio renders the arch above. */
    el.setAttribute('startid', '#' + anchorId);
  } else {
    /* Breath at END of note (per spec): @tstamp positioned between this
       note and its successor. Keep `data-hkl-anchor` so toggle/prune can
       round-trip without scanning by tstamp. */
    const pos = computeEndOfNoteTstamp(anchorEl);
    if (!pos) return;
    el.setAttribute('tstamp', String(pos.tstamp.toFixed(3)));
    el.setAttribute('staff', String(pos.staff));
    el.setAttribute('data-hkl-anchor', anchorId);
  }
  measure.appendChild(el);
}

function removeSibling(measure: Element, localName: string, anchorId: string): void {
  const el = findSibling(measure, localName, anchorId);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

/* ── public API ───────────────────────────────────────────────────────── */

/** True iff `parent` carries the articulation `kind`. For artic-encoded
 *  kinds (stacc/acc/ten) this looks for a child element; for sibling
 *  kinds (fermata/breath) it walks the measure for a matching control
 *  event keyed on the parent's xml:id. */
export function hasArticulation(parent: Element, kind: ArticKind): boolean {
  if (kind === 'fermata' || kind === 'breath') {
    const anchorId = parent.getAttribute('xml:id');
    const measure = parent.closest('measure');
    if (!anchorId || !measure) return false;
    return findSibling(measure, kind, anchorId) !== null;
  }
  return hasArticChild(parent, ARTIC_ATTR_VALUE[kind]);
}

/** Toggle an articulation. Returns the new state (true = on, false = off). */
export function toggleArticulation(parent: Element, kind: ArticKind): boolean {
  if (kind === 'fermata' || kind === 'breath') {
    const anchorId = parent.getAttribute('xml:id');
    const measure = parent.closest('measure');
    if (!anchorId || !measure) return false;
    if (findSibling(measure, kind, anchorId)) {
      removeSibling(measure, kind, anchorId);
      return false;
    }
    addSibling(measure, kind, parent);
    return true;
  }
  const v = ARTIC_ATTR_VALUE[kind];
  if (hasArticChild(parent, v)) {
    removeArticChild(parent, v);
    return false;
  }
  addArticChild(parent, v);
  return true;
}

/** All articulation kinds present on `parent`. Reads from the artic-encoded
 *  child set AND from sibling control events anchored to `parent`'s xml:id. */
export function articulationsOn(parent: Element): ArticKind[] {
  const out: ArticKind[] = [];
  for (const c of Array.from(parent.children)) {
    if (c.localName !== 'artic') continue;
    const v = c.getAttribute('artic');
    if (v === 'stacc') out.push('stacc');
    else if (v === 'acc') out.push('accent');
    else if (v === 'ten') out.push('ten');
  }
  const anchorId = parent.getAttribute('xml:id');
  const measure = parent.closest('measure');
  if (anchorId && measure) {
    for (const c of Array.from(measure.children)) {
      const linked = stripHash(c.getAttribute('startid')) === anchorId
                  || c.getAttribute('data-hkl-anchor') === anchorId;
      if (!linked) continue;
      if (c.localName === 'fermata') out.push('fermata');
      else if (c.localName === 'breath') out.push('breath');
    }
  }
  return out;
}

/** Remove every `<fermata>` / `<breath>` whose @startid no longer resolves
 *  to a slot element. Mirrors `pruneDanglingSlurs`. Returns the count. */
export function pruneDanglingArticControls(doc: Document): number {
  let removed = 0;
  for (const el of Array.from(doc.querySelectorAll('fermata, breath'))) {
    const anchorId = stripHash(el.getAttribute('startid'))
                  ?? el.getAttribute('data-hkl-anchor');
    if (!anchorId) { el.parentNode?.removeChild(el); removed++; continue; }
    let found = false;
    for (const n of Array.from(doc.querySelectorAll('note, chord, rest'))) {
      if (n.getAttribute('xml:id') === anchorId) { found = true; break; }
    }
    if (!found) { el.parentNode?.removeChild(el); removed++; }
  }
  return removed;
}
