// Cursor overlay. Two modes:
//   - Editing mode (default): single bar at the model's insertion point.
//   - Playback mode: per-voice bars, one for each voice currently sounding.
//     The editing cursor is hidden; the editing cursor's model state is
//     preserved so it can be restored when playback ends.

import { renderer } from './render.js';
import type { ComposerModel, Voice } from './model.js';

const CURSOR_COLOR = '#7226e4';
const CURSOR_WIDTH = 2;
const PLAYBACK_WIDTH = 3;
const CURSOR_VPAD = 6;

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
    /* Reset element refs: the previous overlay SVG has been removed from the
       DOM (Verovio rewrote #score.innerHTML between renders). ensureNodes()
       re-creates the editing cursor; playback bars get recreated lazily on
       the next playback-position event. */
    this.barRect = null;
    this.voiceLabel = null;
    this.playbackBars.clear();
  }

  private ensureNodes(): void {
    if (!this.svg) return;
    if (!this.barRect) {
      this.barRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      this.barRect.setAttribute('fill', CURSOR_COLOR);
      this.barRect.setAttribute('opacity', '0.7');
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
      /* Reposition any visible playback bars (since the underlying Verovio
         SVG may have re-laid out). */
      for (const [voice, meiId] of this.playbackPositions) {
        this.positionPlaybackBar(voice, meiId);
      }
      return;
    }

    const voice = model.getCurrentVoice();
    const cursor = model.getCursor();
    const voiceLen = model.getVoiceLength();

    let x: number, y: number, h: number;
    let diag: Record<string, unknown> = { voice, cursor, voiceLen };

    if (voiceLen === 0) {
      x = 80;
      y = 60 + (voice - 1) * 50;
      h = 60;
      diag.case = 'empty-voice';
    } else {
      let refId: string | null = null;
      let edge: 'left' | 'right' = 'left';
      if (cursor < voiceLen) {
        refId = model.getElementIdAt(voice, cursor);
        edge = 'left';
      } else {
        refId = model.getElementIdAt(voice, voiceLen - 1);
        edge = 'right';
      }
      const rect = refId ? renderer.rectForId(refId) : null;
      diag = { ...diag, refId, edge, rect: rect ? { l: rect.left, t: rect.top, w: rect.width, h: rect.height } : null };
      if (rect) {
        x = (edge === 'left') ? (rect.left - 4) : (rect.right + 4);
        y = rect.top - CURSOR_VPAD;
        h = rect.height + CURSOR_VPAD * 2;
        diag.case = 'rect-found';
      } else {
        x = 80;
        y = 60 + (voice - 1) * 50;
        h = 60;
        diag.case = refId ? 'rect-missing' : 'no-refId';
      }
    }

    const bar = this.barRect!;
    bar.setAttribute('x', String(x));
    bar.setAttribute('y', String(y));
    bar.setAttribute('width', String(mode === 'overwrite' ? CURSOR_WIDTH * 3 : CURSOR_WIDTH));
    bar.setAttribute('height', String(h));
    bar.setAttribute('opacity', mode === 'overwrite' ? '0.45' : '0.85');

    const label = this.voiceLabel!;
    label.textContent = 'V' + voice;
    label.setAttribute('x', String(x + 4));
    label.setAttribute('y', String(y - 2));

    if (DEBUG) {
      diag = { ...diag, x, y, h, mode,
        svgSize: { w: this.svg.getAttribute('width'), h: this.svg.getAttribute('height') } };
      console.log('[cursor]', diag);
    }
  }

  /* ── playback mode ─────────────────────────────────────────────────────── */

  setPlaybackMode(on: boolean): void {
    this.playbackMode = on;
    if (!on) {
      /* Hide and clear all playback bars; editing cursor becomes visible
         again on the next update() call. */
      this.playbackPositions.clear();
      for (const bar of this.playbackBars.values()) {
        bar.setAttribute('opacity', '0');
      }
    }
  }

  /** Update one voice's playback cursor. Pass meiId=null to remove. */
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
