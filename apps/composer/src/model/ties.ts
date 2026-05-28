/* Tie normalization: a single pass that strips realization from every note,
 * reads per-note `wantsForward` intent, and rebuilds the realization in a
 * forward walk per voice. Idempotent.
 *
 * The intent/realization split:
 *   INTENT (per-note, persisted across mutations):
 *     `wantsForward` — encoded as @tie ∈ {i,m} OR @data-pending-tie="true".
 *   REALIZATION (derived from intent + current flat order):
 *     @tie — MEI 5 value (i|m|t) on each tied note.
 *     @data-tie-partner — forward xml:id reference (each tied note points
 *       to the next member of its chain); the terminal has none.
 *     @data-pending-tie — set only when intent exists but no partner.
 *     <lv> — visual hanging arc for pending stubs.
 *
 * Replaces the old `orphanTiePartners` (pre-deletion partner cleanup) and
 * `resolvePendingTies` (post-insert stub resolution) — both were partial and
 * asymmetric. Callers run this once AFTER any structural mutation;
 * correctness no longer depends on cleanup-before-deletion. */

import { getNoteAlter } from '@hkl/notation/accidentals.js';
import { extractNoteElements } from './note-elements.js';
import { MEI_NS, type ComposerModel, type Voice } from './index.js';
import { pruneDanglingSlurs } from '../slurs.js';
import { pruneDanglingArticControls } from '../articulations.js';

export function normalizeTies(model: ComposerModel): void {
  const doc = model.getDoc();
  /* Strip every <lv> — we'll re-create them for surviving stubs. The
   * only <lv> producer in the codebase is our stub machinery. */
  for (const lv of Array.from(doc.querySelectorAll('lv'))) {
    lv.parentNode?.removeChild(lv);
  }

  /* Pass 1: snapshot per-note `wantsForward` intent and strip realized
   * tie attributes from every note. Doing this globally (across all
   * voices) keeps the per-voice forward walk simple. */
  const wantsForward = new WeakMap<Element, boolean>();
  for (const note of Array.from(doc.querySelectorAll('note'))) {
    const tie = note.getAttribute('tie');
    const pending = note.hasAttribute('data-pending-tie');
    wantsForward.set(note, tie === 'i' || tie === 'm' || pending);
    note.removeAttribute('tie');
    note.removeAttribute('data-pending-tie');
    note.removeAttribute('data-tie-partner');
  }

  /* Pass 2: per voice, walk flat order and rebuild realization. */
  const pitchKey = (n: Element): string =>
    n.getAttribute('pname') + '/' + n.getAttribute('oct') + '/' + getNoteAlter(n);

  for (let vi: Voice = 1; vi <= 4; vi = (vi + 1) as Voice) {
    const flat = model.flatChildren(vi);
    /* For each cursor between two flat slots, prevOffers[pitchKey] is the
     * note in the previous slot that wantsForward at that pitch — i.e.,
     * the "incoming-tie source" for any matching note in the current
     * slot. Reset on every slot transition. */
    let prevOffers = new Map<string, Element>();
    for (let k = 0; k < flat.length; k++) {
      const notes = extractNoteElements(flat[k]);
      const nextNotes =
        k + 1 < flat.length ? extractNoteElements(flat[k + 1]) : [];
      const currOffers = new Map<string, Element>();

      for (const note of notes) {
        const pk = pitchKey(note);
        const wasFromPrev = prevOffers.has(pk);
        const wants = wantsForward.get(note) ?? false;
        const partner = wants ? nextNotes.find((n) => pitchKey(n) === pk) : null;
        const canForward = !!partner;

        if (canForward && partner) {
          /* Realized: this note ties forward (and possibly backward). */
          setTieFlag(note, wasFromPrev ? 'm' : 'i');
          const pid = partner.getAttribute('xml:id');
          if (pid) note.setAttribute('data-tie-partner', pid);
          currOffers.set(pk, note);
        } else {
          /* No realizable forward tie. Two independent axes:
           *   - If we had incoming (wasFromPrev): set @tie="t" so the
           *     incoming arc still renders (terminal of the prev chain).
           *   - If the user expressed forward intent (wants) that we
           *     couldn't realize: preserve it as a pending stub. The
           *     two can coexist on the SAME note: @tie="t" renders the
           *     incoming arc, and <lv> + data-pending-tie render the
           *     outgoing hanging stub. */
          if (wasFromPrev) setTieFlag(note, 't');
          if (wants) setStubTie(note);
        }
      }

      prevOffers = currOffers;
    }
  }

  /* This is the shared post-mutation hook (run after every structural edit),
   * so it's also the natural place to drop slurs whose endpoint slots were
   * deleted — same rationale as the tie-orphan cleanup above. */
  pruneDanglingSlurs(doc);
  /* Also prune <fermata> / <breath> control events whose @startid anchor
     was deleted. These bind to specific notes/chords/rests by xml:id and
     are appended as measure children alongside slurs. */
  pruneDanglingArticControls(doc);
}

/* ── per-note tie helpers ──────────────────────────────────────────────── */

/** Set the @tie attribute to a single MEI 5 value. data.TIE is i|m|t|n;
 *  there is NO compound form. Callers that need both "incoming and outgoing"
 *  semantics should pass 'm' directly. */
export function setTieFlag(note: Element, value: 'i' | 'm' | 't'): void {
  note.setAttribute('tie', value);
}

/** Remove any tie marker from this note. */
export function clearTieFlag(note: Element): void {
  note.removeAttribute('tie');
}

/** Mark a note as a stub tie:
 *    - data-pending-tie drives our auto-resolve on later inserts.
 *    - A <lv> control element (laissez vibrer) is added as a child of the
 *      enclosing <measure>, with @startid pointing to the note. */
function setStubTie(note: Element): void {
  note.setAttribute('data-pending-tie', 'true');
  ensureLvForNote(note);
}

/** Add a <lv startid="#noteId"/> child to the enclosing <measure> if one
 *  for this note doesn't already exist. */
function ensureLvForNote(note: Element): void {
  const id = note.getAttribute('xml:id');
  if (!id) return;
  const doc = note.ownerDocument;
  if (!doc) return;
  const measure = note.closest('measure');
  if (!measure) return;
  const target = '#' + id;
  for (const child of Array.from(measure.children)) {
    if (child.localName === 'lv' && child.getAttribute('startid') === target) return;
  }
  /* Verovio reads only @endid or @tstamp2 to resolve the end of an <lv>'s
     timespan (verified in src/timeinterface.cpp + src/preparedatafunctor.cpp
     in rism-digital/verovio). @dur is ignored. Pointing @endid at another
     real note would draw a misleading regular tie. We synthesize @tstamp2
     a half-beat past the note's onset, clamped just shy of the bar line,
     giving a short hanging arc. Verovio's Lv::CalculatePosition requires
     start and end to share a measure — by construction, our tstamp2 is
     within the same measure as the note. */
  const tstamp2 = computeStubTstamp2(note, doc);
  const lv = doc.createElementNS(MEI_NS, 'lv');
  lv.setAttribute('startid', target);
  lv.setAttribute('tstamp2', tstamp2);
  measure.appendChild(lv);
}

/** Compute a @tstamp2 value (format "0m+B") that lands a half beat past the
 *  given note's onset, clamped to stay just inside the current measure. */
function computeStubTstamp2(note: Element, doc: Document): string {
  const sd = doc.querySelector('scoreDef');
  const count = parseInt(sd?.getAttribute('meter.count') ?? '4', 10);
  const unit = parseInt(sd?.getAttribute('meter.unit') ?? '4', 10);

  const layer = note.closest('layer');
  if (!layer) return '0m+' + count;
  /* The note may be inside a <chord>; walk up until the immediate child of
     <layer> (which is the note/chord/rest at this timeline position). */
  let container: Element | null = note;
  while (container && container.parentElement !== layer) {
    container = container.parentElement;
  }
  if (!container) return '0m+' + count;

  /* Sum 64th-note ticks of preceding sibling content. */
  let ticks = 0;
  for (const c of Array.from(layer.children)) {
    if (c === container) break;
    if (c.localName !== 'chord' && c.localName !== 'note' && c.localName !== 'rest') continue;
    const dur = c.getAttribute('dur');
    const dots = parseInt(c.getAttribute('dots') ?? '0', 10);
    const denom = dur ? parseInt(dur, 10) : NaN;
    if (!Number.isFinite(denom) || denom <= 0) continue;
    const base = 64 / denom;
    ticks += dots === 1 ? base * 1.5 : dots === 2 ? base * 1.75 : base;
  }

  /* 1 beat = (64 / meter.unit) ticks. Beats are 1-indexed. */
  const ticksPerBeat = 64 / unit;
  const startBeat = ticks / ticksPerBeat + 1;
  const cap = count + 0.95;
  const endBeat = Math.min(startBeat + 0.5, cap);
  return '0m+' + endBeat.toFixed(3).replace(/\.?0+$/, '');
}

/** Remove any <lv> whose @startid points at this note. */
function removeLvForNote(note: Element): void {
  const id = note.getAttribute('xml:id');
  if (!id) return;
  const measure = note.closest('measure');
  if (!measure) return;
  const target = '#' + id;
  for (const child of Array.from(measure.children)) {
    if (child.localName === 'lv' && child.getAttribute('startid') === target) {
      measure.removeChild(child);
    }
  }
}
