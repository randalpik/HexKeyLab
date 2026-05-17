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
//   - 4/4 special case: instead of 4 quarter-beats, treat the measure as 2
//     super-groups (beats 1-2 and 3-4) so 8 eighth notes form two beams of 4.
//   - Rests interrupt runs; quarter+ durations interrupt runs; singletons
//     stay un-wrapped (Verovio renders a flag).
//   - An element belongs to the beat-group containing its startTick. An
//     element overflowing the group end stays in its starting group.
//
// `regroupBeams` is idempotent: it unwraps any existing <beam> wrappers
// before re-computing. This means the same function can be called repeatedly
// on the same doc with no drift.

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
 *  based on the time signature `ts`. Idempotent. */
export function regroupBeams(doc: Document, ts: TimeSigInfo): void {
  unwrapBeams(doc);

  const measureTicks = ts.count * (64 / ts.unit);
  const groups = beatGroupBoundaries(ts, measureTicks);

  const measures = doc.querySelectorAll('measure');
  for (const m of Array.from(measures)) {
    const layers = m.querySelectorAll('layer');
    for (const layer of Array.from(layers)) {
      regroupOneLayer(doc, layer, groups);
    }
  }
}

/** Compute beat-group tick ranges given the time signature. */
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

function regroupOneLayer(doc: Document, layer: Element, groups: Array<{ lo: number; hi: number }>): void {
  const stream = annotateLayer(layer);
  if (stream.length === 0) return;

  for (const grp of groups) {
    const members = stream.filter((s) => s.startTick >= grp.lo && s.startTick < grp.hi);
    if (members.length < 2) continue;
    const runs = splitIntoBeamableRuns(members);
    for (const run of runs) {
      if (run.length >= 2) wrapInBeam(doc, layer, run.map((r) => r.el));
    }
  }
}

interface StreamEntry { el: Element; startTick: number; durTicks: number }

function annotateLayer(layer: Element): StreamEntry[] {
  const out: StreamEntry[] = [];
  let t = 0;
  for (const c of Array.from(layer.children)) {
    const ln = c.localName;
    if (ln !== 'chord' && ln !== 'note' && ln !== 'rest') continue;
    const ticks = elementDurationTicks(c);
    out.push({ el: c, startTick: t, durTicks: ticks });
    t += ticks;
  }
  return out;
}

function elementDurationTicks(el: Element): number {
  const dur = el.getAttribute('dur');
  const dots = parseInt(el.getAttribute('dots') ?? '0', 10);
  const denom = dur ? parseInt(dur, 10) : NaN;
  if (!Number.isFinite(denom) || denom <= 0) return 16;
  const base = 64 / denom;
  if (dots === 1) return base * 1.5;
  if (dots === 2) return base * 1.75;
  return base;
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
 *  (non-beamable elements split runs). */
function splitIntoBeamableRuns(members: StreamEntry[]): StreamEntry[][] {
  const runs: StreamEntry[][] = [];
  let current: StreamEntry[] = [];
  for (const m of members) {
    if (beamablePredicate(m.el)) {
      current.push(m);
    } else {
      if (current.length > 0) { runs.push(current); current = []; }
    }
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
