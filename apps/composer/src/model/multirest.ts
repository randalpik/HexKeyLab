/* Multimeasure rests (2026-09-11) — render-time collapse over "render units".
 *
 * The live document keeps every measure. In a view that shows exactly ONE
 * staff (a one-staff instrument's part, or a one-staff score) a run of ≥2
 * consecutive measures whose cell carries `data-hkl-multirest` (and is still
 * empty — the flag is necessary, emptiness is re-checked here) is engraved as
 * ONE measure holding `<multiRest num="N"/>`. The representative is the run's
 * FIRST measure: it keeps its xml:id, @n, control events, @left and its
 * <staff>/<layer> xml:ids (the cursor and click code map rendered ids back to
 * the model through them); it takes the LAST measure's @right; measures 2..N
 * are removed from the render clone only.
 *
 * A run never crosses a hard boundary, so the line-break owner's hard-start
 * ids and user-break signature stay truthful and the run is one rendered
 * measure that can never straddle a system:
 *   - same parent (<section>, or the same <ending>) and adjacent siblings —
 *     any <scoreDef>/<sb>/<pb> between two measures breaks the run;
 *   - no section start (`data-hkl-section-title`) or pickup (@n="0") inside;
 *   - interior measures (2..N) carry no control events (any `measure > *`
 *     other than <staff>), no @left and no @right; the first may carry
 *     control events and @left="rptstart", the last may carry @right;
 *   - a spanner anchored by @tstamp2="Nm+…" (hairpin, pedal, octave, gradual
 *     tempo) whose span covers a measure makes that measure ineligible as an
 *     INTERIOR, so the run breaks before it (the collapsed measure count would
 *     otherwise falsify the offset).
 *
 * The RenderUnitIndex is the single source of truth for "which measures render
 * as one": the serialize pass TAKES its runs (never recomputes), and the
 * renderer / cursor / selection / input consult it through
 * ComposerModel.renderUnits(viewStaves). */

import { el, type ComposerModel } from './index.js';
import { MULTIREST_ATTR, staffInMeasure, staffCellIsEmpty } from './empty-flags.js';

export interface Run {
  /** Inclusive document-order measure indices. */
  lo: number;
  hi: number;
  /** xml:id of every member, lo..hi; `memberIds[0]` is the representative. */
  memberIds: string[];
}

function idOf(m: Element): string {
  return m.getAttribute('xml:id') ?? '';
}

function isPickup(m: Element): boolean {
  return m.getAttribute('n') === '0';
}

/** xml:id → staff @n for every element inside a <staff>, so a spanner that
 *  names its notes (@startid/@endid, no @staff — slurs, ties, trills) can be
 *  attributed to a staff. */
function idStaffMap(measures: Element[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of measures) {
    for (let st = m.firstElementChild; st; st = st.nextElementSibling) {
      if (st.localName !== 'staff') continue;
      const n = parseInt(st.getAttribute('n') ?? '', 10);
      if (!Number.isFinite(n)) continue;
      for (const e of Array.from(st.querySelectorAll('[*|id]'))) {
        const id = e.getAttribute('xml:id');
        if (id) out.set(id, n);
      }
    }
  }
  return out;
}

/** Does a control event concern staff `staffN`? By @staff when it has one;
 *  else by the staff of its start/end note (a piano slur running under a
 *  viola rest names piano notes); an event with neither (a score-global
 *  tempo, a dir with no staff) concerns every staff. One that concerns other
 *  staves only is invisible in this staff's view — the single-part filter
 *  drops it — and must not break the run. */
function concernsStaff(ev: Element, staffN: number, idStaff: Map<string, number>): boolean {
  const st = ev.getAttribute('staff');
  if (st) return st.split(/\s+/).includes(String(staffN));
  let resolved = false;
  for (const attr of ['startid', 'endid', 'plist']) {
    const raw = ev.getAttribute(attr);
    if (!raw) continue;
    for (const ref of raw.split(/\s+/)) {
      const n = idStaff.get(ref.replace(/^#/, ''));
      if (n === undefined) continue;
      resolved = true;
      if (n === staffN) return true;
    }
  }
  return !resolved;
}

function hasControlEvents(m: Element, staffN: number, idStaff: Map<string, number>): boolean {
  for (let c = m.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName !== 'staff' && concernsStaff(c, staffN, idStaff)) return true;
  }
  return false;
}

/** Measures covered by a @tstamp2="Nm+…" spanner's span (host+1 .. host+N)
 *  on this staff: none of them may be an interior member. */
function spanCoveredMeasures(measures: Element[], staffN: number, idStaff: Map<string, number>): Set<number> {
  const covered = new Set<number>();
  for (let h = 0; h < measures.length; h++) {
    for (let c = measures[h].firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName === 'staff' || !concernsStaff(c, staffN, idStaff)) continue;
      const t2 = c.getAttribute('tstamp2');
      const mm = t2 ? /^([0-9]+)m\+/.exec(t2) : null;
      if (!mm) continue;
      const n = Number(mm[1]);
      for (let k = h + 1; k <= Math.min(measures.length - 1, h + n); k++) covered.add(k);
    }
  }
  return covered;
}

/** Contiguous runs of ≥2 collapsible measures for `staffN`, in document order. */
export function collapsibleRuns(measures: Element[], staffN: number): Run[] {
  const n = measures.length;
  if (n < 2) return [];
  const flaggedEmpty = (i: number): boolean => {
    const st = staffInMeasure(measures[i], staffN);
    return !!st && st.getAttribute(MULTIREST_ATTR) === 'true' && staffCellIsEmpty(st);
  };
  const idStaff = idStaffMap(measures);
  const covered = spanCoveredMeasures(measures, staffN, idStaff);
  /** May `next` (index j) follow `prev` (index j-1) inside one run? */
  const canJoin = (j: number): boolean => {
    const prev = measures[j - 1], next = measures[j];
    if (prev.parentElement !== next.parentElement) return false;
    if (prev.nextElementSibling !== next) return false;          // a scoreDef/sb/pb sits between
    if (isPickup(next) || next.hasAttribute('data-hkl-section-title')) return false;
    if (hasControlEvents(next, staffN, idStaff) || next.hasAttribute('left')) return false;
    if (prev.hasAttribute('right')) return false;                 // prev would become interior
    if (covered.has(j)) return false;
    return true;
  };
  const runs: Run[] = [];
  let i = 0;
  while (i < n) {
    if (!flaggedEmpty(i) || isPickup(measures[i])) { i++; continue; }
    let j = i;
    while (j + 1 < n && flaggedEmpty(j + 1) && canJoin(j + 1)) j++;
    if (j > i) {
      const memberIds: string[] = [];
      for (let k = i; k <= j; k++) memberIds.push(idOf(measures[k]));
      runs.push({ lo: i, hi: j, memberIds });
    }
    i = j + 1;
  }
  return runs;
}

/** Per-measure view of the runs. `active` is false when the view has more than
 *  one staff (nothing collapses) or no run exists; every query then degrades to
 *  the identity. */
export class RenderUnitIndex {
  readonly active: boolean;
  /** Cache/identity: changes whenever a run forms, dissolves or moves. */
  readonly sig: string;
  private readonly lo: Int32Array;
  private readonly hi: Int32Array;

  constructor(readonly measureCount: number, readonly runs: readonly Run[]) {
    this.lo = new Int32Array(measureCount);
    this.hi = new Int32Array(measureCount);
    for (let i = 0; i < measureCount; i++) { this.lo[i] = i; this.hi[i] = i; }
    for (const r of runs) {
      for (let k = r.lo; k <= r.hi; k++) { this.lo[k] = r.lo; this.hi[k] = r.hi; }
    }
    this.active = runs.length > 0;
    this.sig = runs.map((r) => r.lo + '-' + r.hi).join(',');
  }

  /** Inclusive [lo, hi] of the unit containing `mi` (identity outside runs). */
  unitOf(mi: number): [number, number] {
    if (mi < 0 || mi >= this.measureCount) return [mi, mi];
    return [this.lo[mi], this.hi[mi]];
  }

  /** The measure that stands for `mi` in the render (the run's first). */
  repIdxOf(mi: number): number {
    return mi >= 0 && mi < this.measureCount ? this.lo[mi] : mi;
  }

  /** True for members 2..N of a run: they have no rendered counterpart. */
  isInterior(mi: number): boolean {
    return mi >= 0 && mi < this.measureCount && this.lo[mi] !== mi;
  }

  /** True when `mi` starts a run of ≥2 (renders as a multimeasure rest). */
  isRunStart(mi: number): boolean {
    return mi >= 0 && mi < this.measureCount && this.lo[mi] === mi && this.hi[mi] !== mi;
  }

  /** Expand an inclusive index range outward to unit boundaries. */
  snap(lo: number, hi: number): [number, number] {
    const a = Math.max(0, Math.min(lo, hi)), b = Math.min(this.measureCount - 1, Math.max(lo, hi));
    if (!this.active || a > b) return [lo, hi];
    return [this.lo[a], this.hi[b]];
  }
}

/** Identity index: nothing collapses. */
export function identityUnits(measureCount: number): RenderUnitIndex {
  return new RenderUnitIndex(measureCount, []);
}

/** Apply the collapse to a render CLONE (whole-doc or range). Each run whose
 *  representative is present becomes one measure with a <multiRest num="N"/>;
 *  its interior members present in the clone are removed. Returns the number
 *  of runs collapsed. With `strict`, a run only partly inside the clone (some
 *  members present, others not) throws — the tripwire for a range serialize
 *  that cut a run, which serializeRangeForRender's unit snap should prevent. */
export function collapseMultiRests(clone: Document, runs: readonly Run[], strict = false): number {
  if (!runs.length) return 0;
  const byId = new Map<string, Element>();
  for (const m of Array.from(clone.querySelectorAll('measure'))) byId.set(idOf(m), m);
  let collapsed = 0;
  for (const run of runs) {
    const members = run.memberIds.map((id) => byId.get(id) ?? null);
    const present = members.filter((m): m is Element => m !== null);
    if (present.length === 0) continue;
    if (present.length !== members.length) {
      if (strict) {
        throw new Error(`[multirest] run m${run.lo + 1}–m${run.hi + 1} only partly inside the render clone (${present.length}/${members.length})`);
      }
      /* Lenient: leave the partial run uncollapsed rather than mis-count it. */
      continue;
    }
    const rep = members[0]!;
    const last = members[members.length - 1]!;
    const right = last.getAttribute('right');
    if (right) rep.setAttribute('right', right);
    const staff = rep.querySelector(':scope > staff');
    if (!staff) continue;
    const layers = Array.from(staff.children).filter((c) => c.localName === 'layer');
    const layer1 = layers[0] ?? staff.appendChild(el(clone, 'layer', { n: '1' }));
    while (layer1.firstChild) layer1.removeChild(layer1.firstChild);
    layer1.appendChild(el(clone, 'multiRest', { num: String(run.hi - run.lo + 1) }));
    for (const extra of layers.slice(1)) staff.removeChild(extra);
    for (let k = 1; k < members.length; k++) members[k]!.parentNode?.removeChild(members[k]!);
    collapsed++;
  }
  return collapsed;
}
