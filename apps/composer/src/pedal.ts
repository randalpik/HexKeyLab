// Sustain-pedal layer. CRUD on MEI <pedal> control events, time-anchored via
// @tstamp exactly like <dynam> in expressions.ts (NOT note-attached): a pedal
// mark survives deletion of nearby notes because it binds to a moment, not to
// any note's xml:id. Matches Max's expression-anchoring preference.
//
// Encoding: <pedal dir="down|up" tstamp=… staff="2"> as a sibling of <staff>
// in its measure (same insertion convention as <dynam>). @staff="2" attaches
// the mark to the bottom (bass) staff so Verovio renders the Ped./* glyph
// below the grand staff — the conventional piano position. There is no
// @place; pedal placement is below by Verovio default.
//
// No dangling-prune hook is needed (cf. <dynam>): tstamp-anchored events are
// removed together with their measure and never reference a note id, so they
// can't be orphaned by note deletion — unlike <fermata>/<breath>, which DO
// need pruneDanglingArticControls.
//
// Playback consumption lives in render/playback.ts.

import {
  type Moment, formatTstamp, absoluteTickForMoment, momentCompare,
} from './expressions.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export type PedalDir = 'down' | 'up';

let nextSeq = 4_000_000;
function newId(prefix: string): string {
  nextSeq++;
  return prefix + '-' + nextSeq.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

const TS_EPSILON = 1e-6;

function getMeasures(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll('measure'));
}

function readTstamp(el: Element): number | null {
  const t = el.getAttribute('tstamp');
  if (t === null) return null;
  const n = parseFloat(t);
  return isFinite(n) ? n : null;
}

/* ── CRUD ────────────────────────────────────────────────────────────────── */

/** Find a <pedal> at the given moment (optionally constrained to a direction). */
export function pedalAt(doc: Document, m: Moment, dir?: PedalDir): Element | null {
  const measure = getMeasures(doc)[m.measureIdx];
  if (!measure) return null;
  for (const child of Array.from(measure.children)) {
    if (child.localName !== 'pedal') continue;
    const t = readTstamp(child);
    if (t === null || Math.abs(t - m.tstamp) > TS_EPSILON) continue;
    if (dir && child.getAttribute('dir') !== dir) continue;
    return child;
  }
  return null;
}

/** Add a <pedal dir=…> at the moment. No-op-safe: a same-direction event
 *  already at this moment is returned as-is rather than duplicated. */
export function addPedal(doc: Document, at: Moment, dir: PedalDir): Element | null {
  const measure = getMeasures(doc)[at.measureIdx];
  if (!measure) return null;
  const existing = pedalAt(doc, at, dir);
  if (existing) return existing;
  const el = doc.createElementNS(MEI_NS, 'pedal');
  el.setAttributeNS(XML_NS, 'xml:id', newId('p'));
  el.setAttribute('dir', dir);
  el.setAttribute('tstamp', formatTstamp(at.tstamp));
  /* Bottom staff → Verovio renders the pedal glyph below the grand staff. */
  el.setAttribute('staff', '2');
  measure.appendChild(el);
  return el;
}

/** Remove the <pedal> of `dir` at the moment, if present. Returns true if one
 *  was removed. */
export function removePedalAt(doc: Document, m: Moment, dir: PedalDir): boolean {
  const el = pedalAt(doc, m, dir);
  if (el && el.parentNode) {
    el.parentNode.removeChild(el);
    return true;
  }
  return false;
}

/** Toggle the <pedal> of `dir` at the moment: remove if present, else add.
 *  Returns the new state (true = present, false = removed). */
export function togglePedal(doc: Document, at: Moment, dir: PedalDir): boolean {
  if (removePedalAt(doc, at, dir)) return false;
  addPedal(doc, at, dir);
  return true;
}

/* ── queries ─────────────────────────────────────────────────────────────── */

export interface PedalRecord {
  /** Absolute 64th-note tick offset (uniform-meter assumption — same model as
   *  absoluteTickForMoment used by the dynamics/hairpin velocity timeline). */
  tick: number;
  dir: PedalDir;
}

/** All <pedal> events with resolved absolute ticks, sorted ascending. */
export function collectPedals(doc: Document): PedalRecord[] {
  const measures = getMeasures(doc);
  const out: PedalRecord[] = [];
  for (const el of Array.from(doc.querySelectorAll('pedal'))) {
    const measure = el.closest('measure');
    if (!measure) continue;
    const idx = measures.indexOf(measure);
    if (idx < 0) continue;
    const t = readTstamp(el);
    if (t === null) continue;
    const dir: PedalDir = el.getAttribute('dir') === 'up' ? 'up' : 'down';
    out.push({ tick: absoluteTickForMoment(doc, { measureIdx: idx, tstamp: t }), dir });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}

/* ── pedal-layer cursor support (mirrors the expression layer) ─────────────── */

/** Resolved moments of every <pedal> mark (sorted ascending). The pedal-layer
 *  cursor unions these with note onsets — the same construction the expression
 *  cursor uses for its dynam/hairpin moments. */
export function pedalMoments(doc: Document): Moment[] {
  const measures = getMeasures(doc);
  const out: Moment[] = [];
  for (const el of Array.from(doc.querySelectorAll('pedal'))) {
    const measure = el.closest('measure');
    if (!measure) continue;
    const idx = measures.indexOf(measure);
    if (idx < 0) continue;
    const t = readTstamp(el);
    if (t === null) continue;
    out.push({ measureIdx: idx, tstamp: t });
  }
  out.sort(momentCompare);
  return out;
}

/** Every <pedal> element at the given moment (usually one; a coincident
 *  down+up is possible). */
export function pedalsAt(doc: Document, m: Moment): Element[] {
  const measure = getMeasures(doc)[m.measureIdx];
  if (!measure) return [];
  const out: Element[] = [];
  for (const child of Array.from(measure.children)) {
    if (child.localName !== 'pedal') continue;
    const t = readTstamp(child);
    if (t !== null && Math.abs(t - m.tstamp) <= TS_EPSILON) out.push(child);
  }
  return out;
}

/** Remove every <pedal> at the moment. Returns the count removed. */
export function removePedalsAt(doc: Document, m: Moment): number {
  const els = pedalsAt(doc, m);
  for (const el of els) el.parentNode?.removeChild(el);
  return els.length;
}
