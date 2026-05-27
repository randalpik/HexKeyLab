// Note-attached slur control events. Unlike dynamics/hairpins (tstamp-anchored,
// in expressions.ts), a slur binds to specific notes via @startid/@endid — its
// identity IS its two endpoint slots, so it must move/disappear with them.
// See architecture.md §7.20.
//
// Endpoints are SLOT elements: a bare <note> (single pitch) or a <chord>
// (multi-pitch). Both carry an xml:id. Verovio renders <slur startid endid>
// natively as an arc; no SVG injection. The element is appended as the last
// child of the start note's <measure>, after <staff> — same placement
// convention as <hairpin>/<dynam>. A data-voice attribute (1..4) records which
// Composer voice the slur belongs to so membership tests don't have to
// re-derive it from staff/layer ancestry.

const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

let nextSeq = 2_000_000;
function newId(prefix: string): string {
  nextSeq++;
  return prefix + '-' + nextSeq.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

export interface SlurRecord {
  el: Element;
  startId: string;
  endId: string;
  voice: number;
}

function stripHash(v: string | null): string | null {
  if (!v) return null;
  return v.charAt(0) === '#' ? v.slice(1) : v;
}

/** Find a slot element (note or chord) by xml:id. `Document.getElementById`
 *  doesn't see `xml:id` in an XML-parsed document, so query by attribute. */
function slotById(doc: Document, id: string): Element | null {
  for (const n of Array.from(doc.querySelectorAll('note, chord'))) {
    if (n.getAttribute('xml:id') === id) return n;
  }
  return null;
}

/** Create a <slur> from one slot to another, appended to the start slot's
 *  measure. Caller orders endpoints (start should precede end). Returns the
 *  element, or null if the start slot can't be located. */
export function addSlur(doc: Document, startId: string, endId: string, voice: number): Element | null {
  const start = slotById(doc, startId);
  if (!start) return null;
  const measure = start.closest('measure');
  if (!measure) return null;
  const el = doc.createElementNS(MEI_NS, 'slur');
  el.setAttributeNS(XML_NS, 'xml:id', newId('s'));
  el.setAttribute('startid', '#' + startId);
  el.setAttribute('endid', '#' + endId);
  el.setAttribute('data-voice', String(voice));
  measure.appendChild(el);
  return el;
}

export function removeSlur(el: Element): void {
  el.parentNode?.removeChild(el);
}

export function collectSlurs(doc: Document): SlurRecord[] {
  const out: SlurRecord[] = [];
  for (const el of Array.from(doc.querySelectorAll('slur'))) {
    const startId = stripHash(el.getAttribute('startid'));
    const endId = stripHash(el.getAttribute('endid'));
    if (!startId || !endId) continue;
    const v = parseInt(el.getAttribute('data-voice') ?? '0', 10);
    out.push({ el, startId, endId, voice: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

/** Remove any <slur> whose startid or endid no longer resolves to a slot
 *  element (e.g. an endpoint note was deleted). Returns the count removed.
 *  Call from note-removal paths alongside tie-orphan cleanup. */
export function pruneDanglingSlurs(doc: Document): number {
  let removed = 0;
  for (const el of Array.from(doc.querySelectorAll('slur'))) {
    const s = stripHash(el.getAttribute('startid'));
    const e = stripHash(el.getAttribute('endid'));
    if (!s || !e || !slotById(doc, s) || !slotById(doc, e)) {
      el.parentNode?.removeChild(el);
      removed++;
    }
  }
  return removed;
}
