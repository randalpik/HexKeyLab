// Lock glyphs for MANUAL LINE BREAKS (2026-09-11) — page view only.
//
// A manual line break is a plain `<sb>` in the document (model.setLineLockAt;
// render/linebreaks.ts `lockStartIds`). Every system whose NEXT line starts at a
// locked measure gets a small padlock at its right end, drawn as a direct child
// of `g.page-margin` — outside every `g.system`, like the section headers, so
// it never changes the geometry the placement pass measured — carrying
// `data-for` (the locked measure's id) so a click can find the break to remove
// and `data-system` (the system's first measure) so a splice can drop the mark
// with its system. Redrawn from scratch on every placement: idempotent.

const SVG_NS = 'http://www.w3.org/2000/svg';
export const LOCK_CLASS = 'hkl-lock';
export const LOCK_SELECTOR = 'g.' + LOCK_CLASS;
const LOCK_FILL = '#3b82f6';
/** Gap right of the final barline, in staff spaces. */
const LOCK_GAP_SP = 0.4;
/** Glyph height (shackle + body), in staff spaces. */
const LOCK_H_SP = 1.6;

interface StaffTop { x: number; y: number; space: number }

/** Right end of the top staff line of `sys`'s last measure, in `margin`'s
 *  coordinate space, plus the staff space. Read from the staff-line paths
 *  (`M x1 y L x2 y`, the same shape linebreaks.ts measures widths from) and
 *  mapped through the CTMs, so the composer's placement translate on the
 *  system and any snap on the staff row are both honoured. Null when the
 *  shape is not what we expect — the mark is then simply not drawn. */
function staffTopRight(sys: Element, margin: SVGGraphicsElement): StaffTop | null {
  const measures = sys.querySelectorAll('g.measure');
  const last = measures[measures.length - 1];
  const staff = last?.querySelector('g.staff');
  if (!staff) return null;
  const lines: Array<{ x2: number; y: number; el: SVGGraphicsElement }> = [];
  for (const p of Array.from(staff.children)) {
    if (p.localName !== 'path') continue;
    const m = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(p.getAttribute('d') ?? '');
    if (!m) continue;
    const y1 = Number(m[2]), y2 = Number(m[4]);
    if (Math.abs(y1 - y2) > 1e-6) continue;
    lines.push({ x2: Number(m[3]), y: y1, el: p as SVGGraphicsElement });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.y - b.y);
  const top = lines[0];
  const space = lines.length > 1 && lines[1].y - lines[0].y > 0 ? lines[1].y - lines[0].y : 160;
  const from = top.el.getCTM?.(), to = margin.getCTM?.();
  if (from && to) {
    const pt = new DOMPoint(top.x2, top.y).matrixTransform(to.inverse().multiply(from));
    return { x: pt.x, y: pt.y, space };
  }
  return { x: top.x2, y: top.y, space };
}

function makeLock(doc: Document, at: StaffTop, lockId: string, systemId: string): Element {
  const s = at.space;
  const h = LOCK_H_SP * s;
  const bodyW = h * 0.62, bodyH = h * 0.5;
  const r = bodyW * 0.3;
  const x0 = at.x + LOCK_GAP_SP * s;
  const bodyY = at.y - bodyH / 2 + h * 0.1;
  const g = doc.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', LOCK_CLASS);
  g.setAttribute('data-for', lockId);
  g.setAttribute('data-system', systemId);
  g.setAttribute('style', 'cursor:pointer');
  g.setAttribute('pointer-events', 'all');
  const title = doc.createElementNS(SVG_NS, 'title');
  title.textContent = 'Manual line break — click to unlock';
  g.appendChild(title);
  /* Invisible hit pad: the glyph is small, the click target need not be. */
  const pad = doc.createElementNS(SVG_NS, 'rect');
  pad.setAttribute('x', String(x0 - s * 0.3)); pad.setAttribute('y', String(at.y - h * 0.75));
  pad.setAttribute('width', String(bodyW + s * 0.6)); pad.setAttribute('height', String(h * 1.5));
  pad.setAttribute('fill', 'transparent');
  g.appendChild(pad);
  const body = doc.createElementNS(SVG_NS, 'rect');
  body.setAttribute('x', String(x0)); body.setAttribute('y', String(bodyY));
  body.setAttribute('width', String(bodyW)); body.setAttribute('height', String(bodyH));
  body.setAttribute('rx', String(bodyW * 0.12));
  body.setAttribute('fill', LOCK_FILL); body.setAttribute('fill-opacity', '0.85');
  g.appendChild(body);
  const cx = x0 + bodyW / 2;
  const shackle = doc.createElementNS(SVG_NS, 'path');
  shackle.setAttribute('d', `M ${cx - r} ${bodyY} v ${-r * 0.6} a ${r} ${r} 0 0 1 ${2 * r} 0 v ${r * 0.6}`);
  shackle.setAttribute('fill', 'none');
  shackle.setAttribute('stroke', LOCK_FILL); shackle.setAttribute('stroke-opacity', '0.85');
  shackle.setAttribute('stroke-width', String(Math.max(6, s * 0.11)));
  g.appendChild(shackle);
  return g;
}

/** Redraw the padlocks of one mounted page. `lockIds` are the locked
 *  measures' ids; `nextStartOf(startId)` names the line start after the
 *  system beginning at `startId` when it is not on this page (the owner's
 *  partition, or the next page's first system). Returns the count drawn. */
export function refreshLockMarks(
  pageEl: Element, lockIds: ReadonlySet<string>, nextStartOf: (startId: string) => string | null,
): number {
  const margin = pageEl.querySelector('svg g.page-margin') as SVGGraphicsElement | null;
  if (!margin) return 0;
  for (const g of Array.from(margin.querySelectorAll(':scope > ' + LOCK_SELECTOR))) g.remove();
  if (!lockIds.size) return 0;
  const systems = Array.from(margin.children).filter((c) => c.classList.contains('system'));
  let drawn = 0;
  for (let i = 0; i < systems.length; i++) {
    const startId = systems[i].querySelector('g.measure')?.id ?? '';
    if (!startId) continue;
    const nextId = i + 1 < systems.length
      ? (systems[i + 1].querySelector('g.measure')?.id ?? null)
      : nextStartOf(startId);
    if (!nextId || !lockIds.has(nextId)) continue;
    const at = staffTopRight(systems[i], margin);
    if (!at) continue;
    margin.appendChild(makeLock(margin.ownerDocument, at, nextId, startId));
    drawn++;
  }
  return drawn;
}
