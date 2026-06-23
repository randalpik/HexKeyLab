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
import type { ComposerModel } from '../model/index.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const idOf = (m: Element): string => m.getAttribute('xml:id') || m.getAttribute('id') || '';

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
  private headSig = '';                        // everything before the first measure
  private nStaves = 0;
  private gapPx: number[] = [];                // captured inter-staff gaps (screen px)
  private law: Array<{ slope: number; intercept: number }> = [];

  /** Drop persistent state — the next render must be a full one. */
  invalidate(): void { this.ready = false; }
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
    const meiMeasures = Array.from(section.children).filter((c) => c.localName === 'measure');
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
    this.headSig = this.computeHeadSig(meiMeasures[0], ser);

    const measureEls = Array.from(sys.querySelectorAll('g.measure'));
    this.nStaves = measureEls.length ? measureEls[0].querySelectorAll(':scope g.staff').length : 0;
    this.gapPx = measureEls.length ? gapsOfMeasure(measureEls[0], this.nStaves) : [];

    this.calibrate(live, ctx);
    this.ready = this.law.length === this.nStaves - 1 && this.gapPx.every((g) => isFinite(g));
    // The SVG now matches the doc; reset the model's dirty-range so the next
    // edit starts from the conservative 'all' default (Phase B3).
    model.resetRenderDirty();
  }

  /** Serialized head context (the scoreDef(s) before the first measure) — if
   *  this changes between renders the layout header changed and we must full-
   *  render. */
  private computeHeadSig(firstMeasure: Element | undefined, ser: XMLSerializer): string {
    if (!firstMeasure) return '';
    let s = '';
    let n = firstMeasure.previousElementSibling;
    while (n) { s = ser.serializeToString(n) + s; n = n.previousElementSibling; }
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
    if (!this.ready || !this.sysEl) return false;
    const live = model.getDoc();
    const section = live.querySelector('section');
    if (!section) return false;
    const meiMeasures = Array.from(section.children).filter((c) => c.localName === 'measure');
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

    // Layout header changed (clef/key/meter/staff structure) → can't splice.
    if (this.computeHeadSig(meiMeasures[0], ser) !== this.headSig) return false;
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
    if (hiNew < lo && oldHi < oldLo) return true; // nothing changed

    // Expand the NEW run outward until no spanner crosses its endpoints.
    [lo, hiNew] = this.expandForSpanners(live, meiMeasures, newOrder, lo, hiNew);
    // Mirror the expansion onto the OLD run. Measures BEFORE the run align 1:1
    // (common prefix), and measures AFTER it align 1:1 (common suffix, shifted by
    // the measure-count delta), so: oldLo = lo, and oldHi tracks hiNew by the
    // count delta (oN−nN). Forgetting to move oldHi when the run expands inserts
    // more measures than it removes → DUPLICATE measures in the SVG.
    const countDelta = oN - nN;
    oldLo = lo;
    oldHi = hiNew + countDelta;
    const RUN_CAP = 60;
    if (hiNew - lo + 1 > RUN_CAP) return false;   // too big → full render

    // Context overlap. The sub-render's FIRST measure gets a spurious system-
    // initial clef/key/meter (it's system-first), so its x/width don't match the
    // persistent mid-system measure — we must never let the changed run nor the
    // x/y anchor be the sub's first measure. So: ≥1 left context de-taints the
    // run; the ANCHOR is the right-context measure (unchanged, never sub-first)
    // when one exists, else we add a 2nd left context so the left anchor isn't
    // sub-first either. (A run starting at measure 0 is genuinely system-first in
    // BOTH renders, so anchoring there is consistent.)
    const rightAvail = hiNew < nN - 1;
    const leftCtx = rightAvail ? 1 : 2;
    const cLo = Math.max(0, lo - leftCtx);
    const cHi = rightAvail ? hiNew + 1 : hiNew;
    const anchorIdx = rightAvail ? cHi : (lo > 0 ? lo - 1 : 0);
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

    try {
      return this.spliceDom(host, newOrder, newSig, { lo, hiNew, oldLo, oldHi, cHi, anchorIdx });
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
    r: { lo: number; hiNew: number; oldLo: number; oldHi: number; cHi: number; anchorIdx: number },
  ): boolean {
    const bbx = (el: Element) => (el as SVGGraphicsElement).getBBox();
    const sub = (id: string) => host.querySelector('#' + CSS.escape(id)) as SVGGElement | null;
    const persist = (id: string) => this.sysEl!.querySelector('#' + CSS.escape(id)) as SVGGElement | null;

    // Anchor on an UNCHANGED measure present in both renders that is not the
    // sub's system-first measure (see splice()). Its content is identical in
    // both, so the offset between its sub bbox and its persistent bbox is the
    // pure render-to-render shift: dx (x) + dy (y). Gaps already match (synthetic
    // spacer), so this single dy aligns every staff; dx places the run on the
    // persistent x-frame. The persistent measure may carry an x-translate (tx).
    const anchorId = newOrder[r.anchorIdx];
    const subAnchor = sub(anchorId);
    const perAnchor = persist(anchorId);
    if (!subAnchor || !perAnchor) return false;
    const dx = (bbx(perAnchor).x + (this.tx.get(anchorId) ?? 0)) - bbx(subAnchor).x;
    const dy = bbx(perAnchor).y - bbx(subAnchor).y;
    const xf = `translate(${dx},${dy})`;

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
    this.mergeDefs(host, fresh);

    // Locate the insertion point + remove the OLD changed run.
    const oldRunIds = this.order.slice(r.oldLo, r.oldHi + 1);
    const insertBefore = (r.oldHi + 1 < this.order.length)
      ? persist(this.order[r.oldHi + 1]) : null;
    for (const id of oldRunIds) { const el = persist(id); if (el) el.remove(); }
    for (const node of fresh) this.sysEl!.insertBefore(node, insertBefore);

    // Cascade: shift every measure after the run by Δ in x (preserve its y).
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
    }

    // Update the index: spliced measures carry (dx, dy).
    for (let i = r.lo; i <= r.hiNew; i++) { this.tx.set(newOrder[i], dx); this.ty.set(newOrder[i], dy); }
    this.order = newOrder;
    this.sig = newSig;
    // Drop entries for ids no longer present; default new ids to 0.
    const present = new Set(newOrder);
    for (const id of Array.from(this.tx.keys())) if (!present.has(id)) { this.tx.delete(id); this.ty.delete(id); }
    for (const id of newOrder) { if (!this.tx.has(id)) this.tx.set(id, 0); if (!this.ty.has(id)) this.ty.set(id, 0); }
    return true;
  }

  /* ── spanner expansion ───────────────────────────────────────────────────── */

  /** Expand [lo..hi] outward until no tie/slur/hairpin/etc. crosses an endpoint,
   *  so whole spanners are re-rendered together (never hand-edited). */
  private expandForSpanners(doc: Document, meiMeasures: Element[], order: string[], lo: number, hi: number): [number, number] {
    // note id → measure index
    const noteMeasure = new Map<string, number>();
    meiMeasures.forEach((m, i) => {
      for (const n of Array.from(m.querySelectorAll('note, chord, rest'))) {
        const id = n.getAttribute('xml:id') || n.getAttribute('id');
        if (id) noteMeasure.set(id, i);
      }
    });
    const refMeasure = (ref: string | null): number | null => {
      if (!ref) return null;
      const id = ref.startsWith('#') ? ref.slice(1) : ref;
      return noteMeasure.has(id) ? noteMeasure.get(id)! : null;
    };
    const SPANNERS = 'slur, tie, hairpin, phrase, gliss, bracketSpan, octave, lv, dynam, dir, trill';
    for (let guard = 0; guard < meiMeasures.length; guard++) {
      let grew = false;
      for (const m of meiMeasures) {
        for (const sp of Array.from(m.querySelectorAll(SPANNERS))) {
          const a = refMeasure(sp.getAttribute('startid'));
          const b = refMeasure(sp.getAttribute('endid'));
          const ends = [a, b].filter((x): x is number => x != null);
          if (!ends.length) continue;
          const minE = Math.min(...ends), maxE = Math.max(...ends);
          // overlaps the run → must contain it whole
          if (maxE >= lo && minE <= hi) {
            if (minE < lo) { lo = minE; grew = true; }
            if (maxE > hi) { hi = maxE; grew = true; }
          }
        }
      }
      // cross-measure tie via @tie on notes at the run's edges
      const edgeTie = (idx: number, want: string): boolean => {
        const m = meiMeasures[idx];
        return m ? Array.from(m.querySelectorAll('note')).some((n) => (n.getAttribute('tie') || '').includes(want)) : false;
      };
      if (lo > 0 && edgeTie(lo, 't')) { lo--; grew = true; }            // tie terminus → start is left
      if (hi < meiMeasures.length - 1 && edgeTie(hi, 'i')) { hi++; grew = true; } // tie initial → end is right
      if (!grew) break;
    }
    void order;
    return [lo, hi];
  }

  /* ── glyph defs merge ────────────────────────────────────────────────────── */

  /** Ensure the persistent <defs> has every glyph the freshly-spliced measures
   *  reference. Verovio defines glyphs as <g id="<SMuFL-codepoint>-<render-salt>">
   *  children of a single <defs> (NOT <symbol>), and the salt is PER RENDER — so
   *  a sub-render's <use href="#E0A4-<subsalt>"> never matches the persistent
   *  "#E0A4-<mainsalt>". Match by codepoint (id up to the first '-'): remap each
   *  <use> to the persistent glyph when its codepoint already exists (the common
   *  case — the edited measures use glyphs the full render already emitted), else
   *  copy the sub's glyph def over. */
  private mergeDefs(host: HTMLElement, fresh: SVGGElement[]): void {
    if (!this.defsEl) return;
    const cpOf = (id: string) => id.split('-')[0];
    const persistByCp = new Map<string, string>();
    for (const g of Array.from(this.defsEl.children)) {
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
          if (existing !== id) this.setHref(use, '#' + existing);
        } else {
          const g = subById.get(id);
          if (g) {
            this.defsEl.appendChild(this.defsEl.ownerDocument.importNode(g, true));
            persistByCp.set(cp, id);
          }
        }
      }
    }
  }

  private setHref(use: Element, val: string): void {
    if (use.hasAttribute('xlink:href')) use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', val);
    else use.setAttribute('href', val);
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
