// Slur side in two-voice passages (2026-09-05).
//
// Max's invariant: a slur is NEVER on the same side as a tuplet bracket, and
// on the same side as the beams only when nothing else is possible. Verovio
// draws tuplet brackets and beams on the STEM side, so the slur belongs on the
// notehead side — which is what Verovio does in a single-voice staff (slur
// opposite the stems; probed), but NOT in a two-voice staff, where it follows
// the layer instead: layer 1 above, layer 2 below, regardless of the stems
// (probed on sonata m. 82's material). With Verovio's two-voice stems — layer 1
// up, layer 2 down — that puts the upper voice's slur above its beams AND its
// brackets (m. 82, m. 84). This pass sets `@curvedir` on such slurs to the
// notehead side. Verovio's own routing then keeps the arc clear of the other
// voice's notes.
//
// Which staves are "two-voice" is Verovio's own per-moment rule (probed): a
// note's stem follows its LAYER when the other layer holds any element with a
// duration at that moment — a note, a chord, a rest, even a hidden rest — and
// follows the pitch rule when the other layer has only <space> there. So the
// slur's start and end are checked against the other layer's non-space content
// at their moments; if either meets some, the slur is a two-voice slur.
//
// Verovio then routes the flipped slur around whatever else is on that side —
// including the other layer's noteheads in the slur's own start column, which
// carry its start point below them instead of letting it begin between the
// voices (sonata m. 83). `render/slurlayout.ts` redraws such displaced slurs
// from the rendered geometry; a pitch-based gate here was tried and withdrawn
// (Max, 2026-09-05: there is room under the notes, moving the slur up is
// unnecessary and puts it over tuplet brackets).
//
// Explicit `@curvedir` (none is written by Composer today) and explicit
// `@stem.dir` on the endpoints are respected: a note stemmed by hand gets the
// side opposite its own stem. Cross-staff and cross-layer slurs are left to
// Verovio. Runs on the render clone only.

import { realTicks } from '../model/ticks.js';

interface Slot { el: Element; layer: Element; staff: Element; t0: number; t1: number }

const isVoid = (el: Element): boolean => el.localName === 'space' || el.localName === 'mSpace';

/** The slot (note or chord) carrying `id`, with its layer/staff and its tick
 *  span within its layer. Null when the id resolves to nothing or to an
 *  element outside a layer. */
function slotOf(doc: Document, id: string, index: Map<string, Element>): Slot | null {
  const el = index.get(id);
  if (!el) return null;
  const layer = el.closest('layer');
  const staff = el.closest('staff');
  if (!layer || !staff) return null;
  /* Tick position of the top-level ancestor of `el` within the layer (a note
     inside a beam or tuplet sits at its wrapper's position plus the ticks of
     its earlier siblings). */
  let t = 0;
  let found = false;
  const walk = (parent: Element): boolean => {
    for (const c of Array.from(parent.children)) {
      if (c === el || c.contains(el)) {
        if (c === el) { found = true; return true; }
        if (c.localName === 'beam' || c.localName === 'tuplet') {
          const save = t;
          if (walk(c)) return true;
          t = save + realTicks(c);
          continue;
        }
        found = true; return true;      // el inside fTrem/bTrem etc.: take the wrapper's position
      }
      t += realTicks(c);
    }
    return false;
  };
  walk(layer);
  if (!found) return null;
  return { el, layer, staff, t0: t, t1: t + realTicks(el) };
}

/** A note's vertical position as a diatonic step count (octave × 7 + letter). */
function stepOf(n: Element): number | null {
  const p = n.getAttribute('pname'), o = n.getAttribute('oct');
  if (!p || !o) return null;
  const i = 'cdefgab'.indexOf(p[0].toLowerCase()), oct = parseInt(o, 10);
  return i < 0 || !Number.isFinite(oct) ? null : oct * 7 + i;
}
const stepsOf = (el: Element): number[] =>
  (el.localName === 'note' ? [el] : Array.from(el.querySelectorAll('note'))).map(stepOf).filter((v): v is number => v !== null);

/** The notes (chord members included) of the OTHER layers that START at the
 *  slot's onset — the noteheads sharing its column. A note that began earlier
 *  and is still sounding has its head far to the left (m. 83's chord under the
 *  slur's START never touches its END note). */
function otherLayerOnsetsAt(slot: Slot): Element[] {
  const out: Element[] = [];
  for (const other of Array.from(slot.staff.children)) {
    if (other.localName !== 'layer' || other === slot.layer) continue;
    let t = 0;
    const walk = (parent: Element): void => {
      for (const c of Array.from(parent.children)) {
        if (c.localName === 'beam' || c.localName === 'tuplet') { walk(c); continue; }
        const d = c.localName === 'mRest' || c.localName === 'mSpace' ? Infinity : realTicks(c);
        if (d > 0 && !isVoid(c) && Math.abs(t - slot.t0) < 1e-6) out.push(...(c.localName === 'note' ? [c] : Array.from(c.querySelectorAll('note'))));
        if (d !== Infinity) t += d;
        if (t > slot.t0) break;
      }
    };
    walk(other);
  }
  return out;
}

/** True when the OTHER layer of the slot's staff has a non-space element
 *  overlapping the slot's span — Verovio then stems the slot by layer. */
function otherLayerHasContentAt(slot: Slot): boolean {
  for (const other of Array.from(slot.staff.children)) {
    if (other.localName !== 'layer' || other === slot.layer) continue;
    let t = 0;
    for (const c of Array.from(other.children)) {
      const d = c.localName === 'mRest' || c.localName === 'mSpace' ? Infinity : realTicks(c);
      if (d > 0 && !isVoid(c) && t < slot.t1 && t + d > slot.t0) return true;
      if (d !== Infinity) t += d;
      if (t >= slot.t1) break;
    }
  }
  return false;
}

/** Stem direction Verovio will give a slot in a two-voice context, unless the
 *  slot (or its first note) says otherwise. */
function stemDirOf(slot: Slot): 'up' | 'down' {
  const explicit = slot.el.getAttribute('stem.dir') ?? slot.el.querySelector(':scope > note[stem\\.dir]')?.getAttribute('stem.dir');
  if (explicit === 'up' || explicit === 'down') return explicit;
  return slot.layer.getAttribute('n') === '1' ? 'up' : 'down';
}

/** Put every two-voice slur on the notehead side (see module comment). */
export function settleSlurSides(doc: Document): void {
  const slurs = Array.from(doc.querySelectorAll('slur'));
  if (!slurs.length) return;
  const index = new Map<string, Element>();
  for (const el of Array.from(doc.querySelectorAll('note, chord'))) {
    const id = el.getAttribute('xml:id');
    if (id) index.set(id, el);
  }
  for (const slur of slurs) {
    if (slur.hasAttribute('curvedir')) continue;
    const sid = slur.getAttribute('startid')?.replace(/^#/, '');
    const eid = slur.getAttribute('endid')?.replace(/^#/, '');
    if (!sid || !eid) continue;
    const a = slotOf(doc, sid, index), b = slotOf(doc, eid, index);
    if (!a || !b) continue;
    /* Compare staff / layer NUMBERS, not elements: a slur that crosses a barline
       has its endpoints in two <staff> elements of the same staff (p. 17, 2026-09-05). */
    if (a.staff.getAttribute('n') !== b.staff.getAttribute('n') || a.layer.getAttribute('n') !== b.layer.getAttribute('n')) continue;   // cross-staff / cross-layer: Verovio's call
    if (!otherLayerHasContentAt(a) && !otherLayerHasContentAt(b)) continue;   // single-voice: Verovio already goes opposite the stems
    const dir = stemDirOf(a);
    /* The notehead side is IMPOSSIBLE at an endpoint whose other-voice
       neighbour touches it on that side — a note STARTING in the same column,
       a unison, a second or a third away: a notehead is a staff space tall, so
       heads a third apart already overlap (sonata m. 52→53: the lower voice's
       downbeat a third under the slur's end note). No slur end fits between touching noteheads, so this is the
       "unavoidable" of Max's invariant: the slur stays on Verovio's side. A
       fourth (half a space of daylight) is left to the re-draw's tight retry. */
    const blocked = (slot: Slot): boolean => {
      const own = stepsOf(slot.el);
      if (!own.length) return false;
      const ext = dir === 'up' ? Math.min(...own) : Math.max(...own);
      return otherLayerOnsetsAt(slot).some((n) => {
        const v = stepOf(n);
        return v !== null && (dir === 'up' ? v <= ext && v >= ext - 2 : v >= ext && v <= ext + 2);
      });
    };
    if (blocked(a) || blocked(b)) continue;
    slur.setAttribute('curvedir', dir === 'up' ? 'below' : 'above');
  }
}
