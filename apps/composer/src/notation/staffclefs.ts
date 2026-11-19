// A clef belongs to its STAFF (2026-11-18, decisions.md).
//
// An inline `<clef>` is a layer child — that is the only place MEI and
// Verovio let a mid-measure clef live — but the layer is only its SEAT, the
// structure it sits on. What it means is staff-wide: from its moment to the
// next clef it governs every event of every voice on the staff. This module
// is the one place that reading lives:
//
//   • `layerTimeline` — a layer's events and clefs with EXACT onsets (a
//     tuplet's thirds do not survive floating point, and "the same moment in
//     the other voice" is an equality);
//   • `staffClefs` — the clefs of one measure's `<staff>` in time order;
//   • `projectStaffClefs` — the render clone's side of it. Verovio's clefs are
//     per layer (lessons.md, 2026-11-18: an inline clef sets ITS layer for the
//     rest of the measure, and from the next measure every layer starts in
//     the measure's last clef in document order), so every other layer gets a
//     CARRIER — `<clef sameas="#seat">` — before its first event at or after
//     the moment. A `sameas` clef draws no glyph and takes no space, puts that
//     layer's notes in the clef, works inside a `<tuplet>` and a `<beam>`, and
//     leaves the next system's leading clef alone (`visible="false"` hides it
//     when it is the measure's last clef). Carriers exist on the render clone
//     only: never in the model, never in a saved file.
//   • `stripClefCarriers` — a carrier still comes out of Verovio as an empty
//     `<g class="clef">` at the SVG's origin; the DOM passes that measure
//     clef boxes (leading-signature region, layout obstacles) must never see
//     one, so the renderer's toolkits drop them from every SVG they return.
//
// Imports only model/ticks.ts (notation/beams.ts imports this module, and the
// model imports beams).

import { realTicksExact, fracAdd, fracCmp, FRAC_ZERO, type Frac } from '../model/ticks.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Marks a carrier's xml:id: `<seat id>-hklsa<layer n>-<k>`. */
const CARRIER_MARK = '-hklsa';

/** A render-clone carrier (see the module comment), as opposed to a clef the
 *  document holds. */
export const isClefCarrier = (el: Element): boolean => el.localName === 'clef' && el.hasAttribute('sameas');

const TIMED = new Set(['note', 'chord', 'rest', 'space', 'fTrem', 'bTrem']);

export interface TimelineItem {
  el: Element;
  /** Onset (an event) or position (a clef), in the layer's own tick line. */
  at: Frac;
  kind: 'event' | 'clef' | 'carrier';
}

/** A layer's timed events (notes, chords, rests, spaces, tremolos — tuplet
 *  members and beamed notes included, each at its exact onset) and its
 *  clefs, in document order. A grace sits at its main note's onset. */
export function layerTimeline(layer: Element): { items: TimelineItem[]; end: Frac } {
  const items: TimelineItem[] = [];
  let t = FRAC_ZERO;
  const walk = (parent: Element): void => {
    for (const c of Array.from(parent.children)) {
      const ln = c.localName;
      if (ln === 'tuplet' || ln === 'beam') { walk(c); continue; }
      if (ln === 'clef') { items.push({ el: c, at: t, kind: isClefCarrier(c) ? 'carrier' : 'clef' }); continue; }
      if (!TIMED.has(ln)) continue;
      items.push({ el: c, at: t, kind: 'event' });
      t = fracAdd(t, realTicksExact(c));
    }
  };
  walk(layer);
  return { items, end: t };
}

export interface StaffClef {
  el: Element;
  /** The layer the clef sits in — its seat, nothing more. */
  layer: Element;
  /** The moment it takes effect: its position in its seat's tick line. */
  at: Frac;
}

const layersOf = (staff: Element): Element[] =>
  Array.from(staff.children).filter((c) => c.localName === 'layer');

/** The clefs of one measure's `<staff>`, in time order — document order among
 *  clefs of one moment, so the later one is the one in force after it.
 *  Carriers are not clefs. */
export function staffClefs(staff: Element): StaffClef[] {
  const out: StaffClef[] = [];
  for (const layer of layersOf(staff)) {
    if (!layer.querySelector('clef')) continue;
    for (const it of layerTimeline(layer).items) if (it.kind === 'clef') out.push({ el: it.el, layer, at: it.at });
  }
  return out.sort((a, b) => fracCmp(a.at, b.at));   // stable: document order within a moment
}

/** The clef a staff is left in at the end of a measure, or null when the
 *  measure holds none. */
export function lastStaffClef(staff: Element): Element | null {
  if (!staff.querySelector('clef')) return null;
  const clefs = staffClefs(staff);
  return clefs.length ? clefs[clefs.length - 1].el : null;
}

/** The moments at which a clef seated in ANOTHER layer of the staff takes
 *  effect — where this layer's beams break by default (notation/beams.ts). */
export function otherLayerClefMoments(layer: Element): Frac[] {
  const staff = layer.parentElement;
  if (!staff || !staff.querySelector('clef')) return [];
  return staffClefs(staff).filter((c) => c.layer !== layer).map((c) => c.at);
}

const specKey = (el: Element): string =>
  [el.getAttribute('shape'), el.getAttribute('line'), el.getAttribute('dis'), el.getAttribute('dis.place')].map((v) => v ?? '').join('|');

const xmlId = (el: Element): string | null => el.getAttribute('xml:id');

/** Put a carrier in front of an event. An event that opens a `<beam>` or a
 *  `<tuplet>` takes it in front of the wrapper: the clef is in force before
 *  the group starts. */
function insertBeforeEvent(carrier: Element, event: Element): void {
  let target = event;
  for (let p = target.parentElement; p && (p.localName === 'beam' || p.localName === 'tuplet') && target.previousElementSibling === null; p = target.parentElement) target = p;
  target.parentNode!.insertBefore(carrier, target);
}

/** Give every layer of every staff the clefs the staff is in (see the module
 *  comment). Runs on the render clone after `relocateInitialClefs` and
 *  `regroupBeams`, before the render conventions (whose passes then read each
 *  layer's clefs as Verovio does — notation/staffpos.ts). Idempotent: a layer
 *  already in the staff's clef gets nothing. */
export function projectStaffClefs(doc: Document): void {
  /* The clef each staff is in on entering the next measure. */
  const running = new Map<string, string | null>();
  for (const node of Array.from(doc.querySelectorAll('staffDef, measure'))) {
    if (node.localName === 'staffDef') {
      const shape = node.getAttribute('clef.shape');
      if (shape) {
        running.set(node.getAttribute('n') ?? '1',
          [shape, node.getAttribute('clef.line'), node.getAttribute('clef.dis'), node.getAttribute('clef.dis.place')].map((v) => v ?? '').join('|'));
      }
      continue;
    }
    for (const staff of Array.from(node.children)) {
      if (staff.localName !== 'staff' || !staff.querySelector('clef')) continue;
      const clefs = staffClefs(staff);
      if (!clefs.length) continue;
      const sn = staff.getAttribute('n') ?? '1';
      const layers = layersOf(staff);
      if (layers.length > 1) carry(doc, node, staff, layers, clefs, running.get(sn) ?? null);
      running.set(sn, specKey(clefs[clefs.length - 1].el));
    }
  }
}

function carry(doc: Document, measure: Element, staff: Element, layers: Element[], clefs: StaffClef[], entry: string | null): void {
  const made = new Map<Element, number>();
  const carrierOf = (src: StaffClef, layer: Element): Element => {
    let id = xmlId(src.el);
    if (!id) {
      /* A clef without an id (none is written that way today): name it by its
         place, so a range render and a full render agree. */
      id = 'clf-' + (xmlId(measure) ?? 'm') + '-' + (staff.getAttribute('n') ?? '1') + '-' + clefs.indexOf(src);
      src.el.setAttributeNS(XML_NS, 'xml:id', id);
    }
    const k = made.get(src.el) ?? 0;
    made.set(src.el, k + 1);
    const c = doc.createElementNS(MEI_NS, 'clef');
    c.setAttributeNS(XML_NS, 'xml:id', id + CARRIER_MARK + (layer.getAttribute('n') ?? '1') + '-' + k);
    for (const a of ['shape', 'line', 'dis', 'dis.place']) {
      const v = src.el.getAttribute(a);
      if (v !== null) c.setAttribute(a, v);
    }
    c.setAttribute('sameas', '#' + id);
    return c;
  };

  /* A LEADING clef — the first child of its layer: measure 1's, or a
     movement's own (every other measure-initial clef was moved before the
     barline) — is carried at the HEAD of the other layers, not at their first
     event: `applySectionRestarts` lifts every layer-initial clef of a
     movement's first measure into the boundary scoreDef together, and a
     carrier left behind in mid-layer would point at a clef that is gone. */
  const leading = clefs.find((c) => c.layer.firstElementChild === c.el) ?? null;
  if (leading) {
    for (const layer of layers) {
      const first = layer.firstElementChild;
      if (first && first.localName === 'clef') continue;
      /* Only a layer with something to draw: an empty voice needs no clef. */
      if (!layerTimeline(layer).items.some((it) => it.kind === 'event' && it.el.localName !== 'space')) continue;
      if (entry !== null && specKey(leading.el) === entry) continue;
      layer.insertBefore(carrierOf(leading, layer), first);
    }
  }

  for (const layer of layers) {
    const { items } = layerTimeline(layer);
    const seen = new Set<Element>();
    let cur = entry;
    for (const it of items) {
      if (it.kind !== 'event') { cur = specKey(it.el); if (it.kind === 'clef') seen.add(it.el); continue; }
      if (it.el.localName === 'space') continue;          // nothing to draw, nothing to align
      /* The clef in force here: the last, in time, of this layer's own clefs
         already passed and the other layers' clefs at or before this onset. */
      let g: StaffClef | null = null;
      for (const c of clefs) {
        if (c.layer === layer ? seen.has(c.el) : fracCmp(c.at, it.at) <= 0) g = c;
      }
      if (!g || g.layer === layer) continue;
      const key = specKey(g.el);
      if (key === cur) continue;
      insertBeforeEvent(carrierOf(g, layer), it.el);
      cur = key;
    }
  }

  /* Across the barline Verovio starts every layer in the measure's last clef
     in DOCUMENT order. Make that the staff's last clef in time. */
  const all = Array.from(staff.querySelectorAll('clef'));
  const docLast = all[all.length - 1];
  const timeLast = clefs[clefs.length - 1];
  if (docLast && specKey(docLast) !== specKey(timeLast.el)) {
    const layer = docLast.closest('layer');
    if (layer) layer.appendChild(carrierOf(timeLast, layer));
  }
}

/** Make a Verovio toolkit drop the carriers from every SVG it returns. The
 *  renderer wraps each toolkit it creates, so no render path can hand a DOM
 *  pass a carrier node. */
export function dropClefCarriers<T extends { renderToSVG(pageNo: number, options?: object): string }>(tk: T): T {
  const render = tk.renderToSVG.bind(tk);
  tk.renderToSVG = (pageNo: number, options?: object): string => stripClefCarriers(render(pageNo, options));
  return tk;
}

const CARRIER_SVG = new RegExp('<g\\b[^>]*\\bid="[^"]*' + CARRIER_MARK + '[^"]*"[^>]*/>\\s*', 'g');

/** Drop the carriers' empty `<g class="clef">` nodes from an SVG Verovio
 *  returned (see the module comment). Free when the page holds none. */
export function stripClefCarriers(svg: string): string {
  return svg.indexOf(CARRIER_MARK) < 0 ? svg : svg.replace(CARRIER_SVG, '');
}
