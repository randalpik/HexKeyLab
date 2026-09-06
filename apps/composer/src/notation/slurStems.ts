// One stem direction under a slur (2026-09-05).
//
// Max: a slurred group should try to make all its stems face one way. In a
// single-voice staff Verovio stems each note (chord, beam) by its own pitch
// against the middle line, so a slur over a line that crosses the middle
// covers stems pointing both ways — and Verovio then puts the slur ABOVE, on
// the beams and tuplet brackets of the up-stemmed notes (sonata: 104 of 918
// measured slurs, 71 on a beam and 22 on a bracket). Unifying the stems removes the
// conflict: Verovio places a single-voice slur opposite unified stems, so the
// slur lands on the notehead side by itself and no `@curvedir` is written.
//
// The pass runs on the render clone, after beaming and before
// `settleSlurSides`. Per slur — longest first, so a phrase slur decides for
// the shorter slurs under it — it predicts each covered unit's natural
// direction from pitch (a lone note: down at or above the middle line; a
// chord or a beam: by its notes farthest above and below the middle — down
// when the top is at least as far as the bottom; ties down, as Verovio's —
// calibrated on the sonata's single-voice beams, 899/899, where a mean rule
// missed 8), takes the majority over the covered notes
// (a tie goes to the note farthest from the middle), and writes `@stem.dir` on
// every note and chord of the group's units — the whole beam, when a beam
// reaches past the slur, since a beam's members must agree (probed: Verovio
// ignores `@stem.dir` on the `<beam>` element itself and flips the beam when
// every note carries it). A covered note in a TWO-VOICE moment (non-space
// content in another layer at its moment) has its stem forced by Verovio's
// layer rule — layer 1 up, layer 2 down — and that forced direction is a
// fixed vote for the whole group: a slur from a single-voice triplet across
// the barline to a note the second voice forces up (sonata III m. 3→4, LH)
// otherwise got the triplet's down stems under a slur the side pass had
// flipped below, i.e. a slur through the stems — unacceptable under any
// circumstance (Max, 2026-09-05). Skipped: cross-staff notes, grace notes,
// slurs with an explicit `@curvedir`, and groups whose minority notes sit
// more than `CAP_STEPS` off the middle line (their forced stems would be too
// long: a note 3 spaces above the middle with an up stem) — but not when a
// fixed vote decides the group, since the alternative there is the slur
// through the stems. An explicit `@stem.dir` (the `L` key), a direction
// already fixed by a longer slur, or a layer-forced direction is respected:
// it decides the group's direction, and a group whose fixed directions
// disagree is left alone. Each slur the pass judged is tagged `@hkl-stems`
// (unified-up / unified-down / capped / fixed; `data-hkl-stems` in the SVG)
// for the census probe; nothing touches the saved document.

import { realTicks } from '../model/ticks.js';
import { stepOf, middleSteps } from './staffpos.js';

type Dir = 'up' | 'down';

/** Minority notes farther than this from the middle line (in steps — half
 *  spaces) leave the group's stems as Verovio set them. 5 steps = 2.5 spaces. */
const CAP_STEPS = 5;

const isSlot = (el: Element): boolean => el.localName === 'note' || el.localName === 'chord';
const isVoid = (el: Element): boolean => el.localName === 'space' || el.localName === 'mSpace';
const isUnitWrapper = (el: Element): boolean => el.localName === 'beam' || el.localName === 'fTrem' || el.localName === 'bTrem';

interface Span { el: Element; t0: number; t1: number }

/** The slots (notes / chords) of a layer with their tick spans, in order;
 *  `onlyContent` also returns rests (for the other-layer content test). A
 *  tremolo's members share the wrapper's span. */
function flattenLayer(layer: Element, onlyContent: boolean): Span[] {
  const out: Span[] = [];
  const walk = (parent: Element, t: number): number => {
    for (const c of Array.from(parent.children)) {
      const ln = c.localName;
      if (ln === 'beam' || ln === 'tuplet') { t = walk(c, t); continue; }
      if (ln === 'fTrem' || ln === 'bTrem') {
        const d = realTicks(c);
        for (const s of Array.from(c.children)) if (isSlot(s)) out.push({ el: s, t0: t, t1: t + d });
        t += d;
        continue;
      }
      const d = ln === 'mRest' || ln === 'mSpace' ? Infinity : realTicks(c);
      if (d > 0) {
        if (isSlot(c) || (onlyContent && !isVoid(c))) out.push({ el: c, t0: t, t1: t + d });
        if (d !== Infinity) t += d;
      }
    }
    return t;
  };
  walk(layer, 0);
  return out;
}

/** The unit a slot stems with: its outermost beam / tremolo below the layer, else itself. */
function unitOf(slot: Element): Element {
  let unit = slot;
  for (let p = slot.parentElement; p && p.localName !== 'layer'; p = p.parentElement) if (isUnitWrapper(p)) unit = p;
  return unit;
}

/** The note and chord elements a unit stems (chord members excluded). */
function slotsIn(unit: Element): Element[] {
  if (isSlot(unit)) return [unit];
  return Array.from(unit.querySelectorAll('note, chord')).filter((e) => e.localName === 'chord' || e.closest('chord') === null);
}

interface Unit {
  el: Element;
  slots: Element[];
  /** Every note's distance from the middle line in steps (up positive). */
  ds: number[];
  natural: Dir;
  fixed: Dir | null;   // explicit @stem.dir, a direction a longer slur already wrote, or the layer rule in a two-voice moment
}

interface Covered { slots: Element[]; forced: Set<Element>; layerDir: Dir }

const explicitDir = (slot: Element): Dir | null => {
  const v = slot.getAttribute('stem.dir') ?? (slot.localName === 'chord' ? slot.querySelector(':scope > note[stem\\.dir]')?.getAttribute('stem.dir') : null);
  return v === 'up' || v === 'down' ? v : null;
};

export function unifySlurStems(doc: Document): void {
  const slurs = Array.from(doc.querySelectorAll('slur')).filter((s) => !s.hasAttribute('curvedir'));
  if (!slurs.length) return;
  const index = new Map<string, Element>();
  for (const el of Array.from(doc.querySelectorAll('note, chord'))) {
    const id = el.getAttribute('xml:id');
    if (id) index.set(id, el);
  }
  const measures = Array.from(doc.querySelectorAll('measure'));
  const measureIdx = new Map<Element, number>(measures.map((m, i) => [m, i]));
  const mids = middleSteps(doc);
  const layerCache = new Map<Element, Span[]>();
  const contentCache = new Map<Element, Span[]>();
  const spansOf = (layer: Element, content: boolean): Span[] => {
    const cache = content ? contentCache : layerCache;
    let v = cache.get(layer);
    if (!v) { v = flattenLayer(layer, content); cache.set(layer, v); }
    return v;
  };

  /* Covered slots per slur: same staff and layer NUMBER (a slur across a
     barline has its ends in two <staff> elements of one staff), start to end
     in layer order across measures; `forced` holds the slots in a two-voice
     moment, whose stems Verovio sets by layer (`layerDir`). Null when the
     slur is not this pass's: unresolved ends, cross-staff / cross-layer, a
     cross-staff or grace note, an unpitched staff. */
  const covered = (slur: Element): Covered | null => {
    const sid = slur.getAttribute('startid')?.replace(/^#/, ''), eid = slur.getAttribute('endid')?.replace(/^#/, '');
    const a = sid ? index.get(sid) : undefined, b = eid ? index.get(eid) : undefined;
    if (!a || !b) return null;
    const aStaff = a.closest('staff'), bStaff = b.closest('staff'), aLayer = a.closest('layer'), bLayer = b.closest('layer');
    if (!aStaff || !bStaff || !aLayer || !bLayer) return null;
    const sn = aStaff.getAttribute('n'), lyn = aLayer.getAttribute('n');
    if (sn !== bStaff.getAttribute('n') || lyn !== bLayer.getAttribute('n')) return null;
    const m0 = measureIdx.get(aStaff.closest('measure')!), m1 = measureIdx.get(bStaff.closest('measure')!);
    if (m0 === undefined || m1 === undefined || m1 < m0) return null;
    const out: Element[] = [], forced = new Set<Element>();
    const layerDir: Dir = lyn === '1' ? 'up' : 'down';
    let started = false;
    for (let mi = m0; mi <= m1; mi++) {
      const staff = Array.from(measures[mi].children).find((c) => c.localName === 'staff' && c.getAttribute('n') === sn);
      if (!staff) continue;
      const layer = Array.from(staff.children).find((c) => c.localName === 'layer' && c.getAttribute('n') === lyn);
      if (!layer) continue;
      const others = Array.from(staff.children).filter((c) => c.localName === 'layer' && c !== layer).flatMap((l) => spansOf(l, true));
      for (const s of spansOf(layer, false)) {
        if (s.el === a || s.el.contains(a)) started = true;
        if (started) {
          if (s.el.hasAttribute('grace') || s.el.hasAttribute('staff') || !mids.has(s.el.localName === 'note' ? s.el : s.el.querySelector('note') ?? s.el)) return null;
          if (others.some((o) => o.t0 < s.t1 && o.t1 > s.t0)) forced.add(s.el);   // two-voice moment: Verovio stems by layer
          out.push(s.el);
        }
        if (s.el === b || s.el.contains(b)) return started ? { slots: out, forced, layerDir } : null;
      }
    }
    return null;   // end never reached
  };

  const groups = slurs.map((slur) => ({ slur, cov: covered(slur) })).filter((g): g is { slur: Element; cov: Covered } => !!g.cov && g.cov.slots.length > 1);
  groups.sort((x, y) => y.cov.slots.length - x.cov.slots.length);

  const assigned = new Map<Element, Dir>();
  for (const { slur, cov: { slots, forced, layerDir } } of groups) {
    /* Units, each once, with every note's distance from the middle line. */
    const units: Unit[] = [];
    const seen = new Set<Element>();
    let bad = false;
    for (const slot of slots) {
      const u = unitOf(slot);
      if (seen.has(u)) continue;
      seen.add(u);
      const us = slotsIn(u);
      const ds: number[] = [];
      let fixed: Dir | null = null, conflict = false;
      for (const s of us) {
        const f = explicitDir(s) ?? assigned.get(s) ?? (forced.has(s) ? layerDir : null);
        if (f) { if (fixed && fixed !== f) conflict = true; fixed = f; }
        for (const n of (s.localName === 'note' ? [s] : Array.from(s.querySelectorAll('note')))) {
          const st = stepOf(n), mid = mids.get(n);
          if (st === null || mid === undefined) { bad = true; continue; }
          ds.push(st - mid);
        }
      }
      if (conflict || !ds.length) { bad = true; break; }
      /* Verovio's rule for a chord and for a beam alike: the extreme notes
         decide (probed on the sonata: 899 of 899 single-voice beams, 655 of
         655 chords; a mean rule missed 8 beams — sonata II m. 57 LH,
         b♭4 e♭5 b4 a♭4 g4 a4 in treble, is down by the extremes ±3). */
      const natural: Dir = Math.max(...ds) >= -Math.min(...ds) ? 'down' : 'up';
      units.push({ el: u, slots: us, ds, natural, fixed });
    }
    if (bad) continue;
    const fixedDirs = new Set(units.map((u) => u.fixed).filter((d): d is Dir => !!d));
    if (fixedDirs.size > 1) { slur.setAttribute('hkl-stems', 'fixed'); continue; }
    const dirOf = (u: Unit): Dir => u.fixed ?? u.natural;
    if (units.every((u) => dirOf(u) === dirOf(units[0]))) continue;   // already one way: Verovio's stems stand
    let chosen: Dir;
    if (fixedDirs.size === 1) chosen = [...fixedDirs][0];
    else {
      /* Majority over the covered slots (a beam's slots each vote its
         direction); a tie goes to the note farthest from the middle. */
      const under = new Set(slots);
      let up = 0, down = 0;
      for (const u of units) for (const s of u.slots) if (under.has(s)) { if (u.natural === 'up') up++; else down++; }
      if (up !== down) chosen = up > down ? 'up' : 'down';
      else {
        let far = -1, farDir: Dir = 'down';
        for (const u of units) for (const d of u.ds) if (Math.abs(d) > far) { far = Math.abs(d); farDir = u.natural; }
        chosen = farDir;
      }
    }
    /* The cap: a minority unit whose extreme note on the stem side is farther
       than CAP_STEPS from the middle would get too long a stem. Not when a
       fixed vote decided: leaving that group mixed puts the slur through the
       stems of the notes that disagree with the fixed one. */
    const tooFar = fixedDirs.size === 0 && units.some((u) => dirOf(u) !== chosen && (chosen === 'up' ? Math.max(...u.ds) > CAP_STEPS : Math.min(...u.ds) < -CAP_STEPS));
    if (tooFar) { slur.setAttribute('hkl-stems', 'capped'); continue; }
    for (const u of units) for (const s of u.slots) {
      if (!explicitDir(s)) s.setAttribute('stem.dir', chosen);
      assigned.set(s, chosen);
    }
    slur.setAttribute('hkl-stems', 'unified-' + chosen);
  }
}
