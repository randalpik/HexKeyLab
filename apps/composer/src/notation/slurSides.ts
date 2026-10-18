// Slur side in two-voice passages (2026-09-05; gate rewritten 2026-10-17).
//
// Max's invariant: a slur is NEVER on the same side as a tuplet bracket, and
// on the same side as the beams only when nothing else is possible. Verovio
// draws tuplet brackets and beams on the STEM side, so the slur belongs on the
// notehead side — which is what Verovio does in a single-voice staff (slur
// opposite the stems; probed), but NOT in a two-voice staff, where it follows
// the layer instead: layer 1 above, layer 2 below, regardless of the stems
// (probed on sonata I m. 78's material — "m. 82" in the 2026-09-05 entries;
// the first movement's numbering has since shifted by four). With Verovio's
// two-voice stems — layer 1 up, layer 2 down — that puts the upper voice's
// slur above its beams AND its brackets. This pass sets `@curvedir` on such
// slurs to the notehead side.
//
// Which staves are "two-voice" is Verovio's own per-moment rule (probed): a
// note's stem follows its LAYER when the other layer holds any element with a
// duration at that moment — a note, a chord, a rest, even a hidden rest — and
// follows the pitch rule when the other layer has only <space> there. So the
// slur's start and end are checked against the other layer's non-space content
// at their moments; if either meets some, the slur is a two-voice slur.
//
// The gate (Max, 2026-10-17): Verovio's own side never collides — a forced
// side is where collisions come from — so the flip carries the burden of
// proof and happens only when it is known to be clear, from pitches and
// onsets alone. Take the slur's farthest own head in the bulge direction (the
// lowest head anywhere under a below-slur, chord members included, across
// barlines); every head of the other layers whose onset lies within the
// slur's span — endpoint columns included — must sit MORE than a fourth
// beyond it (`BLOCK_STEPS`: within 3 diatonic steps blocks, as does any head
// inside the slur's own range). A note that began before the slur has its
// head to the left of it and does not count. Anything closer leaves the slur
// on Verovio's side — above the beam for an upper voice, Finale's fallback
// too. Sonata census, 2026-10-17: 190 two-voice slurs, 179 flipped (the former
// gate — an other-voice head STARTING in an endpoint's column within a THIRD
// of that endpoint — flipped 186); every slur the new gate stops was tight or
// wrong: III mm. 71–72 RH beat 3 (a chord-top a fourth under the start and
// level with the end: no curve fits below, and the flipped slur ran through
// the lower voice), I m. 79 (the chord's b♭2 a unison with the slur's end
// note, nine steps under its start — a LOCAL test would pass it), III m. 83→84
// viola (an a♭4 inside the slur's range; the import had hidden a displaced
// start). The rule is deliberately pitch-only: span and slope would tell a
// long gentle slur from a short steep one, but the wide margin does the same
// job (Max: a simpler, faster rule over one that gets more theoretical cases
// right; the residue is the manual slur / stem flips).
//
// Verovio then routes the flipped slur around whatever else is on that side;
// `render/slurlayout.ts` re-draws a flipped slur it displaces from its
// noteheads — in practice one broken at a system break, since a same-column
// head close enough to shift an endpoint now also refuses the flip.
//
// Explicit `@curvedir` (none is written by Composer today) and explicit
// `@stem.dir` on the endpoints are respected: a note stemmed by hand gets the
// side opposite its own stem. Cross-staff and cross-layer slurs are left to
// Verovio. Runs on the render clone only.

import { realTicks } from '../model/ticks.js';

/** Other-voice heads within this many diatonic steps (inclusive) of the
 *  slur's farthest own head on the flip side refuse the flip. 3 = a fourth. */
const BLOCK_STEPS = 3;
const EPS = 1e-6;

interface Slot { el: Element; layer: Element; staff: Element; t0: number; t1: number }

const isVoid = (el: Element): boolean => el.localName === 'space' || el.localName === 'mSpace';
/** Layer children that carry noteheads. */
const HEADED = new Set(['note', 'chord', 'fTrem', 'bTrem']);

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
        found = true; return true;      // el inside chord/fTrem/bTrem etc.: take the wrapper's position
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
const headsOf = (el: Element): Element[] =>
  el.localName === 'note' ? [el] : Array.from(el.querySelectorAll('note'));

/** Every timed child of a layer, beams and tuplets unwrapped, with its onset
 *  (`mRest` / `mSpace` fill the measure). */
function walkSlots(layer: Element, cb: (el: Element, t0: number) => void): void {
  let t = 0;
  const walk = (parent: Element): void => {
    for (const c of Array.from(parent.children)) {
      if (c.localName === 'beam' || c.localName === 'tuplet') { walk(c); continue; }
      cb(c, t);
      if (c.localName !== 'mRest' && c.localName !== 'mSpace') t += realTicks(c);
    }
  };
  walk(layer);
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

/** The slur's own heads from `a` to `b` inclusive, and the other layers' heads
 *  whose onset falls within that span (endpoint columns included), across the
 *  measures between — staff and layer matched by NUMBER, since a slur across a
 *  barline has its endpoints in two <staff> elements of one staff. Null when
 *  the endpoints' measures cannot be ordered. */
function spanHeads(measureIndex: Map<Element, number>, measures: Element[], a: Slot, b: Slot): { own: Element[]; other: Element[] } | null {
  const ma = a.staff.closest('measure'), mb = b.staff.closest('measure');
  if (!ma || !mb) return null;
  const ia = measureIndex.get(ma), ib = measureIndex.get(mb);
  if (ia === undefined || ib === undefined || ib < ia) return null;
  const staffN = a.staff.getAttribute('n'), layerN = a.layer.getAttribute('n');
  const own: Element[] = [], other: Element[] = [];
  for (let i = ia; i <= ib; i++) {
    const lo = i === ia ? a.t0 - EPS : -Infinity, hi = i === ib ? b.t0 + EPS : Infinity;
    for (const st of Array.from(measures[i].children)) {
      if (st.localName !== 'staff' || st.getAttribute('n') !== staffN) continue;
      for (const ly of Array.from(st.children)) {
        if (ly.localName !== 'layer') continue;
        const into = ly.getAttribute('n') === layerN ? own : other;
        walkSlots(ly, (el, t0) => {
          if (HEADED.has(el.localName) && t0 >= lo && t0 <= hi) into.push(...headsOf(el));
        });
      }
    }
  }
  return { own, other };
}

/** Stem direction Verovio will give a slot in a two-voice context, unless the
 *  slot (or its first note) says otherwise. */
function stemDirOf(slot: Slot): 'up' | 'down' {
  const explicit = slot.el.getAttribute('stem.dir') ?? slot.el.querySelector(':scope > note[stem\\.dir]')?.getAttribute('stem.dir');
  if (explicit === 'up' || explicit === 'down') return explicit;
  return slot.layer.getAttribute('n') === '1' ? 'up' : 'down';
}

/** Put every two-voice slur on the notehead side when that side is known to
 *  be clear (see module comment). */
export function settleSlurSides(doc: Document): void {
  const slurs = Array.from(doc.querySelectorAll('slur'));
  if (!slurs.length) return;
  const index = new Map<string, Element>();
  for (const el of Array.from(doc.querySelectorAll('note, chord'))) {
    const id = el.getAttribute('xml:id');
    if (id) index.set(id, el);
  }
  const measures = Array.from(doc.querySelectorAll('measure'));
  const measureIndex = new Map<Element, number>(measures.map((m, i) => [m, i]));
  for (const slur of slurs) {
    if (slur.hasAttribute('curvedir')) continue;
    const sid = slur.getAttribute('startid')?.replace(/^#/, '');
    const eid = slur.getAttribute('endid')?.replace(/^#/, '');
    if (!sid || !eid) continue;
    const a = slotOf(doc, sid, index), b = slotOf(doc, eid, index);
    if (!a || !b) continue;
    if (a.staff.getAttribute('n') !== b.staff.getAttribute('n') || a.layer.getAttribute('n') !== b.layer.getAttribute('n')) continue;   // cross-staff / cross-layer: Verovio's call
    if (!otherLayerHasContentAt(a) && !otherLayerHasContentAt(b)) continue;   // single-voice: Verovio already goes opposite the stems
    const dir = stemDirOf(a);
    const heads = spanHeads(measureIndex, measures, a, b);
    if (!heads) continue;
    const ownSteps = heads.own.map(stepOf).filter((v): v is number => v !== null);
    if (!ownSteps.length) continue;
    /* The farthest own head on the flip side; an other-voice head less than
       `BLOCK_STEPS` beyond it — or inside the slur's range (negative) — is a
       collision the flip would cause, so the slur stays on Verovio's side. */
    const ext = dir === 'up' ? Math.min(...ownSteps) : Math.max(...ownSteps);
    const blocked = heads.other.some((n) => {
      const v = stepOf(n);
      return v !== null && (dir === 'up' ? ext - v : v - ext) <= BLOCK_STEPS;
    });
    if (blocked) continue;
    slur.setAttribute('curvedir', dir === 'up' ? 'below' : 'above');
  }
}
