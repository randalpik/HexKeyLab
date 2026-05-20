// Cursor overlay. Three modes:
//   - Voice editing (default): single bar (insert) or selection box
//     (overwrite) at the model's current-element position.
//   - Expression editing: a vertical tick between staves 1 and 2 at the
//     current expression-cursor moment. Selected dynam/hairpin SVG elements
//     get a `.expr-selected` CSS class.
//   - Playback: per-voice bars, one for each voice currently sounding.
//
// Cursor index convention (post-refactor): cursor `c` means "past flat[c]".
// The element to the cursor's LEFT is flat[c]. Both insert and overwrite
// mode anchor on flat[c] — insert renders a bar just past it, overwrite
// renders a selection box around it. There is no cursor === 0 special
// case (flat[0] is always the wrapper of M_0 under rule 3 nonexistent
// prev or rule 2 empty).

import { renderer } from './render.js';
import type { ComposerModel, Voice } from './model.js';
import { type Moment, dynamAt, hairpinsAt } from './expressions.js';
import { currentMoment, selectionAt, type ExpressionCursor } from './expressionCursor.js';
import { realTicks } from './ticks.js';

const CURSOR_COLOR = '#7226e4';
const EXPR_CURSOR_COLOR = '#e47226';
const CURSOR_WIDTH = 2;
const PLAYBACK_WIDTH = 3;
export const CURSOR_VPAD = 6;
const CURSOR_HPAD = 4;
const SELECTION_FILL_OPACITY = 0.18;
const SELECTION_STROKE_OPACITY = 0.7;

const DEBUG = typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('debugCursor');

const EXPR_SELECTED_CLASS = 'expr-selected';

export interface CursorUpdateOpts {
  entryMode: 'insert' | 'overwrite';
  cursorMode: 'voice' | 'expr' | 'select';
  exprCursor: ExpressionCursor;
}

class CursorOverlay {
  private svg: SVGSVGElement | null = null;
  private barRect: SVGRectElement | null = null;
  private voiceLabel: SVGTextElement | null = null;
  private exprBar: SVGRectElement | null = null;
  private exprLabel: SVGTextElement | null = null;
  private lastSelectedIds: string[] = [];

  /* Playback-mode state. Per-voice bars layered over the editing cursor;
     editing cursor itself is hidden while playbackMode is true. */
  private playbackMode = false;
  private playbackBars: Map<Voice, SVGRectElement> = new Map();
  private playbackPositions: Map<Voice, string> = new Map();

  attach(svg: SVGSVGElement): void {
    this.svg = svg;
    this.barRect = null;
    this.voiceLabel = null;
    this.exprBar = null;
    this.exprLabel = null;
    this.playbackBars.clear();
  }

  private ensureNodes(): void {
    if (!this.svg) return;
    if (!this.barRect) {
      this.barRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      this.barRect.setAttribute('fill', CURSOR_COLOR);
      this.barRect.setAttribute('data-cursor-role', 'voice');
      this.svg.appendChild(this.barRect);
    }
    if (!this.voiceLabel) {
      this.voiceLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      this.voiceLabel.setAttribute('fill', CURSOR_COLOR);
      this.voiceLabel.setAttribute('font-family', 'system-ui, sans-serif');
      this.voiceLabel.setAttribute('font-size', '11');
      this.voiceLabel.setAttribute('font-weight', '600');
      this.svg.appendChild(this.voiceLabel);
    }
    if (!this.exprBar) {
      this.exprBar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      this.exprBar.setAttribute('fill', EXPR_CURSOR_COLOR);
      this.exprBar.setAttribute('opacity', '0');
      this.svg.appendChild(this.exprBar);
    }
    if (!this.exprLabel) {
      this.exprLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      this.exprLabel.setAttribute('fill', EXPR_CURSOR_COLOR);
      this.exprLabel.setAttribute('font-family', 'system-ui, sans-serif');
      this.exprLabel.setAttribute('font-size', '11');
      this.exprLabel.setAttribute('font-weight', '600');
      this.svg.appendChild(this.exprLabel);
    }
  }

  /** Update editing cursor to reflect the model's current voice and cursor.
   *  During playback the editing cursor is hidden (playback bars take over).
   *
   *  Backward-compatible: `opts` may be the old EntryMode string for callers
   *  not yet updated. */
  update(model: ComposerModel, opts: CursorUpdateOpts | 'insert' | 'overwrite'): void {
    if (!this.svg) return;
    this.ensureNodes();

    const resolved: CursorUpdateOpts = typeof opts === 'string'
      ? { entryMode: opts, cursorMode: 'voice', exprCursor: { index: 0, moments: [] } }
      : opts;

    if (this.playbackMode) {
      this.barRect!.setAttribute('opacity', '0');
      this.voiceLabel!.textContent = '';
      this.exprBar!.setAttribute('opacity', '0');
      this.exprLabel!.textContent = '';
      this.clearExpressionHighlights();
      for (const [voice, meiId] of this.playbackPositions) {
        this.positionPlaybackBar(voice, meiId);
      }
      return;
    }

    if (resolved.cursorMode === 'select') {
      /* Selection mode: hide the editing cursor entirely; selectionOverlay
         renders the visible region. */
      this.barRect!.setAttribute('opacity', '0');
      this.voiceLabel!.textContent = '';
      this.exprBar!.setAttribute('opacity', '0');
      this.exprLabel!.textContent = '';
      this.clearExpressionHighlights();
      return;
    }

    if (resolved.cursorMode === 'expr') {
      this.barRect!.setAttribute('opacity', '0');
      this.voiceLabel!.textContent = '';
      this.renderExpressionCursor(model, resolved.exprCursor);
      this.updateExpressionHighlights(model, resolved.exprCursor);
      return;
    }

    /* Voice mode: hide expression overlay and highlights. */
    this.exprBar!.setAttribute('opacity', '0');
    this.exprLabel!.textContent = '';
    this.clearExpressionHighlights();
    this.renderVoiceCursor(model, resolved.entryMode);
  }

  /* ── voice-cursor rendering (preserved verbatim from prior version) ────── */

  private renderVoiceCursor(model: ComposerModel, mode: 'insert' | 'overwrite'): void {
    const voice = model.getCurrentVoice();
    const cursor = model.getCursor();
    const voiceLen = model.getVoiceLength();

    let x = 80, y = 60 + (voice - 1) * 50, w = CURSOR_WIDTH, h = 60;
    let isSelectionBox = false;
    let diag: Record<string, unknown> = { voice, cursor, voiceLen, mode };

    const anchorOnStaff = (): boolean => {
      const staffId = model.getStaffIdAtCursor(voice);
      if (!staffId) return false;
      const staffRect = renderer.rectForId(staffId);
      if (!staffRect) return false;
      const sigEndX = renderer.findSigEndXForStaff(staffId);
      x = sigEndX !== null ? sigEndX + CURSOR_HPAD : staffRect.left + 10;
      y = staffRect.top - CURSOR_VPAD;
      h = staffRect.height + CURSOR_VPAD * 2;
      return true;
    };

    const isPlaceholderEl = (el: Element): boolean =>
      el.localName === 'space' && el.getAttribute('data-placeholder') === 'true';

    /* Tuplet-relative anchor helpers. Each <tuplet> adds itself to the flat
     * list (one layer-level stop "entered tuplet") AND inlines its in-tuplet
     * stops. Under the new cursor convention (cursor c = past flat[c]):
     *   - Entering a tuplet: flat[c]=tuplet wrapper, flat[c+1]=its first
     *     child. Anchor at LEFT of flat[c+1] (just inside the bracket).
     *   - Exiting a tuplet: flat[c] is a tuplet child, flat[c+1] is not in
     *     the same tuplet (or doesn't exist). Anchor at parent tuplet's
     *     right edge (just past the bracket). */
    const parentTuplet = (el: Element | null): Element | null => {
      const p = el?.parentElement;
      return p && p.localName === 'tuplet' ? p : null;
    };

    /* Set y/height from the voice's staff bbox in the given measure, so
       the wrapper / past-end cursor visually spans only the staff the
       user is editing (not the whole grand staff). Returns false when the
       staff bbox isn't available; the caller should fall through. */
    const setVerticalFromStaff = (measureEl: Element): boolean => {
      const staffN = voice <= 2 ? 1 : 2;
      const staffEl = Array.from(measureEl.querySelectorAll('staff')).find(
        (s) => s.getAttribute('n') === String(staffN),
      );
      const staffId = staffEl?.getAttribute('xml:id');
      const staffRect = staffId ? renderer.rectForId(staffId) : null;
      if (!staffRect) return false;
      y = staffRect.top - CURSOR_VPAD;
      h = staffRect.height + CURSOR_VPAD * 2;
      return true;
    };

    /* Anchor at the inside-left edge of a measure: prefer (in order)
       sigEnd (handles the leading clef/keysig/timesig area, including
       M_1 of the piece and mid-score sig changes), the first real-content
       element's left edge, the first placeholder's left edge (Verovio
       reserves layout width for placeholder spaces even when invisible),
       then the voice's staff bbox + small inset (consistent with
       anchorOnStaff). Falls back to measure bbox if no staff is available.
       Y/height come from the voice's staff bbox (not the whole measure). */
    const anchorAtMeasureLeft = (measureEl: Element): boolean => {
      const staffN = voice <= 2 ? 1 : 2;
      const staffEl = Array.from(measureEl.querySelectorAll('staff')).find(
        (s) => s.getAttribute('n') === String(staffN),
      );
      const staffId = staffEl?.getAttribute('xml:id') ?? null;
      const sigEndX = staffId ? renderer.findSigEndXForStaff(staffId) : null;
      const staffRect = staffId ? renderer.rectForId(staffId) : null;
      const layer = Array.from(measureEl.querySelectorAll('layer')).find(
        (l) => l.getAttribute('n') === String(voice === 1 || voice === 3 ? 1 : 2) &&
               l.parentElement?.getAttribute('n') === String(staffN),
      );
      const firstContent = layer
        ? Array.from(layer.children).find((c) =>
            c.localName === 'chord' || c.localName === 'note' ||
            c.localName === 'rest' || c.localName === 'tuplet')
        : null;
      const firstContentRect = firstContent
        ? renderer.rectForId(firstContent.getAttribute('xml:id') ?? '')
        : null;
      const firstPh = layer
        ? Array.from(layer.children).find((c) =>
            c.localName === 'space' && c.getAttribute('data-placeholder') === 'true')
        : null;
      const firstPhRect = firstPh
        ? renderer.rectForId(firstPh.getAttribute('xml:id') ?? '')
        : null;
      const measureId = measureEl.getAttribute('xml:id');
      const measureRect = measureId ? renderer.rectForId(measureId) : null;

      if (sigEndX !== null) {
        x = sigEndX + CURSOR_HPAD;
      } else if (firstContentRect) {
        x = firstContentRect.left - CURSOR_HPAD;
      } else if (firstPhRect && firstPhRect.width > 0) {
        x = firstPhRect.left + CURSOR_HPAD;
      } else if (staffRect) {
        x = staffRect.left + 10;
      } else if (measureRect) {
        x = measureRect.left + 30;
      } else {
        return false;
      }
      if (!setVerticalFromStaff(measureEl)) {
        if (measureRect) {
          y = measureRect.top - CURSOR_VPAD;
          h = measureRect.height + CURSOR_VPAD * 2;
        } else {
          return false;
        }
      }
      return true;
    };

    /* Anchor past the final bar of the last existing measure (synthetic
       past-end stop). Y/height from the voice's staff bbox. Past-end only
       exists when the last measure has room (partial/empty layer); when
       the last layer is full, `getVoiceLength` excludes the past-end
       position entirely, so this function is only ever called for the
       partial/empty case where "past the right bar" is the correct anchor. */
    const anchorPastLastBar = (): boolean => {
      const measures = model.getDoc().querySelectorAll('measure');
      const lastMeasure = measures[measures.length - 1];
      if (!lastMeasure) return false;
      const measureId = lastMeasure.getAttribute('xml:id');
      const measureRect = measureId ? renderer.rectForId(measureId) : null;
      if (!measureRect) return false;
      x = measureRect.right + CURSOR_HPAD * 2;
      if (!setVerticalFromStaff(lastMeasure)) {
        y = measureRect.top - CURSOR_VPAD;
        h = measureRect.height + CURSOR_VPAD * 2;
      }
      return true;
    };

    const anchorPastLayerContent = (layer: Element | null): boolean => {
      if (!layer) return false;
      const reals = Array.from(layer.children).filter((c) =>
        c.localName === 'chord' || c.localName === 'note' || c.localName === 'rest' || c.localName === 'tuplet'
      );
      const last = reals[reals.length - 1];
      if (!last) return false;
      const id = last.getAttribute('xml:id');
      const rect = id ? renderer.rectForId(id) : null;
      if (!rect) return false;
      x = rect.right + CURSOR_HPAD;
      y = rect.top - CURSOR_VPAD;
      h = rect.height + CURSOR_VPAD * 2;
      return true;
    };

    /* Past-end synthetic stop (wrapper of the not-yet-existent next
       measure) — applies to both insert and overwrite mode. Past-end
       exists ONLY when the last measure's voice-layer is partial/empty;
       when it's full, `getVoiceLength()` excludes the past-end position
       so the cursor never lands here in that case. */
    if (model.isCursorAtPastEnd(voice)) {
      if (anchorPastLastBar()) diag.case = 'past-end-synth';
      else if (anchorOnStaff()) diag.case = 'past-end-synth-staff';
      else diag.case = 'past-end-synth-fallback';
    } else if (mode === 'insert') {
      {
        /* Under the new cursor convention, cursor `c` means "past flat[c]".
           `getCurrentElement(voice, 'insert')` returns flat[c]. The wrapper
           of M_0 is emitted (rule 3 nonexistent prev), so c=0 has flat[0] =
           wrapper of M_0 and the wrapper-anchor branch fires naturally — no
           cursor === 0 special case needed. */
        const ref = model.getCurrentElement(voice, 'insert');
        const nextRef = ref ? model.getNextElement(voice, ref.index) : null;
        if (ref && ref.elem.localName === 'measure') {
          /* Cursor sits just past a measure wrapper. Under the new cursor
             convention (cursor c = past flat[c]), ref IS the wrapper of
             the cursor's measure — anchor directly at its left edge. */
          if (anchorAtMeasureLeft(ref.elem)) diag.case = 'insert-at-wrapper';
          else if (anchorOnStaff()) diag.case = 'insert-at-wrapper-staff';
          else diag.case = 'insert-at-wrapper-fallback';
        } else if (!ref || isPlaceholderEl(ref.elem)) {
          /* Just past a fill-anchor (placeholder): anchor right of the
             last real content of this measure's layer, not the placeholder
             itself (degenerate bbox). */
          const layer = ref?.elem.parentElement ?? null;
          if (layer && anchorPastLayerContent(layer)) diag.case = 'insert-after-fill-anchor';
          else if (anchorOnStaff()) diag.case = ref ? 'insert-placeholder-on-staff' : 'insert-no-ref-staff';
          else diag.case = 'insert-staff-fallback';
        } else if (ref.elem.localName === 'tuplet' && nextRef && nextRef.elem.parentElement === ref.elem) {
          /* Entering a tuplet: anchor at LEFT of the first in-tuplet stop. */
          const nextRect = renderer.rectForId(nextRef.id);
          if (nextRect) {
            x = nextRect.left - CURSOR_HPAD;
            y = nextRect.top - CURSOR_VPAD;
            h = nextRect.height + CURSOR_VPAD * 2;
            diag.case = 'insert-enter-tuplet';
          } else {
            diag.case = 'insert-enter-tuplet-no-rect';
          }
        } else if (parentTuplet(ref.elem) && parentTuplet(nextRef?.elem ?? null) !== parentTuplet(ref.elem)) {
          /* Exiting a tuplet: anchor at the parent tuplet's right edge. */
          const tParent = parentTuplet(ref.elem)!;
          const tId = tParent.getAttribute('xml:id');
          const tRect = tId ? renderer.rectForId(tId) : null;
          if (tRect) {
            x = tRect.right + CURSOR_HPAD;
            y = tRect.top - CURSOR_VPAD;
            h = tRect.height + CURSOR_VPAD * 2;
            diag.case = 'insert-exit-tuplet';
          } else {
            diag.case = 'insert-exit-tuplet-no-rect';
          }
        } else {
          const rect = renderer.rectForId(ref.id);
          diag = { ...diag, refId: ref.id, rect: rect ? { l: rect.left, t: rect.top, w: rect.width, h: rect.height } : null };
          if (rect) {
            x = rect.right + CURSOR_HPAD;
            y = rect.top - CURSOR_VPAD;
            h = rect.height + CURSOR_VPAD * 2;
            diag.case = 'insert-right-of-prev';
          } else {
            diag.case = 'insert-rect-missing';
          }
        }
      }
    } else {
      if (voiceLen === 0) {
        if (anchorOnStaff()) diag.case = 'overwrite-empty-on-staff';
        else diag.case = 'overwrite-empty-fallback';
      } else {
        const ref = model.getCurrentElement(voice, 'overwrite');
        if (ref && ref.elem.localName === 'measure') {
          /* Wrapper stop in overwrite mode: anchor at LEFT of M_k. The
             wrapper isn't an overwrite target (there's no content yet); fall
             through to a bar-style cursor at the measure's start. */
          if (anchorAtMeasureLeft(ref.elem)) diag.case = 'overwrite-on-measure-wrapper';
          else if (anchorOnStaff()) diag.case = 'overwrite-on-measure-wrapper-staff';
          else diag.case = 'overwrite-on-measure-wrapper-fallback';
        } else if (ref && isPlaceholderEl(ref.elem)) {
          /* Fill-anchor in overwrite mode: anchor at the end of the layer's
             real content (the placeholder area). */
          if (anchorPastLayerContent(ref.elem.parentElement)) {
            diag.case = 'overwrite-on-fill-anchor';
          } else if (anchorOnStaff()) {
            diag.case = 'overwrite-placeholder-on-staff';
          } else {
            diag.case = 'overwrite-placeholder-fallback';
          }
        } else {
          const rect = ref ? renderer.rectForId(ref.id) : null;
          diag = { ...diag, refId: ref?.id, rect: rect ? { l: rect.left, t: rect.top, w: rect.width, h: rect.height } : null };
          if (rect) {
            x = rect.left - CURSOR_HPAD;
            y = rect.top - CURSOR_VPAD;
            w = rect.width + CURSOR_HPAD * 2;
            h = rect.height + CURSOR_VPAD * 2;
            isSelectionBox = true;
            diag.case = 'overwrite-selection-box';
          } else {
            diag.case = ref ? 'overwrite-rect-missing' : 'overwrite-no-ref';
          }
        }
      }
    }

    const bar = this.barRect!;
    bar.setAttribute('x', String(x));
    bar.setAttribute('y', String(y));
    bar.setAttribute('width', String(w));
    bar.setAttribute('height', String(h));
    if (isSelectionBox) {
      bar.setAttribute('fill', CURSOR_COLOR);
      bar.setAttribute('fill-opacity', String(SELECTION_FILL_OPACITY));
      bar.setAttribute('stroke', CURSOR_COLOR);
      bar.setAttribute('stroke-opacity', String(SELECTION_STROKE_OPACITY));
      bar.setAttribute('stroke-width', '1.5');
      bar.setAttribute('opacity', '1');
    } else {
      bar.setAttribute('fill', CURSOR_COLOR);
      bar.setAttribute('fill-opacity', '1');
      bar.removeAttribute('stroke');
      bar.removeAttribute('stroke-opacity');
      bar.removeAttribute('stroke-width');
      bar.setAttribute('opacity', '0.85');
    }

    const label = this.voiceLabel!;
    label.textContent = 'V' + voice;
    const labelX = isSelectionBox ? x + w + 4 : x + 4;
    label.setAttribute('x', String(labelX));
    label.setAttribute('y', String(y - 2));

    if (DEBUG) {
      diag = { ...diag, x, y, w, h, isSelectionBox,
        svgSize: { w: this.svg!.getAttribute('width'), h: this.svg!.getAttribute('height') } };
      console.log('[cursor]', diag);
    }
  }

  /* ── expression-cursor rendering ───────────────────────────────────────── */

  private renderExpressionCursor(model: ComposerModel, exprCursor: ExpressionCursor): void {
    const m = currentMoment(exprCursor);
    const bar = this.exprBar!;
    const label = this.exprLabel!;
    if (!m) {
      bar.setAttribute('opacity', '0');
      label.textContent = 'EXPR (empty)';
      label.setAttribute('x', '80');
      label.setAttribute('y', String(20));
      return;
    }
    /* Find a coincident note (any voice) for x; prefer staff-1 voices (1, 2)
       so the cursor sits between the staves. Fall back to the moment's
       expression element if no note is co-located. */
    const noteRect = this.findNoteRectAtMoment(model, m);
    let staff1BottomGuess = noteRect?.bottom;
    let cursorX = noteRect ? noteRect.left + noteRect.width / 2 : null;

    if (cursorX === null) {
      const exprId = this.findExprIdAtMoment(model, m);
      if (exprId) {
        const r = renderer.rectForId(exprId);
        if (r) {
          cursorX = r.left + r.width / 2;
          if (staff1BottomGuess === undefined) staff1BottomGuess = r.top;
        }
      }
    }

    /* Determine vertical band between staves 1 and 2 for this moment.
       Strategy: use the staff IDs at the cursor's measure to bound the band. */
    const yBand = this.computeBetweenStavesY(model, m);

    if (cursorX === null || !yBand) {
      bar.setAttribute('opacity', '0');
      label.textContent = 'EXPR m' + (m.measureIdx + 1) + ' β' + m.tstamp.toFixed(2).replace(/\.?0+$/, '');
      label.setAttribute('x', '80');
      label.setAttribute('y', '20');
      return;
    }

    const x = cursorX - CURSOR_WIDTH / 2;
    bar.setAttribute('x', String(x));
    bar.setAttribute('y', String(yBand.top));
    bar.setAttribute('width', String(CURSOR_WIDTH + 1));
    bar.setAttribute('height', String(yBand.bottom - yBand.top));
    bar.setAttribute('opacity', '0.85');

    label.textContent = 'EXPR';
    label.setAttribute('x', String(x + 4));
    label.setAttribute('y', String(yBand.top - 2));
  }

  /** Find a note/chord at exactly the given moment. Prefer voice 1/2 (staff 1)
   *  so the cursor naturally lands between the staves. */
  private findNoteRectAtMoment(model: ComposerModel, m: Moment): { left: number; bottom: number; width: number; right: number } | null {
    const measures = Array.from(model.getDoc().querySelectorAll('measure'));
    const measure = measures[m.measureIdx];
    if (!measure) return null;
    const { unit } = model.getTimeSig();
    const ticksPerBeat = 64 / unit;
    const targetTicks = (m.tstamp - 1) * ticksPerBeat;

    const voiceOrder: ReadonlyArray<Voice> = [1, 2, 3, 4];
    for (const v of voiceOrder) {
      const staffN = v <= 2 ? 1 : 2;
      const layerN = (v === 1 || v === 3) ? 1 : 2;
      const layer = Array.from(measure.querySelectorAll(`staff[n="${staffN}"] layer[n="${layerN}"]`))[0];
      if (!layer) continue;
      let cum = 0;
      for (const child of Array.from(layer.children)) {
        const ln = child.localName;
        if (ln !== 'note' && ln !== 'chord' && ln !== 'rest' && ln !== 'space') continue;
        if (Math.abs(cum - targetTicks) < 1e-6 && (ln === 'note' || ln === 'chord')) {
          const id = child.getAttribute('xml:id');
          if (id) {
            const r = renderer.rectForId(id);
            if (r) return { left: r.left, bottom: r.bottom, width: r.width, right: r.right };
          }
        }
        cum += elementDurationTicks(child);
      }
    }
    return null;
  }

  /** Returns the xml:id of the dynam-at-moment or first hairpin-at-moment, if
   *  any. Used as a fallback x-anchor for orphan moments. */
  private findExprIdAtMoment(model: ComposerModel, m: Moment): string | null {
    const doc = model.getDoc();
    const d = dynamAt(doc, m);
    if (d) return d.getAttribute('xml:id');
    const hairpins = hairpinsAt(doc, m);
    if (hairpins.length > 0) return hairpins[0].getAttribute('xml:id');
    return null;
  }

  /** Compute the vertical band between staff 1 and staff 2 at the moment's
   *  measure. Falls back to a small region below the cursor x if the staff
   *  ids can't be resolved. */
  private computeBetweenStavesY(model: ComposerModel, m: Moment): { top: number; bottom: number } | null {
    const measures = Array.from(model.getDoc().querySelectorAll('measure'));
    const measure = measures[m.measureIdx];
    if (!measure) return null;
    const staffs = Array.from(measure.querySelectorAll('staff'));
    const s1 = staffs.find((s) => s.getAttribute('n') === '1');
    const s2 = staffs.find((s) => s.getAttribute('n') === '2');
    const s1Id = s1?.getAttribute('xml:id');
    const s2Id = s2?.getAttribute('xml:id');
    if (!s1Id || !s2Id) return null;
    const r1 = renderer.rectForId(s1Id);
    const r2 = renderer.rectForId(s2Id);
    if (!r1 || !r2) return null;
    /* Use the smaller-on-screen staff as top, the larger as bottom. */
    const top = Math.min(r1.bottom, r2.bottom);
    const bottom = Math.max(r1.top, r2.top);
    if (bottom <= top) {
      /* The staves overlap (rare; shouldn't happen for a grand staff). Fall
         back to a thin band right below staff 1. */
      return { top: r1.bottom, bottom: r1.bottom + 24 };
    }
    return { top: top - CURSOR_VPAD, bottom: bottom + CURSOR_VPAD };
  }

  /** Tag the selected dynam / hairpin SVG elements with `.expr-selected`. */
  private updateExpressionHighlights(model: ComposerModel, exprCursor: ExpressionCursor): void {
    this.clearExpressionHighlights();
    const m = currentMoment(exprCursor);
    if (!m) return;
    const sel = selectionAt(model.getDoc(), m);
    const ids: string[] = [];
    if (sel.dynam) {
      const id = sel.dynam.getAttribute('xml:id');
      if (id) ids.push(id);
    }
    for (const h of sel.hairpins) {
      const id = h.getAttribute('xml:id');
      if (id) ids.push(id);
    }
    const container = this.scoreContainer();
    if (!container) return;
    for (const id of ids) {
      const node = container.querySelector('#' + CSS.escape(id));
      if (node) node.classList.add(EXPR_SELECTED_CLASS);
    }
    this.lastSelectedIds = ids;
  }

  private clearExpressionHighlights(): void {
    const container = this.scoreContainer();
    if (!container) {
      this.lastSelectedIds = [];
      return;
    }
    /* Remove from the snapshot we recorded last time. */
    for (const id of this.lastSelectedIds) {
      const node = container.querySelector('#' + CSS.escape(id));
      if (node) node.classList.remove(EXPR_SELECTED_CLASS);
    }
    /* Defensive: also clear any leftover .expr-selected nodes (e.g., after
       re-render the snapshot ids may have lost their classes already but
       new render could carry stale ones if id stayed the same). */
    for (const node of Array.from(container.querySelectorAll('.' + EXPR_SELECTED_CLASS))) {
      node.classList.remove(EXPR_SELECTED_CLASS);
    }
    this.lastSelectedIds = [];
  }

  private scoreContainer(): HTMLElement | null {
    /* The cursor overlay's parent is #score; Verovio's SVG is a sibling. */
    if (!this.svg) return null;
    return this.svg.parentElement as HTMLElement | null;
  }

  /* ── playback mode ─────────────────────────────────────────────────────── */

  setPlaybackMode(on: boolean): void {
    this.playbackMode = on;
    if (!on) {
      this.playbackPositions.clear();
      for (const bar of this.playbackBars.values()) {
        bar.setAttribute('opacity', '0');
      }
    }
  }

  setPlaybackPosition(voice: Voice, meiId: string | null): void {
    if (!this.svg) return;
    if (meiId === null) {
      this.playbackPositions.delete(voice);
      const bar = this.playbackBars.get(voice);
      if (bar) bar.setAttribute('opacity', '0');
      return;
    }
    this.playbackPositions.set(voice, meiId);
    this.positionPlaybackBar(voice, meiId);
  }

  private positionPlaybackBar(voice: Voice, meiId: string): void {
    if (!this.svg) return;
    let bar = this.playbackBars.get(voice);
    if (!bar) {
      bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bar.setAttribute('fill', CURSOR_COLOR);
      bar.setAttribute('opacity', '0.85');
      bar.setAttribute('width', String(PLAYBACK_WIDTH));
      this.svg.appendChild(bar);
      this.playbackBars.set(voice, bar);
    }
    const rect = renderer.rectForId(meiId);
    if (!rect) {
      bar.setAttribute('opacity', '0');
      return;
    }
    bar.setAttribute('x', String(rect.left - 4));
    bar.setAttribute('y', String(rect.top - CURSOR_VPAD));
    bar.setAttribute('height', String(rect.height + CURSOR_VPAD * 2));
    bar.setAttribute('opacity', '0.85');
  }

  hide(): void {
    if (this.barRect) this.barRect.setAttribute('opacity', '0');
    if (this.voiceLabel) this.voiceLabel.textContent = '';
    if (this.exprBar) this.exprBar.setAttribute('opacity', '0');
    if (this.exprLabel) this.exprLabel.textContent = '';
    for (const bar of this.playbackBars.values()) bar.setAttribute('opacity', '0');
    this.clearExpressionHighlights();
  }
}

function elementDurationTicks(el: Element): number {
  return realTicks(el);
}

export const cursor = new CursorOverlay();
