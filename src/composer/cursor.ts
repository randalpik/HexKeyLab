// Cursor overlay. Two modes:
//   - Editing mode (default): single bar (insert) or selection box
//     (overwrite) at the model's current-element position.
//   - Playback mode: per-voice bars, one for each voice currently sounding.
//     The editing cursor is hidden; the editing cursor's model state is
//     preserved so it can be restored when playback ends.
//
// Insert mode anchor: cursor sits at the RIGHT edge of the just-entered
// element (element at flat-index `cursor - 1`). At cursor === 0 it falls
// back to a pre-staff position.
//
// Overwrite mode: cursor renders a translucent selection BOX around the
// element at flat-index `cursor` (the one that would be replaced). At end
// of voice (no current element) falls back to a thin right-edge bar.

import { renderer } from './render.js';
import type { ComposerModel, Voice } from './model.js';

const CURSOR_COLOR = '#7226e4';
const CURSOR_WIDTH = 2;
const PLAYBACK_WIDTH = 3;
const CURSOR_VPAD = 6;
const CURSOR_HPAD = 4;
const SELECTION_FILL_OPACITY = 0.18;
const SELECTION_STROKE_OPACITY = 0.7;

const DEBUG = typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('debugCursor');

class CursorOverlay {
  private svg: SVGSVGElement | null = null;
  private barRect: SVGRectElement | null = null;
  private voiceLabel: SVGTextElement | null = null;

  /* Playback-mode state. Per-voice bars layered over the editing cursor;
     editing cursor itself is hidden while playbackMode is true. */
  private playbackMode = false;
  private playbackBars: Map<Voice, SVGRectElement> = new Map();
  private playbackPositions: Map<Voice, string> = new Map();

  attach(svg: SVGSVGElement): void {
    this.svg = svg;
    this.barRect = null;
    this.voiceLabel = null;
    this.playbackBars.clear();
  }

  private ensureNodes(): void {
    if (!this.svg) return;
    if (!this.barRect) {
      this.barRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      this.barRect.setAttribute('fill', CURSOR_COLOR);
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
  }

  /** Update editing cursor to reflect the model's current voice and cursor.
   *  During playback the editing cursor is hidden (playback bars take over). */
  update(model: ComposerModel, mode: 'insert' | 'overwrite'): void {
    if (!this.svg) return;
    this.ensureNodes();

    if (this.playbackMode) {
      /* Hide editing cursor during playback. */
      this.barRect!.setAttribute('opacity', '0');
      this.voiceLabel!.textContent = '';
      for (const [voice, meiId] of this.playbackPositions) {
        this.positionPlaybackBar(voice, meiId);
      }
      return;
    }

    const voice = model.getCurrentVoice();
    const cursor = model.getCursor();
    const voiceLen = model.getVoiceLength();

    let x = 80, y = 60 + (voice - 1) * 50, w = CURSOR_WIDTH, h = 60;
    let isSelectionBox = false;
    let diag: Record<string, unknown> = { voice, cursor, voiceLen, mode };

    /* Anchor the cursor on the active staff (the staff for this voice in
       the measure containing the cursor). Used both for the truly-empty
       fallback AND for placeholders, whose rendered bbox is degenerate
       (Verovio emits an empty <g> for MEI <space>). */
    const anchorOnStaff = (): boolean => {
      const staffId = model.getStaffIdAtCursor(voice);
      if (!staffId) return false;
      const staffRect = renderer.rectForId(staffId);
      if (!staffRect) return false;
      const sigEndX = renderer.findSigEndXForStaff(staffId);
      /* When this staff has rendered sigs (first measure of a system), put
         the cursor just past them. Otherwise (mid-score measure without sig
         changes) put it a small distance past the staff's left edge. */
      x = sigEndX !== null ? sigEndX + CURSOR_HPAD : staffRect.left + 10;
      y = staffRect.top - CURSOR_VPAD;
      h = staffRect.height + CURSOR_VPAD * 2;
      return true;
    };

    const isPlaceholderEl = (el: Element): boolean =>
      el.localName === 'space' && el.getAttribute('data-placeholder') === 'true';

    if (mode === 'insert') {
      if (cursor === 0) {
        if (anchorOnStaff()) diag.case = 'insert-empty-on-staff';
        else diag.case = 'insert-empty-fallback';
      } else {
        const ref = model.getCurrentElement(voice, 'insert');
        if (!ref || isPlaceholderEl(ref.elem)) {
          /* Placeholder bboxes are degenerate; anchor on the placeholder's
             measure-staff. Same path for a missing ref (defensive). */
          if (anchorOnStaff()) diag.case = ref ? 'insert-placeholder-on-staff' : 'insert-no-ref-staff';
          else diag.case = 'insert-staff-fallback';
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
      /* overwrite */
      if (voiceLen === 0 || cursor >= voiceLen) {
        /* Past end — show a thin right-edge bar (no element to enclose). */
        if (voiceLen > 0) {
          const ref = model.getElementIdAt(voice, voiceLen - 1);
          const rect = ref ? renderer.rectForId(ref) : null;
          if (rect) {
            x = rect.right + CURSOR_HPAD;
            y = rect.top - CURSOR_VPAD;
            h = rect.height + CURSOR_VPAD * 2;
            diag.case = 'overwrite-past-end';
          } else {
            diag.case = 'overwrite-past-end-no-rect';
          }
        } else {
          if (anchorOnStaff()) diag.case = 'overwrite-empty-on-staff';
          else diag.case = 'overwrite-empty-fallback';
        }
      } else {
        const ref = model.getCurrentElement(voice, 'overwrite');
        if (ref && isPlaceholderEl(ref.elem)) {
          /* Placeholder under overwrite cursor — anchor on its measure-
             staff (no selection box since there's nothing visible). */
          if (anchorOnStaff()) diag.case = 'overwrite-placeholder-on-staff';
          else diag.case = 'overwrite-placeholder-fallback';
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
        svgSize: { w: this.svg.getAttribute('width'), h: this.svg.getAttribute('height') } };
      console.log('[cursor]', diag);
    }
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
    for (const bar of this.playbackBars.values()) bar.setAttribute('opacity', '0');
  }
}

export const cursor = new CursorOverlay();
