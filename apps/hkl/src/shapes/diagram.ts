// One shape of the shape guide as a picture: its keys drawn exactly as the
// lattice draws them (render/keys.ts, the lattice's own painters, on HKL's
// own screen geometry), its path keys fainter, and the band seams it crosses.
//
// The picture is laid out by layout/geometry.ts as it currently stands: the
// page sets the hex size and the rotation before drawing. Needs a document
// (it draws on canvases) and BravuraText loaded.

import { coordToMidi } from '@hkl/shared/freq.js';
import { keyColorHex } from '@hkl/shared/keycolor.js';
import { whiteSet } from '@hkl/shared/colors.js';
import { noteName } from '@hkl/shared/notes.js';
import { hexR, hexScale, dxH, dyH, cosT, sinT, tiltAngle } from '../layout/geometry.js';
import { hexPath, drawKeyLabel, seamSegment } from '../render/keys.js';
import { hejiCommas, hejiLabel } from '../tuning/heji.js';
import type { TuningStateLike } from '../tuning/regions.js';
import type { Cell, Shape, ShapeLayout } from './solve.js';

export interface DiagramStyle {
  /** Opacity of a path key: border, fill and label together. */
  pathAlpha: number;
  /** Width of the dark border around a member key. The lattice's, and a path
   *  key's, is 1 (LATTICE_BORDER). */
  memberBorder: number;
  /** HEJI accidentals on the labels (HKL's "HEJI accidentals" checkbox). */
  heji: boolean;
  /** Seam stroke width, in the lattice's own units (it strokes seams at 2). */
  seamWidth: number;
  /** The seams' color, and that of the hexagon behind a member key (its
   *  border): dark on paper, white on a dark page, as the lattice itself
   *  strokes its seams and rings its selected keys. A path key keeps the
   *  lattice's dark border on either. */
  seamColor: string;
  memberBorderColor: string;
  /** Device pixels per CSS pixel of the canvas: 1 CSS px is 1/96 in on paper. */
  scale: number;
}

export interface Diagram {
  canvas: HTMLCanvasElement;
  /** Size in CSS px. */
  width: number;
  height: number;
}

/* A key's center before the rotation, as the lattice lays it out (y down)… */
const flat = ([q, r]: Cell): [number, number] => [q * dxH + r * dxH * 0.5, -r * dyH];
/* …and a point turned by the rotation, which is where it lands on the page. */
const turn = (x: number, y: number): [number, number] => [x * cosT + y * sinT, -x * sinT + y * cosT];

/* The lattice draws a key's color at hexR − 0.5 over a dark hexagon at
   hexR + 0.5 (buildHexLayer in render/draw.ts): a border 1 wide. */
const LATTICE_BORDER = 1;
const LATTICE_BORDER_COLOR = '#111';

/** Draw `cells` as lattice keys: the hexagon behind each, `border` wider than
 *  its color and filled `borderColor`, then its color and its label. `ox`,
 *  `oy` is where lattice (0, 0) lands on the canvas. */
function drawKeys(ctx: CanvasRenderingContext2D, cells: ReadonlyArray<Cell>, state: TuningStateLike, style: DiagramStyle, border: number, borderColor: string, ox: number, oy: number): void {
  const { mode, mapping, anchor, banded } = state;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.rotate(-tiltAngle);
  ctx.fillStyle = borderColor;
  for (const c of cells) { const [x, y] = flat(c); hexPath(ctx, x, y, hexR - 0.5 + border); ctx.fill(); }
  for (const c of cells) {
    const [x, y] = flat(c);
    hexPath(ctx, x, y, hexR - 0.5);
    ctx.fillStyle = keyColorHex(c[0], c[1], mode, mapping, anchor, banded);
    ctx.fill();
  }
  ctx.restore();
  for (const [q, r] of cells) {
    const [x, y] = turn(...flat([q, r]));
    const commas = style.heji ? hejiCommas(q, r, state) : { syn5: 0, sept7: 0 };
    const label = hejiLabel(noteName(q, r, mapping, anchor, banded), commas);
    const pc = ((coordToMidi(q, r, mapping) % 12) + 12) % 12;
    drawKeyLabel(ctx, ox + x, oy + y, label, whiteSet.has(pc), false, { hexR, hexScale });
  }
}

/** The picture of `shape` under `layout`. */
export function renderDiagram(shape: Shape, layout: ShapeLayout, style: DiagramStyle): Diagram {
  const state: TuningStateLike = { ...layout, equalEnabled: false, septimalEnabled: layout.mode === '7', septimalW: 1 };
  const seams = shape.seams.map(([a, b]) => seamSegment(...flat(a), ...flat(b), hexR));
  const seamW = style.seamWidth * hexScale;
  /* the extent of everything drawn, on the page */
  const xs: number[] = [], ys: number[] = [];
  for (const c of [...shape.cells, ...shape.path]) {
    const [x, y] = turn(...flat(c));
    const reach = hexR + Math.max(style.memberBorder, LATTICE_BORDER);
    xs.push(x - reach, x + reach); ys.push(y - reach, y + reach);
  }
  for (const [x1, y1, x2, y2] of seams) for (const [x, y] of [turn(x1, y1), turn(x2, y2)]) {
    xs.push(x - seamW, x + seamW); ys.push(y - seamW, y + seamW);
  }
  const left = Math.floor(Math.min(...xs)), top = Math.floor(Math.min(...ys));
  const width = Math.ceil(Math.max(...xs)) - left, height = Math.ceil(Math.max(...ys)) - top;
  const ox = -left, oy = -top;

  const sheet = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
    const canvas = document.createElement('canvas');
    canvas.width = width * style.scale; canvas.height = height * style.scale;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(style.scale, 0, 0, style.scale, 0, 0);
    return [canvas, ctx];
  };
  const [canvas, ctx] = sheet();
  /* the path keys go on a sheet of their own, laid over the page at their
     opacity, so a key's border, fill and label fade as one: toward white on
     paper, toward the dark of a dark page */
  if (shape.path.length) {
    const [faint, fctx] = sheet();
    drawKeys(fctx, shape.path, state, style, LATTICE_BORDER, LATTICE_BORDER_COLOR, ox, oy);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = style.pathAlpha;
    ctx.drawImage(faint, 0, 0);
    ctx.restore();
  }
  drawKeys(ctx, shape.cells, state, style, style.memberBorder, style.memberBorderColor, ox, oy);
  if (seams.length) {
    ctx.save();
    ctx.translate(ox, oy);
    ctx.rotate(-tiltAngle);
    ctx.strokeStyle = style.seamColor;
    ctx.lineWidth = seamW;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of seams) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    ctx.stroke();
    ctx.restore();
  }
  return { canvas, width, height };
}
