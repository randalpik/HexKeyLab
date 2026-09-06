// Render-clone rest placement (2026-09-04, two-voice rule 2026-09-06).
//
// Verovio positions a rest in a two-layer staff against whatever the OTHER
// layer has at the same moment: two identical rests are pushed apart (voice 1
// above the staff, voice 2 below it), and a hidden rest (`@visible="false"`,
// which Verovio does not honor — see lessons.md) displaces the visible one
// exactly as a drawn rest would. Both are wrong on paper: two identical rests
// at one moment are ONE rest, and an invisible rest must have no effect on
// anything visible (backlog, Opinionation).
//
// Verovio DOES honor `@loc` on <rest> and <mRest>, and two rests forced to the
// same @loc at the same moment render at the same x with no collision shift
// (probed 2026-09-04: identical x, identical centre) — the pair draws as a
// single glyph. So this pass keeps the DOM shape — every rest keeps its
// element and xml:id, so the cursor, click hit-testing and the selection
// overlay work unchanged — and only pins @loc:
//   • a visible rest whose span meets nothing visible in the other layer
//     (hidden rests, <space>, <mSpace>, or no content at all) gets its
//     single-layer location;
//   • a visible rest whose span meets exactly one identical visible rest
//     (same onset, same element, same written value) gets that location too,
//     so the pair coincides (the partner is pinned when its layer is walked);
//   • (2026-09-06, backlog Layout: sonata p. 17 m. 35) a visible rest whose
//     span meets only NOTES or CHORDS in the other layer is kept ON THE STAFF
//     when their ink leaves room. Verovio's two-voice offsets depend on the
//     other note's duration, not on where its ink is: in m. 30 the voice-1
//     eighth rest against a low half note sat in the staff's upper half, in
//     m. 35 the same rest against a low QUARTER was lifted clear above the
//     staff into its tuplet bracket. The rule: voice 1's rest sits at the
//     conventional raised spot (loc 6; whole rests hang from the top line)
//     or higher until its glyph clears the other layer's ink top by half a
//     location; voice 2's at the lowered spot (loc 2) or lower until it clears
//     the ink bottom. The ink is predicted from the notes — head locations
//     from pitch + clef (notation/staffpos.ts) with the head's ink box 1.1
//     locations either side of its centre (measured — a chord topping at the
//     middle line reaches 5.1), the stem on the layer's side (Verovio's layer
//     rule in a two-voice moment; an explicit @stem.dir wins) 3.5 spaces long
//     and at least to the middle line, a beam at its group's farthest stem,
//     2.5 locations for an accidental or an articulation on the head side;
//     half and whole rests keep to a line. If the glyph would then leave the
//     staff (more than one location past the outer lines) there is no room
//     and Verovio's placement stands — its own two-voice anchor is location
//     8 for quarter and eighth rests, so a rest against a chord topping at the
//     middle line or higher stays exactly where Verovio put it; so does
//     anything the prediction cannot measure (tremolos, unpitched notes, the
//     other layer's own rests).
// Anything else — a different rest in the other layer, a tremolo — is left to
// Verovio's collision logic: a rest pinned to the centre against a note at the
// same moment collides with it (probed).
//
// The first two rules touch only rests DIRECTLY under a <layer> (a rest inside
// a <tuplet> is that tuplet's bracket carrier — see the placeholder decision —
// and a rest in a <beam> cannot occur: rests split beam runs); the two-voice
// rule also reaches rests inside tuplets and beams, tuplet placeholders
// excepted. Runs on the render clone after regroupBeams and after
// unifySlurStems (whose @stem.dir it reads); never on the saved document.

import { realTicks } from '../model/ticks.js';
import { middleSteps, locOf } from './staffpos.js';

type Kind = 'rest' | 'void' | 'note' | 'other';

interface Span {
  el: Element;
  kind: Kind;
  t0: number;
  t1: number;
  /** The <beam> the element stems with, when any. */
  beam: Element | null;
}

/** Rest glyph extents relative to its @loc, in staff-line locations
 *  [below, above] — Bravura/Leipzig, probed at loc 4 (an eighth rest spans
 *  locations 2.0 … 5.46). Whole rests hang from their line, half rests sit
 *  on it. */
const REST_EXTENT: Record<string, readonly [number, number]> = {
  '1': [1, 0], breve: [1, 0], long: [1, 0],
  '2': [0, 1],
  '4': [3, 3],
  '8': [2, 1.5],
  '16': [4, 1.5],
  '32': [4, 3.5],
  '64': [6, 3.5],
  '128': [6, 5.5],
};
/** Clearance kept between the rest glyph and the other layer's ink: half a
 *  space. (0.5 location, 2026-09-06 morning, left an eighth rest touching a
 *  chord's top head — Max.) */
const MARGIN = 1;
/** Verovio's default stem: 3.5 spaces. */
const STEM_LOCS = 7;
/** A notehead's ink box reaches this far above and below its centre —
 *  measured on the bare toolkit: a head at location 4 tops out at 5.1, one at
 *  −1 at 0.1 (not the half location the glyph's nominal height suggests). */
const HEAD_HALF = 1.1;
/** An accidental or an articulation on the head side reaches this far past
 *  the head's CENTRE (a flat's stem, an accent). */
const ACCID_LOCS = 2.5;
const ARTIC_LOCS = 2.5;
/** A rest may poke this far past the outer staff lines and still be "on the staff". */
const STAFF_SLACK = 1;

/** Single-layer resting place of a rest glyph, in Verovio's staff-line
 *  locations (0 = bottom line, 4 = middle line, 8 = top line). A whole rest
 *  hangs from the fourth line (loc 6); every other value centres on the
 *  middle line (loc 4, the glyph's own offset does the rest). Probed against
 *  Verovio 6.3's single-layer output (quarter, half, whole, dotted eighth,
 *  mRest). */
function singleLayerLoc(el: Element): string {
  if (el.localName === 'mRest') return '6';
  const dur = el.getAttribute('dur');
  return dur === '1' || dur === 'breve' || dur === 'long' ? '6' : '4';
}

/** The conventional two-voice resting place: voice 1 raised a space, voice 2
 *  lowered a space; whole rests hang from the top line / the middle line. */
function twoVoiceLoc(el: Element, top: boolean): number {
  const dur = el.getAttribute('dur');
  if (dur === '1' || dur === 'breve' || dur === 'long') return top ? 8 : 4;
  return top ? 6 : 2;
}

const isStemless = (el: Element): boolean => {
  const d = el.getAttribute('dur');
  return d === '1' || d === 'breve' || d === 'long';
};

/** Time spans of a layer's events, in the layer's own tick line, descending
 *  into tuplets and beams (realTicks scales a tuplet member). An <mRest> /
 *  <mSpace> spans the whole measure. */
function layerSpans(layer: Element): Span[] {
  const out: Span[] = [];
  const walk = (parent: Element, t: number, beam: Element | null): number => {
    for (const c of Array.from(parent.children)) {
      const ln = c.localName;
      if (ln === 'tuplet') { t = walk(c, t, beam); continue; }
      if (ln === 'beam') { t = walk(c, t, c); continue; }
      if (ln === 'mRest' || ln === 'mSpace') {
        out.push({ el: c, kind: ln === 'mRest' && c.getAttribute('visible') !== 'false' ? 'rest' : 'void', t0: 0, t1: Infinity, beam: null });
        continue;
      }
      let kind: Kind | null = null;
      if (ln === 'rest') kind = c.getAttribute('visible') === 'false' ? 'void' : 'rest';
      else if (ln === 'space') kind = 'void';
      else if (ln === 'note' || ln === 'chord') kind = 'note';
      else if (ln === 'fTrem' || ln === 'bTrem') kind = 'other';
      if (kind === null) continue;           // clef, keySig, meterSig, … — no time
      const d = realTicks(c);
      out.push({ el: c, kind, t0: t, t1: t + d, beam });
      t += d;
    }
    return t;
  };
  walk(layer, 0, null);
  return out;
}

const sameWrittenValue = (a: Element, b: Element): boolean =>
  a.localName === b.localName
  && (a.getAttribute('dur') ?? '') === (b.getAttribute('dur') ?? '')
  && (a.getAttribute('dots') ?? '0') === (b.getAttribute('dots') ?? '0');

/** Predicted vertical ink extent (top, bottom — in staff-line locations) of a
 *  note/chord span of the OTHER layer, whose index is `layerIdx` (0 = voice 1,
 *  stems up; 1 = voice 2, stems down). A beamed span answers for its whole
 *  beam group (the beam sits at the group's farthest stem). Null when a pitch
 *  or clef is unknown. */
function inkExtent(s: Span, layerIdx: number, mids: Map<Element, number>, all: Span[]): { top: number; bottom: number } | null {
  const members = s.beam ? all.filter((x) => x.beam === s.beam && x.kind === 'note') : [s];
  let top = -Infinity, bottom = Infinity;
  for (const m of members) {
    const notes = m.el.localName === 'chord' ? Array.from(m.el.querySelectorAll('note')) : [m.el];
    let hi = -Infinity, lo = Infinity;
    for (const n of notes) {
      const mid = mids.get(n);
      if (mid === undefined) return null;
      const loc = locOf(n, mid);
      if (loc === null) return null;
      hi = Math.max(hi, loc); lo = Math.min(lo, loc);
    }
    if (!isFinite(hi)) return null;
    const dirAttr = m.el.getAttribute('stem.dir');
    const up = dirAttr === 'up' ? true : dirAttr === 'down' ? false : layerIdx === 0;
    const accid = notes.some((n) => n.hasAttribute('accid') || n.querySelector(':scope > accid[accid]') !== null);
    const artic = m.el.hasAttribute('artic') || m.el.querySelector(':scope > artic') !== null;
    const headPad = Math.max(HEAD_HALF, accid ? ACCID_LOCS : 0, artic ? ARTIC_LOCS : 0);
    const stemmed = !isStemless(m.el);
    const t = stemmed && up ? Math.max(hi + STEM_LOCS, 4) : hi + headPad;
    const b = stemmed && !up ? Math.min(lo - STEM_LOCS, 4) : lo - headPad;
    top = Math.max(top, t); bottom = Math.min(bottom, b);
  }
  return { top, bottom };
}

/** Pin `@loc` on the rests of every two-layer staff per the rules above.
 *  Idempotent; leaves an explicit `@loc` alone. */
export function settleRestLocations(doc: Document): void {
  let mids: Map<Element, number> | null = null;
  for (const staff of Array.from(doc.querySelectorAll('staff'))) {
    const layers = Array.from(staff.children).filter((c) => c.localName === 'layer');
    if (layers.length !== 2) continue;
    const spans = [layerSpans(layers[0]), layerSpans(layers[1])];
    for (let li = 0; li < 2; li++) {
      const others = spans[1 - li];
      for (const s of spans[li]) {
        if (s.kind !== 'rest' || s.el.hasAttribute('loc')) continue;
        const meets = others.filter((o) => o.t0 < s.t1 && o.t1 > s.t0);
        if (meets.some((o) => o.kind === 'other')) continue;
        const notes = meets.filter((o) => o.kind === 'note');
        const rests = meets.filter((o) => o.kind === 'rest');
        if (!notes.length) {
          if (s.el.parentElement !== layers[li]) continue;   // tuplet rests: the bracket carrier stays Verovio's
          const alone = rests.length === 0;
          const twin = rests.length === 1 && meets.length === 1
            && Math.abs(rests[0].t0 - s.t0) < 1e-6 && sameWrittenValue(rests[0].el, s.el);
          if (alone || twin) s.el.setAttribute('loc', singleLayerLoc(s.el));
          continue;
        }
        /* Two-voice rule: notes (and only notes) in the other layer. */
        if (rests.length || s.el.localName !== 'rest' || s.el.hasAttribute('data-tuplet-placeholder')) continue;
        const ext = REST_EXTENT[s.el.getAttribute('dur') ?? ''];
        if (!ext) continue;
        if (!mids) mids = middleSteps(doc);
        let top = -Infinity, bottom = Infinity, measurable = true;
        for (const o of notes) {
          const e = inkExtent(o, 1 - li, mids, others);
          if (!e) { measurable = false; break; }
          top = Math.max(top, e.top); bottom = Math.min(bottom, e.bottom);
        }
        if (!measurable) continue;
        /* Half and whole rests sit on / hang from a LINE: even locations only. */
        const onLine = ext[0] === 0 || ext[1] === 0;
        let loc: number;
        if (li === 0) {
          loc = Math.max(twoVoiceLoc(s.el, true), Math.ceil(top + MARGIN + ext[0]));
          if (onLine && loc % 2) loc += 1;
          if (loc + ext[1] > 8 + STAFF_SLACK) continue;      // no room on the staff
        } else {
          loc = Math.min(twoVoiceLoc(s.el, false), Math.floor(bottom - MARGIN - ext[1]));
          if (onLine && loc % 2) loc -= 1;
          if (loc - ext[0] < 0 - STAFF_SLACK) continue;
        }
        s.el.setAttribute('loc', String(loc));
      }
    }
  }
}
