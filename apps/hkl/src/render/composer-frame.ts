// Composer-view frame. When HKL's "Composer view" mode is on, this renders the
// MEI mirrored from HKL Composer (the cursor instrument's part) as a
// horizontally-scrolling single system, and draws cursor bars that are
// PIXEL-IDENTICAL to Composer's 50%-zoom scroll view.
//
// Identity is structural, not reconstructed: the score is HKL's own Verovio
// re-render of the same MEI at the same options (already pixel-identical), and
// the cursor uses the SHARED computeVoiceCursorRect / computePlaybackBarRect
// (@hkl/shared) — the exact same geometry Composer's cursor.ts uses — fed the
// render-agnostic anchor Composer ships over the bridge. Composer's own cursor
// goes through the same functions (pinned by a test), so the two can't drift.
//
// Voice mode → one bar at the active voice (from composer-cursor's anchor).
// Playback mode → one bar per sounding voice at its note (HKL's scheduler knows
// the voice + element id of every event).
//
// Follows the "Dark staff notation" toggle (body.staff-dark, same as the staff
// inset); the shared @hkl/notation theming recolors staff/ink/noteheads for the
// chosen theme.

import { renderMeiToContainer } from '@hkl/notation/verovio.js';
import type { VoiceCursorAnchor } from '@hkl/bridge/protocol.js';
import {
  computeVoiceCursorRect, computePlaybackBarRect,
  type CursorRectQuery, type CursorGeom,
} from '@hkl/shared/cursor-geom.js';

const HINT = '<span class="composer-frame-hint">Composer view — open HKL Composer in another tab to mirror its score here.</span>';
const CURSOR_COLOR = '#7226e4';            /* Composer CURSOR_COLOR */
const SELECTION_FILL_OPACITY = 0.18;       /* Composer SELECTION_FILL_OPACITY */
const SELECTION_STROKE_OPACITY = 0.7;      /* Composer SELECTION_STROKE_OPACITY */
const SVG_NS = 'http://www.w3.org/2000/svg';

let latestMei: string | null = null;
let editingAnchor: VoiceCursorAnchor | null = null;
let activeVoice = 0;
/** Playback-mode per-voice positions: voice → sounding element xml:id. */
const playbackBars = new Map<number, string>();
let playbackMode = false;
let rafScheduled = false;
let renderSeq = 0;

function frameEl(): HTMLElement | null {
  return document.getElementById('composerFrame');
}

function active(): boolean {
  return document.body.classList.contains('composer-view');
}

function verovioSvg(): SVGSVGElement | null {
  return (frameEl()?.querySelector('svg') as SVGSVGElement | null) ?? null;
}

export function setComposerScore(mei: string): void {
  latestMei = mei;
  scheduleRender();
}

/** Voice-mode editing cursor (from composer-cursor). Ignored while a playback
 *  is showing per-voice bars. */
export function setComposerCursor(voice: number, anchor: VoiceCursorAnchor): void {
  editingAnchor = anchor;
  activeVoice = voice;
  if (!playbackMode) { drawCursors(); scrollToActive(); }
}

export function setComposerPlaybackMode(on: boolean): void {
  playbackMode = on;
  if (!on) playbackBars.clear();
  drawCursors();
  scrollToActive();
}

export function setComposerPlaybackBar(voice: number, meiId: string): void {
  playbackBars.set(voice, meiId);
  if (playbackMode) { drawCursors(); scrollToId(meiId); }
}

export function renderComposerFrame(): void {
  scheduleRender();
}

export function clearComposerFrame(): void {
  const el = frameEl();
  if (el) el.innerHTML = HINT;
  editingAnchor = null;
  playbackBars.clear();
}

function scheduleRender(): void {
  if (!active() || rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    void doRender();
  });
}

async function doRender(): Promise<void> {
  const el = frameEl();
  if (!el || !active()) return;
  if (!latestMei) { el.innerHTML = HINT; return; }
  const seq = ++renderSeq;
  const dark = document.body.classList.contains('staff-dark');
  await renderMeiToContainer(latestMei, el, { geometry: 'scroll', theme: dark ? 'dark' : 'light' });
  if (seq !== renderSeq) return;
  drawCursors();
  scrollToActive();
}

function findById(root: ParentNode, id: string): Element | null {
  return root.querySelector('[id="' + id.replace(/"/g, '\\"') + '"]');
}

/** A CursorRectQuery over the frame's rendered SVG, in CLIENT px (the shared
 *  geometry only uses relative offsets, so any consistent px space works; we
 *  then map the result into SVG user coords for drawing). Mirrors Composer's
 *  renderer.rectForId / findSigEndXForStaff, but client-space. */
function frameQuery(svg: SVGSVGElement): CursorRectQuery {
  return {
    rectForId(id) {
      const el = findById(svg, id);
      if (!el) return null;
      const r = (el as SVGGraphicsElement).getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    },
    sigEndXForStaff(staffId) {
      const staffNode = findById(svg, staffId);
      if (!staffNode) return null;
      const s = (staffNode as SVGGraphicsElement).getBoundingClientRect();
      const inside = (r: DOMRect): boolean => {
        const cy = (r.top + r.bottom) / 2, cx = (r.left + r.right) / 2;
        return cy >= s.top && cy <= s.bottom && cx >= s.left && cx <= s.right;
      };
      let firstContentLeft = Infinity;
      for (const n of Array.from(svg.querySelectorAll('g.note, g.chord, g.rest'))) {
        const r = (n as SVGGraphicsElement).getBoundingClientRect();
        if (inside(r) && r.left < firstContentLeft) firstContentLeft = r.left;
      }
      let rightmost = -Infinity;
      for (const n of Array.from(svg.querySelectorAll('g.clef, g.keySig, g.meterSig'))) {
        const r = (n as SVGGraphicsElement).getBoundingClientRect();
        if (!inside(r) || r.left >= firstContentLeft) continue;
        if (r.right > rightmost) rightmost = r.right;
      }
      return rightmost === -Infinity ? null : rightmost;
    },
  };
}

/** Draw a cursor bar/box from a CLIENT-px geom by mapping its corners into the
 *  SVG's user coordinate system (via the screen CTM). Drawn inside the Verovio
 *  <svg> so it scrolls with the score; inline style fill/stroke beat Verovio's
 *  `#mus… rect { stroke: currentColor }` rule (which would add a white outline).
 *  `box` mode draws Composer's translucent overwrite selection box. */
function drawGeom(svg: SVGSVGElement, inv: DOMMatrix, geom: CursorGeom, label?: string): void {
  const tl = new DOMPoint(geom.x, geom.y).matrixTransform(inv);
  const br = new DOMPoint(geom.x + geom.w, geom.y + geom.h).matrixTransform(inv);
  const x = Math.min(tl.x, br.x), y = Math.min(tl.y, br.y);
  const w = Math.max(0.5, Math.abs(br.x - tl.x)), h = Math.abs(br.y - tl.y);
  const bar = document.createElementNS(SVG_NS, 'rect');
  bar.setAttribute('data-hkl-cursor', '1');
  bar.setAttribute('x', String(x));
  bar.setAttribute('y', String(y));
  bar.setAttribute('width', String(w));
  bar.setAttribute('height', String(h));
  bar.style.fill = CURSOR_COLOR;
  if (geom.isBox) {
    bar.style.fillOpacity = String(SELECTION_FILL_OPACITY);
    bar.style.stroke = CURSOR_COLOR;
    bar.style.strokeOpacity = String(SELECTION_STROKE_OPACITY);
    bar.style.strokeWidth = String(Math.abs((new DOMPoint(geom.x + 1.5, geom.y).matrixTransform(inv)).x - tl.x));
    bar.setAttribute('opacity', '1');
  } else {
    bar.style.stroke = 'none';
    bar.setAttribute('opacity', '0.85');
  }
  svg.appendChild(bar);
  if (label) {
    /* Match Composer: label at x+4 (or x+w+4 for a box), y-2; ~11px font. */
    const lc = new DOMPoint(geom.x + (geom.isBox ? geom.w + 4 : 4), geom.y - 2).matrixTransform(inv);
    const fRef = new DOMPoint(geom.x, geom.y + 11).matrixTransform(inv);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('data-hkl-cursor', '1');
    t.setAttribute('x', String(lc.x));
    t.setAttribute('y', String(lc.y));
    t.style.fill = CURSOR_COLOR;
    t.style.stroke = 'none';
    t.setAttribute('font-family', 'system-ui, sans-serif');
    t.setAttribute('font-weight', '600');
    t.setAttribute('font-size', String(Math.abs(fRef.y - tl.y)));
    t.textContent = label;
    svg.appendChild(t);
  }
}

function drawCursors(): void {
  const svg = verovioSvg();
  if (!svg) return;
  for (const old of Array.from(svg.querySelectorAll('[data-hkl-cursor]'))) old.remove();
  if (!active()) return;
  const ctm = svg.getScreenCTM();
  if (!ctm) return;
  const inv = ctm.inverse();
  const q = frameQuery(svg);

  if (playbackMode) {
    for (const meiId of playbackBars.values()) {
      const geom = computePlaybackBarRect(meiId, q);
      if (geom) drawGeom(svg, inv, geom);
    }
    return;
  }
  if (editingAnchor) {
    const geom = computeVoiceCursorRect(editingAnchor, q);
    if (geom) drawGeom(svg, inv, geom, 'V' + activeVoice);
  }
}

/** Scroll the active voice's cursor / a measure into view. */
function scrollToActive(): void {
  if (playbackMode || !editingAnchor) return;
  const a = editingAnchor;
  scrollToId(a.elementId ?? a.measureId ?? a.staffId ?? '');
}

function scrollToId(id: string): void {
  const el = frameEl();
  const svg = verovioSvg();
  if (!el || !svg || !id) return;
  const target = findById(svg, id);
  if (!target) return;
  const PAD = 48;
  const tr = (target as SVGGraphicsElement).getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const left = tr.left - er.left + el.scrollLeft;
  const right = left + tr.width;
  let next = el.scrollLeft;
  if (tr.width + 2 * PAD > el.clientWidth || left < el.scrollLeft + PAD) {
    next = Math.max(0, left - PAD);
  } else if (right > el.scrollLeft + el.clientWidth - PAD) {
    next = Math.max(0, right - el.clientWidth + PAD);
  }
  if (next !== el.scrollLeft) el.scrollTo({ left: next, behavior: 'smooth' });
}
