// File I/O for Composer:
//   - .hkc save/load (canonical MEI with HKL data-q/data-r attrs)
//   - .musicxml export (one-way, lossy — colors and lattice tags preserved
//     where the spec allows; advanced markings like dynamics aren't emitted
//     because the model doesn't carry them yet).
//
// Uses simple download/upload via Blob + <input type="file"> — no File System
// Access API yet.

import { ComposerModel } from './model/index.js';
import { cellHasFlag } from './model/empty-flags.js';
import type { Voice, Duration, Dots, InstrumentEntry } from './model/index.js';
import { collectTempi, dirIsItalic, dirText, parseTstamp2, type TempoRecord } from './expressions.js';
import { noteAlter } from '@hkl/notation/accidentals.js';
import { applyNotationTheme } from '@hkl/notation/verovio.js';

/* ── helpers ─────────────────────────────────────────────────────────────── */

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('read failed'));
    fr.readAsText(file);
  });
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* ── .hkc save / load ────────────────────────────────────────────────────── */

export function saveHkc(model: ComposerModel, name?: string): void {
  const xml = model.serialize();
  const filename = (name ? name.replace(/\.[^.]*$/, '') : 'hkc-' + isoStamp()) + '.hkc';
  downloadBlob(filename, new Blob([xml], { type: 'application/xml' }));
}

export async function loadHkcFromFile(file: File): Promise<ComposerModel> {
  const text = await readFileAsText(file);
  return new ComposerModel(text);
}

/* ── MusicXML export ─────────────────────────────────────────────────────── */

const DURATION_NAME: Record<Duration, string> = {
  '1':  'whole',
  '2':  'half',
  '4':  'quarter',
  '8':  'eighth',
  '16': '16th',
  '32': '32nd',
  '64': '64th',
};

const PNAME_TO_STEP: Record<string, string> = {
  a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', f: 'F', g: 'G',
};

/** Net alteration for a MusicXML <alter> element. Derives from (q, r) via
 *  noteAlter so any magnitude (incl. >±3 stacks) exports correctly; falls back
 *  to the @accid token for coordinate-less notes. HEJI commas are not
 *  representable in MusicXML (W3C #263 open) and are intentionally dropped. */
function totalAlter(node: Element): number {
  return noteAlter(node);
}

/* divisions per quarter — base 16 covers 32nd notes (= 2) and dotted 16ths
 * (= 6). For tuplet support we multiply by the LCM of all tuplet `num`
 * values found in the doc so each tuplet child's sounding ticks come out
 * integer (e.g. triplet of 8ths needs divisions = LCM(16, 3) = 48). */
const BASE_DIVISIONS = 16;

function gcdN(a: number, b: number): number { return b === 0 ? a : gcdN(b, a % b); }
function lcmN(a: number, b: number): number { return (a * b) / gcdN(a, b); }

function computeDivisions(doc: Document): number {
  let result = BASE_DIVISIONS;
  for (const t of Array.from(doc.querySelectorAll('tuplet'))) {
    const num = parseInt(t.getAttribute('num') ?? '1', 10);
    if (num > 1) result = lcmN(result, num);
  }
  return result;
}

function durationToTicks(dur: Duration, dots: Dots, divisions: number): number {
  const base = (divisions * 4) / parseInt(dur, 10);
  if (dots === 1) return base * 3 / 2;
  if (dots === 2) return base * 7 / 4;
  return base;
}

function isTupletPlaceholderEl(el: Element): boolean {
  return el.localName === 'space' && el.getAttribute('data-tuplet-placeholder') === 'true';
}

function keySigToFifths(sig: string): number {
  if (sig === '0' || !sig) return 0;
  const n = parseInt(sig.slice(0, -1), 10);
  if (!isFinite(n)) return 0;
  if (sig.endsWith('s')) return n;
  if (sig.endsWith('f')) return -n;
  return 0;
}

interface XmlNoteSpec {
  step: string;
  alter: number;
  octave: number;
  color?: string;
  q?: number;
  r?: number;
  tieStart: boolean;
  tieStop: boolean;
  /** MEI xml:id — what note-anchored control events (slurs, fermatas, trills,
   *  breath marks, ottavas) reference. */
  id?: string;
  /** `@head.shape` / `@head.fill` (Finale's string-harmonic diamond). */
  headShape?: string;
  headFilled?: boolean;
}

interface XmlNoteEvent {
  notes: XmlNoteSpec[]; /* empty = rest */
  durTicks: number;
  durName: string;
  dots: number;
  staff: number;
  voice: number; /* MusicXML voice number, 1..4 globally */
  measureIdx: number; /* 0-based; emitted as @number = measureIdx + 1 */
  /** Set when this event is inside a tuplet. `position` marks first/last/etc.
   *  for the MusicXML `<tuplet>` notation start/stop tags. */
  tuplet?: {
    actualNotes: number;  /* @num */
    normalNotes: number;  /* @numbase */
    position: 'start' | 'middle' | 'stop' | 'solo';
  };
  /** xml:id of the slot element (note / chord / rest) — the anchor a
   *  chord-level control event (fermata on a chord) references. */
  slotId?: string;
  /** Articulation tokens on the slot: `stacc` | `acc` | `ten`. */
  artics?: string[];
  /** Explicit `@stem.dir` (the `L` key), when the slot carries one. */
  stemDir?: string;
  /** Beam role inside its `<beam>` wrapper (secondary beams are left to the
   *  reader — only beam number 1 is written). */
  beam?: 'begin' | 'continue' | 'end';
  /** Tremolo role from a `<bTrem>` (single) / `<fTrem>` (start + stop) wrapper. */
  tremolo?: { type: 'single' | 'start' | 'stop'; beams: number };
  /** An INVISIBLE time advance (`<space>`, `<rest visible="false">`): exported
   *  as `<forward>`, which is Finale's encoding and what the importer reads. */
  hidden?: boolean;
  /** Whole-measure rest (`<mRest>`) → `<rest measure="yes">`, which is
   *  meter-agnostic and carries no `<type>`. */
  measureRest?: boolean;
}

function isMeiElement(elem: Element, name: string): boolean {
  return elem.localName === name;
}

function readTieFlags(node: Element): { tieStart: boolean; tieStop: boolean } {
  const t = node.getAttribute('tie');
  /* MEI 5 data.TIE: 'i' (initial) | 'm' (medial — both) | 't' (terminal). */
  return {
    tieStart: t === 'i' || t === 'm',
    tieStop: t === 't' || t === 'm',
  };
}

/** Slot elements a layer can hold, once beams and tremolo wrappers are
 *  flattened away. */
function isSlotEl(el: Element): boolean {
  const ln = el.localName;
  return ln === 'note' || ln === 'chord' || ln === 'rest'
      || ln === 'mRest' || ln === 'space' || ln === 'mSpace';
}

interface Slot {
  elem: Element;
  beam?: 'begin' | 'continue' | 'end';
  tremolo?: { type: 'single' | 'start' | 'stop'; beams: number };
  /** `<fTrem>` members share ONE note's written value between them (each is
   *  DRAWN at the combined value — see model/ticks.ts), so each half carries
   *  half the ticks. That is also MusicXML's double-tremolo encoding. */
  tickScale?: number;
}

function tremoloBeams(el: Element): number {
  const n = parseInt(el.getAttribute('beams') ?? '3', 10);
  return isFinite(n) && n > 0 ? n : 3;
}

/** The playable slots inside a `<layer>` or `<tuplet>`, descending through
 *  `<beam>` (which supplies the beam roles) and `<fTrem>`/`<bTrem>` (the
 *  tremolo roles). With `keepTuplets`, a `<tuplet>` is returned as a slot of
 *  its own so the caller can attach the tuplet metadata; without it the
 *  tuplet's own content is flattened.
 *
 *  Descending into `<beam>` is what the previous layer-level `contentChildren`
 *  did but the tuplet branch did NOT — and `regroupBeams` puts a beamed
 *  tuplet's members inside a `<beam>` child, so 500 of the sonata's 513
 *  tuplets and 1 453 of its 9 099 notes were silently dropped from the export
 *  (probe `phasec/cb-xmlexport.js`). */
function collectSlots(container: Element, keepTuplets: boolean): Slot[] {
  const out: Slot[] = [];
  const walk = (parent: Element): void => {
    for (const c of Array.from(parent.children)) {
      const ln = c.localName;
      if (ln === 'beam') {
        const before = out.length;
        walk(c);
        /* Beam roles are positional within the wrapper; rests inside a beam
           carry none, and a wrapper holding one member needs no beam at all. */
        const members = out.slice(before).filter((sl) => sl.elem.localName !== 'rest');
        if (members.length >= 2) {
          members.forEach((sl, i) => {
            sl.beam = i === 0 ? 'begin' : i === members.length - 1 ? 'end' : 'continue';
          });
        }
        continue;
      }
      if (ln === 'fTrem' || ln === 'bTrem') {
        const kids = Array.from(c.children).filter((k) => k.localName === 'note' || k.localName === 'chord');
        const beams = tremoloBeams(c);
        if (ln === 'bTrem') {
          for (const k of kids) out.push({ elem: k, tremolo: { type: 'single', beams } });
        } else {
          kids.forEach((k, i) => out.push({
            elem: k,
            tickScale: 1 / Math.max(1, kids.length),
            tremolo: { type: i === 0 ? 'start' : 'stop', beams },
          }));
        }
        continue;
      }
      if (ln === 'tuplet') {
        if (keepTuplets) out.push({ elem: c });
        else walk(c);
        continue;
      }
      if (isSlotEl(c)) out.push({ elem: c });
    }
  };
  walk(container);
  return out;
}

function readNote(node: Element): XmlNoteSpec {
  const pname = node.getAttribute('pname') ?? 'c';
  const oct = parseInt(node.getAttribute('oct') ?? '4', 10);
  /* Sum the net alteration from whichever encoding the note carries
     (@accid, @accid.ges, or <accid> children). MusicXML's <alter> needs
     the actual pitch as a signed integer. */
  const alter = totalAlter(node);
  const color = node.getAttribute('color') ?? undefined;
  const qStr = node.getAttribute('data-q');
  const rStr = node.getAttribute('data-r');
  const ties = readTieFlags(node);
  const headShape = node.getAttribute('head.shape') ?? undefined;
  return {
    step: PNAME_TO_STEP[pname] ?? 'C',
    alter,
    octave: oct,
    color,
    q: qStr !== null ? parseInt(qStr, 10) : undefined,
    r: rStr !== null ? parseInt(rStr, 10) : undefined,
    tieStart: ties.tieStart,
    tieStop: ties.tieStop,
    id: node.getAttribute('xml:id') ?? undefined,
    headShape,
    headFilled: headShape ? node.getAttribute('head.fill') !== 'void' : undefined,
  };
}

/** Articulation tokens (`stacc` | `acc` | `ten`) on a slot element. */
function readArtics(slot: Element): string[] | undefined {
  const out: string[] = [];
  for (const c of Array.from(slot.children)) {
    if (c.localName !== 'artic') continue;
    const v = c.getAttribute('artic');
    if (v) out.push(v);
  }
  return out.length ? out : undefined;
}

/** One event from a flattened slot. `budgetTicks` is the measure's own budget
 *  (a pickup's is reduced), needed for the meter-agnostic `<mRest>`. */
function eventFromSlot(
  slot: Slot, staff: number, voice: number, mi: number,
  divisions: number, budgetTicks: number,
  tuplet?: XmlNoteEvent['tuplet'],
): XmlNoteEvent | null {
  const elem = slot.elem;
  const ln = elem.localName;
  const dur = (elem.getAttribute('dur') ?? '4') as Duration;
  const dots = parseInt(elem.getAttribute('dots') ?? '0', 10) as Dots;
  const scale = slot.tickScale ?? 1;
  const ratio = tuplet ? tuplet.normalNotes / tuplet.actualNotes : 1;
  const base: Omit<XmlNoteEvent, 'notes' | 'durTicks' | 'durName'> = {
    dots, staff, voice, measureIdx: mi,
    tuplet,
    slotId: elem.getAttribute('xml:id') ?? undefined,
    artics: readArtics(elem),
    stemDir: elem.getAttribute('stem.dir') ?? undefined,
    beam: slot.beam,
    tremolo: slot.tremolo,
  };
  if (ln === 'mRest' || ln === 'mSpace') {
    return {
      ...base, notes: [], durTicks: budgetTicks, durName: 'whole',
      measureRest: true, hidden: ln === 'mSpace',
      /* A measure rest carries no beam / tremolo / articulation. */
      beam: undefined, tremolo: undefined, artics: undefined,
    };
  }
  const durTicks = Math.round(durationToTicks(dur, dots, divisions) * ratio * scale);
  const durName = DURATION_NAME[dur] ?? 'quarter';
  if (ln === 'rest' || ln === 'space') {
    return {
      ...base, notes: [], durTicks, durName,
      hidden: ln === 'space' || elem.getAttribute('visible') === 'false',
    };
  }
  if (ln === 'note') return { ...base, notes: [readNote(elem)], durTicks, durName };
  if (ln === 'chord') {
    const noteEls = Array.from(elem.children).filter((c) => c.localName === 'note');
    return { ...base, notes: noteEls.map((n) => readNote(n)), durTicks, durName };
  }
  return null;
}

function gatherEventsFromDoc(doc: Document, divisions: number, model: ComposerModel): XmlNoteEvent[] {
  const out: XmlNoteEvent[] = [];
  const measures = Array.from(doc.querySelectorAll('measure'));
  const totalVoices = model.totalVoices();
  for (let mi = 0; mi < measures.length; mi++) {
    const measure = measures[mi];
    const budgetTicks = measureTicksOf(model, mi, divisions);
    for (let voice = 1 as Voice; voice <= totalVoices; voice = (voice + 1) as Voice) {
      const staffN = model.staffForVoice(voice);
      const staff = staffN;
      const layerN = model.layerForVoice(voice);
      const layer = Array.from(measure.querySelectorAll(`staff[n="${staffN}"] layer[n="${layerN}"]`))[0];
      if (!layer) {
        if (voice === totalVoices) break;
        continue;
      }
      for (const slot of collectSlots(layer, true)) {
        if (slot.elem.localName === 'tuplet') {
          const num = parseInt(slot.elem.getAttribute('num') ?? '3', 10);
          const numbase = parseInt(slot.elem.getAttribute('numbase') ?? '2', 10);
          /* Placeholders are MEI-internal layout artifacts with no MusicXML
             form. The members are flattened (beams included) so a beamed
             tuplet exports its notes like any other. */
          const filled = collectSlots(slot.elem, false).filter((sl) => !isTupletPlaceholderEl(sl.elem));
          filled.forEach((member, i) => {
            const position: 'start' | 'middle' | 'stop' | 'solo' =
              filled.length === 1 ? 'solo' :
              i === 0 ? 'start' :
              i === filled.length - 1 ? 'stop' : 'middle';
            const ev = eventFromSlot(member, staff, voice, mi, divisions, budgetTicks,
              { actualNotes: num, normalNotes: numbase, position });
            if (ev) out.push(ev);
          });
          continue;
        }
        if (isTupletPlaceholderEl(slot.elem)) continue;
        const ev = eventFromSlot(slot, staff, voice, mi, divisions, budgetTicks);
        if (ev) out.push(ev);
      }
      if (voice === totalVoices) break;
    }
  }
  return out;
}

/** A measure's tick budget in EXPORT divisions. Taken from the model, not from
 *  `meter.count`, so a pickup's reduced budget travels (MEI ticks are on a
 *  quarter = 16 scale). */
function measureTicksOf(model: ComposerModel, mi: number, divisions: number): number {
  return Math.round(model.measureTicksAt(mi) * divisions / 16);
}

/** Full-bar ticks for the measure's meter, in export divisions — the budget a
 *  measure would have if it were not a pickup. */
function fullBarTicksOf(model: ComposerModel, mi: number, divisions: number): number {
  const meter = model.meterAt(mi);
  return Math.round(meter.count * divisions * 4 / meter.unit);
}

interface ClefSpec { sign: string; line: string; oct: number }

function clefEq(a: ClefSpec, b: ClefSpec): boolean {
  return a.sign === b.sign && a.line === b.line && a.oct === b.oct;
}

/** MEI `@clef.dis`/`@clef.dis.place` (or `@dis`/`@dis.place`) → MusicXML
 *  clef-octave-change (+1/-1 for 8va/8vb, +2/-2 for 15ma/15mb). */
function disToOct(dis: string | null, place: string | null): number {
  if (!dis) return 0;
  const n = parseInt(dis, 10);
  const steps = n === 15 ? 2 : n === 8 ? 1 : 0;
  return place === 'below' ? -steps : steps;
}

/** Opening clef for a staff from the head `<staffDef>` (defaults treble/bass). */
function headClefForStaff(doc: Document, staffN: number): ClefSpec {
  const sd = Array.from(doc.querySelectorAll('scoreDef staffDef'))
    .find((d) => d.getAttribute('n') === String(staffN));
  return {
    sign: sd?.getAttribute('clef.shape') ?? (staffN === 1 ? 'G' : 'F'),
    line: sd?.getAttribute('clef.line') ?? (staffN === 1 ? '2' : '4'),
    oct: disToOct(sd?.getAttribute('clef.dis') ?? null, sd?.getAttribute('clef.dis.place') ?? null),
  };
}

/** The last inline `<clef>` in a staff's layers within a measure, or null. */
function lastClefInMeasure(measureEl: Element, staffN: number): ClefSpec | null {
  const staff = Array.from(measureEl.querySelectorAll('staff'))
    .find((s) => s.getAttribute('n') === String(staffN));
  if (!staff) return null;
  const clefs = Array.from(staff.querySelectorAll('layer > clef'));
  if (clefs.length === 0) return null;
  const c = clefs[clefs.length - 1];
  return {
    sign: c.getAttribute('shape') ?? 'G',
    line: c.getAttribute('line') ?? '2',
    oct: disToOct(c.getAttribute('dis'), c.getAttribute('dis.place')),
  };
}

/** (measure, tick-within-measure) of every note/chord slot, accumulated per
 *  voice from the gathered events. Used to order slurs for numbering and to
 *  place `@startid`/`@endid` spanners (ottavas) at the right measure+offset. */
function buildNotePositions(events: XmlNoteEvent[]): Map<string, NotePos> {
  const pos = new Map<string, NotePos>();
  const clock = new Map<string, number>();
  for (const ev of events) {
    const key = ev.measureIdx + ':' + ev.voice;
    const at = clock.get(key) ?? 0;
    const rec: NotePos = { mi: ev.measureIdx, tick: at, voice: ev.voice };
    if (ev.slotId) pos.set(ev.slotId, rec);
    for (const n of ev.notes) if (n.id) pos.set(n.id, rec);
    clock.set(key, at + ev.durTicks);
  }
  return pos;
}

interface NotePos { mi: number; tick: number; voice: number }

/** MUSICAL position — where a note sounds. Used to decide which notes an
 *  ottava covers. */
const posKey = (p: NotePos): number => p.mi * 1e6 + p.tick;

/** DOCUMENT position in the exported stream. A measure is written one voice
 *  at a time, separated by `<backup>`, so a note late in an early voice
 *  precedes one early in a later voice — which is the order a reader pairing
 *  numbered spanners actually sees. */
function streamKeyOf(p: NotePos, voiceOrder: Map<number, number>): number {
  return p.mi * 1e9 + (voiceOrder.get(p.voice) ?? 0) * 1e6 + p.tick;
}

/** Global voice → its index within its own part's voice list. */
function buildVoiceOrder(model: ComposerModel): Map<number, number> {
  const order = new Map<number, number>();
  for (const inst of model.instruments()) {
    model.voicesForInstrument(inst.index).forEach((v, i) => order.set(v, i));
  }
  return order;
}

/** Index the note-anchored control events by the id they reference.
 *
 *  Slur numbers are assigned by interval colouring over the notes' real
 *  positions: a slur takes the lowest number no slur still open at its start
 *  is using, so overlapping slurs are always distinguishable (MusicXML allows
 *  1–6; a seventh simultaneous slur wraps, which no real score reaches). */
function buildNoteAnnotations(
  doc: Document, positions: Map<string, NotePos>, voiceOrder: Map<number, number>,
): NoteAnnotations {
  const ann: NoteAnnotations = {
    slurs: new Map(), fermatas: new Set(), trills: new Map(), breaths: new Set(),
  };
  const ref = (el: Element, attr: string): string | null => {
    const v = el.getAttribute(attr);
    return v ? v.replace(/^#/, '') : null;
  };
  const addSlur = (id: string, role: { type: 'start' | 'stop'; number: number }): void => {
    const at = ann.slurs.get(id);
    if (at) at.push(role); else ann.slurs.set(id, [role]);
  };

  /* Number by DOCUMENT position, not musical time: a slur ending late in
     voice 3 is written after one starting early in voice 1, and a reader
     pairing by number in document order would see the same number opened
     twice. (Four of the sonata's cross-barline slurs were dropped on
     re-import exactly this way; blocking a number for a whole measure fixed
     those but ran the pool past 6 and wrapped, losing two more.) */
  const spans: Array<{ from: string; to: string; a: number; b: number }> = [];
  for (const sl of Array.from(doc.querySelectorAll('slur'))) {
    const from = ref(sl, 'startid'); const to = ref(sl, 'endid');
    if (!from || !to) continue;
    const pa = positions.get(from); const pb = positions.get(to);
    if (!pa || !pb) continue;
    const a = streamKeyOf(pa, voiceOrder);
    const b = streamKeyOf(pb, voiceOrder);
    spans.push({ from, to, a: Math.min(a, b), b: Math.max(a, b) });
  }
  spans.sort((x, y) => x.a - y.a || x.b - y.b);
  const open: Array<{ until: number; number: number }> = [];
  for (const sp of spans) {
    for (let i = open.length - 1; i >= 0; i--) if (open[i].until <= sp.a) open.splice(i, 1);
    const taken = new Set(open.map((o) => o.number));
    let num = 1;
    while (num <= 6 && taken.has(num)) num++;
    if (num > 6) num = 1;
    open.push({ until: sp.b, number: num });
    addSlur(sp.from, { type: 'start', number: num });
    addSlur(sp.to, { type: 'stop', number: num });
  }

  for (const f of Array.from(doc.querySelectorAll('fermata'))) {
    const id = ref(f, 'startid');
    if (id) ann.fermatas.add(id);
  }
  for (const t of Array.from(doc.querySelectorAll('trill'))) {
    const id = ref(t, 'startid');
    if (!id) continue;
    const extender = t.getAttribute('extender') === 'true';
    const endId = ref(t, 'endid');
    const at = ann.trills.get(id) ?? { mark: false };
    at.mark = true;
    at.accidUpper = t.getAttribute('accidupper') ?? at.accidUpper;
    if (extender && endId && endId !== id) {
      at.wavyStart = true;
      const stop = ann.trills.get(endId) ?? { mark: false };
      stop.wavyStop = true;
      ann.trills.set(endId, stop);
    }
    ann.trills.set(id, at);
  }
  for (const b of Array.from(doc.querySelectorAll('breath'))) {
    const id = b.getAttribute('data-hkl-anchor');
    if (id) ann.breaths.add(id);
  }
  return ann;
}

/** Restore SOUNDING pitch under an ottava. MEI stores the WRITTEN pitch — the
 *  importer shifts a bracketed note when it builds the span, so an 8va's notes
 *  sit an octave low in the document and the `<octave>` element puts them
 *  back. MusicXML is the other way round: `<pitch>` is the sounding pitch and
 *  `<octave-shift>` says how it is PRINTED. Without this the exported notes
 *  sound an octave off, and a re-import shifts them a second time.
 *
 *  Mutates the gathered events in place, before emission. */
function unshiftOttavaPitches(
  doc: Document, events: XmlNoteEvent[], positions: Map<string, NotePos>,
): void {
  const spans = Array.from(doc.querySelectorAll('octave')).map((el) => {
    const from = (el.getAttribute('startid') ?? '').replace(/^#/, '');
    const to = (el.getAttribute('endid') ?? '').replace(/^#/, '');
    const pa = positions.get(from); const pb = positions.get(to);
    if (!pa || !pb) return null;
    const dis = Math.round(firstNumAttr(el, 'dis', 8));
    const octaves = dis >= 22 ? 3 : dis >= 15 ? 2 : 1;
    return {
      a: posKey(pa), b: posKey(pb),
      staff: Math.round(firstNumAttr(el, 'staff', 1)),
      delta: el.getAttribute('dis.place') === 'below' ? -octaves : octaves,
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  if (spans.length === 0) return;
  for (const ev of events) {
    if (ev.notes.length === 0) continue;
    const anchor = ev.slotId ?? ev.notes[0].id;
    const at = anchor ? positions.get(anchor) : undefined;
    if (!at) continue;
    const k = posKey(at);
    for (const sp of spans) {
      if (sp.staff !== ev.staff || k < sp.a || k > sp.b) continue;
      for (const n of ev.notes) n.octave += sp.delta;
      break;
    }
  }
}

/* ── measure-level directions (dynamics, wedges, words, pedal, ottava) ───── */

/** A `<direction>` to write into the part that owns `staff`, `offsetTicks`
 *  divisions after its measure's start. */
interface DirectionSpec {
  measureIdx: number;
  offsetTicks: number;
  /** GLOBAL staff `@n`; the part maps it to its own 1-based numbering. */
  staff: number;
  placement?: 'above' | 'below';
  /** The `<direction-type>` content. */
  inner: string;
}

/** MusicXML has an element for each standard dynamic; anything else (a `sfz`
 *  spelling we do not know, a verbal marking) goes in `<other-dynamics>`. */
const DYNAMIC_ELEMENTS = new Set([
  'p', 'pp', 'ppp', 'pppp', 'ppppp', 'pppppp',
  'f', 'ff', 'fff', 'ffff', 'fffff', 'ffffff',
  'mp', 'mf', 'sf', 'sfp', 'sfpp', 'fp', 'rf', 'rfz', 'sfz', 'sffz', 'fz', 'n', 'pf', 'sfzp',
]);

/** MEI `@place` → MusicXML `@placement`. MusicXML has no "between": a mark in
 *  a grand staff's gap belongs below the staff it is anchored to. */
function placementOf(place: string | null): 'above' | 'below' | undefined {
  if (place === 'above') return 'above';
  if (place === 'below' || place === 'between') return 'below';
  return undefined;
}

const firstNumAttr = (el: Element, attr: string, dflt: number): number => {
  const raw = el.getAttribute(attr);
  if (raw === null) return dflt;
  const n = parseFloat(raw.trim().split(/\s+/)[0]);
  return isFinite(n) ? n : dflt;
};

/** Every measure-level direction the model carries, indexed by measure.
 *  Anchors: `@tstamp` for dynamics / wedges / words / pedal, and the
 *  `@startid`/`@endid` notes for an ottava (its bracket is drawn from those,
 *  and the importer reads it back the same way). */
function buildDirections(
  doc: Document, model: ComposerModel, divisions: number,
  positions: Map<string, NotePos>,
): Map<number, DirectionSpec[]> {
  const byMeasure = new Map<number, DirectionSpec[]>();
  const measures = Array.from(doc.querySelectorAll('measure'));
  const ticksPerBeat = (mi: number): number => {
    const meter = model.meterAt(mi);
    return divisions * 4 / meter.unit;
  };
  const offsetFor = (mi: number, tstamp: number): number =>
    Math.max(0, Math.round((tstamp - 1) * ticksPerBeat(mi)));
  const add = (d: DirectionSpec): void => {
    if (d.measureIdx < 0 || d.measureIdx >= measures.length) return;
    const at = byMeasure.get(d.measureIdx);
    if (at) at.push(d); else byMeasure.set(d.measureIdx, [d]);
  };

  measures.forEach((measure, mi) => {
    for (const el of Array.from(measure.children)) {
      const ln = el.localName;
      const staff = Math.round(firstNumAttr(el, 'staff', 1));
      const placement = placementOf(el.getAttribute('place'));
      const tstamp = firstNumAttr(el, 'tstamp', 1);

      if (ln === 'dynam') {
        const text = (el.textContent ?? '').trim();
        if (!text) continue;
        const inner = DYNAMIC_ELEMENTS.has(text)
          ? `<dynamics><${text}/></dynamics>`
          : `<dynamics><other-dynamics>${escapeXml(text)}</other-dynamics></dynamics>`;
        add({ measureIdx: mi, offsetTicks: offsetFor(mi, tstamp), staff, placement, inner });
        continue;
      }
      if (ln === 'dir') {
        const text = dirText(el);
        if (!text) continue;
        const italic = dirIsItalic(el) ? ' font-style="italic"' : '';
        add({
          measureIdx: mi, offsetTicks: offsetFor(mi, tstamp), staff, placement,
          inner: `<words${italic}>${escapeXml(text)}</words>`,
        });
        continue;
      }
      if (ln === 'pedal') {
        const dir = el.getAttribute('dir');
        if (dir !== 'down' && dir !== 'up') continue;
        add({
          measureIdx: mi, offsetTicks: offsetFor(mi, tstamp), staff, placement: 'below',
          inner: `<pedal type="${dir === 'down' ? 'start' : 'stop'}" line="no"/>`,
        });
        continue;
      }
      if (ln === 'hairpin') {
        const form = el.getAttribute('form');
        const wtype = form === 'dim' ? 'diminuendo' : 'crescendo';
        add({
          measureIdx: mi, offsetTicks: offsetFor(mi, tstamp), staff, placement,
          inner: `<wedge type="${wtype}"/>`,
        });
        const end = parseTstamp2(el.getAttribute('tstamp2') ?? '', mi);
        if (end) {
          add({
            measureIdx: end.measureIdx, offsetTicks: offsetFor(end.measureIdx, end.tstamp),
            staff, placement, inner: `<wedge type="stop"/>`,
          });
        }
        continue;
      }
      if (ln === 'octave') {
        /* 8va = notes PRINTED an octave down = MusicXML type="down" (the
           inverse of the importer's `down` → place="above"). */
        const dis = Math.round(firstNumAttr(el, 'dis', 8));
        const otype = el.getAttribute('dis.place') === 'below' ? 'up' : 'down';
        const from = (el.getAttribute('startid') ?? '').replace(/^#/, '');
        const to = (el.getAttribute('endid') ?? '').replace(/^#/, '');
        const pa = positions.get(from); const pb = positions.get(to);
        if (!pa || !pb) continue;
        add({
          measureIdx: pa.mi, offsetTicks: pa.tick, staff,
          placement: otype === 'down' ? 'above' : 'below',
          inner: `<octave-shift type="${otype}" size="${dis}"/>`,
        });
        add({
          measureIdx: pb.mi, offsetTicks: pb.tick, staff,
          placement: otype === 'down' ? 'above' : 'below',
          inner: `<octave-shift type="stop" size="${dis}"/>`,
        });
      }
    }
  });
  for (const list of byMeasure.values()) list.sort((a, b) => a.offsetTicks - b.offsetTicks);
  return byMeasure;
}

/* ── barlines, repeats and voltas ────────────────────────────────────────── */

/** A manual break before this measure → `<print>`. The model keeps `<pb>` /
 *  `<sb>` as section-level siblings BEFORE the measure they break at (a
 *  section header's `<sb>` carries `data-hkl-section`). One-way: the importer
 *  does not read `<print>` back, but an external editor honours it. */
function printBreakXml(measure: Element): string {
  let page = false; let system = false;
  for (let sib = measure.previousElementSibling; sib; sib = sib.previousElementSibling) {
    const ln = sib.localName;
    if (ln === 'pb') { page = true; continue; }
    if (ln === 'sb') { system = true; continue; }
    if (ln === 'scoreDef') continue;   /* a signature change sits between */
    break;
  }
  if (page) return `    <print new-page="yes"/>\n`;
  if (system) return `    <print new-system="yes"/>\n`;
  return '';
}

/** MEI `@left`/`@right` barline token → MusicXML `<bar-style>`. */
const BAR_STYLE: Record<string, string> = {
  end: 'light-heavy', dbl: 'light-light', rptstart: 'heavy-light', rptend: 'light-heavy',
};

/** The `<ending>` (volta) a measure belongs to, and where it sits in it. */
function endingRoleOf(measure: Element): { n: string; first: boolean; last: boolean } | null {
  const wrap = measure.parentElement;
  if (!wrap || wrap.localName !== 'ending') return null;
  const kids = Array.from(wrap.children).filter((c) => c.localName === 'measure');
  if (kids.length === 0) return null;
  return {
    n: wrap.getAttribute('n') ?? '1',
    first: kids[0] === measure,
    last: kids[kids.length - 1] === measure,
  };
}

/** `<barline>` children in DTD order: bar-style, ending, repeat. Returns the
 *  left and right barlines for one measure — repeat signs, double bars, volta
 *  brackets, and the final bar. A section (movement) boundary needs nothing
 *  special: `setBarlines` already puts `@right="end"` on the measure before
 *  one, and the importer reads a mid-piece final bar back as a section. */
function barlinesFor(measure: Element, isLastMeasure: boolean): { left: string; right: string } {
  const leftTok = measure.getAttribute('left');
  let rightTok = measure.getAttribute('right');
  if (!rightTok && isLastMeasure) rightTok = 'end';
  const ending = endingRoleOf(measure);

  const build = (loc: 'left' | 'right', style: string | undefined, inner: string): string => {
    if (!style && !inner) return '';
    return `    <barline location="${loc}">`
      + (style ? `<bar-style>${style}</bar-style>` : '')
      + inner
      + `</barline>\n`;
  };

  let leftInner = '';
  if (ending?.first) leftInner += `<ending number="${escapeXml(ending.n)}" type="start"/>`;
  if (leftTok === 'rptstart') leftInner += `<repeat direction="forward"/>`;
  const left = build('left', leftTok ? BAR_STYLE[leftTok] : undefined, leftInner);

  let rightInner = '';
  if (ending?.last) {
    /* A volta closed by a repeat gets the hooked "stop"; the last time
       through ends with an open bracket ("discontinue"), the convention. */
    const type = rightTok === 'rptend' ? 'stop' : 'discontinue';
    rightInner += `<ending number="${escapeXml(ending.n)}" type="${type}"/>`;
  }
  if (rightTok === 'rptend') rightInner += `<repeat direction="backward"/>`;
  const right = build('right', rightTok ? BAR_STYLE[rightTok] : undefined, rightInner);

  return { left, right };
}

/** `<direction>` children in DTD order: direction-type+, offset?, staff?.
 *  `offsetTicks` is the residual after the direction has been placed in the
 *  note stream, so it is 0 in the common case and may be NEGATIVE when the
 *  anchor fell between two onsets (MusicXML allows that, and Finale writes
 *  such offsets routinely). */
function directionXml(d: DirectionSpec, staffLocal: number, offsetTicks: number): string {
  let s = `    <direction${d.placement ? ` placement="${d.placement}"` : ''}>\n`;
  s += `      <direction-type>${d.inner}</direction-type>\n`;
  if (offsetTicks !== 0) s += `      <offset>${offsetTicks}</offset>\n`;
  s += `      <staff>${staffLocal}</staff>\n`;
  s += `    </direction>\n`;
  return s;
}

/** One tempo marking as a MusicXML `<direction>`, `offsetTicks` divisions after
 *  the measure start (directions are written at the measure head, so anything
 *  off beat 1 needs the offset — the same encoding the importer reads back).
 *
 *  The metronome is drawn only when the mark shows it (`showMm`); the bpm
 *  always travels as `<sound tempo>`, so a DAW gets the tempo even where the
 *  score draws none. A mark with neither text nor a visible metronome — the
 *  seed document's playback-only tempo, or an imported hidden `<sound tempo>` —
 *  becomes a bare `<sound>`, since an empty `<direction-type>` is invalid.
 *  Gradual rit./accel. and "a tempo" export as italic words with no tempo
 *  value: MusicXML has no gradual-tempo element, and this is what Finale
 *  writes. They re-import as expressive text, not as gradual marks (the .hkc
 *  is the lossless format). */
function tempoDirectionXml(rec: TempoRecord, offsetTicks: number): string {
  const verbalOnly = rec.gradual !== null || rec.aTempo;
  const showMm = rec.bpm !== null && rec.showMm && !verbalOnly;
  const offsetXml = offsetTicks > 0 ? `      <offset>${offsetTicks}</offset>\n` : '';
  if (!rec.text && !showMm) {
    if (rec.bpm === null || verbalOnly) return '';
    return offsetTicks > 0
      ? `    <sound tempo="${rec.bpm}"><offset>${offsetTicks}</offset></sound>\n`
      : `    <sound tempo="${rec.bpm}"/>\n`;
  }
  let s = `    <direction placement="above">\n      <direction-type>\n`;
  if (rec.text) {
    /* Trailing space before a metronome, matching Finale's own spacing. */
    s += `        <words${verbalOnly ? ' font-style="italic"' : ''}>`
      + `${escapeXml(rec.text)}${showMm ? ' ' : ''}</words>\n`;
  }
  if (showMm) {
    const beatUnitName = DURATION_NAME[String(rec.unit) as Duration] ?? 'quarter';
    s += `        <metronome><beat-unit>${beatUnitName}</beat-unit>`;
    if (rec.dots > 0) s += `<beat-unit-dot/>`;
    s += `<per-minute>${rec.bpm}</per-minute></metronome>\n`;
  }
  s += `      </direction-type>\n`;
  s += offsetXml;
  if (rec.bpm !== null && !verbalOnly) s += `      <sound tempo="${rec.bpm}"/>\n`;
  s += `    </direction>\n`;
  return s;
}

function clefXml(number: number, c: ClefSpec): string {
  let s = `      <clef number="${number}"><sign>${c.sign}</sign><line>${c.line}</line>`;
  if (c.oct) s += `<clef-octave-change>${c.oct}</clef-octave-change>`;
  s += `</clef>\n`;
  return s;
}

export function exportMusicXml(model: ComposerModel): string {
  const xml = model.serialize();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  const title = model.getTitle();
  const composer = model.getComposer() || 'HKL Composer';

  const divisions = computeDivisions(doc);
  const events = gatherEventsFromDoc(doc, divisions, model);
  const measureCount = Math.max(1, doc.querySelectorAll('measure').length);
  const measureEls = Array.from(doc.querySelectorAll('measure'));
  const totalVoices = model.totalVoices();

  /* Group events by (measure, GLOBAL voice). The score splits into one <part>
     per instrument (roadmap §14.2): each part renumbers its staves and voices
     part-local (1-based) so a non-first instrument's staff @n=3 doesn't leak a
     bogus clef number. A single-instrument doc degenerates to one <part>. */
  const grouped: Record<number, Record<number, XmlNoteEvent[]>> = {};
  for (let mi = 0; mi < measureCount; mi++) {
    grouped[mi] = {};
    for (let v = 1; v <= totalVoices; v++) grouped[mi][v] = [];
  }
  for (const ev of events) grouped[ev.measureIdx][ev.voice].push(ev);

  const instruments = model.instruments();
  const notePositions = buildNotePositions(events);
  const annotations = buildNoteAnnotations(doc, notePositions, buildVoiceOrder(model));
  const directions = buildDirections(doc, model, divisions, notePositions);
  unshiftOttavaPitches(doc, events, notePositions);

  /* Tempo markings, indexed by measure. Every mark is exported — not just the
     document's first one, which is all `model.getTempo()` ever saw — and each
     is written into EVERY part, the way Finale writes a tempo direction into
     each part. The model holds one score-global <tempo> per moment; the
     duplication is an export convention, exactly as it is on the render clone
     (notation/parts.ts). */
  const tempiByMeasure = new Map<number, TempoRecord[]>();
  for (const rec of collectTempi(doc)) {
    const at = tempiByMeasure.get(rec.moment.measureIdx);
    if (at) at.push(rec);
    else tempiByMeasure.set(rec.moment.measureIdx, [rec]);
  }

  /* Build the body for one instrument's <part>. staffMap/voiceMap convert the
     global staff @n / voice index to part-local (1-based). Tempo directions go
     into every part (see tempiByMeasure above). */
  const buildPartBody = (inst: InstrumentEntry): string => {
    const partStaffNs = inst.staffNs;
    const partStaffCount = partStaffNs.length;
    /* Empty-cell flags (model/empty-flags.ts) → MusicXML. Hidden ranges per
       part staff as Finale writes them: <staff-details print-object="no"/> at
       the first flagged bar, ="yes" at the first unflagged bar after. A
       multimeasure rest is part-wide in MusicXML, so <measure-style>
       <multiple-rest>N</multiple-rest> is written only for a ONE-staff part, at
       the first bar of each run the part view would collapse. */
    const hiddenNow: Record<number, boolean> = {};
    for (const sn of partStaffNs) hiddenNow[sn] = false;
    const partUnits = partStaffCount === 1 ? model.renderUnits([partStaffNs[0]]) : null;
    const staffMap = (globalN: number): number => partStaffNs.indexOf(globalN) + 1;
    const partVoices = model.voicesForInstrument(inst.index);
    const voiceMap = (globalV: number): number => partVoices.indexOf(globalV) + 1;

    /* Per-staff clef tracking (part-local), best-effort for mid-piece changes. */
    const curClef: Record<number, ClefSpec> = {};
    for (const sn of partStaffNs) curClef[sn] = headClefForStaff(doc, sn);
    let prevKeySig: string | null = null;
    let prevCount = -1;
    let prevUnit = -1;

    let body = '';
    for (let mi = 0; mi < measureCount; mi++) {
      const mMeter = model.meterAt(mi);
      const mKeySig = model.keySigAt(mi);
      const mKeyMode = model.keyModeAt(mi);
      /* The measure's OWN budget, from the model — a pickup's is reduced, and
         padding it to `meter.count` (which is what this used to do) exported
         an anacrusis as a complete bar. `implicit="yes"` is MusicXML's mark
         for a measure that is not counted, i.e. exactly a pickup. */
      const measureTicks = measureTicksOf(model, mi, divisions);
      const isPickup = measureTicks < fullBarTicksOf(model, mi, divisions);
      body += `  <measure number="${mi + 1}"${isPickup ? ' implicit="yes"' : ''}>\n`;
      body += printBreakXml(measureEls[mi]);
      const bars = barlinesFor(measureEls[mi], mi === measureCount - 1);
      body += bars.left;

      const clefToEmit: Record<number, ClefSpec | null> = {};
      for (const staffN of partStaffNs) {
        clefToEmit[staffN] = null;
        const cl = lastClefInMeasure(measureEls[mi], staffN);
        if (cl && !clefEq(cl, curClef[staffN])) {
          clefToEmit[staffN] = cl;
          curClef[staffN] = cl;
        }
      }
      const keyChanged = mKeySig !== prevKeySig;
      const meterChanged = mMeter.count !== prevCount || mMeter.unit !== prevUnit;
      const anyClefChange = partStaffNs.some((sn) => clefToEmit[sn]);
      const staffDetails: string[] = [];
      for (const sn of partStaffNs) {
        const hidden = cellHasFlag(measureEls[mi], sn, 'hide-empty');
        if (hidden !== hiddenNow[sn]) {
          hiddenNow[sn] = hidden;
          staffDetails.push(`      <staff-details number="${staffMap(sn)}" print-object="${hidden ? 'no' : 'yes'}"/>\n`);
        }
      }
      const multipleRest = partUnits && partUnits.isRunStart(mi) ? partUnits.unitOf(mi)[1] - mi + 1 : 0;

      if (mi === 0 || keyChanged || meterChanged || anyClefChange || staffDetails.length || multipleRest) {
        body += `    <attributes>\n`;
        if (mi === 0) body += `      <divisions>${divisions}</divisions>\n`;
        if (mi === 0 || keyChanged) body += `      <key><fifths>${keySigToFifths(mKeySig)}</fifths><mode>${mKeyMode}</mode></key>\n`;
        if (mi === 0 || meterChanged) {
          /* meter.sym → MusicXML's C / ¢ glyphs; without it a cut-time score
             exports as a plain 2/2. */
          const sym = mMeter.sym === 'cut' ? ' symbol="cut"' : mMeter.sym === 'common' ? ' symbol="common"' : '';
          body += `      <time${sym}><beats>${mMeter.count}</beats><beat-type>${mMeter.unit}</beat-type></time>\n`;
        }
        if (mi === 0 && partStaffCount > 1) body += `      <staves>${partStaffCount}</staves>\n`;
        for (const sn of partStaffNs) {
          if (mi === 0) body += clefXml(staffMap(sn), curClef[sn]);
          else if (clefToEmit[sn]) body += clefXml(staffMap(sn), clefToEmit[sn]!);
        }
        for (const sd of staffDetails) body += sd;
        if (multipleRest) body += `      <measure-style><multiple-rest>${multipleRest}</multiple-rest></measure-style>\n`;
        body += `    </attributes>\n`;
      }
      prevKeySig = mKeySig;
      prevCount = mMeter.count;
      prevUnit = mMeter.unit;

      /* Tempo markings at this measure, at the measure head with an <offset>
         for anything off beat 1. Directions precede the notes, so a reader
         picks the tempo up before the first note it governs. */
      const marks = tempiByMeasure.get(mi);
      if (marks) {
        const ticksPerBeat = divisions * 4 / mMeter.unit;
        for (const rec of marks) {
          body += tempoDirectionXml(rec, Math.round((rec.moment.tstamp - 1) * ticksPerBeat));
        }
      }

      /* Dynamics, wedges, expressive text, pedal and ottava — each written
         only into the part that owns its staff, with a part-local <staff>.
         They are INTERLEAVED into the note stream at their own tick rather
         than parked at the measure head: `<offset>` is advisory and a reader
         may ignore it, and our own importer deliberately does for
         <octave-shift> (its stream span decides which notes get rewritten),
         so a head-parked ottava contained in one measure spanned nothing and
         was dropped. Each staff's directions ride in the first voice of that
         staff that has content; a staff with no content this measure emits
         them at the head, offset and all. */
      const staffDirs = new Map<number, DirectionSpec[]>();
      for (const d of directions.get(mi) ?? []) {
        if (!partStaffNs.includes(d.staff)) continue;
        const at = staffDirs.get(d.staff);
        if (at) at.push(d); else staffDirs.set(d.staff, [d]);
      }

      /* Per-voice streams within this measure, separated by <backup>. A voice
         whose whole measure is invisible (an empty layer is all <space>) is
         skipped outright rather than written as a measure-long <forward>:
         MusicXML's way of saying "this voice is silent here" is to say
         nothing, and HKL draws nothing there either. */
      const voiceTicks: Record<number, number> = {};
      for (const v of partVoices) voiceTicks[v] = 0;
      const emittedVoices = partVoices.filter((v) => grouped[mi][v].some((ev) => !ev.hidden));
      /* The voice each staff's directions ride in: its first with content. */
      const hostVoice = new Map<number, number>();
      for (const v of emittedVoices) {
        const st = model.staffForVoice(v);
        if (!hostVoice.has(st)) hostVoice.set(st, v);
      }
      let prevVoice: number | null = null;
      for (const voice of emittedVoices) {
        if (prevVoice !== null) body += `    <backup><duration>${voiceTicks[prevVoice]}</duration></backup>\n`;
        const st = model.staffForVoice(voice);
        const pending = hostVoice.get(st) === voice ? (staffDirs.get(st) ?? []) : [];
        let pi = 0;
        const flushTo = (tick: number): void => {
          while (pi < pending.length && pending[pi].offsetTicks <= tick) {
            const d = pending[pi++];
            body += directionXml(d, staffMap(d.staff), d.offsetTicks - tick);
          }
        };
        for (const ev of grouped[mi][voice]) {
          flushTo(voiceTicks[voice]);
          body += emitEventXml(ev, staffMap(ev.staff), voiceMap(ev.voice), annotations);
          voiceTicks[voice] += ev.durTicks;
        }
        flushTo(voiceTicks[voice]);
        const remaining = measureTicks - voiceTicks[voice];
        if (remaining > 0) {
          body += `    <note><rest/><duration>${remaining}</duration>`
            + `<voice>${voiceMap(voice)}</voice>`
            + `<staff>${staffMap(model.staffForVoice(voice))}</staff></note>\n`;
          voiceTicks[voice] = measureTicks;
        }
        /* Anything still pending sits past the voice's content. */
        while (pi < pending.length) {
          const d = pending[pi++];
          body += directionXml(d, staffMap(d.staff), d.offsetTicks - voiceTicks[voice]);
        }
        prevVoice = voice;
      }
      /* Staves with nothing in this measure: their directions at the head. */
      for (const [st, list] of staffDirs) {
        if (hostVoice.has(st)) continue;
        for (const d of list) body += directionXml(d, staffMap(st), d.offsetTicks);
      }
      /* A part silent for a whole measure still has to account for the bar,
         or its timeline drifts against the other parts. The conventional
         encoding is one whole-measure rest. */
      if (emittedVoices.length === 0) {
        body += `    <note><rest measure="yes"/><duration>${measureTicks}</duration>`
          + `<voice>${voiceMap(partVoices[0])}</voice><staff>1</staff></note>\n`;
      }

      body += bars.right;

      body += `  </measure>\n`;
    }
    return body;
  };

  const partList = instruments
    .map((inst, pi) => {
      const abbrEl = Array.from(inst.staffGrp.children).find((c) => c.localName === 'labelAbbr');
      const abbr = (abbrEl?.textContent ?? '').trim();
      return `    <score-part id="P${pi + 1}">\n`
        + `      <part-name>${escapeXml(inst.name)}</part-name>\n`
        + (abbr ? `      <part-abbreviation>${escapeXml(abbr)}</part-abbreviation>\n` : '')
        + `    </score-part>`;
    })
    .join('\n');
  const parts = instruments
    .map((inst, pi) => `  <part id="P${pi + 1}">\n${buildPartBody(inst)}  </part>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.0">
  <work><work-title>${escapeXml(title)}</work-title></work>
  <identification>
    <creator type="composer">${escapeXml(composer)}</creator>
    <encoding>
      <software>HKL Composer</software>
      <encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date>
    </encoding>
  </identification>
  <part-list>
${partList}
  </part-list>
${parts}
</score-partwise>
`;
}

/** Note-anchored control events, indexed by the xml:id they reference, so the
 *  note emitter can attach them without re-walking the document. */
interface NoteAnnotations {
  /** Slur roles per note id. `number` disambiguates overlapping slurs. */
  slurs: Map<string, Array<{ type: 'start' | 'stop'; number: number }>>;
  /** Ids (note OR chord) carrying a `<fermata>`. */
  fermatas: Set<string>;
  /** Trill roles: the ornament itself, plus the wavy-line extender's ends. */
  trills: Map<string, { mark: boolean; accidUpper?: string; wavyStart?: boolean; wavyStop?: boolean }>;
  /** Note ids a `<breath>` follows. */
  breaths: Set<string>;
}

const EMPTY_ANNOTATIONS: NoteAnnotations = {
  slurs: new Map(), fermatas: new Set(), trills: new Map(), breaths: new Set(),
};

/** MusicXML articulation element for an MEI `@artic` token. */
const ARTIC_ELEMENT: Record<string, string> = {
  stacc: 'staccato', acc: 'accent', ten: 'tenuto',
  marc: 'strong-accent', stacciss: 'staccatissimo',
};

/** `<accidental-mark>` value for an MEI accidental token on a trill. */
const ACCID_MARK: Record<string, string> = {
  s: 'sharp', f: 'flat', n: 'natural', x: 'double-sharp', ff: 'flat-flat',
};

function articulationsXml(tokens: string[] | undefined, breath: boolean): string {
  const els: string[] = [];
  for (const t of tokens ?? []) {
    const name = ARTIC_ELEMENT[t];
    if (name) els.push(`<${name}/>`);
  }
  if (breath) els.push('<breath-mark/>');
  return els.length ? `<articulations>${els.join('')}</articulations>` : '';
}

function ornamentsXml(
  trill: { mark: boolean; accidUpper?: string; wavyStart?: boolean; wavyStop?: boolean } | undefined,
  tremolo: XmlNoteEvent['tremolo'],
): string {
  const els: string[] = [];
  if (trill) {
    if (trill.mark) els.push('<trill-mark/>');
    if (trill.wavyStart) els.push('<wavy-line type="start"/>');
    if (trill.wavyStop) els.push('<wavy-line type="stop"/>');
    const mark = trill.accidUpper ? ACCID_MARK[trill.accidUpper] : undefined;
    if (mark) els.push(`<accidental-mark placement="above">${mark}</accidental-mark>`);
  }
  if (tremolo) els.push(`<tremolo type="${tremolo.type}">${tremolo.beams}</tremolo>`);
  return els.length ? `<ornaments>${els.join('')}</ornaments>` : '';
}

/** `<note>` children in DTD order: pitch/rest, duration, tie*, voice, type,
 *  dot*, time-modification?, stem?, notehead?, staff?, beam*, notations*.
 *  (The old emitter put `<dot>` before `<type>` and `<staff>` before
 *  `<notehead>` — both out of order, which strict readers reject.) */
function emitEventXml(
  ev: XmlNoteEvent, staff: number, voice: number,
  ann: NoteAnnotations = EMPTY_ANNOTATIONS,
): string {
  const timeMod = ev.tuplet ? timeModXml(ev.tuplet.actualNotes, ev.tuplet.normalNotes) : '';
  const stem = ev.stemDir === 'up' || ev.stemDir === 'down' ? `<stem>${ev.stemDir}</stem>` : '';
  const beam = ev.beam ? `<beam number="1">${ev.beam}</beam>` : '';

  /* An invisible time advance: <forward> keeps the following notes on their
     true beat without drawing a rest (Finale's encoding; the importer reads
     it back as a hidden rest). */
  if (ev.hidden) {
    return `    <forward><duration>${ev.durTicks}</duration>`
      + `<voice>${voice}</voice><staff>${staff}</staff></forward>\n`;
  }

  if (ev.notes.length === 0) {
    /* Rest. A whole-measure rest is <rest measure="yes"> with no <type> — the
       meter-agnostic form. A tuplet rest carries time-modification (so DAW
       timing is right) but no <tuplet/> tag: only notes get brackets. */
    const restEl = ev.measureRest ? '<rest measure="yes"/>' : '<rest/>';
    let r = `    <note>${restEl}<duration>${ev.durTicks}</duration><voice>${voice}</voice>`;
    if (!ev.measureRest) r += `<type>${ev.durName}</type>${dotXml(ev.dots)}`;
    r += timeMod;
    r += `<staff>${staff}</staff>`;
    /* A tuplet that BEGINS or ENDS on a rest needs its bracket tag here — 134
       of the sonata's 513 tuplets do, and skipping rests left those brackets
       with no start or no stop for a reader to reconstruct. */
    const rStart = ev.tuplet && (ev.tuplet.position === 'start' || ev.tuplet.position === 'solo');
    const rStop = ev.tuplet && (ev.tuplet.position === 'stop' || ev.tuplet.position === 'solo');
    if (rStart || rStop) {
      r += `<notations>`;
      if (rStart) r += `<tuplet type="start" number="1"/>`;
      if (rStop) r += `<tuplet type="stop" number="1"/>`;
      r += `</notations>`;
    }
    r += `</note>\n`;
    return r;
  }

  let s = '';
  for (let i = 0; i < ev.notes.length; i++) {
    const n = ev.notes[i];
    s += `    <note>`;
    if (i > 0) s += `<chord/>`;
    s += `<pitch><step>${n.step}</step>`;
    if (n.alter !== 0) s += `<alter>${n.alter}</alter>`;
    s += `<octave>${n.octave}</octave></pitch>`;
    s += `<duration>${ev.durTicks}</duration>`;
    /* Sound-layer ties. */
    if (n.tieStart) s += `<tie type="start"/>`;
    if (n.tieStop) s += `<tie type="stop"/>`;
    s += `<voice>${voice}</voice>`;
    s += `<type>${ev.durName}</type>`;
    s += `${dotXml(ev.dots)}`;
    /* Time-modification applies to ALL chord notes inside a tuplet, so
       the DAW timing comes out right per voice. */
    s += timeMod;
    s += stem;
    if (n.color || n.headShape) {
      const attrs = (n.color ? ` color="${escapeXml(n.color)}"` : '')
        + (n.headShape && n.headFilled === false ? ' filled="no"' : '');
      s += `<notehead${attrs}>${n.headShape ?? 'normal'}</notehead>`;
    }
    s += `<staff>${staff}</staff>`;
    s += beam;

    /* Engraving-layer notations. Only the chord's PRIMARY note (i === 0)
       carries the tuplet bracket, the fermata and the ornaments — standard
       MusicXML practice (one per chord, not one per chord member). */
    const tStart = ev.tuplet && i === 0 && (ev.tuplet.position === 'start' || ev.tuplet.position === 'solo');
    const tStop  = ev.tuplet && i === 0 && (ev.tuplet.position === 'stop'  || ev.tuplet.position === 'solo');
    const anchored = i === 0;
    /* A slur can be anchored to the CHORD rather than one of its notes, so the
       primary note carries the chord's slur roles too (91 of the sonata's 922
       slurs are chord-anchored and were indexed but never emitted). */
    /* For a BARE note the slot id IS the note id, so only a chord contributes
       a second, distinct anchor. */
    const chordAnchor = anchored && ev.slotId && ev.slotId !== n.id ? ann.slurs.get(ev.slotId) : undefined;
    const slurs = [...((n.id ? ann.slurs.get(n.id) : undefined) ?? []), ...(chordAnchor ?? [])];
    const fermata = anchored && ((ev.slotId ? ann.fermatas.has(ev.slotId) : false)
      || (n.id ? ann.fermatas.has(n.id) : false));
    const trill = anchored && n.id ? ann.trills.get(n.id) : undefined;
    const breath = anchored && !!n.id && ann.breaths.has(n.id);
    const artics = anchored ? articulationsXml(ev.artics, breath) : '';
    const orn = anchored ? ornamentsXml(trill, ev.tremolo) : '';
    if (n.tieStart || n.tieStop || tStart || tStop || slurs.length || fermata || artics || orn) {
      s += `<notations>`;
      if (n.tieStop) s += `<tied type="stop"/>`;
      if (n.tieStart) s += `<tied type="start"/>`;
      for (const sl of slurs) s += `<slur type="${sl.type}" number="${sl.number}"/>`;
      if (tStart) s += `<tuplet type="start" number="1"/>`;
      if (tStop) s += `<tuplet type="stop" number="1"/>`;
      s += orn;
      s += artics;
      if (fermata) s += `<fermata/>`;
      s += `</notations>`;
    }
    s += `</note>\n`;
  }
  return s;
}

function timeModXml(actual: number, normal: number): string {
  return `<time-modification><actual-notes>${actual}</actual-notes>` +
    `<normal-notes>${normal}</normal-notes></time-modification>`;
}

function dotXml(dots: number): string {
  if (dots <= 0) return '';
  let s = '';
  for (let i = 0; i < dots; i++) s += '<dot/>';
  return s;
}

export function downloadMusicXml(model: ComposerModel): void {
  const xml = exportMusicXml(model);
  const filename = 'hkc-' + isoStamp() + '.musicxml';
  downloadBlob(filename, new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }));
}

/* ── .pdf export ─────────────────────────────────────────────────────────── */

/* The paper is always US Letter, in PDF points (1 in = 72 pt). The document's
 * page size (`pageScale`) scales the page RECTANGLE relative to the notation —
 * how much score sits on a sheet — never the sheet itself, so a resized page
 * still prints on Letter; its SVG viewBox keeps Letter's aspect and `meet`
 * fits it. */
const LETTER_PT_W = 612;
const LETTER_PT_H = 792;

/* MEI's @color attribute on <note> propagates to all descendants by default
 * — notehead AND stem AND flag AND accidental AND dots — because Verovio
 * emits the descendants with fill="currentColor". On screen, composer.html
 * forces these non-notehead elements back to black via CSS. That CSS does
 * NOT reach the off-screen SVG handed to svg-to-pdfkit, so without this normalize
 * pass the PDF picks up the inherited color on every stem/flag/accid/etc.
 * Walk the SVG and pin `color` + `fill` to black on the same selectors the
 * stylesheet covers; descendants then resolve currentColor as black. */
const NON_NOTEHEAD_BLACK_CLASSES = ['stem', 'flag', 'accid', 'ledgerLines', 'dots', 'artic', 'fermata', 'breath'];

export function forceNonNoteheadBlack(svg: SVGSVGElement): void {
  const sel = NON_NOTEHEAD_BLACK_CLASSES.map((c) => '.' + c).join(', ');
  for (const container of Array.from(svg.querySelectorAll(sel))) {
    container.setAttribute('color', '#000');
    container.setAttribute('fill', '#000');
    /* Belt and braces: any descendant with an explicit non-currentColor
     * fill (would otherwise win over the container's color) also gets
     * pinned to black. Mirrors the `.stem *` part of the stylesheet. */
    for (const desc of Array.from(container.querySelectorAll('*'))) {
      desc.setAttribute('fill', '#000');
    }
  }
}

/* Verovio emits each single-note <g class="note"> as [notehead, dots, stem];
 * SVG z-order is document order, so the stem draws over the notehead. With
 * colored noteheads + black stems, the stem intrudes visibly. Move each
 * notehead to be the LAST child of its note so it draws on top. Chord
 * stems live outside the per-note <g> already, so chords don't need this.
 * Mirrors the same pass render.ts applies to the on-screen DOM. */
export function liftNoteheadsAbove(svg: SVGSVGElement): void {
  for (const note of Array.from(svg.querySelectorAll('g.note'))) {
    const notehead = note.querySelector(':scope > g.notehead');
    if (notehead) note.appendChild(notehead);
  }
}

/* svg-to-pdfkit asks us which PDF font to draw each SVG <text> in. Verovio's
 * music symbols (clefs, noteheads, time sigs) are vector <path>/<use> — no font
 * — but the title/composer/footer text and the HEJI accidentals injected by
 * injectHejiGlyphs ARE <text>. Map the injected HEJI/music family to the
 * embedded Bravura OTF; everything else to a built-in PDFKit font. */
function pdfFontFor(family: string, bold: boolean, italic: boolean): string {
  if (/bravura|leipzig|smufl|vero|music/i.test(family)) return 'Bravura';
  const serif = /times|serif|georgia/i.test(family);
  if (serif) return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : (italic ? 'Times-Italic' : 'Times-Roman');
  return bold ? (italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (italic ? 'Helvetica-Oblique' : 'Helvetica');
}

/* On screen, composer CSS hides two kinds of rests: tuplet-placeholder rests
 * (`data-data-tuplet-placeholder="true"` — only there to make Verovio draw the
 * bracket) and user-hidden rests (`data-visible="false"`, the `H` toggle).
 * Verovio doesn't honor @visible (rism-digital/verovio#202), so this is CSS —
 * which doesn't reach svg-to-pdfkit. Remove those rests outright before the PDF
 * draws them (removal, not visibility, since svg-to-pdfkit ignores both). */
function removeHiddenRests(svg: SVGSVGElement): void {
  for (const el of Array.from(svg.querySelectorAll(
    'g.rest[data-data-tuplet-placeholder="true"], g.rest[data-visible="false"]',
  ))) {
    el.parentNode?.removeChild(el);
  }
}

/* Verovio strokes staff lines / barlines / stems via an embedded
 * `<style>… path,rect,…{stroke:currentColor}</style>` block rather than inline
 * `stroke` attributes (the line paths carry only `d` + `stroke-width`). On
 * screen the browser applies that scoped style; svg-to-pdfkit does NOT process
 * `<style>` selector blocks, so stroke-only lines render invisible in the PDF
 * (fill-based glyphs are unaffected). Resolve each strokable element's COMPUTED
 * stroke — which the off-screen-but-attached host resolves from the scoped
 * style + `currentColor` (incl. forceNonNoteheadBlack's color overrides) — into
 * an explicit `stroke` attribute svg-to-pdfkit honors.
 *
 * ONLY elements Verovio gave an explicit `stroke-width` (staff lines, barlines,
 * stems, ledger lines, hairpins) are stroke-drawn; we gate on that. Filled
 * glyphs (noteheads, accidentals, clefs — `<use>` of filled `<path>`s in
 * `<defs>`, which have no stroke-width) must NOT be stroked, else every glyph
 * picks up a hairline outline that antialiases to a gray edge in the PDF. */
function inlineComputedStroke(svg: SVGSVGElement): void {
  for (const el of Array.from(svg.querySelectorAll('path, rect, line, polyline, polygon'))) {
    if (el.getAttribute('stroke')) continue;
    if (!el.getAttribute('stroke-width')) continue;
    const stroke = getComputedStyle(el).stroke;
    if (stroke && stroke !== 'none') el.setAttribute('stroke', stroke);
  }
}

/** Export the page view's DOM as a vector PDF, page for page (2026-09-05).
 *
 *  `pages` are the LIVE page SVGs (Renderer.mountAllPages, in page order).
 *  Every pass that shapes the on-screen page — the render-clone conventions,
 *  the crisp post pass, the below-staff text layout, placement, the
 *  header/footer/section injections, the page-fit repair — has already run on
 *  them, so the PDF is the screen by construction: nothing here re-engraves,
 *  and the live toolkit's layout is left alone. (The previous export re-loaded
 *  the document under its own fixed options and re-ran a copy of the three
 *  passes that existed in June; everything added since — line-break and
 *  vertical ownership, dynamics centring, balancing, the injected header /
 *  footer / section titles, the page-size factor — never reached it.)
 *
 *  Each page is CLONED into an attached off-screen host and normalized for
 *  print there (normalizePageForPrint): svg-to-pdfkit reads presentation
 *  attributes and inline style only, so what the screen gets from stylesheets
 *  is inlined from computed style, which needs layout — hence attached.
 *
 *  PDFKit (not jsPDF) because it embeds the Bravura OTF (CFF) via fontkit —
 *  jsPDF supports only TrueType-`glyf` and silently drops Bravura, so HEJI
 *  accidentals wouldn't render. svg-to-pdfkit draws the SVG, including the
 *  injected HEJI <text>, as vectors + embedded glyphs. See decisions.md
 *  "Composer PDF export uses PDFKit, not jsPDF". Lazy-loaded so the PDF stack
 *  only lands in the bundle on first export. */
export async function downloadPdf(pages: SVGSVGElement[]): Promise<void> {
  if (!pages.length) throw new Error('nothing to export — no rendered pages');
  /* Snapshot every page NOW, before the first await: the mount window may
     evict far pages (innerHTML = '') on the next idle tick, and the export
     must be one consistent picture of the screen at the moment it was asked
     for — not whatever the evictor left by the time the PDF stack had loaded. */
  const clones = pages.map((p) => p.cloneNode(true) as SVGSVGElement);
  const PDFDocument = (await import('pdfkit/js/pdfkit.standalone.js')).default;
  const SVGtoPDF = (await import('svg-to-pdfkit')).default;

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute; left:-100000px; top:0; visibility:hidden';
  document.body.appendChild(host);
  try {
    /* The font must come from the PROXY origin (localhost:5170): on an app's
       own dev port the root path 404s (its public assets live under its base),
       fontkit then rejects the HTML body, and svg-to-pdfkit drops every
       BravuraText run with nothing but a console warning — a PDF with no
       accidentals at all (2026-09-05, lessons.md). Refuse loudly instead. */
    const otfRes = await fetch('/BravuraText.otf');
    const otf = await otfRes.arrayBuffer();
    const magic = String.fromCharCode(...new Uint8Array(otf.slice(0, 4)));
    if (!otfRes.ok || magic !== 'OTTO') {
      throw new Error('BravuraText.otf did not load from this origin (' + otfRes.status + ', "' + magic
        + '") — accidentals would be missing. Run Composer through the dev proxy (localhost:5170/composer/).');
    }
    const doc = new PDFDocument({ size: 'letter', margin: 0, autoFirstPage: false });
    /* PDFKit's doc is itself a readable stream — collect its chunks into a Blob
       directly (avoids blob-stream, which references a Node `global`). */
    const chunks: BlobPart[] = [];
    const ended = new Promise<void>((resolve) => {
      doc.on('data', (c: Uint8Array) => chunks.push(c.slice()));
      doc.on('end', () => resolve());
    });
    doc.registerFont('Bravura', otf);
    /* svg-to-pdfkit reports what it could not draw (a font it failed to open,
       an unparsable path) through this callback and otherwise continues
       silently; without it the default is console.warn, easy to miss. */
    const warnings: string[] = [];

    for (const svg of clones) {
      host.replaceChildren(svg);
      normalizePageForPrint(host, svg);
      doc.addPage({ size: 'letter', margin: 0 });
      /* The root <svg>'s own width/height are the screen's device pixels
         (pinExactScale); the paper size passed here is the viewport instead,
         and the nested definition-scale viewBox maps the page onto it. */
      SVGtoPDF(doc, svg, 0, 0, {
        width: LETTER_PT_W,
        height: LETTER_PT_H,
        preserveAspectRatio: 'xMinYMin meet',
        fontCallback: pdfFontFor,
        warningCallback: (w: string) => warnings.push(w),
      });
    }
    if (warnings.length) console.error('[composer] pdf export: svg-to-pdfkit reported ' + warnings.length + ' problem(s):', warnings.slice(0, 20));
    doc.end();
    await ended;
    downloadBlob('hkc-' + isoStamp() + '.pdf', new Blob(chunks, { type: 'application/pdf' }));
  } finally {
    document.body.removeChild(host);
  }
}

/** Print normalization of one page clone sitting in an attached `host`, in
 *  order. Exported for the test suite. */
export function normalizePageForPrint(host: HTMLElement, svg: SVGSVGElement): void {
  /* Light theme regardless of the screen theme. Dark is two things: the
     `data-notation-theme` tag — on the container, and on every system a splice
     imported — whose stylesheet recolors every stroke and fill and WOULD apply
     in the host (the tag travels with the clone; the computed stroke inlined
     below would come out light ink); and the inline light-source notehead
     colors, which applyNotationTheme('light') strips. */
  for (const el of [svg as Element].concat(Array.from(svg.querySelectorAll('[data-notation-theme]')))) {
    el.removeAttribute('data-notation-theme');
  }
  applyNotationTheme(host, 'light');
  /* Rests the screen hides by CSS; non-notehead glyphs the screen blacks by
     CSS; then what Verovio's own stylesheet supplies — the stroke (computed
     AFTER the color overrides so it reflects them) and text weight/slant. */
  removeHiddenRests(svg);
  forceNonNoteheadBlack(svg);
  inlineComputedStroke(svg);
  inlineComputedTextStyle(svg);
}

/* Verovio sets text weight and slant through its embedded stylesheet as well —
 * `#<svgid> g.ending, g.fing, g.reh, g.tempo {font-weight:bold}`, `g.dir,
 * g.dynam, g.mNum {font-style:italic}`, `g.label {font-weight:normal}` — never
 * as attributes on the <text>/<tspan>. svg-to-pdfkit does not apply those
 * rules, so every tempo printed regular (Max, 2026-09-05: bold in the app, not
 * in the export — the brightest spot on the sonata heatmap and its one
 * qualitative divergence) and every expressive text upright. Resolve the
 * COMPUTED weight/style of every text run — which already accounts for
 * ancestors and for Verovio's own `font-weight`/`font-style` attributes — onto
 * the element as presentation attributes; svg-to-pdfkit reads them (with
 * inheritance) when it asks `fontCallback` for the face. Attached host, like
 * the stroke pass. */
function inlineComputedTextStyle(svg: SVGSVGElement): void {
  for (const el of Array.from(svg.querySelectorAll('text, tspan'))) {
    const cs = getComputedStyle(el);
    if (!el.getAttribute('font-weight')) {
      const w = parseInt(cs.fontWeight, 10);
      el.setAttribute('font-weight', cs.fontWeight === 'bold' || w >= 600 ? 'bold' : 'normal');
    }
    if (!el.getAttribute('font-style')) {
      el.setAttribute('font-style', cs.fontStyle === 'italic' || cs.fontStyle === 'oblique' ? 'italic' : 'normal');
    }
  }
}
