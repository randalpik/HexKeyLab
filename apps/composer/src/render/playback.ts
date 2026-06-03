// Playback orchestration. Composer walks the MEI model to produce a timed
// sequence of chord/rest events, then dispatches them to HKL via the bridge
// as a `play-score` message. HKL drives its audio engine; for each chord
// onset HKL broadcasts a `playback-position` so Composer can highlight the
// sounding element. `playback-finished` clears all highlights.
//
// Tempo is read from the MEI <tempo> element (mm + mm.unit + mm.dots).
// Tied notes are coalesced PER NOTE via `data-tie-partner`: each note that
// attacks (no tie, or @tie="i") absorbs the durations of its forward chain
// partners into its own durationMs. Continuation notes (@tie="t" / "m")
// emit no attack. Partial-tie chords (only some notes tied across) yield
// multiple PlaybackEvents at the same atMs with different durationMs.

import type { ComposerModel, Voice } from '../model/index.js';
import { isTupletPlaceholder } from '../model/index.js';
import type { PlaybackEvent, CoordRef, PedalEvent } from '@hkl/bridge/protocol.js';
import {
  collectDynams, collectHairpins, getDynamicMap, absoluteTickForMoment,
  collectTempi, getGradualPercents, collectDirs,
} from '../expressions.js';
import { collectPedals } from '../pedal.js';
import { collectOctaves } from '../expressions.js';
import { collectSlurs } from '../slurs.js';
import { articulationsOn, type ArticKind } from '../articulations.js';
import { realTicks } from '../model/ticks.js';
import { DEFAULT_DYNAMIC_MAP } from '@hkl/shared/dynamics.js';

/* Articulation playback shaping constants. Tuned by ear; all configurable
 * here so a future Setup-dialog control can expose them. */
const STACCATO_FRACTION = 0.5;       /* shorten to half its written value */
const TENUTO_FRACTION = 1.0;         /* play to full written value (no gap) */
const FERMATA_HOLD_FACTOR = 1.5;     /* extend by 50% */
const ACCENT_VELOCITY_DELTA = 20;    /* +20 MIDI velocity */
const BREATH_DUR_FACTOR = 0.85;      /* shorten current note by 15% to leave a gap */

/** Read every articulation kind affecting the slot — on the slot element
 *  itself AND on any contained `<note>`. (A chord-internal selection can
 *  set the articulation on one note only; for playback we still flag the
 *  whole chord, since the audio is the chord, not a single voice within
 *  it.) */
function articulationsOnSlot(slot: Element): ArticKind[] {
  const acc = new Set<ArticKind>(articulationsOn(slot));
  if (slot.localName === 'chord') {
    for (const c of Array.from(slot.children)) {
      if (c.localName === 'note') for (const k of articulationsOn(c)) acc.add(k);
    }
  }
  return Array.from(acc);
}

interface ArticulationShape {
  velocity: number;
  durationFactor: number;
}

function shapeForArticulations(velocity: number, articKinds: ArticKind[]): ArticulationShape {
  let v = velocity;
  let durFactor = 1.0;
  for (const k of articKinds) {
    if (k === 'stacc') durFactor = Math.min(durFactor, STACCATO_FRACTION);
    else if (k === 'ten') durFactor = Math.max(durFactor, TENUTO_FRACTION);
    else if (k === 'fermata') durFactor = durFactor * FERMATA_HOLD_FACTOR;
    else if (k === 'breath') durFactor = Math.min(durFactor, BREATH_DUR_FACTOR);
    else if (k === 'accent') v = Math.max(1, Math.min(127, v + ACCENT_VELOCITY_DELTA));
  }
  return { velocity: v, durationFactor: durFactor };
}

const DEFAULT_BPM = 120;
const MS_PER_MIN = 60_000;
const DEFAULT_VELOCITY = DEFAULT_DYNAMIC_MAP.mf;
/* Synthesized cres/dim swell when a hairpin has no flanking dynamic. Re-scaled
   for the canonical musical-velocity domain (dynamics now span ~21..127 instead
   of the old 96..127 cluster), so a similar perceptual swell needs a larger
   delta. Tunable by ear. */
const HAIRPIN_OPEN_END_DELTA = 45;

/* Pizz/arco (phase 5): a "pizz."/"arco" <dir> cue switches a voice's sounding
 * timbre to a pizzicato sample-set variant for the notes it governs, until the
 * next contradicting cue. ARTIC_VARIANTS maps a base instrument key → its OWN
 * shipped pizzicato variant. We only ship viola_pizz so far, so an instrument
 * without its own variant falls back to ANY library pizz (Max: "I'd rather
 * hear viola pizz than no pizz for any other string"). Extend this map (and
 * ship the matching `<key>_pizz.hki`) to give an instrument its true pizz.
 * main.ts's preload broadcast loads all these variants before playback. */
export const ARTIC_VARIANTS: Readonly<Record<string, string>> = { viola: 'viola_pizz' };

/** All pizzicato variant keys shipped in the library (for the preload set). */
export const PIZZ_VARIANTS: ReadonlyArray<string> = [...new Set(Object.values(ARTIC_VARIANTS))];

/** The pizzicato sample-set to sound for `baseKey` under a pizz cue: its own
 *  variant if it has one, else any library pizz (fallback). null only if the
 *  library ships no pizz at all. */
export function pizzVariantFor(baseKey: string): string | null {
  return ARTIC_VARIANTS[baseKey] ?? PIZZ_VARIANTS[0] ?? null;
}

/** Classify a <dir>'s text as a sounding-articulation cue, or null if it's not
 *  one. Tolerant of a trailing period and case ("Pizz." → 'pizz'). */
function articCue(text: string): 'pizz' | 'arco' | null {
  const t = text.trim().toLowerCase().replace(/\.$/, '');
  if (t === 'pizz') return 'pizz';
  if (t === 'arco') return 'arco';
  return null;
}

/** Build a per-staff piecewise lookup of the active articulation cue. Returns
 *  `cueAt(staff, tick)` = the latest pizz/arco cue on that staff at-or-before
 *  the tick (null if none). Mirrors buildVelocityLookup's piecewise-constant
 *  shape; cue ticks are absolute written ticks (repeat-invariant, like
 *  velocity — a replayed note reuses the cue at its original tick). */
function buildArticCueLookup(doc: Document): (staff: number, tick: number) => 'pizz' | 'arco' | null {
  const byStaff = new Map<number, Array<{ tick: number; cue: 'pizz' | 'arco' }>>();
  for (const d of collectDirs(doc)) {
    const cue = articCue(d.text);
    if (!cue) continue;
    const tick = absoluteTickForMoment(doc, d.moment);
    const list = byStaff.get(d.staff) ?? [];
    list.push({ tick, cue });
    byStaff.set(d.staff, list);
  }
  for (const list of byStaff.values()) list.sort((a, b) => a.tick - b.tick);
  return (staff, tick) => {
    const list = byStaff.get(staff);
    if (!list) return null;
    let cue: 'pizz' | 'arco' | null = null;
    for (const c of list) {
      if (c.tick <= tick + 1e-6) cue = c.cue;
      else break;
    }
    return cue;
  };
}

export interface TempoInfo { bpm: number; unitDenom: number; dots: number }

export function readTempo(doc: Document): TempoInfo {
  const t = doc.querySelector('tempo');
  const bpmAttr = t?.getAttribute('mm') ?? t?.getAttribute('midi.bpm');
  const bpm = bpmAttr ? parseFloat(bpmAttr) : DEFAULT_BPM;
  const unit = parseInt(t?.getAttribute('mm.unit') ?? '4', 10);
  const dots = parseInt(t?.getAttribute('mm.dots') ?? '0', 10);
  return { bpm: isFinite(bpm) ? bpm : DEFAULT_BPM, unitDenom: unit, dots };
}

/** ms per 64th-note tick given the tempo. The tempo's "beat" is a note of
 *  duration unitDenom (possibly dotted). One beat in ticks = (64/unitDenom)
 *  * (1, 1.5, 1.75 for dots 0/1/2). */
export function tickMsFromTempo(tempo: TempoInfo): number {
  const beatTicks = (64 / tempo.unitDenom) * (tempo.dots === 1 ? 1.5 : tempo.dots === 2 ? 1.75 : 1);
  const msPerBeat = MS_PER_MIN / tempo.bpm;
  return msPerBeat / beatTicks;
}

/* ── tempo timeline (instant + gradual rit/accel retiming) ──────────────────
 *
 * The playback clock is no longer a single constant ms/tick. It's a piecewise-
 * LINEAR-in-beat-period function `tickMsAt(tick)`: instant <tempo> marks step
 * it; gradual rit/accel marks ramp it linearly between the bpm before the mark
 * and a target bpm. `atMsAt(tick)` is the trapezoidal integral from tick 0, so
 * a note's onset/duration reflect every preceding tempo change (including a
 * tempo change mid-note). Gradual target resolution (confirmed with Max):
 * explicit @tstamp2 / next instant tempo's bpm / intensity-% (poco·plain·molto);
 * "a tempo" restores the bpm in effect before the gradual began. */

function beatTicksFor(unit: number, dots: number): number {
  return (64 / unit) * (dots === 1 ? 1.5 : dots === 2 ? 1.75 : 1);
}
function msPerTickAt(bpm: number, unit: number, dots: number): number {
  return (MS_PER_MIN / Math.max(1, bpm)) / beatTicksFor(unit, dots);
}

interface TempoSegment {
  startTick: number; endTick: number;
  msStart: number; msEnd: number;
  cumStartMs: number; /* integrated ms at startTick */
}
export interface TempoTimeline {
  tickMsAt: (t: number) => number;
  atMsAt: (t: number) => number;
}

export function buildTempoTimeline(mei: Document): TempoTimeline {
  const measureCount = mei.querySelectorAll('measure').length;
  /* True total tick = cumulative start of the past-end measure (per-measure
     meter aware — handles mid-piece meter changes). */
  const pieceEndTick = Math.max(1, absoluteTickForMoment(mei, { measureIdx: measureCount, tstamp: 1 }));
  const pct = getGradualPercents(mei);

  const tempi = collectTempi(mei)
    .map((r) => ({
      ...r,
      tick: absoluteTickForMoment(mei, r.moment),
      endTickAbs: r.end ? absoluteTickForMoment(mei, r.end) : null,
    }))
    .sort((a, b) => a.tick - b.tick);

  let curBpm = DEFAULT_BPM, curUnit = 4, curDots = 0;
  let preGradualBpm = curBpm;
  let cursorTick = 0;
  let cumMs = 0;
  const segs: TempoSegment[] = [];
  const pushSeg = (startTick: number, endTick: number, msStart: number, msEnd: number): void => {
    if (endTick <= startTick) return;
    segs.push({ startTick, endTick, msStart, msEnd, cumStartMs: cumMs });
    cumMs += (msStart + msEnd) / 2 * (endTick - startTick);
  };

  for (let i = 0; i < tempi.length; i++) {
    const ev = tempi[i];
    const evTick = Math.max(cursorTick, Math.min(ev.tick, pieceEndTick));
    if (evTick > cursorTick) {
      const ms = msPerTickAt(curBpm, curUnit, curDots);
      pushSeg(cursorTick, evTick, ms, ms);
      cursorTick = evTick;
    }
    if (ev.gradual) {
      preGradualBpm = curBpm;
      const next = tempi[i + 1];
      const nextTick = next ? next.tick : pieceEndTick;
      let endTick = ev.endTickAbs ?? nextTick;
      endTick = Math.min(endTick, nextTick, pieceEndTick);
      endTick = Math.max(endTick, evTick + 1);
      let targetBpm: number;
      if (next && next.tick <= endTick + 1e-6 && next.bpm != null && !next.gradual && !next.aTempo) {
        targetBpm = next.bpm; /* interpolate to the explicitly-defined next tempo */
      } else {
        const p = (pct[ev.intensity] ?? 0) / 100;
        targetBpm = ev.gradual === 'rit' ? curBpm * (1 - p) : curBpm * (1 + p);
      }
      targetBpm = Math.max(10, targetBpm);
      pushSeg(evTick, endTick, msPerTickAt(curBpm, curUnit, curDots), msPerTickAt(targetBpm, curUnit, curDots));
      cursorTick = endTick;
      curBpm = targetBpm;
    } else if (ev.aTempo) {
      curBpm = preGradualBpm;
    } else if (ev.bpm != null) {
      curBpm = ev.bpm; curUnit = ev.unit; curDots = ev.dots;
    }
    /* verbal-only instant marks have no timing effect */
  }
  if (pieceEndTick > cursorTick) {
    const ms = msPerTickAt(curBpm, curUnit, curDots);
    pushSeg(cursorTick, pieceEndTick, ms, ms);
  }
  if (segs.length === 0) {
    const ms = msPerTickAt(DEFAULT_BPM, 4, 0);
    segs.push({ startTick: 0, endTick: pieceEndTick, msStart: ms, msEnd: ms, cumStartMs: 0 });
  }
  const lastSeg = segs[segs.length - 1];

  const segAt = (t: number): TempoSegment => {
    if (t <= segs[0].startTick) return segs[0];
    for (const s of segs) if (t >= s.startTick && t < s.endTick) return s;
    return lastSeg;
  };
  return {
    tickMsAt(t: number): number {
      const s = segAt(t);
      const L = s.endTick - s.startTick;
      const u = L > 0 ? Math.max(0, Math.min(1, (t - s.startTick) / L)) : 0;
      return s.msStart + (s.msEnd - s.msStart) * u;
    },
    atMsAt(t: number): number {
      if (t <= 0) return 0;
      const s = segAt(t);
      const L = s.endTick - s.startTick;
      const tau = Math.max(0, Math.min(t, s.endTick) - s.startTick);
      const slope = L > 0 ? (s.msEnd - s.msStart) / L : 0;
      let ms = s.cumStartMs + s.msStart * tau + 0.5 * slope * tau * tau;
      if (t > lastSeg.endTick) ms += (t - lastSeg.endTick) * lastSeg.msEnd; /* extrapolate past end */
      return ms;
    },
  };
}

/** Absolute playback ms at a tick offset, used to compute the cursor-seek
 *  start offset under the live tempo timeline. */
export function playbackStartMs(model: ComposerModel, startTicks: number): number {
  if (startTicks <= 0) return 0;
  const mei = new DOMParser().parseFromString(model.serialize(), 'application/xml');
  return buildTempoTimeline(mei).atMsAt(startTicks);
}

function elementDurationTicks(el: Element): number {
  return realTicks(el);
}

function extractCoords(noteEl: Element): CoordRef | null {
  const qs = noteEl.getAttribute('data-q');
  const rs = noteEl.getAttribute('data-r');
  if (qs === null || rs === null) return null;
  const q = parseInt(qs, 10);
  const r = parseInt(rs, 10);
  return Number.isFinite(q) && Number.isFinite(r) ? { q, r } : null;
}

/** Diatonic pitch rank (oct·7 + step) for ordering a chord's written notes. */
function pitchRank(noteEl: Element): number {
  const oct = parseInt(noteEl.getAttribute('oct') ?? '4', 10);
  const pn = (noteEl.getAttribute('pname') ?? 'c').toLowerCase();
  return (Number.isFinite(oct) ? oct : 4) * 7 + Math.max(0, 'cdefgab'.indexOf(pn));
}

/** The diamond (harmonic) note of a slot + its reference: the NEXT-LOWEST note
 *  directly below the diamond (the stopped note of an artificial harmonic).
 *  Reference is null for a natural harmonic (diamond alone / lowest). The
 *  diamond is the `head.shape="diamond"` note (toggle marks the highest), else
 *  the highest note as a fallback. */
function harmonicParts(noteEls: Element[]): { diamond: Element | null; ref: Element | null } {
  if (noteEls.length === 0) return { diamond: null, ref: null };
  let diamond = noteEls.find((n) => n.getAttribute('head.shape') === 'diamond') ?? null;
  if (!diamond) diamond = noteEls.reduce((a, b) => (pitchRank(b) > pitchRank(a) ? b : a), noteEls[0]);
  const dRank = pitchRank(diamond);
  let ref: Element | null = null;
  for (const n of noteEls) {
    if (n === diamond) continue;
    if (pitchRank(n) < dRank && (ref === null || pitchRank(n) > pitchRank(ref))) ref = n;
  }
  return { diamond, ref };
}

/** Compute the SOUNDING coord of a string harmonic from its diamond + the
 *  next-lowest reference note (Max's rules):
 *   - Natural (no reference below the diamond): +1 octave (q+3) above diamond.
 *   - Artificial: the interval from the reference up to the diamond decides —
 *     P4 → 2 octaves above the reference (q+6); M3 → 2 octaves + P5 above the
 *     reference (q+6, r+1); anything else → +1 octave above the diamond.
 *  Coord deltas: octave = q+3 (band structure), P5 = r+1, M3 = q+1,
 *  P4 = octave−P5 = (q+3, r−1). Returns null if the diamond lacks coords. */
function harmonicSoundingCoord(diamond: Element, ref: Element | null): CoordRef | null {
  const d = extractCoords(diamond);
  if (!d) return null;
  const lo = ref ? extractCoords(ref) : null;
  if (!lo) return { q: d.q + 3, r: d.r };                          /* natural → +octave */
  const dq = d.q - lo.q, dr = d.r - lo.r;
  if (dq === 1 && dr === 0) return { q: lo.q + 6, r: lo.r + 1 };    /* M3 → 2 oct + P5 */
  if (dq === 3 && dr === -1) return { q: lo.q + 6, r: lo.r };       /* P4 → 2 oct */
  return { q: d.q + 3, r: d.r };                                    /* fallback → +octave */
}

/** The slot-bearing element for a note. A note inside a chord inherits the
 *  chord's duration; a top-level note carries its own. */
function slotElementForNote(noteEl: Element): Element {
  const p = noteEl.parentNode as Element | null;
  return p && p.localName === 'chord' ? p : noteEl;
}

/** Build an `xml:id` → element map for all `<note>` elements in the doc.
 *  `Document.getElementById` doesn't see `xml:id` in an XML-parsed document
 *  (only DTD-declared ID attributes), so we materialize a lookup table for
 *  the tie-partner chain walk. */
function buildNoteIdIndex(mei: Document): Map<string, Element> {
  const out = new Map<string, Element>();
  for (const n of Array.from(mei.getElementsByTagName('note'))) {
    const id = n.getAttribute('xml:id');
    if (id) out.set(id, n);
  }
  return out;
}

/** Walk a note's forward `data-tie-partner` chain and return the total
 *  coalesced duration in ticks (including the note's own slot). Caller
 *  should only invoke this for notes that actually attack (i.e. not
 *  `tie="t"` / `tie="m"`); if the note has no outgoing tie this returns
 *  just its own slot's ticks. */
function coalescedDurationTicks(noteEl: Element, noteById: Map<string, Element>): number {
  let total = elementDurationTicks(slotElementForNote(noteEl));
  const tie = noteEl.getAttribute('tie');
  if (tie !== 'i') return total;
  let current: Element | null = noteEl;
  while (current) {
    const partnerId = current.getAttribute('data-tie-partner');
    if (!partnerId) break;
    const next = noteById.get(partnerId);
    if (!next) break;
    total += elementDurationTicks(slotElementForNote(next));
    if (next.getAttribute('tie') === 't') break;
    current = next;
  }
  return total;
}

/* ── velocity timeline ───────────────────────────────────────────────────── */

interface VelocityLookup {
  /** Return the velocity at the given absolute 64th-note tick. */
  at: (tick: number) => number;
}

function buildVelocityLookup(doc: Document): VelocityLookup {
  const dynMap = getDynamicMap(doc);
  const dynams = collectDynams(doc, dynMap)
    .map((d) => ({ tick: absoluteTickForMoment(doc, d.moment), velocity: d.velocity, rec: d }));
  const hairpins = collectHairpins(doc)
    .map((h) => ({
      startTick: absoluteTickForMoment(doc, h.start),
      endTick: absoluteTickForMoment(doc, h.end),
      form: h.form,
      rec: h,
    }))
    .filter((h) => h.endTick > h.startTick); /* Reject degenerate zero-length spans */

  /* Piecewise-constant lookup of the dynamic level at-or-before a tick. */
  function levelBefore(tick: number): number {
    let level = DEFAULT_VELOCITY;
    for (const d of dynams) {
      if (d.tick <= tick + 1e-6) level = d.velocity;
      else break; /* dynams sorted ascending */
    }
    return level;
  }
  function nextDynamAfter(tick: number, upToTick: number): number | null {
    for (const d of dynams) {
      if (d.tick > tick + 1e-6 && d.tick <= upToTick + 1e-6) return d.velocity;
    }
    return null;
  }

  return {
    at(tick: number): number {
      const baseLevel = levelBefore(tick);

      /* Find the LATEST-STARTING hairpin whose range contains this tick.
         If multiple overlap, the latest-started wins (matches "more recent
         user intent"). */
      let active: typeof hairpins[number] | null = null;
      for (const h of hairpins) {
        if (h.startTick <= tick + 1e-6 && tick <= h.endTick + 1e-6) {
          if (!active || h.startTick > active.startTick) active = h;
        }
      }
      if (!active) return clampVel(baseLevel);

      /* Start level: level at the hairpin's start (which might be a dynam
         at the start, or the level inherited from before). */
      const startLevel = levelBefore(active.startTick);
      /* End level: explicit dynam at the hairpin's end (within the span),
         else synthesized ±delta. */
      const explicitEnd = nextDynamAfter(active.startTick, active.endTick);
      const endLevel = explicitEnd !== null
        ? explicitEnd
        : clampVel(startLevel + (active.form === 'cres' ? HAIRPIN_OPEN_END_DELTA : -HAIRPIN_OPEN_END_DELTA));

      const span = active.endTick - active.startTick;
      const t = span > 0 ? (tick - active.startTick) / span : 0;
      const u = Math.max(0, Math.min(1, t));
      return clampVel(startLevel + (endLevel - startLevel) * u);
    },
  };
}

function clampVel(v: number): number {
  return Math.max(1, Math.min(127, Math.round(v)));
}

/** Static trill/tremolo alternation speed: ms per alternation note. A
 *  reasonable ~10/sec; tunable later alongside other playback refinements. */
const TRILL_NOTE_MS = 100;

/** One played occurrence of a measure: its document index plus which pass
 *  (1 = first time through, 2 = repeat pass). `pass` drives volta selection. */
export interface PlayedMeasure { measureIdx: number; pass: number; }

/** A canonical (pre-repeat-expansion) event, tagged with the document index
 *  of its measure so repeat expansion can re-stamp its `atMs` per played
 *  occurrence. `_mi` is internal and never crosses the bridge. */
type CanonEvent = PlaybackEvent & { _mi: number; _tick?: number };

/** True if the score has any repeat barline or ending (volta). When false,
 *  buildPlayback keeps its original linear path unchanged. */
function hasRepeatStructure(mei: Document): boolean {
  for (const m of Array.from(mei.querySelectorAll('measure'))) {
    if (m.getAttribute('left') === 'rptstart') return true;
    const right = m.getAttribute('right');
    if (right === 'rptend') return true;
  }
  return mei.querySelector('ending') !== null;
}

/** The ending number a measure belongs to (1, 2, …), or null if it's not
 *  inside an <ending>. Reads the first token of @n ("1 2" → 1). */
function endingNumberOf(measure: Element): number | null {
  const ending = measure.closest('ending');
  if (!ending) return null;
  const tok = (ending.getAttribute('n') ?? '').trim().split(/\s+/)[0];
  const v = parseInt(tok, 10);
  return Number.isFinite(v) ? v : null;
}

/** Expand repeat barlines + voltas into the order measures actually sound.
 *  Start-aware (backlog line 96): a backward repeat is honored only when its
 *  repeat-start was seen at/after `startIdx` — or, for an implicit repeat
 *  with no rptstart, only when starting from the top. Starting INSIDE a
 *  repeated body plays it through linearly without replaying. Each repeat is
 *  capped at 2 passes (no >2× or nested repeats in v1). */
export function expandPlayOrder(mei: Document, startIdx = 0): PlayedMeasure[] {
  const measures = Array.from(mei.querySelectorAll('measure'));
  const n = measures.length;
  const order: PlayedMeasure[] = [];
  const takenRepeats = new Set<number>();
  const passByStart = new Map<number, number>();
  let repeatStart = -1; /* doc index of the most recent rptstart seen */
  let curPass = 1;
  let i = Math.max(0, startIdx);
  let guard = 0;
  while (i < n && guard++ < 100000) {
    const m = measures[i];
    if (m.getAttribute('left') === 'rptstart' && i >= startIdx) {
      repeatStart = i;
      curPass = passByStart.get(i) ?? 1;
    }
    const honored = repeatStart >= 0 || startIdx === 0;
    const en = endingNumberOf(m);
    if (en !== null && en !== curPass && honored) { i++; continue; }
    order.push({ measureIdx: i, pass: curPass });
    if (m.getAttribute('right') === 'rptend' && honored && !takenRepeats.has(i)) {
      takenRepeats.add(i);
      const target = repeatStart >= 0 ? repeatStart : 0;
      const np = curPass + 1;
      passByStart.set(target, np);
      curPass = np;
      i = target;
      continue;
    }
    i++;
  }
  return order;
}

/** Walk every voice across every measure; emit one PlaybackEvent per
 *  attack (rests advance time silently; tied chains coalesce).
 *
 *  When `startMs > 0`, events whose `atMs` falls before `startMs` are
 *  dropped and the remaining events are shifted left by `startMs` — i.e.
 *  the playhead starts at that offset; notes that were already sounding
 *  at the cursor do NOT get re-attacked (DAW-standard non-retrigger
 *  semantics; matches Pro Tools / FL Studio). */
export function buildPlayback(model: ComposerModel, startMs = 0): PlaybackEvent[] {
  const events: CanonEvent[] = [];
  const mei = new DOMParser().parseFromString(model.serialize(), 'application/xml');
  const isMultiInstrument = model.instruments().length > 1;
  const tempo = buildTempoTimeline(mei);
  const velocity = buildVelocityLookup(mei);
  const articCueAt = buildArticCueLookup(mei);
  const noteById = buildNoteIdIndex(mei);
  /* 8va/8vb spans: a note on the bracketed staff within the span sounds an
     octave shifted (q ± 3 per octave). Returns the q-shift for (staff, tick). */
  const octaves = collectOctaves(mei);
  const octaveQShift = (staff: number, tick: number): number => {
    let shift = 0;
    for (const o of octaves) {
      if (o.staff === staff && tick >= o.startTick - 1e-6 && tick < o.endTick - 1e-6) shift += o.qShift;
    }
    return shift;
  };

  /* Trill anchors: slot xml:id → the alternation cell (the SECOND source note's
     exact lattice position, preserved on the kept note as data-hkl-trill-q/r).
     A trill with no stored alt cell (voice-mode, single note) plays as a plain
     note. */
  const trillAlt = new Map<string, CoordRef | null>();
  for (const tr of Array.from(mei.querySelectorAll('trill'))) {
    const sid = (tr.getAttribute('startid') ?? '').replace('#', '');
    if (!sid) continue;
    const slot = mei.querySelector(`[*|id="${sid}"]`);
    const qs = slot?.getAttribute('data-hkl-trill-q');
    const rs = slot?.getAttribute('data-hkl-trill-r');
    const q = qs !== null && qs !== undefined ? parseInt(qs, 10) : NaN;
    const r = rs !== null && rs !== undefined ? parseInt(rs, 10) : NaN;
    trillAlt.set(sid, Number.isFinite(q) && Number.isFinite(r) ? { q, r } : null);
  }

  /* All coords (chord members or single note) of a slot, with the 8va shift
     applied. */
  const slotCoords = (slot: Element, qShift: number): CoordRef[] => {
    const noteEls = slot.localName === 'note'
      ? [slot]
      : Array.from(slot.children).filter((n) => n.localName === 'note');
    const out: CoordRef[] = [];
    for (const n of noteEls) {
      const c = extractCoords(n);
      if (c) out.push(qShift !== 0 ? { q: c.q + qShift, r: c.r } : c);
    }
    return out;
  };

  /* Expand a trill/tremolo into a rapid alternation across [startTick,
     startTick+spanTicks]. `groups` is the alternation cycle (e.g. [[main],
     [upper]] for a trill, [[noteA],[noteB]] for a tremolo); each emitted note
     is slurred to the next so HKL applies the instrument's glide/overlap. The
     speed is a static ~TRILL_NOTE_MS per note (tunable later). */
  const emitAlternation = (
    groups: CoordRef[][], startTick: number, spanTicks: number,
    meiId: string | undefined, vel: number, voice: Voice, mi: number,
  ): void => {
    const cycle = groups.filter((g) => g.length > 0);
    if (!cycle.length || spanTicks <= 0) return;
    const startMs = tempo.atMsAt(startTick);
    const spanMs = tempo.atMsAt(startTick + spanTicks) - startMs;
    if (spanMs <= 0) return;
    const count = Math.max(cycle.length, Math.round(spanMs / TRILL_NOTE_MS));
    const sliceMs = spanMs / count;
    for (let k = 0; k < count; k++) {
      events.push({
        atMs: startMs + k * sliceMs,
        durationMs: sliceMs,
        notes: cycle[k % cycle.length],
        meiId,
        velocity: vel,
        voice,
        slurredToNext: k < count - 1,
        _mi: mi,
        _tick: startTick,
      });
    }
  };

  for (let voice: Voice = 1; voice <= model.totalVoices(); voice = (voice + 1) as Voice) {
    const staffN = model.staffForVoice(voice);
    const layerN = model.layerForVoice(voice);
    /* The instrument this voice belongs to — tags every event it emits so HKL
       can route per-instrument timbre. (Structural: the model's instrument
       table matches the serialized `mei`.) Only tagged for MULTI-instrument
       scores; a single-instrument score leaves instrumentKey absent so HKL
       plays through its current active instrument (the historic behavior —
       the user picks the sound in HKL, not from the model's "piano" default). */
    const voiceInstrKey = isMultiInstrument ? model.instrumentOf(voice).instrKey : undefined;
    const voiceEventStart = events.length;
    /* Walk all measures' layers for this voice. `streamMi[k]` records the
       document measure index of stream element k, so events can be tagged
       for repeat expansion. */
    const measures = Array.from(mei.querySelectorAll('measure'));
    const stream: Element[] = [];
    const streamMi: number[] = [];
    for (let mi = 0; mi < measures.length; mi++) {
      const layer = Array.from(measures[mi].querySelectorAll(`staff[n="${staffN}"] layer[n="${layerN}"]`))[0];
      if (!layer) continue;
      /* Layer may have <beam> wrappers in the rendered MEI; descend to actual
         content children. */
      const before = stream.length;
      pushContentChildren(layer, stream);
      for (let k = before; k < stream.length; k++) streamMi[k] = mi;
    }

    /* Slur spans for this voice, as inclusive [lo, hi] stream-index ranges.
       Endpoints are slot ids (note or chord), which are the stream elements. */
    const voiceSlurs: Array<{ lo: number; hi: number }> = [];
    for (const s of collectSlurs(mei)) {
      if (s.voice !== voice) continue;
      const si = stream.findIndex((e) => e.getAttribute('xml:id') === s.startId);
      const ei = stream.findIndex((e) => e.getAttribute('xml:id') === s.endId);
      if (si >= 0 && ei >= 0) voiceSlurs.push({ lo: Math.min(si, ei), hi: Math.max(si, ei) });
    }
    /* Two attacks at stream indices a < b are slur-joined iff one span
       contains both. */
    const slurJoins = (a: number, b: number): boolean =>
      voiceSlurs.some((sp) => sp.lo <= a && b <= sp.hi);
    /* The previous attack slot in this voice: its stream index + the indices
       of the event(s) it emitted (a partial-tie chord emits several). When the
       next attack is slur-joined, we back-patch slurredToNext onto those. */
    let prevAttack: { streamIdx: number; eventIdxs: number[] } | null = null;

    let tTicks = 0;
    let i = 0;
    while (i < stream.length) {
      const child = stream[i];
      const local = child.localName;
      const ticks = elementDurationTicks(child);

      if (local === 'space') {
        /* (placeholder) spaces advance the voice clock silently. Including
           spaces in the stream lets a voice that's empty in some measures
           correctly time-shift its later content. */
        tTicks += ticks;
        i++;
        continue;
      }
      if (local === 'rest') {
        /* Visible rests emit a silent PlaybackEvent (notes: []) so HKL's
           scheduler echoes a `playback-position` with the rest's meiId at
           its onset — the per-voice playback cursor steps through rests
           instead of skipping past them. Tuplet placeholders are invisible
           (suppressed by CSS) and not cursor stops, so they stay silent. */
        if (!isTupletPlaceholder(child)) {
          const meiId = child.getAttribute('xml:id') ?? undefined;
          if (meiId) {
            events.push({
              atMs: tempo.atMsAt(tTicks),
              durationMs: tempo.atMsAt(tTicks + ticks) - tempo.atMsAt(tTicks),
              notes: [],
              meiId,
              voice,
              _mi: streamMi[i],
              _tick: tTicks,
            });
          }
        }
        tTicks += ticks;
        i++;
        continue;
      }

      /* Tremolo: alternate between the two (or one) wrapped slots' EXACT
         lattice cells across the wrapper's span. */
      if (local === 'fTrem' || local === 'bTrem') {
        const qShift = octaveQShift(staffN, tTicks);
        const groups = Array.from(child.children)
          .filter((n) => n.localName === 'note' || n.localName === 'chord')
          .map((slot) => slotCoords(slot, qShift));
        emitAlternation(groups, tTicks, ticks, child.getAttribute('xml:id') ?? undefined,
          velocity.at(tTicks), voice, streamMi[i]);
        prevAttack = null; /* a tremolo is its own legato unit */
        tTicks += ticks;
        i++;
        continue;
      }

      /* Trill: a note/chord carrying a <trill>. Alternate between its cell and
         the preserved alternation cell (the second source note); if none was
         stored (voice-mode single-note trill), it plays as a plain note. */
      const slotId = child.getAttribute('xml:id') ?? undefined;
      if ((local === 'note' || local === 'chord') && slotId && trillAlt.has(slotId)) {
        const qShift = octaveQShift(staffN, tTicks);
        const base = slotCoords(child, qShift);
        const alt = trillAlt.get(slotId);
        const groups = alt ? [base, [{ q: alt.q + qShift, r: alt.r }]] : [base];
        emitAlternation(groups, tTicks, ticks, slotId, velocity.at(tTicks), voice, streamMi[i]);
        prevAttack = null;
        tTicks += ticks;
        i++;
        continue;
      }

      /* Per-note attack collection. Ties are followed individually via
         `data-tie-partner` so partial-tie chords (only some notes tied)
         produce correct per-pitch durations. Notes that are tie continuations
         (`tie="t"` / `tie="m"`) emit no attack — they were already coalesced
         into their predecessor's duration. */
      const noteEls: Element[] = local === 'note'
        ? [child]
        : Array.from(child.children).filter((n) => n.localName === 'note');

      const byDuration = new Map<number, CoordRef[]>();
      const isHarmonic = child.getAttribute('data-hkl-harmonic') === 'true';
      const { diamond, ref } = isHarmonic ? harmonicParts(noteEls) : { diamond: null, ref: null };
      const harmonicCoord = diamond ? harmonicSoundingCoord(diamond, ref) : null;
      if (harmonicCoord) {
        /* String harmonic: the diamond sounds its computed harmonic pitch; the
           reference (next-lowest, the stopped note) is consumed (silent); every
           OTHER chord note sounds at its written pitch (so a harmonic in a
           larger chord never silences the rest). 8va composes on top. */
        const qShift = octaveQShift(staffN, tTicks);
        const coords: CoordRef[] = [];
        for (const n of noteEls) {
          const t = n.getAttribute('tie');
          if (t === 't' || t === 'm') continue;
          if (n === ref) continue;
          const c = n === diamond ? harmonicCoord : extractCoords(n);
          if (!c) continue;
          coords.push(qShift !== 0 ? { q: c.q + qShift, r: c.r } : c);
        }
        if (coords.length > 0) byDuration.set(elementDurationTicks(child), coords);
      } else {
        for (const n of noteEls) {
          const t = n.getAttribute('tie');
          if (t === 't' || t === 'm') continue;
          const coord = extractCoords(n);
          if (!coord) continue;
          const qShift = octaveQShift(staffN, tTicks);
          const shifted = qShift !== 0 ? { q: coord.q + qShift, r: coord.r } : coord;
          const durTicks = coalescedDurationTicks(n, noteById);
          const list = byDuration.get(durTicks) ?? [];
          list.push(shifted);
          byDuration.set(durTicks, list);
        }
      }

      if (byDuration.size > 0) {
        const meiId = child.getAttribute('xml:id') ?? undefined;
        const baseVel = velocity.at(tTicks);
        const atMs = tempo.atMsAt(tTicks);
        const articKinds = articulationsOnSlot(child);
        const shape = shapeForArticulations(baseVel, articKinds);
        const emittedIdxs: number[] = [];
        for (const [durTicks, notes] of byDuration) {
          emittedIdxs.push(events.length);
          /* Real elapsed ms over the note's tick span — correct even if a
             tempo change falls inside the note. Articulation factor scales it. */
          const writtenMs = tempo.atMsAt(tTicks + durTicks) - tempo.atMsAt(tTicks);
          events.push({
            atMs,
            durationMs: writtenMs * shape.durationFactor,
            notes,
            meiId,
            velocity: shape.velocity,
            voice,
            _mi: streamMi[i],
            _tick: tTicks,
          });
        }
        /* If this attack is slur-joined to the previous one in this voice,
           mark the previous attack's events as slurredToNext. */
        if (prevAttack && slurJoins(prevAttack.streamIdx, i)) {
          for (const ei of prevAttack.eventIdxs) events[ei].slurredToNext = true;
        }
        prevAttack = { streamIdx: i, eventIdxs: emittedIdxs };
      }

      /* Always advance one slot. tie-terminal notes in later slots will
         naturally emit no attacks; tie-initial notes already absorbed
         their continuation pieces into their own durationMs above. */
      tTicks += ticks;
      i++;
    }
    /* Tag every event this voice emitted (incl. emitAlternation pushes) with
       its instrument's sample-set key for per-instrument playback routing. A
       pizz./arco <dir> cue on this voice's staff overrides the key to the
       pizzicato variant for the notes it governs (until the next contradicting
       cue); the cue is keyed on the event's ORIGINAL written tick, so it's
       repeat-invariant like velocity. */
    if (voiceInstrKey) {
      const pizzKey = pizzVariantFor(voiceInstrKey);
      for (let k = voiceEventStart; k < events.length; k++) {
        let key = voiceInstrKey;
        if (pizzKey && events[k]._tick !== undefined && articCueAt(staffN, events[k]._tick!) === 'pizz') {
          key = pizzKey;
        }
        events[k].instrumentKey = key;
      }
    }
    if (voice >= model.totalVoices()) break;
  }

  /* Cross-instrument same-pitch / same-onset conflict resolution. HKL keys
     audio voices by (q, r), so two instruments sounding the SAME pitch at the
     SAME time would collide on one KeyId (cancel/retrigger). We don't run
     separate per-instrument audio streams; instead the TOPMOST instrument
     (lowest voice index) wins each pitch and the other instruments' duplicates
     are dropped from the played stream. Scoped to DIFFERENT instruments — a
     pitch already claimed by the same instrument is left alone, so single-
     instrument playback (and within-instrument unisons) is byte-identical. An
     event whose notes all drop becomes a silent pulse (still echoes its meiId,
     so that voice's playback cursor still advances). */
  if (isMultiInstrument) {
    const ONSET_EPS = 1e-6;
    const order = events.map((_, i) => i).sort(
      (a, b) => events[a].atMs - events[b].atMs || (events[a].voice ?? 0) - (events[b].voice ?? 0),
    );
    let g = 0;
    while (g < order.length) {
      let hi = g + 1;
      while (hi < order.length && Math.abs(events[order[hi]].atMs - events[order[g]].atMs) < ONSET_EPS) hi++;
      const claimed = new Map<string, number>(); /* "q,r" → claiming instrument index */
      for (let k = g; k < hi; k++) {
        const ev = events[order[k]];
        if (ev.notes.length === 0) continue;
        const instr = model.instrumentOf(ev.voice ?? 1).index;
        const kept = ev.notes.filter((n) => {
          const key = n.q + ',' + n.r;
          const owner = claimed.get(key);
          if (owner === undefined) { claimed.set(key, instr); return true; }
          return owner === instr; /* same instrument → keep; other → drop */
        });
        if (kept.length !== ev.notes.length) ev.notes = kept;
      }
      g = hi;
    }
  }

  /* Strip the internal `_mi`/`_tick` tags when handing PlaybackEvents back. */
  const strip = (e: CanonEvent): PlaybackEvent => {
    const { _mi, _tick, ...rest } = e;
    void _mi; void _tick;
    return rest;
  };

  if (!hasRepeatStructure(mei)) {
    /* Original linear path: atMs is a pure function of tick. */
    events.sort((a, b) => a.atMs - b.atMs);
    const out = events.map(strip);
    if (startMs > 0) {
      return out
        .filter((e) => e.atMs >= startMs - 1e-6)
        .map((e) => ({ ...e, atMs: e.atMs - startMs }));
    }
    return out;
  }

  /* Repeat path: atMs accumulates over the PLAYED measure order, while every
     other lookup (velocity, duration, tempo) stays keyed on the note's
     ORIGINAL tick (already baked into the canonical events above). */
  const measureCount = Array.from(mei.querySelectorAll('measure')).length;
  /* Absolute tick at each measure's start — per-measure-meter aware (the
     non-repeat path already accumulates ticks from content+placeholders, so it
     needs no change; only this canonical-order remap used the uniform width). */
  const canonStart = (mi: number): number => tempo.atMsAt(model.measureStartTick(mi));

  /* Seek: find the measure whose canonical span contains startMs; repeats
     whose body the seek falls inside are not replayed (expandPlayOrder). */
  let startMi = 0;
  if (startMs > 0) {
    for (let mi = 0; mi < measureCount; mi++) {
      if (canonStart(mi) <= startMs + 1e-6) startMi = mi; else break;
    }
  }
  const playOrder = expandPlayOrder(mei, startMi);

  const byMeasure = new Map<number, CanonEvent[]>();
  for (const ev of events) {
    const list = byMeasure.get(ev._mi);
    if (list) list.push(ev); else byMeasure.set(ev._mi, [ev]);
  }

  const remapped: PlaybackEvent[] = [];
  let playedMs = 0;
  for (const occ of playOrder) {
    const mi = occ.measureIdx;
    const mStart = canonStart(mi);
    const mDur = canonStart(mi + 1) - mStart;
    for (const ev of byMeasure.get(mi) ?? []) {
      remapped.push({ ...strip(ev), atMs: playedMs + (ev.atMs - mStart) });
    }
    playedMs += mDur;
  }
  remapped.sort((a, b) => a.atMs - b.atMs);

  /* `playedMs` is measured from the start of `startMi`; shift to startMs. */
  const withinOffset = startMs > 0 ? startMs - canonStart(startMi) : 0;
  if (withinOffset > 1e-6) {
    return remapped
      .filter((e) => e.atMs >= withinOffset - 1e-6)
      .map((e) => ({ ...e, atMs: e.atMs - withinOffset }));
  }
  return remapped;
}

/** Parallel sustain-pedal timeline for a playback run. Maps each <pedal>
 *  event's absolute tick to ms via the same tempo as buildPlayback, then
 *  applies the same `startMs` window (drop events before the playhead, shift
 *  the rest left). HKL consumes these to drive its damper engine + CC 64.
 *
 *  Inherited pedal state: when playback starts mid-piece (startMs > 0) at a
 *  point where the pedal is already DOWN (a pedal-down before the playhead with
 *  no up before it), the down event itself is dropped by the window — so we
 *  seed a synthetic down at t=0 so playback behaves as if the pedal were held
 *  from the start. */
export function buildPedalEvents(model: ComposerModel, startMs = 0): PedalEvent[] {
  const mei = new DOMParser().parseFromString(model.serialize(), 'application/xml');
  const tempo = buildTempoTimeline(mei);
  /* staff @n → owning instrument's sample-set key, so each pedal mark routes to
     its grand-staff instrument's damper. Single-instrument scores leave
     instrumentKey absent (global damper = historic behavior). */
  const multi = model.instruments().length > 1;
  const staffToInstrKey = new Map<number, string>();
  for (const inst of model.instruments())
    for (const sn of inst.staffNs) staffToInstrKey.set(sn, inst.instrKey);
  const evs: PedalEvent[] = collectPedals(mei).map((p) => ({
    atMs: tempo.atMsAt(p.tick), dir: p.dir,
    instrumentKey: multi ? staffToInstrKey.get(p.staff) : undefined,
  }));
  evs.sort((a, b) => a.atMs - b.atMs);
  if (startMs > 0) {
    /* Inherited pedal state PER INSTRUMENT: the most-recent transition strictly
       before startMs (for each instrumentKey) decides whether that instrument
       enters the window pedal-down. */
    const inheritedDown = new Map<string | undefined, boolean>();
    for (const e of evs) {
      if (e.atMs < startMs - 1e-6) inheritedDown.set(e.instrumentKey, e.dir === 'down');
      else break;
    }
    const shifted = evs
      .filter((e) => e.atMs >= startMs - 1e-6)
      .map((e) => ({ ...e, atMs: e.atMs - startMs }));
    for (const [key, down] of inheritedDown)
      if (down) shifted.unshift({ atMs: 0, dir: 'down', instrumentKey: key });
    return shifted;
  }
  return evs;
}

function pushContentChildren(layer: Element, out: Element[]): void {
  for (const c of Array.from(layer.children)) {
    const ln = c.localName;
    if (ln === 'chord' || ln === 'note' || ln === 'rest' || ln === 'space' || ln === 'fTrem' || ln === 'bTrem') {
      /* fTrem/bTrem (tremolos) are pushed as a single slot; buildPlayback
         expands them into an alternating note sequence. */
      out.push(c);
    } else if (ln === 'beam') {
      /* Descend into beam wrappers. */
      for (const cc of Array.from(c.children)) {
        const ln2 = cc.localName;
        if (ln2 === 'chord' || ln2 === 'note' || ln2 === 'rest' || ln2 === 'space') out.push(cc);
      }
    } else if (ln === 'tuplet') {
      /* Descend into tuplet wrappers. realTicks() automatically scales
         child durations by numbase/num based on closest('tuplet'), so the
         outer time-accumulator yields correct sounding times. */
      for (const cc of Array.from(c.children)) {
        const ln2 = cc.localName;
        if (ln2 === 'chord' || ln2 === 'note' || ln2 === 'rest' || ln2 === 'space') {
          out.push(cc);
        } else if (ln2 === 'beam') {
          /* Defensive: v1 never beams inside tuplets, but if some other
             pipeline produces it, descend. */
          for (const bc of Array.from(cc.children)) {
            const bln = bc.localName;
            if (bln === 'chord' || bln === 'note' || bln === 'rest' || bln === 'space') out.push(bc);
          }
        }
      }
    }
  }
}

/* ── highlight rendering ───────────────────────────────────────────────── */

const PLAYING_CLASS = 'playing';

let lastHighlightedId: string | null = null;

export function highlightElement(meiId: string | null, container: HTMLElement | null): void {
  if (!container) return;
  if (lastHighlightedId) {
    const prev = container.querySelector('#' + CSS.escape(lastHighlightedId));
    if (prev) prev.classList.remove(PLAYING_CLASS);
  }
  lastHighlightedId = null;
  if (meiId === null) return;
  const node = container.querySelector('#' + CSS.escape(meiId));
  if (node) {
    node.classList.add(PLAYING_CLASS);
    lastHighlightedId = meiId;
  }
}

export function clearHighlights(container: HTMLElement | null): void {
  if (!container) return;
  if (lastHighlightedId) {
    const prev = container.querySelector('#' + CSS.escape(lastHighlightedId));
    if (prev) prev.classList.remove(PLAYING_CLASS);
  }
  lastHighlightedId = null;
  for (const node of Array.from(container.querySelectorAll('.' + PLAYING_CLASS))) {
    node.classList.remove(PLAYING_CLASS);
  }
}
