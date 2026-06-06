// OBS-overlay publisher. The performing HKL instance mirrors its render state
// to the relay so a second instance (?overlay, an OBS Browser Source) can draw
// it transparent. Auto-started at boot (no toolbar toggle): a refused connection
// (no relay running) is silent on Chromium — the Local Network Access prompt only
// fires once a connection actually establishes, i.e. when a relay is genuinely
// present — so dialing unconditionally never bothers non-OBS visitors.
//
// One tap point for the lattice: overlayPublishTick() runs at the END of draw()
// — the single convergence point every state change funnels through (selection,
// pan, layout, tuning, ref). It diffs three signatures and sends only what
// changed: a full `snapshot` on any structural change, a `keys` delta when the
// lit-key set changes, a `view` delta on pan (streams per-frame during tweens —
// trivial on localhost, and gives the overlay an exact pan match for free).
//
// Composer-frame state is forwarded explicitly from hkl-side.ts (where the same
// payloads already arrive from Composer over the BroadcastChannel bridge) via
// publishComposer*(). It's cached so a fresh snapshot / reconnect resends it.
//
// Imports state only (never draw.ts) so draw.ts → overlayPublishTick stays
// acyclic.

import { OverlayChannel } from '@hkl/bridge/overlay-ws.js';
import type { OverlaySnapshot, OverlayPlaybackBar } from '@hkl/bridge/overlay-protocol.js';
import { view } from '../state/view.js';
import { selection } from '../state/selection.js';
import { tuning } from '../state/tuning.js';
import { referenceNote } from '../state/reference.js';

let channel: OverlayChannel | null = null;

/* Last-sent signatures for diff-gating. Reset on (re)connect so a fresh socket
   gets a full resend. */
let lastStructSig: string | null = null;
let lastViewSig: string | null = null;
let lastKeysSig: string | null = null;

/* Cached Composer-frame state (forwarded from hkl-side), resent on reconnect. */
let lastComposerMei: string | null = null;
let lastComposerView = false;
let lastComposerPlayback: { on: boolean; bars: ReadonlyArray<OverlayPlaybackBar> } | null = null;

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

function selVal(id: string, fallback: string): string {
  return $<HTMLSelectElement>(id)?.value ?? fallback;
}
function cbOn(id: string): boolean {
  return $<HTMLInputElement>(id)?.checked ?? false;
}

function buildSnapshot(): OverlaySnapshot {
  return {
    tuning: tuning.mode,
    heji: tuning.hejiEnabled,
    refQ: referenceNote.q,
    refR: referenceNote.r,
    outline: selVal('selOutline', 'lumatone'),
    rotation: selVal('selRotation', '0'),
    hexSize: selVal('selHexSize', 'm'),
    showNotes: cbOn('cbNotes'),
    showBands: cbOn('cbBands'),
    extendPattern: cbOn('cbExtend'),
    composerView: document.body.classList.contains('composer-view'),
    staffDark: document.body.classList.contains('staff-dark'),
    kbAnchorQ: view.kbAnchorQ,
    kbAnchorR: view.kbAnchorR,
    kbOffY: view.kbOffY,
    viewQ: view.viewQ,
    viewR: view.viewR,
    litKeys: [...selection.selectedKeys],
  };
}

/** Resend everything — full lattice snapshot + cached Composer-frame state.
 *  Called on (re)connect so a freshly-opened overlay (or one that survived a
 *  relay restart) reconstructs immediately. */
function sendFullState(): void {
  if (!channel) return;
  const snap = buildSnapshot();
  channel.send({ t: 'snapshot', data: snap });
  /* Sync the diff signatures to the snapshot we just sent so the next tick
     doesn't immediately resend the same view/keys as deltas. */
  lastStructSig = structSigOf(snap);
  lastViewSig = `${snap.viewQ},${snap.viewR},${snap.kbOffY}`;
  lastKeysSig = snap.litKeys.join('|');
  channel.send({ t: 'composer-view', on: lastComposerView });
  if (lastComposerMei !== null) channel.send({ t: 'composer-score', mei: lastComposerMei });
  if (lastComposerPlayback) {
    channel.send({ t: 'composer-playback', on: lastComposerPlayback.on, bars: lastComposerPlayback.bars });
  }
}

function structSigOf(s: OverlaySnapshot): string {
  return [
    s.tuning, s.heji, s.refQ, s.refR, s.outline, s.rotation, s.hexSize,
    s.showNotes, s.showBands, s.extendPattern, s.composerView, s.staffDark,
    s.kbAnchorQ, s.kbAnchorR,
  ].join('|');
}

/** Enable/disable overlay publishing. Opens (or tears down) the WS connection. */
export function setOverlayPublishing(on: boolean): void {
  if (on && !channel) {
    /* giveUpAfter: with no relay listening the connect is refused (silently —
       the LNA prompt only fires on an established connection). Keep the retry
       count low so a non-OBS visitor logs only a couple of connection-refused
       lines before stopping. Once connected (relay present), reconnect is
       unbounded. */
    channel = new OverlayChannel({ giveUpAfter: 3 });
    channel.onOpen(sendFullState);
  } else if (!on && channel) {
    channel.close();
    channel = null;
    lastStructSig = lastViewSig = lastKeysSig = null;
  }
}

/** Called at the end of draw(). No-op unless publishing. Diffs structural /
 *  view / lit-key state and sends only what changed. */
export function overlayPublishTick(): void {
  if (!channel) return;
  const snap = buildSnapshot();
  const structSig = structSigOf(snap);
  if (structSig !== lastStructSig) {
    lastStructSig = structSig;
    channel.send({ t: 'snapshot', data: snap });
    lastViewSig = `${snap.viewQ},${snap.viewR},${snap.kbOffY}`;
    lastKeysSig = snap.litKeys.join('|');
    return; /* snapshot already carried current view + keys */
  }
  const viewSig = `${snap.viewQ},${snap.viewR},${snap.kbOffY}`;
  if (viewSig !== lastViewSig) {
    lastViewSig = viewSig;
    channel.send({ t: 'view', viewQ: snap.viewQ, viewR: snap.viewR, kbOffY: snap.kbOffY });
  }
  const keysSig = snap.litKeys.join('|');
  if (keysSig !== lastKeysSig) {
    lastKeysSig = keysSig;
    channel.send({ t: 'keys', keys: snap.litKeys });
  }
}

/* ── Composer-frame forwarding (called from hkl-side.ts handlers) ─────────── */

export function publishComposerScore(mei: string): void {
  lastComposerMei = mei;
  if (channel) channel.send({ t: 'composer-score', mei });
}

export function publishComposerView(on: boolean): void {
  lastComposerView = on;
  if (channel) channel.send({ t: 'composer-view', on });
}

export function publishComposerPlayback(on: boolean, bars: ReadonlyArray<OverlayPlaybackBar>): void {
  lastComposerPlayback = { on, bars };
  if (channel) channel.send({ t: 'composer-playback', on, bars });
}
