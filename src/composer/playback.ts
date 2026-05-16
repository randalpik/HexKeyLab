// Playback orchestration. Composer walks the MEI model to produce a timed
// sequence of chord/rest events, then dispatches them to HKL via the bridge
// as a `play-score` message. HKL drives its audio engine; for each chord
// onset HKL broadcasts a `playback-position` so Composer can highlight the
// sounding element. `playback-finished` clears all highlights.
//
// Tempo is fixed at 120 BPM for v1 — a toolbar input is a future enhancement.

import type { ComposerModel, Voice } from './model.js';
import type { PlaybackEvent, CoordRef } from '../bridge/protocol.js';

const TEMPO_BPM = 120;
const MS_PER_QUARTER = 60_000 / TEMPO_BPM;
const MS_PER_WHOLE = MS_PER_QUARTER * 4;

function durationToMs(dur: string, dots: number): number {
  const denom = parseInt(dur, 10);
  if (!Number.isFinite(denom) || denom <= 0) return MS_PER_QUARTER;
  const base = MS_PER_WHOLE / denom;
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

/** Walk every voice in the model; emit one PlaybackEvent per chord/note
 *  (not per rest — rests advance time silently). Events are sorted by
 *  onset so simultaneous voice attacks land together. */
export function buildPlayback(model: ComposerModel): PlaybackEvent[] {
  const events: PlaybackEvent[] = [];
  const mei = new DOMParser().parseFromString(model.serialize(), 'application/xml');

  for (let voice: Voice = 1; voice <= 4; voice = (voice + 1) as Voice) {
    const staffN = voice <= 2 ? 1 : 2;
    const layerN = (voice === 1 || voice === 3) ? 1 : 2;
    const layer = Array.from(mei.querySelectorAll(`staff[n="${staffN}"] layer[n="${layerN}"]`))[0];
    if (!layer) continue;

    let t = 0;
    for (const child of Array.from(layer.children)) {
      const local = child.localName;
      const dur = child.getAttribute('dur') ?? '4';
      const dots = parseInt(child.getAttribute('dots') ?? '0', 10);
      const ms = durationToMs(dur, dots);

      if (local === 'rest') {
        t += ms;
        continue;
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
        events.push({ atMs: t, durationMs: ms, notes, meiId });
      }
      t += ms;
    }
    if (voice === 4) break;
  }

  events.sort((a, b) => a.atMs - b.atMs);
  return events;
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
  /* Belt-and-suspenders: clear any straggler .playing classes. */
  for (const node of Array.from(container.querySelectorAll('.' + PLAYING_CLASS))) {
    node.classList.remove(PLAYING_CLASS);
  }
}
