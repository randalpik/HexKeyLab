// Shared tick math for the composer. Two functions:
//   writtenTicks(el)  — @dur + @dots from the element itself (the value as it
//                       appears on paper).
//   realTicks(el)     — performed/sounding duration: equals writtenTicks for
//                       elements outside a tuplet; scaled by numbase/num for
//                       elements inside a tuplet; for the <tuplet> element
//                       itself, returns the sum of its children's written
//                       ticks times numbase/num (i.e. the tuplet's whole
//                       real-time span).
//
// Centralizing the math here is the single place where tuplet scaling lives.
// All time arithmetic in the composer (cursor positions, measure-fill, beat
// boundaries, playback timing, expression tstamps) flows through realTicks.

/** Element written-ticks from @dur + @dots. 16 (quarter-note) fallback for
 *  malformed/missing attributes — matches the historical behavior of every
 *  pre-ticks.ts duplicate. */
export function writtenTicks(el: Element): number {
  const dur = el.getAttribute('dur');
  const dots = parseInt(el.getAttribute('dots') ?? '0', 10);
  const denom = dur ? parseInt(dur, 10) : NaN;
  if (!Number.isFinite(denom) || denom <= 0) return 16;
  const base = 64 / denom;
  if (dots === 1) return base * 1.5;
  if (dots === 2) return base * 1.75;
  return base;
}

/** Find the enclosing <tuplet> if `el` is one of its (possibly beam-wrapped)
 *  descendants. Returns null when `el` is not inside a tuplet. Does NOT match
 *  on `el` itself even if it is a tuplet — this asks "what tuplet scales my
 *  ticks", and a tuplet's own ticks aren't scaled by itself. */
function enclosingTuplet(el: Element): Element | null {
  let p = el.parentElement;
  while (p) {
    if (p.localName === 'tuplet') return p;
    if (p.localName === 'beam' || p.localName === 'layer') {
      /* Continue up through beams; stop at layer (no tuplet ancestor). */
      if (p.localName === 'layer') return null;
      p = p.parentElement;
      continue;
    }
    p = p.parentElement;
  }
  return null;
}

function tupletRatio(t: Element): { num: number; numbase: number } {
  const num = parseInt(t.getAttribute('num') ?? '1', 10);
  const numbase = parseInt(t.getAttribute('numbase') ?? '1', 10);
  return {
    num: Number.isFinite(num) && num > 0 ? num : 1,
    numbase: Number.isFinite(numbase) && numbase > 0 ? numbase : 1,
  };
}

/** Real (sounding) ticks for an element. Handles three cases:
 *    - <tuplet> element: sum of children's written ticks * numbase/num.
 *    - Element inside a tuplet: writtenTicks * numbase/num.
 *    - Anything else (including <beam>-but-not-inside-tuplet): writtenTicks
 *      for atomic elements; for <beam>, sum of children's realTicks. */
export function realTicks(el: Element): number {
  const ln = el.localName;
  /* Section-level wrapper elements have no @dur; they appear in
     `flatChildren` as nav stops but contribute zero time to the voice's
     tick line. Returning 0 (instead of falling through to writtenTicks's
     16-tick fallback) keeps `getTimeAt` honest across cursor positions. */
  if (ln === 'measure') return 0;
  if (ln === 'tuplet') {
    const { num, numbase } = tupletRatio(el);
    let totalWritten = 0;
    for (const c of Array.from(el.children)) {
      const cln = c.localName;
      if (cln === 'note' || cln === 'chord' || cln === 'rest' || cln === 'space') {
        totalWritten += writtenTicks(c);
      } else if (cln === 'beam') {
        for (const cc of Array.from(c.children)) {
          const ccn = cc.localName;
          if (ccn === 'note' || ccn === 'chord' || ccn === 'rest' || ccn === 'space') {
            totalWritten += writtenTicks(cc);
          }
        }
      }
    }
    return totalWritten * numbase / num;
  }
  if (ln === 'beam') {
    let s = 0;
    for (const c of Array.from(el.children)) s += realTicks(c);
    return s;
  }
  const t = enclosingTuplet(el);
  if (t) {
    const { num, numbase } = tupletRatio(t);
    return writtenTicks(el) * numbase / num;
  }
  return writtenTicks(el);
}
