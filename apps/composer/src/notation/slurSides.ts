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
// The flip is skipped when the other layer's content INTRUDES on the notehead
// side: when, over the slur's span, that content reaches more than
// `SLUR_INTRUSION_STEPS` past the slur layer's extreme notehead on that side —
// noteheads plus a stem pointing that way. Verovio does not decline a
// @curvedir; it routes the slur around whatever is there, and the further the
// obstacle reaches the further the slur's endpoints are carried away from
// their notes (sonata m. 83, 2026-09-05: the lower voice's half-note chord
// b1+b2, stem down, reached 14 steps below the upper voice's lowest slurred
// note, and the flipped slur was drawn from the chord's lower notehead
// scooping 75 px under the staff while the beam side was free). Pitch overlap
// alone is not the criterion: m. 82's and m. 84's other voice is an unstemmed
// whole-note chord whose notes interleave with the slurred ones (span room −5
// and −12) yet reaches only 3 steps past them (m. 82) or not at all (m. 84),
// and both flipped slurs render cleanly (Max, 2026-09-05). The slur then
// stays on Verovio's side — the beam side, which the invariant allows when
// nothing else is possible.
//
// Explicit `@curvedir` (none is written by Composer today) and explicit
// `@stem.dir` on the endpoints are respected: a note stemmed by hand gets the
// side opposite its own stem. Cross-staff and cross-layer slurs are left to
// Verovio. Runs on the render clone only.

import { realTicks } from '../model/ticks.js';

interface Slot { el: Element; layer: Element; staff: Element; t0: number; t1: number }

const isVoid = (el: Element): boolean => el.localName === 'space' || el.localName === 'mSpace';

/* How far, in diatonic steps (half a staff space each), the other layer's
   content may reach past the slur layer's extreme notehead on the notehead side
   before the flip is skipped. Measured on the sonata: m. 82 → 3 and m. 84 → −5
   (flipped, clean), the two-voice fixture → 7 (flipped), m. 81 → 11 and
   m. 83 → 14 (routed far from their notes). A first setting for Max to tune. */
const SLUR_INTRUSION_STEPS = 8;
/* A stem's reach beyond its extreme notehead: Verovio's default length, 3.5
   spaces. Beams and flags may add a little; a whole note has none. */
const STEM_STEPS = 7;

/** A note's vertical position as a diatonic step count (octave × 7 + letter);
 *  accidentals do not move a notehead. Null for an unpitched element. */
function stepOf(n: Element): number | null {
  const p = n.getAttribute('pname'), o = n.getAttribute('oct');
  if (!p || !o) return null;
  const i = 'cdefgab'.indexOf(p[0].toLowerCase());
  const oct = parseInt(o, 10);
  return i < 0 || !Number.isFinite(oct) ? null : oct * 7 + i;
}

/** The pitched elements (notes and chords) of `layer`'s content overlapping the
 *  tick span (t0, t1), descending through beams and tuplets. */
function pitchedOverlapping(layer: Element, t0: number, t1: number): Element[] {
  const out: Element[] = [];
  const walk = (parent: Element, t: number): number => {
    for (const c of Array.from(parent.children)) {
      if (c.localName === 'beam' || c.localName === 'tuplet') { t = walk(c, t); if (t >= t1) break; continue; }
      const d = c.localName === 'mRest' || c.localName === 'mSpace' ? Infinity : realTicks(c);
      if (d > 0 && !isVoid(c) && t < t1 && t + d > t0 && (c.localName === 'note' || c.localName === 'chord' || c.querySelector('note'))) out.push(c);
      if (d !== Infinity) t += d;
      if (t >= t1) break;
    }
    return t;
  };
  walk(layer, 0);
  return out;
}

/** The notehead steps of a pitched element (a note, or every note of a chord /
 *  tremolo wrapper). */
const stepsOf = (el: Element): number[] =>
  (el.localName === 'note' ? [el] : Array.from(el.querySelectorAll('note'))).map(stepOf).filter((v): v is number => v !== null);

/** Does Verovio draw a stem on this element? Whole notes and longer have none;
 *  an explicit zero-length or invisible stem counts as none. */
function hasStem(el: Element): boolean {
  const dur = el.getAttribute('dur') ?? el.querySelector('note')?.getAttribute('dur');
  if (!dur || dur === '1' || dur === 'breve' || dur === 'long' || dur === 'maxima') return false;
  if (el.getAttribute('stem.len') === '0' || el.getAttribute('stem.visible') === 'false') return false;
  return true;
}

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
    if (a.staff !== b.staff || a.layer !== b.layer) continue;      // cross-staff / cross-layer: Verovio's call
    if (!otherLayerHasContentAt(a) && !otherLayerHasContentAt(b)) continue;   // single-voice: Verovio already goes opposite the stems
    const dir = stemDirOf(a);
    /* Intrusion on the notehead side (see SLUR_INTRUSION_STEPS): how far the
       other layers' content over the slur's span — noteheads, plus a stem that
       points that way — reaches past the slur layer's extreme notehead there. */
    const T0 = Math.min(a.t0, b.t0), T1 = Math.max(a.t1, b.t1);
    const own = pitchedOverlapping(a.layer, T0, T1).flatMap(stepsOf);
    if (own.length) {
      const ownExtreme = dir === 'up' ? Math.min(...own) : Math.max(...own);
      let intrusion = -Infinity;
      for (const other of Array.from(a.staff.children)) {
        if (other.localName !== 'layer' || other === a.layer) continue;
        for (const el of pitchedOverlapping(other, T0, T1)) {
          const steps = stepsOf(el);
          if (!steps.length) continue;
          const explicit = el.getAttribute('stem.dir') ?? el.querySelector(':scope > note[stem\\.dir]')?.getAttribute('stem.dir');
          const otherDir = explicit === 'up' || explicit === 'down' ? explicit : (other.getAttribute('n') === '1' ? 'up' : 'down');
          if (dir === 'up') {
            const reach = Math.min(...steps) - (hasStem(el) && otherDir === 'down' ? STEM_STEPS : 0);
            intrusion = Math.max(intrusion, ownExtreme - reach);
          } else {
            const reach = Math.max(...steps) + (hasStem(el) && otherDir === 'up' ? STEM_STEPS : 0);
            intrusion = Math.max(intrusion, reach - ownExtreme);
          }
        }
      }
      if (intrusion > SLUR_INTRUSION_STEPS) continue;
    }
    slur.setAttribute('curvedir', dir === 'up' ? 'below' : 'above');
  }
}
