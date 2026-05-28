// Shared MEI document-construction primitives — the single source of truth for
// the `.hkc` MEI dialect (head + hkl:config + scoreDef + measure skeleton, plus
// the note / chord / rest element builders). Consumed by Composer's model
// (step-entry) and by HKL's transcription emitter (recording → .hkc).
//
// Pure DOM/string construction: no model state, no cursor/tuplet machinery, no
// @hkl/bridge dependency. Note builders take a structural `NoteSpec` rather than
// the bridge's `ResolvedNote` so this module stays a sibling of @hkl/bridge in
// the package DAG (importing it would break check:boundaries). `ResolvedNote` is
// structurally assignable to `NoteSpec`, so Composer call sites pass it directly.

import { tokenFromAlter, alterFromCount } from './accidentals.js';
import { DYNAMIC_NAMES, DEFAULT_DYNAMIC_MAP } from '@hkl/shared/dynamics.js';

export const MEI_NS = 'http://www.music-encoding.org/ns/mei';
export const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export type Duration = '1' | '2' | '4' | '8' | '16' | '32' | '64';
export type Dots = 0 | 1 | 2;

/** Structural note params for the element builders. A subset of the bridge's
 *  ResolvedNote (everything but `velocity`), so HKL's resolveNoteSpec output and
 *  Composer's ResolvedNote both satisfy it. `accid` is count-form
 *  ('', 's', 'ff', 'sss', 'n' …); `midi` is used only for chord sort order. */
export interface NoteSpec {
  q: number;
  r: number;
  pname: 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';
  accid: string;
  oct: number;
  midi: number;
  colorHex: string;
}

export function el(
  doc: Document,
  name: string,
  attrs?: Record<string, string | number | undefined>,
): Element {
  const e = doc.createElementNS(MEI_NS, name);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === '') continue;
      if (k === 'xml:id') {
        /* xml:id must live in the XML namespace — without setAttributeNS, the
           attribute would have local name literally "xml:id" in the null
           namespace, so selectors like `[*|id="…"]` fail to find it and
           tie-partner lookups silently bail. Serializing still emits
           xml:id="…" exactly as before. */
        e.setAttributeNS(XML_NS, 'xml:id', String(v));
      } else {
        e.setAttribute(k, String(v));
      }
    }
  }
  return e;
}

/* MEI id space — required for Verovio's xml:id → SVG id mapping. Module-level
   monotonic counter; each bundle (Composer, HKL) gets its own instance, and the
   random suffix rules out cross-bundle collisions. */
let nextSeq = 0;
export function newId(prefix: string): string {
  nextSeq++;
  return prefix + '-' + nextSeq.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* ── element builders ────────────────────────────────────────────────────── */

export function buildNoteElement(
  doc: Document,
  n: NoteSpec,
  dur: Duration,
  dots: Dots,
  inChord = false,
): Element {
  const attrs: Record<string, string | number | undefined> = {
    'xml:id': newId('n'),
    pname: n.pname,
    oct: n.oct,
    color: n.colorHex,
    'data-q': n.q,
    'data-r': n.r,
  };
  if (!inChord) {
    attrs.dur = dur;
    if (dots > 0) attrs.dots = dots;
  }
  /* Accidental: emit a single canonical MEI token (s/f/x/ff/ts/tf or 'n' for
     explicit natural). HKL count-form string is parsed to an integer alter;
     values outside ±3 should never arrive here but tokenFromAlter clamps. */
  if (n.accid === 'n') {
    attrs.accid = 'n';
  } else {
    const token = tokenFromAlter(alterFromCount(n.accid));
    if (token) attrs.accid = token;
  }
  return el(doc, 'note', attrs);
}

export interface ChordSpec {
  notes: ReadonlyArray<NoteSpec>;
  duration: Duration;
  dots?: Dots;
}

export function buildChordElement(doc: Document, input: ChordSpec): Element {
  const dur = input.duration;
  const dots = input.dots ?? 0;
  if (input.notes.length === 1) {
    return buildNoteElement(doc, input.notes[0], dur, dots);
  }
  const chord = el(doc, 'chord', {
    'xml:id': newId('c'),
    dur,
    dots: dots > 0 ? dots : undefined,
  });
  const sorted = [...input.notes].sort((a, b) => a.midi - b.midi);
  for (const n of sorted) {
    chord.appendChild(buildNoteElement(doc, n, dur, dots, /* inChord */ true));
  }
  return chord;
}

export interface RestSpec {
  duration: Duration;
  dots?: Dots;
}

export function buildRestElement(doc: Document, input: RestSpec): Element {
  return el(doc, 'rest', {
    'xml:id': newId('r'),
    dur: input.duration,
    dots: input.dots && input.dots > 0 ? input.dots : undefined,
  });
}

/* ── empty / skeleton document ───────────────────────────────────────────── */

export interface ScoreSkeletonSetup {
  title?: string;
  composer?: string;
  keySig?: string;            /* "0" | "1s".."7s" | "1f".."7f" */
  meterCount?: number;
  meterUnit?: number;
  tempoBpm?: number;
  tempoUnit?: '1' | '2' | '4' | '8';
  tempoDots?: 0 | 1;
  tempoText?: string;
  /* Required layout for this score. Default Ptolemaic / A3-at-origin. */
  layoutReq?: { tuningMode: string; refQ: number; refR: number };
}

/** Build a complete empty `.hkc` document as an XML string: meiHead with the
 *  HKL-namespaced config (layoutReq + dynamic→velocity map), scoreDef, and one
 *  empty grand-staff measure. */
export function buildScoreSkeletonXml(setup: ScoreSkeletonSetup = {}): string {
  const title = setup.title ?? 'Untitled';
  const composer = setup.composer ?? '';
  const keySig = setup.keySig ?? '0';
  const count = setup.meterCount ?? 4;
  const unit = setup.meterUnit ?? 4;
  const bpm = setup.tempoBpm ?? 120;
  const tempoUnit = setup.tempoUnit ?? '4';
  const tempoDots = setup.tempoDots ?? 0;
  const tempoText = setup.tempoText ?? '';

  const composerBlock = composer
    ? `<respStmt><persName role="composer">${escapeXml(composer)}</persName></respStmt>`
    : '';
  const tempoTextSpan = tempoText ? escapeXml(tempoText) + ' ' : '';
  const tempoDotsAttr = tempoDots > 0 ? ` mm.dots="${tempoDots}"` : '';
  const lr = setup.layoutReq ?? { tuningMode: '5', refQ: 0, refR: 0 };
  const layoutReqBlock = `<hkl:layoutReq tuningMode="${lr.tuningMode}" refQ="${lr.refQ}" refR="${lr.refR}"/>`;
  /* Dynamic→velocity defaults are sourced from @hkl/shared so they track the
     house curve; hardcoding them here let them go stale once already. */
  const dynamicLevelsBlock = DYNAMIC_NAMES
    .map((name) => `<hkl:level name="${name}" velocity="${DEFAULT_DYNAMIC_MAP[name]}"/>`)
    .join('\n          ');

  /* <extMeta> with HKL-namespaced config carries document-level performance
     defaults (dynamic→velocity map). The xmlns:hkl prefix declaration lives
     here so the prefixed elements parse cleanly. */
  return `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="${MEI_NS}" xmlns:hkl="https://hexkeylab.com/ns/mei" meiversion="5.0">
  <meiHead>
    <fileDesc>
      <titleStmt><title>${escapeXml(title)}</title>${composerBlock}</titleStmt>
      <pubStmt/>
    </fileDesc>
    <extMeta>
      <hkl:config>
        ${layoutReqBlock}
        <hkl:dynamicMap>
          ${dynamicLevelsBlock}
        </hkl:dynamicMap>
      </hkl:config>
    </extMeta>
  </meiHead>
  <music><body><mdiv><score>
    <scoreDef key.sig="${keySig}" meter.count="${count}" meter.unit="${unit}">
      <staffGrp symbol="brace" bar.thru="true">
        <staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>
        <staffDef n="2" lines="5" clef.shape="F" clef.line="4"/>
      </staffGrp>
    </scoreDef>
    <section>
      <measure n="1" right="end" xml:id="${newId('m')}">
        <tempo tstamp="1" staff="1" mm="${bpm}" mm.unit="${tempoUnit}"${tempoDotsAttr} midi.bpm="${bpm}">${tempoTextSpan}</tempo>
        <staff n="1" xml:id="${newId('s')}">
          <layer n="1" xml:id="${newId('l')}"/>
          <layer n="2" xml:id="${newId('l')}"/>
        </staff>
        <staff n="2" xml:id="${newId('s')}">
          <layer n="1" xml:id="${newId('l')}"/>
          <layer n="2" xml:id="${newId('l')}"/>
        </staff>
      </measure>
    </section>
  </score></mdiv></body></music>
</mei>`;
}

export function emptyMeiDoc(setup: ScoreSkeletonSetup = {}): Document {
  return new DOMParser().parseFromString(buildScoreSkeletonXml(setup), 'application/xml');
}
