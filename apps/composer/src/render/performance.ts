// Performance mode — input-driven playback. The inverse of clock-driven
// playback (see playback.ts): instead of HKL firing audio on a clock and
// echoing playback-position, the player plays the Lumatone live and HKL
// forwards each strike as a `player-note-struck` bridge event. This matcher
// holds the per-voice "frontier" and advances each voice's playback cursor when
// its current note/chord has been fully played.
//
// Identity match (per Max): exact frequency, expressed as (note name, octave,
// color) — `idKey`. This is exact in Equal/JI modes (enharmonic/comma variants
// stay distinct) and, in the duplicate-key layouts (Pythagorean 'P' /
// Semiditonal 'D'), a frequency fallback additionally accepts any same-pitch
// variant ("allow any variant"). Strict otherwise: a voice advances only when
// its full expected set is struck; a strike matching no current-frontier voice
// is silently ignored (no failure state).
//
// Reuses buildPlayback for structure (per-voice ordered attacks, sounding
// coords post-8va, tie-chain coalescing, rest-skipping). Color — which
// buildPlayback doesn't carry and Composer can't recompute from (q,r) (the
// darkColorHex helper lives in apps/hkl) — is read off each written <note>'s
// @color via extractResolvedFromElement; it's octave-invariant so it's correct
// even under an 8va sounding shift.

import type { ComposerModel, Voice } from '../model/index.js';
import type { ResolvedNote } from '@hkl/bridge/protocol.js';
import { buildPlayback } from './playback.js';
import { extractResolvedFromElement } from '../model/note-elements.js';
import { noteName, keyOctave } from '@hkl/shared/notes.js';
import { freqAt, type TuningMode } from '@hkl/shared/freq.js';

/** Relative frequency tolerance for the duplicate-key (P/D) freq fallback.
 *  Duplicate keys compute to identical Hz, so this only guards float noise. */
const HZ_REL_EPS = 1e-4;

interface ExpectedNote {
  /** (note name, octave, color) identity. */
  idKey: string;
  /** Sounding frequency under the score's tuning, for the P/D variant match. */
  hz: number;
  satisfied: boolean;
}

interface Step {
  meiId: string;
  notes: ExpectedNote[];
}

interface VoiceState {
  steps: Step[];
  /** Index of the current (awaiting-input) step; === steps.length when done. */
  stepIdx: number;
}

/** A voice advance, surfaced to the caller to reposition that voice's bar.
 *  `meiId` is the voice's new current element, or null when the voice is done
 *  (clears its bar). */
export interface PerfAdvance {
  voice: Voice;
  meiId: string | null;
}

/** (note name, octave, color) identity key. Both sides compute name/octave from
 *  (q, r) via @hkl/shared so the form is identical; color is supplied (from
 *  @color for expected notes, from ResolvedNote.colorHex for played notes —
 *  both are darkColorHex(q,r), so equal for the same note). */
function idKeyFor(q: number, r: number, color: string): string {
  return noteName(q, r) + '|' + keyOctave(q, r) + '|' + color;
}

/** Per-member @color of the chord/note at `meiId`, in DOM order (zips 1:1 with
 *  buildPlayback's event.notes, which walk the same <note> children). */
function colorsForElement(model: ComposerModel, meiId: string): string[] {
  const loc = model.findElement(meiId);
  if (!loc) return [];
  const el = model.flatChildren(loc.voice)[loc.index];
  if (!el) return [];
  return extractResolvedFromElement(el).map((n) => n.colorHex);
}

export class PerformanceMatcher {
  private voices = new Map<Voice, VoiceState>();
  private mode: TuningMode;
  private dupMode: boolean;

  constructor(model: ComposerModel) {
    this.mode = model.getLayoutReq().tuningMode as TuningMode;
    this.dupMode = this.mode === 'P' || this.mode === 'D';

    /* buildPlayback returns attacks sorted by atMs, tie-chains coalesced, rests
       as empty-notes pulses. Keep only sounding attacks of a known voice. */
    const events = buildPlayback(model).filter(
      (e) => e.notes.length > 0 && e.voice != null && e.meiId,
    );

    /* Group per voice in atMs order, merging attacks that share an onset within
       a voice into one step (a chord split by a partial tie emits several
       same-atMs events — the player strikes it once). */
    const byVoice = new Map<Voice, { atMs: number; step: Step }[]>();
    for (const e of events) {
      const v = e.voice as Voice;
      const colors = colorsForElement(model, e.meiId!);
      const notes: ExpectedNote[] = e.notes.map((c, i) => ({
        idKey: idKeyFor(c.q, c.r, colors[i] ?? ''),
        hz: freqAt(c.q, c.r, this.mode),
        satisfied: false,
      }));
      let list = byVoice.get(v);
      if (!list) byVoice.set(v, (list = []));
      const prev = list.length ? list[list.length - 1] : null;
      if (prev && Math.abs(prev.atMs - e.atMs) < 1e-6) {
        prev.step.notes.push(...notes);
      } else {
        list.push({ atMs: e.atMs, step: { meiId: e.meiId!, notes } });
      }
    }
    for (const [v, list] of byVoice) {
      this.voices.set(v, { steps: list.map((x) => x.step), stepIdx: 0 });
    }
  }

  /** Each voice's first expected element (its starting bar position). */
  initialPositions(): PerfAdvance[] {
    const out: PerfAdvance[] = [];
    for (const [voice, vs] of this.voices) {
      out.push({ voice, meiId: vs.steps[0]?.meiId ?? null });
    }
    return out;
  }

  /** Feed a live strike. Returns the voices that advanced as a result (each with
   *  its new current element, or null when the voice finished). A strike that
   *  matches no current-frontier voice returns []. */
  onStrike(note: ResolvedNote): PerfAdvance[] {
    const pid = idKeyFor(note.q, note.r, note.colorHex);
    const phz = freqAt(note.q, note.r, this.mode);
    const advanced: PerfAdvance[] = [];
    for (const [voice, vs] of this.voices) {
      const step = vs.steps[vs.stepIdx];
      if (!step) continue;
      let matched = false;
      for (const en of step.notes) {
        if (en.satisfied) continue;
        if (en.idKey === pid
          || (this.dupMode && Math.abs(en.hz - phz) / en.hz < HZ_REL_EPS)) {
          en.satisfied = true;
          matched = true;
          break;
        }
      }
      if (matched && step.notes.every((n) => n.satisfied)) {
        vs.stepIdx++;
        const next = vs.steps[vs.stepIdx];
        advanced.push({ voice, meiId: next ? next.meiId : null });
      }
    }
    return advanced;
  }

  /** True once every voice has consumed all its steps. */
  isFinished(): boolean {
    for (const vs of this.voices.values()) {
      if (vs.stepIdx < vs.steps.length) return false;
    }
    return true;
  }

  /** Whether there's anything to perform at all. */
  hasContent(): boolean {
    for (const vs of this.voices.values()) {
      if (vs.steps.length > 0) return true;
    }
    return false;
  }
}
