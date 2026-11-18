// How a key is painted: its hexagon's path and its note-name label. The
// lattice (render/draw.ts) and the shape guide both paint keys through this
// module, so a key in the guide is an HKL key by construction.
//
// Nothing here reads the canvas, the layout geometry or the tuning state: the
// context and the key size are arguments. The context is the handful of
// CanvasRenderingContext2D members these painters use, so a recorder that
// implements them (an SVG writer, for print) can stand in for a canvas.

import { SEPT_UP_1, SEPT_UP_2 } from '@hkl/shared/heji.js';
import type { HejiLabel, HejiGlyphFamily, HejiGlyphInfo } from '../tuning/heji.js';

/** What the painters use of a 2D context. Filling a hexagon's path is the
 *  caller's, with its own fill style. */
export type KeyContext = Pick<
  CanvasRenderingContext2D,
  'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'fillText' | 'measureText'
  | 'font' | 'fillStyle' | 'textAlign' | 'textBaseline'
>;

/** A key's size: the hex inradius in px, and the stroke/label scale that goes
 *  with it (layout/geometry.ts hexR and hexScale). */
export interface KeySize {
  hexR: number;
  hexScale: number;
}

/** A key's hexagon, radius `r` around (cx, cy), as a new path. */
export function hexPath(ctx: KeyContext, cx: number, cy: number, r: number): void { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)); } ctx.closePath(); }
/** The same hexagon added to the current path as a subpath, so many can share one fill. */
export function hexSubpath(ctx: KeyContext, cx: number, cy: number, r: number): void { for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.closePath(); }

/** The band-seam segment between two adjacent keys centered on (ax, ay) and
 *  (bx, by): through the midpoint between them, square to the line joining
 *  them, 0.55 × hexR to each side. Returned as [x1, y1, x2, y2]. */
export function seamSegment(ax: number, ay: number, bx: number, by: number, hexR: number): [number, number, number, number] {
  const eHL = hexR * 0.55;
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy);
  const nx = -dy / len, ny = dx / len;
  return [mx + nx * eHL, my + ny * eHL, mx - nx * eHL, my - ny * eHL];
}

/** A key's label, centered on (cx, cy): dark ink on a white key, light on a
 *  black one, fainter on a key outside the keyboard (`isExt`). The caller
 *  makes sure BravuraText is loaded. */
export function drawKeyLabel(
  ctx: KeyContext,
  cx: number,
  cy: number,
  label: HejiLabel,
  isW: boolean,
  isExt: boolean,
  size: KeySize,
): void {
  ctx.fillStyle = isW
    ? isExt
      ? "rgba(0,0,0,0.45)"
      : "rgba(0,0,0,0.8)"
    : isExt
      ? "rgba(255,255,255,0.5)"
      : "rgba(255,255,255,0.9)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  drawHejiLabel(ctx, cx, cy, label, size);
}

/** HEJI-on rendering: letter in sans-serif followed by a chain of combined
 *  Bravura SMuFL glyphs (each carrying one Pythagorean accidental + up to 2
 *  syntonic-comma arrows), optionally ending in a septimal hook. Width
 *  budget mirrors the conventional path — same hexR×1.3 maxW with a
 *  shrink-to-fit floor at 6px. */
/* Per-family vertical fine-tune for HEJI glyphs, in fractions of the
 * Bravura font size. BravuraText's accidentals share a common musical Y
 * anchor (the staff-line they're engraved to sit on), but their *visual*
 * centers don't all align with that anchor — the symmetric glyphs
 * (natural, sharp, double-sharp) center near the anchor, while flats/
 * doubleFlats have asymmetric extents (round body below staff line, stem
 * reaching above) and visually float higher than their anchor. A single
 * shared offset (e.g. natural-bbox-based auto-calibration) under-corrects
 * the symmetric family and over-corrects the flat family.
 *
 * These values are empirical — adjust them if the visual alignment drifts.
 * Positive = shift DOWN (Y down in canvas). The chosen baseline puts the
 * symmetric family centered with the letter; flats compensate downward.
 *
 * If you need to retune: render a cell whose label is, say, "Eb" or "F##"
 * in HEJI mode and eyeball the accidental's visual midpoint against the
 * letter. Adjust the family value by ±0.02 at a time. */
const HEJI_FAMILY_Y_OFFSET: Record<HejiGlyphFamily, number> = {
  natural:     0.06,
  sharp:       0.06,
  doubleSharp: 0.06,
  flat:        0.13,
  doubleFlat:  0.13,
  septimal:    0.18,
};

/* BravuraText draws each up hook lower than its down twin, at the same ink
 * height (font units of 1000, read from public/BravuraText.otf 2026-10-29):
 * single up y 64–487 vs down 324–747, double up 83–638 vs down 166–721.
 * Raising an up hook by the difference gives it its down twin's vertical ink
 * extent, so the one septimal family offset fits both directions. Fractions
 * of the Bravura font size. */
const SEPT_UP_RAISE: Readonly<Record<string, number>> = {
  [String.fromCodePoint(SEPT_UP_1)]: 0.260,
  [String.fromCodePoint(SEPT_UP_2)]: 0.084,
};

function septimalYOffset(g: HejiGlyphInfo): number {
  return HEJI_FAMILY_Y_OFFSET.septimal - (SEPT_UP_RAISE[g.ch] ?? 0);
}

/* Bare-accidental codepoints per family — used as the layout-slot reference
 * regardless of what arrows are attached. Bravura's combined glyphs (e.g.
 * U+E2C1 = flat+1arrowDown) have the accidental at the LEFT of a wider
 * advance box, with the arrow extending RIGHT. Using the bare advance as
 * the slot keeps the accidental at a consistent X whether arrows are
 * present or not; the arrow extends past the slot's right edge without
 * affecting layout. */
const BARE_ACC_CODE: Record<HejiGlyphFamily, string | null> = {
  natural:     '\u{E261}',
  sharp:       '\u{E262}',
  flat:        '\u{E260}',
  doubleSharp: '\u{E263}',
  doubleFlat:  '\u{E264}',
  septimal:    null,           // no bare alternative — the hook IS the glyph
};

/** Width to reserve for a glyph in the chain. For accidental families this
 *  is the BARE accidental's advance (ignoring any attached arrows); for
 *  septimal hooks it's the hook's own advance. Caller must set ctx.font to
 *  the Bravura font size first. */
function slotAdvance(ctx: KeyContext, g: HejiGlyphInfo): number {
  const bare = BARE_ACC_CODE[g.family];
  return ctx.measureText(bare ?? g.ch).width;
}

/* Collapse-exponent typography. The superscript number rides above-right of
 * the collapse accidental in plain sans-serif. The two key numbers:
 *   EXP_SCALE — superscript font size as a fraction of the Bravura font size.
 *     0.55 reads as "small but legible at hex scale"; smaller becomes a dot,
 *     larger competes visually with the accidental itself.
 *   EXP_ASCENT_FRAC — where the digit's bottom (its alphabetic baseline)
 *     sits relative to the accidental's visual top. 0.45 = baseline drops
 *     just below the accidental's apex so the digit overlaps slightly and
 *     reads as attached to it.
 * Tuned by inspection at the COLLAPSE_THRESHOLD boundary (|AD|=5 / |SD|=5
 * collapse cases in Pythagorean mode). */
const EXP_SCALE = 0.42;
const EXP_ASCENT_FRAC = 0.45;

function drawHejiLabel(ctx: KeyContext, cx: number, cy: number, label: HejiLabel, size: KeySize): void {
  /* Scale the base label size with the hex-size preset. maxW (= hexR*1.3)
     scales by the same factor, so the shrink-to-fit ratio below is unchanged
     relative to medium — labels grow at Large and shrink at Small while
     keeping identical fit behavior. The 6/5/4px floors stay absolute. */
  const baseFontSize = 14 * size.hexScale;
  /* BravuraText is compiled with text-style metrics, but SMuFL accidental
     glyphs still occupy only a fraction of the em box (engraved to fit a
     5-line staff, so glyph extent is much smaller than the equivalent
     Unicode ♯/♭ in a sans-serif font at the same font-size). To match the
     visual weight of the conventional path, render Bravura glyphs at
     ~1.8× the letter font size. */
  const hejiScale = 1.8;
  /* Layout order (left to right):
       letter
       exponent groups with position 'before', in array order
       chain (all non-septimal glyphs)
       exponent groups with position 'after'
       septimal hooks (if present) — always last so they visually trail an
         'after' group's exponent (bare-accidental excess + Septimal-mode
         cells); above HOOK_COLLAPSE_THRESHOLD one hook carrying `hookCount`
         as exponent.
     Slot widths are computed against the bare-accidental advance so attached
     arrows extend past their slot's right edge without affecting layout. */
  const chainGs: HejiGlyphInfo[] = [];
  const septimalGs: HejiGlyphInfo[] = [];
  for (const g of label.glyphs) {
    (g.family === 'septimal' ? septimalGs : chainGs).push(g);
  }
  /* Glyphs anchor at their LEFT edge (see the render pass); set it before any
     ink measurement, since actualBoundingBoxRight is measured from it. */
  ctx.textAlign = 'left';
  /* A down arrow hangs past its accidental's bare slot (natural ↓ by 0.057
     em); the hooks start after that ink, not over it. Caller sets the Bravura
     font. */
  const hookOverhang = (): number => {
    if (septimalGs.length === 0 || chainGs.length === 0) return 0;
    if (label.collapses.some((c) => c.position === 'after')) return 0;
    const last = chainGs[chainGs.length - 1];
    return Math.max(0, ctx.measureText(last.ch).actualBoundingBoxRight - slotAdvance(ctx, last));
  };
  /* width pass at base size */
  ctx.font = '500 ' + baseFontSize + 'px sans-serif';
  let totalW = ctx.measureText(label.letter).width;
  ctx.font = '500 ' + Math.round(baseFontSize * hejiScale) + 'px "BravuraText", sans-serif';
  for (const c of label.collapses) totalW += slotAdvance(ctx, c.glyph) + 0.5;
  for (const g of chainGs) totalW += slotAdvance(ctx, g) + 0.5;
  for (const g of septimalGs) totalW += slotAdvance(ctx, g) + 0.5;
  totalW += hookOverhang();
  ctx.font = '500 ' + Math.round(baseFontSize * hejiScale * EXP_SCALE) + 'px sans-serif';
  for (const c of label.collapses) totalW += ctx.measureText(String(c.count)).width;
  if (label.hookCount) totalW += ctx.measureText(String(label.hookCount)).width;
  /* shrink to fit hex */
  const maxW = size.hexR * 1.3;
  const scale = Math.min(1, maxW / totalW);
  const fontSize = Math.max(6, Math.round(baseFontSize * scale));
  const hejiFontSize = Math.max(5, Math.round(fontSize * hejiScale));
  const expFontSize = Math.max(4, Math.round(hejiFontSize * EXP_SCALE));
  /* measure at final sizes */
  ctx.font = '500 ' + fontSize + 'px sans-serif';
  const flw = ctx.measureText(label.letter).width;
  ctx.font = '500 ' + hejiFontSize + 'px "BravuraText", sans-serif';
  const chainSlotWs = chainGs.map((g) => slotAdvance(ctx, g));
  const septimalSlotWs = septimalGs.map((g) => slotAdvance(ctx, g));
  /* Per exponent group: slot width, the bare accidental's ascent (the
     exponent's vertical anchor) and, below, the exponent's width.
     actualBoundingBoxAscent reports the distance from the current
     textBaseline (here, 'middle') to the top of the rendered bbox.
     Firefox + Chromium both populate it for Bravura glyphs; fall back to
     a fraction of the font size on engines that don't. */
  const groups = label.collapses.map((c) => ({
    spec: c,
    slotW: slotAdvance(ctx, c.glyph),
    ascent: ctx.measureText(BARE_ACC_CODE[c.glyph.family] ?? c.glyph.ch).actualBoundingBoxAscent || hejiFontSize * 0.6,
    expW: 0,
  }));
  const hookAscent = label.hookCount
    ? ctx.measureText(septimalGs[septimalGs.length - 1].ch).actualBoundingBoxAscent || hejiFontSize * 0.6
    : 0;
  const overhang = hookOverhang();
  ctx.font = '500 ' + expFontSize + 'px sans-serif';
  for (const g of groups) g.expW = ctx.measureText(String(g.spec.count)).width;
  const hookExpW = label.hookCount ? ctx.measureText(String(label.hookCount)).width : 0;
  let tw = flw;
  for (const g of groups) tw += g.slotW + 0.5 + g.expW;
  for (const w of chainSlotWs) tw += w + 0.5;
  for (const w of septimalSlotWs) tw += w + 0.5;
  tw += overhang + hookExpW;
  /* Render with textAlign='left' (set above) so each glyph's LEFT EDGE
     anchors at the slot start. Combined accidental+arrow glyphs have the
     accidental at the left of their advance box, so this keeps the accidental
     portion aligned with the bare-accidental position regardless of arrows. */
  let x = cx - tw / 2;
  ctx.font = '500 ' + fontSize + 'px sans-serif';
  ctx.fillText(label.letter, x, cy);
  x += flw + 0.5;
  const drawGroups = (position: 'before' | 'after'): void => {
    for (const grp of groups) {
      if (grp.spec.position !== position) continue;
      const g = grp.spec.glyph;
      const yOff = HEJI_FAMILY_Y_OFFSET[g.family] * hejiFontSize;
      ctx.font = '500 ' + hejiFontSize + 'px "BravuraText", sans-serif';
      ctx.fillText(g.ch, x, cy + yOff);
      /* Anchor the digit's visual middle near the accidental's upper region:
         cy + yOff is the glyph's musical baseline, ascent carries up to the
         apex, then we drop EXP_ASCENT_FRAC of an ascent so the digit
         overlaps with the top portion of the accidental. textBaseline is
         'middle' so the y we pass is the digit's visual center. */
      const expY = cy + yOff - grp.ascent + grp.ascent * EXP_ASCENT_FRAC;
      ctx.font = '500 ' + expFontSize + 'px sans-serif';
      ctx.fillText(String(grp.spec.count), x + grp.slotW, expY);
      x += grp.slotW + 0.5 + grp.expW;
    }
  };
  drawGroups('before');
  ctx.font = '500 ' + hejiFontSize + 'px "BravuraText", sans-serif';
  for (let i = 0; i < chainGs.length; i++) {
    const g = chainGs[i];
    const yOff = HEJI_FAMILY_Y_OFFSET[g.family] * hejiFontSize;
    ctx.fillText(g.ch, x, cy + yOff);
    x += chainSlotWs[i] + 0.5;
  }
  drawGroups('after');
  /* an 'after' group leaves the exponent font set; the hooks are Bravura */
  ctx.font = '500 ' + hejiFontSize + 'px "BravuraText", sans-serif';
  x += overhang;
  for (let i = 0; i < septimalGs.length; i++) {
    const g = septimalGs[i];
    ctx.fillText(g.ch, x, cy + septimalYOffset(g) * hejiFontSize);
    x += septimalSlotWs[i] + 0.5;
  }
  if (label.hookCount) {
    /* same placement as drawCollapse's exponent, off the trailing hook */
    const yOff = septimalYOffset(septimalGs[septimalGs.length - 1]) * hejiFontSize;
    ctx.font = '500 ' + expFontSize + 'px sans-serif';
    ctx.fillText(String(label.hookCount), x - 0.5, cy + yOff - hookAscent + hookAscent * EXP_ASCENT_FRAC);
  }
  /* restore for next caller — drawKeyLabel sets it on entry, but defensive */
  ctx.textAlign = 'center';
  ctx.font = '500 ' + fontSize + 'px sans-serif';
}
