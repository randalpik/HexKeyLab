// Click-to-position: when the user clicks on (or near) a rendered note or
// rest, move the editing cursor to that element and switch to its voice.
//
// Uses Verovio's `id="<meiId>"` annotation on each `<g class="note">` /
// `<g class="rest">` to map the click target back to a model element. A
// small expanding hit-test (up to ~8 px) lets the user click in the
// general vicinity of a glyph; if no note/rest is within range, the click
// is ignored.

import type { ComposerModel, Voice } from './model/index.js';

const HIT_PAD = 8; /* px of "near" tolerance for sparse layouts */

export interface ClickHooks {
  /** Trigger a re-render + state refresh. */
  onChange: () => void;
  /** Surface a status message (e.g. on voice switch). */
  setStatus?: (msg: string, kind?: 'info' | 'error' | 'state' | 'action') => void;
  /** Suppress while playback is active. */
  isPlaybackActive: () => boolean;
}

/** Walk up `el`'s ancestor chain looking for a clickable element. Prefers
 *  the OUTERMOST g.chord when present (chord-internal g.note xml:ids are
 *  NOT in flatChildren — only the chord wrapper is), falling back to a
 *  bare g.note or g.rest. Returns the meiId, or null if none. */
function findNoteOrRestId(el: Element | null): string | null {
  let candidate: { id: string; kind: 'chord' | 'note' | 'rest' } | null = null;
  let n: Element | null = el;
  while (n && n !== document.body) {
    if (n.tagName === 'g' || n.tagName === 'G') {
      const cls = n.getAttribute('class') ?? '';
      const id = n.getAttribute('id');
      const isChord = cls === 'chord' || / chord(?: |$)/.test(' ' + cls);
      const isNote = cls === 'note' || / note(?: |$)/.test(' ' + cls);
      const isRest = cls === 'rest' || / rest(?: |$)/.test(' ' + cls);
      if (isChord && id) {
        /* Chord wraps any inner notes — its id is the flatChildren entry.
           Return immediately; nothing higher in the tree is relevant. */
        return id;
      }
      if ((isNote || isRest) && id && !candidate) {
        candidate = { id, kind: isRest ? 'rest' : 'note' };
        /* Keep walking — if a chord ancestor exists, prefer it. */
      }
    }
    n = n.parentElement;
  }
  return candidate?.id ?? null;
}

/** Try to find a note/rest meiId at the click point, expanding outward up
 *  to HIT_PAD px in a small cross pattern if the direct hit misses. */
function hitTestNoteOrRest(x: number, y: number): string | null {
  /* Try the direct point first. */
  const direct = document.elementFromPoint(x, y);
  let id = findNoteOrRestId(direct);
  if (id) return id;
  /* Cross of offsets at HIT_PAD. */
  const offsets: ReadonlyArray<[number, number]> = [
    [-HIT_PAD, 0], [HIT_PAD, 0], [0, -HIT_PAD], [0, HIT_PAD],
    [-HIT_PAD, -HIT_PAD], [HIT_PAD, -HIT_PAD], [-HIT_PAD, HIT_PAD], [HIT_PAD, HIT_PAD],
  ];
  for (const [dx, dy] of offsets) {
    const el = document.elementFromPoint(x + dx, y + dy);
    id = findNoteOrRestId(el);
    if (id) return id;
  }
  return null;
}

export function attachScoreClickHandler(
  scoreEl: HTMLElement,
  model: ComposerModel,
  hooks: ClickHooks,
): () => void {
  function onClick(e: MouseEvent): void {
    if (hooks.isPlaybackActive()) return;
    /* Plain click only — don't fight selection drag, ctrl-click for browser
       context menu, etc. */
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.button !== 0) return;
    /* Find the meiId either via target ancestors or via point hit-test. */
    let meiId = findNoteOrRestId(e.target as Element | null);
    if (!meiId) meiId = hitTestNoteOrRest(e.clientX, e.clientY);
    if (!meiId) return;
    const loc = model.findElement(meiId);
    if (!loc) return;
    const prevVoice = model.getCurrentVoice();
    model.setVoice(loc.voice as Voice);
    model.setCursor(loc.index, loc.voice as Voice);
    if (prevVoice !== loc.voice) {
      hooks.setStatus?.('Voice ' + loc.voice + '.', 'state');
    }
    hooks.onChange();
  }
  scoreEl.addEventListener('click', onClick);
  return () => scoreEl.removeEventListener('click', onClick);
}
