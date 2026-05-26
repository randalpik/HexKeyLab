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

import { createHklBridge, createAnalyzerHklBridge, PROTOCOL_VERSION, ANALYZER_PROTOCOL_VERSION } from './channel.js';
import type {
  ComposerEvent, PlaybackEvent, ResolvedNote, CoordRef,
} from './protocol.js';
import type { AnalyzerEvent } from './analyzer-protocol.js';
import * as InstrumentRegistry from '../state/instrumentRegistry.js';
import * as CdnConfigRegistry from '../state/cdnConfigRegistry.js';
import { selection } from '../state/selection.js';
import { audio } from '../state/audio.js';
import { tuning } from '../state/tuning.js';
import { darkColorHex } from '../transcription/pitch.js';
import { resolveNoteSpec } from '../tuning/spell.js';
import { noteOn, noteOff, stopAllNotes, triggerRearticulateFlash } from '../audio/engine.js';
import { draw, activeFootprintSet, invalidatePianoOutline, validateRefNoteCandidate } from '../render/draw.js';
import { syncViewToOutline } from '../ui/controls.js';
import { DEFAULT_DYNAMIC_MAP } from '../shared/dynamics.js';
import { setSelectionFromComposer, setSongKey, onComposerBye, referenceNote } from '../state/reference.js';
import { refSpine } from '../tuning/refspine.js';
import { view } from '../state/view.js';
import { onRefChanged } from '../effects/onRefChanged.js';
import { setTuning } from '../ui/controls.js';
import { loadPrefs, type TuningMode } from '../state/persistence.js';
import type { FootprintCell } from './protocol.js';
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
  pending: Set<number>; /* setTimeout handles, so stop-playback can clear them */
  heldKeys: Set<KeyId>; /* keys we noteOn'd, for force-off on stop */
  /* Monotonic per-key voice tag. Each dispatchChord noteOn bumps the key's
     seq; each offHandle captures the seq it owns and only tears down if it
     still matches. This is how back-to-back same-pitch events avoid the
     previous event's offHandle killing the fresh voice. */
  voiceSeq: Map<KeyId, number>;
  nextSeq: number;
}

let active: ActivePlayback | null = null;

function newPlayback(): ActivePlayback {
  return { cancelled: false, pending: new Set(), heldKeys: new Set(), voiceSeq: new Map(), nextSeq: 0 };
}

function abortActive(): void {
  if (!active) return;
  active.cancelled = true;
  for (const h of active.pending) clearTimeout(h);
  for (const k of active.heldKeys) {
    noteOff(k);
    if (playbackOwnedKeys.has(k)) {
      selection.selectedKeys.delete(k);
      playbackOwnedKeys.delete(k);
    }
  }
  active = null;
  playbackActive = false;
  draw();
  /* Surface any drift in the user's real held-keys that accumulated while
     broadcasts were suppressed during playback. */
  broadcastHeldKeys();
}

function coordToKeyId(c: CoordRef): KeyId {
  return c.q + ',' + c.r;
}

function dispatchChord(notes: ReadonlyArray<CoordRef>, durationMs: number, pb: ActivePlayback, velocity?: number): void {
  if (pb.cancelled) return;
  const keys: KeyId[] = notes.map(coordToKeyId);
  const ownedSeq = new Map<KeyId, number>();
  for (const k of keys) {
    if (audio.activeOscs[k]) {
      /* Back-to-back same-pitch events: the next event's noteOn timer can
         fire before the previous event's noteOff timer when they share a
         deadline. Mirror the input-layer pedal-replay fix — stop the old
         voice so syncAudio creates a fresh one, and flash to confirm. */
      noteOff(k);
      triggerRearticulateFlash(k);
    }
    audio.sustainedKeys.delete(k);
    /* Seed audio.keyVelocity so this attack shows up in loopdiag's vel trace
       like Lumatone / QWERTY / recording-playback do (all of which write
       keyVelocity before noteOn). Without the seed, Composer-dispatched
       notes are invisible to the diagnostic overlay. */
    const v = velocity ?? audio.keyVelocity[k] ?? DEFAULT_DYNAMIC_MAP.mf;
    audio.keyVelocity[k] = v;
    noteOn(k, v);
    const seq = ++pb.nextSeq;
    pb.voiceSeq.set(k, seq);
    ownedSeq.set(k, seq);
    pb.heldKeys.add(k);
    /* Add to selectedKeys for visual highlight via existing draw() path.
       Track ownership so we only remove keys that were not already held by
       the user. */
    if (!selection.selectedKeys.has(k)) {
      selection.selectedKeys.add(k);
      playbackOwnedKeys.add(k);
    }
  }
  draw();
  const offHandle = window.setTimeout(() => {
    pb.pending.delete(offHandle);
    if (pb.cancelled) return;
    let mutated = false;
    for (const k of keys) {
      /* A later dispatchChord may have re-articulated this key; its own
         offHandle will tear it down. Skip if our seq is no longer current. */
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
    if (mutated) draw();
  }, durationMs);
  pb.pending.add(offHandle);
}

function playScore(events: ReadonlyArray<PlaybackEvent>): void {
  abortActive();
  if (events.length === 0) {
    bridge.send({ type: 'playback-finished' });
    return;
  }
  const pb = newPlayback();
  active = pb;
  playbackActive = true;

  let lastEnd = 0;
  for (const ev of events) {
    const onHandle = window.setTimeout(() => {
      pb.pending.delete(onHandle);
      if (pb.cancelled) return;
      dispatchChord(ev.notes, ev.durationMs, pb, ev.velocity);
      bridge.send({
        type: 'playback-position',
        meiId: ev.meiId ?? null,
        timeMs: ev.atMs,
      });
    }, ev.atMs);
    pb.pending.add(onHandle);
    lastEnd = Math.max(lastEnd, ev.atMs + ev.durationMs);
  }

  const finHandle = window.setTimeout(() => {
    pb.pending.delete(finHandle);
    if (pb.cancelled) return;
    bridge.send({ type: 'playback-position', meiId: null, timeMs: lastEnd });
    bridge.send({ type: 'playback-finished' });
    playbackActive = false;
    if (active === pb) active = null;
    /* Resync held-keys with the user's real selection (any input that
       arrived during playback was broadcast-suppressed). */
    broadcastHeldKeys();
  }, lastEnd + 50);
  pb.pending.add(finHandle);
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
    syncViewToOutline(currentOutlineForBridge(), false);
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
        syncViewToOutline(currentOutlineForBridge(), false);
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
        syncViewToOutline(currentOutlineForBridge(), false);
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
        syncViewToOutline(currentOutlineForBridge(), false);
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
