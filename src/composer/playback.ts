// Playback orchestration. Composer walks the MEI model to produce a timed
// sequence of chord/rest events, then dispatches them to HKL via the bridge
// as a `play-score` message. HKL drives its audio engine; for each chord
// onset HKL broadcasts a `playback-position` so Composer can highlight the
// sounding element. `playback-finished` clears all highlights.
//
// Tempo is read from the MEI <tempo> element (mm + mm.unit + mm.dots).
// Tied notes are coalesced: a chord with @tie="i" emits one event whose
// durationMs includes all subsequent @tie="m"|"t" pieces; the tail pieces
// don't trigger separate attacks.

import type { ComposerModel, Voice } from './model.js';
import type { PlaybackEvent, CoordRef } from '../bridge/protocol.js';
import {
  collectDynams, collectHairpins, getDynamicMap, absoluteTickForMoment,
} from './expressions.js';

const DEFAULT_BPM = 120;
const MS_PER_MIN = 60_000;
const DEFAULT_VELOCITY = 85; /* "mf" — matches DEFAULT_DYNAMIC_MAP['mf'] */
const HAIRPIN_OPEN_END_DELTA = 25; /* synthesized cres/dim level when no flanking dynamic */

interface TempoInfo { bpm: number; unitDenom: number; dots: number }

function readTempo(doc: Document): TempoInfo {
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
function tickMsFromTempo(tempo: TempoInfo): number {
  const beatTicks = (64 / tempo.unitDenom) * (tempo.dots === 1 ? 1.5 : tempo.dots === 2 ? 1.75 : 1);
  const msPerBeat = MS_PER_MIN / tempo.bpm;
  return msPerBeat / beatTicks;
}

function elementDurationTicks(el: Element): number {
  const dur = el.getAttribute('dur');
  const dots = parseInt(el.getAttribute('dots') ?? '0', 10);
  const denom = dur ? parseInt(dur, 10) : NaN;
  if (!Number.isFinite(denom) || denom <= 0) return 16;
  const base = 64 / denom;
  if (dots === 1) return base * 1.5;
  if (dots === 2) return base * 1.75;
  return base;
}

function extractCoords(noteEl: Element): CoordRef | null {
  const qs = noteEl.getAttribute('data-q');
  const rs = noteEl.getAttribute('data-r');
  if (qs === null || rs === null) return null;
  const q = parseInt(qs, 10);
  const r = parseInt(rs, 10);
  return Number.isFinite(q) && Number.isFinite(r) ? { q, r } : null;
}

function tieHas(el: Element, role: 'initial' | 'terminal'): boolean {
  const test = (n: Element): boolean => {
    const t = n.getAttribute('tie');
    if (role === 'initial') return t === 'i' || t === 'm';
    return t === 't' || t === 'm';
  };
  if (el.localName === 'note') return test(el);
  if (el.localName === 'chord') {
    return Array.from(el.children).some((n) => n.localName === 'note' && test(n));
  }
  return false;
}

function elementHasTieInitial(el: Element): boolean { return tieHas(el, 'initial'); }
function elementHasTieTerminal(el: Element): boolean { return tieHas(el, 'terminal'); }

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
 *  attack (rests advance time silently; tied chains coalesce). */
export function buildPlayback(model: ComposerModel): PlaybackEvent[] {
  const events: PlaybackEvent[] = [];
  const mei = new DOMParser().parseFromString(model.serialize(), 'application/xml');
  const tempo = readTempo(mei);
  const tickMs = tickMsFromTempo(tempo);
  const velocity = buildVelocityLookup(mei);

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

      /* Coalesce tied chain. */
      let totalTicks = ticks;
      let j = i + 1;
      if (elementHasTieInitial(child)) {
        while (j < stream.length) {
          const e2 = stream[j];
          if (e2.localName === 'rest') break;
          if (!elementHasTieTerminal(e2)) break;
          totalTicks += elementDurationTicks(e2);
          if (!elementHasTieInitial(e2)) { j++; break; }
          j++;
        }
      }

      const notes: CoordRef[] = [];
      if (local === 'note') {
        const c = extractCoords(child);
        if (c) notes.push(c);
      } else if (local === 'chord') {
        for (const n of Array.from(child.children)) {
          if (n.localName !== 'note') continue;
          const c = extractCoords(n);
          if (c) notes.push(c);
        }
      }

      if (notes.length > 0) {
        const meiId = child.getAttribute('xml:id') ?? undefined;
        events.push({
          atMs: tTicks * tickMs,
          durationMs: totalTicks * tickMs,
          notes,
          meiId,
          velocity: velocity.at(tTicks),
        });
      }
      /* Advance time by the chain's total ticks; skip past coalesced pieces. */
      tTicks += totalTicks;
      i = (j === i + 1) ? i + 1 : j;
    }
    if (voice === 4) break;
  }

  events.sort((a, b) => a.atMs - b.atMs);
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
