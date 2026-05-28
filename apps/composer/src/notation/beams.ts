// Intelligent beam-group computation. Run at serialize-time on a CLONE of the
// live MEI doc so that the live doc never contains <beam> wrappers (keeping
// the cursor and mutation code simple — they always see flat layer children).
//
// Beam rules:
//   - Simple meter (e.g. 2/4, 3/4, 4/4): beat unit = meter.unit note. All
//     beamable (dur >= 8) elements within one beat that form a run of >= 2
//     get a <beam> wrapper.
//   - Compound meter (e.g. 6/8, 9/8, 12/8): beat = three meter.unit notes
//     (dotted denominator). Same run logic.
//   - 4/4 special case: each half-measure (beats 1-2, beats 3-4) becomes a
//     single super-group ONLY when its members are exactly four eighth notes
//     (count=4, no rests, every @dur === '8'). Otherwise the half-measure
//     falls back to per-beat quarter-note groups. This keeps the canonical
//     8-eighths case beamed as two 4-beams while preventing over-beaming
//     mixed rhythms like `E E 16 16 E` (which standard engraving renders
//     as per-beat groups, not a cross-beat 5-beam). The two halves are
//     evaluated independently — one half can keep its super-beam while
//     the other splits.
//   - Rests interrupt runs; quarter+ durations interrupt runs; singletons
//     stay un-wrapped (Verovio renders a flag).
//   - An element belongs to the beat-group containing its startTick. An
//     element overflowing the group end stays in its starting group.
//
// `regroupBeams` is idempotent: it unwraps any existing <beam> wrappers
// before re-computing. This means the same function can be called repeatedly
// on the same doc with no drift.

import { realTicks } from '../model/ticks.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';

export interface TimeSigInfo {
  count: number;
  unit: number;
  isCompound: boolean;
  is4_4: boolean;
}

export function readTimeSig(doc: Document): TimeSigInfo {
  const sd = doc.querySelector('scoreDef');
  const count = parseInt(sd?.getAttribute('meter.count') ?? '4', 10);
  const unit = parseInt(sd?.getAttribute('meter.unit') ?? '4', 10);
  const isCompound = unit >= 8 && count >= 6 && count % 3 === 0;
  const is4_4 = count === 4 && unit === 4;
  return { count, unit, isCompound, is4_4 };
}

/** Return every layer-mate that would be wrapped in the same `<beam>` as
 *  `elem` by `regroupBeams`. Single-element array when `elem` would render
 *  as a flagged singleton (not in a beam). Used by the stem-direction-flip
 *  hotkey to flip every member of a beam together: Verovio resolves beam
 *  stem direction by majority, so leaving one member out would either fail
 *  the flip visually or split the beam. */
export function beamGroupForElement(doc: Document, elem: Element): Element[] {
  const layer = elem.closest('layer');
  if (!layer) return [elem];
  /* Inside a tuplet, the tuplet-internal beam pass is what would beam it.
     Tuplets don't have inter-beat boundaries inside them (the whole tuplet
     is one beat group), so the XOR logic collapses to just the marker. */
  const tuplet = elem.closest('tuplet');
  if (tuplet) {
    const stream = annotateTupletChildrenExported(tuplet);
    const idx = stream.findIndex((s) => s.el === elem);
    if (idx < 0) return [elem];
    return findRunIncluding(stream, idx, new Set());
  }
  /* Layer-level: compute beat-group boundaries and the same per-element
     "starts new beam" XOR (natural XOR marker) that regroupOneLayer uses. */
  const ts = readTimeSig(doc);
  const measureTicks = ts.count * (64 / ts.unit);
  const stream = annotateLayerExported(layer);
  const idx = stream.findIndex((s) => s.el === elem);
  if (idx < 0) return [elem];
  const groups = effectiveGroupsForLayerExported(stream, ts, measureTicks);
  const groupStarts = new Set<number>();
  for (const grp of groups) {
    const firstIdx = stream.findIndex((s) => s.startTick >= grp.lo && s.startTick < grp.hi);
    if (firstIdx >= 0) groupStarts.add(firstIdx);
  }
  return findRunIncluding(stream, idx, groupStarts);
}

/** Walk left+right from `idx` in `stream`, collecting consecutive beamable
 *  entries that share `idx`'s beam. An element "starts a new beam" iff
 *  XOR(naturalBoundary, marker) — i.e., either a natural beat boundary
 *  with no override or an inserted marker mid-beat. `groupStarts` carries
 *  the natural-boundary indices for this stream; pass an empty Set for
 *  tuplet contexts (no inter-beat structure inside a tuplet). */
function findRunIncluding(
  stream: StreamEntry[],
  idx: number,
  groupStarts: Set<number>,
): Element[] {
  if (!beamablePredicate(stream[idx].el)) return [stream[idx].el];
  const startsNewBeam = (i: number): boolean => {
    const natural = i > 0 && groupStarts.has(i);
    const marker = stream[i].el.getAttribute('hkl-beam-break') === 'true';
    return natural !== marker;
  };
  let lo = idx, hi = idx;
  while (lo > 0 && beamablePredicate(stream[lo - 1].el) && !startsNewBeam(lo)) lo--;
  while (hi < stream.length - 1 && beamablePredicate(stream[hi + 1].el)
         && !startsNewBeam(hi + 1)) hi++;
  if (lo === hi) return [stream[idx].el];
  return stream.slice(lo, hi + 1).map((s) => s.el);
}

/* Exported wrappers around the layer/tuplet stream annotators so the
 * helper above can reuse them without duplicating logic. */
function annotateLayerExported(layer: Element): StreamEntry[] { return annotateLayer(layer); }
function annotateTupletChildrenExported(tuplet: Element): StreamEntry[] { return annotateTupletChildren(tuplet); }
function effectiveGroupsForLayerExported(stream: StreamEntry[], ts: TimeSigInfo, measureTicks: number): Array<{ lo: number; hi: number }> {
  return effectiveGroupsForLayer(stream, ts, measureTicks);
}

/** Strip every <beam> in the doc, lifting its children to the beam's parent
 *  position. Safe no-op when there are no beams. */
export function unwrapBeams(doc: Document): void {
  const beams = doc.querySelectorAll('beam');
  for (const b of Array.from(beams)) {
    const parent = b.parentNode;
    if (!parent) continue;
    while (b.firstChild) parent.insertBefore(b.firstChild, b);
    parent.removeChild(b);
  }
}

/** Recompute <beam> wrappers for every layer in every measure of `doc`,
 *  based on the time signature `ts`. Idempotent. Two passes:
 *    1. Layer-level beaming (the standard beat-group logic).
 *    2. Tuplet-internal beaming: each <tuplet> is treated as a single beat
 *       group and its beam-eligible children are wrapped independently. */
export function regroupBeams(doc: Document, ts: TimeSigInfo): void {
  unwrapBeams(doc);

  const measureTicks = ts.count * (64 / ts.unit);

  const measures = doc.querySelectorAll('measure');
  for (const m of Array.from(measures)) {
    const layers = m.querySelectorAll('layer');
    for (const layer of Array.from(layers)) {
      regroupOneLayer(doc, layer, ts, measureTicks);
    }
  }

  /* Tuplet-internal pass. Each tuplet is its own beat group; we beam any
     run of consecutive beam-eligible children (rests split runs). */
  for (const tuplet of Array.from(doc.querySelectorAll('tuplet'))) {
    regroupOneTuplet(doc, tuplet);
  }
}

/** Base beat-group tick ranges given the time signature. In 4/4 this returns
 *  the two half-measure super-groups; the per-layer pass may downgrade
 *  either half to two quarter-beats via `effectiveGroupsForLayer`. */
function beatGroupBoundaries(ts: TimeSigInfo, measureTicks: number): Array<{ lo: number; hi: number }> {
  if (ts.is4_4) {
    return [{ lo: 0, hi: 32 }, { lo: 32, hi: 64 }];
  }
  const beatTicks = ts.isCompound
    ? 3 * (64 / ts.unit)
    : 64 / ts.unit;
  const out: Array<{ lo: number; hi: number }> = [];
  for (let lo = 0; lo < measureTicks; lo += beatTicks) {
    out.push({ lo, hi: Math.min(lo + beatTicks, measureTicks) });
  }
  return out;
}

/** In 4/4, a half-measure super-group only survives if the layer's members
 *  inside it are exactly four eighth notes (no rests, no other durations).
 *  Otherwise the half-measure is split into two quarter-beat groups so
 *  beaming stays inside the beat. The two halves are evaluated independently. */
function effectiveGroupsForLayer(
  stream: StreamEntry[],
  ts: TimeSigInfo,
  measureTicks: number,
): Array<{ lo: number; hi: number }> {
  const base = beatGroupBoundaries(ts, measureTicks);
  if (!ts.is4_4) return base;
  const out: Array<{ lo: number; hi: number }> = [];
  for (const grp of base) {
    const members = stream.filter((s) => s.startTick >= grp.lo && s.startTick < grp.hi);
    if (isExactlyFourEighths(members)) {
      out.push(grp);
    } else {
      const mid = (grp.lo + grp.hi) / 2;
      out.push({ lo: grp.lo, hi: mid });
      out.push({ lo: mid, hi: grp.hi });
    }
  }
  return out;
}

function isExactlyFourEighths(members: StreamEntry[]): boolean {
  if (members.length !== 4) return false;
  for (const m of members) {
    if (m.el.localName === 'rest') return false;
    if (m.el.getAttribute('dur') !== '8') return false;
  }
  return true;
}

function regroupOneLayer(
  doc: Document,
  layer: Element,
  ts: TimeSigInfo,
  measureTicks: number,
): void {
  const stream = annotateLayer(layer);
  if (stream.length === 0) return;
  const groups = effectiveGroupsForLayer(stream, ts, measureTicks);

  /* Per-element "starts a new beam" decision. Combines two signals:
       - natural: this element sits at the start of an effective beat group
         (a natural beam break in the absence of overrides);
       - marker:  @hkl-beam-break="true" was placed on this element by `/`.
     The decision is natural XOR marker:
       - natural=false, marker=false → continue current beam   (mid-beat)
       - natural=false, marker=true  → BREAK here              (manual mid-beat split)
       - natural=true,  marker=false → BREAK here              (natural beat boundary)
       - natural=true,  marker=true  → continue current beam   (cross-beat connect)
     This lets `/` *override* either case: forcing a break mid-beat OR
     dissolving a natural beat-boundary break to merge across beats. */
  const groupStarts = new Set<number>();
  for (const grp of groups) {
    const firstIdx = stream.findIndex((s) => s.startTick >= grp.lo && s.startTick < grp.hi);
    if (firstIdx >= 0) groupStarts.add(firstIdx);
  }

  const runs: StreamEntry[][] = [];
  let current: StreamEntry[] = [];
  for (let i = 0; i < stream.length; i++) {
    const entry = stream[i];
    if (!beamablePredicate(entry.el)) {
      if (current.length > 0) { runs.push(current); current = []; }
      continue;
    }
    const natural = i > 0 && groupStarts.has(i);
    const marker = entry.el.getAttribute('hkl-beam-break') === 'true';
    const startsNew = natural !== marker;
    if (startsNew) {
      if (current.length > 0) runs.push(current);
      current = [entry];
    } else {
      current.push(entry);
    }
  }
  if (current.length > 0) runs.push(current);

  for (const run of runs) {
    if (run.length >= 2) wrapInBeam(doc, layer, run.map((r) => r.el));
  }
}

/** Tuplet-internal beam pass. The tuplet's content children form a single
 *  beat group; we wrap any run of ≥ 2 consecutive beam-eligible children
 *  (rests split runs; placeholders are ignored). */
function regroupOneTuplet(doc: Document, tuplet: Element): void {
  const stream = annotateTupletChildren(tuplet);
  if (stream.length < 2) return;
  const runs = splitIntoBeamableRuns(stream);
  for (const run of runs) {
    if (run.length >= 2) wrapInBeam(doc, tuplet, run.map((r) => r.el));
  }
}

function annotateTupletChildren(tuplet: Element): StreamEntry[] {
  const out: StreamEntry[] = [];
  let t = 0;
  for (const c of Array.from(tuplet.children)) {
    const ln = c.localName;
    /* Skip tuplet-internal placeholders — layout-only, never beam-eligible. */
    if (ln === 'space' && c.getAttribute('data-tuplet-placeholder') === 'true') continue;
    if (ln !== 'chord' && ln !== 'note' && ln !== 'rest') continue;
    const ticks = elementDurationTicks(c);
    out.push({ el: c, startTick: t, durTicks: ticks });
    t += ticks;
  }
  return out;
}

interface StreamEntry { el: Element; startTick: number; durTicks: number }

function annotateLayer(layer: Element): StreamEntry[] {
  const out: StreamEntry[] = [];
  let t = 0;
  for (const c of Array.from(layer.children)) {
    const ln = c.localName;
    if (ln === 'tuplet') {
      /* Tuplet contents are not beamed at the layer level in v1; skip
         the tuplet in beam grouping but advance the clock by its real
         ticks so subsequent beat-group math is correct. */
      t += elementDurationTicks(c);
      continue;
    }
    if (ln !== 'chord' && ln !== 'note' && ln !== 'rest') continue;
    const ticks = elementDurationTicks(c);
    out.push({ el: c, startTick: t, durTicks: ticks });
    t += ticks;
  }
  return out;
}

function elementDurationTicks(el: Element): number {
  return realTicks(el);
}

function beamablePredicate(el: Element): boolean {
  if (el.localName === 'rest') return false;
  /* For chord, read @dur on the chord itself. For bare <note>, on the note. */
  const dur = el.getAttribute('dur');
  if (!dur) return false;
  const denom = parseInt(dur, 10);
  return Number.isFinite(denom) && denom >= 8;
}

/** Split a group's members into runs of consecutive beamable elements
 *  (non-beamable elements split runs). An element carrying
 *  `@hkl-beam-break="true"` starts a new run too — used by the `/`
 *  hotkey for manual beam splits within a beat group. */
function splitIntoBeamableRuns(members: StreamEntry[]): StreamEntry[][] {
  const runs: StreamEntry[][] = [];
  let current: StreamEntry[] = [];
  for (const m of members) {
    if (!beamablePredicate(m.el)) {
      if (current.length > 0) { runs.push(current); current = []; }
      continue;
    }
    if (m.el.getAttribute('hkl-beam-break') === 'true') {
      /* End the current run BEFORE this element, then start fresh including it. */
      if (current.length > 0) runs.push(current);
      current = [m];
      continue;
    }
    current.push(m);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** Wrap `els` (consecutive children of `layer`) in a new <beam> element,
 *  inserted at the position of the first element. */
function wrapInBeam(doc: Document, layer: Element, els: Element[]): void {
  if (els.length === 0) return;
  const beam = doc.createElementNS(MEI_NS, 'beam');
  layer.insertBefore(beam, els[0]);
  for (const e of els) beam.appendChild(e); /* moves out of layer into beam */
}
