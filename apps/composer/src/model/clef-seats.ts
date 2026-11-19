// Clef seats (2026-11-18, decisions.md "a clef belongs to the staff").
//
// A clef governs its whole staff (notation/staffclefs.ts); the layer it is
// stored in is only its SEAT — the structure it sits on. This module keeps
// the seats honest after every structural mutation. It runs at the end of
// `ComposerModel.normalizePlaceholdersAll`, the one pass every content edit
// already ends with (the placeholder invariant enforces that), once the
// layers have settled, so no edit path knows about clefs.
//
// A clef's MOMENT is its measure plus either a tick (exact — model/ticks.ts
// `Frac`) or "the tail": the trailing clef run after everything in the layer,
// which is the barline clef in its stored spelling (model/clef-slot.ts).
//
// The pass, per staff cell touched by the edit:
//
//   1. STAY OR MOVE (Max, 2026-11-18). A clef sits among one voice's notes, so
//      an insert or delete in that voice carries it along. "When a note is
//      edited in a given measure, its clefs need to evaluate whether they
//      would be orphaned if they didn't move. If the non-edited voice has a
//      structure the clef can stay on, it does, otherwise it moves with the
//      edited voice." A clef whose moment differs from the one remembered at
//      the last pass has been carried; if another voice of the staff still
//      has a BOUNDARY at the remembered moment it is put back there, and
//      otherwise it stays where the edit left it. A boundary is a position a
//      cursor of that voice reaches outside a tuplet: in front of a note,
//      chord, rest, tremolo or tuplet, the fill point of a partial measure
//      (its first trailing placeholder), or the tail.
//   2. CANONICAL SEAT. The clef moves to the lowest-numbered layer of the
//      staff that has a boundary at its moment, so entering it from either
//      voice writes the same document.
//   3. Identical adjacent clefs collapse to one (what the MusicXML importer
//      used to write into every layer; a clef followed at once by the same
//      clef says nothing).
//   4. The moments are remembered for the next pass. The memory is a WeakMap
//      keyed by element, not document state: a load, an undo or a redo brings
//      new elements, which simply have nothing to compare against.
//
// A clef is never left where no cursor reaches it: it always sits in front of
// an element of its seat, or in the tail.

import { layerTimeline } from '../notation/staffclefs.js';
import { fracCmp, FRAC_ZERO, type Frac } from './ticks.js';

export interface ClefMoment {
  measure: Element;
  /** In the trailing clef run of its layer: the barline after the measure. */
  tail: boolean;
  /** Position in the seat's tick line (unused for a tail). */
  at: Frac;
}

interface Boundary { tail: boolean; at: Frac; ref: Element | null }

const remembered = new WeakMap<Element, ClefMoment>();

const isPlaceholderSpace = (el: Element): boolean =>
  el.localName === 'space' && el.getAttribute('data-placeholder') === 'true';

const BOUNDED = new Set(['note', 'chord', 'rest', 'space', 'fTrem', 'bTrem']);

const layersOf = (staff: Element): Element[] =>
  Array.from(staff.children).filter((c) => c.localName === 'layer')
    .sort((a, b) => (parseInt(a.getAttribute('n') ?? '1', 10) || 1) - (parseInt(b.getAttribute('n') ?? '1', 10) || 1));

/** The positions of `layer` a clef can sit at, in order: in front of each
 *  direct timed child and each tuplet, the fill point (the FIRST trailing
 *  placeholder only — the later ones are not cursor positions), and the tail.
 *  One boundary per onset: the first element there (a clef goes in front of a
 *  grace run, where a tick lands). */
function boundariesOf(layer: Element): Boundary[] {
  const onset = new Map<Element, Frac>();
  const { items, end } = layerTimeline(layer);
  for (const it of items) if (it.kind === 'event') onset.set(it.el, it.at);
  const out: Boundary[] = [];
  let sawPlaceholder = false;
  const add = (at: Frac | undefined, ref: Element): void => {
    if (at === undefined) return;
    if (out.some((b) => fracCmp(b.at, at) === 0)) return;
    out.push({ tail: false, at, ref });
  };
  for (const c of Array.from(layer.children)) {
    const ln = c.localName;
    if (ln === 'tuplet') {
      const first = items.find((it) => it.kind === 'event' && c.contains(it.el));
      add(first?.at, c);
    } else if (BOUNDED.has(ln)) {
      if (isPlaceholderSpace(c)) { if (sawPlaceholder) continue; sawPlaceholder = true; }
      add(onset.get(c), c);
    }
  }
  out.push({ tail: true, at: end, ref: null });
  return out;
}

const boundaryAt = (layer: Element, m: { tail: boolean; at: Frac }): Boundary | null =>
  boundariesOf(layer).find((b) => (m.tail ? b.tail : !b.tail && fracCmp(b.at, m.at) === 0)) ?? null;

/** Where a clef is: its measure, and the tail or its tick. Null for a clef
 *  that is not a direct child of a layer in a measure. */
export function clefMomentOf(clef: Element): ClefMoment | null {
  const layer = clef.parentElement;
  if (!layer || layer.localName !== 'layer') return null;
  const measure = layer.closest('measure');
  if (!measure) return null;
  let tail = true;
  for (let s = clef.nextElementSibling; s; s = s.nextElementSibling) if (s.localName !== 'clef') { tail = false; break; }
  if (tail) return { measure, tail: true, at: FRAC_ZERO };
  const it = layerTimeline(layer).items.find((x) => x.el === clef);
  return it ? { measure, tail: false, at: it.at } : null;
}

const sameMoment = (a: ClefMoment, b: ClefMoment): boolean =>
  a.measure === b.measure && a.tail === b.tail && (a.tail || fracCmp(a.at, b.at) === 0);

function seatAt(clef: Element, layer: Element, b: Boundary): void {
  if (b.ref) layer.insertBefore(clef, b.ref); else layer.appendChild(clef);
}

const specKey = (el: Element): string =>
  [el.getAttribute('shape'), el.getAttribute('line'), el.getAttribute('dis'), el.getAttribute('dis.place')].map((v) => v ?? '').join('|');

const staffOf = (measure: Element, n: string): Element | null =>
  Array.from(measure.children).find((s) => s.localName === 'staff' && (s.getAttribute('n') ?? '1') === n) ?? null;

/** The clefs seated in OTHER layers of `staff` at the moment `m` — the rest of
 *  what a cursor at that moment addresses (model/clef-slot.ts). Document order. */
export function otherLayerClefsAt(staff: Element, own: Element | null, m: { tail: boolean; at: Frac }): Element[] {
  const out: Element[] = [];
  for (const layer of Array.from(staff.children)) {
    if (layer.localName !== 'layer' || layer === own) continue;
    for (const c of Array.from(layer.children)) {
      if (c.localName !== 'clef') continue;
      const cm = clefMomentOf(c);
      if (cm && cm.tail === m.tail && (m.tail || fracCmp(cm.at, m.at) === 0)) out.push(c);
    }
  }
  return out;
}

/** Settle the seats of the clefs in the staff cells of `scope` (the layers an
 *  edit touched; null = the whole document — a load, an undo, the clef
 *  dialog). `dry` changes nothing and returns how many changes a real pass
 *  would make (the HKL_INDEX_CHECK proof that a scoped pass missed none).
 *  `deliberate` is for a write that placed clefs on purpose (the clef dialog,
 *  the range command — which also respells a barline clef from the next
 *  measure's head to this one's tail): nothing was carried, so step 1 is
 *  skipped and the clefs are only seated and remembered where they were put.
 *  Returns the number of clefs moved or removed. */
export function normalizeClefSeats(
  doc: Document, scope: Iterable<Element> | null, opts: { dry?: boolean; deliberate?: boolean } = {},
): number {
  const dry = opts.dry === true;
  const cells = new Set<Element>();
  if (scope) {
    for (const layer of scope) {
      if (layer.isConnected === false || layer.ownerDocument !== doc) continue;
      const staff = layer.parentElement;
      if (staff && staff.localName === 'staff' && staff.querySelector('clef')) cells.add(staff);
    }
  } else {
    for (const c of Array.from(doc.querySelectorAll('layer > clef'))) {
      const staff = c.parentElement!.parentElement;
      if (staff && staff.localName === 'staff') cells.add(staff);
    }
  }
  if (cells.size === 0) return 0;
  const clefsIn = (staff: Element): Element[] => Array.from(staff.querySelectorAll(':scope > layer > clef'));
  let changes = 0;

  /* 1. Stay or move. */
  for (const staff of opts.deliberate ? [] : Array.from(cells)) {
    for (const clef of clefsIn(staff)) {
      const prev = remembered.get(clef);
      if (!prev || prev.measure.isConnected === false) continue;
      const cur = clefMomentOf(clef);
      if (!cur || sameMoment(prev, cur)) continue;
      const seatN = clef.parentElement!.getAttribute('n') ?? '1';
      const home = staffOf(prev.measure, staff.getAttribute('n') ?? '1');
      if (!home) continue;
      for (const layer of layersOf(home)) {
        if ((layer.getAttribute('n') ?? '1') === seatN) continue;      // the edited voice carried it
        const b = boundaryAt(layer, prev);
        if (!b) continue;
        changes++;
        if (!dry) { seatAt(clef, layer, b); cells.add(home); }
        break;
      }
    }
  }

  /* 2. Canonical seat, in document order so clefs of one moment keep theirs. */
  for (const staff of cells) {
    const layers = layersOf(staff);
    if (layers.length < 2) continue;
    for (const clef of clefsIn(staff)) {
      const cur = clefMomentOf(clef);
      if (!cur) continue;
      for (const layer of layers) {
        const b = boundaryAt(layer, cur);
        if (!b) continue;
        /* Across layers only: within its own layer a clef stays exactly where
           it is (in front of or behind a grace run is the user's choice, and
           one tick). */
        if (clef.parentElement !== layer) { changes++; if (!dry) seatAt(clef, layer, b); }
        break;
      }
    }
  }

  /* 3. Identical adjacent clefs are one clef. */
  for (const staff of cells) {
    for (const clef of clefsIn(staff)) {
      const before = clef.previousElementSibling;
      if (before && before.localName === 'clef' && before.isConnected !== false && specKey(before) === specKey(clef)) {
        changes++;
        if (!dry) clef.remove();
      }
    }
  }

  /* 4. Remember. */
  if (!dry) {
    for (const staff of cells) {
      for (const clef of clefsIn(staff)) {
        const m = clefMomentOf(clef);
        if (m) remembered.set(clef, m);
      }
    }
  }
  return changes;
}
