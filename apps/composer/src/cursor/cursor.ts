// Cursor overlay. Three modes:
//   - Voice editing (default): single bar (insert) or selection box
//     (overwrite) at the model's current-element position.
//   - Layer editing (expression / pedal / tempo): one bar per layer at the
//     layer cursor's stop — flush right of the selected mark at its rendered
//     height, or a fixed-height bar at a placeholder's onset (see
//     layerBarRect). The selected mark gets `.expr-selected` /
//     `.pedal-selected` / `.tempo-selected`.
//   - Playback: per-voice bars, one for each voice currently sounding.
//
// Cursor index convention (post-refactor): cursor `c` means "past flat[c]".
// The element to the cursor's LEFT is flat[c]. Both insert and overwrite
// mode anchor on flat[c] — insert renders a bar just past it, overwrite
// renders a selection box around it. There is no cursor === 0 special
// case (flat[0] is always the wrapper of M_0 under rule 3 nonexistent
// prev or rule 2 empty).

import { renderer } from '../render/render.js';
import type { ComposerModel, Voice } from '../model/index.js';
import {
  computeVoiceCursorRect, computePlaybackBarRect,
  type VoiceCursorAnchor, type CursorRectQuery, type PlaybackBarEdge,
} from '@hkl/shared/cursor-geom.js';
import { tempoCopySource } from '../notation/parts.js';
import {
  currentStop, EMPTY_LAYER_CURSOR,
  type ExpressionCursor, type LayerMode, type LayerStop, type MarkRef,
} from './expressionCursor.js';

/* Edit/playback cursor color. Driven by the shared --cursor-color theme var
   (set on the themed score container in dark mode by notation-theme.ts) with
   the light-mode purple as fallback. Applied via inline `style` (not a
   presentation attribute) since SVG presentation attributes don't resolve
   var(); the overlay is a child of #score so it inherits the var. */
const CURSOR_COLOR = 'var(--cursor-color, #7226e4)';
const EXPR_CURSOR_COLOR = '#e47226';
const PEDAL_CURSOR_COLOR = '#0a9396';
const TEMPO_CURSOR_COLOR = '#3a86ff';
const CURSOR_WIDTH = 2;
const PLAYBACK_WIDTH = 3;
export const CURSOR_VPAD = 6;
const CURSOR_HPAD = 4;
const SELECTION_FILL_OPACITY = 0.18;
const SELECTION_STROKE_OPACITY = 0.7;

const DEBUG = typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('debugCursor');

const EXPR_SELECTED_CLASS = 'expr-selected';
const PEDAL_SELECTED_CLASS = 'pedal-selected';
const TEMPO_SELECTED_CLASS = 'tempo-selected';
const LAYER_SELECTED_CLASS: Record<LayerMode, string> = {
  expr: EXPR_SELECTED_CLASS, pedal: PEDAL_SELECTED_CLASS, tempo: TEMPO_SELECTED_CLASS,
};
const LAYER_LABEL: Record<LayerMode, string> = { expr: 'EXPR', pedal: 'PED', tempo: 'TEMPO' };
const LAYERS: readonly LayerMode[] = ['expr', 'pedal', 'tempo'];
/** Layer bar width, and its gap from the mark it selects. */
const LAYER_BAR_W = CURSOR_WIDTH + 1;
const MARK_GAP = 1;
/** Height of a placeholder stop's bar (an onset that carries no mark). */
const PLACEHOLDER_H = 28;

export interface CursorUpdateOpts {
  entryMode: 'insert' | 'overwrite';
  cursorMode: 'voice' | 'expr' | 'pedal' | 'tempo' | 'select';
  exprCursor: ExpressionCursor;
  /** Instrument index the expr/pedal layers are scoped to (per-instrument
   *  expression/pedal). Default 0 (single-instrument doc). */
  exprInstrIdx?: number;
  pedalCursor: ExpressionCursor;
  pedalInstrIdx?: number;
  tempoCursor: ExpressionCursor;
  /** Per-note selection of a single `<note>` — either a chord-child note or
   *  a bare note. When set, the cursor renders a horizontal line from the
   *  cursor bar to the selected note's notehead. Cleared by cursor movement
   *  and by non-preserved keystrokes (see input.ts). */
  chordInternalSel?: { noteId: string } | null;
}

/** Cursor-geometry query backed by the Composer renderer (container-local px).
 *  DOMRect structurally satisfies CursorGeomRect. */
const COMPOSER_QUERY: CursorRectQuery = {
  rectForId: (id) => renderer.rectForId(id),
  sigEndXForStaff: (id) => renderer.findSigEndXForStaff(id),
};

/** True when the rendered element for `meiId` is a user-hidden rest (the `H`
 *  toggle → `visible="false"`, surfaced as `g.rest[data-visible="false"]`).
 *  Verovio still draws such rests (it ignores @visible) and CSS only sets
 *  `visibility:hidden` — so they keep layout coords and the playback bar would
 *  otherwise step onto an invisible element. Used to suppress the bar there. */
function renderedIsHiddenRest(meiId: string): boolean {
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(meiId) : meiId;
  const el = document.querySelector('#' + esc);
  return !!el && el.classList.contains('rest') && el.getAttribute('data-visible') === 'false';
}

const isPlaceholderEl = (el: Element): boolean =>
  el.localName === 'space' && el.getAttribute('data-placeholder') === 'true';
const isReal = (el: Element): boolean =>
  el.localName === 'chord' || el.localName === 'note' || el.localName === 'rest' || el.localName === 'tuplet';
const parentTupletOf = (el: Element | null): Element | null => {
  const p = el?.parentElement;
  return p && p.localName === 'tuplet' ? p : null;
};
const idOf = (el: Element | null): string | null => el?.getAttribute('xml:id') ?? null;

/** Resolve the voice cursor to a render-agnostic anchor, mirroring the case
 *  decisions below (past-end / measure-start / tuplet enter+exit / right-of-
 *  prev / overwrite box). Lives here (needs the model) and is shipped over the
 *  bridge so HKL's frame computes the SAME cursor via computeVoiceCursorRect. */
export function resolveVoiceCursorAnchor(
  model: ComposerModel, voice: Voice, mode: 'insert' | 'overwrite',
): VoiceCursorAnchor {
  const doc = model.getDoc();
  const staffN = model.staffForVoice(voice);
  const layerN = model.layerForVoice(voice);
  const staffIdIn = (measure: Element | null): string | null =>
    measure ? idOf(Array.from(measure.querySelectorAll('staff')).find((s) => s.getAttribute('n') === String(staffN)) ?? null) : null;
  const layerIn = (measure: Element | null): Element | null =>
    measure ? (Array.from(measure.querySelectorAll('layer')).find(
      (l) => l.getAttribute('n') === String(layerN) && l.parentElement?.getAttribute('n') === String(staffN)) ?? null) : null;
  const staffStart = (): VoiceCursorAnchor => ({
    xMode: 'measureLeft', vMode: 'staff', elementId: null, staffId: model.getStaffIdAtCursor(voice),
    firstContentId: null, firstPlaceholderId: null, measureId: null,
  });
  /* A multimeasure-rest run renders as its FIRST measure only (model/
     multirest.ts): an interior member has no g.measure, so anchor on the
     representative; and the representative's placeholders are gone from the
     render clone, so its first-content/placeholder ids must not be offered. */
  const units = model.unitsForView();
  const representative = (measure: Element): Element => {
    if (!units.active) return measure;
    const mi = model.getMeasureIdxForId(idOf(measure) ?? '');
    if (mi < 0 || !units.isInterior(mi)) return measure;
    return model.allMeasures()[units.repIdxOf(mi)] ?? measure;
  };
  const measureLeftOf = (measureIn: Element): VoiceCursorAnchor => {
    const measure = representative(measureIn);
    const collapsed = units.active && units.isRunStart(model.getMeasureIdxForId(idOf(measure) ?? ''));
    const layer = layerIn(measure);
    const kids = layer ? Array.from(layer.children) : [];
    return {
      xMode: 'measureLeft', vMode: 'staff', elementId: null, staffId: staffIdIn(measure),
      firstContentId: collapsed ? null : idOf(kids.find(isReal) ?? null),
      firstPlaceholderId: collapsed ? null : idOf(kids.find(isPlaceholderEl) ?? null),
      measureId: idOf(measure),
    };
  };
  const pastLayerContent = (layer: Element | null): VoiceCursorAnchor | null => {
    const reals = layer ? Array.from(layer.children).filter(isReal) : [];
    const last = reals[reals.length - 1] ?? null;
    return last ? { xMode: 'elementRight', vMode: 'element', elementId: idOf(last), staffId: null, firstContentId: null, firstPlaceholderId: null, measureId: null } : null;
  };
  const ofElement = (id: string | null, xMode: 'elementRight' | 'elementLeft' | 'box'): VoiceCursorAnchor =>
    ({ xMode, vMode: 'element', elementId: id, staffId: null, firstContentId: null, firstPlaceholderId: null, measureId: null });

  if (model.isCursorAtPastEnd(voice)) {
    const measures = doc.querySelectorAll('measure');
    const lastMeasure = measures[measures.length - 1] ? representative(measures[measures.length - 1]) : null;
    if (lastMeasure) {
      return { xMode: 'pastEndRight', vMode: 'staff', elementId: null, staffId: staffIdIn(lastMeasure), firstContentId: null, firstPlaceholderId: null, measureId: idOf(lastMeasure) };
    }
    return staffStart();
  }

  if (mode === 'insert') {
    const ref = model.getCurrentElement(voice, 'insert');
    const nextRef = ref ? model.getNextElement(voice, ref.index) : null;
    if (ref && ref.elem.localName === 'measure') return measureLeftOf(ref.elem);
    if (!ref || isPlaceholderEl(ref.elem)) return pastLayerContent(ref?.elem.parentElement ?? null) ?? staffStart();
    if (ref.elem.localName === 'tuplet' && nextRef && nextRef.elem.parentElement === ref.elem) return ofElement(nextRef.id, 'elementLeft');
    if (parentTupletOf(ref.elem) && parentTupletOf(nextRef?.elem ?? null) !== parentTupletOf(ref.elem)) return ofElement(idOf(parentTupletOf(ref.elem)), 'elementRight');
    return ofElement(ref.id, 'elementRight');
  }

  /* overwrite */
  if (model.getVoiceLength(voice) === 0) return staffStart();
  const ref = model.getCurrentElement(voice, 'overwrite');
  if (ref && ref.elem.localName === 'measure') return measureLeftOf(ref.elem);
  if (ref && isPlaceholderEl(ref.elem)) return pastLayerContent(ref.elem.parentElement) ?? staffStart();
  if (ref) return ofElement(ref.id, 'box');
  return staffStart();
}

/* ── layer-cursor geometry (expression / pedal / tempo) ──────────────────── */

const cssId = (id: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id);

/** Every rendered piece of a mark: its `<g id>` plus, for a spanner broken
 *  across systems, Verovio's id-less continuation pieces — `class="hairpin
 *  id-<xml:id> spanning"`, children of the later system's `<g>`. */
function markPieces(mark: MarkRef): Element[] {
  const esc = cssId(mark.id);
  return renderer.queryRendered('#' + esc + ', g.id-' + esc);
}

/** Rendered box of a mark (container px), or null when it isn't drawn. A
 *  hairpin's END is its last piece; everything else is the `<g id>` itself
 *  (a tempo's original, not its per-part copies). */
export function layerMarkRect(mark: MarkRef): DOMRect | null {
  const el = mark.kind === 'hairpin' && mark.edge === 'end'
    ? markPieces(mark).pop()
    : renderer.queryRendered('#' + cssId(mark.id))[0];
  const r = el ? renderer.rectForElement(el) : null;
  return r && (r.width > 0 || r.height > 0) ? r : null;
}

/** Top/bottom of staff `staffN`'s five lines in measure `measureIdx`
 *  (container px) — the staff's frame, unlike its bbox, which grows with
 *  ledger-line notes. Null when that staff isn't drawn there. */
function staffLines(model: ComposerModel, measureIdx: number, staffN: number): { top: number; bottom: number } | null {
  const staff = model.allMeasures()[measureIdx]?.querySelector(`staff[n="${staffN}"]`);
  const id = staff?.getAttribute('xml:id');
  const g = id ? renderer.queryRendered('#' + cssId(id))[0] : undefined;
  if (!g) return null;
  let top = Infinity, bottom = -Infinity;
  for (const line of Array.from(g.querySelectorAll(':scope > path'))) {
    const r = renderer.rectForElement(line);
    if (!r) continue;
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }
  return isFinite(top) ? { top, bottom } : null;
}

/** x of a stop's onset notehead centre (container px). */
function onsetX(stop: LayerStop): number | null {
  const g = stop.onsetId ? renderer.queryRendered('#' + cssId(stop.onsetId))[0] : undefined;
  const r = g ? renderer.rectForElement(g.querySelector('.notehead') ?? g) : null;
  return r ? r.left + r.width / 2 : null;
}

/** Placeholder bar top with no previous mark to align to: centred between a
 *  grand staff's staves or below a single staff (expr), below the bottom staff
 *  (pedal), above the score's top drawn staff (tempo). */
function defaultPlaceholderTop(model: ComposerModel, mode: LayerMode, measureIdx: number, instrIdx: number): number | null {
  if (mode === 'tempo') {
    for (const inst of model.instruments()) {
      for (const n of inst.staffNs) {
        const l = staffLines(model, measureIdx, n);
        if (l) return l.top - CURSOR_VPAD - PLACEHOLDER_H;
      }
    }
    return null;
  }
  const staffNs = model.instruments()[instrIdx]?.staffNs ?? [1, 2];
  if (mode === 'expr' && staffNs.length >= 2) {
    const a = staffLines(model, measureIdx, staffNs[0]);
    const b = staffLines(model, measureIdx, staffNs[1]);
    return a && b ? (a.bottom + b.top) / 2 - PLACEHOLDER_H / 2 : null;
  }
  const l = staffLines(model, measureIdx, staffNs[staffNs.length - 1]);
  return l ? l.bottom + CURSOR_VPAD : null;
}

/** Placeholder bar top: centred on the previous mark in the layer — its offset
 *  from its staff's lines reapplied to that staff where the placeholder is, so
 *  the alignment survives a system or page break — else the default band. */
function placeholderTop(model: ComposerModel, mode: LayerMode, c: ExpressionCursor, instrIdx: number): number | null {
  const stop = c.stops[c.index];
  for (let i = c.index - 1; i >= 0; i--) {
    const prev = c.stops[i];
    if (!prev.mark) continue;
    const r = layerMarkRect(prev.mark);
    const from = r ? staffLines(model, prev.moment.measureIdx, prev.mark.staff) : null;
    const to = from ? staffLines(model, stop.moment.measureIdx, prev.mark.staff) : null;
    if (r && from && to) return r.top + r.height / 2 - from.top + to.top - PLACEHOLDER_H / 2;
    break;
  }
  return defaultPlaceholderTop(model, mode, stop.moment.measureIdx, instrIdx);
}

/** The layer bar (container px) at the cursor's stop. A mark stop: flush right
 *  of the mark at its rendered height — a hairpin START flush left of the
 *  wedge, its END flush right of the last piece. A placeholder (or a mark that
 *  isn't drawn): a PLACEHOLDER_H bar at the onset's notehead, placed by
 *  placeholderTop. Null only when neither can be located. */
function layerBarRect(model: ComposerModel, mode: LayerMode, c: ExpressionCursor, instrIdx: number): { x: number; y: number; w: number; h: number } | null {
  const stop = currentStop(c);
  if (!stop) return null;
  if (stop.mark) {
    const r = layerMarkRect(stop.mark);
    if (r) {
      const x = stop.mark.kind === 'hairpin' && stop.mark.edge === 'start'
        ? r.left - MARK_GAP - LAYER_BAR_W
        : r.right + MARK_GAP;
      return { x, y: r.top, w: LAYER_BAR_W, h: r.height };
    }
  }
  const x = onsetX(stop);
  const top = x === null ? null : placeholderTop(model, mode, c, instrIdx);
  if (x === null || top === null) return null;
  return { x: x - LAYER_BAR_W / 2, y: top, w: LAYER_BAR_W, h: PLACEHOLDER_H };
}

class CursorOverlay {
  private svg: SVGSVGElement | null = null;
  private barRect: SVGRectElement | null = null;
  private voiceLabel: SVGTextElement | null = null;
  private exprBar: SVGRectElement | null = null;
  private exprLabel: SVGTextElement | null = null;
  private pedalBar: SVGRectElement | null = null;
  private pedalLabel: SVGTextElement | null = null;
  private tempoBar: SVGRectElement | null = null;
  private tempoLabel: SVGTextElement | null = null;
  private chordIntLine: SVGLineElement | null = null;
  /** Rendered pieces carrying the active layer's selected-mark class. */
  private layerSelected: Element[] = [];

  /* Playback-mode state. Per-voice bars layered over the editing cursor;
     editing cursor itself is hidden while playbackMode is true. */
  private playbackMode = false;
  private playbackBars: Map<Voice, SVGRectElement> = new Map();
  /** Per-voice bar target: the element it sits on + which of its edges (see
   *  PlaybackBarEdge — 'left' = sounding now, 'right' = just played). */
  private playbackPositions: Map<Voice, { meiId: string; edge: PlaybackBarEdge }> = new Map();

  /** Fired whenever the playback overlay (mode or any per-voice bar) changes.
   *  main.ts wires this to broadcast the overlay to HKL's Composer-view frame,
   *  so the bars stay identical across both views for EVERY cursor source
   *  (clock playback, Performance mode, future) with no per-feature wiring. */
  onPlaybackChange?: () => void;

  attach(svg: SVGSVGElement): void {
    this.svg = svg;
    this.barRect = null;
    this.voiceLabel = null;
    this.exprBar = null;
    this.exprLabel = null;
    this.pedalBar = null;
    this.pedalLabel = null;
    this.tempoBar = null;
    this.tempoLabel = null;
    this.chordIntLine = null;
    this.playbackBars.clear();
  }

  private ensureNodes(): void {
    if (!this.svg) return;
    if (!this.barRect) {
      this.barRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      this.barRect.style.fill = CURSOR_COLOR;
      this.barRect.setAttribute('data-cursor-role', 'voice');
      this.svg.appendChild(this.barRect);
    }
    if (!this.voiceLabel) {
      this.voiceLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      this.voiceLabel.style.fill = CURSOR_COLOR;
      this.voiceLabel.setAttribute('font-family', 'system-ui, sans-serif');
      this.voiceLabel.setAttribute('font-size', '11');
      this.voiceLabel.setAttribute('font-weight', '600');
      this.svg.appendChild(this.voiceLabel);
    }
    if (!this.exprBar) {
      this.exprBar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      this.exprBar.setAttribute('fill', EXPR_CURSOR_COLOR);
      this.exprBar.setAttribute('opacity', '0');
      this.exprBar.setAttribute('data-cursor-role', 'expr');
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
    if (!this.pedalBar) {
      this.pedalBar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      this.pedalBar.setAttribute('fill', PEDAL_CURSOR_COLOR);
      this.pedalBar.setAttribute('opacity', '0');
      this.pedalBar.setAttribute('data-cursor-role', 'pedal');
      this.svg.appendChild(this.pedalBar);
    }
    if (!this.pedalLabel) {
      this.pedalLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      this.pedalLabel.setAttribute('fill', PEDAL_CURSOR_COLOR);
      this.pedalLabel.setAttribute('font-family', 'system-ui, sans-serif');
      this.pedalLabel.setAttribute('font-size', '11');
      this.pedalLabel.setAttribute('font-weight', '600');
      this.svg.appendChild(this.pedalLabel);
    }
    if (!this.tempoBar) {
      this.tempoBar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      this.tempoBar.setAttribute('fill', TEMPO_CURSOR_COLOR);
      this.tempoBar.setAttribute('opacity', '0');
      this.tempoBar.setAttribute('data-cursor-role', 'tempo');
      this.svg.appendChild(this.tempoBar);
    }
    if (!this.tempoLabel) {
      this.tempoLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      this.tempoLabel.setAttribute('fill', TEMPO_CURSOR_COLOR);
      this.tempoLabel.setAttribute('font-family', 'system-ui, sans-serif');
      this.tempoLabel.setAttribute('font-size', '11');
      this.tempoLabel.setAttribute('font-weight', '600');
      this.svg.appendChild(this.tempoLabel);
    }
    if (!this.chordIntLine) {
      this.chordIntLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      this.chordIntLine.style.stroke = CURSOR_COLOR;
      this.chordIntLine.setAttribute('stroke-width', '3');
      this.chordIntLine.setAttribute('stroke-linecap', 'round');
      this.chordIntLine.setAttribute('opacity', '0');
      this.chordIntLine.setAttribute('data-cursor-role', 'chord-internal');
      this.svg.appendChild(this.chordIntLine);
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
      ? { entryMode: opts, cursorMode: 'voice', exprCursor: EMPTY_LAYER_CURSOR, pedalCursor: EMPTY_LAYER_CURSOR, tempoCursor: EMPTY_LAYER_CURSOR }
      : opts;

    if (this.playbackMode) {
      this.barRect!.setAttribute('opacity', '0');
      this.voiceLabel!.textContent = '';
      this.chordIntLine?.setAttribute('opacity', '0');
      this.hideLayers();
      for (const [voice, pos] of this.playbackPositions) {
        this.positionPlaybackBar(voice, pos.meiId, pos.edge);
      }
      return;
    }

    if (resolved.cursorMode === 'select') {
      /* Selection mode: hide the editing cursor entirely; selectionOverlay
         renders the visible region. */
      this.barRect!.setAttribute('opacity', '0');
      this.voiceLabel!.textContent = '';
      this.chordIntLine?.setAttribute('opacity', '0');
      this.hideLayers();
      return;
    }

    if (resolved.cursorMode === 'expr' || resolved.cursorMode === 'pedal' || resolved.cursorMode === 'tempo') {
      const mode = resolved.cursorMode;
      this.barRect!.setAttribute('opacity', '0');
      this.voiceLabel!.textContent = '';
      this.chordIntLine?.setAttribute('opacity', '0');
      for (const other of LAYERS) if (other !== mode) this.hideLayerBar(other);
      const c = mode === 'expr' ? resolved.exprCursor : mode === 'pedal' ? resolved.pedalCursor : resolved.tempoCursor;
      const instrIdx = mode === 'expr' ? resolved.exprInstrIdx ?? 0 : mode === 'pedal' ? resolved.pedalInstrIdx ?? 0 : 0;
      this.renderLayerCursor(model, mode, c, instrIdx);
      this.updateLayerHighlight(mode, c);
      return;
    }

    /* Voice mode: hide the layer bars and highlights. */
    this.hideLayers();
    this.renderVoiceCursor(model, resolved.entryMode);
    this.renderChordInternalLine(resolved.chordInternalSel ?? null);
  }

  private layerNodes(mode: LayerMode): { bar: SVGRectElement; label: SVGTextElement } {
    if (mode === 'expr') return { bar: this.exprBar!, label: this.exprLabel! };
    if (mode === 'pedal') return { bar: this.pedalBar!, label: this.pedalLabel! };
    return { bar: this.tempoBar!, label: this.tempoLabel! };
  }

  private hideLayerBar(mode: LayerMode): void {
    const { bar, label } = this.layerNodes(mode);
    bar?.setAttribute('opacity', '0');
    if (label) label.textContent = '';
  }

  private hideLayers(): void {
    for (const mode of LAYERS) this.hideLayerBar(mode);
    this.clearLayerHighlights();
  }

  /** Draw a horizontal purple line from the voice cursor's bar to the
   *  bounding box of the selected note. Works for both chord-child notes
   *  (line anchored at the chord's left edge) and bare notes (line anchored
   *  at the note's own left edge — yields a short horizontal mark across
   *  the notehead). Hides the line when there is no chord-internal selection
   *  or when the required bbox isn't available (e.g. before first render). */
  private renderChordInternalLine(
    sel: { noteId: string } | null,
  ): void {
    if (!this.chordIntLine) return;
    if (!sel) {
      this.chordIntLine.setAttribute('opacity', '0');
      return;
    }
    /* Locate the rendered note. Verovio emits each <note> as <g class="note"
       id="<xml:id>">. The id may be bare (top-level <note>) or nested inside
       a g.chord wrapper. Use closest('g.chord') to find the visual chord
       extent for the line's left anchor when applicable. */
    const escapedId = typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(sel.noteId)
      : sel.noteId;
    const target = document.querySelector('#' + escapedId) as SVGGElement | null;
    if (!target) { this.chordIntLine.setAttribute('opacity', '0'); return; }
    const anchorEl = (target.closest('g.chord') ?? target) as SVGGElement;
    const svg = this.svg!;
    const svgRect = svg.getBoundingClientRect();
    const cRect = anchorEl.getBoundingClientRect();
    /* Use the notehead's bbox for the vertical anchor — `target` (g.note)
       includes the accidental glyph as a child, which biases the union
       bbox upward for flats / downward for sharps. The notehead itself
       is `.notehead` inside the note group; that's what we want centered
       on. Fall back to the note's bbox if the notehead can't be located
       (defensive — Verovio's structure should always provide one). */
    const noteheadEl = (target.querySelector('.notehead') ?? target) as SVGGElement;
    const nRect = noteheadEl.getBoundingClientRect();
    /* Line geometry: from the chord's LEFT edge to the cursor bar, at the
       selected notehead's vertical center. The line passes over the middle
       of the selected notehead (since the cursor sits past the chord and
       the notehead is inside the chord). */
    const x1 = cRect.left - svgRect.left;
    const x2 = parseFloat(this.barRect?.getAttribute('x') ?? '0');
    const y = nRect.top + nRect.height / 2 - svgRect.top;
    this.chordIntLine.setAttribute('x1', String(x1));
    this.chordIntLine.setAttribute('y1', String(y));
    this.chordIntLine.setAttribute('x2', String(x2));
    this.chordIntLine.setAttribute('y2', String(y));
    this.chordIntLine.setAttribute('opacity', '1');
  }

  /* ── voice-cursor rendering (preserved verbatim from prior version) ────── */

  private renderVoiceCursor(model: ComposerModel, mode: 'insert' | 'overwrite'): void {
    const voice = model.getCurrentVoice();
    /* Resolve the render-agnostic anchor, then compute geometry via the SHARED
       function (the same one HKL's Composer-view frame uses) so the two cursors
       are pixel-identical over identical renders. Fallback to a default bar if
       the anchor's elements aren't rendered yet. */
    const anchor = resolveVoiceCursorAnchor(model, voice, mode);
    const geom = computeVoiceCursorRect(anchor, COMPOSER_QUERY)
      ?? { x: 80, y: 60 + (voice - 1) * 50, w: CURSOR_WIDTH, h: 60, isBox: false };
    const { x, y, w, h, isBox: isSelectionBox } = geom;

    const bar = this.barRect!;
    bar.setAttribute('x', String(x));
    bar.setAttribute('y', String(y));
    bar.setAttribute('width', String(w));
    bar.setAttribute('height', String(h));
    if (isSelectionBox) {
      bar.style.fill = CURSOR_COLOR;
      bar.setAttribute('fill-opacity', String(SELECTION_FILL_OPACITY));
      bar.style.stroke = CURSOR_COLOR;
      bar.setAttribute('stroke-opacity', String(SELECTION_STROKE_OPACITY));
      bar.setAttribute('stroke-width', '1.5');
      bar.setAttribute('opacity', '1');
    } else {
      bar.style.fill = CURSOR_COLOR;
      bar.setAttribute('fill-opacity', '1');
      bar.style.stroke = '';
      bar.removeAttribute('stroke-opacity');
      bar.removeAttribute('stroke-width');
      bar.setAttribute('opacity', '0.85');
    }

    const label = this.voiceLabel!;
    label.textContent = 'V' + voice;
    const labelX = isSelectionBox ? x + w + 4 : x + 4;
    label.setAttribute('x', String(labelX));
    label.setAttribute('y', String(y - 2));

    if (DEBUG) console.log('[cursor]', { voice, mode, anchor, x, y, w, h, isSelectionBox });
  }

  /* ── layer-cursor rendering (expression / pedal / tempo) ──────────────── */

  private renderLayerCursor(model: ComposerModel, mode: LayerMode, c: ExpressionCursor, instrIdx: number): void {
    const { bar, label } = this.layerNodes(mode);
    const name = LAYER_LABEL[mode];
    const stop = currentStop(c);
    const g = stop ? layerBarRect(model, mode, c, instrIdx) : null;
    if (!g) {
      bar.setAttribute('opacity', '0');
      label.textContent = stop
        ? name + ' m' + (stop.moment.measureIdx + 1) + ' β' + stop.moment.tstamp.toFixed(2).replace(/\.?0+$/, '')
        : name + ' (empty)';
      label.setAttribute('x', '80');
      label.setAttribute('y', '20');
      return;
    }
    bar.setAttribute('x', String(g.x));
    bar.setAttribute('y', String(g.y));
    bar.setAttribute('width', String(g.w));
    bar.setAttribute('height', String(g.h));
    bar.setAttribute('opacity', '0.85');
    label.textContent = name;
    label.setAttribute('x', String(g.x + 4));
    label.setAttribute('y', String(mode === 'pedal' ? g.y + g.h + 12 : g.y - 2));
  }

  /** Tag the selected mark's rendered pieces with the layer's class. */
  private updateLayerHighlight(mode: LayerMode, c: ExpressionCursor): void {
    this.clearLayerHighlights();
    const mark = currentStop(c)?.mark;
    if (!mark) return;
    const els = markPieces(mark);
    /* The render clone restates a tempo above every part
       (`duplicateTempiAcrossParts`), so the selection lights up the original
       AND its `-p<staffN>` copies — one highlighted mark out of several
       identical ones reads as a different mark. */
    if (mark.kind === 'tempo') {
      for (const g of renderer.queryRendered('g.tempo')) {
        if (g.id && g.id !== mark.id && tempoCopySource(g.id) === mark.id) els.push(g);
      }
    }
    for (const el of els) el.classList.add(LAYER_SELECTED_CLASS[mode]);
    this.layerSelected = els;
  }

  private clearLayerHighlights(): void {
    const classes = Object.values(LAYER_SELECTED_CLASS);
    for (const el of this.layerSelected) el.classList.remove(...classes);
    /* Defensive: a re-render can carry a stale class on an element whose id
       survived. */
    const container = this.scoreContainer();
    if (container) {
      for (const cls of classes) {
        for (const node of Array.from(container.querySelectorAll('.' + cls))) node.classList.remove(cls);
      }
    }
    this.layerSelected = [];
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
    this.onPlaybackChange?.();
  }

  isPlaybackMode(): boolean {
    return this.playbackMode;
  }

  /** Snapshot of every active voice's playback meiId. Used by the seek
   *  logic to decide whether ANY voice is at a measure boundary (= about
   *  to play the first content of its measure), in which case Ctrl+←
   *  should jump back one extra measure. */
  getPlaybackPositions(): Map<Voice, string> {
    return new Map([...this.playbackPositions].map(([v, p]) => [v, p.meiId]));
  }

  /** The full overlay, edges included — what main.ts ships to HKL's frame. */
  getPlaybackBars(): { voice: Voice; meiId: string; edge: PlaybackBarEdge }[] {
    return [...this.playbackPositions].map(([voice, p]) => ({ voice, meiId: p.meiId, edge: p.edge }));
  }

  setPlaybackPosition(voice: Voice, meiId: string | null, edge: PlaybackBarEdge = 'left'): void {
    if (!this.svg) return;
    if (meiId === null) {
      this.playbackPositions.delete(voice);
      const bar = this.playbackBars.get(voice);
      if (bar) bar.setAttribute('opacity', '0');
      this.onPlaybackChange?.();
      return;
    }
    this.playbackPositions.set(voice, { meiId, edge });
    this.positionPlaybackBar(voice, meiId, edge);
    this.onPlaybackChange?.();
  }

  private positionPlaybackBar(voice: Voice, meiId: string, edge: PlaybackBarEdge): void {
    if (!this.svg) return;
    let bar = this.playbackBars.get(voice);
    if (!bar) {
      bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bar.style.fill = CURSOR_COLOR;
      bar.setAttribute('data-cursor-role', 'playback');
      bar.setAttribute('opacity', '0.85');
      bar.setAttribute('width', String(PLAYBACK_WIDTH));
      this.svg.appendChild(bar);
      this.playbackBars.set(voice, bar);
    }
    /* Hide the bar on a user-hidden rest rather than parking it on the
       (invisible) rest's coordinates. */
    if (renderedIsHiddenRest(meiId)) { bar.setAttribute('opacity', '0'); return; }
    /* Shared geometry — identical to HKL's Composer-view playback bar. */
    const geom = computePlaybackBarRect(meiId, COMPOSER_QUERY, edge);
    if (!geom) {
      bar.setAttribute('opacity', '0');
      return;
    }
    bar.setAttribute('x', String(geom.x));
    bar.setAttribute('y', String(geom.y));
    bar.setAttribute('width', String(geom.w));
    bar.setAttribute('height', String(geom.h));
    bar.setAttribute('opacity', '0.85');
  }

  hide(): void {
    if (this.barRect) this.barRect.setAttribute('opacity', '0');
    if (this.voiceLabel) this.voiceLabel.textContent = '';
    if (this.exprBar) this.exprBar.setAttribute('opacity', '0');
    if (this.exprLabel) this.exprLabel.textContent = '';
    if (this.pedalBar) this.pedalBar.setAttribute('opacity', '0');
    if (this.pedalLabel) this.pedalLabel.textContent = '';
    if (this.tempoBar) this.tempoBar.setAttribute('opacity', '0');
    if (this.tempoLabel) this.tempoLabel.textContent = '';
    for (const bar of this.playbackBars.values()) bar.setAttribute('opacity', '0');
    this.clearLayerHighlights();
  }
}

export const cursor = new CursorOverlay();
