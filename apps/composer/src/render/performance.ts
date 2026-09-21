// Performance mode — input-driven playback. The inverse of clock-driven
// playback (see playback.ts): instead of HKL firing audio on a clock and
// echoing playback-position, the player plays the Lumatone live and HKL
// forwards each strike as a `player-note-struck` bridge event. This matcher
// holds the per-voice "frontier" and advances each voice's playback cursor when
// its current note/chord has been fully played.
//
// Identity match (per Max): exact frequency, expressed as (note name, octave)
// — `pitchKey` — plus the note's color. This is exact in Equal/JI modes
// (enharmonic/comma variants stay distinct) and, in the duplicate-key layouts
// (Pythagorean 'P' / Semiditonal 'D'), a frequency fallback additionally
// accepts any same-pitch variant ("allow any variant"). Strict otherwise: a
// voice advances only when its full expected set is struck; a strike matching
// no expected voice is silently ignored (no failure state).
//
// A chord expects only the notes that ATTACK on it: a member tied in from the
// previous chord emits no attack (buildPlayback coalesces it into its
// predecessor), so it is absent from the expected set and the player advances
// the voice by striking the new members alone.
//
// ORNAMENT AMBIGUITY (2026-09-20): buildPlayback expands a trill/tremolo into
// N alternation attacks whose count comes from TRILL_NOTE_MS — an audio
// constant. Requiring N strikes made leaving an ornament depend on the player
// matching a nominal trill speed, so the matcher collapses the run to ONE step
// satisfied by a single strike of ANY constituent.
//
// That leaves the real problem: when the note AFTER the trill is one of the
// trill's own pitches (a resolution, very common), no pitch-only rule can tell
// "still trilling" from "moved on" — a listener uses timing, which this matcher
// deliberately has none of. So the decision is DEFERRED rather than guessed.
// When the post-ornament step is satisfied ENTIRELY by strikes drawn from the
// ornament's pitch set P, its advance is OWED instead of emitted: the bar stays
// on the ornament and the voice stops advancing (the cap), though its notes
// keep accumulating so a chord is immune to intra-chord arrival order. The
// shadow LIFTS on the first match — in ANY voice — whose strike is outside P
// and whose step is at or after the owed step's onset; then the owed advance
// flushes and the voice drains. Both halves matter: outside-P rules out a trill
// continuation, at-or-after rules out an unrelated voice's earlier note (which
// would otherwise jump the bar mid-trill). With no such evidence the bar simply
// lags — never runs ahead, which is the benign direction given the bar trails
// by design. A single-voice texture therefore lags to the next non-P note; that
// is the irreducible cost of having no clock. The mechanism is inert unless the
// resolution lies wholly inside P, since otherwise its non-P member must be
// struck and the advance lands exactly there.
//
// MEASURE GATE (2026-09-17): voices are expected only in the measures where
// they exist. The "current measure" is the measure of the EARLIEST PENDING step
// across unfinished voices — pending rather than last-played, so that the
// instant the last note of m19 is consumed the current measure becomes m20 and
// a voice entering on the m20 downbeat is already listening when that downbeat
// is struck (including simultaneously with another voice's). Two rules:
//   listening(V)  = V's pending step is in the current measure
//   barVisible(V) = V has content in the current measure
// They differ on purpose: a voice can be on stage (bar shown) without being
// listened to, when it is present in the measure but has already consumed its
// notes there. Without this gate the matcher kept no position information at
// all, so a voice entering at m20 was matchable — and drew a bar — from m1.
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
import type { PlaybackBarEdge } from '@hkl/shared/cursor-geom.js';

/** Relative frequency tolerance for the duplicate-key (P/D) freq fallback.
 *  Duplicate keys compute to identical Hz, so this only guards float noise. */
const HZ_REL_EPS = 1e-4;

interface ExpectedNote {
  /** (note name, octave) identity. */
  pitchKey: string;
  /** The written note's @color, or null when the element has no written note
   *  at this sounding pitch class (a string harmonic's sounding coord, a
   *  trill's alternation cell) — null means "any color", so an
   *  underdetermined color degrades to a pitch-only match instead of a
   *  never-matching one that would wedge the voice. */
  color: string | null;
  /** Sounding frequency under the score's tuning, for the P/D variant match. */
  hz: number;
  satisfied: boolean;
  /** Whether the strike that satisfied this note was also a member of the
   *  preceding ornament's set — i.e. could equally have been a trill
   *  continuation. A step every one of whose notes is `fromP` is ambiguous. */
  fromP: boolean;
}

interface Step {
  meiId: string;
  notes: ExpectedNote[];
  /** Measure OCCURRENCE this step lives in — an ordinal over the play-order
   *  measure timeline, not a measure index, so a repeated measure is a second
   *  distinct occurrence. The gate compares these, never raw indices. */
  occ: number;
  /** Onset, in playback ms. Compared only for ordering/equality against other
   *  steps, never measured — it is score position (its ordering is identical to
   *  written-tick ordering), and it is what "at or after" tests. */
  atMs: number;
  /** A collapsed trill/tremolo: satisfied by ANY one constituent, and its note
   *  set is the absorbing set P for the step that follows. */
  ornament: boolean;
}

/** A deferred bar advance — see the ORNAMENT AMBIGUITY note. A shadowed voice
 *  holds: it accumulates note satisfaction but emits nothing and advances no
 *  further until the shadow lifts, so at most one advance is ever owed. */
interface Shadow {
  /** The preceding ornament's constituents: the absorbing set P. */
  pitches: ExpectedNote[];
  /** Onset of the owed step; lifting evidence must be at or after it. */
  atMs: number;
  owed: PerfAdvance;
}

interface VoiceState {
  steps: Step[];
  /** Index of the current (awaiting-input) step; === steps.length when done. */
  stepIdx: number;
  /** Open when this voice's last advance was ambiguous (post-ornament, all
   *  notes satisfied from P). Null otherwise, which is the normal case. */
  shadow: Shadow | null;
}

/** A voice advance, surfaced to the caller to reposition that voice's bar.
 *  The bar TRAILS the player rather than leading them (Max, 2026-09-14): it
 *  parks on the RIGHT edge of the note just completed, exactly where the voice
 *  cursor sits after entering that note — so the bar tracks what was played
 *  instead of pointing at what's next, and (the score being played in order)
 *  never moves backward, which keeps the follow-scroll monotonic.
 *  `meiId` is the element the bar sits on, `edge` which side: 'right' for a
 *  completed note, 'left' only for the pre-performance start position (nothing
 *  played yet → the bar sits before the first note). `meiId: null` CLEARS the
 *  voice's bar — a voice with no steps at all, one that hasn't entered yet, or
 *  one the current measure has no content for. */
export interface PerfAdvance {
  voice: Voice;
  meiId: string | null;
  edge: PlaybackBarEdge;
}

/** (note name, octave) identity key. Both sides compute it from (q, r) via
 *  @hkl/shared so the form is identical. Color is matched separately (from
 *  @color for expected notes, from ResolvedNote.colorHex for played notes —
 *  both are darkColorHex(q,r), so equal for the same note). */
function pitchKeyFor(q: number, r: number): string {
  return noteName(q, r) + '|' + keyOctave(q, r);
}

/** Octave-invariant lattice class. An octave is q ± 3 at the same r, and key
 *  color is octave-invariant, so (q mod 3, r) identifies a color — which lets
 *  a SOUNDING coord (post-8va) find its written note's @color. Two chord
 *  members an exact octave apart collide here, harmlessly: same color. */
function octClass(q: number, r: number): string {
  return (((q % 3) + 3) % 3) + '|' + r;
}

/** Ids whose playback is an ornament EXPANSION (buildPlayback's
 *  emitAlternation): a `<trill>`'s startid, or an `<fTrem>`/`<bTrem>` wrapper,
 *  whose own id is the meiId those events carry. Used alongside the structural
 *  signature below, which cannot see an ornament short enough to expand to a
 *  single attack. */
function ornamentIds(model: ComposerModel): Set<string> {
  const doc = model.getDoc();
  const out = new Set<string>();
  for (const tr of Array.from(doc.querySelectorAll('trill'))) {
    const sid = (tr.getAttribute('startid') ?? '').replace('#', '');
    if (sid) out.add(sid);
  }
  for (const w of Array.from(doc.querySelectorAll('fTrem, bTrem'))) {
    const id = w.getAttribute('xml:id');
    if (id) out.add(id);
  }
  return out;
}

/** An ordinary step needs every note struck; an ornament needs only ONE of its
 *  constituents — the player strikes a trill to be "on" it, and how many
 *  alternations they play is theirs to choose, not ours to count. */
function stepComplete(step: Step): boolean {
  return step.ornament
    ? step.notes.some((n) => n.satisfied)
    : step.notes.every((n) => n.satisfied);
}

/** A @color lookup for the chord/note at `meiId`, keyed by octave-invariant
 *  lattice class, plus the index of the measure it lives in. Keyed rather than
 *  positional (2026-09-20): buildPlayback's event.notes do NOT zip 1:1 with the
 *  element's <note> children — a tie continuation emits no attack and so is
 *  absent from event.notes, and a partial-tie chord is split into several
 *  same-onset events that each start at index 0. A positional zip therefore
 *  handed a note its neighbour's color, whose idKey then matched no strike at
 *  all, wedging the voice on any chord mixing tied and untied members.
 *  One findElement lookup serves both results, and the measure comes off the
 *  cached voice index (O(1)) rather than getMeasureIdxForId's per-call scan. */
function elementInfo(
  model: ComposerModel, meiId: string,
): { colorOf: (q: number, r: number) => string | null; mi: number } {
  const miss = { colorOf: () => null, mi: -1 };
  const loc = model.findElement(meiId);
  if (!loc) return miss;
  const el = model.flatChildren(loc.voice)[loc.index];
  if (!el) return miss;
  const info = model.getFlatStopInfo(loc.voice, loc.index);
  const byClass = new Map<string, string>();
  for (const n of extractResolvedFromElement(el)) byClass.set(octClass(n.q, n.r), n.colorHex);
  return {
    colorOf: (q, r) => byClass.get(octClass(q, r)) ?? null,
    mi: info ? info.measureIdx : -1,
  };
}

export class PerformanceMatcher {
  private voices = new Map<Voice, VoiceState>();
  /** Per voice, the measure occurrences it has content in — drives bar
   *  visibility ("is this voice on stage here"), independently of what it is
   *  waiting for. */
  private present = new Map<Voice, Set<number>>();
  /** Voices currently showing a bar, so a hide is emitted once, not per strike. */
  private shown = new Set<Voice>();
  private mode: TuningMode;
  private dupMode: boolean;

  constructor(model: ComposerModel) {
    this.mode = model.getLayoutReq().tuningMode as TuningMode;
    this.dupMode = this.mode === 'P' || this.mode === 'D';

    const ornaments = ornamentIds(model);

    /* buildPlayback returns attacks sorted by atMs, tie-chains coalesced, rests
       as empty-notes pulses. Keep only sounding attacks of a known voice. */
    const events = buildPlayback(model).filter(
      (e) => e.notes.length > 0 && e.voice != null && e.meiId,
    );

    /* Measure OCCURRENCES: walk the globally atMs-sorted stream and open a new
       occurrence whenever the measure changes. Every voice shares one measure
       timeline (measures are global), so a measure's attacks are contiguous
       here regardless of which voices they belong to — and a repeat revisiting
       the same measure opens a second, distinct occurrence. */
    const occMeasure: number[] = [];
    let occ = -1;
    let prevMi = -2;

    /* Group per voice in atMs order, merging attacks that share an onset within
       a voice into one step (a chord split by a partial tie emits several
       same-atMs events — the player strikes it once). */
    const byVoice = new Map<Voice, { atMs: number; step: Step }[]>();
    for (const e of events) {
      const v = e.voice as Voice;
      const { colorOf, mi } = elementInfo(model, e.meiId!);
      if (mi !== prevMi) {
        occ++;
        occMeasure.push(mi);
        prevMi = mi;
      }
      const notes: ExpectedNote[] = e.notes.map((c) => ({
        pitchKey: pitchKeyFor(c.q, c.r),
        color: colorOf(c.q, c.r),
        hz: freqAt(c.q, c.r, this.mode),
        satisfied: false,
        fromP: false,
      }));
      let list = byVoice.get(v);
      if (!list) byVoice.set(v, (list = []));
      const prev = list.length ? list[list.length - 1] : null;
      const sameOnset = !!prev && Math.abs(prev.atMs - e.atMs) < 1e-6;
      /* The SAME meiId at a LATER onset is emitAlternation's ornament
         expansion, and nothing else produces it — every other path emits a
         slot's attacks at one onset (a partial-tie chord splits by duration,
         not by time). Collapse the whole run into the one step the player
         satisfies with a single strike. */
      const ornamentRun = !!prev && !sameOnset && prev.step.meiId === e.meiId;
      if (sameOnset || ornamentRun) {
        /* Dedupe: an alternation repeats the same two cells N times. */
        for (const n of notes) {
          if (!prev!.step.notes.some((x) => x.pitchKey === n.pitchKey && x.color === n.color))
            prev!.step.notes.push(n);
        }
        if (ornamentRun) prev!.step.ornament = true;
      } else {
        list.push({
          atMs: e.atMs,
          step: { meiId: e.meiId!, notes, occ, atMs: e.atMs, ornament: ornaments.has(e.meiId!) },
        });
      }
    }
    for (const [v, list] of byVoice) {
      this.voices.set(v, { steps: list.map((x) => x.step), stepIdx: 0, shadow: null });
    }

    /* Which voices are on stage in each occurrence. isMeasureEmptyInVoice
       counts WRITTEN rests as content, so a voice notated tacet for a bar keeps
       its bar; only a truly empty layer (invisible placeholders / <mRest>,
       which render as nothing) hides it. */
    for (const v of this.voices.keys()) {
      const present = new Set<number>();
      for (let o = 0; o < occMeasure.length; o++) {
        if (!model.isMeasureEmptyInVoice(v, occMeasure[o])) present.add(o);
      }
      this.present.set(v, present);
    }
  }

  /** The measure the performance is in: the occurrence of the earliest PENDING
   *  step across unfinished voices. Infinity once every voice is done — at
   *  which point there is no current measure, so bars freeze where they are
   *  (the end of the score is not an exit, per 2026-09-14). */
  private currentOcc(): number {
    let min = Infinity;
    for (const vs of this.voices.values()) {
      const step = vs.steps[vs.stepIdx];
      if (step && step.occ < min) min = step.occ;
    }
    return min;
  }

  /** The voices a strike is matched against: those whose pending step lives in
   *  the current measure. */
  expected(): Voice[] {
    const cur = this.currentOcc();
    const out: Voice[] = [];
    for (const [voice, vs] of this.voices) {
      const step = vs.steps[vs.stepIdx];
      if (step && step.occ === cur) out.push(voice);
    }
    return out;
  }

  /** Each voice's starting bar position: before (left of) its first expected
   *  element, since nothing has been played yet — but only for voices in play
   *  in the first sounding measure. A voice that enters later starts with NO
   *  bar and gets none until it strikes (no entry cue, per Max). */
  initialPositions(): PerfAdvance[] {
    const cur = this.currentOcc();
    const out: PerfAdvance[] = [];
    for (const [voice, vs] of this.voices) {
      const step = vs.steps[vs.stepIdx];
      const show = !!step && step.occ === cur;
      if (show) this.shown.add(voice);
      out.push({ voice, meiId: show ? step!.meiId : null, edge: 'left' });
    }
    return out;
  }

  /** Does a strike satisfy this expected note? (name, octave) plus the written
   *  color when it is known; the duplicate-key layouts (P/D) additionally
   *  accept any same-pitch variant. Shared by note matching and P-membership
   *  so the two can never drift apart. */
  private matches(en: ExpectedNote, pitchKey: string, hz: number, color: string): boolean {
    if (en.pitchKey === pitchKey && (en.color === null || en.color === color)) return true;
    return this.dupMode && Math.abs(en.hz - hz) / en.hz < HZ_REL_EPS;
  }

  /** Feed a live strike. Returns the voices that advanced as a result, each
   *  with the element it just completed (bar goes to that element's right
   *  edge), followed by any voice whose bar the new current measure has no
   *  content for (`meiId: null` — the bar disappears). A voice that finishes
   *  its last step keeps its bar until the current measure moves past its
   *  content; at the end of the score every bar stays put. A strike that
   *  matches no expected voice returns []. */
  onStrike(note: ResolvedNote): PerfAdvance[] {
    const pid = pitchKeyFor(note.q, note.r);
    const phz = freqAt(note.q, note.r, this.mode);
    const cur = this.currentOcc();
    const advanced: PerfAdvance[] = [];
    const hits = (en: ExpectedNote): boolean => this.matches(en, pid, phz, note.colorHex);

    /* PHASE 1 — matching. Satisfy at most one expected note per listening
       voice, and record the ONSETS the strike landed on: those are the
       evidence a shadow lifts on. Nothing advances yet. */
    const matchedAt: number[] = [];
    for (const [, vs] of this.voices) {
      const step = vs.steps[vs.stepIdx];
      /* Not expected here: this voice's next note is in a later measure. */
      if (!step || step.occ !== cur) continue;
      const prev = vs.stepIdx > 0 ? vs.steps[vs.stepIdx - 1] : null;
      const P = prev?.ornament ? prev.notes : null;
      for (const en of step.notes) {
        if (en.satisfied) continue;
        if (!hits(en)) continue;
        en.satisfied = true;
        en.fromP = !!P && P.some(hits);
        matchedAt.push(step.atMs);
        break;
      }
    }

    /* PHASE 2 — lift. A shadow lifts on any match, in any voice, whose strike
       is OUTSIDE that shadow's P and whose step is AT OR AFTER the owed step's
       onset. An unmatched strike is not evidence, so a wrong note can't lift
       one. */
    for (const [voice, vs] of this.voices) {
      const sh = vs.shadow;
      if (!sh) continue;
      if (sh.pitches.some(hits)) continue;
      if (!matchedAt.some((t) => t >= sh.atMs - 1e-6)) continue;
      advanced.push(sh.owed);
      this.shown.add(voice);
      vs.shadow = null;
    }

    /* PHASE 3 — advance. A still-shadowed voice is capped and holds. Every
       other voice drains whatever is fully satisfied, which is how a voice
       that just lifted catches up on steps it accumulated while held. */
    for (const [voice, vs] of this.voices) {
      while (!vs.shadow) {
        const step = vs.steps[vs.stepIdx];
        if (!step || !stepComplete(step)) break;
        const prev = vs.stepIdx > 0 ? vs.steps[vs.stepIdx - 1] : null;
        const adv: PerfAdvance = { voice, meiId: step.meiId, edge: 'right' };
        vs.stepIdx++;
        /* Ambiguous: the step right after an ornament, every note of which was
           satisfied by a strike that could equally have been a continuation of
           that ornament. Owe the bar rather than move it. */
        if (prev?.ornament && !step.ornament && step.notes.every((n) => n.fromP)) {
          vs.shadow = { pitches: prev.notes, atMs: step.atMs, owed: adv };
          break;
        }
        this.shown.add(voice);
        advanced.push(adv);
      }
    }

    /* Nothing can arrive to lift a shadow once every voice is done, so a voice
       that ended inside one would park its bar a note short. Flush. */
    if (this.isFinished()) {
      for (const [voice, vs] of this.voices) {
        if (!vs.shadow) continue;
        advanced.push(vs.shadow.owed);
        this.shown.add(voice);
        vs.shadow = null;
      }
    }
    /* Only a consumed step can move the current measure. When it moves, any
       voice the new measure has no content for loses its bar. */
    if (advanced.length) {
      const next = this.currentOcc();
      if (next !== cur && next !== Infinity) {
        for (const voice of [...this.shown]) {
          if (!this.present.get(voice)?.has(next)) {
            this.shown.delete(voice);
            advanced.push({ voice, meiId: null, edge: 'left' });
          }
        }
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
