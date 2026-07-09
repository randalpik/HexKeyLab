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

import { createHklBridge, createAnalyzerHklBridge, createOrchestratorHklBridge, PROTOCOL_VERSION, ANALYZER_PROTOCOL_VERSION, ORCHESTRATOR_PROTOCOL_VERSION } from '@hkl/bridge/channel.js';
import type {
  ComposerEvent, PlaybackEvent, PedalEvent, ResolvedNote, CoordRef,
} from '@hkl/bridge/protocol.js';
import type { AnalyzerEvent } from '@hkl/bridge/analyzer-protocol.js';
import type { OrchestratorEvent } from '@hkl/bridge/orchestrator-protocol.js';
import * as InstrumentRegistry from '../state/instrumentRegistry.js';
import * as CdnConfigRegistry from '../state/cdnConfigRegistry.js';
import { selection } from '../state/selection.js';
import { audio } from '../state/audio.js';
import { tuning } from '../state/tuning.js';
import { darkColorHex } from '../transcription/pitch.js';
import { lightSourceHex } from '../render/colors.js';
import { resolveNoteSpec } from '../tuning/spell.js';
import { noteOn, noteOff, stopAllNotes, triggerRearticulateFlash, instrReplaysOnTranspose, glideVoices, setActiveWaveform } from '../audio/engine.js';
import { SampleEngine } from '../audio/samples.js';
import { syncPianoOut, restrikePianoOut, sendSustainPedal } from '../midi/piano-out.js';
import { pedal } from '../state/pedal.js';
import { draw, requestDraw, activeFootprintSet, invalidatePianoOutline, validateRefNoteCandidate } from '../render/draw.js';
import { setComposerScore, setComposerCursor, setComposerPlaybackBars, clearComposerFrame } from '../render/composer-frame.js';
import { publishComposerScore, publishComposerPlayback } from './overlay-publish.js';
import { syncViewToOutline } from '../ui/controls.js';
import { DEFAULT_DYNAMIC_MAP } from '@hkl/shared/dynamics.js';
import { setSelectionFromComposer, setScoreRef, clearSelection, selectionDiffersFromScoreRef, onComposerBye, referenceNote } from '../state/reference.js';
import { refSpine } from '../tuning/refspine.js';
import { view } from '../state/view.js';
import { onRefChanged } from '../effects/onRefChanged.js';
import { setTuning } from '../ui/controls.js';
import { loadPrefs, type TuningMode } from '../state/persistence.js';
import type { FootprintCell } from '@hkl/bridge/protocol.js';
import type { KeyId } from '../types.js';

const bridge = createHklBridge();
const analyzerBridge = createAnalyzerHklBridge();
const orchestratorBridge = createOrchestratorHklBridge();

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

/* Performance mode (Composer-driven): when active, every live note-on is
   forwarded to Composer as a `player-note-struck` event so Composer's
   input-driven playback cursor can advance. Gated so the strike stream stays
   silent otherwise. Suppressed during playbackActive (a play-score in flight
   would otherwise echo its own audio as player input). */
let performanceMode = false;

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

/** Forward a single live note strike to Composer for Performance mode. Called
 *  from the MIDI note-on path. No-op unless Performance mode is active and no
 *  play-score is in flight. Reuses `resolveKey` so the strike's identity
 *  (pname/accid/oct/colorHex) is byte-identical to what held-keys resolves. */
export function broadcastPlayerNote(q: number, r: number): void {
  if (!performanceMode || playbackActive) return;
  bridge.send({ type: 'player-note-struck', note: resolveKey(q, r) });
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
      cells.push([q, r, darkColorHex(q, r), lightSourceHex(q, r)]);
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
  /* Keys whose scheduled note-off was DEFERRED because the sustain pedal was
     down at the time (mirrors the live release path in handler.ts). They keep
     ringing and stay in audio.sustainedKeys until a pedal-up event releases
     them (or playback ends / aborts). Their voiceSeq/heldKeys entries are left
     intact so abort still tears them down. */
  pedalSustained: Map<KeyId, string | undefined>;
  /* True once any pedal-down event has fired in this run — gates the teardown
     reset (release global damper flags + external CC 64) on stop/finish. */
  pedalEngaged: boolean;
  /* Which instruments currently have their pedal DOWN (per-instrument damper;
     keyed by instrumentKey, undefined = the single-instrument / global pedal).
     A per-instrument pedal-up releases only its own deferred voices; the global
     damper flags + CC 64 reset only when this set empties. */
  pedalEngagedInstr: Set<string | undefined>;
  /* The instrument (sample-set key) each currently-sounding KeyId was attacked
     with. A slur glide may only rekey a voice belonging to the SAME instrument
     — otherwise (two instruments unison a pitch; the lower one's note was
     dropped by the topmost-wins dedup but its slur still continues) the glide
     would steal the topmost instrument's live voice. Mismatch → no glide;
     the slur target re-attacks fresh in its own instrument. */
  voiceInstr: Map<KeyId, string | undefined>;
}

let active: ActivePlayback | null = null;

function newPlayback(): ActivePlayback {
  return {
    cancelled: false, pending: new Set(), heldKeys: new Set(), voiceSeq: new Map(),
    nextSeq: 0, pedalSustained: new Map(), pedalEngaged: false, pedalEngagedInstr: new Set(),
    voiceInstr: new Map(),
  };
}

/** Release any pedal-deferred playback voices and reset the global damper
 *  state this run engaged. Used by both natural finish and abort. Uses the
 *  playback teardown idiom (direct noteOff) rather than the live damper-
 *  release machinery, so it stays consistent with the rest of the scheduler
 *  and avoids re-entering onSelectionChanged mid-playback. */
/** Note-off one pedal-deferred key + drop its bookkeeping. */
function releaseDeferredKey(pb: ActivePlayback, k: KeyId): void {
  audio.sustainedKeys.delete(k);
  pb.voiceSeq.delete(k);
  noteOff(k);
  pb.heldKeys.delete(k);
  if (playbackOwnedKeys.has(k)) {
    selection.selectedKeys.delete(k);
    playbackOwnedKeys.delete(k);
  }
}

/** Reset the GLOBAL damper flags + external CC 64 (only meaningful once no
 *  instrument's pedal is still down). Flags set DIRECTLY — NOT via
 *  setDamperDepth(), which runs onSelectionChanged → syncAudio (the live-input
 *  reconciliation that would clip a fresh same-moment attack). Playback owns
 *  its voices via explicit noteOff; the global engine never reconciles them. */
function resetGlobalDamperFlags(pb: ActivePlayback): void {
  if (!pb.pedalEngaged) return;
  pb.pedalEngaged = false;
  pedal.cc64Depth = 0;
  audio.sustainPedalDown = false;
  audio.damperDepth = 0;
  sendSustainPedal(false);
}

/** Release every pedal-deferred voice (finish / abort), regardless of which
 *  instrument held it, and reset the global damper state. */
function releasePlaybackPedal(pb: ActivePlayback): void {
  for (const k of pb.pedalSustained.keys()) releaseDeferredKey(pb, k);
  pb.pedalSustained.clear();
  pb.pedalEngagedInstr.clear();
  resetGlobalDamperFlags(pb);
}

/** Release only the voices held by ONE instrument's pedal (a per-instrument
 *  pedal-up). The global damper flags reset only once no instrument's pedal
 *  remains down. */
function releaseInstrumentPedal(pb: ActivePlayback, instrumentKey: string | undefined): void {
  for (const [k, owner] of Array.from(pb.pedalSustained)) {
    if (owner !== instrumentKey) continue;
    releaseDeferredKey(pb, k);
    pb.pedalSustained.delete(k);
  }
  pb.pedalEngagedInstr.delete(instrumentKey);
  if (pb.pedalEngagedInstr.size === 0) resetGlobalDamperFlags(pb);
}

/** Apply one pedal transition at its scheduled (wall-clock) moment. Down →
 *  engage the damper (subsequent note-offs defer into audio.sustainedKeys) +
 *  CC 64 = 127. Up → release the deferred voices + CC 64 = 0. Binary sustain,
 *  so ~driver-tick jitter on the transition is inaudible (matches the note-off
 *  jitter tolerance documented above). */
function applyPedalTransition(pb: ActivePlayback, dir: PedalEvent['dir'], instrumentKey: string | undefined): void {
  if (pb.cancelled) return;
  if (dir === 'down') {
    pb.pedalEngaged = true;
    pb.pedalEngagedInstr.add(instrumentKey);
    /* Global hardware flags engage on any instrument's pedal-down (external CC
       64 mirroring stays global — per-instrument external routing is out of
       scope for this prerequisite). Set directly; see resetGlobalDamperFlags. */
    pedal.cc64Depth = 1;
    audio.sustainPedalDown = true;
    audio.damperDepth = 1;
    sendSustainPedal(true);
    return;
  }
  releaseInstrumentPedal(pb, instrumentKey);
  syncPianoOut();
  requestDraw();
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
  /* Drop any pedal-deferred voices from the global sustained set and reset the
     damper flags + external CC 64 this run engaged. */
  releasePlaybackPedal(active);
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
    /* Reconcile the pedal sets for the glide TARGET, mirroring the normal
       attack path below. If this pitch was pedal-deferred earlier in the span
       (recurring note), it's now being re-voiced by the glide: stop that stale
       deferred voice (so glideVoices doesn't orphan it) and drop its deferral
       tracking, else a later pedal-up's releasePlaybackPedal would note-off the
       live glided voice — cutting the note after a pedal-off in a slur. */
    if (audio.activeOscs[newKey] && newKey !== oldKey) noteOff(newKey, audioOnSec);
    audio.sustainedKeys.delete(newKey);
    pb.pedalSustained.delete(newKey);
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
    pb.voiceInstr.set(newKey, ev.instrumentKey);
    pb.voiceInstr.delete(oldKey);
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
    /* Re-attacked while pedal-sustained → no longer a deferred voice. */
    pb.pedalSustained.delete(k);
    /* Seed audio.keyVelocity so this attack shows up in loopdiag's vel trace
       like Lumatone / QWERTY / recording-playback do (all of which write
       keyVelocity before noteOn). Without the seed, Composer-dispatched
       notes are invisible to the diagnostic overlay. */
    const v = ev.velocity ?? audio.keyVelocity[k] ?? DEFAULT_DYNAMIC_MAP.mf;
    audio.keyVelocity[k] = v;
    noteOn(k, v, audioOnSec, ev.instrumentKey);
    const seq = ++pb.nextSeq;
    pb.voiceSeq.set(k, seq);
    pb.heldKeys.add(k);
    pb.voiceInstr.set(k, ev.instrumentKey);
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
    try {
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
    } catch (err) {
      logPlaybackError('visual-on', { meiId: ev.meiId, canGlide, ...playbackStateSnapshot(pb) }, err);
    }
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
  deferUnderPedal: boolean,
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
    try {
    let mutated = false;
    for (const k of offKeys) {
      if (pb.voiceSeq.get(k) !== ownedSeq.get(k)) continue;
      /* Pedal captures this note's release (decided deterministically from the
         pedal timeline at schedule time — see pedalCapturesNoteEndingAt):
         defer the off, keep the voice ringing and mark it sustained, like the
         live release path (handler.ts). voiceSeq/heldKeys stay populated so
         abort tears it down; selection stays lit. A pedal-up event, re-attack,
         or playback end releases it. */
      if (deferUnderPedal && !audio.sostenutoLockedKeys.has(k)) {
        audio.sustainedKeys.add(k);
        pb.pedalSustained.set(k, ev.instrumentKey);
        continue;
      }
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
    } catch (err) {
      logPlaybackError('visual-off', { offKeys, deferUnderPedal, ...playbackStateSnapshot(pb) }, err);
    }
  }, Math.max(0, delayMs));
  pb.pending.add(h);
}

/** Clear a single voice's playback bar at `delayMs` from now — both the HKL
 *  Composer-view frame and (via the bridge) Composer. Scheduled at a voice's
 *  last note's written end when its content stops before the score does, so
 *  the per-voice bar disappears when the note expires instead of staying
 *  orphaned at that position for the rest of playback. */
function scheduleVoiceClearAt(voice: number, timeMs: number, delayMs: number, pb: ActivePlayback): void {
  const h = window.setTimeout(() => {
    pb.pending.delete(h);
    if (pb.cancelled) return;
    try {
      bridge.send({ type: 'playback-position', meiId: null, voice, timeMs });
    } catch (err) {
      logPlaybackError('voice-clear', { voice, ...playbackStateSnapshot(pb) }, err);
    }
  }, Math.max(0, delayMs));
  pb.pending.add(h);
}

interface LegatoStep {
  offMs?: number;
  noOff?: boolean;
  glideFromKey?: KeyId;
  rampMs?: number;
}

/** Is the sustain pedal down at moment `t` (ms)? Decided by the most-recent
 *  transition at-or-before t in a pre-sorted pedal timeline. */
function pedalDownAt(sortedPedals: ReadonlyArray<PedalEvent>, t: number, instrumentKey: string | undefined): boolean {
  let down = false;
  for (const pe of sortedPedals) {
    if (pe.instrumentKey !== instrumentKey) continue;
    if (pe.atMs <= t + 1e-6) down = pe.dir === 'down';
    else break;
  }
  return down;
}

/** Should a note whose release is at time `t` (ms) be captured (sustained) by
 *  the pedal? Boundary semantics matter: a pedal-DOWN exactly at `t` does NOT
 *  capture a note ending then (you press the pedal to catch notes still
 *  sounding, not ones releasing at that instant), and a pedal-UP exactly at `t`
 *  releases the note rather than deferring it. So: capture iff the pedal is
 *  down per transitions STRICTLY before `t`, and not lifted by an up exactly
 *  at `t`. Deciding from the timeline (not the live audio.sustainPedalDown
 *  flag at off-fire) also removes the wall-clock race between a note-off and a
 *  coincident pedal transition. */
function pedalCapturesNoteEndingAt(sortedPedals: ReadonlyArray<PedalEvent>, t: number, instrumentKey: string | undefined): boolean {
  let down = false;
  let upAtT = false;
  /* Only this note's OWN instrument's pedal can capture it (per-instrument
     damper). For single-instrument scores all events + pedals are unkeyed
     (instrumentKey undefined), so this matches everything — historic behavior. */
  for (const pe of sortedPedals) {
    if (pe.instrumentKey !== instrumentKey) continue;
    if (pe.atMs < t - 1e-6) down = pe.dir === 'down';
    else if (pe.atMs <= t + 1e-6) { if (pe.dir === 'up') upAtT = true; /* down-at-t captures future notes, not this one */ }
    else break;
  }
  return down && !upAtT;
}

/** Per-event slur realization, decided HKL-side because it depends on the
 *  active instrument. `glideMode` (sustained loopers): single-note slurred
 *  transitions hand one voice off via a pitch glide; chord-involved joins
 *  fall back to normal abutting playback. Otherwise (decay + replay-on-
 *  transpose): slurred notes get a note-proportional release overlap.
 *
 *  Pedal rule (Max): when the sustain pedal is DOWN at a slur transition,
 *  glide degrades to overlap there — the predecessor keeps ringing (and gets
 *  pedal-deferred at its overlap-off) rather than being pitch-glided into the
 *  successor. Because a glide is now never emitted while the pedal is down, a
 *  glide can never rekey a pedal-sustained voice, so the glide/pedal
 *  voice-tracking conflict is structurally impossible (deferred keys exist
 *  only while the pedal is down). */
function computeLegatoPlan(
  events: ReadonlyArray<PlaybackEvent>,
  sortedPedals: ReadonlyArray<PedalEvent> = [],
): LegatoStep[] {
  const plan: LegatoStep[] = events.map(() => ({}));
  const overlap = (i: number): void => {
    plan[i].offMs = events[i].durationMs * (1 + SLUR_OVERLAP_FRACTION);
  };
  /* Group each voice's events into same-onset slots (preserving the global
     atMs order events already arrive in), then glide between consecutive
     single-note slots where the earlier is slurred. Glide-vs-overlap is
     PER-INSTRUMENT: each voice's instrument (its events' instrumentKey, else
     HKL's active instrument) decides — so one run can mix glide (sustained
     loopers) and overlap (decay / replay-on-transpose). */
  const byVoice = new Map<number, number[]>();
  events.forEach((ev, i) => {
    const v = ev.voice ?? 0;
    const list = byVoice.get(v);
    if (list) list.push(i); else byVoice.set(v, [i]);
  });
  for (const list of byVoice.values()) {
    const glideMode = !instrReplaysOnTranspose(events[list[0]]?.instrumentKey);
    if (!glideMode) {
      for (const i of list) if (events[i].slurredToNext) overlap(i);
      continue;
    }
    const slots: Array<{ atMs: number; idxs: number[] }> = [];
    for (const idx of list) {
      const last = slots[slots.length - 1];
      if (last && Math.abs(last.atMs - events[idx].atMs) < 1e-6) last.idxs.push(idx);
      else slots.push({ atMs: events[idx].atMs, idxs: [idx] });
    }
    for (let s = 0; s + 1 < slots.length; s++) {
      const cur = slots[s], nxt = slots[s + 1];
      const ci = cur.idxs[0], ni = nxt.idxs[0];
      if (!events[ci].slurredToNext) continue;
      /* Pedal down at the transition → overlap the whole predecessor slot
         (works for chords too) and let it ride/defer under the pedal, instead
         of gliding. */
      if (pedalDownAt(sortedPedals, nxt.atMs, events[ci].instrumentKey)) {
        for (const i of cur.idxs) overlap(i);
        continue;
      }
      if (cur.idxs.length !== 1 || nxt.idxs.length !== 1) continue;
      if (events[ci].notes.length !== 1 || events[ni].notes.length !== 1) continue;
      plan[ci].noOff = true;
      plan[ni].glideFromKey = coordToKeyId(events[ci].notes[0]);
      plan[ni].rampMs = Math.min(SLUR_GLIDE_MS, events[ci].durationMs * 0.5);
    }
  }
  return plan;
}

/** Snapshot of the playback voice/pedal state, attached to error logs so an
 *  intermittent throw can be diagnosed from a single repro. */
function playbackStateSnapshot(pb: ActivePlayback): Record<string, unknown> {
  return {
    activeOscs: Object.keys(audio.activeOscs).length,
    heldKeys: pb.heldKeys.size,
    pedalSustained: Array.from(pb.pedalSustained.keys()),
    sustainedKeys: audio.sustainedKeys.size,
    pedalEngaged: pb.pedalEngaged,
    sustainPedalDown: audio.sustainPedalDown,
  };
}

/** Log a playback-path exception WITHOUT killing the transport. The driver and
 *  the deferred setTimeout callbacks call this so one bad event/voice can't
 *  silently freeze the whole piece (all cursors stop, deferred notes hang).
 *  The detail bag + state snapshot pinpoint the offending note + voice state. */
function logPlaybackError(label: string, detail: Record<string, unknown>, err: unknown): void {
  try {
    console.error('[playback] ' + label + ' threw; transport kept alive.',
      { ...detail }, err);
  } catch {
    console.error('[playback] ' + label + ' threw', err);
  }
}

async function playScore(events: ReadonlyArray<PlaybackEvent>, pedalEvents: ReadonlyArray<PedalEvent> = []): Promise<void> {
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

  /* Sorted pedal timeline — used both to shape the legato plan (glide degrades
     to overlap under the pedal) and to drive the pedal transitions below. */
  const pedals = pedalEvents.slice().sort((a, b) => a.atMs - b.atMs);

  /* Load every per-event instrument (multi-instrument scores) and WAIT before
     the driver starts. noteOn never falls back to a different timbre — an
     event whose instrument isn't loaded is skipped (silent) rather than played
     wrong — so we must finish loading first or that instrument wouldn't sound
     at all. (Single-instrument scores carry no instrumentKey and use HKL's
     active instrument; nothing to load here.) */
  {
    const keys = new Set<string>();
    for (const ev of events) if (ev.instrumentKey) keys.add(ev.instrumentKey);
    for (const pe of pedals) if (pe.instrumentKey) keys.add(pe.instrumentKey);
    const loads: Promise<void>[] = [];
    for (const key of keys) {
      if (!SampleEngine.isInstrumentLoaded(key) && SampleEngine.INSTRUMENTS[key]) {
        loads.push(SampleEngine.loadInstrument(key).catch((err: unknown) => {
          console.error('[playback] instrument load failed: ' + key, err);
        }));
      }
    }
    if (loads.length) await Promise.all(loads);
    /* A newer play-score (or a stop) during the load supersedes this run. */
    if (pb.cancelled || !audio.audioCtx) {
      if (active === pb) bridge.send({ type: 'playback-finished' });
      return;
    }
  }

  /* Slur legato realization is instrument-dependent and HKL-side state, so the
     choice is made here (not in Composer): sustained loopers glide one voice
     between slurred pitches; decay + replay-on-transpose instruments overlap
     the release into the next attack. The pedal timeline overrides
     glide→overlap wherever the pedal is down. Per-instrument (multi-instrument
     scores tag each event's instrumentKey; a single voice's instrument is
     fixed for the run). */
  const plan = computeLegatoPlan(events, pedals);

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
  /* A pedal can hold notes past their written end; let the finished-broadcast
     wait until the last pedal transition too (a pedal-up releases the deferred
     voices; a trailing pedal-down with no up is released at finish). */
  for (const pe of pedals) lastEndMs = Math.max(lastEndMs, pe.atMs);

  /* Onset of the next event in the SAME voice for each event (Infinity if it's
     that voice's last). Lets the driver clear a voice's playback bar at its
     last note's written end when the voice stops before the score does (a gap
     or end-of-voice) — otherwise the bar stays orphaned at that note. Events
     are sorted by atMs, so a backward sweep records the next same-voice onset. */
  const nextVoiceOnset = new Array<number>(events.length).fill(Infinity);
  {
    const lastSeen = new Map<number, number>();
    for (let i = events.length - 1; i >= 0; i--) {
      const v = events[i].voice ?? 1;
      const nxt = lastSeen.get(v);
      if (nxt !== undefined) nextVoiceOnset[i] = events[nxt].atMs;
      lastSeen.set(v, i);
    }
  }

  let nextIdx = 0;
  let pedalIdx = 0;

  function tick(): void {
    if (pb.cancelled) return;
    const elapsedMs = performance.now() - t0Wall;
    const horizonMs = elapsedMs + LOOKAHEAD_MS;
    /* Schedule every event whose onset falls in [now, now+lookahead]. The
       per-tick batch can be empty (driver firing between events) or hold
       many (a dense passage). */
    while (nextIdx < events.length && events[nextIdx].atMs <= horizonMs) {
      /* Advance the index BEFORE processing so a throw can't re-process (and
         re-throw on) the same event, and so the per-event guard below can skip
         it and let the driver carry on. */
      const idx = nextIdx;
      nextIdx++;
      try {
      const ev = events[idx];
      const step = plan[idx];
      const audioOnSec = t0Audio + ev.atMs / 1000;
      /* The note's WRITTEN end governs pedal capture (its musical release);
         the slur overlap tail (step.offMs) is only a legato release shape. */
      const writtenEndMs = ev.atMs + ev.durationMs;
      const overlapEndMs = ev.atMs + (step.offMs ?? ev.durationMs);
      /* Now that the audio glide runs at tick time (with sample-accurate
         atTime), audio.activeOscs is the live engine state at this point
         in the tick — earlier same-tick events that scheduled audio (noteOn
         for non-canGlide, glideVoices for canGlide) have already rekeyed
         it. Reading it here gives the correct answer for both same-tick
         and cross-tick slur chains. */
      const canGlide = step.glideFromKey != null
        && ev.notes.length === 1
        && !!audio.activeOscs[step.glideFromKey]
        /* The live voice at glideFromKey must belong to THIS event's instrument
           — else a unison-dropped slur would steal another instrument's voice. */
        && pb.voiceInstr.get(step.glideFromKey) === ev.instrumentKey;
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
        /* Capture is evaluated at the WRITTEN end (not the overlap tail). When
           captured, fire the deferring off at the written end too: the pedal —
           not the slur tail — now governs release, and deferring at the written
           end keeps the defer coincident with the capture decision, so a pedal
           that lifts during the tail can't strand the voice. When not captured,
           keep the legato overlap tail. */
        const deferUnderPedal = pedalCapturesNoteEndingAt(pedals, writtenEndMs, ev.instrumentKey);
        const offFireMs = deferUnderPedal ? writtenEndMs : overlapEndMs;
        scheduleOffVisualAt(ev, offFireMs - elapsedMs, pb, canGlide, deferUnderPedal);
      }
      /* If no same-voice event starts by this one's written end (a gap or the
         voice's last element — note OR rest), clear the voice's bar then so it
         doesn't stay orphaned. The 1ms slack avoids clearing when the next
         note is contiguous (it repositions the bar itself). */
      if (nextVoiceOnset[idx] - writtenEndMs > 1) {
        scheduleVoiceClearAt(ev.voice ?? 1, writtenEndMs, writtenEndMs - elapsedMs, pb);
      }
      } catch (err) {
        const bad = events[idx];
        logPlaybackError('event-schedule',
          { idx, meiId: bad?.meiId, voice: bad?.voice, notes: bad?.notes,
            glide: plan[idx]?.glideFromKey ?? null, ...playbackStateSnapshot(pb) }, err);
      }
    }
    /* Schedule pedal transitions in the same lookahead window. A pedal-down
       must take effect before the note-offs it should hold; since pedal marks
       are anchored at note onsets and the offs they hold fire a full note-
       duration later, the ordering is correct in practice (see the exact-
       coincidence caveat in applyPedalTransition). */
    while (pedalIdx < pedals.length && pedals[pedalIdx].atMs <= horizonMs) {
      const pIdx = pedalIdx;
      pedalIdx++;
      try {
        const dir = pedals[pIdx].dir;
        const pedalInstrKey = pedals[pIdx].instrumentKey;
        const delay = Math.max(0, pedals[pIdx].atMs - elapsedMs);
        const h = window.setTimeout(() => {
          pb.pending.delete(h);
          try {
            applyPedalTransition(pb, dir, pedalInstrKey);
          } catch (err) {
            logPlaybackError('pedal-transition', { dir, ...playbackStateSnapshot(pb) }, err);
          }
        }, delay);
        pb.pending.add(h);
      } catch (err) {
        logPlaybackError('pedal-schedule', { pIdx, dir: pedals[pIdx]?.dir }, err);
      }
    }
    if (nextIdx < events.length || pedalIdx < pedals.length) {
      pb.driverHandle = window.setTimeout(tick, DRIVER_INTERVAL_MS);
    } else {
      /* All events scheduled. Final position + finished broadcast at
         lastEndMs+50, matching the legacy behavior. */
      pb.driverHandle = undefined;
      const finDelay = (lastEndMs + 50) - elapsedMs;
      const finHandle = window.setTimeout(() => {
        pb.pending.delete(finHandle);
        if (pb.cancelled) return;
        try {
          /* Release any voices still held by a pedal that never lifted, and
             reset the damper flags + external CC 64 this run engaged. */
          releasePlaybackPedal(pb);
          syncPianoOut();
          bridge.send({ type: 'playback-position', meiId: null, timeMs: lastEndMs });
        } catch (err) {
          logPlaybackError('finish', playbackStateSnapshot(pb), err);
        } finally {
          /* Always complete the handshake + tear down, even if release threw —
             otherwise Composer's transport hangs waiting for playback-finished. */
          bridge.send({ type: 'playback-finished' });
          playbackActive = false;
          if (active === pb) active = null;
          /* Resync held-keys with the user's real selection (any input that
             arrived during playback was broadcast-suppressed). */
          broadcastHeldKeys();
        }
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
/* The distinct sample-set keys of every instrument in the connected Composer
   score (multi-instrument), + the instrument the cursor currently sits in.
   When Sync-to-Composer is on, HKL proactively loads the whole set so that
   moving the cursor between instruments during note entry NEVER previews with
   the wrong (not-yet-loaded) instrument — it's already loaded and switches
   instantly. */
let composerInstrumentKeys: string[] = [];
let composerCursorInstr: string | null = null;

export function getComposerRequiredLayout(): ComposerLayoutReq | null {
  return composerRequiredLayout;
}

/** Proactively load every Composer-score instrument (fire-and-forget) and apply
 *  the cursor's current instrument. Called when a `composer-instruments` set
 *  arrives with Sync on, and when Sync is toggled on. */
export function preloadComposerInstruments(): void {
  for (const key of composerInstrumentKeys) {
    if (!SampleEngine.isInstrumentLoaded(key) && SampleEngine.INSTRUMENTS[key]) {
      void SampleEngine.loadInstrument(key).catch((err: unknown) => {
        console.error('[sync] preload failed: ' + key, err);
      });
    }
  }
  if (composerCursorInstr) setActiveWaveform(composerCursorInstr);
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

/** Called when the user enables "Sync to Composer" with Composer connected:
 *  the lattice must match the score exactly, so drop any selection tier that
 *  differs from the score-ref tier (letting the score-ref become the effective
 *  ref). No-op if there's no selection or it already matches the score-ref. */
export function reconcileSelectionOnSyncEnable(): void {
  if (!composerConnected || !selectionDiffersFromScoreRef()) return;
  const oldAQ = view.kbAnchorQ, oldAR = view.kbAnchorR;
  if (clearSelection()) {
    const sp = refSpine(referenceNote.q, referenceNote.r);
    view.kbAnchorQ = sp.q;
    view.kbAnchorR = sp.r;
    invalidatePianoOutline();
    syncViewToOutline(currentOutlineForBridge(), true);
    draw();
    onRefChanged(sp.q - oldAQ, sp.r - oldAR);
    broadcastAllToComposer();
  }
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
  /* Ref is NOT applied here. The score's ref reaches HKL via its own
     `set-score-ref` message → the score-ref tier (reference.ts), independent
     of this layout (tuning) sync and of the Sync-to-Composer gate's piano-
     outline constraint. Keeping layout (tuning) and ref on separate paths is
     what lets the score-ref drive the lattice even when Sync is off. */
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
      clearComposerFrame();
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
      playScore(msg.events, msg.pedalEvents);
      break;
    }
    case 'stop-playback':
      abortActive();
      bridge.send({ type: 'playback-finished' });
      break;
    case 'start-performance':
      /* Composer-driven Performance mode: forward live note-ons. Audio is the
         live instrument (the player plays the Lumatone) — no play-score arrives
         in this mode, so the normal input path handles sound + held-keys. */
      performanceMode = true;
      break;
    case 'stop-performance':
      performanceMode = false;
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
    case 'composer-active-instrument':
      /* Follow the Composer cursor's instrument during note entry, but only
         when Sync-to-Composer is on (the user opted in to HKL tracking the
         score). The instrument set is preloaded (composer-instruments), so the
         switch is instant + correct — never previews with the wrong instrument.
         Never persists it as the user's default. */
      composerCursorInstr = msg.instrumentKey || null;
      if (loadPrefs().syncToComposer && msg.instrumentKey) {
        setActiveWaveform(msg.instrumentKey);
      }
      break;
    case 'composer-instruments':
      /* The full instrument set of the connected score. Cache it and — when
         Sync is on — eagerly load every one so cursor-follow is always ready
         ("never play wrong" during composition). */
      composerInstrumentKeys = msg.instrumentKeys.slice();
      if (loadPrefs().syncToComposer) preloadComposerInstruments();
      break;
    case 'composer-score':
      /* Mirror of the cursor instrument's part for the read-only "Composer
         view" frame. Cached even when the frame is off so toggling it on shows
         the current score immediately. */
      setComposerScore(msg.mei);
      /* Forward to the OBS overlay (no-op unless the overlay toggle is on). */
      publishComposerScore(msg.mei);
      break;
    case 'composer-cursor':
      /* Editing-cursor anchor → draw a pixel-identical read-only bar + scroll.
         Deliberately NOT forwarded to the overlay: the overlay is bars-only
         (no editing caret in a performance capture). */
      setComposerCursor(msg.voice, msg.anchor);
      break;
    case 'composer-playback':
      /* Composer-owned playback overlay (clock playback, Performance mode, any
         future cursor source) → mirror its mode + per-voice bars verbatim. */
      setComposerPlaybackBars(msg.on, msg.bars);
      publishComposerPlayback(msg.on, msg.bars);
      break;
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
    case 'set-score-ref': {
      /* Sets the score-ref tier (the score's cursor-independent fallback ref,
         from the Setup-dialog coordinates). Validate against the same MIDI +
         accidental constraints as Ctrl+click / set-reference-note so the ref
         never lands on an unspellable cell. When this becomes the effective
         ref, mirror the Ctrl+click path: advance kbAnchor so the
         Lumatone/QWERTY outline centers on it, and fire onRefChanged so any
         held physical voices migrate. Cursor-derived refs (set-reference-note)
         deliberately do NOT recenter — they're piano-outline-only. */
      if (validateRefNoteCandidate(msg.q, msg.r) !== null) break;
      /* Sync on → the lattice must match the score exactly, so a score-ref
         update clears any selection (manual or cursor) that would otherwise
         mask it. Sync off → leave the user's explicit selection alone (they're
         deliberately using their own ref/layout against a mismatched score). */
      const oldAQ = view.kbAnchorQ, oldAR = view.kbAnchorR;
      let changed = false;
      if (loadPrefs().syncToComposer) changed = clearSelection() || changed;
      changed = setScoreRef(msg.q, msg.r) || changed;
      if (changed) {
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

function announceToOrchestrator(): void {
  orchestratorBridge.send({ type: 'hkl-hello', version: ORCHESTRATOR_PROTOCOL_VERSION });
}

/* Shared .hki import path for the Analyzer and Orchestrator bridges. Receives
   bytes inline + writes to IDB ourselves (same path as the `+ .hki` file picker
   in src/ui/instrumentBundles.ts), then auto-selects and acks via the caller's
   reply. `fallbackKey` is acked on failure (when no manifest was parsed). */
function handleHkiImport(
  bytes: Uint8Array,
  fallbackKey: string,
  ack: (instrumentKey: string, ok: boolean, error?: string) => void,
): void {
  void (async () => {
    try {
      const manifest = await InstrumentRegistry.importBundle(bytes);
      /* Evict any already-loaded profile for this key so the auto-select's
         change event reloads from the fresh import instead of hitting the
         engine's isInstrumentLoaded guard (same as the file-picker path). */
      SampleEngine.unloadInstrument(manifest.instrumentKey);
      autoSelectImported(manifest.instrumentKey);
      ack(manifest.instrumentKey, true);
    } catch (err) {
      ack(fallbackKey, false, (err as Error).message);
    }
  })();
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
      handleHkiImport(msg.bytes, msg.instrumentKey, (instrumentKey, ok, error) =>
        analyzerBridge.send({ type: 'import-ack', instrumentKey, ok, error }));
      break;
    }
    case 'import-cdn-config': {
      void (async () => {
        try {
          await CdnConfigRegistry.importConfig(msg.config);
          SampleEngine.unloadInstrument(msg.instrumentKey);
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

orchestratorBridge.on((msg: OrchestratorEvent) => {
  switch (msg.type) {
    case 'orchestrator-hello':
      announceToOrchestrator();
      break;
    case 'orchestrator-bye':
      /* No held orchestrator-side state to clean up. */
      break;
    case 'import-hki': {
      handleHkiImport(msg.bytes, msg.instrumentKey, (instrumentKey, ok, error) =>
        orchestratorBridge.send({ type: 'import-ack', instrumentKey, ok, error }));
      break;
    }
  }
});

/* ── lifecycle ───────────────────────────────────────────────────────────── */

window.addEventListener('beforeunload', () => {
  abortActive();
  bridge.send({ type: 'hkl-bye' });
  analyzerBridge.send({ type: 'hkl-bye' });
  orchestratorBridge.send({ type: 'hkl-bye' });
});

let initialized = false;
function announceAll(): void {
  announce();
  announceToAnalyzer();
  announceToOrchestrator();
}
export function initHklBridge(): void {
  if (initialized) return;
  initialized = true;
  announceAll();
}

/* Re-announce on focus / tab-visible. BroadcastChannel has no buffering: a
   hello posted before the peer's channel exists is dropped, and each side
   otherwise announces only once at load. When BOTH tabs (re)load together —
   e.g. HMR on a shared package reloads HKL + Composer at once — each one-shot
   hello can land in the other's pre-listener window and both are lost, leaving
   the apps wedged until one is reopened. Re-announcing whenever HKL is focused
   makes the handshake self-heal on the one action Max already performs (focus
   HKL to start the AudioContext). Debounced so focus+visibilitychange (which
   often fire together) and rapid toggles coalesce into one burst; announce()'s
   diff filters make repeats cheap regardless. */
let reannounceHandle: number | undefined;
function scheduleReannounce(): void {
  if (!initialized || reannounceHandle !== undefined) return;
  reannounceHandle = window.setTimeout(() => {
    reannounceHandle = undefined;
    announceAll();
  }, 100);
}
window.addEventListener('focus', scheduleReannounce);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleReannounce();
});

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
