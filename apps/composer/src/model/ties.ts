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
import { meterForMeasure } from '../expressions.js';
import { ticksBeforeInLayer, isGrace } from './ticks.js';

/** Per-voice, time-ordered sequence of atomic tie-able events (note / chord /
 *  rest), descending INTO tuplets so a tuplet's first/last notes are real
 *  adjacency endpoints. Unlike `flatChildren`, this emits no <measure>
 *  wrappers and never treats a <tuplet> as atomic — tie pairing is then pure
 *  musical-time adjacency, which is what ties (incl. cross-barline and
 *  tuplet-edge ties) require. Rests appear as empty slots, correctly breaking
 *  tie chains. */
function tieEventSequence(
  model: ComposerModel, voice: Voice, mLo = 0, mHi = Infinity,
): { events: Element[]; measureOf: number[] } {
  const isEvent = (e: Element): boolean =>
    e.localName === 'note' || e.localName === 'chord' || e.localName === 'rest';
  const events: Element[] = [];
  const measureOf: number[] = [];
  const measures = model.allMeasures();
  const lo = Math.max(0, mLo), hi = Math.min(measures.length - 1, mHi);
  for (let mi = lo; mi <= hi; mi++) {
    const layer = model.layerInMeasure(measures[mi], voice);
    if (!layer) continue;
    let pushed = 0;
    for (const c of Array.from(layer.children)) {
      if (c.localName === 'tuplet') {
        for (const tc of Array.from(c.children)) if (isEvent(tc)) { events.push(tc); measureOf.push(mi); pushed++; }
      } else if (isEvent(c)) {
        /* A grace re-attacks its main note, so no tie crosses it: it is a
           barrier slot (the layer, as for an empty measure below), never a
           tie endpoint. */
        events.push(isGrace(c) ? layer : c); measureOf.push(mi); pushed++;
      }
    }
    /* A measure where this voice has NO content is a gap that must break a tie
       chain (e.g. inserting an empty measure between two tied notes). Push the
       layer as a barrier slot (extractNoteElements → [] resets prevOffers).
       Measures WITH content never add a barrier, so legitimate cross-barline
       ties — where the partner is the next measure's first note — survive. */
    if (pushed === 0) { events.push(layer); measureOf.push(mi); }
  }
  return { events, measureOf };
}

const pitchKey = (n: Element): string =>
  n.getAttribute('pname') + '/' + n.getAttribute('oct') + '/' + getNoteAlter(n);

/** Realize ties for one event slot in the forward walk: read each note's
 *  `wantsForward` intent + the incoming offers, set @tie / @data-tie-partner /
 *  stub, and return this slot's outgoing offers. Mutates `notes`. */
function realizeSlot(
  notes: Element[], nextNotes: Element[], prevOffers: Map<string, Element>,
  wantsForward: WeakMap<Element, boolean>,
): Map<string, Element> {
  const currOffers = new Map<string, Element>();
  for (const note of notes) {
    const pk = pitchKey(note);
    const wasFromPrev = prevOffers.has(pk);
    const wants = wantsForward.get(note) ?? false;
    const partner = wants ? nextNotes.find((n) => pitchKey(n) === pk) : null;
    if (partner) {
      setTieFlag(note, wasFromPrev ? 'm' : 'i');
      const pid = partner.getAttribute('xml:id');
      if (pid) note.setAttribute('data-tie-partner', pid);
      currOffers.set(pk, note);
    } else {
      if (wasFromPrev) setTieFlag(note, 't');
      if (wants) setStubTie(note);
    }
  }
  return currOffers;
}

/** Capture a note's persisted forward-tie intent (the @tie ∈ {i,m} / pending
 *  encoding) BEFORE stripping its realization. */
function captureWants(note: Element): boolean {
  const tie = note.getAttribute('tie');
  return tie === 'i' || tie === 'm' || note.hasAttribute('data-pending-tie');
}

/** Strip realized tie attributes (NOT the intent — intent is re-captured into
 *  `wantsForward` first) and any <lv> stub from one note. */
function stripNote(note: Element, wantsForward: WeakMap<Element, boolean>): void {
  wantsForward.set(note, captureWants(note));
  note.removeAttribute('tie');
  note.removeAttribute('data-pending-tie');
  note.removeAttribute('data-tie-partner');
  removeLvForNote(note);
}

/** Re-realize ties for the WHOLE document, all voices (the original behavior). */
function realizeFull(model: ComposerModel, doc: Document): void {
  for (const lv of Array.from(doc.querySelectorAll('lv'))) lv.parentNode?.removeChild(lv);
  const wantsForward = new WeakMap<Element, boolean>();
  for (const note of Array.from(doc.querySelectorAll('note'))) {
    wantsForward.set(note, captureWants(note));
    note.removeAttribute('tie');
    note.removeAttribute('data-pending-tie');
    note.removeAttribute('data-tie-partner');
  }
  for (let vi = 1; vi <= model.totalVoices(); vi++) {
    const { events } = tieEventSequence(model, vi);
    let prevOffers = new Map<string, Element>();
    for (let k = 0; k < events.length; k++) {
      const notes = extractNoteElements(events[k]);
      const nextNotes = k + 1 < events.length ? extractNoteElements(events[k + 1]) : [];
      prevOffers = realizeSlot(notes, nextNotes, prevOffers, wantsForward);
    }
  }
}

/** Re-realize ties ONLY within measures [lo-1 .. hi+1] per voice (Phase B3).
 *  Tie realization for a note depends only on its immediate neighbor events,
 *  so an edit confined to [lo..hi] can only change realization in that ±1
 *  window. The offer entering the window (from the measure before it) and
 *  exiting it (to the measure after) lie between UNCHANGED measures, so they're
 *  stable: we seed prevOffers from the existing realized @tie on the last event
 *  before the window and re-realize only the window's slots, leaving every
 *  other note untouched. O(window) instead of O(total notes). */
function realizeScoped(model: ComposerModel, lo: number, hi: number): void {
  const wLo = lo - 1, wHi = hi + 1;
  const wantsForward = new WeakMap<Element, boolean>();
  for (let vi = 1; vi <= model.totalVoices(); vi++) {
    /* Build the event sequence for [wLo-1 .. wHi+1] only: the window [wLo..wHi]
       plus one measure each side for the prevOffers seed (the event before the
       window) and the forward lookahead (the event after it). O(window), not
       O(total). */
    const { events, measureOf } = tieEventSequence(model, vi, wLo - 1, wHi + 1);
    // Window = the contiguous run of events whose measure ∈ [wLo..wHi].
    let wStart = events.length, wEnd = -1;
    for (let k = 0; k < events.length; k++) {
      if (measureOf[k] >= wLo && measureOf[k] <= wHi) { if (k < wStart) wStart = k; wEnd = k; }
    }
    if (wEnd < wStart) continue;   // this voice has no events in the window
    // Seed prevOffers from the realized state of the event BEFORE the window —
    // unchanged, so its @tie ∈ {i,m} correctly marks an outstanding forward tie.
    let prevOffers = new Map<string, Element>();
    if (wStart > 0) {
      for (const note of extractNoteElements(events[wStart - 1])) {
        const tie = note.getAttribute('tie');
        if (tie === 'i' || tie === 'm') prevOffers.set(pitchKey(note), note);
      }
    }
    // Capture intent + strip realization for the window's notes only.
    for (let k = wStart; k <= wEnd; k++) for (const note of extractNoteElements(events[k])) stripNote(note, wantsForward);
    // Forward-walk the window, realizing each slot.
    for (let k = wStart; k <= wEnd; k++) {
      const notes = extractNoteElements(events[k]);
      const nextNotes = k + 1 < events.length ? extractNoteElements(events[k + 1]) : [];
      prevOffers = realizeSlot(notes, nextNotes, prevOffers, wantsForward);
    }
  }
}

/** Capture every note's tie-state (+ the <lv> startid set) for the test-mode
 *  consistency gate. */
function captureTieState(doc: Document): string {
  const parts: string[] = [];
  for (const n of Array.from(doc.querySelectorAll('note'))) {
    parts.push((n.getAttribute('xml:id') ?? '?') + ':' +
      (n.getAttribute('tie') ?? '') + ':' +
      (n.getAttribute('data-tie-partner') ?? '') + ':' +
      (n.hasAttribute('data-pending-tie') ? 'p' : ''));
  }
  const lvs = Array.from(doc.querySelectorAll('lv')).map((l) => l.getAttribute('startid') ?? '').sort();
  return parts.join('|') + '#lv#' + lvs.join(',');
}

/** Re-realize tie state after a structural mutation.
 *
 *  `scope` (Phase B3): when the caller knows the edit was confined to measures
 *  [scope.lo .. scope.hi], only that ±1 window is re-realized (O(window)).
 *  Omit it (or pass null) for a full O(total) rebuild — the safe default for
 *  load / snapshot-restore / unconverted callers. In HKL_INDEX_CHECK mode a
 *  scoped pass is followed by a full pass + equality assertion, so the doc
 *  always ends in the full-correct state and any scope bug fails loudly. */
export function normalizeTies(
  model: ComposerModel, scope?: { lo: number; hi: number; insert?: boolean } | null,
): void {
  const doc = model.getDoc();

  if (scope) {
    realizeScoped(model, scope.lo, scope.hi);
    if (indexCheckEnabled()) {
      const scoped = captureTieState(doc);
      realizeFull(model, doc);
      const full = captureTieState(doc);
      if (scoped !== full) {
        throw new Error(
          `[normalizeTies] scoped result ≠ full rebuild for scope {${scope.lo},${scope.hi}} — ` +
          `a converted mutation reported the wrong tie scope.`);
      }
    }
  } else {
    realizeFull(model, doc);
  }

  /* Shared post-mutation hook: drop slurs / fermata / breath / trill controls
     whose @startid anchor was deleted. A spanner is defined in its START
     measure but can reach an endpoint anywhere, so this can't be scoped to the
     edit window without a maintained reverse index — instead build the
     note/chord/rest id-set ONCE (O(total)) and share it across both prunes
     (halving the scan), and SKIP it entirely when the edit only added content
     (`scope?.insert`): an insert can never orphan an existing anchor. */
  if (!(scope && scope.insert)) {
    const ids = new Set<string>();
    for (const n of Array.from(doc.querySelectorAll('note, chord, rest'))) {
      const id = n.getAttribute('xml:id'); if (id) ids.add(id);
    }
    pruneDanglingSlurs(doc, ids);
    pruneDanglingArticControls(doc, ids);
  }
}

function indexCheckEnabled(): boolean {
  return typeof globalThis !== 'undefined' &&
    (globalThis as { __HKL_INDEX_CHECK?: boolean }).__HKL_INDEX_CHECK === true;
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

/** Drop a note's tie intent AND realization (incl. its <lv> stub) — for a
 *  note becoming a grace, which is no tie event at all, so neither pass would
 *  strip it. The neighbors re-realize in the caller's normalizeTies. */
export function clearTieState(note: Element): void {
  note.removeAttribute('tie');
  note.removeAttribute('data-pending-tie');
  note.removeAttribute('data-tie-partner');
  removeLvForNote(note);
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
  const tstamp2 = computeStubTstamp2(note, doc);
  for (const child of Array.from(measure.children)) {
    if (child.localName === 'lv' && child.getAttribute('startid') === target) {
      /* Refresh rather than keep: the end is derived from the note's position
         and the bar's meter, both of which editing (or a file written before
         2026-10-17, when it was computed in the head meter) can leave stale.
         normalizeTies runs on load, so this also repairs saved stubs. */
      if (child.getAttribute('tstamp2') !== tstamp2) child.setAttribute('tstamp2', tstamp2);
      return;
    }
  }
  /* Verovio reads only @endid or @tstamp2 to resolve the end of an <lv>'s
     timespan (verified in src/timeinterface.cpp + src/preparedatafunctor.cpp
     in rism-digital/verovio). @dur is ignored. Pointing @endid at another
     real note would draw a misleading regular tie. We synthesize @tstamp2
     a half-beat past the note's onset, clamped just shy of the bar line,
     giving a short hanging arc. Verovio's Lv::CalculatePosition requires
     start and end to share a measure — by construction, our tstamp2 is
     within the same measure as the note. */
  const lv = doc.createElementNS(MEI_NS, 'lv');
  lv.setAttribute('startid', target);
  lv.setAttribute('tstamp2', tstamp2);
  measure.appendChild(lv);
}

/** Compute a @tstamp2 value (format "0m+B") that lands a half beat past the
 *  given note's onset, clamped to stay just inside the current measure. Beat
 *  unit and bar length are the meter in effect at the note's MEASURE (not the
 *  head scoreDef's), and the onset counts every layer child before the note's
 *  slot — tuplets included, and a slot nested in a tuplet / beam / tremolo
 *  wrapper — via `ticksBeforeInLayer`. (Both were wrong until 2026-10-17:
 *  sonata III m. 89's stub, an eighth chord after a quarter triplet in a 3/4
 *  bar of a cut-time-headed file, ended at 0m+1.5 for a note at beat 3 and
 *  Verovio dropped it — "lv … is ignored, since start does not occur
 *  temporally before end".) */
function computeStubTstamp2(note: Element, doc: Document): string {
  void doc;
  const measure = note.closest('measure');
  const layer = note.closest('layer');
  if (!measure || !layer) return '0m+4';
  const { count, unit } = meterForMeasure(measure);
  /* The note may be inside a <chord>: the slot on the layer's tick line is
     the chord, not the member. */
  const slot = note.parentElement?.localName === 'chord' ? note.parentElement : note;
  const ticks = ticksBeforeInLayer(layer, slot) ?? 0;

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
