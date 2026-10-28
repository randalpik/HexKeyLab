// Shared cursor geometry — the SINGLE source of truth for where a Composer
// voice/playback cursor bar sits, so HKL's "Composer view" frame draws a
// pixel-identical cursor over its pixel-identical re-render of the same score.
//
// The split: the CASE DECISION (which element/edge anchors the cursor) needs
// Composer's model, so it stays in Composer (`resolveVoiceCursorAnchor`) and is
// shipped over the bridge as a render-agnostic `VoiceCursorAnchor`. The
// GEOMETRY (turning that anchor + element rects into x/y/w/h, with the fixed
// HPAD/VPAD/width offsets) is this pure function, used by BOTH sides. Composer
// draws its own overlay with it too (pinned by a test), so the two can't drift.
//
// All coordinates are in the consumer's own container-local pixels. The
// horizontal offsets and the bar widths are pixels at zoom 100 and scale with
// the host's render (`notationScale`), so a bar keeps its place in the gaps the
// engraver leaves at every zoom and thins with it, like a staff line; the
// vertical padding stays fixed.

/** Plain rect (container-local px). Mirrors the fields of a DOMRect we use. */
export interface CursorGeomRect {
  left: number; top: number; width: number; height: number; right: number; bottom: number;
}

/** What the geometry function needs from the host's rendered SVG. */
export interface CursorRectQuery {
  /** Bounding rect of an element by xml:id, container-local; null if absent. */
  rectForId(id: string): CursorGeomRect | null;
  /** Right-edge x of the leading clef/keysig/timesig group inside a staff,
   *  container-local; null when the staff has no leading sig (mid-score bars). */
  sigEndXForStaff(staffId: string): number | null;
  /** Whether the rendered element is a grace note/chord (`data-grace`, from
   *  svgAdditionalAttribute `note@grace` / `chord@grace`). */
  isGrace(id: string): boolean;
  /** Drawn size of the notation relative to zoom 100 (the zoom preset's
   *  Verovio scale / 100 — page scale never changes glyph size). */
  notationScale(): number;
}

/** Cursor offsets (px). HPAD and the widths are at zoom 100 and scale by
 *  notationScale(); VPAD is fixed. */
export const CURSOR_HPAD = 4;
export const CURSOR_VPAD = 6;
export const CURSOR_WIDTH = 2;
export const PLAYBACK_WIDTH = 3;
/** A bar past a grace scales its offset (not its width) by this: Verovio packs
 *  a grace tight against its main note, and the full offset put the bar on
 *  the next note. Half the offset centers the bar in the gap between the
 *  grace's ink and the main notehead (measured on `grace_cursor_offset`:
 *  ink ends at 175, notehead starts at 182 → bar at 177–179). */
export const GRACE_SCALE = 0.5;

/** Resolved, render-agnostic cursor anchor (Composer → bridge → HKL). Mirrors
 *  the cases in cursor.ts:renderVoiceCursor. `xMode` selects the horizontal
 *  anchor; `vMode` the vertical extent; the *Id fields supply the elements. */
export interface VoiceCursorAnchor {
  /** Horizontal anchor:
   *   elementRight  — x = rect(elementId).right + HPAD   (insert past a note;
   *                   also tuplet-exit past the bracket, and past-layer-content)
   *   elementLeft   — x = rect(elementId).left  − HPAD   (tuplet-enter)
   *   measureLeft   — leading-sig end / first content / staff left (measure start)
   *   pastEndRight  — x = rect(measureId).right + 2·HPAD (synthetic past-end)
   *   box           — overwrite selection box around elementId */
  xMode: 'elementRight' | 'elementLeft' | 'measureLeft' | 'pastEndRight' | 'box';
  /** Vertical extent: the element's own box, or the voice's staff box. */
  vMode: 'element' | 'staff';
  elementId: string | null;
  staffId: string | null;
  /** measureLeft fallbacks, in priority order after sigEnd. */
  firstContentId: string | null;
  firstPlaceholderId: string | null;
  measureId: string | null;
}

/** Computed cursor rect (container-local px). `isBox` → draw as an outlined
 *  selection box (overwrite mode); otherwise a filled bar. */
export interface CursorGeom { x: number; y: number; w: number; h: number; isBox: boolean }

/** Vertical extent for a `staff`-mode anchor. */
function staffVertical(staffId: string | null, q: CursorRectQuery): { y: number; h: number } | null {
  if (!staffId) return null;
  const s = q.rectForId(staffId);
  if (!s) return null;
  return { y: s.top - CURSOR_VPAD, h: s.height + CURSOR_VPAD * 2 };
}

/** Compute the voice cursor's rect from a resolved anchor + the host's render.
 *  Faithful port of cursor.ts:renderVoiceCursor; returns null if the required
 *  elements aren't rendered (caller hides the cursor). */
export function computeVoiceCursorRect(a: VoiceCursorAnchor, q: CursorRectQuery): CursorGeom | null {
  const s = q.notationScale();
  const hpad = CURSOR_HPAD * s;
  if (a.xMode === 'box') {
    const r = a.elementId ? q.rectForId(a.elementId) : null;
    if (!r) return null;
    return { x: r.left - hpad, y: r.top - CURSOR_VPAD, w: r.width + hpad * 2, h: r.height + CURSOR_VPAD * 2, isBox: true };
  }

  if (a.xMode === 'measureLeft') {
    const v = staffVertical(a.staffId, q);
    const measure = a.measureId ? q.rectForId(a.measureId) : null;
    /* Vertical: prefer the staff; fall back to the measure box (matches
       anchorAtMeasureLeft's setVerticalFromStaff → measure fallback). */
    const vert = v ?? (measure ? { y: measure.top - CURSOR_VPAD, h: measure.height + CURSOR_VPAD * 2 } : null);
    if (!vert) return null;
    /* Horizontal fallback chain: sigEnd → first content → first placeholder →
       staff left+10 → measure left+30. */
    const sigEnd = a.staffId ? q.sigEndXForStaff(a.staffId) : null;
    const staff = a.staffId ? q.rectForId(a.staffId) : null;
    const firstContent = a.firstContentId ? q.rectForId(a.firstContentId) : null;
    const firstPh = a.firstPlaceholderId ? q.rectForId(a.firstPlaceholderId) : null;
    let x: number;
    if (sigEnd != null) x = sigEnd + hpad;
    else if (firstContent) x = firstContent.left - hpad;
    else if (firstPh && firstPh.width > 0) x = firstPh.left + hpad;
    else if (staff) x = staff.left + 10 * s;
    else if (measure) x = measure.left + 30 * s;
    else return null;
    return { x, y: vert.y, w: CURSOR_WIDTH * s, h: vert.h, isBox: false };
  }

  if (a.xMode === 'pastEndRight') {
    const measure = a.measureId ? q.rectForId(a.measureId) : null;
    if (!measure) return null;
    const vert = staffVertical(a.staffId, q) ?? { y: measure.top - CURSOR_VPAD, h: measure.height + CURSOR_VPAD * 2 };
    return { x: measure.right + hpad * 2, y: vert.y, w: CURSOR_WIDTH * s, h: vert.h, isBox: false };
  }

  /* elementRight / elementLeft — vertical follows the element (vMode 'element')
     or the staff (vMode 'staff'). */
  const r = a.elementId ? q.rectForId(a.elementId) : null;
  if (!r) return null;
  const k = a.xMode === 'elementRight' && q.isGrace(a.elementId!) ? GRACE_SCALE : 1;
  const x = a.xMode === 'elementLeft' ? r.left - hpad : r.right + hpad * k;
  const vert = a.vMode === 'staff'
    ? (staffVertical(a.staffId, q) ?? { y: r.top - CURSOR_VPAD, h: r.height + CURSOR_VPAD * 2 })
    : { y: r.top - CURSOR_VPAD, h: r.height + CURSOR_VPAD * 2 };
  return { x, y: vert.y, w: CURSOR_WIDTH * s, h: vert.h, isBox: false };
}

/** Which side of its element a playback bar sits on.
 *   'left'  — at the element's onset: the element is SOUNDING NOW (clock
 *             playback, where the bar marks the moment being heard).
 *   'right' — past the element: it has been PLAYED (Performance mode, where
 *             the bar trails the player like the editing caret trails an
 *             inserted note — same offset as the voice cursor's
 *             `elementRight`, so the two read identically). */
export type PlaybackBarEdge = 'left' | 'right';

/** Playback bar rect for a played/sounding element (matches
 *  cursor.ts:positionPlaybackBar: left edge − HPAD / right edge + HPAD, element
 *  height ± VPAD, PLAYBACK_WIDTH). The 'right' case is deliberately the SAME
 *  expression as computeVoiceCursorRect's `elementRight` — one anchor rule for
 *  both cursors, GRACE_SCALE included. */
export function computePlaybackBarRect(
  meiId: string,
  q: CursorRectQuery,
  edge: PlaybackBarEdge = 'left',
): CursorGeom | null {
  const r = q.rectForId(meiId);
  if (!r) return null;
  const k = edge === 'right' && q.isGrace(meiId) ? GRACE_SCALE : 1;
  const s = q.notationScale();
  const hpad = CURSOR_HPAD * s;
  const x = edge === 'right' ? r.right + hpad * k : r.left - hpad;
  return { x, y: r.top - CURSOR_VPAD, w: PLAYBACK_WIDTH * s, h: r.height + CURSOR_VPAD * 2, isBox: false };
}
