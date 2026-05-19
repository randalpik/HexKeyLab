// Expression layer model. CRUD on MEI control events (<dynam>, <hairpin>)
// and on the document-level <extMeta>/<hkl:config> block that stores
// performance defaults (dynamic→velocity map, future tempo alteration).
//
// Anchoring strategy: time-based via @tstamp (beat within measure, 1-indexed)
// and @tstamp2 ("Nm+beat"). Expressions survive deletion of nearby notes
// because they are not bound to any note's xml:id. Slurs and articulations
// remain note-attached and live elsewhere.
//
// Insertion convention: as last child of the target <measure>, after all
// <staff> elements, matching the existing <lv> placement pattern.
//
// Verovio renders <dynam> and <hairpin> natively from these attributes;
// no rendering code lives here. Each new element gets a fresh xml:id so the
// expression cursor can locate it in the rendered SVG via rectForId().
//
// Moment = (measureIdx, tstamp). measureIdx is 0-based; tstamp is the MEI
// beat float (1.0 = downbeat; 4/4 measure has tstamps [1.0, 5.0)).

import { DYNAMIC_NAMES, DEFAULT_DYNAMIC_MAP } from '../shared/dynamics.js';

export const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export const HKL_NS = 'https://hexkeylab.com/ns/mei';

export interface Moment {
  measureIdx: number;
  tstamp: number;
}

/* ── id minting (self-contained; doesn't share model.ts's counter) ───────── */

let nextSeq = 1_000_000;
function newId(prefix: string): string {
  nextSeq++;
  return prefix + '-' + nextSeq.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

function createMei(doc: Document, name: string, attrs?: Record<string, string | number | undefined>): Element {
  const e = doc.createElementNS(MEI_NS, name);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === '') continue;
      if (k === 'xml:id') {
        e.setAttributeNS(XML_NS, 'xml:id', String(v));
      } else {
        e.setAttribute(k, String(v));
      }
    }
  }
  return e;
}

/* ── tstamp formatting / parsing ─────────────────────────────────────────── */

function trimFloat(x: number): string {
  /* MEI tstamps are commonly emitted with at most 3 decimal places; strip
     trailing zeros so a whole-number beat looks like "1" not "1.000". */
  return x.toFixed(3).replace(/\.?0+$/, '');
}

export function formatTstamp(t: number): string {
  return trimFloat(t);
}

/** Emit "Nm+beat" where N is endMeasureIdx − startMeasureIdx. */
export function formatTstamp2(start: Moment, end: Moment): string {
  const dm = end.measureIdx - start.measureIdx;
  return dm + 'm+' + trimFloat(end.tstamp);
}

/** Parse "Nm+B" or shorthand "B" (same-measure). Returns null on malformed. */
export function parseTstamp2(s: string, baseMeasureIdx: number): Moment | null {
  if (!s) return null;
  const m = s.match(/^(?:(\d+)m\+)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const dm = m[1] !== undefined ? parseInt(m[1], 10) : 0;
  const beat = parseFloat(m[2]);
  if (!isFinite(dm) || !isFinite(beat)) return null;
  return { measureIdx: baseMeasureIdx + dm, tstamp: beat };
}

/* ── moment ↔ tick conversion (depends on meter) ─────────────────────────── */

export function readMeter(doc: Document): { count: number; unit: number } {
  const sd = doc.querySelector('scoreDef');
  const count = parseInt(sd?.getAttribute('meter.count') ?? '4', 10);
  const unit = parseInt(sd?.getAttribute('meter.unit') ?? '4', 10);
  return { count: isFinite(count) ? count : 4, unit: isFinite(unit) ? unit : 4 };
}

/** Absolute 64th-note tick offset for a Moment, assuming uniform meter. */
export function absoluteTickForMoment(doc: Document, m: Moment): number {
  const { count, unit } = readMeter(doc);
  const ticksPerMeasure = count * (64 / unit);
  const ticksPerBeat = 64 / unit;
  return m.measureIdx * ticksPerMeasure + (m.tstamp - 1) * ticksPerBeat;
}

/* ── element CRUD ────────────────────────────────────────────────────────── */

function getMeasures(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll('measure'));
}

function measureAtIdx(doc: Document, idx: number): Element | null {
  return getMeasures(doc)[idx] ?? null;
}

function appendAtEnd(measure: Element, child: Element): void {
  /* By convention: append after all <staff> elements. Since we keep no
     hard ordering constraint between control-event siblings, plain
     appendChild is correct. */
  measure.appendChild(child);
}

const TS_EPSILON = 1e-6;

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) < TS_EPSILON;
}

function readTstamp(el: Element): number | null {
  const t = el.getAttribute('tstamp');
  if (t === null) return null;
  const n = parseFloat(t);
  return isFinite(n) ? n : null;
}

function readStartMoment(el: Element, measures: Element[]): Moment | null {
  const m = el.closest('measure');
  if (!m) return null;
  const idx = measures.indexOf(m);
  if (idx < 0) return null;
  const t = readTstamp(el);
  if (t === null) return null;
  return { measureIdx: idx, tstamp: t };
}

function readEndMoment(el: Element, measures: Element[]): Moment | null {
  const start = readStartMoment(el, measures);
  if (!start) return null;
  const ts2 = el.getAttribute('tstamp2');
  if (!ts2) return null;
  return parseTstamp2(ts2, start.measureIdx);
}

export interface DynamOpts {
  text: string;
  place?: 'above' | 'below' | 'between';
  staff?: number;
  val?: number;
  vgrp?: number;
}

export function addDynam(doc: Document, at: Moment, opts: DynamOpts): Element | null {
  const measure = measureAtIdx(doc, at.measureIdx);
  if (!measure) return null;
  const attrs: Record<string, string | number | undefined> = {
    'xml:id': newId('d'),
    tstamp: formatTstamp(at.tstamp),
    place: opts.place ?? 'between',
    staff: opts.staff ?? 1,
  };
  if (opts.val !== undefined) attrs.val = Math.max(0, Math.min(127, opts.val | 0));
  if (opts.vgrp !== undefined) attrs.vgrp = opts.vgrp;
  const el = createMei(doc, 'dynam', attrs);
  el.textContent = opts.text;
  appendAtEnd(measure, el);
  return el;
}

export interface HairpinOpts {
  form: 'cres' | 'dim';
  place?: 'above' | 'below' | 'between';
  staff?: number;
  vgrp?: number;
}

export function addHairpin(doc: Document, start: Moment, end: Moment, opts: HairpinOpts): Element | null {
  const measure = measureAtIdx(doc, start.measureIdx);
  if (!measure) return null;
  /* Reject zero/negative spans defensively (caller should already filter). */
  if (end.measureIdx < start.measureIdx) return null;
  if (end.measureIdx === start.measureIdx && end.tstamp <= start.tstamp + TS_EPSILON) return null;
  const attrs: Record<string, string | number | undefined> = {
    'xml:id': newId('h'),
    tstamp: formatTstamp(start.tstamp),
    tstamp2: formatTstamp2(start, end),
    form: opts.form,
    place: opts.place ?? 'between',
    staff: opts.staff ?? 1,
  };
  if (opts.vgrp !== undefined) attrs.vgrp = opts.vgrp;
  const el = createMei(doc, 'hairpin', attrs);
  appendAtEnd(measure, el);
  return el;
}

/** Set the text content of an existing <dynam>. */
export function setDynamText(el: Element, text: string): void {
  el.textContent = text;
}

/** Remove an expression element from its parent. */
export function removeExpression(el: Element): void {
  el.parentNode?.removeChild(el);
}

/* ── queries ─────────────────────────────────────────────────────────────── */

/** Find a <dynam> exactly at the given moment. */
export function dynamAt(doc: Document, m: Moment): Element | null {
  const measures = getMeasures(doc);
  const measure = measures[m.measureIdx];
  if (!measure) return null;
  for (const child of Array.from(measure.children)) {
    if (child.localName !== 'dynam') continue;
    const t = readTstamp(child);
    if (t !== null && approxEq(t, m.tstamp)) return child;
  }
  return null;
}

/** Return all <hairpin> elements whose [start, end] range (inclusive)
 *  contains the given moment. */
export function hairpinsAt(doc: Document, m: Moment): Element[] {
  const measures = getMeasures(doc);
  const out: Element[] = [];
  for (const el of Array.from(doc.querySelectorAll('hairpin'))) {
    const s = readStartMoment(el, measures);
    const e = readEndMoment(el, measures);
    if (!s || !e) continue;
    if (momentLE(s, m) && momentLE(m, e)) out.push(el);
  }
  return out;
}

function momentLE(a: Moment, b: Moment): boolean {
  if (a.measureIdx < b.measureIdx) return true;
  if (a.measureIdx > b.measureIdx) return false;
  return a.tstamp <= b.tstamp + TS_EPSILON;
}

export function momentEqual(a: Moment, b: Moment): boolean {
  return a.measureIdx === b.measureIdx && approxEq(a.tstamp, b.tstamp);
}

export function momentCompare(a: Moment, b: Moment): number {
  if (a.measureIdx !== b.measureIdx) return a.measureIdx - b.measureIdx;
  if (approxEq(a.tstamp, b.tstamp)) return 0;
  return a.tstamp - b.tstamp;
}

/** All <dynam> and <hairpin> moments (hairpins contribute BOTH start and
 *  end moments). Used by the expression cursor's moment-snap navigation
 *  so existing markings are reachable even when no note shares the moment. */
export function expressionMoments(doc: Document): Moment[] {
  const measures = getMeasures(doc);
  const out: Moment[] = [];
  for (const d of Array.from(doc.querySelectorAll('dynam'))) {
    const m = readStartMoment(d, measures);
    if (m) out.push(m);
  }
  for (const h of Array.from(doc.querySelectorAll('hairpin'))) {
    const s = readStartMoment(h, measures);
    const e = readEndMoment(h, measures);
    if (s) out.push(s);
    if (e) out.push(e);
  }
  return out;
}

/** All <dynam> elements with their resolved moments and parsed velocity (from
 *  @val if present, else from the dynamic-name map). Sorted ascending. */
export interface DynamRecord {
  el: Element;
  moment: Moment;
  text: string;
  velocity: number;
}
export function collectDynams(doc: Document, dynamicMap: Record<string, number>): DynamRecord[] {
  const measures = getMeasures(doc);
  const out: DynamRecord[] = [];
  for (const el of Array.from(doc.querySelectorAll('dynam'))) {
    const moment = readStartMoment(el, measures);
    if (!moment) continue;
    const text = (el.textContent ?? '').trim();
    const valAttr = el.getAttribute('val');
    let velocity: number;
    if (valAttr !== null) {
      const v = parseInt(valAttr, 10);
      velocity = isFinite(v) ? Math.max(0, Math.min(127, v)) : (dynamicMap[text] ?? 85);
    } else {
      velocity = dynamicMap[text] ?? 85;
    }
    out.push({ el, moment, text, velocity });
  }
  out.sort((a, b) => momentCompare(a.moment, b.moment));
  return out;
}

/** All <hairpin> elements with resolved start/end moments. */
export interface HairpinRecord {
  el: Element;
  start: Moment;
  end: Moment;
  form: 'cres' | 'dim';
}
export function collectHairpins(doc: Document): HairpinRecord[] {
  const measures = getMeasures(doc);
  const out: HairpinRecord[] = [];
  for (const el of Array.from(doc.querySelectorAll('hairpin'))) {
    const start = readStartMoment(el, measures);
    const end = readEndMoment(el, measures);
    if (!start || !end) continue;
    const formAttr = el.getAttribute('form');
    const form: 'cres' | 'dim' = formAttr === 'dim' ? 'dim' : 'cres';
    out.push({ el, start, end, form });
  }
  out.sort((a, b) => momentCompare(a.start, b.start));
  return out;
}

/* ── <extMeta> / <hkl:config> defaults ───────────────────────────────────── */

function findHklConfig(doc: Document): Element | null {
  const cfg = doc.getElementsByTagNameNS(HKL_NS, 'config');
  return cfg.length > 0 ? cfg[0] : null;
}

function ensureExtMetaConfig(doc: Document): Element {
  let cfg = findHklConfig(doc);
  if (cfg) return cfg;
  const meiHead = doc.querySelector('meiHead');
  if (!meiHead) throw new Error('meiHead missing');
  let extMeta = meiHead.querySelector('extMeta');
  if (!extMeta) {
    extMeta = createMei(doc, 'extMeta');
    meiHead.appendChild(extMeta);
  }
  cfg = doc.createElementNS(HKL_NS, 'hkl:config');
  extMeta.appendChild(cfg);
  /* Seed defaults so callers can always rely on the structure existing. */
  seedDefaults(cfg, doc);
  return cfg;
}

function seedDefaults(cfg: Element, doc: Document): void {
  /* dynamicMap */
  let dm = childInHklNs(cfg, 'dynamicMap');
  if (!dm) {
    dm = doc.createElementNS(HKL_NS, 'hkl:dynamicMap');
    cfg.appendChild(dm);
  }
  for (const name of DYNAMIC_NAMES) {
    const existing = Array.from(dm.children).find((c) =>
      c.namespaceURI === HKL_NS && c.localName === 'level' && c.getAttribute('name') === name);
    if (existing) continue;
    const level = doc.createElementNS(HKL_NS, 'hkl:level');
    level.setAttribute('name', name);
    level.setAttribute('velocity', String(DEFAULT_DYNAMIC_MAP[name]));
    dm.appendChild(level);
  }
}

function childInHklNs(parent: Element, localName: string): Element | null {
  for (const c of Array.from(parent.children)) {
    if (c.namespaceURI === HKL_NS && c.localName === localName) return c;
  }
  return null;
}

/** Initialise <extMeta>/<hkl:config> defaults if they're missing. Idempotent.
 *  Called on document creation and on load/migration. */
export function ensureExpressionDefaults(doc: Document): void {
  ensureExtMetaConfig(doc);
}

/** Read the document-level dynamic→velocity map. Falls back to defaults for
 *  any missing entry. */
export function getDynamicMap(doc: Document): Record<string, number> {
  const cfg = findHklConfig(doc);
  const out: Record<string, number> = { ...DEFAULT_DYNAMIC_MAP };
  if (!cfg) return out;
  const dm = childInHklNs(cfg, 'dynamicMap');
  if (!dm) return out;
  for (const lvl of Array.from(dm.children)) {
    if (lvl.namespaceURI !== HKL_NS || lvl.localName !== 'level') continue;
    const name = lvl.getAttribute('name');
    const velStr = lvl.getAttribute('velocity');
    if (!name || velStr === null) continue;
    const v = parseInt(velStr, 10);
    if (isFinite(v)) out[name] = Math.max(0, Math.min(127, v));
  }
  return out;
}

/** Write the dynamic→velocity map. Replaces existing levels by name. */
export function setDynamicMap(doc: Document, map: Record<string, number>): void {
  const cfg = ensureExtMetaConfig(doc);
  let dm = childInHklNs(cfg, 'dynamicMap');
  if (!dm) {
    dm = doc.createElementNS(HKL_NS, 'hkl:dynamicMap');
    cfg.appendChild(dm);
  }
  for (const [name, velocity] of Object.entries(map)) {
    let lvl = Array.from(dm.children).find((c) =>
      c.namespaceURI === HKL_NS && c.localName === 'level' && c.getAttribute('name') === name) ?? null;
    if (!lvl) {
      lvl = doc.createElementNS(HKL_NS, 'hkl:level');
      lvl.setAttribute('name', name);
      dm.appendChild(lvl);
    }
    lvl.setAttribute('velocity', String(Math.max(0, Math.min(127, velocity | 0))));
  }
}
