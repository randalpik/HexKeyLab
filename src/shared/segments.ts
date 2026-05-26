// Segment-pipeline picker — pure data, shared between the production sample
// engine (src/audio/samples-engine.ts) and any other consumer that needs to
// chain analyzer-produced segment pairs into a phase-coherent perpetual
// loop. Mirrors the segments branch of samples-engine.ts:pickNextSeam.
//
// The analyzer emits segments as `[{a, b}, ...]` where each (a, b) is a
// validated seam pair: playing forward from `a` to `b` and wrapping back
// to `a` produces a phase-coherent loop. With multiple segments forming
// an overlap-graph SCC, a single source can wrap at any segment's `b`
// back to that segment's `a`, then play forward to ANOTHER segment's `b`,
// and the wraps stay coherent — every wrap is its own validated seam pair.
// That's how the engine gets loop variety without re-decoding audio.
//
// Pure-data per src/shared/ rules: no Web Audio, no DOM, no runtime state.

export interface Segment {
  readonly a: number;
  readonly b: number;
}

export interface SegmentPick {
  /** Where the new source begins (== segments[curIdx].a — wrap back to
   *  the current segment's start, which is a validated seam point). */
  a: number;
  /** Where the new source will end / wrap (== picked next segment's b). */
  b: number;
  /** The picked segment index. Caller updates currentSegIdx to this so the
   *  next wrap loops back to THIS segment's a. */
  nextSegIdx: number;
}

/** Wrap-and-pick at a segment boundary. The new source starts at
 *  `segments[curIdx].a` (the validated wrap point) and plays forward to a
 *  randomly-chosen next segment's `b`. "Reachable" = any segment whose b
 *  lies past the wrap point; the analyzer's SCC guarantee means at least
 *  one such candidate exists in practice. Dead-end fallback (single-segment
 *  or broken SCC) replays the current segment. */
export function pickNextSeam(
  segments: ReadonlyArray<Segment>,
  curIdx: number,
): SegmentPick {
  if (segments.length === 0) {
    throw new Error('pickNextSeam: empty segments');
  }
  if (curIdx == null || curIdx < 0 || curIdx >= segments.length) curIdx = 0;
  const aTime = segments[curIdx].a;
  const cands: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].b > aTime) cands.push(i);
  }
  /* Dead-end fallback: replay the current segment (single-segment SCC or a
     pathological pick where no segment reaches past the wrap point). */
  if (cands.length === 0) cands.push(curIdx);
  const nextIdx = cands[Math.floor(Math.random() * cands.length)];
  return { a: aTime, b: segments[nextIdx].b, nextSegIdx: nextIdx };
}

/** Find the segment whose `b` is past `t` — i.e., the first segment the
 *  initial source (starting at trimStart) will wrap into. Returns the last
 *  segment index if every segment's b ≤ t (degenerate, shouldn't happen
 *  with a valid analyzer result). */
export function findInitialSegIdx(
  segments: ReadonlyArray<Segment>,
  t: number,
): number {
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].b > t) return i;
  }
  return Math.max(0, segments.length - 1);
}
