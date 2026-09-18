// Scroll-view spot-splice engine (Phase B2).
//
// Verovio re-lays-out the whole document on every loadData and has no
// incremental API, so a full re-engrave of the 446-bar sonata costs ~3.8 s.
// Instead we render the whole score ONCE into a persistent single-system SVG
// (Renderer.renderSingleSystem) and thereafter, on each edit, re-engrave only a
// small run of measures and splice the result into the live SVG — every other
// measure's glyphs are untouched.
//
// The hard problem is vertical: a re-engraved sub-range produces identical x +
// within-staff content but DIFFERENT inter-staff gaps, because Verovio sizes
// each gap to that system's max inter-staff content and a sub-range lacks the
// measures that drive the full system's gaps. The solution (validated by the
// B2 spike) is a SYNTHETIC SPACER measure: one extra measure, rendered then
// discarded, whose per-gap content forces each inter-staff gap to exactly the
// full render's value. The mechanism is `stem.len` on a stemmed note — linear
// (≈ unit·scale/100 px per unit), fractional, so gap = slope·stem.len +
// intercept inverts to hit any px target. Each staff gets a LOCAL forced treble
// clef (confined to the discarded measure) so the control note sits on one fixed
// line (f5) regardless of the real clef, and its down-stem protrudes only BELOW
// its staff. With the gaps reproduced (dy ≈ 0) the edited measures splice in
// with a single x-translate, cross-staff spanners correct by construction.
//
// See docs/composer-spot-splice-design.md.

import type { VerovioToolkit } from '@hkl/notation/verovio-types.js';
import { CONTROL_EVENT_NAMES } from '../model/index.js';
import type { ComposerModel } from '../model/index.js';
import { captureSigState, signatureRanges, unionRun, type SigState } from './sigranges.js';
import {
  captureScrollBox, fitScrollBoxHeight, fitScrollBoxWidth, measureRight, type ScrollBox,
} from './scrollbox.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const idOf = (m: Element): string => m.getAttribute('xml:id') || m.getAttribute('id') || '';

/** The section's measures in DOCUMENT ORDER — the model's coordinate system
 *  (allMeasures / cursor / dirty ranges), `<ending>`-wrapped measures INCLUDED.
 *  The splicer must share this frame: reading the model's dirty range against a
 *  direct-children-only list skewed every index past the first volta and made
 *  post-ending edits splice silently stale (lessons.md "Two measure coordinate
 *  systems", 2026-08-30). */
const sectionMeasures = (section: Element): Element[] =>
  Array.from(section.querySelectorAll('measure'));

/** Test-mode consistency gate, mirrors model/index.ts indexCheckEnabled —
 *  enabled by HKL_INDEX_CHECK=1 in the test runner. */
function indexCheckEnabled(): boolean {
  return typeof globalThis !== 'undefined' &&
    (globalThis as { __HKL_INDEX_CHECK?: boolean }).__HKL_INDEX_CHECK === true;
}

/** Everything the splicer needs from the Renderer to drive Verovio + match its
 *  post-render treatment. `optionsNone` MUST be the same buildOptions('none')
 *  the full render used (so the sub-render's gaps + x match). */
export interface SpliceCtx {
  container: HTMLElement;
  toolkit: VerovioToolkit;
  optionsNone: object;
  postProcess: (el: HTMLElement) => void;
  scale: number;
}

/** Vertical extent (top/bottom, screen px) of a g.staff's 5 staff lines. */
function staffLineExtent(staffEl: Element): { top: number; bot: number } {
  let top = Infinity, bot = -Infinity;
  for (const p of Array.from(staffEl.querySelectorAll(':scope > path'))) {
    const r = (p as Element).getBoundingClientRect();
    if (r.top < top) top = r.top;
    if (r.bottom > bot) bot = r.bottom;
  }
  return { top, bot };
}

/** Tolerance (user units) for "the two renders agree on the vertical frame".
 *  A staff-line y is exact arithmetic in both renders, so this only absorbs
 *  float noise — it is NOT a fudge factor for genuinely different spacing. */
const FRAME_EPS = 0.75;

/** STRUCTURAL geometry of a measure: the top staff-line y of each of its
 *  staves, plus the left x they share. Read from the horizontal staff-line
 *  paths, so it describes the SYSTEM FRAME and nothing about the measure's
 *  content.
 *
 *  That distinction is the whole point. The splicer used to align the fresh run
 *  by the anchor measure's INK bbox, on the stated assumption that the anchor is
 *  "an UNCHANGED measure present in both renders" — but the anchor is
 *  `lo > 0 ? lo - 1 : 0`, so when the edit is in the FIRST measure the anchor is
 *  the edited measure itself and its ink bbox has just changed. Measured
 *  2026-09-13 on a grand staff: adding a high note to bar 1 gave dy = +267 where
 *  the true frame delta was -885, leaving bar 1's staves 1152 user units
 *  (~115 px) below bars 2-4 while the brace and the system's left line — which
 *  the splicer never touches — stayed with the untouched bars. Staff lines are
 *  immune: they move only when the frame moves. */
function staffFrameOf(measureEl: Element): { x: number; ys: number[] } | null {
  const ys: number[] = [];
  let x = Infinity;
  for (const st of Array.from(measureEl.querySelectorAll(':scope > g.staff'))) {
    let top = Infinity;
    for (const p of Array.from(st.querySelectorAll(':scope > path'))) {
      let b: DOMRect;
      try { b = (p as SVGGraphicsElement).getBBox(); } catch { continue; }
      if (b.height >= 1) continue;              // vertical/decorative, not a staff line
      if (b.y < top) top = b.y;
      if (b.x < x) x = b.x;
    }
    if (!isFinite(top)) return null;
    ys.push(top);
  }
  return ys.length && isFinite(x) ? { x, ys } : null;
}

/** An element's current translate, for read-modify-write on system furniture
 *  (the brace, the system's left line, the section milestones) — elements the
 *  splicer holds no index for. */
function translateOf(el: Element): { x: number; y: number } {
  const m = /translate\(\s*(-?[\d.eE+]+)[\s,]+(-?[\d.eE+]+)\s*\)/.exec(el.getAttribute('transform') ?? '');
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
}

/** Inter-staff gaps (screen px) of a measure's adjacent staff pairs. */
function gapsOfMeasure(measureEl: Element, nStaves: number): number[] {
  const staves = Array.from(measureEl.querySelectorAll(':scope g.staff')).map(staffLineExtent);
  const gaps: number[] = [];
  for (let k = 0; k < nStaves - 1; k++) {
    gaps.push(staves[k] && staves[k + 1] ? staves[k + 1].top - staves[k].bot : NaN);
  }
  return gaps;
}

export class ScrollSplicer {
  private ready = false;
  private sysEl: SVGGElement | null = null;
  private defsEl: Element | null = null;
  private order: string[] = [];               // measure ids in document order
  private sig = new Map<string, string>();     // id → serialized measure source
  private tx = new Map<string, number>();      // id → applied translate.x (user units)
  private ty = new Map<string, number>();      // id → applied translate.y (user units)
  private sigState: SigState | null = null;    // head/interior signature state (sigranges.ts)
  private nStaves = 0;
  private gapPx: number[] = [];                // captured inter-staff gaps (screen px)
  private law: Array<{ slope: number; intercept: number }> = [];
  /** The persistent SVG's box <-> content offsets (render/scrollbox.ts). Null
   *  until the first capture; the splicer is the only writer thereafter. */
  private box: ScrollBox | null = null;
  /** Why the last splice() returned false. Surfaced by renderScroll's warning
   *  so a fall-through to a full re-engrave names its cause. */
  lastSkipReason = '';

  /** Drop persistent state — the next render must be a full one. */
  invalidate(): void { this.ready = false; this.box = null; }
  canSplice(): boolean { return this.ready; }

  /* ── capture (after a full render) ───────────────────────────────────────── */

  /** Record the persistent SVG's measure index, inter-staff gaps, and calibrate
   *  the stem.len→gap law. Call right after renderSingleSystem writes the SVG.
   *  Works from the model's LIVE doc (untransformed) — measure signatures are
   *  taken there so the per-edit diff never needs the O(total) render-serialize. */
  capture(model: ComposerModel, ctx: SpliceCtx): void {
    this.ready = false;
    const root = ctx.container.querySelector('svg');
    const sys = ctx.container.querySelector('g.system') as SVGGElement | null;
    const defs = root ? root.querySelector('defs') : null;
    if (!root || !sys) return;                  // nothing rendered (e.g. load error)
    this.sysEl = sys;
    this.defsEl = defs;

    const live = model.getDoc();
    const section = live.querySelector('section');
    if (!section) return;
    const meiMeasures = sectionMeasures(section);
    this.order = meiMeasures.map(idOf);
    this.sig = new Map();
    this.tx = new Map();
    this.ty = new Map();
    const ser = new XMLSerializer();
    for (const m of meiMeasures) {
      const id = idOf(m);
      this.sig.set(id, ser.serializeToString(m));
      this.tx.set(id, 0);
      this.ty.set(id, 0);
    }
    this.sigState = captureSigState(live, this.headExtra(meiMeasures[0], ser));

    const measureEls = Array.from(sys.querySelectorAll('g.measure'));
    this.nStaves = measureEls.length ? measureEls[0].querySelectorAll(':scope g.staff').length : 0;
    this.gapPx = measureEls.length ? gapsOfMeasure(measureEls[0], this.nStaves) : [];

    /* Box <-> content offsets of the render we are about to own (scrollbox.ts).
       Measured against the LAST measure by the same id lookup splice() uses, so
       capture and maintenance share one frame. */
    const lastId = this.order.length ? this.order[this.order.length - 1] : '';
    const lastEl = lastId ? sys.querySelector('#' + CSS.escape(lastId)) : null;
    this.box = captureScrollBox(ctx.container, lastEl as SVGGraphicsElement | null);

    this.calibrate(live, ctx);
    this.ready = this.law.length === this.nStaves - 1 && this.gapPx.every((g) => isFinite(g));
    // The SVG now matches the doc; reset the model's dirty-range so the next
    // edit starts from the conservative 'all' default (Phase B3).
    model.resetRenderDirty();
  }

  /** Section-level elements before the first measure, scoreDefs excluded (those
   *  are interior signature entries, sigranges.ts). Folded into the head's
   *  `rest`: a change here is structural and full-renders. Walks TOP-LEVEL
   *  section siblings: the first measure could itself be `<ending>`-wrapped, and
   *  its in-wrapper siblings aren't head context. */
  private headExtra(firstMeasure: Element | undefined, ser: XMLSerializer): string {
    if (!firstMeasure) return '';
    let top: Element = firstMeasure;
    while (top.parentElement && top.parentElement.localName !== 'section') top = top.parentElement;
    let s = '';
    let n = top.previousElementSibling;
    while (n) { if (n.localName !== 'scoreDef') s = ser.serializeToString(n) + s; n = n.previousElementSibling; }
    return s;
  }

  /* ── calibration: gap = slope·stem.len + intercept, per gap ──────────────── */

  private calibrate(doc: Document, ctx: SpliceCtx): void {
    const scoreDef = doc.querySelector('scoreDef');
    if (!scoreDef) { this.law = []; return; }
    const head = new XMLSerializer().serializeToString(scoreDef);
    const A = 30, B = 45;
    const gA = this.renderCalGaps(head, A, ctx);
    const gB = this.renderCalGaps(head, B, ctx);
    this.law = [];
    for (let k = 0; k < this.nStaves - 1; k++) {
      const slope = (gB[k] - gA[k]) / (B - A);
      const intercept = gA[k] - slope * A;
      this.law.push({ slope, intercept });
    }
  }

  private renderCalGaps(headScoreDef: string, stemLen: number, ctx: SpliceCtx): number[] {
    const sl = new Array(Math.max(0, this.nStaves - 1)).fill(stemLen);
    const mei = `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="${MEI_NS}" meiversion="5.0"><meiHead><fileDesc><titleStmt><title/></titleStmt></fileDesc></meiHead><music><body><mdiv><score>${headScoreDef}<section>${this.synthMeasure(sl)}</section></score></mdiv></body></music></mei>`;
    const host = this.renderOffscreen(mei, ctx);
    const m = host.querySelector('g.measure');
    const gaps = m ? gapsOfMeasure(m, this.nStaves) : [];
    host.remove();
    return gaps;
  }

  /** Synthetic spacer measure: each staff gets a LOCAL treble clef + a note on
   *  f5 (treble top line) with a down-stem of the given length, so it protrudes
   *  only below its staff (into the gap below). Staff s (1..nGap) drives gap
   *  s-1; the bottom staff is a non-protruding filler. dur="4" — whole notes
   *  have no stem, so stem.len would be a no-op. */
  private synthMeasure(stemLens: number[]): string {
    const nGap = this.nStaves - 1;
    let staves = '';
    for (let s = 1; s <= this.nStaves; s++) {
      const note = s <= nGap
        ? `<note dur="4" oct="5" pname="f" stem.dir="down" stem.len="${stemLens[s - 1]}"/>`
        : `<note dur="4" oct="5" pname="f"/>`;
      staves += `<staff n="${s}"><layer n="1"><clef shape="G" line="2"/>${note}</layer></staff>`;
    }
    return `<measure n="9990" xml:id="hkl-spacer">${staves}</measure>`;
  }

  /** Solve stem.len per gap to reproduce the captured persistent gaps. */
  private solveStemLens(): number[] {
    return this.gapPx.map((g, k) => (g - this.law[k].intercept) / this.law[k].slope);
  }

  /** Insert the synthetic spacer measure into a range sub-MEI (from
   *  model.serializeRangeForRender) just before the closing </section>. The
   *  spacer reproduces the persistent inter-staff gaps so the edited measures
   *  splice in with a single x/y translate. */
  private insertSpacer(rangeMei: string): string {
    const spacer = this.synthMeasure(this.solveStemLens());
    const i = rangeMei.lastIndexOf('</section>');
    return i < 0 ? rangeMei : rangeMei.slice(0, i) + spacer + rangeMei.slice(i);
  }

  /* ── splice ──────────────────────────────────────────────────────────────── */

  /** Surgically splice the current model edit into the persistent SVG. Works
   *  from the LIVE doc + model.serializeRangeForRender (O(edited-range), no
   *  whole-doc serialize/parse). Returns true on success; false if the change
   *  can't be spliced (caller must full-render) — NEVER silently full-renders. */
  splice(model: ComposerModel, viewStaves: number[] | null, ctx: SpliceCtx): boolean {
    this.lastSkipReason = '';
    if (!this.ready || !this.sysEl) { this.lastSkipReason = 'splicer not ready'; return false; }
    const live = model.getDoc();
    const section = live.querySelector('section');
    if (!section) return false;
    const meiMeasures = sectionMeasures(section);
    const newOrder = meiMeasures.map(idOf);
    const ser = new XMLSerializer();
    // Per-measure signatures for the diff. The expensive part on a large score
    // is serializing every measure; when the model reports a narrow dirty-range
    // (Phase B3) and the measure count is unchanged (a content edit), we
    // re-serialize ONLY the dirty window and REUSE last render's cached sigs for
    // every other id (guaranteed unchanged — see ComposerModel.renderDirty).
    // The prefix/suffix diff below is untouched: it still discovers the true run
    // structurally, so a too-tight range can't silently corrupt — it would make
    // a changed measure look unchanged and the test-mode gate would catch it.
    const dirty = model.renderDirtyRange();
    const newSig = new Map<string, string>();
    if (dirty !== 'all' && newOrder.length === this.order.length) {
      for (let i = 0; i < newOrder.length; i++) {
        const id = newOrder[i];
        if (i >= dirty.lo && i <= dirty.hi) { newSig.set(id, ser.serializeToString(meiMeasures[i])); continue; }
        const cached = this.sig.get(id);
        newSig.set(id, cached !== undefined ? cached : ser.serializeToString(meiMeasures[i]));
      }
      if (indexCheckEnabled()) this.assertDirtyRangeCoversChanges(meiMeasures, newOrder, newSig, ser);
    } else {
      for (const m of meiMeasures) newSig.set(idOf(m), ser.serializeToString(m));
    }

    if (meiMeasures.length && meiMeasures[0].querySelectorAll('staff').length !== this.nStaves) return false;

    // Diff: common prefix + suffix by (id, signature) → the changed run.
    const oldOrder = this.order;
    const oN = oldOrder.length, nN = newOrder.length;
    const eq = (i: number, j: number) =>
      oldOrder[i] === newOrder[j] && this.sig.get(oldOrder[i]) === newSig.get(newOrder[j]);
    let P = 0;
    while (P < Math.min(oN, nN) && eq(P, P)) P++;
    let Sx = 0;
    while (Sx < Math.min(oN, nN) - P && eq(oN - 1 - Sx, nN - 1 - Sx)) Sx++;
    let lo = P, hiNew = nN - 1 - Sx;            // changed run, NEW index
    let oldLo = P, oldHi = oN - 1 - Sx;          // changed run, OLD index

    // Signature changes govern RANGES (sigranges.ts, Max 2026-09-01): a clef,
    // key or meter change re-engraves the measures up to the next change of the
    // same kind. Head and mid-piece scoreDefs are invisible to the per-measure
    // diff — before this, a mid-piece key change in scroll view rendered
    // NOTHING (the diff saw no change) — and an inline clef change governs far
    // beyond its measure. Structural changes (staffDefs, elements before the
    // first measure) still full-render.
    const newState = captureSigState(live, this.headExtra(meiMeasures[0], ser));
    const idIdx = new Map(newOrder.map((id, i) => [id, i]));
    const changedNew: number[] = [];
    for (let j = lo; j <= hiNew; j++) changedNew.push(j);
    const sr = signatureRanges({
      oldSig: this.sig, newSig: (id) => newSig.get(id), changedNew,
      measures: meiMeasures, ids: newOrder, idIdx,
      oldState: this.sigState ?? newState, newState,
    });
    if (sr.bail) return false;
    /* Commit the signature state now: a splice that fails below full-renders,
       and capture() then recaptures it from the document anyway. */
    this.sigState = newState;
    if (sr.ranges.length) {
      const u = unionRun(lo, hiNew, sr.ranges);
      lo = u.lo; hiNew = u.hi;
      oldLo = lo; oldHi = hiNew + (oN - nN);
    }
    if (hiNew < lo && oldHi < oldLo) return true; // nothing changed

    // SCORE START (Max, backlog Layout — 2026-09-17). Verovio draws the
    // system-initial clef, key and meter INSIDE the first measure's `g.staff`,
    // and gives that measure the staff lines that reach back to the system
    // origin; every later measure is drawn without any of it. The furniture
    // therefore belongs to whichever measure is FIRST, not to a particular
    // measure — so a run at index 0 that changes WHICH measure that is has to
    // re-engrave the incoming one.
    //
    // Deleting a pickup (backspace at the very start of the piece) is the case
    // Max reported: the prefix/suffix diff produced old [0..0] / new EMPTY —
    // remove the pickup, import nothing — so the promoted measure kept the
    // mid-system rendering it already had, and the score opened on blank paper
    // with the music starting a measure-width in. The brace and the system's
    // left line are SYSTEM-level children, untouched by measure surgery, which
    // is why they survived and it read as "the staff heading disappeared".
    //
    // Widening the NEW run to cover index 0 puts the incoming first measure in
    // the imported set; the countDelta mirror below then carries the OLD run
    // back over old index 0, so the outgoing one is removed. `nN - oN` covers
    // the other direction: measures PREPENDED to the score demote the old first
    // measure, which must lose its furniture, so the run has to reach past them
    // to it. (Adding a pickup happens to full-render today, but the diff shape
    // is the mirror image and must not depend on that.)
    if (lo === 0 && nN > 0) hiNew = Math.max(hiNew, 0, nN - oN);

    // `relocateInitialClefs` draws measure lo's measure-initial clef at the END
    // of measure lo-1, so an edit that makes a clef measure-initial (or stops it
    // being so) re-engraves the predecessor — which this splice would otherwise
    // keep as its untouched anchor. Any layer clef in the run's first measure
    // pulls lo-1 into the run (same rule as the page splicer, 2026-09-01).
    if (lo > 0 && meiMeasures[lo].querySelector(':scope > staff > layer > clef')) lo--;
    // Expand the NEW run outward until no spanner crosses its endpoints, then
    // until every touched <ending> is contained whole (run AND context slots).
    [lo, hiNew] = expandForSpanners(meiMeasures, lo, hiNew);
    [lo, hiNew] = expandForEndings(meiMeasures, lo, hiNew);
    // Mirror the expansion onto the OLD run. Measures BEFORE the run align 1:1
    // (common prefix), and measures AFTER it align 1:1 (common suffix, shifted by
    // the measure-count delta), so: oldLo = lo, and oldHi tracks hiNew by the
    // count delta (oN−nN). Forgetting to move oldHi when the run expands inserts
    // more measures than it removes → DUPLICATE measures in the SVG.
    const countDelta = oN - nN;
    oldLo = lo;
    oldHi = hiNew + countDelta;
    /* No run cap (Max, 2026-09-01): a sub-render of the run costs linearly in
       its measures and the full scroll engrave is ~7 s, so even a run that is
       most of the document is the better deal. */

    // Anchor on the LEFT context measure, so the edited run's left edge stays
    // joined to its (unchanged) left neighbour and the width change propagates
    // RIGHTWARD via the cascade. (Anchoring on the RIGHT context — the old
    // behaviour — pinned the right edge and let the left edge float: a deleted
    // note widened/narrowed the measure away from its left neighbour, opening a
    // gap or overlap. That's the disconnect bug.)
    //
    // The sub-render's FIRST measure (cLo) carries a spurious system-initial
    // clef/key/meter, so its x/width don't match a mid-system measure — it must
    // never be the anchor nor in the run. Two left-context measures put the
    // anchor (lo-1) in the SECOND slot, untainted. A run at measure 0 is
    // genuinely system-first in BOTH renders, so anchoring there is consistent.
    // The right context (cHi) is included only as the cascade's shift reference.
    const rightAvail = hiNew < nN - 1;
    const leftCtx = Math.min(2, lo);
    const cLo = lo - leftCtx;
    const cHi = rightAvail ? hiNew + 1 : hiNew;
    // Anchor ids — the measure whose staff frame maps the sub-render onto the
    // persistent x/y frame. Normally the unchanged left-context measure (lo−1),
    // which is the SAME element in both renders. At lo === 0 there is no left
    // context, and the two sides can be different measures: the sub-render's
    // anchor is its own first measure (system-first, staff frame at the system
    // origin) while the persistent anchor must be the measure that is first
    // TODAY — `this.order[0]` — because that is the element carrying the
    // origin's frame. They are the same id for an ordinary content edit at
    // measure 0, and differ exactly when the edit changes which measure starts
    // the score. Reading both from `newOrder[0]` there would anchor the incoming
    // first measure on the position it occupies while still SECOND, leaving the
    // re-engraved score-start furniture a measure-width right of the origin.
    const subAnchorId = lo > 0 ? newOrder[lo - 1] : newOrder[0];
    const perAnchorId = lo > 0 ? newOrder[lo - 1] : (this.order[0] ?? newOrder[0]);
    // Sub-MEI: the model render-serializes ONLY [cLo..cHi] (O(range)), then we
    // append the synthetic spacer that reproduces the persistent gaps.
    const subMei = this.insertSpacer(
      model.serializeRangeForRender(cLo, cHi, { hejiEnabled: model.getHejiEnabled() }, viewStaves));

    ctx.toolkit.setOptions(ctx.optionsNone);
    if (!ctx.toolkit.loadData(subMei)) return false;
    const host = this.makeOffscreen();
    host.innerHTML = ctx.toolkit.renderToSVG(1, {});
    document.body.appendChild(host);
    ctx.postProcess(host);

    /* Volta brackets render as SYSTEM-level glyphs (id = the <ending>'s
       xml:id), NOT inside the measure groups — measure imports and the
       x-cascade never move them, so a re-rendered or shifted ending would keep
       a stale bracket. spliceDom reconciles them: replace from the sub-render
       for endings inside the run, drop orphans, cascade downstream ones. */
    const endings = Array.from(section.querySelectorAll('ending')).map((e) => ({
      id: e.getAttribute('xml:id') ?? '',
      firstMeasureId: idOf(e.querySelector('measure') ?? e),
    })).filter((e) => e.id !== '');

    try {
      return this.spliceDom(host, newOrder, newSig, { lo, hiNew, oldLo, oldHi, cHi, subAnchorId, perAnchorId }, endings, ctx);
    } finally {
      host.remove();
    }
  }

  /** Test-mode gate (HKL_INDEX_CHECK): the cheap dirty-window sig map reused
   *  last render's cached sigs for every measure outside the model's reported
   *  dirty-range. That is only sound if those measures genuinely didn't change.
   *  Re-serialize every measure fresh and assert it equals the cheap map — a
   *  mismatch means the model's dirty-range was too tight (a converted mutation
   *  under-reported its extent), which would silently leave a stale measure in
   *  the SVG. Throw loudly so the offending fixture fails. */
  private assertDirtyRangeCoversChanges(
    meiMeasures: Element[], newOrder: string[], cheapSig: Map<string, string>, ser: XMLSerializer,
  ): void {
    for (let i = 0; i < newOrder.length; i++) {
      const fresh = ser.serializeToString(meiMeasures[i]);
      if (fresh !== cheapSig.get(newOrder[i])) {
        throw new Error(
          `[scroll-splice] dirty-range too tight: measure index ${i} (id ${newOrder[i]}) ` +
          `changed but was outside the model's reported dirty-range — a converted mutation ` +
          `under-reported markDirtyMeasures.`);
      }
    }
  }

  /** The DOM surgery: replace the changed measures, x-translate the new run onto
   *  the persistent x-frame (anchored on an unchanged context measure), cascade
   *  trailing measures, merge glyph defs, and update the index. */
  private spliceDom(
    host: HTMLElement, newOrder: string[], newSig: Map<string, string>,
    r: { lo: number; hiNew: number; oldLo: number; oldHi: number; cHi: number; subAnchorId: string; perAnchorId: string },
    endings: Array<{ id: string; firstMeasureId: string }>,
    ctx: SpliceCtx,
  ): boolean {
    const bbx = (el: Element) => (el as SVGGraphicsElement).getBBox();
    const sub = (id: string) => host.querySelector('#' + CSS.escape(id)) as SVGGElement | null;
    const persist = (id: string) => this.sysEl!.querySelector('#' + CSS.escape(id)) as SVGGElement | null;

    // Anchor the run on the STAFF FRAME of the anchor measure — the staff-line
    // geometry both renders share (staffFrameOf), never the ink bbox. The ink
    // bbox is only a valid anchor while the anchor measure's own content is
    // unchanged, and at lo === 0 the anchor IS the edited measure.
    //
    // FRAME ADOPTION (Max, 2026-09-13). When an edit changes what the system
    // needs vertically — a note high enough to want headroom above the top
    // staff — Verovio re-seats the WHOLE system, and the sub-render already
    // carries that new frame: probed on a grand staff, the spliced bar and a
    // full re-engrave agreed exactly (local staff y 1365/2965 in both). So the
    // sub-render's frame is the correct one and the persistent content is what
    // is stale. Rather than dragging the fresh run back onto the old frame (and
    // clipping the note that asked for the room), the fresh run lands at
    // dy = 0 and every OTHER system child — untouched measures, the brace, the
    // system's left line, the milestones, downstream volta brackets — is
    // migrated by dyFrame below. That is some hundreds of setAttribute calls,
    // the same cost class as the x-cascade that already runs, versus a ~3.8 s
    // full re-engrave; and it self-heals, since afterwards every measure shares
    // the new frame and the next edit computes dyFrame = 0.
    const subAnchor = sub(r.subAnchorId);
    const perAnchor = persist(r.perAnchorId);
    if (!subAnchor || !perAnchor) return false;
    const subFrame = staffFrameOf(subAnchor);
    const perFrame = staffFrameOf(perAnchor);
    if (!subFrame || !perFrame || subFrame.ys.length !== perFrame.ys.length) {
      this.lastSkipReason = 'anchor staff frame unreadable';
      return false;
    }
    const perTy = this.ty.get(r.perAnchorId) ?? 0;
    const dx = (perFrame.x + (this.tx.get(r.perAnchorId) ?? 0)) - subFrame.x;
    // Per-staff frame deltas. They must AGREE: one translate can only re-seat a
    // system whose internal spacing is unchanged. They disagree when the edit
    // changes an inter-staff gap (probed: a high note in the lower staff of a
    // grand staff took the gap 1600 -> 2165 with the top staff unmoved), which
    // needs per-row displacement plus lengthening of every staff-spanning
    // vertical — the barlines, the brace, the system's left line. That is the
    // machinery render/instrgap.ts already implements for page view and is
    // deliberately NOT in this change; refuse so the fall-through re-engrave
    // draws it correctly rather than splicing a system with the wrong gap.
    const frameDeltas = perFrame.ys.map((y, k) => subFrame.ys[k] - (y + perTy));
    const dyFrame = frameDeltas[0];
    if (frameDeltas.some((d) => Math.abs(d - dyFrame) > FRAME_EPS)) {
      this.lastSkipReason = 'inter-staff spacing changed (not yet spliceable — see instrgap.ts)';
      return false;
    }
    // GROW-ONLY, and the asymmetry is load-bearing. dyFrame > 0 means the
    // sub-render seated its staves LOWER than the live ones, i.e. this range now
    // demands more headroom than the system has: adopt, and migrate everything
    // else down to meet it. dyFrame < 0 means it demands LESS — which says
    // nothing about the document, because the sub-render only ever sees
    // [cLo..cHi] and the note that bought that headroom may live anywhere else.
    // Adopting there re-seats the whole system on one range's opinion: measured
    // 2026-09-13, a high note in bar 1 adopted correctly and then the very next
    // edit (four notes appended at the END, a range with nothing tall in it)
    // dragged all six bars back up 885 units and re-clipped the note. So when
    // the sub frame is shallower the persistent frame WINS and the fresh run is
    // seated onto it instead. The frame therefore only ever grows between full
    // renders — it is always >= what every range needs, so nothing clips — and a
    // full re-engrave is what reclaims slack once the tall note is deleted.
    const adopt = dyFrame > FRAME_EPS;
    const freshTy = adopt ? 0 : -dyFrame;
    const xf = `translate(${dx},${freshTy})`;

    // Right-context shift Δ: where the first unchanged trailing measure must move.
    let delta = 0;
    const rcId = r.cHi > r.hiNew ? newOrder[r.cHi] : null;   // unchanged trailing context
    if (rcId) {
      const subRc = sub(rcId), perRc = persist(rcId);
      if (!subRc || !perRc) return false;
      const newRcLeft = bbx(subRc).x + dx;
      const oldRcLeft = bbx(perRc).x + (this.tx.get(rcId) ?? 0);
      delta = newRcLeft - oldRcLeft;
    }

    // Import the changed run's measures (NEW [lo..hiNew]) from the sub-render.
    const fresh: SVGGElement[] = [];
    for (let i = r.lo; i <= r.hiNew; i++) {
      const id = newOrder[i];
      const node = sub(id);
      if (!node) return false;
      const imported = this.sysEl!.ownerDocument.importNode(node, true) as SVGGElement;
      imported.setAttribute('transform', xf);
      fresh.push(imported);
    }
    /* Nodes that came from THIS sub-render, i.e. are already on the new frame.
       Frame adoption below migrates every other system child onto it. */
    const adopted = new Set<Element>(fresh);
    this.mergeDefs(host, fresh);

    // Locate the insertion point + remove the OLD changed run.
    const oldRunIds = this.order.slice(r.oldLo, r.oldHi + 1);
    const insertBefore = (r.oldHi + 1 < this.order.length)
      ? persist(this.order[r.oldHi + 1]) : null;
    for (const id of oldRunIds) { const el = persist(id); if (el) el.remove(); }
    for (const node of fresh) this.sysEl!.insertBefore(node, insertBefore);

    /* Volta brackets: Verovio draws each <ending> as a SYSTEM-level
       `g.ending` group (id = the ending's xml:id) CONTAINING the anonymous
       g.voltaBracket — the member measures stay flat system children. Measure
       imports never carry the bracket group, so reconcile it explicitly:
       (1) drop orphans whose ending left the document; (2) for an ending
       re-rendered inside the run (expandForEndings guarantees whole endings
       land in the run, never in context), replace the persistent group with
       the sub-render's, on the run's (dx, dy) frame like its measures. */
    const newIdxOf = new Map(newOrder.map((id, i) => [id, i]));
    const liveEndingIds = new Set(endings.map((e) => e.id));
    const endingGlyphOf = (id: string): SVGGElement | null => {
      const el = this.sysEl!.querySelector('#' + CSS.escape(id));
      return el && el.classList.contains('ending') ? el as SVGGElement : null;
    };
    for (const eg of Array.from(this.sysEl!.querySelectorAll('g.ending'))) {
      const id = eg.getAttribute('id');
      if (id && !liveEndingIds.has(id)) { eg.remove(); this.tx.delete(id); this.ty.delete(id); }
    }
    for (const sg of Array.from(host.querySelectorAll('g.ending'))) {
      const id = sg.getAttribute('id');
      if (!id || !liveEndingIds.has(id)) continue;
      const e = endings.find((x) => x.id === id)!;
      const fIdx = newIdxOf.get(e.firstMeasureId);
      if (fIdx == null || fIdx < r.lo || fIdx > r.hiNew) continue;
      const imported = this.sysEl!.ownerDocument.importNode(sg, true) as SVGGElement;
      imported.setAttribute('transform', xf);
      endingGlyphOf(id)?.remove();
      this.sysEl!.appendChild(imported);
      this.tx.set(id, dx); this.ty.set(id, freshTy);
      adopted.add(imported);
    }

    // Cascade: shift every measure after the run by Δ in x (preserve its y) —
    // and every downstream volta bracket along with its measures.
    if (delta !== 0) {
      for (let i = r.hiNew + 1; i < newOrder.length; i++) {
        const id = newOrder[i];
        const el = persist(id);
        if (!el) continue;
        const t = (this.tx.get(id) ?? 0) + delta;
        const u = this.ty.get(id) ?? 0;
        this.tx.set(id, t);
        el.setAttribute('transform', `translate(${t},${u})`);
      }
      for (const e of endings) {
        const fIdx = newIdxOf.get(e.firstMeasureId);
        if (fIdx == null || fIdx <= r.hiNew) continue;
        const eg = endingGlyphOf(e.id);
        if (!eg) continue;
        const t = (this.tx.get(e.id) ?? 0) + delta;
        const u = this.ty.get(e.id) ?? 0;
        this.tx.set(e.id, t);
        eg.setAttribute('transform', `translate(${t},${u})`);
      }
    }

    // Update the index: spliced measures carry (dx, freshTy).
    for (let i = r.lo; i <= r.hiNew; i++) { this.tx.set(newOrder[i], dx); this.ty.set(newOrder[i], freshTy); }
    this.order = newOrder;
    this.sig = newSig;
    // Drop entries for ids no longer present (volta-bracket ids count as
    // present — their translate bookkeeping lives in the same maps).
    const present = new Set([...newOrder, ...endings.map((e) => e.id)]);
    for (const id of Array.from(this.tx.keys())) if (!present.has(id)) { this.tx.delete(id); this.ty.delete(id); }
    for (const id of newOrder) { if (!this.tx.has(id)) this.tx.set(id, 0); if (!this.ty.has(id)) this.ty.set(id, 0); }

    /* Frame adoption: migrate everything that did NOT come from this sub-render
       onto the new vertical frame. Deliberately a walk over g.system's direct
       children rather than a list of known classes — that is what covers the
       brace (g.grpSym) and the system's left line (a bare <path>, no class at
       all) without naming them, and it cannot silently miss a system-level
       element Verovio adds later. */
    if (adopt) {
      for (const el of Array.from(this.sysEl!.children)) {
        if (adopted.has(el)) continue;
        const id = el.getAttribute('id');
        if (id !== null && this.ty.has(id)) {
          const u = (this.ty.get(id) ?? 0) + dyFrame;
          this.ty.set(id, u);
          el.setAttribute('transform', `translate(${this.tx.get(id) ?? 0},${u})`);
        } else {
          const cur = translateOf(el);            // system furniture: no index entry
          el.setAttribute('transform', `translate(${cur.x},${cur.y + dyFrame})`);
        }
      }
    }

    /* Re-fit the box to the content (render/scrollbox.ts). Width every time —
       it is one measure bbox and the reason a spliced score stopped being
       reachable at all. Height only on a frame change, where it costs one
       document-wide bbox for exactness. */
    if (this.box) {
      const lastId = newOrder[newOrder.length - 1];
      const lastEl = lastId ? persist(lastId) : null;
      const lastRight = lastEl ? measureRight(lastEl, this.tx.get(lastId) ?? 0) : null;
      if (lastRight !== null) fitScrollBoxWidth(ctx.container, this.box, lastRight, ctx.scale);
      if (adopt) fitScrollBoxHeight(ctx.container, this.box, ctx.scale);
    }
    return true;
  }

  /* ── glyph defs merge ────────────────────────────────────────────────────── */

  /** See mergeGlyphDefs (shared with the page system splicer). */
  private mergeDefs(host: HTMLElement, fresh: SVGGElement[]): void {
    if (!this.defsEl) return;
    mergeGlyphDefs(this.defsEl, host, fresh);
  }

  /* ── offscreen render helpers ────────────────────────────────────────────── */

  private makeOffscreen(): HTMLElement {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0';
    return host;
  }

  private renderOffscreen(mei: string, ctx: SpliceCtx): HTMLElement {
    ctx.toolkit.setOptions(ctx.optionsNone);
    ctx.toolkit.loadData(mei);
    const host = this.makeOffscreen();
    host.innerHTML = ctx.toolkit.renderToSVG(1, {});
    document.body.appendChild(host);
    return host;
  }
}

/* ── shared splice helpers (scroll splicer + page system splicer) ─────────── */

/** Ensure a persistent <defs> has every glyph the freshly-spliced elements
 *  reference. Verovio defines glyphs as <g id="<SMuFL-codepoint>-<render-salt>">
 *  children of a single <defs> (NOT <symbol>), and the salt is PER RENDER — so
 *  a sub-render's <use href="#E0A4-<subsalt>"> never matches the persistent
 *  "#E0A4-<mainsalt>". Match by codepoint (id up to the first '-'): remap each
 *  <use> to the persistent glyph when its codepoint already exists (the common
 *  case — the spliced content uses glyphs the full render already emitted),
 *  else copy the sub-render's glyph def over. */
export function mergeGlyphDefs(defsEl: Element, host: ParentNode, fresh: Element[]): void {
  const cpOf = (id: string) => id.split('-')[0];
  const setHref = (use: Element, val: string): void => {
    if (use.hasAttribute('xlink:href')) use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', val);
    else use.setAttribute('href', val);
  };
  const persistByCp = new Map<string, string>();
  for (const g of Array.from(defsEl.children)) {
    const id = g.getAttribute('id'); if (id) persistByCp.set(cpOf(id), id);
  }
  const subDefs = host.querySelector('defs');
  const subById = new Map<string, Element>();
  if (subDefs) for (const g of Array.from(subDefs.children)) {
    const id = g.getAttribute('id'); if (id) subById.set(id, g);
  }
  for (const m of fresh) {
    for (const use of Array.from(m.querySelectorAll('use'))) {
      const href = use.getAttribute('xlink:href') || use.getAttribute('href');
      if (!href || !href.startsWith('#')) continue;
      const id = href.slice(1);
      const cp = cpOf(id);
      const existing = persistByCp.get(cp);
      if (existing) {
        if (existing !== id) setHref(use, '#' + existing);
      } else {
        const g = subById.get(id);
        if (g) {
          defsEl.appendChild(defsEl.ownerDocument.importNode(g, true));
          persistByCp.set(cp, id);
        }
      }
    }
  }
}

/* ── shared run-expansion helpers (scroll splicer + page line-break owner) ── */

/** Expand [lo..hi] outward until no tie/slur/hairpin/etc. crosses an endpoint,
 *  so whole spanners land in one re-render / measurement window together.
 *  Shared by the scroll splicer's run expansion and the page-view line-break
 *  owner's naturals windows (a window missing an in-bound spanner renders the
 *  member measures at silently different widths — page spike 1, finding 5). */
/** Resolved spanner extents + per-measure tie edges for one measure array —
 *  everything `expandForSpanners`' growth loop needs, as plain numbers.
 *
 *  HOT PATH (Phase D). The growth loop used to re-query every measure's
 *  subtree on each iteration, so a single call ran O(measures × iterations)
 *  `querySelectorAll`s — on the sonata that was the bulk of ~32 000 DOM queries
 *  per keystroke. The DOM is now read ONCE (one union query per measure), and
 *  the loop is pure array arithmetic. */
interface SpannerExtents {
  /** [minMeasure, maxMeasure] of every spanner that resolves to a range. */
  spans: Array<[number, number]>;
  /** Measure has a note whose @tie marks it a tie TERMINUS ('t' or 'm'). */
  tieT: boolean[];
  /** Measure has a note whose @tie marks it a tie INITIAL ('i' or 'm'). */
  tieI: boolean[];
}

/* The window-expansion vocabulary is DERIVED from the model's canonical
   control-event list, never restated (2026-09-03, Phase 3 precondition 1).
   Two hand-maintained lists that had to agree did not: `tempo` — which a
   GRADUAL tempo mark (accel./rit.) anchors with @tstamp2, exactly like a
   hairpin (`addTempo`, expressions.ts) — was a control event the model knew
   about and the window did not. Measured (`cb-spangaps.js`, probe A), that
   one was LATENT rather than live: Verovio draws no extension line for a
   gradual tempo, so its host measure renders identically whether or not the
   @tstamp2 target is in range, and a short window lost nothing. It is covered
   here because the coverage argument should hold by CONSTRUCTION and not by
   that piece of luck — the day Verovio draws the extension, or Composer asks
   for it, the window is already right. The sibling gap found the same way was
   live: see the @tie="m" note below.

   Deriving the set makes that class of drift unrepresentable: every control
   event is considered, and the ones that are point events (fermata, artic,
   breath, reh, caesura, and the ornaments) resolve to a single measure and can
   never grow a window, so including them costs one union-selector term and
   nothing at run time. `pedal` is a point event too — Composer emits the pair
   as two independent `dir="down"`/`"up"` events with no @tstamp2 — and probe
   `cb-pedalspan.js` confirms Verovio draws them as independent glyphs, not a
   connecting line, so the pair carries no cross-measure dependency to cover
   (contingent on nobody enabling Verovio's `pedalStyle` line/bracket).

   `note`/`chord`/`rest` are scanned alongside as the ID SOURCE that
   @startid/@endid resolve against, and for the @tie edges. */
const SPANNER_NAMES: ReadonlySet<string> = CONTROL_EVENT_NAMES;
const SPANNER_SCAN =
  ['note', 'chord', 'rest', ...CONTROL_EVENT_NAMES].join(', ');

/** Last built extents, reusable while the document has not changed and the
 *  same measure array is being described. One edit calls expandForSpanners
 *  ~3 times (refill window + splice run + splice window), each otherwise
 *  re-reading every measure in the document. */
let extentsCache: {
  ver: number; len: number; first: Element; last: Element; value: SpannerExtents;
} | null = null;

function spannerExtents(meiMeasures: Element[], docVer: number | null): SpannerExtents {
  const n = meiMeasures.length;
  if (docVer !== null && n > 0 && extentsCache
      && extentsCache.ver === docVer && extentsCache.len === n
      && extentsCache.first === meiMeasures[0]
      && extentsCache.last === meiMeasures[n - 1]) {
    return extentsCache.value;
  }
  const built = buildSpannerExtents(meiMeasures);
  if (docVer !== null && n > 0) {
    extentsCache = {
      ver: docVer, len: n, first: meiMeasures[0], last: meiMeasures[n - 1], value: built,
    };
  }
  return built;
}

function buildSpannerExtents(meiMeasures: Element[]): SpannerExtents {
  const n = meiMeasures.length;
  const noteMeasure = new Map<string, number>();
  const pending: Array<[Element, number]> = [];
  const tieT = new Array<boolean>(n).fill(false);
  const tieI = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    for (const el of Array.from(meiMeasures[i].querySelectorAll(SPANNER_SCAN))) {
      const ln = el.localName;
      if (SPANNER_NAMES.has(ln)) { pending.push([el, i]); continue; }
      /* note / chord / rest — id source, plus @tie edges on notes */
      const id = el.getAttribute('xml:id') || el.getAttribute('id');
      if (id) noteMeasure.set(id, i);
      if (ln === 'note') {
        const t = el.getAttribute('tie');
        if (t) {
          /* @tie="m" is MEDIAL — the note both TERMINATES the tie from its
             predecessor and INITIATES one to its successor (`realizeSlot`,
             model/ties.ts, writes a bare 'm' for every interior note of a
             3+-note chain). Testing only for 't'/'i' left every such measure
             with neither edge set, so a range seeded mid-chain pulled in
             neither neighbour. Measured (`cb-spangaps.js`, probe B): the
             medial measure rendered alone draws NO tie where the full render
             draws one — a dropped spanner the splice would transplant. Fixed
             2026-09-03 (Phase 3 precondition 1). */
          if (t.includes('t') || t.includes('m')) tieT[i] = true;
          if (t.includes('i') || t.includes('m')) tieI[i] = true;
        }
      }
    }
  }
  const refMeasure = (ref: string | null): number | null => {
    if (!ref) return null;
    const id = ref.startsWith('#') ? ref.slice(1) : ref;
    return noteMeasure.has(id) ? noteMeasure.get(id)! : null;
  };
  const spans: Array<[number, number]> = [];
  for (const [sp, mIdx] of pending) {
    const a = refMeasure(sp.getAttribute('startid'));
    const b = refMeasure(sp.getAttribute('endid'));
    const ends = [a, b].filter((x): x is number => x != null);
    /* tstamp-anchored spans (expression-layer hairpins, pedal lines):
       no startid/endid to resolve — the host measure + the tstamp2
       "Nm+beat" measure offset ARE the endpoints. Without this, an edit
       at a wedge's host measure re-rendered a sub-range its tstamp2
       couldn't reach: Verovio only WARNED and dropped the wedge, and the
       splice transplanted the loss (lessons.md 2026-08-30). */
    const t2 = sp.getAttribute('tstamp2');
    const t2m = t2 ? /^([0-9]+)m\+/.exec(t2) : null;
    if (t2m && Number(t2m[1]) > 0) ends.push(mIdx, mIdx + Number(t2m[1]));
    if (!ends.length) continue;
    spans.push([Math.max(0, Math.min(...ends)), Math.min(n - 1, Math.max(...ends))]);
  }
  return { spans, tieT, tieI };
}

/** ONE containment pass: every spanner with an end inside [lo..hi] is covered
 *  whole, and a tie crossing either edge pulls in the neighbouring measure.
 *  Deliberately NOT a fixed point.
 *
 *  `expandForSpanners` iterates until nothing grows, which makes it a
 *  transitive closure over the interval graph of spanners — and on real music
 *  that graph is a chain. Measured on the sonata (`cb-spanchain.js`): 922 of
 *  its 926 spanners are slurs, none longer than 3 measures, and NONE crosses
 *  more than one line boundary — yet ordinary legato phrasing (each slur
 *  ending on the downbeat where the next begins) let one seed walk 17 slurs
 *  deep, 24 measures, 6 lines. A slur at the far end of a line nobody is
 *  re-rendering is irrelevant; only a spanner with an end inside the range can
 *  draw a segment that changes, or be dropped for want of its other endpoint.
 *
 *  Replaced-set max 5 → 2 lines, window max 14 → 6 (per-measure seeds over the
 *  sonata's 446 measures); 52 of those seeds previously blew MAX_WINDOW_LINES
 *  and none do now. The page splicer uses this; the scroll splicer's own run
 *  expansion is a separate geometry and still uses the closure. */
export function expandForSpannersOnce(
  meiMeasures: Element[], lo: number, hi: number, docVer: number | null = null,
): [number, number] {
  const { spans, tieT, tieI } = spannerExtents(meiMeasures, docVer);
  let a = lo, b = hi;
  for (const [minE, maxE] of spans) {
    /* Overlap is tested against the ORIGINAL range — that is what makes this
       one pass. Growing `a`/`b` mid-scan would re-admit the chain. */
    if (maxE >= lo && minE <= hi) {
      if (minE < a) a = minE;
      if (maxE > b) b = maxE;
    }
  }
  if (lo > 0 && tieT[lo]) a = Math.min(a, lo - 1);
  if (hi < meiMeasures.length - 1 && tieI[hi]) b = Math.max(b, hi + 1);
  return [a, b];
}

export function expandForSpanners(
  meiMeasures: Element[], lo: number, hi: number, docVer: number | null = null,
): [number, number] {
    const { spans, tieT, tieI } = spannerExtents(meiMeasures, docVer);
    for (let guard = 0; guard < meiMeasures.length; guard++) {
      let grew = false;
      for (const [minE, maxE] of spans) {
        // overlaps the run → must contain it whole
        if (maxE >= lo && minE <= hi) {
          if (minE < lo) { lo = minE; grew = true; }
          if (maxE > hi) { hi = maxE; grew = true; }
        }
      }
      // cross-measure tie via @tie on notes at the run's edges
      if (lo > 0 && tieT[lo]) { lo--; grew = true; }                       // tie terminus → start is left
      if (hi < meiMeasures.length - 1 && tieI[hi]) { hi++; grew = true; }  // tie initial → end is right
      if (!grew) break;
    }
    return [lo, hi];
  }

/** Expand [lo..hi] so any touched `<ending>` wrapper is contained WHOLE —
 *  including by the window's CONTEXT slots (two left, one right). A partially
 *  re-rendered volta would re-engrave its bracket over a different member set,
 *  and a volta-wrapped context measure would render against a truncated wrapper
 *  and taint anchor/width measurements — so the run swallows the whole ending.
 *  Adjacent 1st/2nd endings chain naturally: swallowing one puts the other into
 *  a context slot next pass. */
export function expandForEndings(meiMeasures: Element[], lo: number, hi: number): [number, number] {
    /* Wrapper → its measure-index span, built in ONE pass (Phase D): the naive
       form rescanned all measures per candidate index per iteration. */
    const wrapperSpan = new Map<Element, [number, number]>();
    const wrapperAt: Array<Element | null> = new Array(meiMeasures.length);
    for (let k = 0; k < meiMeasures.length; k++) {
      const p = meiMeasures[k].parentElement;
      const w = p && p.localName !== 'section' ? p : null;
      wrapperAt[k] = w;
      if (!w) continue;
      const cur = wrapperSpan.get(w);
      if (cur) { if (k < cur[0]) cur[0] = k; if (k > cur[1]) cur[1] = k; }
      else wrapperSpan.set(w, [k, k]);
    }
    for (let guard = 0; guard < meiMeasures.length; guard++) {
      let grew = false;
      for (const i of [lo, hi, lo - 1, lo - 2, hi + 1]) {
        if (i < 0 || i >= meiMeasures.length) continue;
        const w = wrapperAt[i];
        if (!w) continue;
        const span = wrapperSpan.get(w);
        if (!span) continue;
        if (span[0] < lo) { lo = span[0]; grew = true; }
        if (span[1] > hi) { hi = span[1]; grew = true; }
      }
      if (!grew) break;
    }
    return [lo, hi];
}
