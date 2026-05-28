// HKL-side bridge. Lives in the main HKL app (index.html). Three jobs:
//
//   1. Broadcast held-keys / tuning / footprint to Composer whenever the
//      corresponding HKL state mutates. Driven event-style from the existing
//      effects/* fan-outs (broadcastHeldKeys, broadcastTuning,
//      broadcastFootprint, broadcastAllToComposer are exported and called
//      from onSelectionChanged / onTuningChanged / onRefChanged / setOutline).
//      Payloads are fully resolved (pname/accid/oct/midi/colorHex/velocity)
//      so Composer doesn't need to import HKL's tuning logic. Each broadcast
//      bails on an unchanged signature, so callers can fire them liberally.
//
//      Why event-driven, not requestAnimationFrame: browsers throttle rAF to
//      ~1 Hz or suspend it entirely in background tabs (HTML spec, Firefox +
//      Chromium + Safari). With HKL in a background tab and Composer focused,
//      a polled bridge stalls while audio keeps playing — Composer never sees
//      the held notes. Event-driven dispatch runs in the same call stack as
//      the input handler that fired noteOn, so it survives tab-throttling.
//
//   2. Respond to Composer handshake / state requests with hkl-hello plus
//      a fresh held-keys + tuning-changed broadcast.
//
//   3. Receive play-chord / play-score / stop-playback. Dispatch to the
//      audio engine; emit playback-position acks as each chord onset fires.

import { createHklBridge, createAnalyzerHklBridge, PROTOCOL_VERSION, ANALYZER_PROTOCOL_VERSION } from '@hkl/bridge/channel.js';
import type {
  ComposerEvent, PlaybackEvent, ResolvedNote, CoordRef,
} from '@hkl/bridge/protocol.js';
import type { AnalyzerEvent } from '@hkl/bridge/analyzer-protocol.js';
import * as InstrumentRegistry from '../state/instrumentRegistry.js';
import * as CdnConfigRegistry from '../state/cdnConfigRegistry.js';
import { selection } from '../state/selection.js';
import { audio } from '../state/audio.js';
import { tuning } from '../state/tuning.js';
import { darkColorHex } from '../transcription/pitch.js';
import { resolveNoteSpec } from '../tuning/spell.js';
import { noteOn, noteOff, stopAllNotes, triggerRearticulateFlash, instrReplaysOnTranspose, glideVoices } from '../audio/engine.js';
import { syncPianoOut, restrikePianoOut } from '../midi/piano-out.js';
import { draw, requestDraw, activeFootprintSet, invalidatePianoOutline, validateRefNoteCandidate } from '../render/draw.js';
import { syncViewToOutline } from '../ui/controls.js';
import { DEFAULT_DYNAMIC_MAP } from '@hkl/shared/dynamics.js';
import { setSelectionFromComposer, setSongKey, onComposerBye, referenceNote } from '../state/reference.js';
import { refSpine } from '../tuning/refspine.js';
import { view } from '../state/view.js';
import { onRefChanged } from '../effects/onRefChanged.js';
import { setTuning } from '../ui/controls.js';
import { loadPrefs, type TuningMode } from '../state/persistence.js';
import type { FootprintCell } from '@hkl/bridge/protocol.js';
import type { KeyId } from '../types.js';

const bridge = createHklBridge();
const analyzerBridge = createAnalyzerHklBridge();

/* Lightweight DOM read for the outline mode — the bridge handler runs on
   incoming composer messages, well after the toolbar is wired, so the
   #selOutline select is the simplest source of truth. */
function currentOutlineForBridge(): import('../state/persistence.js').OutlineMode {
  const sel = document.getElementById('selOutline') as HTMLSelectElement | null;
  const v = sel?.value;
  if (v === 'qwerty' || v === 'piano' || v === 'none') return v;
  return 'lumatone';
}

/* ── resolution helpers ──────────────────────────────────────────────────── */

/** Resolve (q, r) to a bridge ResolvedNote: the shared spelling/color core
 *  plus this voice's most-recent velocity. The pname narrowing is safe —
 *  resolveNoteSpec returns a lowercase letter 'a'..'g'. */
function resolveKey(q: number, r: number): ResolvedNote {
  const key: KeyId = q + ',' + r;
  const spec = resolveNoteSpec(q, r);
  return {
    ...spec,
    pname: spec.pname as ResolvedNote['pname'],
    velocity: audio.keyVelocity[key] ?? DEFAULT_DYNAMIC_MAP.mf,
  };
}

function tuningDescription(): string {
  switch (tuning.mode) {
    case 'E': return 'Equal (12-TET)';
    case '5': return 'Ptolemaic JI';
    case 'P': return 'Pythagorean JI';
    case 'D': return 'Semiditonal JI';
    case '7': return 'Septimal JI';
    case 'V': return 'Schismatic JI';
  }
}

function tuningMode(): string {
  return tuning.mode;
}

/* ── held-keys polling ───────────────────────────────────────────────────── */

let lastHeldSerialized = '';
let lastTuningMode = '';

/* Playback adds keys to selection.selectedKeys for visual highlight via the
   existing draw() path. To avoid Composer seeing its own playback echoed
   back as "held keys" (input-feedback loop), broadcasts are suppressed
   while playbackActive is true. */
let playbackActive = false;
/* Keys that the playback added to selectedKeys (vs. keys the user was
   already holding). On noteOff or abort, only these get removed — user's
   real held keys survive. */
const playbackOwnedKeys: Set<KeyId> = new Set();

/** Broadcast the current held-keys set if its signature changed. Safe to
 *  call from any state-mutation site; no-op when nothing changed or when
 *  playback is suppressing echoes. */
export function broadcastHeldKeys(): void {
  if (playbackActive) return;
  const keys: ResolvedNote[] = [];
  for (const keyId of selection.selectedKeys) {
    const parts = keyId.split(',');
    const q = parseInt(parts[0], 10);
    const r = parseInt(parts[1], 10);
    if (Number.isFinite(q) && Number.isFinite(r)) {
      keys.push(resolveKey(q, r));
    }
  }
  keys.sort((a, b) => a.midi - b.midi);
  /* Signature must include (q, r), not just midi: held-voice migration on a
     user-driven ref change preserves pitch (same midi) but shifts (q, r) by
     the kbAnchor delta. A midi-only signature suppresses the post-migration
     broadcast, leaving Composer with stale coords and inserting notes off by
     the ref difference at the next input. Re-resolving when only color/tuning
     changed is handled separately via lastHeldSerialized = '' force-resend. */
  const sig = keys.map((k) => k.q + ',' + k.r + ':' + k.velocity).join(',');
  if (sig !== lastHeldSerialized) {
    lastHeldSerialized = sig;
    bridge.send({ type: 'held-keys', keys });
  }
}

/** Broadcast tuning mode if it changed since the last send. A tuning change
 *  also implies spelling/color shifts for the same coords, so we force a
 *  follow-up held-keys re-broadcast by invalidating its signature. */
export function broadcastTuning(): void {
  const mode = tuningMode();
  if (mode !== lastTuningMode) {
    lastTuningMode = mode;
    bridge.send({ type: 'tuning-changed', mode, description: tuningDescription() });
    lastHeldSerialized = '';
    broadcastHeldKeys();
  }
}

let lastLayoutStateSig = '';

/** Broadcast HKL's full layout state (tuning + ref) when either field changes.
 *  Distinct from `broadcastTuning` (mode-only, for status text). Composer uses
 *  this to mirror HKL's layout when opening a blank score and to update the
 *  match indicator on ref-only changes. */
export function broadcastLayoutState(): void {
  const mode = tuning.mode;
  const q = referenceNote.q;
  const r = referenceNote.r;
  const sig = mode + ':' + q + ':' + r;
  if (sig !== lastLayoutStateSig) {
    lastLayoutStateSig = sig;
    bridge.send({ type: 'hkl-layout-state', tuningMode: mode, refQ: q, refR: r });
  }
}

let lastFootprintSig = '';

/** Compute the current footprint cell list (q, r, colorHex per cell) and
 *  broadcast if its signature changed. When outline='none' the set is null;
 *  we broadcast an empty array, meaning "no constraint" on the Composer
 *  side. */
export function broadcastFootprint(): void {
  const set = activeFootprintSet();
  const cells: FootprintCell[] = [];
  if (set) {
    /* Sort by (q, r) so the signature is stable across iteration order. */
    const ids = Array.from(set);
    ids.sort();
    for (const id of ids) {
      const ci = id.indexOf(',');
      if (ci < 0) continue;
      const q = +id.slice(0, ci);
      const r = +id.slice(ci + 1);
      cells.push([q, r, darkColorHex(q, r)]);
    }
  }
  /* Cheap signature: counts + first/last cells. Color changes propagate via
     tuning-changed which forces a full re-broadcast; for layout-only swaps
     the cell list shape changes (different (q, r) members), which we catch
     by mixing the joined string. */
  const sig = cells.length + ':' + cells.map((c) => c[0] + ',' + c[1] + ',' + c[2]).join('|');
  if (sig !== lastFootprintSig) {
    lastFootprintSig = sig;
    bridge.send({ type: 'footprint-changed', cells });
  }
}

/** Convenience: fire all relevant broadcasts. Used by fan-outs where multiple
 *  bridge-relevant pieces of state can shift in one step (tuning change,
 *  ref-note change). Each is signature-gated, so unchanged ones no-op. */
export function broadcastAllToComposer(): void {
  broadcastHeldKeys();
  broadcastTuning();
  broadcastLayoutState();
  broadcastFootprint();
}

/* ── playback dispatch ───────────────────────────────────────────────────── */

interface ActivePlayback {
  cancelled: boolean;
  pending: Set<number>; /* visual setTimeout handles, so stop-playback can clear them */
  heldKeys: Set<KeyId>; /* keys we noteOn'd, for force-off on stop */
  /* Monotonic per-key voice tag. Each audio-scheduled noteOn bumps the key's
     seq; each off-visual snapshot captures the seq it owns and only tears
     down if it still matches. This is how back-to-back same-pitch events
     avoid the previous event's off handler killing the fresh voice. */
  voiceSeq: Map<KeyId, number>;
  nextSeq: number;
  /* Recursive setTimeout for the lookahead driver. Separate from `pending`
     so the driver lifecycle is clear in cancellation. */
  driverHandle?: number;
}

let active: ActivePlayback | null = null;

function newPlayback(): ActivePlayback {
  return { cancelled: false, pending: new Set(), heldKeys: new Set(), voiceSeq: new Map(), nextSeq: 0 };
}

function abortActive(): void {
  if (!active) return;
  active.cancelled = true;
  if (active.driverHandle != null) {
    clearTimeout(active.driverHandle);
    active.driverHandle = undefined;
  }
  for (const h of active.pending) clearTimeout(h);
  /* heldKeys contains every voice the lookahead driver has scheduled but
     not yet released. For voices already sounding, noteOff schedules a
     normal release; for voices whose source.start is still in the future,
     the engine's source.stop schedules a stop time before the start, which
     the Web Audio spec specifies as producing no output. Either way the
     voice is silenced. */
  for (const k of active.heldKeys) {
    noteOff(k);
    if (playbackOwnedKeys.has(k)) {
      selection.selectedKeys.delete(k);
      playbackOwnedKeys.delete(k);
    }
  }
  active = null;
  playbackActive = false;
  syncPianoOut(); /* stop any external-synth voices the aborted playback left sounding */
  draw();
  /* Surface any drift in the user's real held-keys that accumulated while
     broadcasts were suppressed during playback. */
  broadcastHeldKeys();
}

function coordToKeyId(c: CoordRef): KeyId {
  return c.q + ',' + c.r;
}

/** Slur legato overlap: a slurred note's release is delayed this fraction of
 *  its own duration past the next note's onset, so the tail blends into the
 *  next attack. Note-proportional (longer notes get longer tails). Used for
 *  decay + replay-on-transpose instruments. */
const SLUR_OVERLAP_FRACTION = 0.12;

/** Slur glide ramp (ms) for sustained instruments — a brief boundary
 *  portamento, then hold. Clamped to half the predecessor's duration. */
const SLUR_GLIDE_MS = 70;

/* ── lookahead playback scheduler ────────────────────────────────────────────
 *
 * Composer pre-computes a sorted PlaybackEvent[] with absolute atMs onsets;
 * HKL's job is to hand those onsets to the audio thread with timing locked
 * to the audio clock, not the JS event-loop clock. Previously each event got
 * its own window.setTimeout, so attack timing absorbed any main-thread
 * jitter (canvas redraws, GC, layout) directly into the audible sound.
 *
 * The standard Web Audio remedy (Chris Wilson, "A Tale of Two Clocks") is a
 * lookahead scheduler: a slow JS driver scans events inside a small
 * lookahead window and hands each one to the audio engine with an explicit
 * future audio-clock time. The audio thread then renders the onset
 * sample-accurately regardless of when the driver itself fires. The 100ms
 * lookahead × 25ms driver interval gives ~4× redundancy on any single
 * driver tick missing its target — plenty for a busy main thread.
 *
 * What's audio-clock and what's JS-clock:
 *   • Attacks (noteOn): audio-clock, sample-accurate via `startAt`. THE FIX.
 *   • Releases (noteOff): JS-clock, fired by a setTimeout at score-off time
 *     (same as before). Release ramps are slow enough that ~10ms of JS
 *     jitter on the release start is inaudible; trying to make them
 *     sample-accurate runs into activeOscs lifecycle issues (the entry has
 *     to stay populated through the release for sustain/aftertouch/syncAudio
 *     to see the voice). Worth revisiting if the off jitter turns out to be
 *     audible after the on jitter is gone.
 *   • Visuals (cursor highlight, ack, draw, syncPianoOut): JS-clock at
 *     score-on / score-off time. A few ms of jitter here is invisible since
 *     the audio has already played. `draw()` is rAF-coalesced via
 *     `requestDraw()` so multiple events firing in the same frame collapse
 *     into one canvas blit.
 *   • Glides (sustained-instrument slur portamento): JS-clock from the
 *     visual-on track. The audio engine's sRampFreq anchors at currentTime,
 *     so plumbing audio-clock timing through that path is a separate
 *     change. With slurs short (≤70ms ramps), inheriting the ~10ms visual
 *     jitter is acceptable.
 */

const LOOKAHEAD_MS = 100;
const DRIVER_INTERVAL_MS = 25;

/** Schedule the audio attacks (and the pb-side voice bookkeeping) for an
 *  event at driver tick time. Pure audio scheduling — no DOM, no canvas, no
 *  MIDI mirror. voiceSeq / heldKeys are populated here so cancellation in
 *  abortActive and the seq-based off-skip check in scheduleOffVisualAt see
 *  consistent state from the moment the event is scheduled.
 *
 *  For canGlide (sustained-instrument slur): the audio handoff runs HERE,
 *  not in scheduleOnVisualAt, with `atTime = audioOnSec` so the rate ramp +
 *  voiceGain crossfade are anchored on the audio clock at the planned slur
 *  boundary. The previous design did the glide in the visual-on setTimeout
 *  (anchored at ctx.currentTime), which worked at slow tempos but lost
 *  notes in fast trills: two consecutive visual-on fires inside each
 *  other's ramp windows had their setValueCurveAtTime sequences collide
 *  and skip pitches. Doing it at tick with sample-accurate atTime lets the
 *  audio thread render each glide boundary precisely regardless of when
 *  the JS callbacks fire. */
function scheduleAudioForEvent(
  ev: PlaybackEvent,
  step: LegatoStep,
  audioOnSec: number,
  pb: ActivePlayback,
  canGlide: boolean,
): void {
  if (canGlide) {
    const oldKey = step.glideFromKey!;
    const newKey = coordToKeyId(ev.notes[0]);
    /* Audio handoff on the audio clock. glideVoices rekeys audio.activeOscs
       and audio.keyVelocity synchronously here, so a same-tick successor's
       canGlide check sees the post-glide state. */
    glideVoices([{ oldKey, newKey }], step.rampMs ?? SLUR_GLIDE_MS, audioOnSec);
    /* Mirror the audio rekey in pb-state. voiceSeq is the claim ledger
       checked at off-fire; heldKeys is the abort-target set. Both shift
       oldKey→newKey to match audio.activeOscs. Later canGlide events in
       the same tick that overwrite voiceSeq[newKey] are expected — see
       the off-snapshot note in scheduleOffVisualAt. */
    const seq = ++pb.nextSeq;
    pb.voiceSeq.set(newKey, seq);
    pb.heldKeys.delete(oldKey);
    pb.heldKeys.add(newKey);
    return;
  }
  const keys: KeyId[] = ev.notes.map(coordToKeyId);
  for (const k of keys) {
    if (audio.activeOscs[k]) {
      /* Back-to-back same-pitch: release the existing voice at the new
         attack time. The audio engine schedules its release ramp on the
         audio clock at audioOnSec, effectively cross-fading the old voice
         out as the new one comes in. */
      noteOff(k, audioOnSec);
    }
    audio.sustainedKeys.delete(k);
    /* Seed audio.keyVelocity so this attack shows up in loopdiag's vel trace
       like Lumatone / QWERTY / recording-playback do (all of which write
       keyVelocity before noteOn). Without the seed, Composer-dispatched
       notes are invisible to the diagnostic overlay. */
    const v = ev.velocity ?? audio.keyVelocity[k] ?? DEFAULT_DYNAMIC_MAP.mf;
    audio.keyVelocity[k] = v;
    noteOn(k, v, audioOnSec);
    const seq = ++pb.nextSeq;
    pb.voiceSeq.set(k, seq);
    pb.heldKeys.add(k);
  }
}

/** Visual side of the on-event: cursor highlight, slur glide (sustained-
 *  instrument path), syncPianoOut, draw, playback-position ack. Runs at
 *  score-on time via setTimeout. */
function scheduleOnVisualAt(
  ev: PlaybackEvent,
  step: LegatoStep,
  delayMs: number,
  pb: ActivePlayback,
  canGlide: boolean,
  rearticulatedKeys: KeyId[],
): void {
  const h = window.setTimeout(() => {
    pb.pending.delete(h);
    if (pb.cancelled) return;
    const keys = ev.notes.map(coordToKeyId);
    if (canGlide) {
      /* Slur glide-in — purely visual. The audio handoff (rate ramp +
         voiceGain crossfade) already ran sample-accurately at tick time in
         scheduleAudioForEvent with atTime=audioOnSec. Here we just sync the
         user-visible selection highlight to the new pitch at score-on time
         so it tracks what the listener hears. */
      const oldKey = step.glideFromKey!;
      const newKey = keys[0];
      if (playbackOwnedKeys.has(oldKey)) {
        playbackOwnedKeys.delete(oldKey);
        selection.selectedKeys.delete(oldKey);
      }
      audio.sustainedKeys.delete(newKey);
      if (!selection.selectedKeys.has(newKey)) {
        selection.selectedKeys.add(newKey);
        playbackOwnedKeys.add(newKey);
      }
    } else {
      for (const k of keys) {
        if (!selection.selectedKeys.has(k)) {
          selection.selectedKeys.add(k);
          playbackOwnedKeys.add(k);
        }
      }
      /* External-synth restrike + visual flash for keys that were already
         sounding at scheduling time (back-to-back same-pitch). These fire
         at score-on time so the external MIDI message lands roughly with
         the audio onset. */
      for (const k of rearticulatedKeys) {
        restrikePianoOut(k);
        triggerRearticulateFlash(k);
      }
    }
    syncPianoOut(); /* mirror this chord's attacks to the external synth */
    requestDraw();
    bridge.send({
      type: 'playback-position',
      meiId: ev.meiId ?? null,
      timeMs: ev.atMs,
    });
  }, Math.max(0, delayMs));
  pb.pending.add(h);
}

/** Schedule the off-side bookkeeping + audio release for an event. Runs at
 *  score-off time via setTimeout; voiceSeq snapshot taken at scheduling
 *  time guards against a later event re-articulating the same key (that
 *  event's own off handler will tear it down). */
function scheduleOffVisualAt(
  ev: PlaybackEvent,
  delayMs: number,
  pb: ActivePlayback,
  canGlide: boolean,
): void {
  /* canGlide: only the new key has an off pending; the old key was
     handed off to the new one and its bookkeeping already moved. */
  const offKeys: KeyId[] = canGlide
    ? [coordToKeyId(ev.notes[0])]
    : ev.notes.map(coordToKeyId);
  /* Snapshot seq AT SCHEDULING TIME (right after scheduleAudioForEvent /
     scheduleOnVisualAt populated it for this event). A later event
     re-articulating the same key will increment pb.voiceSeq[k] past our
     snapshot — we then skip the teardown so the live voice survives. */
  const ownedSeq = new Map<KeyId, number>();
  for (const k of offKeys) {
    const s = pb.voiceSeq.get(k);
    if (s !== undefined) ownedSeq.set(k, s);
  }
  const h = window.setTimeout(() => {
    pb.pending.delete(h);
    if (pb.cancelled) return;
    let mutated = false;
    for (const k of offKeys) {
      if (pb.voiceSeq.get(k) !== ownedSeq.get(k)) continue;
      pb.voiceSeq.delete(k);
      noteOff(k);
      pb.heldKeys.delete(k);
      if (playbackOwnedKeys.has(k)) {
        selection.selectedKeys.delete(k);
        playbackOwnedKeys.delete(k);
      }
      mutated = true;
    }
    if (mutated) { syncPianoOut(); requestDraw(); }
  }, Math.max(0, delayMs));
  pb.pending.add(h);
}

interface LegatoStep {
  offMs?: number;
  noOff?: boolean;
  glideFromKey?: KeyId;
  rampMs?: number;
}

/** Per-event slur realization, decided HKL-side because it depends on the
 *  active instrument. `glideMode` (sustained loopers): single-note slurred
 *  transitions hand one voice off via a pitch glide; chord-involved joins
 *  fall back to normal abutting playback. Otherwise (decay + replay-on-
 *  transpose): slurred notes get a note-proportional release overlap. */
function computeLegatoPlan(events: ReadonlyArray<PlaybackEvent>, glideMode: boolean): LegatoStep[] {
  const plan: LegatoStep[] = events.map(() => ({}));
  if (!glideMode) {
    events.forEach((ev, i) => {
      if (ev.slurredToNext) plan[i].offMs = ev.durationMs * (1 + SLUR_OVERLAP_FRACTION);
    });
    return plan;
  }
  /* Group each voice's events into same-onset slots (preserving the global
     atMs order events already arrive in), then glide between consecutive
     single-note slots where the earlier is slurred. */
  const byVoice = new Map<number, number[]>();
  events.forEach((ev, i) => {
    const v = ev.voice ?? 0;
    const list = byVoice.get(v);
    if (list) list.push(i); else byVoice.set(v, [i]);
  });
  for (const list of byVoice.values()) {
    const slots: Array<{ atMs: number; idxs: number[] }> = [];
    for (const idx of list) {
      const last = slots[slots.length - 1];
      if (last && Math.abs(last.atMs - events[idx].atMs) < 1e-6) last.idxs.push(idx);
      else slots.push({ atMs: events[idx].atMs, idxs: [idx] });
    }
    for (let s = 0; s + 1 < slots.length; s++) {
      const cur = slots[s], nxt = slots[s + 1];
      if (cur.idxs.length !== 1 || nxt.idxs.length !== 1) continue;
      const ci = cur.idxs[0], ni = nxt.idxs[0];
      if (!events[ci].slurredToNext) continue;
      if (events[ci].notes.length !== 1 || events[ni].notes.length !== 1) continue;
      plan[ci].noOff = true;
      plan[ni].glideFromKey = coordToKeyId(events[ci].notes[0]);
      plan[ni].rampMs = Math.min(SLUR_GLIDE_MS, events[ci].durationMs * 0.5);
    }
  }
  return plan;
}

function playScore(events: ReadonlyArray<PlaybackEvent>): void {
  abortActive();
  if (events.length === 0) {
    bridge.send({ type: 'playback-finished' });
    return;
  }
  /* Without an audio context we can't anchor on the audio clock at all —
     fall through to the message ack so Composer's playback-finished
     handshake completes. The recording-playback path has its own audio-
     enabled check inside noteOn, so a missing context just produces a
     silent playthrough; not worth replicating here. */
  if (!audio.audioCtx) {
    bridge.send({ type: 'playback-finished' });
    return;
  }
  const pb = newPlayback();
  active = pb;
  playbackActive = true;

  /* Slur legato realization is instrument-dependent and the instrument is
     HKL-side state, so the choice is made here (not in Composer): sustained
     loopers glide one voice between slurred pitches; decay + replay-on-
     transpose instruments overlap the release into the next attack. Mode is
     fixed at playback start; mid-playback instrument changes are rare and
     playback is short. */
  const plan = computeLegatoPlan(events, !instrReplaysOnTranspose());

  /* Two clocks anchored at playback start:
       t0Audio — base of all sample-accurate ON scheduling (audio seconds).
                 +50ms matches the SampleEngine's live-input default lead;
                 gives the audio thread headroom for the first source.
       t0Wall  — base of all visual + off setTimeout delays (performance.now).
     They drift on long playbacks (different clock sources), but for the
     duration of a score that's invisible. */
  const t0Audio = audio.audioCtx.currentTime + 0.050;
  const t0Wall = performance.now();

  /* Precompute the latest off time so the finished-broadcast setTimeout can
     be scheduled once when the driver drains. */
  let lastEndMs = 0;
  for (let i = 0; i < events.length; i++) {
    const step = plan[i];
    lastEndMs = Math.max(lastEndMs, events[i].atMs + (step.offMs ?? events[i].durationMs));
  }

  let nextIdx = 0;

  function tick(): void {
    if (pb.cancelled) return;
    const elapsedMs = performance.now() - t0Wall;
    const horizonMs = elapsedMs + LOOKAHEAD_MS;
    /* Schedule every event whose onset falls in [now, now+lookahead]. The
       per-tick batch can be empty (driver firing between events) or hold
       many (a dense passage). */
    while (nextIdx < events.length && events[nextIdx].atMs <= horizonMs) {
      const ev = events[nextIdx];
      const step = plan[nextIdx];
      const audioOnSec = t0Audio + ev.atMs / 1000;
      const offEndMs = ev.atMs + (step.offMs ?? ev.durationMs);
      /* Now that the audio glide runs at tick time (with sample-accurate
         atTime), audio.activeOscs is the live engine state at this point
         in the tick — earlier same-tick events that scheduled audio (noteOn
         for non-canGlide, glideVoices for canGlide) have already rekeyed
         it. Reading it here gives the correct answer for both same-tick
         and cross-tick slur chains. */
      const canGlide = step.glideFromKey != null
        && ev.notes.length === 1
        && !!audio.activeOscs[step.glideFromKey];
      /* Capture which keys are about to be re-articulated (already in
         activeOscs at scheduling time and not being glided). The visual-on
         track uses this to fire restrikePianoOut + the rearticulate flash
         at score-on time. Must be computed before scheduleAudioForEvent
         since that call mutates activeOscs. */
      const rearticulatedKeys: KeyId[] = [];
      if (!canGlide && ev.notes.length > 0) {
        for (const c of ev.notes) {
          const k = coordToKeyId(c);
          if (audio.activeOscs[k]) rearticulatedKeys.push(k);
        }
      }
      if (ev.notes.length > 0) {
        scheduleAudioForEvent(ev, step, audioOnSec, pb, canGlide);
      }
      scheduleOnVisualAt(ev, step, ev.atMs - elapsedMs, pb, canGlide, rearticulatedKeys);
      if (ev.notes.length > 0 && !step.noOff) {
        scheduleOffVisualAt(ev, offEndMs - elapsedMs, pb, canGlide);
      }
      nextIdx++;
    }
    if (nextIdx < events.length) {
      pb.driverHandle = window.setTimeout(tick, DRIVER_INTERVAL_MS);
    } else {
      /* All events scheduled. Final position + finished broadcast at
         lastEndMs+50, matching the legacy behavior. */
      pb.driverHandle = undefined;
      const finDelay = (lastEndMs + 50) - elapsedMs;
      const finHandle = window.setTimeout(() => {
        pb.pending.delete(finHandle);
        if (pb.cancelled) return;
        bridge.send({ type: 'playback-position', meiId: null, timeMs: lastEndMs });
        bridge.send({ type: 'playback-finished' });
        playbackActive = false;
        if (active === pb) active = null;
        /* Resync held-keys with the user's real selection (any input that
           arrived during playback was broadcast-suppressed). */
        broadcastHeldKeys();
      }, Math.max(0, finDelay));
      pb.pending.add(finHandle);
    }
  }
  tick();
}

/* ── composer required layout cache + apply ─────────────────────────────── */

interface ComposerLayoutReq {
  tuningMode: TuningMode;
  refQ: number;
  refR: number;
}

/** Most-recently-broadcast layout requirement from Composer's `<hkl:layoutReq>`.
 *  Null until composer-hello + layout-req-changed handshake completes. Used by
 *  the playback gate (mismatch prompt) and by the Sync-to-Composer auto-apply. */
let composerRequiredLayout: ComposerLayoutReq | null = null;
let composerConnected = false;

export function getComposerRequiredLayout(): ComposerLayoutReq | null {
  return composerRequiredLayout;
}

export function isComposerConnected(): boolean {
  return composerConnected;
}

/** Send a transcribed score to Composer for editing. The caller gates on
 *  isComposerConnected() — there is no silent fallback. */
export function importScoreToComposer(mei: string): void {
  bridge.send({ type: 'import-score', mei });
}

/** Refresh the HKL toolbar's Composer group — visibility, connection label,
 *  score-layout label, and match indicator. Called from every state change
 *  that can affect them: composer-hello / composer-bye / layout-req-changed /
 *  setTuning() (via onTuningChanged). */
function updateComposerToolbar(): void {
  const group = document.getElementById('tb-group-composer') as HTMLElement | null;
  if (!group) return;
  group.style.display = composerConnected ? '' : 'none';
  if (!composerConnected) return;
  const connEl = document.getElementById('composerConnStatus');
  if (connEl) {
    connEl.textContent = 'Composer connected';
    connEl.classList.remove('luma-disconnected');
    connEl.classList.add('luma-connected');
  }
  const layoutEl = document.getElementById('composerScoreLayout');
  if (layoutEl) {
    if (composerRequiredLayout) {
      layoutEl.textContent = 'Score: ' + tuningLabelFor(composerRequiredLayout.tuningMode);
    } else {
      layoutEl.textContent = '';
    }
  }
  const matchEl = document.getElementById('composerLayoutMatch');
  if (matchEl) {
    if (!composerRequiredLayout) {
      matchEl.textContent = '';
    } else if (composerRequiredLayout.tuningMode === tuning.mode) {
      matchEl.textContent = '✓ match';
      matchEl.style.color = '#4ec466';
    } else {
      matchEl.textContent = '⚠ mismatch';
      matchEl.style.color = '#e0a020';
    }
  }
}

/** Public update hook so other modules (onTuningChanged) can refresh the
 *  match indicator when HKL's tuning changes. */
export function refreshComposerToolbar(): void {
  updateComposerToolbar();
}

/** Apply the currently-cached Composer required layout to HKL (no-op when
 *  Composer hasn't broadcast one). Used by the Sync-to-Composer toggle to
 *  push the catch-up apply when the user flips the switch on while there's
 *  already a mismatch. */
export function applyComposerLayout(): void {
  if (composerRequiredLayout) applyLayoutFromComposer(composerRequiredLayout);
}

function isTuningMode(s: string): s is TuningMode {
  return s === 'E' || s === '5' || s === 'P' || s === 'D' || s === '7' || s === 'V';
}

const TUNING_LABELS: Record<TuningMode, string> = {
  E: 'Equal',
  '5': 'Ptolemaic',
  P: 'Pythagorean',
  D: 'Semiditonal',
  '7': 'Septimal',
  V: 'Schismatic',
};
function tuningLabelFor(m: string): string {
  return TUNING_LABELS[m as TuningMode] ?? m;
}

/** Push tuning + ref into HKL state as if the user had selected them via the
 *  toolbar / Ctrl+click. Fires the same onTuningChanged / onRefChanged effects
 *  so audio, view, MIDI, and Composer broadcasts all update normally. */
function applyLayoutFromComposer(req: ComposerLayoutReq): void {
  /* Tuning mode — drive through the toolbar select so persistence + listeners
     stay coherent. setTuning() reads #selTuning, runs validation, mutates
     state, persists, and fires onTuningChanged. */
  const selTuning = document.getElementById('selTuning') as HTMLSelectElement | null;
  if (selTuning && selTuning.value !== req.tuningMode) {
    selTuning.value = req.tuningMode;
    setTuning();
  }
  /* Ref — apply as a composer-source selection (NOT manual). This means it
     participates in the outline-mode gating in reference.ts: effective only
     in piano outline mode; in lumatone/qwerty/none modes, song-key from the
     key signature wins. Also do NOT persist as manualRef — the layoutReq is
     a score-level pinning, not a user Ctrl+click, and the blank-score auto-
     adopt path used to echo HKL's own default back as a permanent manualRef
     that masked song-key forever after. */
  if (validateRefNoteCandidate(req.refQ, req.refR) !== null) return;
  const oldAQ = view.kbAnchorQ, oldAR = view.kbAnchorR;
  if (setSelectionFromComposer(req.refQ, req.refR)) {
    const sp = refSpine(referenceNote.q, referenceNote.r);
    view.kbAnchorQ = sp.q;
    view.kbAnchorR = sp.r;
    onRefChanged(sp.q - oldAQ, sp.r - oldAR);
    invalidatePianoOutline();
    /* Snap (immediate=true), not tween. Composer-driven sync is programmatic
       state adoption, not user navigation. Multi-message handshakes (composer-
       hello → layout-req-changed → set-song-key, possibly + set-reference-note)
       used to fire successive `syncViewToOutline(false)` calls inside one
       microtask chain — each resetting the tween's startQ to the previous
       call's frozen viewQ. Net effect: view stuck at an intermediate position
       with seams/outline/note-names drifted from the lattice cells. Snapping
       eliminates the in-flight animation state entirely. */
    syncViewToOutline(currentOutlineForBridge(), true);
    draw();
  }
}

/* ── inbound message dispatch ────────────────────────────────────────────── */

function announce(): void {
  bridge.send({ type: 'hkl-hello', version: PROTOCOL_VERSION });
  bridge.send({ type: 'tuning-changed', mode: tuningMode(), description: tuningDescription() });
  /* Force a held-keys + footprint + layout-state broadcast even if empty.
     Composer's blank-score auto-adopt path keys off hkl-layout-state, so
     forcing a resend here ensures fresh-open Composer tabs receive it. */
  lastHeldSerialized = 'force-resend';
  lastFootprintSig = 'force-resend';
  lastLayoutStateSig = 'force-resend';
  broadcastHeldKeys();
  broadcastFootprint();
  broadcastLayoutState();
}

bridge.on((msg: ComposerEvent) => {
  switch (msg.type) {
    case 'composer-hello':
      composerConnected = true;
      updateComposerToolbar();
      announce();
      break;
    case 'request-state':
      announce();
      break;
    case 'composer-bye':
      /* Composer disconnected. Stop any playback in progress so we're not
         left with stuck notes, and drop composer-set ref-note tiers. A
         user's manual Ctrl+click selection survives the bye. */
      composerConnected = false;
      composerRequiredLayout = null;
      updateComposerToolbar();
      abortActive();
      if (onComposerBye()) {
        invalidatePianoOutline();
        /* Snap — see applyLayoutFromComposer comment. Composer dropping a
           ref-tier is structural, not navigational. */
        syncViewToOutline(currentOutlineForBridge(), true);
        draw();
        broadcastAllToComposer();
      }
      break;
    case 'play-score': {
      /* Layout gate: playback frequency must match what the score was entered
         in. If HKL's current tuning doesn't match the score's pinned mode,
         Sync-to-Composer applies silently; otherwise we prompt. On cancel,
         emit playback-finished so Composer's UI doesn't stall. */
      const required = composerRequiredLayout;
      if (required && tuning.mode !== required.tuningMode) {
        const prefs = loadPrefs();
        if (prefs.syncToComposer) {
          applyLayoutFromComposer(required);
        } else {
          const apply = window.confirm(
            'This score requires "' + tuningLabelFor(required.tuningMode) + '" but HKL is in "'
            + tuningLabelFor(tuning.mode) + '".\n\n'
            + 'Apply the score\'s tuning to HKL?'
          );
          if (apply) {
            applyLayoutFromComposer(required);
          } else {
            bridge.send({ type: 'playback-finished' });
            break;
          }
        }
      }
      playScore(msg.events);
      break;
    }
    case 'stop-playback':
      abortActive();
      bridge.send({ type: 'playback-finished' });
      break;
    case 'layout-req-changed': {
      const mode = isTuningMode(msg.tuningMode) ? msg.tuningMode : '5';
      composerRequiredLayout = { tuningMode: mode, refQ: msg.refQ, refR: msg.refR };
      updateComposerToolbar();
      if (loadPrefs().syncToComposer) {
        applyLayoutFromComposer(composerRequiredLayout);
      }
      break;
    }
    case 'apply-layout': {
      const mode = isTuningMode(msg.tuningMode) ? msg.tuningMode : '5';
      applyLayoutFromComposer({ tuningMode: mode, refQ: msg.refQ, refR: msg.refR });
      break;
    }
    case 'set-reference-note':
      /* Sets the selection tier from Composer. Last-writer-wins between
         this and any user Ctrl+click. Composer broadcasts are validated
         against the same MIDI-range + accidental constraints as
         Ctrl+click — Composer has its own accidental-clamp fallback for
         entering notes, but rejecting at the ref-note-set stage is
         smoother (the dashed marker never moves to an unspellable cell
         and the piano outline never reshapes to a >±3 layout). */
      if (validateRefNoteCandidate(msg.q, msg.r) === null
          && setSelectionFromComposer(msg.q, msg.r)) {
        invalidatePianoOutline();
        /* Snap — see applyLayoutFromComposer comment. Cursor-follow used to
           animate, but the multi-message reset race made even single
           set-reference-note updates land mid-tween when the handshake
           was still in flight. */
        syncViewToOutline(currentOutlineForBridge(), true);
        draw();
        broadcastAllToComposer();
      }
      break;
    case 'set-song-key': {
      /* Sets the song-key tier. When the song-key becomes the effective ref
         (no manual override, no composer-cursor in piano mode), mirror the
         Ctrl+click path: advance kbAnchor so the Lumatone/QWERTY outline
         centers on the new song-key, and fire onRefChanged so any held
         physical voices migrate to the new lattice cells. Cursor-derived
         refs (set-reference-note) deliberately do NOT do this — they're
         piano-outline-only and shouldn't drag the static outline around. */
      const oldAQ = view.kbAnchorQ, oldAR = view.kbAnchorR;
      if (setSongKey(msg.q, msg.r)) {
        const sp = refSpine(referenceNote.q, referenceNote.r);
        view.kbAnchorQ = sp.q;
        view.kbAnchorR = sp.r;
        invalidatePianoOutline();
        /* Snap — see applyLayoutFromComposer comment. */
        syncViewToOutline(currentOutlineForBridge(), true);
        draw();
        onRefChanged(sp.q - oldAQ, sp.r - oldAR);
        /* onRefChanged short-circuits when the spine delta is (0,0) — but
           the footprint + layout-state still need to update because they
           track referenceNote, not kbAnchor. Different refs can map to the
           same refSpine. broadcastAllToComposer is sig-diff cached so this
           is a no-op when onRefChanged did fire it. */
        broadcastAllToComposer();
      }
      break;
    }
  }
});

/* ── analyzer bridge ─────────────────────────────────────────────────────── */

/** Auto-select the imported instrument in the waveform dropdown so the user
 *  hears it immediately. Same UX as the existing `+ .hki` file picker —
 *  set value + dispatch change so the engine reloads. */
function autoSelectImported(instrumentKey: string): void {
  const sel = document.getElementById('waveform') as HTMLSelectElement | null;
  if (!sel) return;
  /* Only switch if the key actually appears in the dropdown (will only after
     the registry's onChange has rebuilt the optgroup). */
  if ([...sel.options].some(o => o.value === instrumentKey)) {
    sel.value = instrumentKey;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function announceToAnalyzer(): void {
  analyzerBridge.send({ type: 'hkl-hello', version: ANALYZER_PROTOCOL_VERSION });
}

analyzerBridge.on((msg: AnalyzerEvent) => {
  switch (msg.type) {
    case 'analyzer-hello':
      announceToAnalyzer();
      break;
    case 'analyzer-bye':
      /* No held analyzer-side state to clean up. */
      break;
    case 'import-hki': {
      /* Receive bytes inline + write to IDB ourselves (same path as the
         `+ .hki` file picker in src/ui/instrumentBundles.ts). Keeps the
         analyzer side from having to import src/state/. */
      void (async () => {
        try {
          const manifest = await InstrumentRegistry.importBundle(msg.bytes);
          autoSelectImported(manifest.instrumentKey);
          analyzerBridge.send({ type: 'import-ack', instrumentKey: manifest.instrumentKey, ok: true });
        } catch (err) {
          analyzerBridge.send({
            type: 'import-ack',
            instrumentKey: msg.instrumentKey,
            ok: false,
            error: (err as Error).message,
          });
        }
      })();
      break;
    }
    case 'import-cdn-config': {
      void (async () => {
        try {
          await CdnConfigRegistry.importConfig(msg.config);
          autoSelectImported(msg.instrumentKey);
          analyzerBridge.send({ type: 'import-ack', instrumentKey: msg.instrumentKey, ok: true });
        } catch (err) {
          analyzerBridge.send({
            type: 'import-ack',
            instrumentKey: msg.instrumentKey,
            ok: false,
            error: (err as Error).message,
          });
        }
      })();
      break;
    }
  }
});

/* ── lifecycle ───────────────────────────────────────────────────────────── */

window.addEventListener('beforeunload', () => {
  abortActive();
  bridge.send({ type: 'hkl-bye' });
  analyzerBridge.send({ type: 'hkl-bye' });
});

let initialized = false;
export function initHklBridge(): void {
  if (initialized) return;
  initialized = true;
  announce();
  announceToAnalyzer();
}

/* DevTools handle. */
(window as unknown as { __hkl_bridge: unknown }).__hkl_bridge = {
  bridge,
  resolveKey,
  abortActive,
  stopAllNotes,
  broadcastHeldKeys,
  broadcastTuning,
  broadcastFootprint,
};
