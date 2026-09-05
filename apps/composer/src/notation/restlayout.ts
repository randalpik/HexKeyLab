// Render-clone rest placement (2026-09-04).
//
// Verovio positions a rest in a two-layer staff against whatever the OTHER
// layer has at the same moment: two identical rests are pushed apart (voice 1
// above the staff, voice 2 below it), and a hidden rest (`@visible="false"`,
// which Verovio does not honor — see lessons.md) displaces the visible one
// exactly as a drawn rest would. Both are wrong on paper: two identical rests
// at one moment are ONE rest, and an invisible rest must have no effect on
// anything visible (backlog, Opinionation).
//
// Verovio DOES honor `@loc` on <rest> and <mRest>, and two rests forced to the
// same @loc at the same moment render at the same x with no collision shift
// (probed 2026-09-04: identical x, identical centre) — the pair draws as a
// single glyph. So this pass keeps the DOM shape — every rest keeps its
// element and xml:id, so the cursor, click hit-testing and the selection
// overlay work unchanged — and only pins @loc:
//   • a visible rest whose span meets nothing visible in the other layer
//     (hidden rests, <space>, <mSpace>, or no content at all) gets its
//     single-layer location;
//   • a visible rest whose span meets exactly one identical visible rest
//     (same onset, same element, same written value) gets that location too,
//     so the pair coincides (the partner is pinned when its layer is walked).
// Anything else — a note, a chord, a tuplet, a different rest in the other
// layer — is left to Verovio's collision logic: a rest pinned to the centre
// against a note at the same moment collides with it (probed).
//
// Only rests DIRECTLY under a <layer> are touched: a rest inside a <tuplet> is
// that tuplet's bracket carrier (see the placeholder decision) and a rest in a
// <beam> cannot occur (rests split beam runs). Runs on the render clone after
// regroupBeams; never on the saved document.

import { realTicks } from '../model/ticks.js';

type Kind = 'rest' | 'void' | 'solid';

interface Span {
  el: Element;
  kind: Kind;
  t0: number;
  t1: number;
}

/** Single-layer resting place of a rest glyph, in Verovio's staff-line
 *  locations (0 = bottom line, 4 = middle line, 8 = top line). A whole rest
 *  hangs from the fourth line (loc 6); every other value centres on the
 *  middle line (loc 4, the glyph's own offset does the rest). Probed against
 *  Verovio 6.3's single-layer output (quarter, half, whole, dotted eighth,
 *  mRest). */
function singleLayerLoc(el: Element): string {
  if (el.localName === 'mRest') return '6';
  const dur = el.getAttribute('dur');
  return dur === '1' || dur === 'breve' || dur === 'long' ? '6' : '4';
}

/** Time spans of a layer's direct children, in the layer's own tick line. An
 *  <mRest>/<mSpace> spans the whole measure (they carry no @dur; realTicks
 *  would fall back to a quarter). */
function layerSpans(layer: Element): Span[] {
  const out: Span[] = [];
  let t = 0;
  for (const c of Array.from(layer.children)) {
    const ln = c.localName;
    if (ln === 'mRest' || ln === 'mSpace') {
      out.push({ el: c, kind: ln === 'mRest' && c.getAttribute('visible') !== 'false' ? 'rest' : 'void', t0: 0, t1: Infinity });
      continue;
    }
    let kind: Kind | null = null;
    if (ln === 'rest') kind = c.getAttribute('visible') === 'false' ? 'void' : 'rest';
    else if (ln === 'space') kind = 'void';
    else if (ln === 'note' || ln === 'chord' || ln === 'tuplet' || ln === 'beam' || ln === 'fTrem' || ln === 'bTrem') kind = 'solid';
    if (kind === null) continue;           // clef, keySig, meterSig, … — no time
    const d = realTicks(c);
    out.push({ el: c, kind, t0: t, t1: t + d });
    t += d;
  }
  return out;
}

const sameWrittenValue = (a: Element, b: Element): boolean =>
  a.localName === b.localName
  && (a.getAttribute('dur') ?? '') === (b.getAttribute('dur') ?? '')
  && (a.getAttribute('dots') ?? '0') === (b.getAttribute('dots') ?? '0');

/** Pin `@loc` on the rests of every two-layer staff per the rules above.
 *  Idempotent; leaves an explicit `@loc` alone. */
export function settleRestLocations(doc: Document): void {
  for (const staff of Array.from(doc.querySelectorAll('staff'))) {
    const layers = Array.from(staff.children).filter((c) => c.localName === 'layer');
    if (layers.length !== 2) continue;
    const spans = [layerSpans(layers[0]), layerSpans(layers[1])];
    for (let li = 0; li < 2; li++) {
      const others = spans[1 - li];
      for (const s of spans[li]) {
        if (s.kind !== 'rest' || s.el.hasAttribute('loc')) continue;
        const meets = others.filter((o) => o.t0 < s.t1 && o.t1 > s.t0);
        if (meets.some((o) => o.kind === 'solid')) continue;
        const rests = meets.filter((o) => o.kind === 'rest');
        const alone = rests.length === 0;
        const twin = rests.length === 1 && meets.length === 1
          && Math.abs(rests[0].t0 - s.t0) < 1e-6 && sameWrittenValue(rests[0].el, s.el);
        if (alone || twin) s.el.setAttribute('loc', singleLayerLoc(s.el));
      }
    }
  }
}
