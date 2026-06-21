// Chunk renderer — the core of the virtualized horizontal-ribbon renderer.
//
// Validated by the Phase-1 spike (see docs/decisions.md "Virtualized ribbon
// renderer"): an interior run of measures, rendered as a standalone sub-MEI
// with `breaks:'none'` (natural, unjustified spacing), is *width-identical* to
// the same measures inside the full ribbon. We exploit that to render the score
// a window at a time instead of all at once.
//
// Mechanism per chunk [dispLo..dispHi]:
//   1. Build a sub-MEI of [dispLo-K .. dispHi+K] (K = overlap) whose scoreDef
//      carries the RUNNING clef/key/meter as of dispLo (an interior chunk after
//      a mid-piece key/clef change can't use the head scoreDef).
//   2. Render with `breaks:'none'` + pinned vertical options (content-INDEPENDENT
//      staff-Y, so every chunk aligns vertically — see the spike).
//   3. Keep the whole <svg> (its <defs> glyph symbols are needed; extracting
//      bare <g>s renders blank), positioned in a wrapper clipped to the
//      [dispLo..dispHi] x-range. The overlap measures (incl. the system-initial
//      clef/key drawn on the first rendered measure) and the trailing overlap
//      fall outside the clip. Boundary spanners are drawn fully in both adjacent
//      chunks and clipped at the shared seam, so the halves meet seamlessly.

import type { VerovioToolkit } from '@hkl/notation/verovio-types.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';

export interface ChunkResult {
  /** Wrapper element (position:absolute, overflow:hidden) holding the chunk's
   *  svg, clipped to the display measures. Caller sets its `left`. */
  node: HTMLElement;
  /** Total rendered width of the display measures (px). */
  dispWidth: number;
  /** Per-display-measure width (px), keyed by xml:id, in order. */
  measuredWidths: Array<{ id: string; width: number }>;
  /** Y of the first staff line within the chunk svg (px) — for vertical align. */
  staffTop: number;
}

/** Compute the running clef-per-staff + key/meter state at measure index
 *  `target` by walking the section's scoreDef/measure nodes in document order.
 *  Returns the attribute overrides to stamp onto the chunk's head scoreDef. */
interface RunningCtx {
  keySig: string | null;
  mode: string | null;
  meterCount: string | null;
  meterUnit: string | null;
  meterSym: string | null;
  /** staff @n → { shape, line, dis, disPlace } from the latest inline <clef>. */
  clefByStaff: Map<string, { shape: string; line: string; dis: string | null; disPlace: string | null }>;
}

function computeRunningCtx(section: Element, measures: Element[], target: number): RunningCtx {
  const ctx: RunningCtx = {
    keySig: null, mode: null, meterCount: null, meterUnit: null, meterSym: null,
    clefByStaff: new Map(),
  };
  const targetEl = measures[target];
  for (const node of Array.from(section.children)) {
    if (node === targetEl) break;
    if (node.localName === 'scoreDef') {
      const ks = node.getAttribute('key.sig'); if (ks !== null) ctx.keySig = ks;
      const md = node.getAttribute('mode'); if (md !== null) ctx.mode = md;
      const mc = node.getAttribute('meter.count'); if (mc !== null) ctx.meterCount = mc;
      const mu = node.getAttribute('meter.unit'); if (mu !== null) ctx.meterUnit = mu;
      const ms = node.getAttribute('meter.sym'); if (mc !== null || mu !== null) ctx.meterSym = ms;
    } else if (node.localName === 'measure') {
      for (const staff of Array.from(node.querySelectorAll('staff'))) {
        const sn = staff.getAttribute('n') ?? '1';
        const clefs = staff.querySelectorAll('layer > clef');
        const c = clefs[clefs.length - 1] as Element | undefined;
        if (c) ctx.clefByStaff.set(sn, {
          shape: c.getAttribute('shape') ?? 'G', line: c.getAttribute('line') ?? '2',
          dis: c.getAttribute('dis'), disPlace: c.getAttribute('dis.place'),
        });
      }
    }
  }
  return ctx;
}

/** Build a sub-MEI document string for measures [lo..hi] with the head scoreDef
 *  stamped with the running context at `lo`. `fullDoc` is the parsed live MEI;
 *  `measures` are its in-order <measure> elements (children of <section>). */
function buildChunkMei(fullDoc: Document, measures: Element[], lo: number, hi: number): string {
  const sub = fullDoc.cloneNode(true) as Document;
  const subSection = sub.querySelector('section')!;
  const subMeasures = Array.from(subSection.children).filter((c) => c.localName === 'measure');
  // Drop everything in the section except measures [lo..hi]; also drop in-section
  // scoreDef/sb siblings (running context is folded into the head scoreDef).
  let mi = 0;
  for (const node of Array.from(subSection.children)) {
    if (node.localName === 'measure') {
      if (mi < lo || mi > hi) node.remove();
      mi++;
    } else {
      node.remove();
    }
  }
  // Stamp the head scoreDef with the running context (computed from the ORIGINAL doc).
  const section = fullDoc.querySelector('section')!;
  const ctx = computeRunningCtx(section, measures, lo);
  const headSd = sub.querySelector('scoreDef');
  if (headSd) {
    if (ctx.keySig !== null) headSd.setAttribute('key.sig', ctx.keySig);
    if (ctx.mode !== null) headSd.setAttribute('mode', ctx.mode);
    if (ctx.meterCount !== null) headSd.setAttribute('meter.count', ctx.meterCount);
    if (ctx.meterUnit !== null) headSd.setAttribute('meter.unit', ctx.meterUnit);
    if (ctx.meterSym) headSd.setAttribute('meter.sym', ctx.meterSym); else headSd.removeAttribute('meter.sym');
    for (const sd of Array.from(headSd.querySelectorAll('staffDef'))) {
      const sn = sd.getAttribute('n') ?? '1';
      const c = ctx.clefByStaff.get(sn);
      if (c) {
        sd.setAttribute('clef.shape', c.shape); sd.setAttribute('clef.line', c.line);
        if (c.dis) { sd.setAttribute('clef.dis', c.dis); if (c.disPlace) sd.setAttribute('clef.dis.place', c.disPlace); }
        else { sd.removeAttribute('clef.dis'); sd.removeAttribute('clef.dis.place'); }
      }
    }
  }
  void subMeasures;
  return new XMLSerializer().serializeToString(sub);
}

export interface RenderChunkOpts {
  tk: VerovioToolkit;
  fullDoc: Document;
  measures: Element[];        // in-order <measure> elements of the live doc
  measureIds: string[];       // their xml:ids (same order)
  dispLo: number;
  dispHi: number;
  overlap: number;            // K — measures of context on each side
  options: object;            // verovio options (breaks:'none' + pinned vertical + crisp preset)
  /** Common staff-line Y (px) every chunk is translated to. */
  targetStaffY: number;
  /** Visible band height (px) for the clip wrapper. */
  bandHeight: number;
  ownerDocument: Document;    // document to create the wrapper element in
}

/** Render one chunk and return a positioned, clipped wrapper. The caller sets
 *  `node.style.left` to the chunk's ribbon-x. */
export function renderChunk(o: RenderChunkOpts): ChunkResult {
  const lo = Math.max(0, o.dispLo - o.overlap);
  const hi = Math.min(o.measures.length - 1, o.dispHi + o.overlap);
  const mei = buildChunkMei(o.fullDoc, o.measures, lo, hi);

  o.tk.setOptions(o.options);
  o.tk.loadData(mei);
  const svgStr = o.tk.renderToSVG(1, {});

  // Mount offscreen to measure, then move the live svg into the clip wrapper.
  const host = o.ownerDocument.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0';
  host.innerHTML = svgStr;
  o.ownerDocument.body.appendChild(host);
  const hostRect = host.getBoundingClientRect();
  const hl = hostRect.left, ht = hostRect.top;

  const gLo = host.querySelector('#' + CSS.escape(o.measureIds[o.dispLo]));
  const gHi = host.querySelector('#' + CSS.escape(o.measureIds[o.dispHi]));
  if (!gLo || !gHi) { host.remove(); throw new Error('chunk: display measures not found in render'); }
  const sline = gLo.closest('g.system')!.querySelector('g.staff path')!;
  const dispLeft = gLo.getBoundingClientRect().left - hl;
  const dispRight = gHi.getBoundingClientRect().right - hl;
  const staffTop = sline.getBoundingClientRect().top - ht;

  const measuredWidths: Array<{ id: string; width: number }> = [];
  for (let i = o.dispLo; i <= o.dispHi; i++) {
    const g = host.querySelector('#' + CSS.escape(o.measureIds[i]));
    measuredWidths.push({ id: o.measureIds[i], width: g ? g.getBoundingClientRect().width : 0 });
  }

  const svg = host.querySelector('svg') as SVGSVGElement;
  const wrap = o.ownerDocument.createElement('div');
  wrap.className = 'hkl-chunk';
  wrap.style.cssText = `position:absolute;top:0;height:${o.bandHeight}px;overflow:hidden;width:${(dispRight - dispLeft).toFixed(2)}px`;
  svg.style.position = 'absolute';
  svg.style.left = (-dispLeft).toFixed(2) + 'px';
  svg.style.top = (o.targetStaffY - staffTop).toFixed(2) + 'px';
  wrap.appendChild(svg);   // moves the live svg (defs included) out of host
  host.remove();

  return { node: wrap, dispWidth: dispRight - dispLeft, measuredWidths, staffTop };
}
