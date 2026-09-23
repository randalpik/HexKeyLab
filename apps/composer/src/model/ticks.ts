// Shared tick math for the composer. Two element functions:
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
//
// Plus decomposeTicks(n) — the greedy split of a tick count into written
// values (placeholders, overflow splits, cosmetic pickup rests). Lives here,
// re-exported by model/index.ts, so render-clone passes can use it without a
// runtime import cycle through the model.

import type { Duration, Dots } from './index.js';

/** Element written-ticks from @dur + @dots. 16 (quarter-note) fallback for
 *  malformed/missing attributes — matches the historical behavior of every
 *  pre-ticks.ts duplicate. */
export function writtenTicks(el: Element): number {
  /* A two-note tremolo (<fTrem>) / single-note tremolo (<bTrem>) has no @dur
     of its own. By the fingered-tremolo convention each wrapped note is DRAWN
     at the full combined value and the tremolo OCCUPIES that value — so the
     tremolo's time is ONE wrapped note's written duration (both are equal),
     NOT the sum. Without this it hits the 16-tick fallback below. */
  const ln = el.localName;
  if (ln === 'fTrem' || ln === 'bTrem') {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'note' || c.localName === 'chord') return writtenTicks(c);
    }
    return 0;
  }
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
  /* An inline <clef> (mid-measure clef change) is a zero-duration layer child —
     like <measure>, it must not hit writtenTicks's 16-tick fallback. */
  if (ln === 'clef') return 0;
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

/* 64th-note tick table for representable durations (greedy decomposition).
   Largest first. The @dur values here MUST be consistent with ticksOf —
   e.g. dotted half = ticksOf('2', 1) = 48, so the 48-tick entry must carry
   dur='2' dots=1, not dur='1' dots=1 (= 96). */
const TICK_TABLE: ReadonlyArray<{ ticks: number; dur: Duration; dots: Dots }> = [
  { ticks: 64, dur: '1',  dots: 0 },   /* whole */
  { ticks: 56, dur: '2',  dots: 2 },   /* double-dotted half */
  { ticks: 48, dur: '2',  dots: 1 },   /* dotted half */
  { ticks: 32, dur: '2',  dots: 0 },   /* half */
  { ticks: 28, dur: '4',  dots: 2 },   /* double-dotted quarter */
  { ticks: 24, dur: '4',  dots: 1 },   /* dotted quarter */
  { ticks: 16, dur: '4',  dots: 0 },   /* quarter */
  { ticks: 14, dur: '8',  dots: 2 },   /* double-dotted 8th */
  { ticks: 12, dur: '8',  dots: 1 },   /* dotted 8th */
  { ticks: 8,  dur: '8',  dots: 0 },   /* 8th */
  { ticks: 7,  dur: '16', dots: 2 },   /* double-dotted 16th */
  { ticks: 6,  dur: '16', dots: 1 },   /* dotted 16th */
  { ticks: 4,  dur: '16', dots: 0 },   /* 16th */
  { ticks: 3,  dur: '32', dots: 1 },   /* dotted 32nd */
  { ticks: 2,  dur: '32', dots: 0 },   /* 32nd */
  { ticks: 1,  dur: '64', dots: 0 },   /* 64th */
];

/** Greedy largest-first split of `n` ticks into representable values (up to
 *  two dots): ONE value whenever `n` is itself representable. */
export function decomposeTicks(n: number): Array<{ dur: Duration; dots: Dots }> {
  const out: Array<{ dur: Duration; dots: Dots }> = [];
  let remaining = n;
  while (remaining > 0) {
    let picked = false;
    for (const entry of TICK_TABLE) {
      if (entry.ticks <= remaining) {
        out.push({ dur: entry.dur, dots: entry.dots });
        remaining -= entry.ticks;
        picked = true;
        break;
      }
    }
    if (!picked) break; /* shouldn't happen — TICK_TABLE has a 1-tick entry */
  }
  return out;
}
