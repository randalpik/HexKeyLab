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
import type { PlaybackEvent, CoordRef } from '../../bridge/protocol.js';
import {
  collectDynams, collectHairpins, getDynamicMap, absoluteTickForMoment,
} from '../expressions.js';
import { collectSlurs } from '../slurs.js';
import { realTicks } from '../model/ticks.js';
import { DEFAULT_DYNAMIC_MAP } from '../../shared/dynamics.js';

const DEFAULT_BPM = 120;
const MS_PER_MIN = 60_000;
const DEFAULT_VELOCITY = DEFAULT_DYNAMIC_MAP.mf;
const HAIRPIN_OPEN_END_DELTA = 25; /* synthesized cres/dim level when no flanking dynamic */

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

/** Walk every voice across every measure; emit one PlaybackEvent per
 *  attack (rests advance time silently; tied chains coalesce).
 *
 *  When `startMs > 0`, events whose `atMs` falls before `startMs` are
 *  dropped and the remaining events are shifted left by `startMs` — i.e.
 *  the playhead starts at that offset; notes that were already sounding
 *  at the cursor do NOT get re-attacked (DAW-standard non-retrigger
 *  semantics; matches Pro Tools / FL Studio). */
export function buildPlayback(model: ComposerModel, startMs = 0): PlaybackEvent[] {
  const events: PlaybackEvent[] = [];
  const mei = new DOMParser().parseFromString(model.serialize(), 'application/xml');
  const tempo = readTempo(mei);
  const tickMs = tickMsFromTempo(tempo);
  const velocity = buildVelocityLookup(mei);
  const noteById = buildNoteIdIndex(mei);

  for (let voice: Voice = 1; voice <= 4; voice = (voice + 1) as Voice) {
    const staffN = voice <= 2 ? 1 : 2;
    const layerN = (voice === 1 || voice === 3) ? 1 : 2;
    /* Walk all measures' layers for this voice. */
    const measures = Array.from(mei.querySelectorAll('measure'));
    const stream: Element[] = [];
    for (const m of measures) {
      const layer = Array.from(m.querySelectorAll(`staff[n="${staffN}"] layer[n="${layerN}"]`))[0];
      if (!layer) continue;
      /* Layer may have <beam> wrappers in the rendered MEI; descend to actual
         content children. */
      pushContentChildren(layer, stream);
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

      if (local === 'rest' || local === 'space') {
        /* Both rests and (placeholder) spaces advance the voice clock
           silently. Including spaces in the stream lets a voice that's
           empty in some measures correctly time-shift its later content. */
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
      for (const n of noteEls) {
        const t = n.getAttribute('tie');
        if (t === 't' || t === 'm') continue;
        const coord = extractCoords(n);
        if (!coord) continue;
        const durTicks = coalescedDurationTicks(n, noteById);
        const list = byDuration.get(durTicks) ?? [];
        list.push(coord);
        byDuration.set(durTicks, list);
      }

      if (byDuration.size > 0) {
        const meiId = child.getAttribute('xml:id') ?? undefined;
        const vel = velocity.at(tTicks);
        const atMs = tTicks * tickMs;
        const emittedIdxs: number[] = [];
        for (const [durTicks, notes] of byDuration) {
          emittedIdxs.push(events.length);
          events.push({
            atMs,
            durationMs: durTicks * tickMs,
            notes,
            meiId,
            velocity: vel,
            voice,
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
    if (voice === 4) break;
  }

  events.sort((a, b) => a.atMs - b.atMs);
  if (startMs > 0) {
    return events
      .filter((e) => e.atMs >= startMs - 1e-6)
      .map((e) => ({ ...e, atMs: e.atMs - startMs }));
  }
  return events;
}

function pushContentChildren(layer: Element, out: Element[]): void {
  for (const c of Array.from(layer.children)) {
    const ln = c.localName;
    if (ln === 'chord' || ln === 'note' || ln === 'rest' || ln === 'space') {
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
