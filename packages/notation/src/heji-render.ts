// Render-time HEJI + arbitrary-stack accidental rendering. Shared between HKL
// Composer's score renderer and HKL's live-chord staff inset.
//
// Verovio can't render the Extended Helmholtz-Ellis glyphs (no usable
// glyph.num path in 6.x) and collapses repeated same-token <accid> children
// onto one slot, so it can't stack accidentals past ±3 either. This module
// works around both with a two-step transform, applied ONLY on the render path
// (never to the saved/.hkc doc — (q, r) stays the source of truth):
//
//   1. transformDocForHeji(doc, mode, hejiEnabled): for each note whose label
//      needs more than Verovio can draw natively (any syntonic arrow, any
//      septimal hook, or |alter| > 3), replace its single @accid with a row of
//      DISTINCT placeholder <accid> children. Distinct tokens force Verovio to
//      reserve a real horizontal slot per glyph (same-token siblings collapse);
//      each is tagged with the target SMuFL codepoint + family.
//   2. injectHejiGlyphs(root): after renderToSVG, replace each tagged
//      placeholder's <use> with an inline BravuraText <text> at the true
//      codepoint, laid out by the same bare-advance slot rule HKL uses on the
//      lattice (drawHejiLabel), snug to the notehead.
//
// Notes whose label is a single standard accidental with |alter| ≤ 3 and no
// commas are left untouched — Verovio draws them natively (and with the global
// font:'Bravura' option they match the injected glyphs).

import { hejiChain, hejiCommasFor, type HejiGlyphFamily } from '@hkl/shared/heji.js';
import type { TuningMode } from '@hkl/shared/freq.js';
import { noteAlter } from './accidentals.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/* Bare-accidental advance per family, in font design units (≈ at em=1000),
 * used to size placeholder reservation and to compute the layout slot (the
 * arrow/hook overhangs past the bare advance without affecting layout — same
 * rule as HKL's drawHejiLabel). Septimal hooks have no bare form; the hook's
 * own advance is used (measured at inject time). Values are rough; placeholder
 * choice only needs to over-reserve, and inject repositions exactly. */
const BARE_ADVANCE: Record<HejiGlyphFamily, number> = {
  natural: 11, sharp: 14, flat: 14, doubleSharp: 19, doubleFlat: 28, septimal: 16,
};

const BARE_CODE: Record<HejiGlyphFamily, number | null> = {
  natural: 0xE261, sharp: 0xE262, flat: 0xE260,
  doubleSharp: 0xE263, doubleFlat: 0xE264, septimal: null,
};

/* Per-family vertical fine-tune for injected glyphs, fraction of font size,
 * positive = down (SVG y down). Ported from HKL's HEJI_FAMILY_Y_OFFSET; tuned
 * against Verovio's baseline. These are small corrections for BravuraText's
 * per-family asymmetry, applied on top of ACCID_BASELINE_CORRECTION. */
const FAMILY_Y_OFFSET: Record<HejiGlyphFamily, number> = {
  natural: 0, sharp: 0, doubleSharp: 0, flat: 0, doubleFlat: 0, septimal: 0,
};

/* A SMuFL accidental drawn as <text> sits with its baseline at the text y, but
 * Verovio's <use> ty anchors the glyph a fourth (1.5 staff spaces) higher than
 * that baseline. Every injected glyph must move down by 1.5 spaces to land on
 * the note's staff position. 1 em = 4 staff spaces, so the correction is
 * 1.5/4 = 0.375 of the font size (computed per-render from the read fontSize so
 * it tracks any scale). */
const ACCID_BASELINE_CORRECTION_SPACES = 1.5;
const baselineCorrection = (fontSize: number): number =>
  (ACCID_BASELINE_CORRECTION_SPACES / 4) * fontSize;

/* Distinct placeholder tokens, ascending by approximate rendered width (px at
 * scale 100). The allocator picks the narrowest unused token still ≥ the target
 * glyph's bare advance, so reservation is tight and every sibling is distinct
 * (same-token siblings collapse in Verovio). */
const TOKEN_POOL: ReadonlyArray<{ tok: string; w: number }> = [
  { tok: '1qs', w: 8 }, { tok: 'n', w: 11 }, { tok: 's', w: 14 }, { tok: 'f', w: 14 },
  { tok: 'bs', w: 14 }, { tok: '1qf', w: 14 }, { tok: 'kms', w: 15 }, { tok: 'su', w: 16 },
  { tok: 'sd', w: 16 }, { tok: 'nu', w: 16 }, { tok: 'nd', w: 16 }, { tok: 'bms', w: 17 },
  { tok: 'x', w: 19 }, { tok: 'fu', w: 19 }, { tok: 'fd', w: 19 }, { tok: '3qs', w: 22 },
  { tok: 'ff', w: 28 }, { tok: '3qf', w: 30 }, { tok: 'ts', w: 34 }, { tok: 'tf', w: 42 },
];

/* Tag carried on each placeholder <accid> via @type. Verovio emits @type both
 * as data-type and as a CSS class on the rendered <g class="accid …">. Format:
 * hklg-<seq>-<family>-<hex> (seq = visual left-to-right index). */
function makeTag(seq: number, family: HejiGlyphFamily, codepoint: number): string {
  return `hklg-${seq}-${family}-${codepoint.toString(16)}`;
}
interface ParsedTag { seq: number; family: HejiGlyphFamily; codepoint: number; }
function parseTag(cls: string | null): ParsedTag | null {
  if (!cls) return null;
  for (const c of cls.split(/\s+/)) {
    if (!c.startsWith('hklg-')) continue;
    const parts = c.split('-');
    if (parts.length !== 4) continue;
    return { seq: parseInt(parts[1], 10), family: parts[2] as HejiGlyphFamily, codepoint: parseInt(parts[3], 16) };
  }
  return null;
}

/** Does this note need the placeholder/injection treatment (vs Verovio
 *  native)? Yes if it carries a comma (HEJI on) or its alteration exceeds the
 *  ±3 Verovio can render as a single token. */
function needsInjection(alter: number, syn5: number, sept7: number): boolean {
  return syn5 !== 0 || sept7 !== 0 || Math.abs(alter) > 3;
}

/** Step 1 — rewrite notes needing injection into tagged placeholder rows.
 *  Operates on the render clone AFTER the visible @accid has been set (so only
 *  notes with a visible @accid are touched). Idempotent. */
export function transformDocForHeji(doc: Document, mode: TuningMode, hejiEnabled: boolean): void {
  for (const note of Array.from(doc.querySelectorAll('note'))) {
    /* Visible accidental can live either as the @accid attribute OR as an
       <accid> child element (the latter is how paren-cautionary marks are
       encoded, via @enclose="paren" on the child). Check both forms. */
    const childAccid = Array.from(note.children).find((c) => c.localName === 'accid' && c.hasAttribute('accid')) as Element | undefined;
    if (!note.hasAttribute('accid') && !childAccid) continue;
    const alter = noteAlter(note);
    const qs = note.getAttribute('data-q');
    const rs = note.getAttribute('data-r');
    const hasCoord = qs !== null && rs !== null;
    const { syn5, sept7 } = (hejiEnabled && hasCoord)
      ? hejiCommasFor(mode, parseInt(qs!, 10), parseInt(rs!, 10))
      : { syn5: 0, sept7: 0 };
    if (!needsInjection(alter, syn5, sept7)) continue;

    const glyphs = hejiChain(alter, syn5, sept7); // visual left-to-right
    if (glyphs.length === 0) continue;

    /* Preserve any @enclose marker from the child accid form so the
       placeholders the chain renders into keep the paren spacing. */
    const enclose = childAccid?.getAttribute('enclose') ?? null;
    note.removeAttribute('accid');
    note.removeAttribute('accid.ges');
    if (childAccid) note.removeChild(childAccid);

    /* Allocate distinct placeholder tokens (narrowest unused ≥ target). */
    const used = new Set<string>();
    const pickToken = (need: number): string => {
      for (const { tok, w } of TOKEN_POOL) {
        if (used.has(tok)) continue;
        if (w >= need) { used.add(tok); return tok; }
      }
      /* pool exhausted / no wide-enough token: take the widest unused. */
      for (let i = TOKEN_POOL.length - 1; i >= 0; i--) {
        const { tok } = TOKEN_POOL[i];
        if (!used.has(tok)) { used.add(tok); return tok; }
      }
      return 'x';
    };

    /* MEI order is reversed from visual (MEI-first renders rightmost, nearest
       the notehead). Emit the chain reversed so visual left-to-right matches
       HKL: arrowed first glyph … septimal hook, ending at the notehead. */
    const created: Element[] = [];
    for (let vi = glyphs.length - 1; vi >= 0; vi--) {
      const g = glyphs[vi];
      const accid = doc.createElementNS(MEI_NS, 'accid');
      accid.setAttribute('accid', pickToken(BARE_ADVANCE[g.family]));
      accid.setAttribute('type', makeTag(vi, g.family, g.ch.codePointAt(0)!));
      note.appendChild(accid);
      created.push(accid);
    }
    /* If the original child accid carried @enclose="paren", set it on BOTH
       the leftmost-visual placeholder (= last appended = visually first;
       Verovio adds the left paren before it) AND the rightmost-visual one
       (= first appended; Verovio adds the right paren after it). Verovio
       reserves layout space on both sides, so the chain renders as
       "( …glyphs… )" without colliding with the notehead. The paren `<use>`
       elements emitted by Verovio are swapped to BravuraText in step 2. */
    if (enclose === 'paren' && created.length > 0) {
      created[0].setAttribute('enclose', 'paren');
      created[created.length - 1].setAttribute('enclose', 'paren');
    }
  }
}

/** Parse the SMuFL codepoint from a Verovio symbol href like "#E262-9k3". */
function hrefCodepoint(href: string | null): number | null {
  if (!href) return null;
  const m = /^#([0-9A-Fa-f]{4,6})/.exec(href.replace(/^#/, '#'));
  return m ? parseInt(m[1], 16) : null;
}

/** Step 2 — render every accidental in BravuraText (and ONLY accidentals; the
 *  rest of the score keeps Verovio's default Leipzig). Tagged HEJI/stack
 *  placeholders become the combined U+E2C0+ glyphs, laid out snug to the
 *  notehead; plain native accidentals are re-drawn in BravuraText at their own
 *  SMuFL codepoint and Verovio-assigned position. Requires BravuraText loaded
 *  (caller gates on document.fonts). Idempotent within a render. */
export function injectHejiGlyphs(root: ParentNode): void {
  /* Group tagged HEJI placeholders by note; collect plain accidentals.
     A single g.accid may contain MULTIPLE <use> elements when @enclose="paren"
     was on the source <accid> — Verovio emits paren_left + main_accid +
     paren_right as three siblings of g.accid. We must distinguish the
     PAREN uses (SMuFL U+E26A / U+E26B) from the main accidental glyph and
     route them separately:
       - The main accid use anchors the HEJI combination (or, untagged,
         becomes a plain BravuraText swap).
       - All paren uses across a single note's g.accid groups are collected
         and pruned to keep only the OUTERMOST left + OUTERMOST right; the
         inner ones (right paren of placeholder N, left paren of N+1) are
         removed so the chain reads "( …chain… )" instead of "(a)(b)". */
  const PAREN_LEFT_CP = 0xE26A;
  const PAREN_RIGHT_CP = 0xE26B;
  const isParenCp = (cp: number | null): boolean =>
    cp === PAREN_LEFT_CP || cp === PAREN_RIGHT_CP;
  const byNote = new Map<Element, Array<{ g: Element; tag: ParsedTag; use: Element }>>();
  const plain: Array<{ g: Element; use: Element }> = [];
  const parensByNote = new Map<Element, Array<{ use: Element; cp: number; x: number }>>();
  for (const g of Array.from(root.querySelectorAll('g.accid'))) {
    if (g.getAttribute('data-hkl-injected')) continue;
    const uses = Array.from(g.querySelectorAll('use'));
    if (uses.length === 0) continue;
    const note = g.closest('g.note') ?? g.parentElement!;
    /* Partition this g.accid's uses into paren vs main-accid. */
    const mainAccidUses: Element[] = [];
    for (const u of uses) {
      const cp = hrefCodepoint(u.getAttribute('xlink:href'));
      if (cp !== null && isParenCp(cp)) {
        const t = parseTransform(u.getAttribute('transform'));
        const list = parensByNote.get(note) ?? [];
        list.push({ use: u, cp, x: t?.tx ?? 0 });
        parensByNote.set(note, list);
      } else {
        mainAccidUses.push(u);
      }
    }
    const tag = parseTag(g.getAttribute('class'));
    if (tag && mainAccidUses.length > 0) {
      if (!byNote.has(note)) byNote.set(note, []);
      byNote.get(note)!.push({ g, tag, use: mainAccidUses[0] });
    } else {
      for (const u of mainAccidUses) plain.push({ g, use: u });
    }
  }
  /* Per note: keep only outermost paren-left + outermost paren-right;
     remove the rest. The keepers will be swapped to BravuraText below. */
  for (const [, parens] of parensByNote) {
    const lefts = parens.filter((p) => p.cp === PAREN_LEFT_CP).sort((a, b) => a.x - b.x);
    const rights = parens.filter((p) => p.cp === PAREN_RIGHT_CP).sort((a, b) => a.x - b.x);
    const keepLeft = lefts[0] ?? null;
    const keepRight = rights[rights.length - 1] ?? null;
    for (const p of parens) {
      if (p === keepLeft || p === keepRight) {
        const parentG = p.use.parentElement;
        if (parentG) plain.push({ g: parentG, use: p.use });
      } else {
        p.use.remove();
      }
    }
  }
  if (byNote.size === 0 && plain.length === 0) return;

  const svg = (root as Element).querySelector?.('svg') ?? (root as Element).closest?.('svg') ?? root;
  /* A reusable hidden <text> for advance measurement (getComputedTextLength
     returns user units). */
  const meas = document.createElementNS(SVG_NS, 'text');
  meas.setAttribute('visibility', 'hidden');
  (svg as Element).appendChild(meas);
  const advance = (fontSize: number, ch: string): number => {
    meas.setAttribute('font-family', 'BravuraText');
    meas.setAttribute('font-size', String(fontSize));
    meas.textContent = ch;
    return meas.getComputedTextLength();
  };

  /* Plain accidentals: same codepoint + position, just BravuraText instead
     of Verovio's default font. Verovio already spaced them, so keep its x/y.
     For paren-caut notes (@hkl-paren-caut on the parent g.note), nudge the
     inner accidental glyph ~2 viewport-px (≈14 SVG units) left so it
     reads visually centered between Verovio's parens — BravuraText's left
     sidebearing on sharps/naturals is slightly larger than the matching
     paren spacing assumes. The parens themselves stay at Verovio's
     positions. */
  const PAREN_CAUT_LEFT_NUDGE = 14;
  for (const { g, use } of plain) {
    const cp = hrefCodepoint(use.getAttribute('xlink:href'));
    if (cp === null) continue;
    const t = parseTransform(use.getAttribute('transform'));
    const fontSize = 1000 * (t?.scale ?? 0.72);
    const isParen = cp === PAREN_LEFT_CP || cp === PAREN_RIGHT_CP;
    const inParenCaut = !isParen && (g.closest('g.note')?.getAttribute('data-hkl-paren-caut') === 'true');
    const txt = document.createElementNS(SVG_NS, 'text');
    txt.setAttribute('font-family', 'BravuraText');
    txt.setAttribute('font-size', String(fontSize));
    txt.setAttribute('fill', '#000');
    txt.setAttribute('x', String((t?.tx ?? 0) - (inParenCaut ? PAREN_CAUT_LEFT_NUDGE : 0)));
    txt.setAttribute('y', String((t?.ty ?? 0) + baselineCorrection(fontSize)));
    txt.textContent = String.fromCodePoint(cp);
    use.replaceWith(txt);
    g.setAttribute('data-hkl-injected', '1');
  }

  for (const [note, slots] of byNote) {
    /* Read Verovio's placement from the first placeholder: shared staff Y +
       glyph scale. font-size = 1000 * scale (Bravura em is 1000 design units;
       Verovio renders accidentals at scale ≈ 0.72 → 720 user units = 4 staff
       spaces, the SMuFL standard). */
    const t0 = parseTransform(slots[0].use.getAttribute('transform'));
    const fontSize = 1000 * (t0?.scale ?? 0.72);
    const baselineY = t0?.ty ?? 0;
    /* Rightmost reserved edge = where the accidental block meets the notehead.
       For paren-caut HEJI notes, retract from the inner-paren-right gap that
       was reserved by Verovio so the combined chain sits centered between
       the outer parens. */
    let rightEdge = Math.max(...slots.map(s => rectRight(s.use)));
    const inParenCaut = (note as Element).getAttribute('data-hkl-paren-caut') === 'true';
    if (inParenCaut) rightEdge -= PAREN_CAUT_LEFT_NUDGE;

    /* Order glyphs visual left-to-right by seq, compute slot advances. */
    const ordered = [...slots].sort((a, b) => a.tag.seq - b.tag.seq);
    const slotW = ordered.map(s => {
      const bare = BARE_CODE[s.tag.family];
      return advance(fontSize, String.fromCodePoint(bare ?? s.tag.codepoint));
    });
    const gap = fontSize * 0.02;
    const totalW = slotW.reduce((a, w) => a + w + gap, -gap);
    let x = rightEdge - totalW; /* right-align the packed block to the notehead side */

    for (let i = 0; i < ordered.length; i++) {
      const { g, tag, use } = ordered[i];
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('font-family', 'BravuraText');
      t.setAttribute('font-size', String(fontSize));
      t.setAttribute('fill', '#000');
      t.setAttribute('x', String(x));
      t.setAttribute('y', String(baselineY + baselineCorrection(fontSize) + FAMILY_Y_OFFSET[tag.family] * fontSize));
      t.textContent = String.fromCodePoint(tag.codepoint);
      use.replaceWith(t);
      /* keep the class so the pass stays idempotent-detectable */
      g.setAttribute('data-hkl-injected', '1');
      x += slotW[i] + gap;
    }
  }
  meas.remove();
}

function parseTransform(s: string | null): { tx: number; ty: number; scale: number } | null {
  if (!s) return null;
  const t = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/.exec(s);
  const sc = /scale\(\s*(-?[\d.]+)/.exec(s);
  return { tx: t ? +t[1] : 0, ty: t ? +t[2] : 0, scale: sc ? +sc[1] : 1 };
}

/** Right edge of an element in its OWN user-coordinate space (not screen):
 *  use the transform tx plus the rendered width via getBBox where available. */
function rectRight(use: Element): number {
  const t = parseTransform(use.getAttribute('transform'));
  const tx = t?.tx ?? 0;
  try {
    const bb = (use as SVGGraphicsElement).getBBox();
    return tx + bb.width * (t?.scale ?? 1);
  } catch {
    return tx;
  }
}
