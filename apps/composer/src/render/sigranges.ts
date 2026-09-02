/**
 * Signature changes are RANGES, not derives (Max, 2026-09-01).
 *
 * A clef, key or meter change governs every following measure until the next
 * change of the same kind on the same staff — that range, and only that range,
 * must re-engrave. Before this module the page refill derived the whole
 * document on any interior scoreDef change (and, for one afternoon, on any
 * inline clef change), and the scroll splicer full-rendered on a clef change
 * and silently did NOTHING on a mid-piece key change (its per-measure diff
 * cannot see a section-level scoreDef). Max's framing: "any time the user is
 * exposed to O(document) on a live path when they didn't ask for a change to the
 * full document is a failure, full stop." A change with a later reset is
 * O(range); one without genuinely governs the rest of the staff, and
 * re-engraving that much is what the user asked for — the run caps decide
 * whether that still splices.
 *
 * Both splicers use this module the same way: capture `SigState` with the
 * per-measure baseline, and on the next edit ask `signatureRanges` which
 * measures the signature changes govern (or whether something structural
 * changed that no range can express).
 */

/** Key / meter attributes of a scoreDef, and everything else it carries. */
export interface ScoreDefParts {
  key: string;     // key.sig + mode, '' when absent
  meter: string;   // meter.count / unit / sym / beat groups, '' when absent
  rest: string;    // the element serialized with those attributes removed
}

export interface InteriorEntry extends ScoreDefParts {
  el: Element;
  /** xml:id of the first measure following the scoreDef — its identity AND its
   *  position anchor across edits. Measure indices shift and element objects
   *  are replaced wholesale by undo/redo/restoreSnapshot (the document is
   *  swapped); ids survive both. */
  nextId: string;
  /** True when the scoreDef carries anything beyond key/meter — a change no
   *  range can express. Computed at capture time (needs the element). */
  structural: boolean;
}

export interface SigState {
  head: ScoreDefParts;
  interior: InteriorEntry[];
}

const KEY_ATTRS = ['key.sig', 'mode', 'key.mode', 'keysig'];
const METER_ATTRS = ['meter.count', 'meter.unit', 'meter.sym', 'hkl:beat-groups', 'beat-groups'];

function partsOf(sd: Element): ScoreDefParts {
  const key = KEY_ATTRS.map((a) => sd.getAttribute(a) ?? '').join('/');
  const meter = METER_ATTRS.map((a) => sd.getAttribute(a) ?? '').join('/');
  const clone = sd.cloneNode(true) as Element;
  for (const a of [...KEY_ATTRS, ...METER_ATTRS]) clone.removeAttribute(a);
  /* Namespace declarations are not structure: `setMeterAt` writes
     `hkl:beat-groups` with setAttributeNS, which adds an xmlns:hkl declaration to
     the element — without this, every meter change read as "interior structure
     changed" and derived. */
  for (const a of Array.from(clone.attributes)) {
    if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) clone.removeAttribute(a.name);
  }
  return {
    key: key.replace(/\/+$/, ''), meter: meter.replace(/\/+$/, ''),
    rest: new XMLSerializer().serializeToString(clone),
  };
}

/** Section-level scoreDefs (mid-piece key/meter changes), each anchored to the
 *  measure that follows it. Descends into measure-bearing wrappers (`ending`). */
export function interiorScoreDefs(section: Element): InteriorEntry[] {
  const out: InteriorEntry[] = [];
  const pending: Element[] = [];
  const walk = (el: Element): void => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'measure') {
        const id = c.getAttribute('xml:id') ?? '';
        for (const sd of pending.splice(0)) {
          const parts = partsOf(sd);
          out.push({ ...parts, el: sd, nextId: id, structural: parts.rest !== bareRest(sd) });
        }
      } else if (c.localName === 'scoreDef') {
        pending.push(c);
      } else if (c.querySelector('measure')) {
        walk(c);
      }
    }
  };
  walk(section);
  /* a trailing scoreDef with no following measure governs nothing */
  return out;
}

/** The head scoreDef's parts. `extraRest` lets an owner fold more head-level
 *  context (elements before the first measure, credits) into `rest`. */
export function headParts(doc: Document, extraRest = ''): ScoreDefParts {
  const sd = doc.querySelector('scoreDef');
  const p = sd ? partsOf(sd) : { key: '', meter: '', rest: '' };
  return { ...p, rest: p.rest + '|' + extraRest };
}

export function captureSigState(doc: Document, extraHeadRest = ''): SigState {
  const section = doc.querySelector('section');
  return {
    head: headParts(doc, extraHeadRest),
    interior: section ? interiorScoreDefs(section) : [],
  };
}

/** Per-staff clef tags of a serialized measure, ids stripped. Only called for
 *  measures the diff already marked changed, so the parse is O(edit). */
export function clefsByStaff(measureXml: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!/<clef\b/.test(measureXml)) return out;
  const doc = new DOMParser().parseFromString(measureXml, 'application/xml');
  const meas = doc.documentElement;
  if (!meas) return out;
  for (const staff of Array.from(meas.children)) {
    if (staff.localName !== 'staff') continue;
    const tags = Array.from(staff.querySelectorAll('layer > clef'))
      .map((c) => `${c.getAttribute('shape') ?? ''}${c.getAttribute('line') ?? ''}${c.getAttribute('dis') ?? ''}${c.getAttribute('dis.place') ?? ''}`);
    if (tags.length) out.set(staff.getAttribute('n') ?? '1', tags.join('|'));
  }
  return out;
}

/** Last measure governed by a clef change at `from` on `staff`: up to the next
 *  measure with a layer clef on that staff. That measure is INCLUDED when its
 *  clef is mid-measure (the notes before the clef, and the system clef if the
 *  measure begins a line, are still in the changed prevailing clef — found by
 *  pageClefChangeSplicesGovernedRange: the context line below drew its system
 *  clef in the new clef) and EXCLUDED when the clef is measure-initial (the
 *  measure begins in its own clef; its relocated change glyph lands in the
 *  measure before, which is in range anyway). `measures.length - 1` when no
 *  later clef exists. */
export function clefRangeEnd(measures: Element[], from: number, staff: string): number {
  for (let i = from + 1; i < measures.length; i++) {
    const clef = measures[i].querySelector(`:scope > staff[n="${staff}"] > layer > clef`);
    if (!clef) continue;
    const layer = clef.parentElement;
    return layer && layer.firstElementChild === clef ? i - 1 : i;
  }
  return measures.length - 1;
}

export interface RangeRequest {
  /** Serialized measures by id, OLD baseline and NEW. */
  oldSig: Map<string, string>;
  newSig: (id: string) => string | undefined;
  /** New-index measures whose content the per-measure diff marked changed. */
  changedNew: number[];
  measures: Element[];
  ids: string[];
  idIdx: Map<string, number>;
  oldState: SigState;
  newState: SigState;
}

export interface RangeResult {
  /** Inclusive [lo, hi] ranges in NEW measure indices. */
  ranges: Array<[number, number]>;
  /** A structural change no range can express — the caller must full-render. */
  bail: string | null;
}

/** Which measures the signature changes since the baseline govern. */
export function signatureRanges(req: RangeRequest): RangeResult {
  const { measures, ids, idIdx, oldState, newState } = req;
  const n = measures.length;
  const ranges: Array<[number, number]> = [];
  /* A signature change at measure p also re-engraves measure p−1: Verovio
     draws the end-of-line courtesy (key/meter) there, and `relocateInitialClefs`
     puts a measure-initial clef's change glyph there. Without the predecessor
     in the run, the line above renders as an unchanged CONTEXT line that has in
     fact changed, and the context check (correctly) refuses — found by
     pageKeyChangeSplicesGovernedRange on its first run (dW 101 on the line
     above). Every range therefore starts one measure early. */
  const push = (lo: number, hi: number): void => {
    lo = Math.max(0, lo - 1); hi = Math.min(n - 1, hi);
    if (lo <= hi) ranges.push([lo, hi]);
  };
  /* positions of the NEW interior entries, for "next reset" lookups */
  const posOf = (e: InteriorEntry): number => idIdx.get(e.nextId) ?? n;
  const nextReset = (after: number, kind: 'key' | 'meter'): number => {
    let best = n;
    for (const e of newState.interior) {
      const p = posOf(e);
      if (p > after && p < best && e[kind] !== '') best = p;
    }
    return best;
  };

  /* head */
  if (oldState.head.rest !== newState.head.rest) return { ranges, bail: 'head context changed' };
  if (oldState.head.key !== newState.head.key) push(0, nextReset(-1, 'key') - 1);
  if (oldState.head.meter !== newState.head.meter) push(0, nextReset(-1, 'meter') - 1);

  /* interior: align by the id of the FOLLOWING measure, never by element
     identity — undo/redo/restoreSnapshot swap the whole document object, so
     every scoreDef element is new and identity would read each one as removed
     and re-added, turning every undo into a whole-document range and a derive
     (found by cb-bigrange.js's undo step: three derives, zero naturals
     windows, and a sweep that no longer finished). Two scoreDefs before one
     measure merge into one entry. A removed entry anchors at its successor's
     new position (or the run start when that measure is gone). */
  const byNext = (list: InteriorEntry[]): Map<string, InteriorEntry> => {
    const m = new Map<string, InteriorEntry>();
    for (const e of list) {
      const prev = m.get(e.nextId);
      m.set(e.nextId, prev ? {
        ...e, key: e.key || prev.key, meter: e.meter || prev.meter,
        rest: prev.rest + e.rest, structural: prev.structural || e.structural,
      } : e);
    }
    return m;
  };
  const oldBy = byNext(oldState.interior), newBy = byNext(newState.interior);
  const fallbackPos = req.changedNew.length ? Math.min(...req.changedNew) : 0;
  const consider = (kind: 'key' | 'meter', pos: number): void => push(pos, nextReset(pos, kind) - 1);
  for (const [nid, e] of newBy) {
    const o = oldBy.get(nid);
    const pos = idIdx.get(nid) ?? n;
    if (!o) {
      if (e.structural) return { ranges, bail: 'interior structure changed' };
      if (e.key !== '') consider('key', pos);
      if (e.meter !== '') consider('meter', pos);
      continue;
    }
    if (o.rest !== e.rest) return { ranges, bail: 'interior structure changed' };
    if (o.key !== e.key) consider('key', pos);
    if (o.meter !== e.meter) consider('meter', pos);
  }
  for (const [nid, o] of oldBy) {
    if (newBy.has(nid)) continue;
    if (o.structural) return { ranges, bail: 'interior structure changed' };
    const pos = idIdx.get(nid) ?? fallbackPos;
    if (o.key !== '') consider('key', pos);
    if (o.meter !== '') consider('meter', pos);
  }

  /* inline clefs: a changed measure whose per-staff clef tags differ governs
     that staff up to its next clef */
  for (const j of req.changedNew) {
    const id = ids[j];
    const before = req.oldSig.get(id);
    const after = req.newSig(id);
    if (before === undefined || after === undefined) continue;
    if (!/<clef\b/.test(before) && !/<clef\b/.test(after)) continue;
    const a = clefsByStaff(before), b = clefsByStaff(after);
    for (const staff of new Set([...a.keys(), ...b.keys()])) {
      if ((a.get(staff) ?? '') !== (b.get(staff) ?? '')) push(j, clefRangeEnd(measures, j, staff));
    }
  }
  return { ranges, bail: null };
}

/** A scoreDef's `rest` when it carries nothing but key/meter: the bare element,
 *  so a purely signature-bearing scoreDef never reads as a structural change. */
function bareRest(sd: Element): string {
  const clone = sd.cloneNode(false) as Element;
  for (const a of Array.from(clone.attributes)) clone.removeAttribute(a.name);
  return new XMLSerializer().serializeToString(clone);
}

/** Union of inclusive ranges with an existing [lo, hi] run (either may be
 *  empty: lo > hi). */
export function unionRun(lo: number, hi: number, ranges: Array<[number, number]>): { lo: number; hi: number } {
  let L = lo, H = hi;
  for (const [a, b] of ranges) {
    if (L > H) { L = a; H = b; continue; }
    L = Math.min(L, a); H = Math.max(H, b);
  }
  return { lo: L, hi: H };
}
